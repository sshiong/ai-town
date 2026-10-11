import { hasNonterminalVisit } from './ledger';
import { observeClock, readClock } from './timePolicy';
import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { dispatchRuntimeMessage } from './runtime';
import { Game } from '../aiTown/game';
import { applyEngineUpdate } from '../engine/abstractGame';
import { mutationRef } from './refs';
import { createIdentityKeys, randomSecret, sealSecret } from './security';
import { hostCreated } from './ledger';
import { insertInput } from '../aiTown/insertInput';
import { Id } from '../_generated/dataModel';
import { ENGINE_ACTION_DURATION } from '../constants';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/runtime.ts': () => import('./runtime'),
  '../federation/ledger.ts': () => import('./ledger'),
  '../federation/admin.ts': () => import('./admin'),
  '../federation/transport.ts': () => import('./transport'),
  '../federation/store.ts': () => import('./store'),
  '../aiTown/game.ts': () => import('../aiTown/game'),
  '../aiTown/main.ts': () => import('../aiTown/main'),
  '../engine/abstractGame.ts': () => import('../engine/abstractGame'),
};
const adminToken = 'federation-runtime-test-admin-token';
const layer = Array.from({ length: 8 }, () => Array(8).fill(-1));
const map = { width: 8, height: 8, tileSetUrl: '/tiles.png', tileSetDimX: 8, tileSetDimY: 8, tileDim: 1, bgTiles: [], objectTiles: [layer], animatedSprites: [] };
async function setup(role: 'home' | 'host', state: string) {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken; process.env.FEDERATION_KEY_ENCRYPTION_KEY = randomSecret();
  const t = convexTest(schema, modules), keys = await createIdentityKeys(), credentialEncrypted = await sealSecret(randomSecret());
  const worldId = await t.run(async ctx => {
    await ctx.db.insert('federationClock', { observedAt: Date.now(), uncertain: false });
    const player = { id: 'p:0' as any, lastInput: Date.now(), position: { x: 2, y: 2 }, facing: { dx: 1, dy: 0 }, speed: 0 };
    const worldId = await ctx.db.insert('worlds', { nextId: 10, players: role === 'home' ? [player] : [], agents: role === 'home' ? [{ id: 'a:1' as any, playerId: 'p:0' as any }] : [], conversations: [] });
    const engineId = await ctx.db.insert('engines', { running: true, generationNumber: 0 });
    await ctx.db.insert('worldStatus', { worldId, engineId, isDefault: true, lastViewed: Date.now(), status: 'running' });
    await ctx.db.insert('maps', { worldId, ...map });
    if (role === 'home') {
      await ctx.db.insert('playerDescriptions', { worldId, playerId: 'p:0' as any, name: 'Alice', character: 'f1', description: 'Resident' });
      await ctx.db.insert('agentDescriptions', { worldId, agentId: 'a:1' as any, identity: 'Alice', plan: 'Explore' });
      await ctx.db.insert('federationAgentRuntimes', { agentGlobalId: 'home/agent:alice', homeTownId: 'home', worldId, playerId: 'p:0' as any, agentId: 'a:1' as any, state: 'TRAVEL_PREPARING', visitId: 'visit-1', agentAuthorityEpoch: 2, updatedAt: Date.now() });
    }
    await ctx.db.insert('federationIdentity', { ...keys, townId: role, townName: role, endpoint: `https://${role}.example/federation/v1`, deploymentInstanceId: `${role}-instance`, deploymentEpoch: 1,
      enabled: true, allowIncomingPairRequests: true, allowUnencryptedHttp: false, allowPublicHttp: false, maxVisitors: 1, maxVisitDurationMs: 300000, mode: 'ACTIVE', createdAt: Date.now() });
    const remote = role === 'home' ? 'host' : 'home';
    await ctx.db.insert('federationPeers', { townId: remote, townName: remote, publicKey: keys.publicKey, fingerprint: keys.fingerprint, deploymentInstanceId: `${remote}-instance`, deploymentEpoch: 1,
      endpoint: `https://${remote}.example/federation/v1`, credentialId: 'pair-credential', credentialEncrypted, trustState: 'TRUSTED', inboundVisitsAllowed: true, outboundVisitsAllowed: true, pairedAt: Date.now() });
    await ctx.db.insert('visitLedger', { visitId: 'visit-1', agentGlobalId: 'home/agent:alice', homeTownId: 'home', hostTownId: 'host', homeDeploymentEpoch: 1, hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 2, visitLeaseVersion: 1, leaseExpiry: Date.now() + 300000, fencingToken: 'fencing-token', state, role, worldId,
      ...(role === 'home' ? { homePlayerId: 'p:0' } : {}), profile: { name: 'Alice', character: 'f1', description: 'Resident', homeTownName: 'Home' }, createdAt: Date.now(), updatedAt: Date.now() });
    if (role === 'host') await ctx.db.insert('visitReservations', { visitId: 'visit-1', hostTownId: 'host', expiresAt: Date.now() + 300000, reservedSlot: true });
    return worldId;
  });
  return { t, worldId };
}
async function engineStep(t: ReturnType<typeof convexTest<typeof schema.tables>>, worldId: Id<'worlds'>, maxInputs = 100, tick = false) {
  const currentEngine = await t.run(async ctx => {
    const status = (await ctx.db.query('worldStatus').withIndex('worldId', q => q.eq('worldId', worldId)).unique())!;
    return (await ctx.db.get(status.engineId))!;
  });
  const checkedInputs = await t.query(makeFunctionReference<'query'>('engine/abstractGame:loadInputs'), { engineId: currentEngine._id, processedInputNumber: currentEngine.processedInputNumber, max: maxInputs }) as any[];
  await t.run(async ctx => {
    const status = (await ctx.db.query('worldStatus').withIndex('worldId', q => q.eq('worldId', worldId)).unique())!;
    const engine = (await ctx.db.get(status.engineId))!;
    const loaded = await Game.load(ctx.db, worldId, engine.generationNumber);
    const game = new Game(loaded.engine, worldId, loaded.gameState);
    game.beginStep(Date.now());
    const pending = checkedInputs;
    const completedInputs = pending.map(input => {
      try { return { inputId: input._id, returnValue: { kind: 'ok' as const, value: game.handleInput(Date.now(), input.name as any, input.args) } }; }
      catch (error) { return { inputId: input._id, returnValue: { kind: 'error' as const, message: error instanceof Error ? error.message : String(error) } }; }
    });
    if (tick) game.tick(Date.now());
    const { _id, _creationTime, ...engineData } = engine;
    await applyEngineUpdate(ctx, engine._id, { expectedGenerationNumber: engine.generationNumber, engine: { ...engineData, currentTime: Date.now(), generationNumber: engine.generationNumber + 1,
      ...(pending.length ? { processedInputNumber: pending[pending.length - 1].number } : {}) }, completedInputs });
    await Game.saveDiff(ctx, worldId, game.takeDiff());
  });
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test.each([
  { role: 'home', state: 'FREEZING', operation: 'freezeHome', input: 'federationSuspend', result: 'CONFIRMING' },
  { role: 'home', state: 'RETURN_PENDING', operation: 'resumeHome', input: 'federationResume', result: 'COMPLETED' },
  { role: 'host', state: 'CREATING', operation: 'createHostPresence', input: 'federationCreateVisitor', result: 'ACTIVE' },
] as const)('a stalled running engine processes persisted $input after one fenced recovery kick', async scenario => {
  const { t, worldId } = await setup(scenario.role, scenario.state);
  const stalledAt = Date.now() - ENGINE_ACTION_DURATION * 2 - 1000;
  await t.run(async ctx => {
    const status = (await ctx.db.query('worldStatus').unique())!;
    await ctx.db.patch(status.engineId, { currentTime: stalledAt, generationNumber: 7 });
    if (scenario.role === 'home') await ctx.db.insert('transportSessions', {
      peerTownId: 'host', transportType: 'DIRECT_HTTPS', channelState: 'TRANSPORT_READY',
      localDeploymentEpoch: 1, verifiedPeerDeploymentEpoch: 1, inboundVerifiedAt: Date.now(), outboundVerifiedAt: Date.now(),
    });
    if (scenario.operation === 'resumeHome') {
      const world = (await ctx.db.get(worldId))!, ledger = (await ctx.db.query('visitLedger').unique())!;
      await ctx.db.patch(worldId, { players: [], agents: [{ ...world.agents[0], travelVisitId: 'visit-1', suspendedPlayer: world.players[0] }] });
      await ctx.db.patch(ledger._id, { cleanupConfirmed: true });
    }
  });
  await t.mutation(mutationRef(`runtime/${scenario.operation}`), { visitId: 'visit-1' });
  await t.mutation(mutationRef(`runtime/${scenario.operation}`), { visitId: 'visit-1' });
  const engine = (await t.run(ctx => ctx.db.query('engines').unique()))!;
  expect(engine.generationNumber).toBe(8);
  expect(engine.currentTime).toBe(stalledAt);
  expect(engine.lastRecoveryAt).toBe(Date.now());
  const scheduled = await t.run(ctx => ctx.db.system.query('_scheduled_functions').collect());
  expect(scheduled.filter(row => row.name.includes('runStep'))).toHaveLength(1);
  const inputs = await t.run(ctx => ctx.db.query('inputs').collect());
  expect(inputs.map(input => input.name)).toEqual([scenario.input]);
  await engineStep(t, worldId);
  expect((await t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe(scenario.result);
  expect((await t.run(ctx => ctx.db.query('federationPresenceJobs').unique()))?.state).toBe('COMMITTED');
  const world = (await t.run(ctx => ctx.db.get(worldId)))!;
  if (scenario.operation === 'freezeHome') {
    expect(world.players).toEqual([]);
    expect((await t.run(ctx => ctx.db.query('federationOutbox').collect())).some(row => row.envelope.type === 'VISIT_CONFIRM')).toBe(true);
  } else if (scenario.operation === 'resumeHome') {
    expect(world.players[0].id).toBe('p:0');
    expect(world.agents[0].travelVisitId).toBeUndefined();
    expect((await t.run(ctx => ctx.db.query('federationAgentRuntimes').unique()))?.state).toBe('HOME_ACTIVE');
  } else expect(world.players[0].remoteVisitor?.visitId).toBe('visit-1');
});

test('retrying a persisted pending freeze wakes a stalled engine and fences an earlier world commit', async () => {
  const { t, worldId } = await setup('home', 'FREEZING');
  await t.run(ctx => ctx.db.insert('transportSessions', {
    peerTownId: 'host', transportType: 'DIRECT_HTTPS', channelState: 'TRANSPORT_READY',
    localDeploymentEpoch: 1, verifiedPeerDeploymentEpoch: 1, inboundVerifiedAt: Date.now(), outboundVerifiedAt: Date.now(),
  }));
  await t.mutation(mutationRef('runtime/freezeHome'), { visitId: 'visit-1' });
  await t.run(async ctx => {
    const engine = (await ctx.db.query('engines').unique())!;
    await ctx.db.patch(engine._id, { currentTime: Date.now() - ENGINE_ACTION_DURATION * 2 - 1 });
  });
  const earlier = await prepareEngineCommit(t, worldId);
  await t.mutation(mutationRef('runtime/freezeHome'), { visitId: 'visit-1' });
  const recovered = (await t.run(ctx => ctx.db.query('engines').unique()))!;
  await expect(t.mutation(makeFunctionReference<'mutation'>('aiTown/game:saveWorld'), earlier)).rejects.toThrow('Generation number mismatch');
  expect(await t.run(ctx => ctx.db.query('engines').unique())).toEqual(recovered);
  expect((await t.run(ctx => ctx.db.get(worldId)))?.players[0].id).toBe('p:0');
  expect((await t.run(ctx => ctx.db.query('inputs').unique()))?.returnValue).toBeUndefined();
  await engineStep(t, worldId);
  expect((await t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('CONFIRMING');
  expect((await t.run(ctx => ctx.db.query('engines').unique()))?.lastRecoveryAt).toBe(recovered.lastRecoveryAt);
});

test('healthy presence input retries do not kick the engine or duplicate input, and developer stops remain stopped', async () => {
  const { t } = await setup('home', 'FREEZING');
  await t.run(async ctx => { const engine = (await ctx.db.query('engines').unique())!; await ctx.db.patch(engine._id, { currentTime: Date.now() }); });
  await t.mutation(mutationRef('runtime/freezeHome'), { visitId: 'visit-1' });
  await t.mutation(mutationRef('runtime/freezeHome'), { visitId: 'visit-1' });
  const engine = (await t.run(ctx => ctx.db.query('engines').unique()))!;
  expect(engine.generationNumber).toBe(0);
  expect(engine.lastRecoveryAt).toBeUndefined();
  expect(await t.run(ctx => ctx.db.query('inputs').collect())).toHaveLength(1);
  expect((await t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())).filter(row => row.name.includes('runStep'))).toEqual([]);
  await t.run(async ctx => { const status = (await ctx.db.query('worldStatus').unique())!; await ctx.db.patch(status._id, { status: 'stoppedByDeveloper' }); });
  await expect(t.mutation(mutationRef('runtime/freezeHome'), { visitId: 'visit-1' })).rejects.toThrow('WORLD_NOT_RUNNING');
  expect(await t.run(ctx => ctx.db.query('engines').unique())).toEqual(engine);
});

test('cancel before a delayed freeze job leaves the original resident active and schedules no suspend', async () => {
  const { t, worldId } = await setup('home', 'FREEZING');
  await t.mutation(mutationRef('ledger/returnVisit'), { adminToken, visitId: 'visit-1' });
  await t.mutation(mutationRef('runtime/freezeHome'), { visitId: 'visit-1' });
  expect(await t.run(ctx => ctx.db.query('inputs').collect())).toEqual([]);
  const world = await t.run(ctx => ctx.db.get(worldId)); expect(world?.players.map(p => p.id)).toEqual(['p:0']); expect(world?.agents[0].travelVisitId).toBeUndefined();
});

test('cancel with an already queued freeze processes suspend then safe resume without losing the resident', async () => {
  const { t, worldId } = await setup('home', 'FREEZING');
  await t.mutation(mutationRef('runtime/freezeHome'), { visitId: 'visit-1' });
  await t.mutation(mutationRef('ledger/returnVisit'), { adminToken, visitId: 'visit-1' });
  await t.run(async ctx => { const ledger = (await ctx.db.query('visitLedger').unique())!; await ctx.db.patch(ledger._id, { cleanupConfirmed: true }); });
  await t.mutation(mutationRef('runtime/resumeHome'), { visitId: 'visit-1' });
  const inputs = await t.run(ctx => ctx.db.query('inputs').order('asc').collect()); expect(inputs.map(i => i.name)).toEqual(['federationSuspend', 'federationResume']);
  await engineStep(t, worldId, 1);
  const suspended = await t.run(ctx => ctx.db.get(worldId)); expect(suspended?.players).toEqual([]); expect(suspended?.agents[0].suspendedPlayer?.id).toBe('p:0');
  expect((await t.run(ctx => ctx.db.query('federationAgentRuntimes').unique()))?.state).toBe('RETURN_PENDING');
  await engineStep(t, worldId, 1);
  const returned = await t.run(ctx => ctx.db.get(worldId)); expect(returned?.players.map(p => p.id)).toEqual(['p:0']); expect(returned?.agents[0].travelVisitId).toBeUndefined(); expect(returned?.agents[0].suspendedPlayer).toBeUndefined();
  expect((await t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('COMPLETED');
  expect((await t.run(ctx => ctx.db.query('federationAgentRuntimes').unique()))?.state).toBe('HOME_ACTIVE');
  expect((await t.run(ctx => ctx.db.query('federationOutbox').collect())).some(o => o.envelope.type === 'VISIT_CONFIRM')).toBe(false);
});

test('a delayed resume from a completed visit cannot disturb a newer travel authority', async () => {
  const { t } = await setup('home', 'COMPLETED');
  await t.run(async ctx => {
    const ledger = (await ctx.db.query('visitLedger').unique())!; await ctx.db.patch(ledger._id, { cleanupConfirmed: true });
    const runtime = (await ctx.db.query('federationAgentRuntimes').unique())!; await ctx.db.patch(runtime._id, { state: 'TRAVELING', visitId: 'visit-new', agentAuthorityEpoch: 4 });
  });
  await t.mutation(mutationRef('runtime/resumeHome'), { visitId: 'visit-1' });
  const runtime = await t.run(ctx => ctx.db.query('federationAgentRuntimes').unique()); expect(runtime?.state).toBe('TRAVELING'); expect(runtime?.visitId).toBe('visit-new'); expect(runtime?.agentAuthorityEpoch).toBe(4);
  expect(await t.run(ctx => ctx.db.query('inputs').collect())).toEqual([]);
});

test('a queued Host create followed by cancellation is removed before cleanup confirmation', async () => {
  const { t, worldId } = await setup('host', 'CREATING');
  await t.mutation(mutationRef('runtime/createHostPresence'), { visitId: 'visit-1' });
  await t.mutation(mutationRef('ledger/returnVisit'), { adminToken, visitId: 'visit-1' });
  await t.mutation(mutationRef('runtime/removeHostPresence'), { visitId: 'visit-1' });
  await engineStep(t, worldId, 1);
  expect((await t.run(ctx => ctx.db.get(worldId)))?.players).toHaveLength(0);
  expect((await t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('REMOVING');
  expect((await t.run(ctx => ctx.db.query('federationOutbox').collect())).some(o => o.envelope.type === 'VISIT_CLEANED')).toBe(false);
  await engineStep(t, worldId, 1);
  expect((await t.run(ctx => ctx.db.get(worldId)))?.players).toEqual([]);
  expect((await t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('COMPLETED');
  expect((await t.run(ctx => ctx.db.query('visitReservations').unique()))?.reservedSlot).toBe(false);
  await t.run(ctx => hostCreated(ctx, 'visit-1', 'p:10'));
  expect((await t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('COMPLETED');
});

test('wall-clock lease expiry removes Host presence before physics and rejects queued late actions', async () => {
  const { t, worldId } = await setup('host', 'CREATING');
  await t.mutation(mutationRef('runtime/createHostPresence'), { visitId: 'visit-1' }); await engineStep(t, worldId);
  const world = (await t.run(ctx => ctx.db.get(worldId)))!, player = world.players[0];
  await t.run(async ctx => {
    await insertInput(ctx, worldId, 'federationAction', { playerId: player.id, visitId: 'visit-1', actionId: 'late', turnId: 'turn-late', agentAuthorityEpoch: 2, visitLeaseVersion: 1, deadline: Date.now() + 999999, action: { type: 'wait' } });
  });
  jest.setSystemTime(Date.now() + 300001);
  await engineStep(t, worldId, 100, true);
  expect((await t.run(ctx => ctx.db.get(worldId)))?.players).toEqual([]);
  const actionInput = (await t.run(ctx => ctx.db.query('inputs').collect())).find(i => i.name === 'federationAction');
  expect(actionInput?.returnValue).toEqual({ kind: 'error', message: 'CLOCK_UNCERTAIN' });
  expect((await t.run(ctx => ctx.db.query('federationClock').unique()))?.uncertain).toBe(true);
  await t.mutation(mutationRef('ledger/reconcile'), {}); await t.mutation(mutationRef('runtime/removeHostPresence'), { visitId: 'visit-1' }); await engineStep(t, worldId);
  expect((await t.run(ctx => ctx.db.query('visitLedger').unique()))?.cleanupConfirmed).toBe(true);
});

test('local endpoint updates preserve identity, clear stale readiness, and reject HTTP', async () => {
  const { t } = await setup('home', 'COMPLETED');
  await t.run(async ctx => { await ctx.db.insert('transportSessions', { peerTownId: 'host', transportType: 'DIRECT_HTTPS', channelState: 'TRANSPORT_READY', localDeploymentEpoch: 1, verifiedPeerDeploymentEpoch: 1, inboundVerifiedAt: Date.now(), outboundVerifiedAt: Date.now() }); });
  const identityBefore = await t.run(ctx => ctx.db.query('federationIdentity').unique());
  const result = await t.mutation(mutationRef('admin/updateLocalEndpoint'), { adminToken, endpoint: 'new-home.example:9443' }); expect(result.endpoint).toBe('https://new-home.example:9443/federation/v1');
  const identityAfter = await t.run(ctx => ctx.db.query('federationIdentity').unique());
  expect(identityAfter?.townId).toBe(identityBefore?.townId); expect(identityAfter?.publicKey).toBe(identityBefore?.publicKey); expect(identityAfter?.privateKeyEncrypted).toBe(identityBefore?.privateKeyEncrypted); expect(identityAfter?.deploymentEpoch).toBe(identityBefore?.deploymentEpoch);
  const session = await t.run(ctx => ctx.db.query('transportSessions').unique()); expect(session?.channelState).toBe('TRANSPORT_TESTING'); expect(session?.inboundVerifiedAt).toBeUndefined(); expect(session?.outboundVerifiedAt).toBeUndefined();
  await expect(t.mutation(mutationRef('admin/updateLocalEndpoint'), { adminToken, endpoint: 'http://new-home.example' })).rejects.toThrow('HTTPS required');
});

test('public browser cannot submit system inputs while internal AI activity, wander and memory completion still work', async () => {
  const { t, worldId } = await setup('home', 'COMPLETED');
  const publicInput = makeFunctionReference<'mutation'>('aiTown/main:sendInput');
  const internalInput = makeFunctionReference<'mutation'>('aiTown/main:sendAgentInput');
  for (const name of ['finishDoSomething', 'finishRememberConversation', 'federationSuspend', 'federationAction', 'createAgent']) await expect(t.mutation(publicInput, { worldId, name, args: { agentId: 'a:1', playerId: 'p:0', operationId: 'forged' } })).rejects.toThrow('SYSTEM_INPUT_NOT_PUBLIC');
  expect(await t.run(ctx => ctx.db.query('inputs').collect())).toEqual([]);
  async function operation(name: string, operationId: string, toRemember?: string) {
    await t.run(async ctx => {
      const world = (await ctx.db.get(worldId))!;
      await ctx.db.patch(worldId, { agents: world.agents.map(agent => ({ ...agent, inProgressOperation: { name, operationId, started: Date.now() }, ...(toRemember ? { toRemember: toRemember as any } : {}) })) });
    });
  }
  await operation('agentDoSomething', 'activity-op');
  await t.mutation(internalInput, { worldId, name: 'finishDoSomething', args: { agentId: 'a:1', operationId: 'activity-op', activity: { description: 'Reading', emoji: '📖', until: Date.now() + 30000 } } });
  await engineStep(t, worldId);
  let world = (await t.run(ctx => ctx.db.get(worldId)))!;
  expect(world.players[0].activity?.description).toBe('Reading'); expect(world.agents[0].inProgressOperation).toBeUndefined();
  await operation('agentDoSomething', 'wander-op');
  await t.mutation(internalInput, { worldId, name: 'finishDoSomething', args: { agentId: 'a:1', operationId: 'wander-op', destination: { x: 4, y: 4 } } });
  await engineStep(t, worldId);
  world = (await t.run(ctx => ctx.db.get(worldId)))!;
  expect(world.players[0].pathfinding?.destination).toEqual({ x: 4, y: 4 }); expect(world.agents[0].inProgressOperation).toBeUndefined();
  await operation('agentRememberConversation', 'remember-op', 'c:8');
  await t.mutation(internalInput, { worldId, name: 'finishRememberConversation', args: { agentId: 'a:1', operationId: 'remember-op' } });
  await engineStep(t, worldId);
  world = (await t.run(ctx => ctx.db.get(worldId)))!;
  expect(world.agents[0].toRemember).toBeUndefined(); expect(world.agents[0].inProgressOperation).toBeUndefined();
  const inputs = await t.run(ctx => ctx.db.query('inputs').collect()); expect(inputs).toHaveLength(3); expect(inputs.every(input => input.returnValue?.kind === 'ok')).toBe(true);
});

async function prepareEngineCommit(t: ReturnType<typeof convexTest<typeof schema.tables>>, worldId: Id<'worlds'>) {
  const status = (await t.query(ctx => ctx.db.query('worldStatus').withIndex('worldId', q => q.eq('worldId', worldId)).unique()))!;
  const engine = (await t.query(ctx => ctx.db.get(status.engineId)))!;
  const loaded = await t.query(ctx => Game.load(ctx.db, worldId, engine.generationNumber));
  const game = new Game(loaded.engine, worldId, loaded.gameState);
  game.beginStep(Date.now());
  const pending = await t.query(makeFunctionReference<'query'>('engine/abstractGame:loadInputs'), { engineId: engine._id, processedInputNumber: engine.processedInputNumber, max: 100 });
  const completedInputs = pending.map((input: any) => {
    try { return { inputId: input._id, returnValue: { kind: 'ok' as const, value: game.handleInput(Date.now(), input.name as any, input.args) } }; }
    catch (error) { return { inputId: input._id, returnValue: { kind: 'error' as const, message: error instanceof Error ? error.message : String(error) } }; }
  });
  const { _id, _creationTime, ...engineData } = engine;
  return { engineId: engine._id, worldId, worldDiff: game.takeDiff(), engineUpdate: { expectedGenerationNumber: engine.generationNumber,
    engine: { ...engineData, currentTime: Date.now(), generationNumber: engine.generationNumber + 1, ...(pending.length ? { processedInputNumber: pending[pending.length - 1].number } : {}) }, completedInputs } };
}

test.each(['renewal', 'return', 'authority'] as const)('fenced %s commit rolls back side effects, then a fresh input load rejects it and advances the world', async race => {
  const { t, worldId } = await setup('host', 'CREATING');
  await t.mutation(mutationRef('runtime/createHostPresence'), { visitId: 'visit-1' }); await engineStep(t, worldId);
  const deadline = Date.now() + 25000;
  await t.run(async ctx => {
    const world = (await ctx.db.get(worldId))!, player = world.players[0];
    await ctx.db.patch(worldId, { players: [{ ...player, position: { x: 2, y: 2 }, remoteVisitor: { ...player.remoteVisitor!, pendingTurn: { eventId: 'race-event', turnId: 'race-turn', deadline } } }] });
    await ctx.db.insert('federationTurns', { visitId: 'visit-1', eventId: 'race-event', turnId: 'race-turn', worldId, playerId: player.id, deadline, state: 'PENDING' });
    await dispatchRuntimeMessage(ctx, { protocol: 'ai-town-federation/1', messageId: 'race-message', fromTownId: 'home', toTownId: 'host',
      senderDeploymentInstanceId: 'home-instance', senderDeploymentEpoch: 1, expectedRecipientDeploymentEpoch: 1, credentialId: 'pair-credential', nonce: 'race-nonce', sentAt: Date.now(), expiresAt: Date.now() + 30000,
      type: 'DECISION', visitId: 'visit-1', agentGlobalId: 'home/agent:alice', agentAuthorityEpoch: 2, visitLeaseVersion: 1,
      payload: { actionId: 'race-action', turnId: 'race-turn', basedOnEventId: 'race-event', action: { type: 'moveTo', destination: { x: 4, y: 4 } } } });
  });
  const computed = await prepareEngineCommit(t, worldId);
  expect(computed.engineUpdate.completedInputs[0].returnValue.kind).toBe('ok');
  expect(computed.worldDiff.world.players[0].pathfinding?.destination).toEqual({ x: 4, y: 4 });
  if (race === 'renewal') {
    await t.run(async ctx => { const ledger = (await ctx.db.query('visitLedger').unique())!; await ctx.db.patch(ledger._id, { visitLeaseVersion: 2, leaseExpiry: Date.now() + 360000 }); });
    await t.mutation(mutationRef('runtime/updateHostLease'), { visitId: 'visit-1' });
  } else if (race === 'authority') {
    await t.run(async ctx => { const ledger = (await ctx.db.query('visitLedger').unique())!; await ctx.db.patch(ledger._id, { agentAuthorityEpoch: 3 }); });
    await t.run(ctx => insertInput(ctx, worldId, 'federationRemoveVisitor', { visitId: 'visit-1' }));
  } else {
    await t.mutation(mutationRef('ledger/returnVisit'), { adminToken, visitId: 'visit-1' });
    await t.mutation(mutationRef('runtime/removeHostPresence'), { visitId: 'visit-1' });
  }
  await expect(t.mutation(makeFunctionReference<'mutation'>('aiTown/game:saveWorld'), computed)).rejects.toThrow('STALE_FEDERATION_ENGINE_COMMIT');
  const persisted = (await t.query(ctx => ctx.db.get(worldId)))!;
  expect(persisted.players[0].pathfinding).toBeUndefined();
  const job = (await t.query(ctx => ctx.db.query('federationPendingActions').unique()))!;
  expect(job.state).toBe('PENDING');
  const originalInput = (await t.query(ctx => ctx.db.get(job.inputId)))!;
  expect(originalInput.args.deadline).toBe(deadline); expect(originalInput.returnValue).toBeUndefined();
  const retried = await prepareEngineCommit(t, worldId);
  expect(retried.engineUpdate.completedInputs[0].returnValue).toEqual({ kind: 'error', message: 'STALE_TURN' });
  expect(retried.engineUpdate.completedInputs[1].returnValue.kind).toBe('ok');
  await t.mutation(makeFunctionReference<'mutation'>('aiTown/game:saveWorld'), retried);
  expect((await t.query(ctx => ctx.db.query('federationPendingActions').unique()))?.state).toBe('REJECTED');
  const completed = (await t.query(ctx => ctx.db.get(job.inputId)))!;
  expect(completed.args.deadline).toBe(deadline); expect(completed.returnValue).toEqual({ kind: 'error', message: 'STALE_TURN' });
  const engine = (await t.query(ctx => ctx.db.get(computed.engineId)))!;
  expect(engine.generationNumber).toBe(computed.engineUpdate.engine.generationNumber); expect(engine.processedInputNumber).toBe(originalInput.number + 1);
  expect(await t.query(ctx => ctx.db.query('messages').collect())).toEqual([]);
  const results = (await t.query(ctx => ctx.db.query('federationOutbox').collect())).filter(item => item.envelope.type === 'ACTION_RESULT');
  expect(results.some(result => result.envelope.payload.accepted === true)).toBe(false);
  const returned = (await t.query(ctx => ctx.db.get(worldId)))!;
  if (race === 'renewal') { expect(returned.players[0].remoteVisitor?.visitLeaseVersion).toBe(2); expect(returned.players[0].pathfinding).toBeUndefined(); }
  else { expect(returned.players).toEqual([]); if (race === 'return') expect((await t.query(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('COMPLETED'); }
});

test.each([
  ['revoked', 'success'], ['revoked', 'error'], ['full', 'success'], ['full', 'error'],
] as const)('%s peer or queue permits a durable %s receipt and world commit, then retries the receipt', async (blocker, outcome) => {
  const { t, worldId } = await setup('host', 'CREATING');
  await t.mutation(mutationRef('runtime/createHostPresence'), { visitId: 'visit-1' }); await engineStep(t, worldId);
  const deadline = Date.now() + 25000;
  await t.run(async ctx => {
    const world = (await ctx.db.get(worldId))!, player = world.players[0];
    await ctx.db.patch(worldId, { players: [{ ...player, position: { x: 2, y: 2 }, remoteVisitor: { ...player.remoteVisitor!, pendingTurn: { eventId: 'receipt-event', turnId: 'receipt-turn', deadline } } }] });
    await ctx.db.insert('federationTurns', { visitId: 'visit-1', eventId: 'receipt-event', turnId: 'receipt-turn', worldId, playerId: player.id, deadline, state: 'PENDING' });
    await dispatchRuntimeMessage(ctx, { protocol: 'ai-town-federation/1', messageId: 'receipt-message', fromTownId: 'home', toTownId: 'host',
      senderDeploymentInstanceId: 'home-instance', senderDeploymentEpoch: 1, expectedRecipientDeploymentEpoch: 1, credentialId: 'pair-credential', nonce: 'receipt-nonce', sentAt: Date.now(), expiresAt: Date.now() + 30000,
      type: 'DECISION', visitId: 'visit-1', agentGlobalId: 'home/agent:alice', agentAuthorityEpoch: 2, visitLeaseVersion: 1,
      payload: { actionId: 'receipt-action', turnId: 'receipt-turn', basedOnEventId: 'receipt-event', action: { type: 'moveTo', destination: outcome === 'success' ? { x: 4, y: 4 } : { x: -1, y: -1 } } } });
  });
  const computed = await prepareEngineCommit(t, worldId);
  expect(computed.engineUpdate.completedInputs[0].returnValue.kind).toBe(outcome === 'success' ? 'ok' : 'error');
  await t.run(async ctx => {
    if (blocker === 'revoked') {
      const remote = (await ctx.db.query('federationPeers').unique())!; await ctx.db.patch(remote._id, { trustState: 'REVOKED' });
    } else {
      for (let index = 0; index < 900; index++) await ctx.db.insert('federationOutbox', { messageId: `receipt-full-${index}`, toTownId: 'home', envelope: { type: 'OBSERVATION' }, attempts: 0, nextRetryAt: Date.now() + 60000 });
    }
  });
  await t.mutation(makeFunctionReference<'mutation'>('aiTown/game:saveWorld'), computed);
  const first = (await t.query(ctx => ctx.db.query('federationPendingActions').unique()))!;
  expect(first.state).toBe(outcome === 'success' ? 'COMMITTED' : 'REJECTED'); expect(first.receiptPending).toBe(true); expect(first.receiptPayload.accepted).toBe(outcome === 'success');
  const committedWorld = (await t.query(ctx => ctx.db.get(worldId)))!;
  expect(committedWorld.players[0].pathfinding?.destination).toEqual(outcome === 'success' ? { x: 4, y: 4 } : undefined);
  expect((await t.query(ctx => ctx.db.get(first.inputId)))?.returnValue?.kind).toBe(outcome === 'success' ? 'ok' : 'error');
  expect((await t.query(ctx => ctx.db.get(computed.engineId)))?.processedInputNumber).toBe(computed.engineUpdate.engine.processedInputNumber);
  expect((await t.query(ctx => ctx.db.query('federationOutbox').collect())).some(item => item.envelope.type === 'ACTION_RESULT')).toBe(false);
  await t.mutation(mutationRef('runtime/reconcileEngineJobs'), {});
  expect((await t.query(ctx => ctx.db.query('federationPendingActions').unique()))?.receiptPending).toBe(true);
  await t.run(async ctx => {
    if (blocker === 'revoked') {
      const remote = (await ctx.db.query('federationPeers').unique())!; await ctx.db.patch(remote._id, { trustState: 'TRUSTED' });
    } else {
      const queued = await ctx.db.query('federationOutbox').collect();
      for (const item of queued) if (item.messageId.startsWith('receipt-full-')) await ctx.db.delete(item._id);
    }
  });
  jest.setSystemTime(Date.now() + 10001);
  await t.mutation(mutationRef('runtime/reconcileEngineJobs'), {});
  await t.mutation(mutationRef('runtime/reconcileEngineJobs'), {});
  expect((await t.query(ctx => ctx.db.query('federationPendingActions').unique()))?.receiptPending).toBe(false);
  const receipts = (await t.query(ctx => ctx.db.query('federationOutbox').collect())).filter(item => item.envelope.type === 'ACTION_RESULT');
  expect(receipts).toHaveLength(1); expect(receipts[0].envelope.payload).toEqual(first.receiptPayload);
});

test('a deferred committed receipt remains a fact but cannot be reauthorized under a newer lease', async () => {
  const { t, worldId } = await setup('host', 'ACTIVE');
  await t.run(async ctx => {
    const status = (await ctx.db.query('worldStatus').unique())!;
    const inputId = await ctx.db.insert('inputs', { engineId: status.engineId, number: 0, name: 'federationAction', args: {}, received: Date.now(), returnValue: { kind: 'ok', value: null } });
    await ctx.db.insert('federationPendingActions', { actionId: 'old-receipt', visitId: 'visit-1', turnId: 'old-turn', basedOnEventId: 'old-event', agentAuthorityEpoch: 2, visitLeaseVersion: 1, action: { type: 'wait' }, inputId,
      state: 'COMMITTED', createdAt: Date.now(), result: { kind: 'ok', value: null }, receiptPending: true, receiptPayload: { actionId: 'old-receipt', accepted: true, occurredAt: Date.now() } });
    const ledger = (await ctx.db.query('visitLedger').unique())!; await ctx.db.patch(ledger._id, { visitLeaseVersion: 2 });
  });
  await t.mutation(mutationRef('runtime/reconcileEngineJobs'), {});
  const job = await t.query(ctx => ctx.db.query('federationPendingActions').unique()); expect(job?.state).toBe('COMMITTED'); expect(job?.receiptPending).toBe(false); expect(job?.receiptPayload.accepted).toBe(true);
  expect(await t.query(ctx => ctx.db.query('federationOutbox').collect())).toEqual([]);
});

test('blocked receipts back off so a bounded batch can reach another trusted peer', async () => {
  const { t } = await setup('host', 'ACTIVE');
  await t.run(async ctx => {
    const remote = (await ctx.db.query('federationPeers').unique())!, ledger = (await ctx.db.query('visitLedger').unique())!, status = (await ctx.db.query('worldStatus').unique())!;
    await ctx.db.patch(remote._id, { trustState: 'REVOKED' });
    const { _id: peerId, _creationTime: peerCreated, ...remoteData } = remote;
    await ctx.db.insert('federationPeers', { ...remoteData, townId: 'reachable', trustState: 'TRUSTED' });
    const { _id: ledgerId, _creationTime: ledgerCreated, ...ledgerData } = ledger;
    await ctx.db.insert('visitLedger', { ...ledgerData, visitId: 'fast-visit', agentGlobalId: 'reachable/agent:alice', homeTownId: 'reachable' });
    for (let index = 0; index < 51; index++) {
      const actionId = `batch-action-${index}`, visitId = index === 50 ? 'fast-visit' : 'visit-1';
      const inputId = await ctx.db.insert('inputs', { engineId: status.engineId, number: index, name: 'federationAction', args: {}, received: Date.now(), returnValue: { kind: 'ok', value: null } });
      await ctx.db.insert('federationPendingActions', { actionId, visitId, turnId: `batch-turn-${index}`, basedOnEventId: `batch-event-${index}`, agentAuthorityEpoch: 2, visitLeaseVersion: 1, action: { type: 'wait' }, inputId,
        state: 'COMMITTED', createdAt: Date.now() + index, result: { kind: 'ok', value: null }, receiptPending: true, receiptPayload: { actionId, accepted: true, occurredAt: Date.now() } });
    }
  });
  await t.mutation(mutationRef('runtime/reconcileEngineJobs'), {});
  expect(await t.query(ctx => ctx.db.query('federationOutbox').collect())).toEqual([]);
  await t.mutation(mutationRef('runtime/reconcileEngineJobs'), {});
  const outbox = await t.query(ctx => ctx.db.query('federationOutbox').collect());
  expect(outbox).toHaveLength(1); expect(outbox[0].toTownId).toBe('reachable'); expect(outbox[0].envelope.payload.actionId).toBe('batch-action-50');
  const blocked = await t.query(ctx => ctx.db.query('federationPendingActions').withIndex('action', q => q.eq('actionId', 'batch-action-0')).unique()); expect(blocked?.receiptPending).toBe(true); expect(blocked?.receiptRetryAt).toBeGreaterThan(Date.now());
});

test('an expired superseded return closes only the old ledger without resuming a newer authority', async () => {
  const { t, worldId } = await setup('home', 'RETURN_PENDING');
  await t.run(async ctx => {
    const ledger = (await ctx.db.query('visitLedger').unique())!;
    await ctx.db.patch(ledger._id, { leaseExpiry: Date.now() - 60_001 });
    const runtime = (await ctx.db.query('federationAgentRuntimes').unique())!;
    await ctx.db.patch(runtime._id, { state: 'TRAVELING', visitId: 'visit-new', agentAuthorityEpoch: 4 });
  });
  const before = await t.run(ctx => ctx.db.get(worldId));
  await t.mutation(mutationRef('runtime/resumeHome'), { visitId: 'visit-1' });
  expect((await t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('COMPLETED');
  expect(await t.run(ctx => ctx.db.query('federationAgentRuntimes').unique())).toMatchObject({ state: 'TRAVELING', visitId: 'visit-new', agentAuthorityEpoch: 4 });
  expect(await t.run(ctx => ctx.db.get(worldId))).toEqual(before);
  expect(await t.run(ctx => ctx.db.query('inputs').collect())).toEqual([]);
});

test('superseded return cannot close a ledger while its old lease safety margin remains', async () => {
  const { t } = await setup('home', 'RETURN_PENDING');
  await t.run(async ctx => {
    const ledger = (await ctx.db.query('visitLedger').unique())!;
    await ctx.db.patch(ledger._id, { cleanupConfirmed: true, leaseExpiry: Date.now() - 59_000 });
    const runtime = (await ctx.db.query('federationAgentRuntimes').unique())!;
    await ctx.db.patch(runtime._id, { state: 'HOME_ACTIVE', visitId: undefined, agentAuthorityEpoch: 4 });
  });
  await t.mutation(mutationRef('runtime/resumeHome'), { visitId: 'visit-1' });
  expect((await t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('RETURN_PENDING');
  expect(await t.run(ctx => ctx.db.query('inputs').collect())).toEqual([]);
});


test('clock lock rejects queued Host creation and removes existing proxy before physics', async () => {
  const { t, worldId } = await setup('host', 'CREATING');
  await t.run(async ctx => { const clock = (await ctx.db.query('federationClock').unique())!; await ctx.db.patch(clock._id, { observedAt: Date.now(), uncertain: true, reason: 'CLOCK_MOVED_BACKWARDS' }); });
  await expect(t.mutation(mutationRef('runtime/createHostPresence'), { visitId: 'visit-1' })).rejects.toThrow('CLOCK_UNCERTAIN');
  await t.run(async ctx => {
    const world = (await ctx.db.get(worldId))!;
    await ctx.db.patch(worldId, { players: [{ id: 'p:2' as any, lastInput: Date.now(), position: { x: 2, y: 2 }, facing: { dx: 1, dy: 0 }, speed: 4,
      remoteVisitor: { visitId: 'visit-1', agentGlobalId: 'home/agent:alice', homeTownId: 'home', homeTownName: 'Home', agentAuthorityEpoch: 2, visitLeaseVersion: 1, leaseExpiry: Date.now() + 300000, lastObservationAt: 0 } }] });
    const ledger = (await ctx.db.query('visitLedger').unique())!;
    await ctx.db.patch(ledger._id, { state: 'ACTIVE', hostPlayerId: 'p:2' });
  });
  await engineStep(t, worldId, 100, true);
  expect((await t.run(ctx => ctx.db.get(worldId)))?.players).toHaveLength(0);
  expect((await t.run(ctx => ctx.db.query('federationClock').unique()))?.uncertain).toBe(true);
});

test('final saveDiff gate rolls back Host side effects if clock locks after loading the action', async () => {
  const { t, worldId } = await setup('host', 'CREATING');
  await t.mutation(mutationRef('runtime/createHostPresence'), { visitId: 'visit-1' });
  const diff = await t.run(async ctx => {
    const engine = (await ctx.db.query('engines').unique())!;
    const loaded = await Game.load(ctx.db, worldId, engine.generationNumber);
    const game = new Game(loaded.engine, worldId, loaded.gameState);
    const input = (await ctx.db.query('inputs').unique())!;
    game.handleInput(Date.now(), input.name as any, input.args);
    return game.takeDiff();
  });
  await t.run(async ctx => { const clock = (await ctx.db.query('federationClock').unique())!; await ctx.db.patch(clock._id, { observedAt: Date.now(), uncertain: true, reason: 'CLOCK_OBSERVATION_GAP' }); });
  await expect(t.run(ctx => Game.saveDiff(ctx, worldId, diff))).rejects.toThrow('CLOCK_UNCERTAIN');
  expect((await t.run(ctx => ctx.db.get(worldId)))?.players).toHaveLength(0);
  expect(await t.run(ctx => ctx.db.query('messages').collect())).toHaveLength(0);
});

test('clock lock prevents wall-clock-only Home resumption but permits signed cleanup', async () => {
  const { t, worldId } = await setup('home', 'RETURN_PENDING');
  await t.run(async ctx => {
    const clock = (await ctx.db.query('federationClock').unique())!;
    await ctx.db.patch(clock._id, { observedAt: Date.now(), uncertain: true, reason: 'CLOCK_MOVED_BACKWARDS' });
    const ledger = (await ctx.db.query('visitLedger').unique())!, world = (await ctx.db.get(worldId))!;
    await ctx.db.patch(ledger._id, { leaseExpiry: Date.now() - 1000000 });
    await ctx.db.patch(worldId, { players: [], agents: [{ ...world.agents[0], travelVisitId: 'visit-1', suspendedPlayer: world.players[0] }] });
  });
  await expect(t.mutation(mutationRef('runtime/resumeHome'), { visitId: 'visit-1' })).rejects.toThrow('HOST_LEASE_STILL_VALID');
  await t.run(async ctx => { const ledger = (await ctx.db.query('visitLedger').unique())!; await ctx.db.patch(ledger._id, { cleanupConfirmed: true }); });
  await t.mutation(mutationRef('runtime/resumeHome'), { visitId: 'visit-1' });
  await engineStep(t, worldId);
  expect((await t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('COMPLETED');
  expect((await t.run(ctx => ctx.db.get(worldId)))?.players).toHaveLength(1);
  expect((await t.run(ctx => ctx.db.query('federationClock').unique()))?.uncertain).toBe(true);
});

test('new trips persist conservative return boundaries that configuration changes and renewal cannot shrink', async () => {
  const { t, worldId } = await setup('home', 'COMPLETED');
  await t.run(async ctx => {
    const clock = (await ctx.db.query('federationClock').unique())!;
    await ctx.db.delete(clock._id);
    const runtime = (await ctx.db.query('federationAgentRuntimes').unique())!;
    await ctx.db.patch(runtime._id, { state: 'HOME_ACTIVE', visitId: undefined });
    const profileId = await ctx.db.insert('chatProfiles', { name: 'Travel fixture', provider: 'custom', url: 'https://model.example/v1', model: 'fixture', stopWords: [], createdAt: Date.now() });
    await ctx.db.insert('residentModelBindings', { worldId, playerId: 'p:0' as any, agentGlobalId: runtime.agentGlobalId, chatProfileId: profileId, createdAt: Date.now(), updatedAt: Date.now() });
    const local = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(local._id, { timePolicy: { reservationMs: 30000, leaseMs: 90000, clockSkewMs: 30000, probeFreshnessMs: 120000, probeIntervalMs: 45000, gapTimeoutMs: 30000, returnMarginMs: 60000, clockObservationGapMs: 120000, requestTimeoutMs: 8000 } });
    await ctx.db.insert('transportSessions', { peerTownId: 'host', transportType: 'DIRECT_HTTPS', channelState: 'TRANSPORT_READY', localDeploymentEpoch: 1, verifiedPeerDeploymentEpoch: 1, inboundVerifiedAt: Date.now(), outboundVerifiedAt: Date.now() });
  });
  const startedAt = Date.now();
  const result = await t.mutation(mutationRef('ledger/startVisit'), { adminToken, peerTownId: 'host', worldId, homePlayerId: 'p:0' }) as { visitId: string };
  const ledger = await t.run(ctx => ctx.db.query('visitLedger').withIndex('visitId', q => q.eq('visitId', result.visitId)).unique());
  expect(await t.run(ctx => ctx.db.query('federationClock').unique())).toMatchObject({ observedAt: startedAt, uncertain: false });
  expect(ledger).toMatchObject({ leaseExpiry: startedAt + 90000, leaseSafetyMs: 300000, tripDeadline: startedAt + 300000 });
  await t.mutation(mutationRef('admin/configureTimePolicy'), { adminToken, policy: { reservationMs: 30000, leaseMs: 90000, clockSkewMs: 30000, probeFreshnessMs: 120000, probeIntervalMs: 45000, gapTimeoutMs: 30000, returnMarginMs: 60000, clockObservationGapMs: 30000, requestTimeoutMs: 8000 } });
  await t.run(ctx => ctx.db.patch(ledger!._id, { state: 'ACTIVE' }));
  jest.setSystemTime(startedAt + 20000);
  await t.mutation(mutationRef('ledger/renewVisit'), { adminToken, visitId: result.visitId });
  const renewed = await t.run(ctx => ctx.db.get(ledger!._id));
  expect(renewed).toMatchObject({ leaseExpiry: startedAt + 110000, leaseSafetyMs: 300000, tripDeadline: startedAt + 300000, visitLeaseVersion: 2 });
  const longerGap = { reservationMs: 30000, leaseMs: 90000, clockSkewMs: 30000, probeFreshnessMs: 120000, probeIntervalMs: 45000, gapTimeoutMs: 30000, returnMarginMs: 60000, clockObservationGapMs: 600000, requestTimeoutMs: 8000 };
  await expect(t.mutation(mutationRef('admin/configureTimePolicy'), { adminToken, policy: longerGap })).rejects.toThrow('END_ALL_VISITS_BEFORE_INCREASING_CLOCK_GAP');
  expect((await t.run(ctx => ctx.db.query('federationIdentity').unique()))?.timePolicy?.clockObservationGapMs).toBe(30000);
  expect((await t.run(ctx => ctx.db.get(ledger!._id)))?.leaseSafetyMs).toBe(300000);
  await t.run(ctx => ctx.db.patch(ledger!._id, { state: 'COMPLETED' }));
  await t.mutation(mutationRef('admin/configureTimePolicy'), { adminToken, policy: longerGap });
  expect((await t.run(ctx => ctx.db.query('federationIdentity').unique()))?.timePolicy?.clockObservationGapMs).toBe(600000);
});


test('an unreachable Host drains after explicit UTC return confirmation while new authority remains locked', async () => {
  const { t, worldId } = await setup('home', 'RETURN_PENDING');
  const startedAt = Date.now();
  await t.run(async ctx => {
    await observeClock(ctx, await ctx.db.query('federationIdentity').unique());
    const ledger = (await ctx.db.query('visitLedger').unique())!, world = (await ctx.db.get(worldId))!;
    await ctx.db.patch(ledger._id, { leaseExpiry: startedAt + 1000, leaseSafetyMs: 120000 });
    await ctx.db.patch(worldId, { players: [], agents: [{ ...world.agents[0], travelVisitId: 'visit-1', suspendedPlayer: world.players[0] }] });
  });
  jest.setSystemTime(startedAt + 120001);
  await t.run(ctx => observeClock(ctx, null));
  await expect(t.mutation(mutationRef('runtime/resumeHome'), { visitId: 'visit-1' })).rejects.toThrow('HOST_LEASE_STILL_VALID');
  await t.mutation(mutationRef('admin/confirmReturnClock'), { adminToken, synchronizedUtcConfirmed: true });
  expect(await t.run(ctx => readClock(ctx.db))).toMatchObject({ healthy: false, returnClockHealthy: true });
  await expect(t.mutation(mutationRef('ledger/startVisit'), { adminToken, peerTownId: 'host', worldId, homePlayerId: 'p:0' })).rejects.toThrow('CLOCK_UNCERTAIN');
  await expect(t.mutation(mutationRef('admin/confirmClockRecovery'), { adminToken, synchronizedUtcConfirmed: true })).rejects.toThrow('END_ALL_VISITS_BEFORE_CLOCK_RECOVERY');
  await expect(t.mutation(mutationRef('runtime/resumeHome'), { visitId: 'visit-1' })).rejects.toThrow('HOST_LEASE_STILL_VALID');
  jest.setSystemTime(startedAt + 121000);
  await t.mutation(mutationRef('runtime/resumeHome'), { visitId: 'visit-1' });
  await engineStep(t, worldId);
  const ledger = await t.run(ctx => ctx.db.query('visitLedger').unique());
  expect(ledger).toMatchObject({ state: 'COMPLETED', leaseSafetyMs: 120000 });
  expect(ledger?.cleanupConfirmed).not.toBe(true);
  expect((await t.run(ctx => ctx.db.get(worldId)))?.players).toHaveLength(1);
  expect((await t.run(ctx => readClock(ctx.db))).healthy).toBe(false);
  await t.mutation(mutationRef('admin/confirmClockRecovery'), { adminToken, synchronizedUtcConfirmed: true });
  expect((await t.run(ctx => readClock(ctx.db))).healthy).toBe(true);
});


test('departure guard ignores terminal history but blocks every nonterminal range and unknown state', async () => {
  const { t } = await setup('home', 'COMPLETED');
  const agentGlobalId = 'home/agent:alice';
  await t.run(async ctx => {
    const source = (await ctx.db.query('visitLedger').unique())!;
    const { _id, _creationTime, ...fields } = source;
    for (let i = 0; i < 250; i++) await ctx.db.insert('visitLedger', { ...fields, visitId: `terminal-${i}`, state: i % 2 ? 'COMPLETED' : 'REJECTED' });
  });
  expect(await t.run(ctx => hasNonterminalVisit(ctx, agentGlobalId))).toBe(false);
  for (const state of ['ACTIVE', 'CONFIRMING', 'RETURN_PENDING', 'UNKNOWN_FUTURE_STATE']) {
    const id = await t.run(async ctx => {
      const source = (await ctx.db.query('visitLedger').withIndex('visitId', q => q.eq('visitId', 'visit-1')).unique())!;
      const { _id, _creationTime, ...fields } = source;
      return await ctx.db.insert('visitLedger', { ...fields, visitId: `blocking-${state}`, state });
    });
    expect(await t.run(ctx => hasNonterminalVisit(ctx, agentGlobalId))).toBe(true);
    expect(await t.run(ctx => hasNonterminalVisit(ctx, 'unrelated-resident'))).toBe(false);
    await t.run(ctx => ctx.db.delete(id));
  }
  expect(await t.run(ctx => hasNonterminalVisit(ctx, agentGlobalId))).toBe(false);
});
