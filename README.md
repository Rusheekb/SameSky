# 🌙 Same Sky

**Game night for two hearts, miles apart.** Real-time mini-games made for long-distance
couples: open the site on both phones (or laptops), hop on a call, and play together live.

▶️ **Play:** <https://rusheekb.github.io/SameSky/> once GitHub Pages is switched on (see
[SETUP.md](SETUP.md), it takes two minutes).

## The games

| | Game | How it works |
|---|---|---|
| 🔮 | **In Sync** | You each secretly type a word that links the two on screen. Reveal together. Different? Your two words become the next pair — keep going until your minds meet. |
| 💭 | **Know Me Better** | One of you answers about yourself, the other guesses at the same time. Multiple choice, 1–10 scales and open answers you judge yourself. |
| ⚖️ | **This or That** | Quick dilemmas: pick yours *and* predict theirs. Compatibility and mind-reading scores at the end. |
| 🎨 | **Doodle Dash** | Draw a secret word live while your partner watches the lines appear and races to guess it. |
| 🖌️ | **Duet Canvas** | One shared canvas, two pens, drawing at the same time. Save your masterpiece. |
| 💌 | **Heart to Heart** | Conversation cards from warm-up to deep, flipped together. Talk, or write answers and reveal them side by side. |
| 📖 | **Story Chain** | Write a tiny story one line each, with surprise twists. Keep the finished page. |

Plus, everywhere: live presence, both of your local times, emoji reactions that float onto your
partner's screen, a 💗 "thinking of you" heartbeat, and *Our night so far* with your together
points (and an optional Claude-written poem about the evening).

Everything is cooperative — you earn **together points**, not points against each other.

## How it works

* **Static site, no build step** — plain ES modules with Preact + htm vendored in
  `js/vendor/`, hosted on GitHub Pages. Works on any modern phone browser.
* **Real-time sync** — one browser acts as the authority, runs the game rules and broadcasts the
  state; the other mirrors it. If either drops or refreshes, the room recovers automatically.
  Transport: [Supabase Realtime](https://supabase.com/docs/guides/realtime/broadcast) when
  configured, otherwise a direct WebRTC connection via the public PeerJS broker (zero setup).
* **Optional AI** — a Supabase Edge Function calls Claude to write personalised questions,
  prompts, story twists and a recap poem. The Anthropic key stays in Supabase secrets and the
  function only answers requests carrying your private passcode.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Setup: [SETUP.md](SETUP.md)

## Development

```sh
npm start          # http://localhost:5173 — open ?net=local&profile=a and ?net=local&profile=b in two tabs
npm test           # unit tests (node:test)
npm run test:e2e   # two-player Playwright tests
```
