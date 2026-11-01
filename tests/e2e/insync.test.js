import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPair, loadPlaywright } from './harness.js';

test('In Sync: two players reveal, link words and sync', { skip: !loadPlaywright() && 'playwright missing', timeout: 90000 }, async () => {
  const t = await openPair();
  const { a, b } = t;
  try {
    await t.shot(a, 'lobby-a');
    // Presence: each sees the other's name in the top bar.
    await a.locator('.topbar', { hasText: 'Blair' }).waitFor();
    await b.locator('.topbar', { hasText: 'Alex' }).waitFor();

    await t.startGame('insync', b);
    await t.shot(a, 'insync-pick');
    await a.getByPlaceholder('Your word…').fill('Sunrise');
    await a.getByRole('button', { name: 'Lock in' }).click();
    await b.locator('.lock.is-locked', { hasText: 'Alex' }).waitFor();
    await b.getByPlaceholder('Your word…').fill('Beach');
    await b.getByRole('button', { name: 'Lock in' }).click();

    await a.locator('.reveal-card', { hasText: 'Beach' }).waitFor();
    await b.locator('.reveal-card', { hasText: 'Sunrise' }).waitFor();
    await t.shot(b, 'insync-reveal');
    await b.getByRole('button', { name: /Next round/ }).click();
    await a.locator('.word-chip', { hasText: 'Beach' }).waitFor();

    await a.getByPlaceholder('Your word…').fill('Morning');
    await a.getByRole('button', { name: 'Lock in' }).click();
    await b.getByPlaceholder('Your word…').fill('mornings');
    await b.getByRole('button', { name: 'Lock in' }).click();
    await a.getByText('In sync!').waitFor();
    await b.getByText('In sync!').waitFor();
    await t.shot(a, 'insync-synced');

    await t.backToLobby(b);
    await a.locator('.score-pill', { hasText: '9' }).waitFor();
    // Reactions travel.
    await a.getByRole('button', { name: 'Send ❤️' }).click();
    await b.locator('#fx-layer .fx-float').first().waitFor({ timeout: 5000 });
    t.assertNoErrors();
  } finally {
    await t.close();
  }
});
