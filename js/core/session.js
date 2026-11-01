// Real-time room session: keeps two clients' room state in sync over any transport.
//
// Model: one client is the "authority" (the online player with the smallest clientId). It runs
// the pure reducer from state.js and broadcasts the full state after every change. Everyone else
// sends actions to it and adopts whatever state it broadcasts.
//
// Robustness rules (each one fixes a real failure mode):
// * Sync gate: a client that starts with a saved state, wakes from the background or reconnects
//   does not lead (commit or tick) until it has heard its partner or GRACE_MS has passed alone.
//   Local actions meanwhile are queued, so a stale copy can never overwrite the partner's moves.
// * Terms: whenever a different client takes over as authority it bumps `state.term`; (term, v, by)
//   orders states, so an old authority's copy can't beat its successor's even with a higher v.
// * Exactly-once actions: actions carry (nonce, seq) and are re-sent until the authority's state
//   acknowledges them (state.acks), so a dropped message or an authority hand-over loses nothing.
// * Anti-entropy: pings carry the sender's state version; whoever is behind gets the state again.
// * One timeline: now() always includes the learned offset to the authority's clock, and the
//   offset is frozen when taking over, so countdowns don't jump when phones' clocks disagree.
// * Network input is sanitised (sanitizeIncomingState) before it is adopted.
//
// Wire messages (all carry from, room, now = sender's room timeline):
//   hello {player, state, reply} – on connect / on seeing a peer; always answered once
//   ping  {term, v, by}          – liveness + version every PING_MS
//   state {state}                – authority broadcast (or repair)
//   need  {}                     – "I'm behind, send me the state"
//   action {action}              – follower -> authority
//   fx    {kind, data}           – ephemeral event (strokes, reactions…), never stored
//   full  {}                     – authority -> newcomer when both seats are taken
//   bye   {}                     – best-effort on unload

import { initialState, isNewer, reduce, sanitizePlayer, sanitizeIncomingState } from './state.js';
import { uid } from '../lib/util.js';

export const PING_MS = 2000;
export const OFFLINE_MS = 7000;
export const GRACE_MS = 3000;
export const SEAT_TAKEOVER_MS = 90000;
const TICK_MS = 250;
const JOIN_RETRY_MS = 2500;
const RESEND_MS = 1500;
const FULL_RETRY_MS = 15000;
const PENDING_TTL_MS = 30000;
const MAX_PENDING = 50;
const RAW_ACTIONS = new Set(['join', 'profile']); // self-healing via _maybeJoin, not queued

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

    let saved = null;
    try {
      saved = sanitizeIncomingState(this.storage?.get(this.storageKey()), this.room);
    } catch {
      saved = null;
    }
    // A saved game whose module no longer exists (older version of the site) is dropped.
    if (saved?.game && !this.games.get(saved.game.id)) saved = { ...saved, game: null };
    this.state = saved || initialState(this.room);

    this.offset = 0; // room timeline - local clock
    this.peers = new Map(); // clientId -> {lastSeen, player}
    this.status = 'connecting';
    this.statusDetail = '';
    this.full = false;
    this.lastJoinAttempt = -Infinity;
    this.heardFromPeer = false;
    this.startedAt = 0;

    // Sync gate: a fresh room has nothing stale to protect; a restored one must catch up first.
    this.synced = this.state.v === 0;
    this.unsyncedAt = 0;

    // Exactly-once action delivery.
    this.nonce = uid(6, this.random);
    this.seq = 0;
    this.pending = []; // [{a, sentAt, createdAt}]
    this.lastRole = null;
    this.lastRepair = new Map(); // peerId -> time we last pushed/requested a repair

    this.lastBeat = 0;
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
    this.unsyncedAt = this.startedAt;
    this.lastBeat = this.startedAt;
    this.transport.onMessage((msg) => this._onMessage(msg));
    this.transport.onStatus((status, detail) => {
      const was = this.status;
      this.status = status;
      this.statusDetail = detail || '';
      if (status === 'online') {
        // Reconnected after a drop: we may have missed changes, so catch up before leading.
        if (was === 'offline' || was === 'error') this._unsync();
        this._sendHello(false);
      }
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
    try {
      this._send({ t: 'bye' });
    } catch {
      /* ignore */
    }
    this._stopped = true;
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

  /** The room timeline (ms): the authority's clock, continued across hand-overs. Use for countdowns. */
  now() {
    return this.clock() + this.offset;
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

  /** Who should lead right now (ignores the sync gate). */
  authorityId() {
    const online = this.onlinePeerIds().filter((id) => this.state.players[id]);
    if (this.state.players[this.id]) online.push(this.id);
    if (!online.length) return this.id;
    return online.sort()[0];
  }

  /** True when this client may commit state (it is the authority AND has caught up). */
  isAuthority() {
    return this.synced && this.authorityId() === this.id;
  }

  partnerId() {
    return Object.keys(this.state.players).find((id) => id !== this.id) || null;
  }

  dispatch(action) {
    if (this._stopped) return;
    if (RAW_ACTIONS.has(action.type)) {
      this._raw({ ...action, by: this.id });
      return;
    }
    const role = this.authorityId() === this.id ? 'lead' : 'follow';
    if (role !== this.lastRole) {
      // New role -> new nonce, so sequence numbers never straddle two authorities' bookkeeping.
      this.lastRole = role;
      this.nonce = uid(6, this.random);
      this.seq = 0;
    }
    const a = { ...action, by: this.id, n: this.nonce, q: ++this.seq };
    this.pending.push({ a, sentAt: 0, createdAt: this.clock() });
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    this._flush();
  }

  /** Broadcast an ephemeral event to the partner (not stored in state). */
  sendFx(kind, data) {
    this._send({ t: 'fx', kind, data });
  }

  updateProfile(player) {
    this.me = sanitizePlayer({ ...this.me, ...player, id: this.id }, this.id);
    if (this.state.players[this.id]) this.dispatch({ type: 'profile', player: this.me });
  }

  /** Re-announce ourselves (e.g. when a phone wakes up and its socket has been idle). */
  poke() {
    if (this._stopped) return;
    this._unsync();
    this._sendHello(false);
    this._emit();
  }

  /** Number of local actions not yet confirmed by the authority (for "sending…" hints). */
  pendingCount() {
    return this.pending.length;
  }

  // ---------- internals ----------

  _send(msg) {
    if (this._stopped) return;
    try {
      this.transport.send({ ...msg, from: this.id, room: this.room, now: this.now() });
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

  _unsync() {
    if (this.state.v === 0) return; // nothing stale to protect
    this.synced = false;
    this.unsyncedAt = this.clock();
  }

  _markSynced() {
    if (this.synced) return;
    this.synced = true;
    this._flush();
    this._maybeJoin();
  }

  _ctx() {
    const t = this.clock();
    const gone = new Set();
    for (const id of Object.keys(this.state.players)) {
      if (id === this.id) continue;
      const seen = this.peers.get(id)?.lastSeen ?? this.startedAt;
      if (t - Math.max(seen, this.startedAt) > SEAT_TAKEOVER_MS) gone.add(id);
    }
    return { now: this.now(), random: this.random, games: this.games, gone, self: this.id };
  }

  /** Raw (un-queued) action: join/profile. Applied if we lead, else sent to the authority. */
  _raw(a) {
    if (this.isAuthority()) this._apply(a);
    else if (this.authorityId() !== this.id) this._send({ t: 'action', action: a, to: this.authorityId() });
  }

  /** Deliver queued actions: apply them if we lead, otherwise (re)send them to the authority. */
  _flush() {
    if (!this.pending.length || this._stopped) return;
    const t = this.clock();
    this.pending = this.pending.filter((p) => t - p.createdAt < PENDING_TTL_MS);
    if (this.isAuthority()) {
      const queue = this.pending;
      this.pending = [];
      for (const p of queue) this._apply(p.a);
      return;
    }
    const target = this.authorityId();
    if (target === this.id) return; // we'll lead once synced; keep them queued
    for (const p of this.pending) {
      if (t - p.sentAt >= RESEND_MS) {
        p.sentAt = t;
        this._send({ t: 'action', action: p.a, to: target });
      }
    }
  }

  /** Authority-side: apply an action exactly once and commit. */
  _apply(action) {
    const by = action.by;
    const base = this.state;
    if (action.n) {
      const ack = base.acks?.[by];
      if (ack && ack[0] === action.n) {
        if (action.q <= ack[1]) return; // duplicate (already applied)
        if (action.q > ack[1] + 1 && by !== this.id) return; // gap: wait for the earlier one's resend
      } else if (action.q !== 1 && by !== this.id) {
        return; // first message of a new nonce must be #1; the rest will be re-sent in order
      }
    }
    const next = reduce(base, action, this._ctx());
    if (next === base) {
      if (action.type === 'join' && !base.players[by]) this._send({ t: 'full', to: by });
      // A remote player's no-op still needs an ack so they stop re-sending it.
      if (!(action.n && by !== this.id && base.players[by])) return;
    }
    let out = next;
    if (action.n && out.players[by]) out = { ...out, acks: { ...(out.acks || {}), [by]: [action.n, action.q] } };
    this._commit(out);
  }

  _commit(next) {
    const prev = this.state;
    const takeover = !!prev.by && prev.by !== this.id;
    this.state = {
      ...next,
      term: (prev.term || 0) + (takeover ? 1 : 0),
      v: prev.v + 1,
      by: this.id,
      sentAt: this.now(),
    };
    this._persist();
    this._send({ t: 'state', state: this.state });
    this._prunePending();
    this._emit();
  }

  _persist() {
    try {
      this.storage?.set(this.storageKey(), this.state);
    } catch {
      /* storage full / private mode: fine */
    }
  }

  _prunePending() {
    const ack = this.state.acks?.[this.id];
    if (!ack || !this.pending.length) return;
    this.pending = this.pending.filter((p) => !(p.a.n === ack[0] && p.a.q <= ack[1]));
  }

  _adopt(incoming) {
    if (!incoming || incoming.room !== this.room || !isNewer(incoming, this.state)) return false;
    const clean = sanitizeIncomingState(incoming, this.room);
    if (!clean) return false;
    if (clean.game && !this.games.get(clean.game.id)) return false;
    this.state = clean;
    this._persist();
    this._prunePending();
    return true;
  }

  _maybeJoin() {
    if (this._stopped || !this.synced) return;
    const inRoom = !!this.state.players[this.id];
    const t = this.clock();
    if (inRoom) this.full = false;
    // Room full: keep asking now and then — a seat frees up if the other device stays away long.
    if (this.full && t - this.lastJoinAttempt < FULL_RETRY_MS) return;
    if (inRoom) {
      // Keep our profile fresh (name/avatar may have changed on this device).
      const p = this.state.players[this.id];
      if (p.name !== this.me.name || p.avatar !== this.me.avatar || p.color !== this.me.color || p.tz !== this.me.tz) {
        if (t - this.lastJoinAttempt > JOIN_RETRY_MS) {
          this.lastJoinAttempt = t;
          this._raw({ type: 'profile', player: this.me, by: this.id });
        }
      }
      return;
    }
    // A device opening an invite link waits briefly to hear the room's real state before
    // creating its own, so it doesn't race the creator with an empty room.
    const waiting = !this.creator && !this.heardFromPeer && this.state.v === 0 && t - this.startedAt < JOIN_RETRY_MS;
    if (waiting) return;
    if (t - this.lastJoinAttempt < JOIN_RETRY_MS) return;
    this.lastJoinAttempt = t;
    this._raw({ type: 'join', player: this.me, by: this.id });
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.from !== 'string' || msg.from === this.id || this._stopped) return;
    if (msg.room && msg.room !== this.room) return;
    const wasOnline = this.isOnline(msg.from);
    const wasAuthority = this.authorityId();
    this._touch(msg.from, msg.player);
    this.heardFromPeer = true;
    if (msg.to && msg.to !== this.id) return; // addressed to someone else; still counted as alive

    let changed = !wasOnline;
    switch (msg.t) {
      case 'hello': {
        changed = this._adopt(msg.state) || changed;
        if (!msg.reply) this._sendHello(true);
        // If our copy is the newer one, make sure they get it (they'll adopt by term/v).
        if (msg.state && isNewer(this.state, msg.state)) this._send({ t: 'state', state: this.state, to: msg.from });
        // Having exchanged versions with a partner, we're caught up.
        if (!this.synced) {
          this._markSynced();
          changed = true;
        }
        break;
      }
      case 'ping': {
        if (!wasOnline) this._sendHello(false);
        changed = this._repair(msg) || changed;
        break;
      }
      case 'state': {
        changed = this._adopt(msg.state) || changed;
        // We now hold a copy at least as new as theirs: caught up.
        if (!this.synced) {
          this._markSynced();
          changed = true;
        }
        break;
      }
      case 'need': {
        if (this.synced) this._send({ t: 'state', state: this.state, to: msg.from });
        break;
      }
      case 'action': {
        if (!wasOnline) this._sendHello(false);
        const a = msg.action;
        if (a && typeof a === 'object' && a.by === msg.from && typeof a.type === 'string') {
          if (this.isAuthority()) this._apply(a);
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
    // Follow the authority's timeline so countdowns line up on both screens. When we lead, the
    // offset stays frozen at its last value, which keeps the room timeline continuous.
    if (typeof msg.now === 'number' && msg.from === this.authorityId() && msg.from !== this.id) {
      this.offset = msg.now - this.clock();
    }
    if (this.authorityId() !== wasAuthority) {
      // Authority changed: deliver anything still queued to the new one right away.
      for (const p of this.pending) p.sentAt = 0;
      changed = true;
    }
    this._flush();
    this._maybeJoin();
    if (changed) this._emit();
  }

  /**
   * Anti-entropy: compare the version carried by a ping with ours and push/request the state.
   * Also completes the sync gate when the partner turns out not to be ahead of us.
   * @returns true if our sync status changed
   */
  _repair(msg) {
    if (typeof msg.v !== 'number') return false;
    const theirs = { term: msg.term || 0, v: msg.v, by: msg.by || '' };
    const theyAreAhead = isNewer(theirs, this.state);
    let changed = false;
    if (!this.synced && !theyAreAhead) {
      this._markSynced();
      changed = true;
    }
    const t = this.clock();
    if (t - (this.lastRepair.get(msg.from) || 0) < PING_MS - 200) return changed;
    if (theyAreAhead) {
      this.lastRepair.set(msg.from, t);
      this._send({ t: 'need', to: msg.from });
    } else if (this.synced && isNewer(this.state, theirs)) {
      // They're behind (a broadcast got lost): send our copy.
      this.lastRepair.set(msg.from, t);
      this._send({ t: 'state', state: this.state, to: msg.from });
    }
    return changed;
  }

  _touch(id, player) {
    const prev = this.peers.get(id);
    this.peers.set(id, { lastSeen: this.clock(), player: player || prev?.player || null });
  }

  _heartbeat() {
    const t = this.clock();
    // A big gap between beats means the page was suspended (phone locked / tab in background):
    // our view of the room may be stale, so catch up before leading again.
    if (t - this.lastBeat > PING_MS * 2 + 1500) this._unsync();
    this.lastBeat = t;
    if (!this.synced && t - this.unsyncedAt >= GRACE_MS) {
      if (!this.onlinePeerIds().length) this._markSynced(); // nobody around: carry on with our copy
      else this._sendHello(false); // partner is there but we haven't compared versions yet
    }
    this._send({ t: 'ping', term: this.state.term || 0, v: this.state.v, by: this.state.by });
    this._flush();
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
