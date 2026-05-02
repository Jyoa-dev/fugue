// ── webrtc.js — WebRTC DataChannel peer mesh ────────────────────────────
// ICE server list: STUN (free, zero data touches them) + TURN (relay, only
// used when both STUN candidates fail — symmetric NAT, strict corporate NAT).
//
// TURN is opt-in via __FUGUE_TURN_CONFIG__ which the server injects at build
// time or at runtime via a <script> before this module loads:
//
//   window.__FUGUE_TURN_CONFIG__ = [
//     { urls: 'turn:your.turn.server:3478',
//       username: 'user', credential: 'pass' },
//     { urls: 'turns:your.turn.server:5349',   // TLS fallback
//       username: 'user', credential: 'pass' },
//   ];
//
// If the variable is absent or empty the behaviour is identical to before —
// STUN only, no relay. File data only reaches the TURN server when direct
// ICE paths (host, srflx) are all unreachable; it is still end-to-end
// encrypted so the relay server never sees plaintext.
//
// STUN only discovers your public IP/port — zero file data touches STUN servers.
const _turnServers = (typeof window !== 'undefined' && window.__FUGUE_TURN_CONFIG__) || [];
const ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478'   },
  { urls: 'stun:stun.l.google.com:19302'    },
  { urls: 'stun:stun1.l.google.com:19302'   },
  { urls: 'stun:stun.relay.metered.ca:80'   },
  ..._turnServers,
];

// Maximum payload bytes per _sendOnDC fragment — 2-tier by peer type.
// _sendOnDC prepends a 12-byte transport header (transferId + total + index)
// to every dc.send() call, so the raw dc.send() size is always (12 + chunk).
// Each constant must therefore be (browser ceiling − 12) so the wire frame
// never exceeds the hard ceiling that throws a DOMException.
//
//   Safari peers    → 64 KB  (WebKit hard cap is exactly 65536 B;
//                             65536 − 12 = 65524 B payload ceiling)
//   Chrome/Firefox  → 256 KB (libwebrtc kMaxSctpMessageSize = 262144 B;
//                             262144 − 12 = 262132 B payload ceiling)
//
// Android peers now use sendOnChannel through the 4-pool path (same as desktop)
// after NativeRtcBridge.kt gained transport-header stripping in parseDCFrame.
// The 256 KB app-chunk cap (ANDROID_CHUNK_CAP) in room.js is also removed —
// _sendOnDC fragments automatically so any chunk size is safe.
//
// _sendOnDC reads _chunkSizeFor(peerId) at call time so the right size is used
// per-peer. Small messages (chat etc.) still hit the total===1 fast-path with
// zero reassembly overhead regardless of which tier is active.
const DC_CHUNK_SAFARI  = 64  * 1024 - 12;     // 65524 B — keeps dc.send() ≤ 65536 B
const DC_CHUNK_DESKTOP = 256 * 1024 - 12;     // 262132 B — keeps dc.send() ≤ 262144 B

// Detect Safari once at module load — User-Agent sniff is reliable enough here
// because the chunk size only needs to match what THIS browser's dc.send() allows.
const _isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// ── Adaptive back-pressure ───────────────────────────────────────────────
// Each DataChannel gets its own _bufHigh (send watermark) that tunes itself:
//   drain < 20 ms   → buffer too small,  grow  ×1.25 (up to BUF_MAX)
//   drain 150–300ms → buffer slightly large, shrink ×0.75
//   drain > 300 ms  → buffer way too large,  shrink ×0.5  (fast convergence)
//
// The RESUME threshold (bufferedAmountLowThreshold) is set to high/2 so the
// sender wakes up while there is still room in the pipe — no idle stall.
const BUF_MIN = 32   * 1024;        //  32 KB floor — conservative for Android SCTP
const BUF_MAX =  16  * 1024 * 1024; //   16 MB ceiling

// Android send-side association cap.
// libwebrtc Android has ONE shared SCTP send window per PeerConnection — all pool DCs
// compete for it. Allowing N × DC_CHUNK_DESKTOP in-flight simultaneously saturates the
// window instantly (8 × 256 KB = 2 MB >> ~256–512 KB window) so every channel stalls
// in lockstep. This cap gates total bufferedAmount across all pool DCs to one frame,
// ensuring the window can drain before the next frame enters any channel.
// Android chunk size is pre-computed in room.js _computeChunkSize() to land exactly in
// one DC_CHUNK_DESKTOP dc.send() after all overhead (app header + transport header +
// crypto), so "one frame" == one dc.send() == DC_CHUNK_DESKTOP bytes on the wire.
const ANDROID_INFLIGHT_CAP = DC_CHUNK_DESKTOP; // one 256 KB frame total across all pool DCs
const ANDROID_BUF_MAX      = 2 * DC_CHUNK_DESKTOP; // 512 KB — per-channel budget ceiling for Android

function initialBufHigh() {
  const c = navigator.connection || navigator.mozConnection;
  if (c) {
    // wifi/downlink detection reflects the LOCAL nic, not the peer's link.
    if (c.downlink > 10 || c.type === 'wifi')     return 4 * 1024 * 1024; // 4 MB
    if (c.downlink <  2 || c.type === 'cellular') return BUF_MIN;
  }
  return 4 * 1024 * 1024; // 4 MB default — adaptive shrinks if link is slow
}

// ── Transfer pool ────────────────────────────────────────────────────────
// Per-peer pool of XFER_POOL_SIZE pre-opened ordered DataChannels.
// Chunks are striped across them (chunkIndex % pool.length) so each channel
// is its own independent SCTP stream — parallel without head-of-line blocking.
// No per-file channel setup overhead: pool is established at peer connect time.
const XFER_POOL_SIZE = 8;

export class WebRTCMesh extends EventTarget {
  constructor(sendSignal, myPeerId) {
    super();
    this.sendSignal    = sendSignal;
    this.myPeerId      = myPeerId;
    // Expose this instance's diag helper globally so DevTools can call:
    //   window._webrtcMesh.xferStats()
    window._webrtcMesh = this;
    /** @type {Map<string, RTCPeerConnection>} */
    this._pcs          = new Map();
    /** @type {Map<string, RTCDataChannel>} */
    this._dcs          = new Map(); // shared 'files' DC per peer (chat + signaling)
    /** @type {Map<string, RTCDataChannel>} */
    this._androidDcs   = new Map(); // ordered 'android-direct' DC per peer (chat fallback; file transfers use pool)
    /** @type {Map<string, Array<()=>void>>} */
    this._dcReady      = new Map();
    /** @type {Map<string, { total:number, frags:ArrayBuffer[], received:number, peerId:string }>} */
    this._assemblers   = new Map();
    /** @type {Map<string, RTCIceCandidateInit[]>} */
    this._icePending   = new Map();
    /** @type {Map<string, RTCDataChannel[]>} */
    this._xferPool        = new Map(); // peerId → ready pool DCs (open, reusable)
    /** @type {Map<string, (dcs: RTCDataChannel[]) => void>} */
    this._xferPoolResolve = new Map(); // peerId → pending getPoolChannels resolver
    /** @type {Map<string, RTCDataChannel[]>} */
    this._xferPoolBuf     = new Map(); // peerId → DCs received but pool not yet full
    /** @type {Map<string, { _bufHigh: number }>} */
    this._xferBufHigh     = new Map(); // peerId → shared back-pressure budget for pool DCs
    /** @type {Set<string>} peers identified as Android native-WebRTC (via _android flag in rtc_offer or rtc_answer) */
    this._androidPeers    = new Set();
    /** @type {Set<string>} peers identified as Safari (via _safari flag in rtc_offer or rtc_answer) */
    this._safariPeers     = new Set();
    // Per-peer promise that resolves once peer-type detection (Android/Safari flags) has run.
    // getPoolChannels awaits this so the shared budget is always clamped before the first
    // sendOnChannel call — closes the race where pool DCs open (ICE event) before the
    // rtc_answer carrying _android:true is processed, causing the initiator to send at
    // the default 4 MB budget before the retroactive clamp in handleSignal fires.
    /** @type {Map<string, { resolve: () => void, promise: Promise<void> }>} */
    this._peerTypeReady   = new Map();
    // Per-DC write queues — gives each pool channel an independent drain loop so
    // concurrent sendOnChannel calls on different DCs overlap instead of serialising.
    /** @type {WeakMap<RTCDataChannel, { pending: Array<{buffer:ArrayBuffer, resolve:()=>void}>, running:boolean }>} */
    this._writeQueues     = new WeakMap();
    // ── Diagnostics (call mesh.xferStats() in console to read) ──────────────
    this._xferDiag = {
      calls:        0,    // total sendOnChannel calls
      queueWaitMs:  0,    // total ms sendOnChannel blocked waiting for dequeue
      drainCount:   0,    // total times _drainBuffer was entered
      drainMs:      0,    // total ms spent in _drainBuffer
      bytesSent:    0,    // payload bytes passed to dc.send()
      concurrentDrains: 0, // channels draining simultaneously right now
      peakConcurrent:   0,
      startedAt:    performance.now(),
    };
  }

  // Call in DevTools: mesh.xferStats()
  xferStats() {
    const d = this._xferDiag;
    const elapsed = ((performance.now() - d.startedAt) / 1000).toFixed(1);
    const mbps    = ((d.bytesSent * 8) / 1e6 / (elapsed || 1)).toFixed(2);
    const avgDrain = d.drainCount ? (d.drainMs / d.drainCount).toFixed(0) : '-';
    const avgQueue = d.calls      ? (d.queueWaitMs / d.calls).toFixed(1)  : '-';
    console.table({
      'elapsed (s)':           elapsed,
      'bytes sent':            d.bytesSent,
      'throughput (Mbit/s)':   mbps,
      'sendOnChannel calls':   d.calls,
      'avg queue-wait (ms)':   avgQueue,   // how long sendOnChannel blocked before dequeue
      'drain entries':         d.drainCount,
      'avg drain wait (ms)':   avgDrain,   // avg time spent in _drainBuffer
      'peak concurrent drains':d.peakConcurrent,
    });
    return d;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async addPeer(peerId) {
    if (this._pcs.has(peerId)) {
      console.log('[mesh] addPeer called but already exists', peerId.slice(0,8),
        '| pc state:', this._pcs.get(peerId).connectionState);
      return;
    }
    console.log('[mesh] addPeer', peerId.slice(0,8));
    const pc = this._createPC(peerId);
    if (this.myPeerId > peerId) {
      const dc = pc.createDataChannel('files', { ordered: false });
      this._setupDC(peerId, dc);
      // Create the peer-type gate before _openPool so getPoolChannels can await it.
      // Resolved by handleSignal when rtc_answer arrives (Android/Safari flags read).
      // This guarantees the shared budget is clamped to BUF_MIN for Android peers
      // before any sendOnChannel call fires — closes the race where pool DCs open
      // via ICE events before the answer is processed.
      if (!this._peerTypeReady.has(peerId)) {
        let res;
        const promise = new Promise(r => { res = r; });
        this._peerTypeReady.set(peerId, { resolve: res, promise });
      }
      // Pre-open the transfer pool — all created before the offer so the
      // SDP carries all streams in one round-trip with no extra negotiation.
      this._openPool(peerId, pc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal({ type: 'rtc_offer', targetId: peerId, sdp: pc.localDescription, senderId: this.myPeerId, ...(_isSafari && { _safari: true }) });
    }
  }

  removePeer(peerId) {
    console.log('[mesh] removePeer', peerId.slice(0,8),
      '| pc state:', this._pcs.get(peerId)?.connectionState ?? 'none',
      '| dc state:', this._dcs.get(peerId)?.readyState ?? 'none',
      '| pool size:', this._xferPool.get(peerId)?.length ?? 0);
    this._pcs.get(peerId)?.close();
    this._pcs.delete(peerId);
    this._dcs.delete(peerId);
    this._androidDcs.delete(peerId);
    this._dcReady.delete(peerId);
    this._icePending.delete(peerId);
    const pool = this._xferPool.get(peerId);
    if (pool) {
      pool.forEach(dc => {
        // Flush write queue first so any awaiting sendOnChannel callers unblock
        // before the DC closes — otherwise they hang until GC.
        const q = this._writeQueues.get(dc);
        if (q) { while (q.pending.length > 0) q.pending.shift().resolve(); }
        try { dc.close(); } catch {}
      });
    }
    this._xferPool.delete(peerId);
    this._xferPoolResolve.delete(peerId); // abandons any pending getPoolChannels (timer rejects)
    this._xferPoolBuf.delete(peerId);
    this._xferBufHigh.delete(peerId);
    this._androidPeers.delete(peerId);
    this._safariPeers.delete(peerId);
    this._peerTypeReady.delete(peerId);
    for (const [key, asm] of this._assemblers) {
      if (asm.peerId === peerId) this._assemblers.delete(key);
    }
  }

  hasChannel(peerId) {
    return this._dcs.get(peerId)?.readyState === 'open';
  }

  // Shared DC send (chat, small frames). Fragmented if > DC_CHUNK (rare).
  async sendBinary(peerId, buffer) {
    const dc = this._dcs.get(peerId);
    if (!dc || dc.readyState !== 'open') throw new Error(`No open DC to ${peerId}`);
    await this._sendOnDC(dc, buffer);
  }

  // Direct send for Android native peers — NO transport wrapper, NO splitting.
  // Android's SCTP stack (libwebrtc) delivers complete messages via onMessage()
  // transparently, so Kotlin parseDCFrame() receives the raw app frame directly.
  // Uses the dedicated 'android-direct' DC (ordered:true) to avoid SCTP reordering
  // stalls that occur when 256 KB frames are sent on an unordered channel — a single
  // lost/late packet causes multi-second head-of-line blocking at the OS buffer level.
  // Falls back to the shared 'files' DC for peers that pre-date the android-direct
  // channel (older desktop builds that haven't re-negotiated).
  //
  // Queued: resolves the moment the buffer is dequeued, not when it drains.
  // This lets room.js lanes race ahead on crypto work while the DC drains —
  // same contract as sendOnChannel. Without this, all lanes block simultaneously
  // in _drainBuffer on a slow link, serialising the crypto pool.
  sendDirect(peerId, buffer) {
    const dc = this._androidDcs.get(peerId) ?? this._dcs.get(peerId);
    if (!dc || dc.readyState !== 'open') throw new Error(`No open DC to ${peerId}`);
    const bytes = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
    const d = this._xferDiag;
    d.calls++;
    const enqueueAt = performance.now();
    let q = this._writeQueues.get(dc);
    if (!q) { q = { pending: [], running: false }; this._writeQueues.set(dc, q); }
    return new Promise(resolve => {
      q.pending.push({ buffer: bytes, resolve: () => {
        d.queueWaitMs += performance.now() - enqueueAt;
        resolve();
      }});
      if (!q.running) this._runDirectQueue(dc, q);
    });
  }

  // Serial drain loop for the shared DC (Android path).
  // Differs from _runDCQueue in that it calls dc.send() directly — no fragmentation
  // wrapper — since Android expects intact app frames (parseDCFrame offset 0).
  // Backpressure check + drain happen here, invisible to room.js callers.
  async _runDirectQueue(dc, q) {
    q.running = true;
    while (q.pending.length > 0) {
      if (dc.readyState !== 'open') {
        console.warn('[directQueue] DC closed with', q.pending.length, 'items pending — flushing');
        while (q.pending.length > 0) q.pending.shift().resolve();
        break;
      }
      const { buffer, resolve } = q.pending.shift();
      resolve();                          // unblock caller — lane can now encrypt next chunk
      if (dc.bufferedAmount > (dc._bufHigh ?? BUF_MIN)) {
        const stalled = await this._drainBuffer(dc);
        if (stalled) {
          console.warn('[directQueue] aborting — stall during drain, buffered =',
            (dc.bufferedAmount / 1024).toFixed(0), 'KB');
          // Flush remaining so callers don't hang, then let peer_failed propagate.
          while (q.pending.length > 0) q.pending.shift().resolve();
          break;
        }
      }
      if (dc.readyState !== 'open') {
        while (q.pending.length > 0) q.pending.shift().resolve();
        break;
      }
      this._xferDiag.bytesSent += buffer.byteLength;
      dc.send(buffer);
    }
    q.running = false;
  }

  // Send on a pool DC (from getPoolChannels).
  //
  // Each pool DC has its own independent drain loop (_runDCQueue). This Promise
  // resolves the moment the buffer is *dequeued* — i.e. this channel's loop has
  // started on it and the caller can immediately queue the next chunk on a
  // different channel without blocking. All four xferp-* channels therefore drain
  // concurrently even when room.js calls sendOnChannel sequentially with await.
  //
  // Back-pressure: if this DC's loop is still busy with the previous buffer (slow
  // link), the new item sits in `pending` and the Promise resolves only once it is
  // dequeued — so room.js won't race ahead more than one buffer per channel.
  sendOnChannel(dc, buffer) {
    const d = this._xferDiag;
    d.calls++;
    const enqueueAt = performance.now();
    let q = this._writeQueues.get(dc);
    if (!q) { q = { pending: [], running: false }; this._writeQueues.set(dc, q); }
    return new Promise(resolve => {
      q.pending.push({ buffer, resolve: () => {
        d.queueWaitMs += performance.now() - enqueueAt;
        resolve();
      }});
      if (!q.running) this._runDCQueue(dc, q);
    });
  }

  // Independent per-DC drain loop. Runs until the pending queue is empty, then
  // exits — the next sendOnChannel call will restart it.
  async _runDCQueue(dc, q) {
    q.running = true;
    while (q.pending.length > 0) {
      if (dc.readyState !== 'open') {
        // DC closed mid-transfer — unblock all waiting callers so they don't hang,
        // then let the normal error/close handling propagate up.
        console.warn('[queue] DC', dc.label, 'closed with', q.pending.length, 'items pending — flushing');
        while (q.pending.length > 0) q.pending.shift().resolve();
        break;
      }
      const { buffer, resolve } = q.pending.shift();
      resolve();                        // unblock caller immediately
      const ok = await this._sendOnDC(dc, buffer);
      if (ok === false) {
        // DC stalled or closed — flush remaining queue so callers don't hang,
        // then exit. The connection will fail/close through normal peer_failed path.
        if (q.pending.length > 0) {
          console.warn('[queue]', dc.label, '— flushing', q.pending.length, 'pending items after abort');
          while (q.pending.length > 0) q.pending.shift().resolve();
        }
        break;
      }
    }
    q.running = false;
  }

  async handleSignal(msg) {
    const { type, senderId } = msg;

    if (type === 'rtc_offer') {
      let pc = this._pcs.get(senderId);
      if (!pc) pc = this._createPC(senderId);
      if (pc._native) return; // handed off to webrtc_android_bridge.js
      // ── Android peer detection (offer path) ────────────────────────────
      // webrtc_android_bridge.js stamps _android:true on offers it sends.
      // The desktop is the responder here, so we learn about the Android peer
      // from the offer — before we ever see an answer.
      if (msg._android && !this._androidPeers.has(senderId)) {
        this._androidPeers.add(senderId);
        console.log(
          '[mesh] 📱 peer', senderId.slice(0, 8),
          '— Android detected via offer, native WebRTC path active (NativeRtcBridge.kt)',
          '| total android peers:', this._androidPeers.size,
        );
      }
      // ── Safari peer detection (offer path) ─────────────────────────────
      // Safari stamps _safari:true on offers it sends. Cap chunk size for this
      // peer to DC_CHUNK_SAFARI (64 KB − 12) to stay within WebKit's SCTP ceiling.
      if (msg._safari && !this._safariPeers.has(senderId)) {
        this._safariPeers.add(senderId);
        console.log(
          '[mesh] 🧭 peer', senderId.slice(0, 8),
          '— Safari detected via offer, capping chunks to', DC_CHUNK_SAFARI, 'B',
          '| total safari peers:', this._safariPeers.size,
        );
      }
      if (pc.signalingState !== 'stable') return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        if (pc.signalingState !== 'have-remote-offer') return;
        const buffered = this._icePending.get(senderId);
        if (buffered?.length) {
          this._icePending.delete(senderId);
          for (const c of buffered) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendSignal({ type: 'rtc_answer', targetId: senderId, sdp: pc.localDescription, senderId: this.myPeerId, ...(_isSafari && { _safari: true }) });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'InvalidStateError') return;
        console.warn('rtc_offer handling failed:', e);
      }
    }

    if (type === 'rtc_answer') {
      const pc = this._pcs.get(senderId);
      if (pc?._native) return; // handed off to webrtc_android_bridge.js
      // ── Android peer detection ──────────────────────────────────────────
      // The Android bridge stamps _android:true on every rtc_answer it sends.
      // Log it once on the desktop so it's visible in DevTools that this peer
      // is using native Android WebRTC (NativeRtcBridge.kt), not the browser stack.
      if (msg._android && !this._androidPeers.has(senderId)) {
        this._androidPeers.add(senderId);
        // _openPool() ran before this answer arrived and used initialBufHigh() = 4 MB.
        // Retroactively clamp the shared budget so the first sendOnChannel call
        // doesn't blast into Android's shared SCTP send window.
        const budget = this._xferBufHigh.get(senderId);
        if (budget) {
          budget._bufHigh            = BUF_MIN;            // start conservative (32 KB)
          budget._bufMax             = ANDROID_BUF_MAX;    // cap at 512 KB — prevents re-saturation
          budget._androidInFlightCap = ANDROID_INFLIGHT_CAP; // association-level gate across all pool DCs
        }
        console.log(
          '[mesh] 📱 peer', senderId.slice(0, 8),
          '— Android detected, native WebRTC path active (NativeRtcBridge.kt)',
          '| budget clamped to', BUF_MIN / 1024, 'KB (max', ANDROID_BUF_MAX / 1024, 'KB)',
          '| inflight cap', ANDROID_INFLIGHT_CAP / 1024, 'KB',
          '| total android peers:', this._androidPeers.size,
        );
      }
      // ── Safari peer detection (answer path) ────────────────────────────
      // Safari stamps _safari:true on every rtc_answer it sends.
      if (msg._safari && !this._safariPeers.has(senderId)) {
        this._safariPeers.add(senderId);
        console.log(
          '[mesh] 🧭 peer', senderId.slice(0, 8),
          '— Safari detected via answer, capping chunks to', DC_CHUNK_SAFARI, 'B',
          '| total safari peers:', this._safariPeers.size,
        );
      }
      if (pc && pc.signalingState === 'have-local-offer') {
        // Peer type is now known — unblock getPoolChannels so the shared budget
        // is already clamped before the first sendOnChannel call.
        this._peerTypeReady.get(senderId)?.resolve();
        this._peerTypeReady.delete(senderId);
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const buffered = this._icePending.get(senderId);
          if (buffered?.length) {
            this._icePending.delete(senderId);
            for (const c of buffered) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === 'InvalidStateError') return;
          console.warn('rtc_answer handling failed:', e);
        }
      }
    }

    if (type === 'rtc_ice') {
      const pc = this._pcs.get(senderId);
      if (pc?._native) return; // handed off to webrtc_android_bridge.js
      if (pc && msg.candidate) {
        if (!pc.remoteDescription) {
          if (!this._icePending.has(senderId)) this._icePending.set(senderId, []);
          this._icePending.get(senderId).push(msg.candidate);
        } else {
          try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
        }
      }
    }
  }

  // ── Transfer pool ──────────────────────────────────────────────────────

  // Called by the initiator in addPeer() — creates XFER_POOL_SIZE ordered DCs
  // on `pc` and resolves _xferPool[peerId] once all are open.
  _openPool(peerId, pc) {
    const dcs = [];
    let openCount = 0;

    // Shared budget — all pool DCs on this peer adapt together instead of
    // each channel independently tuning its own threshold.
    // FIX: key must be _bufHigh (not bufHigh) — _sendOnDC and _drainBuffer both
    // read (dc._sharedBufHigh ?? dc)._bufHigh, so a mismatched key silently
    // returned undefined and fell back to BUF_MIN (32 KB) for every pool send,
    // causing immediate back-pressure stalls and transfer_cancel on desktop peers.
    // Android peers: _bufMax is capped at ANDROID_BUF_MAX (512 KB) so the adaptive
    // tuner can't ramp back up to 4 MB and re-saturate the shared SCTP send window.
    // _androidInFlightCap enforces a total across ALL pool DCs — see _sendOnDC.
    const shared = { _bufHigh: initialBufHigh() };
    this._xferBufHigh.set(peerId, shared);

    console.log('[pool] _openPool START for', peerId.slice(0,8), '| target size:', XFER_POOL_SIZE);
    const onOpen = (label) => {
      console.log('[pool] initiator DC open:', label, '| openCount now', openCount + 1, '/', XFER_POOL_SIZE, '| peer', peerId.slice(0,8));
      if (++openCount < XFER_POOL_SIZE) return;
      console.log('[pool] initiator pool READY for', peerId.slice(0,8));
      this._xferPool.set(peerId, dcs);
      this._xferPoolResolve.get(peerId)?.(dcs);
      this._xferPoolResolve.delete(peerId);
    };
    for (let i = 0; i < XFER_POOL_SIZE; i++) {
      const dc = pc.createDataChannel(`xferp-${i}`, { ordered: false });
      console.log('[pool] createDataChannel xferp-' + i, '| readyState:', dc.readyState, '| peer', peerId.slice(0,8));
      dc.binaryType     = 'arraybuffer';
      dc._peerId        = peerId;
      dc._sharedBufHigh = shared;
      dc.onopen     = () => onOpen(dc.label);
      dc.onmessage  = ({ data }) => this._handleFrame(peerId, data);
      dc.onerror    = e => console.warn('[pool] DC error', dc.label, peerId, e);
      dc.onclose    = () => console.warn('[pool] initiator DC CLOSED', dc.label, 'peer', peerId.slice(0,8), '| buffered:', dc.bufferedAmount);
      dcs.push(dc);
    }
    console.log('[pool] _openPool END — created', dcs.length, 'DCs for', peerId.slice(0,8));
  }

  // Returns a Promise<RTCDataChannel[]> that resolves once all XFER_POOL_SIZE
  // pool DCs for `peerId` are open AND peer-type detection has completed.
  // The peer-type gate (_peerTypeReady) ensures the shared budget is clamped for
  // Android peers before the first sendOnChannel call — prevents the race where
  // pool DCs open via ICE events before the rtc_answer carrying _android:true
  // is processed, which would let the initiator send at the 4 MB default budget.
  // Desktop peers: gate resolves in the same answer-processing microtask, zero cost.
  getPoolChannels(peerId, timeoutMs = 10_000) {
    const pool      = this._xferPool.get(peerId);
    const typeGate  = this._peerTypeReady.get(peerId)?.promise ?? Promise.resolve();

    if (pool) return typeGate.then(() => pool);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._xferPoolResolve.delete(peerId);
        reject(new Error(`pool timeout for ${peerId}`));
      }, timeoutMs);

      this._xferPoolResolve.set(peerId, p => {
        clearTimeout(timer);
        // Wait for peer-type detection before handing the pool to the caller.
        typeGate.then(() => resolve(p));
      });

      // Race guard: pool may have become ready between the get() check above
      // and the resolver being stored.
      const poolNow = this._xferPool.get(peerId);
      if (poolNow) {
        clearTimeout(timer);
        this._xferPoolResolve.delete(peerId);
        typeGate.then(() => resolve(poolNow));
      }
    });
  }

  // ── Internal ───────────────────────────────────────────────────────────

  _createPC(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this._pcs.set(peerId, pc);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal({ type: 'rtc_ice', targetId: peerId, candidate, senderId: this.myPeerId });
    };

    pc.ondatachannel = ({ channel }) => {
      if (channel.label.startsWith('xferp-')) {
        // Responder side of a pool DC. Collect until the full pool is open,
        // then resolve any waiting getPoolChannels() call.
        channel.binaryType = 'arraybuffer';
        channel._peerId    = peerId;
        channel.onmessage  = ({ data }) => this._handleFrame(peerId, data);
        channel.onerror    = e => console.warn('pool DC error', peerId, channel.label, e);
        channel.onclose    = () => console.warn('[pool] responder DC CLOSED', channel.label, 'peer', peerId.slice(0,8), '| buffered:', channel.bufferedAmount, '| pool size at close:', (this._xferPool.get(peerId) ?? this._xferPoolBuf.get(peerId) ?? []).length);
        if (!this._xferPoolBuf.has(peerId)) this._xferPoolBuf.set(peerId, []);
        const buf = this._xferPoolBuf.get(peerId);
        const onOpen = () => {
          buf.push(channel);
          if (buf.length === XFER_POOL_SIZE) {
            const pool = buf.slice();
            this._xferPoolBuf.delete(peerId);
            this._xferPool.set(peerId, pool);

            // Shared budget for responder pool — same as initiator side.
            // Android peers get a conservative initial budget (BUF_MIN = 32 KB) so the
            // desktop doesn't blast into Android's SCTP send window before backpressure
            // kicks in. _bufMax is capped at ANDROID_BUF_MAX (512 KB) — prevents the
            // adaptive tuner from ramping back to 4 MB and re-saturating the shared
            // SCTP send window. _androidInFlightCap gates total in-flight across all
            // pool DCs at the association level — see _sendOnDC for enforcement.
            const isAndroid = this._androidPeers.has(peerId);
            const shared = {
              _bufHigh: isAndroid ? BUF_MIN : initialBufHigh(),
              ...(isAndroid && {
                _bufMax:             ANDROID_BUF_MAX,
                _androidInFlightCap: ANDROID_INFLIGHT_CAP,
              }),
            };
            this._xferBufHigh.set(peerId, shared);
            pool.forEach(dc => { dc._sharedBufHigh = shared; dc._peerId = peerId; });

            console.log('[pool] responder pool ready for', peerId.slice(0,8));
            this._xferPoolResolve.get(peerId)?.(pool);
            this._xferPoolResolve.delete(peerId);
          }
        };
        if (channel.readyState === 'open') onOpen();
        else channel.onopen = onOpen;
      } else if (channel.label === 'android-direct') {
        this._setupAndroidDC(peerId, channel);
      } else {
        this._setupDC(peerId, channel);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[pc]', peerId.slice(0,8), pc.connectionState,
        '| ice:', pc.iceConnectionState, '| signal:', pc.signalingState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        console.warn('[pc] dispatching peer_failed for', peerId.slice(0,8),
          '| trigger stack:', new Error().stack.split('\n').slice(1,3).join(' ▸ '));
        this._lastPeerFailed = this._lastPeerFailed ?? {};
        const now = Date.now();
        const last = this._lastPeerFailed[peerId] ?? 0;
        console.warn('[pc] ms since last peer_failed for this peer:', now - last);
        this._lastPeerFailed[peerId] = now;
        this.dispatchEvent(new CustomEvent('peer_failed', { detail: { peerId } }));
        this.removePeer(peerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[ice]', peerId.slice(0,8), pc.iceConnectionState);
      // 'failed' fires faster than connectionState on some Android WebViews /
      // mobile networks where symmetric NAT blocks all candidate pairs.
      // Emit peer_failed here so the UX shows the NAT warning immediately
      // rather than waiting up to ~30 s for the connection-state machine.
      // Guard: only fire if connectionState hasn't already transitioned to
      // failed/closed (avoids a double peer_failed dispatch on the same peer).
      if (pc.iceConnectionState === 'failed') {
        const cs = pc.connectionState;
        if (cs !== 'failed' && cs !== 'closed') {
          console.warn('[ice] iceConnectionState=failed before connectionState —',
            'dispatching peer_failed early for', peerId.slice(0, 8),
            '| connectionState:', cs,
            _turnServers.length ? '' : '| no TURN configured');
          this.dispatchEvent(new CustomEvent('peer_failed', { detail: { peerId } }));
          this.removePeer(peerId);
        }
      }
    };

    return pc;
  }

  // Shared DC (chat, signaling acks). ordered:false, one per peer.
  _setupDC(peerId, dc) {
    this._dcs.set(peerId, dc);
    dc.binaryType = 'arraybuffer';
    dc._bufHigh   = initialBufHigh();
    dc._peerId    = peerId;

    dc.onopen = () => {
      const q = this._dcReady.get(peerId) || [];
      this._dcReady.delete(peerId);
      q.forEach(fn => fn());
      this.dispatchEvent(new CustomEvent('peer_ready', { detail: { peerId } }));
    };

    dc.onclose = () => { this._dcs.delete(peerId); };
    dc.onmessage = ({ data }) => this._handleFrame(peerId, data);
    dc.onerror   = e => {
      const s = this._pcs.get(peerId)?.connectionState;
      if (!s || s === 'closed' || s === 'failed') return;
      console.warn('DC error', peerId, e);
    };
  }

  // Ordered DC for Android direct sends (label 'android-direct', ordered:true).
  // Kept for legacy compatibility — new transfers use the 4-pool path via
  // sendOnChannel. sendDirect still falls back here for chat/small frames.
  // No _bufMax cap — the android-direct DC is no longer the file transfer path.
  _setupAndroidDC(peerId, dc) {
    this._androidDcs.set(peerId, dc);
    dc.binaryType = 'arraybuffer';
    dc._bufHigh   = initialBufHigh();
    dc._peerId    = peerId;
    dc.onclose = () => { this._androidDcs.delete(peerId); };
    dc.onerror = e => {
      const s = this._pcs.get(peerId)?.connectionState;
      if (!s || s === 'closed' || s === 'failed') return;
      console.warn('[android-direct] DC error', peerId, e);
    };
    dc.onopen = () => console.log('[android-direct] DC open for', peerId.slice(0, 8));
  }

  _handleFrame(peerId, data) {
    if (!(data instanceof ArrayBuffer)) return;
    const view       = new DataView(data);
    const transferId = view.getUint32(0, true);
    const total      = view.getUint32(4, true);
    const index      = view.getUint32(8, true);
    const payload    = data.slice(12);

    if (total === 1) {
      this.dispatchEvent(new CustomEvent('binary', { detail: { peerId, buffer: payload } }));
      return;
    }

    const asmKey = `${peerId}:${transferId}`;
    let asm = this._assemblers.get(asmKey);
    if (!asm) { asm = { total, frags: new Array(total), received: 0, peerId }; this._assemblers.set(asmKey, asm); }
    asm.frags[index] = payload;
    if (++asm.received === total) {
      this._assemblers.delete(asmKey);
      const size   = asm.frags.reduce((s, f) => s + f.byteLength, 0);
      const merged = new Uint8Array(size);
      let off = 0;
      for (const f of asm.frags) { merged.set(new Uint8Array(f), off); off += f.byteLength; }
      this.dispatchEvent(new CustomEvent('binary', { detail: { peerId, buffer: merged.buffer } }));
    }
  }

  // Returns the per-call dc.send() ceiling for the given peer:
  //   Safari (local or remote) → 64 KB (WebKit hard cap)
  //   All others               → 256 KB
  // Android peers use the desktop ceiling — room.js _computeChunkSize() pre-sizes
  // the encrypted app chunk to fit in exactly one DC_CHUNK_DESKTOP dc.send() after
  // all overhead (app header + transport header + crypto), so fragmentation never
  // occurs in practice. DC_CHUNK_SAFARI here would re-introduce 4–5× fragmentation.
  _chunkSizeFor(peerId) {
    if (_isSafari || (peerId && this._safariPeers.has(peerId))) return DC_CHUNK_SAFARI;
    return DC_CHUNK_DESKTOP;
  }

  async _sendOnDC(dc, buffer) {
    const bytes      = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
    const chunk      = this._chunkSizeFor(dc._peerId);
    const total      = Math.ceil(bytes.byteLength / chunk) || 1;
    const transferId = (Math.random() * 0xFFFFFFFF) >>> 0;

    for (let i = 0; i < total; i++) {
      const offset     = i * chunk;
      const chunkBytes = Math.min(chunk, bytes.byteLength - offset);
      const frame      = new ArrayBuffer(12 + chunkBytes);
      const view       = new DataView(frame);
      view.setUint32(0, transferId, true);
      view.setUint32(4, total,      true);
      view.setUint32(8, i,          true);
      // Direct copy from source — skips the intermediate slice() allocation + copy.
      new Uint8Array(frame, 12).set(new Uint8Array(bytes, offset, chunkBytes));

      const budget = dc._sharedBufHigh;

      if (budget?._androidInFlightCap != null) {
        // ── Android: serialise sends through a promise-chain mutex ──────────
        // libwebrtc Android has ONE shared SCTP send window across all pool DCs.
        // A check-then-send approach is inherently racy: all 8 _runDCQueue loops
        // run concurrently, read totalInflight ≈ 0, pass the check, and each
        // calls dc.send() before any of them sees the others' frames — producing
        // 8 × 256 KB = 2 MB in-flight simultaneously and saturating the window.
        //
        // Solution: a promise-chain mutex on the shared budget object. Each send
        // chains onto the previous one via budget._sendLock. The lock promise
        // resolves only after _drainBuffer confirms the previous frame has left
        // the SCTP send buffer, so sends are strictly serialised at the
        // association level regardless of which pool DC they land on.
        const releaseLock = await this._acquireAndroidSendLock(budget, dc);
        if (!releaseLock) return false; // DC closed or stalled while waiting
        if (dc.readyState !== 'open') { releaseLock(); return false; }
        this._xferDiag.bytesSent += frame.byteLength;
        dc.send(frame);
        // Drain asynchronously then release the lock so the next queued send
        // can proceed. We do NOT await here — that would block this channel's
        // _runDCQueue while other channels sit idle. The lock serialises the
        // sends; the drain happens in the background and releases when done.
        this._drainAndRelease(dc, budget, releaseLock);
      } else {
        // ── Desktop: per-channel _bufHigh watermark ─────────────────────────
        const high = (budget ?? dc)._bufHigh ?? BUF_MIN;
        if (dc.bufferedAmount > high) {
          const stalled = await this._drainBuffer(dc);
          // If the drain was force-resolved (SCTP stall / hang / DC closed mid-drain)
          // abort this entire frame sequence now. Continuing to send into a pipe that
          // isn't draining just re-enters _drainBuffer on the very next frame, creating
          // a tight thrash loop: force-resolve → send → stall → force-resolve → …
          if (stalled) {
            console.warn('[send] aborting', dc.label,
              '— stall/hang during drain, buffered =',
              (dc.bufferedAmount / 1024).toFixed(0), 'KB');
            return false;
          }
        }
        if (dc.readyState !== 'open') return false;
        this._xferDiag.bytesSent += frame.byteLength;
        dc.send(frame);
      }
    }
  }

  // Acquire the Android association-level send mutex.
  // Returns a release function to call after the frame has drained, or null if
  // the DC closed / stalled while we were waiting for the previous lock to clear.
  async _acquireAndroidSendLock(budget, dc) {
    // Chain onto whatever is currently holding the lock.
    let release;
    const myTurn = new Promise(r => { release = r; });
    const prev   = budget._sendLock ?? Promise.resolve();
    budget._sendLock = myTurn; // next caller will wait on myTurn
    // Wait for the previous sender to finish draining.
    let prevStalled = false;
    await prev.catch(() => { prevStalled = true; });
    if (prevStalled || dc.readyState !== 'open') {
      release(); // unblock anyone waiting behind us
      return null;
    }
    return release;
  }

  // Called after dc.send() on an Android pool channel.
  // Waits for _drainBuffer, then calls release() to unblock the next sender.
  async _drainAndRelease(dc, budget, release) {
    const stalled = await this._drainBuffer(dc);
    if (stalled) {
      console.warn('[send] Android drain stalled on', dc.label,
        '| buffered =', (dc.bufferedAmount / 1024).toFixed(0), 'KB');
    }
    release();
  }

  // Called only when bufferedAmount exceeded the threshold. Waits for drain,
  // then tunes the shared (or per-DC) budget up/down based on how long it took.
  async _drainBuffer(dc) {
    // Read/write from shared budget if pool channel, else fall back to per-DC.
    const budget = dc._sharedBufHigh ?? dc;
    const high   = budget._bufHigh ?? BUF_MIN;
    const t0     = performance.now();
    const d = this._xferDiag;
    d.drainCount++;
    d.concurrentDrains++;
    if (d.concurrentDrains > d.peakConcurrent) d.peakConcurrent = d.concurrentDrains;
    // Snapshot which channels are currently draining (label them for the log)
    const drainingLabel = `[drain] entering ${dc.label} | buffered=${(dc.bufferedAmount/1024).toFixed(0)}KB high=${(high/1024).toFixed(0)}KB | concurrent=${d.concurrentDrains}`;
    console.debug(drainingLabel);
    // Resume at high/2 so the sender wakes while there is still headroom —
    // avoids the "fill to high, idle until high" pattern that causes long stalls.
    // Floor: the DC's own per-call chunk size (16 KB Android, 256 KB desktop).
    // Previously used Math.max(DC_CHUNK_DESKTOP, high/2) which is wrong: when
    // budget shrinks to BUF_MIN (32 KB), high/2 = 16 KB but Math.max clamps to
    // 256 KB — above the budget — so bufferedamountlow never fires until empty.
    const dcChunk = this._chunkSizeFor(dc._peerId);
    const resume = Math.max(dcChunk, Math.min(DC_CHUNK_DESKTOP, (high / 2) | 0));
    let forceResolved = false;
    await new Promise(r => {
      let done = false;
      const resolve = (reason) => {
        if (done) return;
        done = true;
        clearTimeout(hangTimer);
        clearInterval(poll);
        r();
      };
      dc.bufferedAmountLowThreshold = resume;
      dc.addEventListener('bufferedamountlow', resolve, { once: true });
      // Polling fallback: Safari/WebView does not reliably fire bufferedamountlow.
      // Also detects SCTP flow-control stalls: if bufferedAmount stops decreasing
      // for 500 ms we force-resolve rather than blocking indefinitely.
      let lastBuffered = dc.bufferedAmount;
      let stalledTicks = 0;
      const poll = setInterval(() => {
        const cur = dc.bufferedAmount;
        if (dc.readyState !== 'open' || cur <= resume) {
          dc.removeEventListener('bufferedamountlow', resolve);
          resolve('poll-drained');
          return;
        }
        if (cur >= lastBuffered) {
          stalledTicks++;
          if (stalledTicks >= 20) { // 20 × 50 ms = 1000 ms with no progress
            console.warn('[drain] SCTP stall on', dc.label,
              '| buffered:', cur, 'B unchanged for 3000 ms — force-resolving');
            forceResolved = true;
            dc.removeEventListener('bufferedamountlow', resolve);
            resolve('stall');
          }
        } else {
          stalledTicks = 0; // progress resumed — reset counter
        }
        lastBuffered = cur;
      }, 50);
      const hangTimer = setTimeout(() => {
        console.warn('[drain] bufferedamountlow never fired after 5 s',
          '| dc:', dc.label, '| state:', dc.readyState,
          '| buffered:', dc.bufferedAmount, '| high:', high);
        budget._bufHigh = BUF_MIN;
        forceResolved = true;
        dc.removeEventListener('bufferedamountlow', resolve);
        resolve('hang');
      }, 5_000);
    });
    const elapsed = performance.now() - t0;
    d.drainMs += elapsed;
    d.concurrentDrains--;
    // Always log drain exit so we can see overlap: if multiple channels were
    // draining concurrently their [exit] lines will interleave in the console.
    // Log throughput instead of "slow drain" — the link IS the ceiling.
    // drained = how much left the buffer during this wait (high → current)
    const drained  = Math.max(0, high - dc.bufferedAmount);
    const kbps     = elapsed > 0 ? ((drained * 8) / elapsed).toFixed(0) : '?';
    console.debug(`[drain] exit ${dc.label} | ${Math.round(elapsed)} ms | ~${kbps} kbps | buffered=${(dc.bufferedAmount/1024).toFixed(0)}KB | concurrent=${d.concurrentDrains} | bufHigh=${((budget._bufHigh??BUF_MIN)/1024).toFixed(0)}KB`);
    // Write adaptation result back to shared budget so all pool channels on this
    // peer converge together rather than each channel tuning independently.
    // Android: grow ×1.25 instead of ×2 — the shared SCTP send window is small
    // (~256–512 KB) so aggressive doubling shoots past it in 1–2 cycles and
    // re-saturates it immediately. Slow growth lets the window signal its own limit.
    const growFactor = budget._androidInFlightCap != null ? 1.25 : 2;
    if (elapsed < 20 && budget._bufHigh < (budget._bufMax ?? BUF_MAX)) {
      budget._bufHigh = Math.min(budget._bufMax ?? BUF_MAX, Math.ceil(budget._bufHigh * growFactor));
    } else if (elapsed > 300 && budget._bufHigh > BUF_MIN) {
      // Very slow → shrink aggressively to converge quickly
      budget._bufHigh = Math.max(BUF_MIN, (budget._bufHigh * 0.5) | 0);
    } else if (elapsed > 150 && budget._bufHigh > BUF_MIN) {
      // Moderately slow → gentle shrink
      budget._bufHigh = Math.max(BUF_MIN, (budget._bufHigh * 0.75) | 0);
    }
    // Return whether this drain was force-resolved (SCTP stall, hang timeout, or
    // DC closed) rather than a clean drain. _sendOnDC uses this to abort the
    // current transfer frame sequence immediately — prevents the thrash loop
    // where force-resolve exits then the very next send re-enters drain instantly
    // because bufferedAmount never actually dropped below bufHigh.
    return forceResolved;
  }
}