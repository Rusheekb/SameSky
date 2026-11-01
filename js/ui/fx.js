// Visual effects layer: confetti bursts, floating emoji reactions, the "miss you" pulse, toasts.
// All DOM-based (no canvas) and cheap; respects prefers-reduced-motion.

const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function layer() {
  let el = document.getElementById('fx-layer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fx-layer';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  return el;
}

function spawn(cls, text, style, life) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  Object.assign(el.style, style);
  layer().appendChild(el);
  setTimeout(() => el.remove(), life);
  return el;
}

/** Emoji floating up from the bottom of the screen (reactions). */
export function floatEmoji(emoji, { count = 1, fromPartner = false } = {}) {
  if (reduced()) count = 1;
  for (let i = 0; i < count; i++) {
    const x = fromPartner ? 55 + Math.random() * 35 : 10 + Math.random() * 35;
    const dur = 2200 + Math.random() * 1200;
    spawn('fx-float', emoji, {
      left: `${x}vw`,
      fontSize: `${28 + Math.random() * 22}px`,
      animationDuration: `${dur}ms`,
      animationDelay: `${i * 90}ms`,
      '--drift': `${(Math.random() - 0.5) * 120}px`,
    }, dur + i * 90 + 100);
  }
}

const CONFETTI = ['💖', '✨', '💫', '🌟', '💕', '🎉', '⭐'];
export function confetti({ emojis = CONFETTI, count = 28 } = {}) {
  if (reduced()) count = 6;
  for (let i = 0; i < count; i++) {
    const dur = 1600 + Math.random() * 1400;
    spawn('fx-confetti', emojis[i % emojis.length], {
      left: `${Math.random() * 100}vw`,
      fontSize: `${16 + Math.random() * 20}px`,
      animationDuration: `${dur}ms`,
      animationDelay: `${Math.random() * 300}ms`,
      '--spin': `${(Math.random() - 0.5) * 720}deg`,
      '--drift': `${(Math.random() - 0.5) * 160}px`,
    }, dur + 400);
  }
}

/** Big pulsing heart in the middle of the screen ("thinking of you"). */
export function heartPulse(label = '') {
  const el = spawn('fx-heartpulse', '💗', {}, 2600);
  if (label) {
    const cap = document.createElement('small');
    cap.textContent = label;
    el.appendChild(cap);
  }
  try {
    navigator.vibrate?.([80, 60, 120]);
  } catch {
    /* ignore */
  }
}

let toastTimer = null;
export function toast(message, { ms = 2600 } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
