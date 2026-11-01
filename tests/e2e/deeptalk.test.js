import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPair, loadPlaywright } from './harness.js';

const settle = (page, ms = 900) => page.waitForTimeout(ms);

async function noHorizontalScroll(page) {
  const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
  assert.ok(sw <= w, `horizontal scroll: ${sw} > ${w}`);
}

/**
 * `first` taps "Back to games". The partner either follows to the lobby or keeps the finished
 * results on screen (after a one-frame flash of the lobby) until they tap "Back to games" too.
 */
async function bothBack(t, first) {
  const other = first === t.a ? t.b : t.a;
  await first.getByRole('button', { name: 'Back to games' }).first().click();
  await first.locator('.game-grid').waitFor({ timeout: 10000 });
  const deadline = Date.now() + 15000;
  let inLobbySince = 0;
  while (Date.now() < deadline) {
    if (await other.locator('.game-grid').count()) {
      inLobbySince ||= Date.now();
      if (Date.now() - inLobbySince > 800) return;
    } else {
      inLobbySince = 0;
      if (await other.locator('.away-banner').count()) await other.getByRole('button', { name: 'Back to games' }).first().click({ timeout: 2000 }).catch(() => {});
    }
    await other.waitForTimeout(100);
  }
  await t.shot(other, 'deeptalk-back-stuck');
  throw new Error('partner never settled in the lobby');
}

/** The page that is not the authority (its actions travel over the channel to the other one). */
async function followerOf(t) {
  const ids = await t.a.evaluate(() => ({
    a: JSON.parse(localStorage.getItem('samesky:a:clientId')),
    b: JSON.parse(localStorage.getItem('samesky:b:clientId')),
  }));
  assert.ok(ids.a && ids.b && ids.a !== ids.b, JSON.stringify(ids));
  return ids.a < ids.b ? { follower: t.b, leader: t.a } : { follower: t.a, leader: t.b };
}

/** Drop this page's outgoing "answer" actions (a flaky network), until `restore()`. */
async function loseAnswers(page) {
  await page.evaluate(() => {
    const orig = BroadcastChannel.prototype.postMessage;
    window.__restoreAnswers = () => {
      BroadcastChannel.prototype.postMessage = orig;
    };
    BroadcastChannel.prototype.postMessage = function (msg) {
      if (JSON.stringify(msg ?? null).includes('"type":"answer"')) return undefined; // lost on the way
      return orig.call(this, msg);
    };
  });
  return () => page.evaluate(() => window.__restoreAnswers());
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

    await bothBack(t, b);
    await a.locator('.score-pill', { hasText: '2' }).waitFor();
    await b.locator('.score-pill', { hasText: '2' }).waitFor();
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});

test('Heart to Heart: a lost "Seal it" keeps the written answer; leaving via ✕ keeps the night recap', { skip: !loadPlaywright() && 'playwright missing', timeout: 120000 }, async () => {
  const t = await openPair({ viewport: { width: 360, height: 640 } });
  const { a, b } = t;
  try {
    await t.startGame('deeptalk');
    const { follower, leader } = await followerOf(t);
    await leader.getByRole('button', { name: 'Flip the card ✨' }).click();
    for (const p of [a, b]) await p.locator('.dt-card.is-flipped').waitFor();
    const q = (await a.locator('.dt-q').innerText()).trim();
    await leader.getByRole('button', { name: '✍️ Write it down' }).click();
    for (const p of [a, b]) await p.getByRole('textbox', { name: 'Your answer' }).waitFor();

    // Only spaces: the button stays off (the room would reject it anyway).
    const box = follower.getByRole('textbox', { name: 'Your answer' });
    await box.fill('    ');
    assert.equal(await follower.getByRole('button', { name: 'Seal it 💌' }).isDisabled(), true);

    // The follower's answer gets lost on the way: the words stay put, "Seal it" comes back.
    const restore = await loseAnswers(follower);
    const words = 'The way you hum when you cook, even on video';
    await box.fill(words);
    await follower.getByRole('button', { name: 'Seal it 💌' }).click();
    await follower.getByRole('button', { name: 'Sealing…' }).waitFor();
    await settle(follower, 400);
    await t.shot(follower, 'deeptalk-sealing-360x640');
    assert.equal(await box.inputValue(), words, 'text kept while the seal is in flight');
    await follower.getByRole('button', { name: 'Seal it 💌' }).waitFor({ timeout: 8000 });
    assert.equal(await box.inputValue(), words, 'text kept after the seal was lost');
    assert.equal(await follower.getByText('💌 Your answer is sealed').count(), 0);
    assert.equal(await leader.locator('.lock.is-locked').count(), 0, 'nothing sealed on the other screen either');
    await follower.setViewportSize({ width: 390, height: 844 });
    await settle(follower, 300);
    await t.shot(follower, 'deeptalk-seal-lost-390x844');
    await noHorizontalScroll(follower);

    // Network back: the queued answer goes through on its own; nothing was typed twice.
    await restore();
    await follower.getByText('💌 Your answer is sealed').waitFor({ timeout: 8000 });
    await leader.getByRole('textbox', { name: 'Your answer' }).fill('Your voice notes on the bus');
    await leader.getByRole('button', { name: 'Seal it 💌' }).click();
    for (const p of [a, b]) await p.locator('.dt-answer', { hasText: words }).waitFor();
    await a.getByRole('button', { name: '☆ Save' }).click();
    await b.getByRole('button', { name: '⭐ Saved' }).waitFor();

    // Leave through ✕ (two taps) without "Finish for tonight": the recap keeps the conversation.
    await b.getByRole('button', { name: 'Leave this game' }).click();
    await b.getByRole('button', { name: 'Tap again to leave this game' }).click();
    for (const p of [a, b]) await p.locator('.game-grid').waitFor({ timeout: 10000 });
    await a.locator('.score-pill', { hasText: '1' }).waitFor();
    await a.getByRole('button', { name: /Our night so far/ }).click();
    const row = a.locator('.history li', { hasText: 'Heart to Heart' });
    await row.waitFor();
    const text = await row.innerText();
    assert.match(text, /Shared 1 heart-to-heart card and (kept it light|got closer|went deep) · 1 saved ⭐/, text);
    assert.ok(!/Ended early/.test(text));
    assert.ok(q.length > 10);
    await settle(a, 3500);
    await t.shot(a, 'deeptalk-left-recap-360x640');
    await noHorizontalScroll(a);
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});
