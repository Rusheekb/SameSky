import { html, useState, useEffect } from '../../ui/h.js';
import { GameHeader, LockStatus, ResultActions, WaitingDots, Avatar, Icon, Postmark, useOnChange, useCountdown } from '../../ui/components.js';
import { meta, stats, isLocked } from './logic.js';

const LOCK_LABELS = { done: 'locked', waiting: 'picking…' };
const sideText = (item, k) => (k === 'a' ? item.a : k === 'b' ? item.b : '');

function verdict(pct) {
  if (pct >= 100) return 'Same brain, two bodies';
  if (pct >= 80) return 'Basically soulmates';
  if (pct >= 60) return 'Beautifully in tune';
  if (pct >= 40) return 'Opposites attract';
  return 'Never a dull moment';
}

/** Two quiet cards with "or" between them; the picked one gets the lamplight hairline. */
function Options({ item, value, onPick, disabled, kind, label }) {
  const opt = (k) => html`<button key=${k} type="button" role="radio" aria-checked=${value === k}
    class=${`tot-opt tot-${k} ${value === k ? 'sel' : ''}`} disabled=${disabled} onClick=${() => onPick(k)}>
    ${sideText(item, k)}
  </button>`;
  return html`<div class=${`tot-opts ${kind}`} role="radiogroup" aria-label=${label}>
    ${opt('a')}<span class="tot-or" aria-hidden="true">or</span>${opt('b')}
  </div>`;
}

function PickPhase({ s, api, item }) {
  const me = api.me;
  const pName = api.partner?.name || 'your partner';
  const server = s.choices[me.id] || {};
  // Optimistic local taps so the cards respond instantly; the authority's state wins once it arrives.
  const [local, setLocal] = useState({});
  useEffect(() => setLocal({}), [s.round, s.plays]);
  const view = { mine: local.mine || server.mine, guess: local.guess || server.guess };
  const locked = isLocked(server);
  const lockedMap = Object.fromEntries(api.players.map((id) => [id, isLocked(s.choices[id])]));
  const partnerLocked = api.partner && lockedMap[api.partner.id];

  const tap = (slot, choice) => {
    if (locked) return;
    const next = { ...view, [slot]: choice };
    setLocal(next);
    api.act({ type: 'pick', slot, choice });
    api.effects.sound(next.mine && next.guess ? 'lock' : 'tap');
  };

  if (locked) {
    return html`<div class="stack center tot-wait">
      <div class="card tot-locked pop-in">
        <p class="tot-locked-title"><${Icon} name="lock" size=${16} />Locked in</p>
        <dl class="tot-locked-rows">
          <div class="tot-locked-row"><dt>You'd pick</dt><dd>${sideText(item, server.mine)}</dd></div>
          <div class="tot-locked-row"><dt>You think ${pName} picks</dt><dd>${sideText(item, server.guess)}</dd></div>
        </dl>
      </div>
      <p class="muted tot-waiting"><${WaitingDots} text=${`Waiting for ${pName} to choose`} /></p>
      <${LockStatus} api=${api} locked=${lockedMap} labels=${LOCK_LABELS} />
    </div>`;
  }

  return html`<div class="stack tot-pick">
    <p class=${`tot-hint ${partnerLocked ? 'is-hot' : ''}`}>
      ${partnerLocked ? `${pName} has locked in — your turn` : 'Tap yours, then guess theirs'}
    </p>
    <div class="tot-step">
      <div class="tot-label"><${Avatar} player=${me} size="sm" /><b>You'd pick</b>${view.mine && html`<span class="tot-check"><${Icon} name="check" size=${16} label="chosen" /></span>`}</div>
      <${Options} item=${item} value=${view.mine} kind="mine" label="Your pick" onPick=${(k) => tap('mine', k)} />
    </div>
    <div class="tot-step">
      <div class="tot-label"><${Avatar} player=${api.partner} size="sm" /><b>${pName} would pick</b>${view.guess && html`<span class="tot-check"><${Icon} name="check" size=${16} label="chosen" /></span>`}</div>
      <${Options} item=${item} value=${view.guess} kind="guess" label=${`Your guess for ${pName}`} onPick=${(k) => tap('guess', k)} />
    </div>
    <${LockStatus} api=${api} locked=${lockedMap} labels=${LOCK_LABELS} />
  </div>`;
}

function Check({ ok, title, detail }) {
  return html`<li class=${ok ? 'ok' : 'no'}>
    <${Icon} name=${ok ? 'circle-check' : 'circle-x'} label=${ok ? 'right' : 'wrong'} />
    <div><b>${title}</b><small>${detail}</small></div>
  </li>`;
}

function RevealPhase({ s, api, item }) {
  const me = api.me;
  const partner = api.partner;
  const pid = partner?.id;
  const pName = partner?.name || 'Your partner';
  const r = s.rounds[s.rounds.length - 1];
  const secs = useCountdown(api, s.nextAt);
  const last = s.round >= s.items.length;
  if (!r) return null;
  const myPick = sideText(item, r.mine[me.id]);
  return html`<div class="stack center tot-reveal">
    <p class="tot-dilemma"><span>${item.a}</span><span class="tot-dilemma-or">or</span><span>${item.b}</span></p>
    <div class="reveal-row">
      ${[me, partner].map(
        (p, i) => p && html`<div class="reveal-card flip-in tot-rcard" key=${p.id} style=${`animation-delay:${i * 160}ms`}>
          <small>${p.id === me.id ? 'You picked' : `${p.name} picked`}</small>
          <b>${sideText(item, r.mine[p.id])}</b>
        </div>`,
      )}
    </div>
    <div class="result-banner tot-result pop-in" style="animation-delay:320ms">
      <h3 class="tot-headline">${r.same ? `You both chose ${myPick}` : 'You split on this one'}</h3>
      <ul class="tot-checks">
        <${Check} ok=${r.right[pid]} title=${r.right[pid] ? `${pName} read your mind` : `${pName} guessed wrong`}
          detail=${`${pName} guessed you'd pick ${sideText(item, r.guess[pid])}`} />
        <${Check} ok=${r.right[me.id]} title=${r.right[me.id] ? `You read ${pName}'s mind` : 'You guessed wrong'}
          detail=${`You guessed ${sideText(item, r.guess[me.id])}`} />
      </ul>
      <p class="tot-gain">${r.gained
        ? html`<span class="points">+${r.gained}</span> together point${r.gained === 1 ? '' : 's'}`
        : 'No points this time — still cute'}</p>
    </div>
    <button class="btn btn-primary btn-lg tot-next" onClick=${() => api.act({ type: 'next', round: s.round })}>
      ${last ? 'See results' : 'Next dilemma'}<${Icon} name="arrow-right" />
      ${secs != null && html`<span class="tot-count" aria-label=${`auto in ${secs} seconds`}>${secs}s</span>`}
    </button>
  </div>`;
}

function OverPhase({ s, api }) {
  const me = api.me;
  const partner = api.partner;
  const pid = partner?.id;
  const pName = partner?.name || 'Your partner';
  const st = stats(s, api.players);
  const n = s.rounds.length;
  return html`<div class="stack center tot-over">
    <section class="card tot-final pop-in" aria-label="Results">
      <p class="tot-figure">${st.compat}%</p>
      <p class="tot-figure-label">in tune</p>
      <h2 class="tot-verdict">${verdict(st.compat)}</h2>
      <p class="tot-same">Same pick ${st.same} of ${n} times</p>
      <div class="tot-minds">
        <div class="tot-mind"><b>${st.read[me.id] ?? 0}/${n}</b><span class="tot-mind-who"><${Avatar} player=${me} size="sm" />You read ${pName}</span></div>
        <div class="tot-mind"><b>${st.read[pid] ?? 0}/${n}</b><span class="tot-mind-who"><${Avatar} player=${partner} size="sm" />${pName} read you</span></div>
      </div>
      <p class="tot-gain">+${s.gained} together points this game</p>
      <${Postmark} me=${me} partner=${partner} at=${s.endedAt || undefined} class="tot-postmark" />
    </section>
    ${st.differed.length
      ? html`<section class="card tot-talk">
          <h3>Talk about these</h3>
          <div class="tot-talk-head" aria-hidden="true">
            <span><${Avatar} player=${me} size="sm" />You</span>
            <span><${Avatar} player=${partner} size="sm" />${pName}</span>
          </div>
          <ul>
            ${st.differed.map(
              (r, i) => html`<li key=${i}>
                <span class="tot-who"><span class="tot-sr">You: </span>${sideText(r.item, r.mine[me.id])}</span>
                <span class="tot-who"><span class="tot-sr">${pName}: </span>${sideText(r.item, r.mine[pid])}</span>
              </li>`,
            )}
          </ul>
        </section>`
      : html`<p class="card tot-talk tot-agreed">You agreed on every single one. Suspicious.</p>`}
    <${ResultActions} api=${api} onAgain=${() => api.act({ type: 'again' })} againLabel="New dilemmas" />
  </div>`;
}

export default function ThisOrThatView({ s, api }) {
  const item = s.items[s.round - 1] || s.items[0];
  const last = s.rounds[s.rounds.length - 1];

  useOnChange(s.phase === 'reveal' ? `${s.plays}:${s.rounds.length}` : 0, () => {
    if (!last) return;
    if (last.gained === 3) {
      api.effects.confetti();
      api.effects.sound('success');
    } else {
      api.effects.sound('reveal');
    }
  });
  useOnChange(s.phase === 'over' ? s.plays : 0, () => {
    api.effects.sound('success');
    if (stats(s, api.players).compat >= 60) api.effects.confetti();
  });

  return html`<section class="game thisorthat">
    <${GameHeader} meta=${meta} api=${api} round=${s.phase !== 'over' ? s.round : null} total=${s.items.length}>
      <span class="tot-pts" title="Together points"><${Icon} name="heart" size=${14} label="Together points" />${s.points}</span>
    </${GameHeader}>
    ${s.phase === 'pick' && html`<${PickPhase} s=${s} api=${api} item=${item} key=${`${s.plays}:${s.round}`} />`}
    ${s.phase === 'reveal' && html`<${RevealPhase} s=${s} api=${api} item=${item} />`}
    ${s.phase === 'over' && html`<${OverPhase} s=${s} api=${api} />`}
  </section>`;
}
