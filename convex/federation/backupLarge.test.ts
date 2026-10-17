import { drivePrivacyWithStorageMetadata } from '../../tests/helpers/privacyTestDriver';
import * as largeFunctions from './backupLarge';
import { assertBackupPrivacy } from './backupPrivacy';
import { seedMemoryBackupEvidence, assertMemoryBackupEvidence, useLegacyMemoryBackupDigests } from './memoryBackupTestHelpers';
import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference, getFunctionName } from 'convex/server';
import schema from '../schema';
import { DEFAULT_RESOURCE_LIMITS } from './resources';
import { Id } from '../_generated/dataModel';
import { createIdentityKeys, digest, sign, verifySignature } from './security';
import { createLocalArchiveProof, createLocalChunkManifest, type LocalSanitizedChunkManifest } from './travelPrivacyLocalChunkManifest';
import { validateLargeImportManifest, assertLargeDerivativeClearedVisits } from './backupLargeLocalImport';
import type { SelectiveManifest } from './backupSelectiveHelpers';
import { decodeRow, encodeRow } from './backupHelpers';
import { Game } from '../aiTown/game';
import { engineInsertInput } from '../engine/abstractGame';
import type { ActionCtx } from '../_generated/server';
import { EMBEDDING_DIMENSION } from '../util/llm';
import type { PortableHistory } from './coldHistoryFiles';
import {
  descriptor,
  LargeChunk,
  LargeManifest,
  MAX_CHUNK_BYTES,
  largeTables,
  oldTables,
  validateManifest,
  validateChunk,
  validateSourceRow,
  size,
} from './backupLargeHelpers';

const modules = {
  '../federation/backupPrivacyChunks.ts': () => import('./backupPrivacyChunks'),
  '../federation/archiveUploadProvenance.ts': () => import('./archiveUploadProvenance'),
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/backupLarge.ts': () => import('./backupLarge'),
  '../federation/backup.ts': () => import('./backup'),
  '../federation/travelPrivacy.ts': () => import('./travelPrivacy'),
  '../federation/travelPrivacyArchives.ts': () => import('./travelPrivacyArchives'),
  '../federation/travelPrivacyChunkCoordinator.ts': () => import('./travelPrivacyChunkCoordinator'),
  '../federation/travelPrivacyChunkArchives.ts': () => import('./travelPrivacyChunkArchives'),
  '../federation/travelPrivacyChunkRewrite.ts': () => import('./travelPrivacyChunkRewrite'),
  '../federation/travelPrivacyChunkReferenceProof.ts': () => import('./travelPrivacyChunkReferenceProof'),
  '../federation/admin.ts': () => import('./admin'),
  '../federation/coldHistory.ts': () => import('./coldHistory'),
  '../federation/coldHistoryFiles.ts': () => import('./coldHistoryFiles'),
  '../federation/coldHistoryChunks.ts': () => import('./coldHistoryChunks'),
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

test('input snapshot pagination resumes a smaller legacy page without skipping or replaying inputs', async () => {
  const s = await town(25);
  await s.t.run(async ctx => {
    for (let number = 0; number < 450; number++)
      await ctx.db.insert('inputs', { engineId: s.engineId, number, name: 'moveTo',
        args: { playerId: 'p:0', destination: { x: 1, y: 2 } }, received: number + 1 });
  });
  const legacy = await s.t.run(ctx => ctx.db.query('inputs').paginate({ cursor: null, numItems: 20 }));
  expect(legacy.page).toHaveLength(20);
  const { jobId } = await s.t.mutation(mutation('startExport'), { adminToken });
  await s.t.run(ctx => ctx.db.patch(jobId, { tableIndex: largeTables.indexOf('inputs'), cursor: legacy.continueCursor }));
  const numbers = legacy.page.map(row => row.number);
  for (const expected of [200, 200, 30]) {
    const page = await s.t.query(query('page'), { jobId });
    expect(page.rows).toHaveLength(expected);
    numbers.push(...page.rows.map((row: any) => row.number));
    await s.t.run(ctx => ctx.db.patch(jobId, { cursor: page.continueCursor }));
    expect(page.isDone).toBe(expected === 30);
  }
  expect(numbers).toEqual(Array.from({ length: 450 }, (_, number) => number));
  expect(await s.t.run(ctx => ctx.db.query('inputs').collect())).toHaveLength(450);
  expect((await s.t.run(ctx => ctx.db.get(s.engineId)))?.running).toBe(false);
  await s.t.run(ctx => ctx.db.patch(jobId, { tableIndex: largeTables.indexOf('memories'), cursor: null }));
  expect((await s.t.query(query('page'), { jobId })).rows).toHaveLength(20);
});

test('input snapshot pages retain valid signed 20-row chunks across byte and row splitting', async () => {
  const s = await town(0);
  await s.t.run(async ctx => {
    for (let number = 0; number < 450; number++)
      await ctx.db.insert('inputs', { engineId: s.engineId, number, name: 'moveTo',
        args: { note: number === 225 || number === 226 ? '大'.repeat(100000) : 'audit-only' }, received: number + 1 });
  });
  const archive = await exported(s.t);
  await expect(validateManifest(archive.manifest, archive.signature)).resolves.toBeUndefined();
  const chunks = archive.chunks.filter(chunk => chunk.table === 'inputs');
  expect(chunks.length).toBeGreaterThanOrEqual(23);
  expect(chunks.every(chunk => chunk.rows.length <= 20 && size(chunk) <= MAX_CHUNK_BYTES)).toBe(true);
  const firstLarge = chunks.find(chunk => chunk.rows.some(row => decodeRow(row).number === 225));
  expect(firstLarge).toBeDefined();
  expect(firstLarge!.rows.some(row => decodeRow(row).number === 226)).toBe(false);
  expect(chunks.flatMap(chunk => chunk.rows.map(row => decodeRow(row).number)))
    .toEqual(Array.from({ length: 450 }, (_, number) => number));
  expect(await s.t.run(ctx => ctx.db.query('inputs').collect())).toHaveLength(450);
  expect((await s.t.run(ctx => ctx.db.get(s.engineId)))?.running).toBe(false);
});

const historyAction = (name: string) => makeFunctionReference<'action'>(`federation/${name}`);
const historyQuery = (name: string) => makeFunctionReference<'query'>(`federation/${name}`);
async function coldConversation(source: Town, firstMessage?: string, count = 3, chunked = false) {
  const memoryId = await source.t.run(async ctx => {
    const embeddingId = await ctx.db.insert('memoryEmbeddings', {
      playerId: 'p:0', embedding: Array.from({ length: EMBEDDING_DIMENSION }, () => 0.25),
    });
    const memoryId = await ctx.db.insert('memories', {
      worldId: source.worldId, playerId: 'p:0', agentGlobalId: source.agentGlobalId,
      embeddingId, description: 'Retained closed conversation', importance: 8, lastAccess: 1,
      data: { type: 'conversation', conversationId: 'c:4', playerIds: ['p:1'] },
    });
    await ctx.db.insert('archivedConversations', {
      worldId: source.worldId, id: 'c:4', creator: 'p:0', created: 10, ended: 20,
      numMessages: count, participants: ['p:0', 'p:1'],
    });
    await ctx.db.insert('participatedTogether', {
      worldId: source.worldId, conversationId: 'c:4', player1: 'p:0', player2: 'p:1', ended: 20,
    });
    for (let index = 0; index < count; index++)
      await ctx.db.insert('messages', {
        worldId: source.worldId, conversationId: 'c:4', author: index % 2 ? 'p:1' : 'p:0',
        text: index === 0 && firstMessage !== undefined ? firstMessage : `Retained original message ${index}`,
        messageUuid: `large-cold-message-${index}`,
      });
    return memoryId;
  });
  const owner = {
    adminToken, worldId: source.worldId, playerId: 'p:0', agentGlobalId: source.agentGlobalId, memoryId,
  };
  const started = chunked
    ? await source.t.mutation(makeFunctionReference<'mutation'>('federation/coldHistoryChunks:start'), owner)
    : await source.t.action(historyAction('coldHistory:archive'), owner);
  if ('jobId' in started) for (let n = 0; n < 300; n++) {
    const state = await source.t.action(historyAction('coldHistoryChunks:advance'), { ...owner, jobId: started.jobId });
    if (state.state === 'FAILED') throw new Error(state.error);
    if (state.state === 'COMPLETE') break;
  }
  const archiveId = started.archiveId;
  const file: PortableHistory = await source.t.action(historyAction('jobId' in started ? 'coldHistoryChunks:exportPart' : 'coldHistoryFiles:exportFile'),
    { ...owner, ...('jobId' in started ? { index: 0 } : {}) });
  const original = await source.t.run(ctx => ctx.db.get(archiveId as Id<'coldHistoryArchives'>));
  return { owner, file, original: original! };
}
test('v2 full-town clone restores every part of a >1000-message scope with original portable signatures', async () => {
  const source = await town(), cold = await coldConversation(source, undefined, 1007);
  const archive = await exported(source.t), attachments = archive.chunks.filter(c => c.table === 'coldHistoryFiles').flatMap(c => c.rows.map(decodeRow));
  expect(attachments.length).toBe(cold.original.manifest.chunkCount);
  expect(attachments.every(a => a.file.version === 2)).toBe(true);
  const destination = convexTest(schema, modules), jobId = await staged(destination, archive, 'clone');
  await drive(destination, jobId, 'import', 'READY');
  await destination.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(destination, jobId, 'import', 'COMPLETE');
  const restored = await retainedState(destination), binding = restored.bindings[0];
  const memory = restored.memories.find(m => m.description === 'Retained closed conversation')!;
  const owner = { adminToken, worldId: binding.worldId, playerId: binding.playerId, agentGlobalId: binding.agentGlobalId, memoryId: memory._id };
  expect(restored.messages).toHaveLength(1007);
  expect(restored.coldArchives[0].state).toBe('VERIFIED');
  for (const a of attachments) expect(await destination.action(historyAction('coldHistoryChunks:exportPart'), { ...owner, index: a.file.descriptor.index })).toEqual(a.file);
  expect(await source.t.run(ctx => ctx.db.query('messages').collect())).toHaveLength(1007);
}, 300000);
test.each(['missing part', 'extra hot original'])('v2 full-town %s fails preflight without writing target history', async variant => {
  const source = await town(), cold = await coldConversation(source, undefined, 30, true), archive = await exported(source.t);
  if (variant === 'missing part') {
    const coldChunks = archive.chunks.filter(c => c.table === 'coldHistoryFiles');
    archive.chunks = archive.chunks.filter(c => c.index !== coldChunks[coldChunks.length - 1].index);
  } else {
    const chunk = archive.chunks.find(c => c.table === 'messages' && c.rows.length < 20)!;
    const original = decodeRow(chunk.rows[0]);
    chunk.rows.push(encodeRow({ ...original, _id: `${original._id}:extra`, messageUuid: 'extra-hot-original' }));
  }
  for (const [index, chunk] of archive.chunks.entries()) chunk.index = index;
  archive.manifest.chunks = await Promise.all(archive.chunks.map(descriptor));
  archive.signature = await sign(archive.manifest, source.keys.privateKeyEncrypted);
  const destination = convexTest(schema, modules), jobId = await staged(destination, archive, 'clone');
  await expect(drive(destination, jobId, 'import', 'READY')).rejects.toThrow(
    variant === 'missing part' ? 'COLD_HISTORY_INCOMPLETE_CHUNKS' : 'BACKUP_COLD_FILES_MESSAGES_MISMATCH');
  expect(await destination.run(ctx => ctx.db.query('messages').collect())).toEqual([]);
  expect(await destination.run(ctx => ctx.db.query('coldHistoryArchives').collect())).toEqual([]);
  expect(cold.original.state).toBe('VERIFIED');
});
async function coldTravel(source: Town) {
  const transcriptId = 'large-travel-conversation/completed-visit';
  const memoryId = await source.t.run(async ctx => {
    const memoryId = await ctx.db.insert('memories', {
      worldId: source.worldId, playerId: 'p:0', agentGlobalId: source.agentGlobalId,
      description: 'Completed journey with retained original dialogue', importance: 8, lastAccess: 1,
      data: {
        type: 'travel', eventId: 'large-travel-ended', visitId: 'completed-visit', hostTownId: 'town:friend',
        federationConversationId: 'large-travel-conversation', transcriptId, participants: [], occurredAt: 20,
      },
    });
    await ctx.db.insert('homeTravelTranscripts', {
      worldId: source.worldId, playerId: 'p:0', agentGlobalId: source.agentGlobalId, transcriptId,
      visitId: 'completed-visit', hostTownId: 'town:friend', federationConversationId: 'large-travel-conversation',
      endedAt: 20, participants: [], finalPageNumber: 0, receivedPageCount: 1, highestPageNumber: 0,
      totalMessageCount: 3, state: 'COMPLETE', summaryState: 'DONE', endMemoryId: memoryId,
    });
    await ctx.db.insert('homeTravelTranscriptPages', {
      agentGlobalId: source.agentGlobalId, transcriptId, pageNumber: 0, eventId: 'large-travel-page',
      finalPage: true, memoryIds: [memoryId],
      messages: Array.from({ length: 3 }, (_, index) => ({
        messageId: `large-travel-message-${index}`, text: `Retained journey message ${index}`,
        author: index % 2 ? 'town:friend/visitor:bob' : source.agentGlobalId, occurredAt: index + 10,
      })),
    });
    return memoryId;
  });
  const owner = { adminToken, worldId: source.worldId, playerId: 'p:0', agentGlobalId: source.agentGlobalId, memoryId };
  await source.t.action(historyAction('coldHistory:archive'), owner);
  const file: PortableHistory = await source.t.action(historyAction('coldHistoryFiles:exportFile'), owner);
  return { owner, file };
}
async function retainedState(t: Town['t']) {
  return t.run(async ctx => ({
    identity: await ctx.db.query('federationIdentity').collect(),
    worlds: await ctx.db.query('worlds').collect(),
    memories: await ctx.db.query('memories').collect(),
    embeddings: await ctx.db.query('memoryEmbeddings').collect(),
    bindings: await ctx.db.query('residentModelBindings').collect(),
    profiles: await ctx.db.query('chatProfiles').collect(),
    conversations: await ctx.db.query('archivedConversations').collect(),
    history: await ctx.db.query('participatedTogether').collect(),
    messages: await ctx.db.query('messages').collect(),
    travelTranscripts: await ctx.db.query('homeTravelTranscripts').collect(),
    travelPages: await ctx.db.query('homeTravelTranscriptPages').collect(),
    coldArchives: await ctx.db.query('coldHistoryArchives').collect(),
  }));
}
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
async function formalChunkPlan(t: Town['t'], jobId: Id<'travelPrivacyJobs'>) {
  const ref = <K extends 'action' | 'query' | 'mutation'>(name: string, kind: K) =>
    makeFunctionReference<K>(`federation/travelPrivacyChunkArchives:${name}`);
  const scanId = await t.mutation(ref('startInspection', 'mutation'), { jobId });
  for (let page = 0; page < 5000; page++) {
    const scan = (await t.query(ref('result', 'query'), { scanId }))!;
    if (['READY_TO_REWRITE', 'BLOCKED'].includes(scan.phase)) {
      expect(scan.phase).toBe('READY_TO_REWRITE'); expect(scan.cleanupComplete).toBe(false);
      return t.run(async ctx => {
        const objects = await ctx.db.query('travelPrivacyChunkObjects').withIndex('scan', q => q.eq('scanId', scanId)).collect();
        expect(objects).toHaveLength((await ctx.db.query('backupLargeChunks').collect()).length);
        expect(objects.every(o => o.state === 'CHECKED' && !o.blockers.length)).toBe(true);
        return objects;
      });
    }
    await t.action(ref('inspectPage', 'action'), { scanId, revision: scan.revision });
  }
  throw new Error('Formal chunk inspection exceeded deterministic page budget');
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

async function localDerivative(source: Town, archive: Awaited<ReturnType<typeof exported>>,
  chunks = archive.chunks) {
  const local = await createLocalChunkManifest({ archiveId: archive.manifest.exportId, derivedAt: 2,
    clearedVisits: ['removed-visit'], chunks: await Promise.all(chunks.map(async chunk => ({
      ...await descriptor(chunk), role: 'EXPORT' as const, encoding: 'RAW' as const,
    }))), sourceEvidence: { manifest: archive.manifest, signature: archive.signature,
      publicKey: archive.manifest.source.publicKey, digest: await digest(archive.manifest), manifestStorageId: 'foreign-source-storage' } });
  const localProof = await createLocalArchiveProof(local, { townId: archive.manifest.source.townId,
    publicKey: source.keys.publicKey }, value => sign(value, source.keys.privateKeyEncrypted));
  return { manifest: local, signature: '', localProof,
    expectedLocalProofFingerprint: `sha256:${await digest(localProof.publicKey)}`, chunks };
}

test('RAW derivative import requires a pinned signer and rejects tampering, signature ambiguity and private rollback', async () => {
  const source = await town(0), archive = await exported(source.t), derivative = await localDerivative(source, archive);
  await expect(validateLargeImportManifest(derivative.manifest, '', derivative.localProof)).rejects.toThrow('SIGNER_CONFIRMATION_REQUIRED');
  await expect(validateLargeImportManifest(derivative.manifest, '', derivative.localProof, undefined, 'sha256:wrong'))
    .rejects.toThrow('SIGNER_MISMATCH');
  await expect(validateLargeImportManifest({ ...derivative.manifest, derivedAt: 3 }, '', derivative.localProof,
    undefined, derivative.expectedLocalProofFingerprint)).rejects.toThrow('LOCAL_PROOF_INVALID');
  await expect(validateLargeImportManifest(derivative.manifest, archive.signature, derivative.localProof,
    undefined, derivative.expectedLocalProofFingerprint)).rejects.toThrow('SOURCE_SIGNATURE_NOT_CURRENT');
  const old = structuredClone(derivative.manifest);
  old.chunks[0].role = 'OLD';
  await expect(validateLargeImportManifest(old, '', derivative.localProof, undefined,
    derivative.expectedLocalProofFingerprint)).rejects.toThrow('PRIVATE_ROLLBACK_NOT_PORTABLE');
  expect(await verifySignature(derivative.manifest.sourceEvidence.manifest!, archive.signature, source.keys.publicKey)).toBe(true);
  expect(await verifySignature(derivative.manifest, archive.signature, source.keys.publicKey)).toBe(false);
  const target = convexTest(schema, modules);
  await expect(target.action(action('createImport'), { adminToken, manifest: derivative.manifest,
    signature: '', localProof: derivative.localProof, mode: 'clone', targetEndpoint: 'https://derived.example' }))
    .rejects.toThrow('SIGNER_CONFIRMATION_REQUIRED');
  expect(await target.run(ctx => ctx.db.query('backupLargeJobs').collect())).toEqual([]);
});

test('RAW derivative stage validates its current descriptors and missing references remain fatal before apply', async () => {
  const source = await town(2), archive = await exported(source.t);
  const chunks = structuredClone(archive.chunks);
  const memories = chunks.find(chunk => chunk.table === 'memories')!;
  // Removing one side of a reflection cycle is not a valid closed privacy derivative.
  memories.rows = memories.rows.slice(0, 1);
  const derivative = await localDerivative(source, archive, chunks);
  const target = convexTest(schema, modules);
  const { jobId }: { jobId: Id<'backupLargeJobs'> } = await target.action(action('createImport'), { adminToken,
    manifest: derivative.manifest, signature: '', localProof: derivative.localProof,
    expectedLocalProofFingerprint: derivative.expectedLocalProofFingerprint,
    mode: 'clone', targetEndpoint: 'https://derived.example' });
  await expect(target.action(action('stageChunk'), { adminToken, jobId,
    chunk: JSON.stringify(archive.chunks.find(chunk => chunk.table === 'memories')) })).rejects.toThrow('CHECKSUM_MISMATCH');
  for (const chunk of chunks) await target.action(action('stageChunk'), { adminToken, jobId, chunk: JSON.stringify(chunk) });
  await expect(drive(target, jobId, 'import', 'READY')).rejects.toThrow('BACKUP_REFERENCE_MISSING');
  expect(await target.run(ctx => ctx.db.query('worlds').collect())).toEqual([]);
  expect(await target.run(ctx => ctx.db.query('memories').collect())).toEqual([]);
  const job = (await target.run(ctx => ctx.db.get(jobId)))!;
  expect(job.metadata.sourceSignatureValid).toBe(false);
  expect(job.metadata.vectorSourceTrusted).toBe(false);
  expect(job.source).toEqual(archive.manifest.source);
  expect(job.metadata.archiveSourceEvidence).not.toHaveProperty('manifestStorageId');
});

test('RAW derivative stage refuses retained cleared-visit prose while permitting safe control metadata', async () => {
  const source = await town(1);
  await source.t.run(ctx => ctx.db.patch(source.memoryIds[0], { data: { type: 'travel', visitId: 'removed-visit',
    eventId: 'removed-event', hostTownId: 'other', participants: [], occurredAt: 1 } }));
  const archive = await exported(source.t), derivative = await localDerivative(source, archive);
  const target = convexTest(schema, modules);
  const { jobId }: { jobId: Id<'backupLargeJobs'> } = await target.action(action('createImport'), { adminToken,
    manifest: derivative.manifest, signature: '', localProof: derivative.localProof,
    expectedLocalProofFingerprint: derivative.expectedLocalProofFingerprint,
    mode: 'clone', targetEndpoint: 'https://derived.example' });
  await expect(target.action(action('stageChunk'), { adminToken, jobId,
    chunk: JSON.stringify(archive.chunks.find(chunk => chunk.table === 'memories')) })).rejects.toThrow('BACKUP_PRIVACY_REDACTED');
  expect(() => assertLargeDerivativeClearedVisits({ index: 0, table: 'visitLedger',
    rows: [encodeRow({ visitId: 'removed-visit', state: 'COMPLETED' })] }, ['removed-visit'])).not.toThrow();
});

test('RAW derivative retains empty-world infrastructure and same-identity recovery gates', async () => {
  const source = await town(0);
  await source.t.run(async ctx => {
    await ctx.db.patch(source.worldId, { players: [], agents: [] });
    for (const binding of await ctx.db.query('residentModelBindings').collect()) await ctx.db.delete(binding._id);
    for (const runtime of await ctx.db.query('federationAgentRuntimes').collect()) await ctx.db.delete(runtime._id);
  });
  const derivative = await localDerivative(source, await exported(source.t));
  const request = { adminToken, manifest: derivative.manifest, signature: '', localProof: derivative.localProof,
    expectedLocalProofFingerprint: derivative.expectedLocalProofFingerprint };
  await expect(source.t.action(action('createImport'), { ...request, mode: 'restore', sourceStopped: false }))
    .rejects.toThrow('RESTORE_SOURCE_STOP_REQUIRED');
  const other = await town(0);
  await expect(other.t.action(action('createImport'), { ...request, mode: 'migrate', sourceStopped: true }))
    .rejects.toThrow('RESTORE_IDENTITY_PROOF_REQUIRED');
  const target = convexTest(schema, modules);
  const { jobId }: { jobId: Id<'backupLargeJobs'> } = await target.action(action('createImport'), {
    ...request, mode: 'clone', targetEndpoint: 'https://empty-derived.example' });
  for (const chunk of derivative.chunks) await target.action(action('stageChunk'), { adminToken, jobId, chunk: JSON.stringify(chunk) });
  await drive(target, jobId, 'import', 'READY');
  await target.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(target, jobId, 'import', 'COMPLETE');
  await target.run(async ctx => {
    const world = (await ctx.db.query('worlds').unique())!;
    expect(world.agents).toEqual([]);
    expect(world.players).toEqual([]);
    const status = (await ctx.db.query('worldStatus').unique())!;
    expect(status.worldId).toBe(world._id);
    expect(status.status).toBe('stoppedByDeveloper');
    expect((await ctx.db.get(status.engineId))!.running).toBe(false);
    expect((await ctx.db.query('maps').unique())!.worldId).toBe(world._id);
  });
});

test('RAW entry explicitly rejects a valid locally signed SELECTIVE derivative', async () => {
  const source = await town(0), archive = await exported(source.t);
  const chunks = archive.chunks.filter(chunk => ['worlds', 'federationIdentity'].includes(chunk.table))
    .map((chunk, index) => ({ ...chunk, index }));
  const original: SelectiveManifest = { format: 'ai-town-selective-archive', version: 2, schemaVersion: 1,
    scope: 'config-only', source: archive.manifest.source, exportedAt: archive.manifest.exportedAt,
    exportId: 'selective-fixture', chunks: await Promise.all(chunks.map(descriptor)),
    selection: { scope: 'config-only', owners: [], categories: ['configuration'], from: null, to: null,
      includePublicPeers: false, dependencyPolicy: 'same-owner-evidence-and-public-context',
      timePolicy: 'event-time-else-creation-time-half-open' }, usage: 'selective-transfer', operator: 'fixture', reason: 'fixture' };
  const signature = await sign(original, source.keys.privateKeyEncrypted);
  const local = await createLocalChunkManifest({ archiveId: 'selective-derived', derivedAt: 2,
    clearedVisits: ['removed-visit'], chunks: original.chunks.map(chunk => ({ ...chunk,
      role: 'EXPORT', encoding: 'SELECTIVE' })),
    sourceEvidence: { manifest: original, signature, publicKey: source.keys.publicKey, digest: await digest(original) } });
  const proof = await createLocalArchiveProof(local, { townId: original.source.townId, publicKey: source.keys.publicKey },
    value => sign(value, source.keys.privateKeyEncrypted));
  await expect(validateLargeImportManifest(local, '', proof, undefined, `sha256:${await digest(proof.publicKey)}`))
    .rejects.toThrow('SELECTIVE_ARCHIVE_USE_SELECTIVE_API');
});

test('RAW staging rechecks its persisted proof, signer pin and manifest digest before storing any chunk', async () => {
  const source = await town(0), derivative = await localDerivative(source, await exported(source.t));
  const target = convexTest(schema, modules);
  const { jobId }: { jobId: Id<'backupLargeJobs'> } = await target.action(action('createImport'), { adminToken,
    manifest: derivative.manifest, signature: '', localProof: derivative.localProof,
    expectedLocalProofFingerprint: derivative.expectedLocalProofFingerprint,
    mode: 'clone', targetEndpoint: 'https://proof-fenced.example' });
  const original = (await target.run(ctx => ctx.db.get(jobId)))!;
  const beforeObjects = await target.run(ctx => ctx.db.system.query('_storage').collect());
  for (const [changes, expectedError] of [
    [{ archiveLocalProofFingerprint: 'sha256:wrong' }, 'SIGNER_MISMATCH'],
    [{ archiveLocalManifestDigest: await digest({ altered: true }) }, 'DIGEST_MISMATCH'],
    [{ archiveLocalProof: { ...derivative.localProof, signature: 'invalid' } }, 'LOCAL_PROOF_INVALID'],
  ] as const) {
    await target.run(ctx => ctx.db.patch(jobId, { metadata: { ...original.metadata, ...changes } }));
    await expect(target.action(action('stageChunk'), { adminToken, jobId, chunk: JSON.stringify(derivative.chunks[0]) }))
      .rejects.toThrow(expectedError);
    expect(await target.run(ctx => ctx.db.query('backupLargeChunks').collect())).toEqual([]);
    expect(await target.run(ctx => ctx.db.system.query('_storage').collect())).toEqual(beforeObjects);
  }
  await target.run(ctx => ctx.db.patch(jobId, { metadata: original.metadata }));
  await target.action(action('stageChunk'), { adminToken, jobId, chunk: JSON.stringify(derivative.chunks[0]) });
  expect(await target.run(ctx => ctx.db.query('backupLargeChunks').collect())).toHaveLength(1);
});

test.each(['clone', 'restore', 'migrate'] as const)('real RAW export, sensitive clear, derivative export and formal %s retain other prose and stopped runtime', async mode => {
  let checkpoint = 'source setup';
  try {
    const source = await town(0);
    const deletedSourceIds = await source.t.run(async ctx => {
      const erased: Id<'memories'>[] = [];
      for (const [visitId, description] of [['removed-visit', 'selected-private-travel-prose'],
        ['retained-visit', 'other-private-travel-prose']]) {
        const memoryId = await ctx.db.insert('memories', { worldId: source.worldId, playerId: 'p:0', agentGlobalId: source.agentGlobalId,
          description, importance: 8, lastAccess: 1, data: { type: 'travel', visitId, eventId: `${visitId}-event`,
            hostTownId: 'foreign', participants: [], occurredAt: 1 } });
        if (visitId === 'removed-visit') {
          erased.push(memoryId);
          erased.push(await ctx.db.insert('memories', { worldId: source.worldId, playerId: 'p:0', agentGlobalId: source.agentGlobalId,
            description: 'selected-private-reflection-prose', importance: 8, lastAccess: 1,
            data: { type: 'reflection', relatedMemoryIds: [memoryId] } }));
        }
        await ctx.db.insert('visitLedger', { visitId, worldId: source.worldId, homePlayerId: 'p:0',
          agentGlobalId: source.agentGlobalId, homeTownId: 'town:large', hostTownId: 'foreign',
          homeDeploymentEpoch: 1, hostDeploymentEpoch: 1, agentAuthorityEpoch: 1, visitLeaseVersion: 1,
          leaseExpiry: 1, state: 'COMPLETED', role: 'home', fencingToken: 'fixture-fence', profile: {}, createdAt: 1, updatedAt: 1 });
      }
      return erased;
    });
    checkpoint = 'original export';
    const { jobId: exportJobId } = await source.t.mutation(mutation('startExport'), { adminToken });
    await drive(source.t, exportJobId, 'export', 'COMPLETE');
    const original = await source.t.action(action('getManifest'), { adminToken, jobId: exportJobId });
    const originalManifest = original.manifest as LargeManifest;
    jest.useFakeTimers();
    try {
      checkpoint = 'first privacy inspection';
      const privacyJobId: Id<'travelPrivacyJobs'> = await source.t.mutation(makeFunctionReference<'mutation'>('federation/travelPrivacy:inspect'), {
        adminToken, visitId: 'removed-visit', scope: 'SENSITIVE' });
      await source.t.finishAllScheduledFunctions(() => jest.runAllTimers(), 2000);
      expect((await source.t.run(ctx => ctx.db.get(privacyJobId)))!.state).toBe('READY');
      checkpoint = 'first privacy clear';
      await source.t.mutation(makeFunctionReference<'mutation'>('federation/travelPrivacy:start'), { adminToken, jobId: privacyJobId });
      await drivePrivacyWithStorageMetadata(source.t, privacyJobId);
      expect((await source.t.run(ctx => ctx.db.get(privacyJobId)))!.state).toBe('COMPLETE');
    } finally { jest.useRealTimers(); }
    checkpoint = 'derivative export';
    const derived = await source.t.action(action('getManifest'), { adminToken, jobId: exportJobId });
    const local = derived.manifest as LocalSanitizedChunkManifest;
    expect(local.format).toBe('ai-town-local-sanitized-chunks');
    expect(local.sourceSignatureValid).toBe(false);
    expect(derived.signature).toBe('');
    expect(derived.localProof).toBeDefined();
    expect(local.sourceEvidence.manifest).toEqual(originalManifest);
    expect(await verifySignature(originalManifest, local.sourceEvidence.signature, local.sourceEvidence.publicKey)).toBe(true);
    expect(await verifySignature(local, local.sourceEvidence.signature, local.sourceEvidence.publicKey)).toBe(false);
    const chunks: LargeChunk[] = [];
    for (const entry of local.chunks) chunks.push(JSON.parse(await source.t.action(action('getChunk'), { adminToken,
      jobId: exportJobId, index: entry.index })));
    expect(JSON.stringify(chunks)).not.toContain('selected-private-travel-prose');
    expect(JSON.stringify(chunks)).not.toContain('selected-private-reflection-prose');
    expect(JSON.stringify(chunks)).toContain('other-private-travel-prose');
    const target = mode === 'clone' ? convexTest(schema, modules) : source.t;
    checkpoint = 'formal derivative import creation';
    const { jobId }: { jobId: Id<'backupLargeJobs'> } = await target.action(action('createImport'), { adminToken,
      manifest: local, signature: '', localProof: derived.localProof, sourceSignatureValid: false,
      expectedLocalProofFingerprint: `sha256:${await digest(derived.localProof!.publicKey)}`,
      mode, sourceStopped: true, ...(mode === 'clone' ? { targetEndpoint: 'https://local-derived-copy.example' } : {}) });
    checkpoint = 'formal derivative staging';
    for (const chunk of chunks) await target.action(action('stageChunk'), { adminToken, jobId, chunk: JSON.stringify(chunk) });
    for (const page of local.privacyChunks ?? []) {
      const chunk = await source.t.action(makeFunctionReference<'action'>('federation/backupPrivacyChunks:getChunk'), { adminToken, jobId: exportJobId, pageNumber: page.index });
      await target.action(makeFunctionReference<'action'>('federation/backupPrivacyChunks:stageChunk'), { adminToken, jobId, pageNumber: page.index, chunk: JSON.stringify(chunk) });
    }
    checkpoint = 'formal derivative preflight';
    await drive(target, jobId, 'import', 'READY');
    checkpoint = 'formal derivative apply';
    await target.mutation(mutation('startApply'), { adminToken, jobId });
    await drive(target, jobId, 'import', 'COMPLETE');
    const restored = await retainedState(target);
    expect(restored.memories.map(memory => memory.description)).toEqual(['other-private-travel-prose']);
    expect(restored.worlds[0].agents).toHaveLength(1);
    expect(await target.run(ctx => ctx.db.query('engines').filter(q => q.eq(q.field('running'), true)).collect())).toEqual([]);
    expect(await target.run(ctx => ctx.db.query('visitLedger').collect())).toEqual([]);
    expect(await target.run(ctx => ctx.db.query('travelPrivacyTombstones').withIndex('key', q => q.eq('key', 'visit:removed-visit')).unique())).toBeTruthy();
    for (const id of deletedSourceIds) {
      expect(await target.run(ctx => ctx.db.query('travelPrivacyTombstones').withIndex('key', q => q.eq('key', `memory:${id}`)).unique())).toBeTruthy();
      await expect(target.run(ctx => assertBackupPrivacy(ctx.db, { memories: [{ _id: id, worldId: source.worldId,
        data: { type: 'reflection', relatedMemoryIds: [] }, description: 'old private reflection attempt' }] }, originalManifest.source.townId)))
        .rejects.toThrow('BACKUP_PRIVACY_REDACTED');
    }
    const imported = (await target.run(ctx => ctx.db.query('backupImports').order('desc').first()))!;
    expect(imported.manifest.sourceSignatureValid).toBe(false);
    expect(imported.sourceTownId).toBe(originalManifest.source.townId);
    expect(restored.identity[0].townId === originalManifest.source.townId).toBe(mode !== 'clone');
    if (mode === 'clone') {
      checkpoint = 'imported derivative second inspection';
      const candidates = await target.query(makeFunctionReference<'query'>('federation/travelPrivacy:historicalCandidates'), {
        adminToken, visitId: 'retained-visit', paginationOpts: { cursor: null, numItems: 5 } });
      expect(candidates.page).toHaveLength(1);
      jest.useFakeTimers();
      try {
        const secondPrivacyJobId: Id<'travelPrivacyJobs'> = await target.mutation(makeFunctionReference<'mutation'>('federation/travelPrivacy:inspect'), {
          adminToken, visitId: 'retained-visit', scope: 'SENSITIVE', history: candidates.page[0].history });
        await target.finishAllScheduledFunctions(() => jest.runAllTimers(), 2000);
        expect((await target.run(ctx => ctx.db.get(secondPrivacyJobId)))!.state).toBe('READY');
        checkpoint = 'imported derivative second clear';
        await target.mutation(makeFunctionReference<'mutation'>('federation/travelPrivacy:start'), { adminToken, jobId: secondPrivacyJobId });
        await drivePrivacyWithStorageMetadata(target, secondPrivacyJobId);
        expect((await target.run(ctx => ctx.db.get(secondPrivacyJobId)))!.state).toBe('COMPLETE');
        expect(await target.run(ctx => ctx.db.query('memories').collect())).toEqual([]);
      } finally { jest.useRealTimers(); }
    }
  } catch (error) {
    throw new Error(`RAW_${mode}_${checkpoint}: ${error instanceof Error ? error.message : String(error)}`);
  }
});

test('large import detects a conflicting deletion record in a later chunk before touching destination data', async () => {
  const source = await town(1);
  await source.t.run(ctx => ctx.db.insert('travelPrivacyTombstones', {
    key: `memory:${source.memoryIds[0]}`, visitId: 'cleared', createdAt: 1,
    worldId: source.worldId, playerId: 'p:0', ownerGlobalId: source.agentGlobalId,
  }));
  const archive = await exported(source.t);
  expect(archive.chunks.findIndex(chunk => chunk.table === 'travelPrivacyTombstones'))
    .toBeGreaterThan(archive.chunks.findIndex(chunk => chunk.table === 'memories'));
  const target = convexTest(schema, modules), before = await retainedState(target);
  const jobId = await staged(target, archive, 'clone');
  await expect(drive(target, jobId, 'import', 'READY')).rejects.toThrow('BACKUP_PRIVACY_REDACTED');
  expect(await retainedState(target)).toEqual(before);
});

test('large clone carries original and mapped deletion keys with destination ownership', async () => {
  const source = await town(1);
  await source.t.run(ctx => ctx.db.insert('travelPrivacyTombstones', {
    key: `conversation:${source.worldId}:c:cleared`, visitId: 'cleared', createdAt: 1,
    worldId: source.worldId, playerIds: ['p:0'],
  }));
  const archive = await exported(source.t), target = convexTest(schema, modules);
  const jobId = await staged(target, archive, 'clone');
  await drive(target, jobId, 'import', 'READY');
  await target.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(target, jobId, 'import', 'COMPLETE');
  const result = await target.run(async ctx => ({
    world: await ctx.db.query('worlds').unique(), graves: await ctx.db.query('travelPrivacyTombstones').collect(),
  }));
  expect(result.graves.map(row => row.key).sort()).toEqual([
    `conversation:${source.worldId}:c:cleared`, `conversation:${result.world!._id}:c:cleared`,
  ].filter((key, index, all) => all.indexOf(key) === index).sort());
  expect(result.graves.every(row => row.worldId === result.world!._id)).toBe(true);
});

test('large destructive cancellation does not erase local deletion history', async () => {
  const source = await town(1), archive = await exported(source.t);
  const original = { key: 'memory:unrelated-cleared', visitId: 'cleared', createdAt: 1,
    worldId: source.worldId, playerId: 'p:0', ownerGlobalId: source.agentGlobalId };
  await source.t.run(ctx => ctx.db.insert('travelPrivacyTombstones', original));
  const jobId = await staged(source.t, archive);
  await drive(source.t, jobId, 'import', 'READY');
  await source.t.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(source.t, jobId, 'import', 'MEMORY_PROVENANCE');
  await source.t.mutation(mutation('cancel'), { adminToken, jobId });
  await drive(source.t, jobId, 'import', 'CANCELLED');
  const restoredWorld = await source.t.run(ctx => ctx.db.query('worlds').unique());
  expect(await source.t.run(ctx => ctx.db.query('travelPrivacyTombstones').unique()))
    .toMatchObject({ ...original, worldId: restoredWorld!._id });
  const resident = await source.t.query(makeFunctionReference<'query'>('federation/backup:getResident'), {
    adminToken, worldId: restoredWorld!._id, playerId: 'p:0',
  });
  expect(resident.sections.travelPrivacyTombstones.map(decodeRow).map((row: any) => row.key)).toContain(original.key);
});

test('large local deletion ownership remaps in durable pages and remains resident-exportable', async () => {
  const source = await town(1), archive = await exported(source.t);
  await source.t.run(async ctx => {
    for (let i = 0; i < 61; i++) await ctx.db.insert('travelPrivacyTombstones', {
      key: `memory:local-cleared-${i}`, visitId: `local-cleared-${i}`, createdAt: 1,
      worldId: source.worldId, playerId: 'p:0', ownerGlobalId: source.agentGlobalId,
    });
  });
  const jobId = await staged(source.t, archive);
  await drive(source.t, jobId, 'import', 'READY');
  await source.t.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(source.t, jobId, 'import', 'PRIVACY_REMAP');
  await source.t.action(action('advanceImport'), { adminToken, jobId });
  const checkpoint = await source.t.run(async ctx => ({ job: await ctx.db.get(jobId),
    world: await ctx.db.query('worlds').unique(), graves: await ctx.db.query('travelPrivacyTombstones').collect() }));
  expect(checkpoint.job!.phase).toBe('PRIVACY_REMAP');
  expect(checkpoint.job!.cursor).not.toBeNull();
  expect(checkpoint.graves.filter(row => row.worldId === checkpoint.world!._id)).toHaveLength(20);
  await drive(source.t, jobId, 'import', 'COMPLETE');
  const resident = await source.t.query(makeFunctionReference<'query'>('federation/backup:getResident'), {
    adminToken, worldId: checkpoint.world!._id, playerId: 'p:0',
  });
  expect(resident.sections.travelPrivacyTombstones).toHaveLength(61);
});

test('cancellation after local privacy remapping follows partial world aliases into rollback ownership', async () => {
  const source = await town(1), archive = await exported(source.t);
  await source.t.run(ctx => ctx.db.insert('travelPrivacyTombstones', {
    key: `conversation:${source.worldId}:c:removed`, visitId: 'cleared', createdAt: 1,
    worldId: source.worldId, playerIds: ['p:0'],
  }));
  const jobId = await staged(source.t, archive);
  await drive(source.t, jobId, 'import', 'READY');
  await source.t.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(source.t, jobId, 'import', 'FINALIZE');
  await source.t.mutation(mutation('cancel'), { adminToken, jobId });
  await drive(source.t, jobId, 'import', 'CANCELLED');
  const result = await source.t.run(async ctx => ({ world: await ctx.db.query('worlds').unique(),
    graves: await ctx.db.query('travelPrivacyTombstones').collect() }));
  expect(result.graves.every(row => row.worldId === result.world!._id)).toBe(true);
  expect(result.graves.some(row => row.key === `conversation:${result.world!._id}:c:removed`)).toBe(true);
});

test.each(['restore', 'rollback'] as const)('local deletion ownership follows a prior large restore during a later %s', async mode => {
  const source = await town(1), archive = await exported(source.t);
  const first = await staged(source.t, archive);
  await drive(source.t, first, 'import', 'READY');
  await source.t.mutation(mutation('startApply'), { adminToken, jobId: first });
  await drive(source.t, first, 'import', 'COMPLETE');
  const previousWorld = await source.t.run(ctx => ctx.db.query('worlds').unique());
  await source.t.run(ctx => ctx.db.insert('travelPrivacyTombstones', {
    key: `conversation:${previousWorld!._id}:c:removed`, visitId: 'cleared-after-first-restore', createdAt: 1,
    worldId: previousWorld!._id, playerIds: ['p:0'],
  }));
  const second = await staged(source.t, archive);
  await drive(source.t, second, 'import', 'READY');
  await source.t.mutation(mutation('startApply'), { adminToken, jobId: second });
  await drive(source.t, second, 'import', 'FINALIZE');
  if (mode === 'rollback') await source.t.mutation(mutation('cancel'), { adminToken, jobId: second });
  await drive(source.t, second, 'import', mode === 'rollback' ? 'CANCELLED' : 'COMPLETE');
  const result = await source.t.run(async ctx => ({ world: await ctx.db.query('worlds').unique(),
    graves: await ctx.db.query('travelPrivacyTombstones').collect() }));
  expect(result.graves.every(row => row.worldId === result.world!._id)).toBe(true);
  const resident = await source.t.query(makeFunctionReference<'query'>('federation/backup:getResident'), {
    adminToken, worldId: result.world!._id, playerId: 'p:0',
  });
  expect(resident.sections.travelPrivacyTombstones.map(decodeRow).map((row: any) => row.key))
    .toContain(`conversation:${result.world!._id}:c:removed`);
});

test('legacy large manifests may omit the optional deletion-history section', async () => {
  const source = await town(1), archive = await exported(source.t);
  archive.chunks = archive.chunks.filter(chunk => chunk.table !== 'travelPrivacyTombstones').map((chunk, index) => ({ ...chunk, index }));
  archive.manifest.chunks = await Promise.all(archive.chunks.map(descriptor));
  archive.signature = await sign(archive.manifest, source.keys.privateKeyEncrypted);
  const target = convexTest(schema, modules), jobId = await staged(target, archive, 'clone');
  await drive(target, jobId, 'import', 'READY');
  await target.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(target, jobId, 'import', 'COMPLETE');
  expect(await target.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toEqual([]);
});

test('old source memory IDs follow durable large-clone mappings after destination clearing', async () => {
  const source = await town(1), archive = await exported(source.t), target = convexTest(schema, modules);
  const jobId = await staged(target, archive, 'clone');
  await drive(target, jobId, 'import', 'READY');
  await target.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(target, jobId, 'import', 'COMPLETE');
  await target.run(async ctx => {
    const memory = (await ctx.db.query('memories').unique())!;
    await ctx.db.insert('travelPrivacyTombstones', { key: `memory:${memory._id}`, visitId: 'cleared-after-clone',
      createdAt: 1, worldId: memory.worldId, playerId: memory.playerId, ownerGlobalId: memory.agentGlobalId });
    await ctx.db.delete(memory._id);
  });
  const rows = archive.chunks.filter(chunk => chunk.table === 'memories').flatMap(chunk => chunk.rows.map(decodeRow));
  await expect(target.run(ctx => assertBackupPrivacy(ctx.db, { memories: rows }, archive.manifest.source.townId)))
    .rejects.toThrow('BACKUP_PRIVACY_REDACTED');
});

test.each(['current', 'changed source', 'legacy without complete evidence'])('memory provenance large-town clone retains %s evidence and drops executable claims', async variant => {
  const source = await town(1);
  await source.t.run(async ctx => {
    await ctx.db.patch(source.memoryIds[0], { data: { type: 'travel', eventId: 'memory-evidence', visitId: 'fixture-visit', hostTownId: 'fixture-host', participants: [], occurredAt: 1 } });
    await seedMemoryBackupEvidence(ctx, source.memoryIds[0]);
  });
  if (variant === 'changed source') await source.t.run(ctx => ctx.db.patch(source.memoryIds[0], { data: { type: 'travel', eventId: 'memory-evidence', visitId: 'fixture-visit', hostTownId: 'fixture-host', participants: [], occurredAt: 2 } }));
  if (variant === 'legacy without complete evidence') await source.t.run(ctx => useLegacyMemoryBackupDigests(ctx));
  const archive = await exported(source.t);
  const target = convexTest(schema, modules), jobId = await staged(target, archive, 'clone');
  await drive(target, jobId, 'import', 'READY');
  await target.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(target, jobId, 'import', 'COMPLETE');
  const copied = await target.run(ctx => assertMemoryBackupEvidence(ctx, true, variant === 'current'));
  expect(copied.memory._id).not.toBe(source.memoryIds[0]);
  expect(copied.memory.description).toBe('Canonical memory 0');
});

test('memory provenance destructive cancellation restores readable original correction evidence', async () => {
  const source = await town(1);
  await source.t.run(async ctx => {
    await ctx.db.patch(source.memoryIds[0], { data: { type: 'travel', eventId: 'memory-evidence', visitId: 'fixture-visit', hostTownId: 'fixture-host', participants: [], occurredAt: 1 } });
    await seedMemoryBackupEvidence(ctx, source.memoryIds[0]);
  });
  const archive = await exported(source.t), jobId = await staged(source.t, archive);
  await drive(source.t, jobId, 'import', 'READY');
  await source.t.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(source.t, jobId, 'import', 'MEMORY_PROVENANCE');
  await source.t.mutation(mutation('cancel'), { adminToken, jobId });
  await drive(source.t, jobId, 'import', 'CANCELLED');
  const restored = await source.t.run(ctx => assertMemoryBackupEvidence(ctx));
  expect(restored.memory.description).toBe('Canonical memory 0');
});

test('chunked restore retains provider/profile/resident policy without exporting request telemetry', async () => {
  const { t } = await town();
  await t.run(async ctx => {
    const profile = (await ctx.db.query('chatProfiles').unique())!;
    const binding = (await ctx.db.query('residentModelBindings').unique())!;
    await ctx.db.patch(profile._id, { dailyRequestLimit: 6 });
    await ctx.db.patch(binding._id, { requestQuotas: { chat: 2, embedding: 0 } });
    await ctx.db.insert('modelProviderQuotas', { kind: 'CHAT', providerKey: '["custom","https://chat.example"]', maxRequestsPerDay: 9, updatedAt: 1 });
  });
  const archive = await exported(t);
  expect(archive.chunks.some(c => c.table === 'modelProviderQuotas' && c.rows.length === 1)).toBe(true);
  expect(archive.chunks.some(c => ['modelUsageBuckets', 'modelCallReceipts'].includes(c.table))).toBe(false);
  const jobId = await staged(t, archive);
  await drive(t, jobId, 'import', 'READY');
  await t.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(t, jobId, 'import', 'COMPLETE');
  expect(await t.run(ctx => ctx.db.query('modelProviderQuotas').unique())).toMatchObject({ maxRequestsPerDay: 9 });
  expect(await t.run(ctx => ctx.db.query('chatProfiles').unique())).toMatchObject({ dailyRequestLimit: 6 });
  expect(await t.run(ctx => ctx.db.query('residentModelBindings').unique())).toMatchObject({ requestQuotas: { chat: 2, embedding: 0 } });
});

test('large signed export and restore preserve all canonical memories, cyclic references and fixed model ownership', async () => {
  const { t, agentGlobalId } = await town(510);
  await t.run(ctx => ctx.db.insert('federationTravelAudit', { visitId: 'historical', source: 'visitLedger', operation: 'UPDATED', at: 7, next: { state: 'COMPLETED' } }));
  const archive = await exported(t);
  expect(archive.manifest.chunks.filter(c => c.table === 'federationTravelAudit').reduce((n, c) => n + c.count, 0)).toBe(1);
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
    travelAudit: await ctx.db.query('federationTravelAudit').collect(),
  }));
  expect(result.travelAudit).toEqual([expect.objectContaining({ at: 7, visitId: 'historical', operation: 'UPDATED', next: { state: 'COMPLETED' } })]);
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
    const sourceRecoveryAt = Date.now() + 86400000;
    await t.run(async ctx => {
      await ctx.db.patch(engineId, { processedInputNumber: 58, lastRecoveryAt: sourceRecoveryAt });
      await ctx.db.insert('inputs', { engineId, number: 58, name: 'join', args: {}, received: 1, returnValue: { kind: 'ok', value: 'source-only-input' } });
    });
    const archive = await exported(t);
    const sourceEngine = archive.chunks.find(c => c.table === 'engines' && c.rows.length)!;
    expect(decodeRow(sourceEngine.rows[0]).processedInputNumber).toBe(58);
    expect(decodeRow(sourceEngine.rows[0]).lastRecoveryAt).toBe(sourceRecoveryAt);
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
      expect(engine.lastRecoveryAt).toBeUndefined();
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

test('legacy signed large manifests without optional autonomy, resource, travel audit and cold file sections still restore', async () => {
  const { t, keys } = await town();
  const archive = await exported(t);
  archive.chunks = archive.chunks.filter(c => !c.table.startsWith('autonomousTravel') && !c.table.startsWith('federationResource') && c.table !== 'coldHistoryFiles' && c.table !== 'federationTravelAudit')
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
    await ctx.db.insert('federationResourcePolicy', { maxVisitorsPerSourceTown: 3, maxRemoteEventsPerSecond: 5 });
    await ctx.db.insert('federationResourceAudit', { operation: 'SOURCE_QUOTA_CHANGED', previous: null, next: 3, createdAt: 1 });
    await ctx.db.insert('federationResourceMetrics', { kind: 'INBOUND_EVENT', bucketStart: Date.now(), count: 1, durationCount: 0, durationSumMs: 0, samples: [] });
  });
  expect(largeTables.filter(t => !['coldHistoryFiles', 'modelMemoryVectors'].includes(t)).slice(-5)).toEqual(['autonomousTravelPolicies', 'autonomousTravelDecisions', 'federationResourcePolicy', 'federationResourceAudit', 'travelPrivacyTombstones']);
  expect(oldTables).not.toContain('travelPrivacyTombstones');
  expect(oldTables.slice(-4)).toEqual(['autonomousTravelPolicies', 'autonomousTravelDecisions', 'federationResourcePolicy', 'federationResourceAudit']);
  const archive = await exported(t);
  expect(archive.manifest.chunks.some(c => c.table === 'federationResourceMetrics')).toBe(false);
  expect(archive.manifest.chunks.some(c => c.table === 'federationInboundBudget')).toBe(false);
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
  expect(result.policy!.maxRemoteEventsPerSecond).toBe(5);
  expect(result.audit).toHaveLength(mode === 'rollback' ? 2 : 1);
  expect(result.audit.some(row => row.createdAt === 1 && row.next === 3)).toBe(true);
  expect(result.metrics).toHaveLength(mode === 'clone' ? 0 : 1);
});

test('backup preflight rejects invalid quota and identity capacity limits before applying data', async () => {
  for (const maxRemoteEventsPerSecond of [-1, 0.5, 1001])
    expect(() => validateSourceRow('federationResourcePolicy', {
      _id: 'invalid-rate', _creationTime: 1, maxVisitorsPerSourceTown: null, maxRemoteEventsPerSecond,
    })).toThrow('INVALID_REMOTE_EVENT_RATE');
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

test('formal large clone supplies terminal historical evidence for privacy cleanup without executable leases', async () => {
  const source = await town(1);
  await source.t.run(async ctx => {
    await ctx.db.patch(source.memoryIds[0], { data: { type: 'travel', visitId: 'large-history',
      eventId: 'history-event', hostTownId: 'foreign', participants: [], occurredAt: 1 } });
    await ctx.db.insert('visitLedger', { visitId: 'large-history', worldId: source.worldId,
      homePlayerId: 'p:0', agentGlobalId: source.agentGlobalId, homeTownId: 'town:large', hostTownId: 'foreign',
      homeDeploymentEpoch: 1, hostDeploymentEpoch: 1, agentAuthorityEpoch: 1, visitLeaseVersion: 1,
      leaseExpiry: 1, state: 'COMPLETED', role: 'home', fencingToken: 'source-fence',
      profile: {}, createdAt: 1, updatedAt: 1 });
  });
  const archive = await exported(source.t), target = convexTest(schema, modules);
  const importJobId = await staged(target, archive, 'clone');
  await drive(target, importJobId, 'import', 'READY');
  await target.mutation(mutation('startApply'), { adminToken, jobId: importJobId });
  await drive(target, importJobId, 'import', 'COMPLETE');
  await target.run(async ctx => {
    for (const scheduled of await ctx.db.system.query('_scheduled_functions').collect())
      await ctx.scheduler.cancel(scheduled._id);
  });
  const candidates = await target.query(makeFunctionReference<'query'>('federation/travelPrivacy:historicalCandidates'), {
    adminToken, visitId: 'large-history', paginationOpts: { cursor: null, numItems: 5 },
  });
  expect(candidates.page).toHaveLength(1);
  const ledger = await target.run(async ctx => (await ctx.db.query('backupLargeRows')
    .withIndex('job_relation', q => q.eq('jobId', importJobId).eq('role', 'SOURCE')
      .eq('table', 'visitLedger').eq('relationKey', 'visit:large-history')).unique())!);
  await target.run(ctx => ctx.db.patch(ledger._id, { metadata: { ...ledger.metadata, state: undefined } }));
  await expect(target.mutation(makeFunctionReference<'mutation'>('federation/travelPrivacy:inspect'), {
    adminToken, visitId: 'large-history', scope: 'SENSITIVE', history: candidates.page[0].history,
  })).rejects.toThrow('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
  await target.run(ctx => ctx.db.patch(ledger._id, { metadata: ledger.metadata }));
  // A real local export supplies a second physical copy of the imported travel memory.
  await exported(target);
  jest.useFakeTimers();
  try {
    const jobId: Id<'travelPrivacyJobs'> = await target.mutation(makeFunctionReference<'mutation'>('federation/travelPrivacy:inspect'), {
      adminToken, visitId: 'large-history', scope: 'SENSITIVE', history: candidates.page[0].history,
    });
    await target.finishAllScheduledFunctions(() => jest.runAllTimers(), 2000);
    expect((await target.run(ctx => ctx.db.get(jobId)))!.state).toBe('READY');
    const chunkObjects = await formalChunkPlan(target, jobId);
    expect(chunkObjects.some(o => o.role === 'SOURCE' && o.selectedRows > 0)).toBe(true);
    expect(chunkObjects.some(o => o.role === 'EXPORT' && o.selectedRows > 0)).toBe(true);
    expect(chunkObjects.filter(o => o.role === 'SOURCE').every(o => o.sourceSignature === archive.signature &&
      o.sourcePublicKey === archive.manifest.source.publicKey)).toBe(true);
    const selectedSource = await target.run(ctx => ctx.db.query('travelPrivacyChunkRows').withIndex('selected', q =>
      q.eq('scanId', chunkObjects[0].scanId).eq('selected', true)).collect());
    expect(selectedSource).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'SOURCE',
      evidence: expect.objectContaining({ table: 'memories', sourceId: source.memoryIds[0], ownerGlobalId: source.agentGlobalId }) })]));
    for (const object of chunkObjects) {
      const stored = await target.action(async ctx => {
        const blob = await ctx.storage.get(object.originalStorageId);
        return blob ? descriptor(JSON.parse(await blob.text())) : null;
      });
      expect(stored).toEqual(object.descriptor);
    }
    await target.mutation(makeFunctionReference<'mutation'>('federation/travelPrivacy:start'), { adminToken, jobId });
    // Complete-generation preflight is repeated after each emulated lost upload ACK.
    await drivePrivacyWithStorageMetadata(target, jobId, 5000);
    await target.run(async ctx => {
      const completed = (await ctx.db.get(jobId))!;
      if (completed.state !== 'COMPLETE') throw new Error(JSON.stringify({ state: completed.state, phase: completed.phase, code: completed.archiveError }));
      expect(completed.state).toBe('COMPLETE');
      expect(await ctx.db.query('memories').collect()).toEqual([]);
      expect(await ctx.db.query('visitLedger').collect()).toEqual([]);
      expect((await ctx.db.get(ledger._id))!.metadata).toMatchObject({ visitId: 'large-history', state: 'COMPLETED' });
    });
  } finally { jest.useRealTimers(); }
});
test('clone creates a new identity and local global ownership while retaining prose and history', async () => {
  const { t } = await town();
  await t.run(async ctx => {
    const local = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(local._id, { endpointCandidates: [{ url: local.endpoint, priority: 10 }, { url: 'https://source-backup.example/federation/v1', priority: 20 }], endpointGeneration: 4, endpointSequence: 4 });
  });
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
  expect(result.local!.endpointCandidates).toEqual([{ url: 'https://copy.example/federation/v1', priority: 10 }]);
  expect(result.local!.endpointGeneration).toBe(0);
  expect(result.binding!.agentGlobalId).toBe(result.runtime!.agentGlobalId);
  expect(result.binding!.agentGlobalId).toContain(result.local!.townId);
  expect(result.memories[0].agentGlobalId).toBe(result.binding!.agentGlobalId);
  expect(result.memories[0].description).toBe('Canonical memory 0');
});

test('large clone carries verified cold files into an independent database with immutable source proof and mapped local ownership', async () => {
  const source = await town();
  const cold = await coldConversation(source);
  const before = await retainedState(source.t);
  const archive = await exported(source.t);
  const attachments = archive.chunks.filter(c => c.table === 'coldHistoryFiles').flatMap(c => c.rows.map(decodeRow));
  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toEqual({
    _id: cold.original._id, _creationTime: cold.original._creationTime,
    owner: { worldId: source.worldId, playerId: 'p:0', agentGlobalId: source.agentGlobalId, memoryId: cold.owner.memoryId },
    file: cold.file, authorAliases: [],
  });
  expect(JSON.stringify(attachments)).not.toMatch(/storageId|privateKeyEncrypted/);
  const destination = convexTest(schema, modules);
  const jobId = await staged(destination, archive, 'clone');
  await drive(destination, jobId, 'import', 'READY');
  await destination.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(destination, jobId, 'import', 'COMPLETE');
  const restored = await retainedState(destination);
  const binding = restored.bindings[0];
  const memory = restored.memories.find(m => m.description === 'Retained closed conversation')!;
  const owner = { adminToken, worldId: binding.worldId, playerId: binding.playerId, agentGlobalId: binding.agentGlobalId, memoryId: memory._id };
  expect(binding.worldId).not.toBe(source.worldId);
  expect(binding.agentGlobalId).not.toBe(source.agentGlobalId);
  expect(memory.worldId).toBe(binding.worldId);
  expect(memory.agentGlobalId).toBe(binding.agentGlobalId);
  expect(memory.embeddingId).toBeUndefined();
  expect(restored.embeddings).toEqual([]);
  expect(binding.chatProfileId).toBe(restored.profiles[0]._id);
  expect(restored.profiles[0].model).toBe('fixed');
  expect(restored.conversations[0].worldId).toBe(binding.worldId);
  expect(restored.history[0].worldId).toBe(binding.worldId);
  expect(restored.messages.every(m => m.worldId === binding.worldId)).toBe(true);
  const discovered = await destination.query(historyQuery('coldHistory:discover'), owner);
  expect(discovered).toMatchObject({ state: 'VERIFIED', count: 3 });
  const metadata = restored.coldArchives[0];
  expect(discovered.archiveId).toBe(metadata._id);
  expect(metadata.worldId).toBe(binding.worldId);
  expect(metadata.lookupKey).not.toBe(metadata.sourceKey);
  expect(JSON.parse(metadata.lookupKey!)[1]).toBe(binding.worldId);
  expect(metadata.manifest).toEqual(cold.file.manifest);
  expect(metadata.signature).toBe(cold.file.signature);
  expect(metadata.publicKey).toBe(cold.file.publicKey);
  expect(metadata.publicKey).not.toBe(restored.identity[0].publicKey);
  const read = await destination.action(historyAction('coldHistory:read'), { ...owner, offset: 0, numItems: 25 });
  expect(read.page).toEqual(cold.file.payload.messages);
  expect(await destination.action(historyAction('coldHistoryFiles:exportFile'), owner)).toEqual(cold.file);
  expect(await retainedState(source.t)).toEqual(before);
});

test('large clone preserves travel cold files while mapping their local owner and global authors on worldless transcript pages', async () => {
  const source = await town();
  const { owner, file: original } = await coldTravel(source);
  const before = await retainedState(source.t);
  const archive = await exported(source.t);
  expect(archive.chunks.filter(c => c.table === 'coldHistoryFiles').flatMap(c => c.rows)).toHaveLength(1);
  const destination = convexTest(schema, modules);
  const jobId = await staged(destination, archive, 'clone');
  await drive(destination, jobId, 'import', 'READY');
  await destination.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(destination, jobId, 'import', 'COMPLETE');
  const restored = await retainedState(destination);
  const binding = restored.bindings[0];
  const memory = restored.memories.find(m => m.description === 'Completed journey with retained original dialogue')!;
  const targetOwner = { ...owner, worldId: binding.worldId, agentGlobalId: binding.agentGlobalId, memoryId: memory._id };
  expect(binding.agentGlobalId).not.toBe(source.agentGlobalId);
  expect(memory).toMatchObject({ worldId: binding.worldId, agentGlobalId: binding.agentGlobalId });
  expect(restored.travelTranscripts[0]).toMatchObject({
    worldId: binding.worldId, agentGlobalId: binding.agentGlobalId, endMemoryId: memory._id,
    state: 'COMPLETE', summaryState: 'DONE',
  });
  expect(restored.travelPages[0].agentGlobalId).toBe(binding.agentGlobalId);
  expect(restored.travelPages[0].memoryIds).toEqual([memory._id]);
  expect(restored.travelPages[0]).not.toHaveProperty('worldId');
  expect(restored.travelPages[0].messages.map(m => m.author)).toEqual([
    binding.agentGlobalId, 'town:friend/visitor:bob', binding.agentGlobalId,
  ]);
  const read = await destination.action(historyAction('coldHistory:read'), { ...targetOwner, offset: 0, numItems: 25 });
  expect(read.page.map((m: any) => { const { targetAuthor, ...originalMessage } = m; return originalMessage; })).toEqual(original.payload.messages);
  expect(read.page[0].targetAuthor).toBe(binding.agentGlobalId);
  expect(read.page[1].authorGlobalId).toBe('town:friend/visitor:bob');
  expect(restored.coldArchives[0]).toMatchObject({
    worldId: binding.worldId, ownerGlobalId: binding.agentGlobalId,
    manifest: original.manifest, publicKey: original.publicKey, signature: original.signature,
    authorAliases: [{ sourceAuthor: source.agentGlobalId, targetAuthor: binding.agentGlobalId }],
  });
  expect(await destination.action(historyAction('coldHistoryFiles:exportFile'), targetOwner)).toEqual(original);
  expect(await retainedState(source.t)).toEqual(before);
});

test('an oversized encoded cold file fails large export explicitly without truncating its retained original', async () => {
  const source = await town();
  const cold = await coldConversation(source, 'x'.repeat(898900));
  expect(cold.file.manifest.bytes).toBeLessThan(MAX_CHUNK_BYTES);
  const attachment = {
    _id: cold.original._id, _creationTime: cold.original._creationTime,
    owner: { worldId: source.worldId, playerId: 'p:0', agentGlobalId: source.agentGlobalId, memoryId: cold.owner.memoryId },
    file: cold.file, authorAliases: [],
  };
  expect(size({ index: 0, table: 'coldHistoryFiles', rows: [encodeRow(attachment)] })).toBeGreaterThan(MAX_CHUNK_BYTES);
  const before = await retainedState(source.t);
  const { jobId } = await source.t.mutation(mutation('startExport'), { adminToken });
  let failed;
  for (let index = 0; index < 1000; index++) {
    failed = await source.t.action(action('advanceExport'), { adminToken, jobId });
    if (failed.state === 'FAILED') break;
    expect(failed.state).not.toBe('COMPLETE');
  }
  expect(failed).toMatchObject({ state: 'FAILED', table: 'coldHistoryFiles' });
  expect(failed!.error).toContain('BACKUP_SINGLE_DOCUMENT_BUDGET');
  expect(await retainedState(source.t)).toEqual(before);
  expect(await source.t.action(historyAction('coldHistoryFiles:exportFile'), cold.owner)).toEqual(cold.file);
  await expect(source.t.action(action('getManifest'), { adminToken, jobId })).rejects.toThrow('BACKUP_MANIFEST_NOT_READY');
  await source.t.mutation(mutation('cancel'), { adminToken, jobId });
});

test('a forged cold file signature is rejected while staging even when every outer checksum and signature is valid', async () => {
  const source = await town();
  await coldConversation(source);
  const archive = await exported(source.t);
  const chunk = archive.chunks.find(c => c.table === 'coldHistoryFiles' && c.rows.length)!;
  const attachment = decodeRow(chunk.rows[0]);
  attachment.file.signature = 'forged-inner-signature';
  chunk.rows[0] = encodeRow(attachment);
  archive.manifest.chunks[chunk.index] = await descriptor(chunk);
  archive.signature = await sign(archive.manifest, source.keys.privateKeyEncrypted);
  await validateManifest(archive.manifest, archive.signature);
  const before = await retainedState(source.t);
  const { jobId } = await source.t.action(action('createImport'), {
    adminToken, manifest: archive.manifest, signature: archive.signature, mode: 'restore', sourceStopped: true,
  });
  for (const row of archive.chunks.filter(c => c.index !== chunk.index))
    await source.t.action(action('stageChunk'), { adminToken, jobId, chunk: JSON.stringify(row) });
  await expect(source.t.action(action('stageChunk'), { adminToken, jobId, chunk: JSON.stringify(chunk) }))
    .rejects.toThrow('COLD_FILE_INTEGRITY_FAILED');
  expect(await retainedState(source.t)).toEqual(before);
  const state = await source.t.query(query('status'), { adminToken, jobId });
  expect(state.state).toBe('STAGING');
  expect(state.uploadedChunks).toBe(archive.chunks.length - 1);
  await source.t.mutation(mutation('cancel'), { adminToken, jobId });
  expect(await source.t.query(ctx => ctx.db.query('backupMaintenanceLocks').first())).toBeNull();
});

test('signed multi-file cold chunks are rejected before staging or creating an import job', async () => {
  const source = await town();
  await coldConversation(source);
  const archive = await exported(source.t);
  const chunk = archive.chunks.find(c => c.table === 'coldHistoryFiles' && c.rows.length)!;
  const duplicate = decodeRow(chunk.rows[0]);
  duplicate._id += ':duplicate';
  chunk.rows.push(encodeRow(duplicate));
  const expected = await descriptor(chunk);
  archive.manifest.chunks[chunk.index] = expected;
  archive.signature = await sign(archive.manifest, source.keys.privateKeyEncrypted);
  await expect(validateManifest(archive.manifest, archive.signature))
    .rejects.toThrow('BACKUP_COLD_FILES_CHUNK_BOUND_REQUIRED');
  await expect(validateChunk(chunk, expected))
    .rejects.toThrow('BACKUP_COLD_FILES_CHUNK_BOUND_REQUIRED');
  await expect(source.t.action(action('createImport'), {
    adminToken, manifest: archive.manifest, signature: archive.signature, mode: 'restore', sourceStopped: true,
  })).rejects.toThrow('BACKUP_COLD_FILES_CHUNK_BOUND_REQUIRED');
  expect(await source.t.run(ctx => ctx.db.query('backupLargeJobs').filter(q => q.eq(q.field('kind'), 'import')).collect())).toEqual([]);
  expect(await source.t.query(ctx => ctx.db.query('backupMaintenanceLocks').first())).toBeNull();
});

test.each(['same conversation owner', 'different conversation memory', 'different travel memory'])(
  'cold preflight claims local ranges across checkpoints and rejects %s before READY', async variant => {
    const source = await town();
    const cold = variant === 'different travel memory'
      ? await coldTravel(source) : await coldConversation(source);
    let duplicateMemoryId = cold.owner.memoryId;
    if (variant !== 'same conversation owner')
      duplicateMemoryId = await source.t.run(async ctx => {
        const { _id, _creationTime, ...memory } = (await ctx.db.get(cold.owner.memoryId))!;
        return ctx.db.insert('memories', { ...memory, description: 'Another memory of the same retained range' });
      });
    const before = await retainedState(source.t);
    const archive = await exported(source.t);
    const original = archive.chunks.find(c => c.table === 'coldHistoryFiles' && c.rows.length)!;
    const duplicate = decodeRow(original.rows[0]);
    duplicate._id += ':different-source-id';
    duplicate.owner.memoryId = duplicateMemoryId;
    // An independently signed original can describe the same local range. Its
    // foreign provenance key must not be used as the local deduplication key.
    const foreignKey = JSON.parse(duplicate.file.manifest.sourceKey);
    foreignKey[1] = 'foreign-original-world';
    duplicate.file.payload.sourceKey = JSON.stringify(foreignKey);
    duplicate.file.manifest.sourceKey = duplicate.file.payload.sourceKey;
    duplicate.file.manifest.bytes = size(duplicate.file.payload);
    duplicate.file.manifest.digest = await digest(duplicate.file.payload);
    duplicate.file.signature = await sign(duplicate.file.manifest, source.keys.privateKeyEncrypted);
    // Opt-in vector chunks now follow cold files. Keep this independently signed
    // duplicate in its declared table range so cold preflight is actually reached.
    const insertionIndex = archive.chunks.findLastIndex(chunk => chunk.table === 'coldHistoryFiles') + 1;
    const extra: LargeChunk = { index: insertionIndex, table: 'coldHistoryFiles', rows: [encodeRow(duplicate)] };
    archive.chunks.splice(insertionIndex, 0, extra);
    archive.chunks.forEach((chunk, index) => { chunk.index = index; });
    archive.manifest.chunks = await Promise.all(archive.chunks.map(descriptor));
    archive.signature = await sign(archive.manifest, source.keys.privateKeyEncrypted);
    const jobId = await staged(source.t, archive);
    await drive(source.t, jobId, 'import', 'VALIDATE_COLD');
    if (variant === 'same conversation owner') {
      await lostPublicationAck(source.t, largeFunctions.advanceImport, 'saveColdValidation', { adminToken, jobId });
      expect((await source.t.query(query('status'), { adminToken, jobId })).state).toBe('FAILED');
      await source.t.mutation(mutation('resume'), { adminToken, jobId });
    } else await source.t.action(action('advanceImport'), { adminToken, jobId });
    const checkpoint = (await source.t.run(ctx => ctx.db.get(jobId)))!;
    const claimed = await source.t.run(ctx => ctx.db.query('backupLargeRows')
      .withIndex('job_table', q => q.eq('jobId', jobId).eq('role', 'SOURCE').eq('table', 'coldHistoryFiles')).collect());
    expect(checkpoint.phase).toBe('VALIDATE_COLD');
    expect(claimed.filter(r => r.relationKey !== undefined)).toHaveLength(1);
    await expect(source.t.mutation(mutation('saveColdValidation'), {
      jobId, expectedCursor: null, cursor: checkpoint.cursor!, done: false,
      sourceIds: [decodeRow(original.rows[0])._id],
    })).rejects.toThrow('BACKUP_CHECKPOINT_CHANGED');
    const failed = await source.t.action(action('advanceImport'), { adminToken, jobId });
    expect(failed).toMatchObject({ state: 'FAILED', phase: 'VALIDATE_COLD' });
    expect(failed.error).toContain('BACKUP_COLD_FILES_DUPLICATE_SOURCE');
    expect((await source.t.run(ctx => ctx.db.get(jobId)))!.cursor).toBe(checkpoint.cursor);
    expect((await source.t.run(ctx => ctx.db.query('backupLargeRows')
      .withIndex('job_table', q => q.eq('jobId', jobId).eq('role', 'SOURCE').eq('table', 'coldHistoryFiles')).collect()))
      .filter(r => r.relationKey !== undefined)).toHaveLength(1);
    expect(await retainedState(source.t)).toEqual(before);
    expect(await source.t.run(ctx => ctx.db.query('backupLargeChunks')
      .withIndex('job_index', q => q.eq('jobId', jobId).gte('index', archive.chunks.length)).collect())).toEqual([]);
    await source.t.mutation(mutation('resume'), { adminToken, jobId });
    expect((await source.t.action(action('advanceImport'), { adminToken, jobId })).error)
      .toContain('BACKUP_COLD_FILES_DUPLICATE_SOURCE');
    await source.t.mutation(mutation('cancel'), { adminToken, jobId });
    expect(await source.t.query(ctx => ctx.db.query('backupMaintenanceLocks').first())).toBeNull();
  },
);

test('cold source closure preflight fails before live writes when signed outer history disagrees with an authentic cold file', async () => {
  const source = await town();
  await coldConversation(source);
  const archive = await exported(source.t);
  const chunk = archive.chunks.find(c => c.table === 'messages' && c.rows.length)!;
  const message = decodeRow(chunk.rows[0]);
  message.text = 'Outer source history contradicts the immutable original';
  chunk.rows[0] = encodeRow(message);
  archive.manifest.chunks[chunk.index] = await descriptor(chunk);
  archive.signature = await sign(archive.manifest, source.keys.privateKeyEncrypted);
  const before = await retainedState(source.t);
  const jobId = await staged(source.t, archive);
  let failed;
  for (let index = 0; index < 1000; index++) {
    failed = await source.t.action(action('advanceImport'), { adminToken, jobId });
    if (failed.state === 'FAILED') break;
    expect(failed.state).not.toBe('READY');
  }
  expect(failed).toMatchObject({ state: 'FAILED', phase: 'VALIDATE_COLD' });
  expect(failed!.error).toContain('BACKUP_COLD_FILES_MESSAGES_MISMATCH');
  expect(await retainedState(source.t)).toEqual(before);
  expect(await source.t.run(ctx => ctx.db.query('backupLargeChunks').withIndex('job_index', q => q.eq('jobId', jobId).gte('index', archive.chunks.length)).collect())).toEqual([]);
  await source.t.mutation(mutation('cancel'), { adminToken, jobId });
  expect(await source.t.query(ctx => ctx.db.query('backupMaintenanceLocks').first())).toBeNull();
});

test('cancelling after cold files were applied restores the original private file entity and readable remapped owner', async () => {
  const source = await town();
  const cold = await coldConversation(source);
  const archive = await exported(source.t);
  await source.t.run(ctx => ctx.db.patch(cold.owner.memoryId, { description: 'Target closed conversation newer than backup' }));
  const identity = await source.t.run(ctx => ctx.db.query('federationIdentity').unique());
  const jobId = await staged(source.t, archive);
  await drive(source.t, jobId, 'import', 'READY');
  await source.t.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(source.t, jobId, 'import', 'FINALIZE');
  const applied = await source.t.run(ctx => ctx.db.query('coldHistoryArchives').unique());
  expect(applied!.storageId).not.toBe(cold.original.storageId);
  expect(await source.t.run(async ctx => !!await ctx.storage.get(cold.original.storageId!))).toBe(true);
  await source.t.mutation(mutation('cancel'), { adminToken, jobId });
  await drive(source.t, jobId, 'import', 'CANCELLED');
  const restored = await retainedState(source.t);
  const binding = restored.bindings[0];
  const memory = restored.memories.find(m => m.description === 'Target closed conversation newer than backup')!;
  const owner = { adminToken, worldId: binding.worldId, playerId: binding.playerId, agentGlobalId: binding.agentGlobalId, memoryId: memory._id };
  expect(memory.worldId).toBe(binding.worldId);
  expect(memory.embeddingId).toBe(restored.embeddings[0]._id);
  expect(restored.embeddings[0].embedding).toEqual(Array.from({ length: EMBEDDING_DIMENSION }, () => 0.25));
  expect(restored.identity[0]).toEqual(identity);
  expect(restored.coldArchives).toHaveLength(1);
  expect(restored.coldArchives[0]).toMatchObject({
    storageId: cold.original.storageId, manifest: cold.file.manifest,
    signature: cold.file.signature, publicKey: cold.file.publicKey, sourceKey: cold.original.sourceKey,
    worldId: binding.worldId,
  });
  expect(await source.t.run(async ctx => !!await ctx.storage.get(cold.original.storageId!))).toBe(true);
  expect(await source.t.action(historyAction('coldHistoryFiles:exportFile'), owner)).toEqual(cold.file);
  expect((await source.t.action(historyAction('coldHistory:read'), { ...owner, offset: 0, numItems: 25 })).page).toEqual(cold.file.payload.messages);
  expect(await source.t.query(ctx => ctx.db.query('backupMaintenanceLocks').first())).toBeNull();
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
        leaseExpiry: stoppedAt + 10000, leaseSafetyMs: 240000,
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
      safeAfter: proposal + 240000,
      canResume: false,
      reason: 'OLD_HOST_LEASE_STILL_VALID',
    });
    jest.setSystemTime(proposal + 240000);
    await expect(t.mutation(makeFunctionReference<'mutation'>('federation/backup:reconcileRestoredResident'), { adminToken, agentGlobalId, sourceStopped: true })).rejects.toThrow('CLOCK_UNCERTAIN');
    await t.mutation(makeFunctionReference<'mutation'>('federation/admin:confirmClockRecovery'), { adminToken, synchronizedUtcConfirmed: true });
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

async function lostPublicationAck(t: Town['t'], fn: any, method: string, args: any) {
  let lost = false;
  try {
    return await t.action(async ctx => fn._handler({...ctx,runMutation:async (ref:any,values:any) => {
      const result = await ctx.runMutation(ref,values);
      if (!lost && getFunctionName(ref).endsWith(`:${method}`)) { lost=true; throw new Error('SIMULATED_PUBLICATION_ACK_LOST'); }
      return result;
    }},args));
  } finally { expect(lost).toBe(true); }
}
test.each(['saveExportPage','finishExport'])('lost %s response retains actual published export objects and a readable resumable archive', async method => {
  const {t} = await town(), {jobId} = await t.mutation(mutation('startExport'),{adminToken});
  if (method === 'finishExport') await drive(t,jobId,'export','SIGNING');
  await lostPublicationAck(t,largeFunctions.advanceExport,method,{adminToken,jobId});
  const status = await t.query(query('status'),{adminToken,jobId});
  if (status.state === 'FAILED') await t.mutation(mutation('resume'),{adminToken,jobId});
  await drive(t,jobId,'export','COMPLETE');
  const result = await t.action(action('getManifest'),{adminToken,jobId});
  await validateManifest(result.manifest,result.signature);
  for (const descriptor of result.manifest.chunks)
    expect(JSON.parse(await t.action(action('getChunk'),{adminToken,jobId,index:descriptor.index})).index).toBe(descriptor.index);
});
test('lost import-job and staged-chunk acknowledgements retain manifest and first accepted entity; duplicate retry removes only its own object', async () => {
  const {t} = await town(), source = await exported(t);
  await expect(lostPublicationAck(t,largeFunctions.createImport,'createImportJob',{adminToken,manifest:source.manifest,signature:source.signature,mode:'restore',sourceStopped:true})).rejects.toThrow('SIMULATED_PUBLICATION_ACK_LOST');
  const job = await t.run(ctx => ctx.db.query('backupLargeJobs').filter(q=>q.eq(q.field('kind'),'import')).first());
  expect(await t.run(async ctx => !!(await ctx.storage.get(job!.manifestStorageId!)))).toBe(true);
  const chunk = source.chunks[0];
  await expect(lostPublicationAck(t,largeFunctions.stageChunk,'saveImportChunk',{adminToken,jobId:job!._id,chunk:JSON.stringify(chunk)})).rejects.toThrow('SIMULATED_PUBLICATION_ACK_LOST');
  const accepted = await t.run(ctx => ctx.db.query('backupLargeChunks').withIndex('job_index',q=>q.eq('jobId',job!._id).eq('index',0)).unique());
  expect(await t.run(async ctx => !!(await ctx.storage.get(accepted!.storageId)))).toBe(true);
  await t.action(action('stageChunk'),{adminToken,jobId:job!._id,chunk:JSON.stringify(chunk)});
  expect(await t.run(async ctx => !!(await ctx.storage.get(accepted!.storageId)))).toBe(true);
  expect(await t.run(ctx => ctx.db.query('backupLargeChunks').withIndex('job_index',q=>q.eq('jobId',job!._id)).collect())).toHaveLength(1);
  await t.mutation(mutation('cancel'),{adminToken,jobId:job!._id});
});

test('lost private rollback-snapshot publication response survives resume and destructive cancellation', async () => {
  const {t} = await town(), source = await exported(t);
  await t.run(async ctx => {
    const {_id,_creationTime,...fields} = (await ctx.db.query('memories').first())!;
    await ctx.db.insert('memories',{...fields,description:'New original memory beyond the source archive'});
  });
  const before = await t.run(ctx => ctx.db.query('memories').collect());
  const jobId = await staged(t,source);
  await drive(t,jobId,'import','READY');
  await t.mutation(mutation('startApply'),{adminToken,jobId});
  await lostPublicationAck(t,largeFunctions.advanceImport,'saveCapture',{adminToken,jobId});
  const saved = await t.run(ctx=>ctx.db.query('backupLargeChunks').withIndex('job_index',q=>q.eq('jobId',jobId).gte('index',source.manifest.chunks.length)).collect());
  expect(saved.length).toBeGreaterThan(0);
  for (const chunk of saved) expect(await t.run(async ctx => !!(await ctx.storage.get(chunk.storageId)))).toBe(true);
  await t.mutation(mutation('resume'),{adminToken,jobId});
  await drive(t,jobId,'import','ALLOCATE');
  await t.mutation(mutation('cancel'),{adminToken,jobId});
  await drive(t,jobId,'import','CANCELLED');
  expect((await t.run(ctx=>ctx.db.query('memories').collect())).map(m=>m.description).sort()).toEqual(before.map(m=>m.description).sort());
});


test.each(['restore', 'clone', 'rollback'] as const)('large %s preserves resident denials and audits through mapping or rollback', async mode => {
  const { t } = await town();
  const binding = (await t.run(ctx => ctx.db.query('residentModelBindings').unique()))!;
  const sourceGlobalId = binding.agentGlobalId!;
  await t.run(async ctx => {
    await ctx.db.insert('federationResidentPolicy', { agentGlobalId: sourceGlobalId, createdAt: 1, updatedAt: 2 });
    await ctx.db.insert('federationResidentPolicy', { agentGlobalId: 'town:foreign/agent:visitor', createdAt: 1, updatedAt: 2 });
    await ctx.db.insert('federationResidentPolicyAudit', { agentGlobalId: sourceGlobalId, operation: 'DENY', previousDenied: false,
      denied: true, operator: 'Host reviewer', authenticatedBy: 'FEDERATION_ADMIN_TOKEN', reason: 'Private policy note', createdAt: 1 });
  });
  const archive = await exported(t);
  expect(archive.manifest.chunks.filter(c => c.table === 'federationResidentPolicy').reduce((n, c) => n + c.count, 0)).toBe(2);
  if (mode === 'rollback') await t.run(ctx => ctx.db.insert('federationResidentPolicy', {
    agentGlobalId: 'town:foreign/agent:later', createdAt: 3, updatedAt: 3 }));
  const target = mode === 'clone' ? convexTest(schema, modules) : t;
  const jobId = await staged(target, archive, mode === 'clone' ? 'clone' : 'restore');
  await drive(target, jobId, 'import', 'READY');
  await target.mutation(mutation('startApply'), { adminToken, jobId });
  if (mode === 'rollback') {
    await drive(target, jobId, 'import', 'REMAP');
    await target.mutation(mutation('cancel'), { adminToken, jobId });
  }
  await drive(target, jobId, 'import', mode === 'rollback' ? 'CANCELLED' : 'COMPLETE');
  const result = await target.run(async ctx => ({
    denied: await ctx.db.query('federationResidentPolicy').collect(),
    audit: await ctx.db.query('federationResidentPolicyAudit').unique(),
    binding: await ctx.db.query('residentModelBindings').unique(),
  }));
  const expectedId = mode === 'clone' ? result.binding!.agentGlobalId : sourceGlobalId;
  expect(result.denied.map(row => row.agentGlobalId).sort()).toEqual([
    expectedId, 'town:foreign/agent:visitor', ...(mode === 'rollback' ? ['town:foreign/agent:later'] : []),
  ].sort());
  if (mode === 'clone') expect(result.denied.some(row => row.agentGlobalId === sourceGlobalId)).toBe(false);
  expect(result.audit).toMatchObject({ agentGlobalId: expectedId, operator: 'Host reviewer', reason: 'Private policy note' });
});

test('resident policy backup rows reject malformed identities, timestamps and undeclared fields', () => {
  const row = { _id: 'resident-policy', _creationTime: 1, agentGlobalId: 'town:foreign/agent:visitor', createdAt: 1, updatedAt: 2 };
  expect(() => validateSourceRow('federationResidentPolicy', { ...row, agentGlobalId: 'visitor-name' })).toThrow('INVALID_RESIDENT_GLOBAL_ID');
  expect(() => validateSourceRow('federationResidentPolicy', { ...row, updatedAt: 0 })).toThrow('INVALID_RESIDENT_POLICY_TIMESTAMP');
  expect(() => validateSourceRow('federationResidentPolicy', { ...row, privateMemory: 'excluded' })).toThrow('BACKUP_SCHEMA_MISMATCH');
});


test('signed large manifests enforce the total resident policy capacity across individually valid chunks', async () => {
  const { t, keys } = await town();
  const archive = await exported(t);
  const before = await t.run(ctx => ctx.db.query('backupLargeJobs').collect());
  for (const count of [1000, 1001]) {
    const policies = Array.from({ length: count }, (_, index) => encodeRow({
      _id: `denial-${index}`, _creationTime: 1, agentGlobalId: `town:foreign/agent:${index}`, createdAt: 1, updatedAt: 1,
    }));
    for (const row of policies) expect(() => validateSourceRow('federationResidentPolicy', decodeRow(row))).not.toThrow();
    const chunks = archive.chunks.filter(c => c.table !== 'federationResidentPolicy');
    for (let start = 0; start < policies.length; start += 20)
      chunks.push({ index: 0, table: 'federationResidentPolicy', rows: policies.slice(start, start + 20) });
    chunks.sort((a, b) => (largeTables as readonly string[]).indexOf(a.table) - (largeTables as readonly string[]).indexOf(b.table));
    const ordered = chunks.map((chunk, index) => ({ ...chunk, index }));
    const manifest = { ...archive.manifest, chunks: await Promise.all(ordered.map(descriptor)) };
    const signature = await sign(manifest, keys.privateKeyEncrypted);
    if (count === 1000) await expect(validateManifest(manifest, signature)).resolves.toBeUndefined();
    else {
      await expect(t.action(action('createImport'), { adminToken, manifest, signature,
        mode: 'restore', sourceStopped: true })).rejects.toThrow('RESIDENT_POLICY_CAPACITY_EXCEEDED');
      expect(await t.run(ctx => ctx.db.query('backupLargeJobs').collect())).toEqual(before);
      expect(await t.run(ctx => ctx.db.query('backupMaintenanceLocks').collect())).toEqual([]);
      expect(await t.run(ctx => ctx.db.query('federationResidentPolicy').collect())).toEqual([]);
    }
  }
});


test.each([false, true])('completed large clone activates with real completion format (legacy=%s)', async legacy => {
  const source = await town(), archive = await exported(source.t);
  const target = convexTest(schema, modules), jobId = await staged(target, archive, 'clone');
  await drive(target, jobId, 'import', 'READY');
  await target.mutation(mutation('startApply'), { adminToken, jobId });
  await drive(target, jobId, 'import', 'COMPLETE');
  const { local, receipt, job } = await target.run(async ctx => ({
    local: (await ctx.db.query('federationIdentity').unique())!,
    receipt: (await ctx.db.query('backupImports').unique())!, job: (await ctx.db.get(jobId))!,
  }));
  expect(receipt.runtimeSnapshot).toEqual({ largeJobId: jobId });
  expect(job.metadata.importId).toBe(receipt._id);
  expect(job).toMatchObject({ state: 'COMPLETE', phase: 'COMPLETE', newTownId: local.townId });
  expect(receipt.cloneDeployment).toMatchObject({ townId: local.townId, publicKey: local.publicKey });
  if (legacy) await target.run(ctx => ctx.db.patch(receipt._id, { cloneDeployment: undefined }));
  const status = makeFunctionReference<'query'>('federation/admin:status');
  const activate = makeFunctionReference<'mutation'>('federation/admin:activateIndependentClone');
  expect((await target.query(status, { adminToken })).cloneActivation).toMatchObject({ eligible: true, importId: receipt._id });
  const args = { adminToken, importId: receipt._id, expectedTownId: local.townId,
    expectedDeploymentInstanceId: local.deploymentInstanceId, expectedDeploymentEpoch: local.deploymentEpoch,
    operator: 'Large clone operator', reason: 'Start independent large town' };
  expect(await target.mutation(activate, args)).toMatchObject({ alreadyActivated: false });
  const activated = (await target.run(ctx => ctx.db.get(receipt._id)))!;
  expect(activated.cloneDeployment).toMatchObject({ townId: local.townId, publicKey: local.publicKey,
    sourcePublicKey: archive.manifest.source.publicKey, sourceFingerprint: archive.manifest.source.fingerprint });
  expect(await target.mutation(activate, args)).toMatchObject({ alreadyActivated: true });
  expect(await target.run(ctx => ctx.db.get(receipt._id))).toEqual(activated);
});
