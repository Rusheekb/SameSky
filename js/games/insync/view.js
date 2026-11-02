import { html } from '../../ui/h.js';
import { GameHeader, LockStatus, AnswerBox, ResultActions, WaitingDots, Postmark, Icon, useOnChange } from '../../ui/components.js';
import { wordsMatch } from '../../lib/util.js';
import { meta, MAX_ROUNDS, isWord } from './logic.js';

export default function InSyncView({ s, api }) {
  const me = api.me;
  const partner = api.partner;
  const myWord = s.words[me.id];
  const last = s.rounds[s.rounds.length - 1];
  const synced = s.phase === 'synced';

  useOnChange(synced ? s.rounds.length : 0, () => {
    api.effects.confetti({ count: 16 });
    api.effects.sound('success');
  });
  useOnChange(s.phase === 'reveal' ? s.rounds.length : 0, () => api.effects.sound('reveal'));

  return html`<section class="game insync">
    <${GameHeader} meta=${meta} round=${s.round} total=${MAX_ROUNDS} api=${api} />

    ${s.phase === 'pick' &&
    html`<div class="stack center is-stage">
      <div class="prompt-card is-prompt">
        <p class="is-ask">${s.round === 1 ? 'Think of a word that links' : 'Find the word that links your two words'}</p>
        <div class="pair">
          <span class="word-chip">${s.pair[0]}</span><span class="plus" aria-label="and">+</span><span class="word-chip">${s.pair[1]}</span>
        </div>
      </div>
      ${myWord
        ? html`<div class="card is-mine">
            <p class="is-label"><${Icon} name="lock" size=${16} />You said</p>
            <p class="is-word">${myWord}</p>
            <${WaitingDots} text=${`Waiting for ${partner?.name || 'your partner'}`} />
          </div>`
        : html`<${AnswerBox} key=${`r${s.round}:${s.plays}`} placeholder="Your word" clearOnSubmit=${false}
            onSubmit=${(word) => {
              api.act({ type: 'submit', word });
              api.effects.sound('lock');
            }}
            validate=${(v) =>
              !isWord(v)
                ? 'Type a word: letters, numbers or an emoji'
                : s.pair.some((w) => wordsMatch(w, v))
                  ? 'Use a new word, not one of the two on screen'
                  : ''} />`}
      <${LockStatus} api=${api} locked=${s.words} />
    </div>`}

    ${(s.phase === 'reveal' || synced) &&
    last &&
    html`<div class="stack center is-stage">
      <div class=${`reveal-row is-cards ${synced ? 'is-synced' : ''}`}>
        ${api.players.map(
          (id, i) => html`<div class="is-slot" key=${id}>
            <div class="reveal-card flip-in" style=${`animation-delay:${i * 120}ms`}>
              <small>${id === me.id ? 'You' : api.player(id)?.name}</small><b>${last.words[id]}</b>
            </div>
          </div>`,
        )}
      </div>
      ${synced
        ? html`<div class="result-banner win pop-in is-result">
            <h2>In sync</h2>
            <p>Round ${s.round} · <span class="points">+${s.gained}</span> together points</p>
            <${Postmark} me=${api.me} partner=${partner} at=${s.at ?? undefined} />
          </div>`
        : html`<div class="result-banner is-next">
            <p>Not yet. Next, link <b>${last.words[api.players[0]]}</b> + <b>${last.words[api.players[1]]}</b></p>
            <button class="btn btn-primary" onClick=${() => api.act({ type: 'next' })}>
              ${s.round >= MAX_ROUNDS ? 'See result' : html`Next round<${Icon} name="arrow-right" />`}
            </button>
          </div>`}
    </div>`}

    ${s.phase === 'over' &&
    html`<div class="stack center is-stage">
      <div class="result-banner pop-in is-result">
        <h2>${s.rounds.length ? 'So close' : 'Next time'}</h2>
        <p>${s.summary}</p>
        <${Postmark} me=${api.me} partner=${partner} at=${s.at ?? undefined} />
      </div>
    </div>`}

    ${s.rounds.length > 0 &&
    html`<details class="chain is-trail" open=${s.done}>
      <summary><${Icon} name="chevron-right" size=${16} />Your word trail</summary>
      <div class="is-trail-body">
        <p class="trail-start">Started from <b>${s.seed[0]}</b> + <b>${s.seed[1]}</b></p>
        <ol>
          ${s.rounds.map(
            (r, i) => html`<li key=${i} class=${r.match ? 'match' : ''}>
              <span class="is-n">${i + 1}</span>
              <span class="is-words">${api.players.map((id) => r.words[id]).join('  ·  ')}</span>
              ${r.match && html`<${Icon} name="equal" size=${16} label="Same word" />`}
            </li>`,
          )}
        </ol>
      </div>
    </details>`}

    ${s.done && html`<${ResultActions} api=${api} onAgain=${() => api.act({ type: 'again' })} againLabel="New words" />`}
    ${!s.done && s.rounds.length > 2 && html`<button class="btn btn-ghost is-giveup" onClick=${() => api.act({ type: 'giveup' })}>Give up this one</button>`}
  </section>`;
}
