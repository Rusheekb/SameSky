import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as insync from '../../js/games/insync/logic.js';
import { gameHarness } from '../helpers/sim.js';

test('sync on first try scores 10', () => {
  const h = gameHarness(insync);
  assert.equal(h.s.phase, 'pick');
  h.act('p1', { type: 'submit', word: 'Bridge' });
  assert.equal(h.s.phase, 'pick');
  assert.equal(h.s.words.p1, 'Bridge');
  h.act('p2', { type: 'submit', word: 'bridges' });
  assert.equal(h.s.phase, 'synced');
  assert.equal(h.s.done, true);
  assert.equal(h.s.points, 10);
  assert.ok(h.s.highlights.length === 1);
  assert.equal(h.s.at, h.now, 'the result is stamped with the authority time (postmark)');
  assert.ok(!/!/.test(h.s.summary + h.s.highlights.join('')), 'no exclamation marks in recap lines');
});

test('mismatch -> next round links the two words; locked answers are final', () => {
  const h = gameHarness(insync);
  h.act('p1', { type: 'submit', word: 'Sea' });
  const before = h.s;
  h.act('p1', { type: 'submit', word: 'Changed' });
  assert.equal(h.s, before, 'cannot change a locked word');
  h.act('p2', { type: 'submit', word: 'Sky' });
  assert.equal(h.s.phase, 'reveal');
  h.act('p2', { type: 'next' });
  assert.deepEqual(h.s.pair, ['Sea', 'Sky']);
  assert.equal(h.s.round, 2);
  // Saying one of the words on screen is rejected.
  const s2 = h.s;
  h.act('p1', { type: 'submit', word: 'sea' });
  assert.equal(h.s, s2);
  h.act('p1', { type: 'submit', word: 'Blue' });
  h.act('p2', { type: 'submit', word: 'blue' });
  assert.equal(h.s.phase, 'synced');
  assert.equal(h.s.points, 9);
});

test('gives up after MAX_ROUNDS and "again" keeps the running total', () => {
  const h = gameHarness(insync);
  for (let r = 1; r <= insync.MAX_ROUNDS; r++) {
    h.act('p1', { type: 'submit', word: `alpha${r}` });
    h.act('p2', { type: 'submit', word: `omega${r}` });
    assert.equal(h.s.phase, 'reveal');
    h.act('p1', { type: 'next' });
  }
  assert.equal(h.s.phase, 'over');
  assert.equal(h.s.points, 1);
  h.act('p2', { type: 'again' });
  assert.equal(h.s.phase, 'pick');
  assert.equal(h.s.points, 1);
  assert.equal(h.s.done, false);
  h.act('p1', { type: 'submit', word: 'yes' });
  h.act('p2', { type: 'submit', word: 'Yes!' });
  assert.equal(h.s.points, 11);
});

test('AI-provided seed pairs are used and sanitised', () => {
  const h = gameHarness(insync, { opts: { content: { pairs: [{ a: 'Kayak', b: 'Waffle' }, ['x', 'x'], 'junk', { a: '', b: 'y' }] } } });
  assert.deepEqual(h.s.pair, ['Kayak', 'Waffle']);
  assert.equal(h.s.pool.length, 0);
  assert.equal(h.s.ai, true);
});

test('emoji, other scripts and spacing variants count as the same word', () => {
  const h = gameHarness(insync);
  h.act('p1', { type: 'submit', word: '☕' });
  h.act('p2', { type: 'submit', word: '☕' });
  assert.equal(h.s.phase, 'synced');
  const g = gameHarness(insync, { seed: 9 });
  g.act('p1', { type: 'submit', word: 'Ice cream' });
  g.act('p2', { type: 'submit', word: 'icecream' });
  assert.equal(g.s.phase, 'synced');
  const k = gameHarness(insync, { seed: 4 });
  k.act('p1', { type: 'submit', word: 'любовь' });
  assert.equal(k.s.words.p1, 'любовь');
  // Pure punctuation is still rejected.
  const before = k.s;
  k.act('p2', { type: 'submit', word: '?!' });
  assert.equal(k.s, before);
});

test('on-screen words cannot be dodged with spacing or hyphens', () => {
  const h = gameHarness(insync, { opts: { content: { pairs: [{ a: 'Video call', b: 'Wi-Fi' }] } } });
  const s0 = h.s;
  h.act('p1', { type: 'submit', word: 'wifi' });
  h.act('p1', { type: 'submit', word: 'videocall' });
  assert.equal(h.s, s0);
});

test('AI pairs are capped and de-duplicated', () => {
  const pairs = Array.from({ length: 500 }, (_, i) => ({ a: `Word${i % 20}`, b: `Other${i % 20}` }));
  const h = gameHarness(insync, { opts: { content: { pairs } } });
  assert.ok(h.s.pool.length <= 11);
  assert.ok(JSON.stringify(h.s).length < 4000);
});

test('summarize keeps a recap line when leaving mid-game', () => {
  const h = gameHarness(insync);
  h.act('p1', { type: 'submit', word: 'alpha' });
  h.act('p2', { type: 'submit', word: 'omega' });
  const sum = insync.summarize(h.s, h.ctx());
  assert.match(sum.summary, /Stopped after 1 round/);
  assert.match(sum.highlights.at(-1), /alpha \/ omega/);
});
