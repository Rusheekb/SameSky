// App shell: routing (#/ and #/r/CODE), profile setup, home screen.
import { html, useEffect, useState } from './h.js';
import { storage } from '../lib/storage.js';
import { randomCode, normalizeRoomCode, isValidRoomCode, formatCode } from '../lib/util.js';
import { Room } from './room.js';
import { Avatar, Icon } from './components.js';
import { NightScene, MoonMark } from './scene.js';
import { AVATARS, COLORS, getClientId } from './profile.js';


function parseRoute() {
  const m = (location.hash || '').match(/^#\/r\/([A-Za-z0-9-]+)/);
  return m ? { name: 'room', code: normalizeRoomCode(m[1]) } : { name: 'home' };
}

function loadProfile() {
  const p = storage.get('profile');
  if (!p || !p.name) return null;
  return { ...p, id: getClientId(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '' };
}

export function App({ config }) {
  const [route, setRoute] = useState(parseRoute());
  const [profile, setProfile] = useState(loadProfile());
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const on = () => setRoute(parseRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  const saveProfile = (p) => {
    storage.set('profile', { name: p.name, avatar: p.avatar, color: p.color });
    setProfile(loadProfile());
    setEditing(false);
  };

  if (!profile || editing) {
    return html`<${ProfileSetup} initial=${profile} onSave=${saveProfile}
      onCancel=${profile ? () => setEditing(false) : null} inviteCode=${route.name === 'room' ? route.code : ''} />`;
  }
  if (route.name === 'room' && isValidRoomCode(route.code)) {
    return html`<${Room} key=${route.code} code=${route.code} profile=${profile} config=${config}
      onProfileChange=${saveProfile} />`;
  }
  return html`<${Home} profile=${profile} onEditProfile=${() => setEditing(true)} />`;
}

export function ProfileSetup({ initial, onSave, onCancel, inviteCode }) {
  const [name, setName] = useState(initial?.name || '');
  const [avatar, setAvatar] = useState(initial?.avatar || AVATARS[0]);
  const [color, setColor] = useState(initial?.color || COLORS[0]);
  const submit = (e) => {
    e.preventDefault();
    if (name.trim()) onSave({ name: name.trim().slice(0, 24), avatar, color });
  };
  return html`<main class="screen narrow">
    <div class="brand"><${MoonMark} /><span class="brand-name">Same Sky</span></div>
    <h1 class="display profile-title">${inviteCode && !initial ? 'You’re invited' : initial ? 'Your profile' : 'Who’s playing'}</h1>
    ${inviteCode && !initial
      ? html`<p class="lede">Room <span class="mono">${formatCode(inviteCode)}</span> is waiting for you. First, how should your person see you?</p>`
      : html`<p class="lede">Your name and avatar are what your person sees during the games.</p>`}
    <form class="card stack" onSubmit=${submit}>
      <label class="field"><span>Your name</span>
        <input class="input" value=${name} maxLength="24" placeholder="e.g. Maya" autoFocus
          onInput=${(e) => setName(e.currentTarget.value)} />
      </label>
      <div class="field"><span>Pick an avatar</span>
        <div class="avatar-grid" role="radiogroup" aria-label="Avatar">
          ${AVATARS.map(
            (a) => html`<button type="button" role="radio" aria-checked=${a === avatar} key=${a}
              class=${`avatar-opt ${a === avatar ? 'sel' : ''}`} onClick=${() => setAvatar(a)}>${a}</button>`,
          )}
        </div>
      </div>
      <div class="field"><span>Your color</span>
        <div class="row gap" role="radiogroup" aria-label="Color">
          ${COLORS.map(
            (c) => html`<button type="button" role="radio" aria-checked=${c === color} aria-label=${c} key=${c}
              class=${`swatch ${c === color ? 'sel' : ''}`} style=${`--c:${c}`} onClick=${() => setColor(c)}></button>`,
          )}
        </div>
      </div>
      <div class="row center gap">
        <${Avatar} player=${{ name, avatar, color }} size="lg" />
        <b class="preview-name">${name || 'You'}</b>
      </div>
      <div class="row gap end">
        ${onCancel && html`<button type="button" class="btn btn-ghost" onClick=${onCancel}>Cancel</button>`}
        <button class="btn btn-primary" type="submit" disabled=${!name.trim()}>${inviteCode && !initial ? html`Join room <${Icon} name="arrow-right" />` : 'Save'}</button>
      </div>
    </form>
  </main>`;
}

/** Accept a bare code, a formatted code ("K7Q-M2X") or a whole pasted invite link. */
export function codeFromInput(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/#\/r\/([A-Za-z0-9-]+)/);
  if (m) return normalizeRoomCode(m[1]);
  if (/:\/\/|\//.test(raw)) return ''; // a link without a room in it
  return normalizeRoomCode(raw);
}

function Home({ profile, onEditProfile }) {
  const [code, setCode] = useState('');
  const recent = storage.get('recentRooms', []);
  const create = () => {
    const c = randomCode();
    storage.set(`creator:${c}`, true);
    location.hash = `#/r/${c}`;
  };
  const parsed = codeFromInput(code);
  const looksLikeLink = /:\/\/|\//.test(code) && !parsed;
  const join = (e) => {
    e.preventDefault();
    if (isValidRoomCode(parsed)) location.hash = `#/r/${parsed}`;
  };
  return html`<main class="home">
    <section class="hero">
      <${NightScene} />
      <div class="hero-copy">
        <div class="brand"><${MoonMark} /><span class="brand-name">Same Sky</span></div>
        <h1 class="hero-title">Game night for the two of you, miles apart</h1>
      </div>
    </section>

    <div class="home-body">
      <p class="hero-sub">Seven small games you play live on both phones while you talk. Make a room, send your person the link, pick a game.</p>

      <div class="card stack">
        <div class="row between">
          <div class="row gap"><${Avatar} player=${profile} /><span class="muted">Playing as <b class="text">${profile.name}</b></span></div>
          <button class="btn btn-ghost btn-sm" onClick=${onEditProfile}>Edit</button>
        </div>
        <button class="btn btn-primary btn-lg" onClick=${create}>Create our room</button>
        <form class="row gap" onSubmit=${join}>
          <input class="input grow" value=${code} placeholder="Code or invite link" aria-label="Room code or invite link"
            maxLength="300" onInput=${(e) => setCode(e.currentTarget.value)} />
          <button class="btn" type="submit" disabled=${!isValidRoomCode(parsed)}>Join</button>
        </form>
        ${looksLikeLink && html`<p class="form-error">That link has no room in it. Paste just the code, or open the invite link itself.</p>`}
      </div>

      ${recent.length > 0 &&
      html`<div class="card">
        <p class="section-label">Your rooms</p>
        <div class="recent-list">
          ${recent.map(
            (r) => html`<a class="recent" href=${`#/r/${r.code}`} key=${r.code}>
              <b>${formatCode(r.code)}</b>
              <span class="muted small">${r.partner ? `with ${r.partner}` : ''}</span>
            </a>`,
          )}
        </div>
      </div>`}

      <div class="how">
        <p>Everything happens live on both screens, so keep a call going while you play.</p>
        <p>Use a custom code like <code>OURSKY</code> and you’ll always meet in the same room.</p>
      </div>
    </div>
  </main>`;
}
