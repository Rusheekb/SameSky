import { html, useState, useEffect } from '../../ui/h.js';
import { GameHeader, LockStatus, ResultActions, WaitingDots, Avatar, useOnChange, useCountdown } from '../../ui/components.js';
import { meta, stats, isLocked } from './logic.js';

const LOCK_LABELS = { done: 'locked', waiting: 'picking…' };
const sideText = (item, k) => (k === 'a' ? item.a : k === 'b' ? item.b : '');

function verdict(pct) {
  if (pct >= 100) return 'Same brain, two bodies 🤯';
  if (pct >= 80) return 'Basically soulmates 💞';
  if (pct >= 60) return 'Beautifully in tune 🎶';
  if (pct >= 40) return 'Opposites attract ⚡';
  return 'Never a dull moment 😂';
}

function Options({ item, value, onPick, disabled, kind, label }) {
  return html`<div class=${`tot-opts ${kind}`} role="radiogroup" aria-label=${label}>
    ${['a', 'b'].map(
      (k) => html`<button key=${k} type="button" role="radio" aria-checked=${value === k}
        class=${`tot-opt tot-${k} ${value === k ? 'sel' : ''}`} disabled=${disabled} onClick=${() => onPick(k)}>
        <span>${sideText(item, k)}</span>${value === k && html`<i class="tot-tick" aria-hidden="true">✓</i>`}
      </button>`,
    )}
    <span class="tot-or" aria-hidden="true">or</span>
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
    return html`<div class="stack center">
      <div class="card glow tot-locked pop-in">
        <p class="tot-locked-title">🔒 Locked in</p>
        <div class="tot-locked-row"><small>You'd pick</small><b>${sideText(item, server.mine)}</b></div>
        <div class="tot-locked-row"><small>You think ${pName} picks</small><b>${sideText(item, server.guess)}</b></div>
      </div>
      <p class="muted"><${WaitingDots} text=${`Waiting for ${pName} to choose`} /></p>
      <${LockStatus} api=${api} locked=${lockedMap} labels=${LOCK_LABELS} />
    </div>`;
  }

  return html`<div class="stack tot-pick">
    <p class="tot-hint muted center">
      ${partnerLocked ? html`<b class="tot-hot">${pName} has locked in — your turn!</b>` : 'Tap yours, then guess theirs.'}
    </p>
    <div class=${`tot-step ${view.mine ? 'done' : ''}`}>
      <div class="tot-label"><${Avatar} player=${me} size="sm" /><b>You'd pick…</b>${view.mine && html`<span class="tot-check">✓</span>`}</div>
      <${Options} item=${item} value=${view.mine} kind="mine" label="Your pick" onPick=${(k) => tap('mine', k)} />
    </div>
    <div class=${`tot-step ${view.guess ? 'done' : ''}`}>
      <div class="tot-label"><${Avatar} player=${api.partner} size="sm" /><b>${pName} would pick…</b>${view.guess && html`<span class="tot-check">✓</span>`}</div>
      <${Options} item=${item} value=${view.guess} kind="guess" label=${`Your guess for ${pName}`} onPick=${(k) => tap('guess', k)} />
    </div>
    <${LockStatus} api=${api} locked=${lockedMap} labels=${LOCK_LABELS} />
  </div>`;
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
    <div class="tot-dilemma"><span>${item.a}</span><i>vs</i><span>${item.b}</span></div>
    <div class="reveal-row">
      ${[me, partner].map(
        (p, i) => p && html`<div class=${`reveal-card flip-in tot-rcard ${r.same ? 'same' : ''}`} key=${p.id} style=${`animation-delay:${i * 160}ms`}>
          <${Avatar} player=${p} size="sm" />
          <small>${p.id === me.id ? 'You picked' : `${p.name} picked`}</small>
          <b>${sideText(item, r.mine[p.id])}</b>
        </div>`,
      )}
    </div>
    <div class=${`result-banner pop-in ${r.same ? 'win' : ''}`} style="animation-delay:320ms">
      <h3 class="tot-headline">${r.same ? `You both chose ${myPick} 💞` : 'You split on this one ⚡'}</h3>
      <ul class="tot-checks">
        <li class=${r.right[pid] ? 'ok' : 'no'}>
          <b>${r.right[pid] ? `${pName} read your mind ✓` : `${pName} guessed wrong ✗`}</b>
          <small>${pName} guessed you'd pick ${sideText(item, r.guess[pid])}</small>
        </li>
        <li class=${r.right[me.id] ? 'ok' : 'no'}>
          <b>${r.right[me.id] ? `You read ${pName}'s mind ✓` : 'You guessed wrong ✗'}</b>
          <small>You guessed ${sideText(item, r.guess[me.id])}</small>
        </li>
      </ul>
      <p class="tot-gain">${r.gained ? `+${r.gained} together point${r.gained === 1 ? '' : 's'}` : 'No points this time — still cute.'}</p>
    </div>
    <button class="btn btn-primary btn-lg tot-next" onClick=${() => api.act({ type: 'next', round: s.round })}>
      ${last ? 'See results' : 'Next dilemma'} →${secs != null && html`<span class="tot-count" aria-label=${`auto in ${secs} seconds`}>${secs}</span>`}
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
    <div class="card glow tot-final pop-in">
      <div class="tot-ring" style=${`--p:${st.compat}`} role="img" aria-label=${`${st.compat}% in tune`}>
        <div><b>${st.compat}%</b><small>in tune</small></div>
      </div>
      <h2>${verdict(st.compat)}</h2>
      <p class="muted">Same pick ${st.same} of ${n} times</p>
      <div class="tot-minds">
        <div class="tot-mind"><${Avatar} player=${me} size="sm" /><b>${st.read[me.id] ?? 0}/${n}</b><small>You read ${pName}</small></div>
        <div class="tot-mind"><${Avatar} player=${partner} size="sm" /><b>${st.read[pid] ?? 0}/${n}</b><small>${pName} read you</small></div>
      </div>
      <p class="tot-gain">+${s.gained} together points this game</p>
    </div>
    ${st.differed.length
      ? html`<div class="card tot-talk">
          <h3>Talk about these! 💬</h3>
          <ul>
            ${st.differed.map(
              (r, i) => html`<li key=${i}>
                <span class="tot-who"><${Avatar} player=${me} size="sm" /><small>You</small><b>${sideText(r.item, r.mine[me.id])}</b></span>
                <span class="tot-who"><${Avatar} player=${partner} size="sm" /><small>${pName}</small><b>${sideText(r.item, r.mine[pid])}</b></span>
              </li>`,
            )}
          </ul>
        </div>`
      : html`<p class="card tot-talk">You agreed on every single one. Suspicious… 🤨💞</p>`}
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
      if (last.same) api.effects.floatEmoji('💞', { count: 3 });
    }
  });
  useOnChange(s.phase === 'over' ? s.plays : 0, () => {
    api.effects.sound('success');
    if (stats(s, api.players).compat >= 60) api.effects.confetti();
  });

  return html`<section class="game thisorthat">
    <${GameHeader} meta=${meta} api=${api}>
      <span class="chip tot-meta">
        ${s.phase !== 'over' && html`<span class="tot-round" aria-label=${`Round ${s.round} of ${s.items.length}`}>${s.round}/${s.items.length}</span>`}
        <span class="tot-pts" title="Together points">💞 ${s.points}</span>
      </span>
    </${GameHeader}>
    ${s.phase === 'pick' && html`<${PickPhase} s=${s} api=${api} item=${item} key=${`${s.plays}:${s.round}`} />`}
    ${s.phase === 'reveal' && html`<${RevealPhase} s=${s} api=${api} item=${item} />`}
    ${s.phase === 'over' && html`<${OverPhase} s=${s} api=${api} />`}
  </section>`;
}
