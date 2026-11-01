# `same-sky-ai` Edge Function

Optional AI backend for Same Sky. The website POSTs `{ task, params }` here; the function builds a
fixed prompt for that task, asks Claude for JSON (structured outputs), checks and trims the reply,
and returns `{ result }`. The Anthropic key lives only in Supabase secrets; the browser never sees
it and can't send its own prompts. Tasks and result shapes: `docs/ARCHITECTURE.md` → "AI tasks".

| file | |
|---|---|
| `index.ts` | Deno entry: reads secrets, creates the Anthropic SDK client (`npm:@anthropic-ai/sdk@1.3.0`) |
| `handler.ts` | CORS, passcode, limits, model call, error mapping (pure, unit-tested from Node) |
| `tasks.ts` | per-task JSON schema, prompt template and sanitiser |

## Secrets

Set them in the Supabase dashboard → **Edge Functions → Secrets** (never in the repo or in GitHub):

| name | |
|---|---|
| `ANTHROPIC_API_KEY` | required |
| `APP_PASSCODE` | required, at least 8 characters (a few words is ideal); every request must send it in `x-same-sky-passcode`. Without it the function refuses everything. |
| `ANTHROPIC_MODEL` | optional, default `claude-opus-5-5` (`claude-haiku-5-5` is much cheaper) |
| `AI_EFFORT` | optional, `low` (default), `medium` or `high` |
| `ALLOWED_ORIGINS` | optional, comma-separated, e.g. `https://you.github.io,http://localhost:5173`; other websites get a 403 |

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
- Rate limits: 20 requests per client IP and 60 model calls in total per 10 minutes. These are
  in-memory and **per instance** (Supabase can run several instances, and each counts on its own;
  the IP comes from `x-forwarded-for`), so treat them as a speed bump. The passcode and a monthly
  spend limit in the Anthropic Console are the real protection.
- Each call is capped at 8000 output tokens (thinking included). Opus 5.5 always thinks; `AI_EFFORT`
  controls how much. If a safety classifier declines, `fallbacks: "default"` retries on Anthropic's
  recommended fallback model (not used for Haiku, which has none).
- Every call logs one JSON line with the task, model, stop reason and input/output tokens: Supabase
  dashboard → Edge Functions → `same-sky-ai` → Logs. Player text, the passcode and the key are never logged.

## Responses

`200 { result }` · `400` bad body / unknown task · `401` missing or wrong passcode · `403` origin not
allowed · `405` not POST · `413` body too large · `422` Claude declined · `429` rate limited
(`Retry-After`) · `500` not configured / bad key · `502` upstream error or unusable reply.

Tests: `node --test tests/unit/edge-function.test.js` (fake client, no network).
