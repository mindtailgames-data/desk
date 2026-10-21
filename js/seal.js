// Encrypts a value for a GitHub secret, in the browser: GitHub accepts a secret only encrypted with the repository's
// public key as a libsodium "sealed box" (crypto_box_seal). The value is never sent or kept unencrypted; only
// GitHub's servers can open it, and nobody can read it back afterwards (not even with the token).
// A sealed box: a new key pair for this one message; nonce = BLAKE2b-192(its public key || the repository's key);
// out = its public key || crypto_box(value, nonce, the repository's key, its secret key).
// crypto_box is TweetNaCl's (js/vendor/nacl-fast.min.js, public domain); BLAKE2b (RFC 7693) is below.
import './vendor/nacl-fast.min.js';   // (sets self.nacl)

const M = (1n << 64n) - 1n;
const IV = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1',
  '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'].map(h => BigInt('0x' + h));
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]];
const rot = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M;

export function blake2b(data, outLen) {   // unkeyed BLAKE2b, outLen 1..64 bytes
  const h = IV.slice(); h[0] ^= 0x01010000n ^ BigInt(outLen);
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let b = 0; b < blocks; b++) {
    const chunk = new Uint8Array(128); chunk.set(data.subarray(b * 128, b * 128 + 128));
    const m = []; for (let i = 0; i < 16; i++) { let w = 0n; for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(chunk[i * 8 + j]); m.push(w); }
    const last = b === blocks - 1, t = BigInt(last ? data.length : (b + 1) * 128);
    const v = h.concat(IV); v[12] ^= t & M; v[13] ^= t >> 64n; if (last) v[14] ^= M;
    const G = (a, b2, c, d, x, y) => {
      v[a] = (v[a] + v[b2] + x) & M; v[d] = rot(v[d] ^ v[a], 32); v[c] = (v[c] + v[d]) & M; v[b2] = rot(v[b2] ^ v[c], 24);
      v[a] = (v[a] + v[b2] + y) & M; v[d] = rot(v[d] ^ v[a], 16); v[c] = (v[c] + v[d]) & M; v[b2] = rot(v[b2] ^ v[c], 63);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]); G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]);
      G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]); G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}

export function seal(message, publicKey) {   // Uint8Array, Uint8Array(32) -> Uint8Array
  const nacl = self.nacl, e = nacl.box.keyPair();
  const nonce = blake2b(new Uint8Array([...e.publicKey, ...publicKey]), 24);
  const box = nacl.box(message, nonce, publicKey, e.secretKey);
  e.secretKey.fill(0);
  const out = new Uint8Array(32 + box.length); out.set(e.publicKey); out.set(box, 32);
  return out;
}

// the value encrypted for a GitHub secret: { encrypted_value (base64), key_id } from the repository's public key
export function sealForGitHub(value, repoKey) {
  const pk = Uint8Array.from(atob(repoKey.key), c => c.charCodeAt(0));
  const sealed = seal(new TextEncoder().encode(value), pk);
  let s = ''; for (const b of sealed) s += String.fromCharCode(b);
  return { encrypted_value: btoa(s), key_id: repoKey.key_id };
}
