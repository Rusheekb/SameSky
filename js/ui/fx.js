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
  for (const [k, v] of Object.entries(style)) {
    if (k.startsWith('--')) el.style.setProperty(k, v); // custom properties need setProperty
    else el.style[k] = v;
  }
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

// Celebration: a handful of paper slips in the scene's colours (moonlight paper and lamplight).
const SLIPS = ['#f1e9da', '#f2b35c', '#e6dcc8', '#a3a9b8'];
export function confetti({ count = 22 } = {}) {
  if (reduced()) count = 6;
  for (let i = 0; i < count; i++) {
    const dur = 1800 + Math.random() * 1400;
    const w = 6 + Math.random() * 4;
    spawn('fx-confetti', '', {
      left: `${Math.random() * 100}vw`,
      '--c': SLIPS[i % SLIPS.length],
      '--w': `${w}px`,
      '--h': `${w * (1.3 + Math.random() * 0.6)}px`,
      animationDuration: `${dur}ms`,
      animationDelay: `${Math.random() * 300}ms`,
      '--spin': `${(Math.random() - 0.5) * 540}deg`,
      '--drift': `${(Math.random() - 0.5) * 140}px`,
    }, dur + 400);
  }
}

const HEART_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/></svg>';

/** A lamplight line heart in the middle of the screen ("thinking of you"), the same heart as the button. */
export function heartPulse(label = '') {
  const el = spawn('fx-heartpulse', '', {}, 2600);
  el.innerHTML = HEART_SVG; // static markup, no user content
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
export function hideToast() {
  clearTimeout(toastTimer);
  document.getElementById('toast')?.classList.remove('show');
}
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
