import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { recordResourceMetric, resourceMeasurements } from './resourceMonitoring';
import { mutationRef } from './refs';
import { residentChatCompletion } from './resources';
import { webcrypto } from 'node:crypto';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/resources.ts': () => import('./resources'),
  '../federation/decision.ts': () => import('./decision'),
};
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1_000_000); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

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
