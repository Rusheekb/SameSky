// Doodle Dash — one draws a secret word live, the other guesses. 4 rounds, roles alternate.
//
// Phases: choose (drawer picks 1 of 3 words) -> draw (80 s; guesses stream in) -> result -> ...
//         -> final. Strokes never live in state: they stream over fx (see js/ui/canvas.js).
// Secrets: `options` and `word` are in state (the whole state is shared) but the view only shows
// them to the drawer until the round's result.

import { EASY, MEDIUM, US, SILLY, ALL_WORDS } from '../../content/doodle.js';
import { cleanText, normalizeWord, wordsMatch, isCloseGuess, shuffle } from '../../lib/util.js';

export const ROUNDS = 4;
export const DRAW_MS = 80000;
export const RESULT_MS = 8000;
export const HINT1_LEFT = 40000; // letter pattern
export const HINT2_LEFT = 20000; // + first letter
export const MAX_GUESSES = 12;
export const GUESS_MAX = 40;
const OPTION_SETS = 8; // 4 rounds + one reroll each

export const meta = {
  id: 'doodle',
  title: 'Doodle Dash',
  emoji: '🎨',
  tagline: 'Draw it, they guess it',
  description:
    'Take turns drawing a secret word live while the other guesses as fast as they can. Quicker guesses earn more together points. Four rounds, two each.',
  minPlayers: 2,
  ai: { task: 'doodle_words', label: 'drawing words' },
};

/** Sanitise AI-provided words: 1–4 short words of letters/digits, unique. */
export function validWords(content) {
  const raw = Array.isArray(content?.words) ? content.words : [];
  const out = [];
  const seen = new Set();
  for (const w of raw.slice(0, 80)) {
    if (typeof w !== 'string' || w.length > 60) continue;
    const t = cleanText(w, 32);
    if (!t || !/^[\p{L}\p{N}][\p{L}\p{N}' -]*$/u.test(t) || t.split(' ').length > 4) continue;
    const n = normalizeWord(t);
    if (n.replace(/ /g, '').length < 2 || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
    if (out.length >= 40) break;
  }
  return out;
}

const squash = (w) => normalizeWord(w).replace(/ /g, '');

/** "ice cream", "Ice-Cream!" and "icecreams" all count. */
export function isMatch(guess, word) {
  if (wordsMatch(guess, word)) return true;
  const g = squash(guess);
  return g.length > 0 && g === squash(word);
}

/** Same letters with one neighbouring pair swapped ("pengiun"). */
function oneSwap(a, b) {
  if (a.length !== b.length || a.length < 4) return false;
  const diff = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
}

/** A typo-level near miss (but not a match) — shown as "so close!" to both. */
export function isNear(guess, word) {
  if (isMatch(guess, word)) return false;
  const g = squash(guess);
  const w = squash(word);
  return isCloseGuess(guess, word) || isCloseGuess(g, w) || oneSwap(g, w);
}

/** "_ _ _ _ _   _ _ _" (level 1) or "A _ _ _ _   _ _ _" (level 2). */
export function hintFor(word, level) {
  if (!level) return '';
  let shown = false;
  return String(word)
    .split(' ')
    .filter(Boolean)
    .map((w) =>
      [...w]
        .map((ch) => {
          if (!/[\p{L}\p{N}]/u.test(ch)) return ch;
          if (level >= 2 && !shown) {
            shown = true;
            return ch.toUpperCase();
          }
          return '_';
        })
        .join(' '),
    )
    .join('   ');
}

function pickFrom(list, used, rand) {
  const avoid = new Set(used.map(normalizeWord));
  const fresh = list.filter((w) => !avoid.has(normalizeWord(w)));
  return shuffle(fresh.length >= OPTION_SETS ? fresh : list, rand);
}

/** OPTION_SETS triples of [easy, medium, themed] (or AI words first, topped up from the bank). */
function makeSets(rand, vibe, aiWords, used) {
  const sets = [];
  if (aiWords.length >= 6) {
    const seen = new Set();
    const words = [];
    for (const w of [...shuffle(aiWords, rand), ...pickFrom(ALL_WORDS, used, rand)]) {
      const n = normalizeWord(w);
      if (seen.has(n)) continue;
      seen.add(n);
      words.push(w);
    }
    for (let i = 0; i < OPTION_SETS; i++) sets.push(words.slice(i * 3, i * 3 + 3));
    return sets;
  }
  const [main, side] = vibe === 'silly' ? [SILLY, US] : [US, SILLY];
  const e = pickFrom(EASY, used, rand);
  const m = pickFrom(MEDIUM, used, rand);
  const t1 = pickFrom(main, used, rand);
  const t2 = pickFrom(side, used, rand);
  for (let i = 0; i < OPTION_SETS; i++) sets.push([e[i % e.length], m[i % m.length], i % 3 === 2 ? t2[i % t2.length] : t1[i % t1.length]]);
  return sets;
}

function cid(rand) {
  return Math.floor(rand() * 2176782336).toString(36).padStart(6, '0');
}

function fresh(ctx, { aiWords = [], used = [] } = {}, carry = { points: 0, summary: '', highlights: [], plays: 0 }) {
  const [options, ...pool] = makeSets(ctx.random, ctx.settings?.vibe, aiWords, used);
  return {
    phase: 'choose', // choose -> draw -> result -> (choose ...) -> final
    round: 1,
    rounds: ROUNDS,
    drawer: ctx.players[0],
    guesser: ctx.players[1],
    options, // secret: the drawer's three choices
    rerolled: false,
    pool, // spare option sets
    word: '', // secret until the result
    hint: '',
    hintLevel: 0,
    startedAt: 0,
    endsAt: 0,
    nextAt: 0,
    guesses: [], // [{ text, close }] newest last, capped
    guessCount: 0,
    closeCount: 0,
    last: null, // latest round result
    log: [], // [{ round, word, drawer, guesser, ok, how, secs, pts }]
    used: used.slice(-40),
    cid: cid(ctx.random), // prefix for the per-round drawing boards
    ai: aiWords.length >= 6,
    done: false,
    plays: carry.plays,
    gained: 0,
    points: carry.points,
    summary: carry.summary,
    highlights: carry.highlights,
  };
}

export function init(ctx, opts = {}) {
  return fresh(ctx, { aiWords: validWords(opts.content) });
}

function nameOf(ctx, id) {
  return ctx.names?.[id] || 'Someone';
}

function highlight(r, ctx) {
  const d = nameOf(ctx, r.drawer);
  if (r.ok) return `${d} drew “${r.word}” — ${nameOf(ctx, r.guesser)} got it in ${r.secs}s`;
  if (r.how === 'skip') return `${d} skipped “${r.word}”`;
  return `${d} drew “${r.word}” — time ran out`;
}

function summaryOf(log, final) {
  const ok = log.filter((r) => r.ok);
  if (!ok.length) return `${log.length} doodle${log.length === 1 ? '' : 's'}, none guessed, pure abstract art`;
  const best = ok.reduce((a, b) => (b.secs < a.secs ? b : a));
  return `Guessed ${ok.length} of ${final ? ROUNDS : log.length} doodles · fastest: “${best.word}” in ${best.secs}s`;
}

function finishRound(s, ctx, { ok, how }) {
  const secs = Math.max(0, Math.min(DRAW_MS / 1000, Math.round((ctx.now - s.startedAt) / 1000)));
  const left = Math.max(0, Math.floor((s.endsAt - ctx.now) / 1000));
  const pts = ok ? 3 + Math.floor(left / 20) : 0;
  const entry = { round: s.round, word: s.word, drawer: s.drawer, guesser: s.guesser, ok, how, secs, pts };
  const log = [...s.log, entry];
  return {
    ...s,
    phase: 'result',
    last: entry,
    log,
    nextAt: ctx.now + RESULT_MS,
    gained: s.gained + pts,
    points: s.points + pts,
    summary: summaryOf(log, false),
    highlights: [...s.highlights, highlight(entry, ctx)].slice(-6),
  };
}

function advance(s, ctx) {
  if (s.round >= s.rounds) {
    return { ...s, phase: 'final', done: true, plays: s.plays + 1, nextAt: 0, summary: summaryOf(s.log, true) };
  }
  let pool = s.pool;
  if (!pool.length) pool = makeSets(ctx.random, ctx.settings?.vibe, [], s.used);
  const [options, ...rest] = pool;
  return {
    ...s,
    phase: 'choose',
    round: s.round + 1,
    drawer: s.guesser,
    guesser: s.drawer,
    options,
    pool: rest,
    rerolled: false,
    word: '',
    hint: '',
    hintLevel: 0,
    startedAt: 0,
    endsAt: 0,
    nextAt: 0,
    guesses: [],
    guessCount: 0,
    closeCount: 0,
  };
}

/**
 * Actions may carry the `round` they were made in; one that arrives late (after a reconnect) or
 * loses a race (both tap "Next round") is then ignored instead of hitting a later round.
 */
export function reduce(s, a, ctx) {
  if (!a || !ctx.players.includes(a.by)) return s;
  if (a.round !== undefined && a.round !== s.round) return s;
  switch (a.type) {
    case 'choose': {
      if (s.phase !== 'choose' || a.by !== s.drawer) return s;
      const i = a.index;
      if (!Number.isInteger(i) || i < 0 || i >= s.options.length) return s;
      return {
        ...s,
        phase: 'draw',
        word: s.options[i],
        used: [...s.used, ...s.options].slice(-40),
        options: [],
        hint: '',
        hintLevel: 0,
        startedAt: ctx.now,
        endsAt: ctx.now + DRAW_MS,
        guesses: [],
      };
    }
    case 'reroll': {
      if (s.phase !== 'choose' || a.by !== s.drawer || s.rerolled || !s.pool.length) return s;
      const [options, ...pool] = s.pool;
      return { ...s, options, pool, rerolled: true, used: [...s.used, ...s.options].slice(-40) };
    }
    case 'guess': {
      if (s.phase !== 'draw' || a.by !== s.guesser || ctx.now > s.endsAt) return s;
      const text = cleanText(a.text, GUESS_MAX);
      const norm = normalizeWord(text);
      if (!text || !norm) return s;
      const prev = s.guesses[s.guesses.length - 1];
      if (prev && normalizeWord(prev.text) === norm) return s;
      if (isMatch(text, s.word)) return finishRound({ ...s, guessCount: s.guessCount + 1 }, ctx, { ok: true, how: 'guess' });
      const close = isNear(text, s.word);
      return {
        ...s,
        guesses: [...s.guesses, { text, close }].slice(-MAX_GUESSES),
        guessCount: s.guessCount + 1,
        closeCount: s.closeCount + (close ? 1 : 0),
      };
    }
    case 'skip': {
      if (s.phase !== 'draw' || a.by !== s.drawer) return s;
      return finishRound(s, ctx, { ok: false, how: 'skip' });
    }
    case 'next': {
      if (s.phase !== 'result') return s;
      return advance(s, ctx);
    }
    case 'again': {
      if (s.phase !== 'final') return s;
      return fresh(ctx, { used: s.used }, s);
    }
    default:
      return s;
  }
}

export function tick(s, ctx) {
  if (s.phase === 'draw') {
    if (ctx.now >= s.endsAt) return finishRound(s, ctx, { ok: false, how: 'timeout' });
    const left = s.endsAt - ctx.now;
    const level = left <= HINT2_LEFT ? 2 : left <= HINT1_LEFT ? 1 : 0;
    if (level > s.hintLevel) return { ...s, hintLevel: level, hint: hintFor(s.word, level) };
    return s;
  }
  if (s.phase === 'result' && s.nextAt && ctx.now >= s.nextAt) return advance(s, ctx);
  return s;
}
