// ── webrtc_android_bridge.js ─────────────────────────────────────────────────
// Patches WebRTCMesh to use native Kotlin WebRTC on Android.
//
// Architecture:
//  • Signaling (offer/answer/ICE) flows JS ↔ Kotlin via @JavascriptInterface
//  • Outbound file chunks: JS encodes to base64, calls AndroidRtc.sendShared/sendPool
//  • Inbound file chunks: Kotlin receives DC frames, reassembles, decrypts, saves
//    to MediaStore — JS never touches binary data on the receive path
//  • JS-only responsibility: UI callbacks (_nativeProgress, _nativeFileDone, etc.)
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
  // JS → Kotlin: encode frame as base64, call @JavascriptInterface sendShared.
  // Kotlin handles DC fragmentation via splitFrame().
  const _origSendBinary = proto.sendBinary;
  proto.sendBinary = async function(peerId, buffer) {
    const pc = this._pcs.get(peerId);
    if (!pc?._native) return _origSendBinary.call(this, peerId, buffer);
    _dbg('sendBinary (native shared DC)', peerId.slice(0,8));
    const frames = _splitToFrames(buffer);
    for (const frame of frames) {
      const ok = window.AndroidRtc.sendShared(peerId, _toB64(frame));
      if (!ok) throw new Error(`[android-bridge] sendShared failed for ${peerId.slice(0,8)}`);
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

  // ── sendOnChannel — native pool DC ───────────────────────────────────────
  // JS → Kotlin: encode frame as base64, call @JavascriptInterface sendPool.
  const _origSendOnChannel = proto.sendOnChannel;
  proto.sendOnChannel = function(dc, buffer) {
    if (!dc._nativePool) return _origSendOnChannel.call(this, dc, buffer);
    const { peerId, index } = dc._nativePool;
    _dbg('sendOnChannel (native pool)', peerId.slice(0,8), '| channel index:', index);
    return Promise.resolve().then(() => {
      const frames = _splitToFrames(buffer);
      for (const frame of frames) window.AndroidRtc.sendPool(peerId, index, _toB64(frame));
    });
  };

  // ── Kotlin → JS callbacks ─────────────────────────────────────────────────

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

  // ── Native file picker callbacks ──────────────────────────────────────────

  window._nativeFilePicked = (files) => {
    _log('_nativeFilePicked count=', files.length);
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
    }
    async arrayBuffer() { return _readNativeRange(this._token, 0, this.size); }
    slice(start = 0, end = this.size) {
      return new NativeBlob(this._token, start, end - start, this.type);
    }
    release() { window.AndroidRtc.releaseFileToken(this._token); }
  }

  class NativeBlob {
    constructor(token, offset, length, type) {
      this._token = token; this._offset = offset;
      this._length = length; this.size = length; this.type = type;
    }
    async arrayBuffer() { return _readNativeRange(this._token, this._offset, this._length); }
  }

  async function _readNativeRange(token, offset, length) {
    if (length <= 0) return new ArrayBuffer(0);
    const b64 = window.AndroidRtc.readFileChunk(token, offset, length);
    if (!b64) return new ArrayBuffer(0);
    return _fromB64(b64);
  }

  // ── Frame helpers (outbound only) ─────────────────────────────────────────

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

  _log('✓ WebRTCMesh patched for native WebRTC');
} // end _isAndroid block
} // end initAndroidBridge