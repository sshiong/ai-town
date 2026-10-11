import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import {
  createIdentityKeys,
  fromBase64,
  openSecret,
  sign,
  toBase64,
  verifySignature,
} from './security';
import { canonicalJson } from './protocol';
import type { IdentityRecoveryPackage } from './identityRecovery';
import { DEFAULT_RESOURCE_LIMITS } from './resources';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/identityRecovery.ts': () => import('./identityRecovery'),
  '../world.ts': () => import('../world'),
};
const adminToken = 'recovery-test-admin-token-long-enough';
const passphrase = 'correct horse battery recovery';
const endpoint = 'https://restored.example/federation/v1';
const exportRef = makeFunctionReference<'action'>(
  'federation/identityRecovery:exportEncryptedIdentity',
);
const restoreRef = makeFunctionReference<'action'>(
  'federation/identityRecovery:restoreEncryptedIdentity',
);
beforeAll(() =>
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }),
);
beforeEach(() => {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
});
async function source() {
  const t = convexTest(schema, modules),
    keys = await createIdentityKeys();
  await t.run((ctx) =>
    ctx.db.insert('federationIdentity', {
      ...keys,
      townId: 'town:recovery-test',
      townName: 'Recovery Town',
      deploymentInstanceId: 'old-instance',
      deploymentEpoch: 7,
      endpoint: 'https://source.example/federation/v1',
      mode: 'ACTIVE',
      enabled: false,
      allowIncomingPairRequests: false,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 8,
      maxVisitDurationMs: 300_000,
      resourceLimits: {
        ...DEFAULT_RESOURCE_LIMITS,
        maxConcurrentLocalLLM: 1,
        maxPendingLocalLLM: 3,
      },
      createdAt: 1,
    }),
  );
  return { t, keys };
}
test('recovery keeps signing identity while rewrapping on an independent destination and increments epoch', async () => {
  const { t, keys } = await source();
  const pack = (await t.action(exportRef, { adminToken, passphrase })) as IdentityRecoveryPackage;
  expect(JSON.stringify(pack)).not.toContain(await openSecret(keys.privateKeyEncrypted));
  expect(Object.keys(pack).sort()).toEqual(['ciphertext', 'header', 'signature']);
  expect(
    await verifySignature(
      { header: pack.header, ciphertext: pack.ciphertext },
      pack.signature,
      keys.publicKey,
    ),
  ).toBe(true);
  const destination = convexTest(schema, modules);
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  const result = await destination.action(restoreRef, {
    adminToken,
    passphrase,
    package: pack,
    sourceStopped: true,
    endpoint,
  });
  expect(result).toMatchObject({
    townId: 'town:recovery-test',
    deploymentEpoch: 8,
    federationEnabled: false,
  });
  expect(result.deploymentInstanceId).not.toBe('old-instance');
  const restored = await destination.run((ctx) => ctx.db.query('federationIdentity').unique());
  expect(restored!.privateKeyEncrypted).not.toBe(keys.privateKeyEncrypted);
  expect(restored).toMatchObject({ identityVersion: 1, mode: 'MIGRATING_IN', enabled: false });
  expect(restored!.resourceLimits).toEqual({
    ...DEFAULT_RESOURCE_LIMITS,
    maxConcurrentLocalLLM: 1,
    maxPendingLocalLLM: 3,
  });
  const proof = { challenge: 'new deployment proof' };
  expect(
    await verifySignature(proof, await sign(proof, restored!.privateKeyEncrypted), keys.publicKey),
  ).toBe(true);
  expect(await destination.run((ctx) => ctx.db.query('deploymentRecords').collect())).toHaveLength(
    1,
  );
  expect(
    await destination.run((ctx) => ctx.db.query('identityRecoveryAudit').collect()),
  ).toHaveLength(1);
});

async function rewriteEncryptedSecret(
  pack: IdentityRecoveryPackage,
  privateKeyEncrypted: string,
  update: (secret: Record<string, unknown>) => void,
) {
  const encode = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw',
    encode.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: fromBase64(pack.header.salt),
      iterations: pack.header.iterations,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const options = {
    name: 'AES-GCM',
    iv: fromBase64(pack.header.nonce),
    additionalData: encode.encode(canonicalJson(pack.header)),
  };
  const plaintext = await crypto.subtle.decrypt(options, key, fromBase64(pack.ciphertext));
  const secret = JSON.parse(new TextDecoder().decode(plaintext));
  update(secret);
  const ciphertext = toBase64(
    new Uint8Array(
      await crypto.subtle.encrypt(options, key, encode.encode(JSON.stringify(secret))),
    ),
  );
  const body = { header: pack.header, ciphertext };
  return { ...body, signature: await sign(body, privateKeyEncrypted) };
}

test('legacy encrypted packages without identityVersion restore as version 1 and remain awaiting handoff', async () => {
  const { t, keys } = await source();
  const current = await t.action(exportRef, { adminToken, passphrase });
  const legacy = await rewriteEncryptedSecret(current, keys.privateKeyEncrypted, (secret) => {
    delete secret.identityVersion;
  });
  const destination = convexTest(schema, modules);
  await destination.action(restoreRef, {
    adminToken,
    passphrase,
    package: legacy,
    sourceStopped: true,
    endpoint,
  });
  expect(await destination.run((ctx) => ctx.db.query('federationIdentity').unique())).toMatchObject(
    {
      identityVersion: 1,
      mode: 'MIGRATING_IN',
      enabled: false,
    },
  );
});

test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects authenticated invalid identity version %s before installing anything',
  async (identityVersion) => {
    const { t, keys } = await source();
    const current = await t.action(exportRef, { adminToken, passphrase });
    const invalid = await rewriteEncryptedSecret(current, keys.privateKeyEncrypted, (secret) => {
      secret.identityVersion = identityVersion;
    });
    const destination = convexTest(schema, modules);
    await expect(
      destination.action(restoreRef, {
        adminToken,
        passphrase,
        package: invalid,
        sourceStopped: true,
        endpoint,
      }),
    ).rejects.toThrow('RECOVERY_DECRYPTION_FAILED');
    expect(await destination.run((ctx) => ctx.db.query('federationIdentity').first())).toBeNull();
  },
);
test('wrong passphrase and modified archive cannot leave a partially installed identity', async () => {
  const { t } = await source(),
    pack = await t.action(exportRef, { adminToken, passphrase });
  const destination = convexTest(schema, modules);
  await expect(
    destination.action(restoreRef, {
      adminToken,
      passphrase: 'wrong passphrase long enough',
      package: pack,
      sourceStopped: true,
      endpoint,
    }),
  ).rejects.toThrow('RECOVERY_DECRYPTION_FAILED');
  await expect(
    destination.action(restoreRef, {
      adminToken,
      passphrase,
      package: { ...pack, header: { ...pack.header, townId: 'town:tampered' } },
      sourceStopped: true,
      endpoint,
    }),
  ).rejects.toThrow('IDENTITY_RECOVERY_SIGNATURE_INVALID');
  expect(await destination.run((ctx) => ctx.db.query('federationIdentity').collect())).toHaveLength(
    0,
  );
  expect(await destination.run((ctx) => ctx.db.query('deploymentRecords').collect())).toHaveLength(
    0,
  );
});
test('requires authorization, source shutdown, strong passphrase and an empty destination', async () => {
  const { t } = await source();
  await expect(t.action(exportRef, { adminToken: 'bad', passphrase })).rejects.toThrow(
    'ADMIN_UNAUTHORIZED',
  );
  await expect(t.action(exportRef, { adminToken, passphrase: 'short' })).rejects.toThrow(
    'RECOVERY_PASSPHRASE_LENGTH',
  );
  const pack = await t.action(exportRef, { adminToken, passphrase });
  await expect(
    t.action(restoreRef, { adminToken, passphrase, package: pack, sourceStopped: false, endpoint }),
  ).rejects.toThrow('RECOVERY_SOURCE_STOP_REQUIRED');
  await expect(
    t.action(restoreRef, { adminToken, passphrase, package: pack, sourceStopped: true, endpoint }),
  ).rejects.toThrow('IDENTITY_RECOVERY_REQUIRES_EMPTY_DESTINATION');
  expect((await t.run((ctx) => ctx.db.query('federationIdentity').unique()))!.deploymentEpoch).toBe(
    7,
  );
});
test('archive maintenance lock prevents identity audits and normal world writes', async () => {
  const { t } = await source();
  const worldId = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 0,
      players: [],
      agents: [],
      conversations: [],
    });
    const jobId = await ctx.db.insert('backupLargeJobs', {
      kind: 'export',
      state: 'RUNNING',
      phase: 'EXPORTING',
      tableIndex: 0,
      cursor: null,
      chunkCount: 0,
      processedChunks: 0,
      recordCount: 0,
      bytes: 0,
      createdAt: 1,
      updatedAt: 1,
      source: {},
    });
    await ctx.db.insert('backupMaintenanceLocks', { key: 'town', jobId, createdAt: 1 });
    return worldId;
  });
  await expect(t.action(exportRef, { adminToken, passphrase })).rejects.toThrow(
    'TOWN_BACKUP_MAINTENANCE_LOCKED',
  );
  const before = await t.run(ctx => ctx.db.get(worldId));
  await expect(
    t.mutation(makeFunctionReference<'mutation'>('world:heartbeatWorld'), { worldId }),
  ).resolves.toBeNull();
  expect(await t.run(ctx => ctx.db.get(worldId))).toEqual(before);
  expect(await t.run(ctx => ctx.db.query('backupMaintenanceLocks').collect())).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.query('identityRecoveryAudit').collect())).toHaveLength(0);
});
