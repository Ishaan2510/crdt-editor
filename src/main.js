import './style.css';
import { Doc } from './crdt/document.js';
import { Editor } from './editor/editor.js';
import { Presence } from './editor/presence.js';
import { SyncClient } from './sync/client.js';

if (!location.hash) location.hash = Math.random().toString(36).slice(2, 8);
const room = location.hash.slice(1);

const NAMES = ['Kestrel', 'Otter', 'Heron', 'Marten', 'Falcon', 'Vireo'];
const COLORS = ['#2f6feb', '#d1453b', '#1a7f4b', '#8a4fd3', '#c26a00', '#0f7f8f'];
const pick = a => a[Math.floor(Math.random() * a.length)];

const doc = new Doc(undefined, { seed: true });
const identity = { site: doc.site, name: pick(NAMES), color: pick(COLORS) };

const statusEl = document.querySelector('#status');
const toggleEl = document.querySelector('#connection');
const peersEl = document.querySelector('#peers');

const editor = new Editor(document.querySelector('#editor'), doc, {
  onOps: ops => sync.send(ops),
  onSelection: ({ anchorId, focusId }) => sync.cursor(anchorId, focusId)
});

const presence = new Presence(document.querySelector('#presence'), editor);
presence.onRoster = drawRoster;

// Remote edits reflow the text, so every rebuild re-measures the overlay.
editor.onAfterRender = () => presence.draw();

const sync = new SyncClient(
  import.meta.env.VITE_SYNC_URL ?? `ws://${location.hostname}:8787`,
  doc,
  {
    room,
    identity,
    onOps: ops => editor.applyRemote(ops),
    onStatus: setStatus,
    onPeers: (list, joined, left) => {
      if (list) presence.setPeers(list);
      else if (joined) presence.join(joined);
      else if (left) presence.leave(left);
    },
    onCursor: msg => presence.update(msg.site, msg.anchor, msg.focus)
  }
);

function setStatus(state) {
  statusEl.textContent = { online: 'connected', connecting: 'connecting', offline: 'offline' }[state];
  statusEl.className = `status ${state}`;
  toggleEl.textContent = state === 'offline' ? 'Go online' : 'Go offline';
  if (state !== 'online') presence.clear();
}

function drawRoster(list) {
  peersEl.replaceChildren();
  const me = document.createElement('span');
  me.className = 'chip';
  me.innerHTML = `<span class="dot" style="background:${identity.color}"></span>${identity.name} (you)`;
  peersEl.appendChild(me);

  for (const p of list) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<span class="dot" style="background:${p.color}"></span>${p.name}`;
    peersEl.appendChild(chip);
  }
}

document.querySelector('#toolbar').addEventListener('mousedown', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  e.preventDefault();
  const { inline, block, value } = btn.dataset;
  if (inline) editor.toggleInline(inline);
  else if (block) editor.toggleBlock(block, isNaN(+value) ? value : +value);
});

drawRoster([]);
sync.connect();
window.__doc = doc;