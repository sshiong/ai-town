import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { mutationRef } from './refs';
import { DEFAULT_RESOURCE_LIMITS } from './resources';
import { Id } from '../_generated/dataModel';
import { nextChatRequest } from './chatScheduling';
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/resources.ts': () => import('./resources'),
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_000_000);
});
afterEach(() => jest.useRealTimers());
async function fixture(count = 3, maxPending = 30) {
  const t = convexTest(schema, modules);
  await t.run((ctx) =>
    ctx.db.insert('federationIdentity', {
      townId: 'home',
      townName: 'Home',
      publicKey: 'unused',
      privateKeyEncrypted: 'unused',
      fingerprint: 'unused',
      deploymentInstanceId: 'home-instance',
      deploymentEpoch: 1,
      endpoint: 'https://home.example/federation/v1',
      enabled: true,
      allowIncomingPairRequests: false,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 8,
      maxVisitDurationMs: 300000,
      mode: 'ACTIVE',
      createdAt: 1,
      resourceLimits: {
        ...DEFAULT_RESOURCE_LIMITS,
        maxConcurrentLocalLLM: 1,
        maxPendingLocalLLM: maxPending,
      },
    }),
  );
  const worldId = await t.run((ctx) =>
    ctx.db.insert('worlds', { nextId: 100, players: [], agents: [], conversations: [] }),
  );
  const sources = Array.from({ length: count }, (_, i) => `town-${i.toString().padStart(2, '0')}`);
  for (const townId of sources)
    await t.run((ctx) =>
      ctx.db.insert('federationPeers', {
        townId,
        townName: townId,
        publicKey: 'unused',
        fingerprint: 'unused',
        endpoint: `https://${townId}.example/federation/v1`,
        deploymentInstanceId: `${townId}-instance`,
        deploymentEpoch: 1,
        credentialId: `credential-${townId}`,
        credentialEncrypted: 'unused',
        trustState: 'TRUSTED',
        inboundVisitsAllowed: true,
        outboundVisitsAllowed: true,
        pairedAt: 1,
      }),
    );
  let next = 0;
  async function job(source: string) {
    return t.run(async (ctx) => {
      const n = next++,
        visitId = `visit-${n}`,
        eventId = `event-${n}`,
        globalId = `home/agent:${worldId}:a:${n}`;
      await ctx.db.insert('visitLedger', {
        visitId,
        agentGlobalId: globalId,
        homeTownId: 'home',
        hostTownId: source,
        homeDeploymentEpoch: 1,
        hostDeploymentEpoch: 1,
        agentAuthorityEpoch: 1,
        visitLeaseVersion: 1,
        leaseExpiry: Date.now() + 90000,
        fencingToken: 'fixture',
        state: 'ACTIVE',
        role: 'home',
        profile: {},
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('federationAgentRuntimes', {
        agentGlobalId: globalId,
        homeTownId: 'home',
        worldId,
        playerId: `p:${n}`,
        agentId: `a:${n}`,
        state: 'TRAVELING',
        visitId,
        agentAuthorityEpoch: 1,
        activeDecisionId: eventId,
        updatedAt: 1,
      });
      return ctx.db.insert('federationDecisionJobs', {
        visitId,
        eventId,
        observation: {},
        state: 'RUNNING',
        createdAt: Date.now(),
        deadline: Date.now() + 90000,
      });
    });
  }
  const enqueue = (decisionJobId?: Id<'federationDecisionJobs'>) =>
    t.mutation(mutationRef('resources/enqueueChat'), {
      deadline: Date.now() + 90000,
      ...(decisionJobId ? { decisionJobId } : {}),
    }) as Promise<Id<'federationLlmRequests'>>;
  const claim = (requestId: Id<'federationLlmRequests'>) =>
    t.mutation(mutationRef('resources/claimChat'), { requestId });
  const release = (requestId: Id<'federationLlmRequests'>) =>
    t.mutation(mutationRef('resources/releaseChat'), { requestId });
  return { t, sources, job, enqueue, claim, release };
}
test.each([3, 10])(
  '%i authenticated Host sources and local memory work receive bounded turns, preserving source FIFO',
  async (count) => {
    const f = await fixture(count, 100),
      active = await f.enqueue();
    const local1 = await f.enqueue(),
      local2 = await f.enqueue();
    const requests = [];
    for (const source of f.sources) {
      const first = await f.enqueue(await f.job(source)),
        second = await f.enqueue(await f.job(source));
      requests.push({ source, first, second });
    }
    await f.release(active);
    for (const row of requests) {
      expect(await f.claim(row.second)).toBe(false);
      expect(await f.claim(row.first)).toBe(true);
      await f.release(row.first);
    }
    expect(await f.claim(local2)).toBe(false);
    expect(await f.claim(local1)).toBe(true);
    await f.release(local1);
    for (const row of requests) {
      expect(await f.claim(row.second)).toBe(true);
      await f.release(row.second);
    }
    expect(await f.claim(local2)).toBe(true);
    const cursor = await f.t.run((ctx) => ctx.db.query('federationChatScheduling').collect());
    expect(cursor).toHaveLength(1);
  },
);
test('a source cannot fill all waiting slots before another Host or local resident can enqueue', async () => {
  const f = await fixture(2, 6),
    active = await f.enqueue();
  await f.enqueue(await f.job(f.sources[0]));
  await f.enqueue(await f.job(f.sources[0]));
  await expect(f.enqueue(await f.job(f.sources[0]))).rejects.toThrow('LOCAL_LLM_SOURCE_QUEUE_FULL');
  await expect(f.enqueue(await f.job(f.sources[1]))).resolves.toEqual(expect.any(String));
  await expect(f.enqueue()).resolves.toEqual(expect.any(String));
  expect(await f.claim(active)).toBe(true);
});
test('claimed job, Home ownership, active visit and current trust determine source; fake labels are rejected', async () => {
  const f = await fixture(1),
    jobId = await f.job(f.sources[0]);
  await f.t.run((ctx) => ctx.db.patch(jobId, { state: 'PENDING' }));
  await expect(f.enqueue(jobId)).rejects.toThrow('CHAT_SOURCE_AUTHORITY_EXPIRED');
  await f.t.run((ctx) => ctx.db.patch(jobId, { state: 'RUNNING' }));
  await expect(
    f.t.mutation(mutationRef('resources/enqueueChat'), {
      deadline: Date.now() + 90000,
      sourceKey: 'host:spoof',
    }),
  ).rejects.toThrow();
  const request = await f.enqueue(jobId);
  const row = await f.t.run((ctx) => ctx.db.get(request));
  expect(row?.sourceKey).toBe(`host:${f.sources[0]}`);
  await f.t.run(async (ctx) => {
    const peer = await ctx.db.query('federationPeers').unique();
    await ctx.db.patch(peer!._id, { trustState: 'UNTRUSTED' });
  });
  await expect(f.claim(request)).rejects.toThrow('CHAT_SOURCE_AUTHORITY_EXPIRED');
});
test('the round-robin cursor survives reloading a backend and legacy requests remain local FIFO', async () => {
  const f = await fixture(1);
  const a = await f.enqueue(),
    b = await f.enqueue();
  await f.release(a);
  const rows = await f.t.run(async (ctx) => ({
    requests: await ctx.db.query('federationLlmRequests').collect(),
    cursor: await ctx.db.query('federationChatScheduling').unique(),
  }));
  const restarted = convexTest(schema, modules);
  const ids = await restarted.run(async (ctx) => {
    await ctx.db.insert('federationChatScheduling', {
      key: rows.cursor!.key,
      lastSource: rows.cursor!.lastSource,
      updatedAt: rows.cursor!.updatedAt,
    });
    const ids = [];
    for (const { _id, _creationTime, sourceKey, decisionJobId, ...legacy } of rows.requests)
      ids.push(await ctx.db.insert('federationLlmRequests', legacy));
    return ids;
  });
  expect(ids).toHaveLength(1);
  expect(await restarted.mutation(mutationRef('resources/claimChat'), { requestId: ids[0] })).toBe(
    true,
  );
  expect(await f.claim(b)).toBe(true);
});
test('source round-robin does not renew an absolute queue deadline or reclaim an active HTTP permit early', async () => {
  const f = await fixture(1);
  const active = await f.enqueue(),
    waiting = await f.enqueue(await f.job(f.sources[0]));
  jest.advanceTimersByTime(30001);
  await expect(f.claim(waiting)).rejects.toThrow('LOCAL_LLM_QUEUE_TIMEOUT');
  expect(await f.claim(active)).toBe(true);
  await f.release(active);
  await f.release(waiting);
  expect(await f.t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
});

test('a restored source cursor advances past the previously served Host, instead of restarting at the earliest Host', async () => {
  const original = convexTest(schema, modules);
  await original.run(async (ctx) => {
    await ctx.db.insert('federationChatScheduling', {
      key: 'local',
      lastSource: 'host:town-00',
      updatedAt: Date.now(),
    });
    for (const sourceKey of ['host:town-00', 'host:town-01', 'local'])
      await ctx.db.insert('federationLlmRequests', {
        sourceKey,
        state: 'PENDING',
        createdAt: Date.now(),
        deadline: Date.now() + 90000,
        queueDeadline: Date.now() + 30000,
        expiresAt: Date.now() + 30000,
      });
  });
  const snapshot = await original.run(async (ctx) => ({
    cursor: await ctx.db.query('federationChatScheduling').unique(),
    queue: await ctx.db.query('federationLlmRequests').collect(),
  }));
  const restarted = convexTest(schema, modules);
  await restarted.run(async (ctx) => {
    const { _id, _creationTime, ...cursor } = snapshot.cursor!;
    await ctx.db.insert('federationChatScheduling', cursor);
    for (const { _id, _creationTime, ...row } of snapshot.queue)
      await ctx.db.insert('federationLlmRequests', row);
  });
  const next = await restarted.run(async (ctx) =>
    nextChatRequest(
      ctx,
      await ctx.db
        .query('federationLlmRequests')
        .withIndex('state_created', (q) => q.eq('state', 'PENDING'))
        .collect(),
    ),
  );
  expect(next?.sourceKey).toBe('host:town-01');
});
