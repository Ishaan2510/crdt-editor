import './style.css';
import { Doc } from './crdt/document.js';
import { Editor } from './editor/editor.js';

const doc = new Doc(undefined, { seed: true });
const editor = new Editor(document.querySelector('#editor'), doc);

document.querySelector('#toolbar').addEventListener('mousedown', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  e.preventDefault(); // keep the caret in the editor
  const { inline, block, value } = btn.dataset;
  if (inline) editor.toggleInline(inline);
  else if (block) editor.toggleBlock(block, value === 'null' ? null : (isNaN(+value) ? value : +value));
});

window.__doc = doc; // console access during the demo