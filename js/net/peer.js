// Zero-setup transport: WebRTC data channels brokered by the free public PeerJS server
// (0.peerjs.com, which also provides STUN/TURN). Used when Supabase isn't configured.
//
// Each room has two well-known peer ids, slot "a" and slot "b". A client claims "a" if it is
// free, otherwise "b"; the "b" holder dials "a". If "a" vanishes, "b" tries to take over "a"
// so whoever comes back next can find it again.

import { BaseTransport, loadScript } from './transport.js';

const PREFIX = 'samesky-v1-';
const SLOTS = ['a', 'b'];
const STALE_MS = 10000; // no data on a connection for this long -> assume it died

export class PeerTransport extends BaseTransport {
  constructor({ room, Peer = null }) {
    super();
    this.PeerCtor = Peer; // injectable for tests; otherwise the vendored PeerJS is loaded on connect()
    this.kind = 'peer';
    this.label = 'Direct (WebRTC)';
    this.room = room.toLowerCase();
    this.peer = null;
    this.slot = null;
    this.conns = new Map(); // peerId -> {conn, lastData}
    this.closed = false;
    this.timers = new Set();
    this.claimAttempts = 0;
    this.dialing = false;
  }

  async connect() {
    this._setStatus('connecting', 'Finding your partner…');
    if (!this.PeerCtor) {
      await loadScript(new URL('../vendor/peerjs.min.js', import.meta.url).href);
      this.PeerCtor = globalThis.peerjs?.Peer || globalThis.Peer;
    }
    this._claim(0);
    this._every(3000, () => this._watchdog());
  }

  slotId(slot) {
    return `${PREFIX}${this.room}-${slot}`;
  }

  _later(ms, fn) {
    const h = setTimeout(() => {
      this.timers.delete(h);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(h);
  }

  _every(ms, fn) {
    const h = setInterval(() => !this.closed && fn(), ms);
    this.timers.add(h);
  }

  _claim(idx) {
    if (this.closed) return;
    const slot = SLOTS[idx % SLOTS.length];
    const peer = new this.PeerCtor(this.slotId(slot), { debug: 0 });
    let opened = false;

    peer.on('open', () => {
      opened = true;
      this.claimAttempts = 0;
      this.peer = peer;
      this.slot = slot;
      // Registered with the broker = we're reachable. (Session re-sends hello on every 'online'.)
      this._setStatus('online');
      if (slot === 'b') this._dial();
    });

    peer.on('connection', (conn) => this._adopt(conn));

    peer.on('disconnected', () => {
      // Lost the broker (not necessarily the partner). Try to re-register the same id.
      if (!this.conns.size) this._setStatus('offline', 'Reconnecting…');
      if (!this.closed && !peer.destroyed) this._later(1500, () => !peer.destroyed && peer.reconnect());
    });

    peer.on('error', (err) => {
      const type = err?.type;
      if (type === 'unavailable-id' && !opened) {
        peer.destroy();
        this.claimAttempts++;
        // Both slots busy -> back off and retry (a stale tab may still hold one for a bit).
        const next = idx + 1;
        const delay = next % SLOTS.length === 0 ? Math.min(8000, 1000 * this.claimAttempts) : 0;
        if (this.claimAttempts > 4 && next % SLOTS.length === 0) {
          this._setStatus('connecting', 'Room looks busy — retrying…');
        }
        this._later(delay, () => this._claim(next));
        return;
      }
      if (type === 'peer-unavailable') {
        this.dialing = false;
        // We are "b" and nobody holds "a": take over "a" so the partner can find us.
        if (this.slot === 'b' && !this.conns.size) {
          this._later(800 + Math.random() * 800, () => this._promoteToA());
        }
        return;
      }
      if (type === 'browser-incompatible') {
        this._setStatus('error', 'This browser does not support WebRTC.');
        return;
      }
      // network / server-error / socket-error / webrtc: keep trying.
      if (!opened || (peer.disconnected && !this.conns.size)) this._setStatus('offline', 'Connection trouble — retrying…');
      if (!opened) {
        peer.destroy();
        this._later(3000, () => this._claim(idx));
      }
    });
  }

  _promoteToA() {
    if (this.closed || this.slot !== 'b' || this.conns.size) return;
    const old = this.peer;
    this.peer = null;
    this.slot = null;
    old?.destroy();
    this._claim(0);
  }

  _dial() {
    if (this.closed || !this.peer || this.slot !== 'b' || this.conns.size || this.dialing) return;
    this.dialing = true;
    const conn = this.peer.connect(this.slotId('a'), { reliable: true, serialization: 'json' });
    this._adopt(conn);
    // If it doesn't open soon, try again.
    this._later(6000, () => {
      this.dialing = false;
      if (!conn.open) {
        try {
          conn.close();
        } catch {
          /* ignore */
        }
        this.conns.delete(conn.peer);
        this._dial();
      }
    });
  }

  _adopt(conn) {
    const entry = { conn, lastData: Date.now() };
    conn.on('open', () => {
      // Replace any older connection with the same peer.
      const prev = this.conns.get(conn.peer);
      if (prev && prev.conn !== conn) {
        try {
          prev.conn.close();
        } catch {
          /* ignore */
        }
      }
      entry.lastData = Date.now();
      this.dialing = false;
      this.conns.set(conn.peer, entry);
      this._setStatus('online');
    });
    conn.on('data', (data) => {
      entry.lastData = Date.now();
      if (data && typeof data === 'object') this._deliver(data);
    });
    const drop = () => {
      if (this.conns.get(conn.peer)?.conn === conn) this.conns.delete(conn.peer);
      if (!this.conns.size && !this.closed) {
        if (this.peer?.disconnected) this._setStatus('offline', 'Reconnecting…');
        if (this.slot === 'b') this._later(1500, () => this._dial());
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  _watchdog() {
    const t = Date.now();
    for (const [id, e] of this.conns) {
      if (t - e.lastData > STALE_MS) {
        try {
          e.conn.close();
        } catch {
          /* ignore */
        }
        this.conns.delete(id);
      }
    }
    if (!this.conns.size && this.slot === 'b') this._dial();
  }

  send(msg) {
    for (const { conn } of this.conns.values()) {
      if (conn.open) {
        try {
          conn.send(msg);
        } catch {
          /* ignore */
        }
      }
    }
  }

  close() {
    this.closed = true;
    for (const h of this.timers) {
      clearTimeout(h);
      clearInterval(h);
    }
    this.timers.clear();
    for (const { conn } of this.conns.values()) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }
    this.conns.clear();
    this.peer?.destroy();
    this._setStatus('offline');
  }
}
