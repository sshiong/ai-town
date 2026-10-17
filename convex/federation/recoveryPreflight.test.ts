import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { actionRef } from './refs';
import { createIdentityKeys, sign } from './security';

const script = '../../scripts/federation-recovery-preflight.mjs';
let verifyRecoveryPair: (pack: any, passphrase: string, archive: any) => Promise<any>;
let readRecoveryFile: (file: string, limit: number, privateFile?: boolean) => string;
const adminToken = 'preflight-test-administrator-token';
const passphrase = 'independent recovery preflight passphrase';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/identityRecovery.ts': () => import('./identityRecovery'),
};
let pack: any, manifest: any, archive: any, keys: Awaited<ReturnType<typeof createIdentityKeys>>;
beforeAll(async () => {
  ({ verifyRecoveryPair, readRecoveryFile } = await import(script));
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  keys = await createIdentityKeys();
  const t = convexTest(schema, modules);
  const source = { townId: 'town:preflight', publicKey: keys.publicKey, fingerprint: keys.fingerprint,
    deploymentEpoch: 4, deploymentInstanceId: 'source-deployment' };
  await t.run(ctx => ctx.db.insert('federationIdentity', { ...source, ...keys,
    townName: 'Preflight Town', endpoint: 'https://town.example/federation/v1', mode: 'ACTIVE',
    enabled: false, allowIncomingPairRequests: false, allowUnencryptedHttp: false, allowPublicHttp: false,
    maxVisitors: 2, maxVisitDurationMs: 300000, createdAt: 1 }));
  pack = await t.action(actionRef('identityRecovery/exportEncryptedIdentity'), { adminToken, passphrase });
  manifest = { format: 'ai-town-chunks', version: 1, source, exportedAt: Date.now(),
    chunks: [{ index: 0, count: 20 }, { index: 7, count: 3 }] };
  archive = { manifest, signature: await sign(manifest, keys.privateKeyEncrypted) };
});

test('accepts a production identity export and production-signed RAW manifest without claiming migration completion', async () => {
  const proof = await verifyRecoveryPair(pack, passphrase, archive);
  expect(proof).toMatchObject({ identityMatches: true, identitySignatureValid: true,
    archiveManifestSignatureValid: true, decryptionValid: true, privateKeyMatches: true,
    recordCount: 23, chunkCount: 2,
    notChecked: ['chunkContents', 'sourceShutdown', 'targetState', 'signedHandoff'] });
  const bundle = { format: 'ai-town-archive-bundle', version: 1, manifest: JSON.stringify(archive),
    chunks: [], privacyChunks: [] };
  expect(await verifyRecoveryPair(pack, passphrase, bundle)).toEqual(proof);
  expect(JSON.stringify(proof)).not.toContain(passphrase);
  expect(JSON.stringify(proof)).not.toContain(pack.ciphertext);
});

test('rejects another town, a stale epoch, derivative proof and tampered manifest before decryption', async () => {
  for (const field of ['townId', 'publicKey', 'fingerprint', 'deploymentEpoch']) {
    const source = { ...manifest.source, [field]: field === 'deploymentEpoch' ? 3 : 'different' };
    await expect(verifyRecoveryPair(pack, passphrase, { ...archive, manifest: { ...manifest, source } }))
      .rejects.toThrow('RECOVERY_ARCHIVE_IDENTITY_MISMATCH');
  }
  await expect(verifyRecoveryPair(pack, passphrase, { ...archive, localProof: {} }))
    .rejects.toThrow('RECOVERY_ORIGINAL_RAW_ARCHIVE_REQUIRED');
  await expect(verifyRecoveryPair(pack, passphrase, { ...archive, manifest: { ...manifest, exportedAt: 1 } }))
    .rejects.toThrow('RECOVERY_ARCHIVE_SIGNATURE_INVALID');
});

test('rejects wrong passphrases and a validly encrypted package containing a different private key', async () => {
  await expect(verifyRecoveryPair(pack, 'wrong passphrase long enough', archive))
    .rejects.toThrow('RECOVERY_DECRYPTION_FAILED');
  const other = await createIdentityKeys();
  const { openSecret, fromBase64, toBase64 } = await import('./security');
  const { canonicalJson } = await import('./protocol');
  const material = await crypto.subtle.importKey('raw', Buffer.from(passphrase), 'PBKDF2', false, ['deriveKey']);
  const wrappingKey = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256',
    salt: fromBase64(pack.header.salt), iterations: pack.header.iterations }, material,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: fromBase64(pack.header.nonce), additionalData: Buffer.from(canonicalJson(pack.header)),
  }, wrappingKey, Buffer.from(JSON.stringify({ privateKey: await openSecret(other.privateKeyEncrypted) })));
  const body = { header: pack.header, ciphertext: toBase64(new Uint8Array(ciphertext)) };
  const changed = { ...body, signature: await sign(body, keys.privateKeyEncrypted) };
  await expect(verifyRecoveryPair(changed, passphrase, archive)).rejects.toThrow('RECOVERY_PRIVATE_KEY_MISMATCH');
});

test('bounds package parameters and rejects malformed key encoding or an invalid package signature', async () => {
  await expect(verifyRecoveryPair({ ...pack, header: { ...pack.header, iterations: 2 ** 31 } }, passphrase, archive))
    .rejects.toThrow('RECOVERY_INVALID_IDENTITY_PACKAGE');
  await expect(verifyRecoveryPair({ ...pack, signature: Buffer.alloc(64).toString('base64') }, passphrase, archive))
    .rejects.toThrow('RECOVERY_IDENTITY_SIGNATURE_INVALID');
  await expect(verifyRecoveryPair({ ...pack, signature: 'invalid encoding' }, passphrase, archive))
    .rejects.toThrow('RECOVERY_INVALID_ENCODING');
});

test('file reads enforce actual byte limits, restrictive passphrase permissions and no symlinks; CLI errors redact content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitown-recovery-preflight-'));
  try {
    const secretFile = path.join(dir, 'passphrase.txt'), link = path.join(dir, 'link');
    fs.writeFileSync(secretFile, passphrase, { mode: 0o600 });
    expect(readRecoveryFile(secretFile, 1024, true)).toBe(passphrase);
    expect(() => readRecoveryFile(secretFile, 2, true)).toThrow('RECOVERY_FILE_LIMIT');
    fs.chmodSync(secretFile, 0o644);
    expect(() => readRecoveryFile(secretFile, 1024, true)).toThrow('RECOVERY_PASSPHRASE_FILE_PERMISSIONS');
    fs.chmodSync(secretFile, 0o600);
    fs.symlinkSync(secretFile, link);
    expect(() => readRecoveryFile(link, 1024, true)).toThrow('RECOVERY_FILE_READ_FAILED');
    const malformed = path.join(dir, 'invalid.json');
    fs.writeFileSync(malformed, `invalid-json-${passphrase}`);
    try {
      execFileSync(process.execPath, ['scripts/federation-recovery-preflight.mjs', '--identity', malformed,
        '--passphrase-file', secretFile, '--archive', malformed], { encoding: 'utf8', stdio: 'pipe' });
      throw new Error('CLI_ACCEPTED_INVALID_JSON');
    } catch (error: any) {
      expect(error.status).toBe(1);
      expect(error.stdout).toBe('');
      expect(error.stderr.trim()).toBe('RECOVERY_PREFLIGHT_FAILED');
      expect(error.stderr).not.toContain(passphrase);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
