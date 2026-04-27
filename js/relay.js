// ── relay.js — WebSocket connection manager ──────────────────────────────
export class RelayConnection extends EventTarget {
  constructor(relayUrl, canal, identity, sessionId) {
    super();
    this.relayUrl        = relayUrl;
    this.canal           = canal;
    this.identity        = identity;
    this.sessionId       = sessionId;
    this.ws              = null;
    this.peerId          = null;
    this._reconnectDelay = 1000;
    this._dead           = false;
    this._pingInterval   = null;
  }

  connect() {
    const url = `${this.relayUrl}/room/${encodeURIComponent(this.canal)}?identity=${encodeURIComponent(this.identity)}&sessionId=${encodeURIComponent(this.sessionId)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this._reconnectDelay = 1000;
      this._pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 5000);
      this.dispatchEvent(new CustomEvent('open'));
    };

    this.ws.onmessage = (e) => {
      try {
        this.dispatchEvent(new CustomEvent('message', { detail: JSON.parse(e.data) }));
      } catch { /* ignore malformed */ }
    };

    this.ws.onclose = () => {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
      if (this._dead) return;
      this.dispatchEvent(new CustomEvent('close'));
      setTimeout(() => this.connect(), this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 10000);
    };

    this.ws.onerror = () => this.dispatchEvent(new CustomEvent('error'));
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  disconnect() {
    this._dead = true;
    clearInterval(this._pingInterval);
    this._pingInterval = null;
    this.ws?.close();
  }
}