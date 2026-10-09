import { v } from 'convex/values';
import { action, internalMutation, internalQuery, query } from '../maintenanceFunctions';
import { makeFunctionReference } from 'convex/server';
import { canonicalJson, normalizeEndpoint } from './protocol';
import { assertTownUnlocked } from './maintenanceLock';
import { identity } from './store';
import {
  digest,
  fromBase64,
  openSecret,
  requireAdmin,
  sealSecret,
  sign,
  toBase64,
  verifySignature,
} from './security';

const encode = new TextEncoder();
const ITERATIONS = 310_000;
const MAX_PACKAGE_BYTES = 64 * 1024;
const sourceRef = makeFunctionReference<'query'>('federation/identityRecovery:sourceIdentity');
const auditRef = makeFunctionReference<'mutation'>('federation/identityRecovery:auditExport');
const restoreRef = makeFunctionReference<'mutation'>('federation/identityRecovery:installIdentity');

type Header = {
  format: 'ai-town-identity-recovery';
  version: 1;
  townId: string;
  publicKey: string;
  fingerprint: string;
  sourceDeploymentEpoch: number;
  exportedAt: number;
  cipher: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  nonce: string;
};
export type IdentityRecoveryPackage = { header: Header; ciphertext: string; signature: string };
function validatePassphrase(passphrase: string) {
  if (passphrase.length < 12 || encode.encode(passphrase).length > 1024)
    throw new Error('RECOVERY_PASSPHRASE_LENGTH');
}
async function passphraseKey(passphrase: string, salt: string) {
  validatePassphrase(passphrase);
  const material = await crypto.subtle.importKey(
    'raw',
    encode.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(salt), iterations: ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
function validatePackage(value: unknown): IdentityRecoveryPackage {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    encode.encode(JSON.stringify(value)).length > MAX_PACKAGE_BYTES
  )
    throw new Error('INVALID_IDENTITY_RECOVERY_PACKAGE');
  const p = value as IdentityRecoveryPackage,
    h = p.header;
  if (
    !h ||
    Object.keys(p).sort().join(',') !== 'ciphertext,header,signature' ||
    Object.keys(h).sort().join(',') !==
      'cipher,exportedAt,fingerprint,format,iterations,kdf,nonce,publicKey,salt,sourceDeploymentEpoch,townId,version' ||
    h.format !== 'ai-town-identity-recovery' ||
    h.version !== 1 ||
    h.cipher !== 'AES-256-GCM' ||
    h.kdf !== 'PBKDF2-SHA256' ||
    h.iterations !== ITERATIONS ||
    typeof h.townId !== 'string' ||
    !h.townId.startsWith('town:') ||
    h.townId.length > 200 ||
    typeof h.publicKey !== 'string' ||
    typeof h.fingerprint !== 'string' ||
    !Number.isSafeInteger(h.sourceDeploymentEpoch) ||
    h.sourceDeploymentEpoch < 1 ||
    h.sourceDeploymentEpoch >= Number.MAX_SAFE_INTEGER ||
    !Number.isFinite(h.exportedAt) ||
    h.exportedAt < 0 ||
    h.exportedAt > Date.now() + 60_000 ||
    typeof h.salt !== 'string' ||
    typeof h.nonce !== 'string' ||
    typeof p.ciphertext !== 'string' ||
    typeof p.signature !== 'string'
  )
    throw new Error('INVALID_IDENTITY_RECOVERY_PACKAGE');
  try {
    if (
      fromBase64(h.publicKey).length !== 32 ||
      fromBase64(h.salt).length !== 16 ||
      fromBase64(h.nonce).length !== 12 ||
      fromBase64(p.signature).length !== 64 ||
      fromBase64(p.ciphertext).length < 16
    )
      throw new Error();
  } catch {
    throw new Error('INVALID_IDENTITY_RECOVERY_PACKAGE');
  }
  return p;
}
export const sourceIdentity = internalQuery({ args: {}, handler: async (ctx) => identity(ctx) });
export const auditExport = internalMutation({
  args: {
    townId: v.string(),
    fingerprint: v.string(),
    sourceDeploymentEpoch: v.number(),
    deploymentInstanceId: v.string(),
  },
  handler: async (ctx, args) => {
    await assertTownUnlocked(ctx);
    const local = await identity(ctx);
    if (
      !local ||
      local.townId !== args.townId ||
      local.deploymentInstanceId !== args.deploymentInstanceId
    )
      throw new Error('IDENTITY_CHANGED_DURING_EXPORT');
    await ctx.db.insert('identityRecoveryAudit', {
      ...args,
      operation: 'EXPORT',
      createdAt: Date.now(),
    });
  },
});
export const exportEncryptedIdentity = action({
  args: { adminToken: v.string(), passphrase: v.string() },
  handler: async (ctx, args): Promise<IdentityRecoveryPackage> => {
    requireAdmin(args.adminToken);
    validatePassphrase(args.passphrase);
    const local = await ctx.runQuery(sourceRef, {});
    if (!local) throw new Error('INITIALIZE_IDENTITY_FIRST');
    const header: Header = {
      format: 'ai-town-identity-recovery',
      version: 1,
      townId: local.townId,
      publicKey: local.publicKey,
      fingerprint: local.fingerprint,
      sourceDeploymentEpoch: local.deploymentEpoch,
      exportedAt: Date.now(),
      cipher: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: ITERATIONS,
      salt: toBase64(crypto.getRandomValues(new Uint8Array(16))),
      nonce: toBase64(crypto.getRandomValues(new Uint8Array(12))),
    };
    // Only identity material is encrypted here. Ordinary backups remain a separate artifact.
    const secret = {
      townName: local.townName,
      privateKey: await openSecret(local.privateKeyEncrypted),
      maxVisitors: local.maxVisitors,
      maxVisitDurationMs: local.maxVisitDurationMs,
    };
    const ciphertext = toBase64(
      new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: fromBase64(header.nonce),
            additionalData: encode.encode(canonicalJson(header)),
          },
          await passphraseKey(args.passphrase, header.salt),
          encode.encode(JSON.stringify(secret)),
        ),
      ),
    );
    const body = { header, ciphertext };
    const result = { ...body, signature: await sign(body, local.privateKeyEncrypted) };
    await ctx.runMutation(auditRef, {
      townId: local.townId,
      fingerprint: local.fingerprint,
      sourceDeploymentEpoch: local.deploymentEpoch,
      deploymentInstanceId: local.deploymentInstanceId,
    });
    return result;
  },
});
export const restoreEncryptedIdentity = action({
  args: {
    adminToken: v.string(),
    passphrase: v.string(),
    package: v.any(),
    sourceStopped: v.boolean(),
    endpoint: v.string(),
  },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    if (!args.sourceStopped) throw new Error('RECOVERY_SOURCE_STOP_REQUIRED');
    const endpoint = normalizeEndpoint(args.endpoint),
      p = validatePackage(args.package),
      { header, ciphertext } = p;
    if (
      header.fingerprint !== `sha256:${await digest(header.publicKey)}` ||
      !(await verifySignature({ header, ciphertext }, p.signature, header.publicKey))
    )
      throw new Error('IDENTITY_RECOVERY_SIGNATURE_INVALID');
    let secret: {
      townName: string;
      privateKey: string;
      maxVisitors: number;
      maxVisitDurationMs: number;
    };
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: fromBase64(header.nonce),
          additionalData: encode.encode(canonicalJson(header)),
        },
        await passphraseKey(args.passphrase, header.salt),
        fromBase64(ciphertext),
      );
      secret = JSON.parse(new TextDecoder().decode(plaintext));
      if (
        !secret ||
        typeof secret.townName !== 'string' ||
        !secret.townName.trim() ||
        secret.townName.length > 80 ||
        typeof secret.privateKey !== 'string' ||
        !Number.isSafeInteger(secret.maxVisitors) ||
        secret.maxVisitors < 0 ||
        secret.maxVisitors > 100 ||
        !Number.isSafeInteger(secret.maxVisitDurationMs) ||
        secret.maxVisitDurationMs < 30_000 ||
        secret.maxVisitDurationMs > 86_400_000
      )
        throw new Error();
      const key = await crypto.subtle.importKey(
        'pkcs8',
        fromBase64(secret.privateKey),
        'Ed25519',
        false,
        ['sign'],
      );
      const proof = toBase64(
        new Uint8Array(
          await crypto.subtle.sign('Ed25519', key, encode.encode(canonicalJson(header))),
        ),
      );
      if (!(await verifySignature(header, proof, header.publicKey))) throw new Error();
    } catch {
      throw new Error('RECOVERY_DECRYPTION_FAILED');
    }
    return ctx.runMutation(restoreRef, {
      townId: header.townId,
      townName: secret.townName,
      publicKey: header.publicKey,
      fingerprint: header.fingerprint,
      privateKeyEncrypted: await sealSecret(secret.privateKey),
      sourceDeploymentEpoch: header.sourceDeploymentEpoch,
      endpoint,
      maxVisitors: secret.maxVisitors,
      maxVisitDurationMs: secret.maxVisitDurationMs,
    });
  },
});
export const installIdentity = internalMutation({
  args: {
    townId: v.string(),
    townName: v.string(),
    publicKey: v.string(),
    fingerprint: v.string(),
    privateKeyEncrypted: v.string(),
    sourceDeploymentEpoch: v.number(),
    endpoint: v.string(),
    maxVisitors: v.number(),
    maxVisitDurationMs: v.number(),
  },
  handler: async (ctx, args) => {
    await assertTownUnlocked(ctx);
    if (
      (await identity(ctx)) ||
      (await ctx.db.query('worlds').first()) ||
      (await ctx.db.query('visitLedger').first()) ||
      (await ctx.db.query('federationPeers').first()) ||
      (await ctx.db.query('residentModelBindings').first())
    )
      throw new Error('IDENTITY_RECOVERY_REQUIRES_EMPTY_DESTINATION');
    const { sourceDeploymentEpoch, ...fields } = args,
      deploymentInstanceId = crypto.randomUUID(),
      deploymentEpoch = sourceDeploymentEpoch + 1,
      createdAt = Date.now();
    await ctx.db.insert('federationIdentity', {
      ...fields,
      deploymentInstanceId,
      deploymentEpoch,
      createdAt,
      mode: 'ACTIVE',
      enabled: false,
      allowIncomingPairRequests: false,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
    });
    await ctx.db.insert('deploymentRecords', {
      townId: args.townId,
      deploymentInstanceId,
      deploymentEpoch,
      mode: 'ACTIVE',
      createdAt,
    });
    await ctx.db.insert('identityRecoveryAudit', {
      operation: 'RESTORE',
      townId: args.townId,
      fingerprint: args.fingerprint,
      sourceDeploymentEpoch,
      deploymentInstanceId,
      createdAt,
    });
    return {
      townId: args.townId,
      fingerprint: args.fingerprint,
      deploymentInstanceId,
      deploymentEpoch,
      federationEnabled: false,
    };
  },
});

export const history = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    return ctx.db.query('identityRecoveryAudit').order('desc').take(50);
  },
});
