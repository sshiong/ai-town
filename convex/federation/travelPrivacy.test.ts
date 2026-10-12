import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { mutationRef, queryRef } from './refs';
import { persistConfirmedEvent } from '../agent/travelMemory';
import { receiveConversationEnded } from '../agent/travelTranscript';
import { privacyCacheRevisionKey } from './travelPrivacyGuard';
import { assertArchiveCanStart } from './maintenanceLock';
import { decodeRow, encodeRow } from './backupHelpers';
import { withEmbeddingRevision } from '../models/embeddingDataRevision';
import type { Id } from '../_generated/dataModel';

const modules = {
  '../federation/backupLarge.ts': () => import('./backupLarge'),
  '../federation/backup.ts': () => import('./backup'),
  '../federation/travelPrivacy.ts': () => import('./travelPrivacy'),
  '../federation/travelPrivacyArchives.ts': () => import('./travelPrivacyArchives'),
  '../agent/embeddingsCache.ts': () => import('../agent/embeddingsCache'),
  '../_generated/server.ts': () => import('../_generated/server'),
};
const adminToken = 'privacy-test-administrator-token';
beforeEach(() => {
  jest.useFakeTimers();
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
});

test.each(['INSPECTING', 'RUNNING'] as const)('archive admission cannot strand a %s privacy worker', async state => {
  const t = convexTest(schema, modules);
  await fixture(t);
  const inspectionJobId = await t.mutation(mutationRef('travelPrivacy/inspect'), { adminToken, visitId: 'selected', scope: 'CACHE' });
  if (state === 'RUNNING') {
    await drain(t);
    await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId: inspectionJobId });
  }
  await expect(t.mutation(mutationRef('backupLarge/startExport'), { adminToken }))
    .rejects.toThrow('TOWN_TRAVEL_PRIVACY_BUSY');
  await expect(t.query(queryRef('backup/getTown'), { adminToken }))
    .rejects.toThrow('TOWN_TRAVEL_PRIVACY_BUSY');
  expect(await t.run(ctx => ctx.db.query('backupMaintenanceLocks').collect())).toEqual([]);
  await drain(t);
  expect((await t.query(queryRef('travelPrivacy/status'), { adminToken, jobId: inspectionJobId }))!.state)
    .toBe(state === 'INSPECTING' ? 'READY' : 'COMPLETE');
  await expect(t.run(ctx => assertArchiveCanStart(ctx))).resolves.toBeNull();
});

test('an archive lock rejects new privacy inspections, starts and retries', async () => {
  const t = convexTest(schema, modules);
  await fixture(t);
  const inspectionJobId = await t.mutation(mutationRef('travelPrivacy/inspect'), { adminToken, visitId: 'selected', scope: 'CACHE' });
  await drain(t);
  await t.run(async ctx => {
    const jobId = await ctx.db.insert('backupLargeJobs', { kind: 'export', state: 'RUNNING', phase: 'EXPORTING',
      tableIndex: 0, cursor: null, chunkCount: 0, processedChunks: 0, recordCount: 0, bytes: 0,
      createdAt: 1, updatedAt: 1, source: {} });
    await ctx.db.insert('backupMaintenanceLocks', { key: 'town', jobId, createdAt: 1 });
  });
  await expect(t.mutation(mutationRef('travelPrivacy/inspect'), { adminToken, visitId: 'selected', scope: 'CACHE' }))
    .rejects.toThrow('TOWN_BACKUP_MAINTENANCE_LOCKED');
  await expect(t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId: inspectionJobId }))
    .rejects.toThrow('TOWN_BACKUP_MAINTENANCE_LOCKED');
  await expect(t.mutation(mutationRef('travelPrivacy/retry'), { adminToken, jobId: inspectionJobId }))
    .rejects.toThrow('TOWN_BACKUP_MAINTENANCE_LOCKED');
  expect(await t.run(ctx => ctx.db.query('travelPrivacyJobs').collect())).toHaveLength(1);
});
afterEach(() => jest.useRealTimers());
const drain = (t: ReturnType<typeof convexTest<typeof schema.tables>>) =>
  t.finishAllScheduledFunctions(() => jest.runAllTimers());
async function fixture(t: ReturnType<typeof convexTest<typeof schema.tables>>, role = 'home') {
  return t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const ledgerId = await ctx.db.insert('visitLedger', {
      visitId: 'selected',
      agentGlobalId: 'resident-global',
      homeTownId: 'home',
      hostTownId: 'host',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      leaseExpiry: Date.now() - 120000,
      fencingToken: 'safety-fence',
      state: 'COMPLETED',
      role,
      worldId,
      homePlayerId: 'p:0',
      hostPlayerId: 'p:1',
      profile: {},
      cleanupConfirmed: true,
      createdAt: Date.now() - 300000,
      updatedAt: Date.now() - 120000,
    });
    const travel = async (visitId: string, text: string) =>
      ctx.db.insert('memories', {
        worldId,
        playerId: 'p:0',
        agentGlobalId: 'resident-global',
        description: text,
        importance: 5,
        lastAccess: Date.now(),
        data: {
          type: 'travel',
          visitId,
          eventId: text,
          hostTownId: 'host',
          messageText: text,
          participants: [],
          occurredAt: Date.now() - 200000,
        },
      });
    const memoryIds: Id<'memories'>[] = [];
    for (let i = 0; i < 13; i++) memoryIds.push(await travel('selected', `selected-private-${i}`));
    const otherId = await travel('other', 'other-private-message');
    const summaryId = await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'resident-global',
      description: 'private first reflection',
      importance: 5,
      lastAccess: Date.now(),
      data: { type: 'reflection', relatedMemoryIds: memoryIds },
    });
    const childId = await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'resident-global',
      description: 'private derived reflection',
      importance: 5,
      lastAccess: Date.now(),
      data: { type: 'reflection', relatedMemoryIds: [summaryId] },
    });
    const transcriptId = await ctx.db.insert('homeTravelTranscripts', {
      transcriptId: 'transcript-selected',
      agentGlobalId: 'resident-global',
      worldId,
      playerId: 'p:0',
      visitId: 'selected',
      hostTownId: 'host',
      federationConversationId: 'federation-conversation',
      endedAt: Date.now() - 150000,
      participants: [],
      state: 'COMPLETE',
      summaryState: 'DONE',
      receivedPageCount: 1,
      highestPageNumber: 0,
      totalMessageCount: 1,
    });
    await ctx.db.insert('homeTravelTranscriptPages', {
      transcriptId: 'transcript-selected',
      agentGlobalId: 'resident-global',
      pageNumber: 0,
      eventId: 'event-transcript',
      finalPage: true,
      messages: [
        {
          messageId: 'message-body',
          text: 'transcript-secret',
          author: 'visitor',
          occurredAt: Date.now() - 200000,
        },
      ],
      memoryIds: [memoryIds[0]],
    });
    const inboxId = await ctx.db.insert('federationInbox', {
      messageId: 'message-selected',
      fromTownId: 'host',
      payloadDigest: 'original-digest',
      envelope: {
        visitId: 'selected',
        type: 'OBSERVATION',
        payload: { eventId: 'obs', text: 'network-secret' },
      },
      status: 'COMMITTED',
      receivedAt: Date.now() - 200000,
      processedAt: Date.now() - 190000,
      ack: { status: 'COMMITTED' },
    });
    const factsId = await ctx.db.insert('federationEventFacts', {
      messageId: 'fact-selected',
      visitId: 'selected',
      fromTownId: 'host',
      type: 'OBSERVATION',
      payload: { text: 'fact-secret', eventId: 'fact-event' },
      receivedAt: Date.now() - 200000,
    });
    const otherFact = await ctx.db.insert('federationEventFacts', {
      messageId: 'fact-other',
      visitId: 'other',
      fromTownId: 'host',
      type: 'OBSERVATION',
      payload: { text: 'other-fact-secret' },
      receivedAt: Date.now() - 200000,
    });
    const embeddingId = await ctx.db.insert('memoryEmbeddings', {
      playerId: 'p:0',
      embedding: [1],
    });
    await ctx.db.patch(memoryIds[0], { embeddingId });
    const storageId = await ctx.storage.store(new Blob(['cold-sensitive-body']));
    const archiveId = await ctx.db.insert('coldHistoryArchives', {
      sourceKey: 'selected-source',
      worldId,
      kind: 'travel',
      sourceId: 'transcript-selected',
      ownerGlobalId: 'resident-global',
      state: 'VERIFIED',
      manifest: { version: 1 },
      signature: 'signature',
      publicKey: 'public',
      storageId,
      createdAt: Date.now(),
    });
    return {
      worldId,
      ledgerId,
      memoryIds,
      otherId,
      summaryId,
      childId,
      transcriptId,
      inboxId,
      factsId,
      otherFact,
      embeddingId,
      storageId,
      archiveId,
    };
  });
}
async function preview(
  t: ReturnType<typeof convexTest<typeof schema.tables>>,
  scope: 'CACHE' | 'SENSITIVE' = 'SENSITIVE',
) {
  const jobId: Id<'travelPrivacyJobs'> = await t.mutation(mutationRef('travelPrivacy/inspect'), {
    adminToken,
    visitId: 'selected',
    scope,
  });
  await drain(t);
  return { jobId, report: await t.query(queryRef('travelPrivacy/status'), { adminToken, jobId }) };
}
test.each(['failed-page', 'committed-page'] as const)('retry preserves the %s checkpoint and fences older scheduled work', async mode => {
  const t = convexTest(schema, modules), ids = await fixture(t);
  if (mode === 'failed-page') await t.run(async ctx => {
    const { _id, _creationTime, ...inbox } = (await ctx.db.get(ids.inboxId))!;
    await ctx.db.insert('federationInbox', { ...inbox, messageId: 'second-page-message',
      envelope: { ...inbox.envelope, messageId: 'second-page-message' } });
  });
  const { jobId, report } = await preview(t);
  expect(report.state).toBe('READY');
  await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  const started = (await t.run(ctx => ctx.db.get(jobId)))!;
  if (mode === 'failed-page') {
    const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    const digest = jest.spyOn(globalThis.crypto.subtle, 'digest')
      .mockImplementationOnce(originalDigest)
      .mockRejectedValueOnce(new Error('TEST_TRANSIENT_DIGEST_FAILURE'));
    try {
      await expect(t.mutation(mutationRef('travelPrivacy/page'), { jobId, revision: started.revision }))
        .rejects.toThrow('TEST_TRANSIENT_DIGEST_FAILURE');
    } finally { digest.mockRestore(); }
    expect(await t.run(ctx => ctx.db.get(jobId))).toEqual(started);
    expect((await t.run(ctx => ctx.db.get(ids.inboxId)))!.envelope.payload.text).toBe('network-secret');
  } else {
    await t.mutation(mutationRef('travelPrivacy/page'), { jobId, revision: started.revision });
  }
  const checkpoint = (await t.run(ctx => ctx.db.get(jobId)))!;
  const graves = await t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect());
  const generation = await t.run(ctx => ctx.db.query('embeddingDataRevisions')
    .withIndex('key', q => q.eq('key', privacyCacheRevisionKey)).unique());
  await t.mutation(mutationRef('travelPrivacy/retry'), { adminToken, jobId });
  await t.mutation(mutationRef('travelPrivacy/retry'), { adminToken, jobId });
  const retried = (await t.run(ctx => ctx.db.get(jobId)))!;
  expect(retried).toMatchObject({ revision: checkpoint.revision + 2, phase: checkpoint.phase,
    tableIndex: checkpoint.tableIndex, cursor: checkpoint.cursor, memoryIds: checkpoint.memoryIds,
    processedRows: checkpoint.processedRows, counts: checkpoint.counts });
  expect(await t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toEqual(graves);
  expect(await t.run(ctx => ctx.db.query('embeddingDataRevisions')
    .withIndex('key', q => q.eq('key', privacyCacheRevisionKey)).unique())).toEqual(generation);
  await t.mutation(mutationRef('travelPrivacy/page'), { jobId, revision: checkpoint.revision });
  expect(await t.run(ctx => ctx.db.get(jobId))).toEqual(retried);
  await drain(t);
  const complete = (await t.run(ctx => ctx.db.get(jobId)))!;
  expect(complete.state).toBe('COMPLETE');
  expect(complete.counts.federationInbox).toBe(mode === 'failed-page' ? 2 : 1);
  expect(await t.run(ctx => ctx.db.get(ids.memoryIds[0]))).toBeNull();
  expect(await t.run(ctx => ctx.db.get(ids.otherId))).not.toBeNull();
  await t.mutation(mutationRef('travelPrivacy/retry'), { adminToken, jobId });
  expect(await t.run(ctx => ctx.db.get(jobId))).toEqual(complete);
});
test('retry inspection cannot bypass a new visit authority or an unconfirmed preview', async () => {
  const t = convexTest(schema, modules), ids = await fixture(t);
  const jobId: Id<'travelPrivacyJobs'> = await t.mutation(mutationRef('travelPrivacy/inspect'), { adminToken, visitId: 'selected', scope: 'SENSITIVE' });
  await expect(t.mutation(mutationRef('travelPrivacy/retry'), { adminToken: 'invalid', jobId }))
    .rejects.toThrow('ADMIN_UNAUTHORIZED');
  const ledger = (await t.run(ctx => ctx.db.get(ids.ledgerId)))!;
  await t.run(ctx => ctx.db.patch(ids.ledgerId, { state: 'ACTIVE', leaseExpiry: Date.now() + 60000 }));
  await expect(t.mutation(mutationRef('travelPrivacy/retry'), { adminToken, jobId }))
    .rejects.toThrow('TRAVEL_PRIVACY_VISIT_NOT_SAFE_TERMINAL');
  await t.run(ctx => ctx.db.patch(ids.ledgerId, { state: ledger.state, leaseExpiry: ledger.leaseExpiry,
    agentGlobalId: 'another-resident' }));
  await expect(t.mutation(mutationRef('travelPrivacy/retry'), { adminToken, jobId }))
    .rejects.toThrow('TRAVEL_PRIVACY_PREVIEW_STALE');
  await t.run(ctx => ctx.db.patch(ids.ledgerId, { agentGlobalId: ledger.agentGlobalId }));
  await t.mutation(mutationRef('travelPrivacy/retry'), { adminToken, jobId });
  await drain(t);
  expect((await t.run(ctx => ctx.db.get(jobId)))!.state).toBe('READY');
  await expect(t.mutation(mutationRef('travelPrivacy/retry'), { adminToken, jobId }))
    .rejects.toThrow('TRAVEL_PRIVACY_JOB_NOT_RETRYABLE');
  expect(await t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toEqual([]);
  expect(await t.run(ctx => ctx.db.get(ids.memoryIds[0]))).not.toBeNull();
});
test.each(['active-source', 'unexpired-source', 'nonfinite-source', 'resident-away', 'wrong-owner', 'current-ledger'] as const)(
  'ordinary historical evidence rejects %s before creating a clear job', async mode => {
    const t = convexTest(schema, modules), ids = await fixture(t);
    const history = await t.run(async ctx => {
      const { _id, _creationTime, ...ledger } = (await ctx.db.get(ids.ledgerId))!;
      if (mode !== 'current-ledger') await ctx.db.delete(ids.ledgerId);
      const chatProfileId = await ctx.db.insert('chatProfiles', { name: 'local-test', provider: 'ollama',
        url: 'http://localhost:11434', model: 'test-model', stopWords: [], createdAt: 1 });
      await ctx.db.insert('residentModelBindings', { worldId: ids.worldId, playerId: 'p:0',
        agentGlobalId: 'resident-global', chatProfileId, createdAt: 1, updatedAt: 1 });
      await ctx.db.insert('federationAgentRuntimes', { worldId: ids.worldId, playerId: 'p:0', agentId: 'a:0',
        agentGlobalId: 'resident-global', homeTownId: 'home', state: mode === 'resident-away' ? 'HOME_FROZEN' : 'HOME_ACTIVE',
        agentAuthorityEpoch: 1, updatedAt: 1 });
      if (mode === 'active-source') ledger.state = 'ACTIVE';
      if (mode === 'unexpired-source') ledger.leaseExpiry = Date.now() + 60000;
      if (mode === 'nonfinite-source') ledger.leaseExpiry = NaN;
      const importId = await ctx.db.insert('backupImports', { sourceTownId: 'source', mode: 'clone',
        exportedAt: 1, importedAt: 2, mapping: {}, manifest: {},
        runtimeSnapshot: { visitLedger: [encodeRow(ledger)] } });
      return { importId, worldId: ids.worldId, ownerGlobalId: mode === 'wrong-owner' ? 'other-owner' : 'resident-global' };
    });
    const error = mode === 'current-ledger' ? 'TRAVEL_PRIVACY_HISTORY_HAS_CURRENT_LEDGER'
      : mode === 'resident-away' ? 'TRAVEL_PRIVACY_HISTORY_RESIDENT_NOT_HOME' : 'TRAVEL_PRIVACY_VISIT_NOT_SAFE_TERMINAL';
    await expect(t.mutation(mutationRef('travelPrivacy/inspect'), { adminToken, visitId: 'selected', scope: 'SENSITIVE', history }))
      .rejects.toThrow(error);
    expect(await t.run(ctx => ctx.db.query('travelPrivacyJobs').collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.get(ids.memoryIds[0]))).not.toBeNull();
  });
test('paged sensitive clearing removes exclusive original and derived copies but preserves ledger and replay evidence', async () => {
  const t = convexTest(schema, modules),
    ids = await fixture(t);
  const { jobId, report } = await preview(t);
  expect(report.state).toBe('READY');
  expect(report.counts.memories).toBe(15);
  expect(report.counts.coldArchives).toBe(1);
  await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await drain(t);
  expect((await t.query(queryRef('travelPrivacy/status'), { adminToken, jobId })).state).toBe(
    'COMPLETE',
  );
  await t.run(async (ctx) => {
    expect(await ctx.db.get(ids.ledgerId)).toMatchObject({
      state: 'COMPLETED',
      fencingToken: 'safety-fence',
    });
    expect(await ctx.db.get(ids.inboxId)).toMatchObject({
      payloadDigest: 'original-digest',
      ack: { status: 'COMMITTED' },
      envelope: { payload: { privacyRedacted: true, eventId: 'obs' } },
    });
    expect(JSON.stringify(await ctx.db.get(ids.factsId))).not.toContain('fact-secret');
    expect(await ctx.db.get(ids.otherFact)).toMatchObject({
      payload: { text: 'other-fact-secret' },
    });
    expect(await ctx.db.get(ids.otherId)).toMatchObject({ description: 'other-private-message' });
    for (const id of [
      ...ids.memoryIds,
      ids.summaryId,
      ids.childId,
      ids.transcriptId,
      ids.embeddingId,
      ids.archiveId,
    ])
      expect(await ctx.db.get(id)).toBeNull();
    expect(await ctx.storage.get(ids.storageId)).toBeNull();
    const audit = await ctx.db
      .query('federationTravelAudit')
      .withIndex('visit_time', (q) => q.eq('visitId', 'selected'))
      .collect();
    expect(audit.some((row) => row.operation === 'ADMIN_LOCAL_CLEAR_COMPLETED')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('secret');
  });
});
test('cache-only clearing preserves original long-term facts, memories and cold archives', async () => {
  const t = convexTest(schema, modules),
    ids = await fixture(t),
    { jobId, report } = await preview(t, 'CACHE');
  expect(report.state).toBe('READY');
  await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await drain(t);
  await t.run(async (ctx) => {
    expect(await ctx.db.get(ids.memoryIds[0])).toMatchObject({ description: 'selected-private-0' });
    expect(await ctx.db.get(ids.factsId)).toMatchObject({ payload: { text: 'fact-secret' } });
    expect(await ctx.db.get(ids.archiveId)).not.toBeNull();
    expect(await ctx.db.query('travelPrivacyTombstones').collect()).toHaveLength(0);
    const preserved = await ctx.db
      .query('federationEventFacts')
      .withIndex('messageId', (q) => q.eq('messageId', 'message-selected'))
      .unique();
    expect(preserved?.payload.text).toBe('network-secret');
  });
});
test.each([['CACHE', false], ['SENSITIVE', false], ['SENSITIVE', true]] as const)(
  'imported historical bodies follow %s scope across pages with prior History clear=%s', async (scope, priorClear) => {
  const t = convexTest(schema, modules);
  const local = await fixture(t);
  const ids = await t.run(async ctx => {
    const jobId = await ctx.db.insert('backupLargeJobs', {
      kind: 'import', mode: 'selective-import', state: 'COMPLETE', phase: 'COMPLETE', tableIndex: 0,
      cursor: null, chunkCount: 1, processedChunks: 1, recordCount: 20,
      bytes: 1000, source: { townId: 'source-town' }, createdAt: 1, updatedAt: 1,
      metadata: {
        selection: { owners: [{ agentGlobalId: 'resident-global', worldId: local.worldId, playerId: 'p:0' }] },
        targetOwners: [{ sourceAgentGlobalId: 'resident-global', agentGlobalId: 'resident-global',
          worldId: local.worldId, playerId: 'p:0', operation: 'create' }],
      },
    });
    const staged: Record<string, Id<'backupLargeRows'>> = {};
    const add = async (table: string, record: Record<string, any>, agentGlobalIds = ['resident-global']) => {
      staged[record._id] = await ctx.db.insert('backupLargeRows', {
        jobId, role: 'SOURCE', table, sourceId: record._id, chunkIndex: 0,
        rowIndex: Object.keys(staged).length, state: 'APPLIED', references: [],
        ...(table === 'visitLedger' ? { relationKey: `visit:${record.visitId}` } : {}),
        metadata: { retainedMarker: 'mapping-metadata', envelope: {
          kind: 'record', role: 'primary', record: encodeRow(Object.fromEntries(Object.entries(record).reverse())), references: [],
        } },
      });
      return ctx.db.insert('backupSelectiveHistory', {
        jobId, sourceTownId: 'source-town', sourceId: record._id, table,
        agentGlobalIds, record: encodeRow(record),
      });
    };
    const events: Id<'backupSelectiveHistory'>[] = [];
    for (let i = 0; i < 13; i++) events.push(await add('federationEventFacts', {
      _id: `original-event-${i}`, visitId: 'selected', messageId: `message-${i}`,
      receivedAt: i, payload: { eventId: `event-${i}`, text: `historical-secret-${i}` },
    }));
    if (priorClear) {
      const event = decodeRow((await ctx.db.get(events[0]))!.record);
      await ctx.db.patch(events[0], { record: encodeRow({ ...event,
        payload: { privacyRedacted: true, eventId: 'event-0' } }) });
    }
    const action = await add('federationActionFacts', {
      _id: 'original-action', visitId: 'selected', actionId: 'stable-action',
      agentAuthorityEpoch: 4, visitLeaseVersion: 2, occurredAt: 3,
      action: { type: 'say', text: 'historical-action-secret' },
      result: { kind: 'ok', value: { text: 'historical-result-secret' } },
      receiptPayload: { actionId: 'stable-action', text: 'historical-receipt-secret' },
    });
    const decision = await add('autonomousTravelDecisions', {
      _id: 'original-decision', visitId: 'selected', state: 'COMPLETED',
      reason: 'historical-reason-secret', error: 'historical-error-secret',
    });
    const ledger = await add('visitLedger', {
      _id: 'original-ledger', visitId: 'selected', state: 'COMPLETED',
      leaseExpiry: 1234, agentAuthorityEpoch: 4, fencingToken: 'original-fence',
      role: 'home', agentGlobalId: 'resident-global', worldId: local.worldId, homePlayerId: 'p:0',
    });
    const audit = await add('federationTravelAudit', {
      _id: 'original-audit', visitId: 'selected', operation: 'UPDATED', at: 3,
      previous: { state: 'RETURN_PENDING', text: 'historical-audit-secret' },
      next: { state: 'COMPLETED', agentAuthorityEpoch: 4, reason: 'historical-audit-reason-secret' },
    });
    const nativeAudit = await ctx.db.insert('federationTravelAudit', {
      visitId: 'selected', source: 'visitLedger', operation: 'UPDATED', at: 3,
      next: { state: 'COMPLETED', text: 'native-audit-secret', leaseExpiry: 1234 },
    });
    const otherOwner = await add('federationEventFacts', {
      _id: 'other-owner-event', visitId: 'selected', payload: { text: 'other-owner-secret' },
    }, ['other-resident']);
    const otherVisit = await add('federationEventFacts', {
      _id: 'other-visit-event', visitId: 'other', payload: { text: 'other-visit-secret' },
    });
    const worldId = (await ctx.db.query('worlds').first())!._id;
    const policyId = await ctx.db.insert('autonomousTravelPolicies', {
      worldId, playerId: 'p:0', agentGlobalId: 'resident-global', enabled: false,
      allowedPeerTownIds: [], decisionIntervalMs: 60000, dailyRequestLimit: 1,
      revision: 1, nextDecisionAt: 1, operator: 'admin', reason: 'Keep local policy', updatedAt: 1,
    });
    const native = async (visitId: string) => ctx.db.insert('autonomousTravelDecisions', {
      policyId, policyRevision: 1, worldId, playerId: 'p:0', agentId: 'a:0',
      agentGlobalId: 'resident-global', operationId: `operation-${visitId}`, state: 'COMPLETED',
      createdAt: 1, deadline: 2, visitId, reason: `${visitId}-reason-secret`, error: `${visitId}-error-secret`,
    });
    await ctx.db.delete(local.ledgerId);
    const chatProfileId = await ctx.db.insert('chatProfiles', { name: 'local-test', provider: 'ollama',
      url: 'http://localhost:11434', model: 'test-model', stopWords: [], createdAt: 1 });
    await ctx.db.insert('residentModelBindings', { worldId: local.worldId, playerId: 'p:0',
      agentGlobalId: 'resident-global', chatProfileId, createdAt: 1, updatedAt: 1 });
    await ctx.db.insert('federationAgentRuntimes', { worldId: local.worldId, playerId: 'p:0', agentId: 'a:0',
      agentGlobalId: 'resident-global', homeTownId: 'home', state: 'HOME_ACTIVE',
      agentAuthorityEpoch: 1, updatedAt: 1 });
    const importId = await ctx.db.insert('backupImports', { sourceTownId: 'source-town', mode: 'selective-clone',
      exportedAt: 1, importedAt: 2, mapping: {}, manifest: { selectiveJobId: jobId },
      runtimeSnapshot: { selectiveJobId: jobId } });
    const archive = (await ctx.db.get(jobId))!;
    await ctx.db.patch(jobId, { metadata: { ...archive.metadata, importId } });
    const originalStaged = await Promise.all(Object.values(staged).map(id => ctx.db.get(id)));
    const originalLedger = (await ctx.db.get(ledger))!.record;
    return { events, action, decision, ledger, audit, nativeAudit, otherOwner, otherVisit, policyId,
      staged, originalStaged, originalLedger, history: { importId, worldId: local.worldId, ownerGlobalId: 'resident-global' },
      nativeDecision: await native('selected'), otherDecision: await native('other') };
  });
  const jobId: Id<'travelPrivacyJobs'> = await t.mutation(mutationRef('travelPrivacy/inspect'), {
    adminToken, visitId: 'selected', scope, history: ids.history,
  });
  await drain(t);
  const report = (await t.query(queryRef('travelPrivacy/status'), { adminToken, jobId }))!;
  expect(report.state).toBe('READY');
  await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await drain(t);
  const final = await t.query(queryRef('travelPrivacy/status'), { adminToken, jobId });
  expect(final!.state).toBe('COMPLETE');
  expect(final!.counts.backupSelectiveHistory ?? 0).toBe(scope === 'SENSITIVE' ? 16 : 0);
  await t.run(async ctx => {
    const read = async (id: Id<'backupSelectiveHistory'>) => decodeRow((await ctx.db.get(id))!.record);
    for (const original of ids.originalStaged) {
      const staged = (await ctx.db.get(original!._id))!;
      const history = (await ctx.db.query('backupSelectiveHistory').withIndex('job_source', q =>
        q.eq('jobId', staged.jobId).eq('sourceId', staged.sourceId)).unique())!;
      expect(staged.metadata.envelope.record).toBe(history.record);
      expect(staged).toEqual({ ...original, metadata: { ...original!.metadata,
        envelope: { ...original!.metadata.envelope, record: history.record } } });
      if (scope === 'CACHE' || ['original-ledger', 'other-owner-event', 'other-visit-event'].includes(staged.sourceId))
        expect(staged).toEqual(original);
      else expect(JSON.stringify(staged.metadata)).not.toContain('historical-');
    }
    for (const [i, id] of ids.events.entries()) {
      const record = await read(id);
      expect(record.messageId).toBe(`message-${i}`);
      expect(record.receivedAt).toBe(i);
      expect(record.payload).toEqual(scope === 'SENSITIVE'
        ? { privacyRedacted: true, eventId: `event-${i}` }
        : { eventId: `event-${i}`, text: `historical-secret-${i}` });
    }
    const action = await read(ids.action), decision = await read(ids.decision);
    expect(action).toMatchObject({ actionId: 'stable-action', agentAuthorityEpoch: 4, visitLeaseVersion: 2 });
    if (scope === 'SENSITIVE') {
      expect(action.action).toEqual({ type: 'say', privacyRedacted: true });
      expect(action.result).toEqual({ kind: 'ok', value: null });
      expect(action.receiptPayload).toEqual({ privacyRedacted: true, actionId: 'stable-action' });
      expect(decision).not.toHaveProperty('reason');
      expect(decision).not.toHaveProperty('error');
    } else {
      expect(action.action.text).toBe('historical-action-secret');
      expect(decision.reason).toBe('historical-reason-secret');
    }
    expect(await read(ids.ledger)).toMatchObject({ state: 'COMPLETED', leaseExpiry: 1234, fencingToken: 'original-fence' });
    expect((await ctx.db.get(ids.ledger))!.record).toBe(ids.originalLedger);
    const audit = await read(ids.audit), nativeAudit = await ctx.db.get(ids.nativeAudit);
    if (scope === 'SENSITIVE') {
      expect(audit.previous).toEqual({ state: 'RETURN_PENDING' });
      expect(audit.next).toEqual({ state: 'COMPLETED', agentAuthorityEpoch: 4, reason: 'UNCLASSIFIED_FAILURE' });
      expect(nativeAudit!.next).toEqual({ state: 'COMPLETED', leaseExpiry: 1234 });
    } else {
      expect(audit.previous.text).toBe('historical-audit-secret');
      expect(nativeAudit!.next.text).toBe('native-audit-secret');
    }
    expect((await read(ids.otherOwner)).payload.text).toBe('other-owner-secret');
    expect((await read(ids.otherVisit)).payload.text).toBe('other-visit-secret');
    const native = await ctx.db.get(ids.nativeDecision);
    expect(native).toMatchObject({ state: 'COMPLETED', operationId: 'operation-selected', policyRevision: 1 });
    if (scope === 'SENSITIVE') {
      expect(native).not.toHaveProperty('reason');
      expect(native).not.toHaveProperty('error');
    } else expect(native!.reason).toBe('selected-reason-secret');
    expect((await ctx.db.get(ids.otherDecision))!.reason).toBe('other-reason-secret');
    expect((await ctx.db.get(ids.policyId))!.reason).toBe('Keep local policy');
  });
  const candidates = await t.query(queryRef('travelPrivacy/historicalCandidates'), {
    adminToken, visitId: 'selected', paginationOpts: { cursor: null, numItems: 5 },
  });
  expect(candidates.page).toEqual([expect.objectContaining({ history: ids.history })]);
  const retriedId: Id<'travelPrivacyJobs'> = await t.mutation(mutationRef('travelPrivacy/inspect'), {
    adminToken, visitId: 'selected', scope, history: ids.history,
  });
  await t.mutation(mutationRef('travelPrivacy/retry'), { adminToken, jobId: retriedId });
  await drain(t);
  expect((await t.query(queryRef('travelPrivacy/status'), { adminToken, jobId: retriedId }))!.state).toBe('READY');
});
async function historicalFactFixture(t: ReturnType<typeof convexTest<typeof schema.tables>>) {
  return t.run(async ctx => {
    const jobId = await ctx.db.insert('backupLargeJobs', {
      kind: 'import', mode: 'selective-import', state: 'COMPLETE', phase: 'COMPLETE',
      tableIndex: 0, cursor: null, chunkCount: 1, processedChunks: 1, recordCount: 1,
      bytes: 100, source: { townId: 'source-town' }, createdAt: 1, updatedAt: 1,
    });
    const record = encodeRow({ _id: 'source-event', visitId: 'selected', messageId: 'source-message',
      receivedAt: 1, payload: { eventId: 'source-observation', text: 'history-evidence-body' } });
    const metadata = { envelope: { kind: 'record', role: 'primary', record, references: [] } };
    const stagedId = await ctx.db.insert('backupLargeRows', {
      jobId, role: 'SOURCE', table: 'federationEventFacts', sourceId: 'source-event',
      chunkIndex: 0, rowIndex: 0, state: 'APPLIED', references: [], metadata,
    });
    const oldId = await ctx.db.insert('backupLargeRows', {
      jobId, role: 'OLD', table: 'federationEventFacts', sourceId: 'source-event',
      chunkIndex: 1, rowIndex: 0, state: 'CAPTURED', references: [], metadata,
    });
    const historyId = await ctx.db.insert('backupSelectiveHistory', {
      jobId, sourceTownId: 'source-town', sourceId: 'source-event', table: 'federationEventFacts',
      agentGlobalIds: ['resident-global'], record,
    });
    return { jobId, stagedId, oldId, historyId, record, metadata };
  });
}
test.each(['table', 'visit', 'envelope', 'record', 'source-town', 'unfinished-import', 'duplicate'] as const)(
  'inconsistent selective SOURCE %s blocks before clearing facts or memories', async conflict => {
    const t = convexTest(schema, modules), local = await fixture(t), ids = await historicalFactFixture(t);
    await t.run(async ctx => {
      if (conflict === 'duplicate') {
        const { _id, _creationTime, ...fields } = (await ctx.db.get(ids.stagedId))!;
        await ctx.db.insert('backupLargeRows', fields);
      }
      else if (conflict === 'table') await ctx.db.patch(ids.stagedId, { table: 'federationActionFacts' });
      else if (conflict === 'source-town') await ctx.db.patch(ids.jobId, { source: { townId: 'other-town' } });
      else if (conflict === 'unfinished-import') await ctx.db.patch(ids.jobId, { state: 'FAILED' });
      else if (conflict === 'envelope') await ctx.db.patch(ids.stagedId, { metadata: { envelope: { kind: 'external-reference' } } });
      else {
        const record = { ...decodeRow(ids.record), ...(conflict === 'visit' ? { visitId: 'other' } : { messageId: 'other-message' }) };
        await ctx.db.patch(ids.stagedId, { metadata: { envelope: { ...ids.metadata.envelope, record: encodeRow(record) } } });
      }
    });
    const before = await t.run(async ctx => ({ source: await ctx.db.get(ids.stagedId),
      history: await ctx.db.get(ids.historyId), old: await ctx.db.get(ids.oldId) }));
    const { jobId, report } = await preview(t);
    expect(report.state).toBe('BLOCKED');
    expect(report.blockers).toContain('IMPORTED_HISTORY_EVIDENCE_MISMATCH');
    await expect(t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId }))
      .rejects.toThrow('TRAVEL_PRIVACY_PREFLIGHT_BLOCKED');
    await t.run(async ctx => {
      expect(await ctx.db.get(ids.stagedId)).toEqual(before.source);
      expect(await ctx.db.get(ids.historyId)).toEqual(before.history);
      expect(await ctx.db.get(ids.oldId)).toEqual(before.old);
      expect(await ctx.db.get(local.memoryIds[0])).not.toBeNull();
      expect((await ctx.db.get(local.factsId))!.payload.text).toBe('fact-secret');
      expect((await ctx.db.get(local.inboxId))!.envelope.payload.text).toBe('network-secret');
      expect(await ctx.db.query('travelPrivacyTombstones').collect()).toEqual([]);
    });
  });
test.each(['SOURCE', 'History'] as const)('a registered %s change invalidates a ready selective privacy plan', async copy => {
  const t = convexTest(schema, modules), local = await fixture(t), ids = await historicalFactFixture(t);
  const { jobId, report } = await preview(t);
  expect(report.state).toBe('READY');
  await t.run(async ctx => {
    const record = encodeRow({ ...decodeRow(ids.record), messageId: 'changed-after-preview' });
    if (copy === 'SOURCE') await withEmbeddingRevision(ctx).db.patch(ids.stagedId, {
      metadata: { envelope: { ...ids.metadata.envelope, record } },
    });
    else await withEmbeddingRevision(ctx).db.patch(ids.historyId, { record });
  });
  await expect(t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId }))
    .rejects.toThrow('TRAVEL_PRIVACY_PREVIEW_STALE');
  expect(await t.run(ctx => ctx.db.get(local.memoryIds[0]))).not.toBeNull();
  expect(await t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toEqual([]);
});
test('legacy History without a SOURCE row still clears while an OLD record with the same ID stays unchanged', async () => {
  const t = convexTest(schema, modules);
  await fixture(t);
  const ids = await historicalFactFixture(t);
  const old = await t.run(async ctx => {
    await ctx.db.delete(ids.stagedId);
    return ctx.db.get(ids.oldId);
  });
  const { jobId, report } = await preview(t);
  expect(report.state).toBe('READY');
  await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await drain(t);
  expect((await t.query(queryRef('travelPrivacy/status'), { adminToken, jobId }))!.state).toBe('COMPLETE');
  await t.run(async ctx => {
    expect(decodeRow((await ctx.db.get(ids.historyId))!.record).payload)
      .toEqual({ privacyRedacted: true, eventId: 'source-observation' });
    expect(await ctx.db.get(ids.oldId)).toEqual(old);
  });
});
async function snapshotFixture(t: ReturnType<typeof convexTest<typeof schema.tables>>, shared = false) {
  return t.run(async ctx => {
    const snapshot = {
      visitLedger: [encodeRow({ visitId: 'selected', agentGlobalId: 'source-resident',
        state: 'COMPLETED', leaseExpiry: 1234, fencingToken: 'source-fence' })],
      federationInbox: [encodeRow({ messageId: 'old-message', payloadDigest: 'signed-original-digest',
        ack: { status: 'COMMITTED' }, envelope: { visitId: 'selected', type: 'OBSERVATION',
          payload: { eventId: 'old-event', text: 'snapshot-inbox-secret' } } }),
        encodeRow({ envelope: { visitId: 'selected', type: 'RETURN_ACK', payload: { safeAfter: 1234 } } })],
      federationOutbox: [encodeRow({ envelope: { visitId: 'selected', type: 'DECISION',
        payload: { text: 'snapshot-outbox-secret' } }, ackedAt: 12 })],
      federationPendingActions: [encodeRow({ visitId: 'selected', inputId: 'old-input',
        actionId: 'stable-action', agentAuthorityEpoch: 7, visitLeaseVersion: 3,
        action: { type: 'say', text: 'snapshot-action-secret' }, result: { kind: 'ok', value: 'snapshot-result-secret' },
        receiptPayload: { actionId: 'stable-action', text: 'snapshot-receipt-secret' } }),
        encodeRow({ visitId: 'other', inputId: shared ? 'old-input' : 'other-input', action: { text: 'other-action-body' } })],
      inputs: [encodeRow({ _id: 'old-input', args: { text: 'snapshot-input-secret' }, returnValue: { kind: 'ok', value: 'snapshot-return-secret' } }),
        encodeRow({ _id: 'other-input', args: { text: 'other-input-body' } })],
      federationDecisionJobs: [encodeRow({ visitId: 'selected', eventId: 'decision-event',
        state: 'COMPLETED', observation: { text: 'snapshot-observation-secret' }, error: 'snapshot-error-secret' })],
      federationTranscriptJobs: [encodeRow({ visitId: 'selected', state: 'COMPLETE',
        pendingMessages: [{ text: 'snapshot-transcript-secret' }], lastError: 'snapshot-transcript-error-secret' })],
      federationTurns: [encodeRow({ visitId: 'selected', turnId: 'stable-turn', state: 'COMPLETE' })],
    };
    const insert = (mapping: Record<string, string>) => ctx.db.insert('backupImports', {
      sourceTownId: 'source', mode: 'clone', exportedAt: 1, importedAt: 2,
      sourceStoppedAt: 3, manifest: { snapshotDigest: 'original-manifest-digest' }, mapping, runtimeSnapshot: snapshot,
    });
    return { id: await insert({ 'source-resident': 'resident-global' }),
      otherOwner: await insert({ 'source-resident': 'different-local-resident' }), snapshot };
  });
}
test.each(['CACHE', 'SENSITIVE'] as const)('ordinary runtime snapshot clears %s bodies but retains reconciliation and other owners', async scope => {
  const t = convexTest(schema, modules);
  await fixture(t);
  const ids = await snapshotFixture(t);
  const { jobId, report } = await preview(t, scope);
  expect(report.state).toBe('READY');
  await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await drain(t);
  await t.run(async ctx => {
    const imported = (await ctx.db.get(ids.id))!;
    expect(imported).toMatchObject({ sourceStoppedAt: 3, mapping: { 'source-resident': 'resident-global' },
      manifest: { snapshotDigest: 'original-manifest-digest' } });
    const snapshot = imported.runtimeSnapshot;
    expect(snapshot.visitLedger).toEqual(ids.snapshot.visitLedger);
    expect(snapshot.federationTurns).toEqual(ids.snapshot.federationTurns);
    expect(snapshot.federationInbox[1]).toBe(ids.snapshot.federationInbox[1]);
    expect(snapshot.inputs[1]).toBe(ids.snapshot.inputs[1]);
    expect(snapshot.federationPendingActions[1]).toBe(ids.snapshot.federationPendingActions[1]);
    expect((await ctx.db.get(ids.otherOwner))!.runtimeSnapshot).toEqual(ids.snapshot);
    if (scope === 'CACHE') expect(snapshot).toEqual(ids.snapshot);
    else {
      expect(JSON.stringify(snapshot)).not.toContain('snapshot-');
      expect(decodeRow(snapshot.federationInbox[0])).toMatchObject({
        messageId: 'old-message', payloadDigest: 'signed-original-digest', ack: { status: 'COMMITTED' },
        envelope: { payload: { privacyRedacted: true, eventId: 'old-event' } },
      });
      expect(decodeRow(snapshot.federationPendingActions[0])).toMatchObject({
        actionId: 'stable-action', agentAuthorityEpoch: 7, visitLeaseVersion: 3,
        action: { type: 'say', privacyRedacted: true }, result: { kind: 'ok', value: null },
      });
      expect(decodeRow(snapshot.inputs[0])).toMatchObject({ args: {}, returnValue: { kind: 'ok', value: null } });
    }
  });
});
test('shared imported input blocks before deleting original memories or any snapshots', async () => {
  const t = convexTest(schema, modules);
  const memories = await fixture(t), ids = await snapshotFixture(t, true);
  const { jobId, report } = await preview(t);
  expect(report.state).toBe('BLOCKED');
  expect(report.blockers).toContain('SHARED_IMPORTED_INPUT');
  await expect(t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId }))
    .rejects.toThrow('TRAVEL_PRIVACY_PREFLIGHT_BLOCKED');
  await t.run(async ctx => {
    expect(await ctx.db.get(memories.memoryIds[0])).not.toBeNull();
    expect((await ctx.db.get(ids.id))!.runtimeSnapshot).toEqual(ids.snapshot);
    expect(await ctx.db.query('travelPrivacyTombstones').collect()).toEqual([]);
  });
});
test('a registered snapshot writer invalidates a ready privacy plan before deletion', async () => {
  const t = convexTest(schema, modules);
  const memories = await fixture(t), ids = await snapshotFixture(t);
  const { jobId, report } = await preview(t);
  expect(report.state).toBe('READY');
  await t.run(async ctx => {
    const tracked = withEmbeddingRevision(ctx);
    await tracked.db.patch(ids.id, { runtimeSnapshot: { ...ids.snapshot,
      federationDecisionJobs: [...ids.snapshot.federationDecisionJobs,
        encodeRow({ visitId: 'selected', observation: { text: 'new-snapshot-body' }, state: 'COMPLETED' })] } });
  });
  await expect(t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId }))
    .rejects.toThrow('TRAVEL_PRIVACY_PREVIEW_STALE');
  expect(await t.run(ctx => ctx.db.get(memories.memoryIds[0]))).not.toBeNull();
  expect(await t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toEqual([]);
});
test.each(['other-owner', 'other-world', 'missing-owner', 'missing-world', 'other-transcript'] as const)(
  'same visit ID with %s blocks before erasing either resident', async variant => {
    const t = convexTest(schema, modules), ids = await fixture(t);
    const copiedId = await t.run(async ctx => {
      if (variant === 'other-transcript') {
        const { _id, _creationTime, ...transcript } = (await ctx.db.get(ids.transcriptId))!;
        return ctx.db.insert('homeTravelTranscripts', { ...transcript,
          transcriptId: 'cloned-transcript', agentGlobalId: 'cloned-resident', playerId: 'p:2' });
      }
      const { _id, _creationTime, ...memory } = (await ctx.db.get(ids.memoryIds[0]))!;
      if (variant === 'other-owner') memory.agentGlobalId = 'cloned-resident';
      if (variant === 'missing-owner') delete memory.agentGlobalId;
      if (variant === 'missing-world') delete memory.worldId;
      if (variant === 'other-world') memory.worldId = await ctx.db.insert('worlds', {
        nextId: 1, players: [], agents: [], conversations: [],
      });
      return ctx.db.insert('memories', { ...memory, description: 'copied-private-body' });
    });
    const { jobId, report } = await preview(t);
    expect(report.state).toBe('BLOCKED');
    expect(report.blockers).toContain(variant.startsWith('missing-')
      ? 'MISSING_MEMORY_OWNERSHIP' : 'SHARED_VISIT_OWNERSHIP');
    await expect(t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId }))
      .rejects.toThrow('TRAVEL_PRIVACY_PREFLIGHT_BLOCKED');
    await t.run(async ctx => {
      expect(await ctx.db.get(ids.memoryIds[0])).not.toBeNull();
      expect(await ctx.db.get(copiedId)).not.toBeNull();
      expect(await ctx.db.get(ids.transcriptId)).not.toBeNull();
      expect(await ctx.db.query('travelPrivacyTombstones').collect()).toEqual([]);
    });
  });
test.each(['resident-global', 'different-binding-owner'])('legacy travel memory uses authoritative resident binding %s', async bindingOwner => {
  const t = convexTest(schema, modules), ids = await fixture(t);
  await t.run(async ctx => {
    const chatProfileId = await ctx.db.insert('chatProfiles', { name: 'local-test', provider: 'ollama',
      url: 'http://localhost:11434', model: 'test-model', stopWords: [], createdAt: 1 });
    await ctx.db.insert('residentModelBindings', { worldId: ids.worldId, playerId: 'p:0',
      agentGlobalId: bindingOwner, chatProfileId, createdAt: 1, updatedAt: 1 });
    await ctx.db.patch(ids.memoryIds[0], { agentGlobalId: undefined });
  });
  const { jobId, report } = await preview(t);
  if (bindingOwner !== 'resident-global') {
    expect(report.state).toBe('BLOCKED');
    expect(report.blockers).toContain('SHARED_VISIT_OWNERSHIP');
    await expect(t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId }))
      .rejects.toThrow('TRAVEL_PRIVACY_PREFLIGHT_BLOCKED');
    expect(await t.run(ctx => ctx.db.get(ids.memoryIds[0]))).not.toBeNull();
    return;
  }
  expect(report.state).toBe('READY');
  await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await drain(t);
  await t.run(async ctx => {
    expect(await ctx.db.get(ids.memoryIds[0])).toBeNull();
    expect(await ctx.db.query('travelPrivacyTombstones').withIndex('key', q =>
      q.eq('key', `memory:${ids.memoryIds[0]}`)).unique()).toMatchObject({ ownerGlobalId: 'resident-global' });
    expect(await ctx.db.get(ids.otherId)).not.toBeNull();
  });
});
test('resident ownership changes invalidate a ready privacy plan before deletion', async () => {
  const t = convexTest(schema, modules), ids = await fixture(t);
  const { jobId, report } = await preview(t);
  expect(report.state).toBe('READY');
  await t.run(async ctx => {
    const chatProfileId = await ctx.db.insert('chatProfiles', { name: 'local-test', provider: 'ollama',
      url: 'http://localhost:11434', model: 'test-model', stopWords: [], createdAt: 1 });
    await withEmbeddingRevision(ctx).db.insert('residentModelBindings', {
      worldId: ids.worldId, playerId: 'p:0', agentGlobalId: 'different-owner',
      chatProfileId, createdAt: 1, updatedAt: 1,
    });
  });
  await expect(t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId }))
    .rejects.toThrow('TRAVEL_PRIVACY_PREVIEW_STALE');
  expect(await t.run(ctx => ctx.db.get(ids.memoryIds[0]))).not.toBeNull();
  expect(await t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toEqual([]);
});
test('mixed derived memories block sensitive clearing without changing either trip', async () => {
  const t = convexTest(schema, modules),
    ids = await fixture(t);
  const mixedId = await t.run((ctx) =>
    ctx.db.insert('memories', {
      worldId: ids.worldId,
      playerId: 'p:0',
      description: 'mixed-private-inference',
      agentGlobalId: 'resident-global',
      importance: 5,
      lastAccess: Date.now(),
      data: { type: 'reflection', relatedMemoryIds: [ids.memoryIds[0], ids.otherId] },
    }),
  );
  const { jobId, report } = await preview(t);
  expect(report.state).toBe('BLOCKED');
  expect(report.blockers).toContain('SHARED_DERIVED_MEMORY');
  await expect(
    t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId }),
  ).rejects.toThrow('TRAVEL_PRIVACY_PREFLIGHT_BLOCKED');
  expect(await t.run((ctx) => ctx.db.get(mixedId))).toMatchObject({
    description: 'mixed-private-inference',
  });
});
test.each([
  ['summary', 'other-owner'], ['summary', 'other-world'], ['summary', 'missing-world'],
  ['summary', 'missing-owner'], ['summary', 'conflicting-binding'], ['summary', 'conflicting-global-binding'],
  ['summary', 'duplicate-binding'], ['child', 'other-owner'],
] as const)('a %s reflection with %s blocks deletion of its exclusive source memories', async (generation, ownership) => {
  const t = convexTest(schema, modules), ids = await fixture(t);
  const reflectionId = generation === 'summary' ? ids.summaryId : ids.childId;
  await t.run(async ctx => {
    if (ownership === 'other-owner') await ctx.db.patch(reflectionId, { agentGlobalId: 'other-resident', playerId: 'p:1' });
    else if (ownership === 'other-world') {
      const worldId = await ctx.db.insert('worlds', { nextId: 1, players: [], agents: [], conversations: [] });
      await ctx.db.patch(reflectionId, { worldId });
    } else if (ownership === 'missing-world') await ctx.db.patch(reflectionId, { worldId: undefined });
    else if (ownership === 'missing-owner') await ctx.db.patch(reflectionId, { agentGlobalId: undefined, playerId: 'p:1' });
    else {
      const chatProfileId = await ctx.db.insert('chatProfiles', { name: 'ownership-fixture', provider: 'ollama',
        url: 'http://localhost:11434', model: 'test-model', stopWords: [], createdAt: 1 });
      await ctx.db.patch(reflectionId, { playerId: 'p:1' });
      const binding = { worldId: ids.worldId, playerId: ownership === 'conflicting-global-binding' ? 'p:0' : 'p:1',
        agentGlobalId: ownership === 'conflicting-global-binding' ? 'resident-global' : 'other-resident',
        chatProfileId, createdAt: 1, updatedAt: 1 };
      await ctx.db.insert('residentModelBindings', binding);
      if (ownership === 'duplicate-binding') await ctx.db.insert('residentModelBindings', binding);
    }
  });
  const originals = await t.run(ctx => ctx.db.query('memories').collect());
  const { jobId, report } = await preview(t);
  expect(report.state).toBe('BLOCKED');
  expect(report.blockers).toContain(ownership.startsWith('missing-') ? 'MISSING_MEMORY_OWNERSHIP' : 'SHARED_DERIVED_MEMORY');
  expect((await t.run(ctx => ctx.db.get(jobId)))!.memoryIds).not.toContain(reflectionId);
  await expect(t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId }))
    .rejects.toThrow('TRAVEL_PRIVACY_PREFLIGHT_BLOCKED');
  expect(await t.run(ctx => ctx.db.query('memories').collect())).toEqual(originals);
  expect(await t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toEqual([]);
});
test('same-owner legacy reflections follow the fixed point through their resident binding and retain tombstone ownership', async () => {
  const t = convexTest(schema, modules), ids = await fixture(t);
  await t.run(async ctx => {
    const chatProfileId = await ctx.db.insert('chatProfiles', { name: 'ownership-fixture', provider: 'ollama',
      url: 'http://localhost:11434', model: 'test-model', stopWords: [], createdAt: 1 });
    await ctx.db.insert('residentModelBindings', { worldId: ids.worldId, playerId: 'p:0',
      agentGlobalId: 'resident-global', chatProfileId, createdAt: 1, updatedAt: 1 });
    await ctx.db.patch(ids.summaryId, { agentGlobalId: undefined });
    await ctx.db.patch(ids.childId, { agentGlobalId: undefined });
  });
  const { jobId, report } = await preview(t);
  expect(report.state).toBe('READY');
  expect(report.counts.memories).toBe(15);
  const job = (await t.run(ctx => ctx.db.get(jobId)))!;
  for (const memoryId of [ids.summaryId, ids.childId]) expect(job.memoryOwners).toContainEqual({
    memoryId, worldId: ids.worldId, playerId: 'p:0', ownerGlobalId: 'resident-global',
  });
  await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await drain(t);
  expect((await t.query(queryRef('travelPrivacy/status'), { adminToken, jobId }))!.state).toBe('COMPLETE');
  await t.run(async ctx => {
    for (const memoryId of [ids.summaryId, ids.childId]) {
      expect(await ctx.db.get(memoryId)).toBeNull();
      expect(await ctx.db.query('travelPrivacyTombstones').withIndex('key', q => q.eq('key', `memory:${memoryId}`)).unique())
        .toMatchObject({ worldId: ids.worldId, playerId: 'p:0', ownerGlobalId: 'resident-global' });
    }
    expect(await ctx.db.get(ids.otherId)).not.toBeNull();
  });
});
test('shared host conversations are reported and never erase other visitor dialogue', async () => {
  const t = convexTest(schema, modules),
    ids = await fixture(t, 'host');
  const messageId = await t.run(async (ctx) => {
    for (const visitId of ['selected', 'other'])
      await ctx.db.insert('federationTurns', {
        visitId,
        eventId: `event-${visitId}`,
        turnId: `turn-${visitId}`,
        worldId: ids.worldId,
        playerId: 'p:1',
        conversationId: 'c:1',
        deadline: Date.now() - 100000,
        state: 'COMMITTED',
      });
    return ctx.db.insert('messages', {
      worldId: ids.worldId,
      conversationId: 'c:1',
      messageUuid: 'local-uuid',
      author: 'p:1',
      text: 'shared-other-message',
    });
  });
  const { report } = await preview(t);
  expect(report.blockers).toContain('SHARED_CONVERSATION');
  expect(await t.run((ctx) => ctx.db.get(messageId))).toMatchObject({
    text: 'shared-other-message',
  });
});
test('active visits, unauthorized administrators and stale previews cannot start clearing', async () => {
  const t = convexTest(schema, modules),
    ids = await fixture(t);
  await expect(
    t.mutation(mutationRef('travelPrivacy/inspect'), {
      adminToken: 'invalid',
      visitId: 'selected',
      scope: 'CACHE',
    }),
  ).rejects.toThrow('ADMIN_UNAUTHORIZED');
  const { jobId } = await preview(t);
  await t.run((ctx) => ctx.db.insert('embeddingDataRevisions', { key: 'memories', revision: 1 }));
  await expect(
    t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId }),
  ).rejects.toThrow('TRAVEL_PRIVACY_PREVIEW_STALE');
  await t.run((ctx) => ctx.db.patch(ids.ledgerId, { state: 'ACTIVE' }));
  await expect(
    t.mutation(mutationRef('travelPrivacy/inspect'), {
      adminToken,
      visitId: 'selected',
      scope: 'CACHE',
    }),
  ).rejects.toThrow('TRAVEL_PRIVACY_VISIT_NOT_SAFE_TERMINAL');
});
test('privacy tombstones prevent late transcript and source facts from recreating erased memories', async () => {
  const t = convexTest(schema, modules),
    ids = await fixture(t),
    { jobId } = await preview(t);
  await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await drain(t);
  await expect(
    t.run(async (ctx) => receiveConversationEnded(ctx, (await ctx.db.get(ids.ledgerId))!, {})),
  ).rejects.toThrow('TRAVEL_PRIVACY_REDACTED');
  await expect(
    t.run((ctx) =>
      persistConfirmedEvent(ctx, {
        worldId: ids.worldId,
        playerId: 'p:0',
        agentGlobalId: 'resident-global',
        visitId: 'selected',
        eventId: 'late-event',
        hostTownId: 'host',
        description: 'late-private-text',
        occurredAt: Date.now(),
        participants: [],
      }),
    ),
  ).rejects.toThrow('TRAVEL_PRIVACY_REDACTED');
  expect(await t.run((ctx) => ctx.db.query('memories').collect())).toHaveLength(1);
  expect(
    await t.run((ctx) =>
      ctx.db
        .query('embeddingDataRevisions')
        .withIndex('key', (q) => q.eq('key', privacyCacheRevisionKey))
        .unique(),
    ),
  ).toMatchObject({ revision: 2 });
});

test('sensitive scope clears global derived caches and fences old writeback while allowing later regeneration', async () => {
  const t = convexTest(schema, modules);
  await fixture(t);
  const textHash = new Uint8Array(32).buffer;
  await t.run((ctx) =>
    ctx.db.insert('embeddingsCache', { namespace: 'unowned-context', textHash, embedding: [1] }),
  );
  const { jobId } = await preview(t);
  await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  const { makeFunctionReference: makeWriteRef } = await import('convex/server');
  const runningWrite = makeWriteRef<'mutation'>('agent/embeddingsCache:writeEmbeddings');
  expect(
    await t.mutation(runningWrite, {
      namespace: 'unowned-context',
      cacheGeneration: 1,
      embeddings: [{ textHash, embedding: [99] }],
    }),
  ).toEqual([]);
  await drain(t);
  expect(
    await t.mutation(runningWrite, {
      namespace: 'unowned-context',
      cacheGeneration: 1,
      embeddings: [{ textHash, embedding: [99] }],
    }),
  ).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query('embeddingsCache').collect())).toHaveLength(0);
  const { makeFunctionReference } = await import('convex/server');
  const write = makeFunctionReference<'mutation'>('agent/embeddingsCache:writeEmbeddings');
  expect(
    await t.mutation(write, {
      namespace: 'unowned-context',
      cacheGeneration: 0,
      embeddings: [{ textHash, embedding: [2] }],
    }),
  ).toEqual([]);
  expect(
    await t.mutation(write, {
      namespace: 'unowned-context',
      cacheGeneration: 2,
      embeddings: [{ textHash, embedding: [3] }],
    }),
  ).toHaveLength(1);
});

test('changing only provenance graph after preview invalidates privacy preflight without changing embedding source revision', async () => {
  const t = convexTest(schema, modules),
    ids = await fixture(t),
    { jobId } = await preview(t);
  const { withEmbeddingRevision, dataRevision, sourceKey, privacyRevisionKey } = await import(
    '../models/embeddingDataRevision'
  );
  await t.run(async (ctx) => {
    await withEmbeddingRevision(ctx).db.patch(ids.summaryId, {
      data: { type: 'reflection', relatedMemoryIds: [ids.memoryIds[0], ids.otherId] },
    });
    expect(await dataRevision(ctx.db, sourceKey)).toBe(0);
    expect(await dataRevision(ctx.db, privacyRevisionKey)).toBe(1);
  });
  await expect(
    t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId }),
  ).rejects.toThrow('TRAVEL_PRIVACY_PREVIEW_STALE');
});

test('authoritative memory and vector writers cannot reintroduce selected content during paged purge', async () => {
  const t = convexTest(schema, modules),
    ids = await fixture(t),
    { jobId } = await preview(t);
  await t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  const { withEmbeddingRevision } = await import('../models/embeddingDataRevision');
  await expect(
    t.run((ctx) =>
      withEmbeddingRevision(ctx).db.patch(ids.memoryIds[0], { description: 'late-body' }),
    ),
  ).rejects.toThrow('TRAVEL_PRIVACY_REDACTED');
  await expect(
    t.run((ctx) =>
      withEmbeddingRevision(ctx).db.insert('memories', {
        worldId: ids.worldId,
        playerId: 'p:0',
        description: 'late-derived-body',
        importance: 5,
        lastAccess: Date.now(),
        data: { type: 'reflection', relatedMemoryIds: [ids.memoryIds[0]] },
      }),
    ),
  ).rejects.toThrow('TRAVEL_PRIVACY_REDACTED');
  await expect(
    t.run((ctx) =>
      withEmbeddingRevision(ctx).db.insert('modelMemoryVectors', {
        memoryId: ids.memoryIds[0],
        spaceId: 'nonexistent-space' as Id<'embeddingSpaces'>,
        worldId: ids.worldId,
        playerId: 'p:0',
        embedding: [1],
      }),
    ),
  ).rejects.toThrow('TRAVEL_PRIVACY_REDACTED');
  await drain(t);
});


test('a running cache-only job cannot hide a concurrent sensitive job from the cache write fence', async () => {
  const t = convexTest(schema, modules);
  await fixture(t);
  const { jobId } = await preview(t);
  await t.run(async ctx => {
    const job = (await ctx.db.get(jobId))!;
    const { _id, _creationTime, ...fields } = job;
    await ctx.db.patch(jobId, { scope: 'CACHE', state: 'RUNNING' });
    await ctx.db.insert('travelPrivacyJobs', { ...fields, scope: 'SENSITIVE', state: 'RUNNING' });
  });
  const { makeFunctionReference } = await import('convex/server');
  const result = await t.mutation(makeFunctionReference<'mutation'>('agent/embeddingsCache:writeEmbeddings'), {
    namespace: 'concurrent-context', cacheGeneration: 0,
    embeddings: [{ textHash: new Uint8Array(32).buffer, embedding: [1] }],
  });
  expect(result).toEqual([]);
  expect(await t.run(ctx => ctx.db.query('embeddingsCache').collect())).toHaveLength(0);
});
