import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPair, loadPlaywright, SHOTS } from './harness.js';
import { isNear } from '../../js/games/doodle/logic.js';

const PAPER = [241, 233, 218]; // --paper (#f1e9da), the board's background

/** Non-paper pixels on the game's board (sampled), optionally only within [x0, x1] fractions. */
function inkCount(page, region = null) {
  return page.evaluate(
    ({ region, PAPER }) => {
      const c = document.querySelector('.game .board-canvas');
      if (!c || !c.width) return -1;
      const W = c.width;
      const H = c.height;
      const x0 = region ? Math.floor(region[0] * W) : 0;
      const x1 = region ? Math.floor(region[1] * W) : W;
      const d = c.getContext('2d').getImageData(x0, 0, Math.max(1, x1 - x0), H).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 16) {
        if (Math.abs(d[i] - PAPER[0]) + Math.abs(d[i + 1] - PAPER[1]) + Math.abs(d[i + 2] - PAPER[2]) > 60) n++;
      }
      return n;
    },
    { region, PAPER },
  );
}

/** Wait until the ink count satisfies `pred` and has stopped changing (strokes arrive in chunks). */
async function waitInk(page, pred, { region = null, timeout = 4000, what = 'ink' } = {}) {
  const t0 = Date.now();
  let n;
  let prev = null;
  while (Date.now() - t0 < timeout) {
    n = await inkCount(page, region);
    if (pred(n) && n === prev) return n;
    prev = n;
    await page.waitForTimeout(150);
  }
  throw new Error(`${what}: condition not met within ${timeout}ms (last count ${n})`);
}

/** Drag the mouse across the board; points are fractions of the board. `up: false` keeps the pen down. */
async function scribble(page, from, to, { steps = 14, up = true, wobble = 0.06 } = {}) {
  const box = await page.locator('.game .board-canvas').boundingBox();
  const P = ([x, y]) => [box.x + box.width * x, box.y + box.height * y];
  await page.mouse.move(...P(from));
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    await page.mouse.move(...P([from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f + Math.sin(f * 7) * wobble]));
  }
  if (up) await page.mouse.up();
}

/** A typo of `word` that the game counts as "so close" (null for very short words). */
function nearMiss(word) {
  for (let i = word.length - 1; i > 0; i--) {
    const del = word.slice(0, i) + word.slice(i + 1);
    if (isNear(del, word)) return del;
    const swap = word.slice(0, i - 1) + word[i] + word[i - 1] + word.slice(i + 1);
    if (isNear(swap, word)) return swap;
  }
  return null;
}

const hasWord = (text, word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);

test('Doodle Dash: live drawing, guesses, a correct answer, four rounds and the gallery', { skip: !loadPlaywright() && 'playwright missing', timeout: 180000 }, async () => {
  const t = await openPair();
  const { a, b } = t;
  try {
    await t.startGame('doodle');

    // ---- choose: Alex (first player) draws first; Blair can't see the options.
    await a.locator('.choose .option').first().waitFor();
    const options = await a.locator('.choose .option b').allInnerTexts();
    assert.equal(options.length, 3);
    await b.getByText('Alex is choosing a word').waitFor();
    const bText = await b.locator('.game').innerText();
    for (const w of options) assert.ok(!hasWord(bText, w), `guesser must not see option "${w}"`);
    await a.waitForTimeout(500);
    await t.shot(a, 'doodle-choose-a');
    await t.shot(b, 'doodle-choose-b');

    await a.locator('.choose .option').first().click();
    const word = options[0];
    await a.locator('.secret-word', { hasText: word }).waitFor();
    await b.locator('.game .board-canvas').waitFor();
    assert.equal(await b.locator('.secret-word').count(), 0);
    assert.ok(!hasWord(await b.locator('.game').innerText(), word), 'guesser must not see the word while drawing');
    assert.equal(await b.locator('.draw-tools').count(), 0, 'guesser has no drawing tools');
    await b.getByText('Hint unlocks at 40s').waitFor();
    await t.shot(b, 'doodle-draw-b-empty');

    // ---- live strokes reach the guesser
    await scribble(a, [0.15, 0.3], [0.45, 0.6]);
    const c1 = await waitInk(b, (n) => n > 30, { what: 'first stroke on B' });
    // Undo propagates
    await scribble(a, [0.6, 0.2], [0.9, 0.8]);
    const c2 = await waitInk(b, (n) => n > c1 + 30, { what: 'second stroke on B' });
    await a.getByRole('button', { name: 'Undo' }).click();
    await waitInk(b, (n) => n <= c1 + 5, { what: 'undo on B' });
    assert.ok(c2 > c1);
    // Clear propagates (drawer only, asks twice)
    await a.getByRole('button', { name: 'Clear' }).click();
    await a.getByRole('button', { name: 'Tap again to clear' }).click();
    await waitInk(b, (n) => n === 0, { what: 'clear on B' });
    assert.equal(await inkCount(a), 0);

    // A proper doodle, colour + size changes, and the partner's pen dot while drawing.
    await a.getByRole('radio', { name: 'Sky' }).click();
    await a.getByRole('button', { name: 'Bold brush' }).click();
    await scribble(a, [0.2, 0.7], [0.8, 0.7], { wobble: 0.1 });
    await a.getByRole('radio', { name: 'Coral' }).click();
    await a.getByRole('button', { name: 'Fine brush' }).click();
    await scribble(a, [0.5, 0.15], [0.55, 0.55], { up: false });
    await b.locator('.pen-dot.on').waitFor({ state: 'attached', timeout: 3000 });
    await t.shot(b, 'doodle-draw-b-pen');
    await a.mouse.up();
    await waitInk(b, (n) => n > 60, { what: 'doodle on B' });

    // ---- guesses stream to the drawer
    await b.getByPlaceholder('Your guess').fill('spaceship');
    await b.getByRole('button', { name: 'Guess' }).click();
    await a.locator('.bubble', { hasText: 'spaceship' }).waitFor();
    await b.getByPlaceholder('Your guess').fill('blue squiggle');
    await b.getByPlaceholder('Your guess').press('Enter');
    await a.locator('.bubble', { hasText: 'blue squiggle' }).waitFor();
    await a.waitForTimeout(400);
    await t.shot(a, 'doodle-draw-a');
    await t.shot(b, 'doodle-draw-b');

    // ---- on a laptop, the guesses and the drawer's Skip stay clear of the fixed reaction bar
    for (const p of [a, b]) await p.setViewportSize({ width: 1280, height: 800 });
    await a.waitForTimeout(300);
    for (const [p, sel] of [[a, '.skip-btn'], [a, '.guesses'], [b, '.answer-box'], [b, '.guesses']]) {
      const [el, bar] = await Promise.all([p.locator(`.game ${sel}`).boundingBox(), p.locator('.reactions').boundingBox()]);
      assert.ok(el.y + el.height <= bar.y, `${sel} (bottom ${el.y + el.height}) above the reaction bar (${bar.y}) at 1280×800`);
    }
    await t.shot(a, 'doodle-draw-a-laptop');
    for (const p of [a, b]) await p.setViewportSize({ width: 390, height: 844 });

    // ---- a typo-level near miss: "so close!" for both
    const close = nearMiss(word);
    if (close) {
      await b.getByPlaceholder('Your guess').fill(close);
      await b.getByPlaceholder('Your guess').press('Enter');
      await a.locator('.bubble.close', { hasText: 'so close' }).waitFor();
      await b.locator('.close-pop', { hasText: 'So close, check the spelling' }).waitFor();
      await a.locator('.close-pop', { hasText: `Blair is so close: “${close}”` }).waitFor();
      await t.shot(b, 'doodle-so-close-b');
    }

    // ---- correct guess (right after the near miss) -> both see the result and the drawing stays
    await b.getByPlaceholder('Your guess').fill(word.toUpperCase());
    await b.getByRole('button', { name: 'Guess' }).click();
    await a.locator('.result-word', { hasText: word }).waitFor();
    await b.locator('.result-word', { hasText: word }).waitFor();
    // The near-miss pop-up belonged to the drawing phase: nothing "so close" lingers over the result.
    for (const p of [a, b]) {
      assert.equal(await p.locator('.close-pop').count(), 0, 'no stale "So close" on the result');
      assert.equal(await p.locator('#toast.show', { hasText: /so close/i }).count(), 0, 'no stale "So close" toast');
    }
    await b.getByText(/You got it in \d+s/).waitFor();
    await a.getByText(/Blair got it in \d+s/).waitFor();
    assert.ok((await inkCount(b)) > 60, 'drawing stays on screen for the result');
    await a.waitForTimeout(700);
    await t.shot(a, 'doodle-result-a');
    await t.shot(b, 'doodle-result-b');
    const pts = Number((await a.locator('.round-result .points').innerText()).match(/\d+/)[0]);
    assert.ok(pts >= 3 && pts <= 7);

    // ---- round 2: Blair draws (on a small phone), board starts empty
    await b.setViewportSize({ width: 360, height: 740 });
    await b.getByRole('button', { name: /Next round/ }).click();
    await b.locator('.choose .option').first().waitFor();
    await a.getByText('Blair is choosing a word').waitFor();
    await b.waitForTimeout(400);
    await t.shot(b, 'doodle-choose-b-360');
    await b.getByRole('button', { name: /three others/ }).click();
    await b.locator('.choose .option').nth(1).click();
    await b.locator('.secret-word').waitFor();
    await waitInk(a, (n) => n === 0, { what: 'fresh board for round 2' });
    await scribble(b, [0.2, 0.2], [0.8, 0.8]);
    await waitInk(a, (n) => n > 30, { what: 'round 2 stroke on A' });
    await b.waitForTimeout(300);
    await t.shot(b, 'doodle-draw-b-360');
    await b.getByRole('button', { name: 'Skip this word' }).click();
    await b.getByRole('button', { name: /Tap again to skip/ }).click();
    await a.getByText(/Blair skipped this one/).waitFor();
    await b.waitForTimeout(600);
    await t.shot(b, 'doodle-result-skip-b-360');
    await a.getByRole('button', { name: /Next round/ }).click();

    // ---- rounds 3 & 4: skip through
    await a.locator('.choose .option').first().click();
    await scribble(a, [0.3, 0.5], [0.7, 0.5]);
    await a.getByRole('button', { name: 'Skip this word' }).click();
    await a.getByRole('button', { name: /Tap again to skip/ }).click();
    await b.getByRole('button', { name: /Next round/ }).click();
    await b.locator('.choose .option').first().click();
    await scribble(b, [0.4, 0.3], [0.6, 0.7]);
    // Hints arrive by tick: the letter pattern with 40 s left (the word itself stays hidden).
    const word4 = await b.locator('.secret-word').innerText();
    await a.locator('.hint').waitFor({ timeout: 45000 });
    const hint = await a.locator('.hint').innerText();
    assert.match(hint, /^[_ \n'-]+$/, `pattern only: ${hint}`);
    assert.equal(hint.replace(/[^_]/g, '').length, word4.replace(/[^\p{L}\p{N}]/gu, '').length);
    assert.ok(!hasWord(await a.locator('.game').innerText(), word4));
    await t.shot(a, 'doodle-hint-a');
    await b.getByRole('button', { name: 'Skip this word' }).click();
    await b.getByRole('button', { name: /Tap again to skip/ }).click();
    await a.getByRole('button', { name: 'See our results' }).click();

    // ---- final: totals + gallery of all four rounds
    await a.getByText("That's a wrap").waitFor();
    await b.getByText("That's a wrap").waitFor();
    await a.locator('.gallery-item img').nth(3).waitFor();
    await b.locator('.gallery-item img').nth(3).waitFor();
    assert.equal(await a.locator('.gallery-item').count(), 4);
    await a.waitForTimeout(900);
    await t.shot(a, 'doodle-final-a');
    await t.shot(b, 'doodle-final-b-360');
    const total = Number((await a.locator('.final .big').innerText()).match(/\d+/)[0]);
    assert.equal(total, pts);

    const [download] = await Promise.all([a.waitForEvent('download'), a.getByRole('button', { name: /Save our doodles/ }).click()]);
    assert.equal(download.suggestedFilename(), 'our-doodles.png');
    await download.saveAs(`${SHOTS}doodle-export-collage.png`);

    await t.backToLobby(b);
    await a.locator('.score-pill', { hasText: String(total) }).waitFor();
    await b.locator('.score-pill', { hasText: String(total) }).waitFor();
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});
