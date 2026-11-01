import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as dt from '../../js/games/deeptalk/logic.js';
import { CARDS, CLOSINGS } from '../../js/content/deeptalk.js';
import { gameHarness } from '../helpers/sim.js';
import { seededRandom, matchKey } from '../../js/lib/util.js';
import * as room from '../../js/core/state.js';
import { GAMES } from '../../js/games/index.js';

const ctxWith = (vibe, seed = 5) => ({ players: ['p1', 'p2'], names: { p1: 'Alex', p2: 'Blair' }, by: 'p1', now: 0, random: seededRandom(seed), settings: { vibe } });

/** Flip + talk + next. */
function talkCard(h, by = 'p1') {
  const id = h.s.card.id;
  h.act(by, { type: 'flip', card: id });
  h.act(by, { type: 'talked', card: id });
  return id;
}

test('content: >= 30 original cards per level, no duplicates, closings exist', () => {
  const all = new Set();
  for (const l of [1, 2, 3]) {
    assert.ok(CARDS[l].length >= 30, `level ${l}: ${CARDS[l].length}`);
    for (const c of CARDS[l]) {
      assert.ok(typeof c === 'string' && c.length >= 10 && c.length <= 200);
      assert.ok(!all.has(c), `duplicate: ${c}`);
      all.add(c);
    }
  }
  assert.ok([...all].filter((c) => /miss|apart|distance|far away|visit|screen|call|miles|goodbye|reunion|teleport/i.test(c)).length >= 10, 'long-distance cards');
  assert.ok(CLOSINGS.length >= 4);
});

test('init: face-down card from the vibe level, Alex answers first', () => {
  const s = dt.init(ctxWith('sweet'), {});
  assert.equal(s.phase, 'card');
  assert.equal(s.level, 1);
  assert.equal(s.card.level, 1);
  assert.ok(CARDS[1].includes(s.card.text));
  assert.equal(s.flipped, false);
  assert.equal(s.first, 'p1');
  assert.equal(s.done, false);
  assert.equal(s.points, 0);
  assert.equal(s.ai, false);
  for (const vibe of ['flirty', 'silly']) assert.equal(dt.init(ctxWith(vibe), {}).level, 1);
  const deep = dt.init(ctxWith('deep'), {});
  assert.equal(deep.level, 2);
  assert.equal(deep.card.level, 2);
  assert.ok(JSON.stringify(s).length < 2000);
});

test('happy path: flip, talk, next card alternates who answers first', () => {
  const h = gameHarness(dt);
  const c1 = h.s.card.id;
  assert.equal(h.s.first, 'p1');
  h.act('p2', { type: 'flip', card: c1 });
  assert.equal(h.s.flipped, true);
  const flipped = h.s;
  assert.equal(h.act('p1', { type: 'flip', card: c1 }), flipped, 'double flip is a no-op');
  h.act('p1', { type: 'talked', card: c1 });
  assert.equal(h.s.outcome, 'talked');
  assert.equal(h.s.count, 1);
  assert.equal(h.s.points, 1);
  const talked = h.s;
  assert.equal(h.act('p2', { type: 'talked', card: c1 }), talked, 'cannot complete twice');
  assert.equal(h.act('p2', { type: 'write', card: c1 }), talked, 'cannot write after talking');
  h.act('p2', { type: 'next', card: c1 });
  assert.notEqual(h.s.card.id, c1);
  assert.equal(h.s.first, 'p2');
  assert.equal(h.s.flipped, false);
  assert.equal(h.s.outcome, null);
  assert.equal(h.s.count, 1);
  // Both tap "next" at once: the stale one is ignored instead of skipping a card.
  const c2 = h.s.card.id;
  assert.equal(h.act('p1', { type: 'next', card: c1 }), h.s);
  assert.equal(h.s.card.id, c2);
});

test('write it down: answers stay sealed until both lock, then reveal; validation', () => {
  const h = gameHarness(dt);
  const c = h.s.card.id;
  const s0 = h.s;
  assert.equal(h.act('p1', { type: 'write', card: c }), s0, 'must flip first');
  assert.equal(h.act('p1', { type: 'talked', card: c }), s0, 'must flip first');
  h.act('p1', { type: 'flip', card: c });
  h.act('p2', { type: 'write', card: c });
  assert.equal(h.s.mode, 'write');
  const w = h.s;
  assert.equal(h.act('p1', { type: 'write', card: c }), w, 'already writing');
  assert.equal(h.act('p1', { type: 'answer', card: c, text: '   ' }), w, 'empty');
  assert.equal(h.act('p1', { type: 'answer', card: c }), w, 'missing');
  assert.equal(h.act('p1', { type: 'answer', card: c, text: { evil: 1 } }), w, 'not a string');
  assert.equal(h.act('p1', { type: 'answer', card: 'other', text: 'hi' }), w, 'wrong card');
  assert.equal(h.act('stranger', { type: 'answer', card: c, text: 'hi' }), w, 'stranger');
  h.act('p1', { type: 'answer', card: c, text: `  ${'x'.repeat(400)}  ` });
  assert.equal(h.s.answers.p1.length, dt.MAX_ANSWER, 'capped at 280');
  assert.equal(h.s.outcome, null, 'still sealed');
  const one = h.s;
  assert.equal(h.act('p1', { type: 'answer', card: c, text: 'changed my mind' }), one, 'no double submit');
  h.act('p2', { type: 'answer', card: c, text: 'The way you laugh at your own jokes' });
  assert.equal(h.s.outcome, 'written');
  assert.equal(h.s.count, 1);
  assert.equal(h.s.points, 1);
  assert.equal(h.s.answers.p2, 'The way you laugh at your own jokes');
  const done = h.s;
  assert.equal(h.act('p2', { type: 'talked', card: c }), done);
});

test('"just talk instead" abandons a half-written card', () => {
  const h = gameHarness(dt);
  const c = h.s.card.id;
  h.act('p1', { type: 'flip', card: c });
  h.act('p1', { type: 'write', card: c });
  h.act('p1', { type: 'answer', card: c, text: 'secret' });
  h.act('p2', { type: 'talked', card: c });
  assert.equal(h.s.outcome, 'talked');
  assert.equal(h.s.mode, null);
  assert.deepEqual(h.s.answers, {}, 'the sealed answer is discarded, never revealed');
  assert.equal(h.s.points, 1);
});

test('save toggles favourites (with answers once revealed), capped at 20', () => {
  const h = gameHarness(dt);
  const c = h.s.card.id;
  const s0 = h.s;
  assert.equal(h.act('p1', { type: 'save', card: c, on: true }), s0, 'face-down cards cannot be saved');
  h.act('p1', { type: 'flip', card: c });
  h.act('p1', { type: 'save', card: c, on: true });
  assert.equal(h.s.favs.length, 1);
  assert.equal(h.s.favs[0].text, h.s.card.text);
  assert.equal(h.s.favs[0].answers, null);
  const saved = h.s;
  assert.equal(h.act('p2', { type: 'save', card: c, on: true }), saved, 'idempotent');
  assert.equal(h.act('p2', { type: 'save', card: c }), saved, 'on must be boolean');
  h.act('p2', { type: 'write', card: c });
  h.act('p1', { type: 'answer', card: c, text: 'A' });
  assert.equal(h.s.favs[0].answers, null, 'sealed answers never leak into favourites');
  h.act('p2', { type: 'answer', card: c, text: 'B' });
  assert.deepEqual(h.s.favs[0].answers, { p1: 'A', p2: 'B' });
  h.act('p2', { type: 'save', card: c, on: false });
  assert.equal(h.s.favs.length, 0);
  h.act('p1', { type: 'save', card: c, on: true });
  assert.deepEqual(h.s.favs[0].answers, { p1: 'A', p2: 'B' }, 'saving after the reveal keeps the answers');

  // Fill up to the cap (skipping cards does not count towards the 15).
  h.act('p1', { type: 'next', card: c });
  while (h.s.favs.length < dt.MAX_FAVS) {
    const id = h.s.card.id;
    h.act('p1', { type: 'flip', card: id });
    h.act('p1', { type: 'save', card: id, on: true });
    h.act('p1', { type: 'next', card: id });
  }
  const id = h.s.card.id;
  h.act('p1', { type: 'flip', card: id });
  const full = h.s;
  assert.equal(h.act('p1', { type: 'save', card: id, on: true }), full);
  assert.equal(h.s.favs.length, 20);
  assert.equal(new Set(h.s.favs.map((f) => f.id)).size, 20);
});

test('level: swaps a face-down card; after flipping it applies to the next card', () => {
  const h = gameHarness(dt);
  const c1 = h.s.card;
  const drawn = h.s.drawn;
  h.act('p2', { type: 'level', level: 3 });
  assert.equal(h.s.level, 3);
  assert.equal(h.s.card.level, 3);
  assert.equal(h.s.drawn, drawn, 'swapping does not change who answers first');
  assert.equal(h.s.first, 'p1');
  assert.ok(!h.s.used.includes(c1.id), 'the unseen card goes back in the deck');
  const s3 = h.s;
  for (const bad of [3, 0, 4, '2', null, 1.5, undefined]) assert.equal(h.act('p1', { type: 'level', level: bad }), s3);
  const c = h.s.card.id;
  h.act('p1', { type: 'flip', card: c });
  h.act('p1', { type: 'level', level: 1 });
  assert.equal(h.s.level, 1);
  assert.equal(h.s.card.id, c, 'flipped card stays');
  h.act('p1', { type: 'next', card: c });
  assert.equal(h.s.card.level, 1);
});

test('no repeats within a game, even when a level runs out', () => {
  const h = gameHarness(dt);
  const seen = [];
  for (let i = 0; i < CARDS[1].length; i++) {
    seen.push(h.s.card.id);
    h.act('p1', { type: 'next', card: h.s.card.id }); // skip (no points)
  }
  assert.equal(new Set(seen).size, CARDS[1].length, 'every level-1 card once');
  assert.equal(h.s.points, 0);
  // Deck exhausted: still deals something (a repeat), never crashes.
  assert.equal(h.s.card.level, 1);
  assert.ok(h.s.used.length <= 80);
});

test('finish: done, summary, highlights from favourites, closing line; then frozen', () => {
  const h = gameHarness(dt);
  const c1 = talkCard(h);
  h.act('p1', { type: 'save', card: c1, on: true });
  h.act('p1', { type: 'next', card: c1 });
  h.act('p2', { type: 'level', level: 3 });
  const c2 = h.s.card.id;
  h.act('p2', { type: 'flip', card: c2 });
  h.act('p2', { type: 'write', card: c2 });
  h.act('p1', { type: 'answer', card: c2, text: 'You' });
  h.act('p2', { type: 'answer', card: c2, text: 'Also you' });
  h.act('p2', { type: 'save', card: c2, on: true });
  assert.equal(h.s.done, false);
  h.act('p2', { type: 'finish' });
  assert.equal(h.s.phase, 'done');
  assert.equal(h.s.done, true);
  assert.equal(h.s.points, 2);
  assert.match(h.s.summary, /^Shared 2 heart-to-heart cards and went deep · 2 saved ⭐$/);
  assert.equal(h.s.highlights.length, 2);
  assert.ok(h.s.highlights.every((x) => x.length <= 110));
  assert.ok(CLOSINGS.includes(h.s.closing));
  assert.deepEqual(h.s.favs[1].answers, { p1: 'You', p2: 'Also you' });
  const end = h.s;
  for (const a of [{ type: 'next', card: c2 }, { type: 'finish' }, { type: 'level', level: 1 }, { type: 'save', card: c2, on: false }]) {
    assert.equal(h.act('p1', a), end);
  }
});

test('finish with nothing saved uses recent cards; with nothing shared stays at 0 points', () => {
  const h = gameHarness(dt);
  const texts = [];
  for (let i = 0; i < 4; i++) {
    texts.push(h.s.card.text);
    const id = talkCard(h);
    h.act('p1', { type: 'next', card: id });
  }
  h.act('p1', { type: 'finish' });
  assert.deepEqual(h.s.highlights, texts.slice(-3).map((t) => (t.length > 110 ? `${t.slice(0, 107).trimEnd()}…` : t)));
  assert.match(h.s.summary, /kept it light/);

  const g = gameHarness(dt);
  g.act('p2', { type: 'finish' });
  assert.equal(g.s.done, true);
  assert.equal(g.s.points, 0);
  assert.deepEqual(g.s.highlights, []);
  assert.ok(g.s.summary.length > 0);
});

test('auto-finish: after 15 shared cards "next" ends the game', () => {
  const h = gameHarness(dt);
  for (let i = 0; i < dt.MAX_CARDS; i++) {
    const id = talkCard(h, i % 2 ? 'p2' : 'p1');
    if (i < dt.MAX_CARDS - 1) {
      h.act('p2', { type: 'next', card: id });
      assert.equal(h.s.done, false);
    }
  }
  assert.equal(h.s.count, 15);
  assert.equal(h.s.done, false, 'the 15th card stays on screen');
  h.act('p1', { type: 'next', card: h.s.card.id });
  assert.equal(h.s.phase, 'done');
  assert.equal(h.s.done, true);
  assert.equal(h.s.points, 15);
});

test('strangers, junk and wrong-card actions are ignored', () => {
  const h = gameHarness(dt);
  const s0 = h.s;
  const c = s0.card.id;
  for (const a of [
    { type: 'flip' },
    { type: 'flip', card: 'nope' },
    { type: 'next' },
    { type: 'next', card: 'nope' },
    { type: 'answer', card: c, text: 'x' },
    { type: 'bogus' },
    {},
  ]) {
    assert.equal(h.act('p1', a), s0, JSON.stringify(a));
  }
  for (const a of [{ type: 'flip', card: c }, { type: 'finish' }, { type: 'level', level: 2 }, { type: 'next', card: c }]) {
    assert.equal(h.act('intruder', a), s0, JSON.stringify(a));
  }
});

test('AI cards are validated, preferred per level, and fall back to the deck', () => {
  const content = {
    cards: [
      { text: '  What song should play at our reunion?  ', level: 1 },
      { text: 'What song should play at our reunion?', level: 1 }, // duplicate
      { text: 'Too short', level: 9 },
      { text: 'Hi', level: 1 },
      { text: 'What scares you about the next year apart?', level: '3' },
      { text: 42, level: 2 },
      null,
      'junk',
      { text: 'Q'.repeat(500), level: 2 },
    ],
  };
  const h = gameHarness(dt, { opts: { content } });
  assert.equal(h.s.ai, true);
  assert.equal(h.s.aiCards.length, 3);
  assert.equal(h.s.aiCards[2].text.length, 200, 'long AI text is capped');
  assert.equal(h.s.card.text, 'What song should play at our reunion?', 'AI card first');
  assert.equal(h.s.card.id, 'a0');
  h.act('p1', { type: 'next', card: 'a0' });
  assert.ok(CARDS[1].includes(h.s.card.text), 'then the built-in deck');
  h.act('p1', { type: 'level', level: 3 });
  assert.equal(h.s.card.text, 'What scares you about the next year apart?');

  for (const bad of [null, 'nope', { cards: 'x' }, { cards: [] }, { cards: [{ text: 'Where to next?', level: 0 }] }, { items: [] }]) {
    const g = gameHarness(dt, { opts: { content: bad } });
    assert.equal(g.s.ai, false);
    assert.deepEqual(g.s.aiCards, []);
    assert.ok(CARDS[1].includes(g.s.card.text));
  }
  const many = { cards: Array.from({ length: 50 }, (_, i) => ({ text: `Question number ${i}?`, level: (i % 3) + 1 })) };
  assert.ok(gameHarness(dt, { opts: { content: many } }).s.aiCards.length <= 20);
});

test('content: every card works for either partner and any couple', () => {
  // Both of you answer the same card in turn, so nothing may assume who is who.
  for (const l of [1, 2, 3]) {
    for (const c of CARDS[l]) {
      assert.ok(!/\b(he|she|him|her|his|hers|boyfriend|girlfriend|husband|wife)\b/i.test(c), `gendered: ${c}`);
      assert.ok(!/\b(asked (me|you) out|proposed)\b/i.test(c), `one-sided history: ${c}`);
    }
  }
});

test('AI cards that are also in the deck are never dealt twice', () => {
  const dupe = CARDS[1][0];
  const content = {
    cards: [
      { text: dupe.toUpperCase().replace(/[—?]/g, ''), level: 1 }, // same card, other spelling
      { text: 'What song should play at our reunion?', level: 1 },
    ],
  };
  for (let seed = 1; seed <= 20; seed++) {
    const h = gameHarness(dt, { seed, opts: { content } });
    const keys = [];
    for (let i = 0; i < CARDS[1].length + 1; i++) {
      keys.push(matchKey(h.s.card.text));
      h.act('p1', { type: 'next', card: h.s.card.id });
    }
    assert.equal(keys.filter((k) => k === matchKey(dupe)).length, 1, `seed ${seed}: the duplicate came back`);
    assert.equal(new Set(keys).size, keys.length, `seed ${seed}: every card once`);
  }
});

// ------------------------------------------------------------------ leaving through ✕ (rules#2)

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const short = (t) => (t.length > 110 ? `${t.slice(0, 107).trimEnd()}…` : t);

test('summarize: shared count and saved favourites so far; pure; finished games keep their own', () => {
  const h = gameHarness(dt);
  assert.deepEqual(dt.summarize(h.s, h.ctx()), { summary: 'Peeked at the Heart to Heart deck', highlights: [] });
  const texts = [];
  for (let i = 0; i < 4; i++) {
    const id = h.s.card.id;
    texts.push(h.s.card.text);
    h.act('p1', { type: 'flip', card: id });
    if (i % 2) {
      h.act('p1', { type: 'write', card: id });
      h.act('p1', { type: 'answer', card: id, text: `Alex answer ${i}` });
      h.act('p2', { type: 'answer', card: id, text: `Blair answer ${i}` });
    } else h.act('p2', { type: 'talked', card: id });
    if (i < 3) h.act('p1', { type: 'save', card: id, on: true });
    h.act('p2', { type: 'next', card: id });
  }
  // A fifth card half-written: its sealed answer must never reach the recap.
  const c5 = h.s.card.id;
  h.act('p1', { type: 'flip', card: c5 });
  h.act('p1', { type: 'write', card: c5 });
  h.act('p1', { type: 'answer', card: c5, text: 'SECRET sealed answer' });
  const before = JSON.stringify(h.s);
  const sum = dt.summarize(deepFreeze(h.s), h.ctx());
  assert.equal(JSON.stringify(h.s), before, 'never mutates');
  assert.equal(h.s.done, false);
  assert.equal(sum.summary, 'Shared 4 heart-to-heart cards and kept it light · 3 saved ⭐');
  assert.deepEqual(sum.highlights, texts.slice(0, 3).map(short));
  assert.ok(!JSON.stringify(sum).includes('SECRET'));
  assert.deepEqual(dt.summarize(h.s, h.ctx()), sum, 'deterministic');

  // Nothing saved: the last cards talked about.
  const g = gameHarness(dt);
  const said = [];
  for (let i = 0; i < 5; i++) {
    said.push(g.s.card.text);
    g.act('p1', { type: 'next', card: talkCard(g) });
  }
  assert.deepEqual(dt.summarize(g.s, g.ctx()), { summary: 'Shared 5 heart-to-heart cards and kept it light', highlights: said.slice(-3).map(short) });

  // Saved but never shared (flipped, starred, skipped).
  const k = gameHarness(dt);
  const id = k.s.card.id;
  k.act('p1', { type: 'flip', card: id });
  k.act('p1', { type: 'save', card: id, on: true });
  assert.deepEqual(dt.summarize(k.s, k.ctx()), { summary: 'Saved 1 heart-to-heart card ⭐', highlights: [short(k.s.card.text)] });

  // Finished with "Finish for tonight": exactly what the end screen recorded.
  g.act('p2', { type: 'finish' });
  assert.deepEqual(dt.summarize(g.s, g.ctx()), { summary: g.s.summary, highlights: g.s.highlights });
  for (const bad of [null, undefined, {}, { favs: 'x' }]) assert.deepEqual(dt.summarize(bad, g.ctx()), {});
});

test('leaving through ✕ keeps the conversation in the night recap', () => {
  const ctx = { now: 1_700_000_000_000, random: seededRandom(4), games: GAMES, online: new Set(['p1', 'p2']) };
  let st = room.initialState('R');
  st = room.reduce(st, { type: 'join', by: 'p1', player: { id: 'p1', name: 'Alex' } }, ctx);
  st = room.reduce(st, { type: 'join', by: 'p2', player: { id: 'p2', name: 'Blair' } }, { ...ctx, now: ctx.now + 1 });
  st = room.reduce(st, { type: 'startGame', by: 'p1', id: 'deeptalk' }, ctx);
  const g = (by, a) => (st = room.reduce(st, { type: 'game', by, a }, ctx));
  const saved = [];
  for (let i = 0; i < 4; i++) {
    const card = st.game.s.card.id;
    g('p1', { type: 'flip', card });
    if (i % 2) {
      g('p1', { type: 'write', card });
      g('p1', { type: 'answer', card, text: `Alex answer ${i}` });
      g('p2', { type: 'answer', card, text: `Blair answer ${i}` });
    } else g('p2', { type: 'talked', card });
    if (i < 3) {
      g('p1', { type: 'save', card, on: true });
      saved.push(st.game.s.card.text);
    }
    g('p2', { type: 'next', card });
  }
  st = room.reduce(st, { type: 'endGame', by: 'p1' }, ctx);
  const entry = st.history.at(-1);
  assert.equal(entry.id, 'deeptalk');
  assert.equal(entry.summary, 'Shared 4 heart-to-heart cards and kept it light · 3 saved ⭐');
  assert.deepEqual(entry.highlights, saved.map(short));
  assert.equal(entry.points, 4);
});
