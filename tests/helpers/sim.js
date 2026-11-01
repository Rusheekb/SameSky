// Deterministic simulation helpers for Node unit tests: fake clock/timers, an in-memory network
// with a message queue, and a two-player Session pair wired together.
import { Session } from '../../js/core/session.js';
import { createMemoryHub } from '../../js/net/memory.js';
import { GAMES } from '../../js/games/index.js';
import { seededRandom } from '../../js/lib/util.js';

export class FakeTime {
  constructor(start = 1_700_000_000_000) {
    this.t = start;
    this.seq = 1;
    this.jobs = new Map(); // id -> {at, every, fn}
    this.queue = []; // network deliveries
    const self = this;
    this.timers = {
      setInterval: (fn, ms) => self._add(fn, ms, ms),
      clearInterval: (id) => self.jobs.delete(id),
      setTimeout: (fn, ms) => self._add(fn, ms, 0),
      clearTimeout: (id) => self.jobs.delete(id),
    };
    this.clock = () => this.t;
  }
  _add(fn, ms, every) {
    const id = this.seq++;
    this.jobs.set(id, { at: this.t + Math.max(0, ms), every, fn });
    return id;
  }
  schedule = (fn) => this.queue.push(fn);
  /** Deliver all queued network messages (and anything they enqueue). */
  flush(limit = 10000) {
    let n = 0;
    while (this.queue.length && n++ < limit) this.queue.shift()();
  }
  /** Advance time, firing timers in order and flushing the network after each. */
  advance(ms, step = 50) {
    const end = this.t + ms;
    while (this.t < end) {
      this.t = Math.min(end, this.t + step);
      for (const [id, j] of [...this.jobs]) {
        if (!this.jobs.has(id) || j.at > this.t) continue;
        if (j.every) j.at += j.every;
        else this.jobs.delete(id);
        j.fn();
        this.flush();
      }
      this.flush();
    }
  }
}

export function memoryStorage() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), set: (k, v) => m.set(k, JSON.stringify(v)), map: m };
}

export function makeSession(time, hub, { id, name, creator = false, room = 'TESTROOM', storage, games = GAMES, seed = 7 }) {
  return new Session({
    room,
    me: { id, name, avatar: '🌙', color: '#ff7eb6', tz: 'UTC' },
    transport: hub.transport(id),
    games,
    storage: storage || memoryStorage(),
    creator,
    clock: time.clock,
    random: seededRandom(seed),
    timers: time.timers,
  });
}

/** Two connected players in one room. `a` creates it; `b` joins via link. */
export async function makePair({ games = GAMES, idA = 'aaa', idB = 'bbb' } = {}) {
  const time = new FakeTime();
  const hub = createMemoryHub({ schedule: time.schedule });
  const a = makeSession(time, hub, { id: idA, name: 'Alex', creator: true, games });
  const b = makeSession(time, hub, { id: idB, name: 'Blair', games, seed: 11 });
  await a.start();
  time.flush();
  await b.start();
  time.flush();
  time.advance(3000);
  return { time, hub, a, b };
}

/** Run a game's pure logic directly, without the network. */
export function gameHarness(mod, { players = ['p1', 'p2'], names = { p1: 'Alex', p2: 'Blair' }, seed = 3, start = 1_700_000_000_000, opts = {} } = {}) {
  const random = seededRandom(seed);
  const h = {
    now: start,
    ctx(by = null) {
      return { players, names, by, now: h.now, random, settings: { vibe: 'sweet', ai: false, aboutUs: '' } };
    },
    s: null,
    act(by, a) {
      h.s = mod.reduce(h.s, { ...a, by }, h.ctx(by));
      return h.s;
    },
    tick(ms = 0) {
      h.now += ms;
      if (mod.tick) h.s = mod.tick(h.s, h.ctx(null));
      return h.s;
    },
  };
  h.s = mod.init(h.ctx(players[0]), opts);
  return h;
}
