// Supabase Realtime "Broadcast" transport. No database tables needed: both players join the
// channel `samesky:<ROOM>` and broadcast JSON messages to each other over a websocket.
// The anon / publishable key it uses is designed to be public.

import { BaseTransport, loadScript } from './transport.js';

export class SupabaseTransport extends BaseTransport {
  constructor({ room, config }) {
    super();
    this.kind = 'supabase';
    this.label = 'Supabase Realtime';
    this.room = room;
    this.config = config;
    this.client = null;
    this.channel = null;
  }

  async connect() {
    this._setStatus('connecting', 'Connecting to Supabase…');
    await loadScript(new URL('../vendor/supabase.js', import.meta.url).href);
    const { createClient } = globalThis.supabase;
    this.client = createClient(this.config.supabaseUrl, this.config.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 50 } },
    });
    this.channel = this.client.channel(`samesky:${this.room}`, {
      config: { broadcast: { self: false, ack: false } },
    });
    this.channel.on('broadcast', { event: 'm' }, (msg) => {
      if (msg && msg.payload) this._deliver(msg.payload);
    });
    this.channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') this._setStatus('online');
      else if (status === 'CHANNEL_ERROR') this._setStatus('error', err?.message || 'Realtime channel error');
      else if (status === 'TIMED_OUT') this._setStatus('offline', 'Realtime timed out — retrying…');
      else if (status === 'CLOSED') this._setStatus('offline', 'Realtime closed');
    });
  }

  send(msg) {
    if (!this.channel || this.status !== 'online') return;
    this.channel.send({ type: 'broadcast', event: 'm', payload: msg }).catch?.(() => {});
  }

  close() {
    if (this.channel && this.client) {
      this.client.removeChannel(this.channel).catch?.(() => {});
    }
    this.channel = null;
    this._setStatus('offline');
  }
}
