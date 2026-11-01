import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPair, loadPlaywright, SHOTS } from './harness.js';

const PAPER = [255, 250, 243];

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

/** Drag the mouse across the board; points are fractions of the board. */
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

const LEFT = [0, 0.48];
const RIGHT = [0.52, 1];

test('Duet Canvas: both draw at once, undo/clear/resync, finish together and frame it', { skip: !loadPlaywright() && 'playwright missing', timeout: 120000 }, async () => {
  const t = await openPair();
  const { a, b } = t;
  try {
    await t.startGame('duet', b);
    const prompt = await a.locator('.duet-prompt .prompt-text span').innerText();
    assert.ok(prompt.length > 3);
    await b.locator('.duet-prompt', { hasText: prompt }).waitFor();
    assert.ok(await a.getByRole('button', { name: /We're done/ }).isDisabled(), 'nothing drawn yet');
    await a.waitForTimeout(400);
    await t.shot(a, 'duet-start-a');

    // ---- both draw at the same time: Alex on the left, Blair on the right
    await Promise.all([
      scribble(a, [0.08, 0.2], [0.42, 0.8], { steps: 24 }),
      scribble(b, [0.58, 0.8], [0.92, 0.2], { steps: 24 }),
    ]);
    await waitInk(a, (n) => n > 30, { region: RIGHT, what: "Blair's line on A" });
    await waitInk(b, (n) => n > 30, { region: LEFT, what: "Alex's line on B" });
    const aLeft = await inkCount(a, LEFT);
    const bLeft = await inkCount(b, LEFT);
    assert.ok(Math.abs(aLeft - bLeft) <= Math.max(6, aLeft * 0.05), `same drawing on both screens (${aLeft} vs ${bLeft})`);

    // ---- partner pen dot while Blair keeps drawing
    await scribble(b, [0.6, 0.55], [0.85, 0.6], { up: false });
    await a.locator('.pen-dot.on').waitFor({ state: 'attached', timeout: 3000 });
    await a.waitForTimeout(200);
    await t.shot(a, 'duet-draw-a-pen');
    await b.mouse.up();
    await t.shot(b, 'duet-draw-b');

    // ---- undo only removes your own line, on both screens
    const aRightBefore = await waitInk(a, (n) => n > 0, { region: RIGHT });
    await b.getByRole('button', { name: 'Undo' }).click();
    await waitInk(a, (n) => n < aRightBefore - 10, { region: RIGHT, what: 'undo on A' });
    assert.ok((await inkCount(a, LEFT)) >= aLeft - 5, "Alex's line untouched");

    // ---- resync after a refresh with nothing stored locally: the partner sends the drawing
    await b.evaluate(() => sessionStorage.clear());
    await b.reload();
    await b.locator('.game .board-canvas').waitFor({ timeout: 15000 });
    await waitInk(b, (n) => n > 30, { region: LEFT, timeout: 8000, what: 'resync after reload' });

    // ---- mirror mode draws a symmetric twin
    const twinZone = [0.05, 0.35];
    const beforeTwin = await waitInk(a, () => true, { region: twinZone });
    await b.getByRole('button', { name: 'Mirror mode' }).click();
    await scribble(b, [0.7, 0.9], [0.9, 0.95], { wobble: 0 });
    await waitInk(a, (n) => n > beforeTwin + 10, { region: twinZone, what: 'mirrored twin on A' });

    // ---- clear (either player, asks twice) wipes both screens
    await a.getByRole('button', { name: 'Clear' }).click();
    await a.getByRole('button', { name: 'Tap again to clear' }).click();
    await waitInk(b, (n) => n === 0, { what: 'clear on B' });
    assert.equal(await inkCount(a), 0);
    await b.getByText('Alex cleared the canvas').waitFor();

    // ---- new prompt (either player)
    await b.getByRole('button', { name: 'New prompt' }).click();
    await a.locator('.duet-prompt .prompt-text span').filter({ hasNotText: prompt }).waitFor();
    const prompt2 = await a.locator('.duet-prompt .prompt-text span').innerText();
    assert.notEqual(prompt2, prompt);

    // ---- a little drawing, then "We're done!" from both
    await Promise.all([
      scribble(a, [0.2, 0.3], [0.45, 0.35], { steps: 16 }),
      scribble(b, [0.55, 0.6], [0.85, 0.7], { steps: 16 }),
    ]);
    await waitInk(a, (n) => n > 30, { region: RIGHT });
    await a.getByRole('button', { name: /We're done/ }).click();
    await b.getByText('Alex thinks it\'s finished').waitFor();
    await a.getByText(/Waiting for Blair/).waitFor();
    await b.waitForTimeout(500);
    await t.shot(b, 'duet-ready-b');
    await t.shot(a, 'duet-ready-a');
    await b.getByRole('button', { name: /We're done/ }).click();
    await a.getByText('Masterpiece!').waitFor();
    await b.getByText('Masterpiece!').waitFor();
    assert.equal(await a.locator('.draw-tools').count(), 0, 'tools hidden on the framed view');
    assert.ok((await inkCount(a)) > 30 && (await inkCount(b)) > 30, 'masterpiece stays on screen');
    await a.waitForTimeout(1500);
    await t.shot(a, 'duet-done-a');
    await t.shot(b, 'duet-done-b');

    const [download] = await Promise.all([b.waitForEvent('download'), b.getByRole('button', { name: /Save as PNG/ }).click()]);
    assert.match(download.suggestedFilename(), /^duet-.+\.png$/);
    await download.saveAs(`${SHOTS}duet-export.png`);

    // ---- new canvas: empty board, fresh prompt, cumulative points; at 360 px wide
    await a.setViewportSize({ width: 360, height: 760 });
    await a.getByRole('button', { name: 'New canvas' }).click();
    await b.locator('.duet-prompt').waitFor();
    await a.locator('.chip', { hasText: 'Canvas 2' }).waitFor();
    await waitInk(a, (n) => n === 0, { what: 'fresh canvas' });
    await scribble(a, [0.3, 0.3], [0.7, 0.7]);
    await waitInk(b, (n) => n > 30, { what: 'canvas 2 stroke on B' });
    await a.waitForTimeout(300);
    await t.shot(a, 'duet-draw-a-360');
    await a.getByRole('button', { name: /We're done/ }).click();
    await b.getByRole('button', { name: /We're done/ }).click();
    await a.getByText('Masterpiece!').waitFor();
    await a.locator('.duet-thumbs img').first().waitFor();
    await a.waitForTimeout(1500);
    await t.shot(a, 'duet-done-a-360');

    await t.backToLobby(a);
    await a.locator('.score-pill', { hasText: '6' }).waitFor();
    await b.locator('.score-pill', { hasText: '6' }).waitFor();
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});
