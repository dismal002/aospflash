// Settings page: manage the ADB keys this tool presents to devices. Opened from the app bar's gear.
// Keys live in the webadb AdbKeyStore (localStorage); Adb.connect() reads that same list.
import { AdbKeyStore } from './webadb/src/index.js';

const store = new AdbKeyStore();
const $ = (id) => document.getElementById(id);

const splashView = $('splash-view');
const buildView = $('build-view');
const settingsView = $('settings-view');
const gearBtn = $('app-bar-settings');
const backBtn = $('settings-back');

const keyList = $('adb-key-list');
const keyEmpty = $('adb-key-empty');
const statusEl = $('adb-key-status');
const uploadBtn = $('adb-key-upload');
const generateBtn = $('adb-key-generate');
const refreshBtn = $('adb-key-refresh');
const fileInput = $('adb-key-file');

const deleteModal = $('delete-key-modal');
const deleteFingerprint = $('delete-key-fingerprint');
const deleteCancel = $('delete-key-cancel');
const deleteConfirm = $('delete-key-confirm');

// --- Navigation: settings replaces whichever view is showing, and Back restores it. ---
let returnTo = null;

function openSettings() {
  if (!settingsView.hidden) return;
  returnTo = buildView.hidden ? splashView : buildView;
  splashView.hidden = true;
  buildView.hidden = true;
  settingsView.hidden = false;
  setStatus('');
  render();
  backBtn.focus();
}

function closeSettings() {
  settingsView.hidden = true;
  (returnTo || splashView).hidden = false;
  returnTo = null;
  gearBtn.focus();
}

gearBtn.addEventListener('click', openSettings);
backBtn.addEventListener('click', closeSettings);

// --- Key list ---
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('is-error', isError);
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

// Fill `el` with a fingerprint that may only wrap after a colon (never mid-byte). <wbr> adds no text,
// so textContent -- and anything the user copies -- is still the plain fingerprint.
function setFingerprint(el, fingerprint) {
  const parts = fingerprint.split(':');
  el.replaceChildren(...parts.flatMap((part, i) => (
    i < parts.length - 1
      ? [document.createTextNode(`${part}:`), document.createElement('wbr')]
      : [document.createTextNode(part)]
  )));
}

function render() {
  const keys = store.list();
  keyEmpty.hidden = keys.length > 0;
  keyList.replaceChildren(...keys.map((key) => {
    const fingerprint = key.deviceFingerprint();

    const item = document.createElement('li');
    item.className = 'key-item';

    const text = document.createElement('span');
    text.className = 'key-fingerprint';
    setFingerprint(text, fingerprint);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.title = 'Delete key';
    del.setAttribute('aria-label', `Delete key ${fingerprint}`);
    const glyph = document.createElement('span');
    glyph.className = 'material-symbols-outlined';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = 'delete';
    del.append(glyph);
    del.addEventListener('click', () => askDelete(fingerprint, del));

    item.append(text, del);
    return item;
  }));
}

// Runs one action with the buttons locked; any failure is shown in the status line.
async function runAction(action) {
  const buttons = [uploadBtn, generateBtn, refreshBtn];
  buttons.forEach((b) => { b.disabled = true; });
  setStatus('');
  try {
    await action();
  } catch (err) {
    setStatus(errorText(err), true);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

refreshBtn.addEventListener('click', () => runAction(async () => {
  render();
  setStatus('Key list refreshed.');
}));

generateBtn.addEventListener('click', () => runAction(async () => {
  await store.generate();
  render();
  setStatus('New key generated.');
}));

uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileInput.value = '';  // so picking the same file again still fires 'change'
  if (!file) return;
  runAction(async () => {
    // A 2048-bit PEM key is ~1.7 KB; anything much bigger is not an ADB key.
    if (file.size > 16 * 1024) throw new Error('That file is too large to be an ADB private key.');
    const { added } = await store.importPem(await file.text());
    render();
    setStatus(added ? 'Key uploaded.' : 'That key is already in the list.');
  });
});

// --- Delete confirmation ---
let pendingDelete = null;
let deleteOpener = null;

function askDelete(fingerprint, opener) {
  pendingDelete = fingerprint;
  deleteOpener = opener;
  setFingerprint(deleteFingerprint, fingerprint);
  deleteModal.hidden = false;
  deleteCancel.focus();  // the safe choice gets focus
}

function closeDelete() {
  deleteModal.hidden = true;
  pendingDelete = null;
  // The opener's row is gone after a delete; fall back to a stable control.
  (deleteOpener && deleteOpener.isConnected ? deleteOpener : uploadBtn).focus();
  deleteOpener = null;
}

deleteCancel.addEventListener('click', closeDelete);
deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) closeDelete(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !deleteModal.hidden) closeDelete();
});
deleteConfirm.addEventListener('click', () => {
  const fingerprint = pendingDelete;
  try {
    const removed = store.remove(fingerprint);
    render();
    setStatus(removed ? 'Key deleted.' : 'That key was already removed.');
  } catch (err) {
    setStatus(errorText(err), true);
  }
  closeDelete();
});
