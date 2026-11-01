// This or That — 10 quick dilemmas. Each round you both tap twice: your own pick, and what you
// think your partner picked. Reveal together. Same pick +1, each correct prediction +1.

import { DILEMMAS } from '../../content/thisorthat.js';
import { cleanText, normalizeWord, shuffle } from '../../lib/util.js';

export const ROUNDS = 10;
export const NEXT_MS = 7000; // auto-advance after a reveal
const VIBE_SHARE = 6; // of the 10 dilemmas, this many come from the current vibe
const MAX_SPARE = 12;
const SIDES = ['a', 'b'];
const SLOTS = ['mine', 'guess'];

export const meta = {
  id: 'thisorthat',
  title: 'This or That',
  emoji: '⚖️',
  tagline: 'Pick yours, predict theirs.',
  description:
    'Ten quick dilemmas. Tap what you would pick, then what you think your partner picked. Reveal together: matching picks and good guesses earn together points.',
  minPlayers: 2,
  ai: { task: 'thisorthat_items', label: 'fresh dilemmas' },
};

/** AI result -> [{a, b}] (trimmed, deduped, both sides different). */
export function validItems(content) {
  const raw = Array.isArray(content?.items) ? content.items : [];
  const seen = new Set();
  const out = [];
  for (const it of raw.slice(0, 40)) {
    if (!it || typeof it !== 'object') continue;
    const [a, b] = (Array.isArray(it) ? it : [it.a, it.b]).map((x) => (typeof x === 'string' ? cleanText(x, 40) : ''));
    const na = normalizeWord(a);
    const nb = normalizeWord(b);
    if (!na || !nb || na === nb) continue;
    const key = [na, nb].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a, b });
  }
  return out;
}

/** Pick `n` bank indices: most from the current vibe, the rest mixed, avoiding `used`. */
function drawBank(n, vibe, used, random) {
  const usedSet = new Set(used);
  const idx = DILEMMAS.map((_, i) => i);
  const inVibe = idx.filter((i) => DILEMMAS[i].vibe === vibe);
  const others = idx.filter((i) => DILEMMAS[i].vibe !== vibe);
  let freshVibe = inVibe.filter((i) => !usedSet.has(i));
  let freshOther = others.filter((i) => !usedSet.has(i));
  const wantVibe = inVibe.length ? Math.min(n, Math.max(Math.ceil(n / 2), VIBE_SHARE)) : 0;
  // Ran out (many replays): allow repeats rather than run dry.
  if (freshVibe.length < wantVibe) freshVibe = inVibe;
  if (freshOther.length < n - wantVibe) freshOther = others;
  const picked = [...shuffle(freshVibe, random).slice(0, wantVibe)];
  const rest = shuffle(freshOther, random).slice(0, n - picked.length);
  return shuffle([...picked, ...rest], random);
}

function deal(vibe, spare, used, random) {
  const items = spare.slice(0, ROUNDS);
  const nextSpare = spare.slice(ROUNDS);
  const fromBank = drawBank(ROUNDS - items.length, vibe, used, random);
  for (const i of fromBank) items.push({ a: DILEMMAS[i].a, b: DILEMMAS[i].b });
  const keep = used.filter((i) => !fromBank.includes(i));
  return { items, spare: nextSpare, used: [...keep, ...fromBank].slice(-60), ai: spare.length > 0 };
}

export function init(ctx, opts = {}) {
  const fromAi = validItems(opts.content).slice(0, ROUNDS + MAX_SPARE);
  return fresh(deal(ctx.settings?.vibe, fromAi, [], ctx.random));
}

// `carry` keeps points/highlights across "play again" so the recap counts every round.
function fresh(d, carry = { points: 0, summary: '', highlights: [], plays: 0 }) {
  return {
    phase: 'pick', // pick -> reveal -> pick ... -> over
    round: 1,
    total: ROUNDS,
    items: d.items, // [{a, b}] for this game
    spare: d.spare, // unused AI items for "play again"
    used: d.used, // bank indices already shown this session
    ai: d.ai,
    choices: {}, // playerId -> { mine, guess } for the round in progress (hidden until reveal)
    rounds: [], // [{ mine: {id: side}, guess: {id: side}, same, right: {id: bool}, gained }]
    nextAt: 0,
    done: false,
    plays: carry.plays,
    gained: 0, // points from the current play
    points: carry.points,
    summary: carry.summary,
    highlights: carry.highlights,
  };
}

export const isLocked = (c) => !!(c && c.mine && c.guess);

function revealRound(s, choices, ctx) {
  const [p1, p2] = ctx.players;
  const mine = { [p1]: choices[p1].mine, [p2]: choices[p2].mine };
  const guess = { [p1]: choices[p1].guess, [p2]: choices[p2].guess };
  const same = mine[p1] === mine[p2];
  const right = { [p1]: guess[p1] === mine[p2], [p2]: guess[p2] === mine[p1] };
  const gained = (same ? 1 : 0) + (right[p1] ? 1 : 0) + (right[p2] ? 1 : 0);
  return {
    ...s,
    phase: 'reveal',
    choices,
    rounds: [...s.rounds, { mine, guess, same, right, gained }],
    gained: s.gained + gained,
    points: s.points + gained,
    nextAt: ctx.now + NEXT_MS,
  };
}

/** Stats for the end screen (also used by the view). */
export function stats(s, players) {
  const [p1, p2] = players;
  const n = s.rounds.length || 1;
  const same = s.rounds.filter((r) => r.same).length;
  return {
    same,
    compat: Math.round((same / n) * 100),
    read: { [p1]: s.rounds.filter((r) => r.right[p1]).length, [p2]: s.rounds.filter((r) => r.right[p2]).length },
    differed: s.rounds.map((r, i) => ({ ...r, item: s.items[i] })).filter((r) => !r.same),
  };
}

const side = (item, k) => (k === 'a' ? item.a : item.b);
const other = (k) => (k === 'a' ? 'b' : 'a');

function finish(s, ctx) {
  const [p1, p2] = ctx.players;
  const st = stats(s, ctx.players);
  const name = (id) => ctx.names?.[id] || 'Player';
  const agreed = s.rounds
    .map((r, i) => ({ r, it: s.items[i] }))
    .filter(({ r }) => r.same)
    .slice(0, 3)
    .map(({ r, it }) => `Both picked: ${side(it, r.mine[p1])} over ${side(it, other(r.mine[p1]))}`);
  const split = st.differed.slice(0, 3).map((r) => `Differed on: ${r.item.a} vs ${r.item.b}`);
  const mixed = [];
  for (let i = 0; i < 3; i++) {
    if (agreed[i]) mixed.push(agreed[i]);
    if (split[i]) mixed.push(split[i]);
  }
  return {
    ...s,
    phase: 'over',
    nextAt: 0,
    done: true,
    plays: s.plays + 1,
    summary: `${st.compat}% in tune · ${name(p1)} read ${st.read[p1]}/${s.rounds.length}, ${name(p2)} read ${st.read[p2]}/${s.rounds.length}`,
    highlights: [...s.highlights, ...mixed.slice(0, 4)].slice(-6),
  };
}

function advance(s, ctx) {
  if (s.round >= s.items.length) return finish(s, ctx);
  return { ...s, phase: 'pick', round: s.round + 1, choices: {}, nextAt: 0 };
}

export function reduce(s, a, ctx) {
  if (!a || !ctx.players.includes(a.by)) return s;
  switch (a.type) {
    case 'pick': {
      if (s.phase !== 'pick' || !SLOTS.includes(a.slot) || !SIDES.includes(a.choice)) return s;
      const cur = s.choices[a.by] || { mine: null, guess: null };
      if (isLocked(cur) || cur[a.slot] === a.choice) return s;
      const choices = { ...s.choices, [a.by]: { ...cur, [a.slot]: a.choice } };
      if (!ctx.players.every((id) => isLocked(choices[id]))) return { ...s, choices };
      return revealRound(s, choices, ctx);
    }
    case 'next': {
      if (s.phase !== 'reveal' || (a.round != null && a.round !== s.round)) return s;
      return advance(s, ctx);
    }
    case 'again': {
      if (!s.done) return s;
      return fresh(deal(ctx.settings?.vibe, s.spare, s.used, ctx.random), s);
    }
    default:
      return s;
  }
}

export function tick(s, ctx) {
  if (s.phase !== 'reveal' || !s.nextAt || ctx.now < s.nextAt) return s;
  return advance(s, ctx);
}
