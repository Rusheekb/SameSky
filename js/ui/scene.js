// The one bright element of Same Sky: two lit windows on opposite shores under the same moon,
// the moonlight lying on the water between them. Drawn in code (no image files), static.
// Used only on the home and invite screens; everything else stays quiet ink.
import { html } from './h.js';

// Deterministic star field (no Math.random at render, so it never jumps between renders).
// Canvas is 400x400; the headline sits over the calm top-left, so stars keep to the right and lower sky.
const STARS = [
  [300, 24, 0.9, 0.55], [334, 52, 0.7, 0.4], [362, 18, 1.1, 0.7], [388, 44, 0.6, 0.35], [318, 86, 0.6, 0.3],
  [376, 98, 1.0, 0.6], [394, 128, 0.7, 0.45], [292, 128, 0.6, 0.3], [268, 196, 0.8, 0.4], [372, 206, 0.7, 0.35],
  [392, 238, 0.9, 0.5], [236, 226, 0.6, 0.3], [296, 240, 0.5, 0.25], [352, 252, 0.6, 0.3], [204, 210, 0.6, 0.3],
  [176, 236, 0.5, 0.25], [214, 262, 0.6, 0.3], [150, 258, 0.5, 0.2], [24, 238, 0.6, 0.25], [92, 246, 0.5, 0.2],
  [326, 272, 0.6, 0.3], [60, 266, 0.5, 0.2], [118, 274, 0.4, 0.2], [384, 276, 0.5, 0.25], [252, 286, 0.5, 0.2],
];

/** Horizontal strokes of light on the water (moon path or a window's lamplight). */
function reflection(cx, top, rows, maxW, color, maxOpacity) {
  const out = [];
  for (let i = 0; i < rows; i++) {
    const t = i / Math.max(1, rows - 1);
    const w = maxW * (1 - t * 0.7) * (0.75 + ((i * 37) % 10) / 40);
    const x = cx - w / 2 + (((i * 53) % 7) - 3);
    out.push(html`<rect x=${x.toFixed(1)} y=${(top + i * 6).toFixed(1)} width=${w.toFixed(1)} height="1.4" rx="0.7"
      fill=${color} opacity=${(maxOpacity * (1 - t * 0.75)).toFixed(2)} />`);
  }
  return out;
}

export function NightScene({ class: cls = 'hero-scene', label = 'Two lit windows on opposite shores under the same moon' }) {
  return html`<svg class=${cls} viewBox="0 0 400 400" preserveAspectRatio="xMidYMax slice" role="img" aria-label=${label}>
    <defs>
      <linearGradient id="ss-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#07080d" />
        <stop offset="1" stop-color="#0d1019" />
      </linearGradient>
      <linearGradient id="ss-sea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0c0f17" />
        <stop offset="1" stop-color="#0a0c12" />
      </linearGradient>
      <radialGradient id="ss-halo" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="#f1e7d0" stop-opacity="0.10" />
        <stop offset="1" stop-color="#f1e7d0" stop-opacity="0" />
      </radialGradient>
      <mask id="ss-crescent">
        <rect width="400" height="400" fill="#fff" />
        <circle cx="331" cy="166" r="25" fill="#000" />
      </mask>
    </defs>

    <rect width="400" height="400" fill="url(#ss-sky)" />
    ${STARS.map(([x, y, r, o]) => html`<circle cx=${x} cy=${y} r=${r} fill="#eef0f5" opacity=${o} />`)}

    <!-- the moon -->
    <circle cx="320" cy="176" r="64" fill="url(#ss-halo)" />
    <circle cx="320" cy="176" r="26" fill="#f1e7d0" mask="url(#ss-crescent)" />

    <!-- the water between you -->
    <rect y="332" width="400" height="68" fill="url(#ss-sea)" />
    <rect y="332" width="400" height="1" fill="#eef0f5" opacity="0.06" />
    ${reflection(318, 338, 9, 46, '#f1e7d0', 0.42)}

    <!-- your shore -->
    <path d="M 0 310 C 22 300 52 294 84 298 C 118 302 146 314 170 332 L 0 332 Z" fill="#06070b" />
    <g fill="#06070b">
      <rect x="54" y="280" width="38" height="24" />
      <path d="M 50 281 L 73 262 L 96 281 Z" />
      <rect x="82" y="266" width="5" height="10" />
    </g>
    <rect x="64" y="287" width="9" height="9" rx="0.5" fill="#f2b35c" />
    <path d="M 68.5 287 V 296 M 64 291.5 H 73" stroke="#06070b" stroke-width="0.8" />
    ${reflection(68, 340, 4, 12, '#f2b35c', 0.35)}

    <!-- their shore, far away -->
    <path d="M 262 332 C 290 320 320 310 352 308 C 374 307 390 310 400 312 L 400 332 Z" fill="#06070b" />
    <g fill="#06070b">
      <rect x="352" y="296" width="26" height="16" />
      <path d="M 349 297 L 365 284 L 381 297 Z" />
    </g>
    <rect x="359" y="301" width="6" height="6" rx="0.5" fill="#f2b35c" />
    <path d="M 362 301 V 307 M 359 304 H 365" stroke="#06070b" stroke-width="0.6" />
    ${reflection(362, 340, 3, 8, '#f2b35c', 0.3)}
  </svg>`;
}

/** The small crescent used as the logo mark. */
export function MoonMark({ size = 20 }) {
  return html`<svg class="brand-mark" width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M14.5 3.2a9 9 0 1 0 6.3 13.6A7.5 7.5 0 0 1 14.5 3.2Z" fill="currentColor" />
  </svg>`;
}
