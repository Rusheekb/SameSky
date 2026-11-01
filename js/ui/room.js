// Room screen: owns the Session, renders the top bar, invite, lobby, active game, reactions,
// settings and the night recap.
import { html, useEffect, useMemo, useRef, useState, Component } from './h.js';
import { Session } from '../core/session.js';
import { playerIds, VIBES } from '../core/state.js';
import { chooseTransportKind, createTransport } from '../net/transport.js';
import { storage } from '../lib/storage.js';
import { formatCode } from '../lib/util.js';
import { aiConfigured, aiGenerate, getPasscode, setPasscode, AiError } from '../lib/ai.js';
import { play, isMuted, setMuted } from '../lib/sound.js';
import { confetti, floatEmoji, heartPulse, toast } from './fx.js';
import { GAMES, GAME_LIST, loadView } from '../games/index.js';
import { Avatar } from './components.js';
import { rememberRoom, AVATARS, COLORS } from './profile.js';

const REACTIONS = ['❤️', '😘', '😂', '🥺', '🔥', '👏'];
const VIBE_LABELS = { sweet: '🍯 Sweet', flirty: '😏 Flirty', silly: '🤪 Silly', deep: '🌊 Deep' };

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
    addEventListener('pagehide', bye);
    return () => {
      cancelled = true;
      removeEventListener('pagehide', bye);
      s?.stop();
    };
  }, [code]);
  return session;
}

export function Room({ code, profile, config, onProfileChange }) {
  const session = useSession(code, profile, config);
  const [panel, setPanel] = useState(null); // 'settings' | 'recap' | null

  // Push local profile edits into the room.
  useEffect(() => {
    if (session) session.updateProfile(profile);
  }, [session, profile.name, profile.avatar, profile.color]);

  // Global ephemeral events: reactions and "miss you" nudges.
  useEffect(() => {
    if (!session) return undefined;
    return session.onFx((kind, data, from) => {
      const who = session.state.players[from]?.name || 'Your partner';
      if (kind === 'react' && typeof data?.emoji === 'string' && REACTIONS.includes(data.emoji)) {
        floatEmoji(data.emoji, { count: 3, fromPartner: true });
        play('pop');
      } else if (kind === 'nudge') {
        heartPulse(`${who} is thinking of you`);
        play('heart');
      } else if (kind === 'loading') {
        toast(data?.text ? `${who}: ${String(data.text).slice(0, 80)}` : `${who} is setting up a game…`);
      } else if (kind === 'recap') {
        storage.set(`recap:${code}`, data);
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

  if (!session) {
    return html`<main class="screen center"><div class="loader">🌙</div><p class="muted">Opening your room…</p></main>`;
  }
  if (session.full && !st.players[session.id]) {
    return html`<main class="screen narrow center stack">
      <h2>This room is taken 🔒</h2>
      <p class="muted">Room ${formatCode(code)} already has two people in it. Ask for a fresh link, or create your own room.</p>
      <a class="btn btn-primary" href="#/">Back home</a>
    </main>`;
  }

  return html`<div class="room">
    <${TopBar} session=${session} code=${code} onSettings=${() => setPanel('settings')} />
    <main class="room-main">
      ${!partner
        ? html`<${Invite} code=${code} session=${session} />`
        : st.game
          ? html`<${GameHost} session=${session} config=${config} key=${`${st.game.id}:${st.game.n}`} />`
          : html`<${Lobby} session=${session} config=${config} onRecap=${() => setPanel('recap')} />`}
    </main>
    ${partner && html`<${ReactionBar} session=${session} />`}
    ${panel === 'settings' &&
    html`<${Settings} session=${session} config=${config} onClose=${() => setPanel(null)} onProfileChange=${onProfileChange} />`}
    ${panel === 'recap' && html`<${Recap} session=${session} config=${config} code=${code} onClose=${() => setPanel(null)} />`}
  </div>`;
}

function localTime(tz) {
  try {
    return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined }).format(new Date());
  } catch {
    return '';
  }
}

function TopBar({ session, code, onSettings }) {
  const st = session.state;
  const partnerId = session.partnerId();
  const partner = partnerId ? st.players[partnerId] : null;
  const online = partner && session.isOnline(partnerId);
  const statusText =
    session.status === 'online'
      ? online
        ? 'Connected'
        : partner
          ? `${partner.name} is away`
          : 'Waiting…'
      : session.status === 'error'
        ? 'Connection problem'
        : 'Connecting…';
  const showBothTimes = partner?.tz && partner.tz !== session.me.tz;
  return html`<header class="topbar">
    <a class="brand-sm" href="#/" aria-label="Home">🌙</a>
    <div class="couple">
      <${Avatar} player=${session.me} size="sm" online=${true} />
      <span class="amp">&</span>
      <${Avatar} player=${partner} size="sm" online=${partner ? online : undefined} />
      <div class="couple-text">
        <b>${partner ? `${session.me.name} & ${partner.name}` : session.me.name}</b>
        <small class=${`status status-${session.status} ${online ? 'ok' : ''}`} title=${session.statusDetail || session.transport.label}>
          ${statusText}${showBothTimes ? ` · ${partner.name}: ${localTime(partner.tz)}` : ''}
        </small>
      </div>
    </div>
    <button class="btn btn-ghost btn-sm code-btn" onClick=${() => copyInvite(code)} title="Copy invite link">
      ${formatCode(code)}
    </button>
    <button class="btn btn-ghost btn-sm" onClick=${onSettings} aria-label="Settings">⚙️</button>
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
    toast('Invite link copied 💌');
  } catch {
    prompt('Copy this link and send it to your person:', link);
  }
}

function Invite({ code, session }) {
  const link = inviteLink(code);
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Same Sky', text: `Come play with me 💞 Room ${formatCode(code)}`, url: link });
        return;
      } catch {
        /* cancelled */
      }
    }
    copyInvite(code);
  };
  return html`<section class="screen narrow stack center invite">
    <div class="pulse-moon">🌙</div>
    <h2>Waiting for your person…</h2>
    <p class="muted">Send them this link. The moment they open it, you'll both be in the same sky.</p>
    <div class="card stack">
      <div class="invite-code">${formatCode(code)}</div>
      <input class="input mono" readOnly value=${link} onFocus=${(e) => e.currentTarget.select()} aria-label="Invite link" />
      <button class="btn btn-primary btn-lg" onClick=${share}>💌 Share invite link</button>
    </div>
    <p class="muted small">Connection: ${session.transport.label}${session.statusDetail ? ` — ${session.statusDetail}` : ''}</p>
  </section>`;
}

function Lobby({ session, config, onRecap }) {
  const st = session.state;
  const [busy, setBusy] = useState(null);
  const aiReady = aiConfigured(config);
  const useAi = aiReady && st.settings.ai;

  const start = async (mod) => {
    if (busy) return;
    let opts = {};
    if (useAi && mod.meta.ai?.task) {
      setBusy(mod.meta.id);
      session.sendFx('loading', { text: `✨ conjuring ${mod.meta.ai.label || 'something new'} for ${mod.meta.title}…` });
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
        if (err instanceof AiError && err.code === 'passcode') toast('AI passcode needed — set it in ⚙️ Settings. Using built-in cards.');
        else toast(`AI unavailable (${err.message}). Using built-in cards.`);
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
        <p class="muted">Either of you can choose. ${st.scores.games ? `${st.scores.games} played tonight.` : 'Warm up with In Sync!'}</p>
      </div>
      <button class="score-pill" onClick=${onRecap} title="Your night so far">
        <span>💞</span><b>${st.scores.together}</b><small>together pts</small>
      </button>
    </div>

    <div class="vibe-row" role="radiogroup" aria-label="Tonight's vibe">
      ${VIBES.map(
        (v) => html`<button key=${v} role="radio" aria-checked=${st.settings.vibe === v}
          class=${`chip chip-btn ${st.settings.vibe === v ? 'sel' : ''}`}
          onClick=${() => session.dispatch({ type: 'settings', patch: { vibe: v } })}>${VIBE_LABELS[v]}</button>`,
      )}
      ${aiReady &&
      html`<button class=${`chip chip-btn ai-chip ${st.settings.ai ? 'sel' : ''}`} role="switch" aria-checked=${st.settings.ai}
        onClick=${() => session.dispatch({ type: 'settings', patch: { ai: !st.settings.ai } })}
        title="Use Claude to write fresh, personalised prompts">✨ AI ${st.settings.ai ? 'on' : 'off'}</button>`}
    </div>

    <div class="game-grid">
      ${GAME_LIST.map(
        (mod) => html`<button class="game-card" key=${mod.meta.id} onClick=${() => start(mod)} disabled=${!!busy}
          data-game=${mod.meta.id}>
          <span class="game-card-emoji">${busy === mod.meta.id ? '✨' : mod.meta.emoji}</span>
          <b>${mod.meta.title}</b>
          <small>${busy === mod.meta.id ? 'Conjuring…' : mod.meta.tagline}</small>
        </button>`,
      )}
    </div>
    ${st.history.length > 0 &&
    html`<div class="center"><button class="btn btn-ghost" onClick=${onRecap}>🌌 Our night so far</button></div>`}
  </section>`;
}

function recentlyUsed(st, id) {
  return st.history
    .filter((h) => h.id === id)
    .flatMap((h) => h.highlights || [])
    .slice(-10);
}

class ErrorBoundary extends Component {
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
      return html`<div class="card stack center"><h3>Oops, this game tripped 🙈</h3>
        <p class="muted small">${String(this.state.error.message || this.state.error)}</p>
        <button class="btn" onClick=${() => this.props.onExit()}>Back to games</button></div>`;
    }
    return this.props.children;
  }
}

function GameHost({ session, config }) {
  const st = session.state;
  const game = st.game;
  const [View, setView] = useState(null);
  const [err, setErr] = useState(null);
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

  if (err) return html`<p class="card">Couldn't load this game: ${String(err.message || err)}</p>`;
  if (!View) return html`<div class="center"><div class="loader">✨</div></div>`;

  const ids = playerIds(st);
  const partnerId = session.partnerId();
  const mod = GAMES.get(game.id);
  const end = () => session.dispatch({ type: 'endGame' });
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
    act: (a) => session.dispatch({ type: 'game', a }),
    end,
    confirmEnd: () => {
      if (game.s?.done || confirm('Leave this game and go back to the menu?')) end();
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
  return html`<${ErrorBoundary} onExit=${end}>
    ${!api.partnerOnline && html`<div class="away-banner">${api.partner?.name || 'Your partner'} dropped off — waiting for them to come back…</div>`}
    <${View} s=${game.s} api=${api} meta=${mod.meta} />
  </${ErrorBoundary}>`;
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
      toast('Heartbeat sent 💗');
      play('heart');
    }}>💗</button>
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

  const save = () => {
    if (name.trim() && (name !== me.name || avatar !== me.avatar || color !== me.color)) {
      onProfileChange({ name: name.trim(), avatar, color });
    }
    if (aboutUs !== (st.settings.aboutUs || '')) session.dispatch({ type: 'settings', patch: { aboutUs } });
    if (aiReady) setPasscode(pass.trim());
    setMuted(muted);
    onClose();
  };

  return html`<div class="sheet-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="row between"><h2>Settings</h2><button class="btn btn-ghost btn-sm" onClick=${onClose} aria-label="Close">✕</button></div>

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
            <legend>✨ AI (Claude)</legend>
            <label class="field"><span>AI passcode <small class="muted">(the APP_PASSCODE you set in Supabase — stays on this device)</small></span>
              <input class="input" type="password" value=${pass} autocomplete="off" onInput=${(e) => setPass(e.currentTarget.value)} /></label>
            <label class="field"><span>About us <small class="muted">(optional — inside jokes, how you met, places you love; helps personalise questions)</small></span>
              <textarea class="input" rows="3" maxLength="500" value=${aboutUs} onInput=${(e) => setAboutUs(e.currentTarget.value)}></textarea></label>
          </fieldset>`
        : html`<p class="muted small">✨ AI-written prompts are off. See SETUP.md in the repo to switch them on.</p>`}

      <div class="row gap wrap">
        <button class="btn btn-ghost btn-sm" onClick=${() => {
          if (confirm('Reset tonight\'s points and history for both of you?')) session.dispatch({ type: 'clearHistory' });
        }}>Reset points</button>
        <a class="btn btn-ghost btn-sm" href="#/">Leave room</a>
      </div>
      <p class="muted small">Room ${formatCode(st.room)} · ${session.transport.label} · ${session.status}${session.statusDetail ? ` (${session.statusDetail})` : ''}</p>
      <div class="row end"><button class="btn btn-primary" onClick=${save}>Save</button></div>
    </div>
  </div>`;
}

function Recap({ session, config, code, onClose }) {
  const st = session.state;
  const [poem, setPoem] = useState(storage.get(`recap:${code}`));
  const [busy, setBusy] = useState(false);
  const aiOn = aiConfigured(config) && st.settings.ai;
  const names = playerIds(st).map((id) => st.players[id].name);

  const write = async () => {
    setBusy(true);
    try {
      const highlights = st.history.flatMap((h) => [`${h.title}: ${h.summary}`, ...(h.highlights || [])]).slice(-20);
      const r = await aiGenerate(config, 'recap', { vibe: st.settings.vibe, aboutUs: st.settings.aboutUs, names, highlights });
      const data = { title: String(r.title || 'Our night'), poem: String(r.poem || '') };
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
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Our night so far">
      <div class="row between"><h2>🌌 Our night so far</h2><button class="btn btn-ghost btn-sm" onClick=${onClose} aria-label="Close">✕</button></div>
      <div class="score-big"><b>${st.scores.together}</b> together points · ${st.scores.games} game${st.scores.games === 1 ? '' : 's'}</div>
      ${st.history.length === 0
        ? html`<p class="muted">Nothing yet — go play something! 🎲</p>`
        : html`<ul class="history">${st.history
            .slice()
            .reverse()
            .map((h, i) => html`<li key=${i}><span>${h.emoji}</span><div><b>${h.title}</b> <small class="muted">+${h.points}</small><br /><small>${h.summary}</small></div></li>`)}</ul>`}
      ${poem?.poem &&
      html`<div class="poem card"><h3>${poem.title}</h3>${poem.poem.split('\n').map((l, i) => html`<p key=${i}>${l}</p>`)}</div>`}
      ${aiOn && st.history.length > 0 &&
      html`<button class="btn btn-primary" onClick=${write} disabled=${busy}>${busy ? 'Writing…' : poem ? '✨ Write a new one' : '✨ Write us a little poem about tonight'}</button>`}
    </div>
  </div>`;
}
