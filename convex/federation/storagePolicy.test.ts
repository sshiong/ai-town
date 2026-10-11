import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { defaultStoragePolicy, estimateRecordBytes, summarizeStoredObjects } from './storagePolicy';
import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { mutationRef, queryRef } from './refs';

const modules = {
  '../models/usage.ts': () => import('../models/usage'),
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/storagePolicy.ts': () => import('./storagePolicy'),
  '../models/embeddings.ts': () => import('../models/embeddings'),
  '../agent/embeddingsCache.ts': () => import('../agent/embeddingsCache'),
};
const adminToken = 'storage-policy-test-admin-token';
const DAY = 86400000;
beforeEach(() => {
  jest.useFakeTimers();
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
});
afterEach(() => jest.useRealTimers());
const drain = async (t: ReturnType<typeof convexTest<typeof schema.tables>>) =>
  t.finishAllScheduledFunctions(() => jest.runAllTimers());

test('usage scans every page, counts binary payloads and rejects duplicate scheduled pages', async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let i = 0; i < 121; i++)
      await ctx.db.insert('embeddingsCache', {
        namespace: 'test',
        textHash: new Uint8Array(32).buffer,
        embedding: [i, 1],
      });
  });
  const { scanId } = await t.mutation(mutationRef('storagePolicy/refresh'), { adminToken });
  await t.mutation(mutationRef('storagePolicy/scanPage'), { scanId, revision: 1 });
  await t.mutation(mutationRef('storagePolicy/scanPage'), { scanId, revision: 1 });
  await drain(t);
  const status = await t.query(queryRef('storagePolicy/status'), { adminToken });
  expect(status.usage.scanState).toBe('COMPLETE');
  const records = await t.run((ctx) => ctx.db.query('embeddingsCache').collect());
  expect(status.usage.groups.find((g: any) => g.category === 'cache')).toMatchObject({
    records: 121,
    bytes: records.reduce((n, r) => n + estimateRecordBytes(r), 0),
  });
  expect(estimateRecordBytes({ data: new ArrayBuffer(2048) })).toBe(2061);
});

test('cleanup retains canonical memories, active and unacknowledged messages, and referenced inputs', async () => {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const embeddingId = await ctx.db.insert('memoryEmbeddings', {
      playerId: 'p:0',
      embedding: [1, 1],
    });
    const memoryId = await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:0',
      description: 'important fact',
      importance: 10,
      lastAccess: Date.now(),
      embeddingId,
      data: { type: 'reflection', relatedMemoryIds: [] },
    });
    const engineId = await ctx.db.insert('engines', { running: false, generationNumber: 1 });
    const completed = await ctx.db.insert('inputs', {
      engineId,
      number: 1,
      name: 'test',
      args: {},
      received: Date.now(),
      returnValue: { kind: 'ok', value: null },
    });
    const referenced = await ctx.db.insert('inputs', {
      engineId,
      number: 2,
      name: 'test',
      args: {},
      received: Date.now(),
      returnValue: { kind: 'ok', value: null },
    });
    const pending = await ctx.db.insert('inputs', {
      engineId,
      number: 3,
      name: 'test',
      args: {},
      received: Date.now(),
    });
    const actionInput = await ctx.db.insert('inputs', {
      engineId,
      number: 4,
      name: 'test',
      args: {},
      received: Date.now(),
      returnValue: { kind: 'ok', value: null },
    });
    const receiptInput = await ctx.db.insert('inputs', {
      engineId,
      number: 5,
      name: 'test',
      args: {},
      received: Date.now(),
      returnValue: { kind: 'ok', value: null },
    });
    const action = {
      visitId: 'done',
      turnId: 'turn',
      basedOnEventId: 'observation',
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      action: { type: 'move' },
      state: 'COMMITTED',
      createdAt: Date.now(),
      result: { accepted: true },
      receiptPayload: { eventId: 'receipt' },
    };
    const committedAction = await ctx.db.insert('federationPendingActions', {
      ...action,
      actionId: 'archived-action',
      inputId: actionInput,
      receiptPending: false,
    });
    const pendingReceipt = await ctx.db.insert('federationPendingActions', {
      ...action,
      actionId: 'pending-receipt',
      inputId: receiptInput,
      receiptPending: true,
    });
    await ctx.db.insert('federationPresenceJobs', {
      visitId: 'active',
      kind: 'create',
      inputId: referenced,
      state: 'PENDING',
      createdAt: Date.now(),
    });
    for (const [visitId, state] of [
      ['done', 'COMPLETED'],
      ['active', 'ACTIVE'],
    ])
      await ctx.db.insert('visitLedger', {
        visitId,
        state,
        agentGlobalId: 'home/a',
        homeTownId: 'home',
        hostTownId: 'host',
        homeDeploymentEpoch: 1,
        hostDeploymentEpoch: 1,
        agentAuthorityEpoch: 1,
        visitLeaseVersion: 1,
        leaseExpiry: Date.now(),
        fencingToken: 'token',
        role: 'home',
        profile: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    const envelope = {
      visitId: 'done',
      expiresAt: Date.now(),
      type: 'ACTION_RESULT',
      payload: { eventId: 'fact' },
    };
    const acked = await ctx.db.insert('federationOutbox', {
      messageId: 'acked',
      toTownId: 'host',
      envelope,
      attempts: 1,
      nextRetryAt: Date.now(),
      ackedAt: Date.now(),
    });
    const unacked = await ctx.db.insert('federationOutbox', {
      messageId: 'unacked',
      toTownId: 'host',
      envelope,
      attempts: 1,
      nextRetryAt: Date.now(),
    });
    const failed = await ctx.db.insert('federationOutbox', {
      messageId: 'failed',
      toTownId: 'host',
      envelope,
      attempts: 1,
      nextRetryAt: Date.now(),
      failedAt: Date.now(),
      lastError: 'OUTBOX_VISIT_TERMINATED',
    });
    const expired = await ctx.db.insert('federationOutbox', {
      messageId: 'expired',
      toTownId: 'host',
      envelope,
      attempts: 1,
      nextRetryAt: Date.now(),
      ackedAt: Date.now(),
      lastError: 'EXPIRED',
    });
    const active = await ctx.db.insert('federationOutbox', {
      messageId: 'active',
      toTownId: 'host',
      envelope: { ...envelope, visitId: 'active' },
      attempts: 1,
      nextRetryAt: Date.now(),
      ackedAt: Date.now(),
    });
    const inbox = await ctx.db.insert('federationInbox', {
      messageId: 'committed',
      fromTownId: 'host',
      payloadDigest: 'digest',
      envelope,
      status: 'COMMITTED',
      receivedAt: Date.now(),
      processedAt: Date.now(),
    });
    const buffered = await ctx.db.insert('federationInbox', {
      messageId: 'buffered',
      fromTownId: 'host',
      payloadDigest: 'digest',
      envelope,
      status: 'BUFFERED',
      receivedAt: Date.now(),
    });
    await ctx.db.insert('embeddingsCache', {
      namespace: 'old',
      textHash: new Uint8Array(32).buffer,
      embedding: [1, 1],
    });
    return {
      memoryId,
      completed,
      referenced,
      pending,
      actionInput,
      receiptInput,
      committedAction,
      pendingReceipt,
      acked,
      unacked,
      failed,
      expired,
      active,
      inbox,
      buffered,
    };
  });
  jest.setSystemTime(Date.now() + 8 * DAY);
  const { cleanupId } = await t.mutation(mutationRef('storagePolicy/cleanupNow'), { adminToken });
  await t.mutation(mutationRef('storagePolicy/cleanupPage'), { cleanupId, revision: 1 });
  await t.mutation(mutationRef('storagePolicy/cleanupPage'), { cleanupId, revision: 1 });
  await drain(t);
  await t.run(async (ctx) => {
    for (const id of [
      ids.memoryId,
      ids.referenced,
      ids.pending,
      ids.receiptInput,
      ids.pendingReceipt,
      ids.unacked,
      ids.expired,
      ids.active,
      ids.buffered,
    ])
      expect(await ctx.db.get(id)).not.toBeNull();
    for (const id of [
      ids.completed,
      ids.actionInput,
      ids.committedAction,
      ids.acked,
      ids.failed,
      ids.inbox,
    ])
      expect(await ctx.db.get(id)).toBeNull();
    expect((await ctx.db.query('federationActionFacts').unique())?.actionId).toBe(
      'archived-action',
    );
    expect((await ctx.db.query('federationEventFacts').unique())?.messageId).toBe('committed');
    expect(await ctx.db.query('embeddingsCache').collect()).toEqual([]);
  });
  const status = await t.query(queryRef('storagePolicy/status'), { adminToken });
  expect(status.cleanup).toMatchObject({
    state: 'COMPLETE',
    compactedActions: 1,
    compactedEvents: 1,
  });
});

test('capacity alerts pause cache writes and bound vector rebuild pages', async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert('storagePolicies', {
      key: 'local',
      ...defaultStoragePolicy,
      vectorRebuildBatchSize: 3,
      updatedAt: Date.now(),
    });
    await ctx.db.insert('storageUsageSnapshots', {
      key: 'local',
      groups: [{ category: 'cache', records: 1, bytes: defaultStoragePolicy.cacheBytes }],
      measuredAt: Date.now(),
      scanStartedAt: Date.now(),
    });
  });
  const status = await t.query(queryRef('storagePolicy/status'), { adminToken });
  expect(status.alerts[0].level).toBe('EXCEEDED');
  expect(status.nonessential.vectorRebuildPaused).toBe(true);
  expect(
    await t.query(queryRef('storagePolicy/rebuildBudget'), { requestedBatchSize: 25 }),
  ).toMatchObject({ paused: true, allowedBatchSize: 0 });
  expect(
    await t.mutation(makeFunctionReference<'mutation'>('agent/embeddingsCache:writeEmbeddings'), {
      namespace: 'test',
      embeddings: [{ textHash: new Uint8Array(32).buffer, embedding: [1, 1] }],
    }),
  ).toEqual([]);
  await t.run(async (ctx) => {
    const snapshot = (await ctx.db.query('storageUsageSnapshots').unique())!;
    await ctx.db.patch(snapshot._id, { groups: [] });
  });
  expect(
    await t.query(queryRef('storagePolicy/rebuildBudget'), { requestedBatchSize: 25 }),
  ).toMatchObject({ paused: false, allowedBatchSize: 3 });
});

test('a paused rebuild retains its space and schedules the same cursor without provider calls', async () => {
  const t = convexTest(schema, modules);
  const spaceId = await t.run(async (ctx) => {
    const profileId = await ctx.db.insert('embeddingProfiles', {
      name: 'test',
      provider: 'custom',
      url: 'https://models.example',
      model: 'test',
      dimensions: 2,
      preprocessingRevision: 'newline-to-space-v1',
      queryPrefix: '',
      documentPrefix: '',
      normalization: 'none',
      fingerprint: 'test',
      createdAt: Date.now(),
    });
    const spaceId = await ctx.db.insert('embeddingSpaces', {
      profileId,
      fingerprint: 'test',
      status: 'BUILDING',
      createdAt: Date.now(),
    });
    await ctx.db.insert('storageUsageSnapshots', {
      key: 'local',
      groups: [{ category: 'vectors', records: 1, bytes: defaultStoragePolicy.vectorBytes }],
      measuredAt: Date.now(),
      scanStartedAt: Date.now(),
    });
    return spaceId;
  });
  const previousFetch = globalThis.fetch;
  const fetch = jest.fn<typeof globalThis.fetch>();
  globalThis.fetch = fetch;
  try {
    await t.action(makeFunctionReference<'action'>('models/embeddings:rebuildPage'), {
      spaceId,
      cursor: 'preserved-cursor',
    });
    expect(fetch).not.toHaveBeenCalled();
    await t.run(async (ctx) => {
      expect((await ctx.db.get(spaceId))?.status).toBe('BUILDING');
      const scheduled = (await ctx.db.system.query('_scheduled_functions').collect())[0];
      expect(scheduled.args).toEqual([{ spaceId, cursor: 'preserved-cursor' }]);
      expect(scheduled.scheduledTime).toBe(Date.now() + 60000);
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('archive maintenance locks block policy, cleanup and cache mutations while status stays readable', async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const jobId = await ctx.db.insert('backupLargeJobs', {
      kind: 'export',
      state: 'RUNNING',
      phase: 'READ',
      tableIndex: 0,
      cursor: null,
      chunkCount: 0,
      processedChunks: 0,
      recordCount: 0,
      bytes: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: {},
    });
    await ctx.db.insert('backupMaintenanceLocks', { key: 'town', jobId, createdAt: Date.now() });
  });
  for (const name of ['refresh', 'cleanupNow'])
    await expect(t.mutation(mutationRef(`storagePolicy/${name}`), { adminToken })).rejects.toThrow(
      'TOWN_BACKUP_MAINTENANCE_LOCKED',
    );
  await expect(
    t.mutation(mutationRef('storagePolicy/configure'), { adminToken, ...defaultStoragePolicy }),
  ).rejects.toThrow('TOWN_BACKUP_MAINTENANCE_LOCKED');
  await expect(
    t.mutation(makeFunctionReference<'mutation'>('agent/embeddingsCache:writeEmbeddings'), {
      namespace: 'test',
      embeddings: [],
    }),
  ).rejects.toThrow('TOWN_BACKUP_MAINTENANCE_LOCKED');
  expect((await t.query(queryRef('storagePolicy/status'), { adminToken })).usage.scanState).toBe(
    'NOT_MEASURED',
  );
});

test('usage accounts for managed archive payloads and resumable journals', async () => {
  const t = convexTest(schema, modules);
  const storageId = await t.action((ctx) => ctx.storage.store(new Blob(['verified chunk'])));
  await t.run(async (ctx) => {
    const jobId = await ctx.db.insert('backupLargeJobs', {
      kind: 'export',
      state: 'COMPLETE',
      phase: 'COMPLETE',
      tableIndex: 0,
      cursor: null,
      chunkCount: 1,
      processedChunks: 1,
      recordCount: 1,
      bytes: 4096,
      createdAt: 1,
      updatedAt: 1,
      source: {},
    });
    await ctx.db.insert('backupLargeChunks', {
      jobId,
      index: 0,
      table: 'memories',
      count: 1,
      bytes: 4096,
      digest: 'test-digest',
      storageId,
    });
    await ctx.db.insert('backupLargeRows', {
      jobId,
      role: 'SOURCE',
      table: 'memories',
      sourceId: 'old-memory',
      chunkIndex: 0,
      rowIndex: 0,
      state: 'APPLIED',
      references: [],
      metadata: {},
    });
  });
  await t.mutation(mutationRef('storagePolicy/refresh'), { adminToken });
  await drain(t);
  const status = await t.query(queryRef('storagePolicy/status'), { adminToken });
  const chunks = await t.run((ctx) => ctx.db.query('backupLargeChunks').collect());
  expect(status.usage.groups.find((g: any) => g.category === 'history').bytes).toBe(
    new TextEncoder().encode('verified chunk').length + estimateRecordBytes(chunks[0]),
  );
  expect(status.usage.objects).toMatchObject({
    objects: 1,
    bytes: new TextEncoder().encode('verified chunk').length,
  });
  expect(status.usage.groups.find((g: any) => g.category === 'operational').records).toBe(2);
});

test('storage scans include published v1/v2 cold payloads once and retain staged and orphan object bytes', async () => {
  const t = convexTest(schema, modules);
  const objects = await t.action(async (ctx) => {
    const ids = [];
    for (const bytes of [4096, 8192, 16384, 2048])
      ids.push(await ctx.storage.store(new Blob([new Uint8Array(bytes)])));
    return ids;
  });
  const ids = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const memoryId = await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:0',
      description: 'retained canonical original',
      importance: 10,
      lastAccess: 1,
      data: { type: 'reflection', relatedMemoryIds: [] },
    });
    const fields = {
      worldId,
      kind: 'conversation' as const,
      signature: 'persisted-proof',
      publicKey: 'persisted-key',
      createdAt: 1,
    };
    const v1 = await ctx.db.insert('coldHistoryArchives', {
      ...fields,
      sourceKey: 'v1',
      sourceId: 'v1',
      state: 'VERIFIED',
      manifest: { version: 1, bytes: 1 },
      storageId: objects[0],
    });
    await ctx.db.insert('coldHistoryArchives', {
      ...fields,
      sourceKey: 'shared-v1',
      sourceId: 'shared-v1',
      state: 'VERIFIED',
      manifest: { version: 1, bytes: 1 },
      storageId: objects[0],
    });
    const v2 = await ctx.db.insert('coldHistoryArchives', {
      ...fields,
      sourceKey: 'v2',
      sourceId: 'v2',
      state: 'VERIFIED',
      manifest: { version: 2, chunkCount: 2, bytes: 2 },
    });
    const pending = await ctx.db.insert('coldHistoryArchives', {
      ...fields,
      sourceKey: 'pending',
      sourceId: 'pending',
      state: 'PENDING',
      manifest: { version: 2, chunkCount: 1, bytes: 1 },
    });
    const chunk = {
      index: 0,
      start: 0,
      count: 1,
      bytes: 1,
      digest: 'persisted-digest',
      previousDigest: '',
      chainDigest: 'persisted-chain',
      signature: 'persisted-proof',
      storageId: objects[1],
    };
    await ctx.db.insert('coldHistoryChunks', { ...chunk, archiveId: v2 });
    await ctx.db.insert('coldHistoryChunks', { ...chunk, archiveId: v2, index: 1, start: 1 });
    await ctx.db.insert('coldHistoryChunks', {
      ...chunk,
      archiveId: pending,
      storageId: objects[2],
    });
    return { memoryId, v1, v2, pending };
  });
  await t.mutation(mutationRef('storagePolicy/configure'), {
    adminToken,
    ...defaultStoragePolicy,
    historyBytes: 20000,
  });
  await drain(t);
  const status = await t.query(queryRef('storagePolicy/status'), { adminToken });
  expect(status.usage.objects).toEqual({
    objects: 4,
    bytes: 30720,
    publishedColdObjects: 2,
    publishedColdBytes: 12288,
    otherOrUnpublishedObjects: 2,
    otherOrUnpublishedBytes: 18432,
    classificationLimitedObjects: 2,
  });
  const history = status.usage.groups.find((g: any) => g.category === 'history');
  expect(history.payloadBytes).toBe(30720);
  expect(history.bytes).toBe(history.metadataBytes + history.payloadBytes);
  expect(status.alerts.find((a: any) => a.category === 'history').level).toBe('EXCEEDED');
  expect(status.nonessential).toEqual({ cacheWritesPaused: true, vectorRebuildPaused: true });
  expect(
    await t.query(queryRef('storagePolicy/rebuildBudget'), { requestedBatchSize: 3 }),
  ).toMatchObject({ paused: true, allowedBatchSize: 0 });
  await t.mutation(mutationRef('storagePolicy/cleanupNow'), { adminToken });
  await drain(t);
  for (const id of Object.values(ids)) expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
  for (const id of objects) expect(await t.run((ctx) => ctx.db.system.get(id))).not.toBeNull();
  expect(JSON.stringify(status)).not.toContain('retained canonical original');
  expect(JSON.stringify(status)).not.toContain(objects[0]);
});

test('physical object pagination deduplicates shared references and captures a cutoff for concurrent uploads and deletes', async () => {
  const t = convexTest(schema, modules);
  const objects = await t.action(async (ctx) => {
    const ids = [];
    for (let index = 0; index < 121; index++)
      ids.push(await ctx.storage.store(new Blob(['1234567890'])));
    return ids;
  });
  const { scanId } = await t.mutation(mutationRef('storagePolicy/refresh'), { adminToken });
  const cutoff = await t.run(
    async (ctx) => (await ctx.db.get(scanId as Id<'storageUsageScans'>))!.storageCreationCutoff!,
  );
  // This later upload is outside the capture boundary, even with a fixed clock.
  const later = await t.action((ctx) => ctx.storage.store(new Blob(['later-upload'])));
  expect((await t.run((ctx) => ctx.db.system.get(later)))!._creationTime).toBeGreaterThan(cutoff);
  await t.action((ctx) => ctx.storage.delete(objects[120]));
  await drain(t);
  const first = await t.query(queryRef('storagePolicy/status'), { adminToken });
  expect(first.usage.objects).toMatchObject({
    objects: 120,
    bytes: 1200,
    otherOrUnpublishedObjects: 120,
  });
  expect(first.usage.consistency).toBe('paged-estimate-with-storage-creation-cutoff');
  expect(first.usage.storageCreationCutoff).toBe(cutoff);
  expect(first.usage.groups.find((g: any) => g.category === 'history')).toMatchObject({
    metadataBytes: 0,
    payloadBytes: 1200,
    bytes: 1200,
  });
  await t.mutation(mutationRef('storagePolicy/refresh'), { adminToken });
  await drain(t);
  const next = await t.query(queryRef('storagePolicy/status'), { adminToken });
  expect(next.usage.objects).toMatchObject({
    objects: 121,
    bytes: 1200 + new TextEncoder().encode('later-upload').length,
  });
});

test('bounded cold reference classification never drops bytes when shared references exceed its sample', async () => {
  const t = convexTest(schema, modules);
  const storageId = await t.action((ctx) => ctx.storage.store(new Blob(['shared-payload'])));
  await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    for (let index = 0; index < 51; index++)
      await ctx.db.insert('coldHistoryArchives', {
        worldId,
        sourceKey: `shared-${index}`,
        sourceId: `shared-${index}`,
        kind: 'conversation',
        state: index === 50 ? 'VERIFIED' : 'PENDING',
        manifest: { version: 1 },
        signature: 'persisted-proof',
        publicKey: 'persisted-key',
        storageId,
        createdAt: 1,
      });
  });
  await t.mutation(mutationRef('storagePolicy/refresh'), { adminToken });
  await drain(t);
  const status = await t.query(queryRef('storagePolicy/status'), { adminToken });
  expect(status.usage.objects).toMatchObject({
    objects: 1,
    bytes: new TextEncoder().encode('shared-payload').length,
    classificationLimitedObjects: 1,
  });
  expect(status.usage.groups.find((g: any) => g.category === 'history').payloadBytes).toBe(
    new TextEncoder().encode('shared-payload').length,
  );
});

test('a whole object page shares eight classification reads even with large parents and many reused references', async () => {
  const t = convexTest(schema, modules);
  const files = await t.action(async (ctx) => {
    const ids = [];
    for (let index = 0; index < 50; index++)
      ids.push(await ctx.storage.store(new Blob(['physical-bytes'])));
    return ids;
  });
  await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const archiveId = await ctx.db.insert('coldHistoryArchives', {
      worldId,
      sourceKey: 'large-parent',
      sourceId: 'large-parent',
      kind: 'conversation',
      state: 'VERIFIED',
      manifest: { version: 2, chunkCount: 100, padding: 'x'.repeat(700000) },
      signature: 'persisted-proof',
      publicKey: 'persisted-key',
      createdAt: 1,
    });
    for (let index = 0; index < 100; index++)
      await ctx.db.insert('coldHistoryChunks', {
        archiveId,
        index,
        start: index,
        count: 1,
        bytes: 1,
        digest: 'persisted-digest',
        previousDigest: '',
        chainDigest: 'persisted-chain',
        signature: 'persisted-proof',
        storageId: files[index % files.length],
      });
  });
  const result = await t.run(async (ctx) => {
    let references = 0,
      parents = 0;
    const observed = {
      ...ctx,
      db: {
        query: (table: 'coldHistoryArchives' | 'coldHistoryChunks') => {
          references++;
          return ctx.db.query(table);
        },
        get: (id: Id<'coldHistoryArchives'>) => {
          parents++;
          return ctx.db.get(id);
        },
      },
    } as unknown as MutationCtx;
    const metadata = [];
    for (const id of files) metadata.push((await ctx.db.system.get(id))!);
    const summary = await summarizeStoredObjects(observed, metadata);
    return { summary, references, parents };
  });
  expect(result.references + result.parents).toBe(8);
  expect(result.parents).toBe(2);
  expect(result.summary).toMatchObject({
    objects: 50,
    bytes: 50 * new TextEncoder().encode('physical-bytes').length,
    publishedColdObjects: 2,
    classificationLimitedObjects: 48,
  });
});

test('usage includes new model receipts, public budgets and disclosure audit records', async () => {
  const t = convexTest(schema, modules);
  const rows = await t.run(async (ctx) => {
    const budget = await ctx.db.insert('federationPublicRateLimits', {
      key: 'synthetic-ip',
      windowStart: 1,
      count: 2,
      expiresAt: 60001,
    });
    const receipt = await ctx.db.insert('modelCallReceipts', {
      kind: 'CHAT',
      profileId: 'synthetic-profile',
      providerKey: 'synthetic-provider',
      day: 1,
      startedAt: 1,
      finishedAt: 2,
      outcome: 'SUCCESS',
    });
    const policy = await ctx.db.insert('federationDisclosurePolicy', {
      agentGlobalId: 'synthetic/agent:a:0',
      level: 'WHITELIST',
      allowedTownIds: [],
      updatedAt: 1,
    });
    const audit = await ctx.db.insert('federationDisclosureAudit', {
      agentGlobalId: 'synthetic/agent:a:0',
      previous: { level: 'PUBLIC', allowedTownIds: [] },
      next: { level: 'WHITELIST', allowedTownIds: [] },
      operator: 'synthetic-admin',
      reason: 'synthetic test',
      createdAt: 1,
    });
    return {
      operational: await Promise.all([budget, receipt, policy].map((id) => ctx.db.get(id))),
      history: await ctx.db.get(audit),
    };
  });
  await t.mutation(mutationRef('storagePolicy/refresh'), { adminToken });
  await drain(t);
  const status = await t.query(queryRef('storagePolicy/status'), { adminToken });
  const operational = status.usage.groups.find((g: any) => g.category === 'operational');
  const history = status.usage.groups.find((g: any) => g.category === 'history');
  expect(operational.records).toBe(3);
  expect(operational.metadataBytes).toBe(
    rows.operational.reduce((sum, row) => sum + estimateRecordBytes(row), 0),
  );
  expect(history.records).toBe(1);
  expect(history.metadataBytes).toBe(estimateRecordBytes(rows.history));
});
