// Exercises the PeerJS slot logic (claim a/b, dial, reconnect, take-over) against a fake broker.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PeerTransport } from '../../js/net/peer.js';

class Emitter {
  constructor() {
    this.h = {};
  }
  on(ev, fn) {
    (this.h[ev] ||= []).push(fn);
    return this;
  }
  emit(ev, ...a) {
    for (const fn of this.h[ev] || []) fn(...a);
  }
}

function fakePeerJs() {
  const ids = new Map();
  class FakeConn extends Emitter {
    constructor(owner, peer) {
      super();
      this.owner = owner;
      this.peer = peer;
      this.open = false;
      this.closed = false;
      owner.conns.add(this);
    }
    send(d) {
      if (!this.open) return;
      const wire = JSON.stringify(d);
      setTimeout(() => this.remote && !this.remote.closed && this.remote.emit('data', JSON.parse(wire)), 0);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.open = false;
      this.owner.conns.delete(this);
      this.emit('close');
      this.remote?.close();
    }
  }
  class FakePeer extends Emitter {
    constructor(id) {
      super();
      this.id = id;
      this.conns = new Set();
      this.destroyed = false;
      this.disconnected = false;
      setTimeout(() => {
        if (this.destroyed) return;
        if (ids.has(id)) this.emit('error', { type: 'unavailable-id' });
        else {
          ids.set(id, this);
          this.emit('open', id);
        }
      }, 0);
    }
    connect(target) {
      const conn = new FakeConn(this, target);
      setTimeout(() => {
        const t = ids.get(target);
        if (!t || t.destroyed) {
          this.emit('error', { type: 'peer-unavailable' });
          return;
        }
        const remote = new FakeConn(t, this.id);
        conn.remote = remote;
        remote.remote = conn;
        t.emit('connection', remote);
        setTimeout(() => {
          conn.open = remote.open = true;
          remote.emit('open');
          conn.emit('open');
        }, 0);
      }, 0);
      return conn;
    }
    destroy() {
      this.destroyed = true;
      if (ids.get(this.id) === this) ids.delete(this.id);
      for (const c of [...this.conns]) c.close();
    }
    reconnect() {}
  }
  return { FakePeer, ids };
}

function collect(t) {
  const got = [];
  t.onMessage((m) => got.push(m));
  return got;
}

test('two peers find each other, survive a refresh, and the survivor takes over slot "a"', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { FakePeer, ids } = fakePeerJs();
    const tick = async (ms) => {
      for (let i = 0; i < ms; i += 50) {
        mock.timers.tick(50);
        await Promise.resolve();
      }
    };
    const A = new PeerTransport({ room: 'ROOM1', Peer: FakePeer });
    const B = new PeerTransport({ room: 'ROOM1', Peer: FakePeer });
    const gotA = collect(A);
    const gotB = collect(B);
    await A.connect();
    await tick(100);
    await B.connect();
    await tick(500);
    assert.equal(A.slot, 'a');
    assert.equal(B.slot, 'b');
    assert.equal(A.status, 'online');
    A.send({ t: 'hi', from: 'A' });
    B.send({ t: 'yo', from: 'B' });
    await tick(100);
    assert.deepEqual(gotB.map((m) => m.t), ['hi']);
    assert.deepEqual(gotA.map((m) => m.t), ['yo']);

    // A refreshes: old transport closes, a new one claims "a" again and B redials it.
    A.close();
    const A2 = new PeerTransport({ room: 'ROOM1', Peer: FakePeer });
    const gotA2 = collect(A2);
    await A2.connect();
    await tick(4000);
    assert.equal(A2.slot, 'a');
    B.send({ t: 'again', from: 'B' });
    await tick(100);
    assert.deepEqual(gotA2.map((m) => m.t), ['again']);

    // A leaves for good: B notices nobody holds "a" and takes it over so A can find B later.
    A2.close();
    await tick(12000);
    assert.equal(B.slot, 'a');
    assert.ok(ids.has('samesky-v1-room1-a'));
    const A3 = new PeerTransport({ room: 'ROOM1', Peer: FakePeer });
    const gotA3 = collect(A3);
    await A3.connect();
    await tick(3000);
    assert.equal(A3.slot, 'b');
    B.send({ t: 'welcome back', from: 'B' });
    await tick(100);
    assert.deepEqual(gotA3.map((m) => m.t), ['welcome back']);
    B.close();
    A3.close();
  } finally {
    mock.timers.reset();
  }
});

test('a third tab finds both slots busy and keeps retrying without crashing', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { FakePeer } = fakePeerJs();
    const tick = async (ms) => {
      for (let i = 0; i < ms; i += 50) {
        mock.timers.tick(50);
        await Promise.resolve();
      }
    };
    const A = new PeerTransport({ room: 'R', Peer: FakePeer });
    const B = new PeerTransport({ room: 'R', Peer: FakePeer });
    const C = new PeerTransport({ room: 'R', Peer: FakePeer });
    await A.connect();
    await tick(100);
    await B.connect();
    await tick(500);
    await C.connect();
    await tick(20000);
    assert.equal(C.slot, null);
    assert.notEqual(C.status, 'online');
    // When B leaves, C gets the seat.
    B.close();
    await tick(20000);
    assert.equal(C.slot, 'b');
    A.close();
    C.close();
  } finally {
    mock.timers.reset();
  }
});
