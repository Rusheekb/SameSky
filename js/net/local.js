// Same-browser transport via BroadcastChannel. Used for local testing (two tabs, or the
// Playwright end-to-end tests): open the room with ?net=local&profile=a and ?net=local&profile=b.

import { BaseTransport } from './transport.js';

export class LocalTransport extends BaseTransport {
  constructor({ room }) {
    super();
    this.kind = 'local';
    this.label = 'This browser (test mode)';
    this.room = room;
    this.ch = null;
  }
  async connect() {
    this._setStatus('connecting');
    this.ch = new BroadcastChannel(`samesky:${this.room}`);
    this.ch.onmessage = (e) => this._deliver(e.data);
    // Defer so listeners registered right after connect() still see the transition.
    setTimeout(() => this._setStatus('online'), 0);
  }
  send(msg) {
    this.ch?.postMessage(msg);
  }
  close() {
    this.ch?.close();
    this.ch = null;
    this._setStatus('offline');
  }
}
