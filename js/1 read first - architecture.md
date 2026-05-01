# P2P File Transfer — Full Architecture Summary

## System Overview

A serverless P2P file transfer app. The server only handles WebSocket signaling and never touches file data. All transfers are end-to-end encrypted, direct peer-to-peer over WebRTC DataChannels. The same JS core (`room.js` + `webrtc.js` + `chunker.js` + `crypto.js` + `relay.js` + `sw.js`) runs on both desktop browsers and inside an Android WebView, with the Android path monkey-patched at runtime.

---

## Layer by Layer

### 1. `relay.js` — Signaling & Fallback Transport

A thin WebSocket wrapper (`RelayConnection extends EventTarget`). It connects to `/room/{canal}`, auto-reconnects with exponential backoff (1s → 10s), and sends a ping every 5s. All messages are JSON. It serves two roles:

- **Signaling**: delivers `rtc_offer/answer/ice`, `peer_joined/left`, `welcome`, `file_announce`, `file_request`, `receipt`, `transfer_pause/cancel`
- **Fallback data path**: when WebRTC fails, `file_chunk` messages carry base64-encoded encrypted chunk data directly over WebSocket (slow but functional)

The canal ID is `SHA-256(canal + passphrase + settings)` when encrypted, providing room isolation without leaking the passphrase to the server.

---

### 2. `crypto.js` — Encryption Web Worker

Runs off the main thread. Supports a pluggable cipher+KDF matrix:

- **Ciphers**: AES-256-GCM (default), AES-192-GCM, AES-256-CBC, ChaCha20-Poly1305, XChaCha20-Poly1305
- **KDFs**: PBKDF2-SHA-256/512 (200k iterations), HKDF-SHA-384/512, scrypt (N=131072), Argon2id

Key derivation is two-step: KDF stretches the passphrase → HKDF provides domain separation (info string encodes `cipher:kdf` combo, so different settings → different keys from the same passphrase). Encrypted output format is `[IV | ciphertext+tag]` (12B IV for AES-GCM, 16B for AES-CBC, 12/24B for ChaCha variants).

`room.js` wraps this in `CryptoWorkerPool`: 2–4 workers, **round-robin encrypt** (parallel lanes, maximizes CPU), **always worker[0] decrypt** (guarantees FIFO chunk order for SW streaming).

Two keys are derived per session:

- `identity` key — encrypts peer display names sent over relay
- `session` key — encrypts file chunks, derived from the server-provided `welcome.salt`

On Android, `room.js` calls `AndroidRtc.setSessionKey()` so Kotlin can independently derive the same session key for native encrypt/decrypt.

---

### 3. `chunker.js` — File Splitting & Reassembly

- **Send**: `chunkFile()` async generator yields 256 KB chunks. Uses BYOB `ReadableStream` (zero-copy, no intermediate Blob) when available, falls back to `File.slice()`. Resumes always use `slice()` (O(1) random access).
- **Receive**: `Assembler` collects `ArrayBuffer` chunks by index. `assembleBlob()` creates a `Blob` from chunk references without concatenation — peak heap stays at ~(in-flight chunks) rather than 2×fileSize.

---

### 4. `webrtc.js` — DataChannel Mesh

`WebRTCMesh` maintains a full mesh of `RTCPeerConnection`s. Per peer:

- **1 shared unordered DC** (`files`): chat messages and small signaling frames
- **Pool of 4 ordered DCs** (`xferp-0..3`): file chunks, striped by `chunkIndex % 4` — independent SCTP streams eliminate head-of-line blocking
- **1 ordered android-direct DC** (Android only): used for small non-chunk frames to Android peers

`_sendOnDC` prepends a 12-byte transport header `[transferId(u32) | total(u32) | index(u32)]` and fragments if needed (64 KB cap for Safari peers, 256 KB for Chrome/Firefox). The receiver reassembles fragments into the full application frame before firing the `binary` event.

**Adaptive back-pressure**: each peer shares a single `_bufHigh` watermark across its 4 pool DCs. It self-tunes: drain < 20ms → ×2 grow (up to 16 MB), drain > 300ms → ×0.5 shrink, drain 150–300ms → ×0.75. A polling fallback (every 50ms) handles Safari/WebView `bufferedamountlow` unreliability and detects SCTP stalls (3s no progress → force-resolve + abort frame sequence).

---

### 5. `sw.js` — Streaming Download (Desktop Only)

A Service Worker that intercepts fetches to `/sw-download/{downloadId}/{filename}`. It holds a `ReadableStream` per active download (stored in `_streams` map). `room.js`'s `StreamingDownloader` communicates via `postMessage`:

- `open`: creates the stream and a `Response` with correct `Content-Type/Disposition/Length` headers
- `chunk`: enqueues an `ArrayBuffer` into the stream (transferred, zero-copy)
- `done` / `abort`: closes or errors the stream

This keeps the JS heap near zero for large files — chunks flow directly from the DataChannel to the OS download manager without ever accumulating in JS memory. Previewable files (images, video, text) bypass the SW and get Blob URLs instead.

---

### 6. `room.js` — Orchestrator (`Room` class)

Wires everything together:

- Holds a **priority queue** (RTC signals + peer events drain first, file chunks second) processed by a single async `_drain()` loop
- **File lifecycle**: `shareFile()` → optional gzip compress → announce via relay → on `file_request` → `_sendChunks()` (32 concurrent encrypt+send lanes, chunk size adapted per peer type)
- **Receive**: `_receiveChunk()` routes to SW streaming path (large files), Blob URL path (previewable), or JS `Assembler` (small files). On Android, exits early — Kotlin handles everything natively
- **DC frame format**: 26-byte binary header `[type(1) | fileId(16) | chunkIndex(u32) | totalChunks(u32) | flags(1)]`. This format is mirrored exactly in `NativeRtcBridge.kt`
- **Pause/resume**: receiver sends `transfer_pause` over relay; sender checks a `_cancelled` Set before each chunk. Resume sends `file_request` with `startChunk > 0`. Android resume asks Kotlin for the native chunk count via `AndroidRtc.getReceivedChunkCount()`

---

## Desktop ↔ Desktop Flow

```
shareFile() → [gzip?] → announce (relay)
                              ↓
                      file_request (relay)
                              ↓
_sendChunks(): chunkFile() → CryptoWorkerPool.encrypt() [×32 lanes]
                              → WebRTCMesh.sendOnChannel() [4-pool DCs, striped]
                              ↓ (receiver)
decodeDCFrame() → _receiveChunk()
  → SW streaming (large)  →  sw.js ReadableStream → OS download
  → Assembler.assembleBlob() → Blob URL (previewable / small)
```

---

## Desktop ↔ Android Flow

**Android receives** (desktop sends normally; Kotlin handles inbound):

```
DC frame arrives in Kotlin onMessage()
→ parseDCFrame()        [mirrors 26-byte header]
→ aesGcmDecrypt()       [session key derived independently]
→ NativeAssembler.write() [streaming to temp file via RandomAccessFile]
→ writeToMediaStore()
→ _nativeFileDone JS callback → room.js updates UI
```

**Android sends** (fast path):

```
NativeFile.sendChunk(offset, len, peerId, poolIndex, ...)
→ AndroidRtc.readAndSendChunk()  [@JavascriptInterface — single bridge crossing]
→ Kotlin: read chunk → AES-GCM encrypt → build 26B header → dc.send()
```

**Signaling** (both directions via relay → JS → bridge):

```
relay → room.js → WebRTCMesh.handleSignal()  [patched by bridge]
  → AndroidRtc.setRemoteOffer/Answer/addIceCandidate
Kotlin → _nativeRtcOffer/Answer/Ice(peerId, json) → mesh.sendSignal() → relay
```

---

## Key Design Constraints

| Constraint | Why |
|---|---|
| 26-byte DC frame header must match exactly between JS and Kotlin | `parseDCFrame()` in Kotlin mirrors `decodeDCFrame()` in JS byte-for-byte |
| `DC_CHUNK` (256 KB) in Kotlin must match `ANDROID_CHUNK_CAP` in `room.js` | Mismatches cause truncated frames or OOM |
| Decrypt always on `CryptoWorkerPool` worker[0] | Guarantees FIFO order for SW stream — changing this breaks streaming downloads |
| Session key derived after `welcome.salt` arrives | Both JS and Kotlin derive from the same salt; `setSessionKey()` must be called before any encrypted chunks flow |
| Android receive path never touches JS `Assembler` | `_receiveChunk()` exits early on Android; progress/done/error come from Kotlin callbacks |
