import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { embeddingFingerprint } from '../models/compatibility';
import { memorySourceDigest } from '../models/embeddingDataRevision';
import { pipelineFingerprint } from '../models/ollamaEvidence';
import { encodeRow } from './backupHelpers';
import { descriptor, type LargeChunk } from './backupLargeHelpers';
import { digest } from './security';
import { portableVector, validateGenerationEvidence, validateVectorSource, type PortableGenerationEvidence } from './vectorEvidence';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/backupLarge.ts': () => import('./backupLarge'),
  '../federation/backupSelectiveImport.ts': () => import('./backupSelectiveImport'),
  '../federation/backupVectorRestore.ts': () => import('./backupVectorRestore'),
};
const mutation = (module: string, name: string) => makeFunctionReference<'mutation'>(`federation/${module}:${name}`);
const sourceMemory = { _id: 'source-memory', _creationTime: 1, worldId: 'source-world', playerId: 'p:0',
  description: 'Canonical fixture memory', importance: 3, lastAccess: 1,
  data: { type: 'reflection', relatedMemoryIds: [] } };
const originalProviderTrust = process.env.EMBEDDING_TRUSTED_OLLAMA_PROVIDERS;
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
afterEach(() => {
  jest.restoreAllMocks();
  if (originalProviderTrust === undefined) delete process.env.EMBEDDING_TRUSTED_OLLAMA_PROVIDERS;
  else process.env.EMBEDDING_TRUSTED_OLLAMA_PROVIDERS = originalProviderTrust;
});

async function portableFixture() {
  const profile = { provider: 'ollama', url: 'http://managed.example:11434', model: 'fixture:v1', dimensions: 2,
    preprocessingRevision: 'newline-to-space-v1', queryPrefix: 'Q: ', documentPrefix: 'D: ', normalization: 'none' };
  const certificate = { profileFingerprint: embeddingFingerprint(profile), artifactDigest: 'a'.repeat(64),
    metadataDigest: 'b'.repeat(64), serviceVersion: 'fixture-runtime-v1', providerId: 'managed-fixture',
    providerUrl: profile.url, pipelineFingerprint: pipelineFingerprint(profile, 'fixture-runtime-v1', 'b'.repeat(64)),
    state: 'REVOKED', checkedAt: 0, verifiedAt: 1, dimensions: 2, querySample: [1, 0], documentSample: [1, 0] };
  const generationEvidence: PortableGenerationEvidence = { version: 1, profile, certificate };
  return { _id: 'source-vector', _creationTime: 1, memoryId: sourceMemory._id, worldId: sourceMemory.worldId,
    playerId: sourceMemory.playerId, spaceId: 'source-space', embedding: [1, 0],
    sourceDigest: await memorySourceDigest(sourceMemory as never),
    generationEvidence, generationEvidenceId: await digest(generationEvidence) };
}

test('portable generation evidence authenticates the complete pipeline and remains historical authority', async () => {
  const vector = await portableFixture();
  await expect(validateGenerationEvidence(vector)).resolves.toEqual(vector.generationEvidence);
  for (const changed of [
    { ...vector.generationEvidence.certificate, state: 'ACTIVE' },
    { ...vector.generationEvidence.certificate, checkedAt: Date.now() },
    { ...vector.generationEvidence.certificate, metadataDigest: 'unproven' },
    { ...vector.generationEvidence.certificate, providerUrl: 'http://other.example' },
  ]) {
    const generationEvidence = { ...vector.generationEvidence, certificate: changed };
    await expect(validateGenerationEvidence({ ...vector, generationEvidence, generationEvidenceId: await digest(generationEvidence) }))
      .rejects.toThrow('INVALID_PORTABLE_GENERATION_EVIDENCE');
  }
  await expect(validateGenerationEvidence({ ...vector, generationEvidence: undefined })).rejects.toThrow('INVALID_PORTABLE_GENERATION_EVIDENCE');
  await expect(validateGenerationEvidence({ ...vector, embedding: [1] })).rejects.toThrow('INVALID_EMBEDDING_VECTOR');
});

test.each(['memoryId', 'worldId', 'playerId', 'agentGlobalId', 'sourceDigest', 'text'])
  ('portable vectors cannot be rebound through a changed %s', async field => {
    const vector = await portableFixture();
    await expect(validateVectorSource(vector, sourceMemory)).resolves.toBeUndefined();
    const memory = field === 'text' ? { ...sourceMemory, description: 'Different text' } : sourceMemory;
    await expect(validateVectorSource(field === 'text' ? vector : { ...vector, [field]: 'changed' }, memory))
      .rejects.toThrow('VECTOR_SOURCE_OWNER_OR_TEXT_CHANGED');
  });

async function stagedJob(selective: boolean, vector: Awaited<ReturnType<typeof portableFixture>>, externalParent = false) {
  const t = convexTest(schema, modules);
  const jobId = await t.run(async ctx => {
    const owner = { agentGlobalId: 'source/agent:0', worldId: sourceMemory.worldId, playerId: sourceMemory.playerId,
      agentId: 'a:0', chatProfileId: 'source-chat' };
    const jobId = await ctx.db.insert('backupLargeJobs', { kind: 'import', state: 'STAGING', phase: 'STAGING',
      mode: selective ? 'selective-import' : 'restore', tableIndex: 0, cursor: null, chunkCount: 2,
      processedChunks: 0, recordCount: 2, bytes: 1, createdAt: 1, updatedAt: 1, source: { townId: 'source' },
      metadata: selective ? { uploaded: 0, plannedMemories: 0, includeVectors: true,
        selection: { scope: 'memories-only', owners: [owner], categories: ['reflection'], from: null, to: null,
          includePublicPeers: false, dependencyPolicy: 'same-owner-evidence-and-public-context',
          timePolicy: 'event-time-else-creation-time-half-open' }, targetOwners: [{ sourceAgentGlobalId: owner.agentGlobalId }] }
        : { uploadedChunks: 0, includeVectors: true } });
    await ctx.db.insert('backupMaintenanceLocks', { key: 'town', jobId, createdAt: 1 });
    return jobId;
  });
  for (const [index, table, row] of [[0, 'memories', sourceMemory], [1, 'modelMemoryVectors', vector]] as const) {
    const records = selective ? [{ kind: 'record', role: 'primary', record: encodeRow(row),
      references: table === 'modelMemoryVectors' ? [{ id: sourceMemory._id, table: 'memories' }] : [{ id: sourceMemory.worldId, table: 'worlds' }] }]
      : [encodeRow(row)];
    const chunk: LargeChunk = { index, table, rows: records };
    const expected = await descriptor(chunk);
    const storageId = await t.run(ctx => ctx.storage.store(new Blob([JSON.stringify(chunk)])));
    await t.mutation(mutation(selective ? 'backupSelectiveImport' : 'backupLarge', selective ? 'saveChunk' : 'saveImportChunk'),
      { jobId, chunkJson: JSON.stringify(chunk), expected, storageId });
  }
  if (selective) {
    const world = { _id: sourceMemory.worldId, _creationTime: 1, nextId: 2, players: [], agents: [], conversations: [] };
    const chunk: LargeChunk = { index: 2, table: 'worlds', rows: [{ kind: 'record', role: 'dependency', record: encodeRow(world), references: [] }] };
    const expected = await descriptor(chunk);
    const storageId = await t.run(ctx => ctx.storage.store(new Blob([JSON.stringify(chunk)])));
    await t.mutation(mutation('backupSelectiveImport', 'saveChunk'), { jobId, chunkJson: JSON.stringify(chunk), expected, storageId });
  }
  await t.run(async ctx => {
    const memory = (await ctx.db.query('backupLargeRows').withIndex('job_source', q => q.eq('jobId', jobId).eq('sourceId', sourceMemory._id)).unique())!;
    await ctx.db.patch(memory._id, { state: externalParent ? 'EXTERNAL' : memory.state,
      ...(selective ? {} : { references: [] }) });
    await ctx.db.patch(jobId, { state: 'VALIDATING', phase: 'VALIDATING' });
  });
  return { t, jobId };
}

test('chunked vector provenance fails preflight before any canonical write, even with valid chunk checksums', async () => {
  const vector = await portableFixture();
  const { t, jobId } = await stagedJob(false, { ...vector, playerId: 'p:1' });
  const memoryMetadata = await t.run(async ctx => (await ctx.db.query('backupLargeRows')
    .withIndex('job_source', q => q.eq('jobId', jobId).eq('sourceId', sourceMemory._id)).unique())!.metadata);
  expect(memoryMetadata.sourceDigest).toBe(vector.sourceDigest);
  expect(memoryMetadata).not.toHaveProperty('description');
  await expect(t.mutation(mutation('backupLarge', 'validatePage'), { jobId, expectedCursor: null }))
    .rejects.toThrow('VECTOR_SOURCE_OWNER_OR_TEXT_CHANGED');
  expect(await t.run(ctx => ctx.db.query('memories').collect())).toEqual([]);
  expect(await t.run(ctx => ctx.db.query('modelMemoryVectors').collect())).toEqual([]);
});

test('selective vector provenance rejects an external parent memory instead of treating the vector as selected private evidence', async () => {
  const { t, jobId } = await stagedJob(true, await portableFixture(), true);
  await expect(t.mutation(mutation('backupSelectiveImport', 'validatePage'), { jobId }))
    .rejects.toThrow('VECTOR_SOURCE_OWNER_OR_TEXT_CHANGED');
  expect(await t.run(ctx => ctx.db.query('modelMemoryVectors').collect())).toEqual([]);
});

test('valid primary selective vectors pass the same category and time preflight as their primary memory', async () => {
  const { t, jobId } = await stagedJob(true, await portableFixture());
  await t.mutation(mutation('backupSelectiveImport', 'validatePage'), { jobId });
  expect((await t.run(ctx => ctx.db.get(jobId)))?.phase).toBe('REACHABILITY');
  expect(await t.run(ctx => ctx.db.query('modelMemoryVectors').collect())).toEqual([]);
});

test('unsigned or previously untrusted imports never start reuse or call the target provider', async () => {
  const t = convexTest(schema, modules);
  const { importId, targetProfileId } = await t.run(async ctx => {
    const targetProfileId = await ctx.db.insert('embeddingProfiles', { ...(await portableFixture()).generationEvidence.profile,
      provider: 'ollama',
      name: 'Target', fingerprint: 'fixture', createdAt: 1 });
    const importId = await ctx.db.insert('backupImports', { sourceTownId: 'untrusted', mode: 'merge', exportedAt: 1,
      importedAt: 1, mapping: {}, runtimeSnapshot: {}, manifest: { includeVectors: true, vectorSourceTrusted: false } });
    return { importId, targetProfileId };
  });
  process.env.FEDERATION_ADMIN_TOKEN = 'vector-backup-fixture-admin';
  const spy = jest.spyOn(globalThis, 'fetch');
  expect(await t.action(makeFunctionReference<'action'>('federation/backupVectorRestore:prepareVectorReuse'),
    { adminToken: process.env.FEDERATION_ADMIN_TOKEN, importId, targetProfileId })).toMatchObject({ vectorPolicy: 'REBUILD',
      reason: 'SOURCE_KEY_WAS_NOT_LOCALLY_TRUSTED_AT_IMPORT' });
  expect(spy).not.toHaveBeenCalled();
  expect(await t.run(ctx => ctx.db.query('embeddingRestoreJobs').collect())).toEqual([]);
});

test('optional vector snapshots select the active space and omit retired or building duplicates', async () => {
  const t = convexTest(schema, modules), proof = (await portableFixture()).generationEvidence;
  const exported = await t.run(async ctx => {
    const worldId = await ctx.db.insert('worlds', { nextId: 2, players: [], agents: [], conversations: [] });
    const memoryId = await ctx.db.insert('memories', { worldId, playerId: 'p:0' as any,
      description: sourceMemory.description, importance: 3, lastAccess: 1, data: { type: 'reflection', relatedMemoryIds: [] } });
    const profileId = await ctx.db.insert('embeddingProfiles', { ...proof.profile, provider: 'ollama', name: 'Snapshot fixture',
      fingerprint: embeddingFingerprint(proof.profile), createdAt: 1 });
    const certificateId = await ctx.db.insert('embeddingCertificates', { ...proof.certificate, profileId,
      state: 'ACTIVE', checkedAt: Date.now(), trustBoundary: 'Controlled test provider' });
    const spaces = [];
    for (const status of ['ACTIVE', 'RETIRED', 'BUILDING'] as const)
      spaces.push(await ctx.db.insert('embeddingSpaces', { profileId, embeddingCertificateId: certificateId,
        fingerprint: embeddingFingerprint(proof.profile), status, createdAt: 1 }));
    await ctx.db.insert('modelSettings', { key: 'town', activeEmbeddingSpaceId: spaces[0] });
    const vectors = [];
    for (const spaceId of spaces) {
      const vectorId = await ctx.db.insert('modelMemoryVectors', { memoryId, worldId, playerId: 'p:0' as any,
        spaceId, embedding: [1, 0], embeddingCertificateId: certificateId,
        sourceDigest: await memorySourceDigest((await ctx.db.get(memoryId))!) });
      vectors.push(await portableVector(ctx.db, (await ctx.db.get(vectorId))!, true));
    }
    return vectors;
  });
  expect(exported[0]).toMatchObject({ generationEvidence: { certificate: { state: 'REVOKED', checkedAt: 0 } } });
  expect(exported[1]).toBeNull(); expect(exported[2]).toBeNull();
});

test.each(['kind', 'sourceTownId', 'importId', 'state'])
  ('restoration rejects a completed archive whose %s no longer binds to its import', async field => {
    const t = convexTest(schema, modules);
    const { importId, jobId } = await t.run(async ctx => {
      const jobId = await ctx.db.insert('backupLargeJobs', { kind: 'import', state: 'COMPLETE', phase: 'COMPLETE',
        mode: 'restore', tableIndex: 0, cursor: null, chunkCount: 0, processedChunks: 0, recordCount: 0,
        bytes: 0, createdAt: 1, updatedAt: 1, source: { townId: 'source-town', publicKey: 'fixture-key' }, metadata: {} });
      const importId = await ctx.db.insert('backupImports', { sourceTownId: 'source-town', mode: 'merge',
        exportedAt: 1, importedAt: 1, mapping: {}, runtimeSnapshot: {}, manifest: { largeJobId: jobId } });
      await ctx.db.patch(jobId, { metadata: { importId, vectorSourceTrusted: true } });
      return { importId, jobId };
    });
    const importData = makeFunctionReference<'query'>('federation/backupVectorRestore:importData');
    expect(await t.query(importData, { importId })).toMatchObject({ trusted: true });
    await t.run(ctx => ctx.db.patch(jobId, field === 'sourceTownId' ? { source: { townId: 'different-town' } }
      : field === 'importId' ? { metadata: { importId: 'another-import', vectorSourceTrusted: true } }
      : field === 'kind' ? { kind: 'export' } : { state: 'STAGING' }));
    await expect(t.query(importData, { importId })).rejects.toThrow('BACKUP_VECTOR_IMPORT_NOT_COMPLETE');
  });

const restoreQuery = (name: string) => makeFunctionReference<'query'>(`federation/backupVectorRestore:${name}`);
async function reuseFixture(kind: 'ordinary' | 'large' | 'selective' = 'ordinary', archiveRevision?: number) {
  const t = convexTest(schema, modules), vector = await portableFixture(), proof = vector.generationEvidence;
  process.env.EMBEDDING_TRUSTED_OLLAMA_PROVIDERS = JSON.stringify([
    { providerId: proof.certificate.providerId, url: proof.profile.url, trustedModelManagement: true },
  ]);
  const ids = await t.run(async ctx => {
    const worldId = await ctx.db.insert('worlds', { nextId: 2, players: [], agents: [], conversations: [] });
    const targetId = await ctx.db.insert('memories', { worldId, playerId: 'p:0', description: sourceMemory.description,
      importance: 3, lastAccess: 1, data: { type: 'reflection', relatedMemoryIds: [] } });
    const targetProfileId = await ctx.db.insert('embeddingProfiles', { ...proof.profile, provider: 'ollama',
      name: 'Restore target', fingerprint: embeddingFingerprint(proof.profile), createdAt: 1 });
    const certificateId = await ctx.db.insert('embeddingCertificates', { ...proof.certificate, profileId: targetProfileId,
      state: 'ACTIVE', checkedAt: Date.now(), trustBoundary: 'Controlled test provider' });
    const spaceId = await ctx.db.insert('embeddingSpaces', { profileId: targetProfileId,
      fingerprint: embeddingFingerprint(proof.profile), embeddingCertificateId: certificateId, status: 'BUILDING', createdAt: 1 });
    const activeSpaceId = await ctx.db.insert('embeddingSpaces', { profileId: targetProfileId,
      fingerprint: embeddingFingerprint(proof.profile), status: 'ACTIVE', createdAt: 1 });
    const otherSpaceId = await ctx.db.insert('embeddingSpaces', { profileId: targetProfileId,
      fingerprint: embeddingFingerprint(proof.profile), status: 'BUILDING', createdAt: 1 });
    await ctx.db.insert('modelSettings', { key: 'town', activeEmbeddingSpaceId: activeSpaceId });
    const storageId = await ctx.storage.store(new Blob(['fixture archive']));
    let archiveId: Id<'backupLargeJobs'> | undefined;
    if (kind !== 'ordinary') archiveId = await ctx.db.insert('backupLargeJobs', {
      kind: 'import', state: 'COMPLETE', phase: 'COMPLETE', mode: kind === 'selective' ? 'selective-import' : 'restore',
      tableIndex: 0, cursor: null, chunkCount: 2, processedChunks: 2, recordCount: 2, bytes: 1,
      createdAt: 1, updatedAt: 1, source: { townId: 'source-town', publicKey: 'source-public-fixture' },
      ...(archiveRevision === undefined ? {} : { archiveRevision }), metadata: {},
    });
    const importId = await ctx.db.insert('backupImports', { sourceTownId: 'source-town', mode: 'merge', exportedAt: 1,
      importedAt: 1, mapping: { [sourceMemory._id]: targetId, [sourceMemory.worldId]: worldId, 'p:0': 'p:0' }, runtimeSnapshot: {},
      ...(kind === 'ordinary' && archiveRevision !== undefined ? { archiveRevision } : {}),
      manifest: { vectorSourceTrusted: true, includeVectors: true, vectorArchiveStorageId: storageId,
        ...(archiveId ? { [kind === 'selective' ? 'selectiveJobId' : 'largeJobId']: archiveId } : {}) } });
    if (archiveId) {
      await ctx.db.patch(archiveId, { metadata: { importId, vectorSourceTrusted: true, includeVectors: true,
        targetOwners: [{ sourceAgentGlobalId: 'source-owner', worldId, playerId: 'p:0' }] } });
      for (const [index, table, row] of [[0, 'memories', sourceMemory], [1, 'modelMemoryVectors', vector]] as const) {
        const chunk = { index, table, rows: kind === 'selective'
          ? [{ kind: 'record', role: 'primary', record: encodeRow(row), references: [] }] : [encodeRow(row)] };
        const chunkStorageId = await ctx.storage.store(new Blob([JSON.stringify(chunk)]));
        await ctx.db.insert('backupLargeChunks', { jobId: archiveId, ...(await descriptor(chunk)), storageId: chunkStorageId });
      }
      await ctx.db.insert('backupLargeRows', { jobId: archiveId, role: 'SOURCE', table: 'memories',
        sourceId: sourceMemory._id, chunkIndex: 0, rowIndex: 0, newId: targetId, ownerGlobalId: 'source-owner',
        state: 'APPLIED', references: [], metadata: kind === 'selective'
          ? { envelope: { kind: 'record', role: 'primary', record: encodeRow(sourceMemory), references: [] } }
          : { worldId: sourceMemory.worldId, playerId: sourceMemory.playerId } });
      await ctx.db.insert('backupLargeRows', { jobId: archiveId, role: 'SOURCE', table: 'worlds',
        sourceId: sourceMemory.worldId, chunkIndex: 0, rowIndex: 1, newId: worldId,
        state: 'APPLIED', references: [], metadata: {} });
    }
    return { importId, archiveId, targetProfileId, spaceId, activeSpaceId, otherSpaceId, targetId };
  });
  return { t, ...ids, entries: [{ vector, original: sourceMemory, targetId: ids.targetId, sourcePublicKey: 'source-public-fixture' }] };
}
async function createReuseJob(f: Awaited<ReturnType<typeof reuseFixture>>) {
  return f.t.mutation(mutation('backupVectorRestore', 'createJob'), {
    importId: f.importId, targetProfileId: f.targetProfileId, spaceId: f.spaceId,
  }) as Promise<Id<'embeddingRestoreJobs'>>;
}
test.each(['ordinary', 'large', 'selective'] as const)('a %s archive preserves its revision in a new restore job and old jobs use zero', async kind => {
  const f = await reuseFixture(kind, 7), jobId = await createReuseJob(f);
  expect((await f.t.run(ctx => ctx.db.get(jobId)))!.archiveRevision).toBe(7);
  expect((await f.t.query(restoreQuery('pageData'), { jobId })).job.archiveRevision).toBe(7);
  const old = await reuseFixture(kind), oldJobId = await createReuseJob(old);
  expect((await old.t.run(ctx => ctx.db.get(oldJobId)))!.archiveRevision).toBe(0);
  await old.t.run(ctx => ctx.db.patch(oldJobId, { archiveRevision: undefined }));
  await expect(old.t.query(restoreQuery('pageData'), { jobId: oldJobId })).resolves.toMatchObject({ archiveRevision: 0 });
  await expect(old.t.mutation(mutation('backupVectorRestore', 'copyPage'), { jobId: oldJobId,
    expectedCursor: null, expectedOffset: 0, nextCursor: null, nextOffset: 1, done: true, entries: old.entries }))
    .resolves.toEqual({ copied: 1, skipped: 0 });
});
test.each(['ordinary', 'large', 'selective'] as const)('clearing a %s archive fences old page reads before copying any vectors', async kind => {
  const f = await reuseFixture(kind), jobId = await createReuseJob(f);
  await f.t.query(restoreQuery('pageData'), { jobId });
  await f.t.query(restoreQuery('sourceMappings'), { importId: f.importId, memoryIds: [sourceMemory._id], archiveRevision: 0 });
  await f.t.run(ctx => f.archiveId ? ctx.db.patch(f.archiveId, { archiveRevision: 1 })
    : ctx.db.patch(f.importId, { archiveRevision: 1 }));
  await expect(f.t.mutation(mutation('backupVectorRestore', 'copyPage'), { jobId,
    expectedCursor: null, expectedOffset: 0, nextCursor: null, nextOffset: 1, done: true, entries: f.entries }))
    .rejects.toThrow('VECTOR_ARCHIVE_REVISION_CHANGED');
  await expect(f.t.query(restoreQuery('pageData'), { jobId })).rejects.toThrow('VECTOR_ARCHIVE_REVISION_CHANGED');
  await expect(f.t.query(restoreQuery('sourceMappings'), { importId: f.importId,
    memoryIds: [sourceMemory._id], archiveRevision: 0 })).rejects.toThrow('VECTOR_ARCHIVE_REVISION_CHANGED');
  expect(await f.t.run(ctx => ctx.db.query('modelMemoryVectors').collect())).toEqual([]);
  expect((await f.t.run(ctx => ctx.db.get(jobId)))!.copied).toBe(0);
});
test.each([
  ['ordinary', 'REWRITING'], ['ordinary', 'LOCAL_SANITIZED'],
  ['large', 'REWRITING'], ['large', 'LOCAL_SANITIZED'],
  ['selective', 'REWRITING'], ['selective', 'LOCAL_SANITIZED'],
] as const)('a %s %s archive refuses all restore entry points without calling the provider', async (kind, archivePrivacyState) => {
  const f = await reuseFixture(kind), jobId = await createReuseJob(f);
  const spaces = await f.t.run(ctx => ctx.db.query('embeddingSpaces').collect());
  await f.t.run(ctx => f.archiveId ? ctx.db.patch(f.archiveId, { archivePrivacyState, archiveRevision: 1 })
    : ctx.db.patch(f.importId, { archivePrivacyState, archiveRevision: 1 }));
  const spy = jest.spyOn(globalThis, 'fetch');
  process.env.FEDERATION_ADMIN_TOKEN = 'vector-backup-fixture-admin';
  await expect(f.t.action(makeFunctionReference<'action'>('federation/backupVectorRestore:prepareVectorReuse'), {
    adminToken: process.env.FEDERATION_ADMIN_TOKEN, importId: f.importId, targetProfileId: f.targetProfileId,
  })).resolves.toEqual({ vectorPolicy: 'REBUILD', reason: 'VECTOR_ARCHIVE_PRIVACY_REDACTED' });
  expect(spy).not.toHaveBeenCalled();
  expect(await f.t.run(ctx => ctx.db.query('embeddingSpaces').collect())).toEqual(spaces);
  await expect(createReuseJob(f)).rejects.toThrow('VECTOR_ARCHIVE_PRIVACY_REDACTED');
  await expect(f.t.query(restoreQuery('pageData'), { jobId })).rejects.toThrow('VECTOR_ARCHIVE_PRIVACY_REDACTED');
  await expect(f.t.query(restoreQuery('sourceMappings'), { importId: f.importId, memoryIds: [sourceMemory._id] }))
    .rejects.toThrow('VECTOR_ARCHIVE_PRIVACY_REDACTED');
  await expect(f.t.mutation(mutation('backupVectorRestore', 'copyPage'), { jobId,
    expectedCursor: null, expectedOffset: 0, nextCursor: null, nextOffset: 1, done: true, entries: f.entries }))
    .rejects.toThrow('VECTOR_ARCHIVE_PRIVACY_REDACTED');
  expect(await f.t.run(ctx => ctx.db.query('embeddingRestoreJobs').collect())).toHaveLength(1);
  expect(await f.t.run(ctx => ctx.db.query('modelMemoryVectors').collect())).toEqual([]);
});
test.each(['BUILDING', 'ACTIVE', 'READY', 'other-profile'] as const)(
  'advance failure for a cleared archive only invalidates its own matching BUILDING space (%s)', async status => {
    const f = await reuseFixture(), jobId = await createReuseJob(f);
    await f.t.run(async ctx => {
      await ctx.db.patch(f.importId, { archivePrivacyState: 'REWRITING', archiveRevision: 1 });
      if (status === 'other-profile') {
        const { _id, _creationTime, ...profile } = (await ctx.db.get(f.targetProfileId))!;
        const otherProfileId = await ctx.db.insert('embeddingProfiles', profile);
        await ctx.db.patch(f.spaceId, { profileId: otherProfileId });
      } else await ctx.db.patch(f.spaceId, { status });
    });
    const before = await f.t.run(async ctx => ({ target: await ctx.db.get(f.spaceId), active: await ctx.db.get(f.activeSpaceId),
      other: await ctx.db.get(f.otherSpaceId), settings: await ctx.db.query('modelSettings').unique() }));
    const spy = jest.spyOn(globalThis, 'fetch');
    await f.t.action(makeFunctionReference<'action'>('federation/backupVectorRestore:advance'), { jobId });
    expect(spy).not.toHaveBeenCalled();
    expect(await f.t.run(ctx => ctx.db.get(jobId))).toMatchObject({ state: 'REBUILD_REQUIRED', reason: 'VECTOR_ARCHIVE_PRIVACY_REDACTED' });
    await f.t.run(async ctx => {
      expect(await ctx.db.get(f.spaceId)).toEqual(status === 'BUILDING'
        ? { ...before.target, status: 'FAILED', failure: 'VECTOR_ARCHIVE_PRIVACY_REDACTED' } : before.target);
      expect(await ctx.db.get(f.activeSpaceId)).toEqual(before.active);
      expect(await ctx.db.get(f.otherSpaceId)).toEqual(before.other);
      expect(await ctx.db.query('modelSettings').unique()).toEqual(before.settings);
    });
  });
