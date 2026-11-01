// Small, dependency-free helpers shared by the app, the game logic and the tests.
// Everything here must stay DOM-free so it can run under Node's test runner.

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Random room code like "K7QM2X" (no 0/O/1/I/L to avoid confusion when read aloud). */
export function randomCode(len = 6, rand = Math.random) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return out;
}

/** Room codes are case-insensitive, alphanumeric, 4..24 chars. Custom names like "our-sky" become "OURSKY". */
export function normalizeRoomCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 24);
}

export function isValidRoomCode(code) {
  return /^[A-Z0-9]{4,24}$/.test(code || '');
}

/** "K7QM2X" -> "K7Q-M2X" for display; custom codes are left alone. */
export function formatCode(code) {
  return code && code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code || '';
}

export function uid(len = 10, rand = Math.random) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(rand() * chars.length)];
  return out;
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Fisher–Yates; returns a new array. */
export function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const pick = (arr, rand = Math.random) => arr[Math.floor(rand() * arr.length)];

export const sample = (arr, n, rand = Math.random) => shuffle(arr, rand).slice(0, n);

/** Deterministic PRNG (mulberry32) for tests and reproducible shuffles. */
export function seededRandom(seed = 1) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Normalise a typed word/phrase so that "The Waves!", "wave" and "WAVES" compare equal.
 * Lowercases, strips accents/punctuation/leading articles and does light singularisation.
 */
export function normalizeWord(input) {
  let s = String(input || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^(the|a|an) /, '');
  return s
    .split(' ')
    .map(singularize)
    .join(' ');
}

function singularize(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('ss') || w.endsWith('us') || w.endsWith('is')) return w;
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

export const wordsMatch = (a, b) => {
  const na = normalizeWord(a);
  return na.length > 0 && na === normalizeWord(b);
};

export function levenshtein(a, b) {
  a = String(a);
  b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** True when a guess is a near-miss (typo-level) but not an exact match. */
export function isCloseGuess(guess, answer) {
  const g = normalizeWord(guess);
  const a = normalizeWord(answer);
  if (!g || !a || g === a) return false;
  const d = levenshtein(g, a);
  if (a.length >= 8) return d <= 2;
  if (a.length >= 4) return d <= 1;
  return false;
}

/** Trim and cap user-entered text so state and network payloads stay small. */
export function cleanText(input, max = 200) {
  return String(input ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Multi-line variant of cleanText that keeps single newlines. */
export function cleanMultiline(input, max = 1000) {
  return String(input ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shallow structural equality for plain JSON-ish values (used to skip no-op state commits). */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}
