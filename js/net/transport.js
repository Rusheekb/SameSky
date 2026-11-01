// Transport = "a broadcast pipe to everyone else in the room".
//
// Interface every transport implements:
//   kind, label                       – identifiers for the UI
//   connect(): Promise<void>          – resolves once the transport is set up (may still be offline)
//   send(msg)                         – fire-and-forget broadcast of a JSON-serialisable object
//   onMessage(cb)                     – cb(msg) for messages from other clients (never our own)
//   onStatus(cb)                      – cb(status, detail); status ∈ connecting | online | offline | error
//   close()
//
// Which transport is used:
//   ?net=local|peer|supabase in the URL wins (handy for testing);
//   otherwise Supabase Realtime when it's configured in js/config.js;
//   otherwise PeerJS (WebRTC with the free public PeerJS broker) so the game works with zero setup.

export function chooseTransportKind(config, search = globalThis.location?.search || '') {
  const forced = new URLSearchParams(search).get('net');
  if (forced === 'local' || forced === 'peer' || forced === 'supabase') {
    if (forced === 'supabase' && !hasSupabase(config)) return 'peer';
    return forced;
  }
  return hasSupabase(config) ? 'supabase' : 'peer';
}

export function hasSupabase(config) {
  return !!(config?.supabaseUrl && config?.supabaseAnonKey);
}

export async function createTransport(kind, opts) {
  switch (kind) {
    case 'local': {
      const { LocalTransport } = await import('./local.js');
      return new LocalTransport(opts);
    }
    case 'supabase': {
      const { SupabaseTransport } = await import('./supabase.js');
      return new SupabaseTransport(opts);
    }
    case 'peer':
    default: {
      const { PeerTransport } = await import('./peer.js');
      return new PeerTransport(opts);
    }
  }
}

/** Shared listener plumbing for transports. */
export class BaseTransport {
  constructor() {
    this._msg = new Set();
    this._status = new Set();
    this.status = 'connecting';
  }
  onMessage(cb) {
    this._msg.add(cb);
    return () => this._msg.delete(cb);
  }
  onStatus(cb) {
    this._status.add(cb);
    cb(this.status, this.detail);
    return () => this._status.delete(cb);
  }
  _deliver(msg) {
    for (const cb of [...this._msg]) cb(msg);
  }
  _setStatus(status, detail = '') {
    this.status = status;
    this.detail = detail;
    for (const cb of [...this._status]) cb(status, detail);
  }
}

/** Load a classic <script> once (used for the vendored UMD bundles). */
const scriptPromises = new Map();
export function loadScript(src) {
  if (!scriptPromises.has(src)) {
    scriptPromises.set(
      src,
      new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.async = true;
        el.onload = () => resolve();
        el.onerror = () => {
          scriptPromises.delete(src);
          reject(new Error(`Could not load ${src}`));
        };
        document.head.appendChild(el);
      }),
    );
  }
  return scriptPromises.get(src);
}
