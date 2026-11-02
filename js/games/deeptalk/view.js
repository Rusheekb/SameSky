import { html, useState, useEffect, useRef } from '../../ui/h.js';
import { GameHeader, LockStatus, ResultActions, WaitingDots, Icon, Postmark, useOnChange } from '../../ui/components.js';
import { cleanText } from '../../lib/util.js';
import { meta, LEVELS, MAX_CARDS, MAX_ANSWER, MAX_FAVS } from './logic.js';

const nameOf = (api, id) => (id === api.me.id ? 'You' : api.player(id)?.name || 'Your partner');

/** The little lamplight wax seal: on the envelope, on a sealed answer, on tonight's letter. */
function Seal({ small }) {
  return html`<span class=${`dt-seal ${small ? 'dt-seal-sm' : ''}`} aria-hidden="true"><${Icon} name="heart" size=${small ? 12 : 16} /></span>`;
}

function LevelPicker({ s, api }) {
  return html`<div class="dt-levels" role="radiogroup" aria-label="Card level">
    ${[1, 2, 3].map(
      (l) => html`<button key=${l} type="button" role="radio" aria-checked=${s.level === l}
        class=${`dt-level lvl-${l} ${s.level === l ? 'sel' : ''}`}
        onClick=${() => {
          if (s.level === l) return;
          api.act({ type: 'level', level: l });
          api.effects.sound('tap');
        }}>${LEVELS[l].name}</button>`,
    )}
  </div>`;
}

/** Face down: a sealed paper envelope. Face up: the question, written on paper. */
function Card({ s, api }) {
  const c = s.card;
  const L = LEVELS[c.level];
  const firstName = s.first === api.me.id ? 'You answer first' : `${api.player(s.first)?.name || 'Your partner'} answers first`;
  const flip = () => !s.flipped && api.act({ type: 'flip', card: c.id });
  const compact = s.mode === 'write' || s.outcome === 'written';
  return html`<div class=${`dt-card lvl-${c.level} ${s.flipped ? 'is-flipped' : ''} ${compact ? 'compact' : ''}`}>
    <div class="dt-inner">
      <button type="button" class="dt-face dt-front" onClick=${flip} disabled=${s.flipped} aria-label="Turn the card over" tabindex=${s.flipped ? -1 : 0}>
        <svg class="dt-env" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path class="dt-env-fold" d="M0 100 L50 52 L100 100" />
          <path class="dt-env-shade" d="M0 0 H100 L50 58 Z" />
          <path class="dt-env-flap" d="M0 0 H100 L50 56 Z" />
        </svg>
        <span class="dt-front-level">${L.name}</span>
        <${Seal} />
        <span class="dt-front-tap">Tap to flip</span>
      </button>
      <div class="dt-face dt-back" aria-hidden=${!s.flipped} aria-live="polite">
        <span class="dt-back-level">${L.name}</span>
        <p class="dt-q">${s.flipped ? c.text : ''}</p>
        <span class="dt-first">${firstName}</span>
      </div>
    </div>
  </div>`;
}

// The draft is never cleared here. This box unmounts once the state shows the answer sealed (and
// is keyed by card, so a new card starts empty), so a submit that is lost or rejected on the way
// keeps every word: "Seal it" comes back after a moment to try again.
const RESEAL_MS = 4000;

function WriteBox({ s, api }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const lastSent = useRef(0);
  const ref = useRef(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (!sending) return undefined;
    const h = setTimeout(() => setSending(false), RESEAL_MS);
    return () => clearTimeout(h);
  }, [sending]);
  // Same cleaning as the reducer, so text it would reject (only spaces) never looks sendable.
  const ready = !!cleanText(text, MAX_ANSWER);
  const submit = (e) => {
    e.preventDefault();
    if (!ready || sending) return;
    setSending(true);
    api.act({ type: 'answer', card: s.card.id, text: cleanText(text, MAX_ANSWER) });
    api.effects.sound('lock');
  };
  return html`<form class="dt-write" onSubmit=${submit}>
    <textarea class="input" ref=${ref} rows="4" maxLength=${MAX_ANSWER} value=${text} aria-label="Your answer"
      placeholder=${`Write from the heart. ${api.partner?.name || 'They'} won't see it until you both seal yours.`}
      onInput=${(e) => {
        setText(e.currentTarget.value);
        const t = Date.now();
        if (t - lastSent.current > 1500) {
          lastSent.current = t;
          api.fx.send('typing', {});
        }
      }}></textarea>
    <div class="dt-write-foot">
      <small class=${`dt-counter ${text.length > MAX_ANSWER - 20 ? 'dt-near' : ''}`}>${text.length}/${MAX_ANSWER}</small>
      <button class="btn btn-primary" type="submit" disabled=${!ready || sending} aria-busy=${sending}>${sending ? 'Sealing…' : 'Seal it'}</button>
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

/** Both written answers turn over side by side, as two paper cards. */
function Answers({ s, api }) {
  const order = [s.first, ...api.players.filter((id) => id !== s.first)];
  const long = order.some((id) => (s.answers[id] || '').length > 90);
  return html`<div class=${`dt-answers ${long ? 'stacked' : ''}`}>
    ${order.map(
      (id, i) => html`<div class="dt-answer flip-in" key=${id} style=${`animation-delay:${i * 160}ms`}>
        <small class="dt-answer-who">${nameOf(api, id)}</small>
        <p>${s.answers[id]}</p>
      </div>`,
    )}
  </div>`;
}

const PlusOne = () => html`<span class="points">+1</span> together point`;

function Actions({ s, api }) {
  const me = api.me;
  const pName = api.partner?.name || 'your partner';
  const partnerTyping = usePartnerTyping(api);
  const card = s.card.id;

  if (!s.flipped) {
    return html`<div class="stack center dt-actions">
      <button class="btn btn-primary btn-lg dt-wide" onClick=${() => api.act({ type: 'flip', card })}>Flip the card</button>
      <p class="dt-note">Either of you can flip — pick a level first if you like</p>
    </div>`;
  }

  if (s.outcome === 'talked') {
    return html`<div class="result-banner pop-in dt-done-banner">
      <h3 class="dt-done-title"><${Icon} name="message-circle" />Shared</h3>
      <p><${PlusOne} /> · ${s.count} card${s.count === 1 ? '' : 's'} so far</p>
    </div>`;
  }

  if (s.outcome === 'written') {
    return html`<div class="stack center dt-actions">
      <${Answers} s=${s} api=${api} />
      <p class="dt-plus pop-in" style="animation-delay:320ms"><${PlusOne} /></p>
    </div>`;
  }

  if (s.mode === 'write') {
    const mine = s.answers[me.id];
    const sealed = Object.fromEntries(api.players.map((id) => [id, !!s.answers[id]]));
    const partnerSealed = api.partner && sealed[api.partner.id];
    return html`<div class="stack center dt-actions">
      ${mine
        ? html`<div class="card dt-sealed pop-in">
            <p class="dt-sealed-title"><${Seal} small />Your answer is sealed</p>
            <p class="dt-sealed-note">It opens the moment ${pName} seals theirs</p>
            <p class="dt-sealed-wait"><${WaitingDots} text=${`Waiting for ${pName} to finish writing`} /></p>
          </div>`
        : html`<${WriteBox} s=${s} api=${api} key=${card} />`}
      <${LockStatus} api=${api} locked=${sealed} labels=${{ done: 'sealed', waiting: 'writing…' }} />
      ${!partnerSealed && partnerTyping && html`<p class="dt-typing"><${Icon} name="pen-line" size=${16} />${pName} is typing…</p>`}
      <button class="btn btn-ghost btn-sm" onClick=${() => api.act({ type: 'talked', card })}><${Icon} name="message-circle" size=${16} />Just talk about it instead</button>
    </div>`;
  }

  return html`<div class="dt-choose">
    <button class="btn btn-primary" onClick=${() => api.act({ type: 'talked', card })}><${Icon} name="message-circle" />We talked about it</button>
    <button class="btn" onClick=${() => {
      api.act({ type: 'write', card });
      api.effects.sound('tap');
    }}><${Icon} name="pen-line" />Write it down</button>
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
        <${Icon} name=${saved ? 'bookmark-check' : 'bookmark'} />${saved ? 'Saved' : 'Save'}
      </button>
      <button class=${`btn ${s.outcome ? 'btn-primary' : ''} dt-next`} onClick=${next}>
        ${s.outcome ? (last ? 'Finish' : html`Next card<${Icon} name="arrow-right" />`) : html`Skip<${Icon} name="arrow-right" />`}
      </button>
    </div>`}
    ${last && s.outcome && html`<p class="dt-note">That's ${MAX_CARDS} cards — what a night</p>`}
    <div class="dt-foot">
      <span class="dt-counts">
        <span><${Icon} name="bookmark" size=${14} />${s.favs.length} saved</span>
        <span><${Icon} name="message-circle" size=${14} />${s.count} shared</span>
      </span>
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
    <p class=${`dt-hint ${pending ? '' : 'dt-hint-empty'}`} aria-live="polite">
      ${pending ? `Next card will be ${LEVELS[s.level].name}` : ''}
    </p>
    <${Card} s=${s} api=${api} key=${s.card.id} />
    <${Actions} s=${s} api=${api} />
    <${Toolbar} s=${s} api=${api} />
  </div>`;
}

function DonePhase({ s, api }) {
  return html`<div class="stack center dt-end">
    <section class="dt-final pop-in" aria-label="Tonight's cards">
      <${Seal} />
      <p class="dt-closing">${s.closing}</p>
      <p class="dt-final-num"><b>${s.count}</b> card${s.count === 1 ? '' : 's'} shared${s.points > 0 ? html`<span class="dt-final-pts"> · +${s.points} together point${s.points === 1 ? '' : 's'}</span>` : ''}</p>
      <${Postmark} me=${api.me} partner=${api.partner} at=${s.endedAt || undefined} class="dt-postmark" />
    </section>
    ${s.favs.length
      ? html`<div class="dt-favs">
          <h3><${Icon} name="bookmark" size=${16} />Your favourites</h3>
          ${s.favs.map(
            (f, i) => html`<div class="dt-fav" key=${f.id} style=${`animation-delay:${Math.min(i, 5) * 50}ms`}>
              <span class="dt-fav-level">${LEVELS[f.level]?.name}</span>
              <p class="dt-fav-q">${f.text}</p>
              ${f.answers &&
              html`<div class="dt-fav-answers">
                ${[api.me.id, ...api.players.filter((id) => id !== api.me.id)].map(
                  (id) => f.answers[id] && html`<p key=${id}><b>${nameOf(api, id)}</b> ${f.answers[id]}</p>`,
                )}
              </div>`}
            </div>`,
          )}
        </div>`
      : html`<p class="dt-none">No favourites saved this time. Next time, tap Save on the cards you love.</p>`}
    <${ResultActions} api=${api} />
  </div>`;
}

export default function DeepTalkView({ s, api }) {
  // Little moments, heard on both phones.
  useOnChange(s.flipped && s.card ? s.card.id : 0, () => api.effects.sound('whoosh'));
  useOnChange(s.outcome ? `${s.card.id}:${s.outcome}` : 0, () => api.effects.sound(s.outcome === 'written' ? 'reveal' : 'heart'));
  const favCount = useRef(s.favs.length);
  useEffect(() => {
    if (s.favs.length > favCount.current) api.effects.sound('pop');
    favCount.current = s.favs.length;
  }, [s.favs.length]);
  useOnChange(s.done, () => {
    api.effects.sound('success');
    api.effects.confetti();
  });

  return html`<section class="game deeptalk">
    <${GameHeader} meta=${meta} api=${api} />
    ${s.phase === 'card' && s.card && html`<${CardPhase} s=${s} api=${api} />`}
    ${s.phase === 'done' && html`<${DonePhase} s=${s} api=${api} />`}
  </section>`;
}
