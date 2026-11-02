// This or That — 10 quick dilemmas. Each round you both tap twice: your own pick, and what you
// think your partner picked. Reveal together. Same pick +1, each correct prediction +1.

import { DILEMMAS } from '../../content/thisorthat.js';
import { cleanText, matchKey, shuffle } from '../../lib/util.js';

export const ROUNDS = 10;
export const NEXT_MS = 7000; // auto-advance after a reveal
const VIBE_SHARE = 6; // of the 10 dilemmas, this many come from the current vibe
const MAX_SPARE = 12;
const SIDES = ['a', 'b'];
const SLOTS = ['mine', 'guess'];

export const meta = {
  id: 'thisorthat',
  title: 'This or That',
  tagline: 'Pick yours, predict theirs',
  description:
    'Ten quick dilemmas. Tap what you would pick, then what you think your partner picked. Reveal together: matching picks and good guesses earn together points.',
  minPlayers: 2,
  ai: { task: 'thisorthat_items', label: 'fresh dilemmas' },
};

/** Order-free comparison key for a dilemma ("Wi-Fi" = "wifi"). */
const pairKey = (a, b) => [matchKey(a), matchKey(b)].sort().join('|');

/**
 * Each side is shown under both "You'd pick…" and "<partner> would pick…", so "I", "me" or "you"
 * would mean a different person on each screen ("You kiss me first"). Such text is never dealt.
 * ("I-love-yous" is a noun, not a pronoun, and is fine.)
 */
export const PERSONAL = /(?:^|[^\p{L}\p{N}'’-])(?:i|me|my|mine|myself|you|your|yours|yourself)(?=$|[^\p{L}\p{N}-])/iu;

/** AI result -> [{a, b}] (trimmed, deduped, both sides different, no I/you wording). */
export function validItems(content) {
  const raw = Array.isArray(content?.items) ? content.items : [];
  const seen = new Set();
  const out = [];
  for (const it of raw.slice(0, 40)) {
    if (!it || typeof it !== 'object') continue;
    const [a, b] = (Array.isArray(it) ? it : [it.a, it.b]).map((x) => (typeof x === 'string' ? cleanText(x, 40) : ''));
    const ka = matchKey(a);
    const kb = matchKey(b);
    if (!ka || !kb || ka === kb || PERSONAL.test(a) || PERSONAL.test(b)) continue;
    const key = pairKey(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a, b });
  }
  return out;
}

// Bank dilemmas have stable indices; `used` lists the ones already dealt this session, oldest
// first, and covers the whole bank so "least recently seen" is always known.
const USED_CAP = DILEMMAS.length;
const BANK_KEYS = DILEMMAS.map((d) => pairKey(d.a, d.b));

/**
 * Pick `n` bank indices, about 6 from tonight's vibe. Order of preference: never-seen dilemmas
 * from the vibe, then never-seen ones from the other vibes (so a shortfall is topped up with
 * something new), and only once everything has been seen, the least recently seen ones.
 * `skip` holds indices that must not be dealt (e.g. the AI wrote the same dilemma).
 */
function drawBank(n, vibe, used, random, skip = new Set()) {
  if (n <= 0) return [];
  const when = new Map(used.map((i, k) => [i, k])); // 0 = seen longest ago
  const all = DILEMMAS.map((_, i) => i).filter((i) => !skip.has(i));
  const isVibe = (i) => DILEMMAS[i].vibe === vibe;
  const unseen = shuffle(all.filter((i) => !when.has(i)), random);
  const seen = all.filter((i) => when.has(i)).sort((x, y) => when.get(x) - when.get(y));
  const wantVibe = all.some(isVibe) ? Math.min(n, Math.max(Math.ceil(n / 2), VIBE_SHARE)) : 0;
  const picked = [];
  const take = (list, upTo) => {
    for (const i of list) {
      if (picked.length >= Math.min(n, upTo)) return;
      if (!picked.includes(i)) picked.push(i);
    }
  };
  take(unseen.filter(isVibe), wantVibe);
  take(unseen.filter((i) => !isVibe(i)), n);
  take(unseen, n); // the other vibes ran dry: more from tonight's
  // Everything has been seen at least once: the oldest first, still leaning to tonight's vibe.
  take(seen.filter(isVibe), picked.length + Math.max(0, wantVibe - picked.filter(isVibe).length));
  take(seen, n);
  return shuffle(picked, random);
}

function deal(vibe, spare, used, random) {
  const items = spare.slice(0, ROUNDS);
  const nextSpare = spare.slice(ROUNDS);
  // An AI dilemma can match a bank one; never deal both in one game.
  const aiKeys = new Set(items.map((it) => pairKey(it.a, it.b)));
  const skip = new Set(BANK_KEYS.flatMap((k, i) => (aiKeys.has(k) ? [i] : [])));
  const fromBank = drawBank(ROUNDS - items.length, vibe, used, random, skip);
  for (const i of fromBank) items.push({ a: DILEMMAS[i].a, b: DILEMMAS[i].b });
  const keep = used.filter((i) => !fromBank.includes(i));
  return { items, spare: nextSpare, used: [...keep, ...fromBank].slice(-USED_CAP), ai: spare.length > 0 };
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
    endedAt: 0, // authority time the play finished (stamped on the results as a postmark)
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

const nameOf = (ctx, id) => ctx.names?.[id] || 'Player';

/** "Alex read 7/10, Blair read 9/10" for the rounds of the current play. */
function readLine(s, ctx, st) {
  const [p1, p2] = ctx.players;
  const n = s.rounds.length;
  return `${nameOf(ctx, p1)} read ${st.read[p1]}/${n}, ${nameOf(ctx, p2)} read ${st.read[p2]}/${n}`;
}

/** Up to 4 memorable rounds of the current play for the recap poem: agreements and splits, interleaved. */
function notable(s, ctx, st) {
  const [p1] = ctx.players;
  const agreed = s.rounds
    .map((r, i) => ({ r, it: s.items[i] }))
    .filter(({ r, it }) => r.same && it)
    .slice(0, 3)
    .map(({ r, it }) => `Both picked: ${side(it, r.mine[p1])} over ${side(it, other(r.mine[p1]))}`);
  const split = st.differed.filter((r) => r.item).slice(0, 3).map((r) => `Differed on: ${r.item.a} vs ${r.item.b}`);
  const mixed = [];
  for (let i = 0; i < 3; i++) {
    if (agreed[i]) mixed.push(agreed[i]);
    if (split[i]) mixed.push(split[i]);
  }
  return mixed.slice(0, 4);
}

function finish(s, ctx) {
  const st = stats(s, ctx.players);
  return {
    ...s,
    phase: 'over',
    nextAt: 0,
    done: true,
    endedAt: ctx.now,
    plays: s.plays + 1,
    summary: `${st.compat}% in tune · ${readLine(s, ctx, st)}`,
    highlights: [...s.highlights, ...notable(s, ctx, st)].slice(-6),
  };
}

/**
 * Recap for leaving through ✕ mid-game (the room calls it when the game is closed): running
 * compatibility over the dilemmas revealed so far plus their notable rounds, on top of what
 * earlier plays left. Pure — never touches `s`. A round still being picked doesn't count, so
 * hidden picks stay hidden.
 */
export function summarize(s, ctx) {
  if (!s || !Array.isArray(s.rounds) || !Array.isArray(s.items) || !Array.isArray(ctx?.players) || ctx.players.length < 2) return {};
  const carry = { summary: s.summary || '', highlights: Array.isArray(s.highlights) ? s.highlights : [] };
  if (s.done || !s.rounds.length) return carry; // finished, or nothing new since the last finished play
  const st = stats(s, ctx.players);
  const n = s.rounds.length;
  const summary =
    s.plays > 0 && carry.summary
      ? `${carry.summary} · then ${st.compat}% in tune on ${n} more`
      : `${st.compat}% in tune after ${n} of ${s.items.length} · ${readLine(s, ctx, st)}`;
  return { summary, highlights: [...carry.highlights, ...notable(s, ctx, st)].slice(-6) };
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
