// ── lib/compress.js — lossless + lossy file compression ──────────────────
//
// Exports:
//   Lossless (auto, transparent):
//     isLosslessCompressible(mimeType, name) → bool
//     compressGzip(blob)                     → Promise<Blob>
//     decompressGzip(blob, mimeType)         → Promise<Blob>
//
//   Lossy image (opt-in, WebP via OffscreenCanvas):
//     isLossyImageEligible(mimeType, name, size) → bool
//     estimateWebPSize(file, quality?)           → Promise<number>   (bytes)
//     compressImageWebP(file, quality?)          → Promise<File>
//
//   Lossy video (opt-in, H.264 via ffmpeg.wasm — loaded lazily):
//     isVideoEligible(mimeType, name, size)      → bool
//     compressVideoH264(file, opts)              → Promise<File>
//       opts: { onProgress(0‥1), onLog(msg) }


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

// ── AVIF ──────────────────────────────────────────────────────────────────
export async function estimateAVIFSize(file, quality = 0.72) {
  return (await _encodeImage(file, 'image/avif', quality)).size;
}
export async function compressImageAVIF(file, quality = 0.72) {
  const blob = await _encodeImage(file, 'image/avif', quality);
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


// ── Lossy video: H.264 via ffmpeg.wasm (lazy-loaded on first use) ─────────
// ffmpeg-core.wasm is ~31 MB — downloaded and cached by the browser on
// first video compression. Subsequent compressions reuse the same instance.

const _VIDEO_MIME = /^video\//i;
const _VIDEO_EXT  = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|3gp|ts)$/i;
const VIDEO_MIN_BYTES = 5 * 1024 * 1024; // skip tiny clips

export function isVideoEligible(mimeType = '', name = '', size = 0) {
  return size >= VIDEO_MIN_BYTES && (_VIDEO_MIME.test(mimeType) || _VIDEO_EXT.test(name));
}

// Singleton ffmpeg instance — loaded once per page session.
let _ffmpeg     = null;
let _ffmpegLoad = null; // in-flight load Promise (prevents double-load)

// Terminates the ffmpeg instance mid-encode. The next call to compressVideoH264
// will reload the WASM (already cached by the browser, so ~instant).
export function terminateFFmpeg() {
  if (_ffmpeg) {
    try { _ffmpeg.terminate(); } catch {}
    _ffmpeg     = null;
    _ffmpegLoad = null;
  }
}

async function _getFFmpeg(onLog) {
  if (_ffmpeg?.loaded) return _ffmpeg;

  if (!_ffmpegLoad) {
    _ffmpegLoad = (async () => {
      // Dynamic import so the 31 MB WASM is never fetched unless needed.
      const { FFmpeg } = await import('../lib/ffmpeg/ffmpeg.js');
      const ff = new FFmpeg();
      if (onLog) ff.on('log', ({ message }) => onLog(message));
      await ff.load({
        coreURL: new URL('../lib/ffmpeg/ffmpeg-core.js',   import.meta.url).href,
        wasmURL: new URL('../lib/ffmpeg/ffmpeg-core.wasm', import.meta.url).href,
      });
      _ffmpeg     = ff;
      _ffmpegLoad = null;
      return ff;
    })();
  }

  return _ffmpegLoad;
}

/**
 * Compress a video file to H.264 / AAC inside an MP4 container.
 * Uses the "ultrafast" x264 preset + CRF 28 for a good speed/size tradeoff.
 * Downscales to ≤1920×1080 if the source is larger.
 *
 * @param {File}   file
 * @param {object} opts
 * @param {function(number): void}  [opts.onProgress]  Called with 0‥1 as encoding progresses.
 * @param {function(string): void}  [opts.onLog]       Raw ffmpeg log lines (useful for debugging).
 * @returns {Promise<File>}
 */
export async function compressVideoH264(file, { onProgress, onLog } = {}) {
  const ffmpeg = await _getFFmpeg(onLog);

  const ext     = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() || 'mp4';
  const inName  = `in_${Date.now()}.${ext}`;
  const outName = `out_${Date.now()}.mp4`;

  await ffmpeg.writeFile(inName, new Uint8Array(await file.arrayBuffer()));

  const progressCb = onProgress ? ({ progress }) => onProgress(Math.min(Math.max(progress, 0), 1)) : null;
  if (progressCb) ffmpeg.on('progress', progressCb);

  try {
    await ffmpeg.exec([
      '-i', inName,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-vf', 'scale=iw*min(1\\,min(1920/iw\\,1080/ih)):ih*min(1\\,min(1920/iw\\,1080/ih)),setsar=1',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outName,
    ], -1);
  } finally {
    if (progressCb) ffmpeg.off('progress', progressCb);
    await ffmpeg.deleteFile(inName).catch(() => {});
  }

  const data    = await ffmpeg.readFile(outName);
  await ffmpeg.deleteFile(outName).catch(() => {});

  const outBlob = new Blob([data.buffer], { type: 'video/mp4' });
  const outName2 = file.name.replace(/\.[^.]+$/, '.mp4');
  return new File([outBlob], outName2, { type: 'video/mp4' });
}