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
