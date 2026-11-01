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
  assert.deepEqual(sent[0], { id: 's1', color: '#000000', size: 5, t: 9, e: 0, mirror: 0, pts: [[0, 0]], start: true });
  for (let i = 1; i <= 130; i++) bt.push([i, i]);
  // 2 full chunks went out immediately, the rest waits for the timer.
  assert.equal(sent.length, 3);
  assert.ok(sent.slice(1).every((m) => m.pts.length === MAX_CHUNK && !m.start && !m.end));
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
