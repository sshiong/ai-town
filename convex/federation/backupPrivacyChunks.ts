import { v } from 'convex/values';
import { action, internalQuery, trackedInternalMutation as internalMutation, type MutationCtx, type DatabaseReader } from '../maintenanceFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { decodeRow, type BackupRow } from './backupHelpers';
import { descriptor, MAX_CHUNK_BYTES, type LargeChunk, type ChunkDescriptor } from './backupLargeHelpers';
import { validatePrivacyBackupRow, restorePrivacyRows } from './backupPrivacy';
import { requireAdmin, digest } from './security';
import { readLocalArchiveManifest, localArchiveExportSnapshot } from './travelPrivacyLocalChunkManifest';
import { mutationRef, queryRef } from './refs';

export async function validatePrivacyChunk(chunk: LargeChunk, expected: ChunkDescriptor) {
  if (!chunk || Object.keys(chunk).some(key => !['index', 'table', 'rows'].includes(key)) ||
    chunk.index !== expected.index || chunk.table !== 'travelPrivacyTombstones' || !Array.isArray(chunk.rows) ||
    chunk.rows.length > 100 || new TextEncoder().encode(JSON.stringify(chunk)).length > MAX_CHUNK_BYTES ||
    await digest(await descriptor(chunk)) !== await digest(expected)) throw new Error('LOCAL_ARCHIVE_PRIVACY_CHUNK_INVALID');
  return chunk.rows.map(encoded => {
    const row = decodeRow(encoded); validatePrivacyBackupRow(row);
    if (row._id !== undefined || row._creationTime !== undefined) throw new Error('LOCAL_ARCHIVE_PRIVACY_CHUNK_INVALID');
    return row;
  });
}
export async function stagedPrivacyTombstone(db: DatabaseReader, jobId: Id<'backupLargeJobs'>, key: string) {
  return !!await db.query('backupPrivacyRows').withIndex('job_key', q => q.eq('jobId', jobId).eq('key', key)).unique();
}
export function assertPrivacyChunksStaged(job: Doc<'backupLargeJobs'>) {
  if ((job.metadata?.uploadedPrivacyChunks ?? 0) !== (job.metadata?.derivativePrivacyChunkCount ?? 0))
    throw new Error('BACKUP_PRIVACY_CHUNKS_INCOMPLETE');
}
const args = { jobId: v.id('backupLargeJobs'), pageNumber: v.number(), adminToken: v.string() };
export const pageData = internalQuery({ args, handler: async (ctx, a) => {
  requireAdmin(a.adminToken);
  const job = await ctx.db.get(a.jobId);
  if (!job || !job.manifestStorageId) throw new Error('BACKUP_JOB_NOT_FOUND');
  if (job.kind === 'export') await localArchiveExportSnapshot(ctx, job);
  if (job.archivePrivacyState === 'REWRITING') throw new Error('BACKUP_PRIVACY_REWRITE_ACTIVE');
  const page = await ctx.db.query('backupPrivacyChunks').withIndex('job_page', q => q.eq('jobId', job._id).eq('pageNumber', a.pageNumber)).unique();
  return { job, page };
} });
export const getChunk = action({ args, handler: async (ctx, a): Promise<LargeChunk> => {
  const { job, page } = await ctx.runQuery(queryRef('backupPrivacyChunks/pageData'), { adminToken: a.adminToken, jobId: a.jobId, pageNumber: a.pageNumber });
  const manifest = await readLocalArchiveManifest(ctx, job);
  const expected = manifest.privacyChunks?.[a.pageNumber];
  if (!page || !expected) throw new Error('BACKUP_PRIVACY_CHUNK_MISSING');
  const blob = await ctx.storage.get(page.storageId);
  if (!blob || blob.size > MAX_CHUNK_BYTES) throw new Error('BACKUP_PRIVACY_CHUNK_MISSING');
  const chunk = JSON.parse(await blob.text()); await validatePrivacyChunk(chunk, expected);
  const after = await ctx.runQuery(queryRef('backupPrivacyChunks/pageData'), { adminToken: a.adminToken, jobId: a.jobId, pageNumber: a.pageNumber });
  if (await digest({ job, page }) !== await digest(after)) throw new Error('BACKUP_CHECKPOINT_CHANGED');
  return chunk;
} });
export const saveChunk = internalMutation({ args: { ...args, storageId: v.id('_storage'), chunk: v.any(), expected: v.any(), manifestDigest: v.string() }, handler: async (ctx, a) => {
  requireAdmin(a.adminToken);
  const job = await ctx.db.get(a.jobId);
  if (!job || job.kind !== 'import' || job.phase !== 'STAGING' || job.state !== 'STAGING' || job.metadata?.archiveLocalManifestDigest !== a.manifestDigest) throw new Error('BACKUP_CHECKPOINT_CHANGED');
  const existing = await ctx.db.query('backupPrivacyChunks').withIndex('job_page', q => q.eq('jobId', job._id).eq('pageNumber', a.pageNumber)).unique();
  if (existing) {
    if (await digest(existing.descriptor) !== await digest(a.expected)) throw new Error('BACKUP_PRIVACY_CHUNK_CONFLICT');
    return false;
  }
  const rows = await validatePrivacyChunk(a.chunk, a.expected);
  for (const row of rows) {
    const prior = await ctx.db.query('backupPrivacyRows').withIndex('job_key', q => q.eq('jobId', job._id).eq('key', row.key)).unique();
    if (!prior) await ctx.db.insert('backupPrivacyRows', { jobId: job._id, key: row.key, row });
    else {
      // A memory row may identify a conversation before its participant row arrives.
      // Union identifier ownership evidence rather than losing the later scope.
      for (const field of ['worldId', 'ownerGlobalId', 'playerId'])
        if (prior.row[field] !== undefined && row[field] !== undefined && prior.row[field] !== row[field])
          throw new Error('BACKUP_PRIVACY_OWNER_CONFLICT');
      const merged = { ...row, ...prior.row,
        ...((row.playerIds || prior.row.playerIds) ? { playerIds: [...new Set<string>([...(prior.row.playerIds ?? []), ...(row.playerIds ?? [])])].sort() } : {}) };
      await ctx.db.patch(prior._id, { row: merged });
    }
  }
  await ctx.db.insert('backupPrivacyChunks', { jobId: job._id, pageNumber: a.pageNumber, descriptor: a.expected, storageId: a.storageId });
  await ctx.db.patch(job._id, { metadata: { ...job.metadata, uploadedPrivacyChunks: (job.metadata.uploadedPrivacyChunks ?? 0) + 1 } });
  return true;
} });
export const stageChunk = action({ args: { ...args, chunk: v.string() }, handler: async (ctx, a): Promise<void> => {
  const { job } = await ctx.runQuery(queryRef('backupPrivacyChunks/pageData'), { adminToken: a.adminToken, jobId: a.jobId, pageNumber: a.pageNumber });
  if (job.kind !== 'import' || job.phase !== 'STAGING') throw new Error('BACKUP_NOT_STAGING');
  const manifest = await readLocalArchiveManifest(ctx, job);
  const expected = manifest.privacyChunks?.[a.pageNumber];
  if (!expected) throw new Error('BACKUP_PRIVACY_CHUNK_MISSING');
  if (new TextEncoder().encode(a.chunk).length > MAX_CHUNK_BYTES) throw new Error('LOCAL_ARCHIVE_PRIVACY_CHUNK_INVALID');
  const chunk = JSON.parse(a.chunk); await validatePrivacyChunk(chunk, expected);
  const storageId = await ctx.storage.store(new Blob([a.chunk], { type: 'application/json' }));
  // A lost acknowledgement may have committed; only a confirmed duplicate is disposable.
  if (!await ctx.runMutation(mutationRef('backupPrivacyChunks/saveChunk'), { ...a, chunk, expected, storageId, manifestDigest: job.metadata.archiveLocalManifestDigest })) await ctx.storage.delete(storageId);
} });
export async function restoreStagedPrivacyPage(ctx: MutationCtx, job: Doc<'backupLargeJobs'>,
  map: (row: BackupRow) => Promise<Record<string, string> | { mapping: Record<string, string>; row: BackupRow } | null>) {
  assertPrivacyChunksStaged(job);
  const page = await ctx.db.query('backupPrivacyRows').withIndex('job_key', q => q.eq('jobId', job._id))
    .paginate({ cursor: job.cursor, numItems: 20 });
  for (const value of page.page) {
    const result = await map(value.row);
    if (!result) continue;
    if (typeof result.mapping === 'object' && typeof result.row === 'object')
      await restorePrivacyRows(ctx, [result.row as BackupRow], result.mapping as Record<string, string>);
    else await restorePrivacyRows(ctx, [value.row], result as Record<string, string>);
  }
  return page;
}
