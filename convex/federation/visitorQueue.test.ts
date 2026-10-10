import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { mutationRef, queryRef } from './refs';
import { digest } from './security';
import { FederationMessage, PROTOCOL } from './protocol';
import {
  beginReturn,
  dispatchLedgerMessage,
  homeFrozen,
  homeResumed,
  hostCreated,
  hostRemoved,
} from './ledger';
import { drainVisitorQueue, visitorQueueSummary } from './visitorQueue';
import { DEFAULT_RESOURCE_LIMITS } from './resources';
import { enqueueMessage } from './queue';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/ledger.ts': () => import('./ledger'),
  '../federation/transport.ts': () => import('./transport'),
  '../federation/runtime.ts': () => import('./runtime'),
  '../federation/resourceMonitoring.ts': () => import('./resourceMonitoring'),
};
const adminToken = 'visitor-queue-test-admin-token';
const token = 'visitor-queue-fencing-token-32bytes';
const profile = { name: 'Alice', character: 'f1', description: 'Resident', homeTownName: 'Home' };
const baseTime = 1_700_000_000_000;
type TestDb = Awaited<ReturnType<typeof setup>>;

async function setup(
  options: {
    townId?: string;
    peers?: string[];
    maxVisitors?: number;
    policy?: Partial<Doc<'federationResourcePolicy'>> | false;
  } = {},
) {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  const t = convexTest(schema, modules);
  const townId = options.townId ?? 'b';
  await t.run(async (ctx) => {
    await ctx.db.insert('federationIdentity', {
      townId,
      townName: townId,
      endpoint: `https://${townId}.example/federation/v1`,
      publicKey: 'unused',
      privateKeyEncrypted: 'unused',
      fingerprint: 'unused',
      deploymentInstanceId: `${townId}-instance`,
      deploymentEpoch: 1,
      enabled: true,
      allowIncomingPairRequests: true,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: options.maxVisitors ?? 1,
      maxVisitDurationMs: 300_000,
      resourceLimits: DEFAULT_RESOURCE_LIMITS,
      mode: 'ACTIVE',
      createdAt: Date.now(),
    });
    if (options.policy !== false)
      await ctx.db.insert('federationResourcePolicy', {
        maxVisitorsPerSourceTown: null,
        visitorQueueEnabled: true,
        maxQueuedVisits: 50,
        visitQueueTtlMs: 120_000,
        visitorQueueMode: 'FIFO',
        ...options.policy,
      });
    for (const source of options.peers ?? ['a', 'c', 'd']) {
      await ctx.db.insert('federationPeers', {
        townId: source,
        townName: source,
        publicKey: 'unused',
        fingerprint: 'unused',
        deploymentInstanceId: `${source}-instance`,
        deploymentEpoch: 1,
        endpoint: `https://${source}.example/federation/v1`,
        credentialId: 'credential-test',
        credentialEncrypted: 'unused',
        trustState: 'TRUSTED',
        inboundVisitsAllowed: true,
        outboundVisitsAllowed: true,
        pairedAt: Date.now(),
      });
      await ctx.db.insert('transportSessions', {
        peerTownId: source,
        channelState: 'TRANSPORT_READY',
        transportType: 'DIRECT_HTTPS',
        localDeploymentEpoch: 1,
        verifiedPeerDeploymentEpoch: 1,
        outboundVerifiedAt: Date.now(),
        inboundVerifiedAt: Date.now(),
      });
    }
  });
  return t;
}
function message(
  id: string,
  source = 'a',
  target = 'b',
  type = 'VISIT_RESERVE',
  sequence = 1,
  payload: Record<string, any> = {},
): FederationMessage {
  return {
    protocol: PROTOCOL,
    messageId: crypto.randomUUID(),
    fromTownId: source,
    toTownId: target,
    senderDeploymentInstanceId: `${source}-instance`,
    senderDeploymentEpoch: 1,
    expectedRecipientDeploymentEpoch: 1,
    credentialId: 'credential-test',
    type,
    sentAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    nonce: crypto.randomUUID(),
    visitId: id,
    agentGlobalId: `a/agent:${id}`,
    agentAuthorityEpoch: 2,
    visitLeaseVersion: 1,
    streamId: 'lease-control',
    sequence,
    payload: {
      fencingToken: token,
      ...(type === 'VISIT_RESERVE'
        ? {
            leaseExpiry: Date.now() + 250_000,
            profile,
            allowQueue: true,
            queueProtocolVersion: 1,
          }
        : {}),
      ...payload,
    },
  };
}
function reserve(id: string, source = 'a', payload: Record<string, any> = {}) {
  const msg = message(id, source, 'b', 'VISIT_RESERVE', 1, payload);
  msg.agentGlobalId = `${source}/agent:${id}`;
  return msg;
}
const accept = async (t: TestDb, msg: FederationMessage) =>
  t.mutation(mutationRef('transport/acceptMessage'), {
    message: msg,
    payloadDigest: await digest(msg),
  });
const ledger = (t: TestDb, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('visitLedger')
      .withIndex('visitId', (q) => q.eq('visitId', id))
      .unique(),
  );
const drain = (t: TestDb) => t.run((ctx) => drainVisitorQueue(ctx));
async function patchIdentity(t: TestDb, changes: Partial<Doc<'federationIdentity'>>) {
  await t.run(async (ctx) => {
    const row = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(row._id, changes);
  });
}
async function patchPolicy(t: TestDb, changes: Partial<Doc<'federationResourcePolicy'>>) {
  await t.run(async (ctx) => {
    const row = (await ctx.db.query('federationResourcePolicy').unique())!;
    await ctx.db.patch(row._id, changes);
  });
}
async function seed(t: TestDb, id: string, overrides: Partial<Doc<'visitLedger'>> = {}) {
  return t.run((ctx) =>
    ctx.db.insert('visitLedger', {
      visitId: id,
      agentGlobalId: `a/agent:${id}`,
      homeTownId: 'a',
      hostTownId: 'b',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 2,
      visitLeaseVersion: 1,
      leaseExpiry: Date.now() + 250_000,
      fencingToken: token,
      role: 'host',
      state: 'QUEUED',
      allowQueue: true,
      profile,
      queuedAt: Date.now(),
      queueExpiresAt: Date.now() + 120_000,
      queueReason: 'HOST_CAPACITY_EXCEEDED',
      queuePaused: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    }),
  );
}
async function outbox(t: TestDb, id: string, type?: string) {
  return (await t.run((ctx) => ctx.db.query('federationOutbox').collect())).filter(
    (row) => row.envelope.visitId === id && (!type || row.envelope.type === type),
  );
}
async function assertNoVisitorWork(t: TestDb) {
  await t.run(async (ctx) => {
    expect(await ctx.db.query('visitReservations').collect()).toEqual([]);
    expect(await ctx.db.query('federationTurns').collect()).toEqual([]);
    expect(await ctx.db.query('federationDecisionJobs').collect()).toEqual([]);
    expect(await ctx.db.query('federationLlmRequests').collect()).toEqual([]);
    expect(await ctx.db.query('inputs').collect()).toEqual([]);
    expect(await ctx.db.query('worlds').collect()).toEqual([]);
    const jobs = await ctx.db.system.query('_scheduled_functions').collect();
    expect(jobs.some((job) => String(job.name).includes('runtime/'))).toBe(false);
  });
}
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] });
  jest.setSystemTime(baseTime);
});
afterEach(() => jest.useRealTimers());

test('full host persists QUEUED without reservations, presence or model work; retries preserve position and lease', async () => {
  const t = await setup({ maxVisitors: 0 });
  const msg = reserve('waiting', 'a', { leaseExpiry: Date.now() + 60_000 });
  const ack = await accept(t, msg);
  expect(ack.status).toBe('COMMITTED');
  const first = (await ledger(t, 'waiting'))!;
  expect(first).toMatchObject({
    state: 'QUEUED',
    queuedAt: baseTime,
    queueExpiresAt: baseTime + 60_000,
  });
  await assertNoVisitorWork(t);
  jest.setSystemTime(Date.now() + 1000);
  expect(await accept(t, msg)).toEqual(ack); // The first ACK may have been lost.
  const retransmission = { ...msg, messageId: crypto.randomUUID(), nonce: crypto.randomUUID() };
  await accept(t, retransmission);
  expect((await ledger(t, 'waiting'))!).toMatchObject({
    queuedAt: first.queuedAt,
    queueExpiresAt: first.queueExpiresAt,
    leaseExpiry: first.leaseExpiry,
  });
  expect(await outbox(t, 'waiting', 'VISIT_QUEUED')).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.query('visitLedger').collect())).toHaveLength(1);
});

test.each([
  ['old configuration', false, {}],
  ['disabled queue', { visitorQueueEnabled: false }, {}],
  ['old requester', {}, { allowQueue: undefined, queueProtocolVersion: undefined }],
  ['no queue protocol capability', {}, { queueProtocolVersion: undefined }],
  ['requester opts out', {}, { allowQueue: false }],
] as const)('%s retains reject-and-retry compatibility', async (_name, policy, payload) => {
  const t = await setup({ maxVisitors: 0, policy });
  await accept(t, reserve('legacy', 'a', payload));
  expect(await ledger(t, 'legacy')).toMatchObject({
    state: 'REJECTED',
    cleanupConfirmed: true,
    lastError: 'HOST_CAPACITY_EXCEEDED',
  });
  expect((await outbox(t, 'legacy')).map((row) => row.envelope.type)).toEqual(['VISIT_REJECT']);
  await assertNoVisitorWork(t);
});

test('bounded queue and per-source waiting cap reject new requests without evicting existing candidates', async () => {
  const t = await setup({
    maxVisitors: 0,
    policy: { maxQueuedVisits: 2, maxQueuedVisitsPerSourceTown: 1 },
  });
  await Promise.all([accept(t, reserve('a1')), accept(t, reserve('a2'))]);
  await accept(t, reserve('c1', 'c'));
  await accept(t, reserve('d1', 'd'));
  const rows = await t.run((ctx) => ctx.db.query('visitLedger').collect());
  expect(rows.filter((row) => row.state === 'QUEUED')).toHaveLength(2);
  expect(rows.filter((row) => row.lastError === 'VISITOR_SOURCE_QUEUE_FULL')).toHaveLength(1);
  expect(await ledger(t, 'd1')).toMatchObject({
    state: 'REJECTED',
    lastError: 'VISITOR_QUEUE_FULL',
  });
  await assertNoVisitorWork(t);
});

test('parallel admissions and drains cannot oversell total slots or independent reservation budget', async () => {
  const t = await setup({ maxVisitors: 0 });
  await Promise.all(['q1', 'q2', 'q3'].map((id) => accept(t, reserve(id))));
  await patchIdentity(t, {
    maxVisitors: 8,
    resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, maxVisitReservations: 1 },
  });
  await Promise.all([drain(t), drain(t), accept(t, reserve('new', 'c'))]);
  const rows = await t.run((ctx) => ctx.db.query('visitLedger').collect());
  expect(rows.filter((row) => row.state === 'RESERVED').map((row) => row.visitId)).toEqual(['q1']);
  expect(await t.run((ctx) => ctx.db.query('visitReservations').collect())).toHaveLength(1);
  expect(await outbox(t, 'q1', 'VISIT_RESERVED')).toHaveLength(1);
  expect(rows.filter((row) => row.state === 'QUEUED')).toHaveLength(3);
  await t.run(async (ctx) => {
    const current = (await ledgerIn(ctx, 'q1'))!;
    await beginReturn(ctx, current, 'TEST_RELEASE');
  });
  expect((await drain(t)).promoted).toEqual(['q2']);
  await patchIdentity(t, { maxVisitors: 1 });
  expect((await drain(t)).promoted).toEqual([]);
});
async function ledgerIn(ctx: MutationCtx, id: string) {
  return ctx.db
    .query('visitLedger')
    .withIndex('visitId', (q) => q.eq('visitId', id))
    .unique();
}

test('FIFO skips paused and source-quota blocked candidates across the whole queue; ties remain stable', async () => {
  const t = await setup({ maxVisitors: 2, policy: { maxVisitorsPerSourceTown: 1 } });
  await seed(t, 'active', { state: 'REMOVING' });
  await t.run((ctx) =>
    ctx.db.insert('visitReservations', {
      visitId: 'active',
      hostTownId: 'b',
      reservedSlot: true,
      expiresAt: Date.now() - 1,
    }),
  );
  for (let index = 0; index < 25; index++)
    await seed(t, `blocked-${index}`, { queuedAt: Date.now() - 1000 + index });
  await seed(t, 'paused', { homeTownId: 'c', agentGlobalId: 'c/agent:paused', queuePaused: true });
  await seed(t, 'first-c', { homeTownId: 'c', agentGlobalId: 'c/agent:first' });
  await seed(t, 'second-c', { homeTownId: 'c', agentGlobalId: 'c/agent:second' });
  expect((await drain(t)).promoted).toEqual(['first-c']);
  expect(await ledger(t, 'blocked-0')).toMatchObject({
    state: 'QUEUED',
    queueReason: 'HOST_SOURCE_QUOTA_EXCEEDED',
  });
  expect(await ledger(t, 'paused')).toMatchObject({ state: 'QUEUED', queuePaused: true });
  expect(await ledger(t, 'second-c')).toMatchObject({ state: 'QUEUED' });
});

test('SOURCE_ROUND_ROBIN persists cursor across workers and preserves FIFO within each source', async () => {
  const t = await setup({
    policy: { visitorQueueMode: 'SOURCE_ROUND_ROBIN', visitorQueueLastSource: 'a' },
  });
  await seed(t, 'a1', { queuedAt: Date.now() - 3 });
  await seed(t, 'a2', { queuedAt: Date.now() - 2 });
  await seed(t, 'c1', { homeTownId: 'c', agentGlobalId: 'c/agent:c1', queuedAt: Date.now() - 1 });
  await seed(t, 'c2', { homeTownId: 'c', agentGlobalId: 'c/agent:c2' });
  expect((await drain(t)).promoted).toEqual(['c1']);
  expect(
    (await t.run((ctx) => ctx.db.query('federationResourcePolicy').unique()))
      ?.visitorQueueLastSource,
  ).toBe('c');
  await t.run(async (ctx) => {
    await beginReturn(ctx, (await ledgerIn(ctx, 'c1'))!, 'RELEASE');
  });
  expect((await drain(t)).promoted).toEqual(['a1']);
  await t.run(async (ctx) => {
    await beginReturn(ctx, (await ledgerIn(ctx, 'a1'))!, 'RELEASE');
  });
  expect((await drain(t)).promoted).toEqual(['c2']);
  expect(await ledger(t, 'a2')).toMatchObject({ state: 'QUEUED' });
});

test('pause/resume and PROMOTE require admin and use capacity and fair order without extending TTL', async () => {
  const t = await setup({ maxVisitors: 0 });
  await seed(t, 'first', { queuedAt: Date.now() - 1 });
  await seed(t, 'second');
  const manage = (visitId: string, operation: string, credential = adminToken) =>
    t.mutation(mutationRef('ledger/manageQueuedVisit'), {
      adminToken: credential,
      visitId,
      operation,
    });
  await expect(manage('second', 'PROMOTE', 'invalid')).rejects.toThrow();
  await expect(
    t.query(queryRef('ledger/waitingVisits'), { adminToken: 'invalid' }),
  ).rejects.toThrow();
  expect(await manage('second', 'PROMOTE')).toMatchObject({ state: 'QUEUED' });
  await manage('first', 'PAUSE');
  const first = (await ledger(t, 'first'))!;
  expect(await t.run((ctx) => visitorQueueSummary(ctx.db))).toMatchObject({
    waiting: 2,
    paused: 1,
  });
  await patchIdentity(t, { maxVisitors: 1 });
  expect(await manage('first', 'RESUME')).toMatchObject({ state: 'RESERVED' });
  expect(await ledger(t, 'first')).toMatchObject({
    queuedAt: first.queuedAt,
    queueExpiresAt: first.queueExpiresAt,
  });
  expect(await ledger(t, 'second')).toMatchObject({ state: 'QUEUED' });
  expect(await t.run((ctx) => ctx.db.query('federationResourceAudit').collect())).toHaveLength(3);
});

test.each([
  ['expired TTL', 'VISITOR_QUEUE_EXPIRED'],
  ['expired lease', 'VISITOR_QUEUE_EXPIRED'],
  ['disabled queue', 'VISITOR_QUEUE_DISABLED'],
  ['revoked peer', 'VISITOR_QUEUE_PEER_REVOKED'],
  ['changed host epoch', 'VISITOR_QUEUE_DEPLOYMENT_FENCED'],
  ['changed home epoch', 'VISITOR_QUEUE_DEPLOYMENT_FENCED'],
  ['identity conflict', 'VISITOR_QUEUE_IDENTITY_FENCED'],
] as const)(
  '%s terminally cleans queue and cannot be revived by later reserve or confirm',
  async (condition, reason) => {
    const t = await setup();
    await seed(t, 'ended');
    if (condition === 'expired TTL' || condition === 'expired lease')
      await t.run(async (ctx) => {
        await ctx.db.patch(
          (await ledgerIn(ctx, 'ended'))!._id,
          condition === 'expired TTL'
            ? { queueExpiresAt: Date.now() }
            : { leaseExpiry: Date.now() },
        );
      });
    if (condition === 'disabled queue') await patchPolicy(t, { visitorQueueEnabled: false });
    if (condition === 'revoked peer' || condition === 'changed home epoch')
      await t.run(async (ctx) => {
        const remote = (await ctx.db
          .query('federationPeers')
          .withIndex('townId', (q) => q.eq('townId', 'a'))
          .unique())!;
        await ctx.db.patch(
          remote._id,
          condition === 'revoked peer' ? { trustState: 'REVOKED' } : { deploymentEpoch: 2 },
        );
      });
    if (condition === 'changed host epoch') await patchIdentity(t, { deploymentEpoch: 2 });
    if (condition === 'identity conflict')
      await t.run((ctx) =>
        ctx.db.insert('federationIdentityConflicts', {
          conflictKey: 'conflict',
          townId: 'b',
          publicKey: 'unused',
          knownDeploymentInstanceId: 'b-instance',
          knownDeploymentEpoch: 1,
          observedDeploymentInstanceId: 'b-clone',
          observedDeploymentEpoch: 1,
          source: 'MESSAGE',
          evidence: {},
          evidenceDigest: 'unused',
          state: 'OPEN',
          detectedAt: Date.now(),
        }),
      );
    expect((await drain(t)).terminated).toEqual(['ended']);
    expect(await ledger(t, 'ended')).toMatchObject({
      state: 'REJECTED',
      cleanupConfirmed: true,
      lastError: reason,
    });
    expect(await outbox(t, 'ended', 'VISIT_CLEANED')).toHaveLength(1);
    await t.run((ctx) => dispatchLedgerMessage(ctx, reserve('ended')));
    const confirm = t.run((ctx) =>
      dispatchLedgerMessage(ctx, message('ended', 'a', 'b', 'VISIT_CONFIRM')),
    );
    if (condition === 'expired lease') await expect(confirm).rejects.toThrow('VISIT_LEASE_EXPIRED');
    else await confirm;
    expect(await ledger(t, 'ended')).toMatchObject({ state: 'REJECTED' });
    expect(await t.run((ctx) => ctx.db.query('visitReservations').collect())).toEqual([]);
  },
);

test.each(['PAUSED', 'INBOUND_DISABLED', 'STALE_PROBE'] as const)(
  '%s blocks promotion without discarding waiting authorization',
  async (condition) => {
    const t = await setup();
    await seed(t, 'waiting');
    await t.run(async (ctx) => {
      const remote = (await ctx.db
        .query('federationPeers')
        .withIndex('townId', (q) => q.eq('townId', 'a'))
        .unique())!;
      if (condition === 'PAUSED') await ctx.db.patch(remote._id, { trustState: 'PAUSED' });
      if (condition === 'INBOUND_DISABLED')
        await ctx.db.patch(remote._id, { inboundVisitsAllowed: false });
      if (condition === 'STALE_PROBE') {
        const connection = (await ctx.db
          .query('transportSessions')
          .withIndex('peerTownId', (q) => q.eq('peerTownId', 'a'))
          .unique())!;
        await ctx.db.patch(connection._id, { inboundVerifiedAt: Date.now() - 120_000 });
      }
    });
    expect((await drain(t)).promoted).toEqual([]);
    expect(await ledger(t, 'waiting')).toMatchObject({
      state: 'QUEUED',
      queueExpiresAt: baseTime + 120_000,
    });
    await assertNoVisitorWork(t);
  },
);

test.each(['ZERO_EVENTS', 'ZERO_MODEL', 'ZERO_DECISIONS', 'MODEL_BACKLOG'] as const)(
  '%s pauses promotion; restored budget admits without creating inference work',
  async (condition) => {
    const t = await setup();
    await seed(t, 'waiting');
    if (condition === 'ZERO_EVENTS') await patchPolicy(t, { maxRemoteEventsPerSecond: 0 });
    if (condition === 'ZERO_MODEL' || condition === 'ZERO_DECISIONS')
      await patchIdentity(t, {
        resourceLimits: {
          ...DEFAULT_RESOURCE_LIMITS,
          ...(condition === 'ZERO_MODEL'
            ? { maxConcurrentLocalLLM: 0 }
            : { maxPendingDecisions: 0 }),
        },
      });
    if (condition === 'MODEL_BACKLOG') {
      await patchIdentity(t, {
        resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, maxPendingLocalLLM: 1 },
      });
      await t.run((ctx) =>
        ctx.db.insert('federationLlmRequests', {
          state: 'PENDING',
          createdAt: Date.now(),
          deadline: Date.now() + 30_000,
          queueDeadline: Date.now() + 30_000,
          expiresAt: Date.now() + 30_000,
        }),
      );
    }
    expect((await drain(t)).promoted).toEqual([]);
    expect(await ledger(t, 'waiting')).toMatchObject({
      state: 'QUEUED',
      queueReason: 'HOST_RESOURCE_DEGRADED',
    });
    await patchPolicy(t, { maxRemoteEventsPerSecond: null });
    await patchIdentity(t, { resourceLimits: DEFAULT_RESOURCE_LIMITS });
    expect((await drain(t)).promoted).toEqual(['waiting']);
    expect(await t.run((ctx) => ctx.db.query('federationDecisionJobs').collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('federationTurns').collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toHaveLength(
      condition === 'MODEL_BACKLOG' ? 1 : 0,
    );
    expect(await t.run((ctx) => ctx.db.query('federationInboundBudget').collect())).toEqual([]);
  },
);

test('maintenance lock preserves queued snapshot and prevents both admin mutation and direct helper promotion', async () => {
  const t = await setup();
  await seed(t, 'waiting');
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
  expect(await drain(t)).toEqual({ promoted: [], terminated: [] });
  await expect(
    t.mutation(mutationRef('ledger/manageQueuedVisit'), {
      adminToken,
      visitId: 'waiting',
      operation: 'PROMOTE',
    }),
  ).rejects.toThrow('TOWN_BACKUP_MAINTENANCE_LOCKED');
  expect(await ledger(t, 'waiting')).toMatchObject({
    state: 'QUEUED',
    queueReason: 'HOST_CAPACITY_EXCEEDED',
  });
  await assertNoVisitorWork(t);
});

test('agent conflicts and historical authority reject promotion instead of producing a second entity', async () => {
  const t = await setup({ maxVisitors: 5 });
  await seed(t, 'waiting');
  await seed(t, 'historical', {
    agentGlobalId: 'a/agent:waiting',
    state: 'COMPLETED',
    agentAuthorityEpoch: 2,
  });
  expect((await drain(t)).terminated).toEqual(['waiting']);
  expect(await ledger(t, 'waiting')).toMatchObject({
    state: 'REJECTED',
    lastError: 'AGENT_ALREADY_PRESENT',
  });
  await seed(t, 'different', { agentGlobalId: 'a/agent:occupied' });
  await seed(t, 'active', {
    agentGlobalId: 'a/agent:occupied',
    state: 'ACTIVE',
    agentAuthorityEpoch: 1,
  });
  expect((await drain(t)).terminated).toEqual(['different']);
  expect(await t.run((ctx) => ctx.db.query('visitReservations').collect())).toEqual([]);
});

test('full Outbox preserves local queue cancellation and disables promotions before partial reservation', async () => {
  const t = await setup();
  await seed(t, 'cancel');
  await seed(t, 'waiting');
  await t.run(async (ctx) => {
    for (let index = 0; index < 1000; index++)
      await ctx.db.insert('federationOutbox', {
        messageId: `full-${index}`,
        toTownId: 'a',
        envelope: {},
        attempts: 0,
        nextRetryAt: Date.now(),
      });
  });
  await t.mutation(mutationRef('ledger/manageQueuedVisit'), {
    adminToken,
    visitId: 'cancel',
    operation: 'REJECT',
  });
  expect(await ledger(t, 'cancel')).toMatchObject({
    state: 'REJECTED',
    cleanupConfirmed: true,
    lastError: 'ADMIN_QUEUE_REJECTED:OUTBOX_CAPACITY_EXCEEDED',
  });
  expect((await drain(t)).promoted).toEqual([]);
  expect(await ledger(t, 'waiting')).toMatchObject({ state: 'QUEUED' });
  expect(await t.run((ctx) => ctx.db.query('visitReservations').collect())).toEqual([]);
  await t.run(async (ctx) => {
    await beginReturn(ctx, (await ledgerIn(ctx, 'waiting'))!, 'HOME_CANCEL');
  });
  expect(await ledger(t, 'waiting')).toMatchObject({
    state: 'REJECTED',
    cleanupConfirmed: true,
    lastError: 'HOME_CANCEL:OUTBOX_CAPACITY_EXCEEDED',
  });
});

test('queue worker caps each batch, persists remaining candidates and resumes from a later transaction', async () => {
  const t = await setup({ maxVisitors: 100 });
  for (let index = 0; index < 25; index++)
    await seed(t, `q-${index}`, { queuedAt: Date.now() + index });
  expect((await drain(t)).promoted).toHaveLength(20);
  expect(await t.run((ctx) => ctx.db.query('visitReservations').collect())).toHaveLength(20);
  expect((await drain(t)).promoted).toEqual(['q-20', 'q-21', 'q-22', 'q-23', 'q-24']);
  expect((await drain(t)).promoted).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query('visitReservations').collect())).toHaveLength(25);
});

test('Home validates queue confirmation and never renews TTL or regresses after reservation', async () => {
  const t = await setup({ townId: 'a', peers: ['b'] });
  await seed(t, 'home', {
    role: 'home',
    state: 'REQUESTED',
    queuedAt: undefined,
    queueExpiresAt: undefined,
  });
  const queued = message('home', 'b', 'a', 'VISIT_QUEUED', 1, {
    queueProtocolVersion: 1,
    queuedAt: Date.now(),
    queueExpiresAt: Date.now() + 100_000,
    queueReason: 'HOST_CAPACITY_EXCEEDED',
  });
  await accept(t, queued);
  expect(await ledger(t, 'home')).toMatchObject({ state: 'QUEUED' });
  await expect(
    t.run((ctx) =>
      dispatchLedgerMessage(ctx, {
        ...queued,
        payload: { ...queued.payload, queueExpiresAt: Date.now() + 110_000 },
      }),
    ),
  ).rejects.toThrow('QUEUE_CONFIRMATION_CONFLICT');
  const reserved = message('home', 'b', 'a', 'VISIT_RESERVED', 2, {
    reservedUntil: Date.now() + 30_000,
    leaseExpiry: Date.now() + 250_000,
  });
  await accept(t, reserved);
  expect(await ledger(t, 'home')).toMatchObject({ state: 'FREEZING' });
  await t.run((ctx) => dispatchLedgerMessage(ctx, queued));
  expect(await ledger(t, 'home')).toMatchObject({ state: 'FREEZING' });
});

test.each(['RETURN_PENDING', 'COMPLETED', 'REJECTED'] as const)(
  'late queued/reserved messages cannot revive Home %s',
  async (state) => {
    const t = await setup({ townId: 'a', peers: ['b'] });
    await seed(t, 'home', { role: 'home', state, cleanupConfirmed: state !== 'RETURN_PENDING' });
    await accept(
      t,
      message('home', 'b', 'a', 'VISIT_QUEUED', 1, {
        queueProtocolVersion: 1,
        queuedAt: Date.now(),
        queueExpiresAt: Date.now() + 100_000,
        queueReason: 'FULL',
      }),
    );
    await accept(
      t,
      message('home', 'b', 'a', 'VISIT_RESERVED', 2, {
        reservedUntil: Date.now() + 30_000,
        leaseExpiry: Date.now() + 250_000,
      }),
    );
    expect(await ledger(t, 'home')).toMatchObject({ state });
    await assertNoVisitorWork(t);
  },
);

test('Home expired waiting authorization cancels late reservation before freeze and waits for authenticated cleanup', async () => {
  const t = await setup({ townId: 'a', peers: ['b'] });
  await seed(t, 'home', { role: 'home', state: 'QUEUED', queueExpiresAt: Date.now() });
  await accept(
    t,
    message('home', 'b', 'a', 'VISIT_RESERVED', 1, {
      reservedUntil: Date.now() + 30_000,
      leaseExpiry: Date.now() + 250_000,
    }),
  );
  expect(await ledger(t, 'home')).toMatchObject({
    state: 'RETURN_PENDING',
    lastError: 'VISITOR_QUEUE_EXPIRED',
  });
  await expect(t.run((ctx) => homeResumed(ctx, 'home'))).rejects.toThrow('HOST_LEASE_STILL_VALID');
  expect(await outbox(t, 'home', 'VISIT_RETURN')).toHaveLength(1);
  await accept(t, message('home', 'b', 'a', 'VISIT_CLEANED', 2, { reason: 'HOME_CANCEL' }));
  await t.run((ctx) => homeResumed(ctx, 'home'));
  expect(await ledger(t, 'home')).toMatchObject({ state: 'COMPLETED', cleanupConfirmed: true });
});

test('durable queued-to-reserved messages drive the existing Saga once and physically cleaned slot promotes next visitor', async () => {
  const host = await setup({ maxVisitors: 0 });
  const home = await setup({ townId: 'a', peers: ['b'] });
  await seed(home, 'saga', {
    role: 'home',
    state: 'REQUESTED',
    queuedAt: undefined,
    queueExpiresAt: undefined,
  });
  await home.run((ctx) =>
    enqueueMessage(ctx, {
      peerTownId: 'b',
      type: 'VISIT_RESERVE',
      visitId: 'saga',
      payload: reserve('saga').payload,
    }),
  );
  await accept(host, (await outbox(home, 'saga', 'VISIT_RESERVE'))[0].envelope);
  await accept(home, (await outbox(host, 'saga', 'VISIT_QUEUED'))[0].envelope);
  expect(await ledger(home, 'saga')).toMatchObject({ state: 'QUEUED' });
  await patchIdentity(host, { maxVisitors: 1 });
  expect((await drain(host)).promoted).toEqual(['saga']);
  const reserved = (await outbox(host, 'saga', 'VISIT_RESERVED'))[0].envelope;
  await accept(home, reserved);
  await accept(home, reserved);
  expect(await ledger(home, 'saga')).toMatchObject({ state: 'FREEZING' });
  await home.run((ctx) => homeFrozen(ctx, 'saga'));
  await accept(host, (await outbox(home, 'saga', 'VISIT_CONFIRM'))[0].envelope);
  await host.run((ctx) => hostCreated(ctx, 'saga', 'p:9'));
  await accept(home, (await outbox(host, 'saga', 'VISIT_ACTIVE'))[0].envelope);
  expect(await ledger(home, 'saga')).toMatchObject({ state: 'ACTIVE' });
  await accept(host, reserve('next', 'c'));
  await home.mutation(mutationRef('ledger/returnVisit'), { adminToken, visitId: 'saga' });
  await accept(host, (await outbox(home, 'saga', 'VISIT_RETURN'))[0].envelope);
  expect(await ledger(host, 'saga')).toMatchObject({ state: 'REMOVING' });
  expect((await drain(host)).promoted).toEqual([]);
  await host.run((ctx) => hostRemoved(ctx, 'saga'));
  expect(await ledger(host, 'next')).toMatchObject({ state: 'RESERVED' });
  await accept(home, (await outbox(host, 'saga', 'VISIT_CLEANED'))[0].envelope);
  await home.run((ctx) => homeResumed(ctx, 'saga'));
  expect(await ledger(home, 'saga')).toMatchObject({ state: 'COMPLETED', cleanupConfirmed: true });
  expect(
    (await host.run((ctx) => ctx.db.query('visitReservations').collect())).filter(
      (row) => row.reservedSlot,
    ),
  ).toHaveLength(1);
});

test.each([
  ['request did not authorize waiting', { allowQueue: false }, {}],
  ['unknown protocol version', {}, { queueProtocolVersion: 2 }],
  ['TTL exceeds Home lease', {}, { queueExpiresAt: baseTime + 250_001 }],
  ['non-integer queue timestamp', {}, { queuedAt: baseTime + 0.5 }],
  ['future queue timestamp', {}, { queuedAt: baseTime + 30_001 }],
  ['invalid public reason', {}, { queueReason: 42 }],
] as const)('Home rejects %s before any travel mutation', async (_condition, changes, payload) => {
  const t = await setup({ townId: 'a', peers: ['b'] });
  await seed(t, 'home', { role: 'home', state: 'REQUESTED', ...changes });
  const queued = message('home', 'b', 'a', 'VISIT_QUEUED', 1, {
    queueProtocolVersion: 1,
    queuedAt: Date.now(),
    queueExpiresAt: Date.now() + 100_000,
    queueReason: 'HOST_CAPACITY_EXCEEDED',
    ...payload,
  });
  await expect(accept(t, queued)).rejects.toThrow('INVALID_QUEUE_CONFIRMATION');
  expect(await ledger(t, 'home')).toMatchObject({ state: 'REQUESTED' });
  expect(await t.run((ctx) => ctx.db.query('federationInbox').collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query('messageStreamCursors').collect())).toEqual([]);
  await assertNoVisitorWork(t);
});

test('conflicting visit identity and fencing token cannot mutate an existing queue entry', async () => {
  const t = await setup({ maxVisitors: 0 });
  const request = reserve('waiting');
  await accept(t, request);
  for (const changes of [
    { agentGlobalId: 'a/agent:someone-else' },
    { agentAuthorityEpoch: 3 },
    { payload: { ...request.payload, fencingToken: 'different-fencing-token-32bytes' } },
  ])
    await expect(
      accept(t, {
        ...request,
        messageId: crypto.randomUUID(),
        nonce: crypto.randomUUID(),
        ...changes,
      }),
    ).rejects.toThrow();
  expect(await ledger(t, 'waiting')).toMatchObject({
    state: 'QUEUED',
    fencingToken: token,
    queuedAt: baseTime,
    queueExpiresAt: baseTime + 120_000,
  });
  expect(await t.run((ctx) => ctx.db.query('federationInbox').collect())).toHaveLength(1);
  await assertNoVisitorWork(t);
});

test.each(['QUEUED', 'RESERVED'] as const)(
  'Home cancellation cleans Host %s before late queue/reservation can authorize freezing',
  async (hostState) => {
    const host = await setup({ maxVisitors: 0 });
    const home = await setup({ townId: 'a', peers: ['b'] });
    await seed(home, 'cancel', {
      role: 'home',
      state: 'REQUESTED',
      queuedAt: undefined,
      queueExpiresAt: undefined,
    });
    await home.run((ctx) =>
      enqueueMessage(ctx, {
        peerTownId: 'b',
        type: 'VISIT_RESERVE',
        visitId: 'cancel',
        payload: reserve('cancel').payload,
      }),
    );
    await accept(host, (await outbox(home, 'cancel', 'VISIT_RESERVE'))[0].envelope);
    if (hostState === 'RESERVED') {
      await patchIdentity(host, { maxVisitors: 1 });
      expect((await drain(host)).promoted).toEqual(['cancel']);
    }
    await home.mutation(mutationRef('ledger/returnVisit'), { adminToken, visitId: 'cancel' });
    await accept(host, (await outbox(home, 'cancel', 'VISIT_RETURN'))[0].envelope);
    expect(await ledger(host, 'cancel')).toMatchObject({
      state: hostState === 'QUEUED' ? 'REJECTED' : 'COMPLETED',
      cleanupConfirmed: true,
    });
    await accept(home, (await outbox(host, 'cancel', 'VISIT_QUEUED'))[0].envelope);
    if (hostState === 'RESERVED')
      await accept(home, (await outbox(host, 'cancel', 'VISIT_RESERVED'))[0].envelope);
    expect(await ledger(home, 'cancel')).toMatchObject({ state: 'RETURN_PENDING' });
    await accept(home, (await outbox(host, 'cancel', 'VISIT_CLEANED'))[0].envelope);
    await home.run((ctx) => homeResumed(ctx, 'cancel'));
    expect(await ledger(home, 'cancel')).toMatchObject({ state: 'COMPLETED' });
    expect(
      (await host.run((ctx) => ctx.db.query('visitReservations').collect())).filter(
        (row) => row.reservedSlot,
      ),
    ).toEqual([]);
    expect(await host.run((ctx) => ctx.db.query('inputs').collect())).toEqual([]);
    expect(await host.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
    const jobs = await home.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.some((job) => String(job.name).includes('freezeHome'))).toBe(false);
  },
);

test('unsafe queue sample exceeding the hard bound fails closed without granting a slot', async () => {
  const t = await setup({ maxVisitors: 1000 });
  await t.run(async (ctx) => {
    for (let index = 0; index < 1001; index++)
      await ctx.db.insert('visitLedger', {
        visitId: `overflow-${index}`,
        agentGlobalId: `a/agent:overflow-${index}`,
        homeTownId: 'a',
        hostTownId: 'b',
        homeDeploymentEpoch: 1,
        hostDeploymentEpoch: 1,
        agentAuthorityEpoch: 2,
        visitLeaseVersion: 1,
        leaseExpiry: Date.now() + 250_000,
        fencingToken: token,
        role: 'host',
        state: 'QUEUED',
        allowQueue: true,
        profile,
        queuedAt: Date.now(),
        queueExpiresAt: Date.now() + 120_000,
        queuePaused: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
  });
  expect((await drain(t)).promoted).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query('visitReservations').collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query('federationOutbox').collect())).toEqual([]);
});

test.each(['EXPIRED', 'DISABLED', 'REVOKED'] as const)(
  '%s backlog is cleaned in bounded durable pages with one cleanup receipt per original visit',
  async (condition) => {
    const t = await setup({ maxVisitors: 1 });
    for (let index = 0; index < 47; index++)
      await seed(t, `ended-${index}`, {
        queuedAt: Date.now() - 1000 + index,
        ...(condition === 'EXPIRED' ? { queueExpiresAt: Date.now() } : {}),
      });
    if (condition === 'DISABLED') await patchPolicy(t, { visitorQueueEnabled: false });
    if (condition === 'REVOKED')
      await t.run(async (ctx) => {
        const remote = (await ctx.db
          .query('federationPeers')
          .withIndex('townId', (q) => q.eq('townId', 'a'))
          .unique())!;
        await ctx.db.patch(remote._id, { trustState: 'REVOKED' });
      });
    if (condition !== 'DISABLED')
      await seed(t, 'eligible', {
        homeTownId: 'c',
        agentGlobalId: 'c/agent:eligible',
        queuedAt: Date.now(),
      });
    const first = await drain(t);
    expect(first.terminated).toHaveLength(20);
    expect(first.promoted).toEqual([]);
    for (const expectedTerminated of [20, 40, 47]) {
      const rows = await t.run((ctx) => ctx.db.query('visitLedger').collect());
      const ended = rows.filter((row) => row.visitId.startsWith('ended-'));
      expect(ended.filter((row) => row.state === 'REJECTED' && row.cleanupConfirmed)).toHaveLength(
        expectedTerminated,
      );
      expect(ended.filter((row) => row.state === 'QUEUED')).toHaveLength(47 - expectedTerminated);
      expect(
        ended.every((row) => row.queuedAt === baseTime - 1000 + Number(row.visitId.slice(6))),
      ).toBe(true);
      const messages = await t.run((ctx) => ctx.db.query('federationOutbox').collect());
      const cleaned = messages.filter((row) => row.envelope.type === 'VISIT_CLEANED');
      expect(cleaned).toHaveLength(expectedTerminated);
      expect(new Set(cleaned.map((row) => row.envelope.visitId)).size).toBe(expectedTerminated);
      expect(
        messages.some(
          (row) =>
            row.envelope.type === 'VISIT_RESERVED' && row.envelope.visitId.startsWith('ended-'),
        ),
      ).toBe(false);
      const slots = await t.run((ctx) => ctx.db.query('visitReservations').collect());
      expect(slots.filter((row) => row.reservedSlot).length).toBeLessThanOrEqual(1);
      expect(slots.every((row) => row.visitId === 'eligible')).toBe(true);
      if (condition !== 'DISABLED')
        expect(await ledger(t, 'eligible')).toMatchObject({
          state: expectedTerminated === 47 ? 'RESERVED' : 'QUEUED',
        });
      if (expectedTerminated !== 47) await t.mutation(mutationRef('ledger/reconcile'), {});
    }
    await t.mutation(mutationRef('ledger/reconcile'), {});
    const messages = await t.run((ctx) => ctx.db.query('federationOutbox').collect());
    expect(messages.filter((row) => row.envelope.type === 'VISIT_CLEANED')).toHaveLength(47);
    expect(await t.run((ctx) => ctx.db.query('inputs').collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
  },
);

test('queue cleanup and identity-conflict rejection consume one shared transition batch before any later promotion', async () => {
  const t = await setup();
  for (let index = 0; index < 18; index++)
    await seed(t, `expired-${index}`, {
      queuedAt: Date.now() - 1000 + index,
      queueExpiresAt: Date.now(),
    });
  for (let index = 0; index < 2; index++) {
    await seed(t, `conflicting-${index}`, { queuedAt: Date.now() - 100 + index });
    await seed(t, `historical-${index}`, {
      agentGlobalId: `a/agent:conflicting-${index}`,
      state: 'COMPLETED',
      agentAuthorityEpoch: 2,
    });
  }
  await seed(t, 'eligible');
  const first = await drain(t);
  expect(first.terminated).toHaveLength(20);
  expect(first.promoted).toEqual([]);
  expect(await ledger(t, 'eligible')).toMatchObject({ state: 'QUEUED' });
  expect(await t.run((ctx) => ctx.db.query('visitReservations').collect())).toEqual([]);
  expect((await drain(t)).promoted).toEqual(['eligible']);
  expect(
    (await t.run((ctx) => ctx.db.query('federationOutbox').collect())).filter(
      (row) => row.envelope.type === 'VISIT_CLEANED',
    ),
  ).toHaveLength(20);
});

test('receiveReserve shares its transition allowance across pre-admission and post-queue drains', async () => {
  const t = await setup({ maxVisitors: 1 });
  for (let index = 0; index < 40; index++)
    await seed(t, `expired-${index}`, {
      queuedAt: Date.now() - 1000 + index,
      queueExpiresAt: Date.now(),
    });
  await accept(t, reserve('new', 'c'));
  const rows = await t.run((ctx) => ctx.db.query('visitLedger').collect());
  expect(rows.filter((row) => row.state === 'REJECTED')).toHaveLength(20);
  expect(rows.filter((row) => row.state === 'QUEUED')).toHaveLength(21);
  expect(await ledger(t, 'new')).toMatchObject({ state: 'QUEUED' });
  expect(await t.run((ctx) => ctx.db.query('visitReservations').collect())).toEqual([]);
  const messages = await t.run((ctx) => ctx.db.query('federationOutbox').collect());
  expect(messages.filter((row) => row.envelope.type === 'VISIT_CLEANED')).toHaveLength(20);
  expect(messages.filter((row) => row.envelope.type === 'VISIT_QUEUED')).toHaveLength(1);
  expect(messages).toHaveLength(21);
  await t.mutation(mutationRef('ledger/reconcile'), {});
  expect(await ledger(t, 'new')).toMatchObject({ state: 'QUEUED' });
  await t.mutation(mutationRef('ledger/reconcile'), {});
  expect(await ledger(t, 'new')).toMatchObject({ state: 'RESERVED' });
  expect(await outbox(t, 'new', 'VISIT_RESERVED')).toHaveLength(1);
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
  'invalid or exhausted private worker allowance %s fails closed',
  async (transitionLimit) => {
    const t = await setup();
    await seed(t, 'waiting');
    expect(await t.run((ctx) => drainVisitorQueue(ctx, transitionLimit))).toEqual({
      promoted: [],
      terminated: [],
    });
    expect(await ledger(t, 'waiting')).toMatchObject({ state: 'QUEUED' });
    expect(await t.run((ctx) => ctx.db.query('visitReservations').collect())).toEqual([]);
  },
);

test('private worker allowance is clamped to the same hard maximum', async () => {
  const t = await setup({ maxVisitors: 100 });
  for (let index = 0; index < 25; index++)
    await seed(t, `clamped-${index}`, { queuedAt: Date.now() + index });
  expect((await t.run((ctx) => drainVisitorQueue(ctx, 1000))).promoted).toHaveLength(20);
  expect((await t.run((ctx) => drainVisitorQueue(ctx, 1))).promoted).toEqual(['clamped-20']);
});

test.each(['MISSING', 'CPU', 'MEMORY', 'STALE', 'DEPLOYMENT']) (
  'hardware %s blocks immediate admissions and queue promotions, retaining existing visitors', async pressure => {
    const t = await setup({ maxVisitors: 10, policy: {
      hostResourceThresholds: { maxCpuPercent: 85, maxMemoryPercent: 90, maxSampleAgeMs: 10000 },
    } });
    const reportToken = 'queue-resource-test-reporter-token';
    process.env.FEDERATION_RESOURCE_REPORT_TOKEN = reportToken;
    if (pressure !== 'MISSING') {
      await t.run(ctx => ctx.db.insert('federationHostResources', {
        townId: 'b', deploymentInstanceId: pressure === 'DEPLOYMENT' ? 'old-instance' : 'b-instance',
        deploymentEpoch: 1, scope: 'OS_HOST', sampleStartedAt: Date.now() - 5000,
        measuredAt: Date.now(), receivedAt: Date.now(),
        cpuPercent: pressure === 'CPU' ? 85 : 10,
        memoryUsedBytes: pressure === 'MEMORY' ? 90 : 50, memoryTotalBytes: 100,
      }));
      if (pressure === 'STALE') jest.setSystemTime(Date.now() + 10001);
    }
    await seed(t, 'existing', { state: 'ACTIVE' });
    await accept(t, reserve('waiting'));
    expect(await ledger(t, 'waiting')).toMatchObject({ state: 'QUEUED', queueReason: 'HOST_RESOURCE_DEGRADED' });
    expect((await drain(t)).promoted).toEqual([]);
    await assertNoVisitorWork(t);
    await accept(t, reserve('rejected', 'c', { allowQueue: false }));
    expect(await ledger(t, 'rejected')).toMatchObject({ state: 'REJECTED', lastError: 'HOST_RESOURCE_DEGRADED' });
    expect(await ledger(t, 'existing')).toMatchObject({ state: 'ACTIVE' });
    jest.setSystemTime(Date.now() + 5000);
    await t.mutation(mutationRef('resourceMonitoring/reportHostResources'), {
      reportToken, townId: 'b', deploymentInstanceId: 'b-instance', deploymentEpoch: 1,
      scope: 'OS_HOST', sampleStartedAt: Date.now() - 5000, measuredAt: Date.now(),
      cpuPercent: 10, memoryUsedBytes: 50, memoryTotalBytes: 100,
    });
    expect((await drain(t)).promoted).toEqual(['waiting']);
    expect(await ledger(t, 'waiting')).toMatchObject({ state: 'RESERVED' });
    expect(await ledger(t, 'existing')).toMatchObject({ state: 'ACTIVE' });
  },
);
