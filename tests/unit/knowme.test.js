import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as km from '../../js/games/knowme/logic.js';
import { QUESTIONS } from '../../js/content/knowme.js';
import { gameHarness } from '../helpers/sim.js';
import { seededRandom } from '../../js/lib/util.js';

const { ROUNDS, MAX_SKIPS, MAX_ANSWER } = km;
const VIBES = ['sweet', 'flirty', 'silly', 'deep'];

const ctxFor = (vibe = 'sweet', seed = 5, by = 'p1') => ({
  players: ['p1', 'p2'],
  names: { p1: 'Alex', p2: 'Blair' },
  by,
  now: 1000,
  random: seededRandom(seed),
  settings: { vibe, ai: false, aboutUs: '' },
});

/** A value of the right kind: 'a' and 'b' differ by a lot, 'near' is one off from 'a' on a scale. */
function val(q, which) {
  if (q.kind === 'choice') return { a: 0, b: 3, near: 3 }[which];
  if (q.kind === 'scale') return { a: 5, b: 9, near: 6 }[which];
  return { a: 'Lisbon', b: 'Tokyo', near: 'Tokyo' }[which];
}

const guesser = (s) => (s.subject === 'p1' ? 'p2' : 'p1');

/** Both lock in; for open questions the subject judges with `judge`. Returns the round's score. */
function playRound(h, guess = 'a', judge = 2) {
  const s = h.s;
  h.act(s.subject, { type: 'answer', value: val(s.q, 'a'), q: s.q.id });
  h.act(guesser(s), { type: 'answer', value: val(s.q, guess), q: s.q.id });
  if (h.s.phase === 'judge') h.act(s.subject, { type: 'judge', score: judge });
  assert.equal(h.s.phase, 'reveal');
  return h.s.result.score;
}

// ------------------------------------------------------------------ content

test('content bank: ≥72 well-formed, original-feeling questions with a healthy mix', () => {
  assert.ok(QUESTIONS.length >= 72, `only ${QUESTIONS.length} questions`);
  const kinds = { choice: 0, scale: 0, open: 0 };
  const texts = new Set();
  for (const q of QUESTIONS) {
    kinds[q.kind]++;
    assert.ok(q.text && q.text.length <= 45, `text length: ${q.text}`);
    assert.ok(!texts.has(q.text.toLowerCase()), `duplicate: ${q.text}`);
    texts.add(q.text.toLowerCase());
    // Reads after both "About you:" and "About Maya:" — so no pronouns in the question itself.
    // ("Missing-you level" is a compound noun, so hyphenated forms are fine.)
    assert.ok(!/(?<![-\w])(i|my|me|your|you)(?![-\w])/i.test(q.text), `pronoun in question: ${q.text}`);
    assert.ok(!/\?$/.test(q.text), `should be a noun phrase: ${q.text}`);
    assert.ok(Array.isArray(q.vibes) && q.vibes.length >= 1 && q.vibes.every((v) => VIBES.includes(v)), `vibes: ${q.text}`);
    if (q.kind === 'choice') {
      assert.equal(q.options.length, 4, q.text);
      assert.equal(new Set(q.options.map((o) => o.toLowerCase())).size, 4, `duplicate option: ${q.text}`);
      assert.ok(q.options.every((o) => o && o.length <= 40), q.text);
    } else if (q.kind === 'scale') {
      assert.ok(q.low && q.high && q.low !== q.high && q.low.length <= 24 && q.high.length <= 24, q.text);
    } else {
      assert.equal(q.kind, 'open', q.text);
    }
  }
  for (const k of Object.keys(kinds)) assert.ok(kinds[k] >= 20, `${k}: ${kinds[k]}`);
  for (const v of VIBES) assert.ok(QUESTIONS.filter((q) => q.vibes.includes(v)).length >= 20, `vibe ${v}`);
});

// ------------------------------------------------------------------ init

test('init: 8 unique questions + spares, a 3/3/2 kind mix and ≥ half matching the vibe', () => {
  for (const vibe of VIBES) {
    for (let seed = 1; seed <= 12; seed++) {
      const s = km.init(ctxFor(vibe, seed), {});
      assert.equal(s.phase, 'answer');
      assert.equal(s.round, 1);
      assert.equal(s.subject, 'p1');
      assert.equal(s.queue.length, ROUNDS - 1);
      assert.equal(s.spares.length, MAX_SKIPS);
      const rounds = [s.q, ...s.queue];
      const all = [...rounds, ...s.spares];
      assert.equal(new Set(all.map((q) => q.id)).size, all.length, 'no repeats within a game');
      const count = (k) => rounds.filter((q) => q.kind === k).length;
      assert.deepEqual([count('choice'), count('scale'), count('open')], [3, 3, 2], `mix (${vibe}/${seed})`);
      const bank = (q) => QUESTIONS[Number(q.id.slice(1))];
      const matching = rounds.filter((q) => bank(q).vibes.includes(vibe)).length;
      assert.ok(matching >= ROUNDS / 2, `${vibe}/${seed}: only ${matching} match`);
      for (const q of all) {
        assert.equal(q.vibes, undefined, 'vibes stripped from state');
        assert.equal(q.text, bank(q).text);
      }
      assert.equal(s.done, false);
      assert.equal(s.points, 0);
      assert.equal(s.summary, '');
      assert.deepEqual(s.highlights, []);
      assert.ok(JSON.stringify(s).length < 4000, 'state stays small');
    }
  }
});

test('init is deterministic for a given random source and has no tick', () => {
  assert.deepEqual(km.init(ctxFor('silly', 9), {}), km.init(ctxFor('silly', 9), {}));
  assert.notDeepEqual(km.init(ctxFor('silly', 9), {}).q, km.init(ctxFor('silly', 10), {}).q);
  assert.equal(km.tick, undefined, 'no timers in this game');
  assert.equal(km.meta.id, 'knowme');
  assert.equal(km.meta.ai.task, 'knowme_questions');
});

// ------------------------------------------------------------------ happy path

test('a full game: alternating subjects, scoring, tally, summary and highlights', () => {
  const h = gameHarness(km, { seed: 4 });
  const plan = ['a', 'b', 'a', 'near', 'a', 'b', 'a', 'a'];
  let expected = 0;
  const perGuesser = { p1: 0, p2: 0 };
  for (let r = 1; r <= ROUNDS; r++) {
    assert.equal(h.s.round, r);
    assert.equal(h.s.phase, 'answer');
    assert.equal(h.s.subject, r % 2 ? 'p1' : 'p2', 'subject alternates');
    const q = h.s.q;
    const g = guesser(h.s);
    const judge = plan[r - 1] === 'a' ? 2 : plan[r - 1] === 'near' ? 1 : 0;
    const score = playRound(h, plan[r - 1], judge);
    const want = plan[r - 1] === 'a' ? 2 : plan[r - 1] === 'near' && q.kind !== 'choice' ? 1 : 0;
    assert.equal(score, want, `round ${r} (${q.kind})`);
    expected += score;
    if (score === 2) perGuesser[g]++;
    assert.equal(h.s.points, expected);
    assert.equal(h.s.gained, expected);
    const entry = h.s.log[h.s.log.length - 1];
    assert.equal(entry.text, q.text);
    assert.equal(entry.subject, h.s.subject);
    assert.equal(entry.guesser, g);
    assert.equal(entry.answer, km.showValue(q, val(q, 'a')));
    if (r < ROUNDS) {
      h.act(g, { type: 'next', round: r });
      assert.notEqual(h.s.q.id, q.id);
    }
  }
  assert.equal(h.s.done, false, 'still on the last reveal');
  h.act('p1', { type: 'next', round: ROUNDS });
  const s = h.s;
  assert.equal(s.phase, 'over');
  assert.equal(s.done, true);
  assert.equal(s.plays, 1);
  assert.equal(s.points, expected);
  assert.ok(Number.isInteger(s.points));
  assert.equal(s.log.length, ROUNDS);
  assert.equal(s.tally.p1.total, 4);
  assert.equal(s.tally.p2.total, 4);
  assert.equal(s.tally.p1.right, perGuesser.p1);
  assert.equal(s.tally.p2.right, perGuesser.p2);
  assert.match(s.summary, new RegExp(`^Alex knew Blair ${perGuesser.p1}/4, Blair knew Alex ${perGuesser.p2}/4 \\(\\+${expected} pts\\)$`));
  assert.ok(s.highlights.length >= 2 && s.highlights.length <= 6);
  assert.ok(s.highlights.every((l) => typeof l === 'string' && l.length <= 200));
  assert.match(s.highlights[s.highlights.length - 1], /^Alex knows Blair \d\/4 · Blair knows Alex \d\/4$/);
  assert.ok(s.highlights.some((l) => /guessed (Alex|Blair)'s .+: .+ ✓$/.test(l)), s.highlights.join('\n'));
  assert.ok(s.highlights.some((l) => / — it’s /.test(l) || /nearly guessed/.test(l)), 'a miss for flavour');
  // Over: further actions are no-ops.
  for (const a of [{ type: 'next' }, { type: 'answer', value: 1 }, { type: 'skip' }, { type: 'judge', score: 2 }]) {
    assert.equal(km.reduce(s, { ...a, by: 'p2' }, h.ctx('p2')), s);
  }
});

test('verdict lines cover every score band', () => {
  const titles = [16, 12, 8, 4, 0].map((g) => km.verdict(g).title);
  assert.equal(new Set(titles).size, 5);
  for (const g of [0, 3, 7, 11, 16]) assert.ok(km.verdict(g).line.length > 5);
});

// ------------------------------------------------------------------ phases & scoring

/** Harness whose current question is of `kind` (skip until we get one, max 3 skips). */
function harnessWithKind(kind, opts = {}) {
  for (let seed = 1; seed < 200; seed++) {
    const h = gameHarness(km, { seed, ...opts });
    if (h.s.q.kind === kind) return h;
  }
  throw new Error(`no ${kind} question found`);
}

test('choice: exact match +2, anything else 0; reveal waits for Next', () => {
  const h = harnessWithKind('choice');
  h.act('p1', { type: 'answer', value: 2 });
  assert.equal(h.s.phase, 'answer');
  assert.deepEqual(h.s.answers, { p1: 2 });
  h.act('p2', { type: 'answer', value: 2 });
  assert.equal(h.s.phase, 'reveal');
  assert.deepEqual(h.s.result, { score: 2, how: 'auto' });
  assert.equal(h.s.points, 2);
  const h2 = harnessWithKind('choice');
  h2.act('p2', { type: 'answer', value: 0 }); // guesser first is fine too
  h2.act('p1', { type: 'answer', value: 1 });
  assert.equal(h2.s.result.score, 0);
  assert.equal(h2.s.log[0].answer, h2.s.q.options[1]);
  assert.equal(h2.s.log[0].guess, h2.s.q.options[0]);
});

test('scale: exact +2, off by one +1, further 0', () => {
  for (const [real, guess, want] of [[7, 7, 2], [7, 8, 1], [7, 6, 1], [7, 9, 0], [1, 10, 0]]) {
    const h = harnessWithKind('scale');
    h.act('p1', { type: 'answer', value: real });
    h.act('p2', { type: 'answer', value: guess });
    assert.equal(h.s.phase, 'reveal');
    assert.equal(h.s.result.score, want, `${real} vs ${guess}`);
    assert.equal(h.s.log[0].answer, `${real}/10`);
  }
});

test('open: the subject judges (only the subject, only 0/1/2); word-for-word scores itself', () => {
  const h = harnessWithKind('open');
  h.act('p1', { type: 'answer', value: 'Lisbon, at sunset' });
  h.act('p2', { type: 'answer', value: 'Portugal' });
  assert.equal(h.s.phase, 'judge');
  assert.equal(h.s.points, 0);
  const judging = h.s;
  assert.equal(h.act('p2', { type: 'judge', score: 2 }), judging, 'the guesser cannot judge');
  for (const bad of [3, -1, 1.5, '2', null, undefined]) assert.equal(h.act('p1', { type: 'judge', score: bad }), judging);
  assert.equal(h.act('p1', { type: 'next' }), judging, 'no skipping the judgement');
  h.act('p1', { type: 'judge', score: 1 });
  assert.equal(h.s.phase, 'reveal');
  assert.deepEqual(h.s.result, { score: 1, how: 'judged' });
  assert.equal(h.s.points, 1);
  const done = h.s;
  assert.equal(h.act('p1', { type: 'judge', score: 2 }), done, 'no double judging');

  const e = harnessWithKind('open');
  e.act('p1', { type: 'answer', value: 'The Beaches' });
  e.act('p2', { type: 'answer', value: 'beach' });
  assert.equal(e.s.phase, 'reveal');
  assert.deepEqual(e.s.result, { score: 2, how: 'exact' });
  // Emoji-only answers are fine (they just go to the judge).
  const j = harnessWithKind('open');
  j.act('p1', { type: 'answer', value: '🍕' });
  j.act('p2', { type: 'answer', value: '🍕' });
  assert.equal(j.s.phase, 'judge');
});

test('next: only from reveal, either player, ignores stale double taps', () => {
  const h = gameHarness(km);
  assert.equal(h.act('p1', { type: 'next' }), h.s, 'not during answer');
  playRound(h);
  const reveal = h.s;
  assert.equal(h.act('p2', { type: 'next', round: 2 }), reveal, 'stale round number');
  h.act('p2', { type: 'next', round: 1 });
  assert.equal(h.s.round, 2);
  assert.equal(h.s.subject, 'p2');
  assert.deepEqual(h.s.answers, {});
  assert.equal(h.s.result, null);
  const r2 = h.s;
  assert.equal(h.act('p1', { type: 'next', round: 1 }), r2, "partner's simultaneous Next is ignored");
});

// ------------------------------------------------------------------ validation

test('answer validation: values, players, phases, double submits, stale questions', () => {
  const c = harnessWithKind('choice');
  const s0 = c.s;
  for (const bad of [4, -1, 1.5, '1', null, undefined, true, {}, [1]]) assert.equal(c.act('p1', { type: 'answer', value: bad }), s0, `choice ${bad}`);
  assert.equal(c.act('stranger', { type: 'answer', value: 1 }), s0, 'stranger');
  assert.equal(c.act(undefined, { type: 'answer', value: 1 }), s0, 'no actor');
  assert.equal(c.act('p1', { type: 'answer', value: 1, q: 'b99999' }), s0, 'answer to another question');
  assert.equal(km.reduce(s0, { type: 'answer', value: 1, by: 'p1' }, { ...c.ctx('p1'), players: undefined }), s0);
  c.act('p1', { type: 'answer', value: 1, q: s0.q.id });
  const locked = c.s;
  assert.equal(c.act('p1', { type: 'answer', value: 2 }), locked, 'locked answers are final');
  assert.equal(c.s.answers.p1, 1);

  const sc = harnessWithKind('scale');
  for (const bad of [0, 11, 5.5, '5', null, -3]) assert.equal(sc.act('p2', { type: 'answer', value: bad }), sc.s, `scale ${bad}`);
  sc.act('p2', { type: 'answer', value: 10 });
  assert.equal(sc.s.answers.p2, 10);

  const o = harnessWithKind('open');
  const so = o.s;
  for (const bad of ['', '    ', null, undefined, {}, ['x'], true]) assert.equal(o.act('p1', { type: 'answer', value: bad }), so, `open ${JSON.stringify(bad)}`);
  o.act('p1', { type: 'answer', value: `  ${'x'.repeat(500)}\n\u0000 ` });
  assert.equal(o.s.answers.p1.length, MAX_ANSWER, 'oversized text is capped');
  o.act('p2', { type: 'answer', value: 42 });
  assert.equal(o.s.answers.p2, '42');
  // Answering in the wrong phase.
  o.act('p1', { type: 'judge', score: 0 });
  assert.equal(o.s.phase, 'reveal');
  assert.equal(o.act('p1', { type: 'answer', value: 'late' }), o.s);
});

test('unknown / junk actions and strangers return the same object', () => {
  const h = gameHarness(km);
  const s = h.s;
  for (const a of [{ type: 'nope' }, {}, { type: 'again' }, { type: 'judge', score: 2 }, { type: 'skip' }]) {
    assert.equal(km.reduce(s, { ...a, by: 'stranger' }, h.ctx('stranger')), s);
  }
  for (const a of [{ type: 'nope' }, {}, { type: 'again' }, { type: 'judge', score: 2 }]) {
    assert.equal(km.reduce(s, { ...a, by: 'p2' }, h.ctx('p2')), s);
  }
  assert.equal(km.reduce(s, null, h.ctx('p1')), s);
});

// ------------------------------------------------------------------ skip

test('skip: either player, max 3 per game, swaps in a fresh question and clears locks', () => {
  const h = gameHarness(km);
  const firstQ = h.s.q;
  const spares = h.s.spares;
  h.act('p1', { type: 'answer', value: km.KINDS.includes(firstQ.kind) ? val(firstQ, 'a') : 0 });
  assert.ok(Object.keys(h.s.answers).length === 1);
  h.act('p2', { type: 'skip', q: firstQ.id });
  assert.equal(h.s.skips, 1);
  assert.equal(h.s.skippedBy, 'p2');
  assert.deepEqual(h.s.q, spares[0]);
  assert.deepEqual(h.s.answers, {}, 'locks cleared');
  assert.equal(h.s.round, 1, 'same round, same subject');
  assert.equal(h.s.subject, 'p1');
  assert.ok(h.s.seen.includes(spares[0].id));
  const after1 = h.s;
  assert.equal(h.act('p1', { type: 'skip', q: firstQ.id }), after1, 'simultaneous skip of the same question counts once');
  assert.equal(h.act('stranger', { type: 'skip' }), after1);
  h.act('p1', { type: 'skip' });
  h.act('p2', { type: 'skip' });
  assert.equal(h.s.skips, MAX_SKIPS);
  const maxed = h.s;
  assert.equal(h.act('p1', { type: 'skip' }), maxed, 'no more than 3');
  // All 8 rounds' questions are still unique.
  const ids = [h.s.q, ...h.s.queue].map((q) => q.id);
  assert.equal(new Set([...ids, firstQ.id, spares[0].id, spares[1].id]).size, ids.length + 3);
  // Not during reveal.
  const g = gameHarness(km, { seed: 8 });
  playRound(g);
  assert.equal(g.act('p1', { type: 'skip' }), g.s);
});

// ------------------------------------------------------------------ AI content

const aiQ = (n) =>
  Array.from({ length: n }, (_, i) =>
    i % 3 === 0
      ? { text: `Favourite thing about Lisbon #${i}`, kind: 'choice', options: ['Tram 28', 'Pastéis', 'Sunsets', 'Fado'], low: '', high: '' }
      : i % 3 === 1
        ? { text: `Patience level #${i}`, kind: 'scale', options: [], low: 'Zero', high: 'Infinite' }
        : { text: `Secret wish #${i}`, kind: 'open', options: [], low: '', high: '' },
  );

test('AI questions are validated, sanitised and used for every round when there are 8', () => {
  const h = gameHarness(km, { opts: { content: { questions: aiQ(8) } } });
  const rounds = [h.s.q, ...h.s.queue];
  assert.equal(rounds.length, ROUNDS);
  assert.ok(rounds.every((q) => q.ai && q.id.startsWith('a')));
  assert.equal(h.s.ai, true);
  assert.equal(h.s.spares.length, MAX_SKIPS, 'skips come from the bank');
  assert.ok(h.s.spares.every((q) => q.id.startsWith('b')));
  const scale = rounds.find((q) => q.kind === 'scale');
  assert.deepEqual(Object.keys(scale).sort(), ['ai', 'high', 'id', 'kind', 'low', 'text']);
  const choice = rounds.find((q) => q.kind === 'choice');
  assert.deepEqual(choice.options, ['Tram 28', 'Pastéis', 'Sunsets', 'Fado']);
});

test('AI: malformed questions are dropped and the game fills up from the bank', () => {
  const content = {
    questions: [
      { text: 'About you: Dream breakfast?', kind: 'choice', options: ['Eggs', 'Waffles', 'Fruit', 'Nothing', 'Extra'] }, // prefix + "?" stripped, 5th option dropped
      { text: 'Dream breakfast', kind: 'open' }, // duplicate text
      { text: 'Too few options', kind: 'choice', options: ['a', 'b', 'c'] },
      { text: 'Dupe options', kind: 'choice', options: ['Yes', 'yes', 'YES!', 'No'] }, // only 2 distinct
      { text: 'No labels', kind: 'scale', low: '', high: 'High' },
      { text: 'Same labels', kind: 'scale', low: 'Hot', high: 'hot' },
      { text: 'Weird kind', kind: 'essay' },
      { text: '', kind: 'open' },
      { text: 42, kind: 'open' },
      { text: { evil: true }, kind: 'open' },
      null,
      'just a string',
      { text: `  Long   ${'y'.repeat(300)}`, kind: 'open' }, // trimmed to 80
      { text: 'Lucky number', kind: 'scale', low: 'One', high: 'Ten', options: ['ignored'] },
      { text: 'Weird options', kind: 'choice', options: [{ x: 1 }, 'A', 'B', null, 'C', 'D'] },
    ],
  };
  const valid = km.validQuestions(content);
  assert.deepEqual(
    valid.map((q) => q.text.slice(0, 15)),
    ['Dream breakfast', `Long ${'y'.repeat(10)}`, 'Lucky number', 'Weird options'],
  );
  assert.deepEqual(valid[0].options, ['Eggs', 'Waffles', 'Fruit', 'Nothing']);
  assert.equal(valid[1].text.length, 80);
  assert.equal(valid[2].options, undefined);
  assert.deepEqual(valid[3].options, ['A', 'B', 'C', 'D']);

  const h = gameHarness(km, { opts: { content } });
  const rounds = [h.s.q, ...h.s.queue];
  assert.equal(rounds.length, ROUNDS);
  assert.equal(rounds.filter((q) => q.ai).length, 4, 'AI questions mixed in');
  assert.equal(rounds.filter((q) => !q.ai).length, 4, 'filled from the bank');
  assert.equal(new Set(rounds.map((q) => q.id)).size, ROUNDS);
  assert.equal(h.s.ai, true);
});

test('AI: missing or junk content falls back to the built-in bank', () => {
  for (const content of [undefined, null, 'nope', 42, {}, { questions: 'x' }, { questions: [null, 1, 'a'] }, { questions: {} }]) {
    const h = gameHarness(km, { opts: { content } });
    const rounds = [h.s.q, ...h.s.queue];
    assert.equal(rounds.length, ROUNDS);
    assert.ok(rounds.every((q) => q.id.startsWith('b') && !q.ai));
    assert.equal(h.s.ai, false);
  }
  assert.ok(km.validQuestions({ questions: aiQ(20) }).length === ROUNDS, 'never more than 8 from the AI');
});

// ------------------------------------------------------------------ play again

function playGame(h, guess = 'a') {
  for (let r = 1; r <= ROUNDS; r++) {
    playRound(h, guess, guess === 'a' ? 2 : 0);
    h.act('p1', { type: 'next', round: r });
  }
  assert.equal(h.s.phase, 'over');
}

test('play again: fresh 8 rounds, cumulative points, no repeated questions, capped highlights', () => {
  const h = gameHarness(km, { seed: 12 });
  const firstIds = [h.s.q, ...h.s.queue].map((q) => q.id);
  assert.equal(h.act('p2', { type: 'again' }), h.s, 'not before the game is over');
  playGame(h, 'a');
  assert.equal(h.s.points, 16);
  assert.match(km.verdict(h.s.gained).title, /Flawless/);
  h.act('p2', { type: 'again' });
  const s = h.s;
  assert.equal(s.phase, 'answer');
  assert.equal(s.round, 1);
  assert.equal(s.subject, 'p1');
  assert.equal(s.done, false);
  assert.equal(s.points, 16, 'running total kept');
  assert.equal(s.gained, 0);
  assert.equal(s.skips, 0);
  assert.deepEqual(s.log, []);
  assert.equal(s.tally, null);
  assert.equal(s.plays, 1);
  const secondIds = [s.q, ...s.queue].map((q) => q.id);
  assert.equal(secondIds.filter((id) => firstIds.includes(id)).length, 0, 'no repeats from the last game');
  assert.equal(h.act('p1', { type: 'again' }), s, 'double tap on Play again is ignored');

  playGame(h, 'b');
  assert.equal(h.s.plays, 2);
  assert.ok(h.s.points >= 16);
  assert.equal(h.s.points, 16 + h.s.gained);
  assert.match(h.s.summary, /^Over 2 games: Alex knew Blair \d+\/8, Blair knew Alex \d+\/8$/);
  assert.equal(h.s.totals.p1.total, 8);
  assert.ok(h.s.highlights.length <= 6);
  for (let i = 0; i < 12; i++) {
    h.act('p1', { type: 'again' });
    playGame(h, i % 2 ? 'a' : 'b');
  }
  assert.ok(h.s.highlights.length <= 6);
  assert.ok(h.s.seen.length <= 100);
  h.act('p2', { type: 'again' });
  assert.equal(new Set([h.s.q, ...h.s.queue].map((q) => q.id)).size, ROUNDS, 'still no repeats within a game after the bank wraps');
  assert.ok(JSON.stringify(h.s).length < 6000, `state size ${JSON.stringify(h.s).length}`);
});

test('showValue formats each kind', () => {
  assert.equal(km.showValue({ kind: 'choice', options: ['A', 'B', 'C', 'D'] }, 2), 'C');
  assert.equal(km.showValue({ kind: 'scale' }, 7), '7/10');
  assert.equal(km.showValue({ kind: 'open' }, 'Hi'), 'Hi');
  assert.equal(km.showValue({ kind: 'open' }, undefined), '');
  assert.equal(km.showValue(null, 1), '');
});

test('many replays keep the vibe ratio and kind mix, and never repeat last game’s questions', () => {
  for (const vibe of VIBES) {
    const ctx = ctxFor(vibe, 21);
    let s = km.init(ctx, {});
    let prev = new Set();
    for (let play = 0; play < 20; play++) {
      const rounds = [s.q, ...s.queue];
      const ids = rounds.map((q) => q.id);
      assert.equal(new Set(ids).size, ROUNDS);
      assert.ok(rounds.filter((q) => QUESTIONS[Number(q.id.slice(1))].vibes.includes(vibe)).length >= ROUNDS / 2, `${vibe} play ${play}`);
      assert.deepEqual(['choice', 'scale', 'open'].map((k) => rounds.filter((q) => q.kind === k).length), [3, 3, 2]);
      assert.equal(ids.filter((id) => prev.has(id)).length, 0, `${vibe} play ${play} repeats last game`);
      prev = new Set(ids);
      for (let r = 1; r <= ROUNDS; r++) {
        const v = val(s.q, 'a');
        s = km.reduce(s, { type: 'answer', value: v, by: 'p1' }, ctx);
        s = km.reduce(s, { type: 'answer', value: v, by: 'p2' }, ctx);
        s = km.reduce(s, { type: 'next', by: 'p2' }, ctx);
      }
      assert.equal(s.phase, 'over');
      s = km.reduce(s, { type: 'again', by: 'p1' }, ctx);
    }
  }
});
