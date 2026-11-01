// Shared real-time drawing board (used by Doodle Dash and Duet Canvas).
//
// Coordinates are integers 0..1000 on both axes of a fixed-aspect board, so both players see the
// same drawing whatever their screen size. A stroke is
//   { id, by, color, size, t, e, mirror, pts: [[x, y], ...] }
// where `size` is the brush width in board units (relative to the width), `t` the authority-clock
// start time (strokes are ordered by (t, id) so both screens stack them identically), `e` the clear
// "epoch" the stroke belongs to, and `mirror` (0/1) whether it is also painted mirrored.
//
// Strokes never go into game state. They travel over the game-scoped fx channel; every payload
// carries `k` (the board key) so a new round's board ignores stragglers from the previous one:
//   'stroke' { k, id, color, size, t, e, mirror, pts, start?, end? }   ≤ MAX_CHUNK points, ~every 50 ms
//   'undo'   { k, id }                 remove one of the sender's own strokes
//   'clear'  { k, epoch }              wipe everything older than `epoch`
//   'sync?'  { k }                     "I just (re)mounted — send me what you have"
//   'sync'   { k, epoch, tomb, strokes, part, parts }   reply, split into a few messages
// Merging is idempotent (union by id, minus tombstones, minus older epochs) so a sync can be
// applied in any order and any number of times.
//
// Everything above the "Browser-only" line is pure and runs in Node tests. DOM access only
// happens inside functions that the component calls in the browser.

import { html, useEffect, useRef, useState } from './h.js';

export const SPACE = 1000;
export const MAX_CHUNK = 60; // points per 'stroke' message
export const FLUSH_MS = 60; // batch interval while drawing (~16 msgs/s: well inside realtime quotas)
export const MAX_STROKE_PTS = 1200; // a longer scribble is split into several strokes
export const MAX_TOMB = 300;
export const SYNC_MAX_POINTS = 6000; // total points in one sync reply (all parts)
export const SYNC_PART_POINTS = 1500; // points per sync message
export const MIN_STEP = 2; // ignore pointer moves smaller than this (board units)
export const ERASER_SCALE = 2.4;

export const PAPER = '#fffaf3';
export const PALETTE = [
  { c: '#2a2148', name: 'Ink' },
  { c: '#ff5fa2', name: 'Pink' },
  { c: '#ff9b54', name: 'Peach' },
  { c: '#f7c548', name: 'Sunshine' },
  { c: '#34c78e', name: 'Mint' },
  { c: '#45a6f0', name: 'Sky' },
  { c: '#9a78ff', name: 'Lavender' },
  { c: '#ffffff', name: 'White' },
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
  const room = MAX_STROKE_PTS - cur.pts.length;
  if (room <= 0) return board;
  const strokes = board.strokes.slice();
  strokes[i] = { ...cur, pts: cur.pts.concat(room < pts.length ? pts.slice(0, room) : pts) };
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

/** Apply a live 'stroke' message from `from`. */
export function applyStrokeMsg(board, msg, from) {
  const s = sanitizeStroke(msg, from);
  if (!s) return board;
  let b = board;
  // A stroke from a newer epoch means we missed a clear: catch up.
  if (s.e > b.epoch) b = applyClear(b, s.e);
  if (s.e < b.epoch || b.tomb.includes(s.id)) return b;
  if (indexOf(b, s.id) < 0) return s.pts.length ? addStroke(b, s) : b;
  return appendPoints(b, s.id, s.pts, from);
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
 * two players. Union by id; a stroke we already have only grows (never shrinks).
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
      const i = indexOf(b, s.id);
      if (i < 0) {
        b = addStroke(b, s);
      } else if (b.strokes[i].pts.length < s.pts.length && b.strokes[i].by === s.by) {
        const strokes = b.strokes.slice();
        strokes[i] = { ...b.strokes[i], pts: s.pts };
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

/**
 * Build the 'sync' reply for a board: strokes simplified (more aggressively if needed) so the
 * whole reply stays under `maxPoints`, then split into parts of ≤ `partPoints` points. Open
 * (in-progress) strokes are sent as-is so later live chunks still line up. Always ≥ 1 part.
 */
export function syncPayloads(board, k, { open = null, maxPoints = SYNC_MAX_POINTS, partPoints = SYNC_PART_POINTS } = {}) {
  const isOpen = (s) => !!open && (open.has ? open.has(s.id) : false);
  const strip = (s, tol) => ({ id: s.id, by: s.by, color: s.color, size: s.size, t: s.t, e: s.e, mirror: s.mirror, pts: isOpen(s) || tol === 0 ? s.pts : simplifyPts(s.pts, tol) });
  let tol = 0.75;
  let list = board.strokes.map((s) => strip(s, tol));
  while (boardPointCount({ strokes: list }) > maxPoints && tol < 24) {
    tol *= 2;
    list = board.strokes.map((s) => strip(s, tol));
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
  return parts.map((strokes, i) => ({ k, epoch: board.epoch, tomb: i === 0 ? board.tomb.slice(-MAX_TOMB) : [], strokes, part: i + 1, parts: parts.length }));
}

/**
 * Collects points of the stroke being drawn and sends them in small batches.
 * `send(msg)` gets { id, color, size, t, e, mirror, pts, start?, end? } (≤ max points).
 */
export function createBatcher({ send, interval = FLUSH_MS, max = MAX_CHUNK, timers = globalThis }) {
  let meta = null;
  let pending = [];
  let start = false;
  let end = false;
  let timer = null;

  const flush = () => {
    if (timer != null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (!meta) return;
    if (!pending.length && !start && !end) return;
    while (pending.length > max) {
      const msg = { ...meta, pts: pending.slice(0, max) };
      if (start) msg.start = true;
      start = false;
      pending = pending.slice(max);
      send(msg);
    }
    const msg = { ...meta, pts: pending };
    if (start) msg.start = true;
    if (end) msg.end = true;
    pending = [];
    start = false;
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

/** Render a board to a fresh <canvas> (for PNG export / thumbnails), with an optional caption band. */
export function renderBoardImage(board, { width = 1200, aspect = 0.75, bg = PAPER, caption = '', sub = '' } = {}) {
  const h = Math.round(width * aspect);
  const band = caption ? Math.round(width * 0.14) : 0;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = h + band;
  const ctx = c.getContext('2d');
  paintBoard(ctx, board, width, h, bg);
  if (band) drawCaption(ctx, 0, h, width, band, caption, sub);
  return c;
}

function drawCaption(ctx, x, y, w, hgt, caption, sub) {
  ctx.fillStyle = '#1d1640';
  ctx.fillRect(x, y, w, hgt);
  const font = 'ui-rounded, "SF Pro Rounded", Nunito, system-ui, sans-serif';
  const pad = Math.round(hgt * 0.3);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f6f1ff';
  ctx.font = `800 ${Math.round(hgt * 0.3)}px ${font}`;
  ctx.fillText(fit(ctx, caption, w - 2 * pad), x + pad, y + hgt * 0.38);
  ctx.fillStyle = '#ffc6e0';
  ctx.font = `700 ${Math.round(hgt * 0.19)}px ${font}`;
  ctx.fillText(fit(ctx, sub || 'Same Sky 🌙', w - 2 * pad), x + pad, y + hgt * 0.74);
}

function fit(ctx, text, max) {
  let t = String(text || '');
  if (ctx.measureText(t).width <= max) return t;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** Several boards in a grid, each with a label (e.g. every round of Doodle Dash). */
export function renderCollage(items, { aspect = 0.75, cols = 2, cell = 600, bg = PAPER, title = '', sub = '' } = {}) {
  const gap = 24;
  const label = 56;
  const head = title ? 96 : 24;
  const rows = Math.max(1, Math.ceil(items.length / cols));
  const ch = Math.round(cell * aspect);
  const c = document.createElement('canvas');
  c.width = cols * cell + (cols + 1) * gap;
  c.height = head + rows * (ch + label + gap) + 40;
  const ctx = c.getContext('2d');
  const font = 'ui-rounded, "SF Pro Rounded", Nunito, system-ui, sans-serif';
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, '#2a1f5c');
  g.addColorStop(1, '#14102b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  if (title) {
    ctx.fillStyle = '#ffd479';
    ctx.font = `900 44px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fit(ctx, title, c.width - 2 * gap), c.width / 2, head / 2 + 6);
  }
  items.forEach((it, i) => {
    const x = gap + (i % cols) * (cell + gap);
    const y = head + Math.floor(i / cols) * (ch + label + gap);
    const img = document.createElement('canvas');
    img.width = cell;
    img.height = ch;
    paintBoard(img.getContext('2d'), it.board, cell, ch, bg);
    ctx.save();
    roundRect(ctx, x, y, cell, ch, 22);
    ctx.clip();
    ctx.drawImage(img, x, y);
    ctx.restore();
    ctx.fillStyle = '#f6f1ff';
    ctx.font = `800 28px ${font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(fit(ctx, it.label || '', cell - 8), x + 4, y + ch + label / 2);
  });
  ctx.fillStyle = '#b8acd9';
  ctx.font = `700 22px ${font}`;
  ctx.textAlign = 'right';
  ctx.fillText(sub || 'Same Sky 🌙', c.width - gap, c.height - 24);
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
 * <DrawingBoard api boardKey aspect canDraw tools canClear defaultColor mirrorTool handle onInk emptyHint />
 *  - boardKey: unique per drawing (e.g. `${gameCid}-${round}`); changing it means a new board, so
 *    give the component `key=${boardKey}` too.
 *  - canClear(fromId): who may clear (checked for incoming 'clear' too). Clearing always asks twice.
 *  - handle: a ref; gets { board(), savePNG(opts), thumb(opts) }.
 *  - onInk(count, mine): called when the number of strokes changes.
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
  const showPen = (pt, colorHex, ending) => {
    const el = penRef.current;
    if (!el) return;
    clearTimeout(rt.penTimer);
    if (pt) {
      el.style.left = `${pt[0] / 10}%`;
      el.style.top = `${pt[1] / 10}%`;
      el.style.setProperty('--pen', colorHex);
      el.classList.toggle('flip-x', pt[0] > 760); // keep the name tag inside the board
      el.classList.toggle('flip-y', pt[1] > 900);
      el.classList.add('on');
    }
    rt.penTimer = setTimeout(() => el.classList.remove('on'), ending ? 350 : 1200);
  };

  // ----- network -----
  const send = (kind, data) => propsRef.current.api.fx.send(kind, { k: boardKey, ...data });

  useEffect(() => {
    const players = () => propsRef.current.api.players || [];
    const okFrom = (d, from) => d && d.k === boardKey && from !== meId && players().includes(from);

    const offs = [
      api.fx.on('stroke', (d, from) => {
        if (!okFrom(d, from)) return;
        const before = rt.board;
        const next = applyStrokeMsg(before, d, from);
        if (next === before) return;
        const id = String(d.id);
        if (d.end) rt.open.delete(id);
        else rt.open.set(id, Date.now());
        if (rt.baked.has(id)) rt.baseDirty = true; // a stroke we had considered finished grew
        commit(next, { structural: next.strokes.length !== before.strokes.length || next.epoch !== before.epoch, rebuild: next.epoch !== before.epoch });
        if (d.end) save();
        const pts = Array.isArray(d.pts) ? d.pts : [];
        const last = sanitizePts(pts.slice(-1))[0];
        if (last || d.end) showPen(last, findStroke(next, id)?.color || '#ff7eb6', !!d.end);
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
        for (const part of syncPayloads(rt.board, boardKey, { open: rt.open })) propsRef.current.api.fx.send('sync', part);
      }),
      api.fx.on('sync', (d, from) => {
        if (!okFrom(d, from)) return;
        rt.synced = true;
        const next = mergeBoards(rt.board, d, players());
        commit(next, { structural: true, rebuild: true });
      }),
    ];
    send('sync?', {});
    // The transport may not have been online yet when we asked; ask once more if nobody answered.
    const retry = setTimeout(() => !rt.synced && send('sync?', {}), 2500);
    // Strokes whose "end" got lost would otherwise stay "open" forever.
    const sweep = setInterval(() => {
      const t = Date.now();
      let changed = false;
      for (const [id, at] of rt.open) {
        if (rt.active?.id === id || t - at < 4000) continue;
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
    if (online && !wasOnline.current) send('sync?', {});
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

  return html`<div class=${`drawboard ${canDraw ? 'can-draw' : 'view-only'}`}>
    <div class="board-wrap" ref=${wrapRef} style=${`--ar:${(1 / aspect).toFixed(4)}`}>
      <canvas class="board-canvas" ref=${canvasRef} role="img"
        aria-label=${props.label || 'Shared drawing'}
        onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp} onLostPointerCapture=${onUp}
        onContextMenu=${(e) => e.preventDefault()}></canvas>
      ${empty && emptyHint && html`<div class="board-hint" aria-hidden="true">${emptyHint}</div>`}
      <div class="pen-dot" ref=${penRef} aria-hidden="true"><i></i><span>${partner?.name || ''}</span></div>
    </div>
    ${tools && canDraw &&
    html`<div class="draw-tools">
      <div class="palette" role="radiogroup" aria-label="Colour">
        ${PALETTE.map(
          (p) => html`<button type="button" key=${p.c} role="radio" aria-checked=${!eraser && color === p.c} aria-label=${p.name}
            class=${`swatch-btn ${!eraser && color === p.c ? 'sel' : ''}`} style=${`--c:${p.c}`} onClick=${() => pickColor(p.c)}><i></i></button>`,
        )}
      </div>
      <div class="tool-row">
        ${SIZES.map(
          (s, i) => html`<button type="button" key=${s.name} class=${`tool size-btn ${sizeIx === i ? 'sel' : ''}`} aria-pressed=${sizeIx === i}
            aria-label=${`${s.name} brush`} onClick=${() => setSizeIx(i)}>
            <i style=${`width:${6 + i * 6}px;height:${6 + i * 6}px;background:${eraser ? '#fff' : color}`}></i></button>`,
        )}
        <button type="button" class=${`tool ${eraser ? 'sel' : ''}`} aria-pressed=${eraser} aria-label="Eraser" title="Eraser"
          onClick=${() => setEraser(!eraser)}><span class="tool-ico">🧽</span></button>
        ${mirrorTool &&
        html`<button type="button" class=${`tool ${mirror ? 'sel' : ''}`} aria-pressed=${mirror} aria-label="Mirror mode" title="Mirror mode"
          onClick=${() => setMirror(!mirror)}><span class="tool-ico">🦋</span></button>`}
        <button type="button" class="tool" aria-label="Undo" title="Undo my last line" disabled=${!counts.mine} onClick=${undo}>
          <span class="tool-ico">↶</span></button>
        ${showClear &&
        html`<button type="button" class=${`tool tool-clear ${armed ? 'armed' : ''}`} aria-label=${armed ? 'Tap again to clear' : 'Clear'}
          title="Clear the canvas" disabled=${empty && !armed} onClick=${clear}>
          ${armed ? html`<span class="tool-txt">Sure?</span>` : html`<span class="tool-ico">🗑️</span>`}</button>`}
      </div>
    </div>`}
  </div>`;
}
