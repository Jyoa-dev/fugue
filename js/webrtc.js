// ── webrtc.js — WebRTC DataChannel peer mesh ────────────────────────────
// Multiple STUN servers: ICE picks the fastest, others are fallbacks.
// STUN only discovers your public IP/port — zero file data touches these servers.
const ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478'   },
  { urls: 'stun:stun.l.google.com:19302'    },
  { urls: 'stun:stun1.l.google.com:19302'   },
  { urls: 'stun:stun.relay.metered.ca:80'   },
];

// Maximum bytes per dc.send() call.
// 64 KB is the safe floor across all browsers — Safari enforces a hard SCTP
// message limit around 64 KB regardless of what Chrome/Firefox allow.
// App-level chunks larger than this are split into multiple DC frames by _sendOnDC
// and re-merged transparently by _handleFrame before the binary event fires.
// Small messages (chat etc.) still hit the total===1 fast-path with zero reassembly.
const DC_CHUNK = 64 * 1024; // 64 KB — required for Safari compatibility

// ── Adaptive back-pressure ───────────────────────────────────────────────
// Each DataChannel gets its own _bufHigh (send watermark) that tunes itself:
//   drain < 20 ms   → buffer too small,  grow  ×1.25 (up to BUF_MAX)
//   drain 150–300ms → buffer slightly large, shrink ×0.75
//   drain > 300 ms  → buffer way too large,  shrink ×0.5  (fast convergence)
//
// The RESUME threshold (bufferedAmountLowThreshold) is set to high/2 so the
// sender wakes up while there is still room in the pipe — no idle stall.
const BUF_MIN = 128  * 1024;        //  128 KB floor  (was 512 KB — too large for cellular)
const BUF_MAX =  16  * 1024 * 1024; //   16 MB ceiling

function initialBufHigh() {
  const c = navigator.connection || navigator.mozConnection;
  if (c) {
    // wifi/downlink detection reflects the LOCAL nic, not the peer's link.
    // Stay conservative so the adaptive can grow rather than stall on first drain.
    if (c.downlink > 10 || c.type === 'wifi')     return 1 * 1024 * 1024; // 1 MB  (was 4 MB)
    if (c.downlink <  2 || c.type === 'cellular') return BUF_MIN;
  }
  return 256 * 1024; // 256 KB default — ramps up quickly if link is fast
}

// ── Transfer pool ────────────────────────────────────────────────────────
// Per-peer pool of XFER_POOL_SIZE pre-opened ordered DataChannels.
// Chunks are striped across them (chunkIndex % pool.length) so each channel
// is its own independent SCTP stream — parallel without head-of-line blocking.
// No per-file channel setup overhead: pool is established at peer connect time.
const XFER_POOL_SIZE = 4;

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
    /** @type {Map<string, { bufHigh: number }>} */
    this._xferBufHigh     = new Map(); // peerId → shared back-pressure budget for pool DCs
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
      // Pre-open the transfer pool — all created before the offer so the
      // SDP carries all streams in one round-trip with no extra negotiation.
      this._openPool(peerId, pc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal({ type: 'rtc_offer', targetId: peerId, sdp: pc.localDescription, senderId: this.myPeerId });
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
    this._dcReady.delete(peerId);
    this._icePending.delete(peerId);
    const pool = this._xferPool.get(peerId);
    if (pool) { pool.forEach(dc => { try { dc.close(); } catch {} }); }
    this._xferPool.delete(peerId);
    this._xferPoolResolve.delete(peerId); // abandons any pending getPoolChannels (timer rejects)
    this._xferPoolBuf.delete(peerId);
    this._xferBufHigh.delete(peerId);
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
      await this._sendOnDC(dc, buffer); // SCTP drain — blocks only this channel's loop
    }
    q.running = false;
  }

  async handleSignal(msg) {
    const { type, senderId } = msg;

    if (type === 'rtc_offer') {
      let pc = this._pcs.get(senderId);
      if (!pc) pc = this._createPC(senderId);
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
        this.sendSignal({ type: 'rtc_answer', targetId: senderId, sdp: pc.localDescription, senderId: this.myPeerId });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'InvalidStateError') return;
        console.warn('rtc_offer handling failed:', e);
      }
    }

    if (type === 'rtc_answer') {
      const pc = this._pcs.get(senderId);
      if (pc && pc.signalingState === 'have-local-offer') {
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
    const shared = { bufHigh: initialBufHigh() };
    this._xferBufHigh.set(peerId, shared);

    const onOpen = () => {
      if (++openCount < XFER_POOL_SIZE) return;
      console.log('[pool] initiator pool ready for', peerId.slice(0,8));
      this._xferPool.set(peerId, dcs);
      this._xferPoolResolve.get(peerId)?.(dcs);
      this._xferPoolResolve.delete(peerId);
    };
    for (let i = 0; i < XFER_POOL_SIZE; i++) {
      const dc = pc.createDataChannel(`xferp-${i}`, { ordered: false }); // ordered:false — no SCTP HOL blocking
      dc.binaryType     = 'arraybuffer';
      dc._sharedBufHigh = shared; // point at shared object, not a per-DC value
      dc.onopen     = onOpen;
      dc.onmessage  = ({ data }) => this._handleFrame(peerId, data);
      dc.onerror    = e => console.warn('pool DC error', peerId, dc.label, e);
      dcs.push(dc);
    }
  }

  // Returns a Promise<RTCDataChannel[]> that resolves once all XFER_POOL_SIZE
  // pool DCs for `peerId` are open. Rejects after `timeoutMs` (default 10 s).
  getPoolChannels(peerId, timeoutMs = 10_000) {
    const pool = this._xferPool.get(peerId);
    if (pool) return Promise.resolve(pool);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._xferPoolResolve.delete(peerId);
        reject(new Error(`pool timeout for ${peerId}`));
      }, timeoutMs);

      this._xferPoolResolve.set(peerId, p => {
        clearTimeout(timer);
        resolve(p);
      });

      // Race guard: pool may have become ready between the get() check above
      // and the resolver being stored.
      const poolNow = this._xferPool.get(peerId);
      if (poolNow) {
        clearTimeout(timer);
        this._xferPoolResolve.delete(peerId);
        resolve(poolNow);
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
        channel.onmessage  = ({ data }) => this._handleFrame(peerId, data);
        channel.onerror    = e => console.warn('pool DC error', peerId, channel.label, e);
        if (!this._xferPoolBuf.has(peerId)) this._xferPoolBuf.set(peerId, []);
        const buf = this._xferPoolBuf.get(peerId);
        const onOpen = () => {
          buf.push(channel);
          if (buf.length === XFER_POOL_SIZE) {
            const pool = buf.slice();
            this._xferPoolBuf.delete(peerId);
            this._xferPool.set(peerId, pool);

            // Shared budget for responder pool — same as initiator side.
            const shared = { bufHigh: initialBufHigh() };
            this._xferBufHigh.set(peerId, shared);
            pool.forEach(dc => { dc._sharedBufHigh = shared; });

            console.log('[pool] responder pool ready for', peerId.slice(0,8));
            this._xferPoolResolve.get(peerId)?.(pool);
            this._xferPoolResolve.delete(peerId);
          }
        };
        if (channel.readyState === 'open') onOpen();
        else channel.onopen = onOpen;
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

    pc.oniceconnectionstatechange = () =>
      console.log('[ice]', peerId.slice(0,8), pc.iceConnectionState);

    return pc;
  }

  // Shared DC (chat, signaling acks). ordered:false, one per peer.
  _setupDC(peerId, dc) {
    this._dcs.set(peerId, dc);
    dc.binaryType = 'arraybuffer';
    dc._bufHigh   = initialBufHigh();

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

  async _sendOnDC(dc, buffer) {
    const bytes      = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
    const total      = Math.ceil(bytes.byteLength / DC_CHUNK) || 1;
    const transferId = (Math.random() * 0xFFFFFFFF) >>> 0;

    for (let i = 0; i < total; i++) {
      const offset     = i * DC_CHUNK;
      const chunkBytes = Math.min(DC_CHUNK, bytes.byteLength - offset);
      const frame      = new ArrayBuffer(12 + chunkBytes);
      const view       = new DataView(frame);
      view.setUint32(0, transferId, true);
      view.setUint32(4, total,      true);
      view.setUint32(8, i,          true);
      // Direct copy from source — skips the intermediate slice() allocation + copy.
      new Uint8Array(frame, 12).set(new Uint8Array(bytes, offset, chunkBytes));
      // Use shared budget if this is a pool channel, else fall back to per-DC _bufHigh.
      const high = (dc._sharedBufHigh ?? dc)._bufHigh ?? BUF_MIN;
      if (dc.bufferedAmount > high) {
        await this._drainBuffer(dc);
      }
      this._xferDiag.bytesSent += frame.byteLength;
      dc.send(frame);
    }
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
    const resume = Math.max(DC_CHUNK, (high / 2) | 0);
    await new Promise(r => {
      let done = false;
      const resolve = () => {
        if (done) return;
        done = true;
        clearTimeout(hangTimer);
        clearInterval(poll);
        r();
      };
      dc.bufferedAmountLowThreshold = resume;
      dc.addEventListener('bufferedamountlow', resolve, { once: true });
      // Polling fallback: Safari iOS does not reliably fire bufferedamountlow.
      const poll = setInterval(() => {
        if (dc.readyState !== 'open' || dc.bufferedAmount <= resume) {
          dc.removeEventListener('bufferedamountlow', resolve);
          resolve();
        }
      }, 50);
      // After 5 s the hang is real; force the threshold to BUF_MIN so the
      // next poll tick unblocks the channel instead of waiting indefinitely.
      const hangTimer = setTimeout(() => {
        console.warn('[drain] bufferedamountlow never fired after 5 s',
          '| dc:', dc.label, '| state:', dc.readyState,
          '| buffered:', dc.bufferedAmount, '| high:', high);
        budget._bufHigh = BUF_MIN;
        dc.bufferedAmountLowThreshold = BUF_MIN;
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
    if (elapsed < 20 && budget._bufHigh < BUF_MAX) {
      // Fast drain → link has headroom, grow conservatively (×1.25 was ×1.5)
      budget._bufHigh = Math.min(BUF_MAX, (budget._bufHigh * 1.25) | 0);
    } else if (elapsed > 300 && budget._bufHigh > BUF_MIN) {
      // Very slow → shrink aggressively to converge quickly
      budget._bufHigh = Math.max(BUF_MIN, (budget._bufHigh * 0.5) | 0);
    } else if (elapsed > 150 && budget._bufHigh > BUF_MIN) {
      // Moderately slow → gentle shrink
      budget._bufHigh = Math.max(BUF_MIN, (budget._bufHigh * 0.75) | 0);
    }
  }
}