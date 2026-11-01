// Pure, DOM-free room state + reducer. Only the current "authority" client runs reduce();
// everybody else adopts the authority's broadcast state. See js/core/session.js.

import { cleanText, cleanMultiline } from '../lib/util.js';

export const MAX_PLAYERS = 2;
export const VIBES = ['sweet', 'flirty', 'silly', 'deep'];

export function initialState(room) {
  return {
    v: 0, // version; bumped on every committed change
    by: '', // clientId of the authority that produced this version (tie-breaker)
    sentAt: 0, // authority clock when broadcast (used for clock-offset estimation)
    room,
    players: {}, // clientId -> player
    settings: { vibe: 'sweet', ai: false, aboutUs: '' },
    game: null, // { id, s, startedAt, n }
    scores: { together: 0, games: 0 },
    history: [], // [{ id, title, emoji, summary, points, at }]
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
    color: /^#[0-9a-fA-F]{6}$/.test(p?.color || '') ? p.color : '#ff7eb6',
    tz: cleanText(p?.tz, 64),
  };
}

/** Decide whether an incoming state should replace ours. Total order: higher v wins, tie -> smaller `by`. */
export function isNewer(incoming, local) {
  if (!incoming || typeof incoming.v !== 'number') return false;
  if (!local) return true;
  if (incoming.v !== local.v) return incoming.v > local.v;
  if (incoming.by === local.by) return false;
  return (incoming.by || '') < (local.by || '');
}

/**
 * Core reducer.
 * @param state  current room state
 * @param action { type, by, ... }
 * @param ctx    { now, random, games: Map<id, logicModule>, online: Set<clientId> }
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
        return { ...state, players: { ...state.players, [by]: { ...existing, ...player } } };
      }
      const others = Object.keys(state.players);
      let players = { ...state.players };
      let game = state.game;
      if (others.length >= MAX_PLAYERS) {
        // Room full: replace someone who is offline (e.g. partner switched devices), else refuse.
        const offline = others.find((id) => !ctx.online?.has(id) && id !== ctx.self);
        if (!offline) return state;
        delete players[offline];
        game = null; // role assignments referenced the old id
      }
      players[by] = { ...player, joinedAt: ctx.now };
      return { ...state, players, game };
    }
    case 'profile': {
      if (!isPlayer) return state;
      const player = sanitizePlayer({ ...state.players[by], ...action.player, id: by }, by);
      return { ...state, players: { ...state.players, [by]: { ...state.players[by], ...player } } };
    }
    case 'settings': {
      if (!isPlayer) return state;
      const patch = action.patch || {};
      const settings = { ...state.settings };
      if (VIBES.includes(patch.vibe)) settings.vibe = patch.vibe;
      if (typeof patch.ai === 'boolean') settings.ai = patch.ai;
      if (typeof patch.aboutUs === 'string') settings.aboutUs = cleanMultiline(patch.aboutUs, 500);
      return { ...state, settings };
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
        game: { id: action.id, s, startedAt: ctx.now, n: (state.game?.n || 0) + 1 },
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
      const mod = ctx.games.get(state.game.id);
      const s = state.game.s || {};
      const points = Math.max(0, Math.round(Number(s.points) || 0));
      const entry = {
        id: state.game.id,
        title: mod?.meta.title || state.game.id,
        emoji: mod?.meta.emoji || '🎲',
        summary: cleanText(s.summary || '', 240) || (s.done ? 'Finished' : 'Ended early'),
        highlights: Array.isArray(s.highlights) ? s.highlights.slice(0, 6).map((h) => cleanText(h, 200)) : [],
        points,
        at: ctx.now,
      };
      return {
        ...state,
        game: null,
        scores: { together: state.scores.together + points, games: state.scores.games + 1 },
        history: [...state.history, entry].slice(-40),
      };
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
