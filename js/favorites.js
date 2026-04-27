// ── favorites.js — encrypted local favorites ──────────────────────────────
import { closeAllPopovers } from './lobby.js';

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const LS  = { SALT: 'fav_salt', VERIFY: 'fav_verify', DATA: 'fav_data', DEFAULT: 'fav_default' };
let _cryptoKey = null;
let _editIdx   = null;

const FAV_VERSION = '2';
const LS_VER     = 'fav_ver';
const KS_ALIAS   = 'fugue_fav';
const LS_KS_BLOB = 'fav_ks_blob';

function _hasKeystore() {
  try { return typeof AndroidBridge !== 'undefined' && AndroidBridge.isKeystoreAvailable() === 'true'; }
  catch { return false; }
}
// UTF-8 password → base64 and back (handles non-ASCII)
function _pwToB64(pw)  { return btoa(unescape(encodeURIComponent(pw))); }
function _b64ToPw(b64) { return decodeURIComponent(escape(atob(b64))); }

async function _keystoreSave(password) {
  if (!_hasKeystore()) return;
  try {
    const blob = AndroidBridge.keystoreStore(KS_ALIAS, _pwToB64(password));
    if (blob) localStorage.setItem(LS_KS_BLOB, blob);
  } catch (e) { console.warn('[fav] keystore save:', e); }
}

async function _keystoreUnlock() {
  if (!_hasKeystore()) return false;
  const blob = localStorage.getItem(LS_KS_BLOB);
  if (!blob) return false;
  try {
    const b64pw = AndroidBridge.keystoreRetrieve(KS_ALIAS, blob);
    if (!b64pw) return false;
    const salt = Uint8Array.from(atob(localStorage.getItem(LS.SALT)), c => c.charCodeAt(0));
    const key  = await deriveKey(_b64ToPw(b64pw), salt);
    await aeDecrypt(key, localStorage.getItem(LS.VERIFY));
    _cryptoKey = key;
    return true;
  } catch { return false; }
}






// ── Default room (plaintext — no password required) ───────────────────────
function getDefaultRoom()           { try { return JSON.parse(localStorage.getItem(LS.DEFAULT)); } catch { return null; } }
function setDefaultRoom(room, pass) { localStorage.setItem(LS.DEFAULT, JSON.stringify({ room, pass: pass || '' })); }
function clearDefaultRoom()         { localStorage.removeItem(LS.DEFAULT); }

function show(viewId) {
  ['fav-view-setup', 'fav-view-unlock', 'fav-view-main', 'fav-view-new', 'fav-view-edit']
    .forEach(id => document.getElementById(id).classList.toggle('hidden', id !== viewId));
}

function err(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

// ── Crypto helpers ────────────────────────────────────────────────────────
async function deriveKey(password, salt) {
  // Step 1 — PBKDF2: brute-force resistance
  const pbBase = await crypto.subtle.importKey('raw', ENC.encode(password), 'PBKDF2', false, ['deriveKey']);
  const stretched = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 400_000 },
    pbBase, { name: 'HMAC', hash: 'SHA-256', length: 256 }, true, ['sign']
  );
  const stretchedRaw = await crypto.subtle.exportKey('raw', stretched);
  // Step 2 — HKDF: domain separation (fav key ≠ any room key)
  const hkdfBase = await crypto.subtle.importKey('raw', stretchedRaw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: ENC.encode('fugue-fav-v2') },
    hkdfBase, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function aeEncrypt(key, str) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ENC.encode(str));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv); out.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...out));
}

async function aeDecrypt(key, b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const pt    = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return DEC.decode(pt);
}

// ── Persistence ───────────────────────────────────────────────────────────
async function saveData(favs) {
  localStorage.setItem(LS.DATA, await aeEncrypt(_cryptoKey, JSON.stringify(favs)));
}

async function loadData() {
  const raw = localStorage.getItem(LS.DATA);
  if (!raw) return [];
  try { return JSON.parse(await aeDecrypt(_cryptoKey, raw)); }
  catch { return []; }
}

// ── Render list ───────────────────────────────────────────────────────────
async function renderList() {
  const favs = await loadData();
  const list  = document.getElementById('fav-list');
  const def   = getDefaultRoom();

  if (!favs.length) {
    list.innerHTML = '<div class="fav-empty">No favorites yet</div>';
    _renderDefaultBanner(def);
    return;
  }
  list.innerHTML = favs.map((f, i) => {
    const isDefault = def && def.room === f.room;
    return `
    <div class="fav-item" data-i="${i}">
      <div class="fav-item-info">
        <div class="fav-item-name">${f.room}</div>
        ${f.pass ? '<div class="fav-item-pw">••••••••</div>' : ''}
      </div>
      <div class="fav-item-actions">
        <button class="fav-icon-btn star${isDefault ? ' active' : ''}" data-i="${i}" title="${isDefault ? 'Remove default' : 'Set as default room'}">
          ${isDefault ? '★' : '☆'}
        </button>
        <button class="fav-icon-btn edit" data-i="${i}" title="Edit">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="fav-icon-btn del" data-i="${i}" title="Delete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.fav-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.fav-icon-btn')) return;
      const f = favs[+el.dataset.i];
      document.getElementById('canal-input').value = f.room;
      if (f.pass) document.getElementById('passphrase-input').value = f.pass;
      closeFav();
    });
  });

  list.querySelectorAll('.fav-icon-btn.star').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const f = favs[+btn.dataset.i];
      const def = getDefaultRoom();
      if (def && def.room === f.room) {
        clearDefaultRoom();
      } else {
        setDefaultRoom(f.room, f.pass);
      }
      renderList();
    });
  });

  list.querySelectorAll('.fav-icon-btn.edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _editIdx = +btn.dataset.i;
      const f  = favs[_editIdx];
      document.getElementById('fav-edit-name').value = f.room;
      document.getElementById('fav-edit-pw').value   = f.pass || '';
      show('fav-view-edit');
    });
  });
  list.querySelectorAll('.fav-icon-btn.del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = +btn.dataset.i;
      const dlg = document.getElementById('fav-delete-dialog');
      document.getElementById('fav-delete-name').textContent = favs[idx].room;
      dlg.classList.add('open');
      document.getElementById('fav-delete-dialog-cancel').onclick = () => dlg.classList.remove('open');
      dlg.onclick = ev => { if (ev.target === dlg) dlg.classList.remove('open'); };
      document.getElementById('fav-delete-dialog-confirm').onclick = async () => {
        dlg.classList.remove('open');
        // If the deleted item was the default, clear it
        if (getDefaultRoom()?.room === favs[idx].room) clearDefaultRoom();
        favs.splice(idx, 1);
        await saveData(favs);
        renderList();
      };
    });
  });

  _renderDefaultBanner(getDefaultRoom());
}

function _renderDefaultBanner(def) {
  const footer = document.getElementById('fav-default-banner');
  if (!footer) return;
  if (def) {
    footer.innerHTML = `<span class="fav-default-label">★ Default: <strong>${def.room}</strong></span><button class="fav-default-clear" id="fav-default-clear-btn">clear</button>`;
    footer.classList.remove('hidden');
    document.getElementById('fav-default-clear-btn').addEventListener('click', () => {
      clearDefaultRoom();
      renderList();
    });
  } else {
    footer.classList.add('hidden');
  }
}

// ── Setup flow ────────────────────────────────────────────────────────────
document.getElementById('fav-setup-btn').addEventListener('click', async () => {
  const pw  = document.getElementById('fav-setup-pw').value;
  const pw2 = document.getElementById('fav-setup-pw2').value;
  if (!pw)        return err('fav-setup-err', 'Enter a password');
  if (pw !== pw2) return err('fav-setup-err', 'Passwords do not match');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  localStorage.setItem(LS.SALT, btoa(String.fromCharCode(...salt)));
  _cryptoKey = await deriveKey(pw, salt);
  localStorage.setItem(LS.VERIFY, await aeEncrypt(_cryptoKey, 'fugue-fav-ok'));
  await saveData([]);
  localStorage.setItem(LS_VER, FAV_VERSION);
  await _keystoreSave(pw);
  err('fav-setup-err', '');
  show('fav-view-main');
  renderList();
});

// ── Unlock flow ───────────────────────────────────────────────────────────
document.getElementById('fav-unlock-btn').addEventListener('click', async () => {
  const pw = document.getElementById('fav-unlock-pw').value;
  if (!pw) return err('fav-unlock-err', 'Enter your password');
  const salt = Uint8Array.from(atob(localStorage.getItem(LS.SALT)), c => c.charCodeAt(0));
  try {
    const key = await deriveKey(pw, salt);
    await aeDecrypt(key, localStorage.getItem(LS.VERIFY));
    _cryptoKey = key;
    localStorage.setItem(LS_VER, FAV_VERSION);
    await _keystoreSave(pw);
    err('fav-unlock-err', '');
    show('fav-view-main');
    renderList();
  } catch {
    // No fav_ver + has salt = old vault (v1 single-step PBKDF2) — key derivation changed
    const msg = !localStorage.getItem(LS_VER)
      ? 'Vault format updated — reset required (your favorites will need to be re-added).'
      : 'Wrong password';
    err('fav-unlock-err', msg);
  }
});



document.getElementById('fav-unlock-pw').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('fav-unlock-btn').click();
});

document.getElementById('fav-reset-btn').addEventListener('click', () => {
  const dlg = document.getElementById('fav-reset-dialog');
  dlg.classList.add('open');
  document.getElementById('fav-reset-dialog-cancel').onclick = () => dlg.classList.remove('open');
  dlg.onclick = e => { if (e.target === dlg) dlg.classList.remove('open'); };
  document.getElementById('fav-reset-dialog-confirm').onclick = () => {
    dlg.classList.remove('open');
    [LS.SALT, LS.VERIFY, LS.DATA, LS_VER, LS_KS_BLOB].forEach(k => localStorage.removeItem(k));
    if (_hasKeystore()) try { AndroidBridge.keystoreDelete(KS_ALIAS); } catch {}
    _cryptoKey = null;
    show('fav-view-setup');
  };
});

// ── Add current ───────────────────────────────────────────────────────────
document.getElementById('fav-add-btn').addEventListener('click', async () => {
  const room = document.getElementById('canal-input').value.trim();
  const pass = document.getElementById('passphrase-input').value;
  if (!room) return;
  const favs = await loadData();
  if (favs.find(f => f.room === room)) return;
  favs.push({ room, pass });
  await saveData(favs);
  renderList();
});

// ── New favorite from scratch ─────────────────────────────────────────────
document.getElementById('fav-new-btn').addEventListener('click', () => {
  document.getElementById('fav-new-name').value = '';
  document.getElementById('fav-new-pw').value   = '';
  err('fav-new-err', '');
  show('fav-view-new');
});
document.getElementById('fav-new-cancel').addEventListener('click', () => show('fav-view-main'));
document.getElementById('fav-new-save').addEventListener('click', async () => {
  const room = document.getElementById('fav-new-name').value.trim();
  const pass = document.getElementById('fav-new-pw').value;
  if (!room) return err('fav-new-err', 'Room name required');
  const favs = await loadData();
  if (favs.find(f => f.room === room)) return err('fav-new-err', 'Already saved');
  favs.push({ room, pass });
  await saveData(favs);
  show('fav-view-main');
  renderList();
});

// ── Edit flow ─────────────────────────────────────────────────────────────
document.getElementById('fav-edit-save').addEventListener('click', async () => {
  const room = document.getElementById('fav-edit-name').value.trim();
  const pass = document.getElementById('fav-edit-pw').value;
  if (!room) return;
  const favs = await loadData();
  favs[_editIdx] = { room, pass };
  await saveData(favs);
  show('fav-view-main');
  renderList();
});
document.getElementById('fav-edit-cancel').addEventListener('click', () => show('fav-view-main'));

// ── Lowercase enforcement on room name inputs ─────────────────────────────
['fav-new-name', 'fav-edit-name'].forEach(id => {
  document.getElementById(id).addEventListener('input', e => {
    const el = e.target, pos = el.selectionStart;
    el.value = el.value.toLowerCase();
    el.setSelectionRange(pos, pos);
  });
});

// ── Open / close ──────────────────────────────────────────────────────────
function closeFav() {
  document.getElementById('fav-popover').classList.add('hidden');
}
document.getElementById('fav-close').addEventListener('click', closeFav);

document.getElementById('fav-btn').addEventListener('click', async e => {
  e.stopPropagation();
  const pop = document.getElementById('fav-popover');
  if (!pop.classList.contains('hidden')) { closeFav(); return; }
  closeAllPopovers();
  if (!localStorage.getItem(LS.SALT)) {
    show('fav-view-setup');
  } else if (!_cryptoKey) {
    const ksOk = await _keystoreUnlock();
    if (ksOk) {
      show('fav-view-main');
      renderList();
    } else {
      show('fav-view-unlock');
      document.getElementById('fav-unlock-pw').value = '';
      err('fav-unlock-err', !localStorage.getItem(LS_VER) ? 'Vault format updated — reset required.' : '');
    }
  } else {
    show('fav-view-main');
    renderList();
  }

  
  pop.classList.remove('hidden');
  const btn  = document.getElementById('fav-btn');
  const rect = btn.getBoundingClientRect();
  const popW = 280;
  let left   = rect.right - popW;
  if (left < 12) left = 12;
  pop.style.top  = (rect.bottom + 6) + 'px';
  pop.style.left = left + 'px';
});

document.addEventListener('click', e => {
  if (!e.target.closest('.fav-wrap')) closeFav();
});