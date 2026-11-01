import { html, useState } from '../../ui/h.js';
import { GameHeader, LockStatus, AnswerBox, ResultActions, WaitingDots, Avatar, useOnChange } from '../../ui/components.js';
import { meta, ROUNDS, MAX_SKIPS, MAX_ANSWER, SCALE_MAX, showValue, verdict } from './logic.js';

const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const LETTERS = ['A', 'B', 'C', 'D'];

export default function KnowMeView({ s, api }) {
  const me = api.me;
  const [p1, p2] = api.players;
  const subjectId = s.subject;
  const guesserId = api.players.find((id) => id !== subjectId);
  const iAmSubject = subjectId === me.id;
  // "You" for me, the partner's name otherwise (capitalised / mid-sentence variants).
  const Name = (id) => (id === me.id ? 'You' : api.names[id] || 'Your partner');
  const name = (id) => (id === me.id ? 'you' : api.names[id] || 'your partner');
  const subjectName = api.names[subjectId] || 'your partner';
  const guesserName = api.names[guesserId] || 'your partner';

  const key = `${s.plays}:${s.round}`;
  const qKey = `${key}:${s.q?.id}`;
  const mine = hasOwn(s.answers, me.id) ? s.answers[me.id] : undefined;
  const partnerLocked = !!api.partner && hasOwn(s.answers, api.partner.id);

  // Option / number picked but not locked yet. Keyed by question so it resets on skip / next round.
  const [pick, setPick] = useState({ key: '', v: null });
  const sel = pick.key === qKey ? pick.v : null;
  const choose = (v) => {
    setPick({ key: qKey, v });
    api.effects.sound('tap');
  };
  const lock = (value) => {
    api.act({ type: 'answer', value, q: s.q.id });
    api.effects.sound('lock');
  };

  // ---- little moments
  useOnChange(s.phase === 'reveal' ? key : 0, () => {
    const sc = s.result?.score;
    if (sc === 2) {
      api.effects.sound('reveal');
      setTimeout(() => {
        api.effects.confetti({ count: 22 });
        api.effects.sound('success');
      }, 550);
    } else if (sc === 1) {
      api.effects.sound('reveal');
      setTimeout(() => api.effects.floatEmoji('✨', { count: 4 }), 550);
    } else {
      api.effects.sound('reveal');
      setTimeout(() => api.effects.sound('fail'), 550);
    }
  });
  useOnChange(s.phase === 'judge' ? key : 0, () => api.effects.sound('reveal'));
  useOnChange(s.phase === 'answer' && partnerLocked ? qKey : 0, () => api.effects.sound('pop'));
  useOnChange(s.phase === 'answer' && s.skippedBy ? `${s.round}:${s.skips}` : 0, () => {
    api.effects.toast(s.skippedBy === me.id ? 'Skipped — here’s a fresh one 🔄' : `${api.names[s.skippedBy] || 'Your partner'} skipped — fresh question! 🔄`);
    api.effects.sound('whoosh');
  });
  useOnChange(s.phase === 'over' ? s.plays : 0, () => {
    api.effects.sound('success');
    if (s.gained >= ROUNDS) api.effects.confetti();
    else api.effects.floatEmoji('💭', { count: 3 });
  });

  const prompt = (compact) => html`<div class=${`prompt-card km-prompt ${compact ? 'compact' : ''}`} key=${qKey}>
    <span class="km-about"><${Avatar} player=${api.player(subjectId)} size="sm" /> About ${name(subjectId)}</span>
    <span class="km-q">${s.q.text}</span>
    ${s.q.ai && html`<span class="km-ai">✨ written just for you two</span>`}
  </div>`;

  return html`<section class="game knowme">
    <${GameHeader} meta=${meta} round=${s.phase === 'over' ? null : s.round} total=${ROUNDS} api=${api} />

    ${s.phase === 'answer' &&
    html`<div class="stack km-answer">
      ${prompt(false)}
      <p class="km-hint">
        ${iAmSubject ? html`Be honest — <b>${guesserName}</b> is guessing your answer 👀` : html`What would <b>${subjectName}</b> say? 🤔`}
      </p>
      ${mine !== undefined
        ? html`<div class="card glow center km-locked pop-in">
            <p class="muted">${iAmSubject ? 'Your answer' : 'Your guess'} 🔒</p>
            <p class="big">${showValue(s.q, mine)}</p>
            <${WaitingDots} text=${partnerLocked ? 'Flipping' : iAmSubject ? `Waiting for ${guesserName} to guess` : `Waiting for ${subjectName} to answer`} />
          </div>`
        : html`<${Picker} q=${s.q} sel=${sel} choose=${choose} lock=${lock} iAmSubject=${iAmSubject} subjectName=${subjectName} />`}
      <${LockStatus} api=${api} locked=${Object.fromEntries(Object.keys(s.answers).map((id) => [id, true]))} />
      ${s.skips < MAX_SKIPS && s.spares.length > 0 &&
      html`<button class="btn btn-ghost km-skip" onClick=${() => api.act({ type: 'skip', q: s.q.id })}>
        🔄 Skip question <small>(${MAX_SKIPS - s.skips} left)</small>
      </button>`}
    </div>`}

    ${(s.phase === 'judge' || s.phase === 'reveal') &&
    html`<div class="stack center km-reveal">
      ${prompt(true)}
      <div class="km-cards" key=${qKey}>
        <${FlipCard} player=${api.player(subjectId)} label=${iAmSubject ? 'Your answer' : `${subjectName}’s answer`}
          value=${showValue(s.q, s.answers[subjectId])} tone=${tone(s)} />
        <${FlipCard} player=${api.player(guesserId)} label=${iAmSubject ? `${guesserName}’s guess` : 'Your guess'}
          value=${showValue(s.q, s.answers[guesserId])} tone=${tone(s)} delay=${260} />
        <span class=${`km-vs ${tone(s)}`} aria-hidden="true">${{ hit: '=', close: '≈', miss: '≠' }[tone(s)] || '?'}</span>
      </div>
      ${s.q.kind === 'scale' &&
      html`<${ScaleTrack} q=${s.q} api=${api} subjectId=${subjectId} guesserId=${guesserId}
        real=${s.answers[subjectId]} guess=${s.answers[guesserId]} />`}

      ${s.phase === 'judge' &&
      (iAmSubject
        ? html`<div class="km-judge pop-in" style="animation-delay:.55s">
            <p class="km-judge-q">Did <b>${guesserName}</b> get it?</p>
            <div class="km-judge-btns">
              <button class="btn km-j hit" onClick=${() => api.act({ type: 'judge', score: 2 })}><span>🎯</span>Nailed it<small>+2</small></button>
              <button class="btn km-j close" onClick=${() => api.act({ type: 'judge', score: 1 })}><span>🤏</span>Close enough<small>+1</small></button>
              <button class="btn km-j miss" onClick=${() => api.act({ type: 'judge', score: 0 })}><span>🙈</span>Nope<small>0</small></button>
            </div>
          </div>`
        : html`<div class="card center km-wait pop-in" style="animation-delay:.55s">
            <${WaitingDots} text=${`Waiting for ${subjectName} to judge`} />
            <p class="muted small">Nailed it, close enough… or nope? 🤞</p>
          </div>`)}

      ${s.phase === 'reveal' &&
      s.result &&
      html`<div class=${`result-banner km-result ${s.result.score === 2 ? 'win' : s.result.score === 1 ? 'close' : ''} pop-in`}
        style=${`animation-delay:${s.result.how === 'judged' ? 0 : 0.6}s`}>
        <h3>${resultTitle(s, subjectName)}</h3>
        <p class="muted">${s.result.score > 0
          ? `+${s.result.score} together point${s.result.score > 1 ? 's' : ''} · ${s.gained} this game`
          : iAmSubject
            ? `Now ${guesserName} knows you a little better 💡`
            : `Now you know ${subjectName} a little better 💡`}</p>
        <button class="btn btn-primary" onClick=${() => api.act({ type: 'next', round: s.round })}>
          ${s.round >= ROUNDS ? 'See how you did 💭' : 'Next question →'}
        </button>
      </div>`}
    </div>`}

    ${s.phase === 'over' && s.tally && html`<${Final} s=${s} api=${api} Name=${Name} name=${name} p1=${p1} p2=${p2} />`}
  </section>`;
}

function tone(s) {
  if (s.phase !== 'reveal' || !s.result) return '';
  return s.result.score === 2 ? 'hit' : s.result.score === 1 ? 'close' : 'miss';
}

function resultTitle(s, subjectName) {
  const { score, how } = s.result;
  if (how === 'judged') return [`${subjectName} says: nope 🙈`, `${subjectName} says: close enough 🤏`, `${subjectName} says: nailed it! 🎯`][score];
  if (score === 2) return how === 'exact' ? 'Word for word! 🎯' : s.q.kind === 'scale' ? 'Spot on! 🎯' : 'Nailed it! 🎯';
  if (score === 1) return 'So close — just one off! 🤏';
  return 'Not quite! 🙈';
}

/** Input for the current question: 4 options, a 1–10 scale, or free text. */
function Picker({ q, sel, choose, lock, iAmSubject, subjectName }) {
  if (q.kind === 'choice') {
    return html`<div class="stack km-picker">
      <div class="km-options" role="radiogroup" aria-label=${q.text}>
        ${q.options.map(
          (o, i) => html`<button key=${i} role="radio" aria-checked=${sel === i} class=${`btn btn-choice km-opt ${sel === i ? 'sel' : ''}`} onClick=${() => choose(i)}>
            <span class="km-letter">${LETTERS[i]}</span><span>${o}</span>
          </button>`,
        )}
      </div>
      <button class="btn btn-primary km-lock" disabled=${sel == null} onClick=${() => lock(sel)}>
        ${sel == null ? 'Pick one' : iAmSubject ? 'Lock in my answer' : 'Lock in my guess'}
      </button>
    </div>`;
  }
  if (q.kind === 'scale') {
    const nums = Array.from({ length: SCALE_MAX }, (_, i) => i + 1);
    return html`<div class="stack km-picker">
      <div class="km-scale-pick">
        <div class="km-scale-btns" role="radiogroup" aria-label=${q.text}>
          ${nums.map(
            (n) => html`<button key=${n} role="radio" aria-checked=${sel === n} aria-label=${`${n} of ${SCALE_MAX}`}
              class=${`km-num ${sel === n ? 'sel' : ''}`} style=${`--i:${n - 1}`} onClick=${() => choose(n)}>${n}</button>`,
          )}
        </div>
        <div class="km-scale-labels"><span>← ${q.low}</span><span>${q.high} →</span></div>
      </div>
      <button class="btn btn-primary km-lock" disabled=${sel == null} onClick=${() => lock(sel)}>
        ${sel == null ? 'Pick a number' : `Lock in ${sel}/${SCALE_MAX}`}
      </button>
    </div>`;
  }
  return html`<div class="km-picker km-open">
    <${AnswerBox} placeholder=${iAmSubject ? 'Your honest answer…' : `${subjectName} would say…`} maxLength=${MAX_ANSWER}
      onSubmit=${(v) => lock(v)} />
  </div>`;
}

function FlipCard({ player, label, value, tone = '', delay = 0 }) {
  return html`<div class=${`km-flip ${tone}`} style=${`--d:${delay}ms`}>
    <div class="km-flip-inner">
      <div class="km-face km-front">
        <span class="km-face-label"><${Avatar} player=${player} size="sm" /><span>${label}</span></span>
        <b class="km-face-value">${value}</b>
      </div>
      <div class="km-face km-back" aria-hidden="true">💭</div>
    </div>
  </div>`;
}

/** Both positions on the 1–10 line: the real answer above, the guess below. */
function ScaleTrack({ q, api, subjectId, guesserId, real, guess }) {
  const pos = (v) => `${((v - 1) / (SCALE_MAX - 1)) * 100}%`;
  return html`<div class="km-track-wrap" aria-label=${`Answer ${real}, guess ${guess}`}>
    <div class="km-track">
      <span class="km-pin up" style=${`--x:${pos(real)}`}><${Avatar} player=${api.player(subjectId)} size="sm" /><b>${real}</b></span>
      <div class="km-line">${Array.from({ length: SCALE_MAX }, (_, i) => html`<i key=${i} style=${`left:${pos(i + 1)}`}></i>`)}</div>
      <span class="km-pin down" style=${`--x:${pos(guess)}`}><b>${guess}</b><${Avatar} player=${api.player(guesserId)} size="sm" /></span>
    </div>
    <div class="km-scale-labels"><span>${q.low}</span><span>${q.high}</span></div>
  </div>`;
}

function Final({ s, api, Name, name, p1, p2 }) {
  const t = s.tally;
  const score = (id) => (t[id] ? t[id].right * 2 + t[id].close : 0);
  const best = score(p1) === score(p2) ? null : score(p1) > score(p2) ? p1 : p2;
  const other = (id) => (id === p1 ? p2 : p1);
  const knows = (id) => (id === api.me.id ? 'know' : 'knows');
  const v = verdict(s.gained);
  return html`<div class="stack center km-final">
    <div class="result-banner win pop-in">
      <h2>${v.title}</h2>
      <p class="km-verdict">${v.line}</p>
      <div class="km-tally">
        ${(api.me.id === p2 ? [p2, p1] : [p1, p2]).map(
          (g) => html`<div class="km-tally-card" key=${g}>
            <div class="km-tally-who"><${Avatar} player=${api.player(g)} size="sm" /><span>${Name(g)} ${knows(g)} ${name(other(g))}</span></div>
            <b class="km-tally-score">${t[g]?.right ?? 0}<small>/${t[g]?.total ?? 0}</small></b>
            <small class="muted">${t[g]?.close ? `+ ${t[g].close} close call${t[g].close > 1 ? 's' : ''}` : t[g]?.right === t[g]?.total ? 'perfect! ✨' : ' '}</small>
          </div>`,
        )}
      </div>
      <p class="km-best">${best ? `👑 ${Name(best)} ${knows(best)} ${name(other(best))} best this time` : 'Dead even — perfectly matched 💞'}</p>
      <p class="km-gained"><b>+${s.gained}</b> together points</p>
    </div>
    <${ResultActions} api=${api} onAgain=${() => api.act({ type: 'again' })} againLabel="Play again" />
    <details class="chain km-log" open>
      <summary>Round by round</summary>
      <ol>
        ${s.log.map(
          (r, i) => html`<li key=${i} class=${r.score === 2 ? 'hit' : r.score === 1 ? 'close' : 'miss'}>
            <span class="km-mark">${r.score === 2 ? '✓' : r.score === 1 ? '≈' : '✗'}</span>
            <div>
              <small class="muted">About ${name(r.subject)} · ${r.text}</small>
              <div><b>${r.answer}</b>${r.score !== 2 && html` <span class="muted">· ${name(r.guesser)} said ${r.guess}</span>`}</div>
            </div>
          </li>`,
        )}
      </ol>
    </details>
  </div>`;
}
