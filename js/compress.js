// ── lib/compress.js — lossless + lossy file compression ──────────────────
//
// Exports:
//   Lossless (auto, transparent):
//     isLosslessCompressible(mimeType, name) → bool
//     compressGzip(blob)                     → Promise<Blob>
//     decompressGzip(blob, mimeType)         → Promise<Blob>
//
//   Lossy image (opt-in, WebP/AVIF/JPEG via OffscreenCanvas):
//     isLossyImageEligible(mimeType, name, size) → bool
//     estimateWebPSize(file, quality?)           → Promise<number>
//     compressImageWebP(file, quality?)          → Promise<File>
//     estimateAVIFSize(file, quality?)           → Promise<number>
//     compressImageAVIF(file, quality?)          → Promise<File>
//     estimateJPEGSize(file, quality?)           → Promise<number>
//     compressImageJPEG(file, quality?)          → Promise<File>
//
//   Lossy video (opt-in, WebCodecs only):
//     isVideoEligible(mimeType, name, size)  → bool
//     isWebCodecsSupported()                 → Promise<bool>
//     compressVideoH264(file, opts)          → Promise<File>
//       opts: { onProgress(0‥1), onLog(msg) }
//       throws if WebCodecs unavailable or input format unsupported
//
//   VIDEO COMPRESSION STRATEGY
//   ┌─────────────────────────────────────────────────────────────────────┐
//   │ WebCodecs only — H.264 hardware encode, zero WASM download         │
//   │   — Chrome/Edge 94+, requires MP4 / MOV / M4V / WebM input        │
//   │   — VideoDecoder + VideoEncoder + mp4box demux + mp4-muxer mux    │
//   │   — AudioDecoder + AudioEncoder for AAC; gracefully drops on err  │
//   │   — throws a user-readable error when unsupported so callers can   │
//   │     surface a clear warning in the UI                              │
//   └─────────────────────────────────────────────────────────────────────┘


// ── Lossless: gzip via CompressionStream / DecompressionStream ────────────
// Only mime types / extensions that gzip compresses well.
// Already-compressed formats (jpeg, mp4, zip, pdf…) are excluded.

const _GZIP_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|typescript|csv|x-yaml|yaml)|image\/(svg\+xml|bmp|x-bmp|tiff|x-tiff)|audio\/(wav|x-wav|aiff|x-aiff))/i;
const _GZIP_EXT  = /\.(txt|md|log|csv|json|xml|svg|html|htm|css|js|ts|yaml|yml|sh|bat|py|rb|go|rs|c|cpp|h|bmp|tiff|tif|wav|aiff)$/i;

export function isLosslessCompressible(mimeType = '', name = '') {
  return _GZIP_MIME.test(mimeType) || _GZIP_EXT.test(name);
}

export async function compressGzip(blob) {
  const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

export async function decompressGzip(blob, mimeType = 'application/octet-stream') {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  const raw    = await new Response(stream).blob();
  return new Blob([raw], { type: mimeType });
}


// ── Lossy image: WebP via OffscreenCanvas (main thread) ──────────────────

const _IMG_MIME = /^image\/(jpeg|jpg|png|bmp|tiff|gif|webp)$/i;
const _IMG_EXT  = /\.(jpg|jpeg|png|bmp|tiff|tif|gif|webp)$/i;
const IMAGE_MIN_BYTES = 300 * 1024; // skip tiny images — not worth the UX friction

export function isLossyImageEligible(mimeType = '', name = '', size = 0) {
  return size >= IMAGE_MIN_BYTES && (_IMG_MIME.test(mimeType) || _IMG_EXT.test(name));
}

// Detect AVIF encode support once — Chrome supports it, Safari/Firefox don't.
let _avifSupported = null;
export async function isAVIFSupported() {
  if (_avifSupported !== null) return _avifSupported;
  try {
    const c = new OffscreenCanvas(1, 1);
    c.getContext('2d');
    const blob = await c.convertToBlob({ type: 'image/avif' });
    _avifSupported = blob.type === 'image/avif' && blob.size > 0;
  } catch {
    _avifSupported = false;
  }
  return _avifSupported;
}

// Generic encoder — works for webp, avif, jpeg
async function _encodeImage(file, mimeType, quality) {
  const bmp = await createImageBitmap(file);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    return canvas.convertToBlob({ type: mimeType, quality });
  }
  const canvas  = document.createElement('canvas');
  canvas.width  = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise(resolve => canvas.toBlob(b => resolve(b), mimeType, quality));
}

// ── WebP ──────────────────────────────────────────────────────────────────
export async function estimateWebPSize(file, quality = 0.82) {
  return (await _encodeImage(file, 'image/webp', quality)).size;
}
export async function compressImageWebP(file, quality = 0.82) {
  const blob = await _encodeImage(file, 'image/webp', quality);
  return new File([blob], file.name.replace(/\.[^.]+$/, '.webp'), { type: 'image/webp' });
}

// ── AVIF (WASM libavif — proper encoder, same as Squoosh) ─────────────────
// Requires avif_enc.wasm + avif_enc.js at AVIF_WASM_BASE (default: project root).
// Download from:
//   https://unpkg.com/@jsquash/avif@2.1.1/codec/enc/avif_enc.wasm
//   https://unpkg.com/@jsquash/avif@2.1.1/codec/enc/avif_enc.js
export const AVIF_WASM_BASE = '/lib/avif/';

// Binary search bounds: jsquash quality is 0-100, lower = smaller file.
// lo=20 (aggressive floor), hi=65 (ceiling still visually good), 6 iterations.
const _AVIF_Q_LO    = 20;
const _AVIF_Q_HI    = 65;
const _AVIF_ITERS   = 6;

let _avifEncModule = null;
async function _getAvifModule() {
  if (_avifEncModule) return _avifEncModule;
  const { default: factory } = await import(`${AVIF_WASM_BASE}avif_enc.js`);
  _avifEncModule = await factory({
    noInitialRun: true,
    locateFile: (name) => `${AVIF_WASM_BASE}${name}`,
  });
  return _avifEncModule;
}

// Encode file → AVIF blob using libavif WASM. quality: 0-100, lower = smaller.
async function _encodeAVIFWasm(file, quality) {
  const mod = await _getAvifModule();
  const bmp = await createImageBitmap(file);
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(bmp.width, bmp.height)
    : (() => { const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; return c; })();
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  const imgData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const buf = mod.encode(
    new Uint8Array(imgData.data.buffer), imgData.width, imgData.height,
    { quality, qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0,
      speed: 6, subsample: 1, chromaDeltaQ: false, sharpness: 0, tune: 0,
      enableSharpYUV: false, bitDepth: 8, lossless: false },
  );
  if (!buf) throw new Error('AVIF encode failed');
  return new Blob([buf], { type: 'image/avif' });
}

// Find the highest quality (best looking) that still beats the original file size.
// Result is cached per File object — estimate then compress reuses the same search.
const _avifCache = new WeakMap(); // File → Blob | null
async function _bestAVIFBlob(file) {
  if (_avifCache.has(file)) return _avifCache.get(file);
  let lo = _AVIF_Q_LO, hi = _AVIF_Q_HI, bestBlob = null;
  for (let i = 0; i < _AVIF_ITERS; i++) {
    const q    = Math.round((lo + hi) / 2);
    const blob = await _encodeAVIFWasm(file, q);
    if (blob.size < file.size) { bestBlob = blob; hi = q; }
    else                        {                   lo = q; }
  }
  _avifCache.set(file, bestBlob);
  return bestBlob;
}

// Singleton worker — keeps the WASM module in memory across calls.
// Terminated (and nulled) on abort so the stop button still works;
// the next call recreates it and the browser cache makes reload fast.
let _avifWorker = null;
function _getAvifWorker() {
  if (!_avifWorker)
    _avifWorker = new Worker(new URL('./avif-worker.js', import.meta.url), { type: 'module' });
  return _avifWorker;
}

// Runs the binary-search estimation in a Web Worker so the main thread stays
// fully responsive. worker.terminate() gives instant cancellation even mid-
// WASM-encode — unlike a flag check which only fires between iterations.
// On success the result is cached so compressImageAVIF skips re-encoding.
export function estimateAVIFSize(file, signal, onProgress) {
  return new Promise(async (resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));

    // Extract pixel data on the main thread (fast, synchronous-ish)
    const bmp    = await createImageBitmap(file);
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bmp.width, bmp.height)
      : (() => { const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; return c; })();
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    const imgData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);

    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));

    const worker = _getAvifWorker();

    const abort = () => {
      worker.terminate();
      _avifWorker = null; // force fresh worker next time
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });

    worker.onmessage = ({ data }) => {
      if (data.progress !== undefined) { onProgress?.(data.progress, data.total); return; }
      signal?.removeEventListener('abort', abort);
      worker.onmessage = null;
      worker.onerror   = null;
      if (data.error) { reject(new Error(data.error)); return; }
      const blob = data.bestBuf ? new Blob([data.bestBuf], { type: 'image/avif' }) : null;
      _avifCache.set(file, blob); // warm cache — compressImageAVIF will reuse this
      resolve(blob ? blob.size : file.size);
    };
    worker.onerror = e => {
      signal?.removeEventListener('abort', abort);
      worker.onmessage = null;
      worker.onerror   = null;
      reject(new Error(e.message));
    };

    // Transfer the pixel buffer — zero-copy into the worker
    worker.postMessage(
      { width: imgData.width, height: imgData.height, rgba: imgData.data.buffer, fileSize: file.size },
      [imgData.data.buffer],
    );
  });
}
export async function compressImageAVIF(file) {
  const blob = await _bestAVIFBlob(file);
  if (!blob) return new File([file], file.name, { type: file.type }); // original untouched
  return new File([blob], file.name.replace(/\.[^.]+$/, '.avif'), { type: 'image/avif' });
}

// ── JPEG ──────────────────────────────────────────────────────────────────
export async function estimateJPEGSize(file, quality = 0.85) {
  return (await _encodeImage(file, 'image/jpeg', quality)).size;
}
export async function compressImageJPEG(file, quality = 0.85) {
  const blob = await _encodeImage(file, 'image/jpeg', quality);
  return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
}


// ── Lossy video ────────────────────────────────────────────────────────────

const _VIDEO_MIME = /^video\//i;
const _VIDEO_EXT  = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|3gp|ts)$/i;
const VIDEO_MIN_BYTES = 5 * 1024 * 1024; // skip tiny clips

export function isVideoEligible(mimeType = '', name = '', size = 0) {
  return size >= VIDEO_MIN_BYTES && (_VIDEO_MIME.test(mimeType) || _VIDEO_EXT.test(name));
}


// ── WebCodecs support detection ────────────────────────────────────────────
// Checks VideoEncoder H.264 support once and caches the result.

let _webCodecsSupported = null;
let _h264Codec         = null; // first codec string that passes isConfigSupported

// Chrome can return supported:false for some avc1 profile strings even when
// H.264 encoding works fine — probe several in priority order.
const _H264_CANDIDATES = [
  'avc1.42E01E', // Baseline 3.0
  'avc1.4D401E', // Main 3.0
  'avc1.64001E', // High 3.0
  'avc1.420034', // Baseline 5.2 — broad SW fallback
];

export async function isWebCodecsSupported() {
  if (_webCodecsSupported !== null) return _webCodecsSupported;
  console.log('[compress/webcodecs] checking support…');
  console.log('[compress/webcodecs] isSecureContext:', typeof isSecureContext !== 'undefined' ? isSecureContext : '(undefined)');
  console.log('[compress/webcodecs] VideoEncoder:', typeof VideoEncoder);
  console.log('[compress/webcodecs] VideoDecoder:', typeof VideoDecoder);
  try {
    if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
      console.warn('[compress/webcodecs] VideoEncoder/VideoDecoder not in scope — WebCodecs unsupported');
      return (_webCodecsSupported = false);
    }
    for (const codec of _H264_CANDIDATES) {
      const result = await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720 });
      console.log(`[compress/webcodecs] isConfigSupported(${codec}):`, result.supported);
      if (result.supported) { _h264Codec = codec; _webCodecsSupported = true; break; }
    }
    if (!_webCodecsSupported) _webCodecsSupported = false;
  } catch (e) {
    console.warn('[compress/webcodecs] isWebCodecsSupported check threw:', e);
    _webCodecsSupported = false;
  }
  console.log('[compress/webcodecs] final supported:', _webCodecsSupported, '| codec:', _h264Codec);
  return _webCodecsSupported;
}

// Formats mp4box can demux. Anything outside this list is unsupported —
// callers receive a thrown error with a user-readable message.
const _WEBCODECS_EXT = /^(mp4|m4v|mov|webm)$/i;


// ── WebCodecs internal helpers ─────────────────────────────────────────────

/**
 * Extract the codec description bytes (avcC / hvcC) from an mp4box track.
 * These bytes are required by VideoDecoder.configure() for H.264/H.265.
 * Returns undefined if not found (decoder will try without it).
 *
 * @param {object} mp4File   - mp4box file instance
 * @param {number} trackId
 * @param {typeof DataStream} DataStream - mp4box DataStream class
 * @returns {Uint8Array|undefined}
 */
function _getVideoDescription(mp4File, trackId, DataStream) {
  try {
    const track = mp4File.getTrackById(trackId);
    for (const entry of track.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry['av1C'];
      if (!box) continue;
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      // stream.buffer includes a leading 8-byte box header (4 size + 4 type) — skip it
      return new Uint8Array(stream.buffer, 8);
    }
  } catch { /* description is optional; VideoDecoder will error if truly required */ }
  return undefined;
}

/**
 * WebCodecs compression path.
 * Demuxes with mp4box, decodes/re-encodes video with VideoDecoder/VideoEncoder,
 * decodes/re-encodes audio with AudioDecoder/AudioEncoder (AAC), muxes with mp4-muxer.
 *
 * Supports MP4 / MOV / M4V / WebM input.
 * Falls back gracefully: if audio processing fails, output is video-only.
 *
 * @param {File}   file
 * @param {object} opts  { onProgress(0‥1), onLog(msg) }
 * @returns {Promise<File>}
 */
async function _compressVideoWebCodecs(file, { onProgress, onLog, signal } = {}) {
  const ext = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? '';
  console.log('[wc] _compressVideoWebCodecs start — file:', file.name, 'ext:', ext, 'size:', file.size);
  if (!_WEBCODECS_EXT.test(ext)) {
    throw new Error(`WebCodecs demuxer does not support .${ext}`);
  }

  // Lazy-load mp4box (demuxer, ~200 KB) + mp4-muxer (muxer, ~30 KB).
  // Neither is fetched unless this path is actually taken.
  console.log('[wc] importing mp4box + mp4-muxer…');
  const [mp4boxMod, { Muxer, ArrayBufferTarget }] = await Promise.all([
    import('mp4box'),
    import('mp4-muxer'),
  ]);
  console.log('[wc] imports done');
  const MP4Box     = mp4boxMod.default ?? mp4boxMod;
  const DataStream = MP4Box.DataStream;

  // Read in 4 MB slices — file.arrayBuffer() on a large content URI stalls
  // Android WebView's content resolver; sliced reads avoid the hang.
  console.log('[wc] reading file in chunks…');
  const ab = await (async () => {
    const CHUNK = 4 * 1024 * 1024;
    const out   = new Uint8Array(file.size);
    let pos = 0;
    while (pos < file.size) {
      const buf = await file.slice(pos, pos + CHUNK).arrayBuffer();
      out.set(new Uint8Array(buf), pos);
      pos += buf.byteLength;
    }
    return out.buffer;
  })();
  console.log('[wc] file read complete, byteLength:', ab.byteLength);

  return new Promise((resolve, reject) => {
    const mp4In = MP4Box.createFile();

    // Muxer / encoders are created once track info is available in onReady.
    let muxer          = null;
    let muxTarget      = null;
    let videoEncoder   = null;
    let videoDecoder   = null;
    let audioEncoder   = null;
    let audioDecoder   = null;

    let videoTrackId = null;
    let audioTrackId = null;

    let totalVideoSamples    = 0;
    let videoSamplesReceived = 0;
    let totalAudioSamples    = 0;
    let audioSamplesReceived = 0;

    let videoDone  = false;
    let audioDone  = false;
    let finalized  = false;

    // ── Abort handler — the REAL stop fix ─────────────────────────────────
    // mp4box dispatches all samples at once from the in-memory buffer, so
    // checking signal.aborted inside onSamples is always too late. The only
    // reliable fix is to forcibly close the codecs the instant abort fires:
    // .close() drains their internal queues synchronously and stops any
    // further output callbacks, ending the pipeline immediately.
    if (signal) {
      signal.addEventListener('abort', () => {
        if (finalized) return;
        finalized = true;          // prevent _finalize() from winning the race
        try { mp4In.stop?.(); }    catch {}
        try { videoDecoder?.close(); } catch {}
        try { videoEncoder?.close(); } catch {}
        try { audioDecoder?.close(); } catch {}
        try { audioEncoder?.close(); } catch {}
        reject(new DOMException('Encoding aborted', 'AbortError'));
      }, { once: true });
    }

    function _finalize() {
      console.log('[wc] _finalize called, finalized:', finalized);
      if (finalized) return;   // abort handler may have already rejected
      finalized = true;
      try {
        muxer.finalize();
        const blob = new Blob([muxTarget.buffer], { type: 'video/mp4' });
        console.log('[wc] muxer finalized, output size:', blob.size);
        resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.mp4'), { type: 'video/mp4' }));
      } catch (err) {
        console.error('[wc] _finalize error:', err);
        reject(err);
      }
    }

    function _checkDone() {
      console.log('[wc] _checkDone — videoDone:', videoDone, 'audioDone:', audioDone);
      if (videoDone && audioDone) _finalize();
    }

    mp4In.onReady = (info) => {
      console.log('[wc] onReady — tracks:', info.tracks?.length, 'video:', info.videoTracks?.length, 'audio:', info.audioTracks?.length);
      try {
        const vTrack = info.videoTracks?.[0];
        if (!vTrack) { console.error('[wc] no video track'); reject(new Error('No video track found in file')); return; }

        const aTrack = info.audioTracks?.[0];

        videoTrackId      = vTrack.id;
        totalVideoSamples = vTrack.nb_samples;

        // ── output dimensions (downscale to ≤1920×1080, keep even) ───────
        const srcW  = vTrack.video.width;
        const srcH  = vTrack.video.height;
        const scale = Math.min(1, 1920 / srcW, 1080 / srcH);
        const outW  = Math.floor(srcW * scale / 2) * 2;
        const outH  = Math.floor(srcH * scale / 2) * 2;
        const fps   = Math.round(
          vTrack.nb_samples / (vTrack.duration / vTrack.timescale)
        ) || 30;

        onLog?.(`[compress/webcodecs] ${srcW}×${srcH} → ${outW}×${outH} @ ${fps} fps, codec=${vTrack.codec}`);

        // ── muxer ─────────────────────────────────────────────────────────
        muxTarget = new ArrayBufferTarget();
        const muxerOpts = {
          target:                 muxTarget,
          video:                  { codec: 'avc', width: outW, height: outH },
          fastStart:              'in-memory',
          firstTimestampBehavior: 'offset',
        };

        // ── audio setup ───────────────────────────────────────────────────
        let audioSampleRate = 44100;
        let audioChannels   = 2;

        if (aTrack) {
          audioTrackId      = aTrack.id;
          audioSampleRate   = aTrack.audio.sample_rate;
          audioChannels     = aTrack.audio.channel_count;
          totalAudioSamples = aTrack.nb_samples;
          muxerOpts.audio   = { codec: 'aac', sampleRate: audioSampleRate, numberOfChannels: audioChannels };
        } else {
          audioDone = true; // no audio track — nothing to wait for
        }

        muxer = new Muxer(muxerOpts);

        // ── video encoder ─────────────────────────────────────────────────
        let encodedVideoChunks = 0;
        videoEncoder = new VideoEncoder({
          output: (chunk, meta) => {
            muxer.addVideoChunk(chunk, meta);
            onProgress?.(Math.min(1, ++encodedVideoChunks / totalVideoSamples));
          },
          error: (e) => reject(new Error(`VideoEncoder: ${e.message}`)),
        });
        videoEncoder.configure({
          codec:     _h264Codec,
          width:     outW,
          height:    outH,
          bitrate:   2_500_000,
          framerate: fps,
        });

        // ── video decoder ─────────────────────────────────────────────────
        const videoDesc = _getVideoDescription(mp4In, videoTrackId, DataStream);
        videoDecoder = new VideoDecoder({
          output: (frame) => {
            videoEncoder.encode(frame, { keyFrame: videoEncoder.encodeQueueSize === 0 });
            frame.close();
          },
          error: (e) => reject(new Error(`VideoDecoder: ${e.message}`)),
        });
        videoDecoder.configure({
          codec:       vTrack.codec,
          codedWidth:  srcW,
          codedHeight: srcH,
          ...(videoDesc ? { description: videoDesc } : {}),
        });

        // ── audio encoder/decoder ─────────────────────────────────────────
        if (aTrack) {
          // Audio errors are non-fatal: we log and drop the audio track rather
          // than failing the entire compression.
          const _onAudioError = (label) => (e) => {
            onLog?.(`[compress/webcodecs] ${label}: ${e.message} — audio track dropped`);
            audioDone = true;
            // Patch muxer to ignore subsequent addAudioChunk calls
            muxer.addAudioChunk = () => {};
            _checkDone();
          };

          audioEncoder = new AudioEncoder({
            output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
            error:  _onAudioError('AudioEncoder'),
          });

          try {
            audioEncoder.configure({
              codec:            'mp4a.40.2', // AAC-LC
              sampleRate:       audioSampleRate,
              numberOfChannels: audioChannels,
              bitrate:          128_000,
            });
          } catch (e) {
            _onAudioError('AudioEncoder.configure')(e);
          }

          audioDecoder = new AudioDecoder({
            output: (data) => { audioEncoder.encode(data); data.close(); },
            error:  _onAudioError('AudioDecoder'),
          });

          try {
            audioDecoder.configure({
              codec:            aTrack.codec,
              sampleRate:       audioSampleRate,
              numberOfChannels: audioChannels,
            });
          } catch (e) {
            _onAudioError('AudioDecoder.configure')(e);
          }
        }

        // ── start sample extraction ───────────────────────────────────────
        mp4In.setExtractionOptions(videoTrackId, 'video', { nbSamples: 100 });
        if (audioTrackId) mp4In.setExtractionOptions(audioTrackId, 'audio', { nbSamples: 100 });
        mp4In.start();

      } catch (err) {
        reject(err);
      }
    }; // onReady

    mp4In.onSamples = async (id, user, samples) => {
      try {
        // If abort fired, finalized is already true and the codecs are closed.
        // Any attempt to .decode() a closed codec throws — skip gracefully.
        if (finalized) return;
        if (user === 'video') {
          for (const s of samples) {
            videoDecoder.decode(new EncodedVideoChunk({
              type:      s.is_sync ? 'key' : 'delta',
              timestamp: (s.cts      / s.timescale) * 1e6,
              duration:  (s.duration / s.timescale) * 1e6,
              data:      s.data,
            }));
          }
          videoSamplesReceived += samples.length;

          if (videoSamplesReceived >= totalVideoSamples) {
            await videoDecoder.flush();
            await videoEncoder.flush();
            videoDone = true;
            _checkDone();
          }

        } else if (user === 'audio' && !audioDone) {
          for (const s of samples) {
            audioDecoder.decode(new EncodedAudioChunk({
              type:      s.is_sync ? 'key' : 'delta',
              timestamp: (s.cts      / s.timescale) * 1e6,
              duration:  (s.duration / s.timescale) * 1e6,
              data:      s.data,
            }));
          }
          audioSamplesReceived += samples.length;

          if (audioSamplesReceived >= totalAudioSamples) {
            await audioDecoder.flush();
            await audioEncoder.flush();
            audioDone = true;
            _checkDone();
          }
        }
      } catch (err) {
        reject(err);
      }
    }; // onSamples

    mp4In.onError = (err) => reject(new Error(`mp4box: ${err}`));

    // Feed the entire buffer. Slicing ensures mp4box owns the ArrayBuffer.
    const buf = ab.slice(0);
    buf.fileStart = 0;
    mp4In.appendBuffer(buf);
    mp4In.flush();
  });
}


// ── Public video API ───────────────────────────────────────────────────────

/**
 * Compress a video file to H.264 / AAC inside an MP4 container via WebCodecs.
 * Hardware-accelerated, zero WASM download. Requires Chrome/Edge 94+.
 *
 * Throws a user-readable error (suitable for display in UI) when:
 *   — the browser does not support WebCodecs H.264 encoding
 *   — the input format cannot be demuxed (AVI, MKV, FLV, WMV, …)
 *
 * @param {File}   file
 * @param {object} opts
 * @param {(ratio: number) => void}  [opts.onProgress]  0‥1 as encoding progresses.
 * @param {(msg: string)   => void}  [opts.onLog]       Status / debug messages.
 * @returns {Promise<File>}
 * @throws  {Error}  User-readable message if compression is not possible.
 */
export async function compressVideoH264(file, opts = {}) {
  const { onLog } = opts;

  const ext         = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? '';
  const wcSupported = await isWebCodecsSupported();

  if (!wcSupported) {
    const secureCtx = typeof isSecureContext !== 'undefined' && !isSecureContext;
    const hint = secureCtx
      ? 'The page must be served over HTTPS (or localhost) for WebCodecs to be available.'
      : 'Try Chrome or Edge 94+, and make sure the page is served over HTTPS.';
    const msg = `Video compression requires WebCodecs (Chrome / Edge 94+). ${hint}`;
    onLog?.(`[compress] ${msg}`);
    throw new Error(msg);
  }

  if (!_WEBCODECS_EXT.test(ext)) {
    const msg = `.${ext} files cannot be compressed here. `
              + 'Supported formats: MP4, MOV, M4V, WebM.';
    onLog?.(`[compress] ${msg}`);
    throw new Error(msg);
  }

  onLog?.('[compress] WebCodecs path — hardware-accelerated, no WASM required');
  return _compressVideoWebCodecs(file, opts);
}