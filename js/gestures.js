/**
 * gestures.js — swipe-to-open/close panels
 *
 * Works anywhere on screen (room view only). One swipe = one panel action.
 *
 * Both closed  → direction decides which to open (unambiguous)
 * Both open    → direction decides which to close (unambiguous)
 * One open     → unambiguous direction acts on that panel;
 *                ambiguous direction uses startX vs midscreen to pick closest
 *
 * Swipe right (→): opens left panel  / closes right panel
 * Swipe left  (←): opens right panel / closes left panel
 */

(function () {
  // ── Constants ──────────────────────────────────────────────────────────────
  const SWIPE_MIN_PX = 12;  // minimum horizontal travel to register
  const RATIO_MIN    = 0.3; // |dx| must exceed |dy| × ratio (very lenient)

  // ── State ──────────────────────────────────────────────────────────────────
  let startX = 0;
  let startY = 0;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function isCollapsed(panelId) {
    return document.getElementById(panelId)?.classList.contains('collapsed') ?? true;
  }

  function clickBtn(btnId) {
    document.getElementById(btnId)?.click();
  }

  function inRoomView() {
    return document.getElementById('room')?.classList.contains('active') ?? false;
  }

  // ── Touch handlers ─────────────────────────────────────────────────────────
  document.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { startX = startY = 0; return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', function (e) {
    if (!inRoomView()) return;

    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;

    if (Math.abs(dx) < SWIPE_MIN_PX) return;
    if (Math.abs(dx) < Math.abs(dy) * RATIO_MIN) return;

    const leftOpen  = !isCollapsed('peers-panel');
    const rightOpen = !isCollapsed('files-panel');
    const goRight   = dx > 0;
    const mid       = window.innerWidth / 2;

    if (!leftOpen && !rightOpen) {
      // Both closed — unambiguous
      if (goRight) clickBtn('peers-toggle-btn');
      else         clickBtn('files-toggle-btn');

    } else if (leftOpen && rightOpen) {
      // Both open — unambiguous
      if (goRight) clickBtn('files-toggle-btn');
      else         clickBtn('peers-toggle-btn');

    } else if (leftOpen) {
      // Only left open
      // Swipe right → left already open, right already closed → no-op
      // Swipe left  → ambiguous: close left or open right → use startX
      if (!goRight) {
        if (startX < mid) clickBtn('peers-toggle-btn');
        else              clickBtn('files-toggle-btn');
      }

    } else {
      // Only right open
      // Swipe left  → right already open, left already closed → no-op
      // Swipe right → ambiguous: open left or close right → use startX
      if (goRight) {
        if (startX < mid) clickBtn('peers-toggle-btn');
        else              clickBtn('files-toggle-btn');
      }
    }

    // Block the synthetic click the browser fires after touchend so the
    // panels.js click-outside handler doesn't immediately undo the swipe.
    window.swipeJustHandled = true;
    setTimeout(function () { window.swipeJustHandled = false; }, 350);
  }, { passive: true });

})();