import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPair, loadPlaywright, SHOTS } from './harness.js';

const skip = !loadPlaywright() && 'playwright missing';
const settle = (page, ms = 900) => page.waitForTimeout(ms);

async function noHorizontalScroll(page) {
  const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
  assert.ok(sw <= w, `horizontal scroll: ${sw} > ${w}`);
}

const box = (page) => page.getByRole('textbox', { name: 'Your next line' });
const MIN_LINES_E2E = 6; // lines before "The End" unlocks

/** `page` writes a line (button or Enter); waits until both pages show it. */
async function writeLine(page, other, text, { enter = false } = {}) {
  await box(page).fill(text);
  if (enter) await box(page).press('Enter');
  else await page.getByRole('button', { name: 'Add my line ✍️' }).click();
  for (const p of [page, other]) await p.locator('.sc-line', { hasText: text }).waitFor();
}

/** Everything you need to tap is on screen, not under the fixed reactions bar. */
async function fitsAboveReactions(page, selector) {
  const r = await page.evaluate((sel) => {
    scrollTo(0, 0);
    const el = document.querySelector(sel);
    const bar = document.querySelector('.reactions');
    return { bottom: el.getBoundingClientRect().bottom, barTop: bar.getBoundingClientRect().top };
  }, selector);
  assert.ok(r.bottom <= r.barTop + 1, `${selector} hidden under the reactions bar (${r.bottom} > ${r.barTop})`);
}

async function turnIs(writer, waiter, waiterSees) {
  await writer.locator('.sc-compose-label', { hasText: 'Your turn' }).waitFor();
  assert.equal(await writer.locator('.sc-turn').count(), 0);
  await waiter.locator('.sc-turn', { hasText: waiterSees }).waitFor();
  assert.equal(await waiter.getByRole('textbox', { name: 'Your next line' }).count(), 0, 'only the writer gets a text box');
}

test('Story Chain: write together, twist, The End, title, keepsake, write another', { skip, timeout: 150000 }, async () => {
  const t = await openPair();
  const { a, b } = t;
  try {
    await t.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: t.base.replace(/\/$/, '') });
    await t.startGame('story');

    // Both see the same title + opening; Alex (players[0]) writes first.
    for (const p of [a, b]) await p.locator('.sc-book .sc-opening').waitFor();
    const title = (await a.locator('.sc-title').innerText()).trim();
    const opening = (await a.locator('.sc-opening').innerText()).trim();
    assert.ok(title.length > 2 && opening.length > 20);
    assert.equal((await b.locator('.sc-title').innerText()).trim(), title);
    assert.equal((await b.locator('.sc-opening').innerText()).trim(), opening);
    assert.ok(!/\{A\}|\{B\}/.test(opening));
    await turnIs(a, b, 'Waiting for Alex to write…');
    await a.locator('.sc-chip', { hasText: '0/24' }).waitFor();
    assert.ok(await a.locator('.sc-twist-btn').isDisabled(), 'no twist before the first line');
    assert.ok(await b.locator('.sc-end-btn').isDisabled(), 'The End locked at the start');
    await settle(a, 600);
    await t.shot(a, 'story-start-a');
    await t.shot(b, 'story-start-b');
    await noHorizontalScroll(a);

    // Live "Alex is writing…" — but never the draft itself.
    const secret = 'SECRETDRAFT nobody should see this';
    await box(a).pressSequentially(secret.slice(0, 14), { delay: 25 });
    await b.locator('.sc-turn.typing', { hasText: 'Alex is writing' }).waitFor({ timeout: 5000 });
    await b.locator('.sc-book .sc-ghost').waitFor();
    assert.ok(!(await b.content()).includes('SECRETDRAFT'), 'draft text never reaches the partner');
    await settle(b, 400);
    await t.shot(b, 'story-partner-typing-b');
    await t.shot(a, 'story-typing-a');
    // The indicator expires a few seconds after the last keystroke.
    await b.locator('.sc-turn:not(.typing)', { hasText: 'Waiting for Alex' }).waitFor({ timeout: 7000 });
    assert.equal(await b.locator('.sc-ghost').count(), 0);

    const L = [
      'Out of the oven climbed a very small dragon with flour on its nose.',
      'It sneezed a tiny flame and toasted the last bagel to perfection.',
      'Everyone agreed this was the best thing that had ever happened on a Tuesday.',
      'So they gave the dragon an apron and a name badge that said “Kevin”.',
      'Kevin took his new job extremely, almost alarmingly, seriously.',
      'By noon there was a queue all the way round the block.',
      'And that is how the town got its very first dragon-run bakery.',
    ];
    await box(a).fill('');
    await writeLine(a, b, L[0], { enter: true });
    assert.ok(!(await b.content()).includes('SECRETDRAFT'));
    await turnIs(b, a, 'Waiting for Blair');
    await writeLine(b, a, L[1]);
    await turnIs(a, b, 'Waiting for Alex');

    // Blair (not the writer) throws in a twist; it lands on both pages, the turn stays with Alex.
    await b.getByRole('button', { name: /Twist!/ }).click();
    for (const p of [a, b]) await p.locator('.sc-twist').waitFor();
    const twist = (await a.locator('.sc-twist p').innerText()).trim();
    assert.ok(twist.length > 8);
    assert.equal((await b.locator('.sc-twist p').innerText()).trim(), twist);
    await a.locator('.sc-twist small', { hasText: 'summoned by Blair' }).waitFor();
    await b.locator('.sc-twist small', { hasText: 'summoned by You' }).waitFor();
    await turnIs(a, b, 'Waiting for Alex');
    for (const p of [a, b]) {
      assert.ok(await p.locator('.sc-twist-btn').isDisabled(), 'not two twists in a row');
      await p.locator('.sc-badge', { hasText: '2' }).waitFor();
    }
    await b.locator('.sc-note', { hasText: 'write a line first' }).waitFor();
    await a.locator('.sc-note', { hasText: 'unlocks in 4 lines' }).waitFor();
    await settle(a);
    await t.shot(a, 'story-twist-a');
    await t.shot(b, 'story-twist-b');

    await writeLine(a, b, L[2]);
    await writeLine(b, a, L[3]);
    await writeLine(a, b, L[4]);
    assert.ok(await b.locator('.sc-end-btn').isDisabled(), 'still locked at 5 lines');
    await writeLine(b, a, L[5]);
    for (const p of [a, b]) {
      await p.locator('.sc-chip', { hasText: '6/24' }).waitFor();
      await p.locator('.sc-end-btn.ready:not([disabled])').waitFor();
    }
    await settle(b);
    // Newest line is scrolled into view inside the page.
    for (const p of [a, b]) {
      const left = await p.locator('.sc-page').evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
      assert.ok(left < 4, `page scrolled to the newest line (${left}px left)`);
    }
    await t.shot(a, 'story-six-lines-a');
    await t.shot(b, 'story-six-lines-b');
    await fitsAboveReactions(a, '.sc-tools');
    await fitsAboveReactions(b, '.sc-tools');
    await noHorizontalScroll(b);

    // Alex is mid-sentence when Blair writes "The End" — Alex keeps writing and the draft is still there.
    await box(a).fill('Half a thought');
    await b.getByRole('button', { name: '📕 The End' }).click();
    await b.locator('.sc-ending-head', { hasText: 'You wrote “The End”' }).waitFor();
    await a.locator('.sc-ending-head', { hasText: 'Blair wrote “The End”' }).waitFor();
    await a.locator('.sc-unsent', { hasText: 'Your unfinished line is saved' }).waitFor();
    assert.equal(await b.locator('.sc-unsent').count(), 0);
    await a.getByRole('button', { name: '← Keep writing' }).click();
    for (const p of [a, b]) await p.locator('.sc-tools').waitFor();
    await turnIs(a, b, 'Waiting for Alex');
    assert.equal(await box(a).inputValue(), 'Half a thought', 'unsent draft survives');
    await writeLine(a, b, L[6]);

    await b.getByRole('button', { name: '📕 The End' }).click();
    for (const p of [a, b]) await p.locator('.sc-title-form').waitFor();
    assert.equal(await a.locator('.sc-sugg').count(), 4);
    assert.equal((await a.locator('.sc-sugg').first().innerText()).trim(), title, 'working title is suggested');
    await settle(a, 600);
    await t.shot(a, 'story-ending-a');
    await t.shot(b, 'story-ending-b');
    for (const p of [a, b]) await fitsAboveReactions(p, '.sc-title-form');

    // Blair taps a suggestion; Alex types a title and binds the book first.
    await b.locator('.sc-sugg').nth(1).click();
    await b.locator('.sc-sugg.sel').waitFor();
    const myTitle = 'Kevin, the Bakery Dragon';
    await a.getByPlaceholder(title).pressSequentially(myTitle, { delay: 10 });
    await b.locator('.sc-naming', { hasText: 'Alex is typing a title' }).waitFor();
    await a.getByRole('button', { name: 'Bind it 📕' }).click();

    for (const p of [a, b]) {
      await p.locator('.sc-book.final .sc-title', { hasText: myTitle }).waitFor();
      await p.locator('.sc-result', { hasText: '+9' }).waitFor();
      await p.locator('.sc-byline', { hasText: 'by Alex & Blair' }).waitFor();
      await p.locator('.sc-fin', { hasText: 'The End' }).waitFor();
      assert.equal(await p.locator('.sc-book.final .sc-line').count(), 7);
      assert.equal(await p.locator('.sc-book.final .sc-twist').count(), 1);
      assert.ok((await p.locator('.sc-epilogue').innerText()).trim().length > 10);
    }
    await settle(a, 3200); // let the confetti land
    await t.shot(a, 'story-final-a');
    await t.shot(b, 'story-final-b');
    await b.screenshot({ path: `${SHOTS}story-final-full-b.png`, fullPage: true });

    // Copy story.
    await a.bringToFront();
    await a.getByRole('button', { name: '📋 Copy story' }).click();
    await a.locator('#toast', { hasText: /copied|selected/ }).waitFor();
    const clip = await a.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    if (clip) {
      assert.ok(clip.startsWith(`📖 ${myTitle}\nby Alex & Blair`), clip.slice(0, 80));
      for (const line of [opening, L[0], L[6], `✨ ${twist}`, '— The End —']) assert.ok(clip.includes(line), `copied text has: ${line}`);
    }

    // Same book at 360px wide.
    await b.setViewportSize({ width: 360, height: 760 });
    await settle(b, 300);
    await noHorizontalScroll(b);
    await t.shot(b, 'story-final-360-b');
    await b.screenshot({ path: `${SHOTS}story-final-full-360-b.png`, fullPage: true });

    // Write another: new opening, Blair starts this time, points carried.
    await b.getByRole('button', { name: '✍️ Write another' }).click();
    for (const p of [a, b]) await p.locator('.sc-kicker', { hasText: 'Story no. 2' }).waitFor();
    assert.notEqual((await a.locator('.sc-opening').innerText()).trim(), opening);
    await turnIs(b, a, 'Waiting for Blair');
    await settle(b, 600);
    await t.shot(b, 'story-again-360-b');
    await noHorizontalScroll(b);

    await t.backToLobby(a);
    for (const p of [a, b]) await p.locator('.score-pill', { hasText: '9' }).waitFor();
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});

test('Story Chain with AI: opening, twists (incl. a failed call), narrator ending, AI "write another"', { skip, timeout: 150000 }, async () => {
  const t = await openPair({ viewport: { width: 360, height: 760 } });
  const { a, b } = t;
  const calls = [];
  let twistCalls = 0;
  let startCalls = 0;
  try {
    // Pretend the Supabase Edge Function is deployed: a config with AI on + a fake function.
    await t.context.route('**/js/config.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript; charset=utf-8',
        body: `export default { supabaseUrl: '${t.base}fake-supabase', supabaseAnonKey: 'anon-test', aiEnabled: true };`,
      }),
    );
    await t.context.route('**/functions/v1/same-sky-ai', async (route) => {
      const { task, params } = JSON.parse(route.request().postData() || '{}');
      calls.push({ task, params });
      let result = null;
      if (task === 'story_start') {
        startCalls++;
        result =
          startCalls === 1
            ? { title: '“The Robot Gardener”', opening: 'A robot gardener woke up to find a rose growing out of its chest.' }
            : { title: 'The Snail Express', opening: 'The fastest snail in the world had exactly one train to catch.' };
      } else if (task === 'story_twist') {
        twistCalls++;
        if (twistCalls === 2) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); // unusable → bank twist
        result = { twist: '  Then the rose began to sing, very softly, in Italian.  ' };
      } else if (task === 'story_end') {
        await new Promise((r) => setTimeout(r, 1500)); // the narrator takes a moment
        result = { title: 'The Singing Rose', epilogue: 'And every spring after that, the whole garden hummed along.' };
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result }) });
    });
    await Promise.all([a.reload(), b.reload()]);
    for (const p of [a, b]) await p.locator('.game-grid').waitFor({ timeout: 15000 });
    await a.locator('.topbar', { hasText: 'Blair' }).waitFor();
    await a.getByRole('switch', { name: /AI/ }).click();
    for (const p of [a, b]) await p.getByRole('switch', { name: /AI on/ }).waitFor();

    await t.startGame('story');
    for (const p of [a, b]) {
      await p.locator('.sc-title', { hasText: 'The Robot Gardener' }).waitFor();
      await p.locator('.sc-opening', { hasText: 'rose growing out of its chest' }).waitFor();
    }
    assert.equal(calls[0].task, 'story_start');

    const L = ['The rose was red and slightly embarrassed.', 'The robot named it Doris.', 'Doris had opinions about fertiliser.', 'The robot wrote them all down.', 'Spring was coming, and so was the flower show.', 'They entered as a team.'];
    await writeLine(a, b, L[0]);
    await writeLine(b, a, L[1]);
    await b.getByRole('button', { name: /Twist!/ }).click();
    for (const p of [a, b]) await p.locator('.sc-twist p', { hasText: 'Then the rose began to sing, very softly, in Italian.' }).waitFor();
    const tw = calls.find((c) => c.task === 'story_twist');
    assert.ok(tw.params.story.includes('rose growing out of its chest') && tw.params.story.includes(L[1]));
    assert.ok(tw.params.story.length <= 2000);
    assert.equal(tw.params.vibe, 'sweet');

    await writeLine(a, b, L[2]);
    await writeLine(b, a, L[3]);
    // The AI call fails this time: a built-in twist is used instead.
    await a.getByRole('button', { name: /Twist!/ }).click();
    for (const p of [a, b]) await p.locator('.sc-twist').nth(1).waitFor();
    assert.equal(twistCalls, 2);
    const fallback = (await b.locator('.sc-twist p').nth(1).innerText()).trim();
    assert.ok(fallback.length > 8 && !/Italian/.test(fallback));

    await writeLine(a, b, L[4]);
    await writeLine(b, a, L[5]);
    await settle(a);
    await t.shot(a, 'story-ai-writing-360-a');
    await t.shot(b, 'story-ai-writing-360-b');
    await fitsAboveReactions(a, '.sc-tools');
    await fitsAboveReactions(b, '.sc-tools');

    // Alex writes "The End": the narrator (AI) writes the title + epilogue for both.
    await a.getByRole('button', { name: '📕 The End' }).click();
    await a.locator('.sc-narrator', { hasText: 'The narrator is writing your ending' }).waitFor();
    await b.locator('.sc-narrator', { hasText: 'Alex asked the narrator for an ending' }).waitFor();
    await settle(b, 500);
    await t.shot(a, 'story-ai-narrator-360-a');
    await t.shot(b, 'story-ai-narrator-360-b');
    for (const p of [a, b]) {
      await p.locator('.sc-book.final .sc-title', { hasText: 'The Singing Rose' }).waitFor();
      await p.locator('.sc-epilogue', { hasText: 'the whole garden hummed along' }).waitFor();
      await p.locator('.sc-result', { hasText: '+8' }).waitFor();
    }
    assert.equal(calls.filter((c) => c.task === 'story_end').length, 1, 'only the presser asks the narrator');
    await settle(b, 3200);
    await t.shot(b, 'story-ai-final-360-b');
    await noHorizontalScroll(b);

    // Write another: a fresh AI opening.
    await b.getByRole('button', { name: '✍️ Write another' }).click();
    for (const p of [a, b]) await p.locator('.sc-title', { hasText: 'The Snail Express' }).waitFor();
    const again = calls.filter((c) => c.task === 'story_start').pop();
    assert.ok(again.params.avoid.includes('The Robot Gardener'));
    await t.backToLobby(b);
    for (const p of [a, b]) await p.locator('.score-pill', { hasText: '8' }).waitFor();
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});

/** The page that is not the authority (its actions travel over the channel to the other one). */
async function roles(t) {
  const ids = await t.a.evaluate(() => ({
    a: JSON.parse(localStorage.getItem('samesky:a:clientId')),
    b: JSON.parse(localStorage.getItem('samesky:b:clientId')),
  }));
  assert.ok(ids.a && ids.b && ids.a !== ids.b, JSON.stringify(ids));
  return ids.a < ids.b ? { follower: t.b, leader: t.a } : { follower: t.a, leader: t.b };
}

/** Drop this page's outgoing story lines (a flaky network) until `__restoreLines()`. */
async function loseLines(page) {
  await page.evaluate(() => {
    const orig = BroadcastChannel.prototype.postMessage;
    window.__restoreLines = () => {
      BroadcastChannel.prototype.postMessage = orig;
    };
    BroadcastChannel.prototype.postMessage = function (msg) {
      if (JSON.stringify(msg ?? null).includes('"type":"line"')) return undefined; // lost on the way
      return orig.call(this, msg);
    };
  });
}

/** Screenshots at 360×640 and 390×844 with `selector` scrolled into view (above the reactions bar). */
async function shotsAtBothSizes(t, page, name, selector) {
  for (const vp of [{ width: 360, height: 640 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(vp);
    await settle(page, 350);
    await noHorizontalScroll(page);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const bar = document.querySelector('.reactions');
      if (!el) return;
      const r = el.getBoundingClientRect();
      const bottom = bar ? bar.getBoundingClientRect().top : innerHeight;
      if (r.bottom > bottom) scrollBy(0, r.bottom - bottom + 12);
    }, selector);
    await settle(page, 300);
    await t.shot(page, `${name}-${vp.width}`);
  }
}

test('Story Chain: a line lost on the way or racing "The End" is never lost', { skip, timeout: 150000 }, async () => {
  const t = await openPair({ viewport: { width: 360, height: 640 } });
  const { a, b } = t;
  try {
    await t.startGame('story');
    for (const p of [a, b]) await p.locator('.sc-book .sc-opening').waitFor();
    const { follower: f, leader: l } = await roles(t);
    // Six lines (Alex starts), plus one more so it's the follower's turn.
    const filler = (i) => `Line ${i + 1}: and then something lovely happened.`;
    for (let i = 0; i < MIN_LINES_E2E; i++) await writeLine(i % 2 ? b : a, i % 2 ? a : b, filler(i));
    if (f === b) await writeLine(a, b, filler(MIN_LINES_E2E));
    await turnIs(f, l, /Waiting for/);
    const lines = () => f.locator('.sc-book .sc-line').count();
    const n0 = await lines();

    // 1) The line never reaches the partner: it stays in the box, then a gentle "Send again".
    await loseLines(f);
    const lost = 'A sentence that got lost somewhere over the sea.';
    await box(f).fill(lost);
    await f.getByRole('button', { name: 'Add my line ✍️' }).click();
    await f.getByRole('button', { name: 'Adding…' }).waitFor();
    assert.equal(await box(f).inputValue(), lost, 'text kept while it travels');
    assert.ok(await f.getByRole('button', { name: 'Adding…' }).isDisabled());
    assert.equal(await box(f).getAttribute('readonly'), '', 'no edits while it is on its way');
    await f.locator('.sc-stall', { hasText: 'hasn’t reached' }).waitFor({ timeout: 8000 });
    assert.equal(await box(f).inputValue(), lost);
    assert.equal(await box(f).getAttribute('readonly'), null, 'editable again once stalled');
    assert.equal(await l.locator('.sc-line', { hasText: lost }).count(), 0);
    await shotsAtBothSizes(t, f, 'story-line-stalled', '.sc-compose');
    // The network is back; "Send again" (and the session's own retry) land it exactly once.
    await f.evaluate(() => {
      window.__restoreLines();
      [...document.querySelectorAll('.sc-compose button[type=submit]')].find((x) => /Send again/.test(x.textContent)).click();
    });
    for (const p of [f, l]) await p.locator('.sc-line', { hasText: lost }).waitFor();
    await settle(f, 2500); // any duplicate re-send would have arrived by now
    for (const p of [f, l]) assert.equal(await p.locator('.sc-line', { hasText: lost }).count(), 1, 'landed once');
    assert.equal(await lines(), n0 + 1);
    await turnIs(l, f, /Waiting for/);

    // 2) The partner taps "The End" while the follower's next line is on its way: after "Keep
    //    writing" the line is back in the box, ready to add.
    await writeLine(l, f, 'The leader adds one more line.');
    await turnIs(f, l, /Waiting for/);
    await loseLines(f);
    const raced = 'This line crossed paths with The End.';
    await box(f).fill(raced);
    await f.getByRole('button', { name: 'Add my line ✍️' }).click();
    await l.getByRole('button', { name: '📕 The End' }).click();
    for (const p of [f, l]) await p.locator('.sc-title-form').waitFor();
    await f.evaluate(() => window.__restoreLines()); // it arrives now, after "The End": rejected
    await settle(f, 3500);
    for (const p of [f, l]) assert.equal(await p.locator('.sc-line', { hasText: raced }).count(), 0);
    await f.locator('.sc-unsent', { hasText: 'Your unfinished line is saved' }).waitFor();
    assert.equal(await l.locator('.sc-unsent').count(), 0, 'only the writer has a line waiting');
    await shotsAtBothSizes(t, f, 'story-line-raced-ending', '.sc-resume');
    await l.getByRole('button', { name: '← Keep writing' }).click();
    await f.locator('.sc-compose').waitFor();
    assert.equal(await box(f).inputValue(), raced, 'the raced line is back in the box');
    await f.locator('.sc-restored', { hasText: 'Didn’t make it in' }).waitFor();
    await f.getByRole('button', { name: 'Add my line ✍️' }).waitFor();
    await shotsAtBothSizes(t, f, 'story-line-restored', '.sc-compose');
    await f.getByRole('button', { name: 'Add my line ✍️' }).click();
    for (const p of [f, l]) await p.locator('.sc-line', { hasText: raced }).waitFor();
    await turnIs(l, f, /Waiting for/);
    // The next turn starts with an empty box.
    await writeLine(l, f, 'And the leader answers.');
    await turnIs(f, l, /Waiting for/);
    assert.equal(await box(f).inputValue(), '');
    for (const p of [f, l]) assert.equal(await p.locator('.sc-line', { hasText: raced }).count(), 1);

    await t.backToLobby(l);
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});

test('Story Chain with AI: a slow narrator never blocks you, and its late ending is kept', { skip, timeout: 150000 }, async () => {
  const t = await openPair({ viewport: { width: 360, height: 640 } });
  const { a, b } = t;
  let endCalls = 0;
  try {
    await t.context.route('**/js/config.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript; charset=utf-8',
        body: `export default { supabaseUrl: '${t.base}fake-supabase', supabaseAnonKey: 'anon-test', aiEnabled: true };`,
      }),
    );
    await t.context.route('**/functions/v1/same-sky-ai', async (route) => {
      const { task } = JSON.parse(route.request().postData() || '{}');
      let result = null;
      if (task === 'story_start') result = { title: 'The Lighthouse Cat', opening: 'The lighthouse keeper’s cat had never once seen the sea.' };
      else if (task === 'story_end') {
        endCalls++;
        await new Promise((r) => setTimeout(r, 4000)); // a slow narrator
        result = { title: 'The Cat Who Kept the Light', epilogue: 'And on stormy nights, the cat still checks the lamp twice.' };
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result }) });
    });
    await Promise.all([a.reload(), b.reload()]);
    for (const p of [a, b]) await p.locator('.game-grid').waitFor({ timeout: 15000 });
    await a.locator('.topbar', { hasText: 'Blair' }).waitFor();
    await a.getByRole('switch', { name: /AI/ }).click();
    for (const p of [a, b]) await p.getByRole('switch', { name: /AI on/ }).waitFor();
    await t.startGame('story');
    for (const p of [a, b]) await p.locator('.sc-title', { hasText: 'The Lighthouse Cat' }).waitFor();
    for (let i = 0; i < MIN_LINES_E2E; i++) await writeLine(i % 2 ? b : a, i % 2 ? a : b, `Line ${i + 1}: the cat was curious.`);

    // Alex asks the narrator; Blair doesn't want to wait and names it themselves.
    await a.getByRole('button', { name: '📕 The End' }).click();
    await b.locator('.sc-narrator', { hasText: 'Alex asked the narrator' }).waitFor();
    await b.getByRole('button', { name: 'We’ll name it ourselves' }).click();
    for (const p of [a, b]) await p.locator('.sc-title-form').waitFor();
    await b.getByPlaceholder('The Lighthouse Cat').fill('Whiskers');
    // The narrator's reply still arrives: first title idea + closing line, nothing snatched away.
    for (const p of [a, b]) {
      await p.locator('.sc-late', { hasText: 'The narrator caught up: its title is up first, and its closing line will end your book.' }).waitFor({ timeout: 10000 });
      assert.equal((await p.locator('.sc-sugg').first().innerText()).trim(), '🪶 The Cat Who Kept the Light');
      await p.locator('.sc-title-form').waitFor();
    }
    assert.equal(await b.getByPlaceholder('The Lighthouse Cat').inputValue(), 'Whiskers', 'typed title untouched');
    await shotsAtBothSizes(t, a, 'story-ai-late-narrator', '.sc-title-form');
    await b.getByRole('button', { name: 'Bind it 📕' }).click();
    for (const p of [a, b]) {
      await p.locator('.sc-book.final .sc-title', { hasText: 'Whiskers' }).waitFor();
      await p.locator('.sc-epilogue', { hasText: 'the cat still checks the lamp twice' }).waitFor();
    }
    assert.equal(endCalls, 1);
    await t.backToLobby(a);
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});
