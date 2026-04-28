// avif-worker.js — AVIF binary-search estimation, off the main thread.
// Spawned by estimateAVIFSize() in compress.js; terminated instantly on abort.

const AVIF_WASM_BASE = '/lib/avif/';
const Q_LO = 20, Q_HI = 65, ITERS = 6;

let _mod = null;
async function getModule() {
  if (_mod) return _mod;
  const { default: factory } = await import(`${AVIF_WASM_BASE}avif_enc.js`);
  _mod = await factory({ noInitialRun: true, locateFile: n => `${AVIF_WASM_BASE}${n}` });
  return _mod;
}

self.onmessage = async ({ data: { width, height, rgba, fileSize } }) => {
  try {
    self.postMessage({ progress: 0, total: ITERS }); // signal: loading encoder
    const mod  = await getModule();
    const view = new Uint8Array(rgba); // view into the transferred buffer
    let lo = Q_LO, hi = Q_HI, bestBuf = null;

    for (let i = 0; i < ITERS; i++) {
      const q   = Math.round((lo + hi) / 2);
      const raw = mod.encode(view, width, height, {
        quality: q, qualityAlpha: -1, denoiseLevel: 0,
        tileColsLog2: 0, tileRowsLog2: 0, speed: 6,
        subsample: 1, chromaDeltaQ: false, sharpness: 0,
        tune: 0, enableSharpYUV: false, bitDepth: 8, lossless: false,
      });
      if (raw && raw.byteLength < fileSize) {
        bestBuf = new Uint8Array(raw); // copy out of WASM heap before next encode clobbers it
        hi = q;
      } else {
        lo = q;
      }
      self.postMessage({ progress: i + 1, total: ITERS });
    }

    const transfer = bestBuf ? [bestBuf.buffer] : [];
    self.postMessage({ bestBuf: bestBuf ? bestBuf.buffer : null }, transfer);
  } catch (e) {
    self.postMessage({ error: e.message });
  }
};
