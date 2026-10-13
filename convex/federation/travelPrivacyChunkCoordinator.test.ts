import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { actionRef, mutationRef, queryRef } from './refs';
import { encodeRow, type BackupRow } from './backupHelpers';
import { descriptor } from './backupLargeHelpers';
import { digest } from './security';

const modules = {
  '../federation/travelPrivacy.ts': () => import('./travelPrivacy'),
  '../federation/travelPrivacyChunkCoordinator.ts': () => import('./travelPrivacyChunkCoordinator'),
  '../federation/travelPrivacyArchives.ts': () => import('./travelPrivacyArchives'),
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/travelPrivacyChunkRewrite.ts': () => import('./travelPrivacyChunkRewrite'),
  '../federation/archiveUploadProvenance.ts': () => import('./archiveUploadProvenance'),
};
beforeAll(() =>
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }),
);
async function fixture(
  table = 'memories',
  rows: BackupRow[] = [
    {
      _id: 'selected',
      description: 'selected-private-prose',
      playerId: 'p:0',
      data: { type: 'travel', visitId: 'selected-visit' },
    },
    {
      _id: 'other',
      description: 'other-retained-prose',
      playerId: 'p:1',
      data: { type: 'travel', visitId: 'other-visit' },
    },
  ],
) {
  const t = convexTest(schema, modules);
  const chunk = { index: 0, table, rows: rows.map(encodeRow) },
    d = await descriptor(chunk);
  const storageId = await t.action((ctx) =>
    ctx.storage.store(new Blob([JSON.stringify(chunk)], { type: 'application/json' })),
  );
  const ids = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const jobId = await ctx.db.insert('travelPrivacyJobs', {
      visitId: 'selected-visit',
      scope: 'SENSITIVE',
      state: 'READY',
      phase: 'ARCHIVE_CHUNK_CHECK',
      tableIndex: 0,
      cursor: null,
      revision: 0,
      sourceRevision: 0,
      privacyRevision: 0,
      changed: false,
      worldId,
      role: 'home',
      ownerGlobalId: 'owner',
      conversationIds: [],
      conversationOwners: [],
      transcriptIds: [],
      memoryIds: [],
      memoryOwners: [],
      archiveIds: [],
      textHashes: [],
      blockers: [],
      externalCopies: 0,
      counts: {},
      processedRows: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const backupId = await ctx.db.insert('backupLargeJobs', {
      kind: 'import',
      state: 'COMPLETE',
      phase: 'COMPLETE',
      tableIndex: 0,
      cursor: null,
      chunkCount: 0,
      processedChunks: 0,
      recordCount: rows.length,
      bytes: d.bytes,
      createdAt: 1,
      updatedAt: 1,
      source: {},
    });
    const chunkId = await ctx.db.insert('backupLargeChunks', { jobId: backupId, ...d, storageId });
    const scanId = await ctx.db.insert('travelPrivacyChunkScans', {
      jobId,
      privacyRevision: 0,
      version: 1,
      revision: 0,
      phase: 'READY_TO_REWRITE',
      cursor: null,
      cutoff: 1,
      changedInPass: false,
      objects: 1,
      rows: rows.length,
      selectedRows: 1,
      blockers: 0,
      blockerCodes: [],
      sourceRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const planId = await ctx.db.insert('travelPrivacyChunkObjects', {
      scanId,
      backupJobId: backupId,
      chunkId,
      role: 'OLD',
      originalStorageId: storageId,
      originalDigest: d.digest,
      descriptor: d,
      backupDigest: await digest((await ctx.db.get(backupId))!),
      state: 'CHECKED',
      rowOffset: rows.length,
      selectedRows: 1,
      selectionDigest: 'selection',
      nextCursor: null,
      scanDone: true,
      referenceCursor: null,
      blockers: [],
      aliases: [{ table: 'backupLargeChunks', id: chunkId }],
    });
    for (const [rowIndex, row] of rows.entries()) {
      await ctx.db.insert('travelPrivacyChunkRows', {
        scanId,
        objectId: planId,
        backupJobId: backupId,
        role: 'OLD',
        selected: rowIndex === 0,
        evidence: {
          sourceId: row._id,
          table,
          rowIndex,
          relatedMemoryIds: [],
          evidenceMemoryIds: [],
          storageIds: [],
        },
      });
      await ctx.db.insert('backupLargeRows', {
        jobId: backupId,
        role: 'OLD',
        table,
        sourceId: row._id,
        chunkIndex: 0,
        rowIndex,
        state: 'SNAPSHOT',
        references: [],
        metadata: { oldPrivateCopy: row.description ?? row.payload },
      });
    }
    return { jobId, backupId, chunkId, scanId, planId };
  });
  const rewriteId = await t.mutation(mutationRef('travelPrivacyChunkRewrite/startRewrite'), {
    scanId: ids.scanId,
  });
  return { t, ...ids, rewriteId, storageId, chunk, d };
}
async function status(f: Awaited<ReturnType<typeof fixture>>) {
  return f.t.query(queryRef('travelPrivacyChunkRewrite/status'), { rewriteId: f.rewriteId });
}
async function step(f: Awaited<ReturnType<typeof fixture>>) {
  const current = (await status(f))!;
  // convex-test 0.0.60 omits Blob.type from stored metadata. Repair only the emulator field,
  // then exercise the real recovery path (the production writer still checks every byte).
  const invoke = async () => {
    const latest = await f.t.run((ctx) => ctx.db.system.query('_storage').order('desc').first());
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Math.max(Date.now(), Math.ceil(latest?._creationTime ?? 0) + 10));
    try {
      await f.t.action(actionRef('travelPrivacyChunkRewrite/page'), {
        rewriteId: f.rewriteId,
        revision: (await status(f))!.revision,
      });
    } finally {
      clock.mockRestore();
    }
  };
  await invoke();
  const repaired = await f.t.run(async (ctx) => {
    const operations = await ctx.db.query('archiveUploadOperations').collect();
    let changed = false;
    for (const object of await ctx.db.system.query('_storage').collect()) {
      const op = operations.find(
        (op) =>
          op.state === 'UPLOADING' &&
          op.size === object.size &&
          Buffer.from(op.sha256Hex, 'hex').toString('base64') === object.sha256,
      );
      if (op && !object.contentType) {
        await ctx.db.patch(object._id as never, { contentType: op.contentType } as never);
        changed = true;
      }
    }
    return changed;
  });
  if (repaired) await invoke();
  return (await status(f))!;
}
async function until(f: Awaited<ReturnType<typeof fixture>>, phase: string) {
  for (let n = 0; n < 100; n++) {
    const s = await status(f);
    if (s!.phase === phase) return s!;
    const next = await step(f);
    if (next.errorCode) throw new Error(`${next.phase}: ${next.errorCode}`);
  }
  throw new Error('Page limit');
}

async function wireParent(f: Awaited<ReturnType<typeof fixture>>) {
  await f.t.run(async (ctx) => {
    const parent = (await ctx.db.get(f.jobId))!;
    await ctx.db.insert('visitLedger', {
      visitId: parent.visitId,
      agentGlobalId: parent.ownerGlobalId,
      homeTownId: 'home',
      hostTownId: 'host',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      leaseExpiry: Date.now() - 120000,
      fencingToken: 'synthetic-fence',
      state: 'COMPLETED',
      role: 'home',
      worldId: parent.worldId,
      homePlayerId: 'p:0',
      hostPlayerId: 'p:1',
      profile: {},
      cleanupConfirmed: true,
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.patch(f.jobId, {
      state: 'RUNNING',
      phase: 'CHUNK_REWRITE',
      chunkRewriteId: f.rewriteId,
    });
  });
}
const retryToken = 'synthetic-review-admin-token-00000';
beforeEach(() => {
  jest.useFakeTimers();
  process.env.FEDERATION_ADMIN_TOKEN = retryToken;
});
afterEach(() => {
  jest.useRealTimers();
});

test('retry fences an old writer actor revision', async () => {
  const f = await fixture();
  await wireParent(f);
  const before = (await status(f))!;
  await f.t.mutation(mutationRef('travelPrivacy/retry'), {
    adminToken: retryToken,
    jobId: f.jobId,
  });
  const afterRetry = (await status(f))!;
  // Safety requirement: retry invalidates the revision captured by an already-running coordinator action.
  expect(afterRetry.revision).toBeGreaterThan(before.revision);
  await f.t.mutation(mutationRef('travelPrivacyChunkRewrite/preparePage'), {
    rewriteId: f.rewriteId,
    revision: before.revision,
  });
  expect((await status(f))!.revision).toBe(afterRetry.revision);
});

test('retry after writer completion permits the unfinished parent to advance', async () => {
  const f = await fixture();
  await wireParent(f);
  await until(f, 'DONE');
  await f.t.mutation(mutationRef('travelPrivacy/retry'), {
    adminToken: retryToken,
    jobId: f.jobId,
  });
  const parent = (await f.t.run((ctx) => ctx.db.get(f.jobId)))!;
  await f.t.mutation(mutationRef('travelPrivacyChunkCoordinator/finishRewrite'), {
    jobId: f.jobId,
    revision: parent.revision,
  });
  expect((await f.t.run((ctx) => ctx.db.get(f.jobId)))!.phase).toBe('PURGE');
});

test('stale parent completion never bypasses a nondeleted chunk candidate', async () => {
  const f = await fixture();
  await wireParent(f);
  await until(f, 'DELETE');
  await f.t.run((ctx) => ctx.db.patch(f.rewriteId, { phase: 'DONE' }));
  await expect(
    f.t.mutation(mutationRef('travelPrivacyChunkCoordinator/finishRewrite'), {
      jobId: f.jobId,
      revision: 0,
    }),
  ).rejects.toThrow('CHUNK_DELETE_NOT_CONFIRMED');
  expect((await f.t.run((ctx) => ctx.db.get(f.jobId)))!.phase).toBe('CHUNK_REWRITE');
  expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).not.toBeNull();
  await f.t.run((ctx) => ctx.db.patch(f.jobId, { revision: 1 }));
  await f.t.mutation(mutationRef('travelPrivacyChunkCoordinator/finishRewrite'), {
    jobId: f.jobId,
    revision: 0,
  });
  expect((await f.t.run((ctx) => ctx.db.get(f.jobId)))!.phase).toBe('CHUNK_REWRITE');
});

test('retry fences an already planned DELETE invocation before object erasure', async () => {
  const f = await fixture();
  await wireParent(f);
  await until(f, 'DELETE');
  const before = (await status(f))!;
  const planned = await f.t.query(queryRef('travelPrivacyChunkRewrite/deletionData'), {
    rewriteId: f.rewriteId,
    revision: before.revision,
  });
  expect(planned).not.toBeNull();
  await f.t.mutation(mutationRef('travelPrivacy/retry'), {
    adminToken: retryToken,
    jobId: f.jobId,
  });
  const erased = await f.t.mutation(mutationRef('travelPrivacyChunkRewrite/eraseOriginal'), {
    rewriteId: f.rewriteId,
    revision: before.revision,
    candidateId: planned.candidate._id,
    referenceDigest: planned.snapshot.digest,
  });
  expect(erased).toBe(false);
  expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).not.toBeNull();
  expect((await f.t.run((ctx) => ctx.db.get(planned.candidate._id as Id<'travelPrivacyChunkReplacements'>)))!.state).toBe('PUBLISHED');
});

test('duplicate actors with one checkpoint allocate only one physical candidate', async () => {
  const f = await fixture();
  await wireParent(f);
  const before = (await status(f))!;
  await Promise.all(
    [0, 1].map(() =>
      f.t.mutation(mutationRef('travelPrivacyChunkRewrite/preparePage'), {
        rewriteId: f.rewriteId,
        revision: before.revision,
      }),
    ),
  );
  const after = (await status(f))!;
  expect(after.revision).toBe(before.revision + 1);
  expect(after.objects).toBe(1);
  expect(
    await f.t.run((ctx) => ctx.db.query('travelPrivacyChunkReplacements').collect()),
  ).toHaveLength(1);
  expect(
    await f.t.run((ctx) => ctx.db.query('travelPrivacyChunkManifestRewrites').collect()),
  ).toHaveLength(1);
});

test('inspection retry creates a new checkpoint and stale parent actors cannot mark it READY', async () => {
  const f = await fixture();
  await wireParent(f);
  await f.t.run((ctx) =>
    ctx.db.patch(f.jobId, {
      state: 'INSPECTING',
      phase: 'CHUNK_CHECK',
      chunkScanId: f.scanId,
      chunkRewriteId: undefined,
    }),
  );
  await f.t.mutation(mutationRef('travelPrivacy/retry'), {
    adminToken: retryToken,
    jobId: f.jobId,
  });
  const parent = (await f.t.run((ctx) => ctx.db.get(f.jobId)))!;
  expect(parent.revision).toBe(1);
  expect(parent.chunkScanId).not.toBe(f.scanId);
  const before = (await f.t.run((ctx) => ctx.db.get(parent.chunkScanId!)))!;
  await f.t.action(actionRef('travelPrivacyChunkCoordinator/page'), {
    jobId: f.jobId,
    revision: 0,
  });
  await f.t.mutation(mutationRef('travelPrivacyChunkCoordinator/finishInspection'), {
    jobId: f.jobId,
    revision: 0,
  });
  expect((await f.t.run((ctx) => ctx.db.get(parent.chunkScanId!)))!.revision).toBe(before.revision);
  expect((await f.t.run((ctx) => ctx.db.get(f.jobId)))!.state).toBe('INSPECTING');
});
