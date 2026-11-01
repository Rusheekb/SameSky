import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPair, loadPlaywright, SHOTS } from './harness.js';

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

    // Play again keeps the running total, then back to the lobby.
    await b.getByRole('button', { name: 'Play again' }).click();
    await a.locator('.chip', { hasText: 'Round 1 / 8' }).waitFor();
    await b.locator('.km-skip', { hasText: '3 left' }).waitFor();
    await t.backToLobby(a);
    await a.locator('.score-pill', { hasText: String(expected) }).waitFor();
    await b.locator('.score-pill', { hasText: String(expected) }).waitFor();
    console.log(`kinds played: ${kinds.join(', ')} · together points ${expected}`);
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});
