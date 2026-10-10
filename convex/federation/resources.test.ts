import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { Game } from '../aiTown/game';
import { Player } from '../aiTown/player';
import { tickRemoteVisitor } from './remoteTick';
import { Id } from '../_generated/dataModel';
import { DEFAULT_RESOURCE_LIMITS, ResourceLimits, residentChatCompletion } from './resources';
import { mutationRef, queryRef } from './refs';
import { dispatchLedgerMessage, homeResumed } from './ledger';
import { dispatchRuntimeMessage } from './runtime';
import { FederationMessage, PROTOCOL } from './protocol';
import { validateResourcePolicy } from './backupHelpers';
import { consumeRemoteEventBudget } from './resourceMonitoring';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/resources.ts': () => import('./resources'),
  '../federation/resourceMonitoring.ts': () => import('./resourceMonitoring'),
  '../federation/peers.ts': () => import('./peers'),
  '../federation/admin.ts': () => import('./admin'),
  '../federation/decision.ts': () => import('./decision'),
  '../federation/transport.ts': () => import('./transport'),
  '../aiTown/main.ts': () => import('../aiTown/main'),
  '../aiTown/game.ts': () => import('../aiTown/game'),
};
const adminToken = 'resource-limits-test-admin-token';
const map = {
  width: 16,
  height: 16,
  tileSetUrl: '/tiles.png',
  tileSetDimX: 16,
  tileSetDimY: 16,
  tileDim: 1,
  bgTiles: [],
  objectTiles: [Array.from({ length: 16 }, () => Array(16).fill(-1))],
  animatedSprites: [],
};
async function setup(overrides: Partial<ResourceLimits> = {}) {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  const t = convexTest(schema, modules);
  const identityId = await t.run((ctx) =>
    ctx.db.insert('federationIdentity', {
      townId: 'host',
      townName: 'Host',
      endpoint: 'https://host.example/federation/v1',
      publicKey: 'unused',
      privateKeyEncrypted: 'unused',
      fingerprint: 'unused',
      deploymentInstanceId: 'host-instance',
      deploymentEpoch: 1,
      enabled: true,
      allowIncomingPairRequests: true,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 8,
      maxVisitDurationMs: 300000,
      mode: 'ACTIVE',
      createdAt: Date.now(),
      resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, ...overrides },
    }),
  );
  return { t, identityId };
}
async function world(t: Awaited<ReturnType<typeof setup>>['t'], resident = false) {
  return t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 10,
      agents: resident ? [{ id: 'a:1', playerId: 'p:0' }] : [],
      players: resident
        ? [
            {
              id: 'p:0',
              lastInput: Date.now(),
              position: { x: 2, y: 2 },
              facing: { dx: 1, dy: 0 },
              speed: 0,
            },
          ]
        : [],
      conversations: [],
    });
    const engineId = await ctx.db.insert('engines', { running: true, generationNumber: 0 });
    await ctx.db.insert('worldStatus', {
      worldId,
      engineId,
      isDefault: true,
      lastViewed: Date.now(),
      status: 'running',
    });
    await ctx.db.insert('maps', { worldId, ...map });
    return worldId;
  });
}
async function load(t: Awaited<ReturnType<typeof setup>>['t'], worldId: Id<'worlds'>) {
  const data = await t.run((ctx) => Game.load(ctx.db, worldId, 0));
  return new Game(data.engine, worldId, data.gameState);
}
const enqueue = (t: Awaited<ReturnType<typeof setup>>['t']) =>
  t.mutation(mutationRef('resources/enqueueChat'), { deadline: Date.now() + 90000 });
const claim = (t: Awaited<ReturnType<typeof setup>>['t'], requestId: Id<'federationLlmRequests'>) =>
  t.mutation(mutationRef('resources/claimChat'), { requestId });
const release = (
  t: Awaited<ReturnType<typeof setup>>['t'],
  requestId: Id<'federationLlmRequests'>,
) => t.mutation(mutationRef('resources/releaseChat'), { requestId });
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('configuration requires admin and validates all independent limits without removing current residents', async () => {
  const { t } = await setup();
  const worldId = await world(t, true);
  const configure = mutationRef('admin/configureResources');
  await expect(
    t.mutation(configure, { adminToken: 'invalid', limits: DEFAULT_RESOURCE_LIMITS }),
  ).rejects.toThrow();
  for (const [key, value] of [
    ['maxResidentAgents', -1],
    ['maxHumanPlayers', 1.5],
    ['maxVisitReservations', 1001],
    ['maxConcurrentLocalLLM', 33],
    ['maxPendingDecisions', Infinity],
  ])
    await expect(
      t.mutation(configure, { adminToken, limits: { ...DEFAULT_RESOURCE_LIMITS, [key]: value } }),
    ).rejects.toThrow('INVALID_RESOURCE_LIMIT');
  const limits = {
    ...DEFAULT_RESOURCE_LIMITS,
    maxResidentAgents: 0,
    maxHumanPlayers: 0,
    maxConcurrentLocalLLM: 0,
  };
  await t.mutation(configure, { adminToken, limits });
  const status = await t.query(queryRef('admin/status'), { adminToken });
  expect(status.resources).toMatchObject({
    limits,
    residents: 1,
    admissionState: 'DEGRADED',
    cpu: null,
    memory: null,
  });
  const game = await load(t, worldId);
  expect(() => game.handleInput(Date.now(), 'createAgent', { descriptionIndex: 0 })).toThrow(
    'RESIDENT_CAPACITY_EXCEEDED',
  );
  expect(game.world.agents.size).toBe(1);
  expect(() => Player.join(game, Date.now(), 'Human', 'f1', 'Human', 'user')).toThrow(
    'Only 0 human',
  );
});

test('resident capacity counts traveling agents and residents in other worlds while visitors use no resident slots', async () => {
  const { t } = await setup({ maxResidentAgents: 1 });
  const home = await world(t, true),
    destination = await world(t);
  await t.run(async (ctx) => {
    const current = (await ctx.db.get(home))!;
    await ctx.db.patch(home, {
      agents: current.agents.map((a) => ({ ...a, travelVisitId: 'traveling' })),
    });
  });
  const game = await load(t, destination);
  expect(game.otherResidents).toBe(1);
  expect(() => game.handleInput(Date.now(), 'createAgent', { descriptionIndex: 0 })).toThrow(
    'RESIDENT_CAPACITY_EXCEEDED',
  );
  expect(() =>
    game.handleInput(Date.now(), 'federationCreateVisitor', {
      name: 'Guest',
      character: 'f1',
      description: 'Guest',
      visitor: {
        visitId: 'guest',
        agentGlobalId: 'remote/agent:guest',
        homeTownId: 'remote',
        homeTownName: 'Remote',
        agentAuthorityEpoch: 1,
        visitLeaseVersion: 1,
        leaseExpiry: Date.now() + 90000,
        lastObservationAt: 0,
      },
    }),
  ).not.toThrow();
  expect(game.world.agents.size).toBe(0);
});

test('a stale engine action cannot commit new residents past the town budget', async () => {
  const { t } = await setup({ maxResidentAgents: 1 });
  const first = await world(t),
    second = await world(t);
  const gameA = await load(t, first),
    gameB = await load(t, second);
  gameA.handleInput(Date.now(), 'createAgent', { descriptionIndex: 0 });
  gameB.handleInput(Date.now(), 'createAgent', { descriptionIndex: 0 });
  await t.run((ctx) => Game.saveDiff(ctx, first, gameA.takeDiff()));
  await expect(t.run((ctx) => Game.saveDiff(ctx, second, gameB.takeDiff()))).rejects.toThrow(
    'resourceBudgetChanged',
  );
  expect((await t.run((ctx) => ctx.db.get(second)))?.agents).toEqual([]);
  const fresh = await load(t, second);
  expect(() => fresh.handleInput(Date.now(), 'createAgent', { descriptionIndex: 0 })).toThrow(
    'RESIDENT_CAPACITY_EXCEEDED',
  );
});

test('human capacity is shared across worlds and stale human joins cannot commit over capacity', async () => {
  const { t } = await setup({ maxHumanPlayers: 1 });
  const first = await world(t),
    second = await world(t);
  const gameA = await load(t, first),
    gameB = await load(t, second);
  Player.join(gameA, Date.now(), 'Human A', 'f1', 'Human', 'user-a');
  Player.join(gameB, Date.now(), 'Human B', 'f1', 'Human', 'user-b');
  await t.run((ctx) => Game.saveDiff(ctx, first, gameA.takeDiff()));
  await expect(t.run((ctx) => Game.saveDiff(ctx, second, gameB.takeDiff()))).rejects.toThrow(
    'resourceBudgetChanged',
  );
  const fresh = await load(t, second);
  expect(() => Player.join(fresh, Date.now(), 'Human B', 'f1', 'Human', 'user-b')).toThrow(
    'Only 1 human',
  );
  const status = await t.query(queryRef('admin/status'), { adminToken });
  expect(status.resources.humans).toBe(1);
  expect(status.resources.residents).toBe(0);
});

test('Host pending budget stops new observations while keeping visitor bodies and local residents', async () => {
  const { t } = await setup({ maxPendingDecisions: 1 });
  const worldId = await world(t, true),
    game = await load(t, worldId);
  for (let index = 0; index < 2; index++) {
    game.handleInput(Date.now(), 'federationCreateVisitor', {
      name: 'Guest',
      character: 'f1',
      description: 'Guest',
      visitor: {
        visitId: `visitor-${index}`,
        agentGlobalId: `remote/agent:${index}`,
        homeTownId: 'remote',
        homeTownName: 'Remote',
        agentAuthorityEpoch: 1,
        visitLeaseVersion: 1,
        leaseExpiry: Date.now() + 90000,
        lastObservationAt: 0,
      },
    });
  }
  for (const player of game.world.players.values()) tickRemoteVisitor(game, Date.now(), player);
  expect(
    [...game.world.players.values()].filter((player) => player.remoteVisitor?.pendingTurn),
  ).toHaveLength(1);
  expect(game.world.players.size).toBe(3);
  expect(game.world.agents.size).toBe(1);
});

test('Chat permits bound simultaneous workers, limit the queue, and promote pending requests in FIFO order', async () => {
  const { t } = await setup({ maxConcurrentLocalLLM: 1, maxPendingLocalLLM: 2 });
  const first = await enqueue(t);
  await jest.advanceTimersByTimeAsync(1);
  const second = await enqueue(t);
  await jest.advanceTimersByTimeAsync(1);
  const third = await enqueue(t);
  await expect(enqueue(t)).rejects.toThrow('LOCAL_LLM_QUEUE_FULL');
  expect(await claim(t, first)).toBe(true);
  expect(await claim(t, second)).toBe(false);
  await release(t, first);
  expect(await claim(t, third)).toBe(false);
  expect(await claim(t, second)).toBe(true);
  expect(await claim(t, third)).toBe(false);
  await release(t, second);
  expect(await claim(t, third)).toBe(true);
  await release(t, third);
  await release(t, third);
  expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
});

test('Chat zero queue permits immediate work and reducing concurrency never revokes an active request', async () => {
  const { t } = await setup({ maxConcurrentLocalLLM: 1, maxPendingLocalLLM: 0 });
  const active = await enqueue(t);
  await expect(enqueue(t)).rejects.toThrow('LOCAL_LLM_QUEUE_FULL');
  await t.mutation(mutationRef('admin/configureResources'), {
    adminToken,
    limits: { ...DEFAULT_RESOURCE_LIMITS, maxConcurrentLocalLLM: 0 },
  });
  expect(await claim(t, active)).toBe(true);
  await expect(enqueue(t)).rejects.toThrow('LOCAL_LLM_PAUSED');
  await release(t, active);
});

test('abandoned queue entries expire and permits are reclaimed only after the HTTP deadline plus grace', async () => {
  const { t } = await setup({ maxConcurrentLocalLLM: 1, maxPendingLocalLLM: 1 });
  const active = await enqueue(t),
    stalePending = await enqueue(t);
  await jest.advanceTimersByTimeAsync(30001);
  await expect(claim(t, stalePending)).rejects.toThrow('LOCAL_LLM_QUEUE_TIMEOUT');
  const pending = await enqueue(t);
  expect(await t.run((ctx) => ctx.db.get(stalePending))).toBeNull();
  await jest.advanceTimersByTimeAsync(60000);
  expect(await claim(t, pending).catch(() => false)).toBe(false);
  const beforeGrace = await enqueue(t);
  expect(await claim(t, beforeGrace)).toBe(false);
  expect(await t.run((ctx) => ctx.db.get(active))).not.toBeNull();
  await jest.advanceTimersByTimeAsync(5000);
  expect(await claim(t, beforeGrace)).toBe(true);
  await release(t, beforeGrace);
  await enqueue(t);
  expect(await t.run((ctx) => ctx.db.get(active))).toBeNull();
});

test('resident Chat releases its shared permit after provider success or exception', async () => {
  const { t } = await setup({ maxConcurrentLocalLLM: 1 });
  const config = {
    provider: 'custom' as const,
    url: 'https://model.example',
    chatModel: 'fixed-model',
    stopWords: [],
  };
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] })),
    );
  const result = await t.action((ctx) =>
    residentChatCompletion(ctx, { messages: [{ role: 'user', content: 'hello' }] }, config),
  );
  expect(result.content).toBe('hello');
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe('fixed-model');
  expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content: '' } }] })),
  );
  await expect(
    t.action((ctx) =>
      residentChatCompletion(ctx, { messages: [{ role: 'user', content: 'hello' }] }, config),
    ),
  ).rejects.toThrow('EMPTY_CHAT_RESPONSE');
  expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
});

test('separate resident action workers share Chat concurrency and the next worker resumes after release', async () => {
  const { t } = await setup({ maxConcurrentLocalLLM: 1, maxPendingLocalLLM: 1 });
  let firstResponse!: (response: Response) => void;
  let signalStart!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStart = resolve;
  });
  let inFlight = 0,
    peak = 0,
    calls = 0;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    calls++;
    const response =
      calls === 1
        ? await new Promise<Response>((resolve) => {
            firstResponse = resolve;
            signalStart();
          })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'second' } }] }));
    inFlight--;
    return response;
  });
  const complete = () =>
    t.action((ctx) =>
      residentChatCompletion(
        ctx,
        { messages: [{ role: 'user', content: 'hello' }] },
        {
          provider: 'custom',
          url: 'https://model.example',
          chatModel: 'fixed-model',
          stopWords: [],
        },
      ),
    );
  const first = complete();
  await started;
  const second = complete();
  let pending = 0;
  for (let attempt = 0; attempt < 10 && !pending; attempt++)
    pending = (await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).filter(
      (request) => request.state === 'PENDING',
    ).length;
  expect(pending).toBe(1);
  expect(calls).toBe(1);
  firstResponse(new Response(JSON.stringify({ choices: [{ message: { content: 'first' } }] })));
  expect((await first).content).toBe('first');
  await jest.advanceTimersByTimeAsync(250);
  expect((await second).content).toBe('second');
  expect(peak).toBe(1);
  expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
});

test('resident Chat aborts a stalled provider at its deadline and releases its permit', async () => {
  const { t } = await setup({ maxConcurrentLocalLLM: 1 });
  let started!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    started();
    return new Promise<Response>((_resolve, reject) =>
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  });
  const completion = t
    .action((ctx) =>
      residentChatCompletion(
        ctx,
        { messages: [{ role: 'user', content: 'hello' }] },
        {
          provider: 'custom',
          url: 'https://model.example',
          chatModel: 'fixed-model',
          stopWords: [],
        },
        { deadline: Date.now() + 1000 },
      ),
    )
    .catch((error) => error);
  await fetchStarted;
  expect(
    (await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).filter(
      (request) => request.state === 'RUNNING',
    ),
  ).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1000);
  expect(String(await completion)).toContain('CHAT_REQUEST_DEADLINE');
  expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
});

test('resident Chat queue waiting is bounded and never contacts the provider while all permits are busy', async () => {
  const { t } = await setup({ maxConcurrentLocalLLM: 1, maxPendingLocalLLM: 1 });
  const active = await enqueue(t);
  const provider = jest.spyOn(globalThis, 'fetch');
  const completion = t
    .action((ctx) =>
      residentChatCompletion(
        ctx,
        { messages: [{ role: 'user', content: 'hello' }] },
        {
          provider: 'custom',
          url: 'https://model.example',
          chatModel: 'fixed-model',
          stopWords: [],
        },
      ),
    )
    .catch((error) => error);
  await jest.advanceTimersByTimeAsync(30001);
  expect(String(await completion)).toContain('LOCAL_LLM_QUEUE_TIMEOUT');
  expect(provider).not.toHaveBeenCalled();
  expect(
    (await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).map(
      (request) => request._id,
    ),
  ).toEqual([active]);
});

function reserveMessage(index: number): FederationMessage {
  return {
    protocol: PROTOCOL,
    messageId: `message-${index}`,
    fromTownId: 'home',
    toTownId: 'host',
    senderDeploymentInstanceId: 'home-instance',
    senderDeploymentEpoch: 1,
    expectedRecipientDeploymentEpoch: 1,
    type: 'VISIT_RESERVE',
    sentAt: Date.now(),
    expiresAt: Date.now() + 90000,
    nonce: `nonce-${index}`,
    credentialId: 'credential',
    sequence: 1,
    streamId: 'lease-control',
    visitId: `visit-${index}`,
    agentGlobalId: `home/agent:${index}`,
    agentAuthorityEpoch: 1,
    visitLeaseVersion: 1,
    payload: {
      fencingToken: 'test-fencing-token-long-enough',
      leaseExpiry: Date.now() + 90000,
      profile: { name: 'Guest', character: 'f1', description: 'Guest', homeTownName: 'Home' },
    },
  };
}
async function peer(t: Awaited<ReturnType<typeof setup>>['t'], townId = 'home') {
  await t.run(async (ctx) => {
    await ctx.db.insert('federationPeers', {
      townId,
      townName: 'Home',
      publicKey: 'unused',
      fingerprint: 'unused',
      deploymentInstanceId: 'home-instance',
      deploymentEpoch: 1,
      endpoint: 'https://home.example/federation/v1',
      credentialId: 'credential',
      credentialEncrypted: 'unused',
      trustState: 'TRUSTED',
      inboundVisitsAllowed: true,
      outboundVisitsAllowed: true,
      pairedAt: Date.now(),
    });
    await ctx.db.insert('transportSessions', {
      peerTownId: townId,
      channelState: 'TRANSPORT_READY',
      transportType: 'DIRECT_HTTPS',
      localDeploymentEpoch: 1,
      verifiedPeerDeploymentEpoch: 1,
      inboundVerifiedAt: Date.now(),
      outboundVerifiedAt: Date.now(),
    });
  });
}
test('reservation budget is independent of visitor slots and expired reservations do not consume it', async () => {
  const { t } = await setup({ maxVisitReservations: 1 });
  await peer(t);
  await t.run((ctx) => dispatchLedgerMessage(ctx, reserveMessage(1)));
  await t.run((ctx) => dispatchLedgerMessage(ctx, reserveMessage(2)));
  const ledgers = await t.run((ctx) => ctx.db.query('visitLedger').collect());
  expect(ledgers.find((l) => l.visitId === 'visit-1')?.state).toBe('RESERVED');
  expect(ledgers.find((l) => l.visitId === 'visit-2')?.lastError).toBe(
    'HOST_RESERVATION_CAPACITY_EXCEEDED',
  );
  jest.setSystemTime(Date.now() + 30001);
  await t.run((ctx) => dispatchLedgerMessage(ctx, reserveMessage(3)));
  expect(
    (
      await t.run((ctx) =>
        ctx.db
          .query('visitLedger')
          .withIndex('visitId', (q) => q.eq('visitId', 'visit-3'))
          .unique(),
      )
    )?.state,
  ).toBe('RESERVED');
  const status = await t.query(queryRef('admin/status'), { adminToken });
  expect(status.resources).toMatchObject({ reservations: 1, admissionState: 'FULL' });
});

test('a saturated Host pending-decision budget refuses a new visit while retaining the local game', async () => {
  const { t } = await setup({ maxPendingDecisions: 1 });
  const worldId = await world(t, true);
  await peer(t);
  await t.run((ctx) =>
    ctx.db.insert('federationTurns', {
      visitId: 'old',
      eventId: 'old',
      turnId: 'old',
      worldId,
      playerId: 'p:0',
      deadline: Date.now() + 5000,
      state: 'PENDING',
    }),
  );
  await t.run((ctx) => dispatchLedgerMessage(ctx, reserveMessage(1)));
  expect((await t.run((ctx) => ctx.db.query('visitLedger').unique()))?.lastError).toBe(
    'HOST_RESOURCE_DEGRADED',
  );
  expect((await t.run((ctx) => ctx.db.get(worldId)))?.agents).toHaveLength(1);
  expect((await t.query(queryRef('admin/status'), { adminToken })).resources.admissionState).toBe(
    'DEGRADED',
  );
});

test('zero Chat queue remains OPEN while idle and becomes DEGRADED when all permits are busy', async () => {
  const { t } = await setup({ maxConcurrentLocalLLM: 1, maxPendingLocalLLM: 0 });
  await peer(t);
  expect((await t.query(queryRef('admin/status'), { adminToken })).resources.admissionState).toBe(
    'OPEN',
  );
  const active = await enqueue(t);
  expect((await t.query(queryRef('admin/status'), { adminToken })).resources.admissionState).toBe(
    'DEGRADED',
  );
  await t.run((ctx) => dispatchLedgerMessage(ctx, reserveMessage(1)));
  expect((await t.run((ctx) => ctx.db.query('visitLedger').unique()))?.lastError).toBe(
    'HOST_RESOURCE_DEGRADED',
  );
  await release(t, active);
  expect((await t.query(queryRef('admin/status'), { adminToken })).resources.admissionState).toBe(
    'OPEN',
  );
});

test('Home decision budget includes running jobs, ignores expired work, and preserves idempotent observation delivery', async () => {
  const { t } = await setup({ maxPendingDecisions: 1 });
  await t.run(async (ctx) => {
    await ctx.db.insert('visitLedger', {
      visitId: 'visit-1',
      agentGlobalId: 'host/agent:1',
      homeTownId: 'host',
      hostTownId: 'home',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      leaseExpiry: Date.now() + 90000,
      fencingToken: 'unused',
      state: 'ACTIVE',
      role: 'home',
      profile: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert('federationDecisionJobs', {
      visitId: 'visit-1',
      eventId: 'running',
      observation: {},
      state: 'RUNNING',
      createdAt: Date.now(),
      deadline: Date.now() + 5000,
    });
  });
  const observation = {
    ...reserveMessage(1),
    type: 'OBSERVATION',
    payload: { eventId: 'new', turnId: 'new', deadline: Date.now() + 25000 },
  };
  await expect(t.run((ctx) => dispatchRuntimeMessage(ctx, observation))).rejects.toThrow(
    'DECISION_QUEUE_FULL',
  );
  await jest.advanceTimersByTimeAsync(5001);
  await t.run((ctx) => dispatchRuntimeMessage(ctx, observation));
  await t.run((ctx) => dispatchRuntimeMessage(ctx, observation));
  expect(
    (await t.run((ctx) => ctx.db.query('federationDecisionJobs').collect())).filter(
      (job) => job.eventId === 'new',
    ),
  ).toHaveLength(1);
});

test.each(['HOME_PENDING', 'HOME_RUNNING', 'AUTONOMOUS'] as const)(
  'shared decision budget counts %s for Host admission, Home ingestion and administrator status', async kind => {
    const { t } = await setup({ maxPendingDecisions: 1 });
    const worldId = await world(t, true);
    await peer(t);
    await t.run(async ctx => {
      await ctx.db.insert('visitLedger', {
        visitId: 'traveling-home', agentGlobalId: 'host/agent:1', homeTownId: 'host', hostTownId: 'home',
        homeDeploymentEpoch: 1, hostDeploymentEpoch: 1, agentAuthorityEpoch: 1,
        visitLeaseVersion: 1, leaseExpiry: Date.now() + 90000, fencingToken: 'unused',
        state: 'ACTIVE', role: 'home', profile: {}, createdAt: Date.now(), updatedAt: Date.now(),
      });
      if (kind === 'AUTONOMOUS') {
        const policyId = await ctx.db.insert('autonomousTravelPolicies', {
          worldId, agentGlobalId: 'host/agent:1', playerId: 'p:0', enabled: true,
          allowedPeerTownIds: ['home'], decisionIntervalMs: 60000, dailyRequestLimit: 2,
          revision: 1, nextDecisionAt: 0, operator: 'admin', reason: 'Visit', updatedAt: Date.now(),
        });
        await ctx.db.insert('autonomousTravelDecisions', {
          policyId, policyRevision: 1, worldId, agentGlobalId: 'host/agent:1',
          playerId: 'p:0', agentId: 'a:1', operationId: 'autonomous', state: 'RUNNING',
          createdAt: Date.now(), deadline: Date.now() + 5000,
        });
      } else await ctx.db.insert('federationDecisionJobs', {
        visitId: 'traveling-home', eventId: 'previous', observation: {},
        state: kind === 'HOME_PENDING' ? 'PENDING' : 'RUNNING', createdAt: Date.now(), deadline: Date.now() + 5000,
      });
    });
    expect((await t.query(queryRef('admin/status'), { adminToken })).resources)
      .toMatchObject({ pendingDecisions: 1, admissionState: 'DEGRADED' });
    await t.run(ctx => dispatchLedgerMessage(ctx, reserveMessage(1)));
    expect((await t.run(ctx => ctx.db.query('visitLedger').withIndex('visitId', q => q.eq('visitId', 'visit-1')).unique()))?.lastError)
      .toBe('HOST_RESOURCE_DEGRADED');
    const observation = { ...reserveMessage(1), visitId: 'traveling-home', type: 'OBSERVATION',
      payload: { eventId: 'new', turnId: 'new', deadline: Date.now() + 25000 } };
    await expect(t.run(ctx => dispatchRuntimeMessage(ctx, observation))).rejects.toThrow('DECISION_QUEUE_FULL');
    jest.setSystemTime(Date.now() + 5001);
    expect((await t.query(queryRef('admin/status'), { adminToken })).resources.pendingDecisions).toBe(0);
    await t.run(ctx => dispatchRuntimeMessage(ctx, observation));
    await t.run(ctx => dispatchRuntimeMessage(ctx, observation));
    expect((await t.query(queryRef('admin/status'), { adminToken })).resources.pendingDecisions).toBe(1);
  },
);

test('optional source quotas prevent one town filling all slots and count bodies awaiting cleanup', async () => {
  const { t } = await setup();
  await peer(t); await peer(t, 'other');
  await t.mutation(mutationRef('resourceMonitoring/configureSourceQuota'), { adminToken, maxVisitorsPerSourceTown: 1 });
  await t.run(ctx => dispatchLedgerMessage(ctx, reserveMessage(1)));
  await t.run(ctx => dispatchLedgerMessage(ctx, reserveMessage(2)));
  expect((await t.run(ctx => ctx.db.query('visitLedger').withIndex('visitId', q => q.eq('visitId', 'visit-2')).unique()))?.lastError).toBe('HOST_SOURCE_QUOTA_EXCEEDED');
  const other = { ...reserveMessage(3), fromTownId: 'other', agentGlobalId: 'other/agent:3' };
  await t.run(ctx => dispatchLedgerMessage(ctx, other));
  expect((await t.run(ctx => ctx.db.query('visitLedger').withIndex('visitId', q => q.eq('visitId', 'visit-3')).unique()))?.state).toBe('RESERVED');
  await t.run(async ctx => {
    const ledger = (await ctx.db.query('visitLedger').withIndex('visitId', q => q.eq('visitId', 'visit-1')).unique())!;
    const slot = (await ctx.db.query('visitReservations').withIndex('visitId', q => q.eq('visitId', 'visit-1')).unique())!;
    await ctx.db.patch(ledger._id, { state: 'REMOVING' });
    await ctx.db.patch(slot._id, { expiresAt: Date.now() - 1 });
  });
  await t.run(ctx => dispatchLedgerMessage(ctx, reserveMessage(4)));
  expect((await t.run(ctx => ctx.db.query('visitLedger').withIndex('visitId', q => q.eq('visitId', 'visit-4')).unique()))?.lastError).toBe('HOST_SOURCE_QUOTA_EXCEEDED');
  const status = await t.query(queryRef('admin/status'), { adminToken });
  expect(status.resources.sourceOccupancy).toEqual(expect.arrayContaining([{ townId: 'home', occupied: 1 }, { townId: 'other', occupied: 1 }]));
  expect(status.resources.maxVisitorsPerSourceTown).toBe(1);
});

test('source policy is administrator-only, audited, defaults unlimited and reducing it preserves existing work', async () => {
  const { t } = await setup(); await peer(t);
  const worldId = await world(t, true);
  await t.run(ctx => dispatchLedgerMessage(ctx, reserveMessage(1)));
  await t.run(ctx => dispatchLedgerMessage(ctx, reserveMessage(2)));
  expect((await t.query(queryRef('admin/status'), { adminToken })).resources.maxVisitorsPerSourceTown).toBeNull();
  for (const limit of [-1, 0.5, 1001]) await expect(t.mutation(mutationRef('resourceMonitoring/configureSourceQuota'), { adminToken, maxVisitorsPerSourceTown: limit })).rejects.toThrow('INVALID_SOURCE_VISITOR_QUOTA');
  await expect(t.mutation(mutationRef('resourceMonitoring/configureSourceQuota'), { adminToken: 'invalid', maxVisitorsPerSourceTown: 1 })).rejects.toThrow();
  await t.mutation(mutationRef('resourceMonitoring/configureSourceQuota'), { adminToken, maxVisitorsPerSourceTown: 0 });
  await t.run(ctx => dispatchLedgerMessage(ctx, reserveMessage(3)));
  const ledgers = await t.run(ctx => ctx.db.query('visitLedger').collect());
  expect(ledgers.filter(l => l.state === 'RESERVED')).toHaveLength(2);
  expect(ledgers.find(l => l.visitId === 'visit-3')?.lastError).toBe('HOST_SOURCE_QUOTA_EXCEEDED');
  expect((await t.run(ctx => ctx.db.get(worldId)))?.agents).toHaveLength(1);
  expect((await t.query(queryRef('admin/status'), { adminToken })).resources.audit[0]).toMatchObject({ operation: 'SOURCE_QUOTA_CHANGED', previous: null, next: 0 });
  await t.mutation(mutationRef('resourceMonitoring/configureSourceQuota'), { adminToken, maxVisitorsPerSourceTown: null });
  await t.run(ctx => dispatchLedgerMessage(ctx, reserveMessage(4)));
  expect((await t.run(ctx => ctx.db.query('visitLedger').withIndex('visitId', q => q.eq('visitId', 'visit-4')).unique()))?.state).toBe('RESERVED');
});

test('remote event policy validates administrator input, preserves source quota and does not reset on identical saves', async () => {
  const { t } = await setup();
  expect((await t.query(queryRef('admin/status'), { adminToken })).resources.maxRemoteEventsPerSecond).toBeNull();
  for (const rate of [-1, 0.5, 1001]) await expect(t.mutation(
    mutationRef('resourceMonitoring/configureRemoteEventRate'), { adminToken, maxRemoteEventsPerSecond: rate },
  )).rejects.toThrow('INVALID_REMOTE_EVENT_RATE');
  await expect(t.mutation(mutationRef('resourceMonitoring/configureRemoteEventRate'), {
    adminToken: 'invalid', maxRemoteEventsPerSecond: 2,
  })).rejects.toThrow();
  await t.mutation(mutationRef('resourceMonitoring/configureSourceQuota'), { adminToken, maxVisitorsPerSourceTown: 3 });
  await t.mutation(mutationRef('resourceMonitoring/configureRemoteEventRate'), { adminToken, maxRemoteEventsPerSecond: 1 });
  await t.run(ctx => consumeRemoteEventBudget(ctx, 'OBSERVATION'));
  await t.mutation(mutationRef('resourceMonitoring/configureRemoteEventRate'), { adminToken, maxRemoteEventsPerSecond: 1 });
  await expect(t.run(ctx => consumeRemoteEventBudget(ctx, 'OBSERVATION'))).rejects.toThrow('REMOTE_EVENT_RATE_EXCEEDED');
  const status = await t.query(queryRef('admin/status'), { adminToken });
  expect(status.resources).toMatchObject({ maxVisitorsPerSourceTown: 3, maxRemoteEventsPerSecond: 1 });
  expect(status.resources.audit[0]).toMatchObject({ operation: 'REMOTE_EVENT_RATE_CHANGED', previous: 1, next: 1 });
  await t.mutation(mutationRef('resourceMonitoring/configureRemoteEventRate'), { adminToken, maxRemoteEventsPerSecond: null });
  await t.run(ctx => consumeRemoteEventBudget(ctx, 'OBSERVATION'));
});

test('only unique durably accepted inbound events are measured and failed transactions cannot inflate the rate', async () => {
  const { t } = await setup(); await peer(t);
  const message = reserveMessage(1);
  const accept = () => t.mutation(mutationRef('transport/acceptMessage'), { message, payloadDigest: 'same-reservation' });
  await accept(); await accept();
  const status = await t.query(queryRef('admin/status'), { adminToken });
  expect(status.resources.measurements.inboundEvents).toBe(1);
  expect(status.resources.measurements.inboundEventsPerSecond).toBeCloseTo(1000 / (status.resources.measurements.measuredAt - status.resources.measurements.windowStartedAt));
  const invalid = { ...reserveMessage(2), senderDeploymentEpoch: 99 };
  await expect(t.mutation(mutationRef('transport/acceptMessage'), { message: invalid, payloadDigest: 'invalid' })).rejects.toThrow('SENDER_DEPLOYMENT_MISMATCH');
  expect((await t.query(queryRef('admin/status'), { adminToken })).resources.measurements.inboundEvents).toBe(1);
  expect(status.resources.cpu).toBeNull(); expect(status.resources.memory).toBeNull();
});


const queuePolicy = {
  adminToken, enabled: true, maxQueuedVisits: 50, visitQueueTtlMs: 120000,
  mode: 'SOURCE_ROUND_ROBIN' as const, maxQueuedVisitsPerSourceTown: null,
};
test('visitor queue configuration is validated, audited and preserves unrelated source/event budgets', async () => {
  const { t } = await setup();
  await t.mutation(mutationRef('resourceMonitoring/configureSourceQuota'), { adminToken, maxVisitorsPerSourceTown: 3 });
  await t.mutation(mutationRef('resourceMonitoring/configureRemoteEventRate'), { adminToken, maxRemoteEventsPerSecond: 4 });
  await t.run(ctx => consumeRemoteEventBudget(ctx, 'VISIT_RESERVE'));
  const budget = await t.run(ctx => ctx.db.query('federationInboundBudget').unique());
  await expect(t.mutation(mutationRef('resourceMonitoring/configureVisitorQueue'), {
    ...queuePolicy, adminToken: 'invalid',
  })).rejects.toThrow();
  for (const invalid of [{ maxQueuedVisits: 0 }, { maxQueuedVisits: 1001 }, { maxQueuedVisits: 1.5 },
    { visitQueueTtlMs: 999 }, { visitQueueTtlMs: 3600001 }, { maxQueuedVisitsPerSourceTown: -1 },
    { maxQueuedVisitsPerSourceTown: 1001 }])
    await expect(t.mutation(mutationRef('resourceMonitoring/configureVisitorQueue'), {
      ...queuePolicy, ...invalid,
    })).rejects.toThrow('INVALID_VISITOR_QUEUE_POLICY');
  await t.mutation(mutationRef('resourceMonitoring/configureVisitorQueue'), queuePolicy);
  const stored = (await t.run(ctx => ctx.db.query('federationResourcePolicy').unique()))!;
  expect(stored).toMatchObject({ maxVisitorsPerSourceTown: 3, maxRemoteEventsPerSecond: 4,
    visitorQueueEnabled: true, maxQueuedVisits: 50, visitQueueTtlMs: 120000, visitorQueueMode: 'SOURCE_ROUND_ROBIN' });
  expect(await t.run(ctx => ctx.db.query('federationInboundBudget').unique())).toEqual(budget);
  const audit = await t.run(ctx => ctx.db.query('federationResourceAudit').collect());
  expect(audit.filter(a => a.operation === 'VISITOR_QUEUE_POLICY_CHANGED')).toHaveLength(1);
  const status = await t.query(queryRef('admin/status'), { adminToken });
  expect(status.resources.visitorQueue).toMatchObject({ enabled: true, waiting: 0, paused: 0 });
  expect(() => validateResourcePolicy({ maxVisitorsPerSourceTown: null })).not.toThrow();
  expect(() => validateResourcePolicy(stored)).not.toThrow();
  for (const invalid of [{ visitorQueueEnabled: 'yes' }, { maxQueuedVisits: 0 }, { visitQueueTtlMs: Infinity },
    { visitorQueueMode: 'anything' }, { maxQueuedVisitsPerSourceTown: -1 }, { visitorQueueLastSource: '' }])
    expect(() => validateResourcePolicy({ maxVisitorsPerSourceTown: null, ...invalid })).toThrow('INVALID_VISITOR_QUEUE_POLICY');
});
async function pendingPolicyVisit(t: Awaited<ReturnType<typeof setup>>['t'], index: number, role = 'host') {
  return t.run(ctx => ctx.db.insert('visitLedger', {
    visitId: `policy-wait-${index}`, agentGlobalId: `home/agent:${index}`, homeTownId: role === 'host' ? 'home' : 'host',
    hostTownId: role === 'host' ? 'host' : 'home', homeDeploymentEpoch: 1, hostDeploymentEpoch: 1,
    agentAuthorityEpoch: 1, visitLeaseVersion: 1, leaseExpiry: Date.now() + 120000,
    fencingToken: 'private-policy-fencing-token', role, state: 'QUEUED', profile: { name: 'Waiting resident' },
    queuedAt: Date.now(), queueExpiresAt: Date.now() + 60000, queuePaused: false,
    createdAt: Date.now(), updatedAt: Date.now(),
  }));
}
test('disabling a visitor queue cleans a bounded batch and resumes the remaining waiting authorizations', async () => {
  const { t } = await setup();
  await peer(t);
  await t.mutation(mutationRef('resourceMonitoring/configureVisitorQueue'), queuePolicy);
  for (let i = 0; i < 35; i++) await pendingPolicyVisit(t, i);
  await t.mutation(mutationRef('resourceMonitoring/configureVisitorQueue'), { ...queuePolicy, enabled: false });
  await t.mutation(mutationRef('resourceMonitoring/reconcileVisitorQueuePolicy'), {});
  const first = await t.run(ctx => ctx.db.query('visitLedger').collect());
  expect(first.filter(l => l.state === 'QUEUED')).toHaveLength(19);
  expect(first.filter(l => l.state === 'REJECTED' && l.cleanupConfirmed)).toHaveLength(16);
  await t.mutation(mutationRef('resourceMonitoring/reconcileVisitorQueuePolicy'), {});
  await t.mutation(mutationRef('resourceMonitoring/reconcileVisitorQueuePolicy'), {});
  const done = await t.run(ctx => ctx.db.query('visitLedger').collect());
  expect(done.every(l => l.state === 'REJECTED' && l.cleanupConfirmed)).toBe(true);
  expect(await t.run(ctx => ctx.db.query('visitReservations').collect())).toEqual([]);
  expect((await t.run(ctx => ctx.db.query('federationOutbox').collect())).map(m => m.envelope.type))
    .toEqual(Array(35).fill('VISIT_CLEANED'));
});
test.each(['PAUSED', 'REVOKED', 'OUTBOUND_DISABLED'])(
  'peer policy %s preserves or terminates queued requests without reviving old authority', async change => {
    const { t } = await setup();
    await peer(t);
    const hostId = await pendingPolicyVisit(t, 1);
    const homeId = await pendingPolicyVisit(t, 2, 'home');
    await t.mutation(mutationRef('peers/setPolicy'), { adminToken, peerTownId: 'home',
      inboundVisitsAllowed: change !== 'REVOKED', outboundVisitsAllowed: change === 'PAUSED',
      trustState: change === 'OUTBOUND_DISABLED' ? 'TRUSTED' : change,
    });
    const host = await t.run(ctx => ctx.db.get(hostId)), home = await t.run(ctx => ctx.db.get(homeId));
    expect(host!.state).toBe(change === 'REVOKED' ? 'REJECTED' : 'QUEUED');
    expect(home!.state).toBe(change === 'PAUSED' ? 'QUEUED' : 'RETURN_PENDING');
    if (change === 'REVOKED') expect(host!.cleanupConfirmed).toBe(true);
    if (change !== 'PAUSED') expect(home!.cleanupConfirmed).toBeUndefined();
  },
);

test('revoking a peer shares one 16-row budget across 47 mixed Host/Home requests and never restores old Home authority', async () => {
  const { t } = await setup();
  await peer(t);
  const worldId = await world(t);
  const original: Array<{ id: Id<'visitLedger'>; state: string; role: string }> = [];
  for (let index = 0; index < 47; index++) {
    const role = index < 17 ? 'host' : 'home';
    const state = index < 32 && role === 'home' ? 'REQUESTED' : 'QUEUED';
    const id = await pendingPolicyVisit(t, index, role);
    await t.run(async ctx => {
      await ctx.db.patch(id, { state, ...(role === 'home' ? {
        agentGlobalId: `host/agent:${index}`, worldId, homePlayerId: `p:${index}`,
      } : {}) });
      if (role === 'home') await ctx.db.insert('federationAgentRuntimes', {
        agentGlobalId: `host/agent:${index}`, homeTownId: 'host', worldId,
        playerId: `p:${index}` as any, agentId: `a:${index}` as any,
        state: 'TRAVEL_PREPARING', visitId: `policy-wait-${index}`,
        agentAuthorityEpoch: 1, updatedAt: Date.now(),
      });
    });
    original.push({ id, state, role });
  }
  await t.mutation(mutationRef('peers/setPolicy'), {
    adminToken, peerTownId: 'home', inboundVisitsAllowed: false,
    outboundVisitsAllowed: false, trustState: 'REVOKED',
  });
  for (const [page, processed] of [16, 32, 47].entries()) {
    const rows = await t.run(ctx => ctx.db.query('visitLedger').collect());
    const terminalHost = rows.filter(row => row.role === 'host' && row.state === 'REJECTED');
    const returningHome = rows.filter(row => row.role === 'home' && row.state === 'RETURN_PENDING');
    expect(terminalHost.length + returningHome.length).toBe(processed);
    expect(rows).toHaveLength(47);
    for (const item of original) {
      const row = rows.find(row => row._id === item.id)!;
      expect(row.agentAuthorityEpoch).toBe(1);
      expect(row.leaseExpiry).toBeGreaterThan(Date.now());
      expect(['QUEUED', 'REQUESTED', 'REJECTED', 'RETURN_PENDING']).toContain(row.state);
      if (row.state === 'REJECTED') expect(row.cleanupConfirmed).toBe(true);
      else if (row.state === 'RETURN_PENDING') expect(row.cleanupConfirmed).toBeUndefined();
      else expect(row.state).toBe(item.state);
    }
    const messages = await t.run(ctx => ctx.db.query('federationOutbox').collect());
    expect(messages).toHaveLength(processed);
    expect(new Set(messages.map(row => row.envelope.visitId)).size).toBe(processed);
    expect(messages.filter(row => row.envelope.type === 'VISIT_CLEANED')).toHaveLength(terminalHost.length);
    expect(messages.filter(row => row.envelope.type === 'VISIT_RETURN')).toHaveLength(returningHome.length);
    const jobs = await t.run(ctx => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.filter(job => String(job.name).includes('peers:reconcilePendingPeerVisits'))).toHaveLength(Math.min(page + 1, 2));
    expect(jobs.some(job => String(job.name).includes('resumeHome') || String(job.name).includes('freezeHome'))).toBe(false);
    const runtimes = await t.run(ctx => ctx.db.query('federationAgentRuntimes').collect());
    expect(runtimes).toHaveLength(30);
    expect(runtimes.every(row => row.state === 'TRAVEL_PREPARING' && row.visitId && row.agentAuthorityEpoch === 1)).toBe(true);
    if (processed < 47) await t.mutation(mutationRef('peers/reconcilePendingPeerVisits'), { peerTownId: 'home' });
  }
  await t.mutation(mutationRef('peers/reconcilePendingPeerVisits'), { peerTownId: 'home' });
  expect(await t.run(ctx => ctx.db.query('federationOutbox').collect())).toHaveLength(47);
  for (const item of original.filter(item => item.role === 'home')) {
    const row = (await t.run(ctx => ctx.db.get(item.id)))!;
    const late = (type: string): FederationMessage => ({
      protocol: PROTOCOL, messageId: `late-${type}-${row.visitId}`, fromTownId: 'home', toTownId: 'host',
      senderDeploymentInstanceId: 'home-instance', senderDeploymentEpoch: 1,
      expectedRecipientDeploymentEpoch: 1, type, sentAt: Date.now(), expiresAt: Date.now() + 10000,
      nonce: `late-${type}-${row.visitId}`, credentialId: 'credential', visitId: row.visitId,
      agentGlobalId: row.agentGlobalId, agentAuthorityEpoch: 1, visitLeaseVersion: 1,
      streamId: 'lease-control', sequence: 1,
      payload: { fencingToken: row.fencingToken, reservedUntil: Date.now() + 30000,
        leaseExpiry: row.leaseExpiry, queueProtocolVersion: 1, queuedAt: row.queuedAt,
        queueExpiresAt: row.queueExpiresAt, queueReason: 'HOST_CAPACITY_EXCEEDED' },
    });
    await t.run(ctx => dispatchLedgerMessage(ctx, late('VISIT_QUEUED')));
    await t.run(ctx => dispatchLedgerMessage(ctx, late('VISIT_RESERVED')));
    await expect(t.run(ctx => homeResumed(ctx, row.visitId))).rejects.toThrow('HOST_LEASE_STILL_VALID');
    expect(await t.run(ctx => ctx.db.get(row._id))).toMatchObject({ state: 'RETURN_PENDING', agentAuthorityEpoch: 1 });
  }
  expect(await t.run(ctx => ctx.db.query('visitReservations').collect())).toEqual([]);
  expect(await t.run(ctx => ctx.db.query('inputs').collect())).toEqual([]);
});

test('disabling outbound peer travel shares the 16-row budget between REQUESTED and QUEUED without removing inbound candidates', async () => {
  const { t } = await setup();
  await peer(t);
  const hostId = await pendingPolicyVisit(t, 1000);
  for (let index = 0; index < 47; index++) {
    const id = await pendingPolicyVisit(t, index, 'home');
    if (index < 27) await t.run(ctx => ctx.db.patch(id, { state: 'REQUESTED' }));
  }
  await t.mutation(mutationRef('peers/setPolicy'), {
    adminToken, peerTownId: 'home', inboundVisitsAllowed: true,
    outboundVisitsAllowed: false, trustState: 'TRUSTED',
  });
  for (const processed of [16, 32, 47]) {
    const rows = await t.run(ctx => ctx.db.query('visitLedger').collect());
    expect(rows.filter(row => row.role === 'home' && row.state === 'RETURN_PENDING')).toHaveLength(processed);
    expect(rows.filter(row => row.role === 'home' && ['QUEUED', 'REQUESTED'].includes(row.state))).toHaveLength(47 - processed);
    expect(await t.run(ctx => ctx.db.get(hostId))).toMatchObject({ state: 'QUEUED' });
    const messages = await t.run(ctx => ctx.db.query('federationOutbox').collect());
    expect(messages).toHaveLength(processed);
    expect(new Set(messages.map(row => row.envelope.visitId)).size).toBe(processed);
    expect(messages.every(row => row.envelope.type === 'VISIT_RETURN')).toBe(true);
    if (processed < 47) await t.mutation(mutationRef('peers/reconcilePendingPeerVisits'), { peerTownId: 'home' });
  }
  await t.mutation(mutationRef('peers/reconcilePendingPeerVisits'), { peerTownId: 'home' });
  expect(await t.run(ctx => ctx.db.query('federationOutbox').collect())).toHaveLength(47);
  expect(await t.run(ctx => ctx.db.query('visitReservations').collect())).toEqual([]);
});
