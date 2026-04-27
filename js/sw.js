// ── sw.js — streaming download Service Worker ────────────────────────────
// Place at your server root. Register once from your app entry point:
//   await navigator.serviceWorker.register('/sw.js', { scope: '/' });
//
// Recommended response headers on your HTML page:
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp

const SW_PREFIX = '/sw-download/';

// downloadId → { controller, response }
const _streams = new Map();

self.addEventListener('install',  e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(SW_PREFIX)) return;

  const rest       = url.pathname.slice(SW_PREFIX.length);
  const downloadId = rest.slice(0, rest.indexOf('/') >>> 0); // before first slash

  event.respondWith(
    new Promise((resolve, reject) => {
      let tries = 0;
      const poll = () => {
        const entry = _streams.get(downloadId);
        if (entry)         { resolve(entry.response); return; }
        if (++tries > 100) { reject(new Error(`stream ${downloadId} not ready`)); return; }
        setTimeout(poll, 20);
      };
      poll();
    }).catch(err => new Response(err.message, { status: 500 }))
  );
});

self.addEventListener('message', ({ data }) => {
  if (!data || data.type !== 'sw_dl') return;
  const { op, downloadId } = data;

  if (op === 'open') {
    let controller;
    const stream = new ReadableStream({
      start(c) { controller = c; },
      cancel()  { _streams.delete(downloadId); },
    });
    const headers = {
      'Content-Type': data.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(data.filename)}`,
    };
    if (data.size) headers['Content-Length'] = String(data.size);
    _streams.set(downloadId, { controller, response: new Response(stream, { headers }) });
  }

  if (op === 'chunk') {
    const entry = _streams.get(downloadId);
    if (entry?.controller && data.chunk) entry.controller.enqueue(new Uint8Array(data.chunk));
  }

  if (op === 'done') {
    const entry = _streams.get(downloadId);
    if (entry) { entry.controller.close(); _streams.delete(downloadId); }
  }

  if (op === 'abort') {
    const entry = _streams.get(downloadId);
    if (entry) { entry.controller.error(new Error('cancelled')); _streams.delete(downloadId); }
  }
});