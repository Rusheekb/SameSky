import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPair, loadPlaywright, SHOTS, PHONE } from './harness.js';
import { startServer } from '../../scripts/serve.js';

// Plays all 8 rounds of Know Me Better on two real pages. Question kinds are random, so every
// round inspects the screen and answers whatever kind it got (choice / scale / open), aiming for
// a planned outcome (hit / close / miss) and tallying the expected together points.

const PLAN = ['hit', 'miss', 'close', 'hit', 'miss', 'close', 'hit', 'hit'];
const OPEN = {
  hit: ['Lisbon sunsets', 'lisbon sunset'], // word-for-word: scores itself
  close: ['Pancakes at noon', 'Pancakes'], // subject judges "Close enough"
  miss: ['Mount Fuji at dawn', 'Paris'], // subject judges "Nope"
};
const SCALE = { hit: [7, 7], close: [7, 8], miss: [3, 9] };
const CHOICE = { hit: [1, 1], close: [2, 2], miss: [0, 3] };

async function kindOf(page) {
  const q = page.locator('.km-answer');
  await q.waitFor();
  if (await q.locator('.km-options').count()) return 'choice';
  if (await q.locator('.km-scale-btns').count()) return 'scale';
  await q.locator('.km-open input').waitFor();
  return 'open';
}

async function answer(page, kind, value) {
  if (kind === 'choice') {
    await page.locator('.km-opt').nth(value).click();
    await page.locator('.km-lock').click();
  } else if (kind === 'scale') {
    await page.getByRole('radio', { name: `${value} of 10` }).click();
    await page.locator('.km-lock').click();
  } else {
    await page.locator('.km-open input').fill(value);
    await page.locator('.km-open button[type=submit]').click();
  }
}

const show = (kind, v, options) => (kind === 'choice' ? options[v] : kind === 'scale' ? `${v}/10` : v);

/** Leave a running game through the header ✕ (it asks for a second tap before leaving). */
async function leaveMidGame(page) {
  await page.locator('.game-header .game-meta button').last().click();
  const again = page.getByRole('button', { name: /again to leave/i });
  await again.or(page.locator('.game-grid')).first().waitFor();
  if (await again.count()) await again.click();
}

test('Know Me Better: 8 rounds on two phones, secrets hidden until the flip', { skip: !loadPlaywright() && 'playwright missing', timeout: 180000 }, async () => {
  const t = await openPair();
  const { a, b } = t;
  const shots = new Set();
  const shotOnce = async (page, name) => {
    if (shots.has(name)) return;
    shots.add(name);
    await t.shot(page, name);
  };
  try {
    await t.startGame('knowme');
    await a.locator('.game.knowme .km-prompt').waitFor();
    await b.locator('.game.knowme .km-prompt').waitFor();

    // ---- round 1: Alex is in the spotlight, Blair guesses.
    await a.locator('.km-about', { hasText: 'About you' }).waitFor();
    await b.locator('.km-about', { hasText: 'About Alex' }).waitFor();
    await a.locator('.km-hint', { hasText: 'Blair is guessing' }).waitFor();
    await b.locator('.km-hint', { hasText: 'What would Alex say' }).waitFor();
    await a.waitForTimeout(400);
    const k0 = await kindOf(a);
    await t.shot(a, `knowme-answer-subject-${k0}`);
    await t.shot(b, `knowme-answer-guesser-${k0}`);
    shots.add(`subject-${k0}`).add(`guesser-${k0}`);

    // Skip: Alex locks in, then Blair skips -> a fresh question and Alex's lock is cleared.
    const q0 = await a.locator('.km-q').textContent();
    await answer(a, k0, k0 === 'choice' ? 0 : k0 === 'scale' ? 5 : 'Something');
    await b.locator('.lock.is-locked', { hasText: 'Alex' }).waitFor();
    await b.locator('.km-skip', { hasText: '3 left' }).click();
    await a.locator('.km-skip', { hasText: '2 left' }).waitFor();
    await b.locator('.km-skip', { hasText: '2 left' }).waitFor();
    await a.locator('#toast.show', { hasText: 'Blair skipped' }).waitFor();
    assert.notEqual(await a.locator('.km-q').textContent(), q0, 'skip swaps the question');
    assert.equal(await a.locator('.km-locked').count(), 0, 'skip clears locked answers');
    assert.equal(await a.locator('.lock.is-locked').count(), 0);

    let expected = 0;
    const kinds = [];
    for (let r = 1; r <= 8; r++) {
      await a.locator('.chip', { hasText: `Round ${r} / 8` }).waitFor();
      await b.locator('.chip', { hasText: `Round ${r} / 8` }).waitFor();
      const aIsSubject = r % 2 === 1;
      const subj = aIsSubject ? a : b;
      const gues = aIsSubject ? b : a;
      const subjName = aIsSubject ? 'Alex' : 'Blair';
      const guesName = aIsSubject ? 'Blair' : 'Alex';
      await subj.locator('.km-about', { hasText: 'About you' }).waitFor();
      await gues.locator('.km-about', { hasText: `About ${subjName}` }).waitFor();

      const kind = await kindOf(subj);
      assert.equal(await kindOf(gues), kind);
      kinds.push(kind);
      const plan = PLAN[r - 1];
      const [real, guess] = kind === 'choice' ? CHOICE[plan] : kind === 'scale' ? SCALE[plan] : OPEN[plan];
      const options = kind === 'choice' ? await subj.locator('.km-opt').allTextContents() : [];
      const opts = options.map((o) => o.replace(/^[A-D]/, '').trim());

      await subj.waitForTimeout(350);
      await shotOnce(subj, `knowme-answer-subject-${kind}`);
      await shotOnce(gues, `knowme-answer-guesser-${kind}`);

      // The subject locks in first: the guesser sees "locked in" but never the answer itself.
      await answer(subj, kind, real);
      await subj.locator('.km-locked', { hasText: show(kind, real, opts) }).waitFor();
      await gues.locator('.lock.is-locked', { hasText: subjName }).waitFor();
      assert.equal(await gues.locator('.km-flip').count(), 0, 'no reveal for the guesser yet');
      assert.equal(await gues.locator('.km-opt.sel, .km-num.sel').count(), 0, 'no hint of the pick');
      if (kind !== 'choice') {
        const text = await gues.locator('.game').innerText();
        assert.ok(!text.includes(show(kind, real, opts)), `guesser must not see "${show(kind, real, opts)}" before reveal`);
      }
      await subj.waitForTimeout(400);
      await shotOnce(subj, `knowme-locked-subject-${kind}`);
      await shotOnce(gues, `knowme-locked-guesser-${kind}`);

      await answer(gues, kind, guess);

      // ---- flip!
      const realText = show(kind, real, opts);
      const guessText = show(kind, guess, opts);
      for (const p of [a, b]) {
        await p.locator('.km-flip', { hasText: realText }).first().waitFor();
        await p.locator('.km-flip', { hasText: guessText }).first().waitFor();
      }
      if (kind === 'scale') {
        await a.locator('.km-track').waitFor();
        await b.locator('.km-track').waitFor();
      }

      let points;
      if (kind === 'open' && plan !== 'hit') {
        // The subject judges; the guesser waits.
        await subj.getByRole('button', { name: /Close enough/ }).waitFor();
        await gues.getByText(`Waiting for ${subjName} to judge`).waitFor();
        assert.equal(await gues.getByRole('button', { name: /Nailed it/ }).count(), 0, 'only the subject judges');
        await subj.waitForTimeout(1300);
        await shotOnce(subj, 'knowme-judge-subject');
        await shotOnce(gues, 'knowme-judge-guesser');
        await subj.getByRole('button', { name: plan === 'close' ? /Close enough/ : /Nope/ }).click();
        points = plan === 'close' ? 1 : 0;
        await gues.locator('.km-result', { hasText: plan === 'close' ? 'close enough' : 'nope' }).waitFor();
      } else if (kind === 'choice') {
        points = real === guess ? 2 : 0;
      } else if (kind === 'scale') {
        points = Math.abs(real - guess) === 0 ? 2 : Math.abs(real - guess) === 1 ? 1 : 0;
      } else {
        points = 2; // word-for-word
        await a.locator('.km-result', { hasText: 'Word for word' }).waitFor();
      }
      expected += points;
      await a.locator('.km-result').waitFor();
      await b.locator('.km-result').waitFor();
      if (points > 0) await a.locator('.km-result', { hasText: `+${points} together point` }).waitFor();
      await a.waitForTimeout(1300);
      const outcome = points === 2 ? 'hit' : points === 1 ? 'close' : 'miss';
      await shotOnce(subj, `knowme-reveal-${kind}-${outcome}-subject`);
      await shotOnce(gues, `knowme-reveal-${kind}-${outcome}-guesser`);

      if (r === 4) {
        // Narrowest supported phone.
        await b.setViewportSize({ width: 360, height: 740 });
        await b.waitForTimeout(300);
        await t.shot(b, 'knowme-360-reveal');
      }

      await (r % 2 ? b : a).locator('.km-result .btn-primary').click();
      if (r === 4) {
        await a.locator('.chip', { hasText: 'Round 5 / 8' }).waitFor();
        await b.waitForTimeout(500);
        await t.shot(b, 'knowme-360-answer');
        await b.setViewportSize({ width: 390, height: 844 });
      }
    }

    // ---- final screen
    for (const p of [a, b]) {
      await p.locator('.km-final').waitFor();
      await p.locator('.km-gained', { hasText: `+${expected}` }).waitFor();
      await p.locator('.km-tally-card').first().waitFor();
    }
    assert.match(await a.locator('.km-tally').innerText(), /You know Blair/);
    assert.match(await a.locator('.km-tally').innerText(), /Blair knows you/);
    assert.match(await b.locator('.km-tally').innerText(), /You know Alex/);
    assert.equal(await a.locator('.km-log li').count(), 8);
    for (const p of [a, b]) assert.equal(await p.locator('#toast.show', { hasText: 'skipped' }).count(), 0, 'no stale skip toast');
    await a.waitForTimeout(700);
    await t.shot(a, 'knowme-final-a');
    await t.shot(b, 'knowme-final-b');
    await a.screenshot({ path: `${SHOTS}knowme-final-full.png`, fullPage: true });

    // Play again keeps the running total; two spot-on rounds, then leave mid-game through ✕.
    await b.getByRole('button', { name: 'Play again' }).click();
    await a.locator('.chip', { hasText: 'Round 1 / 8' }).waitFor();
    await b.locator('.km-skip', { hasText: '3 left' }).waitFor();
    for (let r = 1; r <= 2; r++) {
      await a.locator('.chip', { hasText: `Round ${r} / 8` }).waitFor();
      const kind = await kindOf(a);
      const [real, guess] = kind === 'choice' ? CHOICE.hit : kind === 'scale' ? SCALE.hit : OPEN.hit;
      await answer(r % 2 ? a : b, kind, real);
      await answer(r % 2 ? b : a, kind, guess);
      await a.locator('.km-result', { hasText: '+2 together points' }).waitFor();
      await a.locator('.km-result .btn-primary').click();
    }
    await a.locator('.chip', { hasText: 'Round 3 / 8' }).waitFor();
    await leaveMidGame(a);
    for (const p of [a, b]) await p.locator('.game-grid').waitFor({ timeout: 10000 });
    for (const p of [a, b]) await p.locator('.score-pill', { hasText: String(expected + 4) }).waitFor();
    // The night recap keeps a running line for the unfinished game, not just "Ended early".
    await b.locator('.score-pill').click();
    const recap = b.getByRole('dialog', { name: 'Our night so far' });
    await recap.waitFor();
    const lines = await recap.locator('.history li').allInnerTexts();
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /\+(\d+)/);
    assert.equal(Number(lines[0].match(/\+(\d+)/)[1]), expected + 4);
    assert.match(lines[0], /Over 1 game and 2 rounds: Alex knew Blair \d+\/5, Blair knew Alex \d+\/5/);
    await t.shot(b, 'knowme-recap-after-leaving');
    console.log(`kinds played: ${kinds.join(', ')} · together points ${expected + 4}`);
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- long names on a narrow phone

/**
 * Nothing in the game may stick out of the screen (mobile Chrome would zoom the whole page out),
 * the flip cards must stay inside their half of the row, and every answer must be fully readable.
 */
async function assertFits(page, where) {
  // Measure the settled layout, not a frame of the flip (it scales the cards up to 103 %).
  await page.evaluate(() => document.getAnimations().forEach((an) => an.effect?.getComputedTiming().endTime !== Infinity && an.finish()));
  const m = await page.evaluate(() => {
    const vw = innerWidth;
    const bad = [];
    const box = (el) => el.getBoundingClientRect();
    const tag = (el) => `${el.tagName}.${String(el.className).trim().replace(/\s+/g, '.')}`;
    for (const el of document.querySelectorAll('.game.knowme *')) {
      const r = box(el);
      if (r.width && (r.right > vw + 0.5 || r.left < -0.5)) bad.push(`${tag(el)} off screen [${Math.round(r.left)}, ${Math.round(r.right)}]`);
    }
    for (const flip of document.querySelectorAll('.km-flip')) {
      const cell = box(flip);
      for (const face of flip.querySelectorAll('.km-face')) {
        const r = box(face);
        if (r.left < cell.left - 0.5 || r.right > cell.right + 0.5) bad.push(`${tag(face)} wider than its card [${Math.round(r.left)}, ${Math.round(r.right)}] vs [${Math.round(cell.left)}, ${Math.round(cell.right)}]`);
      }
      const front = box(flip.querySelector('.km-front'));
      const value = flip.querySelector('.km-face-value');
      if (value.scrollWidth > value.clientWidth + 1 || box(value).right > front.right + 0.5) bad.push(`answer clipped: "${value.textContent}"`);
      // The whole "<Name>’s guess" label is readable: inside the card and nothing cut off.
      const who = flip.querySelector('.km-face-who');
      const wr = box(who);
      if (!wr.width || wr.left < front.left || wr.right > front.right - 4 || who.scrollWidth > who.clientWidth + 1 || who.scrollHeight > who.clientHeight + 1)
        bad.push(`label cut: "${who.textContent}" [${Math.round(wr.left)}, ${Math.round(wr.right)}] in [${Math.round(front.left)}, ${Math.round(front.right)}]`);
    }
    const cards = [...document.querySelectorAll('.km-flip')].map(box);
    if (cards.length === 2 && cards[0].right > cards[1].left) bad.push('flip cards overlap');
    const vs = document.querySelector('.km-vs');
    if (vs && cards.length === 2) {
      const c = (box(vs).left + box(vs).right) / 2;
      if (Math.abs(c - (cards[0].right + cards[1].left) / 2) > 1.5) bad.push('≠ badge off centre');
    }
    return { vw, sw: document.documentElement.scrollWidth, bad };
  });
  assert.deepEqual(m.bad, [], `${where}: ${m.bad.join('; ')}`);
  assert.ok(m.sw <= m.vw, `${where}: page is ${m.sw}px wide on a ${m.vw}px screen`);
}

const LONG = ['Bartholomew-Alexandrina', 'Wilhelmina-Rosalind-Jane'];
const LONG_OPEN = ['Showing off every single dance move', 'Singing in the shower, loudly'];

test('Know Me Better: 24-character names fit a 360px phone on every screen', { skip: !loadPlaywright() && 'playwright missing', timeout: 180000 }, async () => {
  const t = await openPair({ viewport: { width: 360, height: 640 }, names: LONG });
  const { a, b } = t;
  const shots = new Set();
  const shotOnce = async (page, name) => {
    if (shots.has(name)) return;
    shots.add(name);
    await t.shot(page, name);
  };
  try {
    await t.startGame('knowme');
    for (let r = 1; r <= 8; r++) {
      if (r === 5) for (const p of [a, b]) await p.setViewportSize({ width: 390, height: 844 });
      const w = r < 5 ? 360 : 390;
      await a.locator('.chip', { hasText: `${r} / 8` }).waitFor();
      await b.locator('.chip', { hasText: `${r} / 8` }).waitFor();
      const subj = r % 2 ? a : b;
      const gues = r % 2 ? b : a;
      const kind = await kindOf(subj);
      assert.equal(await kindOf(gues), kind);
      await subj.waitForTimeout(400);
      await assertFits(subj, `${w} round ${r} answer (subject)`);
      await assertFits(gues, `${w} round ${r} answer (guesser)`);
      await shotOnce(subj, `knowme-long-${w}-answer-${kind}-subject`);
      await shotOnce(gues, `knowme-long-${w}-answer-${kind}-guesser`);

      // Always a miss, so open answers go to the judge screen (both long texts on the cards).
      const [real, guess] = kind === 'open' ? LONG_OPEN : kind === 'scale' ? [3, 9] : [3, 0];
      await answer(subj, kind, real);
      await subj.locator('.km-locked').waitFor();
      await gues.locator('.lock.is-locked').first().waitFor();
      await subj.waitForTimeout(300);
      await assertFits(subj, `${w} round ${r} locked in (subject)`);
      await assertFits(gues, `${w} round ${r} partner locked (guesser)`);
      await shotOnce(subj, `knowme-long-${w}-locked-subject`);
      await answer(gues, kind, guess);
      for (const p of [a, b]) await p.locator('.km-flip').nth(1).waitFor();

      if (kind === 'open') {
        await subj.getByRole('button', { name: /Nope/ }).waitFor();
        for (const p of [a, b]) {
          await p.locator('.km-flip', { hasText: LONG_OPEN[0] }).waitFor();
          await p.locator('.km-flip', { hasText: LONG_OPEN[1] }).waitFor();
        }
        await assertFits(subj, `${w} round ${r} judge (subject)`);
        await assertFits(gues, `${w} round ${r} judge (guesser)`);
        await shotOnce(subj, `knowme-long-${w}-judge-subject`);
        await shotOnce(gues, `knowme-long-${w}-judge-guesser`);
        await subj.getByRole('button', { name: /Nope/ }).click();
      }
      for (const p of [a, b]) await p.locator('.km-result').waitFor();
      // Both labels say whose card it is: mine reads "Your …", the partner's keeps "’s answer/guess".
      const [subjName, guesName] = r % 2 ? LONG : [LONG[1], LONG[0]];
      assert.deepEqual(await subj.locator('.km-face-who').allTextContents(), ['Your answer', `${guesName}’s guess`]);
      assert.deepEqual(await gues.locator('.km-face-who').allTextContents(), [`${subjName}’s answer`, 'Your guess']);
      await assertFits(subj, `${w} round ${r} reveal (subject)`);
      await assertFits(gues, `${w} round ${r} reveal (guesser)`);
      await shotOnce(subj, `knowme-long-${w}-reveal-${kind}-subject`);
      await shotOnce(gues, `knowme-long-${w}-reveal-${kind}-guesser`);
      await gues.locator('.km-result .btn-primary').click();
    }
    for (const p of [a, b]) await p.locator('.km-final').waitFor();
    for (const [w, h] of [[390, 844], [360, 640]]) {
      for (const p of [a, b]) await p.setViewportSize({ width: w, height: h });
      await a.waitForTimeout(300);
      await assertFits(a, `${w} final (a)`);
      await assertFits(b, `${w} final (b)`);
      await t.shot(a, `knowme-long-${w}-final-a`);
      await t.shot(b, `knowme-long-${w}-final-b`);
    }
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- open answer box (render test)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="css/app.css"><link rel="stylesheet" href="css/games.css"></head>
<body><main id="root" class="app"></main><script type="module">
import { html, render } from './js/ui/h.js';
import * as km from './js/games/knowme/logic.js';
import View from './js/games/knowme/view.js';
import { seededRandom } from './js/lib/util.js';
const P = {
  p1: { id: 'p1', name: 'Alex', avatar: '🦊', color: '#ff7eb6', tz: 'UTC' },
  p2: { id: 'p2', name: 'Blair', avatar: '🐼', color: '#6ec8ff', tz: 'UTC' },
};
const acts = [];
const noop = () => {};
const api = {
  meId: 'p2', me: P.p2, partner: P.p1, partnerOnline: true, players: ['p1', 'p2'], player: (id) => P[id],
  names: { p1: 'Alex', p2: 'Blair' }, settings: { vibe: 'sweet', ai: false, aboutUs: '' }, now: () => 0,
  act: (a) => acts.push(a), end: noop, confirmEnd: noop, fx: { send: noop, on: () => noop }, ai: { enabled: false },
  effects: { confetti: noop, floatEmoji: noop, toast: noop, sound: noop, heartPulse: noop },
};
const ctx = (by) => ({ players: ['p1', 'p2'], names: api.names, by, now: 0, random: seededRandom(1), settings: api.settings });
let s = km.init(ctx('p1'), {});
// Blair guesses an open question; the first spare is open too (same component, new question).
s = { ...s, q: { id: 'x1', text: 'Dream travel destination', kind: 'open' }, spares: [{ id: 'x2', text: 'Biggest pet peeve', kind: 'open' }, ...s.spares] };
const show = () => render(html\`<\${View} s=\${s} api=\${api} meta=\${km.meta} />\`, document.getElementById('root'));
window.km = {
  acts,
  act(by, a) { s = km.reduce(s, { ...a, by }, ctx(by)); show(); },
};
show();
window.ready = true;
</script></body></html>`;

test('Know Me Better: a skip empties a half-typed answer; a lost submit keeps it', { skip: !loadPlaywright() && 'playwright missing', timeout: 60000 }, async () => {
  const pw = loadPlaywright();
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: PHONE });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.route(`${base}__knowme-view.html`, (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));
    await page.goto(`${base}__knowme-view.html`);
    await page.waitForFunction(() => window.ready === true);
    const input = page.locator('.km-open input');
    await page.locator('.km-q', { hasText: 'Dream travel destination' }).waitFor();
    await input.fill('Lisbon');

    // Alex skips while Blair is still typing: the new question starts with an empty box.
    await page.evaluate(() => window.km.act('p1', { type: 'skip', q: 'x1' }));
    await page.locator('.km-q', { hasText: 'Biggest pet peeve' }).waitFor();
    assert.equal(await input.inputValue(), '', 'half-typed text for the old question is gone');
    assert.equal(await page.locator('.km-open button[type=submit]').isDisabled(), true);

    // Blair answers, but the action never reaches the authority: the text is still there to resend.
    await input.fill('Loud chewing');
    await page.locator('.km-open button[type=submit]').click();
    assert.deepEqual(await page.evaluate(() => window.km.acts), [{ type: 'answer', value: 'Loud chewing', q: 'x2' }]);
    assert.equal(await input.inputValue(), 'Loud chewing', 'a submit that was not accepted keeps the text');

    // Once the authority accepts it, the box makes way for the locked card.
    await page.evaluate(() => window.km.act('p2', { type: 'answer', value: 'Loud chewing', q: 'x2' }));
    await page.locator('.km-locked', { hasText: 'Loud chewing' }).waitFor();
    assert.equal(await input.count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
});
