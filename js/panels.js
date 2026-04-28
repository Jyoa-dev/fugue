// ── panels.js — collapsible side panels ──────────────────────────────────
const MOBILE = () => window.innerWidth <= 768;
const panels = [
  { panelId: 'peers-panel', btnId: 'peers-toggle-btn' },
  { panelId: 'files-panel', btnId: 'files-toggle-btn' },
];
const panelRefs = [];

function setCollapsed(panel, btn, collapsed, animate) {
  if (animate) panel.classList.add('panel-transitioning');
  panel.classList.toggle('collapsed', collapsed);
  btn.classList.toggle('is-collapsed', collapsed);
  btn.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
  if (animate) {
    panel.addEventListener('transitionend', () => panel.classList.remove('panel-transitioning'), { once: true });
  }
}

function collapseAllForMobile() {
  panelRefs.forEach(({ panel, btn }) => setCollapsed(panel, btn, true, false));
}

// ── Attach all interactive behaviour to one panel+btn pair ───────────────
// Idempotent: a data attribute guards against double-binding.
function _bindPanelListeners(panel, btn) {
  if (panel.dataset.panelBound) return;
  panel.dataset.panelBound = '1';

  btn.addEventListener('click', () => {
    setCollapsed(panel, btn, !panel.classList.contains('collapsed'), true);
  });

  // Clicking anywhere in a collapsed panel expands it (except the toggle btn itself)
  panel.addEventListener('click', e => {
    if (!panel.classList.contains('collapsed')) return;
    if (e.target.closest('.panel-toggle-btn')) return;
    setCollapsed(panel, btn, false, true);
  });
}

// ── Discover + bind a panel if it is now in the DOM ─────────────────────
function _tryRegisterPanel(panelId, btnId) {
  if (panelRefs.some(r => r.panel.id === panelId)) return; // already registered
  const panel = document.getElementById(panelId);
  const btn   = document.getElementById(btnId);
  if (!panel || !btn) return;
  panelRefs.push({ panel, btn });
  _bindPanelListeners(panel, btn);
}

// ── Called by app.js when a room is entered / re-entered ─────────────────
// Desktop → panels open; mobile → panels hidden.
// Safe to call before or after panels appear in the DOM.
function initPanelsForRoom() {
  // Re-discover panels: elements may not have been in the DOM at script load
  panels.forEach(({ panelId, btnId }) => _tryRegisterPanel(panelId, btnId));

  const collapsed = MOBILE();
  panelRefs.forEach(({ panel, btn }) => setCollapsed(panel, btn, collapsed, false));
}

// ── Best-effort early registration (panels already in DOM at parse time) ──
panels.forEach(({ panelId, btnId }) => {
  _tryRegisterPanel(panelId, btnId);
  // Set initial visual state for panels that were found immediately
  const ref = panelRefs.find(r => r.panel.id === panelId);
  if (ref) setCollapsed(ref.panel, ref.btn, MOBILE(), false);
});

let wasMobile = MOBILE();
window.addEventListener('resize', () => {
  const isMobile = MOBILE();
  if (isMobile && !wasMobile) collapseAllForMobile();
  if (!isMobile && wasMobile) panelRefs.forEach(({ panel, btn }) => setCollapsed(panel, btn, false, true));
  wasMobile = isMobile;
});

// ── Empty-click helpers ───────────────────────────────────────────────────

// Used for SINGLE-click close: must be a click on genuinely empty space
// INSIDE the conversation (#messages), not anywhere else on the page.
// This deliberately excludes panels, buttons, the bottom bar — everything.
// If the click has a real target (a message, a bubble, a button, even a
// child div of #messages), e.target will NOT be the #messages element itself.
function _isEmptyConversationClick(e) {
  if (window.swipeJustHandled) return false;
  // e.target is #messages itself only when the click landed on empty list space
  return e.target.id === 'messages';
}

// Used for DOUBLE-click open: broader — any genuinely empty area of the page,
// still excluding panels, message content, inputs, and any button/action element.
function _isEmptyClick(e) {
  if (window.swipeJustHandled)                                                    return false;
  if (e.target.closest('#peers-panel') || e.target.closest('#files-panel'))       return false;
  if (e.target.closest('.file-bubble'))                                           return false;
  if (e.target.closest('#messages') && e.target.id !== 'messages')               return false;
  if (e.target.closest('#msg-input') || e.target.closest('#send-btn'))           return false;
  if (e.target.closest('.attach-btn') || e.target.closest('[data-action]'))      return false;
  // Catch-all: no click on any button (covers panel pause/stop/cancel/send-file)
  if (e.target.closest('button') || e.target.closest('[role="button"]'))         return false;
  return true;
}

// ── Single empty click in conversation → close all panels ─────────────────
// Debounced so a double-click cancels the pending single-click action.
let _emptyClickTimer = null;

document.addEventListener('click', e => {
  if (!_isEmptyConversationClick(e)) return;
  clearTimeout(_emptyClickTimer);
  _emptyClickTimer = setTimeout(() => {
    panelRefs.forEach(({ panel, btn }) => {
      if (!panel.classList.contains('collapsed')) setCollapsed(panel, btn, true, true);
    });
  }, 200);
});

// ── Double empty click → open all panels (desktop) ───────────────────────
// Text selection starts on the 2nd mousedown, before dblclick fires,
// so we intercept mousedown to kill it at the source.
let _lastMouseDownTime = 0;

document.addEventListener('mousedown', e => {
  const now = Date.now();
  if (now - _lastMouseDownTime < 400 && _isEmptyClick(e)) {
    e.preventDefault();                  // ← block selection before it starts
  }
  _lastMouseDownTime = now;
});

document.addEventListener('dblclick', e => {
  if (!_isEmptyClick(e)) return;
  clearTimeout(_emptyClickTimer);        // cancel the pending single-click close
  panelRefs.forEach(({ panel, btn }) => setCollapsed(panel, btn, false, true));
});

// ── Double-tap → open all panels (mobile) ────────────────────────────────
// Mobile doesn't reliably fire dblclick, so we track two touchend events
// within 300 ms on an empty area and treat that as a double-tap.
// { passive: false } is required so preventDefault() can suppress text selection.
let _lastTapTime = 0;

document.addEventListener('touchend', e => {
  if (window.swipeJustHandled) return;

  const touch = e.changedTouches[0];
  if (!touch) return;

  // Resolve the actual element under the finger (more reliable than e.target
  // when the touch started on a different element).
  const target = document.elementFromPoint(touch.clientX, touch.clientY) || e.target;

  const now = Date.now();
  const isDoubleTap = now - _lastTapTime < 300;

  if (isDoubleTap && _isEmptyClick({ target })) {
    e.preventDefault();                  // ← prevent text-selection on double-tap
    clearTimeout(_emptyClickTimer);      // cancel any pending single-click close
    panelRefs.forEach(({ panel, btn }) => setCollapsed(panel, btn, false, true));
    _lastTapTime = 0;                    // reset so a triple-tap doesn't re-fire
    return;
  }

  _lastTapTime = now;
}, { passive: false });