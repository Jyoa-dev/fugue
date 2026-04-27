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
// Each DataChannel gets its own _bufHigh that tunes itself:
//   drain < 20 ms  → buffer was too small, grow ×1.5 (up to BUF_MAX)
//   drain > 200 ms → buffer was too large, shrink ×0.75 (down to BUF_MIN)
const BUF_MIN = 512  * 1024;       //  512 KB floor
const BUF_MAX =  16  * 1024 * 1024; // 16 MB ceiling

function initialBufHigh() {
  const c = navigator.connection || navigator.mozConnection;
  if (c) {
    if (c.downlink > 10 || c.type === 'wifi')     return  8 * 1024 * 1024; // 8 MB
    if (c.downlink <  2 || c.type === 'cellular') return  1 * 1024 * 1024; // 1 MB
  }
  return 4 * 1024 * 1024; // 4 MB — same as the previous hard-coded default
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
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async addPeer(peerId) {
    if (this._pcs.has(peerId)) return;
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
  async sendOnChannel(dc, buffer) {
    await this._sendOnDC(dc, buffer);
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
    const onOpen = () => {
      if (++openCount < XFER_POOL_SIZE) return;
      console.log('[pool] initiator pool ready for', peerId.slice(0,8));
      this._xferPool.set(peerId, dcs);
      this._xferPoolResolve.get(peerId)?.(dcs);
      this._xferPoolResolve.delete(peerId);
    };
    for (let i = 0; i < XFER_POOL_SIZE; i++) {
      const dc = pc.createDataChannel(`xferp-${i}`, { ordered: true });
      dc.binaryType = 'arraybuffer';
      dc._bufHigh   = initialBufHigh();
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
      console.log('[pc]', peerId, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.dispatchEvent(new CustomEvent('peer_failed', { detail: { peerId } }));
        this.removePeer(peerId);
      }
    };

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
      // Only yield to the event loop when the send buffer is actually full.
      // Avoids ~thousands of unnecessary microtask yields for large transfers.
      if (dc.bufferedAmount > (dc._bufHigh ?? BUF_MIN)) {
        await this._drainBuffer(dc);
      }
      dc.send(frame);
    }
  }

  // Called only when bufferedAmount exceeded the threshold. Waits for drain,
  // then tunes _bufHigh up/down based on how long the drain took.
  async _drainBuffer(dc) {
    const high = dc._bufHigh ?? BUF_MIN;
    const t0   = performance.now();
    await new Promise(r => {
      dc.bufferedAmountLowThreshold = high;
      dc.addEventListener('bufferedamountlow', r, { once: true });
    });
    const elapsed = performance.now() - t0;
    // Fast drain → link can sustain more; grow threshold.
    if (elapsed < 20 && dc._bufHigh < BUF_MAX) {
      dc._bufHigh = Math.min(BUF_MAX, (dc._bufHigh * 1.5) | 0);
    // Slow drain → link is saturated; shrink threshold.
    } else if (elapsed > 200 && dc._bufHigh > BUF_MIN) {
      dc._bufHigh = Math.max(BUF_MIN, (dc._bufHigh * 0.75) | 0);
    }
  }
}