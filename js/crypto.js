// ── crypto.worker.js — AES-256-GCM off the main thread, raw binary only ──
// Noble libs bundled locally — no CDN, no re-download needed.
// Path is relative to the worker file location (js/crypto.js → lib/).



console.log('[crypto worker] loaded OK');
const chacha20poly1305  = () => { throw new Error('ChaCha20 not available'); };
const xchacha20poly1305 = () => { throw new Error('XChaCha20 not available'); };
const scrypt            = () => { throw new Error('scrypt not available'); };
const ENC = new TextEncoder();

const _keys = new Map(); // id → CryptoKey

let _argon2Ready = false;
async function _loadArgon2() {
  if (_argon2Ready) return;
  importScripts('../lib/argon2-bundled.min.js');  // sets self.argon2; wasm loaded from same dir
  _argon2Ready = true;
}

// ── Algorithm registry ───────────────────────────────────────────────────
// Maps UI setting identifiers to parameters.
// WebCrypto ciphers (AES-*) use the WebCrypto API.
// Noble ciphers (ChaCha20-*) use @noble/ciphers — same key derivation path.
// Different cipher+kdf combinations produce different keys from the same
// passphrase — intentional: settings act as an implicit room discriminator.
const CIPHER_PARAMS = {
  'AES-256-GCM':           { name: 'AES-GCM',  length: 256 },
  'AES-192-GCM':           { name: 'AES-GCM',  length: 192 },
  'AES-256-CBC':           { name: 'AES-CBC',  length: 256 },
  'ChaCha20-Poly1305':     { name: 'ChaCha20-Poly1305',  length: 256, noble: true },
  'XChaCha20-Poly1305':    { name: 'XChaCha20-Poly1305', length: 256, noble: true },
};

// For noble ciphers the key is a raw Uint8Array, not a CryptoKey.
// We store both under the same _keys map — callers never see the difference.

const KDF_HASH = {
  'PBKDF2-SHA-256': { type: 'pbkdf2', pbkdf2: 'SHA-256', hkdf: 'SHA-256' },
  'PBKDF2-SHA-512': { type: 'pbkdf2', pbkdf2: 'SHA-512', hkdf: 'SHA-512' },
  'HKDF-SHA-384':   { type: 'pbkdf2', pbkdf2: 'SHA-384', hkdf: 'SHA-384' },
  'HKDF-SHA-512':   { type: 'pbkdf2', pbkdf2: 'SHA-512', hkdf: 'SHA-512' },
  // scrypt: memory-hard KDF — no PBKDF2 pre-stretch needed, scrypt does the work.
  // N=2^17 (131072), r=8, p=1 → ~64 MB RAM, ~1-2 s on a mid-range device.
  'scrypt':         { type: 'scrypt', N: 131072, r: 8, p: 1, dkLen: 32 },
  'Argon2id': { type: 'argon2id', t: 3, m: 65536, p: 4, dkLen: 32 },
};

const DEFAULT_SETTINGS = { cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256' };

// Two-step KDF (PBKDF2 path): PBKDF2 stretches the passphrase (brute-force
// resistance), then HKDF derives the final key (domain separation).
// scrypt path: single memory-hard step, then HKDF for domain separation.
// salt must be unique per room — caller passes SHA-256(canal) as hex, never hardcoded.
// settings.cipher and settings.kdf are folded into the HKDF info string so that
// different algorithm combinations produce cryptographically distinct keys.
async function deriveKey(passphrase, salt, settings = {}) {
  const cipher = settings.cipher || DEFAULT_SETTINGS.cipher;
  const kdf    = settings.kdf    || DEFAULT_SETTINGS.kdf;

  const cipherParam = CIPHER_PARAMS[cipher] || CIPHER_PARAMS['AES-256-GCM'];
  const kdfSpec     = KDF_HASH[kdf]         || KDF_HASH['PBKDF2-SHA-256'];
  const saltBytes   = ENC.encode(salt);
  // Domain-separation info — encodes full algo combo so same passphrase +
  // different settings → completely different key.
  const info = ENC.encode(`fugue-v2:cipher=${cipher}:kdf=${kdf}`);

  let stretchedRaw;

  if (kdfSpec.type === 'argon2id') {
    await _loadArgon2();
    const result = await self.argon2.hash({
      pass:        passphrase,
      salt:        saltBytes,
      type:        self.argon2.ArgonType.Argon2id,
      time:        kdfSpec.t,
      mem:         kdfSpec.m,
      parallelism: kdfSpec.p,
      hashLen:     kdfSpec.dkLen,
    });
    stretchedRaw = result.hash; // Uint8Array[32] → continues to HKDF below
  } else if (kdfSpec.type === 'scrypt') {
    // scrypt is already memory-hard — one step is sufficient.
    // Output is 32 bytes used directly as HKDF input material.
    stretchedRaw = scrypt(
      ENC.encode(passphrase), saltBytes,
      { N: kdfSpec.N, r: kdfSpec.r, p: kdfSpec.p, dkLen: kdfSpec.dkLen }
    );
  } else {
    // Step 1 — PBKDF2: slow down offline brute-force on weak passphrases
    const pbkdf2Base = await crypto.subtle.importKey(
      'raw', ENC.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    const stretchedKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: kdfSpec.pbkdf2, salt: saltBytes, iterations: 200_000 },
      pbkdf2Base,
      { name: 'HMAC', hash: kdfSpec.pbkdf2, length: 256 },
      true,
      ['sign']
    );
    stretchedRaw = await crypto.subtle.exportKey('raw', stretchedKey);
  }

  // Step 2 — HKDF: domain-separated key derivation (same for all KDF types).
  const hkdfBase = await crypto.subtle.importKey(
    'raw', stretchedRaw, 'HKDF', false, ['deriveKey']
  );

  // For noble ciphers we need a raw 32-byte key, not a CryptoKey.
  if (cipherParam.noble) {
    const rawKey = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info },
      hkdfBase,
      256 // always 256 bits for ChaCha
    );
    return new Uint8Array(rawKey); // stored in _keys as Uint8Array
  }

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info },
    hkdfBase,
    cipherParam,
    false,
    ['encrypt', 'decrypt']
  );
}

// Returns ArrayBuffer: [12 iv bytes][ciphertext bytes] for GCM / ChaCha20
//                      [24 iv bytes][ciphertext bytes] for XChaCha20
//                      [16 iv bytes][ciphertext bytes] for CBC
async function encrypt(key, data /* ArrayBuffer | Uint8Array */) {
  const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

  // ── Noble path (ChaCha20-Poly1305 / XChaCha20-Poly1305) ──────────────
  if (key instanceof Uint8Array) {
    // Detect cipher by nonce length: xchacha uses 24 bytes, chacha uses 12.
    // We store cipher choice as key metadata — but since we only have two
    // noble ciphers and nonce size differs, we check key.xcha flag set below.
    const isX  = key._xchacha;
    const ivLen = isX ? 24 : 12;
    const iv    = crypto.getRandomValues(new Uint8Array(ivLen));
    const impl  = isX ? xchacha20poly1305(key, iv) : chacha20poly1305(key, iv);
    const ct    = impl.encrypt(buf);           // Uint8Array with 16-byte auth tag
    const out   = new Uint8Array(ivLen + ct.length);
    out.set(iv, 0);
    out.set(ct, ivLen);
    return out.buffer;
  }

  // ── WebCrypto path (AES-GCM / AES-CBC) ───────────────────────────────
  const algo   = key.algorithm.name;
  const ivLen  = algo === 'AES-CBC' ? 16 : 12;
  const iv     = crypto.getRandomValues(new Uint8Array(ivLen));
  const params = algo === 'AES-CBC' ? { name: 'AES-CBC', iv } : { name: 'AES-GCM', iv };
  const ct     = await crypto.subtle.encrypt(params, key, buf);
  const out    = new Uint8Array(ivLen + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), ivLen);
  return out.buffer;
}

// Accepts ArrayBuffer: [ivLen bytes][ciphertext+tag bytes]
async function decrypt(key, data /* ArrayBuffer */) {
  const bytes = new Uint8Array(data);

  // ── Noble path ────────────────────────────────────────────────────────
  if (key instanceof Uint8Array) {
    const isX  = key._xchacha;
    const ivLen = isX ? 24 : 12;
    const iv    = bytes.slice(0, ivLen);
    const ct    = bytes.slice(ivLen);
    const impl  = isX ? xchacha20poly1305(key, iv) : chacha20poly1305(key, iv);
    return impl.decrypt(ct).buffer;
  }

  // ── WebCrypto path ────────────────────────────────────────────────────
  const algo  = key.algorithm.name;
  const ivLen = algo === 'AES-CBC' ? 16 : 12;
  const params = algo === 'AES-CBC'
    ? { name: 'AES-CBC', iv: bytes.slice(0, ivLen) }
    : { name: 'AES-GCM', iv: bytes.slice(0, ivLen) };
  return crypto.subtle.decrypt(params, key, bytes.slice(ivLen));
}

self.onmessage = async ({ data: msg }) => {
  console.log('[crypto worker] message received:', msg.op, msg.id);
  const { id, op } = msg;
  try {
    if (op === 'derive') {
      const key = await deriveKey(msg.passphrase, msg.salt, msg.settings || {});
      // Tag noble keys with cipher variant so encrypt/decrypt can pick the right nonce size.
      if (key instanceof Uint8Array) {
        const cipher = (msg.settings || {}).cipher || DEFAULT_SETTINGS.cipher;
        key._xchacha = cipher === 'XChaCha20-Poly1305';
      }
      _keys.set(msg.keyId, key);
      self.postMessage({ id, ok: true });

    } else if (op === 'encrypt') {
      const key = _keys.get(msg.keyId);
      if (!key) throw new Error('key not found');
      const result = await encrypt(key, msg.data);
      self.postMessage({ id, ok: true, result }, [result]);

    } else if (op === 'decrypt') {
      const key = _keys.get(msg.keyId);
      if (!key) throw new Error('key not found');
      const result = await decrypt(key, msg.data);
      self.postMessage({ id, ok: true, result }, [result]);

    } else {
      throw new Error(`unknown op: ${op}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};