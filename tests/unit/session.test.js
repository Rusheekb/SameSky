import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePair, makeSession, FakeTime, memoryStorage } from '../helpers/sim.js';
import { createMemoryHub } from '../../js/net/memory.js';
import { isNewer, initialState, reduce, playerIds } from '../../js/core/state.js';
import { GAMES } from '../../js/games/index.js';

test('two players converge on one room with both of them in it', async () => {
  const { a, b } = await makePair();
  assert.deepEqual(Object.keys(a.state.players).sort(), ['aaa', 'bbb']);
  assert.deepEqual(a.state, b.state);
  assert.equal(a.authorityId(), 'aaa');
  assert.equal(b.authorityId(), 'aaa');
  assert.ok(a.isOnline('bbb') && b.isOnline('aaa'));
  assert.equal(a.partnerId(), 'bbb');
  assert.equal(b.partnerId(), 'aaa');
});

test('actions from the non-authority are applied by the authority and mirrored', async () => {
  const { a, b, time } = await makePair();
  b.dispatch({ type: 'settings', patch: { vibe: 'flirty' } });
  time.flush();
  assert.equal(a.state.settings.vibe, 'flirty');
  assert.equal(b.state.settings.vibe, 'flirty');
  b.dispatch({ type: 'startGame', id: 'insync' });
  time.flush();
  assert.equal(a.state.game.id, 'insync');
  assert.deepEqual(a.state, b.state);
});

test('a full game of In Sync over the network', async () => {
  const { a, b, time } = await makePair();
  a.dispatch({ type: 'startGame', id: 'insync' });
  time.flush();
  b.dispatch({ type: 'game', a: { type: 'submit', word: 'Beach' } });
  a.dispatch({ type: 'game', a: { type: 'submit', word: 'Cafe' } });
  time.flush();
  assert.equal(a.state.game.s.phase, 'reveal');
  b.dispatch({ type: 'game', a: { type: 'next' } });
  time.flush();
  assert.equal(b.state.game.s.phase, 'pick');
  a.dispatch({ type: 'game', a: { type: 'submit', word: 'Latte' } });
  b.dispatch({ type: 'game', a: { type: 'submit', word: 'lattes' } });
  time.flush();
  assert.equal(b.state.game.s.phase, 'synced');
  assert.equal(b.state.game.s.points, 9);
  b.dispatch({ type: 'endGame' });
  time.flush();
  assert.equal(a.state.game, null);
  assert.equal(a.state.scores.together, 9);
  assert.equal(b.state.history.length, 1);
  assert.match(b.state.history[0].summary, /Synced on/);
});

test('a refreshed authority recovers the newer state from its partner', async () => {
  const time = new FakeTime();
  const hub = createMemoryHub({ schedule: time.schedule });
  const a = makeSession(time, hub, { id: 'aaa', name: 'Alex', creator: true });
  const b = makeSession(time, hub, { id: 'bbb', name: 'Blair' });
  await a.start();
  await b.start();
  time.advance(3000);
  a.dispatch({ type: 'settings', patch: { vibe: 'deep' } });
  time.flush();
  const v = a.state.v;
  // "Refresh" A with empty storage (e.g. private mode): it must adopt B's copy, not wipe the room.
  a.stop();
  time.advance(8000);
  const a2 = makeSession(time, hub, { id: 'aaa', name: 'Alex', storage: memoryStorage() });
  await a2.start();
  time.advance(4000);
  assert.equal(a2.state.settings.vibe, 'deep');
  assert.ok(a2.state.v >= v);
  assert.deepEqual(Object.keys(a2.state.players).sort(), ['aaa', 'bbb']);
  assert.deepEqual(a2.state, b.state);
});

test('authority hands over when it drops, and the game keeps going', async () => {
  const { a, b, time, hub } = await makePair();
  a.dispatch({ type: 'startGame', id: 'insync' });
  time.flush();
  hub.partitioned.add('aaa');
  time.advance(9000);
  assert.equal(b.isAuthority(), true);
  b.dispatch({ type: 'game', a: { type: 'submit', word: 'zebrafish' } });
  assert.equal(b.state.game.s.words.bbb, 'zebrafish');
  hub.partitioned.delete('aaa');
  time.advance(4000);
  assert.deepEqual(a.state, b.state);
  assert.equal(a.state.game.s.words.bbb, 'zebrafish');
  assert.equal(a.isAuthority(), true);
});

test('a third person is told the room is full; an offline seat can be taken over', async () => {
  const { a, b, time, hub } = await makePair();
  const c = makeSession(time, hub, { id: 'ccc', name: 'Casey' });
  await c.start();
  time.advance(5000);
  assert.equal(c.full, true);
  assert.deepEqual(Object.keys(a.state.players).sort(), ['aaa', 'bbb']);
  c.stop();
  // B leaves for good; B's new device (new id) can take the seat — but only after a long absence.
  b.stop();
  time.advance(9000);
  const b2 = makeSession(time, hub, { id: 'bbb2', name: 'Blair' });
  await b2.start();
  time.advance(6000);
  assert.deepEqual(Object.keys(a.state.players).sort(), ['aaa', 'bbb'], 'a short absence keeps the seat');
  time.advance(95000);
  assert.deepEqual(Object.keys(a.state.players).sort(), ['aaa', 'bbb2']);
  assert.deepEqual(a.state, b2.state);
});

test('two fresh joiners with no creator still converge', async () => {
  const time = new FakeTime();
  const hub = createMemoryHub({ schedule: time.schedule });
  const a = makeSession(time, hub, { id: 'zzz', name: 'Zed' });
  const b = makeSession(time, hub, { id: 'yyy', name: 'Yan' });
  await a.start();
  time.advance(4000); // a gives up waiting and creates the room alone
  await b.start();
  time.advance(6000);
  assert.deepEqual(Object.keys(a.state.players).sort(), ['yyy', 'zzz']);
  assert.deepEqual(a.state, b.state);
});

test('profile changes propagate', async () => {
  const { a, b, time } = await makePair();
  b.updateProfile({ name: 'Bee', avatar: '🐝' });
  time.flush();
  assert.equal(a.state.players.bbb.name, 'Bee');
  assert.equal(a.state.players.bbb.avatar, '🐝');
});

test('fx messages reach the partner but not the sender', async () => {
  const { a, b, time } = await makePair();
  const got = [];
  const mine = [];
  b.onFx((kind, data, from) => got.push([kind, data, from]));
  a.onFx((kind) => mine.push(kind));
  a.sendFx('react', { emoji: '❤️' });
  time.flush();
  assert.deepEqual(got, [['react', { emoji: '❤️' }, 'aaa']]);
  assert.deepEqual(mine, []);
});

test('clock offset follows the authority', async () => {
  const time = new FakeTime();
  const hub = createMemoryHub({ schedule: time.schedule });
  const a = makeSession(time, hub, { id: 'aaa', name: 'Alex', creator: true });
  const skew = 5000;
  const b = makeSession(time, hub, { id: 'bbb', name: 'Blair' });
  b.clock = () => time.t + skew; // B's phone clock is 5s fast
  await a.start();
  await b.start();
  time.advance(5000);
  assert.ok(Math.abs(b.now() - a.now()) < 100, `b.now off by ${b.now() - a.now()}`);
});

test('isNewer is a total order both sides agree on', () => {
  const x = { v: 3, by: 'aaa' };
  const y = { v: 3, by: 'bbb' };
  assert.ok(isNewer(x, y));
  assert.ok(!isNewer(y, x));
  assert.ok(isNewer({ v: 4, by: 'zzz' }, x));
  assert.ok(!isNewer(x, x));
});

test('reducer ignores actions from non-players and unknown games', () => {
  const s0 = initialState('R');
  const ctx = { now: 1, random: Math.random, games: GAMES, online: new Set(['p1']), self: 'p1' };
  const s1 = reduce(s0, { type: 'join', by: 'p1', player: { id: 'p1', name: 'A' } }, ctx);
  assert.equal(reduce(s1, { type: 'settings', by: 'evil', patch: { vibe: 'deep' } }, ctx), s1);
  assert.equal(reduce(s1, { type: 'startGame', by: 'p1', id: 'nope' }, ctx), s1);
  // Not enough players yet.
  assert.equal(reduce(s1, { type: 'startGame', by: 'p1', id: 'insync' }, ctx), s1);
  const s2 = reduce(s1, { type: 'join', by: 'p2', player: { id: 'p2', name: 'B' } }, { ...ctx, now: 2 });
  assert.deepEqual(playerIds(s2), ['p1', 'p2']);
  // Names are sanitised.
  const s3 = reduce(s2, { type: 'profile', by: 'p2', player: { name: '  x'.repeat(40) } }, ctx);
  assert.ok(s3.players.p2.name.length <= 24);
});

test('every registered game can init and ignore junk actions without throwing', () => {
  for (const [id, mod] of GAMES) {
    const ctx = { players: ['p1', 'p2'], names: { p1: 'A', p2: 'B' }, by: 'p1', now: 1000, random: () => 0.42, settings: { vibe: 'sweet' } };
    const s = mod.init(ctx, {});
    assert.ok(s && typeof s === 'object', `${id} init returns state`);
    assert.equal(typeof s.done, 'boolean', `${id} has done`);
    assert.equal(typeof s.points, 'number', `${id} has points`);
    JSON.stringify(s);
    for (const junk of [{ type: 'nope' }, { type: 'submit' }, { type: 'answer', value: null }, {}]) {
      mod.reduce(s, { ...junk, by: 'p2' }, { ...ctx, by: 'p2' });
      mod.reduce(s, { ...junk, by: 'stranger' }, { ...ctx, by: 'stranger' });
    }
    if (mod.tick) mod.tick(s, { ...ctx, by: null, now: 10 ** 13 });
    assert.ok(mod.meta.title && mod.meta.emoji && mod.meta.id === id);
  }
});

test('each started game gets a fresh instance number (fx channels never collide)', async () => {
  const { a, b, time } = await makePair();
  a.dispatch({ type: 'startGame', id: 'insync' });
  time.flush();
  const n1 = a.state.game.n;
  a.dispatch({ type: 'endGame' });
  time.flush();
  b.dispatch({ type: 'startGame', id: 'insync' });
  time.flush();
  assert.equal(b.state.game.n, n1 + 1);
  assert.deepEqual(a.state, b.state);
});

// ---------- regression tests for the real-time review ----------

test("a returning authority's stale saved copy never rolls back the partner's move", async () => {
  const time = new FakeTime();
  const hub = createMemoryHub({ schedule: time.schedule });
  const storeA = memoryStorage();
  const a = makeSession(time, hub, { id: 'aaa', name: 'Alex', creator: true, storage: storeA });
  const b = makeSession(time, hub, { id: 'bbb', name: 'Blair' });
  await a.start();
  await b.start();
  time.advance(3000);
  a.dispatch({ type: 'startGame', id: 'insync' });
  time.flush();
  // A's tab goes away (sends bye). B takes over and locks a word.
  a.stop();
  time.advance(500);
  b.dispatch({ type: 'game', a: { type: 'submit', word: 'zebrafish' } });
  time.flush();
  assert.equal(b.state.game.s.words.bbb, 'zebrafish');
  // A comes back with its older saved copy and immediately does the usual mount things.
  const a2 = makeSession(time, hub, { id: 'aaa', name: 'Alex', storage: storeA });
  await a2.start();
  a2.updateProfile({ name: 'Alex' });
  time.advance(6000);
  assert.equal(a2.state.game.s.words.bbb, 'zebrafish', 'partner move survived');
  assert.deepEqual(a2.state, b.state);
  assert.equal(a2.isAuthority(), true);
});

test('a lost state broadcast is repaired by the ping version check', async () => {
  const { a, b, time, hub } = await makePair();
  a.dispatch({ type: 'startGame', id: 'insync' });
  time.flush();
  b.dispatch({ type: 'game', a: { type: 'submit', word: 'Beach' } });
  time.flush();
  hub.filter = (from, msg) => !(from === 'aaa' && msg.t === 'state'); // the reveal broadcast is lost
  a.dispatch({ type: 'game', a: { type: 'submit', word: 'Cafe' } });
  time.flush();
  assert.notDeepEqual(a.state, b.state, 'one broadcast was lost');
  hub.filter = null;
  time.advance(5000);
  assert.deepEqual(a.state, b.state);
  assert.equal(b.state.game.s.phase, 'reveal');
});

test('an action sent into the void is re-sent and applied exactly once', async () => {
  const { a, b, time, hub } = await makePair();
  a.dispatch({ type: 'startGame', id: 'insync' });
  time.flush();
  // Drop B's next two action messages (first send + first retry).
  let drops = 0;
  hub.filter = (from, msg) => !(from === 'bbb' && msg.t === 'action' && drops++ < 2);
  b.dispatch({ type: 'game', a: { type: 'submit', word: 'Lantern' } });
  time.flush();
  assert.equal(a.state.game.s.words.bbb, undefined);
  time.advance(4000);
  hub.filter = null;
  time.advance(3000);
  assert.equal(a.state.game.s.words.bbb, 'Lantern');
  assert.equal(b.pendingCount(), 0);
  // Duplicates of an applied action are ignored.
  const v = a.state.v;
  const [n, q] = a.state.acks.bbb;
  a._onMessage({ t: 'action', from: 'bbb', room: 'TESTROOM', action: { type: 'game', a: { type: 'next' }, by: 'bbb', n, q } });
  assert.equal(a.state.v, v);
});

test('actions queued while the authority silently vanished land after the hand-over', async () => {
  const { a, b, time, hub } = await makePair();
  b.dispatch({ type: 'startGame', id: 'insync' });
  time.flush();
  hub.partitioned.add('aaa'); // A vanishes without a bye
  time.advance(1000);
  b.dispatch({ type: 'game', a: { type: 'submit', word: 'Moonbeam' } }); // goes to A, lost
  time.advance(9000); // B notices A is gone, takes over and applies its queued action
  assert.equal(b.isAuthority(), true);
  assert.equal(b.state.game.s.words.bbb, 'Moonbeam');
  hub.partitioned.delete('aaa');
  time.advance(5000);
  assert.deepEqual(a.state, b.state);
  assert.equal(a.state.game.s.words.bbb, 'Moonbeam');
});

test('countdowns keep one timeline across a hand-over even with skewed phone clocks', async () => {
  const time = new FakeTime();
  const hub = createMemoryHub({ schedule: time.schedule });
  const a = makeSession(time, hub, { id: 'aaa', name: 'Alex', creator: true });
  const b = makeSession(time, hub, { id: 'bbb', name: 'Blair' });
  b.clock = () => time.t + 5000; // B's clock is 5 s fast
  await a.start();
  await b.start();
  time.advance(5000);
  const before = b.now() - a.now();
  assert.ok(Math.abs(before) < 100);
  hub.partitioned.add('aaa');
  time.advance(9000);
  assert.equal(b.isAuthority(), true);
  // B leads now but keeps A's timeline: its now() did not jump by 5 s.
  assert.ok(Math.abs(b.now() - a.now()) < 100, `jumped by ${b.now() - a.now()}`);
});

test('a page that was suspended does not tick or commit its stale copy before catching up', async () => {
  const { a, b, time, hub } = await makePair();
  a.dispatch({ type: 'startGame', id: 'insync' });
  time.flush();
  // Simulate A's page being frozen: it stops receiving and its timers stop for 20 s.
  hub.partitioned.add('aaa');
  const saved = a.timers;
  const frozen = { ...saved };
  a._intervals.forEach((h) => saved.clearInterval(h));
  time.advance(9000);
  b.dispatch({ type: 'game', a: { type: 'submit', word: 'Seashell' } });
  time.advance(11000);
  // A wakes up: a big heartbeat gap -> unsynced, so it must not lead with its old copy.
  hub.partitioned.delete('aaa');
  a.lastBeat = time.t - 20000;
  a._heartbeat();
  assert.equal(a.synced, false);
  assert.equal(a.isAuthority(), false);
  time.advance(4000);
  assert.equal(a.state.game.s.words.bbb, 'Seashell');
  assert.deepEqual(a.state, b.state);
  void frozen;
});

test('profile no-ops and repeated joins do not bump the version', async () => {
  const { a, b, time } = await makePair();
  const v = a.state.v;
  b.updateProfile({ name: 'Blair' });
  a.updateProfile({ name: 'Alex' });
  time.advance(5000);
  assert.equal(a.state.v, v);
});

test('hostile state from the network is sanitised before adoption', async () => {
  const { a, b, time } = await makePair();
  const evil = JSON.parse(JSON.stringify(a.state));
  evil.term = 99;
  evil.players.bbb.color = '#fff;background-image:url(https://evil.example/x)';
  evil.history = [null, 5, { title: { x: 1 }, summary: 'ok', highlights: [1, 'hi'] }];
  b._onMessage({ t: 'state', from: 'ccc', room: 'TESTROOM', state: evil });
  assert.equal(b.state.term, 99);
  assert.equal(b.state.players.bbb.color, '#ff7eb6');
  assert.equal(b.state.history.length, 1);
  assert.equal(b.state.history[0].title, 'Game');
  assert.deepEqual(b.state.history[0].highlights, ['hi']);
  void time;
});
