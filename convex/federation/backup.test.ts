import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { packColdFiles } from './coldBackup';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { Id } from '../_generated/dataModel';
import { convexToJson, type Value } from 'convex/values';
import { createIdentityKeys, digest, sign } from './security';
import { BackupBundle, decodeRow, encodeRow, validateBundle } from './backupHelpers';
import { embeddingFingerprint } from '../models/compatibility';
import { memorySourceDigest } from '../models/embeddingDataRevision';
import { pipelineFingerprint } from '../models/ollamaEvidence';
import { applyBackupData, importBackup } from './backup';
import { independentCloneStatus } from './cloneActivation';
import { seedMemoryBackupEvidence, assertMemoryBackupEvidence, useLegacyMemoryBackupDigests } from './memoryBackupTestHelpers';

test('atomic cold packing rejects a large v2 root before fetching or combining its parts', async () => {
  let partReads = 0;
  const ctx = { runQuery: async () => [{ owner: {}, archive: { manifest: { version: 2, chunkCount: 20, bytes: 5_000_000 } } }],
    runAction: async () => { partReads++; throw new Error('PART_SHOULD_NOT_BE_READ'); } } as unknown as ActionCtx;
  await expect(packColdFiles(ctx, adminToken, { manifest: {}, sections: {} } as BackupBundle))
    .rejects.toThrow('BACKUP_COLD_FILES_REQUIRES_CHUNKED_ARCHIVE');
  expect(partReads).toBe(0);
});
import { defaultStoragePolicy } from './storagePolicy';
import { receiveConversationEnded } from '../agent/travelTranscript';
import { DEFAULT_RESOURCE_LIMITS } from './resources';
import { Game } from '../aiTown/game';
import { engineInsertInput } from '../engine/abstractGame';
import type { ActionCtx } from '../_generated/server';
import { providerUsageKey } from '../models/usage';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/coldBackup.ts': () => import('./coldBackup'),
  '../federation/coldHistory.ts': () => import('./coldHistory'),
  '../federation/coldHistoryFiles.ts': () => import('./coldHistoryFiles'),
  '../federation/backup.ts': () => import('./backup'),
  '../federation/archiveUploadProvenance.ts': () => import('./archiveUploadProvenance'),
  '../federation/travelPrivacy.ts': () => import('./travelPrivacy'),
  '../federation/travelPrivacyChunkCoordinator.ts': () => import('./travelPrivacyChunkCoordinator'),
  '../federation/travelPrivacyChunkArchives.ts': () => import('./travelPrivacyChunkArchives'),
  '../federation/travelPrivacyChunkRewrite.ts': () => import('./travelPrivacyChunkRewrite'),
  '../federation/travelPrivacyChunkReferenceProof.ts': () => import('./travelPrivacyChunkReferenceProof'),
  '../federation/travelPrivacyArchives.ts': () => import('./travelPrivacyArchives'),
  '../federation/admin.ts': () => import('./admin'),
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

test('old town backup cannot resurrect a cleared conversation and rejection leaves the target intact', async () => {
  const { t, worldId } = await town();
  const memoryId = await t.run(ctx => ctx.db.insert('memories', {
    worldId, playerId: 'p:0', description: 'Private old dialogue', importance: 5, lastAccess: 1,
    data: { type: 'conversation', conversationId: 'c:private', playerIds: [] },
  }));
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  await t.run(async ctx => {
    await ctx.db.insert('travelPrivacyTombstones', {
      key: `memory:${memoryId}`, visitId: 'closed-private', createdAt: 2,
    });
    await ctx.db.delete(memoryId);
  });
  const before = await t.run(ctx => ctx.db.query('worlds').collect());
  const beforeMemories = await t.run(ctx => ctx.db.query('memories').collect());
  await expect(t.action(action('federation/backup:importBackup'), {
    adminToken, bundle, mode: 'restore', sourceStopped: true,
  })).rejects.toThrow('BACKUP_PRIVACY_REDACTED');
  expect(await t.run(ctx => ctx.db.query('worlds').collect())).toEqual(before);
  expect(await t.run(ctx => ctx.db.query('memories').collect())).toEqual(beforeMemories);
  expect(await t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toHaveLength(1);
});

test('resident restore rechecks privacy when clearing happens after confirmation', async () => {
  const { t, worldId } = await town();
  const bundle: BackupBundle = await t.action(action('federation/backup:exportResident'), {
    adminToken, worldId, playerId: 'p:0',
  });
  const args = await residentRestoreArgs(t, bundle, worldId);
  const memoryId = decodeRow(bundle.sections.memories[0])._id as Id<'memories'>;
  await t.run(async ctx => {
    await ctx.db.insert('travelPrivacyTombstones', {
      key: `memory:${memoryId}`, visitId: 'visit-1', createdAt: 2,
    });
    await ctx.db.delete(memoryId);
  });
  const before = await t.run(ctx => ctx.db.query('memories').collect());
  await expect(t.action(action('federation/backup:importBackup'), args))
    .rejects.toThrow('BACKUP_PRIVACY_REDACTED');
  expect(await t.run(ctx => ctx.db.query('memories').collect())).toEqual(before);
});

test('clean town clone carries deletion history and rejects importing an older body archive', async () => {
  const { t, worldId, agentGlobalId } = await town();
  const memoryId = await t.run(ctx => ctx.db.insert('memories', {
    worldId, playerId: 'p:0', agentGlobalId, description: 'Private removed message', importance: 4, lastAccess: 1,
    data: { type: 'conversation', conversationId: 'c:private', playerIds: [] },
  }));
  const old = await t.action(action('federation/backup:exportTown'), { adminToken });
  await t.run(async ctx => {
    await ctx.db.delete(memoryId);
    await ctx.db.insert('travelPrivacyTombstones', {
      key: `memory:${memoryId}`, visitId: 'cleared', worldId, ownerGlobalId: agentGlobalId, playerId: 'p:0', createdAt: 2,
    });
    await ctx.db.insert('travelPrivacyTombstones', {
      key: `conversation:${worldId}:c:private`, visitId: 'cleared', worldId, playerIds: ['p:0'], createdAt: 2,
    });
  });
  const clean = await t.action(action('federation/backup:exportTown'), { adminToken });
  expect(clean.sections.travelPrivacyTombstones).toHaveLength(2);
  const dst = convexTest(schema, modules);
  const result = await dst.action(action('federation/backup:importBackup'), {
    adminToken, bundle: clean, mode: 'clone', targetEndpoint: 'https://privacy-clone.example/federation/v1',
  });
  const graves = await dst.run(ctx => ctx.db.query('travelPrivacyTombstones').collect());
  expect(graves.some(row => row.key === `conversation:${result.mapping[worldId]}:c:private`)).toBe(true);
  expect(graves.every(row => row.worldId === result.mapping[worldId])).toBe(true);
  const before = await dst.run(ctx => ctx.db.query('memories').collect());
  await expect(dst.action(action('federation/backup:importBackup'), {
    adminToken, bundle: old, mode: 'merge', targetWorldId: result.mapping[worldId],
  })).rejects.toThrow('BACKUP_PRIVACY_REDACTED');
  expect(await dst.run(ctx => ctx.db.query('memories').collect())).toEqual(before);
});

test('ordinary clone historical travel clears through the formal privacy entry without creating an executable ledger', async () => {
  const source = await town();
  await source.t.run(ctx => ctx.db.insert('visitLedger', {
    visitId: 'visit-1', worldId: source.worldId, agentGlobalId: source.agentGlobalId,
    homeTownId: 'town:original', hostTownId: 'town:foreign', homeDeploymentEpoch: 4,
    hostDeploymentEpoch: 2, agentAuthorityEpoch: 3, visitLeaseVersion: 1,
    leaseExpiry: Date.now() - 120000, fencingToken: 'source-fence', state: 'COMPLETED',
    role: 'home', homePlayerId: 'p:0', profile: {}, createdAt: 1, updatedAt: 1,
  }));
  const bundle = await source.t.action(action('federation/backup:exportTown'), { adminToken });
  const target = convexTest(schema, modules);
  const result = await target.action(action('federation/backup:importBackup'), {
    adminToken, bundle, mode: 'clone', targetEndpoint: 'https://history-clone.example/federation/v1',
  });
  // Embedding provider probes have separate integration coverage. Pause the
  // import's scheduled vector work before exercising the actual privacy worker.
  await target.run(async ctx => {
    for (const job of await ctx.db.system.query('_scheduled_functions').collect())
      await ctx.scheduler.cancel(job._id);
  });
  expect(await target.run(ctx => ctx.db.query('visitLedger').collect())).toEqual([]);
  await target.run(async ctx => {
    for (let i = 0; i < 12; i++) await ctx.db.insert('backupImports', {
      sourceTownId: 'unrelated-config-import', mode: 'merge', exportedAt: 1, importedAt: 2,
      mapping: {}, manifest: {}, runtimeSnapshot: {},
    });
  });
  let cursor: string | null = null, done = false, pages = 0;
  const choices: unknown[] = [];
  while (!done) {
    const candidates: { page: unknown[]; isDone: boolean; continueCursor: string } = await target.query(makeFunctionReference<'query'>('federation/travelPrivacy:historicalCandidates'), {
      adminToken, visitId: 'visit-1', paginationOpts: { cursor, numItems: 100 },
    });
    expect(candidates.page.length).toBeLessThanOrEqual(5);
    choices.push(...candidates.page);
    cursor = candidates.continueCursor; done = candidates.isDone;
    if (++pages > 5) throw new Error('historical candidate cursor did not advance');
  }
  expect(pages).toBeGreaterThan(1);
  expect(choices).toEqual([expect.objectContaining({ residentName: 'Ada',
    history: { importId: result.importId, worldId: result.mapping[source.worldId], ownerGlobalId: result.mapping[source.agentGlobalId] } })]);
  const jobId: Id<'travelPrivacyJobs'> = await target.mutation(makeFunctionReference<'mutation'>('federation/travelPrivacy:inspect'), {
    adminToken, visitId: 'visit-1', scope: 'SENSITIVE', history: {
      importId: result.importId, worldId: result.mapping[source.worldId],
      ownerGlobalId: result.mapping[source.agentGlobalId],
    },
  });
  await target.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect((await target.run(ctx => ctx.db.get(jobId)))!.state).toBe('READY');
  await target.mutation(makeFunctionReference<'mutation'>('federation/travelPrivacy:start'), { adminToken, jobId });
  await target.finishAllScheduledFunctions(() => jest.runAllTimers());
  await target.run(async ctx => {
    expect((await ctx.db.get(jobId))!.state).toBe('COMPLETE');
    expect(await ctx.db.get(result.mapping[source.memoryId] as Id<'memories'>)).toBeNull();
    expect(await ctx.db.query('visitLedger').collect()).toEqual([]);
    expect(await ctx.db.query('federationAgentRuntimes').first()).toMatchObject({ state: 'HOME_ACTIVE' });
    const snapshot = (await ctx.db.get(result.importId as Id<'backupImports'>))!.runtimeSnapshot;
    expect(snapshot.visitLedger.map(decodeRow)[0]).toMatchObject({ state: 'COMPLETED', visitId: 'visit-1' });
  });
});
test('resident export carries only its deletion history including shared conversation participants', async () => {
  const { t, worldId, agentGlobalId } = await town();
  await t.run(async ctx => {
    for (const [key, owner] of [
      ['memory:removed-owned', { ownerGlobalId: agentGlobalId, playerId: 'p:0' }],
      [`conversation:${worldId}:c:removed`, { playerIds: ['p:0', 'p:7'] }],
      ['memory:removed-other', { ownerGlobalId: 'unrelated', playerId: 'p:9' }],
    ] as Array<[string, { ownerGlobalId?: string; playerId?: string; playerIds?: string[] }]>)
      await ctx.db.insert('travelPrivacyTombstones', { key, ...owner, worldId, visitId: key, createdAt: 2 });
  });
  const bundle: BackupBundle = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  expect(bundle.sections.travelPrivacyTombstones.map(decodeRow).map(row => row.key).sort())
    .toEqual([`conversation:${worldId}:c:removed`, 'memory:removed-owned'].sort());
  await t.action(action('federation/backup:importBackup'), await residentRestoreArgs(t, bundle, worldId));
  expect(await t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toHaveLength(3);
});

test('full restore keeps local deletion evidence absent from the archive exportable in the replacement world', async () => {
  const { t, worldId, agentGlobalId } = await town();
  const older = await t.action(action('federation/backup:exportTown'), { adminToken });
  await t.run(ctx => ctx.db.insert('travelPrivacyTombstones', {
    key: 'memory:later-removed', visitId: 'later-visit', createdAt: 3, worldId, playerId: 'p:0', ownerGlobalId: agentGlobalId,
  }));
  const result = await t.action(action('federation/backup:importBackup'), { adminToken, bundle: older, mode: 'restore', sourceStopped: true });
  const grave = await t.run(ctx => ctx.db.query('travelPrivacyTombstones').first());
  expect(grave).toMatchObject({ key: 'memory:later-removed', worldId: result.mapping[worldId], createdAt: 3 });
  const resident = await t.action(action('federation/backup:exportResident'), {
    adminToken, worldId: result.mapping[worldId], playerId: 'p:0',
  });
  expect(resident.sections.travelPrivacyTombstones.map(decodeRow).map((row: any) => row.key)).toContain('memory:later-removed');
});
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

test.each(['current', 'changed source', 'legacy digest'])('memory provenance small-town clone retains %s evidence and fences interrupted compression', async variant => {
  const source = await town();
  await source.t.run(ctx => seedMemoryBackupEvidence(ctx, source.memoryId));
  if (variant === 'changed source') await source.t.run(ctx => ctx.db.patch(source.memoryId, { description: 'Corrected retained original' }));
  if (variant === 'legacy digest') await source.t.run(ctx => useLegacyMemoryBackupDigests(ctx));
  const bundle = await source.t.action(action('federation/backup:exportTown'), { adminToken });
  const target = convexTest(schema, modules);
  // The registered import now allocates a privacy source revision when it
  // writes the resident binding. That supplies the one-row offset required
  // for this deliberate ID collision; no additional padding is needed.
  await target.action(action('federation/backup:importBackup'), { adminToken, bundle, mode: 'clone', targetEndpoint: 'https://memory-copy.example' });
  const copied = await target.run(ctx => assertMemoryBackupEvidence(ctx, true, variant !== 'changed source'));
  const sourceReflection = bundle.sections.memories.map(decodeRow).find((row: Record<string, unknown>) => row.description === 'Ava is a friend.')!;
  // Convex-test assigns the target observation the ID of this different source
  // reflection: this collision catches accidental second remapping.
  expect(copied.memory._id).toBe(sourceReflection._id);
  expect(copied.memory._id).not.toBe(source.memoryId);
  expect(copied.memory.agentGlobalId).not.toBe(source.agentGlobalId);
  expect(copied.memory.description).toBe(variant === 'changed source' ? 'Corrected retained original' : 'I met Ava abroad.');
});

test('memory provenance resident restore is repeatable and releases target in-flight claims', async () => {
  const f = await town();
  await f.t.run(ctx => seedMemoryBackupEvidence(ctx, f.memoryId));
  const bundle = await f.t.action(action('federation/backup:exportResident'), { adminToken, worldId: f.worldId, playerId: 'p:0' });
  await f.t.action(action('federation/backup:importBackup'), await residentRestoreArgs(f.t, bundle, f.worldId));
  const first = await f.t.run(ctx => assertMemoryBackupEvidence(ctx));
  await f.t.action(action('federation/backup:importBackup'), await residentRestoreArgs(f.t, bundle, f.worldId));
  const second = await f.t.run(ctx => assertMemoryBackupEvidence(ctx));
  expect(second).toEqual(first);
});

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
  const sourceMemories = await t.run(ctx => ctx.db.query('memories').collect());
  expect(await t.run(ctx => ctx.db.query('modelMemoryVectors').collect())).not.toHaveLength(0);
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  expect(bundle.sections.modelMemoryVectors).toEqual([]);
  expect(bundle.sections.memories.map(decodeRow).map((row: { description: string }) => row.description)).toEqual(sourceMemories.map(row => row.description));
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
  const sourceRecoveryAt = Date.now() + 86400000;
  await t.run(async ctx => {
    const engine = (await ctx.db.query('engines').unique())!;
    await ctx.db.patch(engine._id, { processedInputNumber: 37, lastRecoveryAt: sourceRecoveryAt });
    await ctx.db.insert('inputs', { engineId: engine._id, number: 37, name: 'join', args: {}, received: 1, returnValue: { kind: 'ok', value: 'source-only-input' } });
  });
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  expect(decodeRow(bundle.sections.engines[0]).processedInputNumber).toBe(37);
  expect(decodeRow(bundle.sections.engines[0]).lastRecoveryAt).toBe(sourceRecoveryAt);
  await t.action(action('federation/backup:importBackup'), { adminToken, bundle, mode: 'restore', sourceStopped: true });
  const { engine, worldId, inputId } = await t.run(async ctx => {
    const engine = (await ctx.db.query('engines').unique())!;
    const status = (await ctx.db.query('worldStatus').unique())!;
    const audit = (await ctx.db.query('backupImports').unique())!;
    expect(engine.processedInputNumber).toBeUndefined();
    expect(engine.lastRecoveryAt).toBeUndefined();
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

test('model policies survive town restore while call receipts and usage buckets stay outside portable archives', async () => {
  const { t, worldId } = await town();
  const providerKey = await t.run(async ctx => {
    const chat = (await ctx.db.query('chatProfiles').unique())!;
    const embedding = (await ctx.db.query('embeddingProfiles').unique())!;
    const binding = (await ctx.db.query('residentModelBindings').unique())!;
    await ctx.db.patch(chat._id, { dailyRequestLimit: 12 });
    await ctx.db.patch(embedding._id, { dailyRequestLimit: 8 });
    await ctx.db.patch(binding._id, { requestQuotas: { chat: 3, embedding: null } });
    await ctx.db.insert('chatProfiles', { ...Object.fromEntries(Object.entries(chat).filter(([k]) => !k.startsWith('_'))),
      name: 'Paused unused profile', disabled: true, dailyRequestLimit: 0 } as never);
    const providerKey = providerUsageKey(chat);
    await ctx.db.insert('modelProviderQuotas', { kind: 'CHAT', providerKey, maxRequestsPerDay: 20, updatedAt: 1 });
    await ctx.db.insert('modelCallReceipts', { kind: 'CHAT', profileId: chat._id, providerKey, day: 0, startedAt: 1 });
    await ctx.db.insert('modelUsageBuckets', { kind: 'CHAT', dimension: 'PROVIDER', key: providerKey, day: 0,
      started: 1, succeeded: 0, failed: 0, denied: 0, reportedTokenCalls: 0, unknownTokenCalls: 0, totalTokens: 0, retries: 0 });
    return providerKey;
  });
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  expect(bundle.sections.modelCallReceipts).toBeUndefined();
  expect(bundle.sections.modelUsageBuckets).toBeUndefined();
  expect(decodeRow(bundle.sections.modelProviderQuotas[0])).toMatchObject({ providerKey, maxRequestsPerDay: 20 });
  const resident = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  expect(resident.sections.modelProviderQuotas?.length ?? 0).toBe(0);
  expect(decodeRow(resident.sections.residentModelBindings[0]).requestQuotas).toEqual({ chat: 3, embedding: null });
  await t.run(async ctx => {
    const quota = (await ctx.db.query('modelProviderQuotas').unique())!;
    await ctx.db.patch(quota._id, { maxRequestsPerDay: null });
  });
  await t.action(action('federation/backup:importBackup'), { adminToken, bundle, mode: 'restore', sourceStopped: true });
  expect(await t.run(ctx => ctx.db.query('modelProviderQuotas').unique())).toMatchObject({ providerKey, maxRequestsPerDay: 20 });
  expect((await t.run(ctx => ctx.db.query('residentModelBindings').unique()))?.requestQuotas).toEqual({ chat: 3, embedding: null });
  expect((await t.run(ctx => ctx.db.query('embeddingProfiles').unique()))?.dailyRequestLimit).toBe(8);
  expect(await t.run(ctx => ctx.db.query('chatProfiles').collect())).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Fixed Chat', dailyRequestLimit: 12 }),
    expect.objectContaining({ name: 'Paused unused profile', disabled: true, dailyRequestLimit: 0 }),
  ]));
});

test.each(['chatProfiles', 'embeddingProfiles', 'residentModelBindings', 'modelProviderQuotas'])(
  'invalid %s request quotas fail before restoring any live data', async section => {
    const { t } = await town();
    if (section === 'modelProviderQuotas') await t.run(ctx => ctx.db.insert('modelProviderQuotas', {
      kind: 'CHAT', providerKey: '["custom","https://chat.example"]', maxRequestsPerDay: 5, updatedAt: 1,
    }));
    const original = await t.action(action('federation/backup:exportTown'), { adminToken });
    const invalid = await rewrite(original, section, row => {
      if (section === 'residentModelBindings') row.requestQuotas = { chat: -1, embedding: null };
      else if (section === 'modelProviderQuotas') row.maxRequestsPerDay = 1.5;
      else row.dailyRequestLimit = -1;
    });
    const before = await t.run(ctx => ctx.db.query('worlds').collect());
    await expect(t.action(action('federation/backup:importBackup'), { adminToken, bundle: invalid, mode: 'restore', sourceStopped: true }))
      .rejects.toThrow('INVALID_MODEL_REQUEST_QUOTA');
    expect(await t.run(ctx => ctx.db.query('worlds').collect())).toEqual(before);
  },
);

test('restore atomically remaps core data while preserving identities, profiles, maps, conversations and reflection pointers', async () => {
  const { t, agentGlobalId, worldId } = await town();
  await t.run(async ctx => {
    await ctx.db.insert('federationTravelAudit', { visitId: 'historical', source: 'visitLedger', operation: 'UPDATED', at: 7, next: { state: 'COMPLETED' } });
    await ctx.db.insert('federationOutbox', { messageId: 'historical-message', toTownId: 'host', envelope: { visitId: 'historical', type: 'VISIT_CLEANED' }, attempts: 1, nextRetryAt: 7, ackedAt: 7 });
  });
  const bundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  expect(bundle.sections.federationTravelAudit.map(decodeRow)).toEqual([expect.objectContaining({ at: 7, visitId: 'historical', operation: 'UPDATED' })]);
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
    travelAudit: await ctx.db.query('federationTravelAudit').collect(),
  }));
  expect(snapshot.travelAudit).toEqual([expect.objectContaining({ at: 7, visitId: 'historical', operation: 'UPDATED', next: { state: 'COMPLETED' } })]);
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
  await source.t.run(async ctx => {
    const local = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(local._id, { endpointCandidates: [{ url: local.endpoint, priority: 10 }, { url: 'https://source-backup.example/federation/v1', priority: 20 }], endpointGeneration: 4, endpointSequence: 4 });
  });
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
  expect(copied.identity?.endpointCandidates).toEqual([{ url: 'https://clone.example/federation/v1', priority: 10 }]);
  expect(copied.identity?.endpointGeneration).toBe(0);
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
      leaseExpiry: stoppedAt - 10000, leaseSafetyMs: 180000,
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
    safeAfter: pendingLease + 180000,
    canResume: false,
    reason: 'OLD_HOST_LEASE_STILL_VALID',
  });
  const reconcile = makeFunctionReference<'mutation'>(
    'federation/backup:reconcileRestoredResident',
  );
  await expect(
    t.mutation(reconcile, { adminToken, agentGlobalId, sourceStopped: false }),
  ).rejects.toThrow('RESTORE_SOURCE_STOP_REQUIRED');
  jest.setSystemTime(pendingLease + 179999);
  await expect(
    t.mutation(reconcile, { adminToken, agentGlobalId, sourceStopped: true }),
  ).rejects.toThrow('OLD_HOST_LEASE_STILL_VALID');
  expect(
    (await t.query((ctx) => ctx.db.get(result.mapping[worldId] as Id<'worlds'>)))?.players,
  ).toHaveLength(0);
  jest.setSystemTime(pendingLease + 180000);
  await expect(t.mutation(reconcile, { adminToken, agentGlobalId, sourceStopped: true })).rejects.toThrow('CLOCK_UNCERTAIN');
  await t.mutation(makeFunctionReference<'mutation'>('federation/admin:confirmClockRecovery'), { adminToken, synchronizedUtcConfirmed: true });
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
  const coldOwner = await t.run(async ctx => {
    const transcript = (await ctx.db.query('homeTravelTranscripts').unique())!;
    await ctx.db.patch(transcript._id,{summaryState:'DONE'});
    const page = (await ctx.db.query('homeTravelTranscriptPages').unique())!;
    return {adminToken,worldId,playerId:'p:0' as const,agentGlobalId,memoryId:page.memoryIds[0]};
  });
  await t.action(action('federation/coldHistory:archive'),coldOwner);
  const bundle: BackupBundle = await t.action(action('federation/backup:exportTown'), { adminToken });
  expect(bundle.coldHistoryFiles).toHaveLength(1);
  const originalFile = bundle.coldHistoryFiles![0].file;
  const restored = await t.action(action('federation/backup:importBackup'), { adminToken, bundle, mode: 'restore', sourceStopped: true });
  expect(restored.coldFilesRestored).toBe(1);
  expect(await t.action(action('federation/coldHistoryFiles:exportFile'),{...coldOwner,worldId:restored.mapping[worldId],memoryId:restored.mapping[coldOwner.memoryId]})).toEqual(originalFile);
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
  for (const name of ['federationResourcePolicy', 'federationResourceAudit', 'federationTravelAudit']) {
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

async function nativeColdOwner(t: Awaited<ReturnType<typeof town>>['t'], worldId: Id<'worlds'>) {
  return t.run(async ctx => {
    const binding = await ctx.db.query('residentModelBindings').first();
    const memoryId = await ctx.db.insert('memories', {worldId,playerId:'p:0',agentGlobalId:binding!.agentGlobalId,
      description:'Closed original conversation',importance:6,lastAccess:1,data:{type:'conversation',conversationId:'c:2',playerIds:['p:7']}});
    return {adminToken,worldId,playerId:'p:0' as const,agentGlobalId:binding!.agentGlobalId,memoryId};
  });
}
test('small signed town backup automatically packs real cold objects and clones them into an independent database without opaque storage IDs', async () => {
  const src = await town(), owner = await nativeColdOwner(src.t,src.worldId);
  await src.t.action(action('federation/coldHistory:archive'),owner);
  const bundle: BackupBundle = await src.t.action(action('federation/backup:exportTown'),{adminToken});
  expect(bundle.coldHistoryFiles).toHaveLength(1);
  expect(JSON.stringify(bundle.coldHistoryFiles)).not.toContain('storageId');
  const originalFile = bundle.coldHistoryFiles![0].file;
  const dst = convexTest(schema,modules);
  const result = await dst.action(action('federation/backup:importBackup'),{adminToken,bundleJson:JSON.stringify(bundle),mode:'clone',targetEndpoint:'https://cloned.example/federation/v1'});
  expect(result.coldFilesRestored).toBe(1);
  const mappedOwner = {...owner,worldId:result.mapping[owner.worldId],memoryId:result.mapping[owner.memoryId],agentGlobalId:result.mapping[owner.agentGlobalId!]};
  const recovered = await dst.action(action('federation/coldHistoryFiles:exportFile'),mappedOwner);
  expect(recovered).toEqual(originalFile);
  const cold = await dst.run(ctx => ctx.db.query('coldHistoryArchives').first());
  expect(cold!.worldId).toBe(mappedOwner.worldId);
  expect(cold!.sourceKey).toBe(originalFile.manifest.sourceKey);
  expect(cold!.lookupKey).not.toBe(cold!.sourceKey);
  const audit = await src.t.run(ctx => ctx.db.query('backupExportAudits').order('desc').first());
  expect(audit!.sectionCounts.coldHistoryFiles).toBe(1);
});
test('resident merge restores signed native files with composed author mappings and leaves source proof intact', async () => {
  const src = await town(), owner = await nativeColdOwner(src.t,src.worldId);
  await src.t.action(action('federation/coldHistory:archive'),owner);
  await src.t.run(async ctx => { for (const row of await ctx.db.query('participatedTogether').collect()) await ctx.db.delete(row._id); });
  const bundle: BackupBundle = await src.t.action(action('federation/backup:exportResident'),{adminToken,worldId:owner.worldId,playerId:owner.playerId});
  expect(bundle.sections.participatedTogether).toHaveLength(0);
  expect(bundle.sections.archivedConversations).toHaveLength(1);
  const dst = await town();
  const result = await dst.t.action(action('federation/backup:importBackup'),{adminToken,bundle,mode:'merge',targetWorldId:dst.worldId});
  const binding = await dst.t.run(ctx => ctx.db.get(result.mapping[decodeRow(bundle.sections.residentModelBindings[0])._id] as Id<'residentModelBindings'>));
  const mappedOwner = {...owner,worldId:dst.worldId,memoryId:result.mapping[owner.memoryId],playerId:binding!.playerId,agentGlobalId:binding!.agentGlobalId};
  expect(await dst.t.action(action('federation/coldHistoryFiles:exportFile'),mappedOwner)).toEqual(bundle.coldHistoryFiles![0].file);
  const read = await dst.t.action(action('federation/coldHistory:read'),{...mappedOwner,offset:0,numItems:25});
  expect(read.page[0].targetAuthor).toBe(binding!.playerId);
});
test('attachment tampering, unsigned endorsement and missing prepared objects cannot mutate a target', async () => {
  const src = await town(), owner = await nativeColdOwner(src.t,src.worldId);
  await src.t.action(action('federation/coldHistory:archive'),owner);
  const bundle: BackupBundle = await src.t.action(action('federation/backup:exportResident'),{adminToken,worldId:owner.worldId,playerId:owner.playerId});
  const unsigned = structuredClone(bundle); delete unsigned.signature;
  await expect(validateBundle(unsigned)).rejects.toThrow('BACKUP_COLD_FILES_CHECKSUM_MISMATCH');
  const tampered = structuredClone(bundle); tampered.coldHistoryFiles![0].file.payload.messages[0].text = 'tampered';
  await expect(validateBundle(tampered)).rejects.toThrow('BACKUP_COLD_FILES_CHECKSUM_MISMATCH');
  const dst = await town(), before = await dst.t.run(ctx => ctx.db.query('worlds').collect());
  const mutation = makeFunctionReference<'mutation'>('federation/backup:applyImport');
  await expect(dst.t.mutation(mutation,{adminToken,bundle,mode:'merge',targetWorldId:dst.worldId})).rejects.toThrow('BACKUP_COLD_FILES_STORAGE_REQUIRED');
  expect(await dst.t.run(ctx => ctx.db.query('worlds').collect())).toEqual(before);
  expect(await dst.t.run(ctx => ctx.db.query('coldHistoryArchives').collect())).toHaveLength(0);
});

test('same Home resident restore republishes a missing cold archive atomically and remains idempotent', async () => {
  const src = await town(), owner = await nativeColdOwner(src.t,src.worldId);
  await src.t.action(action('federation/coldHistory:archive'),owner);
  const bundle: BackupBundle = await src.t.action(action('federation/backup:exportResident'),{adminToken,worldId:owner.worldId,playerId:owner.playerId});
  await src.t.run(async ctx => { for (const row of await ctx.db.query('coldHistoryArchives').collect()) await ctx.db.delete(row._id); });
  const args = await residentRestoreArgs(src.t,bundle,owner.worldId);
  expect((await src.t.action(action('federation/backup:importBackup'),args)).coldFilesRestored).toBe(1);
  const file = await src.t.action(action('federation/coldHistoryFiles:exportFile'),owner);
  expect(file).toEqual(bundle.coldHistoryFiles![0].file);
  const before = await src.t.run(ctx => ctx.db.query('coldHistoryArchives').collect());
  await src.t.action(action('federation/backup:importBackup'),await residentRestoreArgs(src.t,bundle,owner.worldId));
  expect(await src.t.run(ctx => ctx.db.query('coldHistoryArchives').collect())).toEqual(before);
});

test('a publication acknowledgement failure preserves the uploaded cold object even before any later reference read', async () => {
  const src = await town(), owner = await nativeColdOwner(src.t,src.worldId);
  await src.t.action(action('federation/coldHistory:archive'),owner);
  const bundle: BackupBundle = await src.t.action(action('federation/backup:exportResident'),{adminToken,worldId:owner.worldId,playerId:owner.playerId});
  const archive = await src.t.run(ctx => ctx.db.query('coldHistoryArchives').first());
  const file = bundle.coldHistoryFiles![0].file;
  let deletes = 0, queries = 0;
  const handler = (importBackup as unknown as {_handler:(ctx:ActionCtx,args:any)=>Promise<unknown>})._handler;
  const ctx = {
    runQuery:async () => { queries++; return queries === 1 ? {} : false; },
    runMutation:async () => { throw new Error('PUBLICATION_ACKNOWLEDGEMENT_LOST'); },
    storage:{store:async()=>archive!.storageId!,get:async()=>new Blob([JSON.stringify(file.payload)]),delete:async()=>{deletes++;}},
  } as unknown as ActionCtx;
  await expect(handler(ctx,{adminToken,bundle,mode:'merge',targetWorldId:src.worldId})).rejects.toThrow('PUBLICATION_ACKNOWLEDGEMENT_LOST');
  expect(queries).toBe(1);
  expect(deletes).toBe(0);
});

test.each(['cold-upload', 'cold-verification', 'publication-unknown'] as const)(
  'ordinary vector archive cleanup respects the %s publication boundary', async failure => {
    const src = await town(), owner = await nativeColdOwner(src.t, src.worldId);
    await src.t.action(action('federation/coldHistory:archive'), owner);
    const bundle: BackupBundle = await src.t.action(action('federation/backup:exportResident'), {
      adminToken, worldId: owner.worldId, playerId: owner.playerId, includeVectors: true,
    });
    const vector = (await src.t.run(ctx => ctx.db.query('modelMemoryVectors').first()))!;
    bundle.sections.modelMemoryVectors = [encodeRow(vector)];
    const rows = bundle.sections.modelMemoryVectors;
    bundle.manifest.sections.modelMemoryVectors = {
      digest: await digest(rows), count: rows.length,
      bytes: new TextEncoder().encode(JSON.stringify(rows)).length,
    };
    const identity = (await src.t.run(ctx => ctx.db.query('federationIdentity').unique()))!;
    bundle.signature = await sign(bundle.manifest, identity.privateKeyEncrypted);
    await expect(validateBundle(bundle)).resolves.toBeDefined();
    const objects = new Map<string, Blob>();
    const deleted: string[] = [];
    let stores = 0, queries = 0, publications = 0;
    const handler = (importBackup as unknown as {
      _handler: (ctx: ActionCtx, args: any) => Promise<unknown>;
    })._handler;
    const ctx = {
      runQuery: async () => { queries++; return queries === 1 ? {} : false; },
      runMutation: async (ref: any) => {
        const name = getFunctionName(ref);
        if (name.endsWith(':reserveOrdinaryUpload')) return { operationId: 'operation', revision: 2,
          state: 'UPLOADING', contentType: 'application/vnd.ai-town.archive-upload+json; operation=test', uploadNeeded: true };
        if (name.endsWith(':confirmOrdinaryUpload')) return;
        if (name.endsWith(':retireOrdinaryUpload')) return { operationId: 'operation', revision: 3, candidateId: 'candidate' };
        if (name.endsWith(':eraseOrdinaryUpload')) throw new Error('BACKUP_UPLOAD_REFERENCE_COVERAGE_UNKNOWN');
        publications++; throw new Error('PUBLICATION_ACKNOWLEDGEMENT_LOST');
      },
      storage: {
        store: async (blob: Blob) => {
          if (++stores === 2 && failure === 'cold-upload') throw new Error('COLD_UPLOAD_FAILED');
          const id = `test-storage-${stores}`;
          objects.set(id, blob);
          return id;
        },
        get: async (id: string) => failure === 'cold-verification' ? null : objects.get(id),
        delete: async (id: string) => { deleted.push(id); objects.delete(id); },
      },
    } as unknown as ActionCtx;
    await expect(handler(ctx, { adminToken, bundle, mode: 'merge', targetWorldId: src.worldId }))
      .rejects.toThrow(failure === 'cold-upload' ? 'COLD_UPLOAD_FAILED'
        : failure === 'cold-verification' ? 'BACKUP_COLD_FILES_STORAGE_INVALID'
          : 'PUBLICATION_ACKNOWLEDGEMENT_LOST');
    if (failure === 'publication-unknown') {
      expect(publications).toBe(1);
      expect(queries).toBe(1);
      expect(deleted).toEqual([]);
      expect(objects.size).toBe(2);
      expect(JSON.parse(await objects.get('test-storage-1')!.text())).toEqual(bundle);
    } else {
      expect(publications).toBe(0);
      expect(deleted).not.toContain('test-storage-1');
      expect(objects.size).toBe(1);
    }
  },
);


test.each(['restore', 'clone'] as const)('small %s retains resident denial policy with exact identity mapping and private audit', async mode => {
  const { t, worldId, agentGlobalId } = await town();
  await t.run(async ctx => {
    for (const globalId of [agentGlobalId, 'town:foreign/agent:visitor'])
      await ctx.db.insert('federationResidentPolicy', { agentGlobalId: globalId, createdAt: 1, updatedAt: 2 });
    await ctx.db.insert('federationResidentPolicyAudit', { agentGlobalId, operation: 'DENY', previousDenied: false,
      denied: true, operator: 'Host reviewer', authenticatedBy: 'FEDERATION_ADMIN_TOKEN', reason: 'Private policy note', createdAt: 1 });
  });
  const full = await t.action(action('federation/backup:exportTown'), { adminToken });
  expect(full.sections.federationResidentPolicy).toHaveLength(2);
  expect(full.sections.federationResidentPolicyAudit).toHaveLength(1);
  const resident = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  expect(resident.sections.federationResidentPolicy).toEqual([]);
  expect(resident.sections.federationResidentPolicyAudit).toEqual([]);
  const target = mode === 'clone' ? convexTest(schema, modules) : t;
  const result = await target.action(action('federation/backup:importBackup'), { adminToken, bundle: full, mode,
    sourceStopped: true, ...(mode === 'clone' ? { targetEndpoint: 'https://copy.example/federation/v1' } : {}) });
  const policies = await target.run(ctx => ctx.db.query('federationResidentPolicy').collect());
  const expectedGlobalId = mode === 'clone' ? result.mapping[agentGlobalId] : agentGlobalId;
  expect(policies.map(row => row.agentGlobalId).sort()).toEqual([expectedGlobalId, 'town:foreign/agent:visitor'].sort());
  if (mode === 'clone') expect(policies.some(row => row.agentGlobalId === agentGlobalId)).toBe(false);
  const audit = await target.run(ctx => ctx.db.query('federationResidentPolicyAudit').unique());
  expect(audit).toMatchObject({ agentGlobalId: expectedGlobalId, operator: 'Host reviewer', reason: 'Private policy note' });
});

test('older small archives may omit resident policy sections and duplicate identities fail preflight', async () => {
  const { t } = await town();
  const full = await t.action(action('federation/backup:exportTown'), { adminToken });
  const legacy = structuredClone(full);
  delete legacy.signature;
  for (const name of ['federationResidentPolicy', 'federationResidentPolicyAudit']) {
    delete legacy.sections[name]; delete legacy.manifest.sections[name];
  }
  expect(await validateBundle(legacy)).toBeDefined();
  const bad = structuredClone(full);
  delete bad.signature;
  bad.sections.federationResidentPolicy = ['one', 'two'].map(id => encodeRow({ _id: id, _creationTime: 1,
    agentGlobalId: 'town:foreign/agent:visitor', createdAt: 1, updatedAt: 1 }));
  const rows = bad.sections.federationResidentPolicy;
  bad.manifest.sections.federationResidentPolicy = { digest: await digest(rows), count: rows.length,
    bytes: new TextEncoder().encode(JSON.stringify(rows)).length };
  await expect(validateBundle(bad)).rejects.toThrow('BACKUP_DUPLICATE_RESIDENT_POLICY');
});

test.each(['restore', 'clone'] as const)('small %s preserves Home resident disclosure restrictions and audit', async mode => {
  const { t, worldId, agentGlobalId } = await town();
  const restricted = { level: 'WHITELIST' as const, allowedTownIds: ['town:approved'] };
  await t.run(async ctx => {
    await ctx.db.insert('federationDisclosurePolicy', { agentGlobalId, ...restricted, updatedAt: 2 });
    await ctx.db.insert('federationDisclosureAudit', { agentGlobalId, previous: { level: 'PUBLIC', allowedTownIds: [] },
      next: restricted, operator: 'Home reviewer', reason: 'Resident public persona restriction', createdAt: 2 });
  });
  const full = await t.action(action('federation/backup:exportTown'), { adminToken });
  const resident = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  expect(full.sections.federationDisclosurePolicy).toHaveLength(1);
  expect(resident.sections.federationDisclosurePolicy.map(decodeRow)).toEqual(full.sections.federationDisclosurePolicy.map(decodeRow));
  expect(resident.sections.federationDisclosureAudit).toHaveLength(1);
  const target = mode === 'clone' ? convexTest(schema, modules) : t;
  const result = await target.action(action('federation/backup:importBackup'), { adminToken, bundle: full, mode,
    sourceStopped: true, ...(mode === 'clone' ? { targetEndpoint: 'https://copy.example/federation/v1' } : {}) });
  const expectedGlobalId = mode === 'clone' ? result.mapping[agentGlobalId] : agentGlobalId;
  expect(await target.run(ctx => ctx.db.query('federationDisclosurePolicy').unique())).toMatchObject({ agentGlobalId: expectedGlobalId, ...restricted });
  expect(await target.run(ctx => ctx.db.query('federationDisclosureAudit').unique())).toMatchObject({ agentGlobalId: expectedGlobalId, next: restricted });
});

test('resident restore reinstates its disclosure restriction without replaying duplicate audits', async () => {
  const { t, worldId, agentGlobalId } = await town();
  await t.run(async ctx => {
    await ctx.db.insert('federationDisclosurePolicy', { agentGlobalId, level: 'WHITELIST', allowedTownIds: ['town:approved'], updatedAt: 2 });
    await ctx.db.insert('federationDisclosureAudit', { agentGlobalId, previous: { level: 'PUBLIC', allowedTownIds: [] },
      next: { level: 'WHITELIST', allowedTownIds: ['town:approved'] }, operator: 'Home reviewer', reason: 'Preserve privacy', createdAt: 2 });
  });
  const bundle: BackupBundle = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  await t.run(async ctx => {
    const policy = (await ctx.db.query('federationDisclosurePolicy').unique())!;
    await ctx.db.patch(policy._id, { level: 'PUBLIC', allowedTownIds: [], updatedAt: 3 });
  });
  for (let attempt = 0; attempt < 2; attempt++)
    await t.action(action('federation/backup:importBackup'), await residentRestoreArgs(t, bundle, worldId));
  expect(await t.run(ctx => ctx.db.query('federationDisclosurePolicy').unique())).toMatchObject({ agentGlobalId, level: 'WHITELIST', allowedTownIds: ['town:approved'] });
  expect(await t.run(ctx => ctx.db.query('federationDisclosureAudit').collect())).toHaveLength(1);
});


test('signed small packages cannot import more resident restrictions than the management list bound', async () => {
  const { t } = await town();
  const archive = await t.action(action('federation/backup:exportTown'), { adminToken });
  archive.sections.federationResidentPolicy = Array.from({ length: 1001 }, (_, index) => encodeRow({
    _id: `denial-${index}`, _creationTime: 1, agentGlobalId: `town:foreign/agent:${index}`, createdAt: 1, updatedAt: 1,
  }));
  const rows = archive.sections.federationResidentPolicy;
  archive.manifest.sections.federationResidentPolicy = { digest: await digest(rows), count: rows.length,
    bytes: new TextEncoder().encode(JSON.stringify(rows)).length };
  const identity = (await t.run(ctx => ctx.db.query('federationIdentity').unique()))!;
  archive.signature = await sign(archive.manifest, identity.privateKeyEncrypted);
  // The stricter total-record cap protects small imports independently of the source API.
  await expect(t.action(action('federation/backup:preflight'), {
    adminToken, bundle: archive, mode: 'restore', sourceStopped: true,
  })).rejects.toThrow('BACKUP_ATOMIC_RECORD_LIMIT');
  expect(await t.run(ctx => ctx.db.query('federationResidentPolicy').collect())).toEqual([]);
  expect(await t.run(ctx => ctx.db.query('backupImports').collect())).toEqual([]);
});


test('vector snapshot export options do not leak extra fields into export audit validators', async () => {
  const { t, worldId } = await town();
  for (const scope of ['town', 'resident'] as const) {
    const bundle = await t.action(action(`federation/backup:export${scope === 'town' ? 'Town' : 'Resident'}`), {
      adminToken, includeVectors: true, operator: 'Snapshot administrator', reason: 'Verified vector snapshot',
      ...(scope === 'resident' ? { worldId, playerId: 'p:0' } : {}),
    }) as BackupBundle;
    expect(bundle.manifest.includeVectors).toBe(true);
  }
  const audits = await t.run(ctx => ctx.db.query('backupExportAudits').collect());
  expect(audits.map(row => row.scope).sort()).toEqual(['resident', 'town']);
  expect(audits.every(row => row.operator === 'Snapshot administrator' && row.reason === 'Verified vector snapshot')).toBe(true);
});

async function ordinaryVectorBundle(withCold = false) {
  const src = await town();
  if (withCold) {
    const owner = await nativeColdOwner(src.t, src.worldId);
    await src.t.action(action('federation/coldHistory:archive'), owner);
  }
  const bundle: BackupBundle = await src.t.action(action('federation/backup:exportTown'), { adminToken, includeVectors: true });
  const memory = decodeRow(bundle.sections.memories[0]);
  const profile = { provider: 'ollama' as const, url: 'http://fixture.example:11434', model: 'fixture:v1', dimensions: 2,
    preprocessingRevision: 'newline-to-space-v1', queryPrefix: 'Q: ', documentPrefix: 'D: ', normalization: 'none' };
  const certificate = { profileFingerprint: embeddingFingerprint(profile), artifactDigest: 'a'.repeat(64),
    metadataDigest: 'b'.repeat(64), serviceVersion: 'fixture-v1', providerId: 'fixture-provider', providerUrl: profile.url,
    pipelineFingerprint: pipelineFingerprint(profile, 'fixture-v1', 'b'.repeat(64)), state: 'REVOKED', checkedAt: 0,
    verifiedAt: 1, dimensions: 2, querySample: [1, 0], documentSample: [1, 0] };
  const generationEvidence = { version: 1, profile, certificate };
  const oldVector = (await src.t.run(ctx => ctx.db.query('modelMemoryVectors').first()))!;
  const vector = { ...oldVector, memoryId: memory._id, worldId: memory.worldId, playerId: memory.playerId,
    agentGlobalId: memory.agentGlobalId, sourceDigest: await memorySourceDigest(memory as never),
    generationEvidence, generationEvidenceId: await digest(generationEvidence) };
  bundle.sections.modelMemoryVectors = [encodeRow(vector)];
  bundle.manifest.sections.modelMemoryVectors = { digest: await digest(bundle.sections.modelMemoryVectors), count: 1,
    bytes: new TextEncoder().encode(JSON.stringify(bundle.sections.modelMemoryVectors)).length };
  const sourceIdentity = (await src.t.run(ctx => ctx.db.query('federationIdentity').unique()))!;
  bundle.signature = await sign(bundle.manifest, sourceIdentity.privateKeyEncrypted);
  await validateBundle(bundle);
  return { src, bundle };
}

type OrdinaryFault = 'upload-ack' | 'confirm-ack' | 'publish-ack' | 'publish-before-commit' | 'cold-upload' | 'late-rollback' | 'reserve-ack' | 'wrong-bytes';
function ordinaryImportHarness(t: ReturnType<typeof convexTest>, fault?: OrdinaryFault, afterConfirm?: () => Promise<void>) {
  let armed = !!fault, stores = 0;
  const storedIds: Id<'_storage'>[] = [];
  const handler = (importBackup as unknown as { _handler: (ctx: ActionCtx, args: any) => Promise<any> })._handler;
  return {
    storedIds, stores: () => stores,
    nextFault: (next: OrdinaryFault) => { fault = next; armed = true; },
    invoke: (args: Record<string, any>) => t.action(async ctx => {
      const proxy = { ...ctx,
        runMutation: async (ref: any, value: any) => {
          const name = getFunctionName(ref);
          if (armed && name.endsWith(':applyImport') && fault === 'publish-before-commit') {
            armed = false; throw new Error('PUBLICATION_RESPONSE_UNKNOWN');
          }
          if (armed && name.endsWith(':applyImport') && fault === 'late-rollback') {
            armed = false;
            return t.run(dbCtx => applyBackupData({ ...dbCtx, scheduler: { ...dbCtx.scheduler,
              runAfter: async () => { throw new Error('LATE_IMPORT_ROLLBACK'); } } }, value));
          }
          const result = await ctx.runMutation(ref, value);
          if (name.endsWith(':confirmOrdinaryUpload') && afterConfirm) { const hook = afterConfirm; afterConfirm = undefined; await hook(); }
          if (armed && ((name.endsWith(':reserveOrdinaryUpload') && fault === 'reserve-ack') ||
            (name.endsWith(':confirmOrdinaryUpload') && fault === 'confirm-ack') ||
            (name.endsWith(':applyImport') && fault === 'publish-ack'))) {
            armed = false; throw new Error('RESPONSE_ACK_LOST');
          }
          return result;
        },
        runAction: async (ref: any, value: any) => {
          if (getFunctionName(ref).endsWith(':recoverPage')) {
            const last = await t.run(dbCtx => dbCtx.db.system.query('_storage').order('desc').first());
            const now = jest.spyOn(Date, 'now').mockReturnValue(Math.max(Date.now(), Math.ceil(last?._creationTime ?? 0) + 1));
            try { return await ctx.runAction(ref, value); } finally { now.mockRestore(); }
          }
          return ctx.runAction(ref, value);
        },
        storage: { ...ctx.storage,
          store: async (blob: Blob) => {
            stores++;
            if (armed && fault === 'cold-upload' && stores === 2) { armed = false; throw new Error('COLD_UPLOAD_FAILED'); }
            const actual = armed && fault === 'wrong-bytes' ? new Blob(['wrong bytes'], { type: blob.type }) : blob;
            if (fault === 'wrong-bytes') armed = false;
            const id = await ctx.storage.store(actual);
            // convex-test omits Blob.type; retain its actual-byte hash and size and fill that metadata gap only.
            await t.run(dbCtx => dbCtx.db.patch(id as never, { contentType: blob.type } as never));
            storedIds.push(id);
            if (armed && fault === 'upload-ack') { armed = false; throw new Error('UPLOAD_ACK_LOST'); }
            return id;
          },
        },
      } as ActionCtx;
      return handler(proxy, args);
    }),
  };
}

test.each(['upload-ack', 'confirm-ack', 'publish-ack', 'publish-before-commit'] as const)(
  'ordinary import recovers %s with one exact candidate and one canonical publication', async fault => {
    const { bundle } = await ordinaryVectorBundle();
    const target = convexTest(schema, modules), harness = ordinaryImportHarness(target, fault);
    const args = { adminToken, bundleJson: JSON.stringify(bundle), mode: 'clone', targetEndpoint: 'https://ordinary-copy.example',
      uploadAttemptKey: `ordinary-${fault}` };
    await expect(harness.invoke(args)).rejects.toThrow(fault === 'upload-ack' ? 'UPLOAD_ACK_LOST'
      : fault === 'publish-before-commit' ? 'PUBLICATION_RESPONSE_UNKNOWN' : 'RESPONSE_ACK_LOST');
    const firstOperation = (await target.run(ctx => ctx.db.query('archiveUploadOperations').unique()))!;
    expect(firstOperation.producerKind).toBe('ORDINARY_BUNDLE');
    expect(await target.run(async ctx => !!await ctx.storage.get(harness.storedIds[0]))).toBe(true);
    if (fault === 'upload-ack') {
      expect(firstOperation.state).toBe('UPLOADING');
      expect(await target.run(ctx => ctx.db.query('archiveUploadCandidates').collect())).toHaveLength(0);
    }
    const result = await harness.invoke(args);
    expect(harness.stores()).toBe(1);
    const published = (await target.run(ctx => ctx.db.query('archiveUploadOperations').unique()))!;
    const imported = (await target.run(ctx => ctx.db.query('backupImports').unique()))!;
    expect(published.state).toBe('PUBLISHED');
    expect(published.publishedStorageId).toBe(harness.storedIds[0]);
    expect(imported.manifest.vectorArchiveStorageId).toBe(harness.storedIds[0]);
    expect(imported.manifest.vectorSourceTrusted).toBe(false);
    expect(result.importId).toBe(imported._id);
    expect(imported.runtimeSnapshot.archiveUploadResult).toEqual(result);
    // Existing vector/ordinary privacy readers strip exactly these two local pointer/trust fields.
    expect(await digest(Object.fromEntries(Object.entries(imported.manifest).filter(([key]) =>
      !['vectorSourceTrusted', 'vectorArchiveStorageId'].includes(key))))).toBe(await digest(bundle.manifest));
    const stored = await target.run(async ctx => await (await ctx.storage.get(harness.storedIds[0]))!.text());
    expect(stored).toBe(JSON.stringify(bundle));
    expect(await harness.invoke(args)).toEqual(result);
    expect(harness.stores()).toBe(1);
    expect(await target.run(ctx => ctx.db.query('backupImports').collect())).toHaveLength(1);
    expect(await target.run(ctx => ctx.db.query('archiveUploadCandidates').collect())).toHaveLength(1);
  },
);

test('ordinary publication rolls back candidate state with all import writes and retries the same verified bytes', async () => {
  const { bundle } = await ordinaryVectorBundle();
  const target = convexTest(schema, modules), harness = ordinaryImportHarness(target, 'late-rollback');
  const args = { adminToken, bundle, mode: 'clone', targetEndpoint: 'https://ordinary-rollback.example', uploadAttemptKey: 'rollback-attempt' };
  await expect(harness.invoke(args)).rejects.toThrow('LATE_IMPORT_ROLLBACK');
  expect(await target.run(ctx => ctx.db.query('backupImports').collect())).toHaveLength(0);
  expect(await target.run(ctx => ctx.db.query('worlds').collect())).toHaveLength(0);
  expect((await target.run(ctx => ctx.db.query('archiveUploadOperations').unique()))!.state).toBe('UPLOADED');
  expect((await target.run(ctx => ctx.db.query('archiveUploadCandidates').unique()))!.state).toBe('STORED');
  await harness.invoke(args);
  expect(harness.stores()).toBe(1);
  expect((await target.run(ctx => ctx.db.query('archiveUploadOperations').unique()))!.state).toBe('PUBLISHED');
});

test('ordinary preparation cleanup deletes only its exact retired candidate when reference absence is proven', async () => {
  const { bundle } = await ordinaryVectorBundle(true);
  const target = convexTest(schema, modules), harness = ordinaryImportHarness(target, 'cold-upload');
  const unrelated = await target.run(ctx => ctx.storage.store(new Blob(['unrelated'], { type: 'application/json' })));
  await expect(harness.invoke({ adminToken, bundle, mode: 'clone', targetEndpoint: 'https://ordinary-cleanup.example', uploadAttemptKey: 'cleanup-attempt' }))
    .rejects.toThrow('COLD_UPLOAD_FAILED');
  const op = (await target.run(ctx => ctx.db.query('archiveUploadOperations').unique()))!;
  expect(op.state).toBe('RETIRED'); // A candidate deletion never claims a later full recovery window.
  expect(op.producerTerminalAt).toBeDefined();
  expect((await target.run(ctx => ctx.db.query('archiveUploadCandidates').unique()))!.state).toBe('DELETED');
  expect(await target.run(async ctx => !!await ctx.storage.get(harness.storedIds[0]))).toBe(false);
  expect(await target.run(async ctx => !!await ctx.storage.get(unrelated))).toBe(true);
});

test('ordinary published replay refuses changed canonical pointers and changed exact bundle bytes', async () => {
  const { bundle } = await ordinaryVectorBundle();
  const target = convexTest(schema, modules), harness = ordinaryImportHarness(target);
  const args = { adminToken, bundle, mode: 'clone', targetEndpoint: 'https://ordinary-fence.example', uploadAttemptKey: 'fenced-attempt' };
  await harness.invoke(args);
  const changed = { ...bundle, signature: undefined };
  await expect(harness.invoke({ ...args, bundle: changed })).rejects.toThrow('OPERATION_CHANGED');
  const imported = (await target.run(ctx => ctx.db.query('backupImports').unique()))!;
  await target.run(ctx => ctx.db.patch(imported._id, { manifest: { ...imported.manifest, vectorArchiveStorageId: undefined } }));
  await expect(harness.invoke(args)).rejects.toThrow('BACKUP_UPLOAD_PUBLICATION_CHANGED');
  expect(harness.stores()).toBe(1);
  await target.run(async ctx => {
    await ctx.db.patch(imported._id, { manifest: imported.manifest });
    await ctx.storage.delete(harness.storedIds[0]);
  });
  await expect(harness.invoke(args)).rejects.toThrow('BACKUP_UPLOAD_PUBLICATION_CHANGED');
});

test('ordinary lost reservation ACK never starts a second upload under the already committed lease', async () => {
  const { bundle } = await ordinaryVectorBundle();
  const target = convexTest(schema, modules), harness = ordinaryImportHarness(target, 'reserve-ack');
  const args = { adminToken, bundle, mode: 'clone', targetEndpoint: 'https://ordinary-reservation.example', uploadAttemptKey: 'reserve-lost' };
  await expect(harness.invoke(args)).rejects.toThrow('RESPONSE_ACK_LOST');
  await expect(harness.invoke(args)).rejects.toThrow('BACKUP_UPLOAD_ACKNOWLEDGEMENT_UNKNOWN');
  expect(harness.stores()).toBe(0);
  const op = (await target.run(ctx => ctx.db.query('archiveUploadOperations').unique()))!;
  expect(op.state).toBe('UPLOADING');
  expect(op.producerTerminalAt).toBeUndefined();
  expect(await target.run(ctx => ctx.db.query('backupImports').collect())).toHaveLength(0);
});

test('ordinary metadata recovery cannot manufacture terminal proof for an unknown original invocation', async () => {
  const { bundle } = await ordinaryVectorBundle(true);
  const target = convexTest(schema, modules), harness = ordinaryImportHarness(target, 'upload-ack');
  const args = { adminToken, bundle, mode: 'clone', targetEndpoint: 'https://ordinary-unknown.example', uploadAttemptKey: 'unknown-upload' };
  await expect(harness.invoke(args)).rejects.toThrow('UPLOAD_ACK_LOST');
  harness.nextFault('cold-upload');
  await expect(harness.invoke(args)).rejects.toThrow('COLD_UPLOAD_FAILED');
  const op = (await target.run(ctx => ctx.db.query('archiveUploadOperations').unique()))!;
  const candidate = (await target.run(ctx => ctx.db.query('archiveUploadCandidates').unique()))!;
  expect(op.state).toBe('UPLOADING');
  expect(op.uploadAcknowledged).toBe(false);
  expect(op.producerTerminalAt).toBeUndefined();
  expect(candidate.discoveredBy).toBe('METADATA_RECOVERY');
  expect(candidate.state).toBe('STORED');
  expect(await target.run(async ctx => !!await ctx.storage.get(candidate.storageId))).toBe(true);
});

test('ordinary exact-byte metadata mismatch cannot be acknowledged, published or deleted', async () => {
  const { bundle } = await ordinaryVectorBundle();
  const target = convexTest(schema, modules), harness = ordinaryImportHarness(target, 'wrong-bytes');
  const args = { adminToken, bundle, mode: 'clone', targetEndpoint: 'https://ordinary-conflict.example', uploadAttemptKey: 'wrong-byte-attempt' };
  await expect(harness.invoke(args)).rejects.toThrow('ARCHIVE_UPLOAD_METADATA_MISMATCH');
  await expect(harness.invoke(args)).rejects.toThrow('BACKUP_UPLOAD_NOT_RESUMABLE');
  const op = (await target.run(ctx => ctx.db.query('archiveUploadOperations').unique()))!;
  expect(op.recoveryConflict).toBe(true);
  expect(await target.run(ctx => ctx.db.query('archiveUploadCandidates').collect())).toHaveLength(0);
  expect(await target.run(ctx => ctx.db.query('backupImports').collect())).toHaveLength(0);
  expect(await target.run(async ctx => !!await ctx.storage.get(harness.storedIds[0]))).toBe(true);
  expect(harness.stores()).toBe(1);
});

test('ordinary cleanup preserves a candidate referenced inside an opaque stored manifest', async () => {
  const { bundle } = await ordinaryVectorBundle(true);
  const target = convexTest(schema, modules);
  let opaqueId: Id<'_storage'>;
  const harness = ordinaryImportHarness(target, 'cold-upload', async () => {
    opaqueId = await target.run(async ctx => {
      const candidate = (await ctx.db.query('archiveUploadCandidates').unique())!;
      const root = await ctx.storage.store(new Blob([JSON.stringify({ nested: { OLD: [candidate.storageId] } })]));
      await ctx.db.insert('backupImports', { sourceTownId: 'existing', mode: 'clone', exportedAt: 0,
        importedAt: 0, mapping: {}, runtimeSnapshot: {}, manifest: { vectorArchiveStorageId: root } });
      return root;
    });
  });
  await expect(harness.invoke({ adminToken, bundle, mode: 'clone', targetEndpoint: 'https://ordinary-reference.example', uploadAttemptKey: 'opaque-reference' }))
    .rejects.toThrow('COLD_UPLOAD_FAILED');
  const op = (await target.run(ctx => ctx.db.query('archiveUploadOperations').unique()))!;
  const candidate = (await target.run(ctx => ctx.db.query('archiveUploadCandidates').unique()))!;
  expect(op.state).toBe('RETIRED');
  expect(candidate.state).toBe('STORED');
  expect(await target.run(async ctx => !!await ctx.storage.get(candidate.storageId))).toBe(true);
  expect(await target.run(async ctx => JSON.parse(await (await ctx.storage.get(opaqueId))!.text()).nested.OLD)).toEqual([candidate.storageId]);
});

test('ordinary lost publication ACK reuses its vector bundle and published cold attachments together', async () => {
  const { bundle } = await ordinaryVectorBundle(true);
  const target = convexTest(schema, modules), harness = ordinaryImportHarness(target, 'publish-ack');
  const args = { adminToken, bundleJson: JSON.stringify(bundle), mode: 'clone', targetEndpoint: 'https://ordinary-cold-replay.example',
    uploadAttemptKey: 'cold-publication-replay' };
  await expect(harness.invoke(args)).rejects.toThrow('RESPONSE_ACK_LOST');
  expect(harness.stores()).toBe(2);
  const result = await harness.invoke(args);
  expect(result.coldFilesRestored).toBe(1);
  expect(harness.stores()).toBe(2);
  const imported = (await target.run(ctx => ctx.db.query('backupImports').unique()))!;
  const cold = (await target.run(ctx => ctx.db.query('coldHistoryArchives').unique()))!;
  expect(imported.manifest.vectorArchiveStorageId).toBe(harness.storedIds[0]);
  expect(cold.storageId).toBe(harness.storedIds[1]);
  expect(await target.run(async ctx => !!await ctx.storage.get(cold.storageId!))).toBe(true);
  expect((await target.run(ctx => ctx.db.query('archiveUploadCandidates').unique()))!.state).toBe('PUBLISHED');
});

test.each(['clone', 'merge', 'restore', 'migrate'] as const)(
  'ordinary non-vector %s retries a lost publication ACK without reapplying or requiring old target state', async mode => {
    const src = await town();
    const bundle: BackupBundle = await src.t.action(action('federation/backup:exportTown'), { adminToken });
    expect(bundle.manifest.includeVectors).toBe(false);
    const destination = mode === 'clone' ? { t: convexTest(schema, modules), worldId: undefined } : await town();
    if (mode === 'restore' || mode === 'migrate') {
      const source = (await src.t.run(ctx => ctx.db.query('federationIdentity').unique()))!;
      await destination.t.run(async ctx => {
        const local = (await ctx.db.query('federationIdentity').unique())!;
        await ctx.db.patch(local._id, { publicKey: source.publicKey, privateKeyEncrypted: source.privateKeyEncrypted,
          fingerprint: source.fingerprint });
      });
    }
    const harness = ordinaryImportHarness(destination.t, 'publish-ack');
    const args = { adminToken, bundleJson: JSON.stringify(bundle), mode,
      ...(mode === 'clone' ? { targetEndpoint: 'https://non-vector-copy.example' }
        : mode === 'merge' ? { targetWorldId: destination.worldId } : { sourceStopped: true }),
      uploadAttemptKey: `non-vector-${mode}` };
    await expect(harness.invoke(args)).rejects.toThrow('RESPONSE_ACK_LOST');
    const before = await destination.t.run(async ctx => ({
      imports: await ctx.db.query('backupImports').collect(), worlds: await ctx.db.query('worlds').collect(),
      memories: await ctx.db.query('memories').collect(), identities: await ctx.db.query('federationIdentity').collect(),
    }));
    expect(before.imports).toHaveLength(1);
    const result = await harness.invoke(args);
    expect(result.importId).toBe(before.imports[0]._id);
    expect(before.imports[0].ordinaryImportResult).toEqual(result);
    expect(harness.stores()).toBe(0);
    expect(await destination.t.run(async ctx => ({
      imports: await ctx.db.query('backupImports').collect(), worlds: await ctx.db.query('worlds').collect(),
      memories: await ctx.db.query('memories').collect(), identities: await ctx.db.query('federationIdentity').collect(),
    }))).toEqual(before);
  },
);

test('ordinary non-vector retries reject a changed payload or import target under the same key', async () => {
  const src = await town();
  const bundle: BackupBundle = await src.t.action(action('federation/backup:exportTown'), { adminToken });
  const target = convexTest(schema, modules), harness = ordinaryImportHarness(target);
  const args = { adminToken, bundle, mode: 'clone', targetEndpoint: 'https://non-vector-copy.example', uploadAttemptKey: 'non-vector-immutable' };
  const result = await harness.invoke(args);
  const changed = { ...bundle, manifest: { ...bundle.manifest, exportedAt: bundle.manifest.exportedAt + 1 } };
  const source = (await src.t.run(ctx => ctx.db.query('federationIdentity').unique()))!;
  changed.signature = await sign(changed.manifest, source.privateKeyEncrypted);
  for (const overrides of [{ bundle: changed }, { targetEndpoint: 'https://different.example' },
    { mode: 'merge' }, { sourceStopped: true }, { residentRestore: { operator: 'different', reason: 'changed', expectedTargetDigest: 'x', confirmOverwrite: true } }]) {
    await expect(harness.invoke({ ...args, ...overrides })).rejects.toThrow('BACKUP_IMPORT_REQUEST_CHANGED');
  }
  expect(await harness.invoke(args)).toEqual(result);
  expect(await target.run(ctx => ctx.db.query('backupImports').collect())).toHaveLength(1);
});

test('ordinary non-vector apply rolls back its success receipt with failed import writes', async () => {
  const src = await town();
  const bundle: BackupBundle = await src.t.action(action('federation/backup:exportTown'), { adminToken });
  const target = convexTest(schema, modules), harness = ordinaryImportHarness(target, 'late-rollback');
  const args = { adminToken, bundle, mode: 'clone', targetEndpoint: 'https://non-vector-rollback.example', uploadAttemptKey: 'non-vector-rollback' };
  await expect(harness.invoke(args)).rejects.toThrow('LATE_IMPORT_ROLLBACK');
  expect(await target.run(ctx => ctx.db.query('backupImports').collect())).toHaveLength(0);
  expect(await target.run(ctx => ctx.db.query('worlds').collect())).toHaveLength(0);
  const result = await harness.invoke(args);
  expect(await harness.invoke(args)).toEqual(result);
  expect(await target.run(ctx => ctx.db.query('backupImports').collect())).toHaveLength(1);
});


test('ordinary non-vector original Home resident restore recovers a committed result after target digest changes', async () => {
  const { t, worldId, memoryId } = await town();
  const bundle = await t.action(action('federation/backup:exportResident'), { adminToken, worldId, playerId: 'p:0' });
  const args = { ...await residentRestoreArgs(t, bundle, worldId), uploadAttemptKey: 'resident-restoration-ack' };
  const harness = ordinaryImportHarness(t, 'publish-ack');
  await expect(harness.invoke(args)).rejects.toThrow('RESPONSE_ACK_LOST');
  const first = (await t.run(ctx => ctx.db.query('backupImports').unique()))!;
  await t.run(ctx => ctx.db.patch(memoryId, { description: 'New fact after the committed restore' }));
  const result = await harness.invoke(args);
  expect(result).toEqual(first.ordinaryImportResult);
  expect(result.residentRestoreReport).toBeDefined();
  expect((await t.run(ctx => ctx.db.get(memoryId)))!.description).toBe('New fact after the committed restore');
  expect(await t.run(ctx => ctx.db.query('backupImports').collect())).toHaveLength(1);
});

test('ordinary non-vector retry reuses committed cold files without uploading attachments again', async () => {
  const src = await town();
  await src.t.action(action('federation/coldHistory:archive'), await nativeColdOwner(src.t, src.worldId));
  const bundle: BackupBundle = await src.t.action(action('federation/backup:exportTown'), { adminToken });
  expect(bundle.coldHistoryFiles!.length).toBeGreaterThan(0);
  const target = convexTest(schema, modules), harness = ordinaryImportHarness(target, 'publish-ack');
  const args = { adminToken, bundle, mode: 'clone', targetEndpoint: 'https://non-vector-cold.example', uploadAttemptKey: 'non-vector-cold' };
  await expect(harness.invoke(args)).rejects.toThrow('RESPONSE_ACK_LOST');
  const uploaded = harness.stores();
  const result = await harness.invoke(args);
  expect(result.coldFilesRestored).toBe(bundle.coldHistoryFiles!.length);
  expect(harness.stores()).toBe(uploaded);
  expect(await target.run(ctx => ctx.db.query('coldHistoryArchives').collect())).toHaveLength(bundle.coldHistoryFiles!.length);
});

const cloneStatusQuery = makeFunctionReference<'query'>('federation/admin:status');
const activateCloneMutation = makeFunctionReference<'mutation'>('federation/admin:activateIndependentClone');
async function independentCloneFixture(legacy = false) {
  const source = await town();
  const bundle = await source.t.action(action('federation/backup:exportTown'), { adminToken });
  const t = convexTest(schema, modules);
  const imported = await t.action(action('federation/backup:importBackup'), {
    adminToken, bundle, mode: 'clone', targetEndpoint: 'https://independent.example',
  });
  if (legacy) await t.run(ctx => ctx.db.patch(imported.importId!, { cloneDeployment: undefined }));
  const local = (await t.run(ctx => ctx.db.query('federationIdentity').unique()))!;
  const args = { adminToken, importId: imported.importId! as Id<'backupImports'>, expectedTownId: local.townId,
    expectedDeploymentInstanceId: local.deploymentInstanceId, expectedDeploymentEpoch: local.deploymentEpoch,
    operator: 'Clone operator', reason: 'Start an independent town with new pairing' };
  return { t, args, local };
}

test.each([false, true])('completed ordinary clone activates independently and retry preserves audit (legacy=%s)', async legacy => {
  const { t, args } = await independentCloneFixture(legacy);
  expect((await t.query(cloneStatusQuery, { adminToken })).cloneActivation).toMatchObject({ eligible: true, importId: args.importId });
  expect(await t.mutation(activateCloneMutation, args)).toMatchObject({ activated: true, alreadyActivated: false });
  const state = await t.run(async ctx => ({ local: await ctx.db.query('federationIdentity').unique(),
    receipt: await ctx.db.get(args.importId), records: await ctx.db.query('deploymentRecords').collect() }));
  expect(state.local).toMatchObject({ mode: 'ACTIVE', enabled: false, allowIncomingPairRequests: false });
  expect(state.receipt!.cloneActivation).toMatchObject({ operator: args.operator, reason: args.reason,
    townId: args.expectedTownId, deploymentInstanceId: args.expectedDeploymentInstanceId,
    deploymentEpoch: args.expectedDeploymentEpoch, publicKey: state.local!.publicKey });
  expect(state.receipt!.cloneDeployment).toMatchObject({ townId: args.expectedTownId, publicKey: state.local!.publicKey });
  expect(await t.mutation(activateCloneMutation, { ...args, reason: 'Retry' })).toMatchObject({ alreadyActivated: true });
  const retried = await t.run(async ctx => ({ receipt: await ctx.db.get(args.importId), records: await ctx.db.query('deploymentRecords').collect() }));
  expect(retried).toEqual({ receipt: state.receipt, records: state.records });
  await expect(t.mutation(activateCloneMutation, { ...args, expectedDeploymentInstanceId: 'another-deployment' })).rejects.toThrow('CLONE_DEPLOYMENT_CHANGED');
  await t.run(async ctx => { const local = (await ctx.db.query('federationIdentity').unique())!; await ctx.db.patch(local._id, { mode: 'DISABLED' }); });
  await expect(t.mutation(activateCloneMutation, args)).rejects.toThrow('CLONE_ACTIVATION_NO_LONGER_CURRENT');
});

test.each(['restore', 'migrate', 'merge'])('a %s receipt cannot grant clone activation', async mode => {
  const { t, args } = await independentCloneFixture();
  await t.run(ctx => ctx.db.patch(args.importId, { mode }));
  expect((await t.query(cloneStatusQuery, { adminToken })).cloneActivation).toMatchObject({ eligible: false, importId: null });
  await expect(t.mutation(activateCloneMutation, args)).rejects.toThrow('CLONE_COMPLETION_PROOF_REQUIRED');
});

test.each([
  ['MIGRATING_IN', 'CLONE_DEPLOYMENT_NOT_DISABLED'], ['QUARANTINED', 'CLONE_DEPLOYMENT_NOT_DISABLED'],
  ['enabled', 'CLONE_ADMISSION_MUST_BE_CLOSED'], ['incoming', 'CLONE_ADMISSION_MUST_BE_CLOSED'],
  ['handoff', 'CLONE_OLD_AUTHORITY_REMAINS'], ['runtime', 'CLONE_OLD_AUTHORITY_REMAINS'],
  ['peer', 'CLONE_PEER_TRUST_REMAINS'], ['deployment', 'CLONE_COMPLETION_PROOF_REQUIRED'],
  ['key', 'CLONE_COMPLETION_PROOF_REQUIRED'], ['source-key', 'CLONE_COMPLETION_PROOF_REQUIRED'],
  ['session', 'CLONE_OLD_AUTHORITY_REMAINS'], ['visitor', 'CLONE_ACTIVE_TRAVEL_REMAINS'],
])('clone activation rejects %s without changing deployment', async (variant, reason) => {
  const { t, args, local } = await independentCloneFixture();
  await t.run(async ctx => {
    if (variant === 'MIGRATING_IN' || variant === 'QUARANTINED') await ctx.db.patch(local._id, { mode: variant });
    if (variant === 'enabled') await ctx.db.patch(local._id, { enabled: true });
    if (variant === 'incoming') await ctx.db.patch(local._id, { allowIncomingPairRequests: true });
    if (variant === 'handoff') await ctx.db.patch(local._id, { activeHandoffId: 'old-handoff' });
    if (variant === 'runtime') { const runtime = (await ctx.db.query('federationAgentRuntimes').first())!; await ctx.db.patch(runtime._id, { homeTownId: 'town:original' }); }
    if (variant === 'peer') { const peer = (await ctx.db.query('federationPeers').first())!; await ctx.db.patch(peer._id, { trustState: 'TRUSTED' }); }
    if (variant === 'deployment') await ctx.db.patch(local._id, { deploymentEpoch: local.deploymentEpoch + 1 });
    if (variant === 'key') await ctx.db.patch(local._id, { publicKey: 'different-key' });
    if (variant === 'source-key') { const receipt = (await ctx.db.get(args.importId))!; await ctx.db.patch(args.importId, { cloneDeployment: { ...receipt.cloneDeployment!, sourcePublicKey: local.publicKey } }); }
    if (variant === 'session') await ctx.db.insert('transportSessions', { peerTownId: 'town:old-peer', channelState: 'TRANSPORT_READY', transportType: 'DIRECT_HTTPS', localDeploymentEpoch: 1, verifiedPeerDeploymentEpoch: 1 });
    if (variant === 'visitor') { const world = (await ctx.db.query('worlds').first())!; await ctx.db.patch(world._id, { agents: world.agents.map(a => ({ ...a, travelVisitId: 'old-visit' })) }); }
  });
  expect((await t.query(cloneStatusQuery, { adminToken })).cloneActivation).toMatchObject({ eligible: false, reason });
  await expect(t.mutation(activateCloneMutation, args)).rejects.toThrow(variant === 'deployment' ? 'CLONE_DEPLOYMENT_CHANGED' : reason);
  expect((await t.run(ctx => ctx.db.get(args.importId)))!.cloneActivation).toBeUndefined();
});

test.each(['missing wrapping key', 'wrong wrapping key', 'invalid private key', 'mismatched private key'])('clone activation rejects %s atomically', async variant => {
  const { t, args, local } = await independentCloneFixture();
  if (variant === 'missing wrapping key') delete process.env.FEDERATION_KEY_ENCRYPTION_KEY;
  if (variant === 'wrong wrapping key') process.env.FEDERATION_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
  if (variant === 'invalid private key') await t.run(ctx => ctx.db.patch(local._id, { privateKeyEncrypted: 'invalid' }));
  if (variant === 'mismatched private key') { const other = await createIdentityKeys(); await t.run(ctx => ctx.db.patch(local._id, { privateKeyEncrypted: other.privateKeyEncrypted })); }
  // Eligibility uses public evidence only; the mutation validates the live signer.
  expect((await t.query(cloneStatusQuery, { adminToken })).cloneActivation.eligible).toBe(true);
  await expect(t.mutation(activateCloneMutation, args)).rejects.toThrow('CLONE_SIGNING_KEY_UNAVAILABLE');
  const state = await t.run(async ctx => ({ local: await ctx.db.get(local._id), receipt: await ctx.db.get(args.importId) }));
  expect(state.local!.mode).toBe('DISABLED');
  expect(state.receipt!.cloneActivation).toBeUndefined();
});

test.each(['backup lock', 'cold lock', 'privacy job', 'unfinished backup', 'active visit', 'conflict', 'wrong receipt', 'invalid operator', 'invalid reason'])('clone activation refuses %s', async variant => {
  const { t, args, local } = await independentCloneFixture();
  await t.run(async ctx => {
    if (variant === 'backup lock') { const jobId = await ctx.db.insert('backupLargeJobs', { kind: 'import', state: 'FAILED', phase: 'FINALIZE', tableIndex: 0, cursor: null, chunkCount: 0, processedChunks: 0, recordCount: 0, bytes: 0, createdAt: 1, updatedAt: 1, source: {} }); await ctx.db.insert('backupMaintenanceLocks', { key: 'town', jobId, createdAt: 1 }); }
    if (variant === 'cold lock') {
      const world = (await ctx.db.query('worlds').first())!;
      const archiveId = await ctx.db.insert('coldHistoryArchives', { sourceKey: 'lock-fixture', lookupKey: 'lock-fixture',
        worldId: world._id, kind: 'conversation', sourceId: 'c:0', state: 'PENDING', manifest: {}, signature: '', publicKey: local.publicKey, createdAt: 1 });
      const jobId = await ctx.db.insert('coldHistoryJobs', { archiveId, owner: {}, source: {}, snapshotId: 'lock-fixture',
        state: 'FAILED', phase: 'PACK', revision: 0, cursor: null, pageNumber: 0, messageOffset: 0, chunkCount: 0,
        count: 0, bytes: 0, chainDigest: '', verifiedChunks: 0, createdAt: 1, updatedAt: 1 });
      await ctx.db.insert('coldHistoryLocks', { key: 'town', jobId, createdAt: 1 });
    }
    if (variant === 'privacy job') await ctx.db.insert('travelPrivacyJobs', { visitId: 'old-visit', scope: 'CACHE', state: 'RUNNING',
      phase: 'SCAN', tableIndex: 0, cursor: null, revision: 0, sourceRevision: 0, privacyRevision: 0, changed: false,
      role: 'home', ownerGlobalId: `${local.townId}/agent:old`, conversationIds: [], conversationOwners: [], transcriptIds: [],
      memoryIds: [], memoryOwners: [], archiveIds: [], textHashes: [], blockers: [], externalCopies: 0, counts: {},
      processedRows: 0, createdAt: 1, updatedAt: 1 });
    if (variant === 'unfinished backup') await ctx.db.insert('backupLargeJobs', { kind: 'import', state: 'FAILED', phase: 'FINALIZE',
      tableIndex: 0, cursor: null, chunkCount: 0, processedChunks: 0, recordCount: 0, bytes: 0, createdAt: 1, updatedAt: 1, source: {} });
    if (variant === 'active visit') await ctx.db.insert('visitLedger', { visitId: 'active-old-visit', agentGlobalId: `${local.townId}/agent:old`, homeTownId: local.townId, hostTownId: 'town:foreign', homeDeploymentEpoch: 1, hostDeploymentEpoch: 1, agentAuthorityEpoch: 1, visitLeaseVersion: 1, leaseExpiry: Date.now() + 60000, fencingToken: 'old', state: 'ACTIVE', role: 'home', profile: {}, createdAt: 1, updatedAt: 1 });
    if (variant === 'conflict') await ctx.db.insert('federationIdentityConflicts', { conflictKey: 'clone', townId: local.townId, publicKey: local.publicKey, knownDeploymentInstanceId: local.deploymentInstanceId, knownDeploymentEpoch: 1, observedDeploymentInstanceId: 'other', observedDeploymentEpoch: 1, source: 'HEALTH', evidence: {}, evidenceDigest: 'evidence', state: 'OPEN', detectedAt: 1 });
    if (variant === 'wrong receipt') args.importId = await ctx.db.insert('backupImports', { sourceTownId: 'town:unrelated', mode: 'restore', exportedAt: 1, importedAt: 1, mapping: {}, runtimeSnapshot: {}, manifest: {} });
  });
  if (variant === 'invalid operator') args.operator = ' ';
  if (variant === 'invalid reason') args.reason = ' ';
  const reasons: Record<string, string> = { 'backup lock': 'TOWN_BACKUP_MAINTENANCE_LOCKED',
    'cold lock': 'TOWN_COLD_HISTORY_MAINTENANCE_LOCKED', 'privacy job': 'TOWN_TRAVEL_PRIVACY_BUSY',
    'unfinished backup': 'CLONE_BACKUP_JOB_NOT_COMPLETE', 'active visit': 'CLONE_ACTIVE_TRAVEL_REMAINS',
    conflict: 'TOWN_CLONE_CONFLICT', 'wrong receipt': 'CLONE_COMPLETION_PROOF_REQUIRED',
    'invalid operator': 'INVALID_CLONE_ACTIVATION_DETAILS', 'invalid reason': 'INVALID_CLONE_ACTIVATION_DETAILS' };
  await expect(t.mutation(activateCloneMutation, args)).rejects.toThrow(reasons[variant]);
  expect((await t.run(ctx => ctx.db.get(local._id)))!.mode).toBe('DISABLED');
});


test.each(['ACTIVE', 'MIGRATING_IN', 'QUARANTINED'])('clone status in %s never reads backup history', async mode => {
  const tables: string[] = [];
  const ctx = { db: { query: (table: string) => {
    tables.push(table);
    if (table !== 'federationIdentity') throw new Error('UNEXPECTED_HISTORY_READ');
    return { unique: async () => ({ townId: 'town:current', deploymentInstanceId: 'current', deploymentEpoch: 1, mode }) };
  } } } as unknown as Parameters<typeof independentCloneStatus>[0];
  expect(await independentCloneStatus(ctx)).toMatchObject({ eligible: false, reason: 'CLONE_DEPLOYMENT_NOT_DISABLED' });
  expect(tables).toEqual(['federationIdentity']);
});

test.each(['epoch', 'instance', 'key', 'receipt', 'MIGRATING_IN', 'QUARANTINED', 'conflict'])('clone activation retry rejects changed %s', async variant => {
  const { t, args, local } = await independentCloneFixture();
  await t.mutation(activateCloneMutation, args);
  await t.run(async ctx => {
    if (variant === 'epoch') { args.expectedDeploymentEpoch++; await ctx.db.patch(local._id, { deploymentEpoch: args.expectedDeploymentEpoch }); }
    if (variant === 'instance') { args.expectedDeploymentInstanceId = 'new-instance'; await ctx.db.patch(local._id, { deploymentInstanceId: 'new-instance' }); }
    if (variant === 'key') await ctx.db.patch(local._id, { publicKey: 'replacement-key' });
    if (variant === 'MIGRATING_IN' || variant === 'QUARANTINED') await ctx.db.patch(local._id, { mode: variant });
    if (variant === 'receipt') args.importId = await ctx.db.insert('backupImports', { sourceTownId: 'town:other', mode: 'clone', exportedAt: 1, importedAt: 1, mapping: {}, runtimeSnapshot: {}, manifest: {} });
    if (variant === 'conflict') await ctx.db.insert('federationIdentityConflicts', { conflictKey: 'retry-conflict', townId: local.townId,
      publicKey: local.publicKey, knownDeploymentInstanceId: local.deploymentInstanceId, knownDeploymentEpoch: local.deploymentEpoch,
      observedDeploymentInstanceId: 'other', observedDeploymentEpoch: local.deploymentEpoch, source: 'HEALTH', evidence: {},
      evidenceDigest: 'evidence', state: 'OPEN', detectedAt: 1 });
  });
  const before = await t.run(async ctx => ({ receipt: await ctx.db.get(args.importId), records: await ctx.db.query('deploymentRecords').collect() }));
  await expect(t.mutation(activateCloneMutation, args)).rejects.toThrow(variant === 'conflict' ? 'TOWN_CLONE_CONFLICT' :
    variant === 'MIGRATING_IN' || variant === 'QUARANTINED' ? 'CLONE_DEPLOYMENT_NOT_DISABLED' : 'CLONE_ACTIVATION_NO_LONGER_CURRENT');
  expect(await t.run(async ctx => ({ receipt: await ctx.db.get(args.importId), records: await ctx.db.query('deploymentRecords').collect() }))).toEqual(before);
});
