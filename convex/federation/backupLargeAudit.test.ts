import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { createIdentityKeys, digest } from './security';
import { DEFAULT_RESOURCE_LIMITS } from './resources';
import type { LargeManifest } from './backupLargeHelpers';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/backupLarge.ts': () => import('./backupLarge'),
};
const adminToken = 'chunk-export-audit-admin-token-32';
const mutation = (name: string) =>
  makeFunctionReference<'mutation'>(`federation/backupLarge:${name}`);
const action = (name: string) => makeFunctionReference<'action'>(`federation/backupLarge:${name}`);
beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
});
beforeEach(() => {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
});
async function town() {
  const t = convexTest(schema, modules);
  const keys = await createIdentityKeys();
  await t.run((ctx) =>
    ctx.db.insert('federationIdentity', {
      ...keys,
      townId: 'town:export-audit',
      townName: 'Audit',
      deploymentInstanceId: 'audit-instance',
      deploymentEpoch: 1,
      endpoint: 'https://audit.example/federation/v1',
      enabled: false,
      allowIncomingPairRequests: false,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 8,
      maxVisitDurationMs: 300000,
      resourceLimits: DEFAULT_RESOURCE_LIMITS,
      mode: 'ACTIVE',
      createdAt: 1,
    }),
  );
  return t;
}

test('invalid export attribution fails before creating a job or taking the maintenance lock', async () => {
  const t = await town();
  for (const fields of [
    { operator: 'Ada' },
    { operator: ' ', reason: 'Backup' },
    { operator: 'Ada', reason: 'x'.repeat(1001) },
  ]) {
    await expect(t.mutation(mutation('startExport'), { adminToken, ...fields })).rejects.toThrow(
      'BACKUP_EXPORT_ATTRIBUTION_REQUIRED',
    );
  }
  expect(await t.run((ctx) => ctx.db.query('backupLargeJobs').collect())).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query('backupMaintenanceLocks').collect())).toHaveLength(0);
});

test.each([true, false])(
  'completed export audits the actual signed manifest once, declared=%s',
  async (declared) => {
    const t = await town();
    const { jobId } = await t.mutation(mutation('startExport'), {
      adminToken,
      ...(declared ? { operator: ' Ada ', reason: ' Recovery rehearsal ' } : {}),
    });
    expect(await t.run((ctx) => ctx.db.query('backupExportAudits').collect())).toHaveLength(0);
    let complete = false;
    for (let i = 0; i < 100; i++) {
      const next = await t.action(action('advanceExport'), { adminToken, jobId });
      if (next.state === 'FAILED') throw new Error(next.error);
      if (next.state === 'COMPLETE') {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
    const { manifest }: { manifest: LargeManifest } = await t.action(action('getManifest'), {
      adminToken,
      jobId,
    });
    await t.action(action('advanceExport'), { adminToken, jobId });
    const audits = await t.run((ctx) => ctx.db.query('backupExportAudits').collect());
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      sourceTownId: manifest.source.townId,
      exportedAt: manifest.exportedAt,
      manifestDigest: await digest(manifest),
      operator: declared ? 'Ada' : 'Unspecified administrator',
      reason: declared ? 'Recovery rehearsal' : 'Legacy export client',
      attribution: declared ? 'declared' : 'legacy-admin-token',
      sectionCounts: manifest.chunks.reduce<Record<string, number>>((counts, chunk) => {
        counts[chunk.table] = (counts[chunk.table] ?? 0) + chunk.count;
        return counts;
      }, {}),
      bytes: manifest.chunks.reduce((bytes, chunk) => bytes + chunk.bytes, 0),
    });
    expect(await t.run((ctx) => ctx.db.query('backupMaintenanceLocks').collect())).toHaveLength(0);
    expect(JSON.stringify(audits)).not.toContain(adminToken);
    expect(JSON.stringify(audits)).not.toContain('privateKeyEncrypted');
  },
);
