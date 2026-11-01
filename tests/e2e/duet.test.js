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

/** The running game's state as this page last saved it. */
async function gameState(t, page) {
  const slot = page === t.a ? 'a' : 'b';
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k))?.game?.s, `samesky:${slot}:room:${t.room}`);
}

/**
 * Wrap this page's BroadcastChannel so the test can drop outgoing fx messages (Supabase broadcast
 * is at-most-once), count them, and add latency: `window.__drop = (kind, data) => bool` decides
 * what's lost, `window.__delay = ms` holds every outgoing message back (still in order).
 */
function installLossyNet(page) {
  return page.evaluate(() => {
    window.__sent = {};
    window.__dropped = 0;
    window.__drop = null;
    window.__delay = 0;
    if (window.__lossy) return;
    window.__lossy = true;
    const orig = BroadcastChannel.prototype.postMessage;
    const queue = [];
    let timer = null;
    const pump = () => {
      timer = null;
      while (queue.length && queue[0].at <= Date.now()) {
        const { ch, m } = queue.shift();
        orig.call(ch, m);
      }
      if (queue.length) timer = setTimeout(pump, 10);
    };
    BroadcastChannel.prototype.postMessage = function (m) {
      if (m && m.t === 'fx') {
        const kind = String(m.kind).split(':').pop();
        window.__sent[kind] = (window.__sent[kind] || 0) + 1;
        if (window.__drop?.(kind, m.data)) {
          window.__dropped++;
          return undefined;
        }
      }
      if (window.__delay || queue.length) {
        queue.push({ ch: this, m, at: Date.now() + (window.__delay || 0) });
        if (!timer) timer = setTimeout(pump, 10);
        return undefined;
      }
      return orig.call(this, m);
    };
  });
}

/** The board this page has stored for the current canvas: epoch + [id, length] per stroke. */
function storedBoard(page) {
  return page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('samesky:board:'));
    const b = key && JSON.parse(sessionStorage.getItem(key));
    if (!b) return null;
    return { epoch: b.epoch, strokes: b.strokes.map((s) => `${s.id}:${Math.max(s.pts.length, s.n || 0)}`).sort() };
  });
}

async function waitSameBoards(a, b, { timeout = 12000, what = 'boards converge' } = {}) {
  const t0 = Date.now();
  let ba;
  let bb;
  while (Date.now() - t0 < timeout) {
    [ba, bb] = await Promise.all([storedBoard(a), storedBoard(b)]);
    if (ba && bb && JSON.stringify(ba) === JSON.stringify(bb)) return ba;
    await a.waitForTimeout(250);
  }
  throw new Error(`${what}: still different after ${timeout}ms\nA ${JSON.stringify(ba)}\nB ${JSON.stringify(bb)}`);
}

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
    let prompt2 = await a.locator('.duet-prompt .prompt-text span').innerText();
    assert.notEqual(prompt2, prompt);

    // ---- both tap 🔀 at the same moment (over a 400 ms link, so neither has seen the other's
    // swap yet): one new prompt, not two — nobody's prompt is skipped unseen
    await b.locator('.duet-prompt', { hasText: prompt2 }).waitFor();
    const shuffles0 = (await gameState(t, a)).shuffles;
    for (const p of [a, b]) await installLossyNet(p);
    await Promise.all([a, b].map((p) => p.evaluate(() => (window.__delay = 400))));
    await Promise.all([a, b].map((p) => p.evaluate(() => document.querySelector('button[aria-label="New prompt"]').click())));
    await Promise.all([a, b].map((p) => p.evaluate(() => (window.__delay = 0))));
    await a.locator('.duet-prompt .prompt-text span').filter({ hasNotText: prompt2 }).waitFor();
    await a.waitForTimeout(1500);
    const sA = await gameState(t, a);
    assert.equal(sA.shuffles, shuffles0 + 1, 'the second tap was for a prompt that was already gone');
    prompt2 = sA.prompt;
    await b.locator('.duet-prompt .prompt-text span', { hasText: prompt2 }).waitFor();
    assert.equal(await a.locator('.duet-prompt .prompt-text span').innerText(), prompt2);

    // ---- a little drawing, then "We're done!" from both
    await Promise.all([
      scribble(a, [0.2, 0.3], [0.45, 0.35], { steps: 16 }),
      scribble(b, [0.55, 0.6], [0.85, 0.7], { steps: 16 }),
    ]);
    await waitInk(a, (n) => n > 30, { region: RIGHT });
    await b.setViewportSize({ width: 360, height: 640 });
    await a.getByRole('button', { name: /We're done/ }).click();
    // The partner sees it in the prompt card above the board (no scrolling needed on a 360×640
    // phone, where the finish row is below the fold) and can agree right there.
    await b.locator('.duet-prompt.partner-ready', { hasText: 'Alex thinks it\'s finished' }).waitFor();
    await b.evaluate(() => scrollTo(0, 0));
    {
      const [card, agree, bar] = await Promise.all(['.duet-prompt', '.duet-prompt .agree', '.reactions'].map((sel) => b.locator(sel).boundingBox()));
      assert.ok(card.y >= 0 && card.y + card.height <= bar.y, `ready card on screen (${card.y}..${card.y + card.height}, bar at ${bar.y})`);
      assert.ok(agree.y + agree.height <= bar.y);
    }
    await a.locator('.duet-prompt .ready-note', { hasText: /waiting for Blair/i }).waitFor();
    await b.waitForTimeout(500);
    await t.shot(b, 'duet-ready-b');
    await t.shot(a, 'duet-ready-a');
    await b.getByRole('button', { name: "Agree, it's finished" }).click();
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

test('Duet Canvas: lost stroke, undo and clear messages heal by themselves; no resync storms while drawing', { skip: !loadPlaywright() && 'playwright missing', timeout: 120000 }, async () => {
  const t = await openPair({ viewport: { width: 1280, height: 800 } }); // a laptop
  const { a, b } = t;
  try {
    await t.startGame('duet');
    await a.waitForTimeout(800); // mount-time syncs done
    // The finish row clears the fixed reaction bar on a laptop.
    for (const p of [a, b]) {
      const [cta, bar] = await Promise.all([p.getByRole('button', { name: /We're done/ }).boundingBox(), p.locator('.reactions').boundingBox()]);
      assert.ok(cta.y + cta.height <= bar.y, `"We're done!" (bottom ${cta.y + cta.height}) above the reaction bar (${bar.y})`);
    }
    await installLossyNet(a);
    await installLossyNet(b);

    // ---- both draw at the same time for a while (several digest rounds): no resync requests
    for (let i = 0; i < 4; i++) {
      await Promise.all([
        scribble(a, [0.08, 0.15 + i * 0.2], [0.42, 0.25 + i * 0.2], { steps: 30 }),
        scribble(b, [0.58, 0.15 + i * 0.2], [0.92, 0.25 + i * 0.2], { steps: 30 }),
      ]);
      await a.waitForTimeout(1200);
    }
    await a.waitForTimeout(1500);
    const sentA = await a.evaluate(() => window.__sent);
    const sentB = await b.evaluate(() => window.__sent);
    assert.ok(sentA.digest >= 2 && sentB.digest >= 2, `digests flow (${sentA.digest}, ${sentB.digest})`);
    assert.equal((sentA['sync?'] || 0) + (sentB['sync?'] || 0), 0, `no resync while drawing: ${JSON.stringify({ sentA, sentB })}`);
    const base = await waitSameBoards(a, b, { what: 'live drawing' });
    assert.ok(base.strokes.length >= 8, JSON.stringify(base));

    // ---- one middle chunk of Blair's long stroke is lost: Alex's copy has a gap…
    await b.evaluate(() => {
      let n = 0;
      window.__drop = (kind, d) => kind === 'stroke' && d.o > 0 && !d.end && ++n === 2;
    });
    await scribble(b, [0.55, 0.9], [0.95, 0.5], { steps: 160, wobble: 0.03 });
    assert.equal(await b.evaluate(() => window.__dropped), 1);
    // …a whole stroke of Alex's never arrives…
    await a.evaluate(() => {
      window.__drop = (kind) => kind === 'stroke';
    });
    await scribble(a, [0.1, 0.9], [0.4, 0.6], { steps: 20 });
    await a.evaluate(() => {
      window.__drop = null;
    });
    // …and Blair's undo of her first line is lost too.
    await b.evaluate(() => {
      window.__drop = (kind) => kind === 'undo';
    });
    const beforeUndo = await storedBoard(b);
    await b.getByRole('button', { name: 'Undo' }).click(); // removes the long stroke just drawn
    await b.evaluate(() => {
      window.__drop = null;
    });
    await b.waitForTimeout(600);
    const [ba, bb] = await Promise.all([storedBoard(a), storedBoard(b)]);
    assert.notDeepEqual(ba, bb, 'the boards really differ now');
    assert.equal(bb.strokes.length, beforeUndo.strokes.length - 1);
    await t.shot(a, 'duet-lossy-before-a');
    const healed = await waitSameBoards(a, b, { what: 'after lost chunk / stroke / undo' });
    assert.equal(healed.strokes.length, base.strokes.length + 1, 'plus Alex\'s lost stroke; the undone one is gone on both');

    // Pixels agree too.
    const [inkA, inkB] = [await inkCount(a), await inkCount(b)];
    assert.ok(Math.abs(inkA - inkB) <= Math.max(8, inkA * 0.02), `same picture (${inkA} vs ${inkB})`);

    // ---- a lost clear
    await a.evaluate(() => {
      window.__drop = (kind) => kind === 'clear';
    });
    await a.getByRole('button', { name: 'Clear' }).click();
    await a.getByRole('button', { name: 'Tap again to clear' }).click();
    await a.evaluate(() => {
      window.__drop = null;
    });
    assert.ok((await inkCount(b)) > 30, 'B missed the clear for now');
    await waitInk(b, (n) => n === 0, { timeout: 10000, what: 'clear reaches B through the digest' });
    const cleared = await waitSameBoards(a, b, { what: 'after lost clear' });
    assert.deepEqual(cleared.strokes, []);
    await t.shot(b, 'duet-lossy-after-b');

    // Quiet again: matching digests, no further resyncs.
    const asks = async () => (await a.evaluate(() => window.__sent['sync?'] || 0)) + (await b.evaluate(() => window.__sent['sync?'] || 0));
    const n0 = await asks();
    await a.waitForTimeout(7000);
    assert.equal(await asks(), n0, 'no resync traffic once the boards match');
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});
