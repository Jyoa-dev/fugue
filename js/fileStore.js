// ── fileStore.js — track shared files, transfers, receipts ───────────────
export class FileStore extends EventTarget {
  constructor() {
    super();
    this.files = new Map();
  }

  register(meta, file = null) {
    const existing = this.files.get(meta.id);
    const entry = {
      ...meta,
      file:           file ?? existing?.file ?? null,
      progress:       existing?.progress ?? 0,
      status:         existing?.status   ?? 'available',
      receipts:       existing?.receipts ?? [],
      previewUrl:     existing?.previewUrl     ?? null,
      previewVisible: existing?.previewVisible ?? false,
      rawBuffer:      existing?.rawBuffer      ?? null,
    };
    this.files.set(meta.id, entry);
    this.dispatchEvent(new CustomEvent('updated', { detail: { id: meta.id } }));
    return entry;
  }

  updateProgress(id, progress) {
    const f = this.files.get(id);
    if (!f) return;
    f.progress = progress;
    this.dispatchEvent(new CustomEvent('progress', { detail: { id, progress } }));
  }

  setStatus(id, status) {
    const f = this.files.get(id);
    if (!f) return;
    f.status = status;
    this.dispatchEvent(new CustomEvent('updated', { detail: { id } }));
  }

  setPreviewUrl(id, url) {
    const f = this.files.get(id);
    if (!f) return;
    f.previewUrl = url;
    this.dispatchEvent(new CustomEvent('updated', { detail: { id } }));
  }

  setSpeed(id, bps) {
    const f = this.files.get(id);
    if (!f) return;
    f.speed = bps;
    this.dispatchEvent(new CustomEvent('updated', { detail: { id } }));
  }

  setBuffer(id, buf) {
    const f = this.files.get(id);
    if (!f) return;
    f.rawBuffer = buf;
  }

  togglePreview(id) {
    const f = this.files.get(id);
    if (!f || (!f.previewUrl && !f.rawBuffer)) return;
    f.previewVisible = !f.previewVisible;
    this.dispatchEvent(new CustomEvent('updated', { detail: { id } }));
  }

  addReceipt(id, peerId, peerName, type) {
    const f = this.files.get(id);
    if (!f) return;
    if (!f.receipts.find(r => r.peerId === peerId && r.type === type)) {
      f.receipts.push({ peerId, peerName, type, time: Date.now() });
    }
    this.dispatchEvent(new CustomEvent('receipt', { detail: { id } }));
  }

  getAll() { return [...this.files.values()]; }
  get(id)  { return this.files.get(id); }
}