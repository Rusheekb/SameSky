// localStorage wrapper that never throws (private mode, blocked storage, quota) and namespaces
// keys per "profile slot" so two tabs can act as two different people while testing:
// add ?profile=b to the URL for a second identity in the same browser.

const slot = (() => {
  try {
    const p = new URLSearchParams(globalThis.location?.search || '').get('profile');
    return p ? `:${p.replace(/[^a-z0-9]/gi, '').slice(0, 12)}` : '';
  } catch {
    return '';
  }
})();

const PREFIX = `samesky${slot}:`;
const memory = new Map();

function ls() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = ls()?.getItem(PREFIX + key);
      if (raw == null) return memory.has(key) ? memory.get(key) : fallback;
      return JSON.parse(raw);
    } catch {
      return memory.has(key) ? memory.get(key) : fallback;
    }
  },
  set(key, value) {
    memory.set(key, value);
    try {
      ls()?.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
  remove(key) {
    memory.delete(key);
    try {
      ls()?.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
};
