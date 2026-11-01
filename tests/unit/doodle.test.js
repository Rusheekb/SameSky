import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as doodle from '../../js/games/doodle/logic.js';
import { ALL_WORDS, EASY, MEDIUM, US, SILLY } from '../../js/content/doodle.js';
import { normalizeWord } from '../../js/lib/util.js';
import { gameHarness } from '../helpers/sim.js';

const { ROUNDS, DRAW_MS, RESULT_MS } = doodle;

/** Drawer picks option `i`; returns the secret word. */
function pick(h, i = 0) {
  const word = h.s.options[i];
  h.act(h.s.drawer, { type: 'choose', index: i });
  return word;
}

test('init: choose phase, p1 draws first, three distinct options, no secrets leaked into the word', () => {
  const h = gameHarness(doodle);
  const s = h.s;
  assert.equal(s.phase, 'choose');
  assert.equal(s.round, 1);
  assert.equal(s.drawer, 'p1');
  assert.equal(s.guesser, 'p2');
  assert.equal(s.options.length, 3);
  assert.equal(new Set(s.options.map(normalizeWord)).size, 3);
  assert.equal(s.word, '');
  assert.equal(s.done, false);
  assert.equal(s.points, 0);
  assert.equal(s.ai, false);
  // The three options are easy / medium / themed.
  assert.ok(EASY.includes(s.options[0]));
  assert.ok(MEDIUM.includes(s.options[1]));
  assert.ok([...US, ...SILLY].includes(s.options[2]));
  assert.ok(JSON.stringify(s).length < 3000, 'state stays small');
});

test('choose: only the drawer, only a valid index, only in the choose phase', () => {
  const h = gameHarness(doodle);
  const s0 = h.s;
  assert.equal(h.act('p2', { type: 'choose', index: 0 }), s0, 'guesser cannot choose');
  assert.equal(h.act('stranger', { type: 'choose', index: 0 }), s0, 'strangers ignored');
  for (const index of [-1, 3, 1.5, '1', null, undefined]) assert.equal(h.act('p1', { type: 'choose', index }), s0);
  assert.equal(h.act('p1', { type: 'guess', text: 'cat' }), s0, 'no guessing before a word is chosen');
  assert.equal(h.act('p1', { type: 'skip' }), s0);
  assert.equal(h.act('p1', { type: 'next' }), s0);
  const word = s0.options[1];
  h.act('p1', { type: 'choose', index: 1 });
  assert.equal(h.s.phase, 'draw');
  assert.equal(h.s.word, word);
  assert.deepEqual(h.s.options, []);
  assert.equal(h.s.endsAt, h.now + DRAW_MS);
  const s1 = h.s;
  assert.equal(h.act('p1', { type: 'choose', index: 0 }), s1, 'no double choose');
});

test('reroll: drawer may swap the three options once per round', () => {
  const h = gameHarness(doodle);
  const first = h.s.options;
  assert.equal(h.act('p2', { type: 'reroll' }), h.s);
  h.act('p1', { type: 'reroll' });
  assert.notDeepEqual(h.s.options, first);
  assert.equal(h.s.rerolled, true);
  const s = h.s;
  assert.equal(h.act('p1', { type: 'reroll' }), s, 'only once');
});

test('guesses: validation, wrong guesses stream into a capped list, close guesses are flagged', () => {
  const h = gameHarness(doodle);
  h.act('p1', { type: 'choose', index: 1 });
  h.s = { ...h.s, word: 'penguin' }; // pin the word for the test
  const s0 = h.s;
  assert.equal(h.act('p1', { type: 'guess', text: 'penguin' }), s0, 'the drawer cannot guess');
  assert.equal(h.act('stranger', { type: 'guess', text: 'penguin' }), s0);
  assert.equal(h.act('p2', { type: 'guess', text: '' }), s0);
  assert.equal(h.act('p2', { type: 'guess', text: '   ' }), s0);
  assert.equal(h.act('p2', { type: 'guess', text: '?!' }), s0);
  assert.equal(h.act('p2', { type: 'guess' }), s0);

  h.act('p2', { type: 'guess', text: 'x'.repeat(500) });
  assert.equal(h.s.guesses.length, 1);
  assert.ok(h.s.guesses[0].text.length <= doodle.GUESS_MAX, 'oversized text is capped');
  const s1 = h.s;
  assert.equal(h.act('p2', { type: 'guess', text: 'x'.repeat(500) }), s1, 'same guess twice in a row is ignored');

  h.act('p2', { type: 'guess', text: 'pengiun' });
  assert.equal(h.s.phase, 'draw');
  assert.equal(h.s.closeCount, 1);
  assert.equal(h.s.guesses.at(-1).close, true);
  h.act('p2', { type: 'guess', text: 'bird' });
  assert.equal(h.s.guesses.at(-1).close, false);
  for (let i = 0; i < 20; i++) h.act('p2', { type: 'guess', text: `guess ${i}` });
  assert.equal(h.s.guesses.length, doodle.MAX_GUESSES);
  assert.equal(h.s.guesses.at(-1).text, 'guess 19');
  assert.equal(h.s.guessCount, 23);
});

test('a correct guess ends the round with 3 + floor(secondsLeft / 20) points', () => {
  const h = gameHarness(doodle);
  const word = pick(h, 0);
  h.now += 12_000; // 68 s left -> 3 + 3
  h.act('p2', { type: 'guess', text: `  ${word.toUpperCase()}! ` });
  assert.equal(h.s.phase, 'result');
  assert.deepEqual(
    { ok: h.s.last.ok, secs: h.s.last.secs, pts: h.s.last.pts, how: h.s.last.how, word: h.s.last.word },
    { ok: true, secs: 12, pts: 6, how: 'guess', word },
  );
  assert.equal(h.s.points, 6);
  assert.equal(h.s.gained, 6);
  assert.equal(h.s.nextAt, h.now + RESULT_MS);
  assert.match(h.s.highlights[0], new RegExp(`Alex drew “${word}” — Blair got it in 12s`));
  const s = h.s;
  assert.equal(h.act('p2', { type: 'guess', text: word }), s, 'no double scoring');
  assert.equal(h.act('p1', { type: 'skip' }), s);
});

test('multi-word answers match without spaces/punctuation; hint pattern keeps word gaps', () => {
  assert.ok(doodle.isMatch('icecream', 'ice cream'));
  assert.ok(doodle.isMatch('Ice-Cream!', 'ice cream'));
  assert.ok(doodle.isMatch('the penguins', 'penguin'));
  assert.ok(!doodle.isMatch('cream', 'ice cream'));
  assert.ok(doodle.isNear('pengiun', 'penguin'));
  assert.ok(!doodle.isNear('penguin', 'penguin'));
  assert.ok(!doodle.isNear('cat', 'penguin'));
  assert.equal(doodle.hintFor('airport hug', 0), '');
  assert.equal(doodle.hintFor('airport hug', 1), '_ _ _ _ _ _ _   _ _ _');
  assert.equal(doodle.hintFor('airport hug', 2), 'A _ _ _ _ _ _   _ _ _');
  assert.equal(doodle.hintFor("jack-o'-lantern", 1), "_ _ _ _ - _ ' - _ _ _ _ _ _ _");
});

test('tick: same object while nothing changes, hints at 40 s and 20 s left, timeout ends the round', () => {
  const h = gameHarness(doodle);
  assert.equal(h.tick(1000), h.s);
  const s0 = h.s;
  assert.equal(doodle.tick(s0, h.ctx()), s0, 'choose phase: no-op');
  pick(h, 0);
  const s1 = h.s;
  h.now += 39_000;
  assert.equal(doodle.tick(s1, h.ctx()), s1, '41 s left: nothing yet');
  h.tick(1000); // 40 s left
  assert.equal(h.s.hintLevel, 1);
  assert.match(h.s.hint, /^_/);
  const s2 = h.s;
  assert.equal(h.tick(5000), s2, 'hint does not change again until 20 s');
  h.tick(15_000); // 20 s left
  assert.equal(h.s.hintLevel, 2);
  assert.equal(h.s.hint[0], h.s.word[0].toUpperCase());
  h.tick(19_999);
  assert.equal(h.s.phase, 'draw');
  const late = h.s;
  h.now += 2;
  assert.equal(h.act('p2', { type: 'guess', text: late.word }), late, 'guesses after the deadline are ignored');
  h.tick(0);
  assert.equal(h.s.phase, 'result');
  assert.equal(h.s.last.ok, false);
  assert.equal(h.s.last.how, 'timeout');
  assert.equal(h.s.last.pts, 0);
  assert.match(h.s.highlights.at(-1), /time ran out/);
});

test('skip: drawer only, 0 points; result auto-advances after 8 s and swaps roles', () => {
  const h = gameHarness(doodle);
  pick(h, 2);
  assert.equal(h.act('p2', { type: 'skip' }), h.s, 'guesser cannot skip');
  h.act('p1', { type: 'skip' });
  assert.equal(h.s.phase, 'result');
  assert.equal(h.s.last.how, 'skip');
  assert.equal(h.s.points, 0);
  const r = h.s;
  assert.equal(h.tick(RESULT_MS - 1), r, 'still showing the result');
  h.tick(1);
  assert.equal(h.s.phase, 'choose');
  assert.equal(h.s.round, 2);
  assert.equal(h.s.drawer, 'p2');
  assert.equal(h.s.guesser, 'p1');
  assert.equal(h.s.word, '');
  assert.equal(h.s.guesses.length, 0);
  assert.equal(h.s.options.length, 3);
});

test('full game: 4 rounds alternate drawers, final totals, summary, highlights; play again keeps points', () => {
  const h = gameHarness(doodle);
  const drawers = [];
  let expected = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    assert.equal(h.s.phase, 'choose');
    assert.equal(h.s.round, r);
    drawers.push(h.s.drawer);
    const word = pick(h, r % 3);
    if (r === 3) {
      h.tick(DRAW_MS); // nobody gets round 3
    } else {
      h.now += r * 10_000; // 10 s, 20 s, 40 s
      const left = Math.floor((h.s.endsAt - h.now) / 1000);
      expected += 3 + Math.floor(left / 20);
      h.act(h.s.guesser, { type: 'guess', text: word });
    }
    assert.equal(h.s.phase, 'result');
    // Either player can move on.
    h.act(r % 2 ? 'p2' : 'p1', { type: 'next' });
  }
  assert.deepEqual(drawers, ['p1', 'p2', 'p1', 'p2']);
  assert.equal(h.s.phase, 'final');
  assert.equal(h.s.done, true);
  assert.equal(h.s.plays, 1);
  assert.equal(h.s.points, expected);
  assert.equal(h.s.gained, expected);
  assert.match(h.s.summary, /^Guessed 3 of 4 doodles · fastest: “.+” in 10s$/);
  assert.equal(h.s.highlights.length, 4);
  assert.ok(h.s.highlights.every((x) => typeof x === 'string' && x.length < 120));
  assert.equal(h.s.log.length, 4);
  const fin = h.s;
  assert.equal(h.tick(60_000), fin, 'final is stable');
  assert.equal(h.act('p1', { type: 'next' }), fin);
  assert.equal(h.act('stranger', { type: 'again' }), fin);

  h.act('p2', { type: 'again' });
  assert.equal(h.s.phase, 'choose');
  assert.equal(h.s.round, 1);
  assert.equal(h.s.done, false);
  assert.equal(h.s.points, expected, 'points carry over');
  assert.equal(h.s.gained, 0);
  assert.equal(h.s.log.length, 0);
  assert.notEqual(h.s.cid, fin.cid, 'fresh boards for the new game');
  const usedBefore = new Set(fin.used.map(normalizeWord));
  assert.ok(h.s.options.every((w) => !usedBefore.has(normalizeWord(w))), 'no repeats from the last game');
  // Another round adds to the running total and highlights stay capped at 6.
  const w = pick(h, 0);
  h.act('p2', { type: 'guess', text: w });
  assert.ok(h.s.points > expected);
  assert.ok(h.s.highlights.length <= 6);
});

test('again is only possible from the final screen; options never run out', () => {
  const h = gameHarness(doodle);
  const s = h.s;
  assert.equal(h.act('p1', { type: 'again' }), s);
  for (let r = 1; r <= ROUNDS; r++) {
    h.act(h.s.drawer, { type: 'reroll' });
    assert.equal(h.s.options.length, 3);
    pick(h, 0);
    h.act(h.s.drawer, { type: 'skip' });
    h.act('p1', { type: 'next' });
  }
  assert.equal(h.s.phase, 'final');
  assert.equal(h.s.points, 0);
  assert.match(h.s.summary, /none guessed/);
});

test('AI words are validated; junk falls back to the built-in bank', () => {
  const good = ['Cat nap', 'Moon boots', 'Sushi', 'kite surfing', 'Pillow fight', 'Rainbow cake', 'Banjo'];
  const junk = [42, null, '', '   ', 'x', 'five words is too many', 'https://evil.example', '<b>bold</b>', 'a'.repeat(100), { w: 'obj' }, ['arr']];
  const h = gameHarness(doodle, { opts: { content: { words: [...junk, ...good, 'CAT NAPS'] } } });
  assert.equal(h.s.ai, true);
  const allOptions = [h.s.options, ...h.s.pool].flat();
  for (const w of good) assert.ok(allOptions.includes(w), `${w} offered`);
  assert.ok(!allOptions.includes('CAT NAPS'), 'duplicates (after normalising) dropped');
  assert.ok(!allOptions.some((w) => typeof w !== 'string' || w.length > 32 || /[<:/]/.test(w)));
  assert.deepEqual(doodle.validWords({ words: junk }), []);
  assert.deepEqual(doodle.validWords({ words: ['  Hot   dog  '] }), ['Hot dog'], 'trimmed');

  for (const content of [undefined, null, {}, { words: 'cat' }, { words: [1, 2, 3] }, { words: ['only', 'four', 'valid', 'ones'] }]) {
    const f = gameHarness(doodle, { opts: { content } });
    assert.equal(f.s.ai, false);
    assert.ok(f.s.options.every((w) => ALL_WORDS.includes(w)));
  }
});

test('word bank: 160+ unique, short, drawable entries', () => {
  const norm = ALL_WORDS.map(normalizeWord);
  assert.ok(ALL_WORDS.length >= 160, `${ALL_WORDS.length} words`);
  assert.equal(new Set(norm).size, norm.length, 'no duplicates');
  for (const w of ALL_WORDS) {
    assert.ok(w.length <= 24 && w.split(' ').length <= 4, w);
    assert.equal(doodle.validWords({ words: [w] }).length, 1, `${w} passes our own validation`);
  }
  assert.ok(US.length >= 30, 'plenty of couple-themed words');
});

test('silly vibe leans on silly wildcards', () => {
  const h = gameHarness(doodle);
  const ctx = { ...h.ctx('p1'), settings: { vibe: 'silly' } };
  const s = doodle.init(ctx, {});
  assert.ok(SILLY.includes(s.options[2]));
});
