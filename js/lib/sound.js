// Tiny WebAudio sound effects (no audio files). Muted state persists per device.
import { storage } from './storage.js';

let ctx = null;
let muted = storage.get('muted', false);

export const isMuted = () => muted;
export function setMuted(m) {
  muted = !!m;
  storage.set('muted', muted);
}

function ac() {
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq, start, dur, { type = 'sine', gain = 0.08, slide = 0 } = {}) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + start;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

const SOUNDS = {
  pop: () => tone(660, 0, 0.09, { type: 'triangle', slide: 220 }),
  tap: () => tone(440, 0, 0.05, { type: 'triangle', gain: 0.05 }),
  lock: () => {
    tone(520, 0, 0.08, { type: 'triangle' });
    tone(780, 0.07, 0.1, { type: 'triangle' });
  },
  reveal: () => [392, 494, 587].forEach((f, i) => tone(f, i * 0.06, 0.18, { type: 'sine' })),
  success: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.08, 0.25, { type: 'triangle', gain: 0.07 })),
  fail: () => tone(300, 0, 0.3, { type: 'sawtooth', gain: 0.03, slide: -120 }),
  tick: () => tone(1200, 0, 0.03, { type: 'square', gain: 0.02 }),
  heart: () => {
    tone(180, 0, 0.12, { gain: 0.12 });
    tone(160, 0.16, 0.14, { gain: 0.1 });
  },
  whoosh: () => tone(900, 0, 0.25, { type: 'sine', gain: 0.03, slide: -700 }),
};

export function play(name) {
  if (muted) return;
  try {
    SOUNDS[name]?.();
  } catch {
    /* audio blocked until a user gesture: fine */
  }
}
