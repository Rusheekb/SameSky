// In-memory transport hub for unit tests (Node). Messages are delivered asynchronously
// via the hub's scheduler, can be partitioned to simulate one player dropping off, and are
// JSON round-tripped so tests catch anything that wouldn't survive a real network.

import { BaseTransport } from './transport.js';

export function createMemoryHub({ schedule = (fn) => setTimeout(fn, 0) } = {}) {
  const nodes = new Set();
  const hub = {
    partitioned: new Set(),
    transport(id) {
      const t = new MemoryTransport(hub, id);
      nodes.add(t);
      return t;
    },
    // Optional (fromId, msg) => false to drop a message (simulates a lossy network).
    filter: null,
    deliver(fromT, msg) {
      if (hub.partitioned.has(fromT.id)) return;
      if (hub.filter && hub.filter(fromT.id, msg) === false) return;
      const wire = JSON.stringify(msg);
      for (const t of nodes) {
        if (t === fromT || !t.open || hub.partitioned.has(t.id)) continue;
        schedule(() => t.open && t._deliver(JSON.parse(wire)));
      }
    },
    remove(t) {
      nodes.delete(t);
    },
  };
  return hub;
}

class MemoryTransport extends BaseTransport {
  constructor(hub, id) {
    super();
    this.kind = 'memory';
    this.label = 'Memory';
    this.hub = hub;
    this.id = id;
    this.open = false;
  }
  async connect() {
    this.open = true;
    this._setStatus('online');
  }
  send(msg) {
    if (this.open) this.hub.deliver(this, msg);
  }
  close() {
    this.open = false;
    this.hub.remove(this);
    this._setStatus('offline');
  }
}
