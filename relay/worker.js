export class Room {
  constructor(state) {
    this.state = state;
    this.peers = new Map(); // peerId → { socket, identity, sessionId, lastSeen }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url       = new URL(request.url);
    const peerId    = crypto.randomUUID();
    const identity  = url.searchParams.get("identity")  || peerId.slice(0, 8);
    const sessionId = url.searchParams.get("sessionId") || peerId;

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    // Evict any stale peer with the same sessionId (reconnect after dirty close)
    for (const [id, peer] of this.peers) {
      if (peer.sessionId === sessionId) {
        try { peer.socket.close(); } catch {}
        this.peers.delete(id);
        this._broadcast(id, JSON.stringify({
          type: "peer_left", peerId: id, identity: peer.identity, peerCount: this.peers.size
        }));
      }
    }

    this.peers.set(peerId, { socket: server, identity, sessionId, lastSeen: Date.now() });

    // Always reschedule — ensures a sweep runs even if the alarm lapsed
    // while the room was empty (the previous alarm stops when peers.size === 0).
    await this.state.storage.setAlarm(Date.now() + 10000);

    // Session salt: one random value per DO lifetime, persisted in storage.
    // All peers derive their AES key from this salt — safe to send in plaintext
    // (salt is never secret; its job is uniqueness, not secrecy).
    let salt = await this.state.storage.get('session_salt');
    if (!salt) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      salt = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      await this.state.storage.put('session_salt', salt);
      console.log(`[room] new session salt generated: ${salt}`);
    } else {
      console.log(`[room] reusing existing salt: ${salt}`);
    }

    this._broadcast(peerId, JSON.stringify({
      type: "peer_joined", peerId, identity, peerCount: this.peers.size
    }));

    server.send(JSON.stringify({
      type:  "welcome", peerId, identity, salt,
      peers: [...this.peers.entries()]
        .filter(([id]) => id !== peerId)
        .map(([id, p]) => ({ peerId: id, identity: p.identity })),
    }));

    server.addEventListener("message", async e => {
      const peer = this.peers.get(peerId);
      if (peer) peer.lastSeen = Date.now();
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'ping') return;
        if (m.type === 'leave') {
          this.peers.delete(peerId);
          this._broadcast(peerId, JSON.stringify({
            type: "peer_left", peerId, identity, peerCount: this.peers.size
          }));
          if (this.peers.size === 0) {
            await this.state.storage.delete('session_salt');
            console.log('[room] room empty on leave — salt deleted for next session');
          }
          server.close();
          return;
        }
      } catch {}
      this._broadcast(peerId, e.data);
    });

    // Socket close alone does NOT mean the peer left — they may reconnect.
    // peer_left is only emitted on explicit leave (above) or lease expiry (alarm).
    server.addEventListener("close", () => {
      this.peers.delete(peerId);
    });

    server.addEventListener("error", () => {
      this.peers.delete(peerId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // Runs every 10s, survives DO hibernation
  async alarm() {
    const cutoff = Date.now() - 15000;
    for (const [id, peer] of this.peers) {
      if (peer.lastSeen < cutoff) {
        try { peer.socket.close(); } catch {}
        this.peers.delete(id);
        this._broadcast(id, JSON.stringify({
          type: "peer_left", peerId: id, identity: peer.identity, peerCount: this.peers.size
        }));
      }
    }
    if (this.peers.size > 0) {
      await this.state.storage.setAlarm(Date.now() + 10000);
    } else {
      // Room is empty — delete the salt so the next session derives a fresh key.
      // This provides forward secrecy: old ciphertext can't be decrypted with a
      // future passphrase leak because the salt (and thus the derived key) changes.
      await this.state.storage.delete('session_salt');
    }
  }

  _broadcast(senderId, data) {
    for (const [id, peer] of this.peers) {
      if (id === senderId) continue;
      try { peer.socket.send(data); } catch { this.peers.delete(id); }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    if (url.pathname === "/health") return new Response("ok", { headers: cors() });
    const match = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]{1,64})$/);
    if (!match) return new Response("Not found", { status: 404, headers: cors() });
    const room = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
    return room.fetch(request);
  },
};

function cors() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}