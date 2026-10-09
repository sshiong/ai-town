import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { createIdentityKeys, randomSecret, sealSecret } from './security';
import { considerAutonomousTravel, parseTravelChoice, validatePolicy } from './autonomy';
import { GameId } from '../aiTown/ids';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/autonomy.ts': () => import('./autonomy'),
  '../federation/resources.ts': () => import('./resources'),
  '../federation/decision.ts': () => import('./decision'),
  '../models/profiles.ts': () => import('../models/profiles'),
  '../models/embeddings.ts': () => import('../models/embeddings'),
};
const adminToken = 'autonomous-travel-test-admin';
const agentGlobalId = 'home/agent:alice';
const playerId = 'p:0' as GameId<'players'>;
const agentId = 'a:1' as GameId<'agents'>;
const policy = {
  enabled: true,
  allowedPeerTownIds: ['host'],
  decisionIntervalMs: 60_000,
  dailyRequestLimit: 2,
  operator: 'test operator',
  reason: 'Explicitly authorize this resident.',
};
async function setup() {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = randomSecret();
  const keys = await createIdentityKeys(),
    credentialEncrypted = await sealSecret(randomSecret());
  const t = convexTest(schema, modules);
  const created = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 10,
      conversations: [],
      players: [
        {
          id: playerId,
          lastInput: Date.now(),
          position: { x: 2, y: 2 },
          facing: { dx: 1, dy: 0 },
          speed: 0,
        },
      ],
      agents: [
        {
          id: agentId,
          playerId,
          inProgressOperation: {
            name: 'agentDoSomething',
            operationId: 'o:7',
            started: Date.now(),
          },
        },
      ],
    });
    const engineId = await ctx.db.insert('engines', { running: true, generationNumber: 0 });
    await ctx.db.insert('worldStatus', {
      worldId,
      engineId,
      isDefault: true,
      lastViewed: Date.now(),
      status: 'running',
    });
    await ctx.db.insert('playerDescriptions', {
      worldId,
      playerId,
      name: 'Alice',
      character: 'f1',
      description: 'Resident',
    });
    await ctx.db.insert('agentDescriptions', {
      worldId,
      agentId,
      identity: 'Alice enjoys visiting friends.',
      plan: 'Meet a neighbor.',
    });
    const runtimeId = await ctx.db.insert('federationAgentRuntimes', {
      agentGlobalId,
      homeTownId: 'home',
      worldId,
      playerId,
      agentId,
      state: 'HOME_ACTIVE',
      agentAuthorityEpoch: 1,
      updatedAt: Date.now(),
    });
    const identityId = await ctx.db.insert('federationIdentity', {
      ...keys,
      townId: 'home',
      townName: 'Home',
      endpoint: 'https://home.example/federation/v1',
      deploymentInstanceId: 'home-instance',
      deploymentEpoch: 1,
      enabled: true,
      allowIncomingPairRequests: true,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 2,
      maxVisitDurationMs: 300000,
      mode: 'ACTIVE',
      createdAt: Date.now(),
    });
    const peerId = await ctx.db.insert('federationPeers', {
      townId: 'host',
      townName: 'Host',
      publicKey: keys.publicKey,
      fingerprint: keys.fingerprint,
      deploymentInstanceId: 'host-instance',
      deploymentEpoch: 1,
      endpoint: 'https://host.example/federation/v1',
      credentialId: 'pair',
      credentialEncrypted,
      trustState: 'TRUSTED',
      inboundVisitsAllowed: true,
      outboundVisitsAllowed: true,
      pairedAt: Date.now(),
    });
    const connectionId = await ctx.db.insert('transportSessions', {
      peerTownId: 'host',
      channelState: 'TRANSPORT_READY',
      transportType: 'DIRECT_HTTPS',
      localDeploymentEpoch: 1,
      verifiedPeerDeploymentEpoch: 1,
      outboundVerifiedAt: Date.now(),
      inboundVerifiedAt: Date.now(),
      lastReadyAt: Date.now(),
    });
    const chatId = await ctx.db.insert('chatProfiles', {
      name: 'Fixed original model',
      provider: 'ollama',
      url: 'http://model.example',
      model: 'fixed-resident-model',
      reasoningEffort: 'none',
      stopWords: [],
      createdAt: Date.now(),
    });
    await ctx.db.insert('residentModelBindings', {
      worldId,
      playerId,
      agentGlobalId,
      chatProfileId: chatId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert('modelSettings', { key: 'town', mainChatProfileId: chatId });
    return { worldId, identityId, peerId, connectionId, runtimeId, chatId };
  });
  const operation = { worldId: created.worldId, playerId, agentId, operationId: 'o:7' };
  const configure = (override: Partial<typeof policy> = {}) =>
    t.mutation(api.federation.autonomy.configure, {
      adminToken,
      agentGlobalId,
      ...policy,
      ...override,
    });
  return { t, ...created, operation, configure };
}
beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick'] }));
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('default residents keep local behavior and explicit policies reject invalid or unknown authorization', async () => {
  const { t, operation, configure } = await setup();
  expect(await t.mutation(internal.federation.autonomy.claim, operation)).toBeNull();
  await expect(configure({ allowedPeerTownIds: ['unknown'] })).rejects.toThrow(
    'AUTONOMOUS_DESTINATION_NOT_TRUSTED',
  );
  expect(() => validatePolicy({ ...policy, dailyRequestLimit: 25 })).toThrow();
  expect(() => validatePolicy({ ...policy, decisionIntervalMs: 1 })).toThrow();
  expect(() => validatePolicy({ ...policy, allowedPeerTownIds: ['host', 'host'] })).toThrow();
  expect(() =>
    parseTravelChoice('{"type":"visit","townId":"unknown","reason":"go"}', ['host']),
  ).toThrow();
  expect(parseTravelChoice('{"type":"stay","reason":"I prefer home."}', ['host']).type).toBe(
    'stay',
  );
});

test('a real parsed model choice starts the ordinary exclusive Saga once and keeps the fixed model', async () => {
  const { t, configure, operation, chatId } = await setup();
  await configure();
  const job = await t.mutation(internal.federation.autonomy.claim, operation);
  expect(job?.candidates).toEqual([{ townId: 'host', townName: 'Host' }]);
  expect(await t.mutation(internal.federation.autonomy.claim, operation)).toBeNull();
  expect(
    await t.mutation(internal.federation.autonomy.finish, {
      jobId: job!.jobId,
      choice: '{"type":"visit","townId":"host","reason":"Meet a neighbor."}',
    }),
  ).toBe(true);
  expect(
    await t.mutation(internal.federation.autonomy.finish, {
      jobId: job!.jobId,
      choice: '{"type":"visit","townId":"host","reason":"Duplicate."}',
    }),
  ).toBe(false);
  const state = await t.run(async (ctx) => ({
    visits: await ctx.db.query('visitLedger').collect(),
    outbox: await ctx.db.query('federationOutbox').collect(),
    runtime: await ctx.db.query('federationAgentRuntimes').unique(),
    binding: await ctx.db.query('residentModelBindings').unique(),
  }));
  expect(state.visits).toHaveLength(1);
  expect(state.outbox.map((o) => o.envelope.type)).toEqual(['VISIT_RESERVE']);
  expect(state.runtime?.state).toBe('TRAVEL_PREPARING');
  expect(state.binding?.chatProfileId).toBe(chatId);
});

test('revoking a policy while inference runs prevents a late choice from starting a visit', async () => {
  const { t, configure, operation } = await setup();
  await configure();
  const job = await t.mutation(internal.federation.autonomy.claim, operation);
  await configure({ enabled: false });
  expect(
    await t.mutation(internal.federation.autonomy.finish, {
      jobId: job!.jobId,
      choice: '{"type":"visit","townId":"host","reason":"Late reply."}',
    }),
  ).toBe(false);
  expect(await t.run((ctx) => ctx.db.query('visitLedger').collect())).toEqual([]);
  expect((await t.run((ctx) => ctx.db.get(job!.jobId)))?.state).toBe('STALE');
});

test('current conversation, stale operation, paused world and quarantined identity never claim a second brain', async () => {
  const { t, configure, operation, identityId, worldId } = await setup();
  await configure();
  expect(
    await t.mutation(internal.federation.autonomy.claim, { ...operation, operationId: 'o:old' }),
  ).toBeNull();
  await t.run(async (ctx) => {
    const world = (await ctx.db.get(worldId))!;
    await ctx.db.patch(worldId, {
      conversations: [
        {
          id: 'c:9',
          creator: playerId,
          created: Date.now(),
          numMessages: 0,
          participants: [
            {
              playerId,
              invited: Date.now(),
              status: { kind: 'participating', started: Date.now() },
            },
          ],
        },
      ],
    });
    expect(world.agents).toHaveLength(1);
  });
  expect(await t.mutation(internal.federation.autonomy.claim, operation)).toBeNull();
  await t.run(async (ctx) => {
    await ctx.db.patch(worldId, { conversations: [] });
    const status = (await ctx.db.query('worldStatus').unique())!;
    await ctx.db.patch(status._id, { status: 'stoppedByDeveloper' });
  });
  expect(await t.mutation(internal.federation.autonomy.claim, operation)).toBeNull();
  await t.run(async (ctx) => {
    const status = (await ctx.db.query('worldStatus').unique())!;
    await ctx.db.patch(status._id, { status: 'running' });
    await ctx.db.patch(identityId, { mode: 'QUARANTINED' });
  });
  expect(await t.mutation(internal.federation.autonomy.claim, operation)).toBeNull();
});

test('rolling request quota includes refused manual visits and blocks another autonomous request', async () => {
  const { t, configure, operation, worldId } = await setup();
  await configure({ dailyRequestLimit: 1 });
  await t.run((ctx) =>
    ctx.db.insert('visitLedger', {
      visitId: 'manual-refused',
      agentGlobalId,
      homeTownId: 'home',
      hostTownId: 'host',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      leaseExpiry: Date.now() - 1,
      fencingToken: 'fence',
      state: 'REJECTED',
      role: 'home',
      worldId,
      homePlayerId: playerId,
      profile: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  expect(await t.mutation(internal.federation.autonomy.claim, operation)).toBeNull();
});

test('disconnected destination after inference remains rejected by the real admission transaction', async () => {
  const { t, configure, operation, connectionId } = await setup();
  await configure();
  const job = await t.mutation(internal.federation.autonomy.claim, operation);
  await t.run((ctx) => ctx.db.patch(connectionId, { channelState: 'TRANSPORT_DEGRADED' }));
  await expect(
    t.mutation(internal.federation.autonomy.finish, {
      jobId: job!.jobId,
      choice: '{"type":"visit","townId":"host","reason":"Meet someone."}',
    }),
  ).rejects.toThrow('DIRECT_PEER_NOT_MUTUALLY_REACHABLE');
  expect(await t.run((ctx) => ctx.db.query('visitLedger').collect())).toEqual([]);
});

test('resident model inference chooses stay explicitly; provider failure creates FAILED instead of a fictional choice', async () => {
  const { t, configure, operation } = await setup();
  await configure();
  const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"type":"stay","reason":"I want to finish my plans at Home."}',
            },
          },
        ],
      }),
    ),
  );
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await t.action((ctx) => considerAutonomousTravel(ctx, operation))).toBe(false);
  expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({
    model: 'fixed-resident-model',
    reasoning_effort: 'none',
  });
  expect((await t.run((ctx) => ctx.db.query('autonomousTravelDecisions').unique()))?.state).toBe(
    'STAY',
  );
  await t.run(async (ctx) => {
    const p = (await ctx.db.query('autonomousTravelPolicies').unique())!;
    await ctx.db.patch(p._id, { nextDecisionAt: 0 });
  });
  request.mockResolvedValue(new Response('unavailable', { status: 400 }));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  expect(await t.action((ctx) => considerAutonomousTravel(ctx, operation))).toBe(false);
  expect(
    (await t.run((ctx) => ctx.db.query('autonomousTravelDecisions').order('desc').first()))?.state,
  ).toBe('FAILED');
  expect(await t.run((ctx) => ctx.db.query('visitLedger').collect())).toEqual([]);
});

test('expired model results cannot acquire travel authority or queue a visit', async () => {
  const { t, configure, operation } = await setup();
  await configure();
  const job = await t.mutation(internal.federation.autonomy.claim, operation);
  jest.advanceTimersByTime(90_001);
  expect(
    await t.mutation(internal.federation.autonomy.finish, {
      jobId: job!.jobId,
      choice: '{"type":"visit","townId":"host","reason":"Late decision."}',
    }),
  ).toBe(false);
  expect((await t.run((ctx) => ctx.db.query('autonomousTravelDecisions').unique()))?.state).toBe(
    'EXPIRED',
  );
  expect(await t.run((ctx) => ctx.db.query('visitLedger').collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query('federationOutbox').collect())).toEqual([]);
});

test('a zero decision budget preserves local activity without creating an autonomous job', async () => {
  const { t, configure, operation, identityId } = await setup();
  await configure();
  await t.run((ctx) =>
    ctx.db.patch(identityId, {
      resourceLimits: {
        maxResidentAgents: 100,
        maxHumanPlayers: 1,
        maxVisitReservations: 100,
        maxConcurrentLocalLLM: 2,
        maxPendingDecisions: 0,
        maxPendingLocalLLM: 100,
      },
    }),
  );
  expect(await t.mutation(internal.federation.autonomy.claim, operation)).toBeNull();
  expect(await t.run((ctx) => ctx.db.query('autonomousTravelDecisions').collect())).toEqual([]);
});
