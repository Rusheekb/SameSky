import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as story from '../../js/games/story/logic.js';
import { OPENINGS, TWISTS, END_TITLES, EPILOGUES } from '../../js/content/story.js';
import { gameHarness, makePair } from '../helpers/sim.js';
import { seededRandom } from '../../js/lib/util.js';

const { MAX_LINE, MAX_TWIST, MAX_TWISTS, MIN_LINES, MAX_LINES, LINE_POINTS_CAP, FINISH_POINTS, NARRATOR_WAIT } = story;

function ctxFor(over = {}) {
  return {
    players: ['p1', 'p2'],
    names: { p1: 'Alex', p2: 'Blair' },
    by: 'p1',
    now: 1_700_000_000_000,
    random: seededRandom(5),
    settings: { vibe: 'sweet', ai: false, aboutUs: '' },
    ...over,
  };
}

/** Write `n` alternating lines starting with whoever's turn it is. */
function write(h, n, text = (i) => `Line ${i + 1}: and then something lovely happened.`) {
  for (let i = 0; i < n; i++) {
    const by = h.s.turn;
    const before = h.s;
    h.act(by, { type: 'line', text: text(i) });
    assert.notEqual(h.s, before, `line ${i + 1} by ${by} accepted`);
  }
}

// ------------------------------------------------------------------ content

test('content bank: enough original, well-formed openings, twists and titles', () => {
  assert.ok(OPENINGS.length >= 36, `${OPENINGS.length} openings`);
  for (const vibe of ['sweet', 'flirty', 'silly', 'deep']) {
    assert.ok(OPENINGS.filter((o) => o.vibe === vibe).length >= 8, `${vibe} openings`);
  }
  for (const flavour of ['cosy', 'adventure', 'mystery']) {
    assert.ok(OPENINGS.some((o) => o.flavour === flavour), `${flavour} flavour`);
  }
  for (const o of OPENINGS) {
    assert.ok(o.title && o.title.length <= story.MAX_TITLE, o.title);
    assert.ok(o.opening.length >= 20 && o.opening.length <= story.MAX_OPENING, o.opening);
    assert.ok(!/\{(?!A\}|B\})/.test(o.opening + o.title), `only {A}/{B} placeholders: ${o.title}`);
  }
  assert.equal(new Set(OPENINGS.map((o) => o.title)).size, OPENINGS.length, 'unique titles');
  assert.equal(new Set(OPENINGS.map((o) => o.opening)).size, OPENINGS.length, 'unique openings');

  assert.ok(TWISTS.length >= 50, `${TWISTS.length} twists`);
  assert.equal(new Set(TWISTS.map((t) => t.text)).size, TWISTS.length, 'unique twists');
  for (const t of TWISTS) {
    assert.ok(['any', 'sweet', 'flirty', 'silly', 'deep'].includes(t.vibe));
    assert.ok(t.text.length >= 8 && t.text.length <= MAX_TWIST, t.text);
  }
  assert.ok(END_TITLES.length >= 20);
  assert.equal(new Set(END_TITLES).size, END_TITLES.length);
  for (const t of END_TITLES) assert.ok(t.length <= story.MAX_TITLE);
  assert.ok(EPILOGUES.length >= 8);
});

// ------------------------------------------------------------------ init

test('init: opening from the bank for the vibe, names filled in, players[0] writes first', () => {
  for (const vibe of ['sweet', 'flirty', 'silly', 'deep']) {
    for (let seed = 1; seed <= 15; seed++) {
      const ctx = ctxFor({ random: seededRandom(seed), settings: { vibe } });
      const s = story.init(ctx, {});
      const o = OPENINGS[s.seenO[0]];
      assert.equal(o.vibe, vibe);
      assert.equal(s.src, 'bank');
      assert.ok(!/\{A\}|\{B\}/.test(s.opening + s.title), 'placeholders replaced');
      assert.equal(s.opening, o.opening.replaceAll('{A}', 'Alex').replaceAll('{B}', 'Blair'));
    }
  }
  const h = gameHarness(story);
  assert.equal(h.s.phase, 'writing');
  assert.equal(h.s.turn, 'p1');
  assert.deepEqual(h.s.lines, []);
  assert.equal(h.s.done, false);
  assert.equal(h.s.points, 0);
  assert.equal(h.s.story, 1);
  assert.deepEqual(h.s.highlights, []);
  // Unknown vibe still works.
  const s = story.init(ctxFor({ settings: {} }), {});
  assert.ok(s.opening.length > 10);
});

test('init is deterministic for a given random seed', () => {
  const a = story.init(ctxFor({ random: seededRandom(9) }), {});
  const b = story.init(ctxFor({ random: seededRandom(9) }), {});
  assert.deepEqual(a, b);
});

test('AI story_start content is validated, cleaned and falls back to the bank', () => {
  const ok = story.init(ctxFor(), { content: { title: '  “The Robot Gardener”  ', opening: '  A robot\n gardener woke up\tto find   a rose growing out of its chest. ' } });
  assert.equal(ok.src, 'ai');
  assert.equal(ok.title, 'The Robot Gardener');
  assert.equal(ok.opening, 'A robot gardener woke up to find a rose growing out of its chest.');
  assert.deepEqual(ok.seenO, []);

  const noTitle = story.init(ctxFor(), { content: { opening: 'The kettle sang a song nobody had taught it.' } });
  assert.equal(noTitle.src, 'ai');
  assert.equal(noTitle.title, story.FALLBACK_TITLE);

  const long = story.init(ctxFor(), { content: { title: 'T'.repeat(500), opening: 'word '.repeat(200) } });
  assert.ok(long.opening.length <= story.MAX_OPENING);
  assert.ok(long.opening.endsWith('…'));
  assert.ok(long.title.length <= story.MAX_TITLE);

  for (const junk of [null, 'a string', 42, [], [{ title: 'x', opening: 'y' }], { title: 'Hi' }, { opening: '' }, { opening: '   ' }, { opening: '!!!!!!!!!!!!!!!!' },
    { opening: 'short' }, { opening: { text: 'An object, not a string at all' } }, { title: 7, opening: 12345678901234 }]) {
    const s = story.init(ctxFor(), { content: junk });
    assert.equal(s.src, 'bank', `fallback for ${JSON.stringify(junk)}`);
    assert.ok(OPENINGS.some((o) => o.title === s.title || o.title.includes('{')));
  }
});

// ------------------------------------------------------------------ writing

test('happy path: alternate lines, twist, The End, title, keepsake + recap fields', () => {
  const h = gameHarness(story);
  h.act('p1', { type: 'line', text: '  The baker   turned around and gasped. ' });
  assert.deepEqual(h.s.lines, [{ by: 'p1', text: 'The baker turned around and gasped.' }]);
  assert.equal(h.s.turn, 'p2');
  assert.equal(h.s.points, 1);
  assert.match(h.s.summary, /1 line in/);

  h.act('p2', { type: 'line', text: 'A tiny dragon was eating the cinnamon roll.' });
  assert.equal(h.s.turn, 'p1');
  // Either player can twist, even the one who is not writing; the turn doesn't move.
  h.act('p2', { type: 'twist' });
  assert.equal(h.s.lines.length, 3);
  assert.equal(h.s.lines[2].twist, true);
  assert.equal(h.s.lines[2].by, 'p2');
  assert.ok(TWISTS.some((t) => t.text === h.s.lines[2].text));
  assert.equal(h.s.turn, 'p1');
  assert.equal(h.s.twists, 1);
  assert.equal(h.s.points, 2, 'twists are not worth points');

  write(h, 4);
  assert.equal(story.playerLines(h.s.lines), 6);
  assert.equal(h.s.phase, 'writing');
  h.act('p2', { type: 'end' });
  assert.equal(h.s.phase, 'ending');
  assert.equal(h.s.ending.by, 'p2');
  assert.equal(h.s.ending.narrator, 'off');
  assert.equal(h.s.ending.suggest.length, 4);
  assert.equal(h.s.ending.suggest[0], h.s.title);
  assert.equal(new Set(h.s.ending.suggest).size, 4);

  h.act('p1', { type: 'finish', title: '  The Dragon Who Loved Pastry ' });
  assert.equal(h.s.phase, 'final');
  assert.equal(h.s.done, true);
  assert.equal(h.s.book.title, 'The Dragon Who Loved Pastry');
  assert.ok(EPILOGUES.map((e) => e.replaceAll('{A}', 'Alex').replaceAll('{B}', 'Blair')).includes(h.s.book.epilogue));
  assert.equal(h.s.points, 6 + FINISH_POINTS);
  assert.equal(h.s.gained, 6 + FINISH_POINTS);
  assert.equal(h.s.plays, 1);
  assert.equal(h.s.summary, 'Wrote “The Dragon Who Loved Pastry” together (6 lines, 1 twist)');
  assert.equal(h.s.highlights.length, 1);
  assert.match(h.s.highlights[0], /^“The Dragon Who Loved Pastry”: /);
  assert.match(h.s.highlights[0], /cinnamon roll/, 'longest line is the memorable one');
  assert.ok(h.s.highlights.every((x) => x.length <= 200));

  // Nothing else works once it's bound.
  const done = h.s;
  for (const a of [{ type: 'line', text: 'more' }, { type: 'twist' }, { type: 'end' }, { type: 'finish', title: 'x' }, { type: 'resume' }, { type: 'manual' }]) {
    h.act('p1', a);
    h.act('p2', a);
    assert.equal(h.s, done, `${a.type} ignored after the end`);
  }

  const txt = story.storyText(h.s, { p1: 'Alex', p2: 'Blair' });
  assert.match(txt, /^📖 The Dragon Who Loved Pastry\nby Alex & Blair\n\n/);
  assert.ok(txt.includes(h.s.opening));
  assert.ok(txt.includes('The baker turned around and gasped. A tiny dragon was eating the cinnamon roll.'));
  assert.ok(txt.includes(`✨ ${h.s.lines[2].text}`));
  assert.ok(txt.endsWith(`${h.s.book.epilogue}\n\n— The End —`));
  assert.ok(!/\n\n\n/.test(txt));
});

test('lines are validated: turn, players only, text type, empty, punctuation-only, oversized, double submit', () => {
  const h = gameHarness(story);
  const s0 = h.s;
  for (const [by, a] of [
    ['p2', { type: 'line', text: 'Not my turn yet.' }],
    ['stranger', { type: 'line', text: 'Who let me in?' }],
    [undefined, { type: 'line', text: 'Nobody' }],
    ['p1', { type: 'line' }],
    ['p1', { type: 'line', text: '' }],
    ['p1', { type: 'line', text: '    \n\t  ' }],
    ['p1', { type: 'line', text: '... !!! ???' }],
    ['p1', { type: 'line', text: 42 }],
    ['p1', { type: 'line', text: { evil: true } }],
    ['p1', { type: 'line', text: ['array'] }],
    ['p1', { type: 'nope' }],
    ['p1', {}],
  ]) {
    h.act(by, a);
    assert.equal(h.s, s0, `rejected ${JSON.stringify([by, a])}`);
  }
  assert.equal(story.reduce(s0, null, h.ctx('p1')), s0);

  h.act('p1', { type: 'line', text: 'x'.repeat(5000) });
  assert.equal(h.s.lines[0].text.length, MAX_LINE, 'oversized text is capped');
  const once = h.s;
  h.act('p1', { type: 'line', text: 'Sending twice by accident' });
  assert.equal(h.s, once, 'double submit ignored — it is the partner’s turn now');
  h.act('p2', { type: 'line', text: 'Ok 👍 2' });
  assert.equal(h.s.lines.length, 2);
  assert.equal(h.s.lines[1].text, 'Ok 👍 2');
});

test('wrong-phase actions are ignored and return the same state', () => {
  const h = gameHarness(story);
  const s0 = h.s;
  for (const a of [{ type: 'finish', title: 'Too soon' }, { type: 'resume' }, { type: 'manual' }, { type: 'again' }, { type: 'end' }, { type: 'twist' }]) {
    h.act('p1', a);
    assert.equal(h.s, s0, `${a.type} ignored at the start`);
  }
  write(h, MIN_LINES - 1);
  const s5 = h.s;
  h.act('p1', { type: 'end' });
  assert.equal(h.s, s5, 'The End needs 6 lines');
  write(h, 1);
  h.act('p1', { type: 'end' });
  assert.equal(h.s.phase, 'ending');
  const e = h.s;
  for (const a of [{ type: 'line', text: 'Sneaky extra line' }, { type: 'twist' }, { type: 'end' }, { type: 'manual' }, { type: 'again' }]) {
    h.act('p1', a);
    h.act('p2', a);
    assert.equal(h.s, e, `${a.type} ignored while ending`);
  }
  h.act('stranger', { type: 'finish', title: 'Hijacked' });
  assert.equal(h.s, e, 'strangers cannot finish');
});

// ------------------------------------------------------------------ twists

test('twists: need a line first, never two in a row, max 3, keep the turn', () => {
  const h = gameHarness(story);
  h.act('p1', { type: 'twist' });
  assert.equal(h.s.twists, 0, 'no twist before the first line');
  for (let k = 1; k <= MAX_TWISTS; k++) {
    write(h, 1);
    const turn = h.s.turn;
    h.act(k % 2 ? 'p1' : 'p2', { type: 'twist' });
    assert.equal(h.s.twists, k);
    assert.equal(h.s.turn, turn);
    const t = h.s;
    h.act('p2', { type: 'twist' });
    h.act('p1', { type: 'twist' });
    assert.equal(h.s, t, 'not twice in a row');
  }
  write(h, 1);
  const s = h.s;
  h.act('p1', { type: 'twist' });
  assert.equal(h.s, s, 'no more than 3');
  const texts = h.s.lines.filter((l) => l.twist).map((l) => l.text);
  assert.equal(new Set(texts).size, texts.length, 'no repeated twist in one story');
  h.act('stranger', { type: 'twist' });
  assert.equal(h.s, s);
});

test('twists from the bank respect the vibe', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const ctx = ctxFor({ random: seededRandom(seed), settings: { vibe: 'silly' } });
    let s = story.init(ctx, {});
    s = story.reduce(s, { type: 'line', text: 'Hello there.', by: 'p1' }, ctx);
    s = story.reduce(s, { type: 'twist', by: 'p2' }, ctx);
    const t = TWISTS.find((x) => x.text === s.lines[1].text);
    assert.ok(t && (t.vibe === 'any' || t.vibe === 'silly'), t?.vibe);
  }
});

test('AI twist text is cleaned and clipped; junk falls back to the bank', () => {
  const h = gameHarness(story);
  write(h, 1);
  h.act('p2', { type: 'twist', text: '  "Then the moon\nfell softly into the lake."  ' });
  assert.equal(h.s.lines[1].text, 'Then the moon fell softly into the lake.');
  write(h, 1);
  h.act('p1', { type: 'twist', text: 'Then ' + 'very '.repeat(80) + 'long.' });
  const t2 = h.s.lines[3].text;
  assert.ok(t2.length <= MAX_TWIST && t2.endsWith('…'), t2);
  assert.ok(!/\s…$/.test(t2), 'cut at a word boundary');
  write(h, 1);
  // A twist that merely contains a quote keeps it.
  h.act('p1', { type: 'twist', text: '“Grandma?” someone whispered into the dark.' });
  assert.equal(h.s.lines[5].text, '“Grandma?” someone whispered into the dark.');

  for (const junk of ['', '   ', '!!!', 'Hi', 12345, { a: 1 }, ['x'], null]) {
    const g = gameHarness(story);
    write(g, 1);
    g.act('p2', { type: 'twist', text: junk });
    assert.equal(g.s.twists, 1);
    assert.ok(TWISTS.some((t) => t.text === g.s.lines[1].text), `bank twist for ${JSON.stringify(junk)}`);
  }
});

test('concurrent twist taps never double-apply (phase/turn guards + `at`)', () => {
  const h = gameHarness(story);
  write(h, 2);
  const at = h.s.lines.length;
  h.act('p1', { type: 'twist', at });
  h.act('p2', { type: 'twist', at });
  assert.equal(h.s.twists, 1, 'second tap rejected (two in a row)');
  // A slow AI twist that was requested before the first one landed is dropped even after a new line.
  write(h, 1);
  const s = h.s;
  h.act('p2', { type: 'twist', at, text: 'A late twist from a slow AI call.' });
  assert.equal(h.s, s, 'stale twist dropped');
  h.act('p2', { type: 'twist', at: h.s.lines.length, text: 'A fresh twist arrives right on time.' });
  assert.equal(h.s.twists, 2);
  // Junk `at` values are ignored rather than trusted.
  write(h, 1);
  h.act('p1', { type: 'twist', at: 'zero' });
  assert.equal(h.s.twists, 3);
});

// ------------------------------------------------------------------ ending

test('concurrent "The End" taps: first one wins; resume goes back to writing', () => {
  const h = gameHarness(story);
  write(h, MIN_LINES);
  h.act('p1', { type: 'end' });
  const e = h.s;
  h.act('p2', { type: 'end' });
  assert.equal(h.s, e);
  assert.equal(h.s.ending.by, 'p1');
  h.act('p2', { type: 'resume' });
  assert.equal(h.s.phase, 'writing');
  assert.equal(h.s.ending, null);
  assert.equal(h.s.turn, 'p1', 'turn is kept');
  write(h, 1);
  h.act('p2', { type: 'end' });
  assert.equal(h.s.ending.by, 'p2');
});

test('AI ending: pending narrator, sanitised finish, manual fallback and tick timeout', () => {
  const h = gameHarness(story);
  write(h, MIN_LINES);
  h.act('p2', { type: 'end', ai: true });
  assert.equal(h.s.ending.narrator, 'pending');
  // tick before the timeout: same object
  const pending = h.s;
  assert.equal(h.tick(NARRATOR_WAIT - 1000), pending);
  h.act('p1', { type: 'finish', title: '**“The Lighthouse That Blinked Twice”**', epilogue: '  And   the light\n stayed on for them. ' });
  assert.equal(h.s.book.title, 'The Lighthouse That Blinked Twice');
  assert.equal(h.s.book.epilogue, 'And the light stayed on for them.');

  // AI returned nothing useful: falls back to the working title and a bank epilogue.
  const g = gameHarness(story);
  write(g, MIN_LINES);
  g.act('p1', { type: 'end', ai: true });
  g.act('p1', { type: 'finish', title: { bad: 1 }, epilogue: 99 });
  assert.equal(g.s.book.title, g.s.title);
  assert.ok(g.s.book.epilogue.length > 10);
  assert.ok(!/\{A\}|\{B\}/.test(g.s.book.epilogue));

  // Oversized title/epilogue are clipped.
  const k = gameHarness(story);
  write(k, MIN_LINES);
  k.act('p1', { type: 'end' });
  k.act('p2', { type: 'finish', title: 'Long '.repeat(40), epilogue: 'yes '.repeat(200) });
  assert.ok(k.s.book.title.length <= story.MAX_TITLE);
  assert.ok(k.s.book.epilogue.length <= story.MAX_EPILOGUE);

  // "We'll name it ourselves"
  const m = gameHarness(story);
  write(m, MIN_LINES);
  m.act('p1', { type: 'end', ai: true });
  m.act('stranger', { type: 'manual' });
  assert.equal(m.s.ending.narrator, 'pending');
  m.act('p2', { type: 'manual' });
  assert.equal(m.s.ending.narrator, 'off');
  const off = m.s;
  m.act('p1', { type: 'manual' });
  assert.equal(m.s, off);

  // Narrator never answers: tick flips to the title form after NARRATOR_WAIT.
  const t = gameHarness(story);
  write(t, MIN_LINES);
  t.act('p1', { type: 'end', ai: true });
  const before = t.s;
  t.tick(NARRATOR_WAIT);
  assert.notEqual(t.s, before);
  assert.equal(t.s.ending.narrator, 'off');
  const after = t.s;
  assert.equal(t.tick(5000), after, 'tick is a no-op once off');
});

test('tick returns the same object whenever nothing changes', () => {
  const h = gameHarness(story);
  const s0 = h.s;
  assert.equal(h.tick(10 ** 9), s0);
  write(h, MIN_LINES);
  h.act('p1', { type: 'end' });
  const e = h.s;
  assert.equal(h.tick(10 ** 9), e, 'narrator off: nothing to time out');
  h.act('p1', { type: 'finish', title: 'Done' });
  const f = h.s;
  assert.equal(h.tick(10 ** 9), f);
});

test('hard cap: 24 lines ends the story automatically; points cap at 12 + 2', () => {
  const h = gameHarness(story);
  write(h, MAX_LINES - 1);
  assert.equal(h.s.phase, 'writing');
  assert.equal(h.s.points, LINE_POINTS_CAP, 'line points capped at 12');
  const lastWriter = h.s.turn;
  write(h, 1);
  assert.equal(h.s.phase, 'ending');
  assert.equal(h.s.ending.auto, true);
  assert.equal(h.s.ending.by, lastWriter);
  assert.equal(h.s.ending.narrator, 'off', 'AI off in settings');
  const e = h.s;
  h.act('p1', { type: 'resume' });
  assert.equal(h.s, e, 'cannot keep writing a full book');
  h.act('p2', { type: 'finish', title: 'The Very Long One' });
  assert.equal(h.s.points, LINE_POINTS_CAP + FINISH_POINTS);
  assert.ok(JSON.stringify(h.s).length < 7000, 'state stays small');

  // With AI switched on in settings, the auto-ending asks the narrator.
  const ctx = ctxFor({ settings: { vibe: 'deep', ai: true } });
  let s = story.init(ctx, {});
  for (let i = 0; i < MAX_LINES; i++) s = story.reduce(s, { type: 'line', text: `Line ${i}`, by: s.turn }, ctx);
  assert.equal(s.ending.narrator, 'pending');
});

test('state stays small even with maximum-length lines and twists', () => {
  const h = gameHarness(story);
  for (let i = 0; i < MAX_LINES; i++) {
    h.act(h.s.turn, { type: 'line', text: `${i} ${'w'.repeat(400)}` });
    if (i % 5 === 0 && h.s.twists < MAX_TWISTS) h.act('p1', { type: 'twist', text: 'z '.repeat(300) });
  }
  assert.equal(h.s.phase, 'ending');
  h.act('p1', { type: 'finish', title: 'T'.repeat(500), epilogue: 'e '.repeat(500) });
  assert.ok(JSON.stringify(h.s).length < 8000, `${JSON.stringify(h.s).length} bytes`);
});

// ------------------------------------------------------------------ again

test('"Write another": fresh story, cumulative points, new opening, alternating first writer', () => {
  const h = gameHarness(story);
  write(h, MIN_LINES);
  h.act('p1', { type: 'end' });
  h.act('p1', { type: 'finish', title: 'First' });
  const first = h.s;
  h.act('stranger', { type: 'again' });
  assert.equal(h.s, first);
  h.act('p2', { type: 'again' });
  assert.equal(h.s.phase, 'writing');
  assert.equal(h.s.done, false);
  assert.equal(h.s.story, 2);
  assert.deepEqual(h.s.lines, []);
  assert.equal(h.s.twists, 0);
  assert.equal(h.s.book, null);
  assert.equal(h.s.points, 8, 'points carried over');
  assert.equal(h.s.gained, 0);
  assert.equal(h.s.turn, 'p2', 'the other player starts story two');
  assert.notEqual(h.s.opening, first.opening);
  assert.equal(h.s.highlights.length, 1);
  const again = h.s;
  h.act('p1', { type: 'again' });
  assert.equal(h.s, again, 'again only once done (double tap absorbed)');

  write(h, 7);
  h.act('p2', { type: 'end' });
  h.act('p2', { type: 'finish', title: 'Second' });
  assert.equal(h.s.points, 8 + 9);
  assert.equal(h.s.plays, 2);
  assert.match(h.s.summary, /^Wrote 2 stories together — latest: “Second” \(7 lines\)$/);
  assert.equal(h.s.highlights.length, 2);

  // AI opening for the next story is validated too.
  h.act('p1', { type: 'again', content: { title: 'The Snail Express', opening: 'The fastest snail in the world had a train to catch.' } });
  assert.equal(h.s.src, 'ai');
  assert.equal(h.s.title, 'The Snail Express');
  assert.equal(h.s.turn, 'p1');
  write(h, MIN_LINES);
  h.act('p1', { type: 'end' });
  h.act('p1', { type: 'finish', title: 'Third' });
  h.act('p2', { type: 'again', content: { opening: 3 } });
  assert.equal(h.s.src, 'bank');
});

test('openings do not repeat across several stories in one sitting', () => {
  const h = gameHarness(story);
  const seen = new Set([h.s.opening]);
  for (let k = 0; k < 8; k++) {
    write(h, MIN_LINES);
    h.act('p1', { type: 'end' });
    h.act('p2', { type: 'finish', title: `Story ${k}` });
    h.act('p1', { type: 'again' });
    assert.ok(!seen.has(h.s.opening), `story ${k + 2} has a new opening`);
    seen.add(h.s.opening);
  }
  assert.ok(h.s.highlights.length <= 6);
});

// ------------------------------------------------------------------ over the network

test('a story over the real session: simultaneous twist + end taps apply once', async () => {
  const { a, b, time } = await makePair();
  a.dispatch({ type: 'startGame', id: 'story' });
  time.flush();
  const g = () => a.state.game.s;
  assert.equal(g().turn, 'aaa');
  a.dispatch({ type: 'game', a: { type: 'line', text: 'Once there was a sock.' } });
  time.flush();
  b.dispatch({ type: 'game', a: { type: 'line', text: 'It wanted adventure.' } });
  time.flush();
  const at = g().lines.length;
  a.dispatch({ type: 'game', a: { type: 'twist', at } });
  b.dispatch({ type: 'game', a: { type: 'twist', at } });
  time.flush();
  assert.equal(g().twists, 1);
  for (let i = 0; i < 4; i++) {
    const turn = g().turn === 'aaa' ? a : b;
    turn.dispatch({ type: 'game', a: { type: 'line', text: `Line ${i + 3}.` } });
    time.flush();
  }
  a.dispatch({ type: 'game', a: { type: 'end' } });
  b.dispatch({ type: 'game', a: { type: 'end' } });
  time.flush();
  assert.equal(g().phase, 'ending');
  assert.equal(g().ending.by, 'aaa');
  // Both bind at once: whichever reaches the authority first wins, the other is dropped.
  a.dispatch({ type: 'game', a: { type: 'finish', title: 'The Sock Odyssey' } });
  b.dispatch({ type: 'game', a: { type: 'finish', title: 'Second title loses' } });
  time.flush();
  assert.equal(g().book.title, 'The Sock Odyssey');
  assert.deepEqual(a.state, b.state);
  b.dispatch({ type: 'endGame' });
  time.flush();
  assert.equal(a.state.scores.together, 6 + FINISH_POINTS);
  assert.match(a.state.history[0].summary, /The Sock Odyssey/);
  assert.equal(a.state.history[0].highlights.length, 1);
});
