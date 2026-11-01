import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPACE,
  MAX_CHUNK,
  MAX_STROKE_PTS,
  emptyBoard,
  toBoardPoint,
  sanitizeStroke,
  sanitizePts,
  addStroke,
  appendPoints,
  applyStrokeMsg,
  applyUndo,
  applyClear,
  mergeBoards,
  lastStrokeBy,
  countBy,
  simplifyPts,
  syncPayloads,
  boardPointCount,
  createBatcher,
  drawStroke,
  newStrokeId,
  findStroke,
  strokeLen,
  readHave,
  boardManifest,
  syncRequest,
  partnerHasMore,
  boardDigest,
  digestMessage,
  compareDigest,
  createPuller,
  createResync,
  missedUndos,
  DIGEST_MS,
  PULL_MIN_MS,
  PULL_MAX_MS,
  MAX_DIGEST_OPEN,
} from '../../js/ui/canvas.js';
import { FakeTime } from '../helpers/sim.js';

const S = (id, by, extra = {}) => ({ id, by, color: '#ff5fa2', size: 12, t: 100, e: 0, mirror: 0, pts: [[10, 10], [20, 20]], ...extra });

test('the module imports in Node without touching the DOM', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(SPACE, 1000);
});

test('pointer positions map to 0..1000 on both axes regardless of screen size', () => {
  const small = { left: 10, top: 20, width: 300, height: 225 };
  const big = { left: 0, top: 0, width: 1200, height: 900 };
  assert.deepEqual(toBoardPoint(10 + 150, 20 + 112.5, small), [500, 500]);
  assert.deepEqual(toBoardPoint(600, 450, big), [500, 500]);
  assert.deepEqual(toBoardPoint(-50, 5000, big), [0, 1000], 'clamped');
});

test('incoming strokes are sanitised', () => {
  assert.equal(sanitizeStroke(null, 'a'), null);
  assert.equal(sanitizeStroke({ id: 'bad id!', color: '#ffffff', size: 3 }, 'a'), null);
  assert.equal(sanitizeStroke({ id: 'ok', color: 'red', size: 3 }, 'a'), null);
  assert.equal(sanitizeStroke({ id: 'ok', color: '#ffffff', size: 'big' }, 'a'), null);
  assert.equal(sanitizeStroke({ id: 'ok', color: '#ffffff', size: 3 }, ''), null);
  const s = sanitizeStroke({ id: 'ok-1', color: '#ABCDEF', size: 9999, t: -5, e: 'x', mirror: 'yes', pts: [[1.4, 2.6], [5000, -3], 'junk', [NaN, 1], [3]] }, 'a');
  assert.deepEqual(s, { id: 'ok-1', by: 'a', color: '#abcdef', size: 80, t: 0, e: 0, mirror: 1, pts: [[1, 3], [1000, 0]] });
  assert.equal(sanitizePts(Array.from({ length: 5000 }, () => [1, 1])).length, MAX_STROKE_PTS);
});

test('live chunks build a stroke; only its author may extend it', () => {
  let b = emptyBoard();
  b = applyStrokeMsg(b, { id: 's1', color: '#000000', size: 5, t: 1, e: 0, pts: [[0, 0], [1, 1]], start: true }, 'alex');
  b = applyStrokeMsg(b, { id: 's1', color: '#000000', size: 5, t: 1, e: 0, pts: [[2, 2]] }, 'alex');
  assert.deepEqual(b.strokes[0].pts, [[0, 0], [1, 1], [2, 2]]);
  assert.equal(b.strokes[0].by, 'alex');
  const same = applyStrokeMsg(b, { id: 's1', color: '#000000', size: 5, t: 1, e: 0, pts: [[9, 9]] }, 'mallory');
  assert.equal(same, b, 'someone else cannot hijack a stroke');
  assert.equal(applyStrokeMsg(b, { id: 's1', color: '#000000', size: 5, pts: [] , end: true }, 'alex'), b, 'empty end chunk is a no-op');
  assert.equal(applyStrokeMsg(b, { junk: true }, 'alex'), b);
  // A chunk for a stroke we never saw the start of still shows up (e.g. we mounted mid-stroke).
  const b2 = applyStrokeMsg(b, { id: 's2', color: '#000000', size: 5, t: 2, e: 0, pts: [[5, 5]] }, 'blair');
  assert.equal(b2.strokes.length, 2);
});

test('strokes stay ordered by start time so both screens stack them identically', () => {
  let b = emptyBoard();
  b = addStroke(b, S('late', 'a', { t: 300 }));
  b = addStroke(b, S('early', 'b', { t: 100 }));
  b = addStroke(b, S('mid', 'a', { t: 200 }));
  b = addStroke(b, S('mid0', 'b', { t: 200 }));
  assert.deepEqual(b.strokes.map((s) => s.id), ['early', 'mid', 'mid0', 'late']);
  assert.equal(addStroke(b, S('mid', 'a')), b, 'duplicate id ignored');
});

test('appendPoints caps very long strokes', () => {
  let b = addStroke(emptyBoard(), S('s', 'a', { pts: Array.from({ length: MAX_STROKE_PTS - 1 }, (_, i) => [i % 1000, 1]) }));
  b = appendPoints(b, 's', [[1, 1], [2, 2], [3, 3]]);
  assert.equal(b.strokes[0].pts.length, MAX_STROKE_PTS);
  assert.equal(appendPoints(b, 's', [[4, 4]]), b);
  assert.equal(appendPoints(b, 'nope', [[4, 4]]), b);
});

test('undo removes only your own stroke and leaves a tombstone', () => {
  let b = addStroke(addStroke(emptyBoard(), S('a1', 'alex', { t: 1 })), S('b1', 'blair', { t: 2 }));
  assert.equal(lastStrokeBy(b, 'alex').id, 'a1');
  assert.equal(countBy(b, 'blair'), 1);
  assert.equal(applyUndo(b, 'a1', 'blair'), b, "can't undo your partner's line");
  b = applyUndo(b, 'a1', 'alex');
  assert.deepEqual(b.strokes.map((s) => s.id), ['b1']);
  assert.deepEqual(b.tomb, ['a1']);
  // A late chunk for the undone stroke doesn't bring it back.
  assert.equal(applyStrokeMsg(b, { id: 'a1', color: '#000000', size: 3, pts: [[1, 1]] }, 'alex'), b);
  assert.equal(applyUndo(b, 'bad id!', 'alex'), b);
  const t = applyUndo(b, 'unknown', 'alex');
  assert.deepEqual(t.tomb, ['a1', 'unknown'], 'unknown ids are remembered for later syncs');
});

test('clear bumps the epoch; older strokes and stragglers are dropped', () => {
  let b = addStroke(addStroke(emptyBoard(), S('a1', 'alex')), S('b1', 'blair'));
  b = applyUndo(b, 'a1', 'alex');
  const c = applyClear(b, 1);
  assert.deepEqual(c, { strokes: [], tomb: [], epoch: 1 });
  assert.equal(applyClear(c, 1), c, 'idempotent');
  assert.equal(applyClear(c, 0), c, 'never goes back');
  assert.equal(applyClear(c, 'x'), c);
  assert.equal(applyStrokeMsg(c, { id: 'old', color: '#000000', size: 3, e: 0, pts: [[1, 1]] }, 'blair'), c);
  // A stroke from a newer epoch means we missed a clear: catch up.
  const d = applyStrokeMsg(addStroke(c, S('x', 'alex', { e: 1 })), { id: 'n', color: '#000000', size: 3, e: 2, pts: [[1, 1]] }, 'blair');
  assert.equal(d.epoch, 2);
  assert.deepEqual(d.strokes.map((s) => s.id), ['n']);
});

test('sync: payloads are capped and split, and merging them rebuilds the same board', () => {
  let b = emptyBoard();
  for (let i = 0; i < 60; i++) {
    const pts = Array.from({ length: 200 }, (_, j) => [j * 5, Math.round(500 + 200 * Math.sin((j + i) / 7))]);
    b = addStroke(b, { id: `s${i}`, by: i % 2 ? 'alex' : 'blair', color: '#2a2148', size: 5, t: i, e: 0, mirror: 0, pts });
  }
  b = applyUndo(b, 's3', 'alex');
  assert.ok(boardPointCount(b) > 10_000);
  const parts = syncPayloads(b, 'K');
  const total = parts.reduce((n, p) => n + p.strokes.reduce((m, s) => m + s.pts.length, 0), 0);
  assert.ok(total <= 6000, `total ${total}`);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    assert.equal(p.k, 'K');
    assert.equal(p.parts, parts.length);
    assert.ok(JSON.stringify(p).length < 40_000, 'each message stays small');
  }
  assert.deepEqual(parts[0].tomb, ['s3']);
  // Merge in any order, any number of times.
  let r = emptyBoard();
  for (const p of [...parts].reverse()) r = mergeBoards(r, p, ['alex', 'blair']);
  for (const p of parts) r = mergeBoards(r, p, ['alex', 'blair']);
  assert.deepEqual(r.strokes.map((s) => s.id), b.strokes.map((s) => s.id));
  assert.deepEqual(r.tomb, ['s3']);
  // An empty board still answers (so the asker learns the epoch / tombstones).
  const empty = syncPayloads({ strokes: [], tomb: [], epoch: 4 }, 'K');
  assert.equal(empty.length, 1);
  assert.equal(mergeBoards(emptyBoard(), empty[0]).epoch, 4);
});

test('sync merge: union by id, tombstones win, strokes only grow, strangers rejected', () => {
  const mine = addStroke(addStroke(emptyBoard(), S('a1', 'alex', { t: 1 })), S('b1', 'blair', { t: 2, pts: [[1, 1], [2, 2], [3, 3]] }));
  const theirs = {
    epoch: 0,
    tomb: ['a1'],
    strokes: [S('b1', 'blair', { t: 2 }), S('b2', 'blair', { t: 3 }), S('z1', 'eve', { t: 4 }), { id: 'broken' }],
  };
  const m = mergeBoards(mine, theirs, ['alex', 'blair']);
  assert.deepEqual(m.strokes.map((s) => s.id), ['b1', 'b2']);
  assert.equal(m.strokes[0].pts.length, 3, 'a shorter copy never replaces a longer one');
  assert.equal(mergeBoards(m, theirs, ['alex', 'blair']), m, 'idempotent: same object');
  assert.equal(mergeBoards(m, null), m);
  // Newer epoch from the partner clears our older strokes first.
  const cleared = mergeBoards(m, { epoch: 1, tomb: [], strokes: [S('n1', 'alex', { e: 1 })] }, ['alex', 'blair']);
  assert.deepEqual(cleared.strokes.map((s) => s.id), ['n1']);
  assert.equal(cleared.epoch, 1);
  // Missing chunks are filled in by a longer copy.
  const grown = mergeBoards(mine, { strokes: [S('a1', 'alex', { t: 1, pts: [[1, 1], [2, 2], [3, 3], [4, 4]] })] }, ['alex', 'blair']);
  assert.equal(grown.strokes[0].pts.length, 4);
});

test('simplification keeps the shape with fewer points', () => {
  const line = Array.from({ length: 100 }, (_, i) => [i * 10, 500]);
  assert.deepEqual(simplifyPts(line, 1), [[0, 500], [990, 500]]);
  const corner = [[0, 0], [50, 1], [100, 0], [100, 50], [101, 100]];
  assert.deepEqual(simplifyPts(corner, 2), [[0, 0], [100, 0], [101, 100]]);
  assert.deepEqual(simplifyPts([[1, 1]], 2), [[1, 1]]);
});

test('batcher: start chunk, ~60 ms batches, ≤ 60 points per message, end flag', () => {
  const time = new FakeTime();
  const sent = [];
  const bt = createBatcher({ send: (m) => sent.push(m), timers: time.timers });
  bt.begin({ id: 's1', color: '#000000', size: 5, t: 9, e: 0, mirror: 0 }, [[0, 0]]);
  assert.equal(sent.length, 0, 'not sent synchronously');
  time.advance(60, 10);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { id: 's1', color: '#000000', size: 5, t: 9, e: 0, mirror: 0, o: 0, pts: [[0, 0]], start: true });
  for (let i = 1; i <= 130; i++) bt.push([i, i]);
  // 2 full chunks went out immediately, the rest waits for the timer.
  assert.equal(sent.length, 3);
  assert.ok(sent.slice(1).every((m) => m.pts.length === MAX_CHUNK && !m.start && !m.end));
  assert.deepEqual(sent.map((m) => m.o), [0, 1, 61], 'each chunk says where its points go');
  time.advance(60, 10);
  assert.equal(sent.length, 4);
  assert.equal(sent[3].pts.length, 10);
  time.advance(500, 10);
  assert.equal(sent.length, 4, 'nothing to send while idle');
  bt.push([200, 200]);
  bt.end();
  assert.equal(sent.length, 5);
  assert.deepEqual(sent[4].pts, [[200, 200]]);
  assert.equal(sent[4].end, true);
  assert.equal(sent[4].o, 131);
  assert.equal(bt.active, false);
  bt.push([1, 1]);
  time.advance(200, 10);
  assert.equal(sent.length, 5, 'ignored after end');
  // The receiver rebuilds exactly the stroke that was drawn.
  let b = emptyBoard();
  for (const m of sent) b = applyStrokeMsg(b, m, 'alex');
  assert.equal(b.strokes[0].pts.length, 132);
});

test('drawStroke paints dots, smooth curves and mirrored copies', () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (k in ctx_props ? ctx_props[k] : (...args) => calls.push([k, ...args])),
    set: (_, k, v) => ((ctx_props[k] = v), true),
  });
  const ctx_props = {};
  drawStroke(ctx, S('dot', 'a', { pts: [[500, 500]], size: 10 }), 1000, 750);
  assert.equal(calls.filter((c) => c[0] === 'arc').length, 1);
  assert.equal(calls.find((c) => c[0] === 'arc')[3], 5);
  calls.length = 0;
  drawStroke(ctx, S('curve', 'a', { pts: [[0, 0], [100, 100], [200, 0], [300, 100]], mirror: 1 }), 2000, 1500);
  assert.equal(calls.filter((c) => c[0] === 'stroke').length, 2, 'mirror paints twice');
  assert.equal(calls.filter((c) => c[0] === 'quadraticCurveTo').length, 4);
  const moves = calls.filter((c) => c[0] === 'moveTo');
  assert.deepEqual(moves[0].slice(1), [0, 0]);
  assert.deepEqual(moves[1].slice(1), [2000, 0], 'mirrored across the vertical centre');
  assert.equal(ctx_props.lineCap, 'round');
  assert.equal(ctx_props.lineWidth, 24);
});

test('stroke ids are unique-ish and safe', () => {
  const ids = new Set(Array.from({ length: 500 }, (_, i) => newStrokeId('abc:DEF', i)));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,40}$/);
});

// ---------------------------------------------------------------------------------------------
// Lost messages: chunk offsets, logical lengths, digests and targeted resyncs
// ---------------------------------------------------------------------------------------------

const P = ['alex', 'blair'];
const line = (n, y = 500) => Array.from({ length: n }, (_, i) => [i * 3, y + (i % 7)]);
const chunkMsg = (id, o, pts, extra = {}) => ({ id, color: '#2a2148', size: 5, t: 1, e: 0, mirror: 0, o, pts, ...extra });

test('chunk offsets: a chunk a sync already delivered is skipped, never doubled', () => {
  const full = line(10);
  let b = applyStrokeMsg(emptyBoard(), chunkMsg('s1', 0, full.slice(0, 4), { start: true }), 'alex');
  // A sync overtakes the live chunks and delivers 8 points…
  b = mergeBoards(b, { epoch: 0, strokes: [{ ...chunkMsg('s1', 0, full.slice(0, 8)), by: 'alex' }] }, P);
  assert.equal(b.strokes[0].pts.length, 8);
  // …then the chunk with points 4..7 arrives: nothing new.
  assert.equal(applyStrokeMsg(b, chunkMsg('s1', 4, full.slice(4, 8)), 'alex'), b);
  // A chunk that overlaps only partly adds just the new part.
  const c = applyStrokeMsg(b, chunkMsg('s1', 6, full.slice(6, 10), { end: true }), 'alex');
  assert.deepEqual(c.strokes[0].pts, full);
  // The same chunk twice is a no-op.
  assert.equal(applyStrokeMsg(c, chunkMsg('s1', 6, full.slice(6, 10), { end: true }), 'alex'), c);
  // Chunks without an offset (an older client) still append.
  assert.equal(applyStrokeMsg(c, { ...chunkMsg('s1', 0, [[1, 1]]), o: undefined }, 'alex').strokes[0].pts.length, 11);
});

test('a lost chunk is bridged for now and leaves the copy short, so digests can tell', () => {
  const full = line(9);
  let b = applyStrokeMsg(emptyBoard(), chunkMsg('s1', 0, full.slice(0, 3), { start: true }), 'alex');
  // chunk 3..5 lost
  b = applyStrokeMsg(b, chunkMsg('s1', 6, full.slice(6, 9), { end: true }), 'alex');
  assert.deepEqual(b.strokes[0].pts, [...full.slice(0, 3), ...full.slice(6, 9)], 'order kept, gap bridged');
  assert.equal(strokeLen(b.strokes[0]), 6);
  const author = addStroke(emptyBoard(), { ...chunkMsg('s1', 0, full), by: 'alex' });
  assert.notDeepEqual(boardDigest(b), boardDigest(author));
  // The author's copy (full length) replaces the short one.
  const fixed = mergeBoards(b, syncPayloads(author, 'K', { have: boardManifest(b) })[0], P);
  assert.deepEqual(fixed.strokes[0].pts, full);
  assert.deepEqual(boardDigest(fixed), boardDigest(author));
});

test('a simplified sync copy remembers its real length, so it counts as complete', () => {
  const long = Array.from({ length: 400 }, (_, i) => [i * 2, 500]); // a straight line simplifies to 2 points
  const author = addStroke(emptyBoard(), { ...chunkMsg('s1', 0, long), by: 'alex' });
  assert.deepEqual(syncPayloads(author, 'K')[0].strokes[0].pts, long, 'exact while it fits the budget');
  const [part] = syncPayloads(author, 'K', { maxPoints: 100 });
  assert.equal(part.strokes[0].pts.length, 2);
  assert.equal(part.strokes[0].n, 400);
  const copy = mergeBoards(emptyBoard(), part, P);
  assert.equal(strokeLen(copy.strokes[0]), 400);
  assert.deepEqual(boardDigest(copy), boardDigest(author), 'same fingerprint as the original');
  // An exact copy of the same length doesn't replace it (nothing gained), a longer one would.
  assert.equal(mergeBoards(copy, { strokes: [author.strokes[0]] }, P), copy);
  // Live points after a simplified copy land after its real length.
  const grown = applyStrokeMsg(copy, chunkMsg('s1', 400, [[999, 999]]), 'alex');
  assert.equal(strokeLen(grown.strokes[0]), 401);
  assert.equal(applyStrokeMsg(copy, chunkMsg('s1', 390, line(10)), 'alex'), copy, 'already covered');
  // Junk lengths are ignored; stored boards keep `n` across a reload.
  for (const n of [1, -5, 'x', 1e9, 2.5]) {
    const m = mergeBoards(emptyBoard(), { strokes: [{ ...part.strokes[0], n }] }, P);
    assert.equal(m.strokes[0].n, undefined, `n=${n}`);
  }
  assert.equal(mergeBoards(emptyBoard(), JSON.parse(JSON.stringify(copy)), P).strokes[0].n, 400);
  // A live message can't claim a length it doesn't have.
  const fake = applyStrokeMsg(emptyBoard(), chunkMsg('s9', 0, [[1, 1]], { n: 900 }), 'alex');
  assert.equal(strokeLen(fake.strokes[0]), 1);
});

test("targeted sync: only what the asker lacks, and the tombstones of what it still has", () => {
  let mine = emptyBoard();
  for (let i = 0; i < 5; i++) mine = addStroke(mine, { ...chunkMsg(`s${i}`, 0, line(20, 100 * i)), t: i, by: P[i % 2] });
  mine = applyUndo(mine, 's4', 'alex');
  mine = applyUndo(mine, 'zz', 'alex'); // an id the asker never had
  let theirs = mergeBoards(emptyBoard(), { strokes: mine.strokes.slice(0, 3).map((s) => ({ ...s, pts: s.pts.slice(0, s.id === 's1' ? 12 : 20) })) }, P);
  theirs = addStroke(theirs, { ...chunkMsg('s4', 0, line(5)), t: 4, by: 'alex' }); // its undo got lost
  const req = syncRequest(theirs);
  assert.deepEqual(req.have.map(([id, n]) => `${id}:${n}`), ['s0:20', 's1:12', 's2:20', 's4:5']);
  assert.deepEqual(readHave([['ok', 3], ['bad id!', 1], ['x', -1], ['y', 1.5], 'junk', ['z']]), new Map([['ok', 3]]));
  assert.equal(readHave('nope'), null);
  const parts = syncPayloads(mine, 'K', { have: req.have });
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].strokes.map((s) => s.id), ['s1', 's3'], 'the short copy and the missing stroke');
  assert.deepEqual(parts[0].tomb, ['s4'], 'only tombstones that matter to the asker');
  const fixed = mergeBoards(theirs, parts[0], P);
  assert.deepEqual(boardDigest(fixed), boardDigest(mine));
  // Nothing missing → one tiny reply that still carries the epoch.
  const none = syncPayloads(mine, 'K', { have: syncRequest(fixed).have });
  assert.equal(none.length, 1);
  assert.deepEqual(none[0].strokes, []);
  assert.equal(none[0].epoch, mine.epoch);
  // Too many strokes to list: the request carries no list and gets everything.
  assert.equal(boardManifest(mine, 3), null);
});

test('missedUndos: our own undone strokes coming back in a reply mean our undo was lost', () => {
  let mine = addStroke(emptyBoard(), { ...chunkMsg('a1', 0, line(5)), by: 'alex' });
  mine = applyUndo(mine, 'a1', 'alex');
  mine = applyUndo(mine, 'b9', 'blair'); // someone else's id in our tombstones
  const reply = { strokes: [{ ...chunkMsg('a1', 0, line(5)), by: 'alex' }, { ...chunkMsg('b9', 0, line(5)), by: 'blair' }, null, { id: 7 }] };
  assert.deepEqual(missedUndos(mine, reply, 'alex'), ['a1']);
  assert.deepEqual(missedUndos(mine, reply, 'blair'), ['b9']);
  assert.deepEqual(missedUndos(emptyBoard(), reply, 'alex'), []);
  assert.deepEqual(missedUndos(mine, null, 'alex'), []);
});

test('partnerHasMore: their list (or a newer clear) shows strokes we are missing', () => {
  const mine = addStroke(emptyBoard(), { ...chunkMsg('a1', 0, line(10)), by: 'alex' });
  assert.equal(partnerHasMore(mine, { epoch: 0, have: [['a1', 10]] }), false);
  assert.equal(partnerHasMore(mine, { epoch: 0, have: [['a1', 12]] }), true, 'their copy is longer');
  assert.equal(partnerHasMore(mine, { epoch: 0, have: [['b1', 3]] }), true, 'a stroke we never got');
  assert.equal(partnerHasMore(mine, { epoch: 0, have: [['b1', 3]] }, new Map([['b1', 1]])), false, 'still being drawn');
  assert.equal(partnerHasMore(applyUndo(mine, 'b1', 'blair'), { epoch: 0, have: [['b1', 3]] }), false, 'we already undid it');
  assert.equal(partnerHasMore(mine, { epoch: 1 }), true, 'they cleared, we missed it');
  assert.equal(partnerHasMore(mine, { epoch: 0 }), false);
  assert.equal(partnerHasMore(applyClear(mine, 2), { epoch: 1, have: [['old', 5]] }), false, 'their strokes predate our clear');
  assert.equal(partnerHasMore(mine, null), false);
});

test('digest: order-independent fingerprint of finished strokes; open strokes are left out', () => {
  const s1 = { ...chunkMsg('s1', 0, line(10)), t: 1, by: 'alex' };
  const s2 = { ...chunkMsg('s2', 0, line(4)), t: 2, by: 'blair' };
  const a = addStroke(addStroke(emptyBoard(), s1), s2);
  const b = addStroke(addStroke(emptyBoard(), { ...s2, t: 0 }), s1); // stacked differently
  assert.deepEqual(boardDigest(a), boardDigest(b));
  assert.equal(boardDigest(a).count, 2);
  assert.notEqual(boardDigest(a).hash, boardDigest(appendPoints(a, 's1', [[1, 1]])).hash, 'one more point changes it');
  assert.notDeepEqual(boardDigest(a), boardDigest(applyUndo(a, 's2', 'blair')));
  assert.notDeepEqual(boardDigest(a), boardDigest(applyClear(a, 1)));
  assert.deepEqual(boardDigest(a, new Set(['s2'])), boardDigest(addStroke(emptyBoard(), s1)));

  const msg = digestMessage(a, ['s2']);
  assert.deepEqual(msg.open, ['s2']);
  assert.equal(msg.count, 1);
  assert.ok(JSON.stringify(msg).length < 120, 'lightweight');
  assert.equal(digestMessage(a, Array.from({ length: MAX_DIGEST_OPEN + 1 }, (_, i) => `o${i}`)), null);

  assert.equal(compareDigest(b, digestMessage(a)), 'match');
  assert.equal(compareDigest(addStroke(emptyBoard(), s1), digestMessage(a)), 'mismatch');
  // s2 still being drawn on the sender: compared without it, whatever our copy of it looks like.
  const partial = addStroke(emptyBoard(), s1);
  const growing = addStroke(partial, { ...s2, pts: s2.pts.slice(0, 1) });
  assert.equal(compareDigest(growing, digestMessage(a, ['s2']), ['s2']), 'match');
  assert.equal(compareDigest(partial, digestMessage(a, ['s2'])), 'match');
  // We are drawing something the sender hasn't seen yet: can't tell, wait for the next one.
  assert.equal(compareDigest(addStroke(a, { ...s2, id: 'mine' }), digestMessage(a), ['mine']), 'busy');
  assert.equal(compareDigest(a, { ...digestMessage(a), epoch: 1 }), 'mismatch');
  for (const junk of [null, 'x', {}, { epoch: -1, count: 0, hash: 0 }, { epoch: 0, count: 1.5, hash: 0 }, { epoch: 0, count: 0, hash: 2 ** 33 }]) {
    assert.equal(compareDigest(a, junk), 'invalid');
  }
  assert.equal(compareDigest(a, { ...digestMessage(a), open: Array(MAX_DIGEST_OPEN + 1).fill('x') }), 'busy');
});

test('resync requests back off while a mismatch persists and reset once boards match', () => {
  const p = createPuller();
  assert.equal(p.take(0), true);
  assert.equal(p.take(1000), false, 'not again right away');
  const times = [];
  for (let t = 0; t <= 400_000; t += 3000) if (p.take(t)) times.push(t);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]), `growing gaps ${gaps}`);
  assert.ok(gaps.at(-1) <= PULL_MAX_MS + 3000 && gaps.at(-1) >= PULL_MAX_MS, `capped: ${gaps.at(-1)}`);
  assert.ok(times.length < 15, `${times.length} requests in ~7 minutes of mismatch`);
  p.reset();
  assert.equal(p.gap, PULL_MIN_MS);
  p.note(500_000);
  assert.equal(p.take(500_000 + PULL_MIN_MS - 1), false, 'a request just went out for another reason');
  assert.equal(p.take(500_000 + PULL_MIN_MS), true);
});

test('resync policy: one side asks first, the other only if the mismatch outlives a digest', () => {
  const alex = createResync({ meId: 'alex' });
  const blair = createResync({ meId: 'blair' });
  let now = 0;
  assert.equal(alex.onDigest('mismatch', 'blair', now), true, 'smaller id asks straight away');
  assert.equal(blair.onDigest('mismatch', 'alex', now), false, 'the other waits…');
  now += DIGEST_MS;
  assert.equal(blair.onDigest('mismatch', 'alex', now), true, '…and steps in if it is still there');
  assert.equal(alex.onDigest('busy', 'blair', now), false);
  assert.equal(alex.onDigest('invalid', 'blair', now), false);
  // Being asked hands the problem to the asker: the fallback waits again.
  blair.onAsked(false, now);
  now += DIGEST_MS;
  assert.equal(blair.onDigest('mismatch', 'alex', now), false);
  // Asking back only when their list shows something we lack, and within the rate limit.
  const c = createResync({ meId: 'zed' });
  assert.equal(c.onAsked(false, 0), false);
  assert.equal(c.onAsked(true, 0), true);
  assert.equal(c.onAsked(true, 10), false, 'rate-limited');
  // Requests that come back empty-handed back off; a useful reply or a match resets.
  const d = createResync({ meId: 'a' });
  let t = 0;
  const asks = [];
  for (let i = 0; i < 30; i++, t += DIGEST_MS) if (d.onDigest('mismatch', 'b', t)) asks.push(t);
  assert.ok(asks.length < 8, `${asks.length} asks in 90 s of useless replies`);
  d.onReply(true);
  assert.equal(d.gap, PULL_MIN_MS);
  assert.equal(d.onDigest('mismatch', 'b', t + PULL_MIN_MS), true);
  d.onDigest('match', 'b', t + 2 * PULL_MIN_MS);
  assert.equal(d.gap, PULL_MIN_MS);
});

/**
 * Two boards wired like DrawingBoard does it (stroke/undo/clear/sync?/sync/digest, createResync),
 * over a lossy in-order pipe with a fake clock. `drop(msg)` decides which messages are lost.
 */
function lossyPair() {
  const peers = {};
  const queue = [];
  const stats = { sent: {}, dropped: 0 };
  const clock = { now: 1_000_000 };
  let drop = () => false;
  const mk = (me, other) => {
    const peer = { me, board: emptyBoard(), open: new Set(), resync: createResync({ meId: me }), n: 0 };
    peer.send = (kind, data) => {
      stats.sent[kind] = (stats.sent[kind] || 0) + 1;
      if (drop({ kind, data, from: me })) stats.dropped++;
      else queue.push({ to: other, kind, data, from: me });
    };
    peer.ask = () => peer.send('sync?', syncRequest(peer.board));
    peer.on = {
      stroke(d, from) {
        peer.board = applyStrokeMsg(peer.board, d, from);
        if (d.end) peer.open.delete(d.id);
        else if (findStroke(peer.board, d.id)) peer.open.add(d.id);
      },
      undo(d, from) {
        peer.open.delete(d.id);
        peer.board = applyUndo(peer.board, d.id, from);
      },
      clear(d) {
        peer.board = applyClear(peer.board, d.epoch);
      },
      'sync?'(d) {
        const back = peer.resync.onAsked(partnerHasMore(peer.board, d, peer.open), clock.now);
        const parts = syncPayloads(peer.board, 'K', { open: peer.open, have: d.have });
        if (back) parts[0].more = 1;
        for (const part of parts) peer.send('sync', part);
        if (back) peer.ask();
      },
      sync(d) {
        const next = mergeBoards(peer.board, d, P);
        const redo = missedUndos(peer.board, d, me);
        for (const id of redo) peer.send('undo', { id });
        peer.resync.onReply(next !== peer.board || d.more === 1 || redo.length > 0);
        if (next === peer.board && !d.more && !redo.length) stats.uselessReplies = (stats.uselessReplies || 0) + 1;
        peer.board = next;
      },
      digest(d, from) {
        const v = compareDigest(peer.board, d, peer.open);
        stats[v] = (stats[v] || 0) + 1;
        if (peer.resync.onDigest(v, from, clock.now)) peer.ask();
      },
    };
    peer.digest = () => {
      const m = digestMessage(peer.board, peer.open);
      if (m) peer.send('digest', m);
    };
    /** Draw a stroke of `len` points through a real batcher (one chunk per `per` points). */
    peer.draw = (len, { per = 7, keepOpen = false } = {}) => {
      const id = `${me}-${++peer.n}`;
      const st = { id, by: me, color: '#2a2148', size: 5, t: peer.n, e: peer.board.epoch, mirror: 0, pts: [[0, peer.n]] };
      const bt = createBatcher({ send: (m) => peer.send('stroke', m), max: per, timers: { setTimeout: () => 0, clearTimeout() {} } });
      peer.board = addStroke(peer.board, st);
      peer.open.add(id);
      bt.begin(st, st.pts);
      for (let i = 1; i < len; i++) {
        const pt = [i % 1000, (peer.n * 37 + i) % 1000];
        peer.board = appendPoints(peer.board, id, [pt]);
        bt.push(pt); // a full chunk (per points) goes out at once
      }
      if (keepOpen) return { id, end: () => (bt.end(), peer.open.delete(id)) }; // the last few points still wait in the batcher
      bt.end();
      peer.open.delete(id);
      return { id };
    };
    peer.undo = (id) => {
      peer.board = applyUndo(peer.board, id, me);
      peer.send('undo', { id });
    };
    peer.clear = () => {
      peer.board = applyClear(peer.board, peer.board.epoch + 1);
      peer.send('clear', { epoch: peer.board.epoch });
    };
    return peer;
  };
  peers.alex = mk('alex', 'blair');
  peers.blair = mk('blair', 'alex');
  const deliver = () => {
    while (queue.length) {
      const m = queue.shift();
      peers[m.to].on[m.kind](m.data, m.from);
    }
  };
  const same = () => JSON.stringify(boardDigest(peers.alex.board)) === JSON.stringify(boardDigest(peers.blair.board));
  /** One anti-entropy round (DIGEST_MS later): both send digests, then everything (incl. replies) is delivered. */
  const heal = () => {
    clock.now += DIGEST_MS;
    peers.alex.digest();
    peers.blair.digest();
    deliver();
  };
  return { ...peers, deliver, heal, same, stats, clock, setDrop: (fn) => (drop = fn) };
}

test('lost chunks, strokes, undos and clears heal after one digest round', () => {
  const t = lossyPair();
  const { alex, blair } = t;
  // A middle chunk of Alex's stroke is lost.
  t.setDrop((m) => m.kind === 'stroke' && m.data.o === 14);
  alex.draw(40);
  t.deliver();
  assert.equal(strokeLen(blair.board.strokes[0]), 33);
  assert.ok(!t.same());
  t.setDrop(() => false);
  t.heal();
  assert.ok(t.same(), 'converged');
  assert.deepEqual(blair.board.strokes[0].pts, alex.board.strokes[0].pts, 'exactly the same points');

  // A whole stroke of Blair's is lost, and so is Alex's undo.
  const kept = alex.draw(12);
  t.deliver();
  t.setDrop((m) => m.from === 'blair' && m.kind === 'stroke');
  blair.draw(25);
  t.deliver();
  t.setDrop((m) => m.kind === 'undo');
  alex.undo(kept.id);
  t.deliver();
  assert.equal(alex.board.strokes.length, 1, 'never got Blair\'s stroke');
  assert.equal(blair.board.strokes.length, 3, 'never got the undo');
  t.setDrop(() => false);
  t.heal();
  assert.ok(t.same());
  assert.equal(alex.board.strokes.length, 2);
  assert.deepEqual(alex.board.strokes.map((s) => s.id).sort(), blair.board.strokes.map((s) => s.id).sort());
  assert.ok(!findStroke(blair.board, kept.id), 'the undone stroke is gone on both');

  // A lost clear.
  t.setDrop((m) => m.kind === 'clear');
  blair.clear();
  t.deliver();
  t.setDrop(() => false);
  assert.equal(alex.board.strokes.length, 2);
  t.heal();
  assert.ok(t.same());
  assert.deepEqual(alex.board, blair.board);

  // Matching boards: digests only, no resync traffic.
  const syncs = t.stats.sent['sync?'];
  for (let i = 0; i < 5; i++) t.heal();
  assert.equal(t.stats.sent['sync?'], syncs);
});

test('drawing while digests fly never triggers a resync (no storms from partial strokes)', () => {
  const t = lossyPair();
  const { alex, blair } = t;
  for (let round = 0; round < 20; round++) {
    // Both mid-stroke: chunks still in flight when the digests are made.
    const a = alex.draw(30 + round, { keepOpen: true });
    const b = blair.draw(10 + round, { keepOpen: true });
    alex.digest();
    blair.digest();
    t.deliver();
    if (round % 2) a.end();
    alex.digest();
    t.deliver();
    a.end();
    b.end();
    blair.digest();
    t.deliver();
  }
  assert.equal(t.stats.sent['sync?'] || 0, 0, `no resyncs (${JSON.stringify(t.stats)})`);
  assert.equal(t.stats.mismatch || 0, 0);
  t.heal();
  assert.ok(t.same());
  assert.ok(t.stats.match > 0);
});

test('a sync reply that overtakes live chunks does not double points', () => {
  const t = lossyPair();
  const { alex, blair } = t;
  const s = alex.draw(28, { keepOpen: true, per: 5 });
  // Blair (re)mounts mid-stroke and asks. The reply carries all 28 points, including the 3 still
  // waiting in Alex's batcher, which arrive again in the next live chunk.
  blair.send('sync?', syncRequest(blair.board));
  t.deliver();
  assert.equal(blair.board.strokes[0].pts.length, 28);
  s.end();
  t.deliver();
  assert.deepEqual(blair.board.strokes[0].pts, alex.board.strokes[0].pts, 'no doubled points');
  t.heal();
  assert.ok(t.same());
});

test('an unrepairable mismatch backs off instead of flooding', () => {
  const t = lossyPair();
  const { alex, blair } = t;
  alex.draw(10);
  t.deliver();
  // Blair keeps strokes Alex can never get (e.g. a partner on an old version): every reply and
  // every stroke of hers is lost.
  t.setDrop((m) => m.kind === 'sync' || (m.kind === 'stroke' && m.from === 'blair'));
  blair.draw(10);
  for (let i = 0; i < 40; i++) t.heal(); // two minutes of digests
  const asks = t.stats.sent['sync?'];
  assert.ok(asks <= 12, `${asks} resync requests in 2 minutes of mismatch`);
  assert.ok(t.stats.mismatch >= 40);
});

test('back-to-back problems are each repaired at the next digest, with no wasted requests', () => {
  const t = lossyPair();
  const { alex, blair } = t;
  for (let i = 0; i < 6; i++) {
    // Each round something different gets lost: a chunk, a whole stroke (either player's), an
    // undo, a clear.
    const kind = ['stroke', 'stroke', 'undo', 'clear', 'stroke', 'undo'][i];
    const who = i % 2 ? blair : alex;
    let n = 0;
    t.setDrop((m) => m.kind === kind && (kind !== 'stroke' || i !== 0 || ++n === 2));
    if (kind === 'undo') who.undo(who.board.strokes.find((s) => s.by === who.me)?.id || who.draw(5).id);
    else if (kind === 'clear') who.clear();
    else who.draw(30, { per: 5 });
    t.deliver();
    t.setDrop(() => false);
    if (kind === 'undo' && t.same()) continue; // nothing of theirs left to undo
    assert.ok(!t.same(), `round ${i}: boards differ`);
    t.heal();
    assert.ok(t.same(), `round ${i} (${kind} by ${who.me}) healed at the first digest after it`);
  }
  assert.equal(t.stats.uselessReplies || 0, 0, 'every resync request brought something back');
});
