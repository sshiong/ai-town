import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action, internalAction, internalMutation, internalQuery, query, type DatabaseReader } from '../maintenanceFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { requireAdmin, digest, verifySignature } from './security';
import { decodeRow, validateBundle, type BackupBundle, type BackupRow } from './backupHelpers';
import { validateChunk, type LargeChunk } from './backupLargeHelpers';
import { validateSelectiveChunk } from './backupSelectiveHelpers';
import { validateGenerationEvidence } from './vectorEvidence';
import { embeddingFingerprint, verifiedCompatible } from '../models/compatibility';
import { memorySourceDigest } from '../models/embeddingDataRevision';
import { assertSpaceCertificate, guardEmbeddingRoute } from '../models/embeddingProvenance';

const qref = (s: string) => makeFunctionReference<'query'>(`federation/backupVectorRestore:${s}`);
const mref = (s: string) => makeFunctionReference<'mutation'>(`federation/backupVectorRestore:${s}`);
const aref = (s: string) => makeFunctionReference<'action'>(`federation/backupVectorRestore:${s}`);
const modelQ = (s: string) => makeFunctionReference<'query'>(`models/embeddings:${s}`);
const modelM = (s: string) => makeFunctionReference<'mutation'>(`models/embeddings:${s}`);

async function importContext(db: DatabaseReader, importId: Id<'backupImports'>) {
  const imported = await db.get(importId);
  if (!imported) throw new Error('BACKUP_IMPORT_NOT_FOUND');
  const jobId = imported.manifest.selectiveJobId ?? imported.manifest.largeJobId;
  const archive = jobId ? await db.get(jobId as Id<'backupLargeJobs'>) : null;
  if (jobId && (!archive || archive.kind !== 'import' || archive.state !== 'COMPLETE' ||
    archive.metadata.importId !== importId || archive.source.townId !== imported.sourceTownId))
    throw new Error('BACKUP_VECTOR_IMPORT_NOT_COMPLETE');
  return { imported, archive, trusted: archive?.metadata.vectorSourceTrusted ?? imported.manifest.vectorSourceTrusted ?? false };
}
export const importData = internalQuery({
  args: { importId: v.id('backupImports') }, handler: (ctx, a) => importContext(ctx.db, a.importId),
});
export const createJob = internalMutation({
  args: { importId: v.id('backupImports'), targetProfileId: v.id('embeddingProfiles'), spaceId: v.id('embeddingSpaces') },
  handler: async (ctx, a) => {
    const context = await importContext(ctx.db, a.importId);
    if (!context.trusted) throw new Error('VECTOR_SOURCE_NOT_TRUSTED');
    const certificate = await assertSpaceCertificate(ctx.db, a.spaceId);
    const space = await ctx.db.get(a.spaceId);
    if (!certificate || space?.profileId !== a.targetProfileId || space.status !== 'BUILDING') throw new Error('VECTOR_TARGET_NOT_VERIFIED');
    return ctx.db.insert('embeddingRestoreJobs', { ...a, state: 'COPYING', cursor: null, offset: 0,
      copied: 0, skipped: 0, createdAt: Date.now(), updatedAt: Date.now() });
  },
});
export const prepareVectorReuse = action({
  args: { adminToken: v.string(), importId: v.id('backupImports'), targetProfileId: v.id('embeddingProfiles') },
  handler: async (ctx, a): Promise<{ vectorPolicy: 'REBUILD'; reason: string } | { vectorPolicy: 'PENDING_VALIDATION'; jobId: Id<'embeddingRestoreJobs'>; spaceId: Id<'embeddingSpaces'> }> => {
    requireAdmin(a.adminToken);
    const context: Awaited<ReturnType<typeof importContext>> = await ctx.runQuery(qref('importData'), { importId: a.importId });
    if (!context.trusted) return { vectorPolicy: 'REBUILD', reason: 'SOURCE_KEY_WAS_NOT_LOCALLY_TRUSTED_AT_IMPORT' };
    if (context.archive ? !context.archive.metadata.includeVectors : !context.imported.manifest.vectorArchiveStorageId)
      return { vectorPolicy: 'REBUILD', reason: 'ARCHIVE_HAS_NO_PROVEN_VECTOR_SNAPSHOT' };
    const verified = await ctx.runAction(makeFunctionReference<'action'>('models/embeddingProvenance:verifyProvider'),
      { adminToken: a.adminToken, embeddingProfileId: a.targetProfileId });
    if (verified.compatibility !== 'VERIFIED_PROVIDER') return { vectorPolicy: 'REBUILD', reason: verified.reason };
    const spaceId: Id<'embeddingSpaces'> = await ctx.runMutation(modelM('beginRebuild'), { targetProfileId: a.targetProfileId });
    const jobId: Id<'embeddingRestoreJobs'> = await ctx.runMutation(mref('createJob'), { importId: a.importId, targetProfileId: a.targetProfileId, spaceId });
    await ctx.scheduler.runAfter(0, aref('advance'), { jobId });
    return { vectorPolicy: 'PENDING_VALIDATION', jobId, spaceId };
  },
});
export const status = query({
  args: { adminToken: v.string(), jobId: v.id('embeddingRestoreJobs') },
  handler: async (ctx, a) => { requireAdmin(a.adminToken); return ctx.db.get(a.jobId); },
});
export const pageData = internalQuery({
  args: { jobId: v.id('embeddingRestoreJobs') },
  handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job) throw new Error('VECTOR_RESTORE_JOB_NOT_FOUND');
    const context = await importContext(ctx.db, job.importId);
    if (!context.trusted) throw new Error('VECTOR_SOURCE_NOT_TRUSTED');
    if (!context.archive) return { job, ...context, chunk: null, nextCursor: null, done: true };
    const page = await ctx.db.query('backupLargeChunks').withIndex('job_index', q => q.eq('jobId', context.archive!._id))
      .filter(q => q.eq(q.field('table'), 'modelMemoryVectors')).paginate({ cursor: job.cursor, numItems: 1, maximumBytesRead: 512 * 1024 });
    return { job, ...context, chunk: page.page[0] ?? null, nextCursor: page.isDone ? null : page.continueCursor, done: page.isDone };
  },
});
export const sourceMappings = internalQuery({
  args: { importId: v.id('backupImports'), memoryIds: v.array(v.string()) },
  handler: (ctx, a) => resolveSourceMappings(ctx.db, a.importId, a.memoryIds),
});
async function resolveSourceMappings(db: DatabaseReader, importId: Id<'backupImports'>, memoryIds: string[]) {
    if (memoryIds.length > 20) throw new Error('VECTOR_RESTORE_PAGE_BUDGET');
    const { imported, archive } = await importContext(db, importId);
    const mappings = [];
    for (const memoryId of memoryIds) {
      if (!archive) { mappings.push({ memoryId, targetId: imported.mapping[memoryId], mapping: imported.mapping }); continue; }
      const source = await db.query('backupLargeRows').withIndex('job_source', q => q.eq('jobId', archive._id).eq('sourceId', memoryId)).filter(q => q.eq(q.field('role'), 'SOURCE')).unique();
      if (!source || source.table !== 'memories') throw new Error('VECTOR_SOURCE_MEMORY_MISSING');
      const chunk = await db.query('backupLargeChunks').withIndex('job_index', q => q.eq('jobId', archive._id).eq('index', source.chunkIndex)).unique();
      if (!chunk) throw new Error('VECTOR_SOURCE_CHUNK_MISSING');
      const target = source.newId ? await db.get(source.newId as Id<'memories'>) : null;
      if (archive.mode === 'selective-import') {
        const original = decodeRow(source.metadata.envelope.record);
        const owner = archive.metadata.targetOwners.find((o: BackupRow) => o.sourceAgentGlobalId === source.ownerGlobalId);
        mappings.push({ memoryId, targetId: target?._id, original, chunk, mapping: owner ? {
          [original.worldId]: owner.worldId, [original.playerId]: owner.playerId,
          ...(original.agentGlobalId ? { [original.agentGlobalId]: owner.agentGlobalId } : {}),
        } : {} });
      } else {
        const original = source.metadata;
        const world = await db.query('backupLargeRows').withIndex('job_source', q => q.eq('jobId', archive._id).eq('sourceId', original.worldId)).filter(q => q.eq(q.field('role'), 'SOURCE')).unique();
        const global = original.agentGlobalId ? await db.query('backupLargeGlobalMappings').withIndex('job_source', q => q.eq('jobId', archive._id).eq('sourceId', original.agentGlobalId)).unique() : null;
        mappings.push({ memoryId, targetId: target?._id, chunk, mapping: {
          [original.worldId]: world?.newId, [original.playerId]: original.playerId,
          ...(original.agentGlobalId ? { [original.agentGlobalId]: global?.targetId ?? original.agentGlobalId } : {}),
        } });
      }
    }
    return mappings;
}
export const copyPage = internalMutation({
  args: { jobId: v.id('embeddingRestoreJobs'), expectedCursor: v.union(v.string(), v.null()), expectedOffset: v.number(),
    nextCursor: v.union(v.string(), v.null()), nextOffset: v.number(), done: v.boolean(), entries: v.array(v.any()) },
  handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job || job.state !== 'COPYING' || job.cursor !== a.expectedCursor || job.offset !== a.expectedOffset) throw new Error('VECTOR_RESTORE_CHECKPOINT_CHANGED');
    if (a.entries.length > 20) throw new Error('VECTOR_RESTORE_PAGE_BUDGET');
    const context = await importContext(ctx.db, job.importId);
    if (!context.trusted) throw new Error('VECTOR_SOURCE_NOT_TRUSTED');
    const targetCertificate = await assertSpaceCertificate(ctx.db, job.spaceId);
    const targetProfile = await ctx.db.get(job.targetProfileId);
    const targetSpace = await ctx.db.get(job.spaceId);
    if (!targetCertificate || !targetProfile || targetSpace?.profileId !== targetProfile._id || targetSpace.status !== 'BUILDING')
      throw new Error('VECTOR_TARGET_NOT_VERIFIED');
    const mappings = await resolveSourceMappings(ctx.db, job.importId, a.entries.map(entry => entry.vector.memoryId));
    let copied = job.copied, skipped = job.skipped;
    for (const [index, entry] of a.entries.entries()) {
      const row = entry.vector as BackupRow, source = entry.original as BackupRow;
      const proof = await validateGenerationEvidence(row);
      const mapping = mappings[index];
      if (entry.targetId !== mapping.targetId || context.archive && entry.sourcePublicKey !== context.archive.source.publicKey)
        throw new Error('VECTOR_IMPORT_MAPPING_CHANGED');
      if (!entry.targetId) { skipped++; continue; }
      const target = await ctx.db.get(entry.targetId as Id<'memories'>);
      if (!source || !target || row.memoryId !== source._id || row.worldId !== source.worldId || row.playerId !== source.playerId ||
        row.agentGlobalId !== source.agentGlobalId || row.sourceDigest !== await memorySourceDigest(source as never) ||
        target.description !== source.description || target.worldId !== mapping.mapping[source.worldId] ||
        target.playerId !== (mapping.mapping[source.playerId] ?? source.playerId) ||
        target.agentGlobalId !== (mapping.mapping[source.agentGlobalId] ?? source.agentGlobalId))
        throw new Error('VECTOR_SOURCE_OWNER_OR_TEXT_CHANGED');
      if (!verifiedCompatible(proof.profile, targetProfile, { source: proof.certificate, target: targetCertificate }))
        throw new Error('VECTOR_MODEL_EVIDENCE_INCOMPATIBLE');
      let historical = await ctx.db.query('embeddingCertificates').withIndex('profile', q => q.eq('profileId', targetProfile._id))
        .filter(q => q.and(q.eq(q.field('generationEvidenceId'), row.generationEvidenceId),
          q.eq(q.field('sourceTownId'), context.imported.sourceTownId), q.eq(q.field('sourcePublicKey'), entry.sourcePublicKey))).first();
      if (!historical) {
        const id = await ctx.db.insert('embeddingCertificates', { ...proof.certificate,
          profileId: targetProfile._id, profileFingerprint: embeddingFingerprint(targetProfile), providerUrl: targetProfile.url,
          generationEvidenceId: row.generationEvidenceId, sourceTownId: context.imported.sourceTownId,
          sourcePublicKey: entry.sourcePublicKey, state: 'REVOKED', checkedAt: 0,
          reason: 'PORTABLE_HISTORICAL_GENERATION_ONLY', trustBoundary: 'Trusted source signature; independently verified target provider; no live serving authorization.' });
        historical = (await ctx.db.get(id))!;
      }
      const prior = await ctx.db.query('modelMemoryVectors').withIndex('memory_space', q => q.eq('memoryId', target._id).eq('spaceId', job.spaceId)).unique();
      if (prior) throw new Error('DUPLICATE_PORTABLE_MEMORY_VECTOR');
      await ctx.db.insert('modelMemoryVectors', { memoryId: target._id, spaceId: job.spaceId,
        worldId: target.worldId!, playerId: target.playerId, agentGlobalId: target.agentGlobalId,
        embedding: row.embedding, sourceDigest: await memorySourceDigest(target), embeddingCertificateId: historical._id });
      copied++;
    }
    await ctx.db.patch(job._id, { cursor: a.nextCursor, offset: a.nextOffset, copied, skipped,
      state: a.done ? 'PENDING_VALIDATION' : 'COPYING', updatedAt: Date.now() });
    return { copied, skipped };
  },
});
export const fail = internalMutation({
  args: { jobId: v.id('embeddingRestoreJobs'), reason: v.string() },
  handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (job) await ctx.db.patch(job._id, { state: 'REBUILD_REQUIRED', reason: a.reason.slice(0, 200), updatedAt: Date.now() });
  },
});
export const advance = internalAction({
  args: { jobId: v.id('embeddingRestoreJobs') },
  handler: async (ctx, a): Promise<void> => {
    let spaceId: Id<'embeddingSpaces'> | undefined;
    try {
      const page = await ctx.runQuery(qref('pageData'), a);
      if (page.job.state !== 'COPYING') return;
      spaceId = page.job.spaceId;
      const route = await ctx.runQuery(modelQ('getRoute'), { spaceId });
      await guardEmbeddingRoute(ctx, route);
      let vectors: BackupRow[], normal: BackupBundle | null = null, done = page.done, nextOffset = 0;
      let sourcePublicKey: string;
      if (!page.archive) {
        const blob = await ctx.storage.get(page.imported.manifest.vectorArchiveStorageId);
        if (!blob) throw new Error('VECTOR_ARCHIVE_STORAGE_MISSING');
        normal = await validateBundle(await blob.text());
        if (await digest(normal.manifest) !== await digest(Object.fromEntries(Object.entries(page.imported.manifest)
          .filter(([key]) => !['vectorSourceTrusted', 'vectorArchiveStorageId'].includes(key))))) throw new Error('VECTOR_ARCHIVE_MANIFEST_CHANGED');
        const source = decodeRow(normal.sections.federationIdentity[0]);
        sourcePublicKey = source.publicKey;
        if (!normal.signature || !await verifySignature(normal.manifest, normal.signature, sourcePublicKey)) throw new Error('VECTOR_SOURCE_SIGNATURE_REQUIRED');
        vectors = (normal.sections.modelMemoryVectors ?? []).slice(page.job.offset, page.job.offset + 20).map(decodeRow);
        nextOffset = page.job.offset + vectors.length; done = nextOffset >= (normal.sections.modelMemoryVectors?.length ?? 0);
      } else {
        sourcePublicKey = page.archive.source.publicKey;
        const blob = page.chunk && await ctx.storage.get(page.chunk.storageId);
        if (page.chunk && !blob) throw new Error('VECTOR_ARCHIVE_STORAGE_MISSING');
        const chunk: LargeChunk | null = blob ? JSON.parse(await blob.text()) : null;
        vectors = !chunk ? [] : page.archive.mode === 'selective-import'
          ? (await validateSelectiveChunk(chunk, page.chunk)).filter(e => e.kind === 'record').map(e => decodeRow((e as {record: string}).record))
          : await validateChunk(chunk, page.chunk);
      }
      const mappings = await ctx.runQuery(qref('sourceMappings'), { importId: page.job.importId, memoryIds: vectors.map(row => row.memoryId) });
      const entries = [];
      const chunkCache = new Map<string, BackupRow[]>();
      for (const [index, vector] of vectors.entries()) {
        const mapping = mappings[index];
        let original: BackupRow | undefined = mapping.original;
        if (normal) original = normal.sections.memories.map(decodeRow).find(row => row._id === vector.memoryId);
        else if (!original) {
          const key = String(mapping.chunk.storageId);
          if (!chunkCache.has(key)) {
            const blob = await ctx.storage.get(mapping.chunk.storageId);
            if (!blob) throw new Error('VECTOR_SOURCE_CHUNK_MISSING');
            const chunk = JSON.parse(await blob.text());
            chunkCache.set(key, await validateChunk(chunk, mapping.chunk));
          }
          original = chunkCache.get(key)!.find(row => row._id === vector.memoryId);
        }
        entries.push({ vector, original, targetId: mapping.targetId, mapping: mapping.mapping, sourcePublicKey });
      }
      await guardEmbeddingRoute(ctx, route);
      await ctx.runMutation(mref('copyPage'), { ...a, expectedCursor: page.job.cursor, expectedOffset: page.job.offset,
        nextCursor: page.nextCursor, nextOffset, done, entries });
      if (done) await ctx.runMutation(modelM('finishBuild'), { spaceId });
      else await ctx.scheduler.runAfter(0, aref('advance'), a);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'VECTOR_RESTORE_FAILED';
      await ctx.runMutation(mref('fail'), { ...a, reason });
      if (spaceId) await ctx.runMutation(modelM('failBuild'), { spaceId, failure: reason });
    }
  },
});
