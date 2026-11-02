// In Sync — both type a word at the same time. If the words differ, the next round asks for a
// word that links the two you just said. Keep going until you say the same word.
//
// This is the reference game: every game exports `meta`, `init`, `reduce` (and optionally `tick`)
// as pure functions, and stores `done`, `points`, `summary`, `highlights` on its state for the recap.

import { SEED_PAIRS } from '../../content/insync.js';
import { cleanText, matchKey, wordsMatch, shuffle } from '../../lib/util.js';

export const MAX_ROUNDS = 10;

export const meta = {
  id: 'insync',
  title: 'In Sync',
  emoji: '🔮',
  tagline: 'Say the same word at the same time',
  description:
    'You each secretly type a word that links the two on screen. Reveal together. If they differ, your two words become the next pair. Keep going until your minds meet.',
  minPlayers: 2,
  ai: { task: 'insync_seeds', label: 'fresh starting words' },
};

function validPairs(content) {
  const pairs = Array.isArray(content?.pairs) ? content.pairs.slice(0, 40) : [];
  const seen = new Set();
  const out = [];
  for (const p of pairs) {
    const [a, b] = (Array.isArray(p) ? p : [p?.a, p?.b]).map((w) => (typeof w === 'string' ? cleanText(w, 30) : ''));
    if (!a || !b || !matchKey(a) || !matchKey(b) || matchKey(a) === matchKey(b)) continue;
    const key = [matchKey(a), matchKey(b)].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([a, b]);
    if (out.length >= 12) break;
  }
  return out;
}

/** True when the text is usable as a word (letters/numbers of any script, or emoji). */
export const isWord = (w) => !!matchKey(w);

export function init(ctx, opts = {}) {
  const fromAi = validPairs(opts.content);
  const pool = fromAi.length ? fromAi : shuffle(SEED_PAIRS, ctx.random).slice(0, 12);
  return fresh(pool, fromAi.length > 0);
}

// `carry` keeps points/highlights across "play again" so the recap counts every sync.
function fresh(pool, ai, carry = { points: 0, summary: '', highlights: [], plays: 0 }) {
  const [seed, ...rest] = pool.length ? pool : [['Moon', 'Coffee']];
  return {
    phase: 'pick', // pick -> reveal -> (pick ...) -> synced | over
    round: 1,
    pair: seed, // the two words to link this round
    seed,
    words: {}, // playerId -> word locked in this round
    rounds: [], // [{ pair, words, match }]
    pool: rest,
    ai,
    done: false,
    at: null, // authority time the play ended (stamped on the result as a postmark)
    plays: carry.plays,
    gained: 0, // points from the current play
    points: carry.points, // total across plays (what the recap adds up)
    summary: carry.summary,
    highlights: carry.highlights,
  };
}

export function reduce(s, a, ctx) {
  switch (a.type) {
    case 'submit': {
      if (s.phase !== 'pick' || s.words[a.by]) return s;
      const word = cleanText(a.word, 40);
      if (!word || !isWord(word)) return s;
      // Saying one of the two words you're linking doesn't count.
      if (s.pair.some((w) => wordsMatch(w, word))) return s;
      const words = { ...s.words, [a.by]: word };
      if (!ctx.players.every((id) => words[id])) return { ...s, words };
      const [w1, w2] = ctx.players.map((id) => words[id]);
      const match = wordsMatch(w1, w2);
      const rounds = [...s.rounds, { pair: s.pair, words, match }];
      if (!match) return { ...s, words, rounds, phase: 'reveal' };
      const gained = Math.max(3, 11 - s.round);
      const chain = rounds.map((r) => ctx.players.map((id) => r.words[id]).join(' / ')).join(' → ');
      return {
        ...s,
        words,
        rounds,
        phase: 'synced',
        done: true,
        at: ctx.now ?? null,
        plays: s.plays + 1,
        gained,
        points: s.points + gained,
        summary: `Synced on “${w1}” in ${s.round} round${s.round === 1 ? '' : 's'} (from ${s.seed.join(' + ')})`,
        highlights: [...s.highlights, `${s.seed.join(' + ')} → ${chain}`].slice(-6),
      };
    }
    case 'next': {
      if (s.phase !== 'reveal') return s;
      const last = s.rounds[s.rounds.length - 1];
      if (s.round >= MAX_ROUNDS) {
        return {
          ...s,
          phase: 'over',
          done: true,
          at: ctx.now ?? null,
          plays: s.plays + 1,
          gained: 1,
          points: s.points + 1,
          summary: `Didn't sync in ${MAX_ROUNDS} rounds (started from ${s.seed.join(' + ')})`,
          highlights: [
            ...s.highlights,
            `${s.seed.join(' + ')} → ${s.rounds.map((r) => ctx.players.map((id) => r.words[id]).join(' / ')).join(' → ')}`,
          ].slice(-6),
        };
      }
      return { ...s, phase: 'pick', round: s.round + 1, pair: ctx.players.map((id) => last.words[id]), words: {} };
    }
    case 'giveup': {
      if (s.done) return s;
      const gained = s.rounds.length ? 1 : 0;
      return {
        ...s,
        phase: 'over',
        done: true,
        at: ctx.now ?? null,
        plays: s.plays + 1,
        gained,
        points: s.points + gained,
        summary: `Gave up after ${s.rounds.length} round${s.rounds.length === 1 ? '' : 's'} (from ${s.seed.join(' + ')})`,
      };
    }
    case 'again': {
      if (!s.done) return s;
      const pool = s.pool.length ? s.pool : shuffle(SEED_PAIRS, ctx.random).slice(0, 12);
      return fresh(pool, s.ai && s.pool.length > 0, s);
    }
    default:
      return s;
  }
}

/** Recap line when the game is left part-way (✕) instead of finished. */
export function summarize(s, ctx) {
  if (s.done || !s.rounds.length) return { summary: s.summary, highlights: s.highlights };
  const trail = s.rounds.map((r) => ctx.players.map((id) => r.words[id]).join(' / ')).join(' → ');
  return {
    summary: `Stopped after ${s.rounds.length} round${s.rounds.length === 1 ? '' : 's'} (from ${s.seed.join(' + ')})`,
    highlights: [...s.highlights, `${s.seed.join(' + ')} → ${trail}`].slice(-6),
  };
}
