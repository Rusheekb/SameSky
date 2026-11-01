import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPair, loadPlaywright } from './harness.js';

const settle = (page, ms = 650) => page.waitForTimeout(ms);

async function noHorizontalScroll(page) {
  const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
  assert.ok(sw <= w, `horizontal scroll: ${sw} > ${w}`);
}

async function tap(page, slot, side) {
  await page.locator(`.tot-opts.${slot} .tot-${side}`).click();
}

async function roundChip(page, n) {
  await page.locator('.game-header .tot-round', { hasText: new RegExp(`^${n}/10$`) }).waitFor({ timeout: 10000 });
}

test('This or That: pick, predict, reveal, auto-advance, results', { skip: !loadPlaywright() && 'playwright missing', timeout: 180000 }, async () => {
  const t = await openPair();
  const { a, b } = t;
  try {
    await t.startGame('thisorthat');
    await roundChip(a, 1);
    await roundChip(b, 1);
    await a.getByText('Blair would pick…').waitFor();
    await b.getByText('Alex would pick…').waitFor();
    await t.shot(a, 'thisorthat-pick-a');
    const optA = (await a.locator('.tot-opts.mine .tot-a').innerText()).trim();
    const optB = (await a.locator('.tot-opts.mine .tot-b').innerText()).trim();
    assert.ok(optA && optB && optA !== optB);

    // --- Round 1: Alex picks A and guesses Blair picks B.
    await tap(a, 'mine', 'a');
    await a.locator('.tot-opts.mine .tot-a.sel').waitFor();
    await t.shot(a, 'thisorthat-pick-half');
    await tap(a, 'guess', 'b');
    await a.locator('.tot-locked').waitFor();
    await a.getByText('Waiting for Blair to choose').waitFor();
    await b.locator('.lock.is-locked', { hasText: 'Alex' }).waitFor();
    await b.getByText('Alex has locked in — your turn!').waitFor();
    // Secrecy: Blair sees nothing of Alex's choices before the reveal.
    assert.equal(await b.locator('.tot-opt.sel').count(), 0);
    assert.equal(await b.locator('.tot-locked, .reveal-card').count(), 0);
    await settle(a);
    await t.shot(a, 'thisorthat-locked-a');
    await t.shot(b, 'thisorthat-partner-locked-b');

    // Blair: A + guesses A.
    await tap(b, 'mine', 'a');
    await tap(b, 'guess', 'a');
    for (const p of [a, b]) await p.locator('.tot-rcard').nth(1).waitFor();
    await a.getByText(`You both chose ${optA} 💞`).waitFor();
    await b.getByText(`You both chose ${optA} 💞`).waitFor();
    await a.getByText('Blair read your mind ✓').waitFor();
    await a.getByText('You guessed wrong ✗').waitFor();
    await b.getByText('Alex guessed wrong ✗').waitFor();
    await b.getByText("You read Alex's mind ✓").waitFor();
    await a.getByText('+2 together points').waitFor();
    await a.locator('.tot-count').waitFor();
    await settle(a, 900);
    await t.shot(a, 'thisorthat-reveal-a');
    await t.shot(b, 'thisorthat-reveal-b');
    await noHorizontalScroll(a);

    // --- Round 2: let the 7 s auto-advance do the work.
    await roundChip(a, 2);
    await roundChip(b, 2);
    assert.equal(await a.locator('.tot-opt.sel').count(), 0, 'fresh round starts clean');

    // Blair's view at 360 px wide.
    await b.setViewportSize({ width: 360, height: 760 });
    await settle(b, 300);
    await t.shot(b, 'thisorthat-pick-360');
    await noHorizontalScroll(b);

    // Rounds 2..10: even rounds agree on everything (+3), odd rounds split but both guess right (+2).
    for (let r = 2; r <= 10; r++) {
      await roundChip(a, r);
      await roundChip(b, r);
      if (r % 2 === 0) {
        await tap(a, 'mine', 'a');
        await tap(a, 'guess', 'a');
        await tap(b, 'guess', 'a');
        await tap(b, 'mine', 'a');
      } else {
        await tap(a, 'mine', 'a');
        await tap(a, 'guess', 'b');
        await tap(b, 'mine', 'b');
        await tap(b, 'guess', 'a');
      }
      await a.locator('.tot-rcard').nth(1).waitFor();
      await b.locator('.tot-rcard').nth(1).waitFor();
      if (r === 3) {
        await b.getByText("You split on this one ⚡").waitFor();
        await settle(b, 900);
        await t.shot(b, 'thisorthat-reveal-split-360');
        await noHorizontalScroll(b);
      }
      const who = r % 2 ? a : b;
      await who.getByRole('button', { name: r === 10 ? /See results/ : /Next dilemma/ }).click();
    }

    // --- Results on both screens.
    for (const p of [a, b]) await p.locator('.tot-final').waitFor();
    await a.getByText('60%').waitFor();
    await a.getByText('Beautifully in tune 🎶').waitFor();
    await a.getByText('Talk about these! 💬').waitFor();
    assert.equal(await a.locator('.tot-talk li').count(), 4);
    await a.getByText('+25 together points this game').waitFor();
    await a.locator('.tot-mind', { hasText: 'You read Blair' }).getByText('9/10').waitFor();
    await a.locator('.tot-mind', { hasText: 'Blair read you' }).getByText('10/10').waitFor();
    await settle(a, 900);
    await t.shot(a, 'thisorthat-over-a');
    await b.locator('.tot-final').scrollIntoViewIfNeeded();
    await t.shot(b, 'thisorthat-over-b-360');
    await noHorizontalScroll(b);
    await a.locator('.tot-talk').scrollIntoViewIfNeeded();
    await t.shot(a, 'thisorthat-over-talk-a');

    await t.backToLobby(b);
    await a.locator('.score-pill', { hasText: '25' }).waitFor();
    await b.locator('.score-pill', { hasText: '25' }).waitFor();
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});
