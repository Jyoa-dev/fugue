// ── chunker.js — file chunking and reassembly ────────────────────────────
export const Chunker = (() => {
  const CHUNK_SIZE = 256 * 1024; // 256 KB

  async function* chunkFile(file, chunkSize = CHUNK_SIZE, startChunk = 0) {
    const total = Math.ceil(file.size / chunkSize) || 1;

    // BYOB path: read directly into a pre-allocated buffer — eliminates the
    // intermediate Blob created by slice() and one memcopy per chunk.
    // Falls back to slice() on browsers without BYOB ReadableStream support.
    // Skipped for resumes (startChunk > 0): ReadableStream has no seek API,
    // so resumes always use the slice() path below which has O(1) random access.
    if (typeof file.stream === 'function' && startChunk === 0) {
      const stream = file.stream();
      try {
        const reader = stream.getReader({ mode: 'byob' });
        let index = 0;
        let remaining = file.size;
        while (remaining > 0) {
          const readSize       = Math.min(chunkSize, remaining);
          const { value, done } = await reader.read(new Uint8Array(new ArrayBuffer(readSize)));
          if (done) break;
          remaining -= value.byteLength;
          // slice() here copies out of the BYOB buffer so we can hand off
          // ownership to the crypto worker without racing the next read.
          yield { index, total, data: value.buffer.slice(0, value.byteLength), done: remaining <= 0 };
          index++;
        }
        reader.releaseLock();
        return;
      } catch {
        // BYOB not supported — fall through to slice() path below.
        // Consume the old stream before re-reading.
      }
    }

    // Fallback: slice() path (original behaviour, all browsers).
    // Also used for all resumes: File.slice() is O(1) random access, so
    // seeking to the right byte offset costs nothing.
    let offset = startChunk * chunkSize, index = startChunk;
    while (offset < file.size) {
      const buf = await file.slice(offset, offset + chunkSize).arrayBuffer();
      yield { index, total, data: buf, done: offset + chunkSize >= file.size };
      offset += chunkSize;
      index++;
    }
  }

  class Assembler {
    constructor(total) { this.chunks = new Map(); this.total = total; }
    add(i, data)       { this.chunks.set(i, data); }
    get complete()     { return this.chunks.size === this.total; }
    get progress()     { return this.chunks.size / this.total; }

    // Returns a single concatenated ArrayBuffer. Use assembleBlob() when possible.
    assemble() {
      const parts = Array.from({ length: this.total }, (_, i) => this.chunks.get(i));
      const size  = parts.reduce((s, p) => s + p.byteLength, 0);
      const out   = new Uint8Array(size);
      let off = 0;
      for (const p of parts) { out.set(new Uint8Array(p), off); off += p.byteLength; }
      return out.buffer;
    }

    // Zero-copy: Blob holds references to chunk ArrayBuffers without
    // concatenating them. Peak heap stays at ~(in-flight chunks) instead
    // of 2 × fileSize. Browser copies once when handing to the OS.
    assembleBlob(mimeType = 'application/octet-stream') {
      const parts = Array.from({ length: this.total }, (_, i) => this.chunks.get(i));
      return new Blob(parts, { type: mimeType || 'application/octet-stream' });
    }
  }

  return { chunkFile, Assembler, CHUNK_SIZE };
})();