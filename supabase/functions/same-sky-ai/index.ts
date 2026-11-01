// Supabase Edge Function `same-sky-ai` (Deno). Holds the Anthropic API key as a secret and turns
// { task, params } from the Same Sky website into small JSON game content written by Claude.
// This file only wires up the real world (Deno.env, the Anthropic SDK); all logic is in
// handler.ts (request handling) and tasks.ts (prompts, schemas, sanitisers), which are unit-tested
// from Node in tests/unit/edge-function.test.js.
//
// Secrets (Supabase dashboard -> Edge Functions -> Secrets):
//   ANTHROPIC_API_KEY  required
//   APP_PASSCODE       required, at least 10 characters and not a single word (a few words is
//                      ideal), shared by the two players
//   ANTHROPIC_MODEL    optional, default claude-opus-5-5
//   AI_EFFORT          optional, low | medium | high (default low: fast and cheap)
//   ALLOWED_ORIGINS    optional, comma-separated origins, e.g. https://you.github.io

import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0';
import { UPSTREAM_BUDGET_MS, createLimits, handle } from './handler.ts';
import type { HandlerDeps, ModelClient } from './handler.ts';

// Module scope lives as long as the instance, so the rate limits and the client are shared by
// every request this instance serves (best-effort: each instance counts on its own).
const limits = createLimits();
let cached: { key: string; client: ModelClient } | null = null;

function getClient(apiKey: string): ModelClient {
  if (!cached || cached.key !== apiKey) {
    // No SDK retries and a timeout inside the browser's 45 s patience: the handler passes each
    // call its own timeout and the request's AbortSignal, and retries once itself only when
    // there is time left (see UPSTREAM_BUDGET_MS in handler.ts).
    const anthropic = new Anthropic({ apiKey, maxRetries: 0, timeout: UPSTREAM_BUDGET_MS });
    cached = {
      key: apiKey,
      // create(), not parse(): the handler reads stop_reason and logs usage before it parses
      // the JSON itself, so a cut-off or declined reply is reported as such.
      client: { beta: { messages: { create: (params, options) => anthropic.beta.messages.create(params, options) } } },
    };
  }
  return cached.client;
}

const deps: HandlerDeps = {
  env: { get: (name) => Deno.env.get(name) },
  getClient,
  errors: {
    AnthropicError: Anthropic.AnthropicError,
    APIError: Anthropic.APIError,
    AuthenticationError: Anthropic.AuthenticationError,
    RateLimitError: Anthropic.RateLimitError,
  },
  limits,
  now: () => Date.now(),
};

Deno.serve((req) => handle(req, deps));
