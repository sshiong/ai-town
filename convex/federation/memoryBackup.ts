import type { MutationCtx } from '../_generated/server';
import type { Doc, Id, TableNames } from '../_generated/dataModel';
import { sourceKey, sourceDocumentBytes, sourceDigestMatches, sourceEvidenceDigest } from '../agent/memorySources';
import type { BackupRow } from './backupHelpers';

export const memoryBackupTables = [
  'memorySourceCorrections', 'memoryCompressionJobs', 'memorySourceClaims', 'memorySummaryProvenance',
] as const;
export const isMemoryBackupTable = (table: string) => (memoryBackupTables as readonly string[]).includes(table);
export const skipMemoryBackupRow = (table: string, row: BackupRow) => table === 'memorySourceClaims' && row.state === 'CLAIMED';
type Lookup = (id: string) => Promise<{ table: string; row: BackupRow } | null>;
function sameOwner(row: BackupRow, owner: BackupRow) {
  if (row.worldId !== owner.worldId || row.playerId !== owner.playerId ||
    (row.agentGlobalId && owner.agentGlobalId && row.agentGlobalId !== owner.agentGlobalId))
    throw new Error('BACKUP_MEMORY_SOURCE_OWNER_MISMATCH');
}
function episodicKey(row: BackupRow) {
  const key = sourceKey(row as Doc<'memories'>);
  if (!key) throw new Error('BACKUP_MEMORY_SOURCE_NOT_EPISODIC');
  return key;
}
export function memoryBackupReferences(table: string, row: BackupRow) {
  return table === 'memorySourceClaims' && row.generation !== 'ORIGINAL'
    ? [{ id: row.generation as string, table: 'memorySourceCorrections' }] : [];
}
/** Check exact source ownership before any destination IDs are allocated. */
export async function validateMemoryBackupRelations(table: string, row: BackupRow, lookup: Lookup) {
  if (!isMemoryBackupTable(table)) return;
  const get = async (id: string, expectedTable: string) => {
    const target = await lookup(id);
    if (!target || target.table !== expectedTable) throw new Error('BACKUP_MEMORY_REFERENCE_MISSING');
    sameOwner(target.row, row);
    return target.row;
  };
  const checkSource = async (memoryId: string, key: string, correctionId?: string) => {
    const memory = await get(memoryId, 'memories');
    if (episodicKey(memory) !== key) throw new Error('BACKUP_MEMORY_SOURCE_KEY_MISMATCH');
    if (correctionId) {
      const correction = await get(correctionId, 'memorySourceCorrections');
      if (correction.sourceMemoryId !== memoryId || correction.sourceKey !== key)
        throw new Error('BACKUP_MEMORY_CORRECTION_SOURCE_MISMATCH');
    }
    return memory;
  };
  if (table === 'memorySourceCorrections') {
    await checkSource(row.sourceMemoryId, row.sourceKey);
    if (!row.text?.trim() || new TextEncoder().encode(row.text).byteLength > 4000 ||
      row.evidenceMemoryIds.length > 24 || (row.correctionOrder !== undefined &&
        (!Number.isFinite(row.correctionOrder) || row.correctionOrder < 0 || row.correctionOrder >= Number.MAX_SAFE_INTEGER)))
      throw new Error('BACKUP_MEMORY_CORRECTION_INVALID');
    for (const id of row.evidenceMemoryIds) await get(id, 'memories');
    if (row.previousCorrectionId) {
      const previous = await get(row.previousCorrectionId, 'memorySourceCorrections');
      const order = row.correctionOrder ?? row._creationTime;
      const previousOrder = previous.correctionOrder ?? previous._creationTime;
      if (previous.sourceMemoryId !== row.sourceMemoryId || previous.sourceKey !== row.sourceKey ||
        !Number.isFinite(order) || !Number.isFinite(previousOrder) || previousOrder >= order)
        throw new Error('BACKUP_MEMORY_CORRECTION_CHAIN_INVALID');
    }
    return;
  }
  if (table === 'memorySourceClaims') {
    await get(row.jobId, 'memoryCompressionJobs');
    await checkSource(row.memoryId, row.sourceKey, row.generation === 'ORIGINAL' ? undefined : row.generation);
    return;
  }
  if (table === 'memorySummaryProvenance') {
    await get(row.jobId, 'memoryCompressionJobs');
    const summary = await get(row.summaryMemoryId, 'memories');
    if (summary.data.type !== 'reflection' || !row.sources.length ||
      new Set(summary.data.relatedMemoryIds).size !== row.sources.length ||
      row.sources.some((source: BackupRow) => !summary.data.relatedMemoryIds.includes(source.memoryId)))
      throw new Error('BACKUP_MEMORY_SUMMARY_SOURCE_MISMATCH');
  }
  if (row.sources.length > 100) throw new Error('MEMORY_SOURCE_BUDGET_EXCEEDED');
  if (new Set(row.sources.map((source: BackupRow) => JSON.stringify([source.sourceKey, source.correctionId ?? 'ORIGINAL']))).size !== row.sources.length)
    throw new Error('BACKUP_MEMORY_DUPLICATE_SOURCE');
  for (const source of row.sources) await checkSource(source.memoryId, source.sourceKey, source.correctionId);
}
export function memoryBackupFields(table: string, row: BackupRow): BackupRow {
  const { _id, _creationTime, ...fields } = row;
  if (table === 'memorySourceCorrections') {
    const correctionOrder = row.correctionOrder ?? _creationTime;
    if (!Number.isFinite(correctionOrder) || correctionOrder < 0 || correctionOrder >= Number.MAX_SAFE_INTEGER)
      throw new Error('BACKUP_MEMORY_CORRECTION_INVALID');
    return { ...fields, correctionOrder };
  }
  if (table === 'memoryCompressionJobs') {
    const interrupted = ['CAPTURING', 'READY', 'RUNNING'].includes(row.state);
    return { ...fields, state: interrupted ? 'CANCELLED' : row.state,
      cursor: null, scanDone: true, leaseUntil: undefined,
      revision: row.revision + (interrupted ? 1 : 0),
      errorCode: interrupted ? 'BACKUP_RESTORE_INTERRUPTED_COMPRESSION' : row.errorCode };
  }
  return fields;
}
/** Run only after canonical memories and correction links have all been remapped. */
export async function repairMemoryBackupRow(ctx: MutationCtx, table: string, id: string, originalRow?: BackupRow, originalLookup?: Lookup) {
  if (!isMemoryBackupTable(table)) return;
  const row = await ctx.db.get(id as Id<TableNames>) as BackupRow | null;
  if (!row) throw new Error('BACKUP_MEMORY_REFERENCE_MISSING');
  if (skipMemoryBackupRow(table, row)) { await ctx.db.delete(id as Id<TableNames>); return; }
  let usedBytes = 0;
  const accountEvidence = (evidence: BackupRow | null) => {
    if (evidence) usedBytes += new TextEncoder().encode(JSON.stringify(evidence)).byteLength;
    if (usedBytes > 8 * 1024 * 1024) throw new Error('MEMORY_SOURCE_BUDGET_EXCEEDED');
  };
  const ownedMemory = async (memoryId: string) => {
    const memory = await ctx.db.get(memoryId as Id<'memories'>);
    if (!memory) throw new Error('BACKUP_MEMORY_REFERENCE_MISSING');
    sameOwner(memory, row);
    usedBytes += sourceDocumentBytes(memory);
    if (usedBytes > 8 * 1024 * 1024) throw new Error('MEMORY_SOURCE_BUDGET_EXCEEDED');
    return memory;
  };
  const sourceFor = async (source: BackupRow, original?: BackupRow) => {
    const memory = await ownedMemory(source.memoryId);
    const key = episodicKey(memory);
    const correction = source.correctionId ? await ctx.db.get(source.correctionId as Id<'memorySourceCorrections'>) : null;
    if (source.correctionId && !correction) throw new Error('BACKUP_MEMORY_REFERENCE_MISSING');
    if (correction) {
      sameOwner(correction, row);
      if (correction.sourceMemoryId !== memory._id) throw new Error('BACKUP_MEMORY_CORRECTION_SOURCE_MISMATCH');
    }
    const priorMemory = original && originalLookup ? await originalLookup(original.memoryId) : null;
    const priorCorrection = original?.correctionId && originalLookup ? await originalLookup(original.correctionId) : null;
    accountEvidence(priorMemory?.row ?? null);
    accountEvidence(priorCorrection?.row ?? null);
    const verified = !!priorMemory && priorMemory.table === 'memories' &&
      (!original!.correctionId || priorCorrection?.table === 'memorySourceCorrections') &&
      await sourceDigestMatches(priorMemory.row as Parameters<typeof sourceDigestMatches>[0],
        priorCorrection ? { _id: original!.correctionId, text: priorCorrection.row.text } : null, original!.digest);
    return { memoryId: memory._id, sourceKey: key, correctionId: correction?._id,
      digest: verified ? await sourceEvidenceDigest(memory, correction) : 'RESTORED_STALE_SOURCE' };
  };
  if (table === 'memorySourceCorrections') {
    const memory = await ownedMemory(row.sourceMemoryId);
    const key = episodicKey(memory);
    for (const evidence of row.evidenceMemoryIds) await ownedMemory(evidence);
    if (row.previousCorrectionId) {
      const previous = await ctx.db.get(row.previousCorrectionId as Id<'memorySourceCorrections'>);
      if (!previous) throw new Error('BACKUP_MEMORY_REFERENCE_MISSING');
      sameOwner(previous, row);
      if (previous.sourceMemoryId !== memory._id) throw new Error('BACKUP_MEMORY_CORRECTION_CHAIN_INVALID');
    }
    await ctx.db.patch(id as Id<'memorySourceCorrections'>, { sourceKey: key });
  } else if (table === 'memorySourceClaims') {
    const correctionId = row.generation === 'ORIGINAL' ? undefined : row.generation;
    const source = await sourceFor({ memoryId: row.memoryId, correctionId, digest: row.digest }, originalRow && {
      memoryId: originalRow.memoryId, correctionId: originalRow.generation === 'ORIGINAL' ? undefined : originalRow.generation, digest: originalRow.digest });
    const duplicate = await ctx.db.query('memorySourceClaims').withIndex('source_generation', q =>
      q.eq('worldId', row.worldId).eq('playerId', row.playerId).eq('sourceKey', source.sourceKey)
        .eq('generation', source.correctionId ?? 'ORIGINAL')).take(2);
    if (duplicate.some(claim => claim._id !== id)) throw new Error('BACKUP_MEMORY_DUPLICATE_CLAIM');
    await ctx.db.patch(id as Id<'memorySourceClaims'>, { sourceKey: source.sourceKey,
      generation: source.correctionId ?? 'ORIGINAL', digest: source.digest });
  } else {
    const sources = [];
    if (row.sources.length > 100) throw new Error('MEMORY_SOURCE_BUDGET_EXCEEDED');
    for (let index = 0; index < row.sources.length; index++) sources.push(await sourceFor(row.sources[index], originalRow?.sources[index]));
    await ctx.db.patch(id as Id<'memoryCompressionJobs'>, { sources });
  }
}

export async function repairMemoryBackupPage(ctx: MutationCtx, job: Doc<'backupLargeJobs'>, nextPhase: string,
  role: 'SOURCE' | 'OLD' = 'SOURCE', decodeOriginal?: (encoded: unknown) => BackupRow) {
  const table = memoryBackupTables[job.tableIndex];
  if (!table) throw new Error('BACKUP_CHECKPOINT_CHANGED');
  const page = await ctx.db.query('backupLargeRows').withIndex('job_table', q =>
    q.eq('jobId', job._id).eq('role', role).eq('table', table))
    .paginate({ cursor: job.cursor, numItems: 1, maximumBytesRead: 128 * 1024 });
  const lookup: Lookup = async id => {
    const source = await ctx.db.query('backupLargeRows').withIndex('job_role_source', q =>
      q.eq('jobId', job._id).eq('role', role).eq('sourceId', id)).unique();
    if (source?.metadata.envelope?.kind === 'record' && !decodeOriginal) throw new Error('BACKUP_MEMORY_REFERENCE_MISSING');
    return source ? { table: source.table, row: source.metadata.envelope?.kind === 'record'
      ? decodeOriginal!(source.metadata.envelope.record) : { ...source.metadata, _id: source.sourceId } } : null;
  };
  for (const row of page.page) if (row.newId) await repairMemoryBackupRow(ctx, table, row.newId,
    (await lookup(row.sourceId))?.row, lookup);
  const tableIndex = page.isDone ? job.tableIndex + 1 : job.tableIndex;
  const finished = tableIndex === memoryBackupTables.length;
  await ctx.db.patch(job._id, { tableIndex: finished ? 0 : tableIndex,
    cursor: page.isDone ? null : page.continueCursor,
    phase: finished ? nextPhase : job.phase, updatedAt: Date.now() });
}
