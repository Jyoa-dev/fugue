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

panels.forEach(({ panelId, btnId }) => {
  const panel = document.getElementById(panelId);
  const btn   = document.getElementById(btnId);
  if (!panel || !btn) return;
  panelRefs.push({ panel, btn });

  setCollapsed(panel, btn, MOBILE(), false);

  btn.addEventListener('click', () => {
    setCollapsed(panel, btn, !panel.classList.contains('collapsed'), true);
  });

  panel.addEventListener('click', e => {
    if (!panel.classList.contains('collapsed')) return;
    if (e.target.closest('.panel-toggle-btn')) return;
    setCollapsed(panel, btn, false, true);
  });
});

let wasMobile = MOBILE();
window.addEventListener('resize', () => {
  const isMobile = MOBILE();
  if (isMobile && !wasMobile) collapseAllForMobile();
  if (!isMobile && wasMobile) panelRefs.forEach(({ panel, btn }) => setCollapsed(panel, btn, false, true));
  wasMobile = isMobile;
});

document.addEventListener('click', e => {
  if (window.swipeJustHandled) return;
  if (e.target.closest('#peers-panel') || e.target.closest('#files-panel')) return;
  if (e.target.closest('.file-bubble')) return;
  if (e.target.closest('#messages') && e.target.id !== 'messages') return;
  if (e.target.closest('#msg-input') || e.target.closest('#send-btn') || e.target.closest('.attach-btn')) return;
  panelRefs.forEach(({ panel, btn }) => {
    if (!panel.classList.contains('collapsed')) setCollapsed(panel, btn, true, true);
  });
});