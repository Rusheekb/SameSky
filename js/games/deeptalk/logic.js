// Heart to Heart — a cosy, non-competitive conversation deck for a video call.
// Draw a card face-down, flip it together, then either talk it through or both write an answer
// secretly and reveal side by side. Save the ones you love. +1 together point per card shared.

import { CARDS, CLOSINGS } from '../../content/deeptalk.js';
import { cleanText, pick } from '../../lib/util.js';

export const MAX_CARDS = 15; // after this many shared cards the only way forward is Finish
export const MAX_FAVS = 20;
export const MAX_ANSWER = 280;
const MAX_AI = 20;

export const LEVELS = {
  1: { name: 'Warm-up', emoji: '☕' },
  2: { name: 'Closer', emoji: '🕯️' },
  3: { name: 'Deep', emoji: '🌊' },
};
const LEVEL_IDS = [1, 2, 3];
const DEPTH = { 1: 'kept it light', 2: 'got closer', 3: 'went deep' };

export const meta = {
  id: 'deeptalk',
  title: 'Heart to Heart',
  emoji: '💌',
  tagline: 'Cards to get closer.',
  description:
    'A cosy deck of questions for your call. Flip a card, then talk it through or both write an answer and reveal together. Save the ones you love.',
  minPlayers: 2,
  ai: { task: 'deeptalk_cards', label: 'conversation cards' },
};

/** AI result -> [{ text, level }] (trimmed, deduped, level 1..3). */
export function validCards(content) {
  const raw = Array.isArray(content?.cards) ? content.cards : [];
  const seen = new Set();
  const out = [];
  for (const c of raw.slice(0, 60)) {
    if (!c || typeof c !== 'object' || typeof c.text !== 'string') continue;
    const text = cleanText(c.text, 200);
    const level = typeof c.level === 'string' ? Number(c.level.trim()) : c.level;
    if (text.length < 8 || !LEVEL_IDS.includes(level)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, level });
    if (out.length >= MAX_AI) break;
  }
  return out;
}

function candidates(s, level, used) {
  const usedSet = new Set(used);
  // Personalised AI cards first, then the built-in deck.
  const ai = s.aiCards.map((c, i) => ({ id: `a${i}`, text: c.text, level: c.level })).filter((c) => c.level === level && !usedSet.has(c.id));
  if (ai.length) return ai;
  const bank = (CARDS[level] || []).map((text, i) => ({ id: `${level}-${i}`, text, level }));
  const fresh = bank.filter((c) => !usedSet.has(c.id));
  if (fresh.length) return fresh;
  return bank.filter((c) => c.id !== s.card?.id); // whole level seen: allow repeats
}

/** Deal a new face-down card. `redraw` swaps the current unseen card (level change) without using a turn. */
function deal(s, level, ctx, redraw = false) {
  const used = redraw ? s.used.filter((id) => id !== s.card?.id) : s.used;
  const card = pick(candidates(s, level, redraw ? s.used : used), ctx.random);
  const drawn = redraw ? s.drawn : s.drawn + 1;
  return {
    ...s,
    level,
    card,
    used: [...used, card.id].slice(-80),
    drawn,
    first: ctx.players[(drawn - 1) % 2] || ctx.players[0],
    flipped: false,
    mode: null,
    answers: {},
    outcome: null,
  };
}

export function init(ctx, opts = {}) {
  const aiCards = validCards(opts.content);
  const level = ctx.settings?.vibe === 'deep' ? 2 : 1;
  return deal(
    {
      phase: 'card', // card -> done
      level, // level of the NEXT card drawn (and of the current one unless changed after flipping)
      card: null, // { id, text, level }
      flipped: false,
      mode: null, // null | 'write'
      answers: {}, // playerId -> sealed answer (write mode; never shown before both are in)
      outcome: null, // null | 'talked' | 'written'
      first: ctx.players[0], // who answers first on this card
      drawn: 0,
      count: 0, // cards shared
      deepest: 0,
      used: [], // card ids drawn this game
      aiCards,
      ai: aiCards.length > 0,
      favs: [], // [{ id, text, level, answers|null }]
      recent: [], // last few shared card texts (recap fallback when nothing is saved)
      closing: '',
      done: false,
      points: 0,
      summary: '',
      highlights: [],
    },
    level,
    ctx,
  );
}

function complete(s, outcome) {
  const answers = outcome === 'written' ? s.answers : null;
  return {
    ...s,
    outcome,
    favs: answers ? s.favs.map((f) => (f.id === s.card.id ? { ...f, answers } : f)) : s.favs,
    count: s.count + 1,
    points: s.points + 1,
    deepest: Math.max(s.deepest, s.card.level),
    recent: [...s.recent, s.card.text].slice(-3),
  };
}

const short = (t) => (t.length > 110 ? `${t.slice(0, 107).trimEnd()}…` : t);

function finish(s, ctx) {
  const n = s.count;
  const saved = s.favs.length;
  const summary = n
    ? `Shared ${n} heart-to-heart card${n === 1 ? '' : 's'} and ${DEPTH[s.deepest] || 'opened up'}${saved ? ` · ${saved} saved ⭐` : ''}`
    : 'Peeked at the Heart to Heart deck';
  const highlights = (saved ? s.favs.map((f) => f.text) : s.recent).slice(-6).map(short);
  return { ...s, phase: 'done', done: true, summary, highlights, closing: pick(CLOSINGS, ctx.random) };
}

export function reduce(s, a, ctx) {
  if (!a || !ctx.players.includes(a.by) || s.phase !== 'card') return s;
  const onCard = a.card != null && a.card === s.card?.id;
  switch (a.type) {
    case 'flip':
      return onCard && !s.flipped ? { ...s, flipped: true } : s;
    case 'talked':
      // Also the way out of "write it down" before both answers are in.
      if (!onCard || !s.flipped || s.outcome) return s;
      return complete({ ...s, mode: null, answers: {} }, 'talked');
    case 'write':
      if (!onCard || !s.flipped || s.outcome || s.mode === 'write') return s;
      return { ...s, mode: 'write', answers: {} };
    case 'answer': {
      if (!onCard || s.mode !== 'write' || s.outcome || s.answers[a.by]) return s;
      if (typeof a.text !== 'string') return s;
      const text = cleanText(a.text, MAX_ANSWER);
      if (!text) return s;
      const answers = { ...s.answers, [a.by]: text };
      if (!ctx.players.every((id) => answers[id])) return { ...s, answers };
      return complete({ ...s, answers }, 'written');
    }
    case 'save': {
      if (!onCard || !s.flipped || typeof a.on !== 'boolean') return s;
      const has = s.favs.some((f) => f.id === s.card.id);
      if (a.on === has) return s;
      if (!a.on) return { ...s, favs: s.favs.filter((f) => f.id !== s.card.id) };
      if (s.favs.length >= MAX_FAVS) return s;
      const fav = { id: s.card.id, text: s.card.text, level: s.card.level, answers: s.outcome === 'written' ? s.answers : null };
      return { ...s, favs: [...s.favs, fav] };
    }
    case 'level': {
      if (!LEVEL_IDS.includes(a.level) || a.level === s.level) return s;
      // A face-down card is swapped for one from the new level; otherwise it applies to the next card.
      return s.flipped ? { ...s, level: a.level } : deal(s, a.level, ctx, true);
    }
    case 'next':
      if (!onCard) return s;
      return s.count >= MAX_CARDS ? finish(s, ctx) : deal(s, s.level, ctx);
    case 'finish':
      return finish(s, ctx);
    default:
      return s;
  }
}
