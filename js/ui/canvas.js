// Shared real-time drawing board (used by Doodle Dash and Duet Canvas).
//
// Coordinates are integers 0..1000 on both axes of a fixed-aspect board, so both players see the
// same drawing whatever their screen size. A stroke is
//   { id, by, color, size, t, e, mirror, pts: [[x, y], ...], n? }
// where `size` is the brush width in board units (relative to the width), `t` the authority-clock
// start time (strokes are ordered by (t, id) so both screens stack them identically), `e` the clear
// "epoch" the stroke belongs to, and `mirror` (0/1) whether it is also painted mirrored. A copy
// whose points were simplified for a sync remembers its author's point count in `n`
// (see strokeLen()), so both screens agree on how complete it is.
//
// Strokes never go into game state. They travel over the game-scoped fx channel; every payload
// carries `k` (the board key) so a new round's board ignores stragglers from the previous one:
//   'stroke' { k, id, color, size, t, e, mirror, o, pts, start?, end? }   ≤ MAX_CHUNK points, ~every 60 ms
//            (`o` = index of pts[0] in the author's stroke, so overlaps are skipped, never doubled)
//   'undo'   { k, id }                 remove one of the sender's own strokes
//   'clear'  { k, epoch }              wipe everything older than `epoch`
//   'sync?'  { k, epoch?, have? }      "send me what I'm missing" (`have` = [[id, length], ...];
//                                      without it the whole board comes back)
//   'sync'   { k, epoch, tomb, strokes, part, parts, more? }   reply, split into a few messages
//            (`more`: "your list showed things I lack, I'm asking you back")
//   'digest' { k, epoch, count, hash, open }            every DIGEST_MS while mounted
// Merging is idempotent (union by id, minus tombstones, minus older epochs, longer copy wins) so
// a sync can be applied in any order and any number of times.
//
// Broadcasts are at-most-once (Supabase drops messages under load), so a lost chunk, undo or
// clear would leave the two boards different for good. Each board therefore sends a small digest
// of its finished strokes every few seconds; a board that sees a digest that doesn't match its
// own asks for what it's missing with a targeted 'sync?' (one side asks first, and its list lets
// the other see what *it* lacks — see createResync). Strokes still being drawn are left out of
// the digest (and listed in `open`) so live drawing never looks like a mismatch, and requests
// that bring nothing back back off, so a board that can't be repaired never floods the channel.
//
// Everything above the "Browser-only" line is pure and runs in Node tests. DOM access only
// happens inside functions that the component calls in the browser.

import { html, useEffect, useRef, useState } from './h.js';
import { Icon } from './icons.js';

export const SPACE = 1000;
export const MAX_CHUNK = 60; // points per 'stroke' message
export const FLUSH_MS = 60; // batch interval while drawing (~16 msgs/s: well inside realtime quotas)
export const MAX_STROKE_PTS = 1200; // a longer scribble is split into several strokes
export const MAX_TOMB = 300;
export const SYNC_MAX_POINTS = 6000; // total points in one sync reply (all parts)
export const SYNC_PART_POINTS = 1500; // points per sync message
export const MIN_STEP = 2; // ignore pointer moves smaller than this (board units)
export const ERASER_SCALE = 2.4;
export const DIGEST_MS = 3000; // how often a mounted board tells the partner what it has
export const PULL_MIN_MS = 2500; // a mismatch asks for a resync at most this often…
export const PULL_MAX_MS = 60000; // …backing off (doubling) while mismatches persist
export const MAX_HAVE = 600; // strokes listed in a 'sync?' (a bigger board asks for everything)
export const MAX_DIGEST_OPEN = 16; // open strokes a digest may leave out

// The board is a sheet of paper (--paper in css/app.css); the pens are inks that read on it.
export const PAPER = '#f1e9da';
export const PALETTE = [
  { c: '#1d1b24', name: 'Ink' },
  { c: '#2f4a7a', name: 'Night' },
  { c: '#4a80c6', name: 'Sky' },
  { c: '#866abf', name: 'Lilac' },
  { c: '#d45c4e', name: 'Coral' },
  { c: '#d68a2c', name: 'Amber' },
  { c: '#5f8e58', name: 'Sage' },
  { c: '#fbf8f1', name: 'Moon' },
];
export const SIZES = [
  { v: 5, name: 'Fine' },
  { v: 12, name: 'Medium' },
  { v: 26, name: 'Bold' },
];

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;

const clampInt = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n)));

export function emptyBoard() {
  return { strokes: [], tomb: [], epoch: 0 };
}

/** Client pixel position -> board point, clamped to 0..1000. `rect` = canvas bounding rect. */
export function toBoardPoint(clientX, clientY, rect) {
  const w = rect.width || 1;
  const h = rect.height || 1;
  return [clampInt(((clientX - rect.left) / w) * SPACE, 0, SPACE), clampInt(((clientY - rect.top) / h) * SPACE, 0, SPACE)];
}

export function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Validate a list of points from the network: [[x, y], ...] of finite numbers, clamped, capped. */
export function sanitizePts(raw, max = MAX_STROKE_PTS) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    if (out.length >= max) break;
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([clampInt(x, 0, SPACE), clampInt(y, 0, SPACE)]);
  }
  return out;
}

/** Validate a stroke (or a 'stroke' message) coming from the network. Returns null if unusable. */
export function sanitizeStroke(raw, by) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return null;
  if (typeof by !== 'string' || !by) return null;
  const color = typeof raw.color === 'string' && HEX.test(raw.color) ? raw.color.toLowerCase() : null;
  const size = Number(raw.size);
  if (!color || !Number.isFinite(size)) return null;
  const t = Number(raw.t);
  const e = Number(raw.e);
  return {
    id: raw.id,
    by,
    color,
    size: Math.min(80, Math.max(1, Math.round(size * 10) / 10)),
    t: Number.isFinite(t) ? Math.max(0, Math.round(t)) : 0,
    e: Number.isFinite(e) ? Math.max(0, Math.floor(e)) : 0,
    mirror: raw.mirror ? 1 : 0,
    pts: sanitizePts(raw.pts),
  };
}

function order(a, b) {
  return a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function indexOf(board, id) {
  const list = board.strokes;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].id === id) return i;
  return -1;
}

export function findStroke(board, id) {
  const i = indexOf(board, id);
  return i < 0 ? null : board.strokes[i];
}

/** How many points a stroke really has: a simplified copy remembers its author's count in `n`. */
export function strokeLen(s) {
  return Math.max(s.pts.length, s.n || 0);
}

/** Insert keeping (t, id) order; almost always appends. */
function insertSorted(list, stroke) {
  let i = list.length;
  while (i > 0 && order(list[i - 1], stroke) > 0) i--;
  const out = list.slice();
  out.splice(i, 0, stroke);
  return out;
}

/** Add a whole stroke (ignored if it already exists, was undone, or predates the last clear). */
export function addStroke(board, stroke) {
  if (!stroke || stroke.e < board.epoch || board.tomb.includes(stroke.id) || indexOf(board, stroke.id) >= 0) return board;
  return { ...board, strokes: insertSorted(board.strokes, stroke) };
}

/** Append points to an existing stroke (only its author may extend it). */
export function appendPoints(board, id, pts, by) {
  const i = indexOf(board, id);
  if (i < 0 || !pts.length) return board;
  const cur = board.strokes[i];
  if (by !== undefined && cur.by !== by) return board;
  const room = MAX_STROKE_PTS - strokeLen(cur);
  if (room <= 0) return board;
  const add = room < pts.length ? pts.slice(0, room) : pts;
  const next = { ...cur, pts: cur.pts.concat(add) };
  if (cur.n) next.n = cur.n + add.length;
  const strokes = board.strokes.slice();
  strokes[i] = next;
  return { ...board, strokes };
}

/** Wipe everything older than `epoch`. Same object if we were already there. */
export function applyClear(board, epoch) {
  const e = Math.floor(Number(epoch));
  if (!Number.isFinite(e) || e <= board.epoch) return board;
  return { strokes: board.strokes.filter((s) => s.e >= e), tomb: [], epoch: e };
}

function tombWith(tomb, id) {
  if (tomb.includes(id)) return tomb;
  const out = tomb.concat(id);
  return out.length > MAX_TOMB ? out.slice(-MAX_TOMB) : out;
}

/** Remove `id` if `from` drew it. Unknown ids are remembered so a late sync can't resurrect them. */
export function applyUndo(board, id, from) {
  if (typeof id !== 'string' || !ID.test(id)) return board;
  const i = indexOf(board, id);
  if (i < 0) {
    if (board.tomb.includes(id)) return board;
    return { ...board, tomb: tombWith(board.tomb, id) };
  }
  if (board.strokes[i].by !== from) return board;
  const strokes = board.strokes.slice();
  strokes.splice(i, 1);
  return { ...board, strokes, tomb: tombWith(board.tomb, id) };
}

/**
 * Apply a live 'stroke' message from `from`. With an offset `o` the chunk lands at its place in
 * the author's stroke: points we already have (a sync overtook the chunk) are skipped, never
 * doubled. A gap (a lost chunk) is bridged for now; the stroke stays short of its author's copy,
 * which the digest notices and a resync repairs.
 */
export function applyStrokeMsg(board, msg, from) {
  const s = sanitizeStroke(msg, from);
  if (!s) return board;
  let b = board;
  // A stroke from a newer epoch means we missed a clear: catch up.
  if (s.e > b.epoch) b = applyClear(b, s.e);
  if (s.e < b.epoch || b.tomb.includes(s.id)) return b;
  const i = indexOf(b, s.id);
  if (i < 0) return s.pts.length ? addStroke(b, s) : b;
  let pts = s.pts;
  const o = Number(msg.o);
  if (Number.isInteger(o) && o >= 0) {
    const have = strokeLen(b.strokes[i]);
    if (o + pts.length <= have) return b;
    if (o < have) pts = pts.slice(have - o);
  }
  return appendPoints(b, s.id, pts, from);
}

/** The newest stroke drawn by `by` (for undo). */
export function lastStrokeBy(board, by) {
  for (let i = board.strokes.length - 1; i >= 0; i--) if (board.strokes[i].by === by) return board.strokes[i];
  return null;
}

export function countBy(board, by) {
  let n = 0;
  for (const s of board.strokes) if (s.by === by) n++;
  return n;
}

export function boardPointCount(board) {
  let n = 0;
  for (const s of board.strokes) n += s.pts.length;
  return n;
}

/**
 * Merge a sync payload (or a stored board) into ours. `allowedBy` limits stroke authors to the
 * two players. Union by id; a stroke we already have is only replaced by a more complete copy
 * (by strokeLen), so it never shrinks.
 */
export function mergeBoards(board, inc, allowedBy = null) {
  if (!inc || typeof inc !== 'object') return board;
  let b = board;
  const epoch = Math.floor(Number(inc.epoch));
  if (Number.isFinite(epoch) && epoch > b.epoch) b = applyClear(b, epoch);
  if (Array.isArray(inc.tomb)) {
    for (const id of inc.tomb.slice(-MAX_TOMB)) {
      if (typeof id !== 'string' || !ID.test(id) || b.tomb.includes(id)) continue;
      const i = indexOf(b, id);
      const strokes = i < 0 ? b.strokes : b.strokes.filter((s) => s.id !== id);
      b = { ...b, strokes, tomb: tombWith(b.tomb, id) };
    }
  }
  if (Array.isArray(inc.strokes)) {
    for (const raw of inc.strokes.slice(0, 2000)) {
      const by = raw?.by;
      if (allowedBy && !allowedBy.includes(by)) continue;
      const s = sanitizeStroke(raw, by);
      if (!s || !s.pts.length || s.e < b.epoch || b.tomb.includes(s.id)) continue;
      const n = Number(raw.n);
      if (Number.isInteger(n) && n > s.pts.length && n <= MAX_STROKE_PTS) s.n = n;
      const i = indexOf(b, s.id);
      if (i < 0) {
        b = addStroke(b, s);
      } else if (strokeLen(b.strokes[i]) < strokeLen(s) && b.strokes[i].by === s.by) {
        const next = { ...b.strokes[i], pts: s.pts };
        if (s.n) next.n = s.n;
        else delete next.n;
        const strokes = b.strokes.slice();
        strokes[i] = next;
        b = { ...b, strokes };
      }
    }
  }
  return b;
}

/** Ramer–Douglas–Peucker simplification (keeps the first and last point). */
export function simplifyPts(pts, tol = 1) {
  if (pts.length <= 2 || tol <= 0) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, z] = stack.pop();
    const [ax, ay] = pts[a];
    const [zx, zy] = pts[z];
    const dx = zx - ax;
    const dy = zy - ay;
    const len = Math.hypot(dx, dy);
    let best = -1;
    let bestD = tol;
    for (let i = a + 1; i < z; i++) {
      const [px, py] = pts[i];
      const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + zx * ay - zy * ax) / len;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, z]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** A 'sync?' request's `have` list ([[id, length], ...]) as a Map; null when absent or unusable. */
export function readHave(raw) {
  if (!Array.isArray(raw)) return null;
  const have = new Map();
  for (const e of raw.slice(0, MAX_HAVE)) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || !ID.test(e[0])) continue;
    const n = Number(e[1]);
    if (Number.isInteger(n) && n >= 0) have.set(e[0], n);
  }
  return have;
}

/** What this board holds, for a targeted 'sync?' (null when there are too many strokes to list). */
export function boardManifest(board, max = MAX_HAVE) {
  if (board.strokes.length > max) return null;
  return board.strokes.map((s) => [s.id, strokeLen(s)]);
}

/** The body of a 'sync?' from this board: its epoch and, when it fits, what it already has. */
export function syncRequest(board) {
  const have = boardManifest(board);
  return have ? { epoch: board.epoch, have } : { epoch: board.epoch };
}

/**
 * Build the 'sync' reply for a board: strokes as they are, or simplified (more aggressively if
 * needed) so the whole reply stays under `maxPoints`, then split into parts of ≤ `partPoints` points. Open
 * (in-progress) strokes are sent as-is so later live chunks still line up; a simplified copy
 * carries its real length in `n`. With `have` (the asker's list) only strokes the asker lacks or
 * holds a shorter copy of are sent, plus the tombstones of strokes it still has. Always ≥ 1 part
 * (an empty reply still tells the asker our epoch).
 */
export function syncPayloads(board, k, { open = null, have = null, maxPoints = SYNC_MAX_POINTS, partPoints = SYNC_PART_POINTS } = {}) {
  const isOpen = (s) => !!open && (open.has ? open.has(s.id) : false);
  const theirs = have instanceof Map ? have : readHave(have);
  const wanted = theirs ? board.strokes.filter((s) => !(theirs.get(s.id) >= strokeLen(s))) : board.strokes;
  const strip = (s, tol) => {
    const pts = isOpen(s) || tol === 0 ? s.pts : simplifyPts(s.pts, tol);
    const out = { id: s.id, by: s.by, color: s.color, size: s.size, t: s.t, e: s.e, mirror: s.mirror, pts };
    if (pts.length < strokeLen(s)) out.n = strokeLen(s);
    return out;
  };
  // Exact copies when they fit (so both screens end up with the very same points), otherwise
  // simplify a little more each pass.
  let tol = 0;
  let list = wanted.map((s) => strip(s, tol));
  while (boardPointCount({ strokes: list }) > maxPoints && tol < 24) {
    tol = tol ? tol * 2 : 0.75;
    list = wanted.map((s) => strip(s, tol));
  }
  if (boardPointCount({ strokes: list }) > maxPoints) {
    // Still too big: keep the newest strokes that fit.
    const kept = [];
    let total = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (total + list[i].pts.length > maxPoints) break;
      total += list[i].pts.length;
      kept.unshift(list[i]);
    }
    list = kept;
  }
  const parts = [];
  let cur = [];
  let n = 0;
  for (const s of list) {
    if (cur.length && n + s.pts.length > partPoints) {
      parts.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(s);
    n += s.pts.length;
  }
  if (cur.length || !parts.length) parts.push(cur);
  const tomb = theirs ? board.tomb.filter((id) => theirs.has(id)) : board.tomb.slice(-MAX_TOMB);
  return parts.map((strokes, i) => ({ k, epoch: board.epoch, tomb: i === 0 ? tomb : [], strokes, part: i + 1, parts: parts.length }));
}

/** Does a 'sync?' show that the asker holds strokes (or a clear) we're missing? `skip` = ids still being drawn. */
export function partnerHasMore(board, req, skip = null) {
  const e = Number(req?.epoch);
  if (Number.isInteger(e) && e !== board.epoch) return e > board.epoch;
  const have = readHave(req?.have);
  if (!have) return false;
  const mine = new Map(board.strokes.map((s) => [s.id, s]));
  const tomb = new Set(board.tomb);
  for (const [id, n] of have) {
    if (tomb.has(id) || skip?.has?.(id)) continue;
    const s = mine.get(id);
    if (s ? n > strokeLen(s) : n > 0) return true;
  }
  return false;
}

/**
 * Ids of our own strokes that we undid but a sync reply still carries: the partner missed those
 * 'undo' messages, so we send them again (undo is idempotent).
 */
export function missedUndos(board, inc, me, max = 50) {
  if (!inc || !Array.isArray(inc.strokes) || !board.tomb.length) return [];
  const tomb = new Set(board.tomb);
  const out = [];
  for (const raw of inc.strokes) {
    if (out.length >= max) break;
    if (raw && raw.by === me && typeof raw.id === 'string' && tomb.has(raw.id) && !out.includes(raw.id)) out.push(raw.id);
  }
  return out;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Fingerprint of a board: its epoch, the number of strokes and an order-independent hash of
 * (id, length) pairs. Strokes in `skip` (still being drawn) are left out.
 */
export function boardDigest(board, skip = null) {
  let count = 0;
  let hash = 0;
  for (const s of board.strokes) {
    if (skip?.has?.(s.id)) continue;
    count++;
    hash = (hash + fnv1a(`${s.id}:${strokeLen(s)}`)) >>> 0;
  }
  return { epoch: board.epoch, count, hash };
}

/** The periodic 'digest' message (minus `k`), or null while too many strokes are in flight. */
export function digestMessage(board, open = []) {
  const ids = [...open].filter((id) => typeof id === 'string' && ID.test(id));
  if (ids.length > MAX_DIGEST_OPEN) return null;
  return { ...boardDigest(board, new Set(ids)), open: ids };
}

/**
 * Compare a partner's digest with our board → 'match' | 'mismatch' | 'busy' | 'invalid'.
 * Both sides leave out the strokes the sender listed as open. If we are drawing (or receiving)
 * a stroke the sender didn't list, its digest can't be compared yet: 'busy', try the next one.
 */
export function compareDigest(board, d, myOpen = []) {
  if (!d || typeof d !== 'object') return 'invalid';
  const { epoch, count, hash } = d;
  if (!Number.isInteger(epoch) || epoch < 0 || !Number.isInteger(count) || count < 0) return 'invalid';
  if (!Number.isInteger(hash) || hash < 0 || hash > 0xffffffff) return 'invalid';
  const open = Array.isArray(d.open) ? d.open : [];
  if (open.length > MAX_DIGEST_OPEN) return 'busy';
  const theirs = new Set(open.filter((id) => typeof id === 'string' && ID.test(id)));
  for (const id of myOpen) if (!theirs.has(id)) return 'busy';
  if (epoch !== board.epoch) return 'mismatch';
  const mine = boardDigest(board, theirs);
  return mine.count === count && mine.hash === hash ? 'match' : 'mismatch';
}

/**
 * Rate limit for resync requests: at most one per `gap`, and the gap doubles (up to PULL_MAX_MS)
 * with every request, so a board that can't be repaired (e.g. one too big for a sync reply) asks
 * rarely instead of flooding the channel. A matching digest, or a reply that actually repaired
 * something, resets it.
 */
export function createPuller({ min = PULL_MIN_MS, max = PULL_MAX_MS } = {}) {
  let last = -Infinity;
  let gap = min;
  return {
    /** True if a request may go out now (and records it). */
    take(now) {
      if (now - last < gap) return false;
      last = now;
      gap = Math.min(gap * 2, max);
      return true;
    },
    /** A request went out for another reason (mount / reconnect): don't pile another on top. */
    note(now) {
      last = now;
    },
    reset() {
      gap = min;
    },
    get gap() {
      return gap;
    },
  };
}

/**
 * When a board asks the partner for a resync. On a digest mismatch only one side — the one with
 * the smaller player id — asks straight away: its request lists what it has, so the partner sees
 * what *it* is missing too and asks back in the same round trip (`onAsked`). The other side asks
 * on its own only if the mismatch is still there at the next digest (the first request got lost).
 * So requests normally come back with something, and the backoff only bites when they don't.
 * Each method returns true when a 'sync?' should go out now.
 */
export function createResync({ meId, min = PULL_MIN_MS, max = PULL_MAX_MS } = {}) {
  const puller = createPuller({ min, max });
  let streak = 0; // digests in a row that didn't match
  return {
    onDigest(verdict, from, now) {
      if (verdict === 'match') {
        streak = 0;
        puller.reset();
        return false;
      }
      if (verdict !== 'mismatch') return false;
      streak++;
      if (String(meId) > String(from) && streak < 2) return false;
      return puller.take(now);
    },
    /**
     * The partner asked us; `hasMore` = its list shows strokes (or a clear) we're missing. Being
     * asked means the mismatch is being handled, so our own fallback request waits again.
     */
    onAsked(hasMore, now) {
      streak = 0;
      return !!hasMore && puller.take(now);
    },
    /** A reply arrived; `useful` = it repaired something, or the partner is asking back. */
    onReply(useful) {
      if (!useful) return;
      streak = 0;
      puller.reset();
    },
    /** A request went out for another reason (mount / reconnect). */
    note(now) {
      puller.note(now);
    },
    get gap() {
      return puller.gap;
    },
  };
}

/**
 * Collects points of the stroke being drawn and sends them in small batches.
 * `send(msg)` gets { id, color, size, t, e, mirror, o, pts, start?, end? } (≤ max points), where
 * `o` is the index of pts[0] within the stroke.
 */
export function createBatcher({ send, interval = FLUSH_MS, max = MAX_CHUNK, timers = globalThis }) {
  let meta = null;
  let pending = [];
  let start = false;
  let end = false;
  let timer = null;
  let sent = 0; // points of the current stroke already sent

  const chunk = (pts) => {
    const msg = { ...meta, o: sent, pts };
    sent += pts.length;
    if (start) msg.start = true;
    start = false;
    return msg;
  };

  const flush = () => {
    if (timer != null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (!meta) return;
    if (!pending.length && !start && !end) return;
    while (pending.length > max) {
      const msg = chunk(pending.slice(0, max));
      pending = pending.slice(max);
      send(msg);
    }
    const msg = chunk(pending);
    if (end) msg.end = true;
    pending = [];
    if (end) {
      meta = null;
      end = false;
    }
    send(msg);
  };
  const arm = () => {
    if (timer == null) timer = timers.setTimeout(flush, interval);
  };
  return {
    begin(m, pts = []) {
      if (meta) this.end();
      meta = { id: m.id, color: m.color, size: m.size, t: m.t, e: m.e, mirror: m.mirror ? 1 : 0 };
      pending = pts.slice();
      sent = 0;
      start = true;
      arm();
    },
    push(pt) {
      if (!meta) return;
      pending.push(pt);
      if (pending.length >= max) flush();
      else arm();
    },
    end() {
      if (!meta) return;
      end = true;
      flush();
    },
    flush,
    get active() {
      return !!meta;
    },
    dispose() {
      if (timer != null) timers.clearTimeout(timer);
      timer = null;
      meta = null;
      pending = [];
    },
  };
}

/** Paint one stroke onto a 2D context of size w × h (device pixels). Smoothed with quadratic curves. */
export function drawStroke(ctx, st, w, h) {
  const pts = st.pts;
  if (!pts || !pts.length) return;
  const sx = w / SPACE;
  const sy = h / SPACE;
  const lw = Math.max(1, st.size * sx);
  ctx.strokeStyle = st.color;
  ctx.fillStyle = st.color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const passes = st.mirror ? [0, 1] : [0];
  for (const m of passes) {
    const X = (x) => (m ? SPACE - x : x) * sx;
    const Y = (y) => y * sy;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (pts.length === 1 || (pts.length === 2 && first[0] === last[0] && first[1] === last[1])) {
      ctx.beginPath();
      ctx.arc(X(first[0]), Y(first[1]), lw / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(X(first[0]), Y(first[1]));
    if (pts.length === 2) {
      ctx.lineTo(X(last[0]), Y(last[1]));
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        const [x, y] = pts[i];
        const [nx, ny] = pts[i + 1];
        ctx.quadraticCurveTo(X(x), Y(y), X((x + nx) / 2), Y((y + ny) / 2));
      }
      ctx.lineTo(X(last[0]), Y(last[1]));
    }
    ctx.stroke();
  }
}

/** Paint a whole board (background + strokes) onto a context. */
export function paintBoard(ctx, board, w, h, bg = PAPER) {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  for (const s of board.strokes) drawStroke(ctx, s, w, h);
}

export function newStrokeId(meId, n, rand = Math.random) {
  const who = String(meId || 'x').replace(/[^A-Za-z0-9]/g, '').slice(0, 6) || 'x';
  return `${who}-${n.toString(36)}-${Math.floor(rand() * 1e9).toString(36)}`;
}

// ---------------------------------------------------------------------------------------------
// Browser-only helpers (never called at import time)
// ---------------------------------------------------------------------------------------------

// Exported images use the site's own type and colours (css/app.css): the drawing stays a sheet of
// paper, captions are set like a letter, and a collage is paper sheets laid out on the night page.
const FONT_UI = '"Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_DISPLAY = '"Instrument Serif", "Iowan Old Style", Georgia, serif';
const FONT_MONO = '"Geist Mono", ui-monospace, Menlo, monospace';
const NIGHT = '#0b0d14';
const PAPER_INK = '#1d1b24';
const PAPER_INK_2 = '#5b5666';

/**
 * Render a board to a fresh <canvas> (for PNG export / thumbnails). With a caption the sheet grows
 * a paper band below the drawing: the caption in the display serif, `sub` (names, the postmark) in mono.
 */
export function renderBoardImage(board, { width = 1200, aspect = 0.75, bg = PAPER, caption = '', sub = '' } = {}) {
  const h = Math.round(width * aspect);
  const band = caption ? Math.round(width * 0.16) : 0;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = h + band;
  const ctx = c.getContext('2d');
  paintBoard(ctx, board, width, h, bg);
  if (band) drawCaption(ctx, 0, h, width, band, caption, sub, bg);
  return c;
}

function drawCaption(ctx, x, y, w, hgt, caption, sub, bg) {
  const pad = Math.round(w * 0.04);
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, hgt);
  // A hairline between the drawing and its caption, inset like a margin on a letter.
  ctx.fillStyle = 'rgba(29, 27, 36, 0.12)';
  ctx.fillRect(x + pad, y, w - 2 * pad, Math.max(1, Math.round(w / 600)));
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = PAPER_INK;
  ctx.font = `400 ${Math.round(hgt * 0.34)}px ${FONT_DISPLAY}`;
  ctx.fillText(fit(ctx, caption, w - 2 * pad), x + pad, y + hgt * 0.5);
  ctx.fillStyle = PAPER_INK_2;
  ctx.font = `400 ${Math.round(hgt * 0.13)}px ${FONT_MONO}`;
  ctx.fillText(fit(ctx, sub || 'Same Sky', w - 2 * pad), x + pad, y + hgt * 0.78);
}

function fit(ctx, text, max) {
  let t = String(text || '');
  if (ctx.measureText(t).width <= max) return t;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/**
 * Several boards in a grid on the night page, each a paper sheet with a label and an optional
 * `meta` line under it (e.g. every round of Doodle Dash).
 */
export function renderCollage(items, { aspect = 0.75, cols = 2, cell = 600, bg = PAPER, title = '', sub = '' } = {}) {
  const gap = 32;
  const label = 72;
  const head = title ? 112 : 32;
  const foot = 64;
  const rows = Math.max(1, Math.ceil(items.length / cols));
  const ch = Math.round(cell * aspect);
  const c = document.createElement('canvas');
  c.width = cols * cell + (cols + 1) * gap;
  c.height = head + rows * (ch + label + gap) + foot - gap;
  const ctx = c.getContext('2d');
  ctx.fillStyle = NIGHT;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (title) {
    ctx.fillStyle = '#eef0f5';
    ctx.font = `400 48px ${FONT_DISPLAY}`;
    ctx.fillText(fit(ctx, title, c.width - 2 * gap), gap, 72);
  }
  items.forEach((it, i) => {
    const x = gap + (i % cols) * (cell + gap);
    const y = head + Math.floor(i / cols) * (ch + label + gap);
    const img = document.createElement('canvas');
    img.width = cell;
    img.height = ch;
    paintBoard(img.getContext('2d'), it.board, cell, ch, bg);
    ctx.save();
    roundRect(ctx, x, y, cell, ch, 16); // the on-screen sheet radius (--r-lg)
    ctx.clip();
    ctx.drawImage(img, x, y);
    ctx.restore();
    ctx.fillStyle = '#eef0f5';
    ctx.font = `500 26px ${FONT_UI}`;
    ctx.fillText(fit(ctx, it.label || '', cell), x, y + ch + 36);
    if (it.meta) {
      ctx.fillStyle = '#a3a9b8';
      ctx.font = `400 18px ${FONT_MONO}`;
      ctx.fillText(fit(ctx, it.meta, cell), x, y + ch + 62);
    }
  });
  ctx.fillStyle = '#7a8296';
  ctx.font = `400 18px ${FONT_MONO}`;
  ctx.fillText(fit(ctx, sub || 'Same Sky', c.width - 2 * gap), gap, c.height - 28);
  return c;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function dataUrlToBlob(url) {
  const [head, b64] = url.split(',');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: head.slice(5).split(';')[0] || 'image/png' });
}

/**
 * Save a canvas as a PNG. On phones this opens the share sheet ("Save Image" lands it in the
 * photo library); elsewhere it downloads the file. Must be called from a tap/click handler:
 * the blob is made synchronously so the share still counts as user-initiated.
 * Resolves to 'shared' | 'cancelled' | 'downloaded'.
 */
export async function downloadCanvas(canvas, filename = 'same-sky.png') {
  const blob = dataUrlToBlob(canvas.toDataURL('image/png'));
  const nav = globalThis.navigator;
  const touch = !!globalThis.matchMedia?.('(pointer: coarse)').matches;
  if (touch && nav?.canShare && typeof File === 'function') {
    const file = new File([blob], filename, { type: 'image/png' });
    let ok = false;
    try {
      ok = nav.canShare({ files: [file] });
    } catch {
      ok = false;
    }
    if (ok) {
      try {
        await nav.share({ files: [file], title: 'Same Sky' });
        return 'shared';
      } catch (err) {
        if (err?.name === 'AbortError') return 'cancelled';
        // Not allowed here (e.g. in-app browser): fall back to a download.
      }
    }
  }
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
  return 'downloaded';
}

export function saveBoardPNG(board, opts = {}) {
  return downloadCanvas(renderBoardImage(board, opts), opts.filename || 'same-sky-drawing.png');
}

/** Small preview as a data URL (for galleries). */
export function boardThumb(board, { width = 360, aspect = 0.75, bg = PAPER } = {}) {
  return renderBoardImage(board, { width, aspect, bg }).toDataURL('image/png');
}

/** Filename-safe slug. */
export function slug(text) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'drawing'
  );
}

// Boards are kept in sessionStorage too, so a refresh restores the drawing instantly (and the
// end-of-game galleries can show every round). Per tab, so two test profiles never collide.
const STORE_PREFIX = 'samesky:board:';

export function storeBoard(key, board) {
  try {
    globalThis.sessionStorage?.setItem(STORE_PREFIX + key, JSON.stringify(board));
  } catch {
    /* quota / private mode: the partner can still resync us */
  }
}

export function loadBoard(key, allowedBy = null) {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORE_PREFIX + key);
    if (!raw) return null;
    const b = mergeBoards(emptyBoard(), JSON.parse(raw), allowedBy);
    return b.strokes.length || b.epoch ? b : null;
  } catch {
    return null;
  }
}

/** Forget stored boards that don't belong to the current game (keys not starting with `keep`). */
export function pruneBoards(keep) {
  try {
    const ss = globalThis.sessionStorage;
    if (!ss) return;
    const drop = [];
    for (let i = 0; i < ss.length; i++) {
      const k = ss.key(i);
      if (k && k.startsWith(STORE_PREFIX) && !k.startsWith(STORE_PREFIX + keep)) drop.push(k);
    }
    drop.forEach((k) => ss.removeItem(k));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------------

/**
 * <DrawingBoard api boardKey aspect canDraw tools canClear defaultColor mirrorTool handle onInk emptyHint overlay />
 *  - boardKey: unique per drawing (e.g. `${gameCid}-${round}`); changing it means a new board, so
 *    give the component `key=${boardKey}` too.
 *  - canClear(fromId): who may clear (checked for incoming 'clear' too). Clearing always asks twice.
 *  - handle: a ref; gets { board(), savePNG(opts), thumb(opts) }.
 *  - onInk(count, mine): called when the number of strokes changes.
 *  - overlay: optional markup laid over the board (positioned by the game's CSS; no pointer events).
 */
export function DrawingBoard(props) {
  const { api, boardKey, aspect = 0.75, canDraw = true, tools = true, mirrorTool = false, emptyHint = '', bg = PAPER } = props;
  const meId = api.meId;
  const storeKey = props.storeKey || `${meId}:${boardKey}`;
  const propsRef = useRef(props);
  propsRef.current = props;

  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const penRef = useRef(null);
  const rtRef = useRef(null);
  if (!rtRef.current) {
    rtRef.current = {
      board: loadBoard(storeKey, api.players) || emptyBoard(),
      open: new Map(), // strokeId -> last update (ms) for strokes still being drawn
      baked: new Set(), // strokeIds painted into the base layer
      base: null,
      baseDirty: true,
      pending: false,
      raf: 0,
      to: 0,
      active: null, // { id, pointerId, last, rect }
      n: 0,
      // Exists from the first render: a pointerdown can beat the mount effects.
      batcher: createBatcher({ send: (msg) => propsRef.current.api.fx.send('stroke', { k: boardKey, ...msg }) }),
      saveTimer: 0,
      penTimer: 0,
      synced: false,
      resync: createResync({ meId: api.meId }),
    };
  }
  const rt = rtRef.current;

  const [color, setColor] = useState(props.defaultColor || PALETTE[0].c);
  const [sizeIx, setSizeIx] = useState(1);
  const [eraser, setEraser] = useState(false);
  const [mirror, setMirror] = useState(false);
  const [armed, setArmed] = useState(false);
  const [counts, setCounts] = useState(() => ({ all: rt.board.strokes.length, mine: countBy(rt.board, meId) }));

  // ----- drawing -----
  const draw = () => {
    rt.pending = false;
    const c = canvasRef.current;
    if (!c || !c.width) return;
    const W = c.width;
    const H = c.height;
    if (!rt.base || rt.base.width !== W || rt.base.height !== H) {
      rt.base = document.createElement('canvas');
      rt.base.width = W;
      rt.base.height = H;
      rt.baseDirty = true;
    }
    const bctx = rt.base.getContext('2d');
    const list = rt.board.strokes;
    if (!rt.baseDirty) {
      // Bake newly finished strokes on top, unless one lands below an already-baked stroke.
      const toBake = [];
      let bakedAfter = false;
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        if (rt.open.has(s.id)) continue;
        if (rt.baked.has(s.id)) {
          bakedAfter = true;
          continue;
        }
        if (bakedAfter) {
          rt.baseDirty = true;
          break;
        }
        toBake.push(s);
      }
      if (!rt.baseDirty) {
        for (let i = toBake.length - 1; i >= 0; i--) {
          drawStroke(bctx, toBake[i], W, H);
          rt.baked.add(toBake[i].id);
        }
      }
    }
    if (rt.baseDirty) {
      rt.baked = new Set();
      bctx.fillStyle = bg;
      bctx.fillRect(0, 0, W, H);
      for (const s of list) {
        if (rt.open.has(s.id)) continue;
        drawStroke(bctx, s, W, H);
        rt.baked.add(s.id);
      }
      rt.baseDirty = false;
    }
    const ctx = c.getContext('2d');
    ctx.drawImage(rt.base, 0, 0);
    for (const s of list) if (rt.open.has(s.id)) drawStroke(ctx, s, W, H);
  };

  const schedule = () => {
    if (rt.pending) return;
    rt.pending = true;
    const run = () => {
      cancelAnimationFrame(rt.raf);
      clearTimeout(rt.to);
      if (rt.pending) draw();
    };
    rt.raf = requestAnimationFrame(run);
    rt.to = setTimeout(run, 100); // rAF is paused in hidden tabs; keep the picture current anyway
  };

  const save = () => {
    clearTimeout(rt.saveTimer);
    rt.saveTimer = setTimeout(() => storeBoard(storeKey, rt.board), 400);
  };

  const commit = (next, { structural = false, rebuild = false } = {}) => {
    if (next === rt.board) return;
    rt.board = next;
    if (rebuild) rt.baseDirty = true;
    schedule();
    if (structural) {
      const c = { all: next.strokes.length, mine: countBy(next, meId) };
      setCounts((p) => (p.all === c.all && p.mine === c.mine ? p : c));
      save();
    }
  };

  // ----- local strokes -----
  const startStroke = (p, pointerId, rect) => {
    const ps = propsRef.current;
    const er = rt.tool.eraser;
    const stroke = {
      id: newStrokeId(meId, ++rt.n),
      by: meId,
      color: er ? bg : rt.tool.color,
      size: SIZES[rt.tool.sizeIx].v * (er ? ERASER_SCALE : 1),
      t: Math.max(0, Math.round(ps.api.now())),
      e: rt.board.epoch,
      mirror: rt.tool.mirror ? 1 : 0,
      pts: [p],
    };
    rt.active = { id: stroke.id, pointerId, last: p, rect };
    rt.open.set(stroke.id, Date.now());
    commit(addStroke(rt.board, stroke), { structural: true });
    rt.batcher.begin(stroke, [p]);
  };

  const finishStroke = () => {
    const a = rt.active;
    if (!a) return;
    rt.active = null;
    rt.batcher.end();
    rt.open.delete(a.id);
    schedule();
    save();
  };

  const addPoint = (p) => {
    const a = rt.active;
    if (dist(a.last, p) < MIN_STEP) return;
    const cur = findStroke(rt.board, a.id);
    if (!cur || cur.pts.length >= MAX_STROKE_PTS) {
      // Cleared/undone underneath us, or a very long scribble: continue as a fresh stroke.
      const { pointerId, rect, last } = a;
      rt.batcher.end();
      rt.open.delete(a.id);
      rt.active = null;
      startStroke(cur ? last : p, pointerId, rect);
      if (!cur) return;
    }
    rt.active.last = p;
    rt.open.set(rt.active.id, Date.now());
    commit(appendPoints(rt.board, rt.active.id, [p]));
    rt.batcher.push(p);
  };

  rt.tool = { color, sizeIx, eraser, mirror };

  const onDown = (e) => {
    if (!propsRef.current.canDraw || rt.active) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const c = canvasRef.current;
    try {
      c.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers can't always be captured */
    }
    const rect = c.getBoundingClientRect();
    startStroke(toBoardPoint(e.clientX, e.clientY, rect), e.pointerId, rect);
  };
  const onMove = (e) => {
    const a = rt.active;
    if (!a || e.pointerId !== a.pointerId) return;
    e.preventDefault();
    a.rect = canvasRef.current.getBoundingClientRect(); // the page may have scrolled (mouse wheel)
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    for (const ev of evs.length ? evs : [e]) {
      if (!rt.active) break;
      addPoint(toBoardPoint(ev.clientX, ev.clientY, rt.active.rect));
    }
  };
  const onUp = (e) => {
    if (rt.active && e.pointerId === rt.active.pointerId) finishStroke();
  };

  // ----- partner pen dot -----
  // A quiet dot in the partner's own colour that follows their pen. It moves with a transform
  // (not left/top), so following a fast scribble never triggers layout.
  const showPen = (pt, ending) => {
    const el = penRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    clearTimeout(rt.penTimer);
    if (pt) {
      const hidden = !el.classList.contains('on');
      if (hidden) el.style.transition = 'none'; // appear where the pen is, don't glide in from the last spot
      el.style.transform = `translate(${(pt[0] / SPACE) * wrap.clientWidth}px, ${(pt[1] / SPACE) * wrap.clientHeight}px)`;
      el.classList.toggle('flip-x', pt[0] > 760); // keep the name tag inside the board
      el.classList.toggle('flip-y', pt[1] > 900);
      if (hidden) {
        void el.offsetWidth;
        el.style.transition = '';
      }
      el.classList.add('on');
    }
    rt.penTimer = setTimeout(() => el.classList.remove('on'), ending ? 350 : 1200);
  };

  // ----- network -----
  const send = (kind, data) => propsRef.current.api.fx.send(kind, { k: boardKey, ...data });
  /** Ask the partner for what we're missing (they reply with just that). */
  const askSync = () => {
    rt.resync.note(Date.now());
    send('sync?', syncRequest(rt.board));
  };

  useEffect(() => {
    const players = () => propsRef.current.api.players || [];
    const okFrom = (d, from) => d && d.k === boardKey && from !== meId && players().includes(from);

    const offs = [
      api.fx.on('stroke', (d, from) => {
        if (!okFrom(d, from)) return;
        const before = rt.board;
        const next = applyStrokeMsg(before, d, from);
        const id = String(d.id);
        if (next === before) {
          // Nothing new to paint, but an empty (or already-synced) last chunk still ends the stroke.
          if (d.end && rt.open.delete(id)) {
            schedule();
            showPen(null, true);
          }
          return;
        }
        if (d.end) rt.open.delete(id);
        else rt.open.set(id, Date.now());
        if (rt.baked.has(id)) rt.baseDirty = true; // a stroke we had considered finished grew
        commit(next, { structural: next.strokes.length !== before.strokes.length || next.epoch !== before.epoch, rebuild: next.epoch !== before.epoch });
        if (d.end) save();
        const pts = Array.isArray(d.pts) ? d.pts : [];
        const last = sanitizePts(pts.slice(-1))[0];
        if (last || d.end) showPen(last, !!d.end);
      }),
      api.fx.on('undo', (d, from) => {
        if (!okFrom(d, from)) return;
        rt.open.delete(d.id);
        commit(applyUndo(rt.board, d.id, from), { structural: true, rebuild: true });
      }),
      api.fx.on('clear', (d, from) => {
        if (!okFrom(d, from) || !propsRef.current.canClear?.(from)) return;
        const next = applyClear(rt.board, d.epoch);
        if (next === rt.board) return;
        commit(next, { structural: true, rebuild: true });
        propsRef.current.onCleared?.(from);
      }),
      api.fx.on('sync?', (d, from) => {
        if (!okFrom(d, from)) return;
        // Their board is up (it mounted after ours and missed our ask): no need to ask again.
        rt.synced = true;
        // Their list shows strokes we never got (drawn while we were away, or lost): ask back,
        // and say so in the reply, so their request counts as a useful one.
        const back = rt.resync.onAsked(partnerHasMore(rt.board, d, rt.open), Date.now());
        const parts = syncPayloads(rt.board, boardKey, { open: rt.open, have: d.have });
        if (back) parts[0].more = 1;
        for (const part of parts) propsRef.current.api.fx.send('sync', part);
        if (back) send('sync?', syncRequest(rt.board));
      }),
      api.fx.on('sync', (d, from) => {
        if (!okFrom(d, from)) return;
        rt.synced = true;
        const next = mergeBoards(rt.board, d, players());
        // They still have lines we undid: their copy of our 'undo' got lost, send it again.
        const redo = missedUndos(rt.board, d, meId);
        for (const id of redo) send('undo', { id });
        // A reply that repaired something: the next problem may be asked about right away. Only
        // requests that keep coming back empty-handed back off.
        rt.resync.onReply(next !== rt.board || d.more === 1 || redo.length > 0);
        commit(next, { structural: true, rebuild: true });
      }),
      api.fx.on('digest', (d, from) => {
        if (!okFrom(d, from)) return;
        const verdict = compareDigest(rt.board, d, rt.open.keys());
        if (verdict === 'match') rt.synced = true;
        if (rt.resync.onDigest(verdict, from, Date.now())) send('sync?', syncRequest(rt.board));
      }),
    ];
    askSync();
    // The transport may not have been online yet when we asked; ask once more if nobody answered.
    const retry = setTimeout(() => !rt.synced && askSync(), 2500);
    // Anti-entropy: a lost chunk, undo or clear shows up as a digest mismatch on one side.
    const beat = setInterval(() => {
      if (!propsRef.current.api.partnerOnline) return;
      const msg = digestMessage(rt.board, rt.open.keys());
      if (msg) send('digest', msg);
    }, DIGEST_MS);
    // Strokes whose "end" got lost would otherwise stay "open" forever.
    const sweep = setInterval(() => {
      const t = Date.now();
      let changed = false;
      for (const [id, at] of rt.open) {
        if (rt.active?.id === id || (t - at < 4000 && findStroke(rt.board, id))) continue;
        rt.open.delete(id);
        changed = true;
      }
      if (changed) schedule();
    }, 1500);
    const flushSave = () => storeBoard(storeKey, rt.board);
    addEventListener('pagehide', flushSave);
    return () => {
      offs.forEach((off) => off());
      clearTimeout(retry);
      clearInterval(beat);
      clearInterval(sweep);
      removeEventListener('pagehide', flushSave);
      if (rt.active) finishStroke();
      rt.batcher.dispose();
      cancelAnimationFrame(rt.raf);
      clearTimeout(rt.to);
      clearTimeout(rt.saveTimer);
      clearTimeout(rt.penTimer);
      flushSave();
    };
  }, []);

  // Partner came back (reconnect / their refresh): swap boards again.
  const online = api.partnerOnline;
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) askSync();
    wasOnline.current = online;
  }, [online]);

  // Size the canvas to its box (devicePixelRatio aware) and repaint on resize.
  useEffect(() => {
    const c = canvasRef.current;
    const fitSize = () => {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2.5);
      const W = Math.max(1, Math.round(r.width * dpr));
      const H = Math.max(1, Math.round(r.height * dpr));
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
        rt.baseDirty = true;
      }
      schedule();
    };
    fitSize();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fitSize) : null;
    ro?.observe(c);
    addEventListener('resize', fitSize);
    return () => {
      ro?.disconnect();
      removeEventListener('resize', fitSize);
    };
  }, []);

  // Drawing turned off mid-stroke (time's up): finish it cleanly.
  useEffect(() => {
    if (!canDraw && rt.active) finishStroke();
  }, [canDraw]);

  useEffect(() => {
    propsRef.current.onInk?.(counts.all, counts.mine);
  }, [counts.all, counts.mine]);

  useEffect(() => {
    if (!armed) return undefined;
    const h = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(h);
  }, [armed]);

  if (props.handle) {
    props.handle.current = {
      board: () => rt.board,
      savePNG: (opts = {}) => saveBoardPNG(rt.board, { aspect, bg, ...opts }),
      thumb: (opts = {}) => boardThumb(rt.board, { aspect, bg, ...opts }),
    };
  }

  // ----- toolbar actions -----
  const undo = () => {
    const s = lastStrokeBy(rt.board, meId);
    if (!s) return;
    if (rt.active?.id === s.id) finishStroke();
    rt.open.delete(s.id);
    commit(applyUndo(rt.board, s.id, meId), { structural: true, rebuild: true });
    send('undo', { id: s.id });
    api.effects?.sound('tap');
  };
  const clear = () => {
    if (!armed) {
      setArmed(true);
      api.effects?.sound('tap');
      return;
    }
    setArmed(false);
    if (rt.active) finishStroke();
    const epoch = rt.board.epoch + 1;
    commit(applyClear(rt.board, epoch), { structural: true, rebuild: true });
    send('clear', { epoch });
    api.effects?.sound('whoosh');
  };
  const pickColor = (c) => {
    setColor(c);
    setEraser(false);
  };

  const showClear = !!props.canClear?.(meId);
  const empty = counts.all === 0;
  const partner = api.partner;
  const penColor = HEX.test(partner?.color || '') ? partner.color : PALETTE[0].c;

  // Toolbar: the eight pens in one row, the tools under them on the same eight columns (pen
  // sizes as dots, eraser, mirror first; undo and clear under the last two pens). On wider
  // screens the same two rows stand up as a strip beside the paper (css/canvas.css).
  return html`<div class=${`drawboard ${canDraw ? 'can-draw' : 'view-only'} ${tools && canDraw ? 'with-tools' : ''}`}>
    <div class="board-wrap" ref=${wrapRef} style=${`--ar:${(1 / aspect).toFixed(4)}`}>
      <canvas class="board-canvas" ref=${canvasRef} role="img"
        aria-label=${props.label || 'Shared drawing'}
        onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp} onLostPointerCapture=${onUp}
        onContextMenu=${(e) => e.preventDefault()}></canvas>
      ${empty && emptyHint && html`<div class="board-hint" aria-hidden="true">${emptyHint}</div>`}
      <div class="pen-dot" ref=${penRef} style=${`--pen:${penColor}`} aria-hidden="true"><i></i><span>${partner?.name || ''}</span></div>
      ${props.overlay}
    </div>
    ${tools && canDraw &&
    html`<div class="draw-tools">
      <div class="palette" role="radiogroup" aria-label="Pen colour">
        ${PALETTE.map(
          (p) => html`<button type="button" key=${p.c} role="radio" aria-checked=${!eraser && color === p.c} aria-label=${p.name} title=${p.name}
            class=${`swatch-btn ${!eraser && color === p.c ? 'sel' : ''}`} style=${`--c:${p.c}`} onClick=${() => pickColor(p.c)}><i></i></button>`,
        )}
      </div>
      <div class="tool-row">
        ${SIZES.map(
          (s, i) => html`<button type="button" key=${s.name} class=${`tool size-btn ${sizeIx === i ? 'sel' : ''}`} aria-pressed=${sizeIx === i}
            aria-label=${`${s.name} brush`} title=${s.name} onClick=${() => setSizeIx(i)}><i class=${`size-dot size-${i}`}></i></button>`,
        )}
        <button type="button" class=${`tool ${eraser ? 'sel' : ''}`} aria-pressed=${eraser} aria-label="Eraser" title="Eraser"
          onClick=${() => setEraser(!eraser)}><${Icon} name="eraser" /></button>
        ${mirrorTool &&
        html`<button type="button" class=${`tool ${mirror ? 'sel' : ''}`} aria-pressed=${mirror} aria-label="Mirror mode" title="Mirror mode"
          onClick=${() => setMirror(!mirror)}><${Icon} name="flip-vertical-2" /></button>`}
        <span class="tool-gap" aria-hidden="true"></span>
        <button type="button" class="tool" aria-label="Undo" title="Undo my last line" disabled=${!counts.mine} onClick=${undo}>
          <${Icon} name="undo-2" /></button>
        ${showClear &&
        html`<button type="button" class=${`tool tool-clear ${armed ? 'armed' : ''}`} aria-label=${armed ? 'Tap again to clear' : 'Clear'}
          title="Clear the canvas" disabled=${empty && !armed} onClick=${clear}>
          ${armed ? html`<span class="tool-txt">Sure?</span>` : html`<${Icon} name="trash-2" />`}</button>`}
      </div>
    </div>`}
  </div>`;
}
