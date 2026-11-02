// Room screen: owns the Session, renders the top bar, invite, lobby, active game, reactions,
// settings and the night recap.
import { html, useEffect, useMemo, useRef, useState, Component } from './h.js';
import { Session } from '../core/session.js';
import { playerIds, VIBES } from '../core/state.js';
import { chooseTransportKind, createTransport, hasSupabase } from '../net/transport.js';
import { storage } from '../lib/storage.js';
import { formatCode } from '../lib/util.js';
import { aiConfigured, aiGenerate, getPasscode, setPasscode, AiError } from '../lib/ai.js';
import { play, isMuted, setMuted } from '../lib/sound.js';
import { confetti, floatEmoji, heartPulse, toast, hideToast } from './fx.js';
import { GAMES, GAME_LIST, loadView, iconFor } from '../games/index.js';
import { Avatar, Icon, Postmark, clockIn } from './components.js';
import { NightScene, MoonMark } from './scene.js';
import { rememberRoom, AVATARS, COLORS } from './profile.js';

const REACTIONS = ['❤️', '😘', '😂', '🥺', '🔥', '👏'];
const VIBE_LABELS = { sweet: 'Sweet', flirty: 'Flirty', silly: 'Silly', deep: 'Deep' };

function useSession(code, profile, config) {
  const [session, setSession] = useState(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    let s = null;
    let cancelled = false;
    (async () => {
      const kind = chooseTransportKind(config);
      const transport = await createTransport(kind, { room: code, config, clientId: profile.id });
      if (cancelled) return;
      const creator = !!storage.get(`creator:${code}`);
      s = new Session({ room: code, me: profile, transport, games: GAMES, storage, creator });
      s.subscribe(() => setTick((n) => n + 1));
      setSession(s);
      await s.start();
      storage.remove(`creator:${code}`);
    })().catch((err) => {
      console.error(err);
      toast(`Could not connect: ${err.message}`);
    });
    const bye = () => s?.stop();
    // Coming back from the back/forward cache: the session was stopped on pagehide, so reload.
    const show = (e) => e.persisted && location.reload();
    // Phones suspend background tabs; say hello as soon as we're visible again.
    const wake = () => document.visibilityState === 'visible' && s?.poke();
    addEventListener('pagehide', bye);
    addEventListener('pageshow', show);
    document.addEventListener('visibilitychange', wake);
    return () => {
      cancelled = true;
      removeEventListener('pagehide', bye);
      removeEventListener('pageshow', show);
      document.removeEventListener('visibilitychange', wake);
      s?.stop();
    };
  }, [code]);
  return session;
}

/** True once the transport has failed to come online for `ms` (so we can offer another route). */
function useSlowConnection(session, ms = 12000) {
  const [slow, setSlow] = useState(false);
  const online = session?.status === 'online';
  useEffect(() => {
    if (!session || online) {
      setSlow(false);
      return undefined;
    }
    const h = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(h);
  }, [session, online]);
  return slow;
}

function switchTransport(kind) {
  const u = new URL(location.href);
  u.searchParams.set('net', kind);
  location.href = u.toString();
}

function ConnectionHelp({ session, config }) {
  const kind = session.transport.kind;
  const alt = kind === 'supabase' ? 'peer' : kind === 'peer' && hasSupabase(config) ? 'supabase' : null;
  return html`<div class="away-banner conn-help" role="status">
    <p>Can't reach the ${session.transport.label} connection${session.statusDetail ? ` (${session.statusDetail})` : ''}.</p>
    ${alt &&
    html`<p><button class="btn btn-sm" onClick=${() => switchTransport(alt)}>
        Try ${alt === 'peer' ? 'a direct connection' : 'Supabase'} instead</button><br />
      <small>You both need to be on the same kind — send your partner the invite link again after switching.</small></p>`}
  </div>`;
}

export function Room({ code, profile, config, onProfileChange }) {
  const session = useSession(code, profile, config);
  const [panel, setPanel] = useState(null); // 'settings' | 'recap' | null
  const slow = useSlowConnection(session);

  // Push local profile edits into the room.
  useEffect(() => {
    if (session) session.updateProfile(profile);
  }, [session, profile.name, profile.avatar, profile.color]);

  // Global ephemeral events: reactions and "miss you" nudges.
  useEffect(() => {
    if (!session) return undefined;
    return session.onFx((kind, data, from) => {
      if (!session.state.players[from]) return; // ignore anyone who isn't one of the two of you
      const who = session.state.players[from].name;
      if (kind === 'react' && typeof data?.emoji === 'string' && REACTIONS.includes(data.emoji)) {
        floatEmoji(data.emoji, { count: 3, fromPartner: true });
        play('pop');
      } else if (kind === 'nudge') {
        heartPulse(`${who} is thinking of you`);
        play('heart');
      } else if (kind === 'loading') {
        toast(data?.text ? `${who}: ${String(data.text).slice(0, 80)}` : `${who} is setting up a game…`);
      } else if (kind === 'recap') {
        const poem = cleanPoem(data);
        if (!poem) return;
        storage.set(`recap:${code}`, poem);
        setPanel('recap');
      }
    });
  }, [session]);

  const st = session?.state;
  const partnerId = session?.partnerId();
  const partner = partnerId ? st.players[partnerId] : null;
  useEffect(() => {
    if (partner?.name) rememberRoom(code, partner.name);
    else rememberRoom(code);
  }, [partner?.name]);

  // When your partner closes a game, say so — and if it was finished, keep its results on your
  // screen (story keepsake, doodle gallery…) until you tap "Back to games" yourself.
  // Derived during render (not in an effect) so the partner never sees a one-frame lobby flash.
  const lastGame = useRef(null);
  const keptRef = useRef(null);
  const notice = useRef('');
  const [, rerender] = useState(0);
  if (st) {
    if (st.game) {
      lastGame.current = st.game;
      keptRef.current = null;
    } else if (lastGame.current) {
      const prev = lastGame.current;
      lastGame.current = null;
      const entry = st.history[st.history.length - 1];
      if (entry && entry.by && entry.by !== session.id) {
        notice.current = `${st.players[entry.by]?.name || 'Your partner'} went back to the games`;
        if (prev.s?.done) keptRef.current = prev;
      }
    }
  }
  const kept = keptRef.current;
  // Starting or leaving a game (or your partner arriving) is a new screen: start at the top.
  const view = !partner ? 'invite' : st?.game ? `game:${st.game.n}` : kept ? 'kept' : 'lobby';
  useEffect(() => {
    try {
      window.scrollTo(0, 0);
    } catch {
      /* ignore */
    }
  }, [view]);
  const setKept = (v) => {
    keptRef.current = v;
    rerender((n) => n + 1);
  };
  useEffect(() => {
    if (notice.current) {
      toast(notice.current);
      notice.current = '';
    }
  });

  if (!session) {
    return html`<main class="screen center stack"><div class="loader" role="status" aria-label="Opening your room"></div><p class="muted">Opening your room</p></main>`;
  }
  if (session.full && !st.players[session.id]) {
    return html`<main class="screen narrow center stack">
      <h2 class="display">This room is taken</h2>
      <p class="muted">Room ${formatCode(code)} already has two people in it. Ask for a fresh link, or create your own room.</p>
      <a class="btn btn-primary" href="#/">Back home</a>
    </main>`;
  }

  return html`<div class="room">
    <${TopBar} session=${session} code=${code} onSettings=${() => setPanel('settings')} />
    <main class="room-main">
      ${slow && html`<${ConnectionHelp} session=${session} config=${config} />`}
      ${!partner
        ? html`<${Invite} code=${code} session=${session} />`
        : st.game
          ? html`<${GameHost} session=${session} config=${config} key=${`${st.game.id}:${st.game.n}`} />`
          : kept
            ? html`<${GameHost} session=${session} config=${config} kept=${kept} onLeaveKept=${() => setKept(null)} key=${`kept:${kept.id}:${kept.n}`} />`
            : html`<${Boundary} label="the menu"><${Lobby} session=${session} config=${config} onRecap=${() => setPanel('recap')} /></${Boundary}>`}
    </main>
    ${partner && html`<${ReactionBar} session=${session} />`}
    ${panel === 'settings' &&
    html`<${Boundary} label="settings" onExit=${() => setPanel(null)}><${Settings} session=${session} config=${config} onClose=${() => setPanel(null)} onProfileChange=${onProfileChange} /></${Boundary}>`}
    ${panel === 'recap' && html`<${Boundary} label="the recap" onExit=${() => setPanel(null)}><${Recap} session=${session} config=${config} code=${code} onClose=${() => setPanel(null)} /></${Boundary}>`}
  </div>`;
}

function TopBar({ session, code, onSettings }) {
  const st = session.state;
  const partnerId = session.partnerId();
  const partner = partnerId ? st.players[partnerId] : null;
  const online = partner && session.isOnline(partnerId);
  const showBothTimes = partner?.tz && partner.tz !== session.me.tz;
  const statusText =
    session.status === 'online'
      ? online
        ? showBothTimes
          ? `${clockIn(session.me.tz)} here · ${clockIn(partner.tz)} there`
          : 'Connected'
        : partner
          ? `${partner.name} is away`
          : 'Waiting…'
      : session.status === 'error'
        ? 'Connection problem'
        : 'Connecting…';
  return html`<header class="topbar">
    <a class="brand-sm" href="#/" aria-label="Same Sky home"><${MoonMark} /></a>
    <div class="couple">
      <${Avatar} player=${session.me} size="sm" online=${true} />
      <span class="amp">&</span>
      <${Avatar} player=${partner} size="sm" online=${partner ? online : undefined} />
      <div class="couple-text">
        <b>${partner ? `${session.me.name} & ${partner.name}` : session.me.name}</b>
        <small class=${`status status-${session.status} ${online ? 'ok' : ''}`} title=${session.statusDetail || session.transport.label}>
          ${statusText}
        </small>
      </div>
    </div>
    <button class="btn btn-ghost btn-sm code-btn" onClick=${() => copyInvite(code)} title="Copy invite link">
      ${formatCode(code)}
    </button>
    <button class="btn btn-ghost btn-sm btn-icon" onClick=${onSettings} aria-label="Settings"><${Icon} name="settings" /></button>
  </header>`;
}

export function inviteLink(code) {
  const u = new URL(location.href);
  u.hash = `#/r/${code}`;
  // Keep only the transport override (useful for testing); drop the per-tab profile slot.
  const net = u.searchParams.get('net');
  u.search = net ? `?net=${net}` : '';
  return u.toString();
}

async function copyInvite(code) {
  const link = inviteLink(code);
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied');
  } catch {
    prompt('Copy this link and send it to your person:', link);
  }
}

function Invite({ code, session }) {
  const link = inviteLink(code);
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Same Sky', text: `Come play with me tonight. Room ${formatCode(code)}`, url: link });
        return;
      } catch {
        /* cancelled */
      }
    }
    copyInvite(code);
  };
  return html`<section class="narrow stack invite">
    <div class="hero"><${NightScene} label="Your window is lit. Theirs is still dark across the water" /></div>
    <div class="invite-body">
      <div>
        <h2 class="display invite-title">Waiting for your person</h2>
        <p class="muted">Send them this link. As soon as they open it, you’ll both be in the room.</p>
      </div>
      <div class="card stack">
        <div class="row between wrap gap">
          <span class="section-label">Room code</span>
          <span class="invite-code">${formatCode(code)}</span>
        </div>
        <input class="input mono" readOnly value=${link} onFocus=${(e) => e.currentTarget.select()} aria-label="Invite link" />
        <button class="btn btn-primary btn-lg" onClick=${share}><${Icon} name="send" />Share invite link</button>
      </div>
      <p class="faint small">Connection: ${session.transport.label}${session.statusDetail ? `, ${session.statusDetail.replace(/…$/, '').toLowerCase()}` : ''}</p>
    </div>
  </section>`;
}

function Lobby({ session, config, onRecap }) {
  const st = session.state;
  const [busy, setBusy] = useState(null);
  const aiReady = aiConfigured(config);
  const useAi = aiReady && st.settings.ai;
  const partnerId = session.partnerId();
  const partner = partnerId ? st.players[partnerId] : null;

  // Download every game's screen while you browse, so starting one works even on patchy data.
  useEffect(() => {
    const h = setTimeout(() => GAME_LIST.forEach((m) => loadView(m.meta.id).catch(() => {})), 800);
    return () => clearTimeout(h);
  }, []);

  const start = async (mod) => {
    if (busy) return;
    let opts = {};
    if (useAi && mod.meta.ai?.task) {
      setBusy(mod.meta.id);
      session.sendFx('loading', { text: `writing ${mod.meta.ai.label || 'something new'} for ${mod.meta.title}…` });
      try {
        const names = playerIds(st).map((id) => st.players[id].name);
        const content = await aiGenerate(config, mod.meta.ai.task, {
          vibe: st.settings.vibe,
          aboutUs: st.settings.aboutUs,
          names,
          avoid: recentlyUsed(st, mod.meta.id),
        });
        opts = { content };
      } catch (err) {
        if (err instanceof AiError && err.code === 'passcode') toast('AI passcode needed, add it in Settings. Using the built-in cards.');
        else toast(`AI unavailable (${err.message}). Using the built-in cards.`);
      } finally {
        setBusy(null);
      }
    }
    play('whoosh');
    session.dispatch({ type: 'startGame', id: mod.meta.id, opts });
  };

  return html`<section class="lobby">
    <div class="lobby-hero">
      <div>
        <h2>Pick a game</h2>
        <p>${st.scores.games ? `Either of you can choose. ${st.scores.games} played tonight` : 'Either of you can choose. In Sync is a good first one'}</p>
      </div>
      <button class="score-pill" onClick=${onRecap} title="Our night so far" aria-label=${`${st.scores.together} together points, open our night so far`}>
        <b class=${st.scores.together ? '' : 'is-zero'}>${st.scores.together}</b><small>together points</small>
      </button>
    </div>

    <div class="lobby-controls">
      <div class="vibe-row" role="radiogroup" aria-label="Tonight's vibe">
        ${VIBES.map(
          (v) => html`<button key=${v} role="radio" aria-checked=${st.settings.vibe === v}
            class=${`chip chip-btn ${st.settings.vibe === v ? 'sel' : ''}`}
            onClick=${() => session.dispatch({ type: 'settings', patch: { vibe: v } })}>${VIBE_LABELS[v]}</button>`,
        )}
      </div>
      ${aiReady &&
      html`<button class=${`chip chip-btn ai-chip ${st.settings.ai ? 'sel' : ''}`} role="switch" aria-checked=${st.settings.ai}
        onClick=${() => session.dispatch({ type: 'settings', patch: { ai: !st.settings.ai } })}
        title="Let Claude write fresh prompts for the two of you"><${Icon} name="wand" size=${16} />AI ${st.settings.ai ? 'on' : 'off'}</button>`}
    </div>

    <div class="game-grid">
      ${GAME_LIST.map(
        (mod) => html`<button class="game-card" key=${mod.meta.id} onClick=${() => start(mod)} disabled=${!!busy}
          data-game=${mod.meta.id}>
          <span class="game-card-icon">${busy === mod.meta.id ? html`<span class="loader"></span>` : html`<${Icon} name=${iconFor(mod.meta.id)} />`}</span>
          <b>${mod.meta.title}</b>
          <small>${busy === mod.meta.id ? 'Writing prompts' : String(mod.meta.tagline || '').replace(/\.$/, '')}</small>
        </button>`,
      )}
    </div>
    ${st.history.length > 0 &&
    html`<div class="lobby-footer"><button class="btn btn-ghost" onClick=${onRecap}><${Icon} name="history" />Our night so far</button></div>`}
  </section>`;
}

function recentlyUsed(st, id) {
  return st.history
    .filter((h) => h.id === id)
    .flatMap((h) => h.highlights || [])
    .slice(-10);
}

/** Catches render errors so one broken piece never freezes the whole app. */
class Boundary extends Component {
  constructor() {
    super();
    this.state = { error: null };
  }
  componentDidCatch(error) {
    console.error(error);
    this.setState({ error });
  }
  render() {
    if (this.state.error) {
      const exit = this.props.onExit;
      return html`<div class="card stack center"><h3>Something went wrong in ${this.props.label || 'this screen'}</h3>
        <p class="muted small">${String(this.state.error.message || this.state.error)}</p>
        <div class="row gap center wrap">
          ${exit && html`<button class="btn" onClick=${() => { this.setState({ error: null }); exit(); }}>${this.props.exitLabel || 'Close'}</button>`}
          <button class="btn btn-ghost" onClick=${() => location.reload()}>Reload</button>
        </div></div>`;
    }
    return this.props.children;
  }
}

/** Only accept a recap poem that has the right shape (it can arrive from the network or storage). */
function cleanPoem(data) {
  if (!data || typeof data !== 'object' || typeof data.poem !== 'string' || !data.poem.trim()) return null;
  return {
    title: typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 80) : 'Our night',
    poem: data.poem.slice(0, 1200),
  };
}

/** Two-tap confirm that works even where native dialogs are blocked (in-app browsers). */
function useTwoTap(ms = 3000) {
  const [armed, setArmed] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    armed,
    (onConfirm, hint) => {
      if (armed) {
        clearTimeout(timer.current);
        setArmed(false);
        onConfirm();
        return;
      }
      setArmed(true);
      if (hint) toast(hint);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setArmed(false), ms);
    },
  ];
}

function GameHost({ session, config, kept = null, onLeaveKept }) {
  const st = session.state;
  const game = kept || st.game;
  const [View, setView] = useState(null);
  const [err, setErr] = useState(null);
  const [armed, twoTap] = useTwoTap();
  useEffect(() => {
    loadView(game.id).then((v) => setView(() => v), setErr);
  }, [game.id]);

  // Game-scoped fx channel with a stable identity for the lifetime of this game instance.
  const fx = useMemo(() => {
    const prefix = `g:${game.id}:${game.n}:`;
    return {
      send: (kind, data) => session.sendFx(prefix + kind, data),
      on: (kind, cb) =>
        session.onFx((k, data, from) => {
          if (k === prefix + kind) cb(data, from);
        }),
    };
  }, [game.id, game.n]);

  const end = kept
    ? () => onLeaveKept?.()
    : () => {
        hideToast(); // e.g. "Tap ✕ again to leave" shouldn't follow you into the lobby
        session.dispatch({ type: 'endGame' });
      };
  if (err) {
    // A failed module download is cached by the browser for this page, so only a reload retries it.
    return html`<div class="card stack center">
      <h3>Couldn't load this game</h3>
      <p class="muted small">Your connection may have hiccuped. ${String(err.message || err).slice(0, 120)}</p>
      <div class="row gap center wrap">
        <button class="btn btn-primary" onClick=${() => location.reload()}>Try again</button>
        <button class="btn" onClick=${end}>Back to games</button>
      </div>
    </div>`;
  }
  if (!View) return html`<div class="center"><div class="loader" role="status" aria-label="Loading the game"></div></div>`;

  const ids = playerIds(st).filter((id) => st.players[id]);
  const partnerId = session.partnerId();
  const mod = GAMES.get(game.id);
  if (!mod || ids.length < 2) return html`<div class="card center"><button class="btn" onClick=${end}>Back to games</button></div>`;
  const api = {
    meId: session.id,
    me: st.players[session.id] || session.me,
    partner: partnerId ? st.players[partnerId] : null,
    partnerOnline: partnerId ? session.isOnline(partnerId) : false,
    players: ids,
    player: (id) => st.players[id],
    names: Object.fromEntries(ids.map((id) => [id, st.players[id].name])),
    settings: st.settings,
    isAuthority: session.isAuthority(),
    now: () => session.now(),
    act: kept ? () => {} : (a) => session.dispatch({ type: 'game', a }),
    end,
    leaveArmed: armed,
    confirmEnd: () => {
      if (game.s?.done || kept) end();
      else twoTap(end, 'Tap Leave to confirm');
    },
    fx,
    ai: {
      enabled: aiConfigured(config) && st.settings.ai,
      generate: (task, params = {}) =>
        aiGenerate(config, task, {
          vibe: st.settings.vibe,
          aboutUs: st.settings.aboutUs,
          names: ids.map((id) => st.players[id].name),
          ...params,
        }),
    },
    effects: { confetti, floatEmoji, heartPulse, toast, sound: play },
  };
  return html`<${Boundary} label="this game" exitLabel="Back to games" onExit=${end}>
    ${kept && html`<div class="away-banner">${api.partner?.name || 'Your partner'} went back to the games — your results stay here until you leave.</div>`}
    ${!kept && !api.partnerOnline && html`<div class="away-banner">${api.partner?.name || 'Your partner'} dropped off — waiting for them to come back…</div>`}
    <${View} s=${game.s} api=${api} meta=${mod.meta} />
  </${Boundary}>`;
}

function ReactionBar({ session }) {
  const last = useRef(0);
  const send = (emoji) => {
    const t = Date.now();
    if (t - last.current < 250) return;
    last.current = t;
    floatEmoji(emoji, { count: 2 });
    session.sendFx('react', { emoji });
  };
  return html`<nav class="reactions" aria-label="Send a reaction">
    ${REACTIONS.map((e) => html`<button key=${e} class="react-btn" onClick=${() => send(e)} aria-label=${`Send ${e}`}>${e}</button>`)}
    <button class="react-btn nudge" aria-label="Send a 'thinking of you' heartbeat" onClick=${() => {
      session.sendFx('nudge', {});
      toast('Heartbeat sent');
      play('heart');
    }}><${Icon} name="heart" size=${20} /></button>
  </nav>`;
}

function Settings({ session, config, onClose, onProfileChange }) {
  const st = session.state;
  const me = session.me;
  const [name, setName] = useState(me.name);
  const [avatar, setAvatar] = useState(me.avatar);
  const [color, setColor] = useState(me.color);
  const [aboutUs, setAboutUs] = useState(st.settings.aboutUs || '');
  const [pass, setPass] = useState(getPasscode());
  const [muted, setMutedState] = useState(isMuted());
  const aiReady = aiConfigured(config);

  const [resetArmed, twoTap] = useTwoTap();
  const dirty =
    name !== me.name || avatar !== me.avatar || color !== me.color || muted !== isMuted() ||
    aboutUs !== (st.settings.aboutUs || '') || (aiReady && pass !== getPasscode());
  const save = () => {
    if (name.trim() && (name !== me.name || avatar !== me.avatar || color !== me.color)) {
      onProfileChange({ name: name.trim(), avatar, color });
    }
    if (aboutUs !== (st.settings.aboutUs || '')) session.dispatch({ type: 'settings', patch: { aboutUs } });
    if (aiReady) setPasscode(pass.trim());
    setMuted(muted);
    onClose();
  };
  // Closing with ✕, Escape or the backdrop keeps your edits (saves them) rather than losing them.
  const close = () => (dirty ? save() : onClose());
  const sheet = useSheet(close);

  return html`<div class="sheet-backdrop" onClick=${(e) => e.target === e.currentTarget && close()}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Settings" ref=${sheet} tabIndex="-1">
      <div class="row between"><h2>Settings</h2><button class="btn btn-ghost btn-sm btn-icon" onClick=${close} aria-label="Close settings"><${Icon} name="x" /></button></div>

      <label class="field"><span>Your name</span>
        <input class="input" value=${name} maxLength="24" onInput=${(e) => setName(e.currentTarget.value)} /></label>
      <div class="field"><span>Avatar</span>
        <div class="avatar-grid compact">${AVATARS.map(
          (a) => html`<button type="button" key=${a} class=${`avatar-opt ${a === avatar ? 'sel' : ''}`} onClick=${() => setAvatar(a)}>${a}</button>`,
        )}</div></div>
      <div class="field"><span>Color</span><div class="row gap">${COLORS.map(
        (c) => html`<button type="button" key=${c} aria-label=${c} class=${`swatch ${c === color ? 'sel' : ''}`} style=${`--c:${c}`} onClick=${() => setColor(c)}></button>`,
      )}</div></div>

      <label class="row gap check"><input type="checkbox" checked=${!muted} onChange=${(e) => setMutedState(!e.currentTarget.checked)} /> Sound effects</label>

      ${aiReady
        ? html`<fieldset class="field stack">
            <legend>AI prompts (Claude)</legend>
            <label class="field"><span>AI passcode <small class="muted">(the APP_PASSCODE you set in Supabase — stays on this device)</small></span>
              <input class="input" type="password" value=${pass} autocomplete="off" onInput=${(e) => setPass(e.currentTarget.value)} /></label>
            <label class="field"><span>About us <small class="muted">(optional — inside jokes, how you met, places you love; helps personalise questions)</small></span>
              <textarea class="input" rows="3" maxLength="500" value=${aboutUs} onInput=${(e) => setAboutUs(e.currentTarget.value)}></textarea></label>
          </fieldset>`
        : html`<p class="muted small">AI-written prompts are off for this room</p>`}

      <div class="row gap wrap">
        <button class=${`btn btn-ghost btn-sm ${resetArmed ? 'armed' : ''}`} onClick=${() =>
          twoTap(() => session.dispatch({ type: 'clearHistory' }), 'Tap again to reset points and history for both of you')}>
          ${resetArmed ? 'Tap again to reset' : 'Reset points'}</button>
        <a class="btn btn-ghost btn-sm" href="#/">Leave room</a>
      </div>
      <p class="muted small">Room ${formatCode(st.room)} · ${session.transport.label} · ${session.status}${session.statusDetail ? ` (${session.statusDetail})` : ''}</p>
      <div class="sheet-footer">
        <button class="btn btn-ghost" onClick=${onClose}>Cancel</button>
        <button class="btn btn-primary" onClick=${save}>Save</button>
      </div>
    </div>
  </div>`;
}

/** Focus the sheet when it opens, close on Escape, and give focus back to the opener on close. */
function useSheet(onClose) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}

function Recap({ session, config, code, onClose }) {
  const st = session.state;
  const [poem, setPoem] = useState(() => cleanPoem(storage.get(`recap:${code}`)));
  const sheet = useSheet(onClose);
  const [busy, setBusy] = useState(false);
  const aiOn = aiConfigured(config) && st.settings.ai;
  const names = playerIds(st).map((id) => st.players[id].name);

  const write = async () => {
    setBusy(true);
    try {
      const highlights = st.history.flatMap((h) => [`${h.title}: ${h.summary}`, ...(h.highlights || [])]).slice(-20);
      const r = await aiGenerate(config, 'recap', { vibe: st.settings.vibe, aboutUs: st.settings.aboutUs, names, highlights });
      const data = cleanPoem(r);
      if (!data) throw new Error('the poem came back empty');
      setPoem(data);
      storage.set(`recap:${code}`, data);
      session.sendFx('recap', data);
      confetti();
    } catch (err) {
      toast(`Couldn't write it: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return html`<div class="sheet-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Our night so far" ref=${sheet} tabIndex="-1">
      <div class="row between"><h2>Our night so far</h2><button class="btn btn-ghost btn-sm btn-icon" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button></div>
      <${Postmark} me=${session.me} partner=${session.partnerId() ? st.players[session.partnerId()] : null} prefix="Tonight," />
      <div class="score-big"><b>${st.scores.together}</b> together point${st.scores.together === 1 ? '' : 's'} · ${st.scores.games} game${st.scores.games === 1 ? '' : 's'}</div>
      ${st.history.length === 0
        ? html`<p class="muted">Nothing played yet. Pick a game and it shows up here.</p>`
        : html`<ul class="history">${st.history
            .slice()
            .reverse()
            .map((h, i) => html`<li key=${i}><span><${Icon} name=${iconFor(h.id)} /></span><div class="grow"><div class="row between gap"><b>${h.title}</b><span class="pts">+${h.points}</span></div><small class="muted">${h.summary}</small></div></li>`)}</ul>`}
      ${poem?.poem &&
      html`<div class="poem card"><h3>${poem.title}</h3>${poem.poem.split('\n').map((l, i) => html`<p key=${i}>${l}</p>`)}<${Postmark} me=${session.me} partner=${session.partnerId() ? st.players[session.partnerId()] : null} class="on-paper" /></div>`}
      ${aiOn && st.history.length > 0 &&
      html`<button class="btn btn-primary" onClick=${write} disabled=${busy}>${busy ? 'Writing…' : poem ? 'Write a new one' : 'Write us a short poem about tonight'}</button>`}
    </div>
  </div>`;
}
