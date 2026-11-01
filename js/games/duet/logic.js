// Duet Canvas — both of you draw on one shared canvas at the same time, with a prompt on top.
//
// Phases: draw -> done -> (draw ...). "We're done!" needs both of you (so nobody gets cut off
// mid-line); a finished canvas is worth 3 together points. Strokes live in fx, never in state.

import { PROMPTS, VIBE_ORDER, ALL_PROMPTS } from '../../content/duet.js';
import { cleanText, normalizeWord, shuffle } from '../../lib/util.js';

export const POINTS_PER_CANVAS = 3;
export const PROMPT_MAX = 90;
const POOL_SIZE = 12;

export const meta = {
  id: 'duet',
  title: 'Duet Canvas',
  emoji: '🖌️',
  tagline: 'Draw together, live.',
  description:
    'One canvas, two pens, zero rules. Draw the prompt together in real time and watch each other’s lines appear. Finish it together to frame your masterpiece.',
  minPlayers: 2,
  ai: { task: 'duet_prompts', label: 'drawing prompts' },
};

/** Sanitise AI-provided prompts: short single-line strings, unique. */
export function validPrompts(content) {
  const raw = Array.isArray(content?.prompts) ? content.prompts : [];
  const out = [];
  const seen = new Set();
  for (const p of raw.slice(0, 40)) {
    if (typeof p !== 'string' || p.length > 300) continue;
    const t = cleanText(p, PROMPT_MAX).replace(/^[-*•\d.)\s]+/, '');
    const n = normalizeWord(t);
    if (t.length < 4 || n.length < 3 || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

const key = (p) => normalizeWord(p);

/** A pool leaning towards tonight's vibe (about half), the rest from the other vibes. */
export function bankPool(rand, vibe, avoid = []) {
  const skip = new Set(avoid.map(key));
  const fresh = (list) => list.filter((p) => !skip.has(key(p)));
  const main = PROMPTS[vibe] ? vibe : 'sweet';
  const own = shuffle(fresh(PROMPTS[main]), rand);
  const rest = shuffle(fresh(VIBE_ORDER.filter((v) => v !== main).flatMap((v) => PROMPTS[v])), rand);
  const out = [];
  while (out.length < POOL_SIZE && (own.length || rest.length)) {
    if (own.length && (out.length % 2 === 0 || !rest.length)) out.push(own.shift());
    else out.push(rest.shift());
  }
  return out.length ? out : shuffle(ALL_PROMPTS, rand).slice(0, POOL_SIZE);
}

function cid(rand) {
  return Math.floor(rand() * 2176782336).toString(36).padStart(6, '0');
}

export function init(ctx, opts = {}) {
  const ai = validPrompts(opts.content);
  const pool = ai.length >= 3 ? [...ai, ...bankPool(ctx.random, ctx.settings?.vibe, ai)].slice(0, POOL_SIZE + ai.length) : bankPool(ctx.random, ctx.settings?.vibe);
  const [prompt, ...rest] = pool;
  return {
    phase: 'draw', // draw -> done -> draw ...
    n: 1, // canvas number (board key = `${cid}-${n}`)
    cid: cid(ctx.random),
    prompt,
    pool: rest.slice(0, 20),
    used: [prompt],
    ready: {}, // playerId -> true when they think it's finished
    shuffles: 0,
    startedAt: ctx.now,
    finished: [], // [{ n, prompt, mins }] newest last
    ai: ai.length >= 3,
    done: false,
    plays: 0,
    points: 0,
    summary: '',
    highlights: [],
  };
}

function nextPrompt(s, ctx) {
  let pool = s.pool;
  if (!pool.length) pool = bankPool(ctx.random, ctx.settings?.vibe, [...s.used, s.prompt]);
  let [prompt, ...rest] = pool;
  if (key(prompt) === key(s.prompt) && rest.length) [prompt, ...rest] = [...rest, prompt];
  return { prompt, pool: rest, used: [...s.used, prompt].slice(-30) };
}

function summaryOf(finished) {
  if (!finished.length) return 'Doodled together';
  const last = finished[finished.length - 1];
  return finished.length === 1
    ? `Drew “${last.prompt}” together`
    : `Drew ${finished.length} masterpieces together, last: “${last.prompt}”`;
}

export function reduce(s, a, ctx) {
  if (!a || !ctx.players.includes(a.by)) return s;
  switch (a.type) {
    case 'newPrompt': {
      if (s.phase !== 'draw') return s;
      return { ...s, ...nextPrompt(s, ctx), ready: {}, shuffles: s.shuffles + 1 };
    }
    case 'ready': {
      if (s.phase !== 'draw') return s;
      const on = a.on !== false;
      if (!!s.ready[a.by] === on) return s;
      const ready = { ...s.ready };
      if (on) ready[a.by] = true;
      else delete ready[a.by];
      if (!ctx.players.every((id) => ready[id])) return { ...s, ready };
      const mins = Math.max(1, Math.round((ctx.now - s.startedAt) / 60000));
      const finished = [...s.finished, { n: s.n, prompt: s.prompt, mins }].slice(-12);
      return {
        ...s,
        ready,
        phase: 'done',
        done: true,
        plays: s.plays + 1,
        finished,
        points: s.points + POINTS_PER_CANVAS,
        summary: summaryOf(finished),
        highlights: [...s.highlights, `Drew together: “${s.prompt}”`].slice(-6),
      };
    }
    case 'again': {
      if (s.phase !== 'done') return s;
      return { ...s, ...nextPrompt(s, ctx), phase: 'draw', n: s.n + 1, ready: {}, startedAt: ctx.now, done: false };
    }
    default:
      return s;
  }
}
