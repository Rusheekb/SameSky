// Client for the optional "same-sky-ai" Supabase Edge Function, which holds the Anthropic key.
// The browser never sees the Anthropic key; it only sends a task name + small parameters, and
// a shared passcode that the two of you set as a Supabase secret (APP_PASSCODE).

import { storage } from './storage.js';

export const AI_FUNCTION = 'same-sky-ai';
const PASSCODE_KEY = 'aiPasscode';

export class AiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code; // 'unavailable' | 'passcode' | 'rate_limited' | 'bad_output' | 'network' | 'server'
  }
}

export function aiConfigured(config) {
  return !!(config?.aiEnabled && config?.supabaseUrl && config?.supabaseAnonKey);
}

export const getPasscode = () => storage.get(PASSCODE_KEY, '') || '';
export const setPasscode = (code) => storage.set(PASSCODE_KEY, String(code || '').slice(0, 200));

/**
 * Ask the edge function to generate content.
 * @param {object} config  js/config.js
 * @param {string} task    e.g. 'knowme_questions' (see supabase/functions/same-sky-ai)
 * @param {object} params  { vibe, aboutUs, names, ... }
 */
export async function aiGenerate(config, task, params = {}, { timeoutMs = 45000 } = {}) {
  if (!aiConfigured(config)) throw new AiError('unavailable', 'AI is not set up');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/functions/v1/${AI_FUNCTION}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
        'x-same-sky-passcode': getPasscode(),
      },
      body: JSON.stringify({ task, params }),
    });
  } catch (err) {
    throw new AiError('network', err?.name === 'AbortError' ? 'AI took too long' : 'Could not reach the AI');
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (res.status === 401 || res.status === 403) throw new AiError('passcode', body?.error || 'Wrong AI passcode');
  if (res.status === 429) throw new AiError('rate_limited', body?.error || 'Slow down a little');
  if (!res.ok) throw new AiError('server', body?.error || `AI error (${res.status})`);
  if (!body || typeof body !== 'object' || !body.result) throw new AiError('bad_output', 'AI returned nothing usable');
  return body.result;
}
