// Know Me Better — 8 rounds, taking turns in the spotlight. Each round one of you (the "subject")
// answers a question about yourself while the other secretly guesses what you'll say. Both lock
// in, then the answers flip over together. Matching guesses earn together points.
//
//   phase: answer -> (judge, open questions only) -> reveal -> answer ... -> over
//
// Question kinds: choice (4 options, value = index), scale (value = 1..10), open (value = text).

import { QUESTIONS } from '../../content/knowme.js';
import { cleanText, matchKey, wordsMatch, shuffle } from '../../lib/util.js';

export const ROUNDS = 8;
export const MAX_SKIPS = 3;
export const MAX_ANSWER = 60;
export const SCALE_MAX = 10;
export const KINDS = ['choice', 'scale', 'open'];
const VIBES = ['sweet', 'flirty', 'silly', 'deep'];
const SEEN_MAX = 100;

export const meta = {
  id: 'knowme',
  title: 'Know Me Better',
  emoji: '💭',
  tagline: 'How well do you really know me?',
  description:
    'Take turns in the spotlight: one of you answers a question about yourself while the other secretly guesses your answer. Flip them over together — every match earns together points.',
  minPlayers: 2,
  ai: { task: 'knowme_questions', label: 'personal questions' },
};

// ---------------------------------------------------------------- questions

/** Only the fields the game needs (keeps the broadcast state small). */
function slim(q, id, ai = false) {
  const out = { id, text: q.text, kind: q.kind };
  if (q.kind === 'choice') out.options = q.options.slice(0, 4);
  if (q.kind === 'scale') Object.assign(out, { low: q.low, high: q.high });
  if (ai) out.ai = true;
  return out;
}

/** Comparison key for question / option texts: "Go-to comfort food" = "go to comfort-foods". */
const keyOf = (t) => matchKey(t) || String(t).toLowerCase().trim();

const BANK = QUESTIONS.map((q, i) => ({ ...slim(q, `b${i}`), vibes: q.vibes || [] }));
const BANK_KEY = new Map(BANK.map((q) => [q.id, keyOf(q.text)]));

const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? cleanText(v, max) : '');

/**
 * Validate AI-provided questions (`{ questions: [{ text, kind, options, low, high }] }`).
 * Untrusted input: wrong shapes are dropped, strings trimmed and capped, duplicates removed.
 */
export function validQuestions(content) {
  const list = Array.isArray(content?.questions) ? content.questions.slice(0, 30) : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') continue;
    // The prompt asks for a bare noun phrase; forgive a stray "About you:" prefix or a "?".
    const text = cleanText(raw.text, 80)
      .replace(/^about (you|me|them)\s*[:\-–—]\s*/i, '')
      .replace(/\?+$/, '')
      .trim();
    if (text.length < 3 || seen.has(keyOf(text))) continue;
    let q = null;
    if (raw.kind === 'choice' && Array.isArray(raw.options)) {
      const options = [];
      const keys = new Set();
      for (const op of raw.options.slice(0, 8)) {
        const t = str(op, 40);
        if (!t || keys.has(keyOf(t))) continue;
        keys.add(keyOf(t));
        options.push(t);
        if (options.length === 4) break;
      }
      if (options.length === 4) q = { text, kind: 'choice', options };
    } else if (raw.kind === 'scale') {
      const low = str(raw.low, 24);
      const high = str(raw.high, 24);
      if (low && high && keyOf(low) !== keyOf(high)) q = { text, kind: 'scale', low, high };
    } else if (raw.kind === 'open') {
      q = { text, kind: 'open' };
    }
    if (!q) continue;
    seen.add(keyOf(text));
    out.push(slim(q, `a${out.length}`, true));
    if (out.length === ROUNDS) break;
  }
  return out;
}

/**
 * Pick `n` bank questions: at least half match tonight's vibe, the rest from any vibe, with a
 * cap per kind so a game gets a healthy mix (counting `preset` questions, e.g. from the AI).
 * `order` ranks candidates (never-asked first), `taken` holds ids already in this game.
 */
function pickBank(n, { vibe, order, taken, preset = [], capped = true }) {
  if (n <= 0) return [];
  const avail = BANK.filter((q) => !taken.has(q.id));
  // 8 rounds -> 3 choice, 3 scale, 2 open (open answers need typing + judging, so fewer of them).
  const total = n + preset.length;
  const caps = { choice: Math.ceil(total * 0.375), scale: Math.ceil(total * 0.375), open: Math.ceil(total * 0.25) };
  const count = { choice: 0, scale: 0, open: 0 };
  for (const q of preset) count[q.kind]++;
  const picked = [];
  const ids = new Set();
  const take = (list, upto, withCaps) => {
    for (const q of list) {
      if (picked.length >= upto) break;
      if (ids.has(q.id) || (withCaps && count[q.kind] >= caps[q.kind])) continue;
      ids.add(q.id);
      count[q.kind]++;
      picked.push(q);
    }
  };
  const matching = order(avail.filter((q) => q.vibes.includes(vibe)));
  const any = order(avail);
  take(matching, Math.ceil(n / 2), capped);
  take(any, n, capped);
  take(any, n, false);
  return picked;
}

/**
 * Questions for one play: `rounds` (ROUNDS of them) plus `spares` for skips. Never a repeat
 * within a game; across "play again" never-asked questions come first, then ones asked longest
 * ago, and last game's questions only if nothing else fits.
 */
function deal(ctx, ai, seen) {
  const vibe = VIBES.includes(ctx.settings?.vibe) ? ctx.settings.vibe : 'sweet';
  const rand = ctx.random;
  const asked = new Set(seen);
  const recent = new Set(seen.slice(-(ROUNDS + MAX_SKIPS)));
  const order = (list) => [
    ...shuffle(list.filter((q) => !asked.has(q.id)), rand),
    ...shuffle(list.filter((q) => asked.has(q.id) && !recent.has(q.id)), rand),
    ...shuffle(list.filter((q) => recent.has(q.id)), rand),
  ];
  // The AI is free to write a question the bank also has (its prompt even lists "Go-to comfort
  // food" as a good example), so bank questions with the same text never join the rounds or spares.
  const aiKeys = new Set(ai.map((q) => keyOf(q.text)));
  const taken = new Set(BANK.filter((q) => aiKeys.has(BANK_KEY.get(q.id))).map((q) => q.id));
  const fromBank = pickBank(ROUNDS - ai.length, { vibe, order, taken, preset: ai });
  for (const q of fromBank) taken.add(q.id);
  const spares = pickBank(MAX_SKIPS, { vibe, order, taken, capped: false });
  const strip = ({ vibes, ...q }) => q;
  return { rounds: shuffle([...ai, ...fromBank.map(strip)], rand), spares: spares.map(strip) };
}

// ---------------------------------------------------------------- helpers (shared with the view)

export const guesserOf = (s, players) => players.find((id) => id !== s.subject);

/** Human-readable answer: option text, "7/10" or the typed text. */
export function showValue(q, v) {
  if (v === undefined || v === null || !q) return '';
  if (q.kind === 'choice') return q.options?.[v] ?? '';
  if (q.kind === 'scale') return `${v}/${SCALE_MAX}`;
  return String(v);
}

/** Final-screen headline for a play: `{ title, line }`. */
export function verdict(gained, max = ROUNDS * 2) {
  const r = max > 0 ? gained / max : 0;
  if (r >= 1) return { title: 'Flawless! 🧠💞', line: 'You two share one brain and it’s adorable.' };
  if (r >= 0.75) return { title: 'Mind readers! 🔮', line: 'Scary good — nothing gets past you two.' };
  if (r >= 0.5) return { title: 'Nicely in tune 💫', line: 'With a few fun surprises left to discover.' };
  if (r >= 0.25) return { title: 'Still a little mysterious 😉', line: 'So much left to learn… sounds like more dates.' };
  return { title: 'Mysterious lovers 🕵️', line: 'Time for a get-to-know-you deep dive!' };
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nameOf = (ctx, id) => ctx.names?.[id] || 'Player';
const lower = (t) => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);

function parseValue(q, v) {
  if (q.kind === 'choice') return Number.isInteger(v) && v >= 0 && v < q.options.length ? v : null;
  if (q.kind === 'scale') return Number.isInteger(v) && v >= 1 && v <= SCALE_MAX ? v : null;
  const text = str(v, MAX_ANSWER);
  return text || null;
}

function autoScore(q, real, guess) {
  if (q.kind === 'choice') return real === guess ? 2 : 0;
  const d = Math.abs(real - guess);
  return d === 0 ? 2 : d === 1 ? 1 : 0;
}

/** Per guesser: { right (spot on), close (+1), total } for the rounds in `log`. */
export function tallyOf(log, players) {
  const t = Object.fromEntries(players.map((id) => [id, { right: 0, close: 0, total: 0 }]));
  for (const r of log) {
    const g = t[r.guesser];
    if (!g) continue;
    g.total++;
    if (r.score === 2) g.right++;
    else if (r.score === 1) g.close++;
  }
  return t;
}

function highlightLine(r, ctx) {
  const g = nameOf(ctx, r.guesser);
  const what = `${nameOf(ctx, r.subject)}'s ${lower(r.text)}`;
  const line =
    r.score === 2
      ? `${g} guessed ${what}: ${r.answer} ✓`
      : r.score === 1
        ? `${g} nearly guessed ${what}: ${r.answer} (said ${r.guess})`
        : `${g} guessed ${what} was ${r.guess} — it’s ${r.answer}`;
  return cleanText(line, 200);
}

/** `a` + `b` per player (tallies summed across plays). */
function addTallies(a, b, players) {
  const zero = { right: 0, close: 0, total: 0 };
  return Object.fromEntries(
    players.map((id) => {
      const x = a?.[id] || zero;
      const y = b?.[id] || zero;
      return [id, { right: x.right + y.right, close: x.close + y.close, total: x.total + y.total }];
    }),
  );
}

/** Guesser/subject pairs with at least one guess in `t` (mid-game, one of you may not have guessed yet). */
const pairsOf = (t, ctx) => {
  const [p1, p2] = ctx.players;
  return [[p1, p2], [p2, p1]].filter(([g]) => t[g]?.total > 0);
};

/** "Alex knew Blair 2/4, Blair knew Alex 1/4". */
const knewLine = (t, ctx) =>
  pairsOf(t, ctx)
    .map(([g, sub]) => `${nameOf(ctx, g)} knew ${nameOf(ctx, sub)} ${t[g].right}/${t[g].total}`)
    .join(', ');

/** "Alex knows Blair 2/4 · Blair knows Alex 1/4" (the last highlight line). */
const knowsLine = (t, ctx) =>
  pairsOf(t, ctx)
    .map(([g, sub]) => `${nameOf(ctx, g)} knows ${nameOf(ctx, sub)} ${t[g].right}/${t[g].total}`)
    .join(' · ');

/** A few memorable rounds for the recap poem: up to 3 spot-on guesses and a funny miss. */
function memorable(log, ctx) {
  const hits = log.filter((r) => r.score === 2).slice(0, 3);
  const other = log.filter((r) => r.score < 2).slice(0, 4 - hits.length);
  return log.filter((r) => hits.includes(r) || other.includes(r)).map((r) => highlightLine(r, ctx));
}

/**
 * Recap for leaving through ✕ mid-game (called by the room when the game is closed): the same
 * kind of summary and highlights a finished play gets, built from the rounds revealed so far.
 * Pure — never touches `s`. A round still being answered or judged doesn't count.
 */
export function summarize(s, ctx) {
  if (!s || !Array.isArray(s.log) || !Array.isArray(ctx?.players) || ctx.players.length < 2) return {};
  const carry = { summary: s.summary || '', highlights: Array.isArray(s.highlights) ? s.highlights : [] };
  if (s.done || !s.log.length) return carry; // finished, or nothing new since the last finished play
  const tally = tallyOf(s.log, ctx.players);
  const plays = Number.isInteger(s.plays) ? s.plays : 0;
  const n = s.log.length;
  const summary = plays
    ? `Over ${plays} game${plays > 1 ? 's' : ''} and ${n} round${n > 1 ? 's' : ''}: ${knewLine(addTallies(s.totals, tally, ctx.players), ctx)}`
    : `${knewLine(tally, ctx)} so far (+${s.gained} pts)`;
  const highlights = [...carry.highlights, ...memorable(s.log, ctx), `${knowsLine(tally, ctx)} so far`].slice(-6);
  return { summary, highlights };
}

// ---------------------------------------------------------------- state

const EMPTY_CARRY = { seen: [], plays: 0, points: 0, totals: {}, summary: '', highlights: [] };

function fresh(ctx, deck, carry) {
  const [q, ...queue] = deck.rounds;
  return {
    phase: 'answer', // answer -> (judge) -> reveal -> answer ... -> over
    round: 1,
    total: ROUNDS,
    subject: ctx.players[0], // whose turn in the spotlight; the other one guesses
    q, // current question
    queue, // upcoming questions for this play
    spares: deck.spares, // fresh questions for "skip"
    answers: {}, // playerId -> value (subject: real answer, other: guess) — hidden until reveal
    result: null, // { score, how: 'auto' | 'exact' | 'judged' } once revealed
    skips: 0,
    skippedBy: null,
    log: [], // [{ text, kind, subject, guesser, answer, guess, score }] this play
    tally: null, // tallyOf(log) when the play is over
    seen: [...carry.seen, q.id].slice(-SEEN_MAX), // bank ids already asked (avoid repeats on "play again")
    ai: deck.rounds.some((x) => x.ai),
    plays: carry.plays,
    gained: 0, // points from this play
    points: carry.points, // total across plays (what the recap adds up)
    totals: carry.totals, // tally summed across plays
    done: false,
    summary: carry.summary,
    highlights: carry.highlights,
  };
}

export function init(ctx, opts = {}) {
  const ai = validQuestions(opts?.content);
  return fresh(ctx, deal(ctx, ai, []), EMPTY_CARRY);
}

function settle(s, score, ctx, how) {
  const guesser = guesserOf(s, ctx.players);
  const entry = {
    text: s.q.text,
    kind: s.q.kind,
    subject: s.subject,
    guesser,
    answer: showValue(s.q, s.answers[s.subject]),
    guess: showValue(s.q, s.answers[guesser]),
    score,
  };
  return {
    ...s,
    phase: 'reveal',
    result: { score, how },
    log: [...s.log, entry],
    gained: s.gained + score,
    points: s.points + score,
  };
}

function finish(s, ctx) {
  const tally = tallyOf(s.log, ctx.players);
  const totals = addTallies(s.totals, tally, ctx.players);
  const plays = s.plays + 1;
  const summary = plays === 1 ? `${knewLine(tally, ctx)} (+${s.gained} pts)` : `Over ${plays} games: ${knewLine(totals, ctx)}`;
  const lines = [...memorable(s.log, ctx), knowsLine(tally, ctx)];
  return {
    ...s,
    phase: 'over',
    done: true,
    plays,
    tally,
    totals,
    summary,
    highlights: [...s.highlights, ...lines].slice(-6),
  };
}

export function reduce(s, a, ctx) {
  if (!s || !a || !Array.isArray(ctx?.players) || !ctx.players.includes(a.by)) return s;
  switch (a.type) {
    case 'answer': {
      // Lock in: the subject's real answer or the guesser's prediction. Final once sent.
      if (s.phase !== 'answer' || hasOwn(s.answers, a.by)) return s;
      if (a.q !== undefined && a.q !== s.q.id) return s; // stale (question was skipped meanwhile)
      const value = parseValue(s.q, a.value);
      if (value === null) return s;
      const answers = { ...s.answers, [a.by]: value };
      const guesser = guesserOf(s, ctx.players);
      if (!hasOwn(answers, s.subject) || !hasOwn(answers, guesser)) return { ...s, answers };
      const both = { ...s, answers };
      const real = answers[s.subject];
      const guess = answers[guesser];
      if (s.q.kind === 'open') {
        // Word-for-word matches score themselves; anything else the subject judges.
        return wordsMatch(real, guess) ? settle(both, 2, ctx, 'exact') : { ...both, phase: 'judge' };
      }
      return settle(both, autoScore(s.q, real, guess), ctx, 'auto');
    }
    case 'judge': {
      if (s.phase !== 'judge' || a.by !== s.subject) return s;
      if (a.score !== 0 && a.score !== 1 && a.score !== 2) return s;
      return settle(s, a.score, ctx, 'judged');
    }
    case 'skip': {
      if (s.phase !== 'answer' || s.skips >= MAX_SKIPS || !s.spares.length) return s;
      if (a.q !== undefined && a.q !== s.q.id) return s; // both tapped skip at once: only one counts
      const [q, ...spares] = s.spares;
      return {
        ...s,
        q,
        spares,
        answers: {},
        skips: s.skips + 1,
        skippedBy: a.by,
        seen: [...s.seen, q.id].slice(-SEEN_MAX),
      };
    }
    case 'next': {
      if (s.phase !== 'reveal') return s;
      if (a.round !== undefined && a.round !== s.round) return s; // double tap from both sides
      if (s.round >= ROUNDS || !s.queue.length) return finish(s, ctx);
      const [q, ...queue] = s.queue;
      const round = s.round + 1;
      return {
        ...s,
        phase: 'answer',
        round,
        subject: ctx.players[(round - 1) % 2],
        q,
        queue,
        answers: {},
        result: null,
        skippedBy: null,
        seen: [...s.seen, q.id].slice(-SEEN_MAX),
      };
    }
    case 'again': {
      if (!s.done) return s;
      return fresh(ctx, deal(ctx, [], s.seen), s);
    }
    default:
      return s;
  }
}
