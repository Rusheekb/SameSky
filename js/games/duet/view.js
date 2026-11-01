import { html, useEffect, useRef, useState } from '../../ui/h.js';
import { GameHeader, LockStatus, ResultActions, useOnChange } from '../../ui/components.js';
import { DrawingBoard, PALETTE, loadBoard, boardThumb, saveBoardPNG, pruneBoards, slug } from '../../ui/canvas.js';
import { meta, POINTS_PER_CANVAS } from './logic.js';

const ASPECT = 0.75; // 4:3 — leaves room for the toolbar on a phone screen

// Profile colours (js/ui/profile.js) -> the slightly deeper palette inks that read well on paper.
const INKS = PALETTE.slice(1, 7).map((p) => p.c);
const PROFILE_INK = { '#ff7eb6': '#ff5fa2', '#ffb86b': '#ff9b54', '#ffe66d': '#f7c548', '#7ef0c4': '#34c78e', '#6ec8ff': '#45a6f0', '#b69cff': '#9a78ff' };

function nearestInk(hex) {
  const known = PROFILE_INK[String(hex || '').toLowerCase()];
  if (known) return known;
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return INKS[0];
  const [r, g, b] = rgb(hex);
  return INKS.reduce((best, c) => {
    const [r2, g2, b2] = rgb(c);
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    return d < best.d ? { c, d } : best;
  }, { c: INKS[0], d: Infinity }).c;
}

/** Each player's default pen: their profile colour; the second player gets another if both match. */
export function penColors(api) {
  const [p1, p2] = api.players;
  const a = nearestInk(api.player(p1)?.color);
  let b = nearestInk(api.player(p2)?.color);
  if (a === b) b = INKS[(INKS.indexOf(a) + 3) % INKS.length];
  return { [p1]: a, [p2]: b };
}

export default function DuetView({ s, api }) {
  const meId = api.meId;
  const partner = api.partner;
  const pName = partner?.name || 'your partner';
  const boardKey = `${s.cid}-${s.n}`;
  const handle = useRef(null);
  const [ink, setInk] = useState(0);
  const done = s.phase === 'done';
  const meReady = !!s.ready[meId];
  const partnerReady = !!(partner && s.ready[partner.id]);
  const pens = penColors(api);

  useEffect(() => pruneBoards(`${meId}:${s.cid}`), [s.cid]);
  useOnChange(done ? s.plays : 0, () => {
    api.effects.confetti({ emojis: ['🖌️', '🎨', '💖', '✨', '🌟'] });
    api.effects.sound('success');
  });
  useOnChange(s.shuffles, () => api.effects.sound('whoosh'));
  useOnChange(!done && partnerReady && !meReady ? s.n : 0, () => api.effects.sound('heart'));

  const save = () =>
    handle.current?.savePNG({
      caption: s.prompt,
      sub: `${api.players.map((id) => api.player(id)?.name).join(' & ')} · Same Sky 🌙`,
      filename: `duet-${slug(s.prompt)}.png`,
    });

  return html`<section class=${`game duet ${done ? 'is-done' : ''}`}>
    <${GameHeader} meta=${meta} api=${api}>${s.n > 1 && html`<span class="chip">Canvas ${s.n}</span>`}</${GameHeader}>

    ${done
      ? html`<div class="result-banner win pop-in duet-banner">
          <h2>Masterpiece! 🖼️</h2>
          <p>“${s.prompt}”</p>
          <span class="chip pts-chip">+${POINTS_PER_CANVAS} together points</span>
        </div>`
      : html`<div class="prompt-card duet-prompt">
          <div class="prompt-text pop-in" key=${s.prompt}><small>Draw together</small><span>${s.prompt}</span></div>
          <button class="btn btn-ghost btn-sm shuffle" onClick=${() => api.act({ type: 'newPrompt' })} aria-label="New prompt" title="New prompt">🔀</button>
        </div>`}

    <div class=${`duet-board ${done ? 'framed' : ''}`}>
      <${DrawingBoard} key=${boardKey} api=${api} boardKey=${boardKey} aspect=${ASPECT} handle=${handle}
        canDraw=${!done} tools=${!done} mirrorTool=${true} defaultColor=${pens[meId]}
        canClear=${() => true}
        onCleared=${(from) => api.effects.toast(`${api.player(from)?.name || 'Your partner'} cleared the canvas ✨`)}
        onInk=${(n) => setInk(n)}
        label=${`Shared drawing: ${s.prompt}`}
        emptyHint=${done ? '' : 'Both of you can draw here at once ✏️'} />
    </div>

    ${done
      ? html`<div class="stack center">
          <button class="btn" onClick=${save}>💾 Save as PNG</button>
          <${Gallery} s=${s} api=${api} />
          <${ResultActions} api=${api} onAgain=${() => api.act({ type: 'again' })} againLabel="New canvas" />
        </div>`
      : html`<div class="stack center duet-finish">
          ${partnerReady && !meReady && html`<p class="nudge-note pop-in">${pName} thinks it's finished 💫 Agree?</p>`}
          ${meReady
            ? html`<${LockStatus} api=${api} locked=${s.ready} labels=${{ done: 'done', waiting: 'still drawing…' }} />
                <p class="muted small">Waiting for ${pName} to add their last touches…</p>
                <button class="btn" onClick=${() => api.act({ type: 'ready', on: false })}>✏️ Keep drawing</button>`
            : html`<button class=${`btn btn-primary btn-lg ${partnerReady ? 'glow-pulse' : ''}`} disabled=${!ink}
                onClick=${() => {
                  api.act({ type: 'ready', on: true });
                  api.effects.sound('lock');
                }}>We're done! ✨</button>
                <p class="muted small">${ink ? (partnerReady ? 'Tap to frame your masterpiece 🖼️' : 'You both tap it when it’s finished') : 'Draw something first — any squiggle counts.'}</p>`}
        </div>`}
  </section>`;
}

/** Earlier canvases from this game (kept in this tab's storage). */
function Gallery({ s, api }) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const prev = s.finished.filter((f) => f.n !== s.n).slice(-6);
    const out = [];
    for (const f of prev) {
      const b = loadBoard(`${api.meId}:${s.cid}-${f.n}`, api.players);
      if (!b) continue;
      try {
        out.push({ ...f, board: b, src: boardThumb(b, { width: 240, aspect: ASPECT }) });
      } catch {
        /* no canvas support */
      }
    }
    setItems(out);
  }, [s.n, s.plays]);
  if (!items.length) return null;
  return html`<div class="duet-gallery">
    <small class="muted">Earlier tonight</small>
    <div class="duet-thumbs">
      ${items.map(
        (it) => html`<button key=${it.n} class="thumb-btn" title=${it.prompt} aria-label=${`Save “${it.prompt}”`}
          onClick=${() => saveBoardPNG(it.board, { aspect: ASPECT, caption: it.prompt, filename: `duet-${slug(it.prompt)}.png` })}>
          <img src=${it.src} alt=${it.prompt} /></button>`,
      )}
    </div>
  </div>`;
}
