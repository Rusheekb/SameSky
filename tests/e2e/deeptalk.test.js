import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPair, loadPlaywright } from './harness.js';

const settle = (page, ms = 900) => page.waitForTimeout(ms);

async function noHorizontalScroll(page) {
  const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
  assert.ok(sw <= w, `horizontal scroll: ${sw} > ${w}`);
}

test('Heart to Heart: flip, talk, write secretly, reveal, save, finish', { skip: !loadPlaywright() && 'playwright missing', timeout: 120000 }, async () => {
  const t = await openPair();
  const { a, b } = t;
  try {
    await t.startGame('deeptalk');
    for (const p of [a, b]) await p.locator('.dt-card:not(.is-flipped) .dt-front').waitFor();
    await a.locator('.dt-level.sel', { hasText: 'Warm-up' }).waitFor();
    await settle(a, 500);
    await t.shot(a, 'deeptalk-facedown-a');

    // Blair switches the level before flipping: both decks swap to a "Closer" card.
    await b.getByRole('radio', { name: /Closer/ }).click();
    for (const p of [a, b]) await p.locator('.dt-card.lvl-2 .dt-front-level', { hasText: 'Closer' }).waitFor();
    await t.shot(b, 'deeptalk-facedown-closer-b');
    assert.equal(await a.locator('.dt-q').innerText(), '', 'question hidden until flipped');

    // Blair flips — both see the question.
    await b.getByRole('button', { name: 'Flip the card ✨' }).click();
    for (const p of [a, b]) await p.locator('.dt-card.is-flipped').waitFor();
    const q1 = (await a.locator('.dt-q').innerText()).trim();
    assert.ok(q1.length > 10);
    assert.equal((await b.locator('.dt-q').innerText()).trim(), q1);
    await a.getByText('🎤 You answer first').waitFor();
    await b.getByText('🎤 Alex answers first').waitFor();
    await settle(a);
    await t.shot(a, 'deeptalk-flipped-a');
    await t.shot(b, 'deeptalk-flipped-b');

    // Talk it through, save it.
    await a.getByRole('button', { name: '💬 We talked about it' }).click();
    for (const p of [a, b]) await p.getByText('Shared 💬').waitFor();
    await a.getByRole('button', { name: '☆ Save' }).click();
    await b.getByRole('button', { name: '⭐ Saved' }).waitFor();
    await b.locator('.dt-foot', { hasText: '💬 1 shared' }).waitFor();
    await settle(b, 600);
    await t.shot(b, 'deeptalk-talked-b');

    // Next card: Blair answers first this time.
    await b.getByRole('button', { name: 'Next card →' }).click();
    for (const p of [a, b]) await p.locator('.dt-card:not(.is-flipped)').waitFor();
    await a.getByRole('button', { name: 'Flip the card ✨' }).click();
    await b.locator('.dt-card.is-flipped').waitFor();
    await a.getByText('🎤 Blair answers first').waitFor();
    await b.getByText('🎤 You answer first').waitFor();

    // Write it down: answers are sealed until both are in.
    await b.getByRole('button', { name: '✍️ Write it down' }).click();
    for (const p of [a, b]) await p.getByRole('textbox', { name: 'Your answer' }).waitFor();
    const secretA = 'Your laugh at 2am when the call lags';
    const secretB = 'Falling asleep on video together';
    await a.getByRole('textbox', { name: 'Your answer' }).fill(secretA);
    await settle(a, 300);
    await t.shot(a, 'deeptalk-writing-a');
    await a.getByRole('button', { name: 'Seal it 💌' }).click();
    await a.getByText('💌 Your answer is sealed').waitFor();
    await b.locator('.lock.is-locked', { hasText: 'Alex' }).waitFor();
    assert.equal(await b.getByText(secretA).count(), 0, 'partner answer never shown before both seal');
    assert.ok(!(await b.content()).includes(secretA), 'not even in the DOM');
    // Live "typing…" hint travels over fx.
    await b.getByRole('textbox', { name: 'Your answer' }).pressSequentially('Fall', { delay: 30 });
    await a.getByText('✍️ Blair is typing…').waitFor({ timeout: 5000 });
    await settle(a, 500);
    await t.shot(a, 'deeptalk-sealed-a');
    await t.shot(b, 'deeptalk-writing-b');
    await b.getByRole('textbox', { name: 'Your answer' }).fill(secretB);
    await b.getByRole('button', { name: 'Seal it 💌' }).click();

    for (const p of [a, b]) {
      await p.locator('.dt-answer', { hasText: secretA }).waitFor();
      await p.locator('.dt-answer', { hasText: secretB }).waitFor();
    }
    await b.getByRole('button', { name: '☆ Save' }).click();
    await a.getByRole('button', { name: '⭐ Saved' }).waitFor();
    await settle(a);
    await t.shot(a, 'deeptalk-reveal-a');
    await b.setViewportSize({ width: 360, height: 760 });
    await settle(b, 400);
    await t.shot(b, 'deeptalk-reveal-b-360');
    await noHorizontalScroll(b);

    // Next card, peek at Deep at 360 px, then finish (two taps).
    await a.getByRole('button', { name: 'Next card →' }).click();
    await b.locator('.dt-card:not(.is-flipped)').waitFor();
    await a.getByRole('radio', { name: /Deep/ }).click();
    await b.locator('.dt-card.lvl-3').waitFor();
    await settle(b, 400);
    await t.shot(b, 'deeptalk-deep-facedown-360');
    await b.getByRole('button', { name: 'Flip the card ✨' }).click();
    await b.locator('.dt-card.is-flipped').waitFor();
    await settle(b);
    await t.shot(b, 'deeptalk-deep-flipped-360');
    await noHorizontalScroll(b);

    await a.getByRole('button', { name: 'Finish for tonight' }).click();
    await a.getByRole('button', { name: 'Tap again to finish' }).click();
    for (const p of [a, b]) await p.locator('.dt-final').waitFor();
    await a.getByText('cards shared').waitFor();
    assert.equal((await a.locator('.dt-final-num b').innerText()).trim(), '2');
    assert.equal(await a.locator('.dt-fav').count(), 2);
    await a.locator('.dt-fav', { hasText: q1 }).waitFor();
    await a.locator('.dt-fav-answers', { hasText: secretA }).waitFor();
    await b.locator('.dt-fav-answers', { hasText: secretB }).waitFor();
    await settle(a, 1200);
    await t.shot(a, 'deeptalk-done-a');
    await t.shot(b, 'deeptalk-done-b-360');
    await noHorizontalScroll(b);

    await t.backToLobby(b);
    await a.locator('.score-pill', { hasText: '2' }).waitFor();
    await b.locator('.score-pill', { hasText: '2' }).waitFor();
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});
