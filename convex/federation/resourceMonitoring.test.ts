import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { consumeRemoteEventBudget, hostResourceHealth, recordResourceMetric, resourceMeasurements } from './resourceMonitoring';
import { validateResourcePolicy } from './backupHelpers';
import { visitorAdmissionSnapshot } from './visitorQueue';
import { mutationRef } from './refs';
import { residentChatCompletion } from './resources';
import { webcrypto } from 'node:crypto';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/resources.ts': () => import('./resources'),
  '../federation/decision.ts': () => import('./decision'),
  '../federation/resourceMonitoring.ts': () => import('./resourceMonitoring'),
};
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1_000_000); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test('shared remote-event token bucket is bounded, refills with actual time and retains state across calls', async () => {
  const t = convexTest(schema, modules);
  await t.run(ctx => ctx.db.insert('federationResourcePolicy', {
    maxVisitorsPerSourceTown: 3, maxRemoteEventsPerSecond: 2,
  }));
  for (const type of ['VISIT_RESERVE', 'OBSERVATION'])
    await t.run(ctx => consumeRemoteEventBudget(ctx, type));
  await expect(t.run(ctx => consumeRemoteEventBudget(ctx, 'DECISION'))).rejects.toThrow('REMOTE_EVENT_RATE_EXCEEDED');
  jest.setSystemTime(Date.now() + 499);
  await expect(t.run(ctx => consumeRemoteEventBudget(ctx, 'ACTION_RESULT'))).rejects.toThrow('REMOTE_EVENT_RATE_EXCEEDED');
  jest.setSystemTime(Date.now() + 1);
  await t.run(ctx => consumeRemoteEventBudget(ctx, 'ACTION_RESULT'));
  jest.setSystemTime(Date.now() + 100_000);
  for (let count = 0; count < 2; count++) await t.run(ctx => consumeRemoteEventBudget(ctx, 'OBSERVATION'));
  await expect(t.run(ctx => consumeRemoteEventBudget(ctx, 'OBSERVATION'))).rejects.toThrow('REMOTE_EVENT_RATE_EXCEEDED');
  expect(await t.run(ctx => ctx.db.query('federationInboundBudget').collect())).toHaveLength(1);
});

test('zero event budget preserves lease, history and cleanup traffic; absent legacy policy remains unlimited', async () => {
  const t = convexTest(schema, modules);
  await t.run(ctx => consumeRemoteEventBudget(ctx, 'OBSERVATION'));
  await t.run(ctx => ctx.db.insert('federationResourcePolicy', {
    maxVisitorsPerSourceTown: null, maxRemoteEventsPerSecond: 0,
  }));
  await expect(t.run(ctx => consumeRemoteEventBudget(ctx, 'VISIT_RESERVE'))).rejects.toThrow('REMOTE_EVENT_RATE_EXCEEDED');
  for (const type of ['VISIT_RENEW', 'VISIT_RETURN', 'VISIT_CLEANED', 'VISIT_REJECT', 'VISIT_CONFIRM',
    'VISIT_ACTIVE', 'VISIT_RESERVED', 'CONVERSATION_ENDED', 'SESSION_RESYNC', 'STREAM_NACK'])
    await t.run(ctx => consumeRemoteEventBudget(ctx, type));
  expect(await t.run(ctx => ctx.db.query('federationInboundBudget').collect())).toEqual([]);
});

test('measured queue and provider duration use actual clock deltas and completion releases remain idempotent', async () => {
  const t = convexTest(schema, modules);
  const first = await t.mutation(mutationRef('resources/enqueueChat'), { deadline: Date.now() + 90_000 });
  const second = await t.mutation(mutationRef('resources/enqueueChat'), { deadline: Date.now() + 90_000 });
  const waiting = await t.mutation(mutationRef('resources/enqueueChat'), { deadline: Date.now() + 90_000 });
  jest.setSystemTime(Date.now() + 1750);
  await t.mutation(mutationRef('resources/releaseChat'), { requestId: first });
  expect(await t.mutation(mutationRef('resources/claimChat'), { requestId: waiting })).toBe(true);
  jest.setSystemTime(Date.now() + 2250);
  await t.mutation(mutationRef('resources/releaseChat'), { requestId: waiting, outcome: 'SUCCESS', providerDurationMs: 2250 });
  await t.mutation(mutationRef('resources/releaseChat'), { requestId: waiting, outcome: 'SUCCESS', providerDurationMs: 2250 });
  await t.mutation(mutationRef('resources/releaseChat'), { requestId: second });
  const stats = await t.run(ctx => resourceMeasurements(ctx.db));
  expect(stats.chatQueue).toMatchObject({ count: 1, meanMs: 1750, p95Ms: 1750 });
  expect(stats.chatProvider).toMatchObject({ count: 1, meanMs: 2250, p95Ms: 2250 });
  expect(stats.chatSucceeded).toBe(1); expect(stats.chatFailed).toBe(0);
});

test('real resident model call records its observed provider duration and never substitutes configured deadlines', async () => {
  const t = convexTest(schema, modules);
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    jest.setSystemTime(Date.now() + 137);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
  });
  await t.action(ctx => residentChatCompletion(ctx, { messages: [{ role: 'user', content: 'hello' }] },
    { provider: 'custom', url: 'https://synthetic-model.example', chatModel: 'fixed', stopWords: [] }));
  const stats = await t.run(ctx => resourceMeasurements(ctx.db));
  expect(stats.chatProvider.meanMs).toBe(137);
  expect(stats.chatQueue.meanMs).toBe(0);
  expect(stats.chatSucceeded).toBe(1);
});

test('P95 identifies bounded sampling while mean and counts cover all measured durations', async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    for (let index = 1; index <= 300; index++) await recordResourceMetric(ctx, 'CHAT_PROVIDER', index);
  });
  const stats = await t.run(ctx => resourceMeasurements(ctx.db));
  expect(stats.chatProvider).toMatchObject({ count: 300, durationCount: 300, meanMs: 150.5, sampleCount: 256, sampled: true, p95Ms: 288 });
  expect((await t.run(ctx => ctx.db.query('federationResourceMetrics').collect()))[0].samples).toHaveLength(256);
});

test('measurements persist across new runtimes, expire from the view and retain no private contents', async () => {
  let t = convexTest(schema, modules);
  await t.run(async ctx => { await recordResourceMetric(ctx, 'INBOUND_EVENT'); await recordResourceMetric(ctx, 'CHAT_PROVIDER', 40); });
  const snapshot = await t.run(ctx => ctx.db.query('federationResourceMetrics').collect());
  t = convexTest(schema, modules);
  await t.run(async ctx => { for (const { _id, _creationTime, ...row } of snapshot) await ctx.db.insert('federationResourceMetrics', row); });
  expect((await t.run(ctx => resourceMeasurements(ctx.db))).inboundEvents).toBe(1);
  expect(JSON.stringify(snapshot)).not.toMatch(/prompt|content|secret|credential|messageId/);
  jest.setSystemTime(Date.now() + 310_001);
  const stats = await t.run(ctx => resourceMeasurements(ctx.db));
  expect(stats.inboundEvents).toBe(0); expect(stats.chatProvider.meanMs).toBeNull(); expect(stats.chatProvider.p95Ms).toBeNull();
  jest.setSystemTime(Date.now() + 24 * 60 * 60_000);
  await t.run(ctx => recordResourceMetric(ctx, 'INBOUND_EVENT'));
  expect(await t.run(ctx => ctx.db.query('federationResourceMetrics').collect())).toHaveLength(1);
});

test('negative or non-finite timings are rejected without emitting fake metrics', async () => {
  const t = convexTest(schema, modules);
  for (const value of [-1, Infinity, NaN]) await expect(t.run(ctx => recordResourceMetric(ctx, 'CHAT_PROVIDER', value))).rejects.toThrow('INVALID_RESOURCE_MEASUREMENT');
  expect(await t.run(ctx => ctx.db.query('federationResourceMetrics').collect())).toEqual([]);
});

const hostAdminToken = 'host-resource-test-admin-token';
const reportToken = 'host-resource-test-reporter-token-distinct';
const thresholds = { maxCpuPercent: 85, maxMemoryPercent: 90, maxSampleAgeMs: 15000 };
async function hostSetup() {
  process.env.FEDERATION_ADMIN_TOKEN = hostAdminToken;
  process.env.FEDERATION_RESOURCE_REPORT_TOKEN = reportToken;
  const t = convexTest(schema, modules);
  await t.run(ctx => ctx.db.insert('federationIdentity', {
    townId: 'host', townName: 'Host', endpoint: 'https://host.example/federation/v1', publicKey: 'fixture',
    privateKeyEncrypted: 'fixture', fingerprint: 'fixture', deploymentInstanceId: 'host-instance', deploymentEpoch: 1,
    enabled: true, allowIncomingPairRequests: false, allowUnencryptedHttp: false, allowPublicHttp: false,
    maxVisitors: 8, maxVisitDurationMs: 300000, mode: 'ACTIVE', createdAt: Date.now(),
  }));
  return t;
}
// Deterministic input fixtures validate the reporting contract; they are not real host measurements.
const hostSample = () => ({
  reportToken, townId: 'host', deploymentInstanceId: 'host-instance', deploymentEpoch: 1,
  scope: 'OS_HOST' as const, sampleStartedAt: Date.now() - 5000, measuredAt: Date.now(),
  cpuPercent: 40, memoryUsedBytes: 60, memoryTotalBytes: 100,
});
test('only the dedicated reporter credential can persist readings and credentials never enter records', async () => {
  const t = await hostSetup();
  for (const token of ['invalid', hostAdminToken])
    await expect(t.mutation(mutationRef('resourceMonitoring/reportHostResources'),
      { ...hostSample(), reportToken: token })).rejects.toThrow('RESOURCE_REPORT_UNAUTHORIZED');
  await t.mutation(mutationRef('resourceMonitoring/reportHostResources'), hostSample());
  const health = await t.run(ctx => hostResourceHealth(ctx.db));
  expect(health).toMatchObject({ cpu: 40, memory: { usedPercent: 60 }, status: 'AVAILABLE',
    scope: 'OS_HOST', sampleIntervalMs: 5000, reasons: [], thresholds: null });
  expect(JSON.stringify(await t.run(ctx => ctx.db.query('federationHostResources').collect())))
    .not.toMatch(/reportToken|host-resource-test-reporter-token|adminToken/);
  process.env.FEDERATION_RESOURCE_REPORT_TOKEN = hostAdminToken;
  await expect(t.mutation(mutationRef('resourceMonitoring/reportHostResources'),
    { ...hostSample(), reportToken: hostAdminToken })).rejects.toThrow('RESOURCE_REPORT_UNAUTHORIZED');
});
test('replay, out-of-order, future, stale, impossible values and wrong deployment reports are rejected', async () => {
  const t = await hostSetup();
  for (const patch of [{ cpuPercent: -1 }, { cpuPercent: 101 }, { cpuPercent: Infinity },
    { memoryUsedBytes: -1 }, { memoryUsedBytes: 101 }, { memoryTotalBytes: 0 }, { memoryTotalBytes: 1.5 },
    { sampleStartedAt: Date.now() - 999 }, { sampleStartedAt: Date.now() - 60001 },
    { measuredAt: Date.now() + 1 }, { measuredAt: Date.now() - 30001, sampleStartedAt: Date.now() - 35001 }])
    await expect(t.mutation(mutationRef('resourceMonitoring/reportHostResources'),
      { ...hostSample(), ...patch })).rejects.toThrow('INVALID_HOST_RESOURCE_MEASUREMENT');
  for (const patch of [{ townId: 'other' }, { deploymentInstanceId: 'other' }, { deploymentEpoch: 2 }])
    await expect(t.mutation(mutationRef('resourceMonitoring/reportHostResources'),
      { ...hostSample(), ...patch })).rejects.toThrow('RESOURCE_REPORT_DEPLOYMENT_MISMATCH');
  expect(await t.run(ctx => ctx.db.query('federationHostResources').collect())).toEqual([]);
  await t.mutation(mutationRef('resourceMonitoring/reportHostResources'), hostSample());
  await expect(t.mutation(mutationRef('resourceMonitoring/reportHostResources'), hostSample()))
    .rejects.toThrow('STALE_HOST_RESOURCE_REPORT');
  await expect(t.mutation(mutationRef('resourceMonitoring/reportHostResources'),
    { ...hostSample(), sampleStartedAt: Date.now() - 5001, measuredAt: Date.now() - 1 }))
    .rejects.toThrow('STALE_HOST_RESOURCE_REPORT');
});
test('enabled thresholds require fresh actual readings and the shared admission transaction rechecks hardware', async () => {
  const t = await hostSetup();
  await t.mutation(mutationRef('resourceMonitoring/configureHostResources'), { adminToken: hostAdminToken, thresholds });
  expect(await t.run(async ctx => (await visitorAdmissionSnapshot(ctx)).reason ?? null)).toBe('HOST_RESOURCE_DEGRADED');
  await t.mutation(mutationRef('resourceMonitoring/reportHostResources'), { ...hostSample(), cpuPercent: 85, memoryUsedBytes: 90 });
  expect((await t.run(ctx => hostResourceHealth(ctx.db))).reasons).toEqual(['HOST_CPU_THRESHOLD', 'HOST_MEMORY_THRESHOLD']);
  expect(await t.run(async ctx => (await visitorAdmissionSnapshot(ctx)).reason ?? null)).toBe('HOST_RESOURCE_DEGRADED');
  jest.setSystemTime(Date.now() + 5000);
  await t.mutation(mutationRef('resourceMonitoring/reportHostResources'), hostSample());
  expect(await t.run(async ctx => (await visitorAdmissionSnapshot(ctx)).reason ?? null)).toBeNull();
  jest.setSystemTime(Date.now() + 15001);
  expect(await t.run(ctx => hostResourceHealth(ctx.db))).toMatchObject({ cpu: null, memory: null,
    status: 'STALE', reasons: ['HOST_RESOURCE_MEASUREMENTS_STALE'] });
  expect(await t.run(async ctx => (await visitorAdmissionSnapshot(ctx)).reason ?? null)).toBe('HOST_RESOURCE_DEGRADED');
  await t.mutation(mutationRef('resourceMonitoring/configureHostResources'), { adminToken: hostAdminToken, thresholds: null });
  expect(await t.run(async ctx => (await visitorAdmissionSnapshot(ctx)).reason ?? null)).toBeNull();
  expect((await t.run(ctx => ctx.db.query('federationResourceAudit').collect()))).toHaveLength(2);
});
test('failover and restored deployment cannot reuse a previous deployment sample', async () => {
  const t = await hostSetup();
  await t.mutation(mutationRef('resourceMonitoring/configureHostResources'), { adminToken: hostAdminToken, thresholds });
  await t.mutation(mutationRef('resourceMonitoring/reportHostResources'), hostSample());
  await t.run(async ctx => {
    const row = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(row._id, { deploymentInstanceId: 'replacement-instance', deploymentEpoch: 2 });
  });
  expect(await t.run(ctx => hostResourceHealth(ctx.db))).toMatchObject({ cpu: null, memory: null,
    status: 'DEPLOYMENT_MISMATCH', reasons: ['HOST_RESOURCE_MEASUREMENTS_DEPLOYMENT_MISMATCH'] });
  await expect(t.mutation(mutationRef('resourceMonitoring/reportHostResources'), hostSample()))
    .rejects.toThrow('RESOURCE_REPORT_DEPLOYMENT_MISMATCH');
  await t.mutation(mutationRef('resourceMonitoring/reportHostResources'),
    { ...hostSample(), deploymentInstanceId: 'replacement-instance', deploymentEpoch: 2 });
  expect((await t.run(ctx => hostResourceHealth(ctx.db))).status).toBe('AVAILABLE');
});
test('threshold policy validation also applies to restored backups', async () => {
  const t = await hostSetup();
  for (const patch of [{ maxCpuPercent: 0 }, { maxCpuPercent: 101 }, { maxCpuPercent: NaN },
    { maxMemoryPercent: -1 }, { maxMemoryPercent: 101 }, { maxSampleAgeMs: 4999 }, { maxSampleAgeMs: 120001 }]) {
    const invalid = { ...thresholds, ...patch };
    expect(() => validateResourcePolicy({ maxVisitorsPerSourceTown: null, hostResourceThresholds: invalid }))
      .toThrow('INVALID_HOST_RESOURCE_THRESHOLDS');
    await expect(t.mutation(mutationRef('resourceMonitoring/configureHostResources'),
      { adminToken: hostAdminToken, thresholds: invalid })).rejects.toThrow('INVALID_HOST_RESOURCE_THRESHOLDS');
  }
  expect(() => validateResourcePolicy({ maxVisitorsPerSourceTown: null, hostResourceThresholds: thresholds })).not.toThrow();
});

test.each(['COMMITTED', 'FAILED', 'EXPIRED'] as const)(
  'remote decision terminal %s records actual elapsed duration exactly once', async state => {
    const t = convexTest(schema, modules);
    const jobId = await t.run(async ctx => {
      const worldId = await ctx.db.insert('worlds', { nextId: 2, players: [], agents: [], conversations: [] });
      await ctx.db.insert('federationIdentity', {
        townId: 'home', townName: 'Home', endpoint: 'https://home.example/federation/v1',
        publicKey: 'unused', privateKeyEncrypted: 'unused', fingerprint: 'unused',
        deploymentInstanceId: 'home-instance', deploymentEpoch: 1, enabled: true,
        allowIncomingPairRequests: true, allowUnencryptedHttp: false, allowPublicHttp: false,
        maxVisitors: 8, maxVisitDurationMs: 300000, mode: 'ACTIVE', createdAt: Date.now(),
      });
      await ctx.db.insert('federationPeers', {
        townId: 'host', townName: 'Host', endpoint: 'https://host.example/federation/v1',
        publicKey: 'unused', fingerprint: 'unused', deploymentInstanceId: 'host-instance',
        deploymentEpoch: 1, credentialId: 'unused', credentialEncrypted: 'unused',
        trustState: 'TRUSTED', inboundVisitsAllowed: true, outboundVisitsAllowed: true,
        pairedAt: Date.now(),
      });
      await ctx.db.insert('visitLedger', {
        visitId: 'visit', agentGlobalId: 'home/agent:1', homeTownId: 'home', hostTownId: 'host',
        homeDeploymentEpoch: 1, hostDeploymentEpoch: 1, agentAuthorityEpoch: 2,
        visitLeaseVersion: 1, leaseExpiry: Date.now() + 300000, fencingToken: 'unused',
        state: 'ACTIVE', role: 'home', profile: {}, createdAt: Date.now(), updatedAt: Date.now(),
      });
      await ctx.db.insert('federationAgentRuntimes', {
        worldId, playerId: 'p:0', agentId: 'a:1', agentGlobalId: 'home/agent:1',
        homeTownId: 'home', state: 'TRAVELING', visitId: 'visit', agentAuthorityEpoch: 2,
        activeDecisionId: 'event', updatedAt: Date.now(),
      });
      return ctx.db.insert('federationDecisionJobs', {
        visitId: 'visit', eventId: 'event', observation: { turnId: 'turn', conversation: null },
        state: 'RUNNING', createdAt: Date.now(), deadline: Date.now() + (state === 'EXPIRED' ? 500 : 300000),
      });
    });
    jest.setSystemTime(Date.now() + 1733);
    const args = { jobId, ...(state === 'FAILED' ? { error: 'MODEL_UNAVAILABLE' } : { action: { type: 'wait' } }) };
    await t.mutation(mutationRef('decision/finish'), args);
    await t.mutation(mutationRef('decision/finish'), args);
    expect((await t.run(ctx => ctx.db.get(jobId)))?.state).toBe(state);
    const stats = await t.run(ctx => resourceMeasurements(ctx.db));
    expect(state === 'COMMITTED' ? stats.decision : stats.failedDecision)
      .toMatchObject({ count: 1, durationCount: 1, meanMs: 1733, p95Ms: 1733 });
    expect(state === 'COMMITTED' ? stats.failedDecision.count : stats.decision.count).toBe(0);
    expect(await t.run(ctx => ctx.db.query('federationOutbox').collect()))
      .toHaveLength(state === 'COMMITTED' ? 1 : 0);
  },
);
