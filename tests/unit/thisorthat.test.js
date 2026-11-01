import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tot from '../../js/games/thisorthat/logic.js';
import { DILEMMAS, VIBES } from '../../js/content/thisorthat.js';
import { gameHarness } from '../helpers/sim.js';
import { seededRandom } from '../../js/lib/util.js';

const key = (it) => `${it.a}|${it.b}`;

/** Both players lock a round: p1 picks/guesses, p2 picks/guesses. */
function playRound(h, [m1, g1], [m2, g2]) {
  h.act('p1', { type: 'pick', slot: 'mine', choice: m1 });
  h.act('p1', { type: 'pick', slot: 'guess', choice: g1 });
  h.act('p2', { type: 'pick', slot: 'guess', choice: g2 });
  h.act('p2', { type: 'pick', slot: 'mine', choice: m2 });
}

test('content bank: >= 90 original pairs, tagged by every vibe, no duplicates', () => {
  assert.ok(DILEMMAS.length >= 90, `${DILEMMAS.length} dilemmas`);
  assert.deepEqual([...VIBES].sort(), ['deep', 'flirty', 'silly', 'sweet']);
  for (const v of VIBES) assert.ok(DILEMMAS.filter((d) => d.vibe === v).length >= 20, v);
  const keys = new Set();
  for (const d of DILEMMAS) {
    assert.ok(d.a && d.b && d.a !== d.b);
    assert.ok(d.a.length <= 32 && d.b.length <= 32, `short enough for a half-width card: ${d.a} / ${d.b}`);
    assert.ok(!keys.has(key(d)), `duplicate ${key(d)}`);
    keys.add(key(d));
  }
});

test('init deals 10 distinct dilemmas, at least half from the current vibe', () => {
  for (const vibe of VIBES) {
    for (const seed of [1, 2, 3]) {
      const ctx = { players: ['p1', 'p2'], names: {}, by: 'p1', now: 0, random: seededRandom(seed), settings: { vibe } };
      const s = tot.init(ctx, {});
      assert.equal(s.items.length, 10);
      assert.equal(new Set(s.items.map(key)).size, 10, 'no repeats');
      const inVibe = s.items.filter((it) => DILEMMAS.find((d) => key(d) === key(it)).vibe === vibe).length;
      assert.ok(inVibe >= 5, `${vibe}: ${inVibe} from vibe`);
      assert.equal(s.phase, 'pick');
      assert.equal(s.round, 1);
      assert.equal(s.done, false);
      assert.equal(s.points, 0);
      assert.equal(s.ai, false);
      assert.ok(JSON.stringify(s).length < 4000, 'state stays small');
    }
  }
});

test('happy path: picks lock after two taps, reveal scores, next advances', () => {
  const h = gameHarness(tot);
  h.act('p1', { type: 'pick', slot: 'mine', choice: 'a' });
  assert.deepEqual(h.s.choices.p1, { mine: 'a', guess: null });
  // Can change until both taps are done.
  h.act('p1', { type: 'pick', slot: 'mine', choice: 'b' });
  assert.equal(h.s.choices.p1.mine, 'b');
  h.act('p1', { type: 'pick', slot: 'guess', choice: 'b' });
  assert.ok(tot.isLocked(h.s.choices.p1));
  // Locked: no more changes.
  const locked = h.s;
  assert.equal(h.act('p1', { type: 'pick', slot: 'mine', choice: 'a' }), locked);
  assert.equal(h.act('p1', { type: 'pick', slot: 'guess', choice: 'a' }), locked);
  assert.equal(h.s.phase, 'pick');
  h.act('p2', { type: 'pick', slot: 'mine', choice: 'b' });
  assert.equal(h.s.phase, 'pick');
  h.act('p2', { type: 'pick', slot: 'guess', choice: 'b' });
  assert.equal(h.s.phase, 'reveal');
  const r = h.s.rounds[0];
  assert.equal(r.same, true);
  assert.deepEqual(r.right, { p1: true, p2: true });
  assert.equal(r.gained, 3);
  assert.equal(h.s.points, 3);
  assert.equal(h.s.nextAt, h.now + tot.NEXT_MS);
  // Picks are frozen during reveal.
  const rev = h.s;
  assert.equal(h.act('p2', { type: 'pick', slot: 'mine', choice: 'a' }), rev);
  h.act('p2', { type: 'next', round: 1 });
  assert.equal(h.s.phase, 'pick');
  assert.equal(h.s.round, 2);
  assert.deepEqual(h.s.choices, {});
  assert.equal(h.s.nextAt, 0);
});

test('scoring: same pick +1, each correct prediction +1', () => {
  const h = gameHarness(tot);
  // Different picks; p1 guessed p2 right, p2 guessed wrong.
  playRound(h, ['a', 'b'], ['b', 'b']);
  let r = h.s.rounds[0];
  assert.equal(r.same, false);
  assert.deepEqual(r.right, { p1: true, p2: false });
  assert.equal(r.gained, 1);
  h.act('p1', { type: 'next', round: 1 });
  // Same pick, both guessed wrong.
  playRound(h, ['a', 'b'], ['a', 'b']);
  r = h.s.rounds[1];
  assert.equal(r.same, true);
  assert.deepEqual(r.right, { p1: false, p2: false });
  assert.equal(r.gained, 1);
  assert.equal(h.s.points, 2);
  h.act('p1', { type: 'next', round: 2 });
  // Nothing right at all.
  playRound(h, ['a', 'a'], ['b', 'b']);
  assert.equal(h.s.rounds[2].gained, 0);
  assert.equal(h.s.points, 2);
});

test('validation: wrong phase, strangers, junk payloads, stale next', () => {
  const h = gameHarness(tot);
  const s0 = h.s;
  assert.equal(h.act('stranger', { type: 'pick', slot: 'mine', choice: 'a' }), s0);
  assert.equal(h.act(undefined, { type: 'pick', slot: 'mine', choice: 'a' }), s0);
  assert.equal(h.act('p1', { type: 'pick', slot: 'mine', choice: 'c' }), s0);
  assert.equal(h.act('p1', { type: 'pick', slot: 'theirs', choice: 'a' }), s0);
  assert.equal(h.act('p1', { type: 'pick', slot: 'mine' }), s0);
  assert.equal(h.act('p1', { type: 'pick', slot: '__proto__', choice: 'a' }), s0);
  assert.equal(h.act('p1', { type: 'next' }), s0, 'next only in reveal');
  assert.equal(h.act('p1', { type: 'again' }), s0, 'again only when done');
  assert.equal(h.act('p1', { type: 'bogus' }), s0);
  // Re-tapping the same option is a no-op (same object).
  h.act('p1', { type: 'pick', slot: 'mine', choice: 'a' });
  const s1 = h.s;
  assert.equal(h.act('p1', { type: 'pick', slot: 'mine', choice: 'a' }), s1);
  playRound(h, ['a', 'a'], ['a', 'a']);
  assert.equal(h.s.phase, 'reveal');
  // A stale "next" for another round (both tapped at once) is ignored.
  const rev = h.s;
  assert.equal(h.act('p1', { type: 'next', round: 7 }), rev);
  h.act('p1', { type: 'next', round: 1 });
  const r2 = h.s;
  assert.equal(r2.round, 2);
  assert.equal(h.act('p2', { type: 'next', round: 1 }), r2, 'double next does not skip a round');
  assert.equal(h.act('stranger', { type: 'next', round: 2 }), r2);
});

test('tick auto-advances 7s after reveal and returns the same object until then', () => {
  const h = gameHarness(tot);
  const s0 = h.s;
  assert.equal(h.tick(60_000), s0, 'no-op while picking');
  playRound(h, ['a', 'b'], ['b', 'a']);
  const rev = h.s;
  assert.equal(h.tick(1000), rev);
  assert.equal(h.tick(5900), rev);
  h.tick(200);
  assert.equal(h.s.phase, 'pick');
  assert.equal(h.s.round, 2);
  const p = h.s;
  assert.equal(h.tick(10_000), p);
});

test('full game: 10 rounds -> over with stats, summary, highlights; again keeps points', () => {
  const h = gameHarness(tot);
  // Rounds 1-7 same pick (a) + both guessed right; 8-10 differ.
  for (let r = 1; r <= 10; r++) {
    if (r <= 7) playRound(h, ['a', 'a'], ['a', 'a']);
    else playRound(h, ['a', 'b'], ['b', 'b']);
    assert.equal(h.s.phase, 'reveal');
    assert.equal(h.s.done, false);
    if (r < 10) h.act(r % 2 ? 'p1' : 'p2', { type: 'next', round: r });
  }
  // Last reveal auto-advances to the end screen.
  h.tick(tot.NEXT_MS);
  assert.equal(h.s.phase, 'over');
  assert.equal(h.s.done, true);
  assert.equal(h.s.points, 7 * 3 + 3 * 1);
  assert.equal(h.s.gained, 24);
  const st = tot.stats(h.s, ['p1', 'p2']);
  assert.equal(st.compat, 70);
  assert.deepEqual(st.read, { p1: 10, p2: 7 });
  assert.equal(st.differed.length, 3);
  assert.match(h.s.summary, /^70% in tune · Alex read 10\/10, Blair read 7\/10$/);
  assert.ok(h.s.highlights.length >= 1 && h.s.highlights.length <= 6);
  assert.ok(h.s.highlights.some((x) => x.startsWith('Both picked: ')));
  assert.ok(h.s.highlights.some((x) => x.startsWith('Differed on: ')));
  for (const x of h.s.highlights) assert.ok(x.length <= 200);
  const first = h.s.items.map(key);
  // Ending is final: nothing but "again" changes it.
  const over = h.s;
  assert.equal(h.act('p1', { type: 'next', round: 10 }), over);
  assert.equal(h.tick(60_000), over);

  h.act('p2', { type: 'again' });
  assert.equal(h.s.phase, 'pick');
  assert.equal(h.s.done, false);
  assert.equal(h.s.round, 1);
  assert.equal(h.s.points, 24, 'points carry over');
  assert.equal(h.s.gained, 0);
  assert.equal(h.s.rounds.length, 0);
  assert.equal(h.s.plays, 1);
  const overlap = h.s.items.map(key).filter((k) => first.includes(k));
  assert.equal(overlap.length, 0, 'play again deals fresh dilemmas');
  playRound(h, ['b', 'b'], ['b', 'b']);
  assert.equal(h.s.points, 27);
});

test('many replays never run dry or repeat inside one game', () => {
  const h = gameHarness(tot);
  for (let play = 0; play < 8; play++) {
    assert.equal(new Set(h.s.items.map(key)).size, 10);
    for (let r = 1; r <= 10; r++) {
      playRound(h, ['a', 'a'], ['b', 'b']);
      h.act('p1', { type: 'next', round: r });
    }
    assert.equal(h.s.done, true);
    h.act('p1', { type: 'again' });
  }
  assert.ok(h.s.used.length <= 60);
  assert.ok(h.s.highlights.length <= 6);
});

test('AI items are validated, deduped and topped up from the bank', () => {
  const content = {
    items: [
      { a: '  Sushi date ', b: 'Taco night' },
      { a: 'Sushi date', b: 'Taco night' }, // duplicate
      { a: 'Same', b: 'same' }, // identical sides
      { a: '', b: 'x' },
      { a: 42, b: 'Number' },
      null,
      'junk',
      ['Ferris wheel', 'Rollercoaster'],
      { a: 'X'.repeat(300), b: 'Short' },
    ],
  };
  const h = gameHarness(tot, { opts: { content } });
  assert.equal(h.s.ai, true);
  assert.deepEqual(h.s.items[0], { a: 'Sushi date', b: 'Taco night' });
  assert.deepEqual(h.s.items[1], { a: 'Ferris wheel', b: 'Rollercoaster' });
  assert.equal(h.s.items[2].a.length, 40, 'oversized text is capped');
  assert.equal(h.s.items.length, 10, 'topped up from the bank');
  assert.equal(new Set(h.s.items.map(key)).size, 10);
});

test('AI: a full set of 12 is used, spare items feed "again"; malformed content falls back', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ a: `Option ${i} A`, b: `Option ${i} B` }));
  const h = gameHarness(tot, { opts: { content: { items } } });
  assert.deepEqual(h.s.items, items.slice(0, 10));
  assert.equal(h.s.spare.length, 2);
  for (let r = 1; r <= 10; r++) {
    playRound(h, ['a', 'a'], ['a', 'a']);
    h.act('p1', { type: 'next', round: r });
  }
  h.act('p1', { type: 'again' });
  assert.deepEqual(h.s.items.slice(0, 2), items.slice(10));
  assert.equal(h.s.items.length, 10);
  assert.equal(h.s.spare.length, 0);

  for (const content of [null, 'nope', { items: 'x' }, { items: [] }, { items: [{}, { a: 1 }] }, { pairs: items }]) {
    const g = gameHarness(tot, { opts: { content } });
    assert.equal(g.s.ai, false);
    assert.equal(g.s.items.length, 10);
    for (const it of g.s.items) assert.ok(DILEMMAS.some((d) => key(d) === key(it)));
  }
});

test('partner choices stay in state only for the authority; view-level secrecy relies on phase', () => {
  // Sanity: before reveal there is no round record (the reveal data the view renders).
  const h = gameHarness(tot);
  h.act('p1', { type: 'pick', slot: 'mine', choice: 'a' });
  h.act('p1', { type: 'pick', slot: 'guess', choice: 'b' });
  assert.equal(h.s.rounds.length, 0);
  assert.equal(h.s.phase, 'pick');
});
