// Per-device identity and profile helpers.
import { storage } from '../lib/storage.js';
import { uid } from '../lib/util.js';

export const AVATARS = ['🌙', '☀️', '⭐', '🌸', '🌻', '🐻', '🐱', '🦊', '🐼', '🐧', '🦋', '🐢', '🍓', '🍑', '🧸', '👑', '🌈', '🔥', '🍀', '🎧'];
export const COLORS = ['#ff7eb6', '#ffb86b', '#ffe66d', '#7ef0c4', '#6ec8ff', '#b69cff'];

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
