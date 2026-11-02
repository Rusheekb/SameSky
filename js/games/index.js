// Game registry. Logic modules are imported eagerly (the authority needs them to run reducers);
// views are loaded lazily when a game starts.
import * as insync from './insync/logic.js';
import * as knowme from './knowme/logic.js';
import * as thisorthat from './thisorthat/logic.js';
import * as doodle from './doodle/logic.js';
import * as duet from './duet/logic.js';
import * as deeptalk from './deeptalk/logic.js';
import * as story from './story/logic.js';

export const GAME_LIST = [insync, knowme, thisorthat, doodle, duet, deeptalk, story];

export const GAMES = new Map(GAME_LIST.map((m) => [m.meta.id, m]));

/** Line icon (js/ui/icons.js) for each game: used on lobby cards, game headers and the recap. */
export const GAME_ICONS = {
  insync: 'orbit',
  knowme: 'message-circle-question',
  thisorthat: 'split',
  doodle: 'pencil',
  duet: 'brush',
  deeptalk: 'messages-square',
  story: 'book-open',
};
export const iconFor = (id) => GAME_ICONS[id] || 'dice-5';

const VIEWS = {
  insync: () => import('./insync/view.js'),
  knowme: () => import('./knowme/view.js'),
  thisorthat: () => import('./thisorthat/view.js'),
  doodle: () => import('./doodle/view.js'),
  duet: () => import('./duet/view.js'),
  deeptalk: () => import('./deeptalk/view.js'),
  story: () => import('./story/view.js'),
};

export function loadView(id) {
  const load = VIEWS[id];
  if (!load) return Promise.reject(new Error(`Unknown game ${id}`));
  return load().then((m) => m.default);
}
