# Same Sky — architecture & game API

Static site, no build step. Plain ES modules + [Preact/htm](../js/vendor/README.md) vendored in
`js/vendor/`. Runs from any sub-path (GitHub Pages), so **every URL in the code is relative**.

```
index.html            entry; loads css/app.css, css/games.css, js/main.js
js/config.js          public config (Supabase URL + anon key, aiEnabled) – written by the deploy workflow
js/core/state.js      pure room reducer (players, settings, current game, scores, history)
js/core/session.js    real-time sync protocol over a transport (authority model, presence, fx)
js/net/*.js           transports: supabase.js (Realtime broadcast), peer.js (WebRTC/PeerJS),
                      local.js (BroadcastChannel, for tests), memory.js (Node unit tests)
js/games/index.js     game registry
js/games/<id>/logic.js   PURE game rules (runs in Node tests and on the authority client)
js/games/<id>/view.js    Preact component (browser only)
js/content/<id>.js    built-in prompt banks
js/lib/ai.js          client for the optional Supabase Edge Function (Claude)
js/ui/*.js            app shell, room screen, shared components, fx (confetti, floating emoji)
css/app.css           design system; css/games/<id>.css per-game styles
supabase/functions/same-sky-ai/   Edge Function that holds the Anthropic key
tests/unit/           node:test unit tests            → npm test
tests/e2e/            Playwright two-player tests      → npm run test:e2e
```

## Real-time model

Two clients share one **room state**. The online player with the smallest `clientId` is the
**authority**: it runs `reduce()` and broadcasts the whole new state (`v` bumps each commit).
The other client sends actions to it and adopts whatever it broadcasts. If the authority drops,
the other one takes over with its latest copy; on reconnect, `(v, by)` decides which copy wins.
State is also persisted in `localStorage`, so a refresh resumes where you were.

Anything that's high-frequency or doesn't need to survive a refresh (doodle strokes, emoji
reactions, "typing…" hints) goes through **fx** messages instead of state.

## Writing a game

A game is two files plus optional content and CSS. Copy `js/games/insync/` as a template.

### `logic.js` — pure, deterministic, DOM-free

```js
export const meta = {
  id: 'mygame',              // must match the folder + registry key
  title: 'My Game',
  emoji: '🎲',
  tagline: 'One short line for the lobby card.',
  description: 'A sentence or two of rules.',
  minPlayers: 2,
  ai: { task: 'mygame_task', label: 'fresh prompts' }, // optional: lobby asks the AI first
};

export function init(ctx, opts) { return s; }      // opts.content = AI result (validate it!)
export function reduce(s, a, ctx) { return s2; }   // a = { type, ...payload, by }
export function tick(s, ctx) { return s2; }        // optional; authority calls it every 250 ms
```

`ctx` = `{ players: [id1, id2], names: {id: name}, by, now, random, settings }`
- `players` is in stable join order → use it to assign roles (`players[0]` goes first, etc.).
- `by` is the acting player id (null in `tick`). **Ignore actions from ids not in `players`.**
- `now` is the authority clock in ms; store deadlines as absolute `endsAt` timestamps.
- `random()` — use this, never `Math.random()`, so tests are deterministic.
- `settings.vibe` ∈ `sweet | flirty | silly | deep`.

Rules for the state `s`:
- Plain JSON only (it's broadcast in full after every change — keep it small: a few KB).
- **Never mutate.** Return a new object when something changes and **the same object when
  nothing changed** (the session uses identity to skip no-op broadcasts; `tick` especially).
- Validate everything in an action: wrong phase, wrong player, missing/oversized text
  (`cleanText()` from `js/lib/util.js`), double submits.
- Required fields used by the recap: `done` (bool), `points` (int, "together points" earned in
  this game, cumulative across "play again"), `summary` (one line), `highlights` (≤ 6 short
  strings — fed to the AI recap poem).
- Simultaneous answers: store per-player answers in state but **the view must never show the
  partner's answer before the reveal phase**.

### `view.js` — Preact component

```js
import { html, useState, useEffect } from '../../ui/h.js';
import { GameHeader, LockStatus, AnswerBox, ResultActions, Timer, WaitingDots, Avatar, useOnChange } from '../../ui/components.js';
export default function MyGameView({ s, api, meta }) { … }
```

`api`:

| field | |
|---|---|
| `me`, `partner`, `meId` | player objects `{id, name, avatar, color, tz}` |
| `players`, `player(id)`, `names` | ids in stable order, lookup |
| `partnerOnline` | bool |
| `act(a)` | dispatch a game action (`{type, ...}`) — goes to the authority |
| `end()` / `confirmEnd()` | back to the lobby (records the result) |
| `now()` | authority clock — use with `endsAt` (or `useCountdown`/`<Timer>`) |
| `fx.send(kind, data)` / `fx.on(kind, cb) → unsubscribe` | ephemeral partner events scoped to this game instance; `fx.on` is identity-stable, use it in `useEffect(() => api.fx.on(...), [])` |
| `ai.enabled`, `ai.generate(task, params)` | optional mid-game AI call (vibe/names/aboutUs pre-filled) |
| `effects.confetti()`, `.floatEmoji(e)`, `.toast(msg)`, `.sound(name)` | sounds: `pop tap lock reveal success fail tick heart whoosh` |
| `settings` | `{vibe, ai, aboutUs}` |

The component re-renders on every state change; keep local UI state (input text, selected
option before locking) in hooks. Use the shared CSS classes from `css/app.css` (`card`, `btn`,
`btn-primary`, `btn-choice`, `chip`, `prompt-card`, `reveal-row`, `reveal-card`, `result-banner`,
`stack`, `row`, `muted`, `big`, …) and put anything game-specific in `css/games/<id>.css`,
with selectors scoped under `.game.<id>`. Must look good at 360 px wide.

### Tests

- `tests/unit/<id>.test.js` — drive `logic.js` with `gameHarness()` from `tests/helpers/sim.js`.
- `tests/e2e/<id>.test.js` — use `openPair()` from `tests/e2e/harness.js` (two real pages).

## AI tasks (Supabase Edge Function `same-sky-ai`)

The browser POSTs `{ task, params }` to `${SUPABASE_URL}/functions/v1/same-sky-ai` with the
`x-same-sky-passcode` header and gets back `{ result }`. The function builds every prompt itself
from a fixed template per task — the client can't send free-form prompts. Games must treat the
result as untrusted input: validate shapes, trim strings, and fall back to the built-in banks.

Common params (all optional): `vibe` (`sweet|flirty|silly|deep`), `aboutUs` (≤ 500 chars),
`names` (2 × ≤ 24 chars), `avoid` (≤ 20 strings × ≤ 200 chars, recently used items).

| task | used by | extra params | `result` shape |
|---|---|---|---|
| `insync_seeds` | In Sync | – | `{ pairs: [{ a, b }] }` ×10 — two everyday words that can be linked |
| `knowme_questions` | Know Me Better | – | `{ questions: [{ text, kind: 'choice'\|'scale'\|'open', options: string[], low: string, high: string }] }` ×8 — `text` is a short noun phrase that reads well both as "About you:" and "About Maya:" (e.g. "Go-to comfort food"); `options` has 4 entries for `choice`, else `[]`; `low`/`high` label a 1–10 scale for `scale`, else `''` |
| `thisorthat_items` | This or That | – | `{ items: [{ a, b }] }` ×12 |
| `doodle_words` | Doodle Dash | – | `{ words: string[] }` ×30 — easy-to-draw nouns or 2-word phrases |
| `duet_prompts` | Duet Canvas | – | `{ prompts: string[] }` ×10 — things to draw together |
| `deeptalk_cards` | Heart to Heart | – | `{ cards: [{ text, level: 1\|2\|3 }] }` ×15 — 1 = light, 3 = deep |
| `story_start` | Story Chain | – | `{ title, opening }` — opening is 1–2 sentences |
| `story_twist` | Story Chain | `story` (≤ 2000 chars) | `{ twist }` — one sentence that continues the story with a surprise |
| `story_end` | Story Chain | `story` (≤ 2000 chars) | `{ title, epilogue }` |
| `recap` | Night recap sheet | `highlights` (≤ 20 × ≤ 200 chars) | `{ title, poem }` — ≤ 12 short lines, `\n`-separated |

The ×N counts are maximums: the server drops invalid items and may return fewer (at least 3;
`doodle_words` at least 6), otherwise it answers 502. Status codes the client can see:
401/403 wrong passcode or origin · 413 request too large · 422 Claude declined · 429 rate
limited (`Retry-After`) · 502 unusable output or upstream error · 500 server not configured.
