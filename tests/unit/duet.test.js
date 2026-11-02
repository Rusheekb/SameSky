import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as duet from '../../js/games/duet/logic.js';
import { postmarkText } from '../../js/games/duet/view.js';
import { PROMPTS, ALL_PROMPTS } from '../../js/content/duet.js';
import { normalizeWord } from '../../js/lib/util.js';
import { gameHarness } from '../helpers/sim.js';

test('init: drawing straight away with a prompt and an empty ready list', () => {
  const h = gameHarness(duet);
  assert.equal(h.s.phase, 'draw');
  assert.equal(h.s.n, 1);
  assert.ok(ALL_PROMPTS.includes(h.s.prompt));
  assert.deepEqual(h.s.ready, {});
  assert.equal(h.s.done, false);
  assert.equal(h.s.points, 0);
  assert.equal(typeof h.s.cid, 'string');
  assert.ok(!h.s.pool.includes(h.s.prompt));
  assert.ok(JSON.stringify(h.s).length < 2500, 'state stays small');
  // No tick: nothing time-based in this game.
  assert.equal(duet.tick, undefined);
});

test('the prompt pool leans towards tonight’s vibe', () => {
  const h = gameHarness(duet);
  const pool = duet.bankPool(h.ctx().random, 'silly');
  assert.ok(pool.length >= 10);
  assert.ok(PROMPTS.silly.includes(pool[0]));
  assert.ok(pool.filter((p) => PROMPTS.silly.includes(p)).length >= pool.length / 2 - 1);
  assert.equal(new Set(pool).size, pool.length);
});

test('new prompt: either player, only while drawing; clears "ready" votes', () => {
  const h = gameHarness(duet);
  const first = h.s.prompt;
  h.act('p1', { type: 'ready', on: true });
  h.act('p2', { type: 'newPrompt', from: first });
  assert.notEqual(h.s.prompt, first);
  assert.deepEqual(h.s.ready, {});
  assert.equal(h.s.shuffles, 1);
  h.act('p1', { type: 'newPrompt', from: h.s.prompt });
  assert.equal(h.s.shuffles, 2);
  const s = h.s;
  assert.equal(h.act('stranger', { type: 'newPrompt', from: s.prompt }), s);
  // Exhausting the pool refills it without repeating the current prompt.
  for (let i = 0; i < 40; i++) {
    const before = h.s.prompt;
    h.act(i % 2 ? 'p1' : 'p2', { type: 'newPrompt', from: before });
    assert.notEqual(h.s.prompt, before);
    assert.ok(typeof h.s.prompt === 'string' && h.s.prompt.length > 3);
  }
  assert.ok(h.s.pool.length <= 20 && h.s.used.length <= 30);
});

test('"We\'re done!" needs both players; either can take it back before the other agrees', () => {
  const h = gameHarness(duet);
  const s0 = h.s;
  assert.equal(h.act('stranger', { type: 'ready', on: true }), s0);
  assert.equal(h.act('p1', { type: 'ready', on: false }), s0, 'un-ready when not ready is a no-op');
  h.act('p1', { type: 'ready', on: true });
  assert.deepEqual(h.s.ready, { p1: true });
  assert.equal(h.s.phase, 'draw');
  const s1 = h.s;
  assert.equal(h.act('p1', { type: 'ready', on: true }), s1, 'double submit ignored');
  h.act('p1', { type: 'ready', on: false });
  assert.deepEqual(h.s.ready, {});
  h.act('p2', { type: 'ready' }); // `on` defaults to true
  h.now += 5 * 60_000;
  h.act('p1', { type: 'ready', on: true });
  assert.equal(h.s.phase, 'done');
  assert.equal(h.s.done, true);
  assert.equal(h.s.points, duet.POINTS_PER_CANVAS);
  assert.equal(h.s.plays, 1);
  assert.deepEqual(h.s.finished.map((f) => [f.n, f.mins]), [[1, 5]]);
  assert.equal(h.s.summary, `Drew “${h.s.prompt}” together`);
  assert.deepEqual(h.s.highlights, [`Drew together: “${h.s.prompt}”`]);
  const done = h.s;
  assert.equal(h.act('p2', { type: 'ready', on: false }), done, 'no un-ready after finishing');
  assert.equal(h.act('p2', { type: 'newPrompt', from: done.prompt }), done, 'no new prompt on the done screen');
  assert.equal(h.act('p2', { type: 'ready', on: true }), done);
});

test('"New canvas" keeps the running total, bumps the board number and picks a new prompt', () => {
  const h = gameHarness(duet);
  const s0 = h.s;
  assert.equal(h.act('p1', { type: 'again' }), s0, 'not while drawing');
  const prompts = [];
  for (let i = 1; i <= 8; i++) {
    prompts.push(h.s.prompt);
    assert.equal(h.s.n, i);
    h.act('p1', { type: 'ready', on: true });
    h.act('p2', { type: 'ready', on: true });
    assert.equal(h.s.points, i * duet.POINTS_PER_CANVAS);
    h.act(i % 2 ? 'p2' : 'p1', { type: 'again' });
    assert.equal(h.s.phase, 'draw');
    assert.equal(h.s.done, false);
    assert.deepEqual(h.s.ready, {});
  }
  assert.equal(new Set(prompts).size, prompts.length, 'no prompt repeats');
  assert.equal(h.s.points, 24);
  assert.equal(h.s.highlights.length, 6, 'highlights capped');
  assert.match(h.s.summary, /^Drew 8 masterpieces together/);
  assert.equal(h.s.cid, s0.cid, 'same game, so the same board prefix');
});

test('both tapping 🔀 at the same moment swaps the prompt once (the second request is stale)', () => {
  const h = gameHarness(duet);
  const seen = h.s.prompt;
  const poolBefore = h.s.pool;
  // Both players were looking at the same prompt when they tapped.
  h.act('p1', { type: 'newPrompt', from: seen });
  const after = h.s;
  assert.equal(after.shuffles, 1);
  assert.equal(h.act('p2', { type: 'newPrompt', from: seen }), after, 'raced request ignored: same object');
  assert.equal(after.prompt, poolBefore[0], 'no prompt skipped unseen');
  assert.deepEqual(after.used, [seen, after.prompt]);
  // Without saying which prompt it replaces, a request can't be judged: ignored.
  assert.equal(h.act('p2', { type: 'newPrompt' }), after);
  assert.equal(h.act('p2', { type: 'newPrompt', from: 42 }), after);
});

test('late "ready"/"again" meant for another canvas or an old prompt are ignored', () => {
  const h = gameHarness(duet);
  const p1 = h.s.prompt;
  // B taps "We're done" just as A swaps the prompt: B's vote doesn't carry over to a prompt B never saw.
  h.act('p1', { type: 'newPrompt', from: p1 });
  const s1 = h.s;
  assert.equal(h.act('p2', { type: 'ready', on: true, n: 1, from: p1 }), s1);
  h.act('p2', { type: 'ready', on: true, n: 1, from: s1.prompt });
  assert.deepEqual(h.s.ready, { p2: true });
  h.act('p1', { type: 'ready', on: true, n: 1, from: s1.prompt });
  assert.equal(h.s.phase, 'done');
  // Both tap "New canvas" at once: one new canvas, not a skipped one.
  h.act('p1', { type: 'again', n: 1 });
  const c2 = h.s;
  assert.equal(c2.n, 2);
  assert.equal(h.act('p2', { type: 'again', n: 1 }), c2);
  // A "ready" from canvas 1 arriving late (after a reconnect) doesn't finish canvas 2.
  h.act('p1', { type: 'ready', on: true, n: 2, from: c2.prompt });
  assert.equal(h.act('p2', { type: 'ready', on: true, n: 1 }), h.s);
  assert.equal(h.s.phase, 'draw');
  // Finishing canvas 2 quickly: a stale "again" from canvas 1 doesn't skip its done screen.
  h.act('p2', { type: 'ready', on: true, n: 2, from: c2.prompt });
  assert.equal(h.s.phase, 'done');
  const done2 = h.s;
  assert.equal(h.act('p1', { type: 'again', n: 1 }), done2);
});

test('AI prompts are validated; malformed content falls back to the bank', () => {
  const good = ['Our dream treehouse', 'A dragon who loves tea', 'The view from our future balcony'];
  const junk = [7, null, '', 'hi', 'x'.repeat(400), { text: 'object' }, ['arr']];
  const h = gameHarness(duet, { opts: { content: { prompts: [...junk, ...good, 'our DREAM treehouse!', '  3. A picnic on the moon  '] } } });
  assert.equal(h.s.ai, true);
  assert.equal(h.s.prompt, good[0]);
  assert.ok(h.s.pool.includes('A picnic on the moon'), 'list numbering stripped');
  assert.ok(!h.s.pool.includes('our DREAM treehouse!'), 'near-duplicates dropped');
  assert.ok([h.s.prompt, ...h.s.pool].every((p) => typeof p === 'string' && p.length <= duet.PROMPT_MAX));
  assert.deepEqual(duet.validPrompts({ prompts: junk }), []);

  for (const content of [undefined, null, {}, { prompts: 'draw a cat' }, { prompts: [1, 2] }, { prompts: ['Only one good prompt'] }]) {
    const f = gameHarness(duet, { opts: { content } });
    assert.equal(f.s.ai, false);
    assert.ok(ALL_PROMPTS.includes(f.s.prompt));
  }
});

test('prompt bank: 45+ unique prompts across every vibe', () => {
  assert.ok(ALL_PROMPTS.length >= 45, `${ALL_PROMPTS.length} prompts`);
  const norm = ALL_PROMPTS.map(normalizeWord);
  assert.equal(new Set(norm).size, norm.length);
  for (const v of ['sweet', 'silly', 'flirty', 'deep']) assert.ok(PROMPTS[v].length >= 10, v);
  for (const p of ALL_PROMPTS) assert.ok(p.length <= duet.PROMPT_MAX, p);
});

test('the framed canvas is stamped with the moment it was finished; the postmark text uses that stamp', () => {
  const h = gameHarness(duet); // starts at 2023-11-14 22:13:20 UTC
  assert.equal(h.s.doneAt, 0);
  h.act('p1', { type: 'ready', on: true });
  h.now += 60_000;
  h.act('p2', { type: 'ready', on: true });
  assert.equal(h.s.phase, 'done');
  const at = h.now; // 22:14:20 UTC
  assert.equal(h.s.doneAt, at, 'stamped with the authority time');
  assert.equal(h.s.finished.at(-1).at, at, 'earlier canvases keep their stamp for the gallery PNGs');
  const done = h.s;
  h.now += 3 * 60 * 60_000; // the sheet sits on screen for hours: the stamp does not move
  assert.equal(h.act('p1', { type: 'ready', on: true }), done);
  assert.equal(h.s.doneAt, at);

  const api = { me: { tz: 'UTC' }, partner: { tz: 'Asia/Tokyo' } };
  assert.equal(postmarkText(api, h.s.doneAt), '10:14 pm here · 7:14 am there');
  assert.equal(postmarkText({ me: { tz: 'UTC' }, partner: { tz: 'UTC' } }, h.s.doneAt), '10:14 pm for you both');

  h.act('p2', { type: 'again', n: h.s.n });
  assert.equal(h.s.phase, 'draw');
  assert.equal(h.s.doneAt, 0, 'a new canvas has no stamp yet');
});

test('meta: no emoji field (the game icon comes from iconFor(id))', () => {
  assert.equal('emoji' in duet.meta, false);
});
