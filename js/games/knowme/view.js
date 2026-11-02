import { html, useState } from '../../ui/h.js';
import { GameHeader, LockStatus, AnswerBox, ResultActions, WaitingDots, Avatar, Icon, Postmark, useOnChange } from '../../ui/components.js';
import { meta, ROUNDS, MAX_SKIPS, MAX_ANSWER, SCALE_MAX, showValue, verdict } from './logic.js';

const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const LETTERS = ['A', 'B', 'C', 'D'];
const SYMBOL = { hit: '=', close: '≈', miss: '≠' };
const SYMBOL_LABEL = { hit: 'Same answer', close: 'Close', miss: 'Different answers' };

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

  // ---- little moments: sounds per round; paper slips are kept for the final screen
  useOnChange(s.phase === 'reveal' ? key : 0, () => {
    const sc = s.result?.score;
    api.effects.sound('reveal');
    if (sc === 2) setTimeout(() => api.effects.sound('success'), 550);
    else if (sc === 0) setTimeout(() => api.effects.sound('fail'), 550);
  });
  useOnChange(s.phase === 'judge' ? key : 0, () => api.effects.sound('reveal'));
  useOnChange(s.phase === 'answer' && partnerLocked ? qKey : 0, () => api.effects.sound('pop'));
  useOnChange(s.phase === 'answer' && s.skippedBy ? `${s.round}:${s.skips}` : 0, () => {
    api.effects.toast(s.skippedBy === me.id ? 'Skipped, here’s a fresh one' : `${api.names[s.skippedBy] || 'Your partner'} skipped, here’s a fresh question`);
    api.effects.sound('whoosh');
  });
  useOnChange(s.phase === 'over' ? s.plays : 0, () => {
    api.effects.sound('success');
    if (s.gained >= ROUNDS) api.effects.confetti();
  });

  const prompt = (compact) => html`<div class=${`prompt-card km-prompt ${compact ? 'compact' : ''}`} key=${qKey}>
    <span class="km-about"><${Avatar} player=${api.player(subjectId)} size="sm" /> About ${name(subjectId)}</span>
    <span class="km-q">${s.q.text}</span>
    ${s.q.ai && html`<span class="km-ai"><${Icon} name="wand" size=${16} />Written for you two</span>`}
  </div>`;

  const t = tone(s);

  return html`<section class="game knowme">
    <${GameHeader} meta=${meta} round=${s.phase === 'over' ? null : s.round} total=${ROUNDS} api=${api} />

    ${s.phase === 'answer' &&
    html`<div class="stack km-answer">
      ${prompt(false)}
      <p class="km-hint">
        ${iAmSubject ? html`Be honest, <b>${guesserName}</b> is guessing your answer` : html`What would <b>${subjectName}</b> say?`}
      </p>
      ${mine !== undefined
        ? html`<div class="card km-locked pop-in">
            <p class="km-locked-label"><${Icon} name="lock" size=${16} />${iAmSubject ? 'Your answer' : 'Your guess'}</p>
            <p class="km-locked-value">${showValue(s.q, mine)}</p>
            <${WaitingDots} text=${partnerLocked ? 'Turning them over' : iAmSubject ? `Waiting for ${guesserName} to guess` : `Waiting for ${subjectName} to answer`} />
          </div>`
        : // Keyed by question: a skip (same round, new question) remounts it, so text half-typed
          // for the old question never gets locked in as the answer to the new one.
          html`<${Picker} key=${qKey} q=${s.q} sel=${sel} choose=${choose} lock=${lock} iAmSubject=${iAmSubject} subjectName=${subjectName} />`}
      <${LockStatus} api=${api} locked=${Object.fromEntries(Object.keys(s.answers).map((id) => [id, true]))} />
      ${s.skips < MAX_SKIPS && s.spares.length > 0 &&
      html`<button class="btn btn-ghost km-skip" onClick=${() => api.act({ type: 'skip', q: s.q.id })}>
        <${Icon} name="skip-forward" size=${16} />Skip question<span class="km-skip-left">${MAX_SKIPS - s.skips} left</span>
      </button>`}
    </div>`}

    ${(s.phase === 'judge' || s.phase === 'reveal') &&
    html`<div class="stack center km-reveal">
      ${prompt(true)}
      <div class=${`km-cards ${t}`} key=${qKey}>
        <${FlipCard} player=${api.player(subjectId)} who=${iAmSubject ? null : subjectName} role="answer"
          value=${showValue(s.q, s.answers[subjectId])} />
        <${FlipCard} player=${api.player(guesserId)} who=${iAmSubject ? guesserName : null} role="guess"
          value=${showValue(s.q, s.answers[guesserId])} delay=${200} />
        <span class=${`km-vs ${t}`} role="img" aria-label=${SYMBOL_LABEL[t] || 'Waiting for the judge'}>${SYMBOL[t] || '?'}</span>
      </div>
      ${s.q.kind === 'scale' &&
      html`<${ScaleTrack} q=${s.q} api=${api} subjectId=${subjectId} guesserId=${guesserId}
        real=${s.answers[subjectId]} guess=${s.answers[guesserId]} />`}

      ${s.phase === 'judge' &&
      (iAmSubject
        ? html`<div class="km-judge">
            <p class="km-judge-q">Did <b>${guesserName}</b> get it?</p>
            <div class="km-judge-btns">
              <button class="btn km-j" onClick=${() => api.act({ type: 'judge', score: 2 })}><${Icon} name="target" /><span>Nailed it</span><small>+2</small></button>
              <button class="btn km-j" onClick=${() => api.act({ type: 'judge', score: 1 })}><${Icon} name="equal-approximately" /><span>Close enough</span><small>+1</small></button>
              <button class="btn km-j" onClick=${() => api.act({ type: 'judge', score: 0 })}><${Icon} name="x" /><span>Nope</span><small>0</small></button>
            </div>
          </div>`
        : html`<div class="card km-wait">
            <${WaitingDots} text=${`Waiting for ${subjectName} to judge`} />
            <p>Nailed it, close enough or nope?</p>
          </div>`)}

      ${s.phase === 'reveal' &&
      s.result &&
      html`<div class=${`result-banner km-result ${s.result.score === 2 ? 'win' : ''} pop-in`}
        style=${`animation-delay:${s.result.how === 'judged' ? 0 : 600}ms`}>
        <h3>${resultTitle(s, subjectName)}</h3>
        <p>${s.result.score > 0
          ? html`<span class="points">+${s.result.score}</span> together point${s.result.score > 1 ? 's' : ''} · ${s.gained} this game`
          : iAmSubject
            ? `Now ${guesserName} knows you a little better`
            : `Now you know ${subjectName} a little better`}</p>
        <button class="btn btn-primary" onClick=${() => api.act({ type: 'next', round: s.round })}>
          ${s.round >= ROUNDS ? 'See how you did' : html`Next question<${Icon} name="arrow-right" />`}
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
  if (how === 'judged') return [`${subjectName} says: nope`, `${subjectName} says: close enough`, `${subjectName} says: nailed it`][score];
  if (score === 2) return how === 'exact' ? 'Word for word' : s.q.kind === 'scale' ? 'Spot on' : 'Nailed it';
  if (score === 1) return 'So close, just one off';
  return 'Not quite';
}

/** Input for the current question: 4 options, a 1–10 scale, or free text. */
function Picker({ q, sel, choose, lock, iAmSubject, subjectName }) {
  if (q.kind === 'choice') {
    return html`<div class="stack km-picker">
      <div class="km-options" role="radiogroup" aria-label=${q.text}>
        ${q.options.map(
          (o, i) => html`<button key=${i} role="radio" aria-checked=${sel === i} style=${`--i:${i}`}
            class=${`btn btn-choice km-opt ${sel === i ? 'sel' : ''}`} onClick=${() => choose(i)}>
            <span class="km-letter" aria-hidden="true">${LETTERS[i]}</span><span>${o}</span>
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
              class=${`km-num ${sel === n ? 'sel' : ''}`} onClick=${() => choose(n)}>${n}</button>`,
          )}
        </div>
        <div class="km-scale-labels"><span>${q.low}</span><span>${q.high}</span></div>
      </div>
      <button class="btn btn-primary km-lock" disabled=${sel == null} onClick=${() => lock(sel)}>
        ${sel == null ? 'Pick a number' : `Lock in ${sel}/${SCALE_MAX}`}
      </button>
    </div>`;
  }
  // The box unmounts once the answer is locked in, so it keeps the text until then: a submit the
  // authority never got (or rejected) doesn't eat what was typed. The Picker's key empties it for
  // a new question.
  return html`<div class="km-picker km-open">
    <${AnswerBox} placeholder=${iAmSubject ? 'Your honest answer' : subjectName.length <= 12 ? `${subjectName} would say` : 'Your guess'} maxLength=${MAX_ANSWER}
      clearOnSubmit=${false} onSubmit=${(v) => lock(v)} />
  </div>`;
}

/**
 * One side of the reveal: a paper card that turns over. `who` is the partner's name (null = mine
 * → "Your answer"). The label wraps on a narrow card ("Christopher’s / answer") instead of being
 * cut, so a long name and the "answer" / "guess" part are always readable.
 */
function FlipCard({ player, who, role, value, delay = 0 }) {
  const long = String(value).length > 16;
  return html`<div class="km-flip" style=${`--d:${delay}ms`}>
    <div class="km-flip-inner">
      <div class="km-face km-front">
        <span class="km-face-label">
          <${Avatar} player=${player} size="sm" />
          <span class="km-face-who">${who ? `${who}’s ${role}` : `Your ${role}`}</span>
        </span>
        <b class=${`km-face-value ${long ? 'long' : ''}`}>${value}</b>
      </div>
      <div class="km-face km-back" aria-hidden="true"></div>
    </div>
  </div>`;
}

/** Both positions on the 1–10 line: the real answer above, the guess below. */
function ScaleTrack({ q, api, subjectId, guesserId, real, guess }) {
  const pos = (v) => `${((v - 1) / (SCALE_MAX - 1)) * 100}%`;
  return html`<div class="km-track-wrap" role="img" aria-label=${`Answer ${real}, guess ${guess}, on a scale from ${q.low} to ${q.high}`}>
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
  const note = (g) =>
    t[g]?.close ? `+ ${t[g].close} close call${t[g].close > 1 ? 's' : ''}` : t[g]?.total && t[g]?.right === t[g]?.total ? 'Perfect' : ' ';
  return html`<div class="stack center km-final">
    <div class="result-banner win pop-in km-summary">
      <h2>${v.title}</h2>
      <p class="km-verdict">${v.line}</p>
      <div class="km-tally">
        ${(api.me.id === p2 ? [p2, p1] : [p1, p2]).map(
          (g) => html`<div class="km-tally-card" key=${g}>
            <div class="km-tally-who"><${Avatar} player=${api.player(g)} size="sm" /><span>${Name(g)} ${knows(g)} ${name(other(g))}</span></div>
            <b class="km-tally-score">${t[g]?.right ?? 0}<small>/${t[g]?.total ?? 0}</small></b>
            <small class="km-tally-note">${note(g)}</small>
          </div>`,
        )}
      </div>
      <p class="km-best">${best ? `${Name(best)} ${knows(best)} ${name(other(best))} best this time` : 'Dead even, perfectly matched'}</p>
      <p class="km-gained"><b>+${s.gained}</b> together points</p>
      <${Postmark} me=${api.me} partner=${api.partner} at=${s.at ?? undefined} />
    </div>
    <${ResultActions} api=${api} onAgain=${() => api.act({ type: 'again' })} againLabel="Play again" />
    <details class="chain km-log" open>
      <summary><${Icon} name="chevron-right" size=${16} />Round by round</summary>
      <ol>
        ${s.log.map(
          (r, i) => html`<li key=${i} class=${r.score === 2 ? 'hit' : r.score === 1 ? 'close' : 'miss'}>
            <span class="km-mark"><${Icon} name=${r.score === 2 ? 'check' : r.score === 1 ? 'equal-approximately' : 'x'} size=${16}
              label=${r.score === 2 ? 'Guessed right' : r.score === 1 ? 'Close' : 'Missed'} /></span>
            <div>
              <small class="km-log-q">About ${name(r.subject)} · ${r.text}</small>
              <div class="km-log-a"><b>${r.answer}</b>${r.score !== 2 && html` <span class="km-log-said">· ${name(r.guesser)} said ${r.guess}</span>`}</div>
            </div>
          </li>`,
        )}
      </ol>
    </details>
  </div>`;
}
