import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { Id } from '../_generated/dataModel';
import { createIdentityKeys, sign } from './security';
import { decodeRow, encodeRow } from './backupHelpers';
import {
  descriptor,
  LargeChunk,
  LargeManifest,
  largeTables,
  validateManifest,
} from './backupLargeHelpers';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/backupLarge.ts': () => import('./backupLarge'),
  '../federation/backup.ts': () => import('./backup'),
  '../models/embeddings.ts': () => import('../models/embeddings'),
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
      .filter((c) => c.table !== largeTables[largeTables.length - 1])
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
