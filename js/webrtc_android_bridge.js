// ── webrtc_android_bridge.js ─────────────────────────────────────────────────
// How it works
// ────────────
//  • _createPC(peerId)  → creates a NativeRtcBridge PC instead of RTCPeerConnection
//  • addPeer / handleSignal → forward offer/answer/ICE through AndroidRtc.*
//  • Native layer fires window._nativeRtc{Ready,PoolReady,Answer,Ice,Chunk,Failed}
//    callbacks which re-enter the mesh as if they came from a real DC/PC.
//
// The shim is a no-op on desktop (window.AndroidRtc is undefined).

const _isAndroid = typeof window.AndroidRtc !== 'undefined';

if (_isAndroid) {
  console.log('[android-bridge] AndroidRtc detected — patching WebRTCMesh');

  // ── Patch WebRTCMesh prototype ────────────────────────────────────────────

  const proto = WebRTCMesh.prototype;

  // ── addPeer ───────────────────────────────────────────────────────────────
  // Replaces RTCPeerConnection creation with a native PC on Android.
  // The peer that has the lexicographically larger id is the initiator
  // (same rule as the original).  On Android we are always the answerer
  // for desktop→Android calls (desktop sends the offer via the signal channel).
  const _origAddPeer = proto.addPeer;
  proto.addPeer = async function(peerId) {
    if (!_isAndroid) return _origAddPeer.call(this, peerId);

    if (this._pcs.has(peerId)) {
      console.log('[android-bridge] addPeer already exists', peerId.slice(0,8));
      return;
    }
    console.log('[android-bridge] addPeer (native)', peerId.slice(0,8));

    // Sentinel so _pcs.has() / removePeer() still work.
    this._pcs.set(peerId, { _native: true, connectionState: 'new', close() {} });

    // Tell native layer to create the PeerConnection.
    window.AndroidRtc.createPeerConnection(peerId);

    // If this device is the initiator, create and send an offer natively.
    // (Desktop→Android: desktop is initiator; this branch handles Android→desktop.)
    if (this.myPeerId > peerId) {
      // Android-initiated: not the common path, but supported.
      // Native answer callback will fire and we forward it through the signal channel.
      console.log('[android-bridge] Android is initiator — waiting for native offer');
      // Native layer doesn't currently self-create offers; extend here if needed.
    }
  };

  // ── removePeer ────────────────────────────────────────────────────────────
  const _origRemovePeer = proto.removePeer;
  proto.removePeer = function(peerId) {
    const pc = this._pcs.get(peerId);
    if (pc?._native) {
      console.log('[android-bridge] removePeer (native)', peerId.slice(0,8));
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
      return;
    }
    return _origRemovePeer.call(this, peerId);
  };

  // ── handleSignal ──────────────────────────────────────────────────────────
  // Intercepts rtc_offer / rtc_answer / rtc_ice for native peers.
  const _origHandleSignal = proto.handleSignal;
  proto.handleSignal = async function(msg) {
    if (!_isAndroid) return _origHandleSignal.call(this, msg);

    const { type, senderId } = msg;

    // If we don't have a native PC yet for this sender, create one now
    // (desktop sent the offer before our addPeer was called).
    if (type === 'rtc_offer') {
      if (!this._pcs.has(senderId)) {
        this._pcs.set(senderId, { _native: true, connectionState: 'new', close() {} });
        window.AndroidRtc.createPeerConnection(senderId);
      }
      const pc = this._pcs.get(senderId);
      if (!pc?._native) return _origHandleSignal.call(this, msg); // desktop peer — normal path
      console.log('[android-bridge] rtc_offer → native peerId', senderId.slice(0,8));
      window.AndroidRtc.setRemoteOffer(senderId, JSON.stringify(msg.sdp));
      return;
    }

    if (type === 'rtc_answer') {
      const pc = this._pcs.get(senderId);
      if (!pc?._native) return _origHandleSignal.call(this, msg);
      console.log('[android-bridge] rtc_answer → native peerId', senderId.slice(0,8));
      window.AndroidRtc.setRemoteAnswer(senderId, JSON.stringify(msg.sdp));
      return;
    }

    if (type === 'rtc_ice') {
      const pc = this._pcs.get(senderId);
      if (!pc?._native) return _origHandleSignal.call(this, msg);
      if (msg.candidate) {
        console.debug('[android-bridge] rtc_ice → native peerId', senderId.slice(0,8));
        window.AndroidRtc.addIceCandidate(senderId, JSON.stringify(msg.candidate));
      }
      return;
    }

    // Not a WebRTC message (LAN caps etc.) — pass through.
    return _origHandleSignal.call(this, msg);
  };

  // ── hasChannel ────────────────────────────────────────────────────────────
  const _origHasChannel = proto.hasChannel;
  proto.hasChannel = function(peerId) {
    const pc = this._pcs.get(peerId);
    if (pc?._native) return window.AndroidRtc.isPoolReady(peerId);
    return _origHasChannel.call(this, peerId);
  };

  // ── sendBinary (shared DC) ────────────────────────────────────────────────
  const _origSendBinary = proto.sendBinary;
  proto.sendBinary = async function(peerId, buffer) {
    const pc = this._pcs.get(peerId);
    if (!pc?._native) return _origSendBinary.call(this, peerId, buffer);

    // Encode and send through native shared DC.
    const frames = _splitToFrames(buffer);
    for (const frame of frames) {
      const b64 = _toB64(frame);
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

    // Check if pool is already flagged ready.
    if (this._xferPool.has(peerId)) return Promise.resolve(this._xferPool.get(peerId));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._xferPoolResolve.delete(peerId);
        reject(new Error(`[android-bridge] pool timeout ${peerId.slice(0,8)}`));
      }, timeoutMs);

      this._xferPoolResolve.set(peerId, pool => {
        clearTimeout(timer);
        resolve(pool);
      });

      // Race: pool may be ready already.
      if (this._xferPool.has(peerId)) {
        clearTimeout(timer);
        this._xferPoolResolve.delete(peerId);
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
    // Return a Promise that resolves after all frames are dispatched (no back-pressure
    // needed here — native layer handles its own SCTP buffering).
    return Promise.resolve().then(() => {
      for (const frame of frames) {
        const b64 = _toB64(frame);
        window.AndroidRtc.sendPool(peerId, index, b64);
      }
    });
  };

  // ── Native → JS callbacks ─────────────────────────────────────────────────

  // Shared DC is open → peer_ready event (mirrors _setupDC onopen).
  window._nativeRtcReady = (peerId) => {
    console.log('[android-bridge] _nativeRtcReady', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) return;
    // Synthesise a minimal shared DC proxy for hasChannel / sendBinary.
    const fakeSharedDc = { readyState: 'open', _nativePeer: peerId };
    mesh._dcs.set(peerId, fakeSharedDc);
    // Flush any queued DC-ready callbacks.
    const q = mesh._dcReady.get(peerId) || [];
    mesh._dcReady.delete(peerId);
    q.forEach(fn => fn());
    mesh.dispatchEvent(new CustomEvent('peer_ready', { detail: { peerId } }));
  };

  // All 4 pool DCs open → build proxy array and resolve getPoolChannels.
  window._nativeRtcPoolReady = (peerId) => {
    console.log('[android-bridge] _nativeRtcPoolReady', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) return;
    const pool = Array.from({ length: 4 }, (_, i) => ({
      _nativePool: { peerId, index: i },
      label: `xferp-${i}`,
      readyState: 'open',
    }));
    mesh._xferPool.set(peerId, pool);
    mesh._xferPoolResolve.get(peerId)?.(pool);
    mesh._xferPoolResolve.delete(peerId);
  };

  // Native layer produced an answer SDP → forward through the signal channel.
  window._nativeRtcAnswer = (peerId, sdpJson) => {
    console.log('[android-bridge] _nativeRtcAnswer → signal', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) return;
    mesh.sendSignal({
      type:     'rtc_answer',
      targetId: peerId,
      sdp:      JSON.parse(sdpJson),
      senderId: mesh.myPeerId,
    });
  };

  // Native ICE candidate → forward through the signal channel.
  window._nativeRtcIce = (peerId, candidateJson) => {
    console.debug('[android-bridge] _nativeRtcIce → signal', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) return;
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
    const mesh = window._webrtcMesh;
    if (!mesh) return;
    const buffer = _fromB64(b64Payload);
    // Deliver directly — native layer already merged chunks, no header present.
    mesh.dispatchEvent(new CustomEvent('binary', { detail: { peerId, buffer } }));
  };

  // Native PC failed/closed.
  window._nativeRtcFailed = (peerId) => {
    console.warn('[android-bridge] _nativeRtcFailed', peerId.slice(0,8));
    const mesh = window._webrtcMesh;
    if (!mesh) return;
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

  console.log('[android-bridge] ✓ WebRTCMesh patched for native WebRTC');
} else {
  console.log('[android-bridge] no AndroidRtc — desktop mode, no patch applied');
}