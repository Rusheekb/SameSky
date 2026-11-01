import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseTransport } from '../../js/net/supabase.js';

// Minimal fake of the supabase-js Realtime API surface the transport uses.
function fakeSupabase() {
  const channels = [];
  const created = [];
  function createClient(url, key, opts) {
    created.push({ url, key, opts });
    return {
      channel(topic, cfg) {
        const ch = {
          topic,
          cfg,
          handlers: [],
          sent: [],
          statusCb: null,
          on(type, filter, cb) {
            this.handlers.push({ type, filter, cb });
            return this;
          },
          subscribe(cb) {
            this.statusCb = cb;
            return this;
          },
          send(msg) {
            this.sent.push(msg);
            for (const other of channels) {
              if (other !== this && other.topic === this.topic) {
                for (const h of other.handlers) if (h.type === 'broadcast' && h.filter.event === msg.event) h.cb({ event: msg.event, payload: msg.payload });
              }
            }
            return Promise.resolve('ok');
          },
        };
        channels.push(ch);
        return ch;
      },
      removeChannel(ch) {
        channels.splice(channels.indexOf(ch), 1);
        return Promise.resolve('ok');
      },
    };
  }
  return { createClient, channels, created };
}

test('supabase transport: subscribes to samesky:<room>, maps statuses, relays broadcasts', async () => {
  const fake = fakeSupabase();
  const config = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' };
  const a = new SupabaseTransport({ room: 'ROOM', config, createClient: fake.createClient });
  const b = new SupabaseTransport({ room: 'ROOM', config, createClient: fake.createClient });
  const statuses = [];
  a.onStatus((s) => statuses.push(s));
  const got = [];
  b.onMessage((m) => got.push(m));
  await a.connect();
  await b.connect();
  assert.equal(fake.channels[0].topic, 'samesky:ROOM');
  assert.deepEqual(fake.channels[0].cfg.config.broadcast, { self: false, ack: false });
  assert.equal(fake.created[0].opts.auth.persistSession, false);

  a.send({ t: 'early' }); // not subscribed yet -> dropped, not thrown
  assert.equal(fake.channels[0].sent.length, 0);

  fake.channels[0].statusCb('SUBSCRIBED');
  fake.channels[1].statusCb('SUBSCRIBED');
  a.send({ t: 'hello', from: 'a' });
  assert.deepEqual(got, [{ t: 'hello', from: 'a' }]);

  fake.channels[0].statusCb('TIMED_OUT');
  fake.channels[0].statusCb('CHANNEL_ERROR', new Error('nope'));
  fake.channels[0].statusCb('SUBSCRIBED');
  assert.deepEqual(statuses, ['connecting', 'connecting', 'online', 'offline', 'error', 'online']);

  a.close();
  assert.equal(a.status, 'offline');
  b.close();
});
