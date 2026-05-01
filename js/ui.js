// ── ui.js — DOM manipulation and rendering ────────────────────────────────
import { Identity } from './identity.js';

export const UI = (() => {
  const $ = id => document.getElementById(id);

  // messageId → Set<readerName>
  const _readBy = new Map();
  // readerName → messageId of the furthest message they've seen
  const _readerLatest = new Map();
  // fileId → Set<peerName> who have "seen" the announce (read receipt on file msg)
  const _fileSeen = new Map();

  // Whether system/event messages are visible
  let _showEvents = false;

  function fmtSize(bytes) {
    if (bytes < 1024)        return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function fmtSpeed(bps) {
    if (bps < 1024)        return `${bps.toFixed(0)} B/s`;
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / 1048576).toFixed(1)} MB/s`;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fileIcon(name) {
    if (/\.(txt|md|log|csv)$/i.test(name))                        return '📄';
    if (/\.(jpg|jpeg|png|gif|webp|svg|avif)$/i.test(name))        return '🖼️';
    if (/\.(mp4|mov|avi|mkv|webm)$/i.test(name))                  return '🎬';
    if (/\.(mp3|wav|ogg|flac|aac)$/i.test(name))                  return '🎵';
    if (/\.(zip|tar|gz|rar|7z|bz2)$/i.test(name))                 return '📦';
    if (/\.(pdf)$/i.test(name))                                    return '📕';
    if (/\.(js|ts|py|rs|go|c|cpp|html|css|json|sh)$/i.test(name)) return '💾';
    return '📁';
  }

  function isImageFile(name, mimeType) {
    return /\.(jpg|jpeg|png|gif|webp|svg|avif)$/i.test(name) || /^image\//i.test(mimeType || '');
  }

  function isVideoFile(name, mimeType) {
    return /\.(mp4|mov|webm|ogg)$/i.test(name) || /^video\//i.test(mimeType || '');
  }

  function isTextFile(name, mimeType) {
    return /\.(txt|md|log|csv)$/i.test(name) || /^text\//i.test(mimeType || '');
  }

  function isPreviewable(name, mimeType) {
    return isImageFile(name, mimeType) || isVideoFile(name, mimeType) || isTextFile(name, mimeType);
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/\n/g, '<br>');
  }

  function setStatus(state, text) {
    $('status-dot').className    = `status-dot ${state}`;
    $('status-text').textContent = text;
  }

  function renderPeers(peers, myPeerId) {
    const list = $('peer-list');
    list.innerHTML = '';
    let count = 0;
    for (const [id, peer] of peers) {
      count++;
      const el = document.createElement('div');
      el.className = 'peer-item';
      el.innerHTML = `
        <div class="peer-avatar" style="background:${peer.color}22;color:${peer.color};border:1.5px solid ${peer.color}44">
          ${Identity.initials(peer.identity)}
        </div>
        <div class="peer-info">
          <div class="peer-name${id === myPeerId ? ' you' : ''}">${peer.identity}</div>
          <div class="peer-status">${id === myPeerId ? 'you' : 'online'}</div>
        </div>`;
      list.appendChild(el);
    }
    $('peer-count').textContent = count;
  }

  // ── Event visibility toggle ───────────────────────────────────────────────
  function applyEventVisibility() {
    const messages = $('messages');
    if (messages) messages.classList.toggle('show-events', _showEvents);
    const btn = $('meta-toggle-btn');
    if (btn) {
      btn.title = _showEvents ? 'Hide events' : 'Show events';
      btn.classList.toggle('is-active', _showEvents);
    }
  }

  function toggleEvents() {
    _showEvents = !_showEvents;
    applyEventVisibility();
  }

  document.addEventListener('toggle-events', toggleEvents);

  // ── Render a discreet event pill ─────────────────────────────────────────
  // type: 'join' | 'leave' | 'seen' | 'downloaded' | 'receipt' | 'generic'
  function appendEvent(text, type = 'generic') {
    const container = $('messages');
    const el = document.createElement('div');
    el.className = `msg system event event-${type}`;

    const icons = { join: '→', leave: '←', seen: '👁', downloaded: '↓', receipt: '✓', generic: '·' };
    const icon = icons[type] || '·';

    el.innerHTML = `<span><span class="event-icon">${icon}</span>${escapeHtml(text)}</span>`;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  function _renderReceipts(msgEl, messageId) {
    const readers = _readBy.get(messageId);
    let receiptsEl = msgEl.querySelector('.msg-read-receipts');
    if (!readers || readers.size === 0) {
      if (receiptsEl) receiptsEl.remove();
      return;
    }
    if (!receiptsEl) {
      receiptsEl = document.createElement('div');
      receiptsEl.className = 'msg-read-receipts';
      msgEl.appendChild(receiptsEl);
    }
    receiptsEl.innerHTML = [...readers].map(name => {
      const color = Identity.colorFor(name);
      return `<span class="read-receipt-avatar" style="background:${color}22;color:${color};border:1px solid ${color}44" title="${escapeHtml(name)} read this">${Identity.initials(name)}</span>`;
    }).join('') + `<span class="read-receipt-label">seen</span>`;
  }

  function appendMessage(msg, peers, myPeerId) {
    const container = $('messages');

    // ── Read receipt — update seen avatars under message ─────────────────
    if (msg.type === 'read_receipt') {
      const { messageId, readerName, readerId } = msg;
      if (readerId === myPeerId) return;

      // File "seen before download" tick
      if (messageId?.startsWith('file:')) {
        markFileSeen(messageId.slice(5), readerName);
        return;
      }

      // Remove this reader from whichever message they were on before
      const prevId = _readerLatest.get(readerName);
      if (prevId && prevId !== messageId) {
        const prevSet = _readBy.get(prevId);
        if (prevSet) prevSet.delete(readerName);
        const prevEl = container.querySelector(`[data-msgid="${CSS.escape(prevId)}"]`);
        if (prevEl) _renderReceipts(prevEl, prevId);
      }

      _readerLatest.set(readerName, messageId);
      if (!_readBy.has(messageId)) _readBy.set(messageId, new Set());
      _readBy.get(messageId).add(readerName);

      const msgEl = container.querySelector(`[data-msgid="${CSS.escape(messageId)}"]`);
      if (msgEl) _renderReceipts(msgEl, messageId);
      return;
    }

    // ── System / event messages ───────────────────────────────────────────
    if (msg.type === 'system') {
      // Map subtype to event type for styling
      if (msg.subtype === 'join')     { appendEvent(msg.text, 'join');       return; }
      if (msg.subtype === 'leave')    { appendEvent(msg.text, 'leave');      return; }
      if (msg.subtype === 'receipt')  { appendEvent(msg.text, 'downloaded'); return; }

      // Generic system
      const el = document.createElement('div');
      el.className = `msg system event event-generic`;
      el.innerHTML = `<span>${escapeHtml(msg.text)}</span>`;
      container.appendChild(el);
      container.scrollTop = container.scrollHeight;
      return;
    }

    // ── File cancel — clear in-progress bubble immediately ────────────────
    if (msg.type === 'file_cancel') {
      const wrap   = $(`progwrap-${msg.fileId}`);
      const action = $(`bubble-action-${msg.fileId}`);
      if (wrap)   { wrap.classList.add('hidden'); }
      if (action) { _setActionText(action, '↓'); }
      return;
    }

    // ── File announce ─────────────────────────────────────────────────────
    if (msg.type === 'file_announce') {
      const peer  = peers.get(msg.senderId);
      const color = peer?.color || Identity.colorFor(msg.senderName);
      const isSelf = msg.senderId === myPeerId;
      const el = document.createElement('div');
      el.className = `msg ${isSelf ? 'self' : ''}`;
      el.innerHTML = `
        <div class="msg-header">
          <span class="msg-author" style="color:${color}">${escapeHtml(msg.senderName)}</span>
          <span class="msg-time">${fmtTime(Date.now())}</span>
        </div>
        <div class="file-bubble" id="filemsg-${msg.fileId}" data-fileid="${msg.fileId}">
          <div class="file-bubble-icon">${fileIcon(msg.name)}</div>
          <div class="file-bubble-info">
            <div class="file-bubble-name">${escapeHtml(msg.name)}</div>
            <div class="file-bubble-meta">
              ${fmtSize(msg.size)}
              <span id="bubble-spd-${msg.fileId}" class="dl-speed" style="margin-left:6px;opacity:0.7;"></span>
            </div>
            <div class="progress-wrap hidden" id="progwrap-${msg.fileId}">
              <div class="progress-bar" id="prog-${msg.fileId}">
                <div class="progress-fill" style="width:0%"></div>
              </div>
            </div>
          </div>
          <div class="file-bubble-action" id="bubble-action-${msg.fileId}">${isSelf ? '↑' : '↓'}</div>
        </div>
        <div class="file-seen-row" id="file-seen-${msg.fileId}"></div>`;
      container.appendChild(el);
      container.scrollTop = container.scrollHeight;
      return;
    }

    // ── Chat ──────────────────────────────────────────────────────────────
    if (msg.type === 'chat') {
      const peer  = peers.get(msg.senderId);
      const color = peer?.color || Identity.colorFor(msg.senderName);
      const isSelf = msg.senderId === myPeerId;
      const isUnknown = msg.senderName === '[unknown]';
      const el = document.createElement('div');
      el.className = `msg ${isSelf ? 'self' : ''}`;
      if (msg.messageId) {
        el.dataset.msgid    = msg.messageId;
        el.dataset.senderid = msg.senderId;
      }
      el.innerHTML = `
        <div class="msg-header">
          <span class="msg-author" style="color:${color}">${escapeHtml(isUnknown ? '?' : msg.senderName)}</span>
          <span class="msg-time">${fmtTime(msg.time || Date.now())}</span>
        </div>
        <div class="msg-body">${msg.decryptFailed ? `<em class="decrypt-failed">[decryption failed]</em>` : escapeHtml(msg.text)}</div>`;

      // Tap / click → copy text to clipboard (desktop and mobile)
      const body = el.querySelector('.msg-body');
      if (body && !msg.decryptFailed) {
        body.addEventListener('click', () => {
          navigator.clipboard?.writeText(msg.text).then(() => showCopiedToast(body));
        });
      }

      container.appendChild(el);
      container.scrollTop = container.scrollHeight;
    }
  }

  // ── File "seen" tick — shown before download ──────────────────────────────
  // Called when a peer's read receipt arrives for a file_announce message
  function markFileSeen(fileId, readerName) {
    if (!_fileSeen.has(fileId)) _fileSeen.set(fileId, new Set());
    _fileSeen.get(fileId).add(readerName);

    const row = $(`file-seen-${fileId}`);
    if (!row) return;
    const names = [..._fileSeen.get(fileId)];
    row.innerHTML = names.map(name => {
      const color = Identity.colorFor(name);
      return `<span class="file-seen-avatar" style="background:${color}22;color:${color};border:1px solid ${color}44" title="${escapeHtml(name)} saw this">
        ${Identity.initials(name)}
      </span>`;
    }).join('') + `<span class="file-seen-label">seen</span>`;
  }

  function updateFileProgress(fileId, progress, speed) {
    // Chat bubble bar — guard against race: cancel/done may have already hidden this
    const wrap = $(`progwrap-${fileId}`);
    if (wrap) {
      const bubble = $(`filemsg-${fileId}`);
      if (!bubble?.classList.contains('done') && progress < 1) wrap.classList.remove('hidden');
      const fill = wrap.querySelector('.progress-fill');
      if (fill) fill.style.width = `${Math.round(progress * 100)}%`;
    }
    if (progress >= 1) {
      const bubble = $(`filemsg-${fileId}`);
      if (bubble) {
        bubble.classList.add('done');
        const action = $(`bubble-action-${fileId}`);
        if (action && action.textContent !== '✓') action.textContent = '✓';
        if (wrap) wrap.classList.add('hidden');
      }
    }
    // Chat bubble speed
    // File panel entry
    const entryProg = $(`entry-prog-${fileId}`);
    const entryPct  = $(`entry-pct-${fileId}`);
    const entrySpd  = $(`entry-spd-${fileId}`);
    if (entryProg) entryProg.querySelector('.progress-fill').style.width = `${Math.round(progress * 100)}%`;
    if (entryPct)  entryPct.textContent  = `${Math.round(progress * 100)}%`;
    if (entrySpd && speed)        entrySpd.textContent = fmtSpeed(speed);
    if (entrySpd && progress >= 1) entrySpd.textContent = '';
  }

  // ── File panel ────────────────────────────────────────────────────────────
  let _onDownload, _onCancel, _onPause, _onTogglePreview;

  function renderFilePanel(files, myPeerId, onDownload, onCancel, onPause, onTogglePreview) {
    _onDownload      = onDownload;
    _onCancel        = onCancel;
    _onPause         = onPause;
    _onTogglePreview = onTogglePreview;

    const list = $('file-list');
    list.innerHTML = '';
    const fileCountEl = $('file-count');
    if (fileCountEl) fileCountEl.textContent = files.length;

    const activeDownloads = files.filter(f => f.status === 'downloading').length;

    for (const f of files) {
      const isMine        = f.senderId === myPeerId;
      const isDownloading = f.status === 'downloading';
      const isPaused      = f.status === 'paused';
      const isDone        = f.status === 'done';
      const pct           = Math.round((f.progress || 0) * 100);

      const el = document.createElement('div');
      el.className = 'file-entry';
      let actionHtml = '';
      if (!isMine) {
        if (isDownloading || isPaused) {
          // Toggle button stays at the same DOM position — only icon/action changes
          const toggleBtn = isDownloading
            ? `<button class="btn-ghost-sm pause-btn" data-action="pause" data-fileid="${f.id}" title="Pause">⏸</button>`
            : `<button class="btn-ghost-sm dl-btn resume-btn" data-action="download" data-fileid="${f.id}" title="Resume">▶</button>`;
          actionHtml = toggleBtn +
            `<button class="btn-ghost-sm cancel-btn" data-action="cancel" data-fileid="${f.id}" title="Cancel">✕</button>`;
        } else if (!isDone) {
          actionHtml = `<button class="btn-ghost-sm dl-btn" data-action="download" data-fileid="${f.id}" title="Download">↓</button>`;
        }
      }

      const receiptsHtml = (f.receipts || []).map(r =>
        `<span class="receipt ${r.type}">${r.peerName.split('-')[0]} ${r.type === 'downloaded' ? '↓' : r.type === 'sent' ? '↑' : '✓'}</span>`
      ).join('');

      const parallelBadge = isDownloading && activeDownloads > 1
        ? `<span class="parallel-badge" title="${activeDownloads} simultaneous downloads">×${activeDownloads}</span>`
        : '';

      el.innerHTML = `
        <div class="file-entry-top">
          <span class="file-entry-icon">${fileIcon(f.name)}</span>
          <span class="file-entry-name">${escapeHtml(f.name)}</span>
          ${isPaused ? '<span class="paused-badge">paused</span>' : ''}
          ${actionHtml}
          ${isDone && !isDownloading && !isPaused ? '<span class="done-check">✓</span>' : ''}
        </div>
        <div class="file-entry-meta">
          <span>${fmtSize(f.size)}</span>
          <span id="entry-pct-${f.id}" class="dl-pct" style="min-width:36px;display:inline-block">${isDownloading ? pct + '%' : ''}</span>
          <span id="entry-spd-${f.id}" class="dl-speed" style="min-width:62px;display:inline-block">${isDownloading && f.speed ? fmtSpeed(f.speed) : ''}</span>
          ${parallelBadge}
          <span style="color:${Identity.colorFor(f.senderName)}">${f.senderName.split('-')[0]}</span>
        </div>
        ${isDownloading || isPaused ? `
          <div class="file-entry-progress-row">
            <div class="progress-bar file-entry-progress-bar" id="entry-prog-${f.id}">
              <div class="progress-fill" style="width:${pct}%"></div>
            </div>
          </div>` : ''}
        ${receiptsHtml ? `<div class="file-entry-receipts">${receiptsHtml}</div>` : ''}`;

      list.appendChild(el);
    }
  }

  function _onFileListClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, fileid } = btn.dataset;
    if (action === 'download' && _onDownload)      _onDownload(fileid);
    if (action === 'cancel'   && _onCancel)        _onCancel(fileid);
    if (action === 'pause'    && _onPause)         _onPause(fileid);
    if (action === 'preview'  && _onTogglePreview) _onTogglePreview(fileid);
  }

  function setEncryptionStatus(hasKey, settings) {
    $('enc-icon').innerHTML  = hasKey
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke="currentColor" stroke-width="1.8"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`
      : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke="currentColor" stroke-width="1.8"/><path d="M7 11V7a5 5 0 0 1 9.9-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
    if (hasKey && settings && settings.cipher) {
      $('enc-label').textContent = settings.cipher + ' · ' + settings.kdf;
    } else {
      $('enc-label').textContent = hasKey ? 'encrypted' : 'plaintext · no passphrase';
    }
    $('enc-label').className   = `enc-label ${hasKey ? 'enc-on' : 'enc-off'}`;
  }

  // ── Preview helpers ───────────────────────────────────────────────────────

  function _ensurePreviewStyles() {
    if (document.getElementById('ui-preview-styles')) return;
    const s = document.createElement('style');
    s.id = 'ui-preview-styles';
    s.textContent = `
      .bubble-inline-preview { transition: filter 0.12s; }
      .bubble-inline-preview:hover { filter: brightness(1.06); }
      .preview-expand-hint {
        position: absolute; bottom: 7px; right: 7px;
        width: 16px; height: 16px; color: #fff; opacity: 0.4;
        pointer-events: none; transition: opacity 0.12s, transform 0.15s;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6));
      }
      .bubble-inline-preview:hover .preview-expand-hint { opacity: 0.85; }
      .bubble-inline-preview.is-expanded .preview-expand-hint { transform: rotate(180deg); }
    `;
    document.head.appendChild(s);
  }

  function _makeExpandHint() {
    const hint = document.createElement('div');
    hint.className = 'preview-expand-hint';
    hint.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
      <path d="M6 2H2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M10 14h4v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    return hint;
  }

  // Insert preview into a bubble; idempotent, async-safe for text fetch.
  // Click on preview → expand/collapse. Click elsewhere on bubble → toggle visibility (handled by caller).
  async function _insertPreview(bubble, f) {
    if (bubble.querySelector('.bubble-inline-preview')) return;
    _ensurePreviewStyles();

    if (isImageFile(f.name, f.mimeType)) {
      let url = f.previewUrl;
      if (!url && f.rawBuffer) {
        const blob = new Blob([f.rawBuffer], { type: f.mimeType || 'application/octet-stream' });
        url = URL.createObjectURL(blob);
      }
      if (!url && f.file) url = URL.createObjectURL(f.file);
      if (!url) return;

      const wrapper = document.createElement('div');
      wrapper.className = 'bubble-inline-preview';
      wrapper.dataset.expanded = 'false';
      wrapper.style.cssText = 'margin-top:8px;border-radius:6px;position:relative;overflow:hidden;cursor:zoom-in;';

      const img = document.createElement('img');
      img.alt = f.name;
      img.style.cssText = 'width:100%;max-height:180px;object-fit:contain;display:block;border-radius:6px;';
      img.onerror = () => wrapper.remove();
      img.src = url;

      wrapper.addEventListener('click', e => {
        e.stopPropagation();
        const expanded = wrapper.dataset.expanded === 'true';
        img.style.maxHeight = expanded ? '180px' : '90vh';
        wrapper.dataset.expanded   = String(!expanded);
        wrapper.classList.toggle('is-expanded', !expanded);
        wrapper.style.cursor = expanded ? 'zoom-in' : 'zoom-out';
      });

      wrapper.appendChild(img);
      wrapper.appendChild(_makeExpandHint());
      bubble.appendChild(wrapper);

    } else if (isVideoFile(f.name, f.mimeType) && (f.previewUrl || f.file)) {
      const videoUrl = f.previewUrl || URL.createObjectURL(f.file);
      const wrapper = document.createElement('div');
      wrapper.className = 'bubble-inline-preview';
      wrapper.dataset.expanded = 'false';
      wrapper.style.cssText = 'margin-top:8px;border-radius:6px;overflow:hidden;position:relative;';
      const video = document.createElement('video');
      video.src = videoUrl;
      video.controls = true;
      video.preload = 'none';
      video.style.cssText = 'width:100%;max-height:180px;object-fit:contain;display:block;border-radius:6px;';

      // Expand button in top-right corner — avoids conflicting with bottom controls
      const expandBtn = _makeExpandHint();
      expandBtn.style.cssText = 'position:absolute;top:7px;right:7px;pointer-events:auto;cursor:zoom-in;';
      expandBtn.addEventListener('click', e => {
        e.stopPropagation();
        const expanded = wrapper.dataset.expanded === 'true';
        video.style.maxHeight = expanded ? '180px' : '90vh';
        wrapper.dataset.expanded = String(!expanded);
        wrapper.classList.toggle('is-expanded', !expanded);
        expandBtn.style.cursor = expanded ? 'zoom-in' : 'zoom-out';
      });

      wrapper.appendChild(video);
      wrapper.appendChild(expandBtn);
      bubble.appendChild(wrapper);

    } else if (isTextFile(f.name, f.mimeType)) {
      let text = null;
      if (f.rawBuffer) {
        try { text = new TextDecoder().decode(f.rawBuffer); } catch { /* fall through */ }
      }
      if (text === null && f.previewUrl) {
        try { text = await fetch(f.previewUrl).then(r => r.text()); } catch { return; }
      }
      if (text === null && f.file) {
        try { text = await f.file.text(); } catch { return; }
      }
      if (text === null) return;

      const capped = text.length > 4000 ? text.slice(0, 4000) + '\n…' : text;
      const wrapper = document.createElement('div');
      wrapper.className = 'bubble-inline-preview';
      wrapper.dataset.expanded = 'false';
      wrapper.style.cssText = 'margin-top:8px;border-radius:6px;position:relative;overflow:hidden;cursor:zoom-in;';
      wrapper.innerHTML = `
        <div class="preview-clamp" style="max-height:180px;overflow:hidden;position:relative;border-radius:6px;">
          <pre style="margin:0;padding:8px;white-space:pre-wrap;word-break:break-word;font-size:0.8em;opacity:0.85;">${escapeHtml(capped)}</pre>
        </div>`;
      wrapper.appendChild(_makeExpandHint());

      wrapper.addEventListener('click', e => {
        e.stopPropagation();
        const clamp    = wrapper.querySelector('.preview-clamp');
        const expanded = wrapper.dataset.expanded === 'true';
        clamp.style.maxHeight = expanded ? '180px' : '90vh';
        clamp.style.overflow  = expanded ? 'hidden' : 'auto';
        wrapper.dataset.expanded = String(!expanded);
        wrapper.classList.toggle('is-expanded', !expanded);
        wrapper.style.cursor = expanded ? 'zoom-in' : 'zoom-out';
      });

      bubble.appendChild(wrapper);
    }
  }

  // ── Update file bubble state in conv (progress bar, action icon) ─────────
  function _setActionText(action, text) {
    action.style.cssText = ''; // restore container's own CSS
    action.innerHTML = text;
  }

  function _setActionBtn(action, html) {
    // neutralise the container's circle/background so the button stands alone
    action.style.cssText = 'background:none;border:none;box-shadow:none;padding:0;min-width:0;';
    action.innerHTML = html;
  }

  function updateFileBubble(f, isMine) {
    const fileId = f.id;
    const status = f.status;

    // Sender auto-preview — must run before the !action guard, since the bubble
    // isn't in the DOM yet when this first fires (appendMessage runs after us).
    if (isMine && status === 'available' && isPreviewable(f.name, f.mimeType) && (f.previewUrl || f.rawBuffer || f.file)) {
      const _fid = fileId, _f = f;
      const tryInsert = b => _insertPreview(b, _f);
      const bubble = $(`filemsg-${_fid}`);
      if (bubble) {
        tryInsert(bubble);
      } else {
        const observer = new MutationObserver(() => {
          const b = $(`filemsg-${_fid}`);
          if (!b) return;
          observer.disconnect();
          tryInsert(b);
        });
        observer.observe($('messages'), { childList: true, subtree: true });
      }
    }

    const wrap   = $(`progwrap-${fileId}`);
    const action = $(`bubble-action-${fileId}`);
    if (!action) return;

    // Speed in conv bubble — mirrors how renderFilePanel reads f.speed directly
    const bubbleSpd = $(`bubble-spd-${fileId}`);
    if (bubbleSpd) {
      bubbleSpd.textContent = (status === 'downloading' && f.speed) ? fmtSpeed(f.speed) : '';
    }

    if (status === 'done') {
      if (wrap) wrap.classList.add('hidden');
      _setActionText(action, '✓');
      // Auto-preview on first completion (sender and receiver, all previewable types)
      const bubble = $(`filemsg-${fileId}`);
      if (bubble && isPreviewable(f.name, f.mimeType) && (f.previewUrl || f.rawBuffer || f.file)) {
        _insertPreview(bubble, f);
      }
    } else if (status === 'available') {
      if (wrap) wrap.classList.add('hidden');
      _setActionText(action, isMine ? '↑' : '↓');
    } else if (status === 'downloading') {
      if (wrap) wrap.classList.remove('hidden');
      _setActionBtn(action, `
        <div style="display:flex;gap:3px;align-items:center;padding-right:12px;">
          <button class="btn-ghost-sm pause-btn"  data-action="bubble-pause"  data-fileid="${fileId}" title="Pause">⏸</button>
          <button class="btn-ghost-sm cancel-btn" data-action="bubble-cancel" data-fileid="${fileId}" title="Cancel">✕</button>
        </div>`);
    } else if (status === 'paused') {
      _setActionBtn(action, `
        <div style="display:flex;gap:3px;align-items:center;padding-right:12px;">
          <button class="btn-ghost-sm dl-btn resume-btn" data-action="bubble-resume" data-fileid="${fileId}" title="Resume">▶</button>
          <button class="btn-ghost-sm cancel-btn"        data-action="bubble-cancel" data-fileid="${fileId}" title="Cancel">✕</button>
        </div>`);
    }
  }

  function initReadTracking(room) {
    $('file-list').addEventListener('click', _onFileListClick);

    // Delegated click on messages — pause/resume buttons + preview toggle
    $('messages').addEventListener('click', e => {
      // In-bubble pause / resume buttons
      const actionBtn = e.target.closest('[data-action^="bubble-"]');
      if (actionBtn) {
        e.stopPropagation();
        const { action, fileid } = actionBtn.dataset;
        if (action === 'bubble-pause')  room.pauseDownload(fileid);
        if (action === 'bubble-resume') room.requestFile(fileid);
        if (action === 'bubble-cancel') room.cancelDownload(fileid);
        return;
      }

      // Preview click → expand/collapse handled by preview's own listener
      if (e.target.closest('.bubble-inline-preview')) return;

      const bubble = e.target.closest('.file-bubble[data-fileid]');
      if (!bubble) return;
      const f = room.fileStore.get(bubble.dataset.fileid);
      if (!f) return;

      // Toggle inline preview on/off
      const existing = bubble.querySelector('.bubble-inline-preview');
      if (existing) { existing.remove(); return; }

      if (isPreviewable(f.name, f.mimeType) && (f.previewUrl || f.rawBuffer || f.file)) {
        _insertPreview(bubble, f);
      }
    });

    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        const { msgid, senderid, fileid } = el.dataset;
        if (msgid && senderid && senderid !== room.myPeerId) {
          room.sendReadReceipt(senderid, msgid);
        }
        // File announce seen — mark it
        if (fileid && senderid && senderid !== room.myPeerId) {
          markFileSeen(fileid, room.identity);
          room.sendReadReceipt(senderid, `file:${fileid}`);
        }
        io.unobserve(el);
      }
    }, { threshold: 0.5 });

    new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.dataset?.msgid) io.observe(node);
          // Also observe file bubbles to track "seen"
          const bubble = node.querySelector?.('.file-bubble[data-fileid]');
          if (bubble) {
            // Attach fileid + senderid to the parent msg node for IO
            const msg = bubble.closest('.msg');
            if (msg) {
              msg.dataset.fileid   = bubble.dataset.fileid;
              msg.dataset.senderid = msg.dataset.senderid || '';
            }
            io.observe(bubble);
          }
        }
      }
    }).observe($('messages'), { childList: true });
  }

  // ── Copied toast ─────────────────────────────────────────────────────────
  function showCopiedToast(anchorEl) {
    const existing = document.querySelector('.copied-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'copied-toast';
    toast.textContent = 'Copied';
    document.body.appendChild(toast);

    // Position centered above the anchor element
    const rect = anchorEl.getBoundingClientRect();
    const tw = 80; // approximate width before render
    const left = rect.left + rect.width / 2 - tw / 2;
    const top  = rect.top - 34;
    toast.style.left = `${Math.max(8, left)}px`;
    toast.style.top  = `${Math.max(8, top)}px`;

    // Animate in
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // Animate out
    const hideDelay = 700;
    setTimeout(() => {
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 220);
    }, hideDelay);
  }

  // Button now lives in index.html; kept for API compatibility with app.js
  function injectEventsToggle() {}

  return {
    setStatus,
    renderPeers,
    appendMessage,
    renderFilePanel,
    updateFileProgress,
    updateFileBubble,
    setEncryptionStatus,
    initReadTracking,
    injectEventsToggle,
    markFileSeen,
    fmtSize,
    showCopiedToast,
  };
})();