// ── webrtc_android_bridge.js ─────────────────────────────────────────────────
// Call initAndroidBridge(WebRTCMesh) after importing WebRTCMesh.
// When running inside the Android WebView with window.AndroidRtc present it
// monkey-patches WebRTCMesh so all desktop↔Android connections use native
// WebRTC instead of the browser stack.
//
// ── Binary port architecture (replaces evalJs + base64 delivery) ─────────────
//  • MainActivity posts one end of a WebMessagePort to the page as a transferable
//    in a window message with data === "rtc-port".
//  • initAndroidBridge() stores the port in _rtcPort and wires port.onmessage.
//  • Inbound frames (Kotlin→JS): port.onmessage fires with event.data as
//    ArrayBuffer. Wire format:
//      [36 bytes peerId ASCII, space-padded][raw frame bytes]
//    JS slices the first 36 bytes, decodes as UTF-8, trims padding → peerId.
//    The rest is the raw DC frame passed directly to mesh._handleFrame().
//    No base64. No main-looper round-trip.
//  • Outbound frames (JS→Kotlin): sendBinary / sendOnChannel post binary
//    ArrayBuffers to the port with this header prepended:
//      [1 byte channel type: 0x00=shared, 0x01..0x04=pool DC 0..3]
//      [36 bytes peerId ASCII, space-padded]
//      [frame bytes]
//    Kotlin's WebMessageCallback receives WebMessage.data as ByteArray,
//    routes to the correct DataChannel, and sends. Zero base64.
//  • Fallback: if _rtcPort is not yet set (race during init), the old
//    AndroidRtc.sendShared/sendPool/@JavascriptInterface path is used.
//    window._nativeRtcChunk is also kept as a fallback receive path for the
//    same race window.
//
// ── Native file picker ────────────────────────────────────────────────────────
//  • room.js / UI calls window.AndroidRtc.openFilePicker() instead of
//    triggering an <input type=file> click. Kotlin launches the system picker.
//  • On completion, Kotlin calls window._nativeFilePicked(jsonArrayStr) with
//    [{token, name, mime, size}, …]. JS builds synthetic File-like objects and
//    hands them to room.shareFile() / the existing upload flow.
//  • JS reads file data via AndroidRtc.readFileChunk(token, offset, length)
//    (returns base64). This keeps the Chunker.chunkFile generator pattern intact
//    while never materialising the whole file in JS heap.
//  • On transfer complete JS calls AndroidRtc.releaseFileToken(token).
//
// ── _saveFile port path ───────────────────────────────────────────────────────
//  • room.js _saveFile() detects AndroidRtc and calls AndroidRtc.saveFile()
//    with a base64 payload (legacy). The binary port path for received files is
//    a follow-on optimisation — for now the base64 path is preserved for save.

// ── Internal log helper ───────────────────────────────────────────────────────
const _log  = (...a) => console.log ('[android-bridge]', ...a);
const _dbg  = (...a) => console.debug('[android-bridge]', ...a);
const _warn = (...a) => console.warn ('[android-bridge]', ...a);

// Binary port — assigned from window.onmessage when Kotlin posts "rtc-port".
// Shared across all mesh patches so sendBinary/sendOnChannel can use it.
let _rtcPort = null;

// Set up the port receiver immediately at module load time so we don't miss
// the postWebMessage if initAndroidBridge() is called slightly after page load.
// The mesh reference is needed only in _nativeRtcChunk / port.onmessage, so
// we grab window._webrtcMesh lazily inside the handler.
window.addEventListener('message', (e) => {
  if (e.data !== 'rtc-port') return;
  const port = e.ports?.[0];
  if (!port) { _warn('rtc-port message received but no port in e.ports'); return; }
  _rtcPort = port;
  port.start();

  port.onmessage = (ev) => {
    // Inbound binary frame: [36-byte peerId][frame]
    const buf = ev.data;
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 36) {
      _warn('port.onmessage — unexpected data', typeof buf); return;
    }
    const peerIdRaw = new TextDecoder().decode(new Uint8Array(buf, 0, 36));
    const peerId    = peerIdRaw.trimEnd(); // remove space padding
    const frame     = buf.slice(36);

    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('port.onmessage — no _webrtcMesh on window'); return; }
    mesh._handleFrame(peerId, frame);
  };

  _log('✓ binary RTC port received from Kotlin');
});

// Peer-id header size used in outbound port messages.
const _PEER_ID_HDR = 36;

/** Encode outbound frame for the binary port: [channelByte][peerId36][frame] */
function _portFrame(channelByte, peerId, frameBuffer) {
  const frameBytes = frameBuffer instanceof ArrayBuffer ? frameBuffer : frameBuffer.buffer;
  const out        = new ArrayBuffer(1 + _PEER_ID_HDR + frameBytes.byteLength);
  const view       = new Uint8Array(out);
  view[0]          = channelByte;
  // Write peerId as ASCII, space-padded to 36 bytes.
  const peerIdBytes = new TextEncoder().encode(peerId.padEnd(_PEER_ID_HDR));
  view.set(peerIdBytes, 1);
  view.set(new Uint8Array(frameBytes), 1 + _PEER_ID_HDR);
  return out;
}

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
    _log('already patched — skipping');
    return;
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
      _log('addPeer — Android is initiator for', peerId.slice(0,8),
        '— calling AndroidRtc.createOffer');
      window.AndroidRtc.createOffer(peerId);
    } else {
      _log('addPeer — Android is responder for', peerId.slice(0,8),
        '— waiting for desktop rtc_offer via signal channel');
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
    _log('removePeer (JS/browser path) for', peerId.slice(0,8));
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
        _warn('rtc_offer from', senderId.slice(0,8),
          '— real RTCPeerConnection already in _pcs (unexpected); falling through to JS path');
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
        for (const c of pendingIce) {
          window.AndroidRtc.addIceCandidate(senderId, JSON.stringify(c));
        }
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
  // Binary port path: no _splitToFrames, no base64.
  // The frame goes as a single port message. Kotlin's sendBytes() handles DC
  // fragmentation (its splitFrame mirrors the old JS _splitToFrames).
  const _origSendBinary = proto.sendBinary;
  proto.sendBinary = async function(peerId, buffer) {
    const pc = this._pcs.get(peerId);
    if (!pc?._native) return _origSendBinary.call(this, peerId, buffer);

    _dbg('sendBinary (native shared DC)', peerId.slice(0,8));

    if (_rtcPort) {
      // Binary port: channel 0x00 = shared DC.
      const out = _portFrame(0x00, peerId, buffer);
      _rtcPort.postMessage(out, [out]);
    } else {
      // Fallback: base64 via @JavascriptInterface (port not ready yet).
      _warn('sendBinary — port not ready, falling back to base64 sendShared');
      const frames = _splitToFrames(buffer);
      for (const frame of frames) {
        const b64 = _toB64(frame);
        const ok  = window.AndroidRtc.sendShared(peerId, b64);
        if (!ok) throw new Error(`[android-bridge] sendShared failed for ${peerId.slice(0,8)}`);
      }
    }
  };

  // ── getPoolChannels ───────────────────────────────────────────────────────
  const _origGetPoolChannels = proto.getPoolChannels;
  proto.getPoolChannels = function(peerId, timeoutMs = 10_000) {
    const pc = this._pcs.get(peerId);
    if (!pc?._native) return _origGetPoolChannels.call(this, peerId, timeoutMs);

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

  // ── sendOnChannel — native pool proxy ────────────────────────────────────
  // Binary port path: channel byte 0x01..0x04 = pool DC index 0..3.
  // No _splitToFrames, no base64. Kotlin handles DC fragmentation.
  const _origSendOnChannel = proto.sendOnChannel;
  proto.sendOnChannel = function(dc, buffer) {
    if (!dc._nativePool) return _origSendOnChannel.call(this, dc, buffer);

    const { peerId, index } = dc._nativePool;
    _dbg('sendOnChannel (native pool)', peerId.slice(0,8), '| channel index:', index);

    return Promise.resolve().then(() => {
      if (_rtcPort) {
        // Binary port: channel byte 0x01..0x04 for pool index 0..3.
        const channelByte = 0x01 + index;
        const out = _portFrame(channelByte, peerId, buffer);
        _rtcPort.postMessage(out, [out]);
      } else {
        // Fallback: base64 via @JavascriptInterface.
        _warn('sendOnChannel — port not ready, falling back to base64 sendPool');
        const frames = _splitToFrames(buffer);
        for (const frame of frames) {
          const b64 = _toB64(frame);
          window.AndroidRtc.sendPool(peerId, index, b64);
        }
      }
    });
  };

  // ── Native → JS callbacks ─────────────────────────────────────────────────

  window._nativeRtcOffer = (peerId, sdpJson) => {
    _log('_nativeRtcOffer — forwarding offer for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcOffer — no _webrtcMesh'); return; }
    mesh.sendSignal({ type: 'rtc_offer', targetId: peerId, sdp: JSON.parse(sdpJson), senderId: mesh.myPeerId, _android: true });
  };

  window._nativeRtcReady = (peerId) => {
    _log('_nativeRtcReady — shared DC open for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcReady — no _webrtcMesh'); return; }
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
    const pool = Array.from({ length: 4 }, (_, i) => ({
      _nativePool: { peerId, index: i },
      label: `xferp-${i}`,
      readyState: 'open',
    }));
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

  // Fallback receive path: used when the binary port is not yet set up.
  // Once _rtcPort is wired, port.onmessage at the top of this file handles
  // all frames directly and this callback is never called for new peers.
  window._nativeRtcChunk = (peerId, b64Payload) => {
    if (_rtcPort) return; // already handled by port.onmessage — shouldn't fire
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcChunk — no _webrtcMesh'); return; }
    mesh._handleFrame(peerId, _fromB64(b64Payload));
  };

  window._nativeRtcFailed = (peerId) => {
    _warn('_nativeRtcFailed — native PC failed for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) return;
    mesh.dispatchEvent(new CustomEvent('peer_failed', { detail: { peerId } }));
    mesh.removePeer(peerId);
  };

  // ── Native file picker callbacks ──────────────────────────────────────────

  /**
   * Kotlin calls this when the system file picker returns.
   * files: JSON array string of [{token, name, mime, size}, …]
   *
   * Constructs NativeFile objects (match the File API subset used by room.js
   * Chunker.chunkFile + shareFile) and dispatches them to the upload flow.
   * JS reads file data via AndroidRtc.readFileChunk(token, offset, length).
   */
  window._nativeFilePicked = (files) => {
    _log('_nativeFilePicked count=', files.length);
    // Dispatch a synthetic CustomEvent so any UI layer can subscribe.
    // room.js / app.js should listen for 'native-files-picked' and call
    // room.shareFile(nativeFile) for each entry.
    window.dispatchEvent(new CustomEvent('native-files-picked', {
      detail: { files: files.map(f => new NativeFile(f)) }
    }));
  };

  /**
   * NativeFile — a File-API-compatible wrapper around a Kotlin-side picked file.
   * Supports .name, .size, .type (all File properties used by room.js).
   * Supports arrayBuffer() and slice() used by Chunker.chunkFile — both
   * implemented via AndroidRtc.readFileChunk (base64 per-chunk).
   *
   * IMPORTANT: Chunker.chunkFile() calls slice() to read ranges. We implement
   * slice() to return a NativeBlob that reads the given byte range on demand via
   * readFileChunk. This means file data is read in chunks, never fully in heap.
   */
  class NativeFile {
    constructor({ token, name, mime, size }) {
      this._token = token;
      this.name   = name;
      this.size   = size;
      this.type   = mime;
      this.lastModified = Date.now();
    }

    /** Read this.size bytes starting at 0 — used by Chunker for small files. */
    async arrayBuffer() {
      return _readNativeRange(this._token, 0, this.size);
    }

    /** Mimic Blob.slice — Chunker.chunkFile calls file.slice(start, end). */
    slice(start = 0, end = this.size) {
      return new NativeBlob(this._token, start, end - start, this.type);
    }

    /** Release the Kotlin-side token when done. */
    release() {
      window.AndroidRtc.releaseFileToken(this._token);
    }
  }

  class NativeBlob {
    constructor(token, offset, length, type) {
      this._token  = token;
      this._offset = offset;
      this._length = length;
      this.size    = length;
      this.type    = type;
    }
    async arrayBuffer() {
      return _readNativeRange(this._token, this._offset, this._length);
    }
  }

  /**
   * Read [length] bytes starting at [offset] from a picked file via Kotlin.
   * Returns an ArrayBuffer. Kotlin returns base64 (per-call cost acceptable
   * because Chunker.chunkFile reads at most one chunk per call).
   */
  async function _readNativeRange(token, offset, length) {
    if (length <= 0) return new ArrayBuffer(0);
    const b64 = window.AndroidRtc.readFileChunk(token, offset, length);
    if (!b64) return new ArrayBuffer(0);
    return _fromB64(b64);
  }

  // ── Frame helpers (fallback base64 path only) ─────────────────────────────

  const DC_CHUNK = 64 * 1024;

  function _splitToFrames(buffer) {
    const bytes      = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
    const total      = Math.ceil(bytes.byteLength / DC_CHUNK) || 1;
    const transferId = (Math.random() * 0xFFFFFFFF) >>> 0;
    const frames     = [];
    for (let i = 0; i < total; i++) {
      const offset     = i * DC_CHUNK;
      const chunkBytes = Math.min(DC_CHUNK, bytes.byteLength - offset);
      const frame      = new ArrayBuffer(12 + chunkBytes);
      const view       = new DataView(frame);
      view.setUint32(0, transferId, true);
      view.setUint32(4, total,      true);
      view.setUint32(8, i,          true);
      new Uint8Array(frame, 12).set(new Uint8Array(bytes, offset, chunkBytes));
      frames.push(frame);
    }
    return frames;
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

  _log('✓ WebRTCMesh patched for native WebRTC (binary port path active)');
} // end _isAndroid block
} // end initAndroidBridge