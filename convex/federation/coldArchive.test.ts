import { convexTest } from 'convex-test';
import { internalAction } from '../_generated/server';
import { v } from 'convex/values';
import schema from '../schema';
import { actionRef, mutationRef, queryRef } from './refs';
import { createIdentityKeys, digest, sign } from './security';
import { rawSha256, mirrorKey } from './coldArchivePolicy';
import {
  coldBytes,
  describeColdChunk,
  chunkCertificate,
  EMPTY_COLD_CHAIN,
} from './coldHistoryChunkFormat';
import type { Id } from '../_generated/dataModel';

const token = 'synthetic-cold-mirror-admin';
const config = {
  name: 'synthetic',
  endpoint: 'https://s3.example',
  region: 'us-east-1',
  bucket: 'synthetic-bucket',
  prefix: 'private',
  accessKeyId: 'SYNTHETICACCESS',
  secretAccessKey: 'synthetic-test-only-credential',
};
let fail = false,
  uploads: { key: string; body: string }[] = [];
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/coldArchive.ts': () => import('./coldArchive'),
  '../federation/coldArchiveNode.ts': async () => ({
    putVerified: internalAction({
      args: {
        name: v.string(),
        environmentBinding: v.string(),
        scope: v.string(),
        runId: v.string(),
        index: v.union(v.number(), v.literal('root')),
        body: v.string(),
      },
      handler: async (_ctx, args: any) => {
        if (fail) return { ok: false, error: 'S3_HTTP_503' };
        const key = mirrorKey(config.prefix, args.scope, args.runId, args.index);
        uploads.push({ key, body: args.body });
        return {
          ok: true,
          key,
          sha256: await rawSha256(args.body),
          bytes: new TextEncoder().encode(args.body).length,
        };
      },
    }),
  }),
};
beforeEach(() => {
  process.env.FEDERATION_ADMIN_TOKEN = token;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.COLD_ARCHIVE_S3_CONFIG = JSON.stringify([config]);
  fail = false;
  uploads = [];
});
afterEach(() => {
  delete process.env.FEDERATION_ADMIN_TOKEN;
  delete process.env.FEDERATION_KEY_ENCRYPTION_KEY;
  delete process.env.COLD_ARCHIVE_S3_CONFIG;
});
async function fixture() {
  const t = convexTest(schema, modules),
    keys = await createIdentityKeys();
  const identityId = await t.run((ctx) =>
    ctx.db.insert('federationIdentity', {
      ...keys,
      townId: 'synthetic-town',
      townName: 'Synthetic',
      deploymentInstanceId: 'synthetic-instance',
      deploymentEpoch: 1,
      identityVersion: 1,
      mode: 'ACTIVE',
      endpoint: 'https://synthetic.example/federation/v1',
      enabled: false,
      allowIncomingPairRequests: false,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 1,
      maxVisitDurationMs: 300000,
      createdAt: 1,
    }),
  );
  const worldId = await t.run((ctx) =>
    ctx.db.insert('worlds', { nextId: 1, players: [], agents: [], conversations: [] }),
  );
  const sourceKey = JSON.stringify(['conversation', worldId, 'c:1']);
  const payloads = [0, 1].map((index) => ({
    format: 'ai-town-cold-history-chunk' as const,
    version: 2 as const,
    sourceKey,
    snapshotId: 'synthetic-snapshot',
    index,
    start: index,
    messages: [
      {
        messageId: `synthetic-${index}`,
        authorPlayerId: 'p:0',
        text: `Synthetic ${index} 原文`,
        occurredAt: index + 1,
      },
    ],
  }));
  const descriptors = [await describeColdChunk(payloads[0], EMPTY_COLD_CHAIN)];
  descriptors.push(await describeColdChunk(payloads[1], descriptors[0].chainDigest));
  const storageIds = await t.action(async (ctx) => {
    const ids: Id<'_storage'>[] = [];
    for (const payload of payloads)
      ids.push(await ctx.storage.store(new Blob([JSON.stringify(payload)])));
    return ids;
  });
  const manifest = {
    format: 'ai-town-cold-history',
    version: 2,
    schemaVersion: 1,
    sourceTownId: 'synthetic-town',
    sourceKey,
    kind: 'conversation',
    sourceId: 'c:1',
    snapshotId: 'synthetic-snapshot',
    exportedAt: 1,
    chunkCount: 2,
    count: 2,
    bytes: payloads.reduce((total, payload) => total + coldBytes(payload), 0),
    digest: descriptors[1].chainDigest,
  };
  const signature = await sign(manifest, keys.privateKeyEncrypted);
  const signatures = await Promise.all(
    descriptors.map((descriptor) =>
      sign(chunkCertificate(sourceKey, 'synthetic-snapshot', descriptor), keys.privateKeyEncrypted),
    ),
  );
  const archiveId = await t.run(async (ctx) => {
    const archiveId = await ctx.db.insert('coldHistoryArchives', {
      worldId,
      sourceKey,
      sourceId: 'c:1',
      kind: 'conversation',
      state: 'VERIFIED',
      manifest,
      signature,
      publicKey: keys.publicKey,
      createdAt: 1,
    });
    for (let index = 0; index < 2; index++)
      await ctx.db.insert('coldHistoryChunks', {
        archiveId,
        ...descriptors[index],
        storageId: storageIds[index],
        signature: signatures[index],
      });
    return archiveId;
  });
  const destinationId = (await t.mutation(mutationRef('coldArchive/configure'), {
    adminToken: token,
    name: config.name,
    enabled: true,
    operator: 'synthetic-admin',
  })) as Id<'coldArchiveDestinations'>;
  return { t, identityId, archiveId, destinationId, storageIds };
}
async function begin(f: Awaited<ReturnType<typeof fixture>>) {
  await f.t.action(actionRef('coldArchive/verify'), {
    adminToken: token,
    destinationId: f.destinationId,
  });
  uploads = [];
  return (await f.t.mutation(mutationRef('coldArchive/start'), {
    adminToken: token,
    archiveId: f.archiveId,
    destinationId: f.destinationId,
    operator: 'synthetic-admin',
  })) as Id<'coldArchiveMirrorJobs'>;
}

test('verified parts are uploaded one at a time and signed root is published last without local deletion', async () => {
  const f = await fixture(),
    jobId = await begin(f);
  for (let index = 0; index < 3; index++) {
    const result = await f.t.action(actionRef('coldArchive/advance'), { adminToken: token, jobId });
    expect(result.nextIndex).toBe(index + 1);
    expect(result.state).toBe(index === 2 ? 'COMPLETE' : 'RUNNING');
  }
  expect(uploads.map((row) => row.key.split('/').at(-1))).toEqual([
    'part-0.json',
    'part-1.json',
    'root.json',
  ]);
  expect(JSON.parse(uploads[2].body).manifest.chunkCount).toBe(2);
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(f.archiveId)).toMatchObject({ state: 'VERIFIED' });
    for (const id of f.storageIds) expect(await ctx.db.system.get(id)).not.toBeNull();
    expect(await ctx.db.query('coldArchiveMirrorObjects').collect()).toHaveLength(3);
  });
  await expect(
    f.t.action(actionRef('coldArchive/advance'), { adminToken: token, jobId }),
  ).rejects.toThrow('COLD_ARCHIVE_JOB_TERMINAL');
});

test('failed upload retains cursor, retries the same key and cancel fences late receipts', async () => {
  const f = await fixture(),
    jobId = await begin(f);
  fail = true;
  await expect(
    f.t.action(actionRef('coldArchive/advance'), { adminToken: token, jobId }),
  ).rejects.toThrow('S3_HTTP_503');
  expect(await f.t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
    state: 'FAILED',
    nextIndex: 0,
  });
  fail = false;
  await f.t.action(actionRef('coldArchive/advance'), { adminToken: token, jobId });
  const captured = await f.t.query(queryRef('coldArchive/pageData'), { jobId });
  await f.t.mutation(mutationRef('coldArchive/cancel'), { adminToken: token, jobId });
  await expect(
    f.t.mutation(mutationRef('coldArchive/savePage'), {
      jobId,
      revision: captured.job.revision,
      key: 'late',
      sha256: 'a'.repeat(64),
      bytes: 10,
    }),
  ).rejects.toThrow('COLD_ARCHIVE_CHECKPOINT_CHANGED');
  expect(await f.t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
    state: 'CANCELLED',
    nextIndex: 1,
  });
  expect(uploads).toHaveLength(1);
});

test('identity, destination and server credential changes cannot silently redirect an existing mirror', async () => {
  const f = await fixture(),
    jobId = await begin(f);
  process.env.COLD_ARCHIVE_S3_CONFIG = JSON.stringify([{ ...config, prefix: 'other' }]);
  await expect(
    f.t.action(actionRef('coldArchive/advance'), { adminToken: token, jobId }),
  ).rejects.toThrow('COLD_ARCHIVE_ENVIRONMENT_CHANGED');
  expect(uploads).toHaveLength(0);
  process.env.COLD_ARCHIVE_S3_CONFIG = JSON.stringify([config]);
  await f.t.run((ctx) => ctx.db.patch(f.identityId, { deploymentEpoch: 2 }));
  await expect(
    f.t.action(actionRef('coldArchive/advance'), { adminToken: token, jobId }),
  ).rejects.toThrow('COLD_ARCHIVE_IDENTITY_CHANGED');
  await f.t.run((ctx) => ctx.db.patch(f.identityId, { deploymentEpoch: 1 }));
  await f.t.mutation(mutationRef('coldArchive/configure'), {
    adminToken: token,
    name: config.name,
    enabled: true,
    operator: 'synthetic-admin',
  });
  await expect(f.t.query(queryRef('coldArchive/pageData'), { jobId })).rejects.toThrow(
    'COLD_ARCHIVE_DESTINATION_CHANGED',
  );
});

test('admin-only metadata exposes no server credentials and old revisions cannot commit twice', async () => {
  const f = await fixture(),
    jobId = await begin(f);
  await expect(
    f.t.query(queryRef('coldArchive/status'), { adminToken: 'wrong' }),
  ).rejects.toThrow();
  const publicStatus = JSON.stringify(
    await f.t.query(queryRef('coldArchive/status'), { adminToken: token }),
  );
  expect(publicStatus).not.toContain(config.secretAccessKey);
  expect(publicStatus).not.toContain(config.accessKeyId);
  const captured = await f.t.query(queryRef('coldArchive/pageData'), { jobId });
  await f.t.action(actionRef('coldArchive/advance'), { adminToken: token, jobId });
  await expect(
    f.t.mutation(mutationRef('coldArchive/savePage'), {
      jobId,
      revision: captured.job.revision,
      key: uploads[0].key,
      sha256: await rawSha256(uploads[0].body),
      bytes: new TextEncoder().encode(uploads[0].body).length,
    }),
  ).rejects.toThrow('COLD_ARCHIVE_CHECKPOINT_CHANGED');
  expect(await f.t.run((ctx) => ctx.db.query('coldArchiveMirrorObjects').collect())).toHaveLength(
    1,
  );
});

test('v1 signed files mirror exact payload and changed source metadata blocks a later page', async () => {
  const f = await fixture();
  const previous = await f.t.run((ctx) => ctx.db.get(f.archiveId));
  const payload = {
    format: 'ai-town-cold-history',
    version: 1,
    sourceKey: previous!.sourceKey,
    messages: [
      {
        messageId: 'synthetic-v1',
        authorPlayerId: 'p:0',
        text: 'Synthetic retained 原文',
        occurredAt: 1,
      },
    ],
  };
  const storageId = await f.t.action((ctx) =>
    ctx.storage.store(new Blob([JSON.stringify(payload)])),
  );
  const manifest = {
    format: 'ai-town-cold-history',
    version: 1,
    schemaVersion: 1,
    sourceTownId: 'synthetic-town',
    sourceKey: previous!.sourceKey,
    kind: 'conversation',
    sourceId: 'c:1',
    exportedAt: 1,
    count: 1,
    bytes: coldBytes(payload),
    digest: await digest(payload),
  };
  const local = await f.t.run((ctx) => ctx.db.get(f.identityId));
  await f.t.run(async (ctx) =>
    ctx.db.patch(f.archiveId, {
      manifest,
      storageId,
      signature: await sign(manifest, local!.privateKeyEncrypted),
    }),
  );
  const jobId = await begin(f);
  expect(
    await f.t.action(actionRef('coldArchive/advance'), { adminToken: token, jobId }),
  ).toMatchObject({ state: 'COMPLETE', partCount: 0 });
  expect(JSON.parse(uploads[0].body).payload).toEqual(payload);
  const second = await f.t.mutation(mutationRef('coldArchive/start'), {
    adminToken: token,
    archiveId: f.archiveId,
    destinationId: f.destinationId,
    operator: 'synthetic-admin',
  });
  await f.t.run((ctx) => ctx.db.patch(f.archiveId, { signature: 'changed-invalid-signature' }));
  const count = uploads.length;
  await expect(
    f.t.action(actionRef('coldArchive/advance'), { adminToken: token, jobId: second }),
  ).rejects.toThrow('COLD_ARCHIVE_SOURCE_CHANGED');
  expect(uploads).toHaveLength(count);
  expect(await f.t.run((ctx) => ctx.db.system.get(storageId))).not.toBeNull();
});
