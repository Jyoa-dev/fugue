// ── lobby.js — popovers, settings, leave modal, misc UI ──────────────────

// ── Popovers ──────────────────────────────────────────────────────────────
export function closeAllPopovers() {
  document.querySelectorAll('.lobby-popover').forEach(p => p.classList.add('hidden'));
}

function togglePopover(id) {
  const target = document.getElementById(id);
  const wasHidden = target.classList.contains('hidden');
  closeAllPopovers();
  if (wasHidden) target.classList.remove('hidden');
}

document.getElementById('info-btn')    ?.addEventListener('click', e => { e.stopPropagation(); togglePopover('info-popover'); });
document.getElementById('support-btn') ?.addEventListener('click', e => { e.stopPropagation(); togglePopover('support-popover'); });
document.getElementById('info-popover-close')    ?.addEventListener('click', closeAllPopovers);
document.getElementById('support-popover-close') ?.addEventListener('click', closeAllPopovers);

document.addEventListener('click', e => {
  if (
    !e.target.closest('.lobby-popover') &&
    !e.target.closest('.lobby-tr-btn') &&
    !e.target.closest('.settings-wrap') &&
    !e.target.closest('.fav-wrap')
  ) closeAllPopovers();
});

// ── Support popover interactions ──────────────────────────────────────────
document.getElementById('support-crypto-btn')?.addEventListener('click', () => {
  document.getElementById('support-crypto-addresses')?.classList.toggle('hidden');
});

document.querySelectorAll('.crypto-addr').forEach(el => {
  el.addEventListener('click', () => {
    navigator.clipboard?.writeText(el.textContent.trim()).catch(() => {});
    const orig = el.textContent;
    el.textContent = '✓ copied';
    setTimeout(() => el.textContent = orig, 1500);
  });
});

document.getElementById('support-thankyou')?.addEventListener('click', () => {
  const msg = document.getElementById('support-thanks-msg');
  msg?.classList.remove('hidden');
  setTimeout(() => msg?.classList.add('hidden'), 3000);
});

document.getElementById('support-coffee')?.addEventListener('click', () => {
  window.open('https://buymeacoffee.com/placeholder', '_blank');
});

document.getElementById('support-comment-send')?.addEventListener('click', () => {
  const txt = document.getElementById('support-comment')?.value.trim();
  if (!txt) return;
  document.getElementById('support-comment').value = '';
  const sent = document.getElementById('support-comment-sent');
  sent?.classList.remove('hidden');
  setTimeout(() => sent?.classList.add('hidden'), 2500);
});

// ── Settings ──────────────────────────────────────────────────────────────
const DEFAULTS = { cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256' };
window.__fugueSettings = { ...DEFAULTS };

function updateBadges() {
  const s = window.__fugueSettings;
  document.getElementById('badge-cipher')?.textContent && (document.getElementById('badge-cipher').textContent = s.cipher);
  document.getElementById('badge-kdf')   ?.textContent && (document.getElementById('badge-kdf').textContent    = s.kdf);
}

function syncSelects() {
  const s = window.__fugueSettings;
  const cipherSel = document.getElementById('cipher-select');
  const kdfSel    = document.getElementById('kdf-select');
  if (cipherSel) cipherSel.value = s.cipher;
  if (kdfSel)    kdfSel.value    = s.kdf;
}

document.getElementById('cipher-select')?.addEventListener('change', e => {
  window.__fugueSettings.cipher = e.target.value; updateBadges();
});
document.getElementById('kdf-select')?.addEventListener('change', e => {
  window.__fugueSettings.kdf = e.target.value; updateBadges();
});
document.getElementById('settings-reset-btn')?.addEventListener('click', () => {
  window.__fugueSettings = { ...DEFAULTS };
  syncSelects();
  updateBadges();
});
document.getElementById('settings-btn')?.addEventListener('click', e => {
  e.stopPropagation(); togglePopover('settings-popover');
});
document.getElementById('settings-popover-close')?.addEventListener('click', closeAllPopovers);

// ── Leave modal ───────────────────────────────────────────────────────────
const leaveModal = document.getElementById('leave-modal');
const cancelBtn  = document.getElementById('leave-modal-cancel');
const confirmBtn = document.getElementById('leave-modal-confirm');
const roomEl     = document.getElementById('room');

function isInRoom() { return roomEl?.classList.contains('active'); }
function openLeaveModal()  { if (!isInRoom()) return; leaveModal.classList.add('open'); cancelBtn?.focus(); }
function closeLeaveModal() { leaveModal?.classList.remove('open'); }

document.getElementById('logo-btn')?.addEventListener('click', openLeaveModal);
document.getElementById('logo-btn')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') openLeaveModal();
});
cancelBtn ?.addEventListener('click', closeLeaveModal);
leaveModal?.addEventListener('click', e => { if (e.target === leaveModal) closeLeaveModal(); });
confirmBtn?.addEventListener('click', () => {
  closeLeaveModal();
  document.getElementById('leave-btn')?.click();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeLeaveModal(); closeAllPopovers(); }
});

// ── Meta / events toggle buttons ──────────────────────────────────────────
document.getElementById('meta-toggle-btn')  ?.addEventListener('click', () => document.dispatchEvent(new CustomEvent('toggle-events')));
document.getElementById('toggle-events-btn')?.addEventListener('click', () => document.dispatchEvent(new CustomEvent('toggle-events')));

// ── Bubble peer-color observer ────────────────────────────────────────────
const msgContainer = document.getElementById('messages');
if (msgContainer) {
  const applyBubbleColor = msg => {
    const author     = msg.querySelector('.msg-author');
    const miniAvatar = msg.querySelector('.peer-avatar, [style*="background"]');
    const color = author?.style.color
      || miniAvatar?.style.background
      || miniAvatar?.style.backgroundColor
      || null;
    if (color) msg.style.setProperty('--peer-color', color);
  };
  new MutationObserver(mutations => {
    for (const m of mutations)
      for (const node of m.addedNodes)
        if (node.nodeType === 1 && node.classList.contains('msg'))
          requestAnimationFrame(() => applyBubbleColor(node));
  }).observe(msgContainer, { childList: true });
}
