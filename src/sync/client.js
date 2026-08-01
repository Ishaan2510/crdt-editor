import { missingFrom } from './vector.js';

const BACKOFF = [500, 1000, 2000, 4000, 8000];

/**
 * Transport only. It moves operations; it never interprets them.
 * The document stays fully editable whether or not this is connected,
 * which is what makes the offline path require no special handling.
 */
export class SyncClient {
  constructor(url, doc, { room, identity, onOps, onStatus, onPeers, onCursor }) {
    this.url = url;
    this.doc = doc;
    this.room = room;
    this.identity = identity;
    this.onOps = onOps;
    this.onStatus = onStatus;
    this.onPeers = onPeers;
    this.onCursor = onCursor;

    this.ws = null;
    this.attempt = 0;
    this.manualOffline = false;
    this.serverVector = {};
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    this.manualOffline = false;
    if (this.ws) return;
    this.onStatus('connecting');

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      ws.send(JSON.stringify({
        type: 'hello',
        room: this.room,
        vector: this.doc.vector(),
        ...this.identity
      }));
    };

    ws.onmessage = e => this.handle(JSON.parse(e.data));

    ws.onclose = () => {
      this.ws = null;
      this.onStatus('offline');
      this.onPeers([]);
      if (!this.manualOffline) this.retry();
    };

    ws.onerror = () => ws.close();
  }

  disconnect() {
    this.manualOffline = true;
    this.ws?.close();
  }

  retry() {
    const wait = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)];
    setTimeout(() => { if (!this.manualOffline) this.connect(); }, wait);
  }

  handle(msg) {
    if (msg.type === 'welcome') {
      this.serverVector = msg.vector ?? {};
      this.onStatus('online');
      this.onPeers(msg.peers ?? []);

      // Their ops first, so anything of ours that depends on them lands cleanly.
      if (msg.ops?.length) this.onOps(msg.ops);

      // Then everything they are missing, which is exactly our offline work.
      const outgoing = missingFrom(this.doc.log, this.serverVector);
      if (outgoing.length) this.raw({ type: 'push', ops: outgoing });
      return;
    }

    if (msg.type === 'ops') return this.onOps(msg.ops ?? []);
    if (msg.type === 'cursor') return this.onCursor(msg);
    if (msg.type === 'peer-join') return this.onPeers(null, msg.peer);
    if (msg.type === 'peer-leave') return this.onPeers(null, null, msg.site);
  }

  raw(msg) {
    if (this.connected) this.ws.send(JSON.stringify(msg));
  }

  /**
   * No outbox is needed. Ops go into the document log unconditionally,
   * and the vector exchange on reconnect resends whatever the server
   * did not receive. The queue is the log.
   */
  send(ops) {
    if (ops.length) this.raw({ type: 'push', ops });
  }

  cursor(anchor, focus) {
    this.raw({ type: 'cursor', anchor, focus });
  }
}