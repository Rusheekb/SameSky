import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWord, wordsMatch, isCloseGuess, normalizeRoomCode, isValidRoomCode, randomCode, formatCode,
  shuffle, seededRandom, cleanText, levenshtein,
} from '../../js/lib/util.js';

test('normalizeWord folds case, accents, articles, punctuation and plurals', () => {
  assert.equal(normalizeWord('  The Waves! '), 'wave');
  assert.equal(normalizeWord('Café'), 'cafe');
  assert.equal(normalizeWord('Berries'), 'berry');
  assert.equal(normalizeWord('boxes'), 'box');
  assert.equal(normalizeWord('glass'), 'glass');
  assert.equal(normalizeWord('bus'), 'bus');
  assert.equal(normalizeWord("Rock 'n' roll"), 'rock n roll');
  assert.equal(normalizeWord('Ice  Cream'), 'ice cream');
});

test('wordsMatch', () => {
  assert.ok(wordsMatch('Moon', 'moons'));
  assert.ok(wordsMatch('a sunset', 'Sunset'));
  assert.ok(!wordsMatch('sun', 'moon'));
  assert.ok(!wordsMatch('', ''));
  assert.ok(!wordsMatch('!!!', '???'));
});

test('isCloseGuess catches typos but not matches or unrelated words', () => {
  assert.ok(isCloseGuess('elefant', 'elephant'));
  assert.ok(isCloseGuess('pizzza', 'pizza'));
  assert.ok(!isCloseGuess('pizza', 'pizza'));
  assert.ok(!isCloseGuess('cat', 'car'));
  assert.ok(!isCloseGuess('banana', 'pizza'));
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

test('room codes', () => {
  assert.equal(normalizeRoomCode('our-sky 2!'), 'OURSKY2');
  assert.ok(isValidRoomCode('OURSKY'));
  assert.ok(!isValidRoomCode('ABC'));
  const c = randomCode(6, seededRandom(1));
  assert.match(c, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  assert.equal(formatCode('K7QM2X'), 'K7Q-M2X');
  assert.equal(formatCode('OURSKYROOM'), 'OURSKYROOM');
});

test('shuffle is a permutation and deterministic with a seed', () => {
  const a = shuffle([1, 2, 3, 4, 5], seededRandom(5));
  const b = shuffle([1, 2, 3, 4, 5], seededRandom(5));
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), [1, 2, 3, 4, 5]);
});

test('cleanText strips control chars, collapses whitespace and caps length', () => {
  assert.equal(cleanText('  hi\u0000 there\n\nyou  ', 100), 'hi there you');
  assert.equal(cleanText('x'.repeat(50), 10).length, 10);
  assert.equal(cleanText(null), '');
});
