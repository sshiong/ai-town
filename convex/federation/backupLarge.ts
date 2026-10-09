import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  DatabaseReader,
  MutationCtx,
  ActionCtx,
} from '../_generated/server';
import { Doc, Id, TableNames } from '../_generated/dataModel';
import { requireAdmin, digest, sign, createIdentityKeys } from './security';
import { identity } from './store';
import { normalizeEndpoint } from './protocol';
import {
  BackupRow,
  decodeRow,
  encodeRow,
  remapValue,
  stripSystem,
  snapshotTables,
} from './backupHelpers';
import {
  ChunkDescriptor,
  LargeChunk,
  LargeManifest,
  largeTables,
  oldTables,
  descriptor,
  MAX_ARCHIVE_BYTES,
  MAX_CHUNKS,
  MAX_CHUNK_BYTES,
  TARGET_CHUNK_BYTES,
  sanitizeLargeValue,
  size,
  validateManifest,
  validateChunk,
  validateSourceRow,
} from './backupLargeHelpers';
import { assertTownUnlocked } from './maintenanceLock';
export { assertTownUnlocked } from './maintenanceLock';
import { rowMetadata, relationKey, leaseEvidence } from './backupLargeHelpers';
import { validateConnection } from '../models/profiles';
import { defaultStoragePolicy } from './storagePolicy';
import { embeddingFingerprint } from '../models/compatibility';

type Job = Doc<'backupLargeJobs'>;
const args = { adminToken: v.string(), jobId: v.id('backupLargeJobs') };
const table = (name: string) => name as TableNames;
const readRef = (name: string) => makeFunctionReference<'query'>(`federation/backupLarge:${name}`);
const writeRef = (name: string) =>
  makeFunctionReference<'mutation'>(`federation/backupLarge:${name}`);
const terminal = new Set(['COMPLETE', 'CANCELLED']);
function publicJob(job: Job) {
  return {
    jobId: job._id,
    kind: job.kind,
    mode: job.mode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    sourceTownId: job.source?.townId,
    sourceFingerprint: job.source?.fingerprint,
    uploadedChunks: job.metadata?.uploadedChunks ?? 0,
    state: job.state,
    phase: job.phase,
    table:
      job.phase === 'EXPORTING'
        ? largeTables[job.tableIndex]
        : job.phase === 'CAPTURE_OLD'
          ? oldTables[job.tableIndex]
          : undefined,
    chunkCount: job.chunkCount,
    processedChunks: job.processedChunks,
    recordCount: job.recordCount,
    bytes: job.bytes,
    error: job.error,
    canResume: job.state === 'FAILED',
  };
}
async function owned(ctx: { db: DatabaseReader }, jobId: Id<'backupLargeJobs'>) {
  const job = await ctx.db.get(jobId);
  if (!job) throw new Error('BACKUP_JOB_NOT_FOUND');
  const lock = await ctx.db
    .query('backupMaintenanceLocks')
    .withIndex('key', (q) => q.eq('key', 'town'))
    .unique();
  if (!terminal.has(job.state) && lock?.jobId !== jobId)
    throw new Error('BACKUP_MAINTENANCE_LOCK_LOST');
  return job;
}
async function stable(ctx: { db: DatabaseReader }, allowEmpty = false) {
  const local = await ctx.db.query('federationIdentity').unique();
  if (!local && !allowEmpty) throw new Error('INITIALIZE_IDENTITY_FIRST');
  if (local?.enabled) throw new Error('DISABLE_FEDERATION_BEFORE_BACKUP');
  if (
    await ctx.db
      .query('engines')
      .filter((q) => q.eq(q.field('running'), true))
      .first()
  )
    throw new Error('STOP_TARGET_ENGINE_FIRST');
  return local;
}
export const status = query({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    const job = await ctx.db.get(a.jobId);
    if (!job) throw new Error('BACKUP_JOB_NOT_FOUND');
    return publicJob(job);
  },
});
export const listJobs = query({
  args: { adminToken: v.string() },
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    return (await ctx.db.query('backupLargeJobs').order('desc').take(30)).map(publicJob);
  },
});
export const startExport = mutation({
  args: { adminToken: v.string() },
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    await assertTownUnlocked(ctx);
    const local = await stable(ctx);
    const now = Date.now();
    const jobId = await ctx.db.insert('backupLargeJobs', {
      kind: 'export',
      state: 'RUNNING',
      phase: 'EXPORTING',
      tableIndex: 0,
      cursor: null,
      chunkCount: 0,
      processedChunks: 0,
      recordCount: 0,
      bytes: 0,
      createdAt: now,
      updatedAt: now,
      source: sanitizeLargeValue(local),
    });
    await ctx.db.insert('backupMaintenanceLocks', { key: 'town', jobId, createdAt: now });
    return { jobId };
  },
});
export const jobData = internalQuery({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => owned(ctx, a.jobId),
});
export const page = internalQuery({
  args: { jobId: v.id('backupLargeJobs'), capture: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    await stable(ctx, job.mode === 'clone');
    const name = a.capture ? oldTables[job.tableIndex] : largeTables[job.tableIndex];
    if (!name) throw new Error('BACKUP_TABLE_CHECKPOINT_INVALID');
    const result = await ctx.db
      .query(table(name))
      .paginate({ cursor: job.cursor, numItems: 20, maximumBytesRead: TARGET_CHUNK_BYTES });
    const rows: BackupRow[] = result.page.map((row) => sanitizeLargeValue(row));
    if (name === 'memories') {
      const owners = new Map<string, Doc<'residentModelBindings'>[]>();
      for (const memory of rows) {
        if (memory.worldId) continue;
        let bindings = owners.get(memory.playerId);
        if (!bindings) {
          bindings = await ctx.db
            .query('residentModelBindings')
            .filter((q) => q.eq(q.field('playerId'), memory.playerId))
            .take(2);
          owners.set(memory.playerId, bindings);
        }
        if (bindings.length !== 1) throw new Error('LEGACY_MEMORY_OWNER_AMBIGUOUS');
        memory.worldId = bindings[0].worldId;
        memory.agentGlobalId = bindings[0].agentGlobalId;
      }
    }
    return { table: name, ...result, rows };
  },
});
export const chunkPage = internalQuery({
  args: { jobId: v.id('backupLargeJobs'), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    await owned(ctx, a.jobId);
    return ctx.db
      .query('backupLargeChunks')
      .withIndex('job_index', (q) => q.eq('jobId', a.jobId))
      .paginate({ cursor: a.cursor, numItems: 200, maximumBytesRead: TARGET_CHUNK_BYTES });
  },
});
export const chunkData = internalQuery({
  args: { jobId: v.id('backupLargeJobs'), index: v.number() },
  handler: async (ctx, a) => {
    await owned(ctx, a.jobId);
    return ctx.db
      .query('backupLargeChunks')
      .withIndex('job_index', (q) => q.eq('jobId', a.jobId).eq('index', a.index))
      .unique();
  },
});
export const saveExportPage = internalMutation({
  args: {
    jobId: v.id('backupLargeJobs'),
    expectedCursor: v.union(v.string(), v.null()),
    expectedTableIndex: v.number(),
    cursor: v.string(),
    done: v.boolean(),
    chunks: v.array(v.any()),
  },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (
      job.phase !== 'EXPORTING' ||
      job.cursor !== a.expectedCursor ||
      job.tableIndex !== a.expectedTableIndex
    )
      throw new Error('BACKUP_CHECKPOINT_CHANGED');
    let bytes = job.bytes,
      records = job.recordCount;
    for (const chunk of a.chunks) {
      if (chunk.index !== job.chunkCount + a.chunks.indexOf(chunk))
        throw new Error('BACKUP_CHUNK_SEQUENCE');
      await ctx.db.insert('backupLargeChunks', { ...chunk, jobId: a.jobId });
      bytes += chunk.bytes;
      records += chunk.count;
    }
    if (bytes > MAX_ARCHIVE_BYTES || job.chunkCount + a.chunks.length > MAX_CHUNKS)
      throw new Error('LARGE_BACKUP_ARCHIVE_BUDGET');
    await ctx.db.patch(job._id, {
      bytes,
      recordCount: records,
      chunkCount: job.chunkCount + a.chunks.length,
      processedChunks: job.chunkCount + a.chunks.length,
      tableIndex: a.done ? job.tableIndex + 1 : job.tableIndex,
      cursor: a.done ? null : a.cursor,
      phase: a.done && job.tableIndex + 1 === largeTables.length ? 'SIGNING' : 'EXPORTING',
      updatedAt: Date.now(),
    });
  },
});
export const finishExport = internalMutation({
  args: {
    jobId: v.id('backupLargeJobs'),
    manifestStorageId: v.id('_storage'),
    signature: v.string(),
  },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (job.phase !== 'SIGNING') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const policy = await ctx.db
      .query('storagePolicies')
      .withIndex('key', (q) => q.eq('key', 'local'))
      .unique();
    if (policy) await ctx.db.patch(policy._id, { lastVerifiedBackupAt: Date.now() });
    else
      await ctx.db.insert('storagePolicies', {
        key: 'local',
        ...defaultStoragePolicy,
        updatedAt: Date.now(),
        lastVerifiedBackupAt: Date.now(),
      });
    await ctx.db.patch(job._id, {
      manifestStorageId: a.manifestStorageId,
      signature: a.signature,
      state: 'COMPLETE',
      phase: 'COMPLETE',
      updatedAt: Date.now(),
    });
    const lock = await ctx.db
      .query('backupMaintenanceLocks')
      .withIndex('key', (q) => q.eq('key', 'town'))
      .unique();
    await ctx.db.delete(lock!._id);
  },
});
export const fail = internalMutation({
  args: { jobId: v.id('backupLargeJobs'), error: v.string() },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (terminal.has(job.state)) return;
    await ctx.db.patch(job._id, {
      state: 'FAILED',
      resumeState: job.state === 'FAILED' ? job.resumeState : job.state,
      error: a.error.slice(0, 1000),
      updatedAt: Date.now(),
    });
  },
});
export const resume = mutation({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    const job = await owned(ctx, a.jobId);
    await stable(ctx, job.mode === 'clone');
    if (job.state !== 'FAILED') throw new Error('BACKUP_JOB_NOT_FAILED');
    await ctx.db.patch(job._id, {
      state: job.resumeState ?? 'RUNNING',
      error: undefined,
      resumeState: undefined,
      updatedAt: Date.now(),
    });
    return publicJob((await ctx.db.get(job._id))!);
  },
});
async function load(ctx: ActionCtx, id: Id<'_storage'>) {
  const blob = await ctx.storage.get(id);
  if (!blob) throw new Error('BACKUP_CHUNK_STORAGE_MISSING');
  return JSON.parse(await blob.text());
}
async function storeJSON(ctx: ActionCtx, value: unknown) {
  return ctx.storage.store(new Blob([JSON.stringify(value)], { type: 'application/json' }));
}
async function exportDescriptors(ctx: ActionCtx, jobId: Id<'backupLargeJobs'>) {
  const chunks: ChunkDescriptor[] = [];
  let cursor: string | null = null;
  do {
    const result: { page: ChunkDescriptor[]; isDone: boolean; continueCursor: string } =
      await ctx.runQuery(readRef('chunkPage'), { jobId, cursor });
    chunks.push(
      ...result.page.map(({ index, table, count, bytes, digest }: ChunkDescriptor) => ({
        index,
        table,
        count,
        bytes,
        digest,
      })),
    );
    cursor = result.isDone ? null : result.continueCursor;
  } while (cursor);
  return chunks;
}
export const advanceExport = action({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    let job: Job = await ctx.runQuery(readRef('jobData'), { jobId: a.jobId });
    if (job.kind !== 'export') throw new Error('BACKUP_JOB_KIND_MISMATCH');
    if (terminal.has(job.state)) return publicJob(job);
    if (job.state === 'FAILED') throw new Error('RESUME_BACKUP_JOB_FIRST');
    const created: Id<'_storage'>[] = [];
    try {
      if (job.phase === 'EXPORTING') {
        const page = await ctx.runQuery(readRef('page'), { jobId: job._id });
        let groups: unknown[][] = [[]];
        for (const row of page.rows) {
          let current = groups[groups.length - 1];
          const encoded = encodeRow(row);
          if (
            current.length &&
            size({
              index: job.chunkCount + groups.length - 1,
              table: page.table,
              rows: [...current, encoded],
            }) > TARGET_CHUNK_BYTES
          ) {
            current = [];
            groups.push(current);
          }
          current.push(encoded);
        }
        const chunks = [];
        for (const [offset, rows] of groups.entries()) {
          const chunk: LargeChunk = { index: job.chunkCount + offset, table: page.table, rows };
          if (size(chunk) > MAX_CHUNK_BYTES) throw new Error('BACKUP_SINGLE_DOCUMENT_BUDGET');
          const storageId = await storeJSON(ctx, chunk);
          created.push(storageId);
          chunks.push({ ...(await descriptor(chunk)), storageId });
        }
        await ctx.runMutation(writeRef('saveExportPage'), {
          jobId: job._id,
          expectedCursor: job.cursor,
          expectedTableIndex: job.tableIndex,
          cursor: page.continueCursor,
          done: page.isDone,
          chunks,
        });
      } else if (job.phase === 'SIGNING') {
        const source = await ctx.runQuery(readRef('signingIdentity'), { jobId: job._id });
        const manifest: LargeManifest = {
          format: 'ai-town-chunks',
          version: 1,
          schemaVersion: 1,
          scope: 'town',
          exportId: job._id,
          source: job.source,
          exportedAt: job.createdAt,
          includeVectors: false,
          chunks: await exportDescriptors(ctx, job._id),
        };
        const signature = await sign(manifest, source.privateKeyEncrypted);
        await validateManifest(manifest, signature);
        const manifestStorageId = await storeJSON(ctx, manifest);
        created.push(manifestStorageId);
        await ctx.runMutation(writeRef('finishExport'), {
          jobId: job._id,
          manifestStorageId,
          signature,
        });
      }
    } catch (error) {
      for (const storageId of created) await ctx.storage.delete(storageId);
      if (!String(error).includes('BACKUP_CHECKPOINT_CHANGED'))
        await ctx.runMutation(writeRef('fail'), { jobId: job._id, error: String(error) });
    }
    job = await ctx.runQuery(readRef('jobData'), { jobId: a.jobId });
    return publicJob(job);
  },
});
export const signingIdentity = internalQuery({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    await owned(ctx, a.jobId);
    const local = await identity(ctx);
    if (!local) throw new Error('INITIALIZE_IDENTITY_FIRST');
    return local;
  },
});
export const getManifest = action({
  args,
  handler: async (ctx, a): Promise<{ manifest: LargeManifest; signature: string }> => {
    requireAdmin(a.adminToken);
    const job: Job = await ctx.runQuery(readRef('jobData'), { jobId: a.jobId });
    if (
      job.kind !== 'export' ||
      job.state !== 'COMPLETE' ||
      !job.manifestStorageId ||
      !job.signature
    )
      throw new Error('BACKUP_MANIFEST_NOT_READY');
    return { manifest: await load(ctx, job.manifestStorageId), signature: job.signature };
  },
});
export const getChunk = action({
  args: { ...args, index: v.number() },
  handler: async (ctx, a): Promise<string> => {
    requireAdmin(a.adminToken);
    const job: Job = await ctx.runQuery(readRef('jobData'), { jobId: a.jobId });
    if (job.kind !== 'export' || job.state !== 'COMPLETE')
      throw new Error('BACKUP_MANIFEST_NOT_READY');
    const chunk = await ctx.runQuery(readRef('chunkData'), { jobId: a.jobId, index: a.index });
    if (!chunk) throw new Error('BACKUP_CHUNK_NOT_FOUND');
    return JSON.stringify(await load(ctx, chunk.storageId));
  },
});

const importArgs = {
  adminToken: v.string(),
  manifest: v.any(),
  signature: v.string(),
  mode: v.union(v.literal('restore'), v.literal('migrate'), v.literal('clone')),
  sourceStopped: v.optional(v.boolean()),
  targetEndpoint: v.optional(v.string()),
};
const sourceRow = async (
  ctx: { db: DatabaseReader },
  jobId: Id<'backupLargeJobs'>,
  sourceId: string,
  role: 'SOURCE' | 'OLD' = 'SOURCE',
) =>
  ctx.db
    .query('backupLargeRows')
    .withIndex('job_role_source', (q) =>
      q.eq('jobId', jobId).eq('role', role).eq('sourceId', sourceId),
    )
    .unique();
const relatedRow = async (
  ctx: { db: DatabaseReader },
  jobId: Id<'backupLargeJobs'>,
  name: string,
  key: string,
) =>
  ctx.db
    .query('backupLargeRows')
    .withIndex('job_relation', (q) =>
      q.eq('jobId', jobId).eq('role', 'SOURCE').eq('table', name).eq('relationKey', key),
    )
    .unique();
async function release(ctx: MutationCtx, job: Job, state: 'COMPLETE' | 'CANCELLED') {
  await ctx.db.patch(job._id, { state, phase: state, updatedAt: Date.now(), error: undefined });
  const lock = await ctx.db
    .query('backupMaintenanceLocks')
    .withIndex('key', (q) => q.eq('key', 'town'))
    .unique();
  if (lock?.jobId !== job._id) throw new Error('BACKUP_MAINTENANCE_LOCK_LOST');
  await ctx.db.delete(lock._id);
}
export const createImportJob = internalMutation({
  args: { ...importArgs, manifestStorageId: v.id('_storage'), keys: v.optional(v.any()) },
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    await assertTownUnlocked(ctx);
    const local = await stable(ctx, a.mode === 'clone');
    await validateManifest(a.manifest, a.signature);
    const source = a.manifest.source;
    if (a.mode === 'clone') {
      if (!a.targetEndpoint) throw new Error('CLONE_ENDPOINT_REQUIRED');
      normalizeEndpoint(a.targetEndpoint);
      if (local) throw new Error('CLONE_REQUIRES_EMPTY_DESTINATION');
      // A copy must never silently erase a pre-existing local table.
      for (const name of oldTables)
        if (await ctx.db.query(table(name)).first())
          throw new Error('CLONE_REQUIRES_EMPTY_DESTINATION');
      if (!a.keys) throw new Error('CLONE_IDENTITY_KEYS_REQUIRED');
    } else {
      if (
        !local ||
        local.townId !== source.townId ||
        local.publicKey !== source.publicKey ||
        local.fingerprint !== source.fingerprint
      )
        throw new Error('RESTORE_IDENTITY_PROOF_REQUIRED');
      if (!a.sourceStopped)
        throw new Error(
          a.mode === 'migrate' ? 'MIGRATION_SOURCE_STOP_REQUIRED' : 'RESTORE_SOURCE_STOP_REQUIRED',
        );
      if (
        await ctx.db
          .query('visitLedger')
          .filter((q) =>
            q.and(q.neq(q.field('state'), 'COMPLETED'), q.neq(q.field('state'), 'REJECTED')),
          )
          .first()
      )
        throw new Error('RECONCILE_TARGET_VISITS_FIRST');
    }
    const now = Date.now();
    const jobId = await ctx.db.insert('backupLargeJobs', {
      kind: 'import',
      state: 'STAGING',
      phase: 'STAGING',
      tableIndex: 0,
      cursor: null,
      chunkCount: a.manifest.chunks.length,
      processedChunks: 0,
      recordCount: a.manifest.chunks.reduce((n: number, c: ChunkDescriptor) => n + c.count, 0),
      bytes: a.manifest.chunks.reduce((n: number, c: ChunkDescriptor) => n + c.bytes, 0),
      createdAt: now,
      updatedAt: now,
      source,
      manifestStorageId: a.manifestStorageId,
      signature: a.signature,
      mode: a.mode,
      targetEndpoint: a.targetEndpoint,
      sourceStoppedAt: a.sourceStopped ? now : undefined,
      newTownId: a.mode === 'clone' ? `town:${crypto.randomUUID()}` : local!.townId,
      keys: a.keys,
      metadata: {
        uploadedChunks: 0,
        oldChunkCount: 0,
        oldBytes: 0,
        destructive: false,
        exportedAt: a.manifest.exportedAt,
      },
    });
    await ctx.db.insert('backupMaintenanceLocks', { key: 'town', jobId, createdAt: now });
    return { jobId };
  },
});
export const createImport = action({
  args: importArgs,
  handler: async (ctx, a): Promise<{ jobId: Id<'backupLargeJobs'> }> => {
    requireAdmin(a.adminToken);
    await validateManifest(a.manifest, a.signature);
    const keys = a.mode === 'clone' ? await createIdentityKeys() : undefined;
    const manifestStorageId = await storeJSON(ctx, a.manifest);
    try {
      return await ctx.runMutation(writeRef('createImportJob'), { ...a, manifestStorageId, keys });
    } catch (error) {
      await ctx.storage.delete(manifestStorageId);
      throw error;
    }
  },
});
export const saveImportChunk = internalMutation({
  args: {
    jobId: v.id('backupLargeJobs'),
    chunkJson: v.string(),
    expected: v.any(),
    storageId: v.id('_storage'),
  },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (job.kind !== 'import' || job.phase !== 'STAGING' || job.state !== 'STAGING')
      throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const chunk: LargeChunk = JSON.parse(a.chunkJson);
    const existing = await ctx.db
      .query('backupLargeChunks')
      .withIndex('job_index', (q) => q.eq('jobId', job._id).eq('index', chunk.index))
      .unique();
    if (existing) {
      if (existing.digest !== a.expected.digest) throw new Error('BACKUP_CHUNK_CONFLICT');
      return false;
    }
    const rows = await validateChunk(chunk, a.expected);
    for (const [rowIndex, row] of rows.entries()) {
      const references = validateSourceRow(chunk.table, row);
      if (await sourceRow(ctx, job._id, row._id)) throw new Error('DUPLICATE_BACKUP_DOCUMENT_ID');
      if (
        chunk.table === 'federationIdentity' &&
        (await digest(row)) !== (await digest(job.source))
      )
        throw new Error('BACKUP_IDENTITY_MISMATCH');
      if (['chatProfiles', 'embeddingProfiles'].includes(chunk.table))
        validateConnection(row as never);
      if (chunk.table === 'embeddingProfiles') {
        if (
          !Number.isSafeInteger(row.dimensions) ||
          row.dimensions < 1 ||
          row.dimensions > 16384 ||
          row.preprocessingRevision !== 'newline-to-space-v1' ||
          row.normalization !== 'none'
        )
          throw new Error('UNSUPPORTED_BACKUP_EMBEDDING_CONFIGURATION');
        if (row.fingerprint !== embeddingFingerprint(row as never))
          throw new Error('EMBEDDING_FINGERPRINT_MISMATCH');
      }
      if (chunk.table === 'memories' && !row.worldId)
        throw new Error('LEGACY_MEMORY_OWNER_AMBIGUOUS');
      if ((snapshotTables as readonly string[]).includes(chunk.table))
        for (const [visitId, leaseExpiry] of leaseEvidence(row)) {
          const evidence = await ctx.db
            .query('backupLargeVisitEvidence')
            .withIndex('job_visit', (q) => q.eq('jobId', job._id).eq('visitId', visitId))
            .unique();
          if (evidence)
            await ctx.db.patch(evidence._id, {
              leaseExpiry: Math.max(evidence.leaseExpiry, leaseExpiry),
            });
          else
            await ctx.db.insert('backupLargeVisitEvidence', {
              jobId: job._id,
              visitId,
              leaseExpiry,
            });
        }
      const key = relationKey(chunk.table, row);
      if (key && (await relatedRow(ctx, job._id, chunk.table, key)))
        throw new Error('BACKUP_DUPLICATE_RELATION');
      const ownerGlobalId = ['residentModelBindings', 'federationAgentRuntimes'].includes(
        chunk.table,
      )
        ? row.agentGlobalId
        : undefined;
      if (
        ownerGlobalId &&
        (await ctx.db
          .query('backupLargeRows')
          .withIndex('job_owner', (q) =>
            q
              .eq('jobId', job._id)
              .eq('role', 'SOURCE')
              .eq('table', chunk.table)
              .eq('ownerGlobalId', ownerGlobalId),
          )
          .first())
      )
        throw new Error('BACKUP_DUPLICATE_GLOBAL_RESIDENT');
      await ctx.db.insert('backupLargeRows', {
        jobId: job._id,
        role: 'SOURCE',
        table: chunk.table,
        sourceId: row._id,
        chunkIndex: chunk.index,
        rowIndex,
        state: 'STAGED',
        references,
        metadata: rowMetadata(chunk.table, row),
        ownerGlobalId,
        relationKey: key,
      });
    }
    await ctx.db.insert('backupLargeChunks', {
      jobId: job._id,
      ...a.expected,
      storageId: a.storageId,
    });
    await ctx.db.patch(job._id, {
      metadata: { ...job.metadata, uploadedChunks: job.metadata.uploadedChunks + 1 },
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const stageChunk = action({
  args: { ...args, chunk: v.string() },
  handler: async (ctx, a): Promise<ReturnType<typeof publicJob>> => {
    requireAdmin(a.adminToken);
    const job: Job = await ctx.runQuery(readRef('jobData'), { jobId: a.jobId });
    if (job.kind !== 'import' || job.phase !== 'STAGING' || !job.manifestStorageId)
      throw new Error('BACKUP_NOT_STAGING');
    const manifest: LargeManifest = await load(ctx, job.manifestStorageId);
    const chunk: LargeChunk = JSON.parse(a.chunk);
    const expected = manifest.chunks[chunk?.index];
    if (!expected) throw new Error('BACKUP_CHUNK_NOT_FOUND');
    await validateChunk(chunk, expected);
    const storageId = await storeJSON(ctx, chunk);
    try {
      if (
        !(await ctx.runMutation(writeRef('saveImportChunk'), {
          jobId: job._id,
          chunkJson: a.chunk,
          expected,
          storageId,
        }))
      )
        await ctx.storage.delete(storageId);
    } catch (error) {
      await ctx.storage.delete(storageId);
      throw error;
    }
    return publicJob(await ctx.runQuery(readRef('jobData'), { jobId: a.jobId }));
  },
});
export const beginValidation = internalMutation({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (job.phase !== 'STAGING') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    if (job.metadata.uploadedChunks !== job.chunkCount) throw new Error('BACKUP_UPLOAD_INCOMPLETE');
    await ctx.db.patch(job._id, {
      state: 'VALIDATING',
      phase: 'VALIDATING',
      cursor: null,
      processedChunks: 0,
      updatedAt: Date.now(),
    });
  },
});
export const validatePage = internalMutation({
  args: { jobId: v.id('backupLargeJobs'), expectedCursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (job.phase !== 'VALIDATING' || job.cursor !== a.expectedCursor)
      throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const page = await ctx.db
      .query('backupLargeRows')
      .withIndex('job_role', (q) => q.eq('jobId', job._id).eq('role', 'SOURCE'))
      .paginate({ cursor: job.cursor, numItems: 20, maximumBytesRead: TARGET_CHUNK_BYTES });
    for (const row of page.page) {
      for (const ref of row.references) {
        const target = await sourceRow(ctx, job._id, ref.id);
        if (!target || target.table !== ref.table)
          throw new Error(`BACKUP_REFERENCE_MISSING:${row.table}:${ref.table}`);
      }
      const m = row.metadata;
      if (row.table === 'worlds') {
        if (
          !(await relatedRow(ctx, job._id, 'maps', row.sourceId)) ||
          !(await relatedRow(ctx, job._id, 'worldStatus', row.sourceId))
        )
          throw new Error('BACKUP_WORLD_INFRASTRUCTURE_MISSING');
        const locals = new Set<string>();
        for (const agent of m.agents) {
          if (locals.has(agent.playerId) || locals.has(agent.id))
            throw new Error('BACKUP_DUPLICATE_LOCAL_RESIDENT');
          locals.add(agent.playerId);
          locals.add(agent.id);
          if (
            !(await relatedRow(
              ctx,
              job._id,
              'residentModelBindings',
              `${row.sourceId}:${agent.playerId}`,
            ))
          )
            throw new Error('BACKUP_RESIDENT_BINDING_MISSING');
        }
      }
      if (row.table === 'embeddingSpaces') {
        const profile = await sourceRow(ctx, job._id, m.profileId);
        if (profile?.metadata.fingerprint !== m.fingerprint)
          throw new Error('BACKUP_EMBEDDING_SPACE_REFERENCE_MISSING');
      }
      if (row.table === 'federationAgentRuntimes') {
        const binding = await relatedRow(
          ctx,
          job._id,
          'residentModelBindings',
          `${m.worldId}:${m.playerId}`,
        );
        const world = await sourceRow(ctx, job._id, m.worldId);
        if (
          m.homeTownId !== job.source.townId ||
          binding?.metadata.agentGlobalId !== m.agentGlobalId ||
          !world?.metadata.agents.some(
            (agent: BackupRow) => agent.id === m.agentId && agent.playerId === m.playerId,
          )
        )
          throw new Error('BACKUP_RUNTIME_OWNER_MISMATCH');
      }
      if (row.table === 'memories' && m.agentGlobalId) {
        const binding = await relatedRow(
          ctx,
          job._id,
          'residentModelBindings',
          `${m.worldId}:${m.playerId}`,
        );
        if (binding?.metadata.agentGlobalId !== m.agentGlobalId)
          throw new Error('BACKUP_MEMORY_OWNER_MISMATCH');
      }
      await ctx.db.patch(row._id, { state: 'VALIDATED' });
    }
    await ctx.db.patch(job._id, {
      cursor: page.isDone ? null : page.continueCursor,
      phase: page.isDone ? 'READY' : 'VALIDATING',
      state: page.isDone ? 'READY' : 'VALIDATING',
      processedChunks: job.processedChunks + page.page.length,
      updatedAt: Date.now(),
    });
  },
});
export const startApply = mutation({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    const job = await owned(ctx, a.jobId);
    await stable(ctx, job.mode === 'clone');
    if (job.kind !== 'import' || job.state !== 'READY' || job.phase !== 'READY')
      throw new Error('BACKUP_NOT_READY');
    await ctx.db.patch(job._id, {
      state: 'APPLYING',
      phase: 'CAPTURE_OLD',
      cursor: null,
      tableIndex: 0,
      processedChunks: 0,
      updatedAt: Date.now(),
    });
    return publicJob((await ctx.db.get(job._id))!);
  },
});
export const capturePage = internalQuery({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (job.phase !== 'CAPTURE_OLD') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    await stable(ctx, job.mode === 'clone');
    const name = oldTables[job.tableIndex];
    if (!name) throw new Error('BACKUP_TABLE_CHECKPOINT_INVALID');
    const page = await ctx.db
      .query(table(name))
      .paginate({ cursor: job.cursor, numItems: 20, maximumBytesRead: TARGET_CHUNK_BYTES });
    return { ...page, table: name, rows: page.page };
  },
});
export const saveCapture = internalMutation({
  args: {
    jobId: v.id('backupLargeJobs'),
    expectedCursor: v.union(v.string(), v.null()),
    expectedTableIndex: v.number(),
    cursor: v.string(),
    done: v.boolean(),
    chunks: v.array(v.any()),
  },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (
      job.phase !== 'CAPTURE_OLD' ||
      job.cursor !== a.expectedCursor ||
      job.tableIndex !== a.expectedTableIndex
    )
      throw new Error('BACKUP_CHECKPOINT_CHANGED');
    let oldBytes = job.metadata.oldBytes,
      oldChunkCount = job.metadata.oldChunkCount;
    for (const entry of a.chunks) {
      if (
        entry.index !== job.chunkCount + oldChunkCount ||
        entry.table !== oldTables[job.tableIndex]
      )
        throw new Error('BACKUP_CHUNK_SEQUENCE');
      const chunk: LargeChunk = JSON.parse(entry.json);
      for (const [rowIndex, raw] of chunk.rows.entries()) {
        const row = decodeRow(raw);
        await ctx.db.insert('backupLargeRows', {
          jobId: job._id,
          role: 'OLD',
          table: entry.table,
          sourceId: row._id,
          chunkIndex: entry.index,
          rowIndex,
          state: 'CAPTURED',
          references: [],
          metadata: {},
        });
      }
      const { json, ...summary } = entry;
      await ctx.db.insert('backupLargeChunks', { jobId: job._id, ...summary });
      oldBytes += entry.bytes;
      oldChunkCount++;
    }
    if (oldBytes > MAX_ARCHIVE_BYTES || oldChunkCount > MAX_CHUNKS)
      throw new Error('LARGE_BACKUP_ROLLBACK_BUDGET');
    const tableIndex = a.done ? job.tableIndex + 1 : job.tableIndex;
    const captured = a.done && tableIndex === oldTables.length;
    await ctx.db.patch(job._id, {
      metadata: { ...job.metadata, oldBytes, oldChunkCount, destructive: captured },
      tableIndex: captured ? 0 : tableIndex,
      cursor: a.done ? null : a.cursor,
      phase: captured ? 'DELETE_OLD' : 'CAPTURE_OLD',
      updatedAt: Date.now(),
    });
  },
});
export const deleteOldPage = internalMutation({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (job.phase !== 'DELETE_OLD') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const name = oldTables[job.tableIndex];
    const rows = await ctx.db
      .query(table(name))
      .paginate({ cursor: null, numItems: 20, maximumBytesRead: TARGET_CHUNK_BYTES });
    for (const row of rows.page) await ctx.db.delete(row._id);
    const tableIndex = rows.isDone ? job.tableIndex + 1 : job.tableIndex;
    await ctx.db.patch(job._id, {
      tableIndex,
      phase: tableIndex === oldTables.length ? 'ALLOCATE' : 'DELETE_OLD',
      processedChunks: 0,
      updatedAt: Date.now(),
    });
  },
});
function activeFields(name: string, row: BackupRow, job: Job, allocation: boolean): BackupRow {
  let fields = stripSystem(row);
  if (name === 'engines')
    // Runtime inputs are audit snapshots, not the new active input queue.
    fields = { ...fields, running: false, generationNumber: fields.generationNumber + 1, processedInputNumber: undefined };
  if (name === 'worldStatus') fields = { ...fields, status: 'stoppedByDeveloper' };
  if (name === 'memories') {
    const { embeddingId, embeddingSpaceId, ...canonical } = fields;
    fields = canonical;
    if (allocation && fields.data.type === 'reflection')
      fields = { ...fields, data: { type: 'reflection', relatedMemoryIds: [] } };
  }
  if (name === 'worlds') {
    fields = {
      ...fields,
      players: fields.players.filter((p: BackupRow) => !p.remoteVisitor),
      conversations: [],
      historicalLocations: [],
    };
    fields.agents = fields.agents.map((agent: BackupRow) => {
      const { inProgressOperation, toRemember, ...fresh } = agent;
      if (job.mode === 'clone') {
        if (
          agent.suspendedPlayer &&
          !fields.players.some((p: BackupRow) => p.id === agent.playerId)
        )
          fields.players.push({
            ...agent.suspendedPlayer,
            pathfinding: undefined,
            activity: undefined,
            speed: 0,
          });
        delete fresh.travelVisitId;
        delete fresh.suspendedPlayer;
      }
      return fresh;
    });
    fields.players = fields.players.map((p: BackupRow) => ({
      ...p,
      pathfinding: undefined,
      activity: undefined,
      speed: 0,
    }));
  }
  if (name === 'federationAgentRuntimes')
    fields = {
      ...fields,
      homeTownId: job.newTownId,
      state: job.mode === 'clone' || !row.visitId ? 'HOME_ACTIVE' : 'NEEDS_RECONCILIATION',
      agentAuthorityEpoch: row.agentAuthorityEpoch + 1,
      activeDecisionId: undefined,
      lastError: undefined,
      visitId: job.mode === 'clone' ? undefined : row.visitId,
      updatedAt: Date.now(),
    };
  if (name === 'federationPeers')
    fields = {
      ...fields,
      credentialId: '',
      credentialEncrypted: '',
      trustState: 'UNTRUSTED',
      inboundVisitsAllowed: false,
      outboundVisitsAllowed: false,
    };
  if (name === 'embeddingSpaces')
    fields = {
      ...fields,
      status: 'RETIRED',
      validatedAt: undefined,
      validationSampleCount: undefined,
      failure: undefined,
    };
  if (name === 'storagePolicies') fields = { ...fields, lastVerifiedBackupAt: undefined };
  return fields;
}
async function mappingFor(
  ctx: { db: DatabaseReader },
  job: Job,
  role: 'SOURCE' | 'OLD',
  value: any,
): Promise<Record<string, string>> {
  const strings = new Set<string>();
  const inspect = (v: any): void => {
    if (typeof v === 'string') strings.add(v);
    else if (v && typeof v === 'object' && !(v instanceof ArrayBuffer))
      Object.values(v).forEach(inspect);
  };
  inspect(value);
  const mapping: Record<string, string> = {};
  for (const value of strings) {
    const row = await sourceRow(ctx, job._id, value, role);
    if (row?.newId) mapping[value] = row.newId;
    if (role === 'SOURCE' && job.mode === 'clone') {
      const global = await ctx.db
        .query('backupLargeGlobalMappings')
        .withIndex('job_source', (q) => q.eq('jobId', job._id).eq('sourceId', value))
        .unique();
      if (global) mapping[value] = global.targetId;
    }
  }
  return mapping;
}
export const applyChunk = internalMutation({
  args: { jobId: v.id('backupLargeJobs'), index: v.number(), chunkJson: v.string() },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    const chunk: LargeChunk = JSON.parse(a.chunkJson);
    const rollback = job.phase === 'ROLLBACK_ALLOCATE' || job.phase === 'ROLLBACK_REMAP';
    const role = rollback ? 'OLD' : 'SOURCE';
    const remapping = job.phase === 'REMAP' || job.phase === 'ROLLBACK_REMAP';
    if (
      !['ALLOCATE', 'REMAP', 'ROLLBACK_ALLOCATE', 'ROLLBACK_REMAP'].includes(job.phase) ||
      job.processedChunks !== a.index
    )
      throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const index = rollback ? job.chunkCount + a.index : a.index;
    const saved = await ctx.db
      .query('backupLargeChunks')
      .withIndex('job_index', (q) => q.eq('jobId', job._id).eq('index', index))
      .unique();
    if (
      !saved ||
      chunk.index !== index ||
      chunk.table !== saved.table ||
      (await digest(chunk)) !== saved.digest
    )
      throw new Error('BACKUP_CHECKSUM_MISMATCH');
    const skip =
      !rollback &&
      (chunk.table === 'federationIdentity' ||
        (snapshotTables as readonly string[]).includes(chunk.table));
    if (!skip)
      for (const raw of chunk.rows) {
        const row = decodeRow(raw);
        const staged = await sourceRow(ctx, job._id, row._id, role);
        if (!staged) throw new Error('BACKUP_STAGED_ROW_MISSING');
        if (
          !rollback &&
          job.mode === 'clone' &&
          ['residentModelBindings', 'federationAgentRuntimes'].includes(chunk.table) &&
          row.agentGlobalId
        ) {
          const world = await sourceRow(ctx, job._id, row.worldId);
          const runtime = await relatedRow(
            ctx,
            job._id,
            'federationAgentRuntimes',
            `${row.worldId}:${row.playerId}`,
          );
          if (!world?.newId) throw new Error('BACKUP_WORLD_REFERENCE_MISSING');
          const global = await ctx.db
            .query('backupLargeGlobalMappings')
            .withIndex('job_source', (q) =>
              q.eq('jobId', job._id).eq('sourceId', row.agentGlobalId),
            )
            .unique();
          if (!global)
            await ctx.db.insert('backupLargeGlobalMappings', {
              jobId: job._id,
              sourceId: row.agentGlobalId,
              targetId: `${job.newTownId}/agent:${world.newId}:${runtime?.metadata.agentId ?? row.playerId}`,
            });
        }
        let fields = rollback ? stripSystem(row) : activeFields(chunk.table, row, job, !remapping);
        if (rollback && !remapping && chunk.table === 'memories') {
          const { embeddingId, ...canonical } = fields;
          fields = canonical;
          if (fields.data.type === 'reflection')
            fields = { ...fields, data: { type: 'reflection', relatedMemoryIds: [] } };
        }
        const mapping = await mappingFor(ctx, job, role, fields);
        if (!rollback)
          for (const ref of validateSourceRow(chunk.table, {
            ...fields,
            _id: row._id,
            _creationTime: row._creationTime,
          }))
            if (!mapping[ref.id]) throw new Error('BACKUP_REFERENCE_NOT_ALLOCATED');
        fields = remapValue(fields, mapping);
        if (remapping) {
          if (!staged.newId) throw new Error('BACKUP_ALLOCATED_ID_MISSING');
          await ctx.db.replace(staged.newId as Id<TableNames>, fields as never);
          await ctx.db.patch(staged._id, { state: 'APPLIED' });
        } else {
          if (staged.newId) throw new Error('BACKUP_ROW_ALREADY_ALLOCATED');
          const newId = await ctx.db.insert(table(chunk.table), fields as never);
          await ctx.db.patch(staged._id, { newId, state: 'ALLOCATED' });
        }
      }
    const total = rollback ? job.metadata.oldChunkCount : job.chunkCount;
    const finished = a.index + 1 === total;
    const phase = finished
      ? job.phase === 'ALLOCATE'
        ? 'REMAP'
        : job.phase === 'REMAP'
          ? 'FINALIZE'
          : job.phase === 'ROLLBACK_ALLOCATE'
            ? 'ROLLBACK_REMAP'
            : 'ROLLBACK_FINISH'
      : job.phase;
    await ctx.db.patch(job._id, {
      phase,
      processedChunks: finished ? 0 : a.index + 1,
      updatedAt: Date.now(),
    });
  },
});
export const finalizeImport = internalMutation({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (job.phase !== 'FINALIZE') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const source = job.source;
    const now = Date.now();
    let local = await identity(ctx);
    if (job.mode === 'clone') {
      if (local) throw new Error('CLONE_REQUIRES_EMPTY_DESTINATION');
      const id = await ctx.db.insert('federationIdentity', {
        ...stripSystem(source),
        ...job.keys,
        townId: job.newTownId!,
        endpoint: normalizeEndpoint(job.targetEndpoint!),
        deploymentInstanceId: crypto.randomUUID(),
        deploymentEpoch: 1,
        enabled: false,
        allowIncomingPairRequests: false,
        allowUnencryptedHttp: false,
        allowPublicHttp: false,
        mode: 'DISABLED',
        activeHandoffId: undefined,
        migrationFrozenAt: undefined,
        migrationOperator: undefined,
        createdAt: now,
      } as never);
      local = await ctx.db.get(id);
    } else {
      if (!local || local.townId !== source.townId || local.publicKey !== source.publicKey)
        throw new Error('RESTORE_IDENTITY_PROOF_REQUIRED');
      await ctx.db.patch(local._id, {
        deploymentInstanceId: crypto.randomUUID(),
        deploymentEpoch: Math.max(local.deploymentEpoch, source.deploymentEpoch) + 1,
        townName: source.townName,
        maxVisitors: source.maxVisitors,
        maxVisitDurationMs: source.maxVisitDurationMs,
        resourceLimits: source.resourceLimits,
        endpoint: job.targetEndpoint ? normalizeEndpoint(job.targetEndpoint) : local.endpoint,
        allowUnencryptedHttp: false,
        allowPublicHttp: false,
        enabled: false,
        allowIncomingPairRequests: false,
        mode: 'NEEDS_RECONCILIATION',
        activeHandoffId: undefined,
        migrationFrozenAt: undefined,
        migrationOperator: undefined,
      });
      local = await ctx.db.get(local._id);
    }
    await ctx.db.insert('deploymentRecords', {
      townId: local!.townId,
      deploymentInstanceId: local!.deploymentInstanceId,
      deploymentEpoch: local!.deploymentEpoch,
      mode: job.mode!,
      createdAt: now,
    });
    const settings = await ctx.db
      .query('modelSettings')
      .withIndex('key', (q) => q.eq('key', 'town'))
      .unique();
    if (settings?.activeEmbeddingSpaceId) {
      const space = await ctx.db.get(settings.activeEmbeddingSpaceId);
      if (!space) throw new Error('BACKUP_EMBEDDING_SPACE_REFERENCE_MISSING');
      await ctx.db.patch(space._id, { status: 'ACTIVE' });
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'action'>('models/embeddings:rebuildPage'),
        { spaceId: space._id, cursor: null },
      );
    }
    const importId = await ctx.db.insert('backupImports', {
      sourceTownId: source.townId,
      mode: job.mode!,
      exportedAt: job.metadata.exportedAt,
      importedAt: now,
      sourceStoppedAt: job.sourceStoppedAt,
      mapping: {},
      runtimeSnapshot: { largeJobId: job._id },
      manifest: { format: 'ai-town-chunks', largeJobId: job._id, sourceTownId: source.townId },
    });
    await ctx.db.patch(job._id, { metadata: { ...job.metadata, importId } });
    await release(ctx, job, 'COMPLETE');
  },
});
export const cancel = mutation({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    const job = await owned(ctx, a.jobId);
    if (terminal.has(job.state)) return publicJob(job);
    if (job.kind === 'export' || !job.metadata?.destructive) {
      await release(ctx, job, 'CANCELLED');
    } else if (job.state !== 'ROLLING_BACK' && !job.phase.startsWith('ROLLBACK'))
      await ctx.db.patch(job._id, {
        state: 'ROLLING_BACK',
        phase: 'ROLLBACK_DELETE',
        tableIndex: 0,
        cursor: null,
        processedChunks: 0,
        error: undefined,
        resumeState: undefined,
        updatedAt: Date.now(),
      });
    return publicJob((await ctx.db.get(job._id))!);
  },
});
export const rollbackDeletePage = internalMutation({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (job.phase !== 'ROLLBACK_DELETE') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    // Delete the full affected scope, including partially deleted OLD rows. Its durable snapshot is complete.
    const name = oldTables[job.tableIndex];
    const page = await ctx.db
      .query(table(name))
      .paginate({ cursor: null, numItems: 20, maximumBytesRead: TARGET_CHUNK_BYTES });
    for (const row of page.page) await ctx.db.delete(row._id);
    const tableIndex = page.isDone ? job.tableIndex + 1 : job.tableIndex;
    await ctx.db.patch(job._id, {
      tableIndex,
      phase:
        tableIndex === oldTables.length
          ? job.metadata.oldChunkCount
            ? 'ROLLBACK_ALLOCATE'
            : 'ROLLBACK_FINISH'
          : 'ROLLBACK_DELETE',
      processedChunks: 0,
      updatedAt: Date.now(),
    });
  },
});
export const finishRollback = internalMutation({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (job.phase !== 'ROLLBACK_FINISH') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    await release(ctx, job, 'CANCELLED');
  },
});
export const advanceImport = action({
  args,
  handler: async (ctx, a): Promise<ReturnType<typeof publicJob>> => {
    requireAdmin(a.adminToken);
    let job: Job = await ctx.runQuery(readRef('jobData'), { jobId: a.jobId });
    if (job.kind !== 'import') throw new Error('BACKUP_JOB_KIND_MISMATCH');
    if (terminal.has(job.state) || job.state === 'READY') return publicJob(job);
    if (job.state === 'FAILED') throw new Error('RESUME_BACKUP_JOB_FIRST');
    const created: Id<'_storage'>[] = [];
    try {
      if (job.phase === 'STAGING')
        await ctx.runMutation(writeRef('beginValidation'), { jobId: job._id });
      else if (job.phase === 'VALIDATING')
        await ctx.runMutation(writeRef('validatePage'), {
          jobId: job._id,
          expectedCursor: job.cursor,
        });
      else if (job.phase === 'CAPTURE_OLD') {
        const page = await ctx.runQuery(readRef('capturePage'), { jobId: job._id });
        const chunks: (ChunkDescriptor & { storageId: Id<'_storage'>; json: string })[] = [];
        let rows: unknown[] = [];
        const persist = async () => {
          const chunk: LargeChunk = {
            index: job.chunkCount + job.metadata.oldChunkCount + chunks.length,
            table: page.table,
            rows,
          };
          if (size(chunk) > MAX_CHUNK_BYTES) throw new Error('BACKUP_SINGLE_DOCUMENT_BUDGET');
          const storageId = await storeJSON(ctx, chunk);
          created.push(storageId);
          chunks.push({ ...(await descriptor(chunk)), storageId, json: JSON.stringify(chunk) });
          rows = [];
        };
        for (const source of page.rows) {
          const raw = encodeRow(source);
          if (
            rows.length &&
            size({ rows: [...rows, raw], index: 0, table: page.table }) > TARGET_CHUNK_BYTES
          )
            await persist();
          rows.push(raw);
        }
        if (rows.length) await persist();
        await ctx.runMutation(writeRef('saveCapture'), {
          jobId: job._id,
          expectedCursor: job.cursor,
          expectedTableIndex: job.tableIndex,
          cursor: page.continueCursor,
          done: page.isDone,
          chunks,
        });
      } else if (job.phase === 'DELETE_OLD')
        await ctx.runMutation(writeRef('deleteOldPage'), { jobId: job._id });
      else if (['ALLOCATE', 'REMAP', 'ROLLBACK_ALLOCATE', 'ROLLBACK_REMAP'].includes(job.phase)) {
        const rollback = job.phase.startsWith('ROLLBACK');
        const index = rollback ? job.chunkCount + job.processedChunks : job.processedChunks;
        const stored = await ctx.runQuery(readRef('chunkData'), { jobId: job._id, index });
        if (!stored) throw new Error('BACKUP_CHUNK_STORAGE_MISSING');
        await ctx.runMutation(writeRef('applyChunk'), {
          jobId: job._id,
          index: job.processedChunks,
          chunkJson: JSON.stringify(await load(ctx, stored.storageId)),
        });
      } else if (job.phase === 'FINALIZE')
        await ctx.runMutation(writeRef('finalizeImport'), { jobId: job._id });
      else if (job.phase === 'ROLLBACK_DELETE')
        await ctx.runMutation(writeRef('rollbackDeletePage'), { jobId: job._id });
      else if (job.phase === 'ROLLBACK_FINISH')
        await ctx.runMutation(writeRef('finishRollback'), { jobId: job._id });
      else throw new Error('BACKUP_CHECKPOINT_INVALID');
    } catch (error) {
      for (const storageId of created) await ctx.storage.delete(storageId);
      if (!String(error).includes('BACKUP_CHECKPOINT_CHANGED'))
        await ctx.runMutation(writeRef('fail'), { jobId: job._id, error: String(error) });
    }
    job = await ctx.runQuery(readRef('jobData'), { jobId: a.jobId });
    return publicJob(job);
  },
});
