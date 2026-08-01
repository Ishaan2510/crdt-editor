import './style.css';
import { Doc } from './crdt/document.js';
import { Editor } from './editor/editor.js';
import { SyncClient } from './sync/client.js';

/* Room id lives in the URL so two tabs can share a document. */
if (!location.hash) location.hash = Math.random().toString(36).slice(2, 8);
const room = location.hash.slice(1);

const NAMES = ['Kestrel', 'Otter', 'Heron', 'Marten', 'Falcon', 'Vireo'];
const COLORS = ['#2f6feb', '#d1453b', '#1a7f4b', '#8a4fd3', '#c26a00', '#0f7f8f'];
const pick = a => a[Math.floor(Math.random() * a.length)];

const doc = new Doc(undefined, { seed: true });
const identity = { site: doc.site, name: pick(NAMES), color: pick(COLORS) };

const statusEl = document.querySelector('#status');
const toggleEl = document.querySelector('#connection');

const editor = new Editor(document.querySelector('#editor'), doc, {
  onOps: ops => sync.send(ops),
  onSelection: ({ anchorId, focusId }) => sync.cursor(anchorId, focusId)
});

const sync = new SyncClient(
  import.meta.env.VITE_SYNC_URL ?? `ws://${location.hostname}:8787`,
  doc,
  {
    room,
    identity,
    onOps: ops => editor.applyRemote(ops),
    onStatus: setStatus,
    onPeers: () => {},
    onCursor: () => {}
  }
);

function setStatus(state) {
  const label = { online: 'connected', connecting: 'connecting', offline: 'offline' }[state];
  statusEl.textContent = label;
  statusEl.className = `status ${state}`;
  toggleEl.textContent = state === 'offline' ? 'Go online' : 'Go offline';
}

toggleEl.addEventListener('click', () => {
  if (sync.connected || !sync.manualOffline) sync.disconnect();
  else sync.connect();
});

/*
 * mousedown rather than click: the button would otherwise steal focus
 * from the editor and collapse the selection before the handler runs.
 * preventDefault keeps the caret and selection exactly where they are.
 */
document.querySelector('#toolbar').addEventListener('mousedown', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  e.preventDefault();
  const { inline, block, value } = btn.dataset;
  if (inline) {
    editor.toggleInline(inline);
  } else if (block) {
    editor.toggleBlock(block, isNaN(+value) ? value : +value);
  }
});

sync.connect();
window.__doc = doc;