import { html, useEffect, useRef, useState } from '../../ui/h.js';
import { GameHeader, LockStatus, ResultActions, Icon, Postmark, clockIn, useOnChange } from '../../ui/components.js';
import { DrawingBoard, PALETTE, loadBoard, boardThumb, saveBoardPNG, pruneBoards, slug } from '../../ui/canvas.js';
import { meta, POINTS_PER_CANVAS } from './logic.js';

const ASPECT = 0.75; // 4:3 — leaves room for the toolbar on a phone screen

// Each player's default pen follows their profile colour (js/ui/profile.js), as the paper ink
// closest to it. Ink, Night and Moon stay for drawing, never as someone's default.
const pen = (name) => PALETTE.find((p) => p.name === name).c;
const INKS = ['Sky', 'Lilac', 'Coral', 'Amber', 'Sage'].map(pen);
const PROFILE_INK = {
  // current profile colours
  '#f2b35c': pen('Amber'),
  '#ef8a74': pen('Coral'),
  '#e3cf8f': pen('Amber'),
  '#7fc8a9': pen('Sage'),
  '#7fa8e6': pen('Sky'),
  '#c3a3e6': pen('Lilac'),
  // colours saved by older versions
  '#ff7eb6': pen('Coral'),
  '#ffb86b': pen('Amber'),
  '#ffe66d': pen('Amber'),
  '#7ef0c4': pen('Sage'),
  '#6ec8ff': pen('Sky'),
  '#b69cff': pen('Lilac'),
};

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

/**
 * A short phone (360x640, or a 390-wide phone once the browser's bars take their share): the
 * header, a two-line prompt, the board and its toolbar fill the height above the reaction bar, so
 * the finish row would sit under it. There the prompt card carries the finish controls too (as it
 * already does "Agree") and the row below the board is left out. A wider phone has a taller board,
 * hence the taller bands for wider screens.
 */
const COMPACT = [
  '(max-width: 679px) and (max-height: 720px)',
  '(min-width: 380px) and (max-width: 679px) and (max-height: 760px)',
  '(min-width: 420px) and (max-width: 679px) and (max-height: 780px)',
].join(', ');

function useMedia(query) {
  const read = () => !!globalThis.matchMedia?.(query).matches;
  const [on, setOn] = useState(read);
  useEffect(() => {
    const m = globalThis.matchMedia?.(query);
    if (!m) return undefined;
    const update = () => setOn(m.matches);
    update();
    m.addEventListener?.('change', update);
    return () => m.removeEventListener?.('change', update);
  }, [query]);
  return on;
}

/**
 * The postmark as plain text, for saved images: "9:40 pm here · 11:40 am there". Stamped with
 * `at` (when the canvas was framed, from the state) so the PNG matches the sheet on both phones.
 */
export function postmarkText(api, at) {
  const here = clockIn(api.me?.tz, at || undefined);
  if (!here) return '';
  const tz = api.partner?.tz;
  return tz && tz !== api.me?.tz ? `${here} here · ${clockIn(tz, at || undefined)} there` : `${here} for you both`;
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
  const compact = useMedia(COMPACT);

  useEffect(() => pruneBoards(`${meId}:${s.cid}`), [s.cid]);
  useOnChange(done ? s.plays : 0, () => {
    api.effects.confetti();
    api.effects.sound('success');
  });
  useOnChange(s.shuffles, () => api.effects.sound('whoosh'));
  useOnChange(!done && partnerReady && !meReady ? s.n : 0, () => api.effects.sound('heart'));

  const shuffle = () => api.act({ type: 'newPrompt', from: s.prompt });
  const setReady = (on) => {
    api.act({ type: 'ready', on, n: s.n, from: s.prompt });
    if (on) api.effects.sound('lock');
  };
  // The ready state lives in the prompt card above the board, so it's seen without scrolling even
  // on a short phone where the finish row sits below the fold (or behind the reaction bar).
  const partnerWaiting = partnerReady && !meReady;
  const label = partnerWaiting
    ? `${pName} thinks it’s finished`
    : meReady
      ? `You’re done, waiting for ${pName}`
      : compact && ink
        ? 'You both tap the check when it’s done'
        : 'Draw together';
  const names = api.players.map((id) => api.player(id)?.name).join(' & ');

  const save = () =>
    handle.current?.savePNG({
      caption: s.prompt,
      sub: [names, postmarkText(api, s.doneAt)].filter(Boolean).join(' · '),
      filename: `duet-${slug(s.prompt)}.png`,
    });

  // The prompt card's one control: Agree when the partner is done; on a short phone also
  // "Keep drawing" / "We're done" (the finish row is left out there); otherwise a new prompt.
  const control = partnerWaiting
    ? html`<button class="btn btn-accent btn-icon agree" onClick=${() => setReady(true)} aria-label="Agree, it’s finished" title="Agree, it’s finished">
        <${Icon} name="check" /></button>`
    : compact && meReady
      ? html`<button class="btn btn-ghost btn-icon keep" onClick=${() => setReady(false)} aria-label="Keep drawing" title="Keep drawing">
          <${Icon} name="pencil" /></button>`
      : compact && ink
        ? html`<button class="btn btn-primary btn-icon finish" onClick=${() => setReady(true)} aria-label="We’re done" title="We’re done">
            <${Icon} name="check" /></button>`
        : html`<button class="btn btn-ghost btn-icon shuffle" onClick=${shuffle} aria-label="New prompt" title="New prompt">
            <${Icon} name="shuffle" /></button>`;

  return html`<section class=${`game duet ${done ? 'is-done' : ''} ${compact ? 'compact' : ''}`}>
    <${GameHeader} meta=${meta} api=${api}>${s.n > 1 && html`<span class="chip">Canvas ${s.n}</span>`}</${GameHeader}>

    ${done
      ? html`<div class="duet-banner pop-in">
          <h2>Masterpiece</h2>
          <p><span class="points">+${POINTS_PER_CANVAS}</span> together points</p>
        </div>`
      : html`<div class=${`prompt-card duet-prompt ${partnerWaiting ? 'partner-ready' : ''} ${meReady ? 'me-ready' : ''}`}>
          <div class="prompt-text pop-in" key=${s.prompt}>
            <small class="ready-note" aria-live="polite" title=${label}>${meReady && html`<${Icon} name="check" size=${14} />`}${label}</small>
            <span>${s.prompt}</span>
          </div>
          ${control}
        </div>`}

    <div class=${`duet-board ${done ? 'framed' : ''}`}>
      <${DrawingBoard} key=${boardKey} api=${api} boardKey=${boardKey} aspect=${ASPECT} handle=${handle}
        canDraw=${!done} tools=${!done} mirrorTool=${true} defaultColor=${pens[meId]}
        canClear=${() => true}
        onCleared=${(from) => api.effects.toast(`${api.player(from)?.name || 'Your partner'} cleared the canvas`)}
        onInk=${(n) => setInk(n)}
        label=${`Shared drawing: ${s.prompt}`}
        emptyHint=${done ? '' : 'Both of you can draw here at once'} />
      ${done &&
      html`<div class="sheet-caption">
        <span class="sheet-title">${s.prompt}</span>
        <span class="sheet-meta">${names}${' · '}<${Postmark} me=${api.me} partner=${api.partner} at=${s.doneAt || undefined} /></span>
      </div>`}
    </div>

    ${done
      ? html`<div class="stack center duet-after">
          <button class="btn" onClick=${save}><${Icon} name="download" />Save as PNG</button>
          <${Gallery} s=${s} api=${api} />
          <${ResultActions} api=${api} onAgain=${() => api.act({ type: 'again', n: s.n })} againLabel="New canvas" />
        </div>`
      : !compact &&
        html`<div class="stack center duet-finish">
          ${meReady
            ? html`<div class="row center wrap waiting-row">
                  <${LockStatus} api=${api} locked=${s.ready} labels=${{ done: 'done', waiting: 'still drawing' }} />
                  <button class="btn" onClick=${() => setReady(false)}><${Icon} name="pencil" />Keep drawing</button>
                </div>`
            : html`<button class="btn btn-primary btn-lg" disabled=${!ink} onClick=${() => setReady(true)}>We’re done</button>
                <p class="muted small">${ink ? (partnerReady ? 'Tap to frame your masterpiece' : 'You both tap it when it’s finished') : 'Draw something first, any squiggle counts'}</p>`}
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
  const names = api.players.map((id) => api.player(id)?.name).join(' & ');
  return html`<div class="duet-gallery">
    <h3 class="section-label">Earlier tonight</h3>
    <div class="duet-thumbs">
      ${items.map(
        (it) => html`<button key=${it.n} class="thumb-btn" title=${it.prompt} aria-label=${`Save “${it.prompt}”`}
          onClick=${() => saveBoardPNG(it.board, { aspect: ASPECT, caption: it.prompt, sub: [names, it.at && postmarkText(api, it.at)].filter(Boolean).join(' · '), filename: `duet-${slug(it.prompt)}.png` })}>
          <img src=${it.src} alt=${it.prompt} /></button>`,
      )}
    </div>
  </div>`;
}
