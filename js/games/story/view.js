import { html, useState, useEffect, useRef } from '../../ui/h.js';
import { GameHeader, ResultActions, WaitingDots, Avatar, useOnChange } from '../../ui/components.js';
import { meta, MAX_LINE, MAX_TITLE, MAX_TWISTS, MIN_LINES, MAX_LINES, playerLines, storyText } from './logic.js';

const TYPING_TTL = 4000; // a "typing" ping keeps the indicator on this long
const PING_EVERY = 1500; // send at most one ping per this many ms
const CONJURE_TTL = 20000;
const ALT_COLORS = ['#6ec8ff', '#ffb86b'];
const hasWords = (t) => /[\p{L}\p{N}]/u.test(t || '');

const nameOf = (api, id) => api.player(id)?.name || 'Your partner';
const youOr = (api, id) => (id === api.meId ? 'You' : nameOf(api, id));

/** Each author's highlighter colour (their profile colour; nudged apart if both picked the same). */
function authorColors(api) {
  const [p0, p1] = api.players;
  const c0 = api.player(p0)?.color || '#ff7eb6';
  let c1 = api.player(p1)?.color || ALT_COLORS[0];
  if (c1.toLowerCase() === c0.toLowerCase()) c1 = c0.toLowerCase() === ALT_COLORS[0] ? ALT_COLORS[1] : ALT_COLORS[0];
  return { [p0]: c0, [p1]: c1 };
}

/** Partner's ephemeral pings (fx): returns the last payload for `ttl` ms, cleared when `resetKey` changes. */
function usePartnerPing(api, kind, ttl, resetKey) {
  const [ping, setPing] = useState(null);
  useEffect(() => {
    let h = null;
    const off = api.fx.on(kind, (data) => {
      setPing(data && typeof data === 'object' ? data : {});
      clearTimeout(h);
      h = setTimeout(() => setPing(null), ttl);
    });
    return () => {
      off();
      clearTimeout(h);
    };
  }, []);
  useEffect(() => setPing(null), [resetKey]);
  return ping;
}

/** Throttled sender for "I'm typing" pings. Never sends the draft itself. */
function usePinger(api, kind) {
  const last = useRef(0);
  return () => {
    const t = Date.now();
    if (t - last.current < PING_EVERY) return;
    last.current = t;
    api.fx.send(kind, {});
  };
}

function formatDate(ms) {
  try {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ the book page

function Book({ s, api, ghostBy, final, pageRef, mode = '' }) {
  const own = useRef(null);
  const ref = pageRef || own;
  const colors = authorColors(api);
  const n = s.lines.length;
  // Lines already on the page when the book opened don't animate; only fresh ink does.
  const seenAtMount = useRef(n);
  // Keep the newest line in view: scroll down on new ink, and stay pinned to the bottom while the
  // page resizes (turn changes, keyboard) unless the reader scrolled up to re-read something.
  const scrolled = useRef(false);
  const pinned = useRef(true);
  const autoAt = useRef(0);
  const toBottom = (smooth) => {
    const el = ref.current;
    if (!el) return;
    autoAt.current = Date.now();
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };
  useEffect(() => {
    if (final) return;
    pinned.current = true;
    toBottom(scrolled.current);
    scrolled.current = true;
  }, [n, !!ghostBy, s.phase]);
  useEffect(() => {
    const el = ref.current;
    if (!el || final || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => pinned.current && toBottom(false));
    ro.observe(el);
    return () => ro.disconnect();
  }, [final]);
  const onScroll = (e) => {
    if (Date.now() - autoAt.current < 700) return; // our own smooth scroll
    const el = e.currentTarget;
    pinned.current = el.scrollHeight - el.clientHeight - el.scrollTop < 40;
  };

  const isNew = (i) => !final && i === n - 1 && i >= seenAtMount.current;
  const label = (id) => (final ? nameOf(api, id) : youOr(api, id));

  // Group lines into paragraphs; a twist always stands on its own.
  const blocks = [];
  let para = null;
  s.lines.forEach((l, i) => {
    if (l.twist) {
      para = null;
      blocks.push({ twist: l, i });
      return;
    }
    if (!para || para.items.length >= 4) {
      para = { items: [], i };
      blocks.push(para);
    }
    para.items.push({ l, i });
  });
  const ghost =
    ghostBy &&
    html`<span class="sc-ghost" key="ghost" style=${`--hl:${colors[ghostBy]}`} aria-hidden="true">
      <span class="sc-quill">✒️</span><i>.</i><i>.</i><i>.</i></span>`;
  const lastIsPara = blocks.length && !blocks[blocks.length - 1].twist;

  return html`<article class=${`sc-book ${final ? 'final' : mode}`} aria-label=${final ? 'Your finished story' : 'Your story so far'}>
    <div class="sc-page" ref=${ref} onScroll=${final ? undefined : onScroll}>
      <header class="sc-head">
        ${final ? html`<div class="sc-orn" aria-hidden="true">✦ ✦ ✦</div>` : html`<div class="sc-kicker">Story no. ${s.story}</div>`}
        <h3 class="sc-title">${final ? s.book.title : s.title}</h3>
        ${final && html`<p class="sc-byline">by ${api.players.map((id) => nameOf(api, id)).join(' & ')} · ${formatDate(s.book.at)}</p>`}
        <div class="sc-legend">
          ${api.players.map(
            (id) => html`<span class="sc-who" key=${id} style=${`--hl:${colors[id]}`}><i aria-hidden="true"></i>${label(id)}</span>`,
          )}
        </div>
      </header>
      <p class="sc-opening">${s.opening}</p>
      ${blocks.map((b, bi) =>
        b.twist
          ? html`<div key=${`t${b.i}`} class=${`sc-twist ${isNew(b.i) ? 'sc-new' : ''}`} role="note">
              <span class="sc-twist-tag">✨ Plot twist</span>
              <p>${b.twist.text}</p>
              <small>summoned by ${label(b.twist.by)}</small>
            </div>`
          : html`<p key=${`p${b.i}`} class="sc-para">
              ${b.items.map(
                ({ l, i }) => html`<span key=${i} class=${`sc-line ${isNew(i) ? 'sc-new' : ''}`} style=${`--hl:${colors[l.by] || '#b69cff'}`}
                  title=${`${nameOf(api, l.by)} wrote this`}>${l.text}</span>${' '}`,
              )}
              ${bi === blocks.length - 1 && ghost}
            </p>`,
      )}
      ${ghost && !lastIsPara && html`<p class="sc-para" key="ghost-p">${ghost}</p>`}
      ${!final && n === 0 && !ghost && html`<p class="sc-empty" aria-hidden="true">…and then?</p>`}
      ${final &&
      html`<p class="sc-epilogue">${s.book.epilogue}</p>
        <p class="sc-fin">The End</p>`}
    </div>
  </article>`;
}

// ------------------------------------------------------------------ writing

/** What the waiting player sees: whose turn it is, live "is writing…" while they type. */
function TurnBanner({ s, api, typing }) {
  const p = api.player(s.turn);
  const color = authorColors(api)[s.turn];
  return html`<div class=${`sc-turn ${typing ? 'typing' : ''}`} style=${`--pc:${color}`} aria-live="polite">
    <${Avatar} player=${p} size="sm" />
    ${typing
      ? html`<span class="sc-typing"><b>${nameOf(api, s.turn)}</b> is writing<i>.</i><i>.</i><i>.</i></span>`
      : html`<span>Waiting for <b>${nameOf(api, s.turn)}</b> to write…</span>`}
  </div>`;
}

// Unsent drafts survive the composer unmounting (e.g. your partner taps "The End" mid-sentence
// and then "Keep writing"). Local to this device, never sent anywhere.
const drafts = new Map();

function Composer({ s, api }) {
  const draftKey = `${s.story}:${s.title}`;
  const [text, setTextState] = useState(() => drafts.get(draftKey) || '');
  const setText = (v) => {
    setTextState(v);
    if (v) drafts.set(draftKey, v);
    else drafts.delete(draftKey);
  };
  const ref = useRef(null);
  const ping = usePinger(api, 'typing');
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const first = s.lines.length === 0;
  const send = (e) => {
    e?.preventDefault();
    const v = text.trim();
    if (!hasWords(v)) return;
    api.act({ type: 'line', text: v });
    api.effects.sound('tap');
    setText('');
  };
  const left = MAX_LINE - text.length;
  const color = authorColors(api)[api.meId];
  return html`<form class="sc-compose" onSubmit=${send} style=${`--pc:${color}`}>
    <div class="sc-compose-label" aria-live="polite"><i aria-hidden="true">✍️</i><span><b>Your turn</b> — what happens next?</span></div>
    <textarea class="input" ref=${ref} rows="2" maxLength=${MAX_LINE} value=${text} aria-label="Your next line"
      enterkeyhint="send" placeholder=${first ? 'Start us off — what happens next?' : 'Add the next sentence (or two)…'}
      onInput=${(e) => {
        setText(e.currentTarget.value);
        ping();
      }}
      onKeyDown=${(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) send(e);
      }}></textarea>
    <div class="sc-compose-foot">
      <small class=${`sc-left ${left <= 20 ? 'near' : ''}`} aria-live="polite">${left <= 40 ? `${left} characters left` : 'One or two sentences'}</small>
      <button class="btn btn-primary" type="submit" disabled=${!hasWords(text)}>Add my line ✍️</button>
    </div>
  </form>`;
}

function Tools({ s, api, busy, conjuring, onTwist }) {
  const n = playerLines(s.lines);
  const last = s.lines[s.lines.length - 1];
  const left = MAX_TWISTS - s.twists;
  const blocked = left <= 0 ? 'all used up' : !last ? 'after the first line' : last.twist ? 'write a line first' : '';
  const partnerTwisting = conjuring?.what === 'twist';
  const twistNote =
    busy === 'twist' ? 'summoning…' : partnerTwisting ? `${api.partner?.name || 'Partner'} is summoning…` : blocked || 'shake things up';
  const canEnd = n >= MIN_LINES;
  const room = MAX_LINES - n;
  const endNote = !canEnd
    ? `unlocks in ${MIN_LINES - n} line${MIN_LINES - n === 1 ? '' : 's'}`
    : room <= 4
      ? `only ${room} line${room === 1 ? '' : 's'} left!`
      : 'whenever it feels right';
  return html`<div class="sc-tools">
    <div class="sc-tool">
      <button class="btn sc-twist-btn" onClick=${onTwist} disabled=${!!blocked || !!busy || partnerTwisting}
        title="Let the narrator throw in a surprise">
        ✨ Twist! <span class="sc-badge" title=${`${left} left`}>${left}</span>
      </button>
      <small class=${`sc-note ${busy === 'twist' || partnerTwisting ? 'live' : ''}`} aria-live="polite">${twistNote}</small>
    </div>
    <div class="sc-tool">
      <button class=${`btn sc-end-btn ${canEnd ? 'ready' : ''}`} disabled=${!canEnd}
        onClick=${() => api.act({ type: 'end', ai: !!api.ai.enabled })}>📕 The End</button>
      <small class="sc-note">${endNote}</small>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ ending

function TitleForm({ s, api, head }) {
  const [val, setVal] = useState('');
  const ping = usePinger(api, 'naming');
  const naming = usePartnerPing(api, 'naming', TYPING_TTL, s.ending.at);
  const submit = (e) => {
    e.preventDefault();
    const t = val.trim();
    if (!hasWords(t)) return;
    api.act({ type: 'finish', title: t });
    api.effects.sound('lock');
  };
  return html`<form class="card stack sc-title-form pop-in" onSubmit=${submit}>
    ${head}
    <div class="sc-title-row">
      <input class="input" value=${val} maxLength=${MAX_TITLE} placeholder=${s.title} enterkeyhint="done" autocomplete="off"
        aria-label="Story title" onInput=${(e) => {
          setVal(e.currentTarget.value);
          ping();
        }} />
      <button class="btn btn-primary" type="submit" disabled=${!hasWords(val)}>Bind it 📕</button>
    </div>
    <div class="sc-suggest" role="group" aria-label="Suggested titles">
      ${s.ending.suggest.map(
        (t) => html`<button type="button" key=${t} class=${`sc-sugg ${val === t ? 'sel' : ''}`} aria-pressed=${val === t}
          onClick=${() => {
            setVal(t);
            ping();
            api.effects.sound('tap');
          }}>${t}</button>`,
      )}
    </div>
    <p class="muted small sc-naming" aria-live="polite">
      ${naming ? html`✍️ <b>${api.partner?.name || 'Your partner'}</b> is typing a title too…` : 'Either of you can bind it — first one wins.'}
    </p>
  </form>`;
}

function Ending({ s, api }) {
  const e = s.ending;
  const full = playerLines(s.lines) >= MAX_LINES;
  const head = html`<div class="sc-ending-head">
    <span class="sc-ending-emoji" aria-hidden="true">📕</span>
    <div><b>${e.auto ? `The book is full — ${MAX_LINES} lines!` : `${youOr(api, e.by)} wrote “The End”`}</b>
      <small>${e.narrator === 'pending' ? 'Now for the final touch…' : 'Every story deserves a title — or pick one:'}</small></div>
  </div>`;
  return html`<div class="stack sc-ending">
    ${e.narrator === 'pending'
      ? html`<div class="card glow stack center sc-narrator pop-in">
          ${head}
          <div class="sc-narrator-icon" aria-hidden="true">🪶</div>
          <${WaitingDots} text=${e.by === api.meId ? 'The narrator is writing your ending' : `${nameOf(api, e.by)} asked the narrator for an ending`} />
          <button class="btn btn-ghost btn-sm" onClick=${() => api.act({ type: 'manual' })}>We’ll name it ourselves</button>
        </div>`
      : html`<${TitleForm} s=${s} api=${api} head=${head} key=${e.at} />`}
    ${!full && html`<button class="btn btn-ghost btn-sm sc-resume" onClick=${() => api.act({ type: 'resume' })}>← Keep writing</button>`}
  </div>`;
}

// ------------------------------------------------------------------ keepsake

function Keepsake({ s, api, busy, conjuring, onAgain }) {
  const pageRef = useRef(null);
  const n = playerLines(s.lines);
  const copy = async () => {
    const text = storyText(s, Object.fromEntries(api.players.map((id) => [id, nameOf(api, id)])));
    try {
      await navigator.clipboard.writeText(text);
      api.effects.toast('Story copied — keep it somewhere safe 💌');
    } catch {
      // No clipboard permission (or not a secure context): select the page so they can copy it.
      let ok = false;
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(pageRef.current);
        sel.removeAllRanges();
        sel.addRange(range);
        ok = document.execCommand('copy');
      } catch {
        /* selection is the best we can do */
      }
      api.effects.toast(ok ? 'Story copied 💌' : 'Story selected — tap Copy to keep it');
    }
    api.effects.sound('pop');
  };
  const partnerBusy = conjuring?.what === 'again';
  return html`<div class="stack sc-final">
    <div class="result-banner win pop-in sc-result">
      <h2>Bound & saved 📕</h2>
      <p>${n} lines · ${s.twists} twist${s.twists === 1 ? '' : 's'} · <b>+${s.gained}</b> together points</p>
      <button class="btn btn-sm sc-copy" onClick=${copy}>📋 Copy story</button>
    </div>
    <${Book} s=${s} api=${api} final=${true} pageRef=${pageRef} />
    ${(busy === 'again' || partnerBusy) &&
    html`<p class="muted small center sc-hint"><${WaitingDots} text=${busy ? 'Conjuring a fresh opening' : `${api.partner?.name || 'Your partner'} is conjuring a fresh opening`} /></p>`}
    <${ResultActions} api=${api} onAgain=${busy || partnerBusy ? null : onAgain} againLabel="✍️ Write another" />
  </div>`;
}

// ------------------------------------------------------------------ main

export default function StoryView({ s, api }) {
  const [busy, setBusy] = useState(null); // 'twist' | 'again' while an AI call is in flight
  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);
  const n = playerLines(s.lines);
  const last = s.lines[s.lines.length - 1];
  const typing = usePartnerPing(api, 'typing', TYPING_TTL, `${s.story}:${s.lines.length}:${s.phase}`);
  const conjuring = usePartnerPing(api, 'conjuring', CONJURE_TTL, `${s.story}:${s.twists}:${s.phase}`);
  const myTurn = s.turn === api.meId;
  const partnerWriting = s.phase === 'writing' && !myTurn && !!typing;

  // Little moments.
  useOnChange(s.lines.length, () => {
    if (!last) return;
    if (last.twist) {
      api.effects.sound('whoosh');
      api.effects.floatEmoji('✨', { count: 3 });
    } else if (last.by !== api.meId) api.effects.sound('pop');
  });
  useOnChange(s.phase === 'ending' ? s.ending.at : 0, () => api.effects.sound('reveal'));
  useOnChange(s.phase === 'final' ? s.plays : 0, () => {
    api.effects.confetti({ emojis: ['📖', '✨', '💖', '🪶', '⭐', '💫'] });
    api.effects.sound('success');
  });

  // Whoever wrote "The End" asks the narrator (AI) for a title + epilogue. If that fails (or AI
  // is off on this device), both of you get the title form instead.
  useEffect(() => {
    const e = s.ending;
    if (s.phase !== 'ending' || !e || e.narrator !== 'pending' || e.by !== api.meId) return undefined;
    if (!api.ai.enabled) {
      api.act({ type: 'manual' });
      return undefined;
    }
    let live = true;
    api.ai
      .generate('story_end', { story: storyText(s).slice(-2000) })
      .then((r) => {
        if (!live) return;
        api.act({ type: 'finish', title: typeof r?.title === 'string' ? r.title : '', epilogue: typeof r?.epilogue === 'string' ? r.epilogue : '' });
      })
      .catch(() => live && api.act({ type: 'manual' }));
    return () => {
      live = false;
    };
  }, [s.phase, s.ending?.at, s.ending?.narrator]);

  const twist = async () => {
    if (busy) return;
    const at = s.lines.length;
    if (!api.ai.enabled) {
      api.act({ type: 'twist', at });
      return;
    }
    setBusy('twist');
    api.fx.send('conjuring', { what: 'twist' });
    let text = '';
    try {
      const r = await api.ai.generate('story_twist', { story: storyText(s).slice(-2000) });
      text = typeof r?.twist === 'string' ? r.twist : '';
    } catch {
      /* fall back to the built-in twists (the reducer picks one) */
    }
    if (!alive.current) return;
    api.act(text ? { type: 'twist', at, text } : { type: 'twist', at });
    setBusy(null);
  };

  const again = async () => {
    if (busy) return;
    if (!api.ai.enabled) {
      api.act({ type: 'again' });
      return;
    }
    setBusy('again');
    api.fx.send('conjuring', { what: 'again' });
    let content = null;
    try {
      content = await api.ai.generate('story_start', { avoid: [s.title, s.opening.slice(0, 200)] });
    } catch {
      /* built-in opening instead */
    }
    if (!alive.current) return;
    api.act(content ? { type: 'again', content } : { type: 'again' });
    setBusy(null);
  };

  return html`<section class="game story">
    <${GameHeader} meta=${meta} api=${api}>
      ${s.phase !== 'final' && html`<span class="chip sc-chip" title="Lines written">✍️ ${n}/${MAX_LINES}</span>`}
    </${GameHeader}>

    ${s.phase === 'final'
      ? html`<${Keepsake} s=${s} api=${api} busy=${busy} conjuring=${conjuring} onAgain=${again} key=${`final${s.story}`} />`
      : html`<${Book} s=${s} api=${api} ghostBy=${partnerWriting ? s.turn : null} key=${`book${s.story}`}
            mode=${s.phase === 'ending' ? 'ending' : myTurn ? 'writer' : 'waiter'} />
          ${s.phase === 'writing'
            ? html`${myTurn
                  ? html`<${Composer} s=${s} api=${api} key=${`c${s.story}`} />`
                  : html`<${TurnBanner} s=${s} api=${api} typing=${partnerWriting} />`}
                <${Tools} s=${s} api=${api} busy=${busy} conjuring=${conjuring} onTwist=${twist} />`
            : html`<${Ending} s=${s} api=${api} />`}`}
  </section>`;
}
