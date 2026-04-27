/**
 * transport.js — defines window.NativeBridge
 *
 * On Android   : thin shim over window.AndroidBridge (@JavascriptInterface).
 * In browser   : no-op stubs so room.js never throws on non-Android.
 * Tauri (future): swap the shim block for window.__TAURI__ equivalents.
 *
 * Kotlin → JS callbacks (fired by JsBridge.evaluateJavascript):
 *   window._lanChunkReceived(peerId, b64Frame)
 *   window._lanReady(peerId, method)
 *   window._lanFailed(peerId, reason)
 *
 * These are installed here so they are always defined before the first frame
 * arrives, regardless of module load order.
 */

// ── Kotlin → JS callbacks ────────────────────────────────────────────────────

/**
 * Called by Kotlin when a TCP chunk frame arrives for any peer.
 * Decodes the base64 DC binary frame and feeds it into the Room's receive path.
 *
 * room.js must set window._lanChunkHandler after Room initialises:
 *   window._lanChunkHandler = (peerId, buffer) => room._receiveRawDCFrame(peerId, buffer);
 */
window._lanChunkReceived = function(peerId, b64Frame) {
  try {
    const bytes  = Uint8Array.from(atob(b64Frame), c => c.charCodeAt(0));
    const buffer = bytes.buffer;
    if (typeof window._lanChunkHandler === 'function') {
      window._lanChunkHandler(peerId, buffer);
    } else {
      console.warn('[transport] _lanChunkHandler not set — chunk dropped for', peerId.slice(0, 8));
    }
  } catch (e) {
    console.error('[transport] _lanChunkReceived decode error:', e.message);
  }
};

/**
 * Called by Kotlin when the TCP connection to [peerId] is established.
 * Dispatches a synthetic event that _waitForLanReady() in room.js is listening for.
 */
window._lanReady = function(peerId, method) {
  console.log('[transport] LAN ready — peer:', peerId.slice(0, 8), 'method:', method);
  window.dispatchEvent(new CustomEvent('_lanReady:' + peerId, { detail: { method } }));
};

/**
 * Called by Kotlin when a TCP connection attempt fails or drops.
 * Dispatches a synthetic event that _waitForLanReady() resolves false on.
 */
window._lanFailed = function(peerId, reason) {
  console.log('[transport] LAN failed — peer:', peerId.slice(0, 8), 'reason:', reason);
  window.dispatchEvent(new CustomEvent('_lanFailed:' + peerId, { detail: { reason } }));
};

// ── Platform detection ───────────────────────────────────────────────────────

const _isAndroid = typeof window.AndroidBridge !== 'undefined';
const _isTauri   = typeof window.__TAURI__     !== 'undefined';

// ── NativeBridge ─────────────────────────────────────────────────────────────

if (_isAndroid) {

  // ── Android shim ──────────────────────────────────────────────────────────
  window.NativeBridge = {
    isAndroid : true,
    isTauri   : false,

    /**
     * Notify Kotlin that a peer has sent its LAN caps.
     * Kotlin decides whether to attempt Wi-Fi Direct or LAN TCP.
     */
    onLanCaps(peerId, capsJson) {
      window.AndroidBridge.onLanCaps(peerId, capsJson);
    },

    /**
     * Returns true if a live TCP session exists for this peer.
     * Synchronous — safe to call before the chunk loop.
     */
    isLanReady(peerId) {
      return window.AndroidBridge.isLanReady(peerId);
    },

    /**
     * Send one encoded+encrypted DC binary frame over TCP.
     * Returns false if the session is gone (room.js falls back to WebRTC).
     */
    sendLanChunk(peerId, b64Frame) {
      return window.AndroidBridge.sendLanChunk(peerId, b64Frame);
    },

    /**
     * Tear down the TCP session for this peer (cancel / leave).
     */
    cancelLan(peerId) {
      window.AndroidBridge.cancelLan(peerId);
    },

    /**
     * Best-effort: return the device's current LAN IP so the peer can use it
     * for the direct TCP fallback. Empty string if unavailable.
     * (Not a @JavascriptInterface — derived from WebRTC local candidate in JS.)
     */
    getLanIp() {
      return window._localLanIp || '';
    },
  };

  console.log('[transport] NativeBridge → Android');

} else if (_isTauri) {

  // ── Tauri stub (future desktop shim) ──────────────────────────────────────
  window.NativeBridge = {
    isAndroid : false,
    isTauri   : true,
    onLanCaps   : () => {},
    isLanReady  : () => false,
    sendLanChunk: () => false,
    cancelLan   : () => {},
    getLanIp    : () => '',
  };
  console.log('[transport] NativeBridge → Tauri stub (not yet implemented)');

} else {

  // ── Browser / non-native no-op ────────────────────────────────────────────
  window.NativeBridge = {
    isAndroid : false,
    isTauri   : false,
    onLanCaps   : () => {},
    isLanReady  : () => false,
    sendLanChunk: () => false,
    cancelLan   : () => {},
    getLanIp    : () => '',
  };
  console.log('[transport] NativeBridge → no-op (browser)');
}

// ── Local LAN IP (populated by webrtc.js ICE candidate sniffing) ─────────────
// webrtc.js should call:  window._localLanIp = candidate.address;
// whenever it sees a host ICE candidate with a private IP.
// This value is included in the lan_caps frame so the remote peer can skip
// Wi-Fi Direct and connect directly over LAN TCP.
if (!('_localLanIp' in window)) window._localLanIp = '';
