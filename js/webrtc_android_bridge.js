// ── webrtc_android_bridge.js ─────────────────────────────────────────────────
// Patches WebRTCMesh to use native Kotlin WebRTC on Android.
//
// Architecture:
//  • Signaling (offer/answer/ICE) flows JS ↔ Kotlin via @JavascriptInterface
//  • Outbound file chunks (FAST PATH): JS calls NativeBlob.sendChunk() / NativeFile.sendChunk()
//    → single @JavascriptInterface call AndroidRtc.readAndSendChunk().
//    Kotlin reads the chunk, encrypts with the session AES-GCM key, builds the
//    26-byte DC frame header, and calls dc.send() — no base64, one bridge crossing.
//    sendPool/sendShared are still used for non-file frames (signalling wrappers, etc.).
//  • Outbound file chunks (LEGACY / non-Android fallback): sendOnChannel() still exists
//    for desktop code paths and any caller that cannot use sendChunk().
//  • Inbound file chunks: Kotlin receives DC frames, reassembles, decrypts, saves
//    to MediaStore — JS never touches binary data on the receive path.
//  • JS-only responsibility: UI callbacks (_nativeProgress, _nativeFileDone, etc.)
//
// readAndSendChunk @JavascriptInterface contract (Kotlin must implement):
//   fun readAndSendChunk(
//     token:        String,   // NativeFile._token opaque handle
//     offset:       Long,     // byte offset into file
//     length:       Int,      // bytes to read
//     peerId:       String,   // destination peer UUID
//     poolIndex:    Int,      // which pool DC to use (0–3)
//     fileIdHex:    String,   // 8-char hex file-ID for the DC frame header
//     chunkIndex:   Int,      // 0-based chunk sequence number
//     totalChunks:  Int,      // total chunks for this transfer
//     encryptedFlag:Boolean   // true → encrypt with session key before send
//   ): Boolean               // false → caller should treat as send failure
//
// Kotlin → JS callbacks (all small strings, no binary):
//  _nativeRtcOffer(peerId, sdpJson)
//  _nativeRtcAnswer(peerId, sdpJson)
//  _nativeRtcIce(peerId, candidateJson)
//  _nativeRtcReady(peerId)
//  _nativeRtcPoolReady(peerId)
//  _nativeRtcFailed(peerId)
//  _nativeFilePicked(jsonArray)
//  _nativeProgress(fileId, ratio)        0.0–1.0
//  _nativeFileDone(fileId, name, mime)   saved to Downloads
//  _nativeFileError(fileId, name, msg)   save failed
//  _nativeRelayReceipt(fileId, peerId)   JS should send relay receipt

const _log  = (...a) => console.log ('[android-bridge]', ...a);
const _dbg  = (...a) => console.debug('[android-bridge]', ...a);
const _warn = (...a) => console.warn ('[android-bridge]', ...a);

/**
 * Patch WebRTCMesh to use native Android WebRTC when window.AndroidRtc is
 * present. Must be called with the WebRTCMesh *class* (not an instance).
 * Safe to call on desktop — exits immediately if AndroidRtc is not defined.
 */
export function initAndroidBridge(WebRTCMesh) {
  const _isAndroid = typeof window.AndroidRtc !== 'undefined';
  _log(_isAndroid
    ? 'AndroidRtc detected — will patch WebRTCMesh'
    : 'no AndroidRtc — desktop mode, no patch applied');
  if (!_isAndroid) return;
  if (WebRTCMesh.prototype._androidBridgeApplied) {
    _log('already patched — skipping'); return;
  }
  WebRTCMesh.prototype._androidBridgeApplied = true;
{
  const proto = WebRTCMesh.prototype;

  // ── addPeer ───────────────────────────────────────────────────────────────
  const _origAddPeer = proto.addPeer;
  proto.addPeer = async function(peerId) {
    _log('addPeer called for', peerId.slice(0,8));
    if (this._pcs.has(peerId)) {
      const existing = this._pcs.get(peerId);
      _log('addPeer skipped — already exists', peerId.slice(0,8),
        '| native:', !!existing._native, '| state:', existing.connectionState);
      return;
    }
    _log('addPeer — creating native PC for', peerId.slice(0,8));
    this._pcs.set(peerId, { _native: true, connectionState: 'new', close() {} });
    _log('→ AndroidRtc.createPeerConnection(', peerId.slice(0,8), ')');
    window.AndroidRtc.createPeerConnection(peerId);
    if (this.myPeerId > peerId) {
      _log('addPeer — Android is initiator for', peerId.slice(0,8), '— calling AndroidRtc.createOffer');
      window.AndroidRtc.createOffer(peerId);
    } else {
      _log('addPeer — Android is responder for', peerId.slice(0,8), '— waiting for rtc_offer');
    }
  };

  // ── removePeer ────────────────────────────────────────────────────────────
  const _origRemovePeer = proto.removePeer;
  proto.removePeer = function(peerId) {
    const pc = this._pcs.get(peerId);
    if (pc?._native) {
      _log('removePeer (native)', peerId.slice(0,8));
      window.AndroidRtc.closePeer(peerId);
      this._pcs.delete(peerId);
      this._dcs.delete(peerId);
      this._androidDcs.delete(peerId);
      this._dcReady.delete(peerId);
      this._icePending.delete(peerId);
      this._xferPool.delete(peerId);
      this._xferPoolResolve.delete(peerId);
      this._xferPoolBuf.delete(peerId);
      this._xferBufHigh.delete(peerId);
      for (const [key, asm] of this._assemblers) {
        if (asm.peerId === peerId) this._assemblers.delete(key);
      }
      _log('removePeer (native) done for', peerId.slice(0,8));
      return;
    }
    return _origRemovePeer.call(this, peerId);
  };

  // ── handleSignal ──────────────────────────────────────────────────────────
  const _origHandleSignal = proto.handleSignal;
  proto.handleSignal = async function(msg) {
    const { type, senderId } = msg;
    _dbg('handleSignal type=', type, 'from', senderId.slice(0,8));

    if (type === 'rtc_offer') {
      const existing = this._pcs.get(senderId);
      if (existing && !existing._native) {
        _warn('rtc_offer from', senderId.slice(0,8), '— real RTCPeerConnection in _pcs; falling through');
        return _origHandleSignal.call(this, msg);
      }
      if (!existing) {
        _log('rtc_offer from', senderId.slice(0,8), '— no PC yet, creating native sentinel');
        this._pcs.set(senderId, { _native: true, connectionState: 'new', close() {} });
        window.AndroidRtc.createPeerConnection(senderId);
      } else {
        _log('rtc_offer from', senderId.slice(0,8), '— native sentinel already present');
      }
      _log('rtc_offer → AndroidRtc.setRemoteOffer(', senderId.slice(0,8), ')');
      window.AndroidRtc.setRemoteOffer(senderId, JSON.stringify(msg.sdp));
      const pendingIce = this._icePending.get(senderId);
      if (pendingIce?.length) {
        _log('rtc_offer — flushing', pendingIce.length, 'pre-offer ICE candidate(s)');
        this._icePending.delete(senderId);
        for (const c of pendingIce) window.AndroidRtc.addIceCandidate(senderId, JSON.stringify(c));
      }
      return;
    }

    if (type === 'rtc_answer') {
      const pc = this._pcs.get(senderId);
      if (!pc) { _warn('rtc_answer — no PC; dropping'); return; }
      if (!pc._native) return _origHandleSignal.call(this, msg);
      window.AndroidRtc.setRemoteAnswer(senderId, JSON.stringify(msg.sdp));
      return;
    }

    if (type === 'rtc_ice') {
      const pc = this._pcs.get(senderId);
      if (!pc) {
        _warn('rtc_ice — no PC yet; buffering');
        if (!this._icePending.has(senderId)) this._icePending.set(senderId, []);
        if (msg.candidate) this._icePending.get(senderId).push(msg.candidate);
        return;
      }
      if (!pc._native) return _origHandleSignal.call(this, msg);
      if (msg.candidate) window.AndroidRtc.addIceCandidate(senderId, JSON.stringify(msg.candidate));
      return;
    }

    _dbg('handleSignal — non-WebRTC type', type, '— passing through');
    return _origHandleSignal.call(this, msg);
  };

  // ── hasChannel ────────────────────────────────────────────────────────────
  const _origHasChannel = proto.hasChannel;
  proto.hasChannel = function(peerId) {
    const pc = this._pcs.get(peerId);
    if (pc?._native) {
      const ready = window.AndroidRtc.isSharedReady(peerId);
      _dbg('hasChannel (native)', peerId.slice(0,8), '→', ready);
      return ready;
    }
    return _origHasChannel.call(this, peerId);
  };

  // ── sendBinary (shared DC) ────────────────────────────────────────────────
  // JS → Kotlin: wrap frame with _sendOnDC transport header (total=1) then
  // encode as base64 and call @JavascriptInterface sendShared.
  //
  // WHY the transport header is required here:
  //   webrtc.js sendBinary() calls _sendOnDC() which ALWAYS prepends a 12-byte
  //   transport header [transferId(u32 LE) | total(u32 LE) | index(u32 LE)].
  //   Desktop's _handleFrame() unconditionally strips those 12 bytes, so any
  //   frame arriving on the shared DC from Android MUST carry that header or
  //   _handleFrame() will consume the first 12 payload bytes as header fields,
  //   producing a garbled transferId, a nonsensical total, and a dropped message.
  //
  //   Symmetrically, Kotlin's handleInboundFrame() strips the header for ALL
  //   DataChannels (shared and pool alike) so outbound messages from the desktop
  //   — which always carry the header via _sendOnDC — are forwarded to JS
  //   as clean app frames with no header bytes prepended.
  const _origSendBinary = proto.sendBinary;
  proto.sendBinary = async function(peerId, buffer) {
    const pc = this._pcs.get(peerId);
    if (!pc?._native) return _origSendBinary.call(this, peerId, buffer);
    _dbg('sendBinary (native shared DC)', peerId.slice(0,8));
    const bytes   = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
    const wrapped = _wrapSingleFragment(bytes);
    const ok = window.AndroidRtc.sendShared(peerId, _toB64(wrapped));
    if (!ok) throw new Error(`[android-bridge] sendShared failed for ${peerId.slice(0,8)}`);
  };

  // ── getPoolChannels ───────────────────────────────────────────────────────
  const _origGetPoolChannels = proto.getPoolChannels;
  proto.getPoolChannels = function(peerId, timeoutMs = 10_000) {
    const pc = this._pcs.get(peerId);
    if (!pc?._native) return _origGetPoolChannels.call(this, peerId, timeoutMs);

    // Guard: you can never open a pool channel to yourself.
    if (peerId === this.myPeerId) {
      _warn('getPoolChannels (native) — peerId equals myPeerId! Caller passed own ID.',
            '| myPeerId:', this.myPeerId.slice(0,8),
            '| Stack:', new Error().stack.split('\n').slice(1,4).join(' ▸ '));
      return Promise.reject(new Error('[android-bridge] getPoolChannels called with own peerId'));
    }

    _log('getPoolChannels (native)', peerId.slice(0,8));
    if (this._xferPool.has(peerId)) {
      _log('getPoolChannels (native) — pool already ready for', peerId.slice(0,8));
      return Promise.resolve(this._xferPool.get(peerId));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        _warn('getPoolChannels (native) — TIMEOUT', peerId.slice(0,8));
        this._xferPoolResolve.delete(peerId);
        reject(new Error(`[android-bridge] pool timeout ${peerId.slice(0,8)}`));
      }, timeoutMs);
      this._xferPoolResolve.set(peerId, pool => {
        clearTimeout(timer);
        resolve(pool);
      });
      if (this._xferPool.has(peerId)) {
        clearTimeout(timer);
        this._xferPoolResolve.delete(peerId);
        resolve(this._xferPool.get(peerId));
      }
    });
  };

  // ── sendOnChannel — native pool DC ───────────────────────────────────────
  // Used for non-file frames (small control messages, relay receipts, etc.) that
  // are already fully assembled in JS.  File chunk senders should use
  // NativeBlob.sendChunk() / NativeFile.sendChunk() instead — those avoid the
  // double base64 round-trip by calling AndroidRtc.readAndSendChunk() directly.
  // JS → Kotlin: encode frame as base64, call @JavascriptInterface sendPool.
  //
  // NOTE: sendPool frames go directly to Kotlin's dc.send() — they must NOT carry
  // the _sendOnDC transport header here because readAndSendChunk() already builds
  // the complete wire frame (transport header + app header + payload) internally.
  // Control frames sent via this path (relay receipts, etc.) are raw app frames
  // that Kotlin forwards to the remote peer as-is via sendBytes().
  const _origSendOnChannel = proto.sendOnChannel;
  proto.sendOnChannel = function(dc, buffer) {
    if (!dc._nativePool) return _origSendOnChannel.call(this, dc, buffer);
    const { peerId, index } = dc._nativePool;

    // Guard: peerId must be the REMOTE peer, never our own ID.
    // If peerId === this.myPeerId something upstream passed the wrong peer ID
    // (e.g. room.js calling getPoolChannels(myPeerId) instead of senderPeerId).
    // Kotlin's peers map is keyed by remote ID so this would always miss.
    if (peerId === this.myPeerId) {
      _warn('sendOnChannel (native pool) — peerId equals myPeerId! Caller passed own ID as destination.',
            '| peerId:', peerId.slice(0,8), '| index:', index,
            '| This is a bug in the caller — pool DC lookup in Kotlin will fail.');
      return Promise.reject(new Error('[android-bridge] sendOnChannel called with own peerId as destination'));
    }

    _log('sendOnChannel (native pool)', peerId.slice(0,8), '| channel index:', index);
    return Promise.resolve().then(() => {
      const bytes = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
      const ok = window.AndroidRtc.sendPool(peerId, index, _toB64(bytes));
      if (!ok) _warn('sendOnChannel (native pool) — sendPool returned false',
                     '| peerId:', peerId.slice(0,8), '| idx:', index,
                     '| DC not open in Kotlin yet? Pool ready =', window.AndroidRtc.isPoolReady(peerId));
    });
  };

  // ── Kotlin → JS callbacks ─────────────────────────────────────────────────

  window._nativeRtcOffer = (peerId, sdpJson) => {
    _log('_nativeRtcOffer — forwarding offer for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcOffer — no _webrtcMesh'); return; }
    mesh.sendSignal({ type: 'rtc_offer', targetId: peerId, sdp: JSON.parse(sdpJson), senderId: mesh.myPeerId, _android: true });
  };

  // Stable reference to the active mesh — updated every time _nativeRtcReady fires.
  // _nativeBinary uses this instead of window._webrtcMesh directly because
  // _initRTC() can replace the mesh object (on reconnect) after _nativeBinary
  // was registered, leaving window._webrtcMesh pointing to the new mesh while
  // the binary listener is on the old one. _nativeRtcReady always fires on the
  // new mesh after _initRTC sets window._webrtcMesh, so capturing it here
  // guarantees _nativeBinary dispatches on the same object room.js listens to.
  let _activeMesh = null;

  window._nativeRtcReady = (peerId) => {
    _log('_nativeRtcReady — shared DC open for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcReady — no _webrtcMesh'); return; }
    _activeMesh = mesh;
    mesh._dcs.set(peerId, { readyState: 'open', _nativePeer: peerId });
    const leftoverIce = mesh._icePending.get(peerId);
    if (leftoverIce?.length) {
      _warn('_nativeRtcReady — flushing leftover ICE for', peerId.slice(0,8));
      mesh._icePending.delete(peerId);
      for (const c of leftoverIce) window.AndroidRtc.addIceCandidate(peerId, JSON.stringify(c));
    }
    const q = mesh._dcReady.get(peerId) || [];
    mesh._dcReady.delete(peerId);
    q.forEach(fn => fn());
    mesh.dispatchEvent(new CustomEvent('peer_ready', { detail: { peerId } }));
  };

  window._nativeRtcPoolReady = (peerId) => {
    _log('_nativeRtcPoolReady — all pool DCs open for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcPoolReady — no _webrtcMesh'); return; }

    // Guard: Kotlin fires _nativeRtcPoolReady with the remote peer ID.
    // If it matches myPeerId something has gone wrong in Kotlin's peer map.
    if (peerId === mesh.myPeerId) {
      _warn('_nativeRtcPoolReady — peerId equals myPeerId! Kotlin fired pool-ready with own ID.',
            '| peerId:', peerId.slice(0,8), '| myPeerId:', mesh.myPeerId.slice(0,8),
            '| Ignoring — this would make all sendPool calls target self, always missing in Kotlin peers map.');
      return;
    }

    // Verify Kotlin confirms the pool is actually open before exposing it to room.js.
    // isPoolReady() checks that peers[peerId].poolDcs has XFER_POOL_SIZE open DCs —
    // this closes the race where _nativeRtcPoolReady fires during the last DC's
    // onStateChange but a concurrent sendPool call races in before the DC list is full.
    if (!window.AndroidRtc.isPoolReady(peerId)) {
      _warn('_nativeRtcPoolReady — Kotlin fired pool-ready but isPoolReady() is false for',
            peerId.slice(0,8), '| deferring 50 ms');
      setTimeout(() => window._nativeRtcPoolReady(peerId), 50);
      return;
    }

    // Pool size must match XFER_POOL_SIZE in webrtc.js and NativeRtcBridge.kt (both = 8).
    // Previously hardcoded as 4 — caused room.js to stripe chunks across only 4 DCs
    // while Kotlin opened 8, leaving 4 DCs idle and halving potential throughput.
    const POOL_SIZE = 8;
    const pool = Array.from({ length: POOL_SIZE }, (_, i) => ({
      _nativePool: { peerId, index: i },
      label: `xferp-${i}`,
      readyState: 'open',
    }));
    _log('_nativeRtcPoolReady — created', POOL_SIZE, 'pool DC stubs for', peerId.slice(0,8));
    mesh._xferPool.set(peerId, pool);
    mesh._xferPoolResolve.get(peerId)?.(pool);
    mesh._xferPoolResolve.delete(peerId);
  };

  window._nativeRtcAnswer = (peerId, sdpJson) => {
    _log('_nativeRtcAnswer — forwarding answer for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcAnswer — no _webrtcMesh'); return; }
    mesh.sendSignal({ type: 'rtc_answer', targetId: peerId, sdp: JSON.parse(sdpJson), senderId: mesh.myPeerId, _android: true });
  };

  window._nativeRtcIce = (peerId, candidateJson) => {
    const mesh = window._webrtcMesh;
    if (!mesh) return;
    mesh.sendSignal({ type: 'rtc_ice', targetId: peerId, candidate: JSON.parse(candidateJson), senderId: mesh.myPeerId });
  };

  window._nativeRtcFailed = (peerId) => {
    _warn('_nativeRtcFailed — native PC failed for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) return;
    mesh.dispatchEvent(new CustomEvent('peer_failed', { detail: { peerId } }));
    mesh.removePeer(peerId);
  };

  // ── Progress / done / error callbacks from Kotlin ────────────────────────
  // These are wired in room.js where the fileStore lives.
  // Defined here as no-ops so they exist before room.js assigns them.
  window._nativeProgress    = null; // assigned by room.js
  window._nativeFileDone    = null; // assigned by room.js
  window._nativeFileError   = null; // assigned by room.js
  window._nativeRelayReceipt= null; // assigned by room.js

  // Inbound non-chunk frames (chat, lan_caps) forwarded from Kotlin.
  // Uses _activeMesh (captured in _nativeRtcReady) rather than window._webrtcMesh
  // so reconnects that replace the mesh object don't break the dispatch target.
  //
  // Kotlin strips the _sendOnDC transport header before forwarding (see
  // handleInboundFrame in NativeRtcBridge.kt), so `b64` here decodes to a
  // clean app frame starting at byte 0 — ready for room.js decodeDCFrame().
  window._nativeBinary = (peerId, b64) => {
    const mesh = _activeMesh || window._webrtcMesh;
    if (!mesh) { _warn('_nativeBinary — no mesh'); return; }
    _dbg('_nativeBinary from', peerId.slice(0,8), 'len=', b64.length);
    mesh.dispatchEvent(new CustomEvent('binary', { detail: { peerId, buffer: _fromB64(b64) } }));
  };

  // ── Native file picker callbacks ──────────────────────────────────────────

  // Override openFilePicker to ensure the native Kotlin picker always fires
  // and the WebView <input type=file> path is never reached for file transfers.
  // This is called by room.js / app.js when the user triggers a file pick action.
  // On Android, we call AndroidRtc.openFilePicker() which fires the Kotlin
  // filePickerCallback → nativeFilePickerLauncher in MainActivity → system picker.
  // The result flows back via _nativeFilePicked, never through WebChromeClient.
  proto.openFilePicker = function() {
    _log('openFilePicker — calling AndroidRtc.openFilePicker() (native Kotlin path)');
    window.AndroidRtc.openFilePicker();
  };

  window._nativeFilePicked = (files) => {
    _log('_nativeFilePicked ✓ NATIVE PICKER — count=', files.length,
         '| this confirms the native Kotlin picker ran, NOT the WebView <input type=file>');
    window.dispatchEvent(new CustomEvent('native-files-picked', {
      detail: { files: files.map(f => new NativeFile(f)) }
    }));
  };

  class NativeFile {
    constructor({ token, name, mime, size }) {
      this._token = token;
      this.name   = name;
      this.size   = size;
      this.type   = mime;
      this.lastModified = Date.now();
      _log('NativeFile created — token=', token.slice(0,8), 'name=', name,
           'size=', size, '| fast-path: sendChunk() will call readAndSendChunk()');
    }
    async arrayBuffer() {
      _warn('NativeFile.arrayBuffer() called — SLOW PATH (reads via bridge base64)', this.name);
      return _readNativeRange(this._token, 0, this.size);
    }
    slice(start = 0, end = this.size) {
      return new NativeBlob(this._token, start, end - start, this.type);
    }
    release() {
      _log('NativeFile.release() token=', this._token.slice(0,8));
      window.AndroidRtc.releaseFileToken(this._token);
    }

    /**
     * Fast-path outbound send for file chunks.
     * Delegates to NativeBlob.sendChunk() — see that method for full docs.
     */
    sendChunk(offset, length, peerId, poolIndex, fileIdHex, chunkIndex, totalChunks, encryptedFlag = true) {
      return this.slice(offset, offset + length)
                 .sendChunk(peerId, poolIndex, fileIdHex, chunkIndex, totalChunks, encryptedFlag);
    }
  }

  class NativeBlob {
    constructor(token, offset, length, type) {
      this._token = token; this._offset = offset;
      this._length = length; this.size = length; this.type = type;
    }
    async arrayBuffer() {
      _warn('NativeBlob.arrayBuffer() called — SLOW PATH (reads via bridge base64) offset=', this._offset);
      return _readNativeRange(this._token, this._offset, this._length);
    }

    /**
     * Fast-path outbound send — eliminates the double base64 round-trip.
     *
     * Instead of:
     *   readFileChunk() → base64 → _fromB64() → encrypt → _toB64() → sendPool() → Kotlin decode
     * this issues a single @JavascriptInterface call and lets Kotlin handle everything:
     *   read chunk → encrypt (AES-GCM, session key) → build 26-byte DC header → dc.send()
     *
     * @param {string}  peerId        - destination peer UUID
     * @param {number}  poolIndex     - pool DC index (0–7)
     * @param {string}  fileIdHex     - UUID (dashes OK — Kotlin strips them)
     * @param {number}  chunkIndex    - 0-based chunk sequence number
     * @param {number}  totalChunks   - total chunks for this transfer
     * @param {boolean} [encryptedFlag=true] - pass false only for unencrypted debug transfers
     * @returns {boolean} false if Kotlin reports a send failure (caller should abort transfer)
     */
    sendChunk(peerId, poolIndex, fileIdHex, chunkIndex, totalChunks, encryptedFlag = true) {
      if (typeof window.AndroidRtc.readAndSendChunk !== 'function') {
        _warn('sendChunk — AndroidRtc.readAndSendChunk NOT available — Kotlin build outdated, returning false');
        return false;
      }
      _dbg('sendChunk FAST-PATH → readAndSendChunk',
           '| pool:', poolIndex, '| chunk:', chunkIndex, '/', totalChunks,
           '| offset:', this._offset, '| len:', this._length);
      return window.AndroidRtc.readAndSendChunk(
        this._token,
        this._offset,
        this._length,
        peerId,
        poolIndex,
        fileIdHex,
        chunkIndex,
        totalChunks,
        encryptedFlag,
      );
    }
  }

  async function _readNativeRange(token, offset, length) {
    if (length <= 0) return new ArrayBuffer(0);
    const b64 = window.AndroidRtc.readFileChunk(token, offset, length);
    if (!b64) return new ArrayBuffer(0);
    return _fromB64(b64);
  }

  // ── Frame helpers ─────────────────────────────────────────────────────────

  /**
   * Wrap [bytes] with the _sendOnDC transport header for a single-fragment
   * (total=1) message.  All outbound shared-DC frames must carry this header
   * so the desktop peer's _handleFrame() can strip it identically to the frames
   * it sends itself via _sendOnDC.
   *
   * Layout (mirrors _sendOnDC in webrtc.js):
   *   [transferId(u32 LE) | total=1(u32 LE) | index=0(u32 LE) | payload bytes]
   */
  function _wrapSingleFragment(bytes) {
    const frame = new ArrayBuffer(12 + bytes.byteLength);
    const view  = new DataView(frame);
    view.setUint32(0, (Math.random() * 0xFFFFFFFF) >>> 0, true); // transferId (random, matches desktop)
    view.setUint32(4, 1, true);                                   // total = 1 (single fragment)
    view.setUint32(8, 0, true);                                   // index = 0
    new Uint8Array(frame, 12).set(new Uint8Array(bytes));
    return frame;
  }

  function _toB64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function _fromB64(b64) {
    const bin   = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  _log('✓ WebRTCMesh patched for native WebRTC');
} // end _isAndroid block
} // end initAndroidBridge