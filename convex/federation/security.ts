import { canonicalJson, SignedPacket } from './protocol';
const encoder = new TextEncoder();
export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left); const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}
export function requireAdmin(adminToken: string): void {
  const expected = process.env.FEDERATION_ADMIN_TOKEN;
  if (!expected || expected.length < 24 || !constantTimeEqual(adminToken, expected)) throw new Error('ADMIN_UNAUTHORIZED');
}
export function toBase64(bytes: Uint8Array): string {
  let value = ''; for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
export function fromBase64(value: string): Uint8Array {
  const raw = atob(value); return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
export function randomSecret(): string { return toBase64(crypto.getRandomValues(new Uint8Array(32))); }
export function validatePairingSecret(secret: string): void {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(secret) || fromBase64(secret).length !== 32) throw new Error('PAIRING_SECRET_MUST_BE_32_RANDOM_BYTES_BASE64');
}
async function wrappingKey(): Promise<CryptoKey> {
  const value = process.env.FEDERATION_KEY_ENCRYPTION_KEY;
  if (!value) throw new Error('FEDERATION_KEY_ENCRYPTION_KEY_REQUIRED');
  validatePairingSecret(value);
  return crypto.subtle.importKey('raw', fromBase64(value), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealSecret(value: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode('ai-town-federation/secrets/1') }, await wrappingKey(), encoder.encode(value));
  return `${toBase64(nonce)}.${toBase64(new Uint8Array(data))}`;
}
export async function openSecret(value: string): Promise<string> {
  const parts = value.split('.'); if (parts.length !== 2) throw new Error('INVALID_ENCRYPTED_SECRET');
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(parts[0]), additionalData: encoder.encode('ai-town-federation/secrets/1') }, await wrappingKey(), fromBase64(parts[1]));
  return new TextDecoder().decode(data);
}
export async function digest(value: unknown): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalJson(value)))));
}
export async function createIdentityKeys() {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  const privateKey = toBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey)));
  return { publicKey, privateKeyEncrypted: await sealSecret(privateKey), fingerprint: `sha256:${await digest(publicKey)}` };
}
export async function sign(value: unknown, encryptedKey: string): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', fromBase64(await openSecret(encryptedKey)), { name: 'Ed25519' }, false, ['sign']);
  return toBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', key, encoder.encode(canonicalJson(value)))));
}
export async function verifySignature(value: unknown, signature: string, publicKey: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, fromBase64(signature), encoder.encode(canonicalJson(value)));
  } catch { return false; }
}
export async function mac(value: unknown, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', fromBase64(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalJson(value)))));
}
export async function verifyMac(value: unknown, proof: string, secret: string): Promise<boolean> {
  return constantTimeEqual(await mac(value, secret), proof);
}
export async function signPacket<T>(body: T, privateKeyEncrypted: string, credentialEncrypted: string): Promise<SignedPacket<T>> {
  return { body, signature: await sign(body, privateKeyEncrypted), mac: await mac(body, await openSecret(credentialEncrypted)) };
}
export async function verifyPacket<T>(packet: SignedPacket<T>, publicKey: string, credentialEncrypted: string): Promise<boolean> {
  return await verifySignature(packet.body, packet.signature, publicKey) && await verifyMac(packet.body, packet.mac, await openSecret(credentialEncrypted));
}
export async function ephemeralKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  return { publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey), privateKeyEncrypted: await sealSecret(JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey))) };
}
// HTTPS supplies authenticated encryption; this is application authentication and HKDF
// separation, not an implementation of Noise/PAKE or a safe plaintext HTTP handshake.
export async function deriveCredential(privateKeyEncrypted: string, remotePublicKey: JsonWebKey, secret: string, transcript: unknown): Promise<string> {
  const local = await crypto.subtle.importKey('jwk', JSON.parse(await openSecret(privateKeyEncrypted)), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const remote = await crypto.subtle.importKey('jwk', remotePublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: remote }, local, 256));
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const key = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: fromBase64(secret), info: encoder.encode(`ai-town-federation/peer-auth/1:${await digest(transcript)}`) }, material, 256);
  return toBase64(new Uint8Array(key));
}
