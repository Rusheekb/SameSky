// Shared UI building blocks for game views. Games should use these so every screen feels the same.
import { html, useEffect, useState, useRef } from './h.js';
import { Icon } from './icons.js';
import { iconFor } from '../games/index.js';

export { Icon };

const safeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#f2b35c');

/** "9:40 pm" in a time zone (lower-case, the postmark style). */
export function clockIn(tz, at = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined })
      .format(new Date(at))
      .toLowerCase()
      .replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

/**
 * Same Sky's signature: both local times written like a postmark, "9:40 pm here · 11:40 am there".
 * Use it in the top bar and on results/keepsakes (pass `at` to stamp a moment in the past).
 */
export function postmarkText(me, partner, at) {
  const here = clockIn(me?.tz, at);
  if (!here) return '';
  const differs = partner?.tz && partner.tz !== me?.tz;
  return differs ? `${here} here · ${clockIn(partner.tz, at)} there` : `${here} for you both`;
}

/** `prefix` reads like a stamp: "Written 9:40 pm here · 11:40 am there". Pass class="on-paper" on paper. */
export function Postmark({ me, partner, at, prefix = '', class: cls = '' }) {
  const text = postmarkText(me, partner, at);
  if (!text) return null;
  return html`<span class=${`postmark ${cls}`}>${prefix ? `${prefix} ${text}` : text}</span>`;
}

export function Avatar({ player, size = 'md', online }) {
  if (!player) return html`<span class="avatar avatar-${size} avatar-empty">?</span>`;
  return html`<span class="avatar avatar-${size}" style=${`--pc:${safeColor(player.color)}`} title=${player.name}>
    ${player.avatar}${online !== undefined && html`<i class=${`dot ${online ? 'on' : 'off'}`}></i>`}
  </span>`;
}

/** Title bar inside a game: line icon + title + optional round info + leave button. */
export function GameHeader({ meta, round, total, api, children }) {
  return html`<div class="game-header">
    <div class="game-title"><span class="game-icon"><${Icon} name=${iconFor(meta.id)} /></span>${meta.title}</div>
    <div class="game-meta">
      ${round != null && html`<span class="chip"><span class="hide-narrow">Round </span>${round}${total ? ` / ${total}` : ''}</span>`}
      ${children}
      <button class=${`btn btn-ghost btn-sm ${api.leaveArmed ? 'armed' : 'btn-icon'}`} onClick=${() => api.confirmEnd()}
        aria-label=${api.leaveArmed ? 'Tap again to leave this game' : 'Leave this game'}>${api.leaveArmed ? 'Leave' : html`<${Icon} name="x" />`}</button>
    </div>
  </div>`;
}

/** "You ✓  ·  Maya … thinking" status row for simultaneous-answer phases. */
export function LockStatus({ api, locked, labels = {} }) {
  const done = labels.done || 'locked in';
  const waiting = labels.waiting || 'thinking…';
  return html`<div class="lock-status">
    ${[api.me, api.partner].map(
      (p) => p && html`<span class=${`lock ${locked[p.id] ? 'is-locked' : ''}`} key=${p.id}>
        <${Avatar} player=${p} size="sm" />
        <b>${p.id === api.me.id ? 'You' : p.name}</b>
        <span>${locked[p.id] ? html`<${Icon} name="check" size=${14} /> ${done}` : waiting}</span>
      </span>`,
    )}
  </div>`;
}

/** Seconds left until `endsAt` (authority clock). Re-renders itself 4×/s. */
export function useCountdown(api, endsAt) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!endsAt) return undefined;
    const h = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(h);
  }, [endsAt]);
  if (!endsAt) return null;
  return Math.max(0, Math.ceil((endsAt - api.now()) / 1000));
}

export function Timer({ api, endsAt, total }) {
  const secs = useCountdown(api, endsAt);
  if (secs == null) return null;
  const pct = total ? Math.max(0, Math.min(100, ((secs * 1000) / total) * 100)) : 100;
  return html`<div class=${`timer ${secs <= 10 ? 'urgent' : ''}`} role="timer" aria-label=${`${secs} seconds left`}>
    <span class="timer-bar" style=${`--p:${(pct / 100).toFixed(3)}`}></span><b>${secs}s</b>
  </div>`;
}

/** End-of-game buttons. */
export function ResultActions({ api, onAgain, againLabel = 'Play again' }) {
  return html`<div class="row center wrap gap">
    ${onAgain && html`<button class="btn btn-primary" onClick=${onAgain}>${againLabel}</button>`}
    <button class="btn" onClick=${() => api.end()}>Back to games</button>
  </div>`;
}

/**
 * Text input + submit. `clearOnSubmit={false}` keeps the text after sending: use it when the box
 * unmounts once the answer is accepted, so a rejected or lost submit never eats what was typed.
 * Give it a `key` tied to the question so a new question always starts empty.
 */
export function AnswerBox({ placeholder, button = 'Lock in', onSubmit, maxLength = 40, disabled, autoFocus = true, validate, clearOnSubmit = true }) {
  const [val, setVal] = useState('');
  const [err, setErr] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (autoFocus && !disabled) ref.current?.focus({ preventScroll: true });
  }, [disabled]);
  const submit = (e) => {
    e.preventDefault();
    const v = val.trim();
    if (!v) return;
    const problem = validate?.(v);
    if (problem) {
      setErr(problem);
      return;
    }
    setErr('');
    onSubmit(v);
    if (clearOnSubmit) setVal('');
  };
  return html`<form class="answer-box" onSubmit=${submit}>
    <input class="input" ref=${ref} value=${val} maxLength=${maxLength} placeholder=${placeholder}
      disabled=${disabled} enterkeyhint="send" autocomplete="off" autocapitalize="off" spellcheck=${false}
      onInput=${(e) => {
        setVal(e.currentTarget.value);
        if (err) setErr('');
      }} />
    <button class="btn btn-primary" type="submit" disabled=${disabled || !val.trim()}>${button}</button>
    ${err && html`<p class="form-error" role="alert">${err}</p>`}
  </form>`;
}

export function WaitingDots({ text = 'Waiting' }) {
  return html`<span class="waiting">${text}<i>.</i><i>.</i><i>.</i></span>`;
}

/** Plays a callback once when `value` changes to something truthy (e.g. confetti on a new result). */
export function useOnChange(value, fn) {
  const prev = useRef(value);
  useEffect(() => {
    if (value !== prev.current) {
      prev.current = value;
      if (value) fn(value);
    }
  }, [value]);
}
