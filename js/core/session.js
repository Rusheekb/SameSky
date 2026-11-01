// Real-time room session: keeps two clients' room state in sync over any transport.
//
// Model: one client is the "authority" (the online player with the smallest clientId).
// It runs the pure reducer from state.js and broadcasts the full state after every change.
// Everyone else sends actions to it and adopts whatever state it broadcasts.
// If the authority disappears, the other player takes over with its latest copy; when the
// first one comes back, versions (v, by) decide which copy wins. Ephemeral things that don't
// belong in state (doodle strokes, emoji reactions, typing hints) go through `fx` messages.
//
// Wire messages (every message carries `from`, optional `to`):
//   hello {player, state, reply}  – sent on connect / on seeing a peer; always answered once
//   ping  {now}                   – liveness every PING_MS
//   state {state}                 – authority broadcast
//   action {action}               – non-authority -> authority
//   fx    {kind, data}            – ephemeral event
//   full  {}                      – authority -> newcomer when the room already has 2 people
//   bye   {}                      – best-effort on unload

import { initialState, isNewer, reduce, sanitizePlayer } from './state.js';

export const PING_MS = 2000;
export const OFFLINE_MS = 7000;
const TICK_MS = 250;
const JOIN_RETRY_MS = 2500;

export class Session {
  /**
   * @param {object} o
   * @param {string} o.room
   * @param {object} o.me          player profile {id, name, avatar, color, tz}
   * @param {object} o.transport   see js/net/transport.js
   * @param {Map}    o.games       id -> game logic module
   * @param {object} [o.storage]   {get(key), set(key, value)} for persisting the room state
   * @param {boolean} [o.creator]  true when this device just created the room (self-join at once)
   * @param {function} [o.clock]   () => ms
   * @param {function} [o.random]
   * @param {object} [o.timers]    {setInterval, clearInterval, setTimeout, clearTimeout}
   */
  constructor(o) {
    this.room = o.room;
    this.me = sanitizePlayer(o.me, o.me.id);
    this.id = this.me.id;
    this.transport = o.transport;
    this.games = o.games;
    this.storage = o.storage || null;
    this.creator = !!o.creator;
    this.clock = o.clock || (() => Date.now());
    this.random = o.random || Math.random;
    this.timers = o.timers || globalThis;

    const saved = this.storage?.get(this.storageKey());
    this.state = saved && saved.room === this.room && typeof saved.v === 'number' ? saved : initialState(this.room);
    this.offset = 0; // estimated authority clock - local clock
    this.peers = new Map(); // clientId -> {lastSeen, player}
    this.status = 'connecting';
    this.statusDetail = '';
    this.full = false;
    this.lastJoinAttempt = -Infinity;
    this.heardFromPeer = false;
    this.startedAt = 0;

    this._listeners = new Set();
    this._fxListeners = new Set();
    this._intervals = [];
    this._stopped = false;
  }

  storageKey() {
    return `room:${this.room}`;
  }

  // ---------- lifecycle ----------

  async start() {
    this.startedAt = this.clock();
    this.transport.onMessage((msg) => this._onMessage(msg));
    this.transport.onStatus((status, detail) => {
      this.status = status;
      this.statusDetail = detail || '';
      if (status === 'online') this._sendHello(false);
      this._emit();
    });
    this._intervals.push(this.timers.setInterval(() => this._heartbeat(), PING_MS));
    this._intervals.push(this.timers.setInterval(() => this._tick(), TICK_MS));
    try {
      await this.transport.connect();
    } catch (err) {
      this.status = 'error';
      this.statusDetail = err?.message || String(err);
      this._emit();
    }
    this._maybeJoin();
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    try {
      this._send({ t: 'bye' });
    } catch {
      /* ignore */
    }
    for (const h of this._intervals) this.timers.clearInterval(h);
    this._intervals = [];
    this.transport.close?.();
    this._listeners.clear();
    this._fxListeners.clear();
  }

  // ---------- public API ----------

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Listen to ephemeral events. fn(kind, data, from) */
  onFx(fn) {
    this._fxListeners.add(fn);
    return () => this._fxListeners.delete(fn);
  }

  /** Approximate authority clock (ms). Use for countdowns stored in state. */
  now() {
    return this.clock() + (this.isAuthority() ? 0 : this.offset);
  }

  onlinePeerIds() {
    const t = this.clock();
    return [...this.peers.entries()].filter(([, p]) => t - p.lastSeen < OFFLINE_MS).map(([id]) => id);
  }

  isOnline(id) {
    if (id === this.id) return true;
    const p = this.peers.get(id);
    return !!p && this.clock() - p.lastSeen < OFFLINE_MS;
  }

  authorityId() {
    const online = this.onlinePeerIds().filter((id) => this.state.players[id]);
    if (this.state.players[this.id]) online.push(this.id);
    if (!online.length) return this.id;
    return online.sort()[0];
  }

  isAuthority() {
    return this.authorityId() === this.id;
  }

  partnerId() {
    return Object.keys(this.state.players).find((id) => id !== this.id) || null;
  }

  dispatch(action) {
    if (this._stopped) return;
    const a = { ...action, by: this.id };
    if (this.isAuthority()) {
      this._apply(a);
    } else {
      this._send({ t: 'action', action: a, to: this.authorityId() });
    }
  }

  /** Broadcast an ephemeral event to the partner (not stored in state). */
  sendFx(kind, data) {
    this._send({ t: 'fx', kind, data });
  }

  /** Re-announce ourselves (e.g. when a phone wakes up and its socket has been idle). */
  poke() {
    if (this._stopped) return;
    this._sendHello(false);
    this._emit();
  }

  updateProfile(player) {
    this.me = sanitizePlayer({ ...this.me, ...player, id: this.id }, this.id);
    this.dispatch({ type: 'profile', player: this.me });
  }

  // ---------- internals ----------

  _send(msg) {
    if (this._stopped && msg.t !== 'bye') return;
    try {
      this.transport.send({ ...msg, from: this.id, room: this.room, now: this.clock() });
    } catch (err) {
      console.warn('send failed', err);
    }
  }

  _sendHello(reply) {
    this._send({ t: 'hello', reply, player: this.me, state: this.state });
  }

  _emit() {
    for (const fn of [...this._listeners]) {
      try {
        fn(this);
      } catch (err) {
        console.error(err);
      }
    }
  }

  _ctx() {
    const online = new Set(this.onlinePeerIds());
    online.add(this.id);
    return { now: this.now(), random: this.random, games: this.games, online, self: this.id };
  }

  _apply(action) {
    const next = reduce(this.state, action, this._ctx());
    if (next === this.state) {
      if (action.type === 'join' && !this.state.players[action.by]) {
        this._send({ t: 'full', to: action.by });
      }
      return;
    }
    this._commit(next);
  }

  _commit(next) {
    this.state = { ...next, v: this.state.v + 1, by: this.id, sentAt: this.now() };
    this._persist();
    this._send({ t: 'state', state: this.state });
    this._emit();
  }

  _persist() {
    try {
      this.storage?.set(this.storageKey(), this.state);
    } catch {
      /* storage full / private mode: fine */
    }
  }

  _adopt(incoming) {
    if (!incoming || incoming.room !== this.room || !isNewer(incoming, this.state)) return false;
    if (!looksLikeState(incoming)) return false;
    this.state = incoming;
    this._persist();
    return true;
  }

  _maybeJoin() {
    if (this._stopped || this.full) return;
    const inRoom = !!this.state.players[this.id];
    if (inRoom) {
      // Keep our profile fresh (name/avatar may have changed on this device).
      const p = this.state.players[this.id];
      if (p.name !== this.me.name || p.avatar !== this.me.avatar || p.color !== this.me.color || p.tz !== this.me.tz) {
        if (this.clock() - this.lastJoinAttempt > JOIN_RETRY_MS) {
          this.lastJoinAttempt = this.clock();
          this.dispatch({ type: 'profile', player: this.me });
        }
      }
      return;
    }
    const t = this.clock();
    // A device opening an invite link waits briefly to hear the room's real state before
    // creating its own, so it doesn't race the creator with an empty room.
    const waiting = !this.creator && !this.heardFromPeer && this.state.v === 0 && t - this.startedAt < JOIN_RETRY_MS;
    if (waiting) return;
    if (t - this.lastJoinAttempt < JOIN_RETRY_MS) return;
    this.lastJoinAttempt = t;
    this.dispatch({ type: 'join', player: this.me });
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.from === this.id || this._stopped) return;
    if (msg.room && msg.room !== this.room) return;
    if (msg.to && msg.to !== this.id) {
      // Still counts as a sign of life.
      this._touch(msg.from, msg.player);
      return;
    }
    const wasOnline = this.isOnline(msg.from);
    this._touch(msg.from, msg.player);
    this.heardFromPeer = true;
    let changed = !wasOnline;

    switch (msg.t) {
      case 'hello': {
        changed = this._adopt(msg.state) || changed;
        if (!msg.reply) this._sendHello(true);
        // If we're the authority and our copy is the newer one, make sure they get it.
        if (this.isAuthority() && msg.state && isNewer(this.state, msg.state)) {
          this._send({ t: 'state', state: this.state });
        }
        break;
      }
      case 'ping': {
        if (!wasOnline) this._sendHello(false);
        break;
      }
      case 'state': {
        changed = this._adopt(msg.state) || changed;
        break;
      }
      case 'action': {
        if (!wasOnline) this._sendHello(false);
        if (this.isAuthority() && msg.action && msg.action.by === msg.from) {
          this._apply(msg.action);
        }
        break;
      }
      case 'fx': {
        for (const fn of [...this._fxListeners]) {
          try {
            fn(msg.kind, msg.data, msg.from);
          } catch (err) {
            console.error(err);
          }
        }
        break;
      }
      case 'full': {
        if (!this.state.players[this.id]) {
          this.full = true;
          changed = true;
        }
        break;
      }
      case 'bye': {
        this.peers.delete(msg.from);
        changed = true;
        break;
      }
      default:
        break;
    }
    // Track the authority's clock so countdowns stored in state line up on both screens.
    if (typeof msg.now === 'number' && msg.from === this.authorityId()) {
      this.offset = msg.now - this.clock();
    }
    this._maybeJoin();
    if (changed) this._emit();
  }

  _touch(id, player) {
    const prev = this.peers.get(id);
    this.peers.set(id, { lastSeen: this.clock(), player: player || prev?.player || null });
  }

  _heartbeat() {
    this._send({ t: 'ping', now: this.clock() });
    this._maybeJoin();
    this._emit(); // presence may have timed out
  }

  _tick() {
    if (!this.isAuthority() || !this.state.game) return;
    const mod = this.games.get(this.state.game.id);
    if (!mod?.tick) return;
    this._apply({ type: 'tick', by: this.id });
  }
}

/** Cheap shape check before adopting a state that arrived over the network. */
function looksLikeState(st) {
  if (typeof st !== 'object' || !st.players || typeof st.players !== 'object') return false;
  if (Object.keys(st.players).length > 3) return false;
  if (!Array.isArray(st.history) || !st.scores || !st.settings) return false;
  if (st.game !== null && (typeof st.game !== 'object' || typeof st.game.id !== 'string')) return false;
  try {
    return JSON.stringify(st).length < 512 * 1024;
  } catch {
    return false;
  }
}
