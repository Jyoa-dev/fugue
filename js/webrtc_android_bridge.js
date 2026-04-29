// ── webrtc_android_bridge.js ─────────────────────────────────────────────────
// Import this AFTER webrtc.js. When running inside the Android WebView with
// window.AndroidRtc present, it monkey-patches WebRTCMesh so all
// desktop↔Android connections use native WebRTC instead of the browser stack.
//
// Everything else (desktop↔desktop, Android↔Android via LAN) is unchanged.
// The JS assembler, pool logic, and binary event format are fully reused.
//
// How it works
// ────────────
//  • _createPC(peerId)  → creates a NativeRtcBridge PC instead of RTCPeerConnection
//  • addPeer / handleSignal → forward offer/answer/ICE through AndroidRtc.*
//  • Native layer fires window._nativeRtc{Ready,PoolReady,Answer,Ice,Chunk,Failed}
//    callbacks which re-enter the mesh as if they came from a real DC/PC.
//
// The shim is a no-op on desktop (window.AndroidRtc is undefined).
//
// ── BUG FIX (desktop→Android path) ──────────────────────────────────────────
// Previously, handleSignal's rtc_offer branch called _origHandleSignal as a
// fallback for non-native peers. However, _origHandleSignal itself calls
// _createPC() when no PC exists yet — which creates a real RTCPeerConnection
// and stores it in _pcs BEFORE this bridge can store the native sentinel.
//
// The patched handleSignal now owns ALL offer/answer/ice handling on Android.
// It classifies each peer itself (native sentinel already in _pcs → native path,
// real RTCPeerConnection already in _pcs → JS path, nothing in _pcs → create
// native sentinel first, then native path). _origHandleSignal is only called
// for non-WebRTC message types (LAN caps etc.).

const _isAndroid = typeof window.AndroidRtc !== 'undefined';

// ── Internal log helper ───────────────────────────────────────────────────────
// Prefix every bridge log consistently. Replace with your own logger if needed.
const _log  = (...a) => console.log ('[android-bridge]', ...a);
const _dbg  = (...a) => console.debug('[android-bridge]', ...a);
const _warn = (...a) => console.warn ('[android-bridge]', ...a);

_log(_isAndroid
  ? 'AndroidRtc detected — will patch WebRTCMesh'
  : 'no AndroidRtc — desktop mode, no patch applied');

if (_isAndroid) {

  // ── Patch WebRTCMesh prototype ────────────────────────────────────────────

  const proto = WebRTCMesh.prototype;

  // ── addPeer ───────────────────────────────────────────────────────────────
  // Replaces RTCPeerConnection creation with a native PC on Android.
  // The peer that has the lexicographically larger id is the initiator
  // (same rule as the original).  On Android we are always the answerer
  // for desktop→Android calls (desktop sends the offer via the signal channel).
  const _origAddPeer = proto.addPeer;
  proto.addPeer = async function(peerId) {
    _log('addPeer called for', peerId.slice(0,8));

    if (this._pcs.has(peerId)) {
      const existing = this._pcs.get(peerId);
      _log('addPeer skipped — already exists', peerId.slice(0,8),
        '| native:', !!existing._native,
        '| state:', existing.connectionState);
      return;
    }

    _log('addPeer — creating native PC for', peerId.slice(0,8));

    // Sentinel so _pcs.has() / removePeer() still work.
    this._pcs.set(peerId, { _native: true, connectionState: 'new', close() {} });

    // Tell native layer to create the PeerConnection.
    _log('→ AndroidRtc.createPeerConnection(', peerId.slice(0,8), ')');
    window.AndroidRtc.createPeerConnection(peerId);

    // If this device is the initiator, create and send an offer natively.
    // (Desktop→Android: desktop is initiator; this branch handles Android→desktop.)
    if (this.myPeerId > peerId) {
      // Android-initiated: not the common path, but supported.
      _log('addPeer — Android is initiator for', peerId.slice(0,8),
        '— waiting for native offer from AndroidRtc layer');
      // Native layer doesn't currently self-create offers; extend here if needed.
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
      _log('→ AndroidRtc.closePeer(', peerId.slice(0,8), ')');
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
  // ── FIX ──────────────────────────────────────────────────────────────────
  // This method now OWNS all rtc_offer / rtc_answer / rtc_ice handling on
  // Android. It no longer delegates to _origHandleSignal for those types.
  //
  // Why this matters for desktop→Android:
  //   When a desktop peer sends rtc_offer, the base handleSignal (webrtc.js)
  //   would have been called first (via prototype chain). It checks
  //   _pcs.get(senderId) and, finding nothing, calls _createPC() which creates
  //   a real RTCPeerConnection — *before* this bridge's sentinel is stored.
  //   After that, every _native check fails because the stored object is a real
  //   RTCPeerConnection (pc._native is undefined).
  //
  //   By owning the full signal dispatch here, the bridge intercepts the offer
  //   before _origHandleSignal runs and ensures the native sentinel is always
  //   stored first. Only non-WebRTC messages fall through to _origHandleSignal.
  const _origHandleSignal = proto.handleSignal;
  proto.handleSignal = async function(msg) {
    const { type, senderId } = msg;

    _dbg('handleSignal type=', type, 'from', senderId.slice(0,8));

    // ── rtc_offer ─────────────────────────────────────────────────────────
    if (type === 'rtc_offer') {
      const existing = this._pcs.get(senderId);

      // If a real RTCPeerConnection is already stored, this is a desktop↔desktop
      // peer that got here before the bridge ran (shouldn't happen, but guard it).
      if (existing && !existing._native) {
        _warn('rtc_offer from', senderId.slice(0,8),
          '— real RTCPeerConnection already in _pcs (unexpected on Android); '
          + 'falling through to JS path');
        return _origHandleSignal.call(this, msg);
      }

      // If no native PC exists yet, create one now.
      // This is the normal desktop→Android path: desktop sends the offer
      // without us having called addPeer first.
      if (!existing) {
        _log('rtc_offer from', senderId.slice(0,8),
          '— no PC yet, creating native sentinel + AndroidRtc PC');
        this._pcs.set(senderId, { _native: true, connectionState: 'new', close() {} });
        _log('→ AndroidRtc.createPeerConnection(', senderId.slice(0,8), ')');
        window.AndroidRtc.createPeerConnection(senderId);
      } else {
        _log('rtc_offer from', senderId.slice(0,8),
          '— native sentinel already present (addPeer was called first)');
      }

      _log('rtc_offer → AndroidRtc.setRemoteOffer(', senderId.slice(0,8), ')');
      window.AndroidRtc.setRemoteOffer(senderId, JSON.stringify(msg.sdp));
      return;
    }

    // ── rtc_answer ────────────────────────────────────────────────────────
    if (type === 'rtc_answer') {
      const pc = this._pcs.get(senderId);

      if (!pc) {
        _warn('rtc_answer from', senderId.slice(0,8),
          '— no PC in _pcs at all; dropping (unexpected)');
        return;
      }

      if (!pc._native) {
        _dbg('rtc_answer from', senderId.slice(0,8), '— JS/browser peer, passing through');
        return _origHandleSignal.call(this, msg);
      }

      _log('rtc_answer → AndroidRtc.setRemoteAnswer(', senderId.slice(0,8), ')');
      window.AndroidRtc.setRemoteAnswer(senderId, JSON.stringify(msg.sdp));
      return;
    }

    // ── rtc_ice ───────────────────────────────────────────────────────────
    if (type === 'rtc_ice') {
      const pc = this._pcs.get(senderId);

      if (!pc) {
        // ICE can arrive before the offer (especially on fast networks).
        // Buffer it in _icePending so it can be applied once the offer arrives.
        _warn('rtc_ice from', senderId.slice(0,8),
          '— no PC yet; buffering candidate in _icePending');
        if (!this._icePending.has(senderId)) this._icePending.set(senderId, []);
        if (msg.candidate) this._icePending.get(senderId).push(msg.candidate);
        return;
      }

      if (!pc._native) {
        _dbg('rtc_ice from', senderId.slice(0,8), '— JS/browser peer, passing through');
        return _origHandleSignal.call(this, msg);
      }

      if (msg.candidate) {
        _dbg('rtc_ice → AndroidRtc.addIceCandidate(', senderId.slice(0,8), ')');
        window.AndroidRtc.addIceCandidate(senderId, JSON.stringify(msg.candidate));
      } else {
        _dbg('rtc_ice from', senderId.slice(0,8), '— end-of-candidates marker, ignoring');
      }
      return;
    }

    // Not a WebRTC message (LAN caps etc.) — pass through.
    _dbg('handleSignal — non-WebRTC type', type, '— passing through to base');
    return _origHandleSignal.call(this, msg);
  };

  // ── hasChannel ────────────────────────────────────────────────────────────
  const _origHasChannel = proto.hasChannel;
  proto.hasChannel = function(peerId) {
    const pc = this._pcs.get(peerId);
    if (pc?._native) {
      const ready = window.AndroidRtc.isPoolReady(peerId);
      _dbg('hasChannel (native)', peerId.slice(0,8), '→', ready);
      return ready;
    }
    return _origHasChannel.call(this, peerId);
  };

  // ── sendBinary (shared DC) ────────────────────────────────────────────────
  const _origSendBinary = proto.sendBinary;
  proto.sendBinary = async function(peerId, buffer) {
    const pc = this._pcs.get(peerId);
    if (!pc?._native) return _origSendBinary.call(this, peerId, buffer);

    _dbg('sendBinary (native shared DC)', peerId.slice(0,8),
      '| bytes:', buffer.byteLength ?? buffer.buffer?.byteLength ?? '?');

    // Encode and send through native shared DC.
    const frames = _splitToFrames(buffer);
    _dbg('sendBinary — split into', frames.length, 'frame(s) for', peerId.slice(0,8));
    for (const [i, frame] of frames.entries()) {
      const b64 = _toB64(frame);
      _dbg('sendBinary — AndroidRtc.sendShared frame', i + 1, '/', frames.length,
        'for', peerId.slice(0,8));
      const ok  = window.AndroidRtc.sendShared(peerId, b64);
      if (!ok) throw new Error(`[android-bridge] sendShared failed for ${peerId.slice(0,8)}`);
    }
  };

  // ── getPoolChannels ───────────────────────────────────────────────────────
  // Returns a Promise<proxy[]> where each proxy mimics RTCDataChannel enough
  // for room.js to call sendOnChannel(dc, buffer) on it.
  const _origGetPoolChannels = proto.getPoolChannels;
  proto.getPoolChannels = function(peerId, timeoutMs = 10_000) {
    const pc = this._pcs.get(peerId);
    if (!pc?._native) return _origGetPoolChannels.call(this, peerId, timeoutMs);

    _log('getPoolChannels (native)', peerId.slice(0,8));

    // Check if pool is already flagged ready.
    if (this._xferPool.has(peerId)) {
      _log('getPoolChannels (native) — pool already ready for', peerId.slice(0,8));
      return Promise.resolve(this._xferPool.get(peerId));
    }

    _log('getPoolChannels (native) — waiting for _nativeRtcPoolReady callback',
      peerId.slice(0,8), '| timeout:', timeoutMs, 'ms');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        _warn('getPoolChannels (native) — TIMEOUT waiting for pool', peerId.slice(0,8));
        this._xferPoolResolve.delete(peerId);
        reject(new Error(`[android-bridge] pool timeout ${peerId.slice(0,8)}`));
      }, timeoutMs);

      this._xferPoolResolve.set(peerId, pool => {
        clearTimeout(timer);
        _log('getPoolChannels (native) — pool resolved for', peerId.slice(0,8));
        resolve(pool);
      });

      // Race: pool may be ready already.
      if (this._xferPool.has(peerId)) {
        clearTimeout(timer);
        this._xferPoolResolve.delete(peerId);
        _log('getPoolChannels (native) — pool became ready during registration',
          peerId.slice(0,8));
        resolve(this._xferPool.get(peerId));
      }
    });
  };

  // ── sendOnChannel — native pool proxy ────────────────────────────────────
  // room.js calls: await mesh.sendOnChannel(pool[i], buffer)
  // pool[i] is a NativePoolProxy (see _nativeRtcPoolReady below).
  const _origSendOnChannel = proto.sendOnChannel;
  proto.sendOnChannel = function(dc, buffer) {
    if (!dc._nativePool) return _origSendOnChannel.call(this, dc, buffer);

    const { peerId, index } = dc._nativePool;
    const frames = _splitToFrames(buffer);
    _dbg('sendOnChannel (native pool)', peerId.slice(0,8),
      '| channel index:', index,
      '| frames:', frames.length);

    // Return a Promise that resolves after all frames are dispatched (no back-pressure
    // needed here — native layer handles its own SCTP buffering).
    return Promise.resolve().then(() => {
      for (const [i, frame] of frames.entries()) {
        const b64 = _toB64(frame);
        _dbg('sendOnChannel → AndroidRtc.sendPool', peerId.slice(0,8),
          '| pool index:', index, '| frame:', i + 1, '/', frames.length);
        window.AndroidRtc.sendPool(peerId, index, b64);
      }
    });
  };

  // ── Native → JS callbacks ─────────────────────────────────────────────────

  // Shared DC is open → peer_ready event (mirrors _setupDC onopen).
  window._nativeRtcReady = (peerId) => {
    _log('_nativeRtcReady — shared DC open for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcReady — no _webrtcMesh on window!'); return; }

    // Synthesise a minimal shared DC proxy for hasChannel / sendBinary.
    const fakeSharedDc = { readyState: 'open', _nativePeer: peerId };
    mesh._dcs.set(peerId, fakeSharedDc);

    // Flush any pending ICE candidates that arrived before the offer (buffered
    // in handleSignal's rtc_ice branch when no PC existed yet).
    const bufferedIce = mesh._icePending.get(peerId);
    if (bufferedIce?.length) {
      _log('_nativeRtcReady — flushing', bufferedIce.length,
        'buffered ICE candidate(s) for', peerId.slice(0,8));
      mesh._icePending.delete(peerId);
      for (const c of bufferedIce) {
        _dbg('→ AndroidRtc.addIceCandidate (flushed)', peerId.slice(0,8));
        window.AndroidRtc.addIceCandidate(peerId, JSON.stringify(c));
      }
    }

    // Flush any queued DC-ready callbacks.
    const q = mesh._dcReady.get(peerId) || [];
    mesh._dcReady.delete(peerId);
    if (q.length) _log('_nativeRtcReady — flushing', q.length, 'dcReady callback(s)');
    q.forEach(fn => fn());

    _log('_nativeRtcReady — dispatching peer_ready for', peerId.slice(0,8));
    mesh.dispatchEvent(new CustomEvent('peer_ready', { detail: { peerId } }));
  };

  // All 4 pool DCs open → build proxy array and resolve getPoolChannels.
  window._nativeRtcPoolReady = (peerId) => {
    _log('_nativeRtcPoolReady — all pool DCs open for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcPoolReady — no _webrtcMesh on window!'); return; }

    const pool = Array.from({ length: 4 }, (_, i) => ({
      _nativePool: { peerId, index: i },
      label: `xferp-${i}`,
      readyState: 'open',
    }));
    _log('_nativeRtcPoolReady — pool proxy array built (4 channels) for', peerId.slice(0,8));
    mesh._xferPool.set(peerId, pool);
    mesh._xferPoolResolve.get(peerId)?.(pool);
    mesh._xferPoolResolve.delete(peerId);
  };

  // Native layer produced an answer SDP → forward through the signal channel.
  window._nativeRtcAnswer = (peerId, sdpJson) => {
    _log('_nativeRtcAnswer — forwarding answer via signal channel for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcAnswer — no _webrtcMesh on window!'); return; }
    mesh.sendSignal({
      type:     'rtc_answer',
      targetId: peerId,
      sdp:      JSON.parse(sdpJson),
      senderId: mesh.myPeerId,
    });
    _log('_nativeRtcAnswer — signal sent for', peerId.slice(0,8));
  };

  // Native ICE candidate → forward through the signal channel.
  window._nativeRtcIce = (peerId, candidateJson) => {
    _dbg('_nativeRtcIce — forwarding ICE candidate via signal channel for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcIce — no _webrtcMesh on window!'); return; }
    mesh.sendSignal({
      type:      'rtc_ice',
      targetId:  peerId,
      candidate: JSON.parse(candidateJson),
      senderId:  mesh.myPeerId,
    });
  };

  // Inbound binary frame from native DC → synthesise the 'binary' CustomEvent.
  // Native Kotlin has already reassembled multi-chunk transfers, so the payload
  // here is the final merged buffer with NO 12-byte header — dispatch directly.
  window._nativeRtcChunk = (peerId, b64Payload) => {
    _dbg('_nativeRtcChunk — inbound binary from', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcChunk — no _webrtcMesh on window!'); return; }
    const buffer = _fromB64(b64Payload);
    _dbg('_nativeRtcChunk — decoded', buffer.byteLength, 'bytes from', peerId.slice(0,8),
      '— dispatching binary event');
    // Deliver directly — native layer already merged chunks, no header present.
    mesh.dispatchEvent(new CustomEvent('binary', { detail: { peerId, buffer } }));
  };

  // Native PC failed/closed.
  window._nativeRtcFailed = (peerId) => {
    _warn('_nativeRtcFailed — native PC failed/closed for', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) { _warn('_nativeRtcFailed — no _webrtcMesh on window!'); return; }
    _warn('_nativeRtcFailed — dispatching peer_failed + removePeer for', peerId.slice(0,8));
    mesh.dispatchEvent(new CustomEvent('peer_failed', { detail: { peerId } }));
    mesh.removePeer(peerId);
  };

  // ── Frame helpers (mirrors JS _sendOnDC wire format) ──────────────────────
  // 12-byte header: [transferId u32le][total u32le][index u32le] + payload

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
    const bin    = atob(b64);
    const bytes  = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  _log('✓ WebRTCMesh patched for native WebRTC');
}