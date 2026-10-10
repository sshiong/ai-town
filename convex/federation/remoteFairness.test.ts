import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { internalAction } from '../_generated/server';
import { v } from 'convex/values';
import schema from '../schema';
import { Game } from '../aiTown/game';
import { DEFAULT_RESOURCE_LIMITS } from './resources';
import { tickRemoteVisitors } from './remoteTick';
import { mutationRef } from './refs';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/decision.ts': async () => ({
    ...(await import('./decision')),
    run: internalAction({
      args: { jobId: v.id('federationDecisionJobs') },
      handler: async (ctx, args) => {
        await ctx.runMutation(mutationRef('decision/claim'), args);
      },
    }),
  }),
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_000_000);
});
afterEach(() => jest.useRealTimers());

async function game(budget = 1) {
  const t = convexTest(schema, modules);
  const worldId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('worlds', {
      nextId: 0,
      players: [],
      agents: [],
      conversations: [],
    });
    const engineId = await ctx.db.insert('engines', { running: true, generationNumber: 0 });
    await ctx.db.insert('worldStatus', {
      worldId: id,
      engineId,
      isDefault: true,
      lastViewed: Date.now(),
      status: 'running',
    });
    await ctx.db.insert('maps', {
      worldId: id,
      width: 20,
      height: 20,
      tileSetUrl: '/tiles.png',
      tileSetDimX: 16,
      tileSetDimY: 16,
      tileDim: 1,
      bgTiles: [],
      objectTiles: [Array.from({ length: 20 }, () => Array(20).fill(-1))],
      animatedSprites: [],
    });
    return id;
  });
  const data = await t.run((ctx) => Game.load(ctx.db, worldId, 0));
  const instance = new Game(data.engine, worldId, data.gameState);
  instance.resourceLimits = { ...DEFAULT_RESOURCE_LIMITS, maxPendingDecisions: budget };
  return { t, worldId, instance };
}
function addVisitor(instance: Game, town: string, number: number) {
  instance.handleInput(Date.now(), 'federationCreateVisitor', {
    name: `${town} visitor ${number}`,
    character: 'f1',
    description: 'Public visitor',
    visitor: {
      visitId: `${town}:${number}`,
      agentGlobalId: `${town}/agent:${number}`,
      homeTownId: town,
      homeTownName: town,
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      leaseExpiry: Date.now() + 900_000,
      lastObservationAt: 0,
    },
  });
}

test.each([3, 10])(
  '%i synthetic sources receive bounded turns with one slot despite unequal visitor counts',
  async (sources) => {
    const { instance } = await game();
    for (let i = 0; i < 6; i++) addVisitor(instance, 'source:00', i);
    for (let i = 1; i < sources; i++)
      addVisitor(instance, `source:${String(i).padStart(2, '0')}`, 0);
    const selected: string[] = [];
    for (let step = 0; step < sources * 3; step++) {
      jest.setSystemTime(Date.now() + 6000);
      tickRemoteVisitors(instance, Date.now());
      const pending = [...instance.world.players.values()].filter(
        (p) => p.remoteVisitor?.pendingTurn,
      );
      expect(pending).toHaveLength(1);
      selected.push(pending[0].remoteVisitor!.homeTownId);
      delete pending[0].remoteVisitor!.pendingTurn;
    }
    for (let round = 0; round < 3; round++)
      expect(new Set(selected.slice(round * sources, (round + 1) * sources)).size).toBe(sources);
    const servedFirstSource = [...instance.world.players.values()].filter(
      (p) => p.remoteVisitor?.homeTownId === 'source:00' && p.remoteVisitor.lastObservationAt > 0,
    );
    expect(servedFirstSource).toHaveLength(3);
  },
);

test('multiple slots take one visitor from each source before the source with many visitors gets another', async () => {
  const { instance } = await game(3);
  for (let i = 0; i < 4; i++) addVisitor(instance, 'first', i);
  addVisitor(instance, 'second', 0);
  addVisitor(instance, 'third', 0);
  tickRemoteVisitors(instance, Date.now());
  const pending = [...instance.world.players.values()].filter((p) => p.remoteVisitor?.pendingTurn);
  expect(pending).toHaveLength(3);
  expect(new Set(pending.map((p) => p.remoteVisitor!.homeTownId)).size).toBe(3);
  expect(instance.world.agents.size).toBe(0);
});

test('fair order survives world serialization; occupied other-world budget and expired leases remain authoritative', async () => {
  const { instance, worldId, t } = await game();
  addVisitor(instance, 'first', 0);
  addVisitor(instance, 'second', 0);
  tickRemoteVisitors(instance, Date.now());
  const pending = [...instance.world.players.values()].find((p) => p.remoteVisitor?.pendingTurn)!;
  expect(pending.remoteVisitor!.homeTownId).toBe('first');
  delete pending.remoteVisitor!.pendingTurn;
  await t.run((ctx) => ctx.db.patch(worldId, instance.world.serialize()));
  const loaded = await t.run((ctx) => Game.load(ctx.db, worldId, 0));
  const restarted = new Game(loaded.engine, worldId, loaded.gameState);
  restarted.resourceLimits.maxPendingDecisions = 1;
  jest.setSystemTime(Date.now() + 6000);
  restarted.otherPendingDecisions = 1;
  tickRemoteVisitors(restarted, Date.now());
  expect([...restarted.world.players.values()].some((p) => p.remoteVisitor?.pendingTurn)).toBe(
    false,
  );
  restarted.otherPendingDecisions = 0;
  tickRemoteVisitors(restarted, Date.now());
  expect(
    [...restarted.world.players.values()].find((p) => p.remoteVisitor?.pendingTurn)?.remoteVisitor
      ?.homeTownId,
  ).toBe('second');
  for (const player of restarted.world.players.values()) {
    delete player.remoteVisitor!.pendingTurn;
    player.remoteVisitor!.leaseExpiry = Date.now() - 1;
  }
  tickRemoteVisitors(restarted, Date.now());
  expect([...restarted.world.players.values()].some((p) => p.remoteVisitor?.pendingTurn)).toBe(
    false,
  );
});

test('decision recovery pages past blocked older jobs and preserves one active decision per runtime', async () => {
  const { t, worldId } = await game();
  const ids = await t.run(async (ctx) => {
    const result: string[] = [];
    for (const [town, active] of [
      ['blocked-source', true],
      ['waiting-source', false],
    ] as const) {
      await ctx.db.insert('visitLedger', {
        visitId: town,
        agentGlobalId: `${town}/agent:1`,
        homeTownId: 'home',
        hostTownId: town,
        homeDeploymentEpoch: 1,
        hostDeploymentEpoch: 1,
        agentAuthorityEpoch: 1,
        visitLeaseVersion: 1,
        leaseExpiry: Date.now() + 90_000,
        fencingToken: 'unused',
        role: 'home',
        state: 'ACTIVE',
        profile: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert('federationAgentRuntimes', {
        worldId,
        playerId: 'p:0',
        agentId: 'a:1',
        agentGlobalId: `${town}/agent:1`,
        homeTownId: 'home',
        state: 'TRAVELING',
        agentAuthorityEpoch: 1,
        updatedAt: Date.now(),
        ...(active ? { activeDecisionId: 'ongoing' } : {}),
      });
      for (let i = 0; i < (active ? 25 : 2); i++) {
        const id = await ctx.db.insert('federationDecisionJobs', {
          visitId: town,
          eventId: `${town}:${i}`,
          observation: {},
          state: 'PENDING',
          createdAt: Date.now(),
          deadline: Date.now() + 25_000,
        });
        if (!active) result.push(id);
      }
    }
    return result;
  });
  await t.mutation(mutationRef('decision/recover'), {});
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  const jobs = await t.run((ctx) => ctx.db.query('federationDecisionJobs').collect());
  expect(jobs.find((j) => j._id === ids[0])?.state).toBe('RUNNING');
  expect(jobs.find((j) => j._id === ids[1])?.state).toBe('PENDING');
  expect(jobs.filter((j) => j.visitId === 'blocked-source' && j.state === 'RUNNING')).toHaveLength(
    0,
  );
});
