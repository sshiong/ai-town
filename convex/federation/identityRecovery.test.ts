import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { createIdentityKeys, openSecret, sign, verifySignature } from './security';
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
      resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, maxConcurrentLocalLLM: 1, maxPendingLocalLLM: 3 },
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
  expect(restored!.resourceLimits).toEqual({ ...DEFAULT_RESOURCE_LIMITS, maxConcurrentLocalLLM: 1, maxPendingLocalLLM: 3 });
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
  await expect(
    t.mutation(makeFunctionReference<'mutation'>('world:heartbeatWorld'), { worldId }),
  ).rejects.toThrow('TOWN_BACKUP_MAINTENANCE_LOCKED');
  expect(await t.run((ctx) => ctx.db.query('identityRecoveryAudit').collect())).toHaveLength(0);
});
