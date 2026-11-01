import { html } from '../../ui/h.js';
import { GameHeader, LockStatus, AnswerBox, ResultActions, WaitingDots, useOnChange } from '../../ui/components.js';
import { wordsMatch } from '../../lib/util.js';
import { meta, MAX_ROUNDS, isWord } from './logic.js';

export default function InSyncView({ s, api }) {
  const me = api.me;
  const partner = api.partner;
  const myWord = s.words[me.id];
  const last = s.rounds[s.rounds.length - 1];

  useOnChange(s.phase === 'synced' ? s.rounds.length : 0, () => {
    api.effects.confetti();
    api.effects.sound('success');
  });
  useOnChange(s.phase === 'reveal' ? s.rounds.length : 0, () => api.effects.sound('reveal'));

  return html`<section class="game insync">
    <${GameHeader} meta=${meta} round=${s.round} total=${MAX_ROUNDS} api=${api} />

    ${s.phase === 'pick' &&
    html`<div class="stack center">
      <p class="muted">${s.round === 1 ? 'Think of a word that links' : 'Find the word that links your two words'}</p>
      <div class="pair">
        <span class="word-chip">${s.pair[0]}</span><span class="plus">+</span><span class="word-chip">${s.pair[1]}</span>
      </div>
      ${myWord
        ? html`<div class="card glow center"><p class="muted">You said</p><p class="big">${myWord}</p>
            <${WaitingDots} text=${`Waiting for ${partner?.name || 'your partner'}`} /></div>`
        : html`<${AnswerBox} key=${`r${s.round}:${s.plays}`} placeholder="Your word…" clearOnSubmit=${false}
            onSubmit=${(word) => {
              api.act({ type: 'submit', word });
              api.effects.sound('lock');
            }}
            validate=${(v) =>
              !isWord(v)
                ? 'Type a word — letters, numbers or an emoji 🙂'
                : s.pair.some((w) => wordsMatch(w, v))
                  ? 'Use a new word — not one of the two on screen 😉'
                  : ''} />`}
      <${LockStatus} api=${api} locked=${s.words} />
    </div>`}

    ${(s.phase === 'reveal' || s.phase === 'synced') &&
    last &&
    html`<div class="stack center">
      <div class="reveal-row">
        ${api.players.map(
          (id, i) => html`<div class="reveal-card flip-in" style=${`animation-delay:${i * 180}ms`} key=${id}>
            <small>${id === me.id ? 'You' : api.player(id)?.name}</small><b>${last.words[id]}</b>
          </div>`,
        )}
      </div>
      ${s.phase === 'synced'
        ? html`<div class="result-banner win pop-in"><h2>In sync! 🔮✨</h2>
            <p>Round ${s.round} · +${s.gained} together points</p></div>`
        : html`<div class="result-banner">
            <p>Not yet! Next round: link <b>${last.words[api.players[0]]}</b> + <b>${last.words[api.players[1]]}</b></p>
            <button class="btn btn-primary" onClick=${() => api.act({ type: 'next' })}>${s.round >= MAX_ROUNDS ? 'See result' : 'Next round →'}</button>
          </div>`}
    </div>`}

    ${s.phase === 'over' &&
    html`<div class="result-banner"><h2>${s.rounds.length ? 'So close 💫' : 'Next time!'}</h2><p>${s.summary}</p></div>`}

    ${s.rounds.length > 0 &&
    html`<details class="chain" open=${s.done}>
      <summary>Your word trail</summary>
      <p class="muted small trail-start">Started from <b>${s.seed[0]}</b> + <b>${s.seed[1]}</b></p>
      <ol>
        ${s.rounds.map(
          (r, i) => html`<li key=${i} class=${r.match ? 'match' : ''}>${api.players.map((id) => r.words[id]).join('  ·  ')}${r.match ? ' 💞' : ''}</li>`,
        )}
      </ol>
    </details>`}

    ${s.done && html`<${ResultActions} api=${api} onAgain=${() => api.act({ type: 'again' })} againLabel="New words" />`}
    ${!s.done && s.rounds.length > 2 && html`<button class="btn btn-ghost btn-sm" onClick=${() => api.act({ type: 'giveup' })}>Give up this one</button>`}
  </section>`;
}
