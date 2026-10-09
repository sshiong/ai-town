import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { DEFAULT_RESOURCE_LIMITS } from './resources';
import { Id } from '../_generated/dataModel';
import { createIdentityKeys, sign } from './security';
import { decodeRow, encodeRow } from './backupHelpers';
import { Game } from '../aiTown/game';
import { engineInsertInput } from '../engine/abstractGame';
import type { ActionCtx } from '../_generated/server';
import {
  descriptor,
  LargeChunk,
  LargeManifest,
  largeTables,
  oldTables,
  validateManifest,
  validateSourceRow,
} from './backupLargeHelpers';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/backupLarge.ts': () => import('./backupLarge'),
  '../federation/backup.ts': () => import('./backup'),
  '../models/embeddings.ts': () => import('../models/embeddings'),
  '../engine/abstractGame.ts': () => import('../engine/abstractGame'),
  '../aiTown/game.ts': () => import('../aiTown/game'),
};
jest.setTimeout(60000);
const adminToken = 'large-backup-admin-token-32-characters';
const action = (name: string) => makeFunctionReference<'action'>(`federation/backupLarge:${name}`);
const mutation = (name: string) =>
  makeFunctionReference<'mutation'>(`federation/backupLarge:${name}`);
const query = (name: string) => makeFunctionReference<'query'>(`federation/backupLarge:${name}`);
beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
});
beforeEach(() => {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
});

async function town(memoryCount = 2) {
  const t = convexTest(schema, modules);
  const keys = await createIdentityKeys();
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert('federationIdentity', {
      ...keys,
      townId: 'town:large',
      townName: 'Large',
      deploymentInstanceId: 'old-instance',
      deploymentEpoch: 3,
      endpoint: 'https://large.example/federation/v1',
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
    const engineId = await ctx.db.insert('engines', { running: false, generationNumber: 2 });
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
    const chatProfileId = await ctx.db.insert('chatProfiles', {
      name: 'Fixed',
      provider: 'custom',
      url: 'https://chat.example',
      model: 'fixed',
      stopWords: [],
      createdAt: 1,
    });
    await ctx.db.insert('modelSettings', { key: 'town', mainChatProfileId: chatProfileId });
    const agentGlobalId = `town:large/agent:${worldId}:a:1`;
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
      homeTownId: 'town:large',
      state: 'HOME_ACTIVE',
      agentAuthorityEpoch: 3,
      updatedAt: 1,
    });
    const memoryIds: Id<'memories'>[] = [];
    for (let index = 0; index < memoryCount; index++)
      memoryIds.push(
        await ctx.db.insert('memories', {
          worldId,
          playerId: 'p:0',
          agentGlobalId,
          description: `Canonical memory ${index}`,
          importance: 8,
          lastAccess: 1,
          data: { type: 'reflection', relatedMemoryIds: [] },
        }),
      );
    if (memoryIds.length >= 2) {
      await ctx.db.patch(memoryIds[0], {
        data: { type: 'reflection', relatedMemoryIds: [memoryIds[1]] },
      });
      await ctx.db.patch(memoryIds[1], {
        data: { type: 'reflection', relatedMemoryIds: [memoryIds[0]] },
      });
    }
    return { worldId, engineId, agentGlobalId, memoryIds };
  });
  return { t, keys, ...ids };
}
type Town = Awaited<ReturnType<typeof town>>;
async function drive(
  t: Town['t'],
  jobId: Id<'backupLargeJobs'>,
  kind: 'export' | 'import',
  until: string,
) {
  for (let index = 0; index < 1000; index++) {
    const state = await t.query(query('status'), { adminToken, jobId });
    if (state.state === until || state.phase === until) return state;
    if (state.state === 'FAILED') throw new Error(state.error);
    await t.action(action(kind === 'export' ? 'advanceExport' : 'advanceImport'), {
      adminToken,
      jobId,
    });
  }
  throw new Error('Job failed to reach checkpoint');
}
async function exported(t: Town['t']) {
  const { jobId } = await t.mutation(mutation('startExport'), { adminToken });
  await drive(t, jobId, 'export', 'COMPLETE');
  const { manifest, signature } = await t.action(action('getManifest'), { adminToken, jobId });
  const chunks: LargeChunk[] = [];
  for (const entry of manifest.chunks)
    chunks.push(
      JSON.parse(await t.action(action('getChunk'), { adminToken, jobId, index: entry.index })),
    );
  return { manifest: manifest as LargeManifest, signature: signature as string, chunks };
}
async function staged(
  t: Town['t'],
  archive: Awaited<ReturnType<typeof exported>>,
  mode: 'restore' | 'clone' = 'restore',
) {
  const { jobId } = await t.action(action('createImport'), {
    adminToken,
    manifest: archive.manifest,
    signature: archive.signature,
    mode,
    sourceStopped: true,
    ...(mode === 'clone' ? { targetEndpoint: 'https://copy.example/federation/v1' } : {}),
  });
  for (const chunk of archive.chunks)
    await t.action(action('stageChunk'), { adminToken, jobId, chunk: JSON.stringify(chunk) });
  return jobId as Id<'backupLargeJobs'>;
}

test('large signed export and restore preserve all canonical memories, cyclic references and fixed model ownership', async () => {
  const { t, agentGlobalId } = await town(510);
  const archive = await exported(t);
  await t.run(async ctx => {
    const local = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(local._id, { resourceLimits: DEFAULT_RESOURCE_LIMITS });
  });
  expect(
    archive.manifest.chunks.filter((c) => c.table === 'memories').reduce((n, c) => n + c.count, 0),
  ).toBe(510);
  expect(JSON.stringify(archive)).not.toMatch(
    /privateKeyEncrypted|credentialEncrypted|fencingToken/,
  );
  const jobId = await staged(t, archive);
  await drive(t, jobId, 'import', 'READY');
  await expect(
    t.mutation(makeFunctionReference<'mutation'>('federation/backup:reconcileRestoredResident'), {
      adminToken,
      agentGlobalId,
      sourceStopped: true,
    }),
  ).rejects.toThrow('TOWN_BACKUP_MAINTENANCE_LOCKED');
  await t.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(t, jobId, 'import', 'COMPLETE');
  const result = await t.query(async (ctx) => ({
    memories: await ctx.db.query('memories').collect(),
    bindings: await ctx.db.query('residentModelBindings').collect(),
    profiles: await ctx.db.query('chatProfiles').collect(),
    local: await ctx.db.query('federationIdentity').unique(),
    lock: await ctx.db.query('backupMaintenanceLocks').first(),
    inputs: await ctx.db.query('inputs').collect(),
  }));
  expect(result.memories).toHaveLength(510);
  expect(result.bindings[0].agentGlobalId).toBe(agentGlobalId);
  expect(result.profiles[0].model).toBe('fixed');
  expect(result.bindings[0].chatProfileId).toBe(result.profiles[0]._id);
  expect(result.local!.deploymentEpoch).toBe(4);
  expect(result.local!.resourceLimits).toEqual({ ...DEFAULT_RESOURCE_LIMITS, maxConcurrentLocalLLM: 1, maxVisitReservations: 3 });
  expect(result.lock).toBeNull();
  expect(result.inputs).toHaveLength(0);
  const first = result.memories.find((m) => m.description === 'Canonical memory 0')!;
  const second = result.memories.find((m) => m.description === 'Canonical memory 1')!;
  expect(first.data).toEqual({ type: 'reflection', relatedMemoryIds: [second._id] });
  expect(second.data).toEqual({ type: 'reflection', relatedMemoryIds: [first._id] });
  await expect(
    t.action(action('getChunk'), { adminToken, jobId, index: archive.chunks.length }),
  ).rejects.toThrow('BACKUP_MANIFEST_NOT_READY');
});

test('chunked restore resets a nonzero source cursor and commits the first new engine input zero', async () => {
  jest.useFakeTimers();
  try {
    const { t, engineId } = await town();
    await t.run(async ctx => {
      await ctx.db.patch(engineId, { processedInputNumber: 58 });
      await ctx.db.insert('inputs', { engineId, number: 58, name: 'join', args: {}, received: 1, returnValue: { kind: 'ok', value: 'source-only-input' } });
    });
    const archive = await exported(t);
    const sourceEngine = archive.chunks.find(c => c.table === 'engines' && c.rows.length)!;
    expect(decodeRow(sourceEngine.rows[0]).processedInputNumber).toBe(58);
    const sourceInputs = archive.chunks.find(c => c.table === 'inputs' && c.rows.length)!;
    expect(decodeRow(sourceInputs.rows[0]).number).toBe(58);
    const jobId = await staged(t, archive);
    await drive(t, jobId, 'import', 'READY');
    await t.mutation(mutation('startApply'), { adminToken, jobId });
    await drive(t, jobId, 'import', 'COMPLETE');
    const { engine, worldId, inputId } = await t.run(async ctx => {
      const engine = (await ctx.db.query('engines').unique())!;
      const status = (await ctx.db.query('worldStatus').unique())!;
      expect(engine.processedInputNumber).toBeUndefined();
      expect(await ctx.db.query('inputs').collect()).toEqual([]);
      const audit = (await ctx.db.query('backupImports').unique())!;
      expect(audit.runtimeSnapshot.largeJobId).toBe(jobId);
      await ctx.db.patch(engine._id, { running: true });
      const inputId = await engineInsertInput(ctx, engine._id, 'join', { name: 'First chunk restored human', character: 'f1', description: 'First input after chunk restore', tokenIdentifier: 'chunk-restored-human' });
      return { engine, worldId: status.worldId, inputId };
    });
    const loaded = await t.run(ctx => Game.load(ctx.db, worldId, engine.generationNumber));
    const game = new Game(loaded.engine, worldId, loaded.gameState);
    jest.spyOn(game, 'tick').mockImplementation(() => {});
    await game.runStep({ runQuery: (ref: any, args: any) => t.query(ref, args), runMutation: (ref: any, args: any) => t.mutation(ref, args) } as ActionCtx, Date.now());
    await t.run(async ctx => {
      const input = (await ctx.db.get(inputId))!;
      expect(input.number).toBe(0);
      expect(input.returnValue?.kind).toBe('ok');
      expect((await ctx.db.get(engine._id))!.processedInputNumber).toBe(0);
      expect((await ctx.db.get(worldId))!.players.some(p => p.human === 'chunk-restored-human')).toBe(true);
    });
  } finally {
    jest.useRealTimers();
  }
});

test.each([false, true])('relationship evidence survives cross-chunk allocation and cycles (rollback=%s)', async rollback => {
  const { t, memoryIds } = await town(45);
  await t.run(async ctx => {
    await ctx.db.patch(memoryIds[0], {
      data: { type: 'relationship', playerId: 'p:0', evidenceMemoryIds: [memoryIds[40], memoryIds[0]], encounterCount: 2 },
    });
    await ctx.db.patch(memoryIds[40], {
      data: { type: 'relationship', playerId: 'p:0', evidenceMemoryIds: [memoryIds[0]] },
    });
  });
  const archive = await exported(t);
  expect(archive.chunks.find(c => c.rows.some(row => decodeRow(row)._id === memoryIds[0]))!.index)
    .not.toBe(archive.chunks.find(c => c.rows.some(row => decodeRow(row)._id === memoryIds[40]))!.index);
  await t.run(ctx => ctx.db.patch(memoryIds[0], { description: 'Target relationship newer than archive' }));
  const jobId = await staged(t, archive);
  await drive(t, jobId, 'import', 'READY');
  await t.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(t, jobId, 'import', 'REMAP');
  if (rollback) await t.mutation(mutation('cancel'), { adminToken, jobId });
  await drive(t, jobId, 'import', rollback ? 'CANCELLED' : 'COMPLETE');
  const result = await t.query(async ctx => ({
    memories: await ctx.db.query('memories').collect(),
    lock: await ctx.db.query('backupMaintenanceLocks').first(),
  }));
  const first = result.memories.find(m => m.description === (rollback ? 'Target relationship newer than archive' : 'Canonical memory 0'))!;
  const last = result.memories.find(m => m.description === 'Canonical memory 40')!;
  expect(first.data).toEqual({ type: 'relationship', playerId: 'p:0', evidenceMemoryIds: [last._id, first._id], encounterCount: 2 });
  expect(last.data).toEqual({ type: 'relationship', playerId: 'p:0', evidenceMemoryIds: [first._id] });
  expect(result.memories).toHaveLength(45);
  expect(result.lock).toBeNull();
});

test('large recovery cannot overwrite an identity quarantine at creation or finalization', async () => {
  const { t } = await town();
  const archive = await exported(t);
  await t.run(async ctx => {
    const local = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(local._id, { mode: 'QUARANTINED', quarantinePreviousMode: local.mode });
  });
  await expect(staged(t, archive)).rejects.toThrow('TOWN_CLONE_CONFLICT');
  await t.run(async ctx => {
    const local = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(local._id, { mode: 'ACTIVE', quarantinePreviousMode: undefined });
  });
  const jobId = await staged(t, archive);
  await drive(t, jobId, 'import', 'READY');
  await t.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(t, jobId, 'import', 'FINALIZE');
  await t.run(async ctx => {
    const local = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(local._id, { mode: 'QUARANTINED', quarantinePreviousMode: local.mode });
  });
  const failed = await t.action(action('advanceImport'), { adminToken, jobId });
  expect(failed.state).toBe('FAILED');
  expect(failed.error).toContain('TOWN_CLONE_CONFLICT');
  const local = await t.query(ctx => ctx.db.query('federationIdentity').unique());
  expect(local!.mode).toBe('QUARANTINED');
  expect(local!.deploymentEpoch).toBe(3);
  await t.mutation(mutation('cancel'), { adminToken, jobId });
  await drive(t, jobId, 'import', 'CANCELLED');
  expect((await t.query(ctx => ctx.db.query('federationIdentity').unique()))!.mode).toBe('QUARANTINED');
});

test.each(['restore', 'clone'] as const)('large %s preserves autonomous policy and completed audit without reviving a running decision', async mode => {
  const { t, worldId, agentGlobalId } = await town();
  await t.run(async ctx => {
    const policyId = await ctx.db.insert('autonomousTravelPolicies', {
      worldId, agentGlobalId, playerId: 'p:0', enabled: true, allowedPeerTownIds: ['town:friend'],
      decisionIntervalMs: 60000, dailyRequestLimit: 2, revision: 7, nextDecisionAt: 1,
      operator: 'admin', reason: 'Visit this friend', updatedAt: 1,
    });
    for (const state of ['RUNNING', 'VISIT_REQUESTED'])
      await ctx.db.insert('autonomousTravelDecisions', {
        policyId, policyRevision: 7, worldId, agentGlobalId, playerId: 'p:0', agentId: 'a:1',
        operationId: `operation-${state}`, state, createdAt: 1, deadline: 2,
        ...(state === 'VISIT_REQUESTED' ? { completedAt: 2, destinationTownId: 'town:friend', visitId: 'historical-visit', reason: 'Meet my friend' } : {}),
      });
  });
  const archive = await exported(t);
  const target = mode === 'clone' ? convexTest(schema, modules) : t;
  const jobId = await staged(target, archive, mode);
  await drive(target, jobId, 'import', 'READY');
  await target.mutation(mutation('startApply'), { adminToken, jobId });
  const beforeApply = Date.now();
  await drive(target, jobId, 'import', 'COMPLETE');
  const result = await target.query(async ctx => ({
    policy: await ctx.db.query('autonomousTravelPolicies').unique(),
    decisions: await ctx.db.query('autonomousTravelDecisions').collect(),
    binding: await ctx.db.query('residentModelBindings').unique(),
    local: await ctx.db.query('federationIdentity').unique(),
  }));
  expect(result.policy!.nextDecisionAt).toBeGreaterThanOrEqual(beforeApply + 60000);
  expect(result.policy).toMatchObject({ revision: 7, enabled: true, allowedPeerTownIds: ['town:friend'], agentGlobalId: result.binding!.agentGlobalId, worldId: result.binding!.worldId });
  expect(result.decisions.every(d => d.policyId === result.policy!._id && d.worldId === result.binding!.worldId && d.agentGlobalId === result.binding!.agentGlobalId)).toBe(true);
  expect(result.decisions.find(d => d.operationId === 'operation-RUNNING')).toMatchObject({ state: 'STALE', error: 'BACKUP_RESTORE_INTERRUPTED_DECISION' });
  expect(result.decisions.find(d => d.operationId === 'operation-VISIT_REQUESTED')).toMatchObject({ state: 'VISIT_REQUESTED', completedAt: 2, destinationTownId: 'town:friend', visitId: 'historical-visit', reason: 'Meet my friend' });
  expect(result.local!.enabled).toBe(false);
});

test('legacy signed large manifests without optional autonomy and resource sections still restore', async () => {
  const { t, keys } = await town();
  const archive = await exported(t);
  archive.chunks = archive.chunks.filter(c => !c.table.startsWith('autonomousTravel') && !c.table.startsWith('federationResource'))
    .map((c, index) => ({ ...c, index }));
  archive.manifest.chunks = await Promise.all(archive.chunks.map(descriptor));
  archive.signature = await sign(archive.manifest, keys.privateKeyEncrypted);
  const jobId = await staged(t, archive);
  await drive(t, jobId, 'import', 'READY');
  await t.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(t, jobId, 'import', 'COMPLETE');
  expect(await t.query(ctx => ctx.db.query('autonomousTravelPolicies').collect())).toEqual([]);
});

test.each(['restore', 'clone', 'rollback'] as const)('large %s preserves capacity policy and audit without backing up transient measurements', async mode => {
  const { t, keys } = await town();
  await t.run(async ctx => {
    await ctx.db.insert('federationResourcePolicy', { maxVisitorsPerSourceTown: 3 });
    await ctx.db.insert('federationResourceAudit', { operation: 'SOURCE_QUOTA_CHANGED', previous: null, next: 3, createdAt: 1 });
    await ctx.db.insert('federationResourceMetrics', { kind: 'INBOUND_EVENT', bucketStart: Date.now(), count: 1, durationCount: 0, durationSumMs: 0, samples: [] });
  });
  expect(largeTables.slice(-4)).toEqual(['autonomousTravelPolicies', 'autonomousTravelDecisions', 'federationResourcePolicy', 'federationResourceAudit']);
  expect(oldTables.slice(-4)).toEqual(['autonomousTravelPolicies', 'autonomousTravelDecisions', 'federationResourcePolicy', 'federationResourceAudit']);
  const archive = await exported(t);
  expect(archive.manifest.chunks.some(c => c.table === 'federationResourceMetrics')).toBe(false);
  expect(archive.manifest.chunks.filter(c => c.table === 'federationResourcePolicy').reduce((sum, c) => sum + c.count, 0)).toBe(1);
  const invalid = structuredClone(archive.manifest);
  invalid.chunks.find(c => c.table === 'federationResourcePolicy')!.count = 2;
  await expect(validateManifest(invalid, await sign(invalid, keys.privateKeyEncrypted))).rejects.toThrow('BACKUP_SINGLETON_MISMATCH');
  const target = mode === 'clone' ? convexTest(schema, modules) : t;
  if (mode === 'rollback') await t.run(async ctx => {
    const policy = (await ctx.db.query('federationResourcePolicy').unique())!;
    await ctx.db.patch(policy._id, { maxVisitorsPerSourceTown: 7 });
    await ctx.db.insert('federationResourceAudit', { operation: 'SOURCE_QUOTA_CHANGED', previous: 3, next: 7, createdAt: 2 });
  });
  const jobId = await staged(target, archive, mode === 'clone' ? 'clone' : 'restore');
  await drive(target, jobId, 'import', 'READY');
  await target.mutation(mutation('startApply'), { adminToken, jobId });
  if (mode === 'rollback') {
    await drive(target, jobId, 'import', 'REMAP');
    await target.mutation(mutation('cancel'), { adminToken, jobId });
  }
  await drive(target, jobId, 'import', mode === 'rollback' ? 'CANCELLED' : 'COMPLETE');
  const result = await target.query(async ctx => ({
    policy: await ctx.db.query('federationResourcePolicy').unique(),
    audit: await ctx.db.query('federationResourceAudit').collect(),
    metrics: await ctx.db.query('federationResourceMetrics').collect(),
  }));
  expect(result.policy!.maxVisitorsPerSourceTown).toBe(mode === 'rollback' ? 7 : 3);
  expect(result.audit).toHaveLength(mode === 'rollback' ? 2 : 1);
  expect(result.audit.some(row => row.createdAt === 1 && row.next === 3)).toBe(true);
  expect(result.metrics).toHaveLength(mode === 'clone' ? 0 : 1);
});

test('backup preflight rejects invalid quota and identity capacity limits before applying data', async () => {
  for (const maxVisitorsPerSourceTown of [-1, 0.5, 1001])
    expect(() => validateSourceRow('federationResourcePolicy', {
      _id: 'invalid-policy', _creationTime: 1, maxVisitorsPerSourceTown,
    })).toThrow('INVALID_SOURCE_VISITOR_QUOTA');
  const { t, keys } = await town();
  const archive = await exported(t);
  archive.manifest.source.resourceLimits.maxConcurrentLocalLLM = -1;
  await expect(validateManifest(archive.manifest, await sign(archive.manifest, keys.privateKeyEncrypted)))
    .rejects.toThrow('INVALID_RESOURCE_LIMIT:maxConcurrentLocalLLM');
  expect(await t.query(ctx => ctx.db.query('federationResourcePolicy').collect())).toEqual([]);
});

test('tampered chunk is rejected before staging and retry is idempotent; cross-chunk missing references fail before writes', async () => {
  const { t, keys } = await town();
  const archive = await exported(t);
  const jobId = await t.action(action('createImport'), {
    adminToken,
    ...{ manifest: archive.manifest, signature: archive.signature },
    mode: 'restore',
    sourceStopped: true,
  });
  const tampered = { ...archive.chunks[0], rows: [] };
  await expect(
    t.action(action('stageChunk'), {
      adminToken,
      jobId: jobId.jobId,
      chunk: JSON.stringify(tampered),
    }),
  ).rejects.toThrow('BACKUP_CHECKSUM_MISMATCH');
  await t.action(action('stageChunk'), {
    adminToken,
    jobId: jobId.jobId,
    chunk: JSON.stringify(archive.chunks[0]),
  });
  await t.action(action('stageChunk'), {
    adminToken,
    jobId: jobId.jobId,
    chunk: JSON.stringify(archive.chunks[0]),
  });
  expect((await t.query(query('status'), { adminToken, jobId: jobId.jobId })).uploadedChunks).toBe(
    1,
  );
  await t.mutation(mutation('cancel'), { adminToken, jobId: jobId.jobId });
  const changed = structuredClone(archive);
  const chunk = changed.chunks.find((c) => c.table === 'memories' && c.rows.length)!;
  const memory = decodeRow(chunk.rows[0]);
  memory.data.relatedMemoryIds = ['missing-memory'];
  chunk.rows[0] = encodeRow(memory);
  changed.manifest.chunks[chunk.index] = await descriptor(chunk);
  changed.signature = await sign(changed.manifest, keys.privateKeyEncrypted);
  const badId = await staged(t, changed);
  await t.action(action('advanceImport'), { adminToken, jobId: badId });
  let state;
  for (let index = 0; index < 30; index++) {
    state = await t.action(action('advanceImport'), { adminToken, jobId: badId });
    if (state.state === 'FAILED') break;
  }
  expect(state!.error).toContain('BACKUP_REFERENCE_MISSING');
  expect(await t.query((ctx) => ctx.db.query('memories').collect())).toHaveLength(2);
  await t.mutation(mutation('cancel'), { adminToken, jobId: badId });
  expect(await t.query((ctx) => ctx.db.query('backupMaintenanceLocks').first())).toBeNull();
});

test('partial import cancellation restores the original private target snapshot and repairs all document IDs', async () => {
  const { t, agentGlobalId } = await town();
  const archive = await exported(t);
  await t.run(async (ctx) => {
    const memory = await ctx.db.query('memories').first();
    await ctx.db.patch(memory!._id, { description: 'Target memory newer than archive' });
  });
  const before = await t.query((ctx) => ctx.db.query('federationIdentity').unique());
  const jobId = await staged(t, archive);
  await drive(t, jobId, 'import', 'READY');
  await t.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(t, jobId, 'import', 'REMAP');
  await t.mutation(mutation('cancel'), { adminToken, jobId });
  await drive(t, jobId, 'import', 'CANCELLED');
  const result = await t.query(async (ctx) => ({
    memories: await ctx.db.query('memories').collect(),
    worlds: await ctx.db.query('worlds').collect(),
    runtime: await ctx.db.query('federationAgentRuntimes').unique(),
    binding: await ctx.db.query('residentModelBindings').unique(),
    identity: await ctx.db.query('federationIdentity').unique(),
    lock: await ctx.db.query('backupMaintenanceLocks').first(),
  }));
  expect(result.memories.map((m) => m.description)).toContain('Target memory newer than archive');
  expect(result.identity).toEqual(before);
  expect(result.runtime!.agentGlobalId).toBe(agentGlobalId);
  expect(result.runtime!.worldId).toBe(result.worlds[0]._id);
  expect(result.binding!.worldId).toBe(result.worlds[0]._id);
  expect(result.lock).toBeNull();
  for (const memory of result.memories) {
    expect(memory.worldId).toBe(result.worlds[0]._id);
    if (memory.data.type === 'reflection')
      expect(result.memories.map((m) => m._id)).toContain(memory.data.relatedMemoryIds[0]);
  }
});

test('clone creates a new identity and local global ownership while retaining prose and history', async () => {
  const { t } = await town();
  const archive = await exported(t);
  const destination = convexTest(schema, modules);
  const jobId = await staged(destination, archive, 'clone');
  await drive(destination, jobId, 'import', 'READY');
  await destination.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(destination, jobId, 'import', 'COMPLETE');
  const result = await destination.query(async (ctx) => ({
    local: await ctx.db.query('federationIdentity').unique(),
    binding: await ctx.db.query('residentModelBindings').unique(),
    runtime: await ctx.db.query('federationAgentRuntimes').unique(),
    memories: await ctx.db.query('memories').collect(),
  }));
  expect(result.local!.townId).not.toBe(archive.manifest.source.townId);
  expect(result.local!.publicKey).not.toBe(archive.manifest.source.publicKey);
  expect(result.local!.endpoint).toBe('https://copy.example/federation/v1');
  expect(result.binding!.agentGlobalId).toBe(result.runtime!.agentGlobalId);
  expect(result.binding!.agentGlobalId).toContain(result.local!.townId);
  expect(result.memories[0].agentGlobalId).toBe(result.binding!.agentGlobalId);
  expect(result.memories[0].description).toBe('Canonical memory 0');
});

test('manifest must be signed, complete and ordered; exporting cancellation releases the lock', async () => {
  const { t, keys } = await town();
  const archive = await exported(t);
  await expect(validateManifest(archive.manifest, 'invalid')).rejects.toThrow(
    'BACKUP_SIGNATURE_INVALID',
  );
  const incomplete = {
    ...archive.manifest,
    chunks: archive.manifest.chunks
      .filter((c) => c.table !== 'memories')
      .map((c, index) => ({ ...c, index })),
  };
  await expect(
    validateManifest(incomplete, await sign(incomplete, keys.privateKeyEncrypted)),
  ).rejects.toThrow('INCOMPLETE_LARGE_BACKUP_MANIFEST');
  const { jobId } = await t.mutation(mutation('startExport'), { adminToken });
  await t.mutation(mutation('cancel'), { adminToken, jobId });
  expect(await t.query((ctx) => ctx.db.query('backupMaintenanceLocks').first())).toBeNull();
});

test('JSON string transport preserves Convex bytes and nonfinite runtime values through staging and private rollback', async () => {
  const { t, worldId, engineId } = await town();
  await t.run(async (ctx) => {
    await ctx.db.patch(worldId, {
      historicalLocations: [{ playerId: 'p:0', location: new Uint8Array([0, 255, 32]).buffer }],
    });
    await ctx.db.insert('inputs', {
      engineId,
      number: 0,
      name: 'join',
      args: { deadline: Infinity, bits: new Uint8Array([1, 2, 3]).buffer },
      received: 1,
    });
  });
  const archive = await exported(t);
  const rawWorld = decodeRow(archive.chunks.find((c) => c.table === 'worlds')!.rows[0]);
  expect(new Uint8Array(rawWorld.historicalLocations[0].location)).toEqual(
    new Uint8Array([0, 255, 32]),
  );
  const rawInput = decodeRow(archive.chunks.find((c) => c.table === 'inputs')!.rows[0]);
  expect(rawInput.args.deadline).toBe(Infinity);
  const jobId = await staged(t, archive);
  await drive(t, jobId, 'import', 'READY');
  await t.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(t, jobId, 'import', 'REMAP');
  // Simulate a worker failure at a durable checkpoint, then resume without duplicate allocations.
  await t.mutation(mutation('fail'), { jobId, error: 'temporary interruption' });
  expect((await t.query(query('status'), { adminToken, jobId })).canResume).toBe(true);
  await t.mutation(mutation('resume'), { adminToken, jobId });
  await t.mutation(mutation('cancel'), { adminToken, jobId });
  await drive(t, jobId, 'import', 'CANCELLED');
  const restored = await t.query(async (ctx) => ({
    world: await ctx.db.query('worlds').unique(),
    input: await ctx.db.query('inputs').unique(),
  }));
  expect(new Uint8Array(restored.world!.historicalLocations![0].location)).toEqual(
    new Uint8Array([0, 255, 32]),
  );
  expect(restored.input!.args.deadline).toBe(Infinity);
  expect(restored.input!.engineId).not.toBe(engineId);
  expect(new Uint8Array(restored.input!.args.bits)).toEqual(new Uint8Array([1, 2, 3]));
});

test('same-town large recovery retains lease evidence and resumes travelers only after every recorded lease is fenced', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(1800000000000);
  try {
    const { t, worldId, agentGlobalId } = await town();
    const stoppedAt = Date.now();
    const proposal = stoppedAt + 600000;
    await t.run(async (ctx) => {
      const world = await ctx.db.get(worldId);
      await ctx.db.patch(worldId, {
        players: [],
        agents: [
          { ...world!.agents[0], travelVisitId: 'visit-large', suspendedPlayer: world!.players[0] },
        ],
      });
      const runtime = await ctx.db.query('federationAgentRuntimes').unique();
      await ctx.db.patch(runtime!._id, { state: 'TRAVELING', visitId: 'visit-large' });
      await ctx.db.insert('visitLedger', {
        visitId: 'visit-large',
        agentGlobalId,
        homeTownId: 'town:large',
        hostTownId: 'town:host',
        homeDeploymentEpoch: 3,
        hostDeploymentEpoch: 2,
        agentAuthorityEpoch: 3,
        visitLeaseVersion: 1,
        leaseExpiry: stoppedAt + 10000,
        fencingToken: 'do-not-export',
        state: 'COMPLETED',
        role: 'home',
        worldId,
        homePlayerId: 'p:0',
        profile: {},
        createdAt: stoppedAt,
        updatedAt: stoppedAt,
      });
      await ctx.db.insert('federationOutbox', {
        messageId: 'lease-proposal',
        toTownId: 'town:host',
        envelope: { visitId: 'visit-large', payload: { leaseExpiry: proposal } },
        attempts: 1,
        nextRetryAt: stoppedAt,
      });
    });
    const archive = await exported(t);
    const jobId = await staged(t, archive);
    await drive(t, jobId, 'import', 'READY');
    await t.mutation(mutation('startApply'), { adminToken, jobId });
    await drive(t, jobId, 'import', 'COMPLETE');
    const pending = await t.query(
      makeFunctionReference<'query'>('federation/backup:restoredResidents'),
      { adminToken },
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      agentGlobalId,
      safeAfter: proposal + 60000,
      canResume: false,
      reason: 'OLD_HOST_LEASE_STILL_VALID',
    });
    jest.setSystemTime(proposal + 60000);
    const result = await t.mutation(
      makeFunctionReference<'mutation'>('federation/backup:reconcileRestoredResident'),
      { adminToken, agentGlobalId, sourceStopped: true },
    );
    expect(result.state).toBe('HOME_ACTIVE');
    const world = await t.query((ctx) => ctx.db.query('worlds').unique());
    expect(world!.players[0].id).toBe('p:0');
    expect(world!.agents[0].travelVisitId).toBeUndefined();
    expect(await t.query((ctx) => ctx.db.query('federationOutbox').collect())).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});
