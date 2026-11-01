// End-to-end harness: serves the site, opens TWO pages in one Chromium context (so they can talk
// over the BroadcastChannel "local" transport) and walks both players into the same room.
//
//   const t = await openPair();           // Alex creates a room, Blair joins via the invite link
//   await t.startGame('insync');          // Alex taps the game card; both pages show the game
//   ... drive t.a / t.b (Playwright pages) ...
//   t.assertNoErrors(); await t.close();
//
// Screenshots go to tests/e2e/screenshots/ (git-ignored). Playwright is resolved with require()
// so the globally installed copy is used; if it's missing the tests are skipped.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../scripts/serve.js';

const require = createRequire(import.meta.url);
export function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

export const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

export const PHONE = { width: 390, height: 844 };

export async function openPair({ viewport = PHONE, names = ['Alex', 'Blair'] } = {}) {
  const pw = loadPlaywright();
  if (!pw) throw new Error('playwright not available');
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: true });
  const errors = [];
  const a = await context.newPage();
  const b = await context.newPage();
  for (const [label, p] of [['A', a], ['B', b]]) {
    p.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[${label}] console: ${m.text()}`);
    });
    p.on('dialog', (d) => d.accept());
  }

  await a.goto(`${base}?net=local&profile=a#/`);
  await a.getByPlaceholder('e.g. Maya').fill(names[0]);
  await a.getByRole('button', { name: 'Save' }).click();
  await a.getByRole('button', { name: /Create our room/ }).click();
  await a.waitForURL(/#\/r\/[A-Z0-9]+/);
  const room = a.url().match(/#\/r\/([A-Z0-9]+)/)[1];

  await b.goto(`${base}?net=local&profile=b#/r/${room}`);
  await b.getByPlaceholder('e.g. Maya').fill(names[1]);
  await b.getByRole('button', { name: /Join room/ }).click();

  await a.locator('.game-grid').waitFor({ timeout: 15000 });
  await b.locator('.game-grid').waitFor({ timeout: 15000 });

  const t = {
    base,
    room,
    browser,
    context,
    a,
    b,
    errors,
    /** Alex (or `who`) taps a game card; resolves when both pages are inside the game. */
    async startGame(id, who = a) {
      await who.locator(`[data-game="${id}"]`).click();
      await a.locator('.game').first().waitFor({ timeout: 10000 });
      await b.locator('.game').first().waitFor({ timeout: 10000 });
    },
    async shot(page, name) {
      await page.screenshot({ path: `${SHOTS}${name}.png` });
    },
    /**
     * Both pages back in the lobby. `who` leaves first: via "Back to games" on a finished game,
     * or the two-tap ✕ on a running one. The partner either lands in the lobby by itself
     * (unfinished game) or keeps the finished results on screen and taps "Back to games" too.
     */
    async backToLobby(who = a) {
      const other = who === a ? b : a;
      const back = who.getByRole('button', { name: 'Back to games' }).first();
      if (await back.isVisible().catch(() => false)) {
        await back.click();
      } else {
        await who.getByRole('button', { name: 'Leave this game' }).click();
        await who.getByRole('button', { name: 'Tap again to leave this game' }).click();
      }
      await who.locator('.game-grid').waitFor({ timeout: 10000 });
      await other.waitForFunction(
        () => document.querySelector('.game-grid') || /went back to the games/.test(document.querySelector('.room-main')?.textContent || ''),
        null,
        { timeout: 10000 },
      );
      if (!(await other.locator('.game-grid').count())) {
        await other.getByRole('button', { name: 'Back to games' }).first().click();
      }
      await other.locator('.game-grid').waitFor({ timeout: 10000 });
    },
    assertNoErrors() {
      const real = errors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND/.test(e));
      if (real.length) throw new Error(`Browser errors:\n${real.join('\n')}`);
    },
    async close() {
      await browser.close().catch(() => {});
      await new Promise((r) => server.close(r));
    },
  };
  return t;
}
