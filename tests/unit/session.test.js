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
  // B leaves for good; B's new device (new id) can take the seat.
  b.stop();
  time.advance(9000);
  const b2 = makeSession(time, hub, { id: 'bbb2', name: 'Blair' });
  await b2.start();
  time.advance(6000);
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
