# Setting up Same Sky

There are three levels. Level 1 is enough to start playing tonight.

| Level | What you get | What you need |
|---|---|---|
| 1. GitHub Pages | The game on the web, real-time over a direct (WebRTC) connection | 2 minutes in GitHub settings |
| 2. + Supabase Realtime | A sturdier real-time connection (works on strict mobile networks too) | Free Supabase project, 2 repo variables |
| 3. + Claude (AI) | Fresh, personalised questions, prompts and a little poem about your night | Anthropic API key **stored only in Supabase** |

---

## 1. Put it on the web (GitHub Pages)

1. Open the repo on GitHub → **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab → **Deploy to GitHub Pages** → **Run workflow** (or just push a commit).
4. When it turns green, the URL appears in the run summary and under Settings → Pages:
   **`https://rusheekb.github.io/SameSky/`** (the path is case-sensitive — keep the capital
   S's when you share it).

That's it — open the link, create a room, send your partner the invite link.

> The deploy workflow runs on pushes to `main` (and to the branch this was built on). If you
> later rename the default branch to `main`, nothing else needs to change.

**Repo description:** on the repo home page click the ⚙️ next to *About*, paste the line below,
and put `https://rusheekb.github.io/SameSky/` in *Website*:

> Same Sky: real-time mini-games for long-distance couples. Sync your minds, guess each
> other's answers, doodle and write stories together, live on both phones.

The app only uses relative paths, so it works under any repo name. If you ever rename the repo
again, the URL changes with it and old links stop working.

---

## 2. Sturdier real-time with Supabase (recommended)

Without Supabase the two browsers connect directly with WebRTC, brokered by the free public
PeerJS server. That works for most people, but some mobile carriers and office/school networks
block it, and the public broker is best-effort. Supabase Realtime goes over a normal websocket.
No database tables are needed — the game only uses Realtime "broadcast" channels.

1. Create a free project at <https://supabase.com/dashboard> (any name/region; save the DB
   password somewhere, you won't need it for this).
2. In the project: **Project Settings → API Keys**. Copy:
   - the **Project URL** (`https://<project-ref>.supabase.co`, also on the project home page)
   - the **anon** / **publishable** key (`sb_publishable_…` or the legacy `eyJ…` anon key).
   These two values are **public by design** (they end up in every visitor's browser).
   ⚠️ Never use the `service_role` / `sb_secret_…` key — the deploy refuses it anyway.
3. In GitHub: repo **Settings → Secrets and variables → Actions → Variables** tab →
   **New repository variable**, add:
   - `SUPABASE_URL` = your Project URL
   - `SUPABASE_ANON_KEY` = your anon/publishable key
4. Re-run **Actions → Deploy to GitHub Pages**. The top bar's ⚙️ Settings sheet shows
   "Supabase Realtime" once it's live.

If it can't connect, check **Project Settings → Realtime** and make sure public channels are
allowed ("Allow public access" / private-only channels **off**). Free projects pause after a
week of inactivity — if that happens, open the Supabase dashboard and click *Restore*; in the
meantime the game offers a "Try a direct connection instead" button.

---

## 3. AI-written prompts with Claude (optional)

> **Needs section 2 first** — the website reaches the AI function through your Supabase project,
> so the `SUPABASE_URL` and `SUPABASE_ANON_KEY` variables must be set (this also moves the
> real-time connection to Supabase, which is what you want anyway).

### How your key stays safe

* The Anthropic key **never** goes into this repo, GitHub variables/secrets, the website, or a
  chat message. It lives only as a **Supabase Edge Function secret**.
* The website talks to a small function (`supabase/functions/same-sky-ai`) that holds the key.
  The browser can only ask for one of a fixed set of tasks ("8 questions for Know Me Better");
  it can't send its own prompts or read the key.
* The function **refuses every request** unless it carries a passcode that only you two know
  (`APP_PASSCODE`). Anyone else who finds your site gets a 401 and costs you nothing.
* Requests are size-limited and rate-limited, and each call has a capped output length.
* Add a **monthly spend limit** in the Anthropic Console as a final safety net.

### Steps

1. **Create a key** at <https://console.anthropic.com> → API Keys → *Create Key* (name it
   `same-sky`). Copy it once — don't paste it anywhere except step 3.
   Then **Settings → Limits** (or Billing) and set a small monthly spend limit, e.g. $5.
2. **Pick a passcode** only the two of you know — a few words, at least 10 characters, e.g.
   `pancakes-under-the-same-moon`. You'll type it once on each device. The function refuses
   passcodes shorter than 10 characters or made of a single word (like `iloveyou2024`), and it
   pauses itself for a few minutes after 30 wrong guesses, so nobody can brute-force it.
3. **Store both as Supabase secrets** — in the Supabase dashboard: **Edge Functions → Secrets**
   (a.k.a. *Manage secrets*) → add:
   - `ANTHROPIC_API_KEY` = your key
   - `APP_PASSCODE` = your passcode
   - optional `ANTHROPIC_MODEL` (default `claude-opus-5-5`; `claude-haiku-5-5` is much cheaper
     and fine for party prompts)
   - optional `AI_EFFORT` = `low` (default), `medium` or `high` — how hard Claude thinks
   - optional `ALLOWED_ORIGINS` = `https://rusheekb.github.io` (locks the function to your
     site; comma-separate extra origins, e.g. add `http://localhost:5173` for local testing)
4. **Deploy the function** — pick one:
   - **From GitHub (no installs):** create a Supabase access token at
     <https://supabase.com/dashboard/account/tokens>, then in GitHub add a repository **secret**
     `SUPABASE_ACCESS_TOKEN` (that token) and a repository **variable** `SUPABASE_PROJECT_REF`
     (the `<project-ref>` part of your Supabase URL). Run **Actions → Deploy AI function to
     Supabase**.
   - **From your computer:** install the [Supabase CLI](https://supabase.com/docs/guides/cli),
     then in this repo:
     ```sh
     supabase login
     supabase link --project-ref <project-ref>
     supabase functions deploy same-sky-ai --no-verify-jwt
     ```
     (If you prefer setting secrets from the CLI, put them in `supabase/.env` — already
     git-ignored — and run `supabase secrets set --env-file supabase/.env`, then delete the file.
     Don't type the key directly on the command line; it would land in your shell history.)
5. **Turn it on in the website:** add the GitHub repository variable `AI_ENABLED` = `true` and
   re-run **Deploy to GitHub Pages**.
6. **In the game:** ⚙️ Settings → enter the AI passcode (once per device) and, optionally, a few
   lines "About us" (how you met, inside jokes — used to personalise questions). In the lobby,
   tap **AI on**. Games then start with freshly written content, Story Chain gets AI twists
   and endings, and *Our night so far* can write you a little poem.

**Cost:** each generation is one short request (roughly 1–3k tokens). With the default
`claude-opus-5-5` that's a few cents per game; with `claude-haiku-5-5` it's a fraction of a
cent. Games always fall back to the built-in cards if the AI is slow, off, or out of credit.

**Rotating the key:** create a new key in the Anthropic Console, update the Supabase secret,
delete the old key. No redeploy of the website needed.

---

## Local development

```sh
npm start                     # http://localhost:5173
npm test                      # unit tests (Node 20+)
npm run test:e2e              # two-player browser tests (needs Playwright + Chromium installed)
```

Two players in one browser: open `http://localhost:5173/?net=local&profile=a` and
`http://localhost:5173/?net=local&profile=b` in two tabs. To try your Supabase project locally,
put its URL/anon key into `js/config.js` temporarily (don't commit them — the deploy writes that
file from the repo variables).
