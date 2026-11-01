// Supabase Edge Function `same-sky-ai` (Deno). Holds the Anthropic API key as a secret and turns
// { task, params } from the Same Sky website into small JSON game content written by Claude.
// This file only wires up the real world (Deno.env, the Anthropic SDK); all logic is in
// handler.ts (request handling) and tasks.ts (prompts, schemas, sanitisers), which are unit-tested
// from Node in tests/unit/edge-function.test.js.
//
// Secrets (Supabase dashboard -> Edge Functions -> Secrets):
//   ANTHROPIC_API_KEY  required
//   APP_PASSCODE       required, at least 8 characters, shared by the two players
//   ANTHROPIC_MODEL    optional, default claude-opus-5-5
//   AI_EFFORT          optional, low | medium | high (default low: fast and cheap)
//   ALLOWED_ORIGINS    optional, comma-separated origins, e.g. https://you.github.io

import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0';
import { betaJSONSchemaOutputFormat } from 'npm:@anthropic-ai/sdk@1.3.0/helpers/beta/json-schema';
import { createLimits, handle } from './handler.ts';
import type { HandlerDeps, ModelClient } from './handler.ts';

// Module scope lives as long as the instance, so the rate limits and the client are shared by
// every request this instance serves (best-effort: each instance counts on its own).
const limits = createLimits();
let cached: { key: string; client: ModelClient } | null = null;

function getClient(apiKey: string): ModelClient {
  if (!cached || cached.key !== apiKey) {
    // Keep the whole call inside the browser's 45 s patience: one retry at most.
    const anthropic = new Anthropic({ apiKey, maxRetries: 1, timeout: 40_000 });
    cached = {
      key: apiKey,
      client: { beta: { messages: { parse: (params) => anthropic.beta.messages.parse(params) } } },
    };
  }
  return cached.client;
}

const deps: HandlerDeps = {
  env: { get: (name) => Deno.env.get(name) },
  getClient,
  // transform: false sends our schemas exactly as written. They already follow the strict
  // structured-outputs subset, and the default transform would move `enum` into the description.
  outputFormat: (schema) => betaJSONSchemaOutputFormat(schema as { type: 'object' }, { transform: false }),
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
