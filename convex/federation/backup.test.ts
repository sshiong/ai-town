import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { Id } from '../_generated/dataModel';
import { convexToJson, type Value } from 'convex/values';
import { createIdentityKeys, digest, sign } from './security';
import { BackupBundle, decodeRow, encodeRow, validateBundle } from './backupHelpers';
import { embeddingFingerprint } from '../models/compatibility';
import { applyBackupData } from './backup';
import { defaultStoragePolicy } from './storagePolicy';
import { receiveConversationEnded } from '../agent/travelTranscript';
import { DEFAULT_RESOURCE_LIMITS } from './resources';
import { Game } from '../aiTown/game';
import { engineInsertInput } from '../engine/abstractGame';
import type { ActionCtx } from '../_generated/server';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/backup.ts': () => import('./backup'),
  '../federation/backupExportAudit.ts': () => import('./backupExportAudit'),
  '../models/embeddings.ts': () => import('../models/embeddings'),
  '../engine/abstractGame.ts': () => import('../engine/abstractGame'),
  '../aiTown/game.ts': () => import('../aiTown/game'),
};
const action = (name: string) => makeFunctionReference<'action'>(name);
const adminToken = 'test-admin-token-24-characters';
beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
});
beforeEach(() => {
  jest.useFakeTimers();
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});
afterEach(() => {
  jest.useRealTimers();
});

async function town() {
  const t = convexTest(schema, modules);
  const keys = await createIdentityKeys();
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert('federationIdentity', {
      ...keys,
      townId: 'town:original',
      townName: 'Original',
      deploymentInstanceId: 'instance-old',
      deploymentEpoch: 4,
      endpoint: 'https://original.example/federation/v1',
      enabled: false,
      allowIncomingPairRequests: false,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 8,
      maxVisitDurationMs: 300000,
      resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, maxConcurrentLocalLLM: 1, maxVisitReservations: 3 },
      mode: 'ACTIVE',
      createdAt: 1,
    });
    const engineId = await ctx.db.insert('engines', { running: false, generationNumber: 1 });
    const worldId = await ctx.db.insert('worlds', {
      nextId: 3,
      players: [
        { id: 'p:0', lastInput: 1, position: { x: 1, y: 1 }, facing: { dx: 1, dy: 0 }, speed: 0 },
      ],
      agents: [{ id: 'a:1', playerId: 'p:0' }],
      conversations: [],
    });
    await ctx.db.insert('worldStatus', {
      worldId,
      engineId,
      isDefault: true,
      lastViewed: 1,
      status: 'stoppedByDeveloper',
    });
    await ctx.db.insert('maps', {
      worldId,
      width: 3,
      height: 3,
      tileSetUrl: '/tiles.png',
      tileSetDimX: 32,
      tileSetDimY: 32,
      tileDim: 16,
      bgTiles: [[[0]]],
      objectTiles: [
        [
          [-1, -1, -1],
          [-1, -1, -1],
          [-1, -1, -1],
        ],
      ],
      animatedSprites: [],
    });
    await ctx.db.insert('playerDescriptions', {
      worldId,
      playerId: 'p:0',
      name: 'Ada',
      description: 'Scientist',
      character: 'f1',
    });
    await ctx.db.insert('agentDescriptions', {
      worldId,
      agentId: 'a:1',
      identity: 'I am Ada.',
      plan: 'Visit friends.',
    });
    const chatProfileId = await ctx.db.insert('chatProfiles', {
      name: 'Fixed Chat',
      provider: 'custom',
      url: 'https://chat.example',
      model: 'chat-original',
      apiKeyEnv: 'UNCONFIGURED_CHAT_KEY',
      stopWords: [],
      createdAt: 1,
    });
    const embedding = {
      name: 'Fixed Embed',
      provider: 'custom' as const,
      url: 'https://embed.example',
      model: 'embed-original',
      apiKeyEnv: 'UNCONFIGURED_EMBED_KEY',
      dimensions: 2,
      preprocessingRevision: 'newline-to-space-v1',
      queryPrefix: '',
      documentPrefix: '',
      normalization: 'none',
    };
    const embeddingProfileId = await ctx.db.insert('embeddingProfiles', {
      ...embedding,
      fingerprint: embeddingFingerprint(embedding),
      createdAt: 1,
    });
    const spaceId = await ctx.db.insert('embeddingSpaces', {
      profileId: embeddingProfileId,
      fingerprint: embeddingFingerprint(embedding),
      status: 'ACTIVE',
      createdAt: 1,
      validatedAt: 1,
    });
    await ctx.db.insert('modelSettings', {
      key: 'town',
      mainChatProfileId: chatProfileId,
      activeEmbeddingSpaceId: spaceId,
    });
    const agentGlobalId = `town:original/agent:${worldId}:a:1`;
    await ctx.db.insert('residentModelBindings', {
      worldId,
      playerId: 'p:0',
      agentGlobalId,
      chatProfileId,
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('federationAgentRuntimes', {
      worldId,
      playerId: 'p:0',
      agentId: 'a:1',
      agentGlobalId,
      homeTownId: 'town:original',
      state: 'HOME_ACTIVE',
      agentAuthorityEpoch: 3,
      updatedAt: 1,
    });
    const memoryId = await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:0',
      agentGlobalId,
      description: 'I met Ava abroad.',
      importance: 8,
      lastAccess: 1,
      data: {
        type: 'travel',
        eventId: 'event-1',
        visitId: 'visit-1',
        hostTownId: 'town:foreign',
        participants: [
          { agentGlobalId: 'town:foreign/agent:ava', homeTownId: 'town:foreign', name: 'Ava' },
        ],
        occurredAt: 1,
      },
    });
    await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:0',
      agentGlobalId,
      description: 'Ava is a friend.',
      importance: 9,
      lastAccess: 1,
      data: { type: 'reflection', relatedMemoryIds: [memoryId] },
    });
    await ctx.db.insert('modelMemoryVectors', {
      memoryId,
      worldId,
      playerId: 'p:0',
      agentGlobalId,
      spaceId,
      embedding: [1, 0],
    });
    await ctx.db.insert('archivedConversations', {
      worldId,
      id: 'c:2',
      creator: 'p:0',
      created: 1,
      ended: 2,
      numMessages: 1,
      participants: ['p:0', 'p:7'],
    });
    await ctx.db.insert('messages', {
      worldId,
      conversationId: 'c:2',
      messageUuid: 'message-1',
      author: 'p:0',
      text: 'Hello Ava',
    });
    await ctx.db.insert('participatedTogether', {
      worldId,
      conversationId: 'c:2',
      player1: 'p:0',
      player2: 'p:7',
      ended: 2,
    });
    await ctx.db.insert('federationPeers', {
      townId: 'town:foreign',
      townName: 'Foreign',
      publicKey: 'public',
      fingerprint: 'foreign',
      deploymentInstanceId: 'foreign-old',
      deploymentEpoch: 2,
      endpoint: 'https://foreign.example/federation/v1',
      credentialId: 'old',
      credentialEncrypted: 'secret-credential',
      trustState: 'TRUSTED',
      inboundVisitsAllowed: true,
      outboundVisitsAllowed: true,
      pairedAt: 1,
    });
    return { worldId, agentGlobalId, memoryId };
  });
  return { t, ...ids };
}
async function rewrite(
  bundle: BackupBundle,
  section: string,
  change: (row: Record<string, any>) => void,
) {
  const updated = structuredClone(bundle);
  delete updated.signature;
  const row = decodeRow(updated.sections[section][0]);
  change(row);
  updated.sections[section][0] = encodeRow(row);
  updated.manifest.sections[section] = {
    digest: await digest(updated.sections[section]),
    count: updated.sections[section].length,
    bytes: new TextEncoder().encode(JSON.stringify(updated.sections[section])).length,
  };
  return updated;
}

async function residentRestoreArgs(t: Awaited<ReturnType<typeof town>>['t'], bundle: BackupBundle, targetWorldId: Id<'worlds'>) {
  const args = { adminToken, bundle, mode: 'restore' as const, sourceStopped: true, targetWorldId };
  const preflight = await t.action(action('federation/backup:preflight'), args);
  return { ...args, residentRestore: { expectedTargetDigest: preflight.residentRestorePlan!.targetDigest,
    confirmOverwrite: true, operator: 'Home administrator', reason: 'Restore the resident archive' } };
}

test('original Home resident restore retains identity and fixed Chat ownership without changing main or other residents', async () => {
  const { t, worldId, agentGlobalId, memoryId } = await town();
  await t.run(async ctx => {
    const world = (await ctx.db.get(worldId))!;
    await ctx.db.patch(worldId, { players: [...world.players, { id: 'p:2', lastInput: 1, position: { x: 2, y: 2 }, facing: { dx: 1, dy: 0 }, speed: 0 }],
      agents: [...world.agents, { id: 'a:3', playerId: 'p:2', inProgressOperation: { name: 'agentDoSomething', operationId: 'other-operation', started: 1 } }], nextId: 4 });
    await ctx.db.insert('memories', { worldId, playerId: 'p:2', description: 'Other resident private memory', importance: 3, lastAccess: 1, data: { type: 'reflection', relatedMemoryIds: [] } });
    const reflection = await ctx.db.query('memories').withIndex('resident', q => q.eq('worldId', worldId).eq('playerId', 'p:0'))
      .filter(q => q.eq(q.field('data.type'), 'reflection')).first();
    await ctx.db.insert('memories', { worldId, playerId: 'p:0', agentGlobalId, description: 'My relationship', importance: 8, lastAccess: 1,
      data: { type: 'relationship', agentGlobalId: 'town:foreign/agent:ava', evidenceMemoryIds: [reflection!._id, memoryId] } });
  });
  const bundle = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  expect(bundle.sections.memories.map(decodeRow).some((m: Record<string, any>) => m.playerId === 'p:2')).toBe(false);
  await t.run(async ctx => {
    await ctx.db.patch(memoryId, { description: 'Accidentally damaged memory' });
    const settings = (await ctx.db.query('modelSettings').unique())!;
    const binding = (await ctx.db.query('residentModelBindings').unique())!;
    const main = await ctx.db.insert('chatProfiles', { name: 'New main', provider: 'custom', url: 'https://new-main.example', model: 'new-main', stopWords: [], createdAt: 2 });
    await ctx.db.patch(settings._id, { mainChatProfileId: main });
    await ctx.db.patch(binding._id, { chatProfileId: main });
    const world = (await ctx.db.get(worldId))!;
    await ctx.db.patch(worldId, { agents: world.agents.map(a => a.id === 'a:1' ? { ...a, inProgressOperation: { name: 'agentDoSomething', operationId: 'old-local-operation', started: 1 } } : a) });
    await ctx.db.insert('memories', { worldId, playerId: 'p:0', agentGlobalId, description: 'Newer memory preserved', importance: 8, lastAccess: 2, data: { type: 'reflection', relatedMemoryIds: [] } });
  });
  const before = await t.query(async ctx => ({ local: await ctx.db.query('federationIdentity').unique(), settings: await ctx.db.query('modelSettings').unique(),
    other: await ctx.db.query('memories').withIndex('resident', q => q.eq('worldId', worldId).eq('playerId', 'p:2')).collect(), world: await ctx.db.get(worldId) }));
  const args = await residentRestoreArgs(t, bundle, worldId);
  const result = await t.action(action('federation/backup:importBackup'), args);
  const after = await t.query(async ctx => ({ local: await ctx.db.query('federationIdentity').unique(), settings: await ctx.db.query('modelSettings').unique(),
    binding: await ctx.db.query('residentModelBindings').unique(), memories: await ctx.db.query('memories').collect(), profiles: await ctx.db.query('chatProfiles').collect(),
    world: await ctx.db.get(worldId), audit: await ctx.db.query('backupImports').unique(), runtime: await ctx.db.query('federationAgentRuntimes').unique() }));
  expect(after.local).toEqual(before.local);
  expect(after.settings).toEqual(before.settings);
  expect(after.binding).toMatchObject({ worldId, playerId: 'p:0', agentGlobalId, chatProfileId: decodeRow(bundle.sections.chatProfiles[0])._id });
  expect(after.profiles.find(p => p._id === after.binding!.chatProfileId)?.model).toBe('chat-original');
  expect(after.memories.filter(m => m.playerId === 'p:2')).toEqual(before.other);
  expect(after.memories.find(m => m._id === memoryId)?.description).toBe('I met Ava abroad.');
  expect(after.memories.some(m => m.description === 'Newer memory preserved')).toBe(true);
  const relationship = after.memories.find(m => m.description === 'My relationship')!;
  const reflection = after.memories.find(m => m.description === 'Ava is a friend.')!;
  expect(relationship.data).toMatchObject({ evidenceMemoryIds: [reflection._id, memoryId] });
  expect(after.world!.agents.find(a => a.id === 'a:3')).toEqual(before.world!.agents.find(a => a.id === 'a:3'));
  expect(after.world!.agents.find(a => a.id === 'a:1')?.inProgressOperation).toBeUndefined();
  expect(after.runtime).toMatchObject({ agentGlobalId, state: 'HOME_ACTIVE', agentAuthorityEpoch: 4 });
  expect(after.audit!.runtimeSnapshot.scope).toBe('resident');
  expect(after.audit!.runtimeSnapshot.targetSnapshot.memories.some((m: any) => m.description === 'Accidentally damaged memory')).toBe(true);
  expect(after.audit!.manifest.residentRestore.operator).toBe('Home administrator');
  expect(result.worldIds).toEqual([worldId]);
});

test('original Home resident restore repairs deleted local data without importing runtime or replacing a changed shared profile', async () => {
  const { t, worldId, agentGlobalId } = await town();
  const bundle = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  await t.run(async ctx => {
    const world = (await ctx.db.get(worldId))!;
    await ctx.db.patch(worldId, { agents: [], players: [] });
    for (const name of ['memories', 'residentModelBindings', 'federationAgentRuntimes', 'playerDescriptions', 'agentDescriptions'] as const)
      for (const row of await ctx.db.query(name).collect()) await ctx.db.delete(row._id);
    const profile = (await ctx.db.query('chatProfiles').unique())!;
    await ctx.db.patch(profile._id, { model: 'Changed model used by main' });
  });
  const args = await residentRestoreArgs(t, bundle, worldId);
  await t.action(action('federation/backup:importBackup'), args);
  const after = await t.query(async ctx => ({ world: await ctx.db.get(worldId), binding: await ctx.db.query('residentModelBindings').unique(),
    runtimes: await ctx.db.query('federationAgentRuntimes').collect(), memories: await ctx.db.query('memories').collect(), profiles: await ctx.db.query('chatProfiles').collect(), settings: await ctx.db.query('modelSettings').unique() }));
  expect(after.world!.agents).toEqual([{ id: 'a:1', playerId: 'p:0' }]);
  expect(after.world!.players[0].id).toBe('p:0');
  expect(after.binding!.agentGlobalId).toBe(agentGlobalId);
  expect(after.runtimes).toEqual([]);
  expect(after.profiles.find(p => p._id === after.binding!.chatProfileId)?.model).toBe('chat-original');
  expect(after.profiles.find(p => p._id === after.settings!.mainChatProfileId)?.model).toBe('Changed model used by main');
  const reflection = after.memories.find(m => m.data.type === 'reflection')!;
  expect(reflection.data).toEqual({ type: 'reflection', relatedMemoryIds: [after.memories.find(m => m.data.type === 'travel')!._id] });
});

test('resident restore rejects unsigned archives, foreign ownership, missing references and active source travel before writes', async () => {
  const { t, worldId } = await town();
  const original = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  const base = { adminToken, mode: 'restore' as const, targetWorldId: worldId, sourceStopped: true };
  await expect(t.action(action('federation/backup:preflight'), { ...base, bundle: { ...original, signature: undefined } })).rejects.toThrow('RESIDENT_RESTORE_SIGNED_BACKUP_REQUIRED');
  const key = (await t.query(ctx => ctx.db.query('federationIdentity').unique()))!.privateKeyEncrypted;
  for (const [section, change, error] of [
    ['memories', (row: any) => { row.playerId = 'p:2'; }, 'RESIDENT_BACKUP_MEMORY_OWNER_MISMATCH'],
    ['memories', (row: any) => { row.data = { type: 'reflection', relatedMemoryIds: ['missing-memory'] }; }, 'RESIDENT_BACKUP_REFERENCE_MISSING'],
    ['federationAgentRuntimes', (row: any) => { row.visitId = 'old-visit'; row.state = 'TRAVELING'; }, 'RECONCILE_SOURCE_RESIDENT_TRAVEL_FIRST'],
  ] as const) {
    const bundle = await rewrite(original, section, change);
    bundle.signature = await sign(bundle.manifest, key);
    await expect(t.action(action('federation/backup:preflight'), { ...base, bundle })).rejects.toThrow(error);
  }
  expect(await t.query(ctx => ctx.db.query('backupImports').collect())).toEqual([]);
});

test('resident restore requires confirmation, detects changed target and rolls back all writes after a late scheduler failure', async () => {
  const { t, worldId, memoryId } = await town();
  const bundle = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  const args = await residentRestoreArgs(t, bundle, worldId);
  await expect(t.action(action('federation/backup:importBackup'), { ...args, residentRestore: undefined })).rejects.toThrow('RESIDENT_RESTORE_CONFIRMATION_REQUIRED');
  await t.run(ctx => ctx.db.patch(memoryId, { description: 'Changed after preflight' }));
  await expect(t.action(action('federation/backup:importBackup'), args)).rejects.toThrow('RESIDENT_RESTORE_TARGET_CHANGED');
  const currentArgs = await residentRestoreArgs(t, bundle, worldId);
  const read = async () => t.query(async ctx => ({ world: await ctx.db.get(worldId), local: await ctx.db.query('federationIdentity').unique(),
    binding: await ctx.db.query('residentModelBindings').collect(), memories: await ctx.db.query('memories').collect(), vectors: await ctx.db.query('modelMemoryVectors').collect(),
    descriptions: await ctx.db.query('agentDescriptions').collect(), runtime: await ctx.db.query('federationAgentRuntimes').collect(), audits: await ctx.db.query('backupImports').collect() }));
  const before = await read();
  await expect(t.run(async ctx => {
    ctx.scheduler.runAfter = async () => { throw new Error('RESIDENT_RESTORE_INJECTED_SCHEDULER_FAILURE'); };
    return applyBackupData(ctx, currentArgs);
  })).rejects.toThrow('RESIDENT_RESTORE_INJECTED_SCHEDULER_FAILURE');
  expect(await read()).toEqual(before);
});

test('full-town export is signed, versioned, binary-safe and excludes private keys and peer credentials', async () => {
  const { t } = await town();
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  expect(bundle.manifest).toMatchObject({
    version: 1,
    schemaVersion: 1,
    scope: 'town',
    sourceTownId: 'town:original',
  });
  expect(bundle.signature).toBeTruthy();
  expect(JSON.stringify(bundle)).not.toMatch(
    /privateKeyEncrypted|credentialEncrypted|secret-credential/,
  );
  await expect(validateBundle(bundle)).resolves.toEqual(bundle);
  const bad = structuredClone(bundle);
  bad.sections.messages = [];
  await expect(validateBundle(bad)).rejects.toThrow('BACKUP_CHECKSUM_MISMATCH');
});

test('restoring a nonzero source input cursor preserves its audit snapshot and executes the new queue input zero', async () => {
  const { t } = await town();
  await t.run(async ctx => {
    const engine = (await ctx.db.query('engines').unique())!;
    await ctx.db.patch(engine._id, { processedInputNumber: 37 });
    await ctx.db.insert('inputs', { engineId: engine._id, number: 37, name: 'join', args: {}, received: 1, returnValue: { kind: 'ok', value: 'source-only-input' } });
  });
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  expect(decodeRow(bundle.sections.engines[0]).processedInputNumber).toBe(37);
  await t.action(action('federation/backup:importBackup'), { adminToken, bundle, mode: 'restore', sourceStopped: true });
  const { engine, worldId, inputId } = await t.run(async ctx => {
    const engine = (await ctx.db.query('engines').unique())!;
    const status = (await ctx.db.query('worldStatus').unique())!;
    const audit = (await ctx.db.query('backupImports').unique())!;
    expect(engine.processedInputNumber).toBeUndefined();
    expect(await ctx.db.query('inputs').collect()).toEqual([]);
    expect(decodeRow(audit.runtimeSnapshot.inputs[0]).number).toBe(37);
    await ctx.db.patch(engine._id, { running: true });
    const inputId = await engineInsertInput(ctx, engine._id, 'join', { name: 'First restored human', character: 'f1', description: 'First input after restore', tokenIdentifier: 'restored-human' });
    return { engine, worldId: status.worldId, inputId };
  });
  const loaded = await t.run(ctx => Game.load(ctx.db, worldId, engine.generationNumber));
  const game = new Game(loaded.engine, worldId, loaded.gameState);
  // Keep periodic model jobs out of this deterministic queue/commit regression.
  jest.spyOn(game, 'tick').mockImplementation(() => {});
  await game.runStep({ runQuery: (ref: any, args: any) => t.query(ref, args), runMutation: (ref: any, args: any) => t.mutation(ref, args) } as ActionCtx, Date.now());
  await t.run(async ctx => {
    const input = (await ctx.db.get(inputId))!;
    expect(input.number).toBe(0);
    expect(input.returnValue?.kind).toBe('ok');
    expect((await ctx.db.get(engine._id))!.processedInputNumber).toBe(0);
    expect((await ctx.db.get(worldId))!.players.some(p => p.human === 'restored-human')).toBe(true);
  });
});

test('atomic recovery cannot overwrite an unresolved identity quarantine', async () => {
  const { t } = await town();
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  await t.run(async ctx => {
    const local = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(local._id, { mode: 'QUARANTINED', quarantinePreviousMode: local.mode });
  });
  const before = await t.query(async ctx => ({
    identity: await ctx.db.query('federationIdentity').unique(),
    memories: await ctx.db.query('memories').collect(),
  }));
  await expect(t.action(action('federation/backup:importBackup'), {
    adminToken, bundle, mode: 'restore', sourceStopped: true,
  })).rejects.toThrow('TOWN_CLONE_CONFLICT');
  expect(await t.query(async ctx => ({
    identity: await ctx.db.query('federationIdentity').unique(),
    memories: await ctx.db.query('memories').collect(),
  }))).toEqual(before);
});

test('atomic restore keeps autonomous authorization and audit while marking the interrupted decision stale', async () => {
  const { t, worldId, agentGlobalId } = await town();
  await t.run(async ctx => {
    const policyId = await ctx.db.insert('autonomousTravelPolicies', {
      worldId, agentGlobalId, playerId: 'p:0', enabled: true, allowedPeerTownIds: ['town:friend'],
      decisionIntervalMs: 60000, dailyRequestLimit: 2, revision: 7, nextDecisionAt: 1,
      operator: 'admin', reason: 'Visit this friend', updatedAt: 1,
    });
    for (const state of ['RUNNING', 'STAY'])
      await ctx.db.insert('autonomousTravelDecisions', {
        policyId, policyRevision: 7, worldId, agentGlobalId, playerId: 'p:0', agentId: 'a:1',
        operationId: `operation-${state}`, state, createdAt: 1, deadline: 2,
        ...(state === 'STAY' ? { completedAt: 2, reason: 'Stay home' } : {}),
      });
  });
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  const beforeApply = Date.now();
  await t.action(action('federation/backup:importBackup'), { adminToken, bundle, mode: 'restore', sourceStopped: true });
  const result = await t.query(async ctx => ({
    policy: await ctx.db.query('autonomousTravelPolicies').unique(),
    decisions: await ctx.db.query('autonomousTravelDecisions').collect(),
    binding: await ctx.db.query('residentModelBindings').unique(),
  }));
  expect(result.policy!.nextDecisionAt).toBeGreaterThanOrEqual(beforeApply + 60000);
  expect(result.policy).toMatchObject({ revision: 7, enabled: true, allowedPeerTownIds: ['town:friend'], agentGlobalId, worldId: result.binding!.worldId });
  expect(result.decisions.every(d => d.policyId === result.policy!._id && d.worldId === result.binding!.worldId)).toBe(true);
  expect(result.decisions.find(d => d.operationId === 'operation-RUNNING')).toMatchObject({ state: 'STALE', error: 'BACKUP_RESTORE_INTERRUPTED_DECISION' });
  expect(result.decisions.find(d => d.operationId === 'operation-STAY')).toMatchObject({ state: 'STAY', completedAt: 2, reason: 'Stay home' });
});

test('restore atomically remaps core data while preserving identities, profiles, maps, conversations and reflection pointers', async () => {
  const { t, agentGlobalId, worldId } = await town();
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  const before = await t.query((ctx) => ctx.db.query('federationIdentity').unique());
  await t.run(ctx => ctx.db.patch(before!._id, { resourceLimits: DEFAULT_RESOURCE_LIMITS }));
  const result = await t.action(action('federation/backup:importBackup'), {
    adminToken,
    bundle,
    mode: 'restore',
    sourceStopped: true,
  });
  const snapshot = await t.query(async (ctx) => ({
    identity: await ctx.db.query('federationIdentity').unique(),
    worlds: await ctx.db.query('worlds').collect(),
    maps: await ctx.db.query('maps').collect(),
    memories: await ctx.db.query('memories').collect(),
    bindings: await ctx.db.query('residentModelBindings').collect(),
    profiles: await ctx.db.query('chatProfiles').collect(),
    vectors: await ctx.db.query('modelMemoryVectors').collect(),
    peers: await ctx.db.query('federationPeers').collect(),
    messages: await ctx.db.query('messages').collect(),
    settings: await ctx.db.query('modelSettings').unique(),
    embeddingSpaces: await ctx.db.query('embeddingSpaces').collect(),
    embeddingProfiles: await ctx.db.query('embeddingProfiles').collect(),
  }));
  expect(snapshot.identity?.townId).toBe(before?.townId);
  expect(snapshot.identity?.resourceLimits).toEqual(before?.resourceLimits);
  expect(snapshot.identity?.publicKey).toBe(before?.publicKey);
  expect(snapshot.identity?.deploymentInstanceId).not.toBe(before?.deploymentInstanceId);
  expect(snapshot.identity?.deploymentEpoch).toBe(5);
  expect(snapshot.identity?.enabled).toBe(false);
  expect(snapshot.worlds).toHaveLength(1);
  expect(snapshot.worlds[0]._id).not.toBe(worldId);
  expect(snapshot.maps[0].worldId).toBe(result.mapping[worldId]);
  expect(snapshot.bindings[0].agentGlobalId).toBe(agentGlobalId);
  expect(snapshot.profiles[0].model).toBe('chat-original');
  expect(snapshot.bindings[0].chatProfileId).toBe(snapshot.settings?.mainChatProfileId);
  expect(snapshot.memories).toHaveLength(2);
  expect(snapshot.memories.every((m) => m.agentGlobalId === agentGlobalId)).toBe(true);
  const reflection = snapshot.memories.find((m) => m.data.type === 'reflection');
  expect(reflection?.data).toMatchObject({
    relatedMemoryIds: [snapshot.memories.find((m) => m.data.type === 'travel')?._id],
  });
  expect(snapshot.vectors).toHaveLength(0);
  expect(snapshot.messages[0].text).toBe('Hello Ava');
  expect(snapshot.peers[0]).toMatchObject({
    trustState: 'UNTRUSTED',
    credentialEncrypted: '',
    inboundVisitsAllowed: false,
    outboundVisitsAllowed: false,
  });
  const active = snapshot.embeddingSpaces.find(
    (s) => s._id === snapshot.settings?.activeEmbeddingSpaceId,
  );
  expect(snapshot.embeddingProfiles.find((p) => p._id === active?.profileId)?.model).toBe(
    'embed-original',
  );
});

test('preflight rejects corrupt structure and foreign restore; failed import leaves the original town intact', async () => {
  const { t, worldId } = await town();
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  const broken = await rewrite(bundle, 'maps', (row) => {
    row.width = 'invalid';
  });
  await expect(
    t.action(action('federation/backup:preflight'), {
      adminToken,
      bundle: broken,
      mode: 'restore',
      sourceStopped: true,
    }),
  ).rejects.toThrow('BACKUP_SCHEMA_MISMATCH');
  await expect(
    t.action(action('federation/backup:importBackup'), {
      adminToken,
      bundle: broken,
      mode: 'restore',
      sourceStopped: true,
    }),
  ).rejects.toThrow('BACKUP_SCHEMA_MISMATCH');
  expect(await t.query((ctx) => ctx.db.get(worldId))).toBeTruthy();
  expect(await t.query((ctx) => ctx.db.query('memories').collect())).toHaveLength(2);
  const foreign = await rewrite(bundle, 'federationIdentity', (row) => {
    row.publicKey = 'different';
  });
  await expect(
    t.action(action('federation/backup:preflight'), {
      adminToken,
      bundle: foreign,
      mode: 'restore',
      sourceStopped: true,
    }),
  ).rejects.toThrow('RESTORE_IDENTITY_PROOF_REQUIRED');
  await expect(
    t.action(action('federation/backup:preflight'), { adminToken, bundle, mode: 'migrate' }),
  ).rejects.toThrow('MIGRATION_SOURCE_STOP_REQUIRED');
});

test('clone has fresh town/key/global ownership and merge allocates local IDs without importing old authorizations', async () => {
  const source = await town();
  const bundle = await source.t.action(action('federation/backup:exportTown'), { adminToken });
  const clone = convexTest(schema, modules);
  await clone.action(action('federation/backup:importBackup'), {
    adminToken,
    bundle,
    mode: 'clone',
    targetEndpoint: 'https://clone.example',
  });
  const copied = await clone.query(async (ctx) => ({
    identity: await ctx.db.query('federationIdentity').unique(),
    bindings: await ctx.db.query('residentModelBindings').collect(),
    memories: await ctx.db.query('memories').collect(),
    ledger: await ctx.db.query('visitLedger').collect(),
  }));
  expect(copied.identity?.townId).not.toBe('town:original');
  expect(copied.identity?.publicKey).not.toBe(
    decodeRow(bundle.sections.federationIdentity[0]).publicKey,
  );
  expect(copied.identity?.endpoint).toBe('https://clone.example/federation/v1');
  expect(copied.bindings[0].agentGlobalId?.startsWith(copied.identity!.townId + '/')).toBe(true);
  expect(copied.ledger).toHaveLength(0);
  expect(copied.memories[0].data).toMatchObject({
    participants: [{ agentGlobalId: 'town:foreign/agent:ava' }],
  });
  const destination = await town();
  const prior = await destination.t.query((ctx) => ctx.db.query('federationIdentity').unique());
  const priorEngine = await destination.t.run(async ctx => {
    const engine = (await ctx.db.query('engines').unique())!;
    await ctx.db.patch(engine._id, { processedInputNumber: 21 });
    return (await ctx.db.get(engine._id))!;
  });
  await destination.t.action(action('federation/backup:importBackup'), {
    adminToken,
    bundle,
    mode: 'merge',
    targetWorldId: destination.worldId,
  });
  const merged = await destination.t.query(async (ctx) => ({
    identity: await ctx.db.query('federationIdentity').unique(),
    world: await ctx.db.get(destination.worldId),
    bindings: await ctx.db.query('residentModelBindings').collect(),
    memories: await ctx.db.query('memories').collect(),
    engines: await ctx.db.query('engines').collect(),
  }));
  expect(merged.identity).toEqual(prior);
  expect(merged.engines).toEqual([priorEngine]);
  expect(merged.world?.players).toHaveLength(2);
  expect(merged.world?.agents).toHaveLength(2);
  expect(new Set(merged.world?.players.map((p) => p.id)).size).toBe(2);
  expect(new Set(merged.bindings.map((b) => b.agentGlobalId)).size).toBe(2);
  expect(merged.memories).toHaveLength(4);
});

test('a late scheduler failure rolls back identity rotation, deletion, and every imported document', async () => {
  const { t, worldId } = await town();
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  const before = await t.query(async (ctx) => ({
    identity: await ctx.db.query('federationIdentity').unique(),
    world: await ctx.db.get(worldId),
    memories: await ctx.db.query('memories').collect(),
    settings: await ctx.db.query('modelSettings').collect(),
  }));
  await expect(
    t.run((ctx) =>
      applyBackupData(
        {
          ...ctx,
          scheduler: {
            ...ctx.scheduler,
            runAfter: () => {
              throw new Error('INJECTED_SCHEDULER_FAILURE');
            },
          },
        },
        { adminToken, bundle, mode: 'restore', sourceStopped: true },
      ),
    ),
  ).rejects.toThrow('INJECTED_SCHEDULER_FAILURE');
  const after = await t.query(async (ctx) => ({
    identity: await ctx.db.query('federationIdentity').unique(),
    world: await ctx.db.get(worldId),
    memories: await ctx.db.query('memories').collect(),
    settings: await ctx.db.query('modelSettings').collect(),
  }));
  expect(after).toEqual(before);
  expect(await t.query((ctx) => ctx.db.query('backupImports').collect())).toHaveLength(0);
});

test('restored travelers wait for old lease proposals plus source-stop margin, then resume original identities atomically', async () => {
  const { t, worldId, agentGlobalId } = await town();
  const stoppedAt = Date.now();
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  const snapshot = structuredClone(bundle) as BackupBundle;
  delete snapshot.signature;
  const world = decodeRow(snapshot.sections.worlds[0]);
  const player = world.players[0];
  world.players = [];
  world.agents[0].travelVisitId = 'visit-restored';
  world.agents[0].suspendedPlayer = player;
  snapshot.sections.worlds[0] = encodeRow(world);
  const runtime = decodeRow(snapshot.sections.federationAgentRuntimes[0]);
  runtime.visitId = 'visit-restored';
  runtime.state = 'TRAVELING';
  snapshot.sections.federationAgentRuntimes[0] = encodeRow(runtime);
  snapshot.sections.visitLedger = [
    encodeRow({
      _id: 'old-ledger',
      visitId: 'visit-restored',
      agentGlobalId,
      homeTownId: 'town:original',
      hostTownId: 'town:foreign',
      homeDeploymentEpoch: 4,
      hostDeploymentEpoch: 2,
      agentAuthorityEpoch: 3,
      visitLeaseVersion: 1,
      leaseExpiry: stoppedAt - 10000,
      state: 'ACTIVE',
      role: 'home',
      worldId,
      homePlayerId: 'p:0',
      profile: {},
      createdAt: 1,
      updatedAt: 1,
    }),
  ];
  const pendingLease = stoppedAt + 400000;
  snapshot.sections.federationOutbox = [
    encodeRow({
      _id: 'old-lease-proposal',
      messageId: 'old-proposal',
      toTownId: 'town:foreign',
      envelope: { visitId: 'visit-restored', payload: { leaseExpiry: pendingLease } },
      attempts: 1,
      nextRetryAt: stoppedAt,
    }),
  ];
  snapshot.sections.inputs = [
    encodeRow({
      _id: 'old-input',
      engineId: decodeRow(snapshot.sections.engines[0])._id,
      number: 0,
      name: 'federationAction',
      args: { visitId: 'visit-restored', action: { type: 'say', text: 'Do not replay this.' } },
      received: stoppedAt,
    }),
  ];
  snapshot.sections.federationDecisionJobs = [
    encodeRow({
      _id: 'old-thinking',
      visitId: 'visit-restored',
      eventId: 'old-event',
      observation: {},
      state: 'RUNNING',
      createdAt: stoppedAt,
      deadline: stoppedAt + 10000,
    }),
  ];
  snapshot.sections.federationTurns = [
    encodeRow({
      _id: 'old-turn',
      visitId: 'visit-restored',
      eventId: 'old-event',
      turnId: 'old-turn-id',
      worldId,
      playerId: 'p:0',
      deadline: stoppedAt + 10000,
      state: 'PENDING',
    }),
  ];
  snapshot.sections.federationPendingActions = [
    encodeRow({
      _id: 'old-action',
      visitId: 'visit-restored',
      actionId: 'old-action-id',
      turnId: 'old-turn-id',
      basedOnEventId: 'old-event',
      agentAuthorityEpoch: 3,
      visitLeaseVersion: 1,
      action: { type: 'say', text: 'Do not replay this.' },
      inputId: 'old-input',
      state: 'PENDING',
      createdAt: stoppedAt,
    }),
  ];
  for (const [name, values] of Object.entries(snapshot.sections))
    snapshot.manifest.sections[name] = {
      digest: await digest(values),
      count: values.length,
      bytes: new TextEncoder().encode(JSON.stringify(values)).length,
    };
  const result = await t.action(action('federation/backup:importBackup'), {
    adminToken,
    bundle: snapshot,
    mode: 'restore',
    sourceStopped: true,
  });
  const pending = await t.query(
    makeFunctionReference<'query'>('federation/backup:restoredResidents'),
    { adminToken },
  );
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
    agentGlobalId,
    safeAfter: pendingLease + 60000,
    canResume: false,
    reason: 'OLD_HOST_LEASE_STILL_VALID',
  });
  const reconcile = makeFunctionReference<'mutation'>(
    'federation/backup:reconcileRestoredResident',
  );
  await expect(
    t.mutation(reconcile, { adminToken, agentGlobalId, sourceStopped: false }),
  ).rejects.toThrow('RESTORE_SOURCE_STOP_REQUIRED');
  jest.setSystemTime(pendingLease + 59999);
  await expect(
    t.mutation(reconcile, { adminToken, agentGlobalId, sourceStopped: true }),
  ).rejects.toThrow('OLD_HOST_LEASE_STILL_VALID');
  expect(
    (await t.query((ctx) => ctx.db.get(result.mapping[worldId] as Id<'worlds'>)))?.players,
  ).toHaveLength(0);
  jest.setSystemTime(pendingLease + 60000);
  const restoredEngineId = await t.run(async (ctx) => {
    const status = await ctx.db.query('worldStatus').unique();
    await ctx.db.patch(status!.engineId, { running: true });
    return status!.engineId;
  });
  await expect(
    t.mutation(reconcile, { adminToken, agentGlobalId, sourceStopped: true }),
  ).rejects.toThrow('STOP_TARGET_ENGINE_FIRST');
  expect(
    (await t.query((ctx) => ctx.db.get(result.mapping[worldId] as Id<'worlds'>)))?.players,
  ).toHaveLength(0);
  await t.run((ctx) => ctx.db.patch(restoredEngineId, { running: false }));
  const resumed = await t.mutation(reconcile, { adminToken, agentGlobalId, sourceStopped: true });
  expect(resumed).toMatchObject({ state: 'HOME_ACTIVE', agentGlobalId, playerId: 'p:0' });
  const state = await t.query(async (ctx) => ({
    world: await ctx.db.get(result.mapping[worldId] as Id<'worlds'>),
    runtime: await ctx.db.query('federationAgentRuntimes').unique(),
    bindings: await ctx.db.query('residentModelBindings').collect(),
    imports: await ctx.db.query('backupImports').collect(),
    ledger: await ctx.db.query('visitLedger').collect(),
    inputs: await ctx.db.query('inputs').collect(),
    thinking: await ctx.db.query('federationDecisionJobs').collect(),
    turns: await ctx.db.query('federationTurns').collect(),
    actions: await ctx.db.query('federationPendingActions').collect(),
    audits: await ctx.db.query('backupReconciliations').collect(),
  }));
  expect(state.world!.players).toHaveLength(1);
  expect(state.world!.players[0].id).toBe('p:0');
  expect(state.world!.agents[0]).toMatchObject({ id: 'a:1', playerId: 'p:0' });
  expect(state.world!.agents[0].travelVisitId).toBeUndefined();
  expect(state.runtime?.state).toBe('HOME_ACTIVE');
  expect(state.runtime?.agentGlobalId).toBe(agentGlobalId);
  expect(state.bindings[0].agentGlobalId).toBe(agentGlobalId);
  for (const name of ['ledger', 'inputs', 'thinking', 'turns', 'actions'] as const)
    expect(state[name]).toHaveLength(0);
  expect(state.imports[0].runtimeSnapshot).toMatchObject({
    inputs: expect.any(Array),
    federationDecisionJobs: expect.any(Array),
    federationTurns: expect.any(Array),
    federationPendingActions: expect.any(Array),
    engines: expect.any(Array),
  });
  expect(state.audits).toHaveLength(1);
  expect(await t.mutation(reconcile, { adminToken, agentGlobalId, sourceStopped: true })).toEqual(
    resumed,
  );
});

test('same-town restore requires explicit source stop confirmation before rotating the instance', async () => {
  const { t } = await town();
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  const before = await t.query((ctx) => ctx.db.query('federationIdentity').unique());
  await expect(
    t.action(action('federation/backup:preflight'), { adminToken, bundle, mode: 'restore' }),
  ).rejects.toThrow('RESTORE_SOURCE_STOP_REQUIRED');
  await expect(
    t.action(action('federation/backup:importBackup'), {
      adminToken,
      bundle,
      mode: 'restore',
      sourceStopped: false,
    }),
  ).rejects.toThrow('RESTORE_SOURCE_STOP_REQUIRED');
  expect(await t.query((ctx) => ctx.db.query('federationIdentity').unique())).toEqual(before);
});


test('small signed archives restore storage policy and durable committed federation evidence', async () => {
  const { t } = await town();
  await t.run(async ctx => {
    await ctx.db.insert('storagePolicies', { key: 'town', ...defaultStoragePolicy, historyBytes: 1234567, updatedAt: 1 });
    await ctx.db.insert('federationActionFacts', {
      actionId: 'action-durable', visitId: 'visit-past', turnId: 'turn-past', basedOnEventId: 'observation-past',
      agentAuthorityEpoch: 3, visitLeaseVersion: 2, action: { type: 'say', text: 'Committed statement' },
      result: { status: 'COMMITTED' }, occurredAt: 2,
    });
    await ctx.db.insert('federationEventFacts', { messageId: 'receipt-past', visitId: 'visit-past',
      fromTownId: 'town:foreign', type: 'ACTION_RESULT', payload: { status: 'COMMITTED' }, receivedAt: 2 });
  });
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  expect(bundle.sections.federationActionFacts).toHaveLength(1);
  expect(bundle.sections.federationEventFacts).toHaveLength(1);
  await t.action(action('federation/backup:importBackup'), { adminToken, bundle, mode: 'restore', sourceStopped: true });
  const restored = await t.run(async ctx => ({
    policy: await ctx.db.query('storagePolicies').unique(),
    action: await ctx.db.query('federationActionFacts').unique(),
    event: await ctx.db.query('federationEventFacts').unique(),
  }));
  expect(restored.policy?.historyBytes).toBe(1234567);
  expect(restored.action?.actionId).toBe('action-durable');
  expect(restored.event?.messageId).toBe('receipt-past');
});


test('resident export ignores more than 500 unrelated town memories without truncating its own canonical history', async () => {
  const { t, worldId, agentGlobalId } = await town();
  await t.run(async ctx => {
    for (let i = 0; i < 505; i++) await ctx.db.insert('memories', {
      worldId, playerId: 'p:99', agentGlobalId: 'town:original/agent:other',
      description: `Unrelated memory ${i}`, importance: 1, lastAccess: 1,
      data: { type: 'travel', eventId: `unrelated-${i}`, visitId: 'other-visit', hostTownId: 'town:foreign', participants: [], occurredAt: 1 },
    });
    await ctx.db.insert('memories', { worldId, playerId: 'p:0', agentGlobalId,
      description: 'My new memory beyond the unrelated town history', importance: 2, lastAccess: 2,
      data: { type: 'travel', eventId: 'resident-tail', visitId: 'old-visit', hostTownId: 'town:foreign', participants: [], occurredAt: 2 },
    });
  });
  const bundle = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  const memories: Record<string, any>[] = bundle.sections.memories.map(decodeRow);
  expect(memories).toHaveLength(3);
  expect(memories.every(m => m.agentGlobalId === agentGlobalId)).toBe(true);
  expect(memories.some(m => m.description === 'My new memory beyond the unrelated town history')).toBe(true);
  expect(bundle.sections.messages.map(decodeRow)[0].text).toBe('Hello Ava');
});


test('canonical completed travel transcripts and relationship evidence survive signed restore and resident merge', async () => {
  const { t, worldId, agentGlobalId } = await town();
  await t.run(async ctx => {
    const ledgerId = await ctx.db.insert('visitLedger', { visitId: 'visit-transcript', agentGlobalId, homeTownId: 'town:original', hostTownId: 'town:foreign',
      homeDeploymentEpoch: 4, hostDeploymentEpoch: 2, agentAuthorityEpoch: 2, visitLeaseVersion: 1, leaseExpiry: 1, fencingToken: 'fence',
      role: 'home', state: 'COMPLETED', worldId, homePlayerId: 'p:0', profile: {}, createdAt: 1, updatedAt: 1 });
    await receiveConversationEnded(ctx, (await ctx.db.get(ledgerId))!, { eventId: 'transcript-page-0', transcriptId: 'foreign-conversation',
      federationConversationId: 'town:foreign/world/c:1', endedAt: 3, pageNumber: 0, finalPage: true,
      participants: [{ playerId: 'p:9', agentGlobalId, name: 'Ada', homeTownId: 'town:original' },
        { playerId: 'p:0', agentGlobalId: 'town:foreign/ava', name: 'Ava', homeTownId: 'town:foreign' }],
      messages: [{ messageId: 'raw-self', text: 'p:0', author: 'p:9', occurredAt: 1 },
        { messageId: 'raw-other', text: 'I remember our visit.', author: 'p:0', occurredAt: 2 }] });
  });
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  await t.action(action('federation/backup:importBackup'), { adminToken, bundle, mode: 'restore', sourceStopped: true });
  const check = async () => t.run(async ctx => {
    const transcripts = await ctx.db.query('homeTravelTranscripts').collect(), pages = await ctx.db.query('homeTravelTranscriptPages').collect();
    const memories = await ctx.db.query('memories').collect();
    for (const transcript of transcripts) {
      expect(transcript.state).toBe('COMPLETE');
      expect(memories.some(m => m._id === transcript.endMemoryId)).toBe(true);
      const ownPages = pages.filter(p => p.agentGlobalId === transcript.agentGlobalId);
      expect(ownPages).toHaveLength(1);
      expect(ownPages[0].messages[0].text).toBe('p:0');
      expect(ownPages[0].memoryIds.every(id => memories.some(m => m._id === id))).toBe(true);
      const relation = memories.find(m => m.agentGlobalId === transcript.agentGlobalId && m.data.type === 'relationship');
      expect(relation?.data).toMatchObject({ agentGlobalId: 'town:foreign/ava', evidenceMemoryIds: [transcript.endMemoryId] });
      expect(memories.find(m => m._id === ownPages[0].memoryIds[0])?.data).toMatchObject({ messageText: 'p:0' });
    }
    return transcripts;
  });
  expect(await check()).toHaveLength(1);
  const restoredWorld = (await t.run(ctx => ctx.db.query('worlds').unique()))!;
  const resident = await t.action(action('federation/backup:exportResident'), { adminToken, worldId: restoredWorld._id, playerId: 'p:0' });
  await t.action(action('federation/backup:importBackup'), { adminToken, bundle: resident, mode: 'merge', targetWorldId: restoredWorld._id });
  const both = await check();
  expect(both).toHaveLength(2);
  expect(new Set(both.map(tr => tr.agentGlobalId)).size).toBe(2);
});

test('resident restore retains cyclic memory references through a whole-town ID remap and repeated restore', async () => {
  const { t, worldId, memoryId } = await town();
  await t.run(async ctx => {
    const reflection = (await ctx.db.query('memories').filter(q => q.eq(q.field('data.type'), 'reflection')).unique())!;
    await ctx.db.patch(memoryId, { data: { type: 'reflection', relatedMemoryIds: [reflection._id] } });
  });
  const resident = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  const full = await t.action(action('federation/backup:exportTown'), { adminToken });
  const restored = await t.action(action('federation/backup:importBackup'), { adminToken, bundle: full, mode: 'restore', sourceStopped: true });
  const targetWorldId = restored.worldIds[0] as Id<'worlds'>;
  const first = await t.action(action('federation/backup:importBackup'), await residentRestoreArgs(t, resident, targetWorldId));
  const second = await t.action(action('federation/backup:importBackup'), await residentRestoreArgs(t, resident, targetWorldId));
  expect(first.mapping[memoryId]).toBe(restored.mapping[memoryId]);
  expect(second.mapping[memoryId]).toBe(first.mapping[memoryId]);
  const memories = await t.query(ctx => ctx.db.query('memories').collect());
  expect(memories).toHaveLength(2);
  for (const memory of memories) {
    expect(memory.worldId).toBe(targetWorldId);
    expect(memory.data).toMatchObject({ type: 'reflection', relatedMemoryIds: [memories.find(m => m._id !== memory._id)!._id] });
  }
});

test('resident restore refuses pending input, live model permits and an active local operation before writing', async () => {
  const { t, worldId } = await town();
  const bundle = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  const args = { adminToken, bundle, mode: 'restore', targetWorldId: worldId, sourceStopped: true };
  const inputId = await t.run(async ctx => {
    const status = (await ctx.db.query('worldStatus').unique())!;
    return engineInsertInput(ctx, status.engineId, 'moveTo', { playerId: 'p:0', destination: { x: 1, y: 2 } });
  });
  await expect(t.action(action('federation/backup:preflight'), args)).rejects.toThrow('DRAIN_TARGET_WORK_BEFORE_RESIDENT_RESTORE');
  await t.run(ctx => ctx.db.delete(inputId));
  const permitId = await t.run(ctx => ctx.db.insert('federationLlmRequests', { state: 'RUNNING', createdAt: Date.now(), startedAt: Date.now(), deadline: Date.now() + 90000, queueDeadline: Date.now() + 30000, expiresAt: Date.now() + 95000 }));
  await expect(t.action(action('federation/backup:preflight'), args)).rejects.toThrow('DRAIN_TARGET_WORK_BEFORE_RESIDENT_RESTORE');
  await t.run(ctx => ctx.db.delete(permitId));
  await t.run(async ctx => {
    const world = (await ctx.db.get(worldId))!;
    await ctx.db.patch(worldId, { agents: world.agents.map(agent => ({ ...agent, inProgressOperation: { name: 'agentRememberConversation', operationId: 'active-operation', started: Date.now() } })) });
  });
  await expect(t.action(action('federation/backup:preflight'), args)).rejects.toThrow('DRAIN_TARGET_WORK_BEFORE_RESIDENT_RESTORE');
  expect(await t.query(ctx => ctx.db.query('backupImports').collect())).toEqual([]);
});

test('resident restore maps durable travel pages and their evidence without replaying a running source summary', async () => {
  const { t, worldId, agentGlobalId } = await town();
  await t.run(async ctx => {
    const ledgerId = await ctx.db.insert('visitLedger', { visitId: 'resident-transcript', agentGlobalId, homeTownId: 'town:original', hostTownId: 'town:foreign',
      homeDeploymentEpoch: 4, hostDeploymentEpoch: 2, agentAuthorityEpoch: 2, visitLeaseVersion: 1, leaseExpiry: 1, fencingToken: 'fence',
      role: 'home', state: 'COMPLETED', worldId, homePlayerId: 'p:0', profile: {}, createdAt: 1, updatedAt: 1 });
    await receiveConversationEnded(ctx, (await ctx.db.get(ledgerId))!, { eventId: 'resident-page', transcriptId: 'resident-conversation',
      federationConversationId: 'town:foreign/world/c:1', endedAt: 3, pageNumber: 0, finalPage: true,
      participants: [{ playerId: 'p:9', agentGlobalId, name: 'Ada', homeTownId: 'town:original' }, { playerId: 'p:0', agentGlobalId: 'town:foreign/ava', name: 'Ava', homeTownId: 'town:foreign' }],
      messages: [{ messageId: 'durable-message', text: 'p:0', author: 'p:9', occurredAt: 1 }] });
    const transcript = (await ctx.db.query('homeTravelTranscripts').unique())!;
    await ctx.db.patch(transcript._id, { summaryState: 'RUNNING', summaryStartedAt: 1 });
  });
  const bundle = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  await t.run(async ctx => {
    for (const name of ['memories', 'homeTravelTranscripts', 'homeTravelTranscriptPages'] as const)
      for (const row of await ctx.db.query(name).collect()) await ctx.db.delete(row._id);
  });
  const result = await t.action(action('federation/backup:importBackup'), await residentRestoreArgs(t, bundle, worldId));
  const after = await t.query(async ctx => ({ transcript: await ctx.db.query('homeTravelTranscripts').unique(), page: await ctx.db.query('homeTravelTranscriptPages').unique(), memories: await ctx.db.query('memories').collect() }));
  expect(after.transcript).toMatchObject({ agentGlobalId, worldId, playerId: 'p:0', state: 'COMPLETE', summaryState: 'FAILED', summaryError: 'BACKUP_RESTORE_INTERRUPTED_SUMMARY' });
  expect(after.transcript!.summaryStartedAt).toBeUndefined();
  expect(after.memories.some(memory => memory._id === after.transcript!.endMemoryId)).toBe(true);
  expect(after.page!.memoryIds).toEqual(decodeRow(bundle.sections.homeTravelTranscriptPages[0]).memoryIds.map((id: string) => result.mapping[id]));
  expect(after.page!.messages[0].text).toBe('p:0');
  expect(after.page!.memoryIds.every(id => after.memories.some(memory => memory._id === id))).toBe(true);
});

test('small town archives restore source quota and its audit, exclude rolling metrics and accept older packages without quota sections', async () => {
  const { t, worldId } = await town();
  await t.run(async ctx => {
    await ctx.db.insert('federationResourcePolicy', { maxVisitorsPerSourceTown: 3 });
    await ctx.db.insert('federationResourceAudit', { operation: 'SOURCE_QUOTA_CHANGED', previous: null, next: 3, createdAt: 1 });
    await ctx.db.insert('federationResourceMetrics', { kind: 'INBOUND_EVENT', bucketStart: Date.now(), count: 1, durationCount: 0, durationSumMs: 0, samples: [] });
  });
  const full = await t.action(action('federation/backup:exportTown'), { adminToken });
  expect(full.sections.federationResourcePolicy.map(decodeRow)).toMatchObject([{ maxVisitorsPerSourceTown: 3 }]);
  expect(full.sections.federationResourceAudit.map(decodeRow)).toMatchObject([{ operation: 'SOURCE_QUOTA_CHANGED' }]);
  expect(full.sections.federationResourceMetrics).toBeUndefined();
  const resident = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  expect(resident.sections.federationResourcePolicy).toEqual([]);
  expect(resident.sections.federationResourceAudit).toEqual([]);
  await t.action(action('federation/backup:importBackup'), { adminToken, bundle: full, mode: 'restore', sourceStopped: true });
  expect(await t.query(ctx => ctx.db.query('federationResourcePolicy').collect())).toMatchObject([{ maxVisitorsPerSourceTown: 3 }]);
  expect(await t.query(ctx => ctx.db.query('federationResourceAudit').collect())).toMatchObject([{ next: 3 }]);
  const legacy = structuredClone(full);
  delete legacy.signature;
  for (const name of ['federationResourcePolicy', 'federationResourceAudit']) {
    delete legacy.sections[name];
    delete legacy.manifest.sections[name];
  }
  const identity = (await t.query(ctx => ctx.db.query('federationIdentity').unique()))!;
  legacy.signature = await sign(legacy.manifest, identity.privateKeyEncrypted);
  await t.action(action('federation/backup:importBackup'), { adminToken, bundle: legacy, mode: 'restore', sourceStopped: true });
  expect(await t.query(ctx => ctx.db.query('federationResourcePolicy').collect())).toEqual([]);
});


test('resident restore confirmation binds the reviewed source archive as well as the target snapshot', async () => {
  const { t, worldId } = await town();
  const original = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  const args = await residentRestoreArgs(t, original, worldId);
  const different = await rewrite(original, 'agentDescriptions', row => { row.identity = 'A different archived persona'; });
  const local = (await t.query(ctx => ctx.db.query('federationIdentity').unique()))!;
  different.signature = await sign(different.manifest, local.privateKeyEncrypted);
  await expect(t.action(action('federation/backup:importBackup'), { ...args, bundle: different })).rejects.toThrow('RESIDENT_RESTORE_TARGET_CHANGED');
  expect(await t.query(ctx => ctx.db.query('backupImports').collect())).toEqual([]);
});


test('small archives cross Convex wire serialization without losing bytes or special numeric runtime data', async () => {
  const { t } = await town();
  await t.run(async ctx => {
    const status = (await ctx.db.query('worldStatus').unique())!;
    await ctx.db.insert('inputs', { engineId: status.engineId, number: 0, name: 'runtimeEvidence', received: 1,
      args: { deadline: Infinity, negativeInfinity: -Infinity, missingNumber: NaN, negativeZero: -0, bits: new Uint8Array([0, 127, 255]).buffer } });
  });
  const exported = await t.action(action('federation/backup:exportTown'), { adminToken });
  expect(() => convexToJson(exported as unknown as Value)).not.toThrow();
  expect(typeof exported.sections.inputs[0]).toBe('string');
  const check = (bundle: BackupBundle) => {
    const data = decodeRow(bundle.sections.inputs[0]).args;
    expect(data.deadline).toBe(Infinity);
    expect(data.negativeInfinity).toBe(-Infinity);
    expect(Number.isNaN(data.missingNumber)).toBe(true);
    expect(Object.is(data.negativeZero, -0)).toBe(true);
    expect([...new Uint8Array(data.bits)]).toEqual([0, 127, 255]);
  };
  check(await validateBundle(JSON.stringify(exported)));
  await t.action(action('federation/backup:importBackup'), { adminToken, bundleJson: JSON.stringify(exported), mode: 'restore', sourceStopped: true });
  const audit = (await t.query(ctx => ctx.db.query('backupImports').unique()))!;
  check({ ...exported, sections: { inputs: audit.runtimeSnapshot.inputs } });
  expect(() => convexToJson(audit as Value)).not.toThrow();
});

test('legacy object-row archives preserve signed special values when imported using JSON file transport', async () => {
  const { t } = await town();
  await t.run(async ctx => {
    const status = (await ctx.db.query('worldStatus').unique())!;
    await ctx.db.insert('inputs', { engineId: status.engineId, number: 0, name: 'runtimeEvidence', received: 1,
      args: { deadline: Infinity, bits: new Uint8Array([8, 9]).buffer } });
  });
  const exported = await t.action(action('federation/backup:exportTown'), { adminToken });
  const legacy: BackupBundle = structuredClone(exported);
  for (const [name, rows] of Object.entries(legacy.sections)) {
    legacy.sections[name] = rows.map(row => JSON.parse(row as string));
    legacy.manifest.sections[name] = { count: rows.length, digest: await digest(legacy.sections[name]),
      bytes: new TextEncoder().encode(JSON.stringify(legacy.sections[name])).length };
  }
  const local = (await t.query(ctx => ctx.db.query('federationIdentity').unique()))!;
  legacy.signature = await sign(legacy.manifest, local.privateKeyEncrypted);
  expect(() => convexToJson(legacy as unknown as Value)).toThrow();
  await expect(validateBundle(JSON.stringify(legacy))).resolves.toEqual(legacy);
  await expect(t.action(action('federation/backup:preflight'), { adminToken, bundleJson: JSON.stringify(legacy), mode: 'restore', sourceStopped: true })).resolves.toMatchObject({ valid: true });
  await expect(t.action(action('federation/backup:importBackup'), { adminToken, bundleJson: JSON.stringify(legacy), mode: 'restore', sourceStopped: true })).resolves.toMatchObject({ mode: 'restore' });
});

test('encoded string rows cannot hide credentials from archive validation', async () => {
  const { t } = await town();
  const exported = await t.action(action('federation/backup:exportTown'), { adminToken });
  const unsafe = await rewrite(exported, 'chatProfiles', row => { row.apiKey = 'forbidden-test-value'; });
  await expect(validateBundle(unsafe)).rejects.toThrow('BACKUP_CONTAINS_CREDENTIALS');
});


test('resident file restore preserves the real player negative-zero direction through Convex RPC', async () => {
  const { t, worldId } = await town();
  await t.run(async ctx => {
    const world = (await ctx.db.get(worldId))!;
    await ctx.db.patch(worldId, { players: world.players.map(player => ({ ...player, facing: { dx: 1, dy: -0 } })) });
  });
  const bundle = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  expect(() => convexToJson(bundle as unknown as Value)).not.toThrow();
  expect(Object.is(decodeRow(bundle.sections.worlds[0]).players[0].facing.dy, -0)).toBe(true);
  await t.run(ctx => ctx.db.patch(worldId, { players: [] }));
  const args = { adminToken, bundle: JSON.stringify(bundle), mode: 'restore', targetWorldId: worldId, sourceStopped: true };
  const report = await t.action(action('federation/backup:preflight'), args);
  await t.action(action('federation/backup:importBackup'), { ...args, bundle: undefined, bundleJson: args.bundle,
    residentRestore: { expectedTargetDigest: report.residentRestorePlan!.targetDigest, confirmOverwrite: true, operator: 'Home administrator', reason: 'Verify original direction' } });
  const restored = (await t.query(ctx => ctx.db.get(worldId)))!;
  expect(Object.is(restored.players[0].facing.dy, -0)).toBe(true);
});

test('successful exports audit declared scope and digest without copying private memory or admin token', async () => {
  const { t, worldId } = await town();
  const bundle = await t.action(action('federation/backup:exportResident'), {
    adminToken, worldId, playerId: 'p:0', operator: '  Local administrator  ', reason: '  Recovery rehearsal  ',
  }) as BackupBundle;
  const audit = await t.run(ctx => ctx.db.query('backupExportAudits').unique());
  expect(audit).toMatchObject({ scope: 'resident', operator: 'Local administrator', reason: 'Recovery rehearsal', attribution: 'declared', worldId, playerId: 'p:0', manifestDigest: await digest(bundle.manifest) });
  expect(audit?.sectionCounts.memories).toBe(bundle.manifest.sections.memories.count);
  expect(audit?.bytes).toBe(Object.values(bundle.manifest.sections).reduce((n, section) => n + section.bytes, 0));
  expect(JSON.stringify(audit)).not.toContain(adminToken);
  expect(audit).not.toHaveProperty('sections');
  await expect(t.query(makeFunctionReference<'query'>('federation/backupExportAudit:history'), { adminToken: 'wrong', paginationOpts: { cursor: null, numItems: 30 } })).rejects.toThrow();
  const page = await t.query(makeFunctionReference<'query'>('federation/backupExportAudit:history'), { adminToken, paginationOpts: { cursor: null, numItems: 30 } });
  expect(page.page).toHaveLength(1);
});

test('export audit distinguishes legacy attribution and records no successful export for failed generation', async () => {
  const { t, worldId } = await town();
  await expect(t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0', operator: 'missing reason' })).rejects.toThrow('BACKUP_EXPORT_ATTRIBUTION_REQUIRED');
  await expect(t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:999', operator: 'admin', reason: 'missing owner' })).rejects.toThrow();
  expect(await t.run(ctx => ctx.db.query('backupExportAudits').collect())).toHaveLength(0);
  await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  expect(await t.run(ctx => ctx.db.query('backupExportAudits').unique())).toMatchObject({ attribution: 'legacy-admin-token', operator: 'Unspecified administrator' });
});

test('public signing-key history survives a town backup only as untrusted immutable provenance', async () => {
  const { t } = await town();
  const certificate = { body: { townId: 'town:original', oldVersion: 1, newVersion: 2 }, oldSignature: 'historical-old', newSignature: 'historical-new' };
  const activation = { body: { rotationId: 'history-backup-test' }, oldSignature: 'historical-old', newSignature: 'historical-new' };
  await t.run(ctx => ctx.db.insert('federationIdentityKeyHistory', {
    rotationId: 'history-backup-test', townId: 'town:original', oldVersion: 1, newVersion: 2,
    oldPublicKey: 'historical-old-public', newPublicKey: 'historical-new-public', kind: 'SIGNED',
    role: 'LOCAL', certificate, activation, verified: true, acceptedAt: 1,
    operator: 'test operator', reason: 'test public backup provenance',
  }));
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  const exported = bundle.sections.federationIdentityKeyHistory.map(decodeRow);
  expect(exported).toHaveLength(1);
  expect(exported[0].certificate).toEqual(certificate);
  expect(bundle.sections.federationIdentityKeyRotations).toBeUndefined();
  expect(bundle.sections.federationIdentityKeyExchanges).toBeUndefined();
  await t.action(action('federation/backup:importBackup'), { adminToken, bundle, mode: 'restore', sourceStopped: true });
  const restored = await t.run(ctx => ctx.db.query('federationIdentityKeyHistory').collect());
  expect(restored).toHaveLength(1);
  expect(restored[0].verified).toBe(false);
  expect(restored[0].certificate).toEqual(certificate);
  expect(restored[0].activation).toEqual(activation);
});
