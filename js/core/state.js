// Pure, DOM-free room state + reducer. Only the current "authority" client runs reduce();
// everybody else adopts the authority's broadcast state. See js/core/session.js.

import { cleanText, cleanMultiline } from '../lib/util.js';

export const MAX_PLAYERS = 2;
export const VIBES = ['sweet', 'flirty', 'silly', 'deep'];

export function initialState(room) {
  return {
    term: 0, // bumped whenever a different client takes over as authority (stale copies can't win)
    v: 0, // version; bumped on every committed change
    by: '', // clientId of the authority that produced this version (tie-breaker)
    sentAt: 0, // authority timeline when committed (informational)
    acks: {}, // playerId -> [sessionNonce, lastAppliedSeq] so retried actions apply exactly once
    room,
    players: {}, // clientId -> player
    settings: { vibe: 'sweet', ai: false, aboutUs: '' },
    game: null, // { id, s, startedAt, n }
    gameSeq: 0, // how many games have been started in this room (instance counter)
    scores: { together: 0, games: 0 },
    history: [], // [{ id, title, summary, highlights, points, at, by }] (the recap draws icons via iconFor(id))
  };
}

/** Player ids in a stable order (join time, then id) so games can assign roles deterministically. */
export function playerIds(state) {
  return Object.values(state.players || {})
    .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))
    .map((p) => p.id);
}

export function sanitizePlayer(p, fallbackId) {
  const id = String(p?.id || fallbackId || '').slice(0, 40);
  return {
    id,
    name: cleanText(p?.name, 24) || 'Player',
    avatar: cleanText(p?.avatar, 8) || '🌙',
    color: /^#[0-9a-fA-F]{6}$/.test(p?.color || '') ? p.color : '#f2b35c',
    tz: cleanText(p?.tz, 64),
  };
}

/**
 * Decide whether an incoming state should replace ours. Total order both clients agree on:
 * higher term wins (a newer authority's copy beats any stale one), then higher v, then smaller `by`.
 */
export function isNewer(incoming, local) {
  if (!incoming || typeof incoming.v !== 'number') return false;
  if (!local) return true;
  const ti = incoming.term || 0;
  const tl = local.term || 0;
  if (ti !== tl) return ti > tl;
  if (incoming.v !== local.v) return incoming.v > local.v;
  if (incoming.by === local.by) return false;
  return (incoming.by || '') < (local.by || '');
}

const samePlayer = (a, b) => a.name === b.name && a.avatar === b.avatar && a.color === b.color && a.tz === b.tz;

/**
 * Core reducer.
 * @param state  current room state
 * @param action { type, by, ... }
 * @param ctx    { now, random, games: Map<id, logicModule>, gone: Set<clientId> (players absent long
 *                enough that a new device may take their seat), self }
 * @returns new state (or the same object when nothing changed)
 */
export function reduce(state, action, ctx) {
  const by = action.by;
  const isPlayer = !!state.players[by];
  switch (action.type) {
    case 'join': {
      const player = sanitizePlayer(action.player, by);
      if (player.id !== by) return state;
      const existing = state.players[by];
      if (existing) {
        if (samePlayer(existing, player)) return state;
        return { ...state, players: { ...state.players, [by]: { ...existing, ...player } } };
      }
      const others = Object.keys(state.players);
      let base = state;
      if (others.length >= MAX_PLAYERS) {
        // Room full: a new device may only take the seat of someone who has been gone a long time
        // (e.g. the partner switched phones). A running game is recorded first, never just wiped.
        const gone = others.find((id) => ctx.gone?.has(id) && id !== ctx.self);
        if (!gone) return state;
        base = finishGame(state, ctx, null);
        const players = { ...base.players };
        delete players[gone];
        const acks = { ...(base.acks || {}) };
        delete acks[gone];
        base = { ...base, players, acks };
      }
      return { ...base, players: { ...base.players, [by]: { ...player, joinedAt: ctx.now } } };
    }
    case 'profile': {
      if (!isPlayer) return state;
      const player = sanitizePlayer({ ...state.players[by], ...action.player, id: by }, by);
      if (samePlayer(state.players[by], player)) return state;
      return { ...state, players: { ...state.players, [by]: { ...state.players[by], ...player } } };
    }
    case 'settings': {
      if (!isPlayer) return state;
      const patch = action.patch || {};
      const settings = { ...state.settings };
      if (VIBES.includes(patch.vibe)) settings.vibe = patch.vibe;
      if (typeof patch.ai === 'boolean') settings.ai = patch.ai;
      if (typeof patch.aboutUs === 'string') settings.aboutUs = cleanMultiline(patch.aboutUs, 500);
      const same = settings.vibe === state.settings.vibe && settings.ai === state.settings.ai && settings.aboutUs === state.settings.aboutUs;
      return same ? state : { ...state, settings };
    }
    case 'startGame': {
      // One game at a time: finish (or leave) the current one first. Also absorbs double-taps.
      if (!isPlayer || state.game) return state;
      const mod = ctx.games.get(action.id);
      if (!mod) return state;
      const ids = playerIds(state);
      if (ids.length < (mod.meta.minPlayers ?? 2)) return state;
      const gctx = gameCtx(state, ctx, by);
      let s;
      try {
        s = mod.init(gctx, action.opts || {});
      } catch (err) {
        console.error(`[${action.id}] init failed`, err);
        return state;
      }
      return {
        ...state,
        // `n` numbers game instances for the whole room so per-game fx channels never collide.
        game: { id: action.id, s, startedAt: ctx.now, n: (state.gameSeq || 0) + 1 },
        gameSeq: (state.gameSeq || 0) + 1,
      };
    }
    case 'game': {
      if (!isPlayer || !state.game) return state;
      const mod = ctx.games.get(state.game.id);
      if (!mod) return state;
      const a = { ...(action.a || {}), by };
      let s;
      try {
        s = mod.reduce(state.game.s, a, gameCtx(state, ctx, by));
      } catch (err) {
        console.error(`[${state.game.id}] reduce failed`, a, err);
        return state;
      }
      if (s === state.game.s || s == null) return state;
      return { ...state, game: { ...state.game, s } };
    }
    case 'tick': {
      if (!state.game) return state;
      const mod = ctx.games.get(state.game.id);
      if (!mod?.tick) return state;
      let s;
      try {
        s = mod.tick(state.game.s, gameCtx(state, ctx, null));
      } catch (err) {
        console.error(`[${state.game.id}] tick failed`, err);
        return state;
      }
      if (s === state.game.s || s == null) return state;
      return { ...state, game: { ...state.game, s } };
    }
    case 'endGame': {
      if (!isPlayer || !state.game) return state;
      return finishGame(state, ctx, by);
    }
    case 'clearHistory': {
      if (!isPlayer) return state;
      return { ...state, history: [], scores: { together: 0, games: 0 } };
    }
    default:
      return state;
  }
}

/** The context handed to game modules. Keep it small and serialisable-ish. */
export function gameCtx(state, ctx, by) {
  const ids = playerIds(state);
  return {
    players: ids,
    names: Object.fromEntries(ids.map((id) => [id, state.players[id].name])),
    by,
    now: ctx.now,
    random: ctx.random,
    settings: state.settings,
  };
}

/**
 * Close the current game and record it in the night's history. Games may export
 * `summarize(s, ctx) -> { summary?, highlights? }` so that leaving mid-game (✕) still keeps a
 * meaningful line for the recap; otherwise `s.summary` / `s.highlights` are used.
 */
export function finishGame(state, ctx, by = null) {
  if (!state.game) return state;
  const mod = ctx.games.get(state.game.id);
  const s = state.game.s || {};
  let sum = {};
  if (mod?.summarize) {
    try {
      sum = mod.summarize(s, gameCtx(state, ctx, by)) || {};
    } catch (err) {
      console.error(`[${state.game.id}] summarize failed`, err);
    }
  }
  const summary = cleanText(sum.summary || s.summary || '', 240) || (s.done ? 'Finished' : 'Ended early');
  const raw = Array.isArray(sum.highlights) ? sum.highlights : Array.isArray(s.highlights) ? s.highlights : [];
  const points = Math.max(0, Math.min(1000, Math.round(Number(s.points) || 0)));
  const entry = {
    id: state.game.id,
    title: mod?.meta.title || state.game.id,
    summary,
    highlights: raw.slice(0, 6).map((h) => cleanText(h, 200)).filter(Boolean),
    points,
    at: ctx.now,
    by: by || '',
  };
  return {
    ...state,
    game: null,
    scores: { together: state.scores.together + points, games: state.scores.games + 1 },
    history: [...state.history, entry].slice(-40),
  };
}

/**
 * Validate and clean a room state that arrived over the network before adopting it, so a buggy
 * or hostile peer can't inject CSS through a player colour, crash the UI with a malformed history
 * entry, or flood us with a giant payload. Returns a cleaned copy, or null to reject it.
 */
export function sanitizeIncomingState(st, room) {
  if (!st || typeof st !== 'object' || st.room !== room || typeof st.v !== 'number') return null;
  let size = 0;
  try {
    size = JSON.stringify(st).length;
  } catch {
    return null;
  }
  if (size > 512 * 1024) return null;
  if (!st.players || typeof st.players !== 'object' || Array.isArray(st.players)) return null;
  const ids = Object.keys(st.players);
  if (ids.length > MAX_PLAYERS + 1) return null;
  const players = {};
  for (const id of ids) {
    const raw = st.players[id];
    if (!raw || typeof raw !== 'object') return null;
    const p = sanitizePlayer({ ...raw, id }, id);
    players[id] = { ...p, joinedAt: Number.isFinite(raw.joinedAt) ? raw.joinedAt : 0 };
  }
  const settings = {
    vibe: VIBES.includes(st.settings?.vibe) ? st.settings.vibe : 'sweet',
    ai: st.settings?.ai === true,
    aboutUs: typeof st.settings?.aboutUs === 'string' ? cleanMultiline(st.settings.aboutUs, 500) : '',
  };
  const num = (x) => (Number.isFinite(x) ? x : 0);
  const str = (x, max) => (typeof x === 'string' ? cleanText(x, max) : '');
  const history = (Array.isArray(st.history) ? st.history : [])
    .filter((h) => h && typeof h === 'object')
    .slice(-40)
    .map((h) => ({
      id: str(h.id, 40),
      title: str(h.title, 60) || 'Game',
      summary: str(h.summary, 240),
      highlights: Array.isArray(h.highlights) ? h.highlights.filter((x) => typeof x === 'string').slice(0, 6).map((x) => cleanText(x, 200)) : [],
      points: Math.max(0, Math.min(1000, Math.round(num(h.points)))),
      at: num(h.at),
      by: str(h.by, 40),
    }));
  let game = null;
  if (st.game != null) {
    const g = st.game;
    if (typeof g !== 'object' || typeof g.id !== 'string' || !g.s || typeof g.s !== 'object') return null;
    game = { id: g.id.slice(0, 40), s: g.s, startedAt: num(g.startedAt), n: num(g.n) };
  }
  const acks = {};
  if (st.acks && typeof st.acks === 'object') {
    for (const [id, a] of Object.entries(st.acks)) {
      if (Array.isArray(a) && typeof a[0] === 'string' && Number.isFinite(a[1])) acks[id] = [a[0].slice(0, 20), a[1]];
    }
  }
  return {
    term: num(st.term),
    v: st.v,
    by: str(st.by, 40),
    sentAt: num(st.sentAt),
    acks,
    room,
    players,
    settings,
    game,
    gameSeq: num(st.gameSeq),
    scores: { together: Math.max(0, Math.round(num(st.scores?.together))), games: Math.max(0, Math.round(num(st.scores?.games))) },
    history,
  };
}
