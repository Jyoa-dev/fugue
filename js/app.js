// ── app.js — wires everything together ───────────────────────────────────
import { Identity } from './identity.js';
import { Room }     from './room.js';
import { UI }       from './ui.js';
import {
  isLossyImageEligible, isAVIFSupported,
  estimateWebPSize, compressImageWebP,
  estimateAVIFSize, compressImageAVIF,
  estimateJPEGSize, compressImageJPEG,
  isVideoEligible, compressVideoH264,
} from './compress.js';

const App = (() => {
  let room = null;

  function getDefaultRelay() {
    return 'wss://fugue.thebuttonapp-lastonewins.workers.dev';
  }

  function parseHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    return { canal: p.get('canal') || '', key: p.get('key') || '', relay: p.get('relay') || '' };
  }

  // ── Compression prompt ────────────────────────────────────────────────
  // Injected once into the DOM; shown whenever a large image or video is shared.

  function _injectCompressModal() {
    if (document.getElementById('compress-modal')) return;
    const style = document.createElement('style');
    style.textContent = `
      #compress-modal {
        display: none; position: fixed; inset: 0;
        background: rgb(0 0 0 / 0.4); backdrop-filter: blur(4px);
        z-index: 100; align-items: center; justify-content: center; padding: 20px;
      }
      #compress-modal.open { display: flex; }
      #compress-modal .modal-box { width: 320px; align-items: stretch; gap: 0; padding: 24px; }
      #compress-modal .modal-title { margin-bottom: 16px; }
      #cm-file-row { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
      #cm-icon { font-size: 1.8em; line-height: 1; flex-shrink: 0; }
      #cm-name { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
      #cm-size { font-size: 11px; color: var(--text-3); margin-top: 2px; }
      #cm-options { display: flex; flex-direction: column; gap: 8px; }
      #cm-options .btn { justify-content: center; width: 100%; }
      #cm-note { font-size: 11px; color: var(--text-3); text-align: center; margin-top: 4px; }
      #cm-progress { display: none; margin-top: 4px; }
      #cm-progress-label { font-size: 12px; color: var(--text-3); margin-bottom: 8px; }
      #cm-progress .progress-bar { margin-top: 0; }
      #cm-actions { display: flex; gap: 8px; margin-top: 12px; }
      #cm-actions .btn { flex: 1; justify-content: center; }
    `;
    document.head.appendChild(style);
    const m = document.createElement('div');
    m.id = 'compress-modal';
    m.innerHTML = `
      <div class="modal-box">
        <div class="modal-title" id="cm-title">Share file</div>
        <div id="cm-file-row">
          <span id="cm-icon"></span>
          <div style="min-width:0">
            <div id="cm-name"></div>
            <div id="cm-size"></div>
          </div>
        </div>
        <div id="cm-options"></div>
        <div id="cm-progress">
          <div id="cm-progress-label"></div>
          <div class="progress-bar"><div id="cm-progress-fill" class="progress-fill" style="width:0%"></div></div>
          <div id="cm-actions">
            <button id="cm-stop-btn" class="btn btn-danger">✕ Stop encoding</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => {
      if (e.target === m && m._resolveChoice && !m._compressing) m._resolveChoice(null);
    });
  }

  function _fmtSize(b) {
    if (b < 1024)         return `${b} B`;
    if (b < 1024 * 1024)  return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
  }

  async function _pickCompression(file) {
    const isImg = isLossyImageEligible(file.type, file.name, file.size);
    const isVid = isVideoEligible(file.type, file.name, file.size);
    console.log('[compress] isImg:', isImg, 'isVid:', isVid, 'type:', file.type, 'size:', file.size);
    if (!isImg && !isVid) { console.log('[compress] not eligible, sending raw'); return file; }

    _injectCompressModal();
    const modal    = document.getElementById('compress-modal');
    const options  = document.getElementById('cm-options');
    const progress = document.getElementById('cm-progress');
    const progFill = document.getElementById('cm-progress-fill');
    const progLbl  = document.getElementById('cm-progress-label');
    const stopBtn  = document.getElementById('cm-stop-btn');

    document.getElementById('cm-icon').textContent  = isImg ? '🖼️' : '🎬';
    document.getElementById('cm-name').textContent  = file.name;
    document.getElementById('cm-size').textContent  = _fmtSize(file.size);
    document.getElementById('cm-title').textContent = isImg ? 'Share image' : 'Share video';
    options.innerHTML      = '';
    progress.style.display = 'none';
    progFill.style.width   = '0%';
    modal._compressing     = false;
    modal.classList.add('open');

    const choice = await new Promise(resolve => {
      modal._resolveChoice = resolve;

      const btnRaw = document.createElement('button');
      btnRaw.className   = 'btn btn-outline';
      btnRaw.textContent = `Send as-is  (${_fmtSize(file.size)})`;
      btnRaw.onclick     = () => resolve('raw');
      options.appendChild(btnRaw);

      if (isImg) {
        // Helper: add one image format button with async size estimate
        const addImgBtn = (label, estimateFn, resolveKey) => {
          const btn = document.createElement('button');
          btn.className   = 'btn btn-primary';
          btn.textContent = `${label} — estimating…`;
          btn.disabled    = true;
          btn.onclick     = () => resolve(resolveKey);
          options.appendChild(btn);
          estimateFn(file).then(est => {
            const pct = Math.round((1 - est / file.size) * 100);
            btn.textContent = `${label}  (~${_fmtSize(est)}, −${pct}%)`;
            btn.disabled    = false;
          }).catch(() => {
            btn.textContent = `${label}`;
            btn.disabled    = false;
          });
        };

        // AVIF first (best compression) — always offered, browser will error if unsupported
        addImgBtn('Compress to AVIF', estimateAVIFSize, 'avif');
        addImgBtn('Compress to WebP', estimateWebPSize, 'webp');
        addImgBtn('Compress to JPEG', estimateJPEGSize, 'jpeg');
      } else {
        const btnH264 = document.createElement('button');
        btnH264.className   = 'btn btn-primary';
        btnH264.textContent = 'Compress to H.264  (software, slow)';
        btnH264.onclick     = () => resolve('h264');
        options.appendChild(btnH264);
        const note = document.createElement('div');
        note.id          = 'cm-note';
        note.textContent = 'Runs entirely in-browser — no server involved';
        options.appendChild(note);
      }
    });

    if (choice === 'raw' || choice === null) {
      _closeCompressModal();
      return choice === 'raw' ? file : null;
    }

    // ── Compression phase — loops back to choice on stop ─────────────────
    let currentChoice = choice;
    while (true) {
      modal._compressing     = true;
      options.style.display  = 'none';
      progress.style.display = 'block';
      progFill.style.width   = '0%';
      progLbl.textContent    = '';

      stopBtn.textContent = '✕ Stop encoding';
      stopBtn.disabled    = false;
      const abortCtrl = new AbortController();
      stopBtn.onclick     = () => {
        stopBtn.textContent = 'Stopping…';
        stopBtn.disabled    = true;
        modal._stopped      = true;
        abortCtrl.abort();
      };
      modal._stopped = false;

      try {
        let compressed;
        if (currentChoice === 'webp') {
          progLbl.textContent  = 'Encoding WebP…';
          progFill.style.width = '30%';
          compressed           = await compressImageWebP(file);
          progFill.style.width = '100%';
        } else if (currentChoice === 'avif') {
          progLbl.textContent  = 'Encoding AVIF…';
          progFill.style.width = '30%';
          compressed           = await compressImageAVIF(file);
          progFill.style.width = '100%';
        } else if (currentChoice === 'jpeg') {
          progLbl.textContent  = 'Encoding JPEG…';
          progFill.style.width = '30%';
          compressed           = await compressImageJPEG(file);
          progFill.style.width = '100%';
        } else {
          progLbl.textContent = 'Loading encoder… (~31 MB)';
          compressed = await compressVideoH264(file, {
            signal:     abortCtrl.signal,
            onProgress: p => {
              progLbl.textContent  = `Encoding… ${Math.round(p * 100)}%`;
              progFill.style.width = `${Math.round(p * 100)}%`;
            },
          });
        }
        _closeCompressModal();
        return compressed;

      } catch (e) {
        // If the user hit Stop — go back to the choice screen
        if (modal._stopped) {
          modal._compressing     = false;
          progress.style.display = 'none';
          options.innerHTML      = '';
          options.style.display  = '';

          // Recovery choice: send as-is or retry
          const label = document.createElement('div');
          label.style.cssText  = 'font-size:12px;color:var(--text-3);margin-bottom:4px;text-align:center';
          label.textContent    = 'Encoding stopped.';
          options.appendChild(label);

          const recoveryChoice = await new Promise(resolve => {
            modal._resolveChoice = resolve;

            const btnRaw = document.createElement('button');
            btnRaw.className   = 'btn btn-outline';
            btnRaw.textContent = `Send as-is  (${_fmtSize(file.size)})`;
            btnRaw.onclick     = () => resolve('raw');
            options.appendChild(btnRaw);

            const btnRetry = document.createElement('button');
            btnRetry.className   = 'btn btn-primary';
            const fmtName = { webp: 'WebP', avif: 'AVIF', jpeg: 'JPEG', h264: 'H.264' }[currentChoice] ?? currentChoice.toUpperCase();
            btnRetry.textContent = `Try ${fmtName} again`;
            btnRetry.onclick     = () => resolve(currentChoice);
            options.appendChild(btnRetry);
          });

          if (recoveryChoice === 'raw' || recoveryChoice === null) {
            _closeCompressModal();
            return recoveryChoice === 'raw' ? file : null;
          }
          // retry — loop
          currentChoice = recoveryChoice;
          continue;
        }

        // Unexpected error — show in modal, let user decide
        console.error('[compress] compression failed:', e);
        modal._compressing   = false;
        progFill.style.width = '0%';
        progLbl.style.color  = 'var(--danger, #e55)';
        progLbl.textContent  = `⚠ ${e.message}`;

        const result = await new Promise(resolve => {
          stopBtn.className   = 'btn btn-outline';
          stopBtn.textContent = `Send as-is  (${_fmtSize(file.size)})`;
          stopBtn.disabled    = false;
          stopBtn.onclick     = () => resolve('raw');

          const btnCancel = document.createElement('button');
          btnCancel.className   = 'btn btn-outline';
          btnCancel.textContent = 'Cancel';
          btnCancel.onclick     = () => resolve(null);
          stopBtn.insertAdjacentElement('afterend', btnCancel);
        });

        _closeCompressModal();
        return result === 'raw' ? file : null;
      }
    }
  }

  function _closeCompressModal() {
    const modal = document.getElementById('compress-modal');
    if (!modal) return;
    modal._resolveChoice   = null;
    modal._compressing     = false;
    modal.classList.remove('open');
    const options = document.getElementById('cm-options');
    if (options) options.style.display = '';
  }

  /**
   * Entry point used by both the file-input handler and the drop handler.
   * Shows compression prompt for eligible files; shares directly otherwise.
   */
  async function _shareFile(file) {
    console.log('[share] file:', file.name, file.type, file.size, 'bytes');
    try {
      const toSend = await _pickCompression(file);
      console.log('[share] _pickCompression resolved:', toSend?.name ?? null);
      if (!toSend) { console.log('[share] cancelled'); return; }
      room.shareFile(toSend);
    } catch (e) {
      console.error('[share] error in _shareFile:', e);
    }
  }

  // ── Complex random room name — always 5 words, crypto-random ────────────
  function generateComplexCanal() {
    const adj = [
      'amber','arctic','ashen','azure','black','blazing','bleak','bright','brittle',
      'calm','carved','chromatic','cinder','cobalt','cold','coral','crimson','crumbled',
      'dark','deep','dense','dim','distant','drifting','dry','dusk','dusted',
      'echo','elder','eroded','fading','fallen','faint','fierce','fissured','flickering',
      'frozen','gilded','glowing','granite','grey','hidden','hollow','honed',
      'icy','indigo','iron','jade','jagged','keen','latticed','layered','leaden',
      'lost','lunar','marble','matte','midnight','molten','muted','narrow','neon',
      'obsidian','onyx','opal','pale','phantom','polar','polished','primal','quiet',
      'raw','riven','russet','rusted','scarlet','shattered','silent','silver',
      'skeletal','slate','smoky','solar','spectral','stark','still','stone',
      'submerged','sunken','swift','tawny','tidal','twilight','twisted','violet',
      'vivid','void','volcanic','worn','woven','weathered','wrecked',
    ];
    const noun = [
      'abyss','alcove','arch','atoll','basin','beacon','bluff','breach','brook',
      'butte','caldera','canyon','cape','cavern','chasm','cliff','col','cove','crest',
      'delta','depth','dolmen','drift','dune','ember','escarpment','estuary',
      'fathom','fen','field','fjord','flame','flare','flash','flint','floe','flow',
      'forest','forge','fracture','frost','gale','geyser','glade','gorge','grotto',
      'grove','gulf','haze','headland','helm','hollow','horizon','inlet','isle',
      'kelp','knoll','labyrinth','lagoon','ledge','lichen','loch','maelstrom',
      'mesa','mire','mist','monolith','moon','moraine','moss','nexus','node',
      'outcrop','oubliette','peak','pinnacle','plain','plateau','prism','pulse',
      'reef','ridge','rift','rune','saltflat','scarp','shard','shoal','shore',
      'sinkhole','slope','spire','steppe','strait','stratum','surge','swale',
      'talus','tide','tor','tower','trail','tundra','vale','vault','veil',
      'vertex','vortex','wave','wilds','wrack',
    ];
    const pick = arr => arr[crypto.getRandomValues(new Uint32Array(1))[0] % arr.length];
    // Always 5 words: adj-adj-adj-noun-noun  (~100^5 ≈ 10 billion combinations)
    return `${pick(adj)}-${pick(adj)}-${pick(adj)}-${pick(noun)}-${pick(noun)}`;
  }

  // ── Cryptographically random passphrase (KeePass-style, high entropy) ────
  // crypto.getRandomValues only — no time seeding (time has ~13 bits; CSPRNG has 128+).
  function generateComplexPassword() {
    const lower   = 'abcdefghijkmnpqrstuvwxyz';     // no l, o
    const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';     // no I, O
    const digits  = '23456789';                      // no 0, 1
    const special = '!@#$%^&*-_=+[]{}|;:,./<>?';
    const unicode = '£€¥©®°±×÷≠≈≤≥∞√←→↑↓§¶µ¿¡';   // KeePass "high" set
    const sets    = [lower, upper, digits, special, unicode];
    const all     = sets.join('');
    const length  = 48;
    const result  = [];
    // Guarantee ≥2 chars from every set
    for (const set of sets) {
      for (let n = 0; n < 2; n++)
        result.push(set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length]);
    }
    // Fill rest from full pool
    while (result.length < length)
      result.push(all[crypto.getRandomValues(new Uint32Array(1))[0] % all.length]);
    // Fisher-Yates shuffle
    for (let i = result.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result.join('');
  }

  // ── Reliable AVIF *encoding* detection ────────────────────────────────────
  // The imported isAVIFSupported() from compress.js likely tests decoding (via <img>),
  // not encoding. OffscreenCanvas.convertToBlob is the correct encoding API.
  async function _checkAVIFEncoding() {
    try {
      // Always use HTMLCanvasElement.toBlob — OffscreenCanvas.convertToBlob silently
      // falls back to PNG in Chrome/Edge even when AVIF encoding is supported.
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#f00';
      ctx.fillRect(0, 0, 1, 1);
      return await new Promise(resolve =>
        c.toBlob(b => resolve(!!b && b.type === 'image/avif' && b.size > 0), 'image/avif')
      );
    } catch { return false; }
  }

  function prefill() {
    const { canal, key, relay } = parseHash();
    let fillCanal = canal;
    let fillKey   = key;
    // If no room from URL, check for a saved default room (stored plaintext)
    if (!fillCanal) {
      try {
        const def = JSON.parse(localStorage.getItem('fav_default'));
        if (def?.room) { fillCanal = def.room; if (!fillKey && def.pass) fillKey = def.pass; }
      } catch {}
    }
    document.getElementById('canal-input').value = fillCanal || generateComplexCanal();
    if (fillKey) document.getElementById('passphrase-input').value = fillKey;
    document.getElementById('relay-input').value = relay || getDefaultRelay();
  }

  function initLobby() {
    prefill();
    if (parseHash().canal) joinRoom().catch(console.error);
    
    window.addEventListener('beforeunload', e => {
      if (!room) return;
      e.preventDefault();
      e.returnValue = '';
    });
    document.getElementById('random-canal-btn').addEventListener('click', () => {
      document.getElementById('canal-input').value = generateComplexCanal();
    });
    document.getElementById('random-pass-btn')?.addEventListener('click', () => {
      const input = document.getElementById('passphrase-input');
      input.value = generateComplexPassword();
      input.type  = 'text'; // reveal briefly so user can see/copy it
      setTimeout(() => { input.type = 'password'; }, 2500);
    });
    document.getElementById('canal-input').addEventListener('input', e => {
      const el = e.target;
      const pos = el.selectionStart;
      el.value = el.value.toLowerCase();
      el.setSelectionRange(pos, pos);
    });
    document.getElementById('join-btn').addEventListener('click', () => joinRoom().catch(console.error));
    document.getElementById('canal-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') joinRoom().catch(console.error);
    });
    document.getElementById('passphrase-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') joinRoom().catch(console.error);
    });
    document.getElementById('identity-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') joinRoom().catch(console.error);
    });
    window.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (document.getElementById('lobby').classList.contains('hidden')) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT') return;
      joinRoom().catch(console.error);
    });
  }

  async function joinRoom() {
    const canal      = document.getElementById('canal-input').value.trim();
    const passphrase = document.getElementById('passphrase-input').value;
    const identity   = document.getElementById('identity-input').value.trim() || Identity.generate();
    const relayUrl   = document.getElementById('relay-input').value.trim()   || getDefaultRelay();

    if (!canal) { document.getElementById('canal-input').focus(); return; }

    UI.setStatus('connecting', 'connecting…');

    room = new Room({ relayUrl, canal, passphrase, identity, settings: { ...window.__fugueSettings } });

    room.onStatus = state => UI.setStatus(state, {
      connected: 'connected', connecting: 'reconnecting…', error: 'error',
    }[state] || state);

    room.onMessage    = msg => UI.appendMessage(msg, room.peers, room.myPeerId);
    room.onPeerUpdate = ()  => UI.renderPeers(room.peers, room.myPeerId);
    room.onFileUpdate = ()  => renderFiles();

    room.fileStore.addEventListener('progress', e => {
      UI.updateFileProgress(e.detail.id, e.detail.progress, e.detail.speed);
    });
    room.fileStore.addEventListener('updated', e => {
      const f = e.detail?.id ? room.fileStore.get(e.detail.id) : null;
      if (f) UI.updateFileBubble(f, f.senderId === room.myPeerId);
      renderFiles();
    });
    room.fileStore.addEventListener('receipt', () => renderFiles());

    function renderFiles() {
      UI.renderFilePanel(
        room.fileStore.getAll(),
        room.myPeerId,
        id => room.requestFile(id),
        id => room.cancelDownload(id),
        id => room.pauseDownload(id),
        id => room.fileStore.togglePreview(id),
      );
    }

    try {
      await room.init();
    } catch (err) {
      console.error('[fugue] room.init() failed:', err);
      UI.setStatus('error', 'error');
      room?.leave?.();
      room = null;
      return;
    }

    history.pushState({ fugueRoom: true }, '');

    document.getElementById('lobby').classList.add('hidden');
    document.getElementById('room').classList.add('active');
    document.getElementById('room-canal').textContent = canal;
    document.getElementById('room-relay').textContent =
      new URL(relayUrl.replace('wss://', 'https://')).hostname;

    UI.setEncryptionStatus(!!passphrase, window.__fugueSettings);
    UI.initReadTracking(room);
    UI.injectEventsToggle();
    initRoomEvents(canal, passphrase, relayUrl, renderFiles);
  }

  function initRoomEvents(canal, passphrase, relayUrl, renderFiles) {
    const msgInput = document.getElementById('msg-input');

    msgInput.addEventListener('input', () => {
      msgInput.style.height = 'auto';
      msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    });
    msgInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    });
    document.getElementById('send-btn').addEventListener('click', sendMsg);

    function sendMsg() {
      const text = msgInput.value.trim();
      if (!text || !room) return;
      room.sendMessage(text);
      msgInput.value = '';
      msgInput.style.height = 'auto';
    }

    document.getElementById('file-input').addEventListener('change', async e => {
      for (const f of e.target.files) await _shareFile(f);
      e.target.value = '';
    });

    const dropZone = document.getElementById('drop-zone');
    if (dropZone) dropZone.addEventListener('click', () => document.getElementById('file-input').click());

    const chatPanel = document.getElementById('chat-panel');
    chatPanel.addEventListener('dragover',  e => { e.preventDefault(); dropZone?.classList.add('drag-over'); });
    chatPanel.addEventListener('dragleave', ()  => dropZone?.classList.remove('drag-over'));
    chatPanel.addEventListener('drop', async e => {
      e.preventDefault();
      dropZone?.classList.remove('drag-over');
      for (const f of e.dataTransfer.files) await _shareFile(f);
    });

    // Click on file bubble in chat — handle pause/resume buttons or start download
    document.getElementById('messages').addEventListener('click', e => {
      // In-bubble pause / resume — handled by initReadTracking, nothing to do here
      if (e.target.closest('[data-action^="bubble-"]')) return;

      const bubble = e.target.closest('.file-bubble[data-fileid]');
      if (!bubble) return;
      const f = room.fileStore.get(bubble.dataset.fileid);
      console.log('[click] fileId:', bubble.dataset.fileid, 'found:', !!f, 'status:', f?.status, 'senderId:', f?.senderId, 'myPeerId:', room.myPeerId, 'isMine:', f?.senderId === room.myPeerId);
      if (f && f.senderId !== room.myPeerId && f.status === 'available') {
        console.log('[click] → requestFile');
        room.requestFile(f.id);
      } else {
        console.log('[click] → blocked (status:', f?.status, ')');
      }
    });

    function doLeave() {
      room.leave();
      room = null;
      document.getElementById('room').classList.remove('active');
      document.getElementById('lobby').classList.remove('hidden');
      ['peer-list','messages','file-list'].forEach(id => document.getElementById(id).innerHTML = '');
      UI.setStatus('', 'disconnected');
    }

    // ── Browser/Android back button ───────────────────────────────────────
    function showLeaveModal() {
      const leaveModal = document.getElementById('leave-modal');
      if (leaveModal) {
        leaveModal.classList.add('open');
        document.getElementById('leave-modal-cancel')?.focus();
        return true;
      }
      return false;
    }

    window.fugueHandleBack = function () {
      if (!room) return false;        // on lobby — let Android show exit dialog
      // Re-push so the history stack stays intact for next back press
      history.pushState({ fugueRoom: true }, '');
      return showLeaveModal();
    };

    window.addEventListener('popstate', function (e) {
      if (!room) return;              // nothing to intercept on lobby
      history.pushState({ fugueRoom: true }, '');
      showLeaveModal();
    });

    document.getElementById('leave-btn').addEventListener('click', () => {
      if (!showLeaveModal()) doLeave();
    });

    // Modal confirm — wire actual leave (replaces the index.html inline handler that re-clicked leave-btn)
    const leaveModalConfirm = document.getElementById('leave-modal-confirm');
    if (leaveModalConfirm) {
      // Remove the old handler set in index.html inline script by cloning
      const fresh = leaveModalConfirm.cloneNode(true);
      leaveModalConfirm.parentNode.replaceChild(fresh, leaveModalConfirm);
      fresh.addEventListener('click', () => {
        document.getElementById('leave-modal').classList.remove('open');
        doLeave();
      });
    }

    document.getElementById('copy-link-btn').addEventListener('click', () => {
      const hash = new URLSearchParams({ canal, relay: relayUrl });
      if (passphrase) hash.set('key', passphrase);
      const btn = document.getElementById('copy-link-btn');
      navigator.clipboard.writeText(`${location.origin}${location.pathname}#${hash}`)
        .then(() => UI.showCopiedToast(btn));
    });

    function renderQR(includeKey) {
      const hash = new URLSearchParams({ canal, relay: relayUrl });
      if (passphrase && includeKey) hash.set('key', passphrase);
      const url = `${location.origin}${location.pathname}#${hash}`;
      const qrEl = document.getElementById('qr-canvas');
      qrEl.innerHTML = '';
      new QRCode(qrEl, {
        text: url, width: 180, height: 180,
        colorDark: '#000000', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
      });
      document.getElementById('qr-canal').textContent = canal;
      if (!passphrase) {
        document.getElementById('qr-note').textContent = 'No passphrase — room name only.';
        document.getElementById('qr-key-toggle').classList.add('hidden');
      } else {
        document.getElementById('qr-key-toggle').classList.remove('hidden');
        document.getElementById('qr-note').textContent = includeKey
          ? '⚠ Passphrase embedded — share in person only.'
          : 'Passphrase not included — recipient must enter it manually.';
        document.getElementById('qr-include-key').checked = includeKey;
      }
    }

    document.getElementById('show-qr-btn').addEventListener('click', () => {
      renderQR(false);
      document.getElementById('qr-modal').classList.add('open');
    });
    document.getElementById('qr-include-key').addEventListener('change', e => renderQR(e.target.checked));

    const qrModal = document.getElementById('qr-modal');
    document.getElementById('close-qr-btn').addEventListener('click', () => qrModal.classList.remove('open'));
    qrModal.addEventListener('click', e => { if (e.target === qrModal) qrModal.classList.remove('open'); });
  }

  return { init: initLobby };
})();

App.init();