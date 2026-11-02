// Per-device identity and profile helpers.
import { storage } from '../lib/storage.js';
import { uid } from '../lib/util.js';

export const AVATARS = ['🌙', '☀️', '⭐', '🌸', '🌻', '🐻', '🐱', '🦊', '🐼', '🐧', '🦋', '🐢', '🍓', '🍑', '🧸', '👑', '🌈', '🔥', '🍀', '🎧'];
// Player colours: muted enough to sit on the ink surfaces, distinct enough to tell two people apart.
export const COLORS = ['#f2b35c', '#ef8a74', '#e3cf8f', '#7fc8a9', '#7fa8e6', '#c3a3e6'];

/** Stable random id for this device (per ?profile= slot). */
export function getClientId() {
  let id = storage.get('clientId');
  if (!id) {
    id = uid(12);
    storage.set('clientId', id);
  }
  return id;
}

export function rememberRoom(code, partnerName) {
  const all = storage.get('recentRooms', []);
  const prev = all.find((r) => r.code === code);
  const list = all.filter((r) => r.code !== code);
  list.unshift({ code, partner: partnerName || prev?.partner || '', at: Date.now() });
  storage.set('recentRooms', list.slice(0, 6));
}
