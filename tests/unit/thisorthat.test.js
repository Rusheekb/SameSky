import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tot from '../../js/games/thisorthat/logic.js';
import { DILEMMAS, VIBES } from '../../js/content/thisorthat.js';
import { gameHarness } from '../helpers/sim.js';
import { seededRandom } from '../../js/lib/util.js';
import * as room from '../../js/core/state.js';
import { GAMES } from '../../js/games/index.js';

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
  assert.ok(![h.s.summary, ...h.s.highlights].some((x) => /[!💞⚡🎶]/u.test(x)), 'recap lines are plain: no exclamation marks or emoji');
  assert.equal(h.s.endedAt, h.now, 'stamped with the time the play finished (the postmark on the results)');
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
  assert.equal(h.s.endedAt, 0, 'a new play is not finished yet');
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
  assert.ok(h.s.used.length <= DILEMMAS.length);
  assert.ok(h.s.highlights.length <= 6);
  assert.ok(JSON.stringify(h.s).length < 4000, 'state stays small with the full recency list');
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

// ------------------------------------------------------------------ helpers for the fixes below

const bankIndex = new Map(DILEMMAS.map((d, i) => [key(d), i]));

/** Play a whole game (any picks) and tap "New dilemmas"; returns the next game's item keys. */
function playThroughAndAgain(h) {
  for (let r = 1; r <= 10; r++) {
    playRound(h, ['a', 'b'], ['b', 'a']);
    h.act('p1', { type: 'next', round: r });
  }
  assert.equal(h.s.done, true);
  h.act('p2', { type: 'again' });
  return h.s.items.map(key);
}

function harnessFor(vibe, seed) {
  const h = gameHarness(tot, { seed });
  const base = h.ctx.bind(h);
  h.ctx = (by) => ({ ...base(by), settings: { vibe, ai: false, aboutUs: '' } });
  h.s = tot.init(h.ctx('p1'), {});
  return h;
}

// ------------------------------------------------------------------ deal order (rules#5)

test('deal order: every unseen dilemma comes before any repeat, across all vibes', () => {
  for (const vibe of VIBES) {
    for (const seed of [1, 7, 42]) {
      const h = harnessFor(vibe, seed);
      const seenAt = new Map(); // key -> game number it was last dealt in
      let game = 1;
      let items = h.s.items.map(key);
      const record = () => items.forEach((k) => seenAt.set(k, game));
      record();
      // 108 dilemmas / 10 per game: the first 10 games never repeat anything.
      for (game = 2; game <= Math.floor(DILEMMAS.length / 10); game++) {
        items = playThroughAndAgain(h);
        const repeats = items.filter((k) => seenAt.has(k));
        assert.deepEqual(repeats, [], `${vibe}/${seed} game ${game}: repeats while unseen ones remain`);
        assert.equal(new Set(items).size, 10);
        record();
      }
      // Game 11: the last unseen dilemmas, topped up with the ones seen longest ago (game 1).
      const unseenLeft = DILEMMAS.map(key).filter((k) => !seenAt.has(k));
      items = playThroughAndAgain(h);
      for (const k of unseenLeft) assert.ok(items.includes(k), `${vibe}/${seed}: unseen "${k}" dealt before repeats`);
      for (const k of items.filter((x) => seenAt.has(x))) assert.equal(seenAt.get(k), 1, `${vibe}/${seed}: repeat "${k}" is from the oldest game`);
      record();
      // From now on everything is a repeat, but never from the game just played.
      for (game = 12; game <= 24; game++) {
        const prev = new Set(items);
        items = playThroughAndAgain(h);
        assert.equal(items.filter((k) => prev.has(k)).length, 0, `${vibe}/${seed} game ${game}: repeat from the previous game`);
        assert.equal(new Set(items).size, 10, 'no repeats inside one game');
        record();
      }
    }
  }
});

test('deal order: tonight\'s vibe keeps its share while it has unseen dilemmas, other vibes fill the rest', () => {
  for (const vibe of VIBES) {
    const h = harnessFor(vibe, 9);
    const inVibe = DILEMMAS.filter((d) => d.vibe === vibe).length;
    let shown = 0; // in-vibe dilemmas dealt so far
    for (let game = 1; game <= 6; game++) {
      const items = game === 1 ? h.s.items.map(key) : playThroughAndAgain(h);
      const n = items.filter((k) => DILEMMAS[bankIndex.get(k)].vibe === vibe).length;
      const unseenVibe = inVibe - shown;
      assert.equal(n, Math.min(6, unseenVibe), `${vibe} game ${game}: ${n} from the vibe with ${unseenVibe} unseen`);
      shown += n;
    }
  }
});

test('AI dilemmas that are also in the bank are not dealt twice in one game', () => {
  const dupes = [
    { a: 'breakfast in bed', b: 'Fancy brunch out' }, // bank item, other spelling
    { a: 'Sleep in till noon', b: 'Sunrise hike' }, // bank item, sides swapped
    { a: 'Pet dragon', b: 'Pet dinosaur' },
  ];
  for (let seed = 1; seed <= 60; seed++) {
    const g = gameHarness(tot, { seed, opts: { content: { items: dupes } } });
    const keys = g.s.items.map((it) => [it.a, it.b].map((x) => x.toLowerCase()).sort().join('|'));
    assert.equal(new Set(keys).size, 10, `seed ${seed}: ${keys.join(', ')}`);
  }
});

// ------------------------------------------------------------------ content reads right for both (rules#6)

test('content: no I/you wording and no role pairs where the same pick means opposite wants', () => {
  for (const d of DILEMMAS) {
    for (const side of [d.a, d.b]) {
      // Shown under "You'd pick…" and "<partner> would pick…": I/you would flip meaning between them.
      assert.ok(!tot.PERSONAL.test(side), `"${side}" points at a different person on each screen`);
    }
    // Complementary roles: both picking "Big spoon" is a clash, not a match.
    assert.ok(!/\b(big|little) spoon\b|\bdo the chasing\b|\bbe chased\b|\bkiss(es)? (me|you) first\b/i.test(`${d.a} | ${d.b}`), `role pair: ${key(d)}`);
    assert.ok(!/^live near family$/i.test(d.a), 'whose family?');
  }
  assert.ok(tot.PERSONAL.test('You kiss me first') && tot.PERSONAL.test('I kiss you first') && tot.PERSONAL.test("I'd rather"));
  assert.ok(!tot.PERSONAL.test('A thousand little I-love-yous') && !tot.PERSONAL.test('Wi-Fi') && !tot.PERSONAL.test('Mines'));
});

test('AI dilemmas with I/you wording are dropped (they read wrongly on one of the two screens)', () => {
  const content = {
    items: [
      { a: 'You kiss me first', b: 'I kiss you first' },
      { a: 'Cook for you', b: 'Order in' },
      { a: 'Matching pyjamas', b: 'Swapping hoodies' },
    ],
  };
  const h = gameHarness(tot, { opts: { content } });
  assert.deepEqual(tot.validItems(content), [{ a: 'Matching pyjamas', b: 'Swapping hoodies' }]);
  assert.deepEqual(h.s.items[0], { a: 'Matching pyjamas', b: 'Swapping hoodies' });
  assert.ok(h.s.items.every((it) => !tot.PERSONAL.test(it.a) && !tot.PERSONAL.test(it.b)));
});

// ------------------------------------------------------------------ leaving mid-game (rules#2)

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

test('summarize: running compatibility and notable rounds so far; pure; finished games keep their own', () => {
  const h = gameHarness(tot);
  const ctx = h.ctx(null);
  assert.deepEqual(tot.summarize(h.s, ctx), { summary: '', highlights: [] }, 'nothing revealed yet');
  // Round 1 same + both right, round 2 split, round 3 same; round 4 half-picked (hidden).
  playRound(h, ['a', 'a'], ['a', 'a']);
  h.act('p1', { type: 'next', round: 1 });
  playRound(h, ['a', 'a'], ['b', 'b']);
  h.act('p1', { type: 'next', round: 2 });
  playRound(h, ['b', 'a'], ['b', 'b']);
  h.act('p1', { type: 'next', round: 3 });
  h.act('p1', { type: 'pick', slot: 'mine', choice: 'a' });
  h.act('p1', { type: 'pick', slot: 'guess', choice: 'a' });
  const before = JSON.stringify(h.s);
  const sum = tot.summarize(deepFreeze(h.s), ctx);
  assert.equal(JSON.stringify(h.s), before, 'never mutates');
  assert.equal(sum.summary, '67% in tune after 3 of 10 · Alex read 1/3, Blair read 2/3');
  const [it1, it2, it3] = h.s.items;
  assert.deepEqual(sum.highlights, [`Both picked: ${it1.a} over ${it1.b}`, `Differed on: ${it2.a} vs ${it2.b}`, `Both picked: ${it3.b} over ${it3.a}`]);
  assert.deepEqual(tot.summarize(h.s, ctx), sum, 'deterministic');

  // Mid-reveal counts the round on screen.
  playRound(h, ['b', 'a'], ['a', 'a']); // p1 already locked: p2 completes round 4
  assert.equal(h.s.phase, 'reveal');
  assert.match(tot.summarize(h.s, ctx).summary, /^75% in tune after 4 of 10 · /);

  // Finished: the end-screen summary and highlights are used as they are.
  for (let r = 4; r <= 10; r++) {
    if (r > 4) playRound(h, ['a', 'a'], ['a', 'a']);
    h.act('p1', { type: 'next', round: r });
  }
  assert.equal(h.s.done, true);
  assert.deepEqual(tot.summarize(h.s, ctx), { summary: h.s.summary, highlights: h.s.highlights });

  // "New dilemmas", then leave after two rounds: the earlier game stays in the line.
  h.act('p2', { type: 'again' });
  assert.deepEqual(tot.summarize(h.s, ctx), { summary: h.s.summary, highlights: h.s.highlights }, 'nothing new yet');
  playRound(h, ['a', 'a'], ['a', 'a']);
  h.act('p1', { type: 'next', round: 1 });
  playRound(h, ['a', 'b'], ['b', 'a']);
  const again = tot.summarize(h.s, ctx);
  assert.equal(again.summary, `${h.s.summary} · then 50% in tune on 2 more`);
  assert.ok(again.highlights.length <= 6);
  assert.equal(again.highlights.at(-1), `Differed on: ${h.s.items[1].a} vs ${h.s.items[1].b}`);
  for (const x of again.highlights) assert.ok(x.length <= 200);

  for (const bad of [null, undefined, {}, { rounds: 'x' }]) assert.deepEqual(tot.summarize(bad, ctx), {});
});

test('leaving through ✕ mid-game keeps the running result in the night recap', () => {
  const ctx = { now: 1_700_000_000_000, random: seededRandom(4), games: GAMES, online: new Set(['p1', 'p2']) };
  let st = room.initialState('R');
  st = room.reduce(st, { type: 'join', by: 'p1', player: { id: 'p1', name: 'Alex' } }, ctx);
  st = room.reduce(st, { type: 'join', by: 'p2', player: { id: 'p2', name: 'Blair' } }, { ...ctx, now: ctx.now + 1 });
  st = room.reduce(st, { type: 'startGame', by: 'p1', id: 'thisorthat' }, ctx);
  const g = (by, a) => (st = room.reduce(st, { type: 'game', by, a }, ctx));
  for (let r = 1; r <= 7; r++) {
    for (const p of ['p1', 'p2']) {
      g(p, { type: 'pick', slot: 'mine', choice: r <= 5 ? 'a' : p === 'p1' ? 'a' : 'b' });
      g(p, { type: 'pick', slot: 'guess', choice: 'a' });
    }
    g('p1', { type: 'next', round: r });
  }
  st = room.reduce(st, { type: 'endGame', by: 'p1' }, ctx);
  const entry = st.history.at(-1);
  assert.equal(entry.id, 'thisorthat');
  assert.equal(entry.summary, '71% in tune after 7 of 10 · Alex read 5/7, Blair read 7/7');
  assert.ok(entry.highlights.length >= 2 && entry.highlights.length <= 6);
  assert.ok(entry.highlights.some((x) => x.startsWith('Both picked: ')));
  assert.ok(entry.highlights.some((x) => x.startsWith('Differed on: ')));
  assert.equal(entry.points, 5 * 3 + 2 * 1);
});
