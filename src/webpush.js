// Web Push on Cloudflare Workers — RFC 8291 (aes128gcm payload) + RFC 8292 (VAPID), pure WebCrypto.
// No Node deps, so it runs unchanged in the Worker. sendPush() returns the push service HTTP status
// (201 = accepted; 404/410 = subscription gone → caller should delete it).
const enc = new TextEncoder();

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad), b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
function bytesToB64url(bytes) {
  const b = new Uint8Array(bytes); let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hmac(keyBytes, data) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
// HKDF (extract + single expand block; every output here is <=32 bytes so one block is enough)
async function hkdf(salt, ikm, info, len) {
  const prk = await hmac(salt, ikm);
  const t = await hmac(prk, concat(info, new Uint8Array([1])));
  return t.slice(0, len);
}

// VAPID Authorization header (signed ES256 JWT + the server public key)
async function vapidAuth(endpoint, vapidPublic, privateJwk, subject) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const signingInput = header + "." + payload;
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput)));
  return "vapid t=" + signingInput + "." + bytesToB64url(sig) + ", k=" + vapidPublic;
}

// Encrypt a payload to a subscription's keys (RFC 8291). opts.salt/opts.asKeys allow deterministic test vectors.
async function encryptPayload(plaintext, p256dh, authSecretB64, opts = {}) {
  const uaPublic = b64urlToBytes(p256dh);            // receiver public key, 65 bytes
  const authSecret = b64urlToBytes(authSecretB64);   // 16 bytes
  const asKeys = opts.asKeys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));   // 65 bytes
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const record = concat(plaintext, new Uint8Array([2]));   // single, final record -> 0x02 delimiter
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);   // aes128gcm header || ciphertext
}

// Send one push. subscription = {endpoint, keys:{p256dh, auth}}. Returns the HTTP status code.
export async function sendPush(subscription, payloadObj, env) {
  const privateJwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const body = await encryptPayload(enc.encode(JSON.stringify(payloadObj)), subscription.keys.p256dh, subscription.keys.auth);
  const authz = await vapidAuth(subscription.endpoint, env.VAPID_PUBLIC, privateJwk, env.VAPID_SUBJECT || "mailto:alerts@snoking.app");
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: { Authorization: authz, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400" },
    body,
  });
  return res.status;
}

export const _test = { b64urlToBytes, bytesToB64url, encryptPayload, vapidAuth, hkdf };
