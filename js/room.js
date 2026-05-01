// ── room.js — orchestrates relay, crypto, WebRTC P2P file transfers ──────
import { Identity }        from './identity.js';
import { Chunker }         from './chunker.js';
import { RelayConnection } from './relay.js';
import { FileStore }       from './fileStore.js';
import { WebRTCMesh }      from './webrtc.js';
import { initAndroidBridge } from './webrtc_android_bridge.js';
import { isLosslessCompressible, compressGzip, decompressGzip } from './compress.js';



// ── Module-level singletons (avoid per-call allocation) ──────────────────
const ENC = new TextEncoder();
const DEC = new TextDecoder();

// Priority set as a constant — was being re-created on every _enqueue() call.
const PRIORITY_TYPES = new Set([
  'chat', 'peer_joined', 'peer_left', 'welcome', 'read_receipt',
  'rtc_offer', 'rtc_answer', 'rtc_ice',
]);

// ── Binary DC frame format ───────────────────────────────────────────────
// Replaces the old JSON header (~95 bytes) with a fixed 26-byte binary header.
// [0]      type   = 0x01 (chunk) | 0x02 (chat)
// [1..16]  fileId as 16 raw UUID bytes
// [17..20] chunkIndex uint32 LE
// [21..24] totalChunks uint32 LE
// [25]     flags: bit0 = encrypted
// [26..]   payload bytes
const DC_TYPE_CHUNK    = 0x01;
const DC_TYPE_CHAT     = 0x02;
const DC_TYPE_LAN_CAPS = 0x03;   // LAN capability handshake — never relayed
const CHUNK_HDR        = 26;

// Minimum file size to attempt LAN transport (below this WebRTC DC is fast enough).
const LAN_MIN_SIZE = 5 * 1024 * 1024; // 5 MB

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  const out  = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToUuid(b) {
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function encodeDCChunk(fileIdBytes, chunkIndex, totalChunks, encrypted, chunkBuf) {
  const frame = new Uint8Array(CHUNK_HDR + chunkBuf.byteLength);
  const view  = new DataView(frame.buffer);
  frame[0] = DC_TYPE_CHUNK;
  frame.set(fileIdBytes, 1);
  view.setUint32(17, chunkIndex,  true);
  view.setUint32(21, totalChunks, true);
  frame[25] = encrypted ? 0x01 : 0x00;
  frame.set(new Uint8Array(chunkBuf), CHUNK_HDR);
  return frame.buffer;
}

function decodeDCFrame(buffer) {
  if (buffer.byteLength < 1) return null;
  const view = new DataView(buffer);
  const type = view.getUint8(0);

  if (type === DC_TYPE_CHAT) {
    const len  = view.getUint32(1, true);
    const json = DEC.decode(new Uint8Array(buffer, 5, len));
    return { type: 'chat', msg: JSON.parse(json) };
  }

  if (type === DC_TYPE_CHUNK && buffer.byteLength >= CHUNK_HDR) {
    const fileId     = bytesToUuid(new Uint8Array(buffer, 1, 16));
    const chunkIndex = view.getUint32(17, true);
    const totalChunks= view.getUint32(21, true);
    const encrypted  = !!(view.getUint8(25) & 0x01);
    const chunkBuf   = buffer.slice(CHUNK_HDR);
    return { type: 'chunk', fileId, chunkIndex, totalChunks, encrypted, chunkBuf };
  }

  if (type === DC_TYPE_LAN_CAPS) {
    try {
      const json = DEC.decode(new Uint8Array(buffer, 1));
      return { type: 'lan_caps', caps: JSON.parse(json) };
    } catch { return null; }
  }

  return null;
}

// ── CryptoWorker + Pool ──────────────────────────────────────────────────
class CryptoWorker {
  constructor() {
    this._w       = new Worker(new URL('./crypto.js', import.meta.url))
    this._pending = new Map();
    this._seq     = 0;
    this._keyId   = null;
    this._w.onmessage = ({ data }) => {
      const p = this._pending.get(data.id);
      if (!p) return;
      this._pending.delete(data.id);
      data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
    };
  }
  _call(msg, xfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++this._seq;
      this._pending.set(id, { resolve, reject });
      this._w.postMessage({ ...msg, id }, xfer);
    });
  }
  async deriveKey(passphrase, salt, keyId = 'default', settings = {}) {
    await this._call({ op: 'derive', passphrase, salt, keyId, settings });
    this._keyId = keyId;
  }
  encrypt(data, keyId = this._keyId) {
    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    return this._call({ op: 'encrypt', keyId, data: buf }, [buf]);
  }
  decrypt(data, keyId = this._keyId) {
    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    return this._call({ op: 'decrypt', keyId, data: buf }, [buf]);
  }
  terminate() { this._w.terminate(); }
}

// Pool: parallel encrypt across N workers (breaks single-worker serialization
// bottleneck on fast links). Decrypt always routes to worker[0] to guarantee
// FIFO ordering — required for correct in-order streaming to the SW.
class CryptoWorkerPool {
  constructor() {
    const n = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) >> 1));
    this._workers = Array.from({ length: n }, () => new CryptoWorker());
    this._encIdx  = 0;
  }
  async deriveKey(passphrase, salt, keyId, settings) {
    await Promise.all(this._workers.map(w => w.deriveKey(passphrase, salt, keyId, settings)));
  }
  encrypt(data, keyId) {
    // Round-robin: each lane gets its own worker, maximising CPU parallelism.
    const w = this._workers[this._encIdx++ % this._workers.length];
    return w.encrypt(data, keyId);
  }
  decrypt(data, keyId) {
    // Always worker[0]: guarantees decrypted chunks emerge in submission order,
    // so we can pipe them to the SW stream without a reorder buffer.
    return this._workers[0].decrypt(data, keyId);
  }
  terminate() { this._workers.forEach(w => w.terminate()); }
}

// ── StreamingDownloader ──────────────────────────────────────────────────
// Registers sw.js and pipes received chunks directly to the OS via the SW,
// keeping JS heap near zero for large files.
class StreamingDownloader {
  constructor() {
    this._ready = false;
    this._init();
  }

  async _init() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      this._ready = true;
    } catch (e) {
      console.warn('[sw] registration failed — falling back to Blob URL:', e);
    }
  }

  get available() { return this._ready && !!navigator.serviceWorker.controller; }

  open(downloadId, filename, mimeType, size) {
    const sw = navigator.serviceWorker.controller;
    if (!sw) return false;
    sw.postMessage({ type: 'sw_dl', op: 'open', downloadId, filename, mimeType, size });
    const url = `/sw-download/${downloadId}/${encodeURIComponent(filename)}`;
    Object.assign(document.createElement('a'), { href: url, download: filename }).click();
    return true;
  }

  chunk(downloadId, buffer /* ArrayBuffer — ownership transferred */) {
    navigator.serviceWorker.controller
      ?.postMessage({ type: 'sw_dl', op: 'chunk', downloadId, chunk: buffer }, [buffer]);
  }

  done(downloadId) {
    navigator.serviceWorker.controller?.postMessage({ type: 'sw_dl', op: 'done', downloadId });
  }

  abort(downloadId) {
    navigator.serviceWorker.controller?.postMessage({ type: 'sw_dl', op: 'abort', downloadId });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

// Concurrent encrypt+send lanes.
// Desktop → desktop: 32 lanes across the 4-worker pool (8 lanes/worker) keeps
// every crypto worker and the pool DCs continuously saturated.
// Desktop → Android: same 4-pool striped path as desktop-to-desktop now that
// Kotlin's parseDCFrame strips the _sendOnDC 12-byte transport header.
// 32 lanes keeps all crypto workers and all 4 pool DCs continuously saturated.
const SEND_CONCURRENCY = 32;

// Files we can show inline — use Blob URL path so preview works.
// Everything else streams via SW (zero heap for large files).
const PREVIEWABLE = /^(image|video|text)\//i;
const PREVIEWABLE_EXT = /\.(jpg|jpeg|png|gif|webp|svg|avif|mp4|mov|webm|ogg|txt|md|log|csv)$/i;
function isPreviewable(mimeType = '', name = '') {
  return PREVIEWABLE.test(mimeType) || PREVIEWABLE_EXT.test(name);
}

// TURN is intentionally absent — all transfers are end-to-end private.
// This message is shown whenever WebRTC direct connection fails.
const TURN_WARNING =
  `Direct P2P connection failed. This app does not use TURN relay servers — ` +
  `your transfers are always end-to-end private and never route through a third-party server. ` +
  `The downside: symmetric NATs and strict corporate firewalls block direct connections. ` +
  `Try switching to a mobile hotspot or home Wi-Fi if this keeps happening.`;

const TURN_SLOW_WARNING =
  `P2P connection is taking longer than expected. If it fails, both peers need a network ` +
  `that allows direct WebRTC connections (avoid corporate VPNs and symmetric NATs). ` +
  `This app never routes file data through a relay server.`;

// ── Room ─────────────────────────────────────────────────────────────────

export class Room {
  constructor({ relayUrl, canal, passphrase, identity, settings }) {
    this.relayUrl   = relayUrl;
    this.canal      = canal;
    this.passphrase = passphrase;
    this.identity   = identity || Identity.generate();
    this.settings   = settings || {};

    this._crypto      = passphrase ? new CryptoWorkerPool() : null;
    this._cryptoReady = null;
    this._sessionId   = crypto.randomUUID();

    this.peers      = new Map();
    this.myPeerId   = null;
    this.fileStore  = new FileStore();
    this.relay      = null;

    this._foreignPeers  = new Set();
    this._pending       = new Map(); // fileId → Assembler (Blob-URL / previewable path)
    this._swActive      = new Map(); // fileId → { received, total } (SW streaming path)
    this._cancelled     = new Set();
    this._readSent      = new Set();
    this._msgQueue      = [];
    this._priorityQueue = [];
    this._draining      = false;
    this._dcChatQueue   = new Map();
    this._speedMap      = new Map();
    this._rtc           = null;
    this._swDL          = new StreamingDownloader();

    this.onMessage    = null;
    this.onPeerUpdate = null;
    this.onFileUpdate = null;
    this.onStatus     = null;
  }

  async init() {
    const settingsSuffix = (this.settings.cipher || this.settings.kdf)
      ? `:${this.settings.cipher || 'AES-256-GCM'}:${this.settings.kdf || 'PBKDF2-SHA-256'}`
      : '';

    const canalId = this.passphrase
      ? await crypto.subtle.digest('SHA-256', ENC.encode(this.canal + this.passphrase + settingsSuffix))
          .then(b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''))
      : this.canal;

    if (this._crypto) {
      await this._crypto.deriveKey(this.passphrase, canalId, 'identity', this.settings);
    }

    let relayIdentity = this.identity;
    if (this._crypto) {
      const PADDED = 32;
      const raw    = ENC.encode(this.identity);
      const padded = new Uint8Array(PADDED);
      padded.set(raw.subarray(0, PADDED));
      const ct      = await this._crypto.encrypt(padded.buffer, 'identity');
      relayIdentity = btoa(String.fromCharCode(...new Uint8Array(ct)));
    }

    this._cryptoReady = this._crypto
      ? new Promise(r => { this._sessionKeyReady = r; })
      : Promise.resolve();

    this.relay = new RelayConnection(this.relayUrl, canalId, relayIdentity, this._sessionId);
    this.relay.addEventListener('open',    () => this.onStatus?.('connected'));
    this.relay.addEventListener('close',   () => this.onStatus?.('connecting'));
    this.relay.addEventListener('error',   () => this.onStatus?.('error'));
    this.relay.addEventListener('message', e  => this._enqueue(e.detail));
    this.relay.connect();

    this._onBeforeUnload = () => this.leave();
    window.addEventListener('beforeunload', this._onBeforeUnload);

    this._initNativeFilePicker();
  }

  _initNativeFilePicker() {
    if (typeof window.AndroidRtc === 'undefined') return;

    // Listen for files delivered by the Kotlin native picker.
    // webrtc_android_bridge.js wraps them as NativeFile objects and dispatches
    // this event so room.js (and any UI layer) can consume them uniformly.
    window.addEventListener('native-files-picked', (e) => {
      const { files } = e.detail;
      if (!files?.length) return;
      for (const nativeFile of files) {
        // shareFile() expects a File-like object with .name .size .type and
        // either .arrayBuffer() or .slice() — NativeFile provides both.
        this.shareFile(nativeFile).catch(err => {
          console.error('[room] shareFile(NativeFile) failed:', err);
        }).finally(() => {
          // Release the Kotlin-side ContentResolver reference when done.
          nativeFile.release?.();
        });
      }
    });
  }

  openNativeFilePicker() {
    if (typeof window.AndroidRtc !== 'undefined' && window.AndroidRtc.openFilePicker) {
      window.AndroidRtc.openFilePicker();
    } else {
      // Desktop fallback: trigger a hidden file input.
      const input     = document.createElement('input');
      input.type      = 'file';
      input.multiple  = true;
      input.onchange  = () => {
        if (!input.files?.length) return;
        for (const f of input.files) this.shareFile(f).catch(console.error);
      };
      input.click();
    }
  }

  // ── WebRTC ──────────────────────────────────────────────────────────────

  _initRTC() {
    if (this._rtc) {
      if (this._rtc.myPeerId === this.myPeerId) return;
      for (const peerId of this._rtc._pcs.keys()) this._rtc.removePeer(peerId);
      if (window._webrtcMesh === this._rtc) window._webrtcMesh = null;
      this._rtc = null;
    }
    // Patch WebRTCMesh prototype for native Android WebRTC.
    // Done here — not at module load — because window.AndroidRtc is injected by
    // the Kotlin WebView *after* the JS bundle evaluates, so it isn't visible at
    // import time. initAndroidBridge is idempotent (checks a guard flag) so
    // repeated calls on reconnect are safe.
    initAndroidBridge(WebRTCMesh);
    this._rtc = new WebRTCMesh(obj => this.relay.send(obj), this.myPeerId);
    window._webrtcMesh = this._rtc;

    this._rtc.addEventListener('binary', async ({ detail: { peerId, buffer } }) => {
      const frame = decodeDCFrame(buffer);
      if (!frame) return;
      if (frame.type === 'chat') {
        this.onMessage?.({ ...frame.msg, type: 'chat' });
        return;
      }
      if (frame.type === 'lan_caps') {
        // Forward to Kotlin — it will decide whether to attempt a TCP connection.
        window.NativeBridge?.onLanCaps(peerId, JSON.stringify(frame.caps));
        return;
      }
      if (frame.type === 'chunk') {
        await this._receiveChunk({ ...frame, fromDC: true });
      }
    });

    this._rtc.addEventListener('peer_ready', ({ detail: { peerId } }) => {
      const queue = this._dcChatQueue.get(peerId);
      if (queue?.length) {
        this._dcChatQueue.delete(peerId);
        for (const frame of queue) this._rtc.sendBinary(peerId, frame).catch(console.warn);
      }
      // Advertise LAN capability so both sides can attempt TCP if both are Android.
      this._sendLanCaps(peerId);
    });

    this._rtc.addEventListener('peer_failed', ({ detail: { peerId } }) => {
      this._dcChatQueue.delete(peerId);
      const identity = this.peers.get(peerId)?.identity || peerId.slice(0, 8);
      this.onMessage?.({ type: 'system', text: `${identity}: ${TURN_WARNING}`, subtype: 'warning' });
    });

    // ── Kotlin → JS callbacks for native receive path ─────────────────────
    // Kotlin reassembles, decrypts, and saves inbound files entirely natively.
    // These callbacks are the only JS involvement on the receive side.
    if (typeof window.AndroidRtc !== 'undefined') {
      window._nativeProgress = (fileId, ratio) => {
        this.fileStore.updateProgress(fileId, ratio);
        // Track received chunk count so requestFile() can resume from the
        // correct startChunk instead of always restarting from 0.
        const progEntry = this.fileStore.get(fileId);
        if (progEntry?.totalChunks) {
          if (!this._androidChunksReceived) this._androidChunksReceived = new Map();
          this._androidChunksReceived.set(fileId, Math.floor(ratio * progEntry.totalChunks));
        }
        this.onFileUpdate?.();
      };

      window._nativeFileDone = (fileId, name, mime) => {
        this._androidChunksReceived?.delete(fileId);
        this.fileStore.setStatus(fileId, 'done');
        this.fileStore.updateProgress(fileId, 1);
        this.onFileUpdate?.();
        this.onMessage?.({ type: 'system', text: `${name} saved to Downloads`, subtype: 'receipt' });
      };

      window._nativeFileError = (fileId, name, msg) => {
        this._androidChunksReceived?.delete(fileId);
        console.error('[native-save] error', name, msg);
        this.fileStore.setStatus(fileId, 'error');
        this.onFileUpdate?.();
        this.onMessage?.({ type: 'system', text: `Failed to save ${name}: ${msg}`, subtype: 'warning' });
      };

      window._nativeRelayReceipt = (fileId, peerId) => {
        this.relay.send({ type: 'receipt', fileId, receiptType: 'downloaded', senderId: this.myPeerId, senderName: this.identity });
        if (this._crypto) this.relay.send({ type: 'receipt', fileId, receiptType: 'decrypted', senderId: this.myPeerId, senderName: this.identity });
      };
    }
  }

  // ── Queue ────────────────────────────────────────────────────────────────

  _enqueue(msg) {
    if (PRIORITY_TYPES.has(msg.type)) this._priorityQueue.push(msg);
    else                              this._msgQueue.push(msg);
    if (!this._draining) this._drain();
  }

  async _drain() {
    this._draining = true;
    while (this._priorityQueue.length || this._msgQueue.length) {
      const msg = this._priorityQueue.length ? this._priorityQueue.shift() : this._msgQueue.shift();
      await this._handle(msg);
    }
    this._draining = false;
  }

  // ── Handler ──────────────────────────────────────────────────────────────

  async _handle(msg) {
    if (!['rtc_ice', 'rtc_offer', 'rtc_answer'].includes(msg.type))
      console.log('[handle]', msg.type, JSON.stringify(msg).slice(0, 120));
    switch (msg.type) {

      case 'welcome': {
        if (msg.salt) {
          const prev  = sessionStorage.getItem('_lastSalt');
          sessionStorage.setItem('_lastSalt', msg.salt);
          console.log(`[crypto] salt ${msg.salt !== prev ? 'NEW' : 'REUSED'}: ${msg.salt}`);
        }
        if (this._crypto && msg.salt) {
          await this._crypto.deriveKey(this.passphrase, msg.salt, 'session');
          this._crypto._workers.forEach(w => { w._keyId = 'session'; });
          this._sessionKeyReady?.();
          // Hand the session key material to Kotlin so it can decrypt inbound
          // DC chunks natively. Must be called after deriveKey resolves so both
          // sides derive from the same welcome salt with the same parameters.
          // Kotlin only supports AES-256-GCM / PBKDF2-SHA-256 — if the room
          // was opened with a different cipher/kdf combo Kotlin logs a warning
          // and skips derivation; those transfers will fail decrypt on Android.
          if (typeof window.AndroidRtc !== 'undefined') {
            const cipher = this.settings?.cipher || 'AES-256-GCM';
            const kdf    = this.settings?.kdf    || 'PBKDF2-SHA-256';
            console.log('[crypto] → AndroidRtc.setSessionKey cipher=', cipher, 'kdf=', kdf);
            window.AndroidRtc.setSessionKey(this.passphrase, msg.salt, cipher, kdf);
          }
        }
        this.myPeerId = msg.peerId;
        this.peers.set(msg.peerId, { identity: this.identity, color: Identity.colorFor(this.identity), isMe: true });
        for (const p of msg.peers) {
          const ident = await this._decryptIdentity(p.identity);
          this.peers.set(p.peerId, { identity: ident, color: Identity.colorFor(ident), isMe: false });
        }
        this.onPeerUpdate?.();
        this._initRTC();
        for (const p of msg.peers) {
          if (this.peers.get(p.peerId)?.identity === '[unknown]') { this._foreignPeers.add(p.peerId); continue; }
          this._rtc.addPeer(p.peerId).catch(console.warn);
        }
        this._broadcastManifest();
        break;
      }

      case 'peer_joined': {
        const ident = await this._decryptIdentity(msg.identity);
        this.peers.set(msg.peerId, { identity: ident, color: Identity.colorFor(ident), isMe: false });
        this.onPeerUpdate?.();
        this.onMessage?.({ type: 'system', text: `${ident} joined`, subtype: 'join' });
        if (this.peers.size >= 6)
          this.onMessage?.({ type: 'system', text: `Transfer speeds may be lower with many peers (${this.peers.size} connected).`, subtype: 'warning' });
        this._broadcastManifest();
        if (ident === '[unknown]') { this._foreignPeers.add(msg.peerId); }
        else { this._rtc?.addPeer(msg.peerId).catch(console.warn); }
        break;
      }

      case 'peer_left':
        this._foreignPeers.delete(msg.peerId);
        this.peers.delete(msg.peerId);
        this._rtc?.removePeer(msg.peerId);
        this.onPeerUpdate?.();
        this.onMessage?.({ type: 'system', text: `${msg.identity} left`, subtype: 'leave' });
        break;

      case 'rtc_offer':
      case 'rtc_answer':
      case 'rtc_ice':
        if (msg.targetId !== this.myPeerId) break;
        if (!this._foreignPeers.has(msg.senderId)) this._rtc?.handleSignal(msg);
        break;

      case 'chat': {
        let text = msg.text, decryptFailed = false;
        if (this._crypto && msg.encrypted) {
          try {
            const bytes = Uint8Array.from(atob(msg.text), c => c.charCodeAt(0)).buffer;
            const dec   = await this._crypto.decrypt(bytes);
            text        = DEC.decode(dec);
          } catch { text = '[decryption failed]'; decryptFailed = true; }
        }
        const messageId = msg.messageId || `${msg.senderId}-${msg.time}`;
        this.onMessage?.({ type: 'chat', senderId: msg.senderId, senderName: msg.senderName, text, decryptFailed, time: msg.time, messageId });
        if (document.visibilityState === 'visible') this.sendReadReceipt(msg.senderId, messageId);
        break;
      }

      case 'read_receipt':
        if (msg.readerId !== this.myPeerId)
          this.onMessage?.({ type: 'read_receipt', readerId: msg.readerId, readerName: msg.readerName, messageId: msg.messageId });
        break;

      case 'file_announce': {
        const meta = { id: msg.fileId, name: msg.name, size: msg.size, mimeType: msg.mimeType, encrypted: msg.encrypted, senderId: msg.senderId, senderName: msg.senderName, totalChunks: msg.totalChunks, compression: msg.compression || null };
        this.fileStore.register(meta);
        // Tell Kotlin the file metadata so it can save correctly on transfer complete.
        if (typeof window.AndroidRtc !== 'undefined') {
          window.AndroidRtc.announceFile(
            msg.fileId, msg.name, msg.mimeType || 'application/octet-stream',
            msg.size, msg.totalChunks, msg.compression || '', msg.senderId
          );
        }
        this.onFileUpdate?.();
        this.onMessage?.({ type: 'file_announce', senderId: msg.senderId, senderName: msg.senderName, fileId: msg.fileId, name: msg.name, size: msg.size });
        break;
      }

      case 'file_request':
        this._sendChunks(msg.fileId, msg.requesterId, msg.startChunk ?? 0);
        break;

      case 'file_chunk': {
        const { fileId, chunkIndex, totalChunks, data, encrypted } = msg;
        if (this._cancelled.has(fileId)) break;
        let chunkBuf;
        if (this._crypto && encrypted) {
          try {
            const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0)).buffer;
            chunkBuf    = await this._crypto.decrypt(bytes);
          } catch { console.warn('relay chunk decrypt failed'); break; }
        } else {
          chunkBuf = Uint8Array.from(atob(data), c => c.charCodeAt(0)).buffer;
        }
        await this._receiveChunk({ fileId, chunkIndex, totalChunks, chunkBuf, encrypted, fromDC: false });
        break;
      }

      case 'receipt':
        this.fileStore.addReceipt(msg.fileId, msg.senderId, msg.senderName, msg.receiptType);
        this.onFileUpdate?.();
        this.onMessage?.({ type: 'system', text: `${msg.senderName} ${msg.receiptType === 'downloaded' ? 'downloaded' : msg.receiptType === 'decrypted' ? 'decrypted' : 'received'} a file`, subtype: 'receipt' });
        break;

      case 'transfer_pause':
        // Receiver paused — stop sending chunks for this file.
        if (msg.targetId === this.myPeerId) {
          this._cancelled.add(msg.fileId);
          console.log('[sendChunks] paused by receiver, fileId=', msg.fileId.slice(0, 8));
        }
        break;

      case 'transfer_cancel':
        // Receiver cancelled — stop sending and forget the file request.
        if (msg.targetId === this.myPeerId) {
          this._cancelled.add(msg.fileId);
          console.log('[sendChunks] cancelled by receiver, fileId=', msg.fileId.slice(0, 8));
        }
        break;

      case 'manifest':
        for (const f of msg.files) { if (!this.fileStore.get(f.id)) this.fileStore.register(f); }
        this.onFileUpdate?.();
        break;
    }
  }

  // ── Chunk reception ──────────────────────────────────────────────────────

  async _receiveChunk({ fileId, chunkIndex, totalChunks, chunkBuf, encrypted, fromDC }) {
    // On Android, inbound DC frames are handled entirely by Kotlin (NativeRtcBridge).
    // Kotlin reassembles, decrypts, decompresses, and writes to MediaStore natively.
    // _nativeProgress / _nativeFileDone fire when Kotlin is done — no JS work needed.
    if (fromDC && typeof window.AndroidRtc !== 'undefined') return;
    if (this._cancelled.has(fileId)) return;
    if (chunkIndex === 0) console.log('[receiveChunk] first chunk', { fileId: fileId.slice(0,8), totalChunks, fromDC, swAvailable: this._swDL.available });

    // Speed tracking
    const now = Date.now();
    let spd = this._speedMap.get(fileId);
    if (!spd) { spd = { bytes: 0, lastTs: now, bps: 0 }; this._speedMap.set(fileId, spd); }
    spd.bytes += chunkBuf.byteLength;
    const elapsed = (now - spd.lastTs) / 1000;
    if (elapsed >= 0.5) { spd.bps = spd.bytes / elapsed; spd.bytes = 0; spd.lastTs = now; this.fileStore.setSpeed(fileId, spd.bps); }

    // Decrypt if needed (worker[0] always — preserves FIFO order for SW streaming).
    // Skip when encrypted=false: NativeRtcBridge.kt decrypts AES-GCM chunks natively
    // and clears the flag before delivery, so hitting the JS crypto worker here would
    // double-decrypt and corrupt the data. For browser peers encrypted is always true
    // when this._crypto is set, so this check is a no-op on the desktop path.
    let data = chunkBuf;
    if (fromDC && this._crypto && encrypted) {
      try { data = await this._crypto.decrypt(chunkBuf, 'session'); }
      catch { console.warn('DC chunk decrypt failed'); return; }
    }

    const entry = this.fileStore.get(fileId);

    // ── SW streaming path (large non-previewable, non-compressed files) ──
    // Chunks stream chunk-by-chunk directly to the OS write buffer.
    // Compressed files must use the assembler path so we can decompress the
    // complete blob before handing it off — gzip is a whole-stream format.
    // Peak JS heap = one chunk (256 KB) instead of the full file.
    if (this._swDL.available && !isPreviewable(entry?.mimeType, entry?.name) && !entry?.compression) {
      let sw = this._swActive.get(fileId);
      if (!sw) {
        sw = { received: 0, total: totalChunks };
        this._swActive.set(fileId, sw);
        console.log('[receiveChunk] SW path — opening stream', { fileId: fileId.slice(0,8), totalChunks });
        this._swDL.open(fileId, entry?.name || fileId, entry?.mimeType, entry?.size);
      }
      // Transfer ownership of the decrypted buffer to the SW — zero copy.
      this._swDL.chunk(fileId, data instanceof ArrayBuffer ? data : data.buffer);
      sw.received++;
      this.fileStore.updateProgress(fileId, sw.received / sw.total);
      if (sw.received === sw.total) {
        this._swActive.delete(fileId);
        this._speedMap.delete(fileId);
        this._swDL.done(fileId);
        this.fileStore.setStatus(fileId, 'done');
        this.onFileUpdate?.();
        this.relay.send({ type: 'receipt', fileId, receiptType: 'downloaded', senderId: this.myPeerId, senderName: this.identity });
        if (this._crypto) this.relay.send({ type: 'receipt', fileId, receiptType: 'decrypted', senderId: this.myPeerId, senderName: this.identity });
      }
      return;
    }

    // ── Assembler path (previewable files, or SW unavailable) ────────────
    // assembleBlob() on completion is zero-copy: Blob holds ArrayBuffer refs
    // without concatenating — one OS copy when the URL is resolved.
    if (!this._pending.has(fileId)) this._pending.set(fileId, new Chunker.Assembler(totalChunks));
    const asm = this._pending.get(fileId);
    asm.add(chunkIndex, data);
    this.fileStore.updateProgress(fileId, asm.progress);

    if (asm.complete) {
      this._speedMap.delete(fileId);
      let blob = asm.assembleBlob(entry?.mimeType);
      // Decompress if the sender applied lossless gzip compression.
      if (entry?.compression === 'gzip') {
        try { blob = await decompressGzip(blob, entry?.mimeType); }
        catch (e) { console.error('[decompress] gzip failed for', fileId, e); }
      }
      this._pending.delete(fileId);
      const previewUrl = this._saveFile(blob, entry);
      if (previewUrl) this.fileStore.setPreviewUrl(fileId, previewUrl);
      this.fileStore.setBuffer(fileId, blob);
      this.fileStore.setStatus(fileId, 'done');
      this.onFileUpdate?.();
      this.relay.send({ type: 'receipt', fileId, receiptType: 'downloaded', senderId: this.myPeerId, senderName: this.identity });
      if (this._crypto) this.relay.send({ type: 'receipt', fileId, receiptType: 'decrypted', senderId: this.myPeerId, senderName: this.identity });
    }
  }

  // ── Adaptive chunk size ───────────────────────────────────────────────────
  // Larger chunks = fewer crypto round-trips and sendOne calls per file.
  // App chunks larger than DC_CHUNK (webrtc.js) are transparently split into
  // multiple DC frames by _sendOnDC, so there is no hard upper-bound here.
  // Tiers are tuned so async overhead per GB drops as file size grows.
  _computeChunkSize(fileSize) {
    const KB = 1024, MB = 1024 * KB;
    let base;
    if      (fileSize <  512 * KB) base = Math.max(32  * KB, Math.ceil(fileSize / 4));
    else if (fileSize <   32 * MB) base = 256 * KB;
    else if (fileSize <  256 * MB) base = 512 * KB;
    else                           base =   1 * MB;
    return base;
  }

  // ── LAN transport helpers ─────────────────────────────────────────────────

  /** Broadcast our LAN capabilities to [peerId] over the open DC. */
  _sendLanCaps(peerId) {
    if (typeof window.AndroidRtc === 'undefined') return;
    try {
      const caps = JSON.stringify({
        android     : true,
        peerId      : this.myPeerId,
        lanIp       : window.AndroidRtc.getLanIp?.() || '',
        directReady : false,
      });
      const payload = ENC.encode(caps);
      const frame   = new Uint8Array(1 + payload.byteLength);
      frame[0]      = DC_TYPE_LAN_CAPS;
      frame.set(payload, 1);
      this._rtc.sendBinary(peerId, frame.buffer).catch(e =>
        console.warn('[lan] sendLanCaps failed:', e.message)
      );
      console.log('[lan] sent lan_caps to', peerId.slice(0, 8));
    } catch (e) {
      console.warn('[lan] _sendLanCaps error:', e.message);
    }
  }

  /**
   * Wait up to [ms] for Kotlin to establish a TCP session with [peerId].
   * Returns true if ready, false on timeout.
   * Polling interval is short — Kotlin calls _lanReady() as soon as connected,
   * so in the happy path this resolves within one tick.
   */
  _waitForLanReady(peerId, ms = 10_000) {
    return new Promise(resolve => {
      // Fast path: already ready (e.g. inbound connection arrived first).
      if (window.NativeBridge?.isLanReady(peerId)) { resolve(true); return; }

      const timer = setTimeout(() => {
        window.removeEventListener('_lanReady:' + peerId, onReady);
        window.removeEventListener('_lanFailed:' + peerId, onFail);
        console.log('[lan] waitForLanReady timeout for', peerId.slice(0, 8));
        resolve(false);
      }, ms);

      const onReady = () => { clearTimeout(timer); window.removeEventListener('_lanFailed:' + peerId, onFail); resolve(true); };
      const onFail  = () => { clearTimeout(timer); window.removeEventListener('_lanReady:'  + peerId, onReady); resolve(false); };

      // transport.js fires these synthetic events when Kotlin calls back.
      window.addEventListener('_lanReady:' + peerId, onReady, { once: true });
      window.addEventListener('_lanFailed:' + peerId, onFail,  { once: true });
    });
  }

  // ── File sending ─────────────────────────────────────────────────────────

  async _sendChunks(fileId, requesterId, startChunk = 0) {
    // Clear any pause/cancel flag from a previous request for this file so a
    // resume (new file_request with startChunk > 0) actually sends chunks.
    this._cancelled.delete(fileId);
    console.log('[sendChunks] start', { fileId: fileId.slice(0,8), requesterId: requesterId.slice(0,8), startChunk });
    const entry = this.fileStore.get(fileId);
    if (!entry?.file) { console.warn('[sendChunks] no entry.file — aborting'); return; }
    console.log('[sendChunks] file ok', { size: entry.file.size, chunkSize: entry.chunkSize });

    // Wait for shared DC (confirms PeerConnection is live).
    const hasCh = this._rtc?.hasChannel(requesterId);
    console.log('[sendChunks] hasChannel:', hasCh);
    if (!hasCh) {
      console.log('[sendChunks] waiting for peer_ready…');
      const ok = await new Promise(resolve => {
        const timer   = setTimeout(() => resolve(false), 8000);
        const onReady = ({ detail }) => {
          if (detail.peerId !== requesterId) return;
          clearTimeout(timer);
          this._rtc.removeEventListener('peer_ready', onReady);
          resolve(true);
        };
        this._rtc?.addEventListener('peer_ready', onReady);
        if (this._rtc?.hasChannel(requesterId)) {
          clearTimeout(timer); this._rtc.removeEventListener('peer_ready', onReady); resolve(true);
        }
      });
      console.log('[sendChunks] peer_ready result:', ok);
      if (!ok) {
        const name = this.peers.get(requesterId)?.identity || requesterId.slice(0, 8);
        this.onMessage?.({ type: 'system', text: `Cannot send file to ${name} — no P2P connection. ${TURN_WARNING}`, subtype: 'warning' });
        return;
      }
    }

    // Use the pre-opened pool DCs — no per-transfer channel setup overhead.
    // Chunks are striped by index so each DC is an independent SCTP stream.
    let dcPool;
    console.log('[sendChunks] calling getPoolChannels…');
    try {
      dcPool = await this._rtc.getPoolChannels(requesterId);
      console.log('[sendChunks] pool ready, size:', dcPool.length, 'states:', dcPool.map(d => d.readyState));
    } catch (e) {
      console.error('[sendChunks] getPoolChannels failed:', e.message);
      const name = this.peers.get(requesterId)?.identity || requesterId.slice(0, 8);
      this.onMessage?.({ type: 'system', text: `Could not open transfer channel to ${name}: ${e.message}`, subtype: 'warning' });
      return;
    }

    // Pre-encode fileId bytes once (saves 16 parseInt calls per chunk).
    const fileIdBytes = uuidToBytes(fileId);

    // ── LAN fast-path (files ≥ 5 MB, Android only) ───────────────────────
    // Attempt TCP over Wi-Fi Direct or LAN before falling through to WebRTC DC.
    // On Android, the bridge's patched sendOnChannel/getPoolChannels already
    // route through native WebRTC; the LAN TCP path is an additional shortcut
    // for very large files where TCP throughput exceeds SCTP.
    let useLan = false;
    if (entry.file.size >= LAN_MIN_SIZE && typeof window.AndroidRtc !== 'undefined') {
      console.log('[lan] file is', (entry.file.size / 1024 / 1024).toFixed(1), 'MB — attempting LAN connect to', requesterId.slice(0, 8));
      useLan = await this._waitForLanReady(requesterId, 10_000);
      console.log('[lan] useLan =', useLan);
    }

    // ── Android peer detection — evaluated AFTER pool/peer handshake ──────
    // _androidPeers is populated when the WebRTC offer/answer is processed.
    // file_request can arrive over the relay before the WebRTC handshake
    // completes, so reading _androidPeers before getPoolChannels (which waits
    // for the connection to be live) would race and return false for Android
    // peers. All Android-dependent values are derived here, after the awaits.
    const isAndroidPeer = this._rtc._androidPeers?.has(requesterId) === true;
    console.log('[sendChunks] isAndroidPeer:', isAndroidPeer, 'for', requesterId.slice(0, 8));

    // effectiveChunkSize: pool path uses _sendOnDC which auto-fragments, so
    // no Android-specific cap is needed. Both peer types use the same chunk size.
    const effectiveChunkSize = entry.chunkSize;

    // Seed log — both peer types use the pool path now.
    if (isAndroidPeer) {
      console.log('[sendChunks] Android peer — pool path (4 DCs) for', requesterId.slice(0, 8));
    }

    const sendOne = async (chunk) => {
      if (this._cancelled.has(fileId) || aborted) return;
      let chunkBuf = chunk.data;
      if (this._crypto) chunkBuf = await this._crypto.encrypt(chunk.data, 'session');
      if (this._cancelled.has(fileId) || aborted) return; // recheck after async encrypt
      const frame = encodeDCChunk(fileIdBytes, chunk.index, chunk.total, !!this._crypto, chunkBuf);

      if (useLan) {
        // btoa(String.fromCharCode(...new Uint8Array(frame))) spreads the entire
        // buffer into a temporary string before encoding — O(n) allocation on every
        // chunk. At LAN speeds (where this path is taken) that becomes the CPU
        // ceiling. Process in 8 KB slices instead: each slice fits in L1/L2 cache
        // and the string is discarded immediately after btoa encodes it.
        const bytes = new Uint8Array(frame instanceof ArrayBuffer ? frame : frame.buffer);
        let b64 = '';
        const SLICE = 8192;
        for (let i = 0; i < bytes.length; i += SLICE) {
          b64 += btoa(String.fromCharCode(...bytes.subarray(i, i + SLICE)));
        }
        const ok  = window.AndroidRtc.sendLanChunk(requesterId, b64);
        if (!ok) {
          console.warn('[lan] sendLanChunk failed at chunk', chunk.index, '— falling back to WebRTC');
          useLan = false;
        } else {
          return;
        }
      }

      if (isAndroidPeer) {
        // Pool path: same as desktop. Kotlin's parseDCFrame now strips the
        // 12-byte _sendOnDC transport header, so the 4-pool striped path works
        // for Android peers. HOL blocking and the 512 KB buffer ceiling are gone.
        const dc = dcPool[chunk.index % dcPool.length];
        await this._rtc.sendOnChannel(dc, frame);
        return;
      }

      const dc = dcPool[chunk.index % dcPool.length];
      await this._rtc.sendOnChannel(dc, frame);
    };

    // All peers now use the 4-pool striped path. Single concurrency value.
    const activeConcurrency = SEND_CONCURRENCY;
    const lanes = new Array(activeConcurrency).fill(Promise.resolve());
    let lane = 0;
    let chunkCount = 0;
    let aborted = false;
    for await (const chunk of Chunker.chunkFile(entry.file, effectiveChunkSize, startChunk)) {
      if (this._cancelled.has(fileId)) { aborted = true; break; }
      const l = lane++ % activeConcurrency;
      await lanes[l];                                         // free the slot first
      if (this._cancelled.has(fileId)) { aborted = true; break; }
      if (chunkCount === 0) console.log('[sendChunks] first chunk, total:', chunk.total);
      chunkCount++;
      lanes[l] = sendOne(chunk);
    }
    // Drain in-flight lanes, but ignore errors from closed DCs when aborted.
    if (aborted) {
      await Promise.allSettled(lanes);
    } else {
      await Promise.all(lanes);
    }
    console.log('[sendChunks] done, sent', chunkCount, 'chunks', aborted ? '(aborted)' : '');


    if (!aborted && !this._cancelled.has(fileId)) {
      this.fileStore.addReceipt(fileId, requesterId, this.peers.get(requesterId)?.identity || requesterId, 'sent');
      this.onFileUpdate?.();
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  async _decryptIdentity(raw) {
    if (!this._crypto) return raw;
    try {
      const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0)).buffer;
      const dec   = await this._crypto.decrypt(bytes, 'identity');
      return DEC.decode(dec).replace(/\0+$/, '');
    } catch { return '[unknown]'; }
  }

  _saveFile(blob, meta) {
    const b    = blob instanceof Blob ? blob : new Blob([blob], { type: meta?.mimeType || 'application/octet-stream' });
    const name = meta?.name || 'download';

    // Android: Kotlin handles saving natively via _nativeFileDone callback.
    // _saveFile is only called from the assembler path (relay fallback, previewable files).
    // On the DC path, Kotlin already saved the file — this is never reached.
    // For relay fallback on Android (edge case): still save via Kotlin so it lands in MediaStore.
    if (typeof window.AndroidRtc !== 'undefined') {
      const previewUrl = isPreviewable(meta?.mimeType, name) ? URL.createObjectURL(b) : null;
      b.arrayBuffer().then(buf => {
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        window.AndroidRtc.saveFile(name, meta?.mimeType || 'application/octet-stream', btoa(bin));
      }).catch(err => console.error('[_saveFile] arrayBuffer() failed:', err));
      return previewUrl;
    }

    // Desktop / non-Android path — unchanged.
    const url = URL.createObjectURL(b);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    if (isPreviewable(meta?.mimeType, name)) return url;
    URL.revokeObjectURL(url);
    return null;
  }

  _broadcastManifest() {
    const files = this.fileStore.getAll()
      .filter(f => f.senderId === this.myPeerId)
      .map(({ id, name, size, mimeType, encrypted, senderId, senderName, totalChunks, compression }) =>
        ({ id, name, size, mimeType, encrypted, senderId, senderName, totalChunks, compression }));
    if (files.length) this.relay.send({ type: 'manifest', files });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  sendReadReceipt(targetPeerId, messageId) {
    if (!messageId || this._readSent.has(messageId)) return;
    this._readSent.add(messageId);
    this.relay.send({ type: 'read_receipt', messageId, targetPeerId, readerId: this.myPeerId, readerName: this.identity });
  }

  async sendMessage(text) {
    const messageId = `${this.myPeerId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const chatMsg   = { type: 'chat', text, encrypted: false, senderId: this.myPeerId, senderName: this.identity, time: Date.now(), messageId };
    const msgBytes  = ENC.encode(JSON.stringify(chatMsg));
    const frame     = new Uint8Array(1 + 4 + msgBytes.byteLength);
    frame[0] = DC_TYPE_CHAT;
    new DataView(frame.buffer).setUint32(1, msgBytes.byteLength, true);
    frame.set(msgBytes, 5);
    const buf = frame.buffer;

    if (this._rtc) {
      for (const [peerId] of this.peers) {
        if (peerId === this.myPeerId) continue;
        if (this._rtc.hasChannel(peerId)) {
          this._rtc.sendBinary(peerId, buf).catch(console.warn);
        } else {
          if (!this._dcChatQueue.has(peerId)) {
            this._dcChatQueue.set(peerId, []);
            setTimeout(() => {
              if (this._dcChatQueue.get(peerId)?.length) {
                this.onMessage?.({ type: 'system', text: TURN_SLOW_WARNING, subtype: 'warning' });
              }
            }, 10_000);
          }
          this._dcChatQueue.get(peerId).push(buf);
        }
      }
    }

    this.onMessage?.({ type: 'chat', senderId: this.myPeerId, senderName: this.identity, text, time: Date.now(), self: true, messageId });
  }

  async shareFile(file) {
    // ── Auto lossless gzip for compressible text/data types ──────────────
    // Transparent to both peers: compressed on send, decompressed on receive.
    // Skipped silently if gzip would grow the file (already-compressed data).
    let transferFile = file;
    let compression  = null;
    if (isLosslessCompressible(file.type, file.name) && file.size > 8192) {
      try {
        const compressed = await compressGzip(file);
        if (compressed.size < file.size * 0.95) {          // only if saves ≥ 5%
          transferFile = new File([compressed], file.name, { type: file.type });
          compression  = 'gzip';
          console.log(`[compress] gzip ${file.name}: ${file.size} → ${compressed.size} bytes`);
        }
      } catch (e) { console.warn('[compress] gzip failed, sending raw:', e); }
    }

    const fileId      = crypto.randomUUID();
    const chunkSize   = this._computeChunkSize(transferFile.size);
    const totalChunks = Math.ceil(transferFile.size / chunkSize) || 1;
    // size = original (display on receiver); totalChunks = based on transfer file
    const meta        = { id: fileId, name: file.name, size: file.size, mimeType: file.type, encrypted: !!this._crypto, senderId: this.myPeerId, senderName: this.identity, totalChunks, chunkSize, file: transferFile, compression };
    this.fileStore.register(meta, transferFile);
    this.relay.send({ type: 'file_announce', fileId, name: file.name, size: file.size, mimeType: file.type, encrypted: !!this._crypto, senderId: this.myPeerId, senderName: this.identity, totalChunks, compression });
    this.onFileUpdate?.();
    this.onMessage?.({ type: 'file_announce', senderId: this.myPeerId, senderName: this.identity, fileId, name: file.name, size: file.size, self: true });
  }

  requestFile(fileId) {
    console.log('[requestFile] sending file_request', fileId.slice(0,8));
    this._cancelled.delete(fileId);
    // Tell Kotlin to clear its cancelled flag so inbound chunks are accepted again.
    // announceFile() also clears it, but this covers re-downloading a paused file
    // in the same session without a fresh announce.
    if (typeof window.AndroidRtc !== 'undefined') window.AndroidRtc.resumeTransfer(fileId);

    let startChunk = 0;

    if (typeof window.AndroidRtc !== 'undefined') {
      // Android: JS assembler (_pending) is never populated because _receiveChunk
      // exits early on the DC path. Ask Kotlin directly for the exact chunk count
      // written to the partial temp file (returns -1 if no assembler / fresh download).
      const nativeCount = window.AndroidRtc.getReceivedChunkCount?.(fileId) ?? -1;
      if (nativeCount > 0) {
        startChunk = nativeCount;
        console.log('[requestFile] Android resuming from chunk', startChunk);
      } else {
        this._androidChunksReceived?.delete(fileId);
        this.fileStore.updateProgress(fileId, 0);
      }
    } else {
      // Resume detection: if a partial assembler exists in _pending, find the
      // first chunk index not yet received so the sender can skip ahead.
      // Fresh download: no assembler — clean slate, start from 0.
      const asm = this._pending.get(fileId);
      if (asm) {
        while (asm.chunks.has(startChunk)) startChunk++;
        console.log('[requestFile] resuming from chunk', startChunk, '/', asm.total);
      } else {
        this.fileStore.updateProgress(fileId, 0);
      }
    }

    this.fileStore.setStatus(fileId, 'downloading');
    this.onFileUpdate?.();
    this.relay.send({ type: 'file_request', fileId, requesterId: this.myPeerId, startChunk });
  }

  pauseDownload(fileId) {
    this._cancelled.add(fileId);
    // _pending (assembler) is intentionally NOT deleted here — it holds all
    // chunks received so far so that requestFile() can resume from the right
    // chunk index instead of restarting from 0.
    // SW path has no resumable state: abort + delete is still correct there.
    if (this._swActive.has(fileId)) { this._swDL.abort(fileId); this._swActive.delete(fileId); }
    // Tell Kotlin to stop accepting inbound chunks but KEEP the partial temp file
    // so resume can continue writing at the correct chunk offset.
    // pauseTransfer() sets the cancelled flag without calling asm.abort(),
    // preserving the RandomAccessFile and temp file for resumption.
    if (typeof window.AndroidRtc !== 'undefined') window.AndroidRtc.pauseTransfer(fileId);
    // Tell the sender to stop transmitting — without this the sender keeps
    // pushing chunks over the DC regardless of our local cancelled flag.
    const pauseEntry = this.fileStore.get(fileId);
    if (pauseEntry?.senderId && pauseEntry.senderId !== this.myPeerId) {
      this.relay.send({ type: 'transfer_pause', fileId, targetId: pauseEntry.senderId });
    }
    this.fileStore.setStatus(fileId, 'paused');
    // Progress is preserved — do not reset to 0.
    this.onFileUpdate?.();
  }

  cancelDownload(fileId) {
    this._cancelled.add(fileId);
    this._pending.delete(fileId);
    this._androidChunksReceived?.delete(fileId);
    if (this._swActive.has(fileId)) { this._swDL.abort(fileId); this._swActive.delete(fileId); }
    this._speedMap.delete(fileId);
    // Tell Kotlin to drop inbound chunks and clean up the temp file.
    if (typeof window.AndroidRtc !== 'undefined') window.AndroidRtc.cancelTransfer(fileId);
    // Tell the sender to stop transmitting.
    const cancelEntry = this.fileStore.get(fileId);
    if (cancelEntry?.senderId && cancelEntry.senderId !== this.myPeerId) {
      this.relay.send({ type: 'transfer_cancel', fileId, targetId: cancelEntry.senderId });
    }
    this.fileStore.setStatus(fileId, 'available');
    this.fileStore.updateProgress(fileId, 0);
    this.onFileUpdate?.();
    // Notify the conversation so it can clear the inline progress bar and
    // reset the file message back to its pre-download (offer) state.
    this.onMessage?.({ type: 'file_cancel', fileId });
  }

  get myColor() { return Identity.colorFor(this.identity); }

  leave() {
    this._msgQueue.length = 0;
    this._priorityQueue.length = 0;
    this._cancelled.clear();
    for (const fileId of this._swActive.keys()) this._swDL.abort(fileId);
    this._swActive.clear();
    for (const peerId of (this._rtc?._pcs?.keys() || [])) this._rtc.removePeer(peerId);
    if (window._webrtcMesh === this._rtc) window._webrtcMesh = null;
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    this.relay.send({ type: 'leave' });
    this.relay.disconnect();
    this._crypto?.terminate();
  }
}