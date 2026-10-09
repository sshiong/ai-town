import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { defaultStoragePolicy, estimateRecordBytes } from './storagePolicy';
import { mutationRef, queryRef } from './refs';

const modules = {
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
    for (const id of [ids.completed, ids.actionInput, ids.committedAction, ids.acked, ids.inbox])
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
    4096 + estimateRecordBytes(chunks[0]),
  );
  expect(status.usage.groups.find((g: any) => g.category === 'operational').records).toBe(2);
});
