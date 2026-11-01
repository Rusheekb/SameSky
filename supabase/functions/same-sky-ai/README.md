# `same-sky-ai` Edge Function

Optional AI backend for Same Sky. The website POSTs `{ task, params }` here; the function builds a
fixed prompt for that task, asks Claude for JSON (structured outputs), checks and trims the reply,
and returns `{ result }`. The Anthropic key lives only in Supabase secrets; the browser never sees
it and can't send its own prompts. Tasks and result shapes: `docs/ARCHITECTURE.md` → "AI tasks".

| file | |
|---|---|
| `index.ts` | Deno entry: reads secrets, creates the Anthropic SDK client (`npm:@anthropic-ai/sdk@1.3.0`) |
| `handler.ts` | CORS, passcode, limits, model call (`client.beta.messages.create`), reply checks, error mapping (pure, unit-tested from Node) |
| `tasks.ts` | per-task JSON schema, prompt template and sanitiser |

## Secrets

Set them in the Supabase dashboard → **Edge Functions → Secrets** (never in the repo or in GitHub):

| name | |
|---|---|
| `ANTHROPIC_API_KEY` | required |
| `APP_PASSCODE` | required: at least 10 characters and not a single word (a few words is ideal, e.g. `pancakes-under-the-same-moon`); every request must send it in `x-same-sky-passcode`. Without it, or with a weak one (`iloveyou`, `sweetheart`, `iloveyou2024`), the function refuses everything with a 500 that says why. |
| `ANTHROPIC_MODEL` | optional, default `claude-opus-5-5` (`claude-haiku-5-5` is much cheaper) |
| `AI_EFFORT` | optional, `low` (default), `medium` or `high` |
| `ALLOWED_ORIGINS` | optional, comma-separated, e.g. `https://you.github.io,http://localhost:5173`; other websites get a 403 (with CORS headers, so the page can show "not allowed" instead of a network error) |

## Deploy

```sh
supabase login
supabase link --project-ref <project-ref>
supabase functions deploy same-sky-ai --no-verify-jwt
```

or run the **Deploy AI function to Supabase** GitHub Action (see `SETUP.md`). JWT verification is
off on purpose (`supabase/config.toml`): new publishable keys aren't JWTs, and the passcode is the lock.

## Limits and costs

- Request body ≤ 16 KB; every param is capped (about-us 500 chars, 2 names × 24, 20 avoid × 200,
  story 2000, 20 highlights × 200); unknown vibes become `sweet`.
- Rate limits, per 10 minutes: 20 requests per client address, 60 model calls in total, and
  **30 wrong passcodes in total**. After 30 wrong guesses (from anyone, from any address) every
  request gets a 429 until the oldest guess is 10 minutes old, the right passcode included, so
  guessing can't be sped up by rotating addresses; the worst an attacker can do is pause the AI
  for a while (the games fall back to their built-in prompts). Wrong passcodes are logged
  (`"error":"wrong_passcode"`, without the guess).
- The client address is the **right-most** `x-forwarded-for` entry: proxies append to that header,
  so its left-most entries are whatever the caller sent, and only the last one was written by the
  platform. If that last hop is a shared proxy, the per-address limit becomes per-proxy (stricter,
  never looser). `cf-connecting-ip` / `x-real-ip` are only used when there is no `x-forwarded-for`.
- All limits are in-memory and **per instance** (Supabase can run several instances, and each
  counts on its own), so treat them as a speed bump. A strong passcode and a monthly spend limit in
  the Anthropic Console are the real protection.
- Time: the browser gives up after 45 s, so the whole model call gets **38 s**, counted from when
  the request arrives. The SDK never retries by itself (`maxRetries: 0`); the handler retries once
  only after a quick failure (overloaded/5xx/408/409/dropped connection) when at least 15 s are
  left, and gives that attempt only the time that remains. Upstream 429s are passed on with their
  `Retry-After`, not waited out. The request's `AbortSignal` goes to the SDK, so when the browser
  gives up or leaves, the upstream call is cancelled too (logged as `"error":"client_gone"`).
- Each call is capped at 8000 output tokens (thinking included). Opus 5.5 always thinks; `AI_EFFORT`
  controls how much. If a safety classifier declines, `fallbacks: "default"` retries on Anthropic's
  recommended fallback model (not used for Haiku, which has none).
- Claude's reply is checked in this order: `stop_reason` `refusal` → 422, `max_tokens` → 502 "cut
  off", then the JSON in its text block (the part after a `fallback` marker, if a model declined
  mid-answer) is parsed and sanitised. Structured outputs (`output_config.format`, our schemas
  exactly as written) need no beta header; only the fallback beta is sent.
- Every call logs one JSON line with the task, model, stop reason and input/output tokens **before**
  the reply is parsed, so cut-off and declined calls show their cost too: Supabase dashboard → Edge
  Functions → `same-sky-ai` → Logs. Player text, model text, the passcode and the key are never logged.

## Responses

`200 { result }` · `400` bad body / unknown task · `401` missing or wrong passcode · `403` origin not
allowed (readable from the browser) · `405` not POST · `413` body too large · `422` Claude declined ·
`429` rate limited, too many wrong passcodes, or Claude busy (`Retry-After`) · `499` the browser
gave up (nobody reads it) · `500` not configured / weak passcode / bad key · `502` upstream error,
cut-off or unusable reply.

Tests: `node --test tests/unit/edge-function.test.js` (fake client, no network).
