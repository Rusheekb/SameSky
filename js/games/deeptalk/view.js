import { html, useState, useEffect, useRef } from '../../ui/h.js';
import { GameHeader, LockStatus, ResultActions, WaitingDots, Avatar, useOnChange } from '../../ui/components.js';
import { meta, LEVELS, MAX_CARDS, MAX_ANSWER, MAX_FAVS } from './logic.js';

const nameOf = (api, id) => (id === api.me.id ? 'You' : api.player(id)?.name || 'Your partner');

function LevelPicker({ s, api }) {
  return html`<div class="dt-levels" role="radiogroup" aria-label="Card level">
    ${[1, 2, 3].map(
      (l) => html`<button key=${l} type="button" role="radio" aria-checked=${s.level === l}
        class=${`dt-level lvl-${l} ${s.level === l ? 'sel' : ''}`}
        onClick=${() => {
          if (s.level === l) return;
          api.act({ type: 'level', level: l });
          api.effects.sound('tap');
        }}>
        <span aria-hidden="true">${LEVELS[l].emoji}</span> ${LEVELS[l].name}
      </button>`,
    )}
  </div>`;
}

function Card({ s, api }) {
  const c = s.card;
  const L = LEVELS[c.level];
  const firstName = s.first === api.me.id ? 'You answer first' : `${api.player(s.first)?.name || 'Your partner'} answers first`;
  const flip = () => !s.flipped && api.act({ type: 'flip', card: c.id });
  const compact = s.mode === 'write' || s.outcome === 'written';
  return html`<div class=${`dt-card lvl-${c.level} ${s.flipped ? 'is-flipped' : ''} ${compact ? 'compact' : ''}`}>
    <div class="dt-inner">
      <button type="button" class="dt-face dt-front" onClick=${flip} disabled=${s.flipped} aria-label="Flip the card" tabindex=${s.flipped ? -1 : 0}>
        <span class="dt-front-level">${L.emoji} ${L.name}</span>
        <span class="dt-front-emoji" aria-hidden="true">💌</span>
        <span class="dt-front-tap">Tap to flip</span>
      </button>
      <div class="dt-face dt-back" aria-hidden=${!s.flipped} aria-live="polite">
        <span class="dt-back-level">${L.emoji} ${L.name}</span>
        <p class="dt-q">${s.flipped ? c.text : ''}</p>
        <span class="dt-first">🎤 ${firstName}</span>
      </div>
    </div>
  </div>`;
}

function WriteBox({ s, api }) {
  const [text, setText] = useState('');
  const lastSent = useRef(0);
  const ref = useRef(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const submit = (e) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    api.act({ type: 'answer', card: s.card.id, text: v });
    api.effects.sound('lock');
  };
  return html`<form class="dt-write" onSubmit=${submit}>
    <textarea class="input" ref=${ref} rows="4" maxLength=${MAX_ANSWER} value=${text} aria-label="Your answer"
      placeholder=${`Write from the heart… ${api.partner?.name || 'they'} won't see it until you both seal yours.`}
      onInput=${(e) => {
        setText(e.currentTarget.value);
        const t = Date.now();
        if (t - lastSent.current > 1500) {
          lastSent.current = t;
          api.fx.send('typing', {});
        }
      }}></textarea>
    <div class="dt-write-foot">
      <small class=${`muted ${text.length > MAX_ANSWER - 20 ? 'dt-near' : ''}`}>${text.length}/${MAX_ANSWER}</small>
      <button class="btn btn-primary" type="submit" disabled=${!text.trim()}>Seal it 💌</button>
    </div>
  </form>`;
}

function usePartnerTyping(api) {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    let h = null;
    const off = api.fx.on('typing', () => {
      setTyping(true);
      clearTimeout(h);
      h = setTimeout(() => setTyping(false), 2600);
    });
    return () => {
      off();
      clearTimeout(h);
    };
  }, []);
  return typing;
}

function Answers({ s, api }) {
  const order = [s.first, ...api.players.filter((id) => id !== s.first)];
  const long = order.some((id) => (s.answers[id] || '').length > 90);
  return html`<div class=${`dt-answers ${long ? 'stacked' : ''}`}>
    ${order.map(
      (id, i) => html`<div class="dt-answer flip-in" key=${id} style=${`animation-delay:${i * 200}ms`}>
        <div class="dt-answer-who"><${Avatar} player=${api.player(id)} size="sm" /><b>${nameOf(api, id)}</b></div>
        <p>${s.answers[id]}</p>
      </div>`,
    )}
  </div>`;
}

function Actions({ s, api }) {
  const me = api.me;
  const pName = api.partner?.name || 'your partner';
  const partnerTyping = usePartnerTyping(api);
  const card = s.card.id;

  if (!s.flipped) {
    return html`<div class="stack center dt-actions">
      <button class="btn btn-primary btn-lg dt-wide" onClick=${() => api.act({ type: 'flip', card })}>Flip the card ✨</button>
      <p class="muted small dt-note">Either of you can flip — pick a level first if you like.</p>
    </div>`;
  }

  if (s.outcome === 'talked') {
    return html`<div class="result-banner win pop-in dt-done-banner">
      <h3>Shared 💬</h3><p>+1 together point · ${s.count} card${s.count === 1 ? '' : 's'} so far</p>
    </div>`;
  }

  if (s.outcome === 'written') {
    return html`<div class="stack center dt-actions">
      <${Answers} s=${s} api=${api} />
      <p class="dt-plus pop-in" style="animation-delay:400ms">+1 together point 💞</p>
    </div>`;
  }

  if (s.mode === 'write') {
    const mine = s.answers[me.id];
    const sealed = Object.fromEntries(api.players.map((id) => [id, !!s.answers[id]]));
    const partnerSealed = api.partner && sealed[api.partner.id];
    return html`<div class="stack center dt-actions">
      ${mine
        ? html`<div class="card glow dt-sealed pop-in">
            <p class="dt-sealed-title">💌 Your answer is sealed</p>
            <p class="muted small">It opens the moment ${pName} seals theirs.</p>
            <${WaitingDots} text=${`Waiting for ${pName} to finish writing`} />
          </div>`
        : html`<${WriteBox} s=${s} api=${api} key=${card} />`}
      <${LockStatus} api=${api} locked=${sealed} labels=${{ done: 'sealed', waiting: 'writing…' }} />
      ${!partnerSealed && partnerTyping && html`<p class="muted small dt-typing">✍️ ${pName} is typing…</p>`}
      <button class="btn btn-ghost btn-sm" onClick=${() => api.act({ type: 'talked', card })}>💬 Just talk about it instead</button>
    </div>`;
  }

  return html`<div class="dt-choose">
    <button class="btn btn-primary" onClick=${() => api.act({ type: 'talked', card })}>💬 We talked about it</button>
    <button class="btn" onClick=${() => {
      api.act({ type: 'write', card });
      api.effects.sound('tap');
    }}>✍️ Write it down</button>
  </div>`;
}

function Toolbar({ s, api }) {
  const saved = s.favs.some((f) => f.id === s.card.id);
  const full = !saved && s.favs.length >= MAX_FAVS;
  const last = s.count >= MAX_CARDS;
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return undefined;
    const h = setTimeout(() => setSure(false), 3000);
    return () => clearTimeout(h);
  }, [sure]);
  const next = () => {
    api.act({ type: 'next', card: s.card.id });
    api.effects.sound('whoosh');
  };
  return html`<div class="stack dt-toolbar">
    ${s.flipped &&
    html`<div class="dt-tools">
      <button class=${`btn dt-save ${saved ? 'on' : ''}`} aria-pressed=${saved} disabled=${full}
        title=${full ? `You can keep up to ${MAX_FAVS} favourites` : 'Save to your favourites'}
        onClick=${() => api.act({ type: 'save', card: s.card.id, on: !saved })}>
        ${saved ? '⭐ Saved' : '☆ Save'}
      </button>
      <button class=${`btn ${s.outcome ? 'btn-primary' : ''} dt-next`} onClick=${next}>
        ${s.outcome ? (last ? 'Finish 💌' : 'Next card →') : 'Skip →'}
      </button>
    </div>`}
    ${last && s.outcome && html`<p class="muted small center">That's ${MAX_CARDS} cards — what a night. 💞</p>`}
    <div class="dt-foot">
      <span class="muted small">⭐ ${s.favs.length} saved · 💬 ${s.count} shared</span>
      <button class=${`btn btn-ghost btn-sm ${sure ? 'dt-sure' : ''}`} onClick=${() => {
        if (sure) api.act({ type: 'finish' });
        else setSure(true);
      }}>${sure ? 'Tap again to finish' : 'Finish for tonight'}</button>
    </div>
  </div>`;
}

function CardPhase({ s, api }) {
  const pending = s.flipped && s.level !== s.card.level;
  return html`<div class="stack dt-play">
    <${LevelPicker} s=${s} api=${api} />
    <p class=${`muted small center dt-hint ${pending ? '' : 'dt-hint-empty'}`} aria-live="polite">
      ${pending ? `Next card will be ${LEVELS[s.level].emoji} ${LEVELS[s.level].name}` : ''}
    </p>
    <${Card} s=${s} api=${api} key=${s.card.id} />
    <${Actions} s=${s} api=${api} />
    <${Toolbar} s=${s} api=${api} />
  </div>`;
}

function DonePhase({ s, api }) {
  return html`<div class="stack center dt-end">
    <div class="card glow dt-final pop-in">
      <div class="dt-final-emoji" aria-hidden="true">💌</div>
      <p class="dt-final-num"><b>${s.count}</b> card${s.count === 1 ? '' : 's'} shared</p>
      <p class="dt-closing">${s.closing}</p>
      ${s.points > 0 && html`<p class="dt-plus">+${s.points} together point${s.points === 1 ? '' : 's'}</p>`}
    </div>
    ${s.favs.length
      ? html`<div class="dt-favs">
          <h3>⭐ Your favourites</h3>
          ${s.favs.map(
            (f, i) => html`<div class="dt-fav" key=${f.id} style=${`animation-delay:${Math.min(i, 6) * 80}ms`}>
              <span class="dt-fav-level">${LEVELS[f.level]?.emoji} ${LEVELS[f.level]?.name}</span>
              <p class="dt-fav-q">${f.text}</p>
              ${f.answers &&
              html`<div class="dt-fav-answers">
                ${[api.me.id, ...api.players.filter((id) => id !== api.me.id)].map(
                  (id) => f.answers[id] && html`<p key=${id}><b>${nameOf(api, id)}:</b> ${f.answers[id]}</p>`,
                )}
              </div>`}
            </div>`,
          )}
        </div>`
      : html`<p class="muted center">No favourites saved this time. Next time, tap ☆ Save on the cards you love.</p>`}
    <${ResultActions} api=${api} />
  </div>`;
}

export default function DeepTalkView({ s, api }) {
  // Little moments, felt on both screens.
  useOnChange(s.flipped && s.card ? s.card.id : 0, () => api.effects.sound('whoosh'));
  useOnChange(s.outcome ? `${s.card.id}:${s.outcome}` : 0, () => {
    if (s.outcome === 'written') {
      api.effects.sound('reveal');
      api.effects.floatEmoji('💌', { count: 3 });
    } else {
      api.effects.sound('heart');
      api.effects.floatEmoji('💞', { count: 2 });
    }
  });
  const favCount = useRef(s.favs.length);
  useEffect(() => {
    if (s.favs.length > favCount.current) {
      api.effects.floatEmoji('⭐', { count: 2 });
      api.effects.sound('pop');
    }
    favCount.current = s.favs.length;
  }, [s.favs.length]);
  useOnChange(s.done, () => {
    api.effects.sound('success');
    api.effects.confetti({ emojis: ['💌', '💞', '✨', '⭐', '🌙'] });
  });

  return html`<section class="game deeptalk">
    <${GameHeader} meta=${meta} api=${api} />
    ${s.phase === 'card' && s.card && html`<${CardPhase} s=${s} api=${api} />`}
    ${s.phase === 'done' && html`<${DonePhase} s=${s} api=${api} />`}
  </section>`;
}
