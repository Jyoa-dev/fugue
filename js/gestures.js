/**
 * gestures.js — swipe-to-open/close panels + Android IME keyboard shim
 *
 * Open  : swipe right from left edge  → open left panel
 *         swipe left  from right edge → open right panel
 * Close : swipe left  from anywhere inside open left panel
 *         swipe right from anywhere inside open right panel
 */

(function () {
  // ── Constants ──────────────────────────────────────────────────────────────
  const EDGE_PX      = 88; // CSS px — edge zone width for open gesture
  const SWIPE_MIN_PX = 18; // CSS px — minimum horizontal travel to register
  const RATIO_MIN    = 1.0; // horizontal must match (not beat) vertical

  // ── State ──────────────────────────────────────────────────────────────────
  let startX = 0;
  let startY = 0;
  let edge   = null; // 'open-left' | 'open-right' | 'close-left' | 'close-right' | null

  // ── Helpers ────────────────────────────────────────────────────────────────
  function isCollapsed(panelId) {
    return document.getElementById(panelId)?.classList.contains('collapsed') ?? true;
  }

  function clickBtn(btnId) {
    document.getElementById(btnId)?.click();
  }

  // ── Touch handlers ─────────────────────────────────────────────────────────
  document.addEventListener('touchstart', function (e) {
    const x = e.touches[0].clientX;
    const w = window.innerWidth;

    const leftOpen  = !isCollapsed('peers-panel');
    const rightOpen = !isCollapsed('files-panel');

    if (leftOpen && e.target.closest('#peers-panel')) {
      edge = 'close-left';
    } else if (rightOpen && e.target.closest('#files-panel')) {
      edge = 'close-right';
    } else if (!leftOpen && x < EDGE_PX) {
      edge = 'open-left';
    } else if (!rightOpen && x > w - EDGE_PX) {
      edge = 'open-right';
    } else {
      edge = null;
    }

    startX = x;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', function (e) {
    if (!edge) return;

    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;

    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) >= Math.abs(dy) * RATIO_MIN) {
      if (edge === 'open-left'   && dx > 0) clickBtn('peers-toggle-btn');
      if (edge === 'close-left'  && dx < 0) clickBtn('peers-toggle-btn');
      if (edge === 'open-right'  && dx < 0) clickBtn('files-toggle-btn');
      if (edge === 'close-right' && dx > 0) clickBtn('files-toggle-btn');
    }

    edge = null;
  }, { passive: true });

})();