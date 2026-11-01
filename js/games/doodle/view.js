import { html, useEffect, useRef, useState } from '../../ui/h.js';
import { GameHeader, AnswerBox, ResultActions, Timer, WaitingDots, Avatar, useOnChange, useCountdown } from '../../ui/components.js';
import { DrawingBoard, loadBoard, boardThumb, renderCollage, downloadCanvas, saveBoardPNG, pruneBoards, slug } from '../../ui/canvas.js';
import { meta, ROUNDS, DRAW_MS, GUESS_MAX } from './logic.js';

const ASPECT = 0.75; // 4:3 board
const TAGS = ['Easy', 'Medium', 'Wildcard'];

const coarse = () => !!globalThis.matchMedia?.('(pointer: coarse)').matches;

export default function DoodleView({ s, api }) {
  const meId = api.meId;
  const isDrawer = meId === s.drawer;
  const drawer = api.player(s.drawer);
  const guesser = api.player(s.guesser);
  const boardKey = `${s.cid}-${s.round}`;

  // Only keep this game's drawings in the tab's storage.
  useEffect(() => pruneBoards(`${meId}:${s.cid}`), [s.cid]);

  useOnChange(s.phase === 'draw' ? s.round : 0, () => api.effects.sound('whoosh'));
  useOnChange(s.phase === 'result' ? s.log.length : 0, () => {
    if (s.last?.ok) {
      api.effects.confetti({ emojis: ['🎨', '✨', '💖', '🖍️', '⭐'] });
      api.effects.sound('success');
    } else {
      api.effects.sound('fail');
    }
  });
  useOnChange(s.phase === 'draw' ? s.closeCount : 0, () => {
    const g = s.guesses[s.guesses.length - 1]?.text;
    api.effects.toast(isDrawer ? `${guesser?.name || 'They'} is so close: “${g}” 🤏` : `So close! Check the spelling 🤏`);
    api.effects.sound('tick');
  });
  useOnChange(isDrawer && s.phase === 'draw' ? s.guessCount : 0, () => api.effects.sound('pop'));
  useOnChange(s.phase === 'draw' ? s.hintLevel : 0, () => api.effects.sound('reveal'));
  useOnChange(s.phase === 'final' ? s.plays : 0, () => {
    api.effects.confetti();
    api.effects.sound('success');
  });

  return html`<section class="game doodle">
    <${GameHeader} meta=${meta} round=${s.phase === 'final' ? null : s.round} total=${s.rounds} api=${api} />
    ${s.phase === 'choose' && html`<${Choose} s=${s} api=${api} isDrawer=${isDrawer} drawer=${drawer} guesser=${guesser} />`}
    ${(s.phase === 'draw' || s.phase === 'result') &&
    html`<${Round} key=${boardKey} boardKey=${boardKey} s=${s} api=${api} isDrawer=${isDrawer} drawer=${drawer} guesser=${guesser} />`}
    ${s.phase === 'final' && html`<${Final} s=${s} api=${api} />`}
  </section>`;
}

function Choose({ s, api, isDrawer, drawer, guesser }) {
  if (!isDrawer) {
    return html`<div class="card stack center waiting-card pop-in">
      <${Avatar} player=${drawer} size="lg" />
      <h3><${WaitingDots} text=${`${drawer?.name || 'Your partner'} is choosing a word`} /></h3>
      <p class="muted">You're guessing this round. Type as many guesses as you like — the faster you get it, the more points you both score.</p>
    </div>`;
  }
  return html`<div class="stack center choose">
    <div class="role-badge pop-in">✏️ Your turn to draw!</div>
    <p class="muted">Pick a word — ${guesser?.name || 'your partner'} can't see it.</p>
    <div class="options">
      ${s.options.map(
        (w, i) => html`<button class="btn btn-choice option flip-in" key=${w} style=${`animation-delay:${i * 90}ms`}
          onClick=${() => {
            api.act({ type: 'choose', index: i });
            api.effects.sound('lock');
          }}>
          <b>${w}</b>${!s.ai && html`<small class=${`tag tag-${i}`}>${TAGS[i]}</small>`}
        </button>`,
      )}
    </div>
    ${!s.rerolled && s.pool.length > 0 &&
    html`<button class="btn btn-ghost btn-sm" onClick=${() => api.act({ type: 'reroll' })}>🔀 Show me three others</button>`}
    <p class="muted small">You'll have ${DRAW_MS / 1000} seconds. No letters allowed in the drawing 😉</p>
  </div>`;
}

function Round({ s, api, isDrawer, drawer, guesser, boardKey }) {
  const drawing = s.phase === 'draw';
  const handle = useRef(null);
  const dName = drawer?.name || 'Your partner';
  const gName = guesser?.name || 'Your partner';

  return html`<div class="stack round">
    ${drawing
      ? isDrawer
        ? html`<div class="word-bar">
            <div class="word-info"><small>Draw this</small><b class="secret-word">${s.word}</b></div>
            <${Timer} api=${api} endsAt=${s.endsAt} total=${DRAW_MS} />
          </div>`
        : html`<div class="word-bar">
            <div class="word-info"><small>${s.hint ? `Hint · ${s.hint.replace(/[^_\p{L}\p{N}]/gu, '').length} letters` : `${dName} is drawing`}</small>
              ${s.hint
                ? html`<b class="hint" aria-label=${`Hint: ${s.hint.replace(/_/g, 'blank')}`}>${s.hint.split('   ').map((w, i) => html`<span class="hint-word" key=${i}>${w}</span>`)}</b>`
                : html`<span class="hint-wait">Hint unlocks at 40s 🔒</span>`}</div>
            <${Timer} api=${api} endsAt=${s.endsAt} total=${DRAW_MS} />
          </div>`
      : html`<${RoundResult} s=${s} api=${api} />`}

    <${DrawingBoard} key=${boardKey} api=${api} boardKey=${boardKey} aspect=${ASPECT} handle=${handle}
      canDraw=${drawing && isDrawer} tools=${drawing && isDrawer}
      canClear=${(id) => id === s.drawer}
      onCleared=${() => api.effects.toast(`${dName} started over ✨`)}
      label=${`Drawing by ${isDrawer ? 'you' : dName}`}
      emptyHint=${drawing ? (isDrawer ? 'Start drawing here ✏️' : `Waiting for ${dName}'s first line…`) : ''} />

    ${drawing && !isDrawer &&
    html`<${AnswerBox} placeholder="Type a guess…" button="Guess" maxLength=${GUESS_MAX} autoFocus=${!coarse()}
      onSubmit=${(text) => {
        api.act({ type: 'guess', text });
        api.effects.sound('tap');
      }} />`}
    ${drawing && html`<${Guesses} s=${s} isDrawer=${isDrawer} gName=${gName} />`}
    ${drawing && isDrawer && html`<${SkipButton} api=${api} />`}
    ${!drawing &&
    html`<${NextBar} s=${s} api=${api} onSave=${() =>
      handle.current?.savePNG({ caption: s.last?.word || 'Doodle', sub: `Drawn by ${dName} · Same Sky 🌙`, filename: `doodle-${slug(s.last?.word)}.png` })} />`}
  </div>`;
}

/** Two taps (no native dialog: those can be blocked in in-app browsers). */
function SkipButton({ api }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const h = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(h);
  }, [armed]);
  return html`<button class=${`btn btn-sm skip-btn ${armed ? 'armed' : 'btn-ghost'}`}
    onClick=${() => (armed ? api.act({ type: 'skip' }) : setArmed(true))}>
    ${armed ? 'Tap again to skip (no points)' : 'Skip this word'}</button>`;
}

function Guesses({ s, isDrawer, gName }) {
  const list = s.guesses;
  return html`<div class="guesses" aria-live="polite">
    <div class="guesses-head"><small>${isDrawer ? `${gName}'s guesses` : 'Your guesses'}</small>
      ${s.guessCount > list.length && html`<small class="muted">${s.guessCount} so far</small>`}</div>
    ${list.length
      ? html`<div class="bubbles">${list.map(
          (g, i) => html`<span key=${`${s.guessCount - list.length + i}`} class=${`bubble pop-in ${g.close ? 'close' : ''}`}>
            ${g.text}${g.close && html`<em>so close!</em>`}</span>`,
        )}</div>`
      : html`<p class="muted small empty-guesses">${isDrawer
          ? html`<${WaitingDots} text=${`Waiting for ${gName}'s first guess`} />`
          : 'Wrong guesses are free — fire away!'}</p>`}
  </div>`;
}

function RoundResult({ s, api }) {
  const r = s.last;
  if (!r) return null;
  const who = (id) => (id === api.meId ? 'You' : api.player(id)?.name || 'Your partner');
  const line = r.ok
    ? `${who(r.guesser)} got it in ${r.secs}s!`
    : r.how === 'skip'
      ? `${who(r.drawer)} skipped this one`
      : `Time's up! This one got away`;
  return html`<div class=${`result-banner ${r.ok ? 'win' : ''} pop-in round-result`}>
    <small class="muted">The word was</small>
    <h2 class="result-word">${r.word}</h2>
    <p>${r.ok ? '🎉 ' : r.how === 'skip' ? '🙈 ' : '⏰ '}${line}</p>
    ${r.ok && html`<span class="chip pts-chip">+${r.pts} together points</span>`}
  </div>`;
}

function NextBar({ s, api, onSave }) {
  const secs = useCountdown(api, s.nextAt);
  const last = s.round >= s.rounds;
  const nextDrawer = api.player(s.guesser);
  return html`<div class="stack center next-bar">
    <button class="btn btn-primary btn-lg" onClick=${() => api.act({ type: 'next' })}>
      ${last ? 'See our results' : 'Next round →'}${secs != null && html`<small class="auto">${secs}s</small>`}</button>
    ${!last && html`<p class="muted small">${s.guesser === api.meId ? 'You draw next ✏️' : `${nextDrawer?.name || 'Your partner'} draws next`}</p>`}
    <button class="btn btn-ghost btn-sm" onClick=${onSave}>💾 Save this doodle</button>
  </div>`;
}

function Final({ s, api }) {
  const [thumbs, setThumbs] = useState(null);
  const boards = useRef([]);
  const rounds = s.log.slice(-ROUNDS);
  const ok = rounds.filter((r) => r.ok);
  const best = ok.length ? ok.reduce((a, b) => (b.secs < a.secs ? b : a)) : null;
  const name = (id, lower) => (id === api.meId ? (lower ? 'you' : 'You') : api.player(id)?.name || 'your partner');

  // Drawings were saved per round by the board; read them after the last board unmounted.
  useEffect(() => {
    boards.current = rounds.map((r) => loadBoard(`${api.meId}:${s.cid}-${r.round}`, api.players));
    try {
      setThumbs(boards.current.map((b) => (b ? boardThumb(b, { width: 320, aspect: ASPECT }) : null)));
    } catch {
      setThumbs(boards.current.map(() => null));
    }
  }, [s.cid, s.plays]);

  const label = (r) => `${r.word} — ${r.ok ? `${r.secs}s ✓` : r.how === 'skip' ? 'skipped' : 'time ran out'}`;
  const saveAll = () => {
    const items = rounds.map((r, i) => ({ board: boards.current[i], label: `${api.player(r.drawer)?.name || ''}: ${label(r)}` })).filter((it) => it.board);
    if (!items.length) {
      api.effects.toast('No drawings saved on this device 🙈');
      return;
    }
    const names = api.players.map((id) => api.player(id)?.name).join(' & ');
    downloadCanvas(renderCollage(items, { aspect: ASPECT, title: `${names} · Doodle Dash`, sub: `${s.gained} together points · Same Sky 🌙` }), 'our-doodles.png');
    api.effects.sound('tap');
  };

  return html`<div class="stack center final">
    <div class="result-banner win pop-in">
      <h2>That's a wrap! 🎨</h2>
      <p class="big">${s.gained} <small>together points</small></p>
      <p>${ok.length} of ${rounds.length} doodles guessed${ok.length === rounds.length ? ' — perfect night! 💯' : ''}</p>
      ${best && html`<p class="muted small">Fastest: “${best.word}” in ${best.secs}s — drawn by ${name(best.drawer, true)}, guessed by ${name(best.guesser, true)}</p>`}
    </div>
    <div class="gallery">
      ${rounds.map(
        (r, i) => html`<figure key=${r.round} class=${`gallery-item flip-in ${r.ok ? 'ok' : 'miss'}`} style=${`animation-delay:${i * 120}ms`}>
          ${thumbs?.[i]
            ? html`<button class="thumb-btn" aria-label=${`Save the drawing of ${r.word}`}
                onClick=${() => saveBoardPNG(boards.current[i], { aspect: ASPECT, caption: r.word, sub: `Drawn by ${api.player(r.drawer)?.name || ''} · Same Sky 🌙`, filename: `doodle-${slug(r.word)}.png` })}>
                <img src=${thumbs[i]} alt=${`Drawing of ${r.word}`} /></button>`
            : html`<div class="thumb-empty">🖼️</div>`}
          <figcaption><b>${r.word}</b><small>${r.ok ? `✓ ${r.secs}s · +${r.pts}` : r.how === 'skip' ? 'skipped' : 'time ran out'}</small></figcaption>
        </figure>`,
      )}
    </div>
    <button class="btn" onClick=${saveAll}>💾 Save our doodles</button>
    <${ResultActions} api=${api} onAgain=${() => api.act({ type: 'again' })} againLabel="Play again" />
  </div>`;
}
