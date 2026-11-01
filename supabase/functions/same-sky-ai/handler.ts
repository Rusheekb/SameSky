// Request handler for the `same-sky-ai` Edge Function. Pure: no Deno globals and no npm imports;
// everything from the outside world (secrets, the Anthropic client, SDK error classes, the clock,
// rate limiters, logging) is injected, so Node unit tests can drive it with fakes.
// index.ts wires in the real Anthropic SDK and Deno.env.
//
// Flow: CORS -> POST only -> APP_PASSCODE configured and strong enough -> per-IP rate limit ->
//       passcode (behind a global cap on wrong guesses) -> body size -> JSON -> known task ->
//       ANTHROPIC_API_KEY configured -> global rate limit -> fixed prompt from sanitised params ->
//       Claude (structured output, inside the browser's time budget) -> stop reason -> JSON ->
//       sanitiser -> { result }

import type { ObjectSchema, TaskName } from './tasks.ts';
import { TASKS, buildPrompt, isTaskName, sanitizeParams } from './tasks.ts';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_EFFORT = 'low';
export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];
export const MAX_TOKENS = 8000;
export const MAX_BODY_BYTES = 16 * 1024;
export const MIN_PASSCODE_LENGTH = 10;
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const ALLOWED_HEADERS = 'authorization, x-client-info, apikey, content-type, x-same-sky-passcode';

/**
 * Time budget for the whole Claude call, retry included, counted from when the request arrives.
 * The browser (js/lib/ai.js) gives up after 45 s; the rest is left for the network, the gateway
 * and a cold start. The SDK never retries on its own (maxRetries 0): the handler retries once,
 * and only when a quick failure (overloaded, 5xx, dropped connection) leaves enough time.
 */
export const UPSTREAM_BUDGET_MS = 38_000;
export const RETRY_MIN_MS = 15_000; // time that must remain for the one retry to be worth it
export const RETRY_DELAY_MS = 1_000;

/** Best-effort, in-memory, PER INSTANCE (Supabase may run several instances, each counting alone). */
export const RATE_WINDOW_MS = 10 * 60 * 1000;
export const RATE_PER_IP = 20; // per client address per window (wrong passcodes count too)
export const RATE_GLOBAL = 60; // model calls per instance per window
/**
 * Wrong passcodes per instance per window, from everyone together. Once reached, every request
 * (right passcode or not) gets a 429 until the oldest failure is out of the window. That turns
 * a guessing attack into a short AI outage for the couple (the games fall back to their built-in
 * prompts) instead of a found passcode, and it doesn't depend on any client-supplied header.
 */
export const RATE_FAILED_PASSCODES = 30;

// ---------------------------------------------------------------- injected dependencies

export interface Env {
  get(name: string): string | undefined;
}

/** `output_config.format` as the API takes it: our schema exactly as written (no SDK transform). */
export interface OutputFormat {
  type: 'json_schema';
  schema: ObjectSchema;
}

/** The exact params handed to `client.beta.messages.create`. */
export interface ModelRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
  output_config: { effort: Effort; format: OutputFormat };
  betas?: string[];
  fallbacks?: 'default';
}

/** Per-call SDK request options. */
export interface ModelCallOptions {
  /** Aborts the upstream call when the browser goes away. */
  signal?: AbortSignal;
  /** Milliseconds for this attempt. */
  timeout: number;
  /** Always 0: the handler decides about retries itself (see UPSTREAM_BUDGET_MS). */
  maxRetries: 0;
}

/** The parts of the SDK's BetaMessage the handler reads. */
export interface ModelResponse {
  model?: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    iterations?: ReadonlyArray<{ type?: string }> | null;
  } | null;
}

export interface ModelClient {
  beta: { messages: { create(params: ModelRequest, options: ModelCallOptions): PromiseLike<ModelResponse> } };
}

type ErrorClass = abstract new (...args: never[]) => Error;

/** SDK error classes, for `instanceof` checks (Anthropic.AuthenticationError etc.). */
export interface SdkErrors {
  AnthropicError: ErrorClass;
  APIError: ErrorClass;
  AuthenticationError: ErrorClass;
  RateLimitError: ErrorClass;
}

export interface RateLimiter {
  /** Records a hit. Returns 0 when allowed, else the seconds until the next hit is allowed. */
  hit(key: string, now: number): number;
  /** Takes back a hit recorded at `at` (e.g. a passcode attempt that turned out to be right). */
  undo(key: string, at: number): void;
}

export interface Limits {
  perIp: RateLimiter;
  global: RateLimiter;
  /** Wrong passcodes from everyone (one key, '*'). */
  failedPasscodes: RateLimiter;
}

export interface HandlerDeps {
  env: Env;
  /** Returns an Anthropic-like client for this key (index.ts caches the real one). */
  getClient(apiKey: string): ModelClient;
  errors: SdkErrors;
  limits: Limits;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

// ---------------------------------------------------------------- rate limiting

/** Sliding-window counter per key; forgets the least recently used keys beyond `maxKeys`. */
export function createRateLimiter(limit: number, windowMs: number, maxKeys = 5000): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    hit(key, now) {
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      hits.delete(key);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
      return 0;
    },
    undo(key, at) {
      const list = hits.get(key);
      const i = list ? list.lastIndexOf(at) : -1;
      if (list && i >= 0) list.splice(i, 1);
    },
  };
}

export function createLimits(): Limits {
  return {
    perIp: createRateLimiter(RATE_PER_IP, RATE_WINDOW_MS),
    global: createRateLimiter(RATE_GLOBAL, RATE_WINDOW_MS),
    failedPasscodes: createRateLimiter(RATE_FAILED_PASSCODES, RATE_WINDOW_MS, 1),
  };
}

/**
 * The address to rate-limit on. Proxies APPEND to X-Forwarded-For, so its left-most entries are
 * whatever the caller sent and only the RIGHT-most one was written by infrastructure (the hop
 * that talks to this function). If that hop is a shared proxy, the limit becomes per-proxy:
 * stricter, never looser; the global cap on wrong passcodes doesn't depend on it at all.
 * cf-connecting-ip / x-real-ip are only used when there is no X-Forwarded-For.
 */
export function clientIp(req: Request): string {
  const hops = (req.headers.get('x-forwarded-for') || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const ip = hops[hops.length - 1] || req.headers.get('cf-connecting-ip')?.trim() || req.headers.get('x-real-ip')?.trim();
  return (ip || 'unknown').slice(0, 64);
}

// ---------------------------------------------------------------- passcode strength

/**
 * Why APP_PASSCODE is too weak to guard the key, or null when it's fine. Guessing is capped (see
 * RATE_FAILED_PASSCODES), but a short or single-word passcode would still fall to a dictionary
 * within days, so the function refuses to run with one.
 */
export function passcodeProblem(passcode: string): string | null {
  const length = [...passcode].length;
  if (length < MIN_PASSCODE_LENGTH) return `APP_PASSCODE needs at least ${MIN_PASSCODE_LENGTH} characters`;
  // One word, maybe with a number after it ("sweetheart", "iloveyou2024"), or only digits.
  if (length < 16 && /^(?:\p{L}+\p{N}*|\p{N}+)$/u.test(passcode)) {
    return 'APP_PASSCODE is a single word: use a few words, e.g. pancakes-under-the-same-moon';
  }
  return null;
}

// ---------------------------------------------------------------- CORS

function normalizeOrigin(o: string): string {
  const t = o.trim().toLowerCase().replace(/\/+$/, '');
  try {
    return new URL(t).origin; // "https://you.github.io/Game/" -> "https://you.github.io"
  } catch {
    return t;
  }
}

export function allowedOrigins(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o && o !== '*')
    .map(normalizeOrigin);
}

/**
 * CORS headers for this request, and whether its Origin may use the AI. Without ALLOWED_ORIGINS
 * any site may call (the passcode still guards it). A browser Origin that isn't on the list still
 * gets readable CORS headers (its preflight passes too), so the page can show the 403 "origin not
 * allowed" instead of a bare network error; the request itself is refused before anything runs.
 */
export function corsFor(origin: string | null, allowedRaw: string | undefined): { headers: Record<string, string>; allowed: boolean } {
  const base: Record<string, string> = {
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
  };
  const allowed = allowedOrigins(allowedRaw);
  if (!allowed.length) return { headers: { ...base, 'Access-Control-Allow-Origin': '*' }, allowed: true };
  if (!origin) return { headers: { ...base, Vary: 'Origin' }, allowed: true }; // not a browser: nothing to allow
  return {
    headers: { ...base, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' },
    allowed: allowed.includes(normalizeOrigin(origin)),
  };
}

// ---------------------------------------------------------------- helpers

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** Constant-time string comparison (hashing first hides the length too). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Header values must be Latin-1, so a client may send the passcode URI-encoded
 * (encodeURIComponent). Accept either form; both comparisons always run.
 */
async function passcodeMatches(given: string, expected: string): Promise<boolean> {
  let decoded = given;
  try {
    decoded = decodeURIComponent(given);
  } catch {
    /* not encoded */
  }
  const [raw, dec] = await Promise.all([safeEqual(given, expected), safeEqual(decoded.trim(), expected)]);
  return raw || dec;
}

/** Reads at most `max` bytes; null when the body is larger. */
async function readBody(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Never let a secret reach the logs, even inside an upstream message. */
function redact(text: string, secrets: string[]): string {
  let out = text.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out.slice(0, 300);
}

function modelSupportsFallback(model: string): boolean {
  // Claude Haiku 5.5 has no server-side fallback (docs: don't send `fallbacks` to it).
  return !/haiku/i.test(model);
}

/**
 * The full params for `client.beta.messages.create` (exported for tests). The schema goes out
 * exactly as written in tasks.ts (it already follows the strict structured-outputs subset).
 * Structured outputs need no beta header; `betas` only carries the fallback beta.
 */
export function buildModelRequest(task: TaskName, params: ReturnType<typeof sanitizeParams>, env: Env): ModelRequest {
  const model = (env.get('ANTHROPIC_MODEL') || '').trim() || DEFAULT_MODEL;
  const wanted = (env.get('AI_EFFORT') || '').trim().toLowerCase();
  const effort: Effort = (EFFORTS as readonly string[]).includes(wanted) ? (wanted as Effort) : DEFAULT_EFFORT;
  const { system, user } = buildPrompt(task, params);
  // No temperature/top_p/top_k (not accepted on current models) and no `thinking`: thinking is
  // always on for Claude Opus 5.5; `effort` is the control for how much it thinks.
  const req: ModelRequest = {
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort, format: { type: 'json_schema', schema: TASKS[task].schema } },
  };
  if (modelSupportsFallback(model)) {
    // If a safety classifier declines (a false positive on a party game, realistically), the API
    // re-runs the request on Anthropic's recommended fallback model instead of refusing.
    req.betas = [FALLBACK_BETA];
    req.fallbacks = 'default';
  }
  return req;
}

/**
 * The reply's JSON text: the text blocks after the last `fallback` marker (a model that declined
 * mid-answer leaves its partial text before the marker), joined. '' when there is none.
 */
export function replyText(content: ModelResponse['content'] | null | undefined): string {
  const blocks = Array.isArray(content) ? content : [];
  let from = 0;
  blocks.forEach((b, i) => {
    if (b?.type === 'fallback') from = i + 1;
  });
  return blocks
    .slice(from)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** Upstream failures worth one more try: overloaded / 5xx / 408 / 409 / a dropped connection. */
function retryable(err: unknown, errors: SdkErrors): boolean {
  const api = err instanceof errors.APIError;
  const rateLimited = err instanceof errors.RateLimitError;
  const badKey = err instanceof errors.AuthenticationError;
  if (!api || rateLimited || badKey) return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status !== 'number') return true; // connection error (a timeout leaves no time anyway)
  return status === 408 || status === 409 || status >= 500;
}

// ---------------------------------------------------------------- handler

export async function handle(req: Request, deps: HandlerDeps): Promise<Response> {
  const log = deps.log || ((line: string) => console.log(line));
  try {
    return await handleInner(req, deps, log);
  } catch (err) {
    log(JSON.stringify({ fn: 'same-sky-ai', error: 'unexpected', name: (err as Error)?.name || 'Error' }));
    let headers: Record<string, string> = {};
    try {
      headers = corsFor(req.headers.get('origin'), deps.env.get('ALLOWED_ORIGINS')).headers;
    } catch {
      /* keep it plain */
    }
    return json(500, { error: 'Internal error' }, headers);
  }
}

async function handleInner(req: Request, deps: HandlerDeps, log: (line: string) => void): Promise<Response> {
  const { env, limits } = deps;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const arrived = now();

  const { headers: cors, allowed } = corsFor(req.headers.get('origin'), env.get('ALLOWED_ORIGINS'));
  // Preflights always pass, so the browser sends the real request and can read its refusal.
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!allowed) return json(403, { error: 'This website is not allowed to use the AI (ALLOWED_ORIGINS)' }, cors);
  if (req.method !== 'POST') return json(405, { error: 'Use POST' }, { ...cors, Allow: 'POST, OPTIONS' });

  // Fail closed: without a passcode anyone who finds the URL could spend the key.
  const passcode = (env.get('APP_PASSCODE') || '').trim();
  if (!passcode) return json(500, { error: 'Server not configured: set APP_PASSCODE' }, cors);
  const weak = passcodeProblem(passcode);
  if (weak) return json(500, { error: `Server not configured: ${weak}` }, cors);

  // Before the passcode check, so guessing is throttled too.
  const ipWait = limits.perIp.hit(clientIp(req), now());
  if (ipWait) {
    return json(429, { error: 'Too many AI requests. Try again in a few minutes' }, { ...cors, 'Retry-After': String(ipWait) });
  }

  const given = (req.headers.get('x-same-sky-passcode') || '').trim();
  if (!given) return json(401, { error: 'AI passcode missing: add it in Settings' }, cors);
  // Every comparison takes a slot in the global wrong-guess budget first (concurrent guesses
  // can't slip past the cap while the hash runs); a right passcode gives its slot back.
  const attemptAt = now();
  const lockWait = limits.failedPasscodes.hit('*', attemptAt);
  if (lockWait) {
    return json(
      429,
      { error: 'Too many wrong AI passcodes lately, so the AI is paused. Try again in a few minutes' },
      { ...cors, 'Retry-After': String(lockWait) },
    );
  }
  if (!(await passcodeMatches(given, passcode))) {
    log(JSON.stringify({ fn: 'same-sky-ai', error: 'wrong_passcode' }));
    return json(401, { error: 'Wrong AI passcode' }, cors);
  }
  limits.failedPasscodes.undo('*', attemptAt);

  const text = await readBody(req, MAX_BODY_BYTES);
  if (text === null) return json(413, { error: 'Request too large' }, cors);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'Request body must be JSON' }, cors);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Expected { task, params }' }, cors);
  const { task, params } = body as { task?: unknown; params?: unknown };
  if (!isTaskName(task)) return json(400, { error: 'Unknown task' }, cors);

  const apiKey = (env.get('ANTHROPIC_API_KEY') || '').trim();
  if (!apiKey) return json(500, { error: 'Server not configured: set ANTHROPIC_API_KEY' }, cors);

  const globalWait = limits.global.hit('*', now());
  if (globalWait) {
    return json(429, { error: 'The AI is taking a breather. Try again in a few minutes' }, { ...cors, 'Retry-After': String(globalWait) });
  }

  const clean = sanitizeParams(params);
  const request = buildModelRequest(task, clean, env);
  const info = { task, model: request.model, secrets: [apiKey, passcode] };
  const deadline = arrived + UPSTREAM_BUDGET_MS;
  const started = now();
  let res: ModelResponse | null = null;
  for (let attempt = 1; !res; attempt++) {
    try {
      res = await deps.getClient(apiKey).beta.messages.create(request, {
        signal: req.signal,
        timeout: Math.max(1000, deadline - now()),
        maxRetries: 0,
      });
    } catch (err) {
      if (req.signal?.aborted) {
        // The browser gave up or left; the SDK has already cancelled the upstream call.
        log(JSON.stringify({ fn: 'same-sky-ai', task, model: request.model, error: 'client_gone', ms: now() - started }));
        return json(499, { error: 'Request cancelled' }, cors);
      }
      if (attempt === 1 && retryable(err, deps.errors) && deadline - now() - RETRY_DELAY_MS >= RETRY_MIN_MS) {
        logError(err, log, { ...info, retrying: true });
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return modelError(err, deps.errors, cors, log, info);
    }
  }

  // Log what the call cost before anything below can fail.
  const usage = res.usage || {};
  const fallback = (usage.iterations || []).some((it) => it?.type === 'fallback_message');
  log(
    JSON.stringify({
      fn: 'same-sky-ai',
      task,
      model: res.model || request.model,
      effort: request.output_config.effort,
      stop_reason: res.stop_reason,
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      fallback,
      ms: now() - started,
    }),
  );

  if (res.stop_reason === 'refusal') {
    log(JSON.stringify({ fn: 'same-sky-ai', task, refusal: res.stop_details?.category ?? null }));
    return json(422, { error: 'Claude passed on that one. Try another vibe or edit "About us"' }, cors);
  }
  if (res.stop_reason === 'max_tokens' || res.stop_reason === 'model_context_window_exceeded') {
    return json(502, { error: 'AI reply was cut off' }, cors);
  }
  const reply = replyText(res.content);
  if (!reply) return json(502, { error: 'AI returned nothing usable' }, cors);
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch (err) {
    log(JSON.stringify({ fn: 'same-sky-ai', task, error: 'unparseable_reply', name: (err as Error)?.name || 'Error', chars: reply.length }));
    return json(502, { error: 'AI returned something unreadable' }, cors);
  }

  const result = TASKS[task].sanitize(parsed, clean);
  if (!result) return json(502, { error: 'AI returned too few usable items' }, cors);
  return json(200, { result }, cors);
}

function logError(
  err: unknown,
  log: (line: string) => void,
  info: { task: string; model: string; secrets: string[]; retrying?: boolean },
): void {
  const status = (err as { status?: unknown })?.status;
  log(
    JSON.stringify({
      fn: 'same-sky-ai',
      task: info.task,
      model: info.model,
      error: (err as Error)?.name || 'Error',
      status: typeof status === 'number' ? status : null,
      message: redact(String((err as Error)?.message || ''), info.secrets),
      ...(info.retrying ? { retrying: true } : {}),
    }),
  );
}

function modelError(
  err: unknown,
  errors: SdkErrors,
  cors: Record<string, string>,
  log: (line: string) => void,
  info: { task: string; model: string; secrets: string[] },
): Response {
  logError(err, log, info);
  const status = (err as { status?: unknown })?.status;
  // Only short, fixed messages go back to the browser: never upstream text, never the key.
  if (err instanceof errors.AuthenticationError) return json(500, { error: 'Server AI key invalid' }, cors);
  if (err instanceof errors.RateLimitError) {
    const h = (err as { headers?: { get?(name: string): string | null } }).headers;
    const ra = Math.round(Number(h?.get?.('retry-after')));
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 600) : 30;
    return json(429, { error: 'Claude is busy right now. Try again in a minute' }, { ...cors, 'Retry-After': String(wait) });
  }
  if (err instanceof errors.APIError) {
    if (status === 404) return json(502, { error: 'AI model not found (check ANTHROPIC_MODEL)' }, cors);
    return json(502, { error: typeof status === 'number' ? `AI service error (${status})` : 'Could not reach the AI service' }, cors);
  }
  if (err instanceof errors.AnthropicError) return json(502, { error: 'AI service error' }, cors);
  return json(500, { error: 'Internal error' }, cors);
}
