import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).filter(k => value[k] !== undefined).sort()
    .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  fail('RECOVERY_INVALID_JSON');
}
function base64(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('RECOVERY_INVALID_ENCODING');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || length !== undefined && bytes.length !== length)
    fail('RECOVERY_INVALID_ENCODING');
  return bytes;
}
async function signed(value, signature, key, code) {
  if (!await crypto.subtle.verify('Ed25519', key, base64(signature, 64), Buffer.from(canonical(value))))
    fail(code);
}

// This is an offline identity-pair check. Chunk contents and target authorization
// remain the responsibility of the production import and signed handoff APIs.
export async function verifyRecoveryPair(identityPackage, passphrase, archive) {
  const pack = identityPackage, h = pack?.header;
  if (!object(pack) || Object.keys(pack).sort().join(',') !== 'ciphertext,header,signature' ||
      !object(h) || Object.keys(h).sort().join(',') !==
      'cipher,exportedAt,fingerprint,format,iterations,kdf,nonce,publicKey,salt,sourceDeploymentEpoch,townId,version' ||
      h.format !== 'ai-town-identity-recovery' || h.version !== 1 || h.cipher !== 'AES-256-GCM' ||
      h.kdf !== 'PBKDF2-SHA256' || h.iterations !== 310000 ||
      typeof h.townId !== 'string' || !h.townId.startsWith('town:') ||
      !Number.isSafeInteger(h.sourceDeploymentEpoch) || h.sourceDeploymentEpoch < 1 ||
      h.sourceDeploymentEpoch >= Number.MAX_SAFE_INTEGER ||
      !Number.isFinite(h.exportedAt) || h.exportedAt < 0 || h.exportedAt > Date.now() + 60000)
    fail('RECOVERY_INVALID_IDENTITY_PACKAGE');
  if (typeof passphrase !== 'string' || passphrase.length < 12 || Buffer.byteLength(passphrase) > 1024)
    fail('RECOVERY_INVALID_PASSPHRASE');
  if (!object(archive)) fail('RECOVERY_INVALID_ARCHIVE');
  let header = archive;
  if (archive.format === 'ai-town-archive-bundle') {
    if (archive.version !== 1 || typeof archive.manifest !== 'string') fail('RECOVERY_INVALID_ARCHIVE');
    try { header = JSON.parse(archive.manifest); } catch { fail('RECOVERY_INVALID_ARCHIVE'); }
  }
  const manifest = header?.manifest, source = manifest?.source;
  if (!object(manifest) || manifest.format !== 'ai-town-chunks' || !object(source) ||
      !Array.isArray(manifest.chunks) || header.localProof !== undefined || header.sourceSignatureValid === false)
    fail('RECOVERY_ORIGINAL_RAW_ARCHIVE_REQUIRED');
  if (source.townId !== h.townId || source.publicKey !== h.publicKey || source.fingerprint !== h.fingerprint ||
      source.deploymentEpoch !== h.sourceDeploymentEpoch)
    fail('RECOVERY_ARCHIVE_IDENTITY_MISMATCH');
  const publicBytes = base64(h.publicKey, 32);
  // Match security.digest: base64 SHA-256 of canonical JSON, including string quotes.
  if (h.fingerprint !== `sha256:${crypto.createHash('sha256').update(canonical(h.publicKey)).digest('base64')}`)
    fail('RECOVERY_FINGERPRINT_MISMATCH');
  const key = await crypto.subtle.importKey('raw', publicBytes, 'Ed25519', false, ['verify']);
  await signed({ header: h, ciphertext: pack.ciphertext }, pack.signature, key, 'RECOVERY_IDENTITY_SIGNATURE_INVALID');
  await signed(manifest, header.signature, key, 'RECOVERY_ARCHIVE_SIGNATURE_INVALID');
  const material = await crypto.subtle.importKey('raw', Buffer.from(passphrase), 'PBKDF2', false, ['deriveKey']);
  const wrappingKey = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256',
    salt: base64(h.salt, 16), iterations: h.iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let secret;
  try {
    secret = JSON.parse(Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64(h.nonce, 12),
      additionalData: Buffer.from(canonical(h)) }, wrappingKey, base64(pack.ciphertext))).toString('utf8'));
  } catch { fail('RECOVERY_DECRYPTION_FAILED'); }
  try {
    const privateKey = await crypto.subtle.importKey('pkcs8', base64(secret.privateKey), 'Ed25519', false, ['sign']);
    const challenge = crypto.randomBytes(32), proof = await crypto.subtle.sign('Ed25519', privateKey, challenge);
    if (!await crypto.subtle.verify('Ed25519', key, proof, challenge)) fail('KEY_MISMATCH');
  } catch { fail('RECOVERY_PRIVATE_KEY_MISMATCH'); }
  if (manifest.chunks.some(c => !object(c) || !Number.isSafeInteger(c.count) || c.count < 0))
    fail('RECOVERY_INVALID_ARCHIVE');
  const recordCount = manifest.chunks.reduce((n, c) => n + c.count, 0);
  if (!Number.isSafeInteger(recordCount)) fail('RECOVERY_INVALID_ARCHIVE');
  return { identityMatches: true, identitySignatureValid: true, archiveManifestSignatureValid: true,
    decryptionValid: true, privateKeyMatches: true, recordCount, chunkCount: manifest.chunks.length,
    archiveExportedAt: manifest.exportedAt, identityExportedAt: h.exportedAt,
    notChecked: ['chunkContents', 'sourceShutdown', 'targetState', 'signedHandoff'] };
}

export function readRecoveryFile(file, maxBytes, privateFile = false) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) fail('RECOVERY_FILE_LIMIT');
    if (privateFile && ((stat.mode & 0o077) !== 0 ||
        typeof process.getuid === 'function' && stat.uid !== process.getuid()))
      fail('RECOVERY_PASSPHRASE_FILE_PERMISSIONS');
    // Bound the actual read too, even if the file grows after fstat.
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0, read;
    while ((read = fs.readSync(fd, buffer, total, buffer.length - total, null)) > 0) {
      total += read;
      if (total > maxBytes) fail('RECOVERY_FILE_LIMIT');
    }
    return buffer.subarray(0, total).toString('utf8');
  } catch (error) {
    if (error.message?.startsWith('RECOVERY_')) throw error;
    fail('RECOVERY_FILE_READ_FAILED');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== '--identity' || args[2] !== '--passphrase-file' || args[4] !== '--archive')
      fail('RECOVERY_USAGE: --identity FILE --passphrase-file PRIVATE_FILE --archive FILE');
    const pack = JSON.parse(readRecoveryFile(args[1], 64 * 1024));
    const passphrase = readRecoveryFile(args[3], 1026, true).replace(/\r?\n$/, '');
    const archive = JSON.parse(readRecoveryFile(args[5], 64 * 1024 * 1024));
    console.log(JSON.stringify(await verifyRecoveryPair(pack, passphrase, archive)));
  } catch (error) {
    // Never print crypto errors, supplied objects, file contents or passphrases.
    console.error(error.message?.startsWith('RECOVERY_') ? error.message : 'RECOVERY_PREFLIGHT_FAILED');
    process.exitCode = 1;
  }
}
