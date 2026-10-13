import { v, type Infer } from 'convex/values';
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from '../maintenanceFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { decodeRow, type BackupRow } from './backupHelpers';
import { descriptor, MAX_CHUNK_BYTES, type LargeChunk } from './backupLargeHelpers';
import { digest, verifySignature } from './security';
import { mutationRef, queryRef } from './refs';
import { chunkEvidence } from './travelPrivacyChunkSchema';
import { dataRevision, privacyRevisionKey } from '../models/embeddingDataRevision';
import { validateLocalChunkManifest, validateLocalChunk } from './travelPrivacyLocalChunkManifest';

type ObjectPlan = Doc<'travelPrivacyChunkObjects'>;
type Row = Doc<'travelPrivacyChunkRows'>;
type Evidence = Infer<typeof chunkEvidence>;
type Role = ObjectPlan['role'];
type DB = QueryCtx | MutationCtx;
const PAGE = 10, MAX_EDGES = 100;
const terminal = new Set(['COMPLETE', 'CANCELLED']);
const checkpoint = { scanId: v.id('travelPrivacyChunkScans'), revision: v.number() };
const relation = (...parts: string[]) => JSON.stringify(parts);
const id = (value: unknown) => typeof value === 'string' && value.length <= 256 ? value : undefined;
const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter(x => id(x) !== undefined).slice(0, MAX_EDGES) : [];
const backupDigest = (job: Doc<'backupLargeJobs'>) => digest(job);
const chunkDescriptor = (chunk: Doc<'backupLargeChunks'>) => ({ index: chunk.index, table: chunk.table,
  count: chunk.count, bytes: chunk.bytes, digest: chunk.digest });

/** Extract identifiers only: never persist an encoded record, prose, embedding, or bundle. */
export function inspectionEvidence(table: string, raw: unknown, rowIndex: number, selective: boolean): Evidence {
  let row = decodeRow(raw);
  if (selective) {
    if (row.kind !== 'record') return { sourceId: id(row.sourceId) ?? `external:${rowIndex}`, table: id(row.table) ?? table,
      rowIndex, relatedMemoryIds: [], evidenceMemoryIds: [], storageIds: [] };
    row = decodeRow(row.record);
  }
  const owner = table === 'coldHistoryFiles' ? row.owner : row;
  const sourceId = id(row._id);
  if (!sourceId) throw new Error('CHUNK_ROW_ID_INVALID');
  const related = row.data?.relatedMemoryIds ?? row.sources?.map((s: BackupRow) => s.memoryId);
  const evidence = row.evidenceMemoryIds;
  const storageIds = ids([row.storageId, row.manifest?.vectorArchiveStorageId, row.localArchiveStorageId].filter(Boolean));
  const largeEdges = [related, evidence].some(a => Array.isArray(a) && (a.length > MAX_EDGES || a.some(x => !id(x))));
  const worldId = id(owner?.worldId), playerId = id(owner?.playerId ?? owner?.homePlayerId), ownerGlobalId = id(owner?.agentGlobalId ?? owner?.ownerGlobalId);
  const conversationId = id(row.conversationId ?? row.data?.conversationId ?? (table === 'coldHistoryArchives' && row.kind === 'conversation' ? row.sourceId : undefined));
  const transcriptId = id(row.transcriptId ?? row.data?.transcriptId ?? (table === 'coldHistoryArchives' && row.kind === 'travel' ? row.sourceId : undefined));
  return { sourceId, table, rowIndex, worldId, playerId, ownerGlobalId,
    visitId: id(row.visitId ?? row.envelope?.visitId ?? row.data?.visitId), conversationId, transcriptId,
    relation: table === 'federationPendingActions' && id(row.inputId) ? relation(row.inputId)
      : table === 'residentModelBindings' && worldId && playerId ? relation(worldId, playerId)
      : table === 'visitLedger' && id(row.visitId) ? relation(row.visitId)
      : conversationId && worldId ? relation(worldId, conversationId)
      : transcriptId && ownerGlobalId ? relation(ownerGlobalId, transcriptId) : undefined,
    memoryId: id(row.memoryId ?? row.sourceMemoryId ?? row.summaryMemoryId ?? (table === 'coldHistoryFiles' ? owner?.memoryId : undefined)),
    memoryType: id(row.data?.type), relatedMemoryIds: ids(related), evidenceMemoryIds: ids(evidence),
    inputId: id(row.inputId), parentArchiveId: id(row.archiveId), storageIds, blocker: largeEdges ? 'EDGE_BUDGET_OR_INVALID_ID' : undefined };
}

async function checked(ctx: DB, a: { scanId: Id<'travelPrivacyChunkScans'>; revision: number }) {
  const scan = await ctx.db.get(a.scanId);
  if (!scan || scan.revision !== a.revision || ['READY_TO_REWRITE', 'BLOCKED'].includes(scan.phase)) return null;
  const job = await ctx.db.get(scan.jobId);
  if (!job || job.scope !== 'SENSITIVE' || job.revision !== scan.privacyRevision) return null;
  return { scan, job };
}

export async function beginChunkInspection(ctx: MutationCtx, job: Doc<'travelPrivacyJobs'>) {
  if (job.scope !== 'SENSITIVE') throw new Error('CHUNK_INSPECTION_REQUIRES_SENSITIVE');
  const prior = await ctx.db.query('travelPrivacyChunkScans').withIndex('job', q => q.eq('jobId', job._id)).order('desc').first();
  if (prior?.privacyRevision === job.revision) return prior._id;
  const latest = await ctx.db.query('backupLargeChunks').order('desc').first();
  return ctx.db.insert('travelPrivacyChunkScans', { jobId: job._id, privacyRevision: job.revision, version: 1,
    revision: 0, phase: 'OBJECTS', cursor: null, cutoff: latest?._creationTime ?? 0, cutoffId: latest?._id, changedInPass: false,
    objects: 0, rows: 0, selectedRows: 0, blockers: 0, blockerCodes: [],
    sourceRevision: await dataRevision(ctx.db, privacyRevisionKey), createdAt: Date.now(), updatedAt: Date.now() });
}
export const startInspection = internalMutation({
  args: { jobId: v.id('travelPrivacyJobs') }, handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job) throw new Error('CHUNK_PRIVACY_JOB_MISSING');
    return beginChunkInspection(ctx, job);
  },
});

export const pageData = internalQuery({
  args: checkpoint, handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.scan.phase !== 'OBJECTS') return null;
    const pending = await ctx.db.query('travelPrivacyChunkObjects').withIndex('scan_state', q =>
      q.eq('scanId', a.scanId).eq('state', 'INDEXING')).first();
    if (pending) return { ...current, pending, chunk: await ctx.db.get(pending.chunkId),
      backup: await ctx.db.get(pending.backupJobId), cursor: pending.nextCursor, done: pending.scanDone };
    const page = await ctx.db.query('backupLargeChunks').withIndex('by_creation_time', q => q.lte('_creationTime', current.scan.cutoff))
      .paginate({ cursor: current.scan.cursor, numItems: 1, maximumBytesRead: 128 * 1024 });
    const chunk = page.page[0] ?? null;
    return { ...current, pending: null, chunk, backup: chunk ? await ctx.db.get(chunk.jobId) : null,
      cursor: page.continueCursor, done: page.isDone };
  },
});

export const saveObjectPage = internalMutation({
  args: { ...checkpoint, chunkId: v.optional(v.id('backupLargeChunks')), expectedBackupDigest: v.optional(v.string()),
    expectedOffset: v.number(), cursor: v.union(v.string(), v.null()), done: v.boolean(),
    evidence: v.array(chunkEvidence), totalRows: v.number(), blocker: v.optional(v.string()),
    sourceManifestDigest: v.optional(v.string()), sourceManifestStorageId: v.optional(v.id('_storage')),
    sourcePublicKey: v.optional(v.string()), sourceSignature: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.scan.phase !== 'OBJECTS') return;
    const { scan } = current;
    if (a.evidence.length > PAGE) throw new Error('CHUNK_INSPECTION_PAGE_BUDGET');
    if (!a.chunkId) {
      await ctx.db.patch(scan._id, { phase: 'SEED', cursor: null, revision: scan.revision + 1, updatedAt: Date.now() });
      return;
    }
    const chunk = await ctx.db.get(a.chunkId);
    if (!chunk) {
      const plan = await ctx.db.query('travelPrivacyChunkObjects').withIndex('scan_chunk', q =>
        q.eq('scanId', scan._id).eq('chunkId', a.chunkId!)).unique();
      if (!plan) throw new Error('CHUNK_INSPECTION_SOURCE_CHANGED');
      await ctx.db.patch(plan._id, { state: 'INVALID', blockers: [...new Set([...plan.blockers, 'SOURCE_CHANGED'])] });
      await ctx.db.patch(scan._id, { phase: plan.scanDone ? 'SEED' : 'OBJECTS', cursor: plan.scanDone ? null : plan.nextCursor,
        revision: scan.revision + 1, updatedAt: Date.now() });
      return;
    }
    const backup = await ctx.db.get(chunk.jobId);
    // A missing producer remains actionable evidence attached to the physical object.
    const actualDigest = backup ? await backupDigest(backup) : 'MISSING';
    let blocker = actualDigest !== a.expectedBackupDigest ? 'SOURCE_CHANGED' : a.blocker;
    let object = await ctx.db.query('travelPrivacyChunkObjects').withIndex('scan_chunk', q =>
      q.eq('scanId', scan._id).eq('chunkId', chunk._id)).unique();
    if (object && (object.state !== 'INDEXING' || object.rowOffset !== a.expectedOffset)) return;
    if (!object && a.expectedOffset !== 0) throw new Error('CHUNK_INSPECTION_OFFSET_CHANGED');
    const role: Role = backup?.kind === 'export' ? 'EXPORT' : chunk.index < (backup?.chunkCount ?? 0) ? 'SOURCE' : 'OLD';
    if (!object) {
      const objectId = await ctx.db.insert('travelPrivacyChunkObjects', { scanId: scan._id,
        backupJobId: chunk.jobId, chunkId: chunk._id, role, originalStorageId: chunk.storageId, originalDigest: chunk.digest,
        descriptor: { index: chunk.index, table: chunk.table, count: chunk.count, bytes: chunk.bytes, digest: chunk.digest },
        backupDigest: actualDigest, state: 'INDEXING', rowOffset: 0, selectedRows: 0, selectionDigest: '',
        nextCursor: a.cursor, scanDone: a.done, referenceCursor: null, blockers: [], aliases: [],
        sourceManifestDigest: a.sourceManifestDigest, sourceManifestStorageId: a.sourceManifestStorageId,
        sourcePublicKey: a.sourcePublicKey, sourceSignature: a.sourceSignature });
      object = (await ctx.db.get(objectId))!;
    }
    if (object.originalStorageId !== chunk.storageId || await digest(object.descriptor) !== await digest(chunkDescriptor(chunk)) || object.backupDigest !== actualDigest)
      blocker = 'SOURCE_CHANGED';
    let blockers = [...object.blockers];
    if (blocker && !blockers.includes(blocker)) blockers.push(blocker);
    if (backup && !terminal.has(backup.state) && !blockers.includes('ACTIVE_BACKUP_PENDING')) blockers.push('ACTIVE_BACKUP_PENDING');
    if (!blocker) for (const evidence of a.evidence) {
      if (evidence.rowIndex !== object.rowOffset + a.evidence.indexOf(evidence)) throw new Error('CHUNK_INSPECTION_ROW_SEQUENCE');
      await ctx.db.insert('travelPrivacyChunkRows', { scanId: scan._id, objectId: object._id,
        backupJobId: chunk.jobId, role, evidence, selected: false, blocker: evidence.blocker });
    }
    const offset = object.rowOffset + (blocker ? 0 : a.evidence.length);
    const finished = !!blocker || offset === a.totalRows;
    await ctx.db.patch(object._id, { rowOffset: offset, blockers, state: blocker ? 'INVALID' : finished ? 'VERIFIED' : 'INDEXING' });
    await ctx.db.patch(scan._id, { cursor: finished ? a.cursor : scan.cursor,
      phase: finished && a.done ? 'SEED' : 'OBJECTS',
      ...(finished && a.done ? { cursor: null } : {}), objects: scan.objects + (object.rowOffset === 0 && a.expectedOffset === 0 ? 1 : 0),
      rows: scan.rows + (blocker ? 0 : a.evidence.length),
      blockers: scan.blockers + (blocker ? 0 : a.evidence.filter(e => e.blocker).length),
      revision: scan.revision + 1, updatedAt: Date.now() });
  },
});

/** One physical chunk is read and verified each action; only ten identifier rows are checkpointed. */
export const inspectPage = internalAction({
  args: checkpoint, handler: async (ctx, a): Promise<void> => {
    const data = await ctx.runQuery(queryRef('travelPrivacyChunkArchives/pageData'), a);
    if (!data) { await ctx.runMutation(mutationRef('travelPrivacyChunkArchives/planPage'), a); return; }
    const { chunk, backup, pending } = data;
    if (!chunk) {
      await ctx.runMutation(mutationRef('travelPrivacyChunkArchives/saveObjectPage'), { ...a,
        ...(pending ? { chunkId: pending.chunkId } : {}), expectedOffset: pending?.rowOffset ?? 0,
        cursor: data.cursor, done: data.done, evidence: [], totalRows: 0 });
      return;
    }
    let evidence: Evidence[] = [], blocker: string | undefined, totalRows = chunk.count;
    let sourceManifestDigest: string | undefined, sourcePublicKey: string | undefined, sourceSignature: string | undefined;
    try {
      if (!backup) throw new Error('PRODUCER_MISSING');
      const blob = await ctx.storage.get(chunk.storageId);
      if (!blob) throw new Error('STORAGE_MISSING');
      if (blob.size > MAX_CHUNK_BYTES) throw new Error('STORAGE_SIZE_LIMIT');
      const raw = JSON.parse(await blob.text()) as LargeChunk;
      const actual = await descriptor(raw);
      if (actual.digest !== chunk.digest || actual.bytes !== chunk.bytes || actual.count !== chunk.count ||
        actual.table !== chunk.table || actual.index !== chunk.index) throw new Error('DESCRIPTOR_MISMATCH');
      const role: Role = backup.kind === 'export' ? 'EXPORT' : chunk.index < backup.chunkCount ? 'SOURCE' : 'OLD';
      if (role !== 'OLD' && backup.state === 'COMPLETE' && !backup.manifestStorageId) throw new Error('SOURCE_MANIFEST_MISSING');
      if (backup.archivePrivacyState === 'LOCAL_SANITIZED') {
        if (!backup.manifestStorageId) throw new Error('SOURCE_MANIFEST_MISSING');
        const manifestBlob = await ctx.storage.get(backup.manifestStorageId);
        if (!manifestBlob || manifestBlob.size > 10_000_000) throw new Error('MANIFEST_MISSING_OR_SIZE');
        const manifest = await validateLocalChunkManifest(JSON.parse(await manifestBlob.text()), {
          expectedDigest: backup.metadata?.archiveLocalManifestDigest,
          localProof: backup.metadata?.archiveLocalProof,
        });
        if (manifest.archiveId !== backup._id) throw new Error('ARCHIVE_ID_MISMATCH');
        const expected = manifest.chunks.find(c => c.index === chunk.index);
        if (!expected || expected.role !== role || await digest({ index: expected.index, table: expected.table,
          count: expected.count, bytes: expected.bytes, digest: expected.digest }) !== await digest(actual))
          throw new Error('MANIFEST_DESCRIPTOR_MISMATCH');
        await validateLocalChunk(raw, expected);
        if (manifest.sourceEvidence.manifest &&
          (manifest.sourceEvidence.manifest.source.townId !== backup.source?.townId ||
            manifest.sourceEvidence.publicKey !== backup.source?.publicKey)) throw new Error('SOURCE_IDENTITY_MISMATCH');
        // Pin the current derivative separately from the original signed evidence embedded inside it.
        sourceManifestDigest = await digest(manifest);
        sourcePublicKey = manifest.sourceEvidence.publicKey;
        sourceSignature = manifest.sourceEvidence.signature;
      } else if (backup.manifestStorageId && role !== 'OLD') {
        const manifestBlob = await ctx.storage.get(backup.manifestStorageId);
        if (!manifestBlob || manifestBlob.size > 6 * 1024 * 1024) throw new Error('MANIFEST_MISSING_OR_SIZE');
        const manifest = JSON.parse(await manifestBlob.text());
        const expected = manifest.chunks?.find((c: { index: number }) => c.index === chunk.index);
        if (!expected || await digest(expected) !== await digest(actual)) throw new Error('MANIFEST_DESCRIPTOR_MISMATCH');
        const publicKey = manifest.source?.publicKey;
        if (manifest.source?.townId !== backup.source?.townId || publicKey !== backup.source?.publicKey)
          throw new Error('SOURCE_IDENTITY_MISMATCH');
        if (!backup.signature || !publicKey || !await verifySignature(manifest, backup.signature, publicKey))
          throw new Error('SOURCE_SIGNATURE_INVALID');
        sourceManifestDigest = await digest(manifest); sourcePublicKey = publicKey; sourceSignature = backup.signature;
      }
      const offset = pending?.rowOffset ?? 0;
      evidence = raw.rows.slice(offset, offset + PAGE).map((row, n) =>
        inspectionEvidence(chunk.table, row, offset + n, !!backup.mode?.startsWith('selective-') && role !== 'OLD'));
      totalRows = raw.rows.length;
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      blocker = /^[A-Z_]+$/.test(code) ? code : 'CHUNK_VALIDATION_FAILED';
    }
    await ctx.runMutation(mutationRef('travelPrivacyChunkArchives/saveObjectPage'), { ...a, chunkId: chunk._id,
      expectedBackupDigest: backup ? await backupDigest(backup) : 'MISSING', expectedOffset: pending?.rowOffset ?? 0,
      cursor: data.cursor, done: data.done, evidence, totalRows, blocker,
      sourceManifestDigest, ...(sourceManifestDigest ? { sourceManifestStorageId: backup!.manifestStorageId } : {}),
      sourcePublicKey, sourceSignature });
  },
});

async function scopeRow(ctx: DB, row: Row, table: string, sourceId: string) {
  return ctx.db.query('travelPrivacyChunkRows').withIndex('source', q => q.eq('scanId', row.scanId)
    .eq('backupJobId', row.backupJobId).eq('role', row.role).eq('evidence.sourceId', sourceId).eq('evidence.table', table)).take(2);
}
async function related(ctx: DB, row: Row, table: string, key: string) {
  return ctx.db.query('travelPrivacyChunkRows').withIndex('relation', q => q.eq('scanId', row.scanId)
    .eq('backupJobId', row.backupJobId).eq('role', row.role).eq('evidence.table', table).eq('evidence.relation', key)).take(101);
}

async function owner(ctx: DB, row: Row, job: Doc<'travelPrivacyJobs'>): Promise<'SELECTED' | 'OTHER' | 'UNKNOWN'> {
  const e = row.evidence;
  let global = e.ownerGlobalId;
  if (e.worldId && e.playerId) {
    const binding = await related(ctx, row, 'residentModelBindings', relation(e.worldId, e.playerId));
    if (binding.length > 1 || global && binding[0]?.evidence.ownerGlobalId && global !== binding[0].evidence.ownerGlobalId) return 'UNKNOWN';
    global ??= binding[0]?.evidence.ownerGlobalId;
  }
  if (!global) return 'UNKNOWN';
  const globalBindings = await ctx.db.query('travelPrivacyChunkRows').withIndex('owner', q => q.eq('scanId', row.scanId)
    .eq('backupJobId', row.backupJobId).eq('role', row.role).eq('evidence.table', 'residentModelBindings')
    .eq('evidence.ownerGlobalId', global!)).take(2);
  if (globalBindings.length > 1 || globalBindings[0] &&
    (e.worldId && globalBindings[0].evidence.worldId !== e.worldId || e.playerId && globalBindings[0].evidence.playerId !== e.playerId)) return 'UNKNOWN';
  let world = e.worldId;
  if (row.role === 'SOURCE') {
    const backup = await ctx.db.get(row.backupJobId);
    if (!backup) return 'UNKNOWN';
    if (backup.mode?.startsWith('selective-')) {
      const targets = (backup.metadata?.targetOwners ?? []).filter((t: { sourceAgentGlobalId: string }) => t.sourceAgentGlobalId === global);
      if (targets.length !== 1) return 'UNKNOWN';
      const target = targets[0];
      if (target.operation === 'skip') return 'UNKNOWN';
      const declared = (backup.metadata?.selection?.owners ?? []).filter((o: { agentGlobalId: string }) => o.agentGlobalId === global);
      if (declared.length !== 1 || world && declared[0].worldId !== world || e.playerId && declared[0].playerId !== e.playerId) return 'UNKNOWN';
      world = target.worldId; global = target.agentGlobalId;
    } else {
      if (world) {
        const worlds = await ctx.db.query('backupLargeRows').withIndex('job_role_source', q => q.eq('jobId', row.backupJobId)
          .eq('role', 'SOURCE').eq('sourceId', world!)).take(2);
        if (worlds.length !== 1 || worlds[0].table !== 'worlds' || !worlds[0].newId) return 'UNKNOWN';
        world = worlds[0].newId;
      }
      const mapping = await ctx.db.query('backupLargeGlobalMappings').withIndex('job_source', q =>
        q.eq('jobId', row.backupJobId).eq('sourceId', global!)).take(2);
      if (mapping.length > 1) return 'UNKNOWN';
      global = mapping[0]?.targetId ?? global;
    }
  }
  return global === job.ownerGlobalId && (!world || world === job.worldId) ? 'SELECTED' : 'OTHER';
}

async function selectedVisit(ctx: DB, row: Row, job: Doc<'travelPrivacyJobs'>) {
  if (row.evidence.visitId !== job.visitId) return false;
  const own = await owner(ctx, row, job);
  if (own !== 'UNKNOWN') return own === 'SELECTED';
  if (row.evidence.ownerGlobalId || row.evidence.playerId) return null;
  const ledgers = await related(ctx, row, 'visitLedger', relation(job.visitId));
  return ledgers.length === 1 ? (await owner(ctx, ledgers[0], job)) === 'SELECTED' : null;
}
async function memorySelected(ctx: DB, row: Row, memoryId: string) {
  const matches = await scopeRow(ctx, row, 'memories', memoryId);
  return matches.length === 1 && matches[0].selected;
}

async function rowSelection(ctx: DB, row: Row, job: Doc<'travelPrivacyJobs'>, closure: boolean) {
  const e = row.evidence;
  const visit = await selectedVisit(ctx, row, job);
  if (visit === null) return { blocker: 'VISIT_OWNER_EVIDENCE_MISSING' };
  if (visit && ['visitLedger', 'residentModelBindings'].includes(e.table)) return {};
  if (visit) {
    if (e.table === 'memories' && (await owner(ctx, row, job)) !== 'SELECTED') return { blocker: 'SHARED_VISIT_OWNER' };
    return { selection: 'VISIT' };
  }
  if (e.table === 'memories' && job.memoryIds.includes(e.sourceId as Id<'memories'>))
    return (await owner(ctx, row, job)) === 'SELECTED' ? { selection: 'CURRENT_MEMORY' } : { blocker: 'MEMORY_OWNER_AMBIGUOUS' };
  if (!closure) return {};
  if (e.parentArchiveId) {
    const archives = await scopeRow(ctx, row, 'coldHistoryArchives', e.parentArchiveId);
    if (archives.length === 1 && archives[0].selected) return { selection: 'COLD_ARCHIVE_DEPENDENCY' };
    if (archives.length > 1) return { blocker: 'COLD_ARCHIVE_EVIDENCE_AMBIGUOUS' };
  }
  if (e.conversationId && e.worldId) {
    for (const table of ['federationTurns', 'federationTranscriptJobs']) {
      const context = await related(ctx, row, table, relation(e.worldId, e.conversationId));
      if (context.length > 100) return { blocker: 'CONVERSATION_EVIDENCE_BUDGET' };
      if (context.some(c => c.selected)) {
        if (context.some(c => c.evidence.visitId && c.evidence.visitId !== job.visitId)) return { blocker: 'SHARED_CONVERSATION' };
        if (e.visitId && e.visitId !== job.visitId) return { blocker: 'SHARED_CONVERSATION' };
        if (e.table === 'memories' && (await owner(ctx, row, job)) !== 'SELECTED') return { blocker: 'SHARED_CONVERSATION_OWNER' };
        return { selection: 'CONVERSATION' };
      }
    }
  }
  if (e.transcriptId && e.ownerGlobalId) {
    const transcripts = await related(ctx, row, 'homeTravelTranscripts', relation(e.ownerGlobalId, e.transcriptId));
    if (transcripts.length > 1) return { blocker: 'TRANSCRIPT_EVIDENCE_AMBIGUOUS' };
    if (transcripts[0]?.selected) return { selection: 'TRANSCRIPT' };
  }
  if (e.memoryId && await memorySelected(ctx, row, e.memoryId)) {
    if ((e.ownerGlobalId || e.worldId || e.playerId) && await owner(ctx, row, job) !== 'SELECTED')
      return { blocker: 'SHARED_MEMORY_DEPENDENCY_OWNER' };
    return { selection: 'MEMORY_DEPENDENCY' };
  }
  const selectedEdges = await Promise.all(e.relatedMemoryIds.map(memoryId => memorySelected(ctx, row, memoryId)));
  if (selectedEdges.some(Boolean)) {
    if (e.table === 'memories' && e.memoryType === 'reflection') {
      // Mixed reflections might become fully selected during the next fixed-point pass.
      if (selectedEdges.every(Boolean)) return (await owner(ctx, row, job)) === 'SELECTED'
        ? { selection: 'REFLECTION_CLOSURE' } : { blocker: 'SHARED_DERIVED_MEMORY_OWNER' };
    } else if (e.table === 'memoryCompressionJobs') return await owner(ctx, row, job) === 'SELECTED'
      ? { selection: 'CANCEL_COMPRESSION' } : { blocker: 'SHARED_COMPRESSION_OWNER' };
    else if (e.table === 'memorySummaryProvenance' && e.memoryId && await memorySelected(ctx, row, e.memoryId))
      return { selection: 'SUMMARY_PROVENANCE' };
  }
  if (e.table === 'inputs') {
    const actions = await related(ctx, row, 'federationPendingActions', relation(e.sourceId));
    if (actions.length > 100) return { blocker: 'INPUT_EVIDENCE_BUDGET' };
    if (actions.some(action => action.selected)) return actions.every(action => action.selected)
      ? { selection: 'INPUT' } : { blocker: 'SHARED_INPUT' };
  }
  return {};
}

async function objectReferences(ctx: MutationCtx, object: ObjectPlan) {
  const aliases: ObjectPlan['aliases'] = object.aliases.filter(ref => ref.table === 'travelPrivacyChunkRows.storage');
  const chunkRefs = await ctx.db.query('backupLargeChunks').withIndex('storage', q => q.eq('storageId', object.originalStorageId)).take(101);
  const blockers = [...object.blockers];
  if (chunkRefs.length > 100) blockers.push('SHARED_ALIAS_BUDGET');
  for (const ref of chunkRefs.slice(0, 100)) {
    aliases.push({ table: 'backupLargeChunks', id: ref._id });
    const plan = await ctx.db.query('travelPrivacyChunkObjects').withIndex('scan_chunk', q => q.eq('scanId', object.scanId).eq('chunkId', ref._id)).unique();
    if (!plan || !['VERIFIED', 'CHECKED'].includes(plan.state) || plan.originalDigest !== object.originalDigest || plan.selectionDigest !== object.selectionDigest)
      blockers.push('SHARED_STORAGE_PLAN_MISMATCH');
  }
  const foreign = await Promise.all([
    ctx.db.query('backupLargeJobs').withIndex('manifestStorage', q => q.eq('manifestStorageId', object.originalStorageId)).first(),
    ctx.db.query('backupImports').withIndex('vectorArchiveStorage', q => q.eq('manifest.vectorArchiveStorageId', object.originalStorageId)).first(),
    ctx.db.query('backupImports').withIndex('localArchiveStorage', q => q.eq('localArchiveStorageId', object.originalStorageId)).first(),
    ctx.db.query('coldHistoryArchives').withIndex('storage', q => q.eq('storageId', object.originalStorageId)).first(),
    ctx.db.query('coldHistoryChunks').withIndex('storage', q => q.eq('storageId', object.originalStorageId)).first(),
    ctx.db.query('music').withIndex('storage', q => q.eq('storageId', object.originalStorageId)).first(),
  ]);
  for (const [n, ref] of foreign.entries()) if (ref) {
    aliases.push({ table: ['backupLargeJobs', 'backupImports.vector', 'backupImports.local', 'coldHistoryArchives', 'coldHistoryChunks', 'music'][n], id: ref._id });
    blockers.push('SHARED_EXTERNAL_STORAGE_REFERENCE');
  }
  const backup = await ctx.db.get(object.backupJobId), chunk = await ctx.db.get(object.chunkId);
  if (!backup || await backupDigest(backup) !== object.backupDigest || !chunk || chunk.storageId !== object.originalStorageId ||
    await digest(chunkDescriptor(chunk)) !== await digest(object.descriptor))
    blockers.push('SOURCE_CHANGED');
  return { aliases, blockers: [...new Set(blockers)] };
}

export const planPage = internalMutation({
  args: checkpoint, handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.scan.phase === 'OBJECTS') return;
    const { scan, job } = current;
    if (scan.phase === 'CHECK') {
      const object = await ctx.db.query('travelPrivacyChunkObjects').withIndex('scan_state', q => q.eq('scanId', scan._id).eq('state', 'VERIFIED')).first()
        ?? await ctx.db.query('travelPrivacyChunkObjects').withIndex('scan_state', q => q.eq('scanId', scan._id).eq('state', 'INVALID')).first();
      let blockers = scan.blockers;
      const blockerCodes = [...scan.blockerCodes];
      if (object) {
        const rows = await ctx.db.query('travelPrivacyChunkRows').withIndex('object', q => q.eq('objectId', object._id))
          .paginate({ cursor: object.referenceCursor, numItems: 1, maximumBytesRead: 128 * 1024 });
        const objectBlockers = [...object.blockers];
        for (const row of rows.page) if (row.ownerDigest !== await ownershipDigest(ctx, row) && !objectBlockers.includes('OWNER_MAPPING_CHANGED'))
          objectBlockers.push('OWNER_MAPPING_CHANGED');
        if (rows.isDone) {
          const refs = await objectReferences(ctx, { ...object, blockers: objectBlockers });
          await ctx.db.patch(object._id, { ...refs, referenceCursor: null, state: 'CHECKED' });
          blockers += refs.blockers.length;
        } else await ctx.db.patch(object._id, { referenceCursor: rows.continueCursor, blockers: objectBlockers });
      } else {
        const latest = await ctx.db.query('backupLargeChunks').order('desc').first();
        if (latest?._id !== scan.cutoffId) { blockers++; blockerCodes.push('SOURCE_SET_CHANGED'); }
        if (await dataRevision(ctx.db, privacyRevisionKey) !== scan.sourceRevision) { blockers++; blockerCodes.push('SOURCE_REVISION_CHANGED'); }
      }
      await ctx.db.patch(scan._id, { blockers, blockerCodes: [...new Set(blockerCodes)], cursor: null,
        phase: !object ? blockers ? 'BLOCKED' : 'READY_TO_REWRITE' : 'CHECK', revision: scan.revision + 1, updatedAt: Date.now() });
      return;
    }
    const page = await ctx.db.query('travelPrivacyChunkRows').withIndex('scan', q => q.eq('scanId', scan._id))
      .paginate({ cursor: scan.cursor, numItems: 1, maximumBytesRead: 128 * 1024 });
    let selected = 0, blockers = 0, changed = scan.changedInPass;
    for (const row of page.page) {
      if (scan.phase === 'VALIDATE') for (const storageId of row.evidence.storageIds) {
        const normalized = ctx.db.system.normalizeId('_storage', storageId);
        if (!normalized) continue;
        const plans = await ctx.db.query('travelPrivacyChunkObjects').withIndex('scan_storage', q =>
          q.eq('scanId', scan._id).eq('originalStorageId', normalized)).take(101);
        for (const plan of plans.slice(0, 100)) {
          if (plan.aliases.some(ref => ref.table === 'travelPrivacyChunkRows.storage' && ref.id === row._id)) continue;
          const nested = plan.aliases.filter(ref => ref.table === 'travelPrivacyChunkRows.storage');
          if (nested.length >= 100 || plans.length > 100) {
            await ctx.db.patch(plan._id, { blockers: [...new Set([...plan.blockers, 'NESTED_ALIAS_BUDGET'])] });
          } else await ctx.db.patch(plan._id, { aliases: [...plan.aliases, { table: 'travelPrivacyChunkRows.storage', id: row._id }],
            blockers: [...new Set([...plan.blockers, 'NESTED_STORAGE_ALIAS_REQUIRES_REWRITE'])] });
        }
      }
      const next = scan.phase === 'VALIDATE' ? await finalRowValidation(ctx, row, job)
        : await rowSelection(ctx, row, job, scan.phase === 'CLOSURE');
      if (scan.phase === 'SEED') await ctx.db.patch(row._id, { ownerDigest: await ownershipDigest(ctx, row) });
      if (next.blocker && !row.blocker) { await ctx.db.patch(row._id, { blocker: next.blocker }); blockers++; }
      if (next.selection && !row.selected) {
        await ctx.db.patch(row._id, { selected: true, selection: next.selection });
        const object = await ctx.db.get(row.objectId);
        await ctx.db.patch(row.objectId, { selectedRows: object!.selectedRows + 1,
          selectionDigest: await digest({ previous: object!.selectionDigest, rowIndex: row.evidence.rowIndex, selection: next.selection }) });
        selected++; changed = true;
      }
    }
    const finished = page.isDone;
    const phase = !finished ? scan.phase : scan.phase === 'VALIDATE' ? 'CHECK'
      : scan.phase === 'SEED' || changed ? 'CLOSURE' : 'VALIDATE';
    await ctx.db.patch(scan._id, { selectedRows: scan.selectedRows + selected, blockers: scan.blockers + blockers,
      changedInPass: finished ? false : changed, cursor: finished ? null : page.continueCursor,
      phase, revision: scan.revision + 1, updatedAt: Date.now() });
  },
});

async function finalRowValidation(ctx: DB, row: Row, job: Doc<'travelPrivacyJobs'>): Promise<{ blocker?: string; selection?: string }> {
  const e = row.evidence;
  if (row.blocker) return {};
  if (row.ownerDigest !== await ownershipDigest(ctx, row)) return { blocker: 'OWNER_MAPPING_CHANGED' };
  const duplicates = await scopeRow(ctx, row, e.table, e.sourceId);
  if (duplicates.length !== 1) return { blocker: 'DUPLICATE_SOURCE_ROW' };
  if (e.table === 'memories' && e.memoryType === 'reflection' && !row.selected &&
    (await Promise.all(e.relatedMemoryIds.map(memoryId => memorySelected(ctx, row, memoryId)))).some(Boolean))
    return { blocker: 'SHARED_DERIVED_MEMORY' };
  if (e.table === 'memorySourceCorrections' && !row.selected &&
    (await Promise.all(e.evidenceMemoryIds.map(memoryId => memorySelected(ctx, row, memoryId)))).some(Boolean))
    return { blocker: 'SHARED_CORRECTION' };
  if (e.visitId === job.visitId && (await owner(ctx, row, job)) === 'OTHER') {
    const ledger = await related(ctx, row, 'visitLedger', relation(job.visitId));
    for (const l of ledger) if (await owner(ctx, l, job) === 'SELECTED') return { blocker: 'SHARED_VISIT_OWNER' };
  }
  if (e.table === 'inputs') return rowSelection(ctx, row, job, true);
  return {};
}

async function ownershipDigest(ctx: DB, row: Row) {
  const e = row.evidence;
  const bindings = e.worldId && e.playerId ? await related(ctx, row, 'residentModelBindings', relation(e.worldId, e.playerId)) : [];
  const globals = [...new Set([e.ownerGlobalId, ...bindings.map(binding => binding.evidence.ownerGlobalId)].filter((g): g is string => !!g))];
  const mappings = row.role === 'SOURCE' ? await Promise.all(globals.map(global => ctx.db.query('backupLargeGlobalMappings')
    .withIndex('job_source', q => q.eq('jobId', row.backupJobId).eq('sourceId', global)).take(2))) : [];
  const worlds = row.role === 'SOURCE' && e.worldId ? await ctx.db.query('backupLargeRows').withIndex('job_role_source', q =>
    q.eq('jobId', row.backupJobId).eq('role', 'SOURCE').eq('sourceId', e.worldId!)).take(2) : [];
  const backup = await ctx.db.get(row.backupJobId);
  return digest({ bindings: bindings.map(binding => binding.evidence), mappings,
    worlds: worlds.map(world => ({ id: world._id, table: world.table, newId: world.newId, sourceId: world.sourceId })),
    selection: backup?.metadata?.selection ?? null, targets: backup?.metadata?.targetOwners ?? null });
}

export const result = internalQuery({
  args: { scanId: v.id('travelPrivacyChunkScans') }, handler: async (ctx, a) => {
    const scan = await ctx.db.get(a.scanId);
    if (!scan) return null;
    const privacyJob = await ctx.db.get(scan.jobId);
    return { ...scan, stale: !privacyJob || privacyJob.revision !== scan.privacyRevision,
      cleanupComplete: false as const, nextOperation: 'REWRITE_PUBLISH_DELETE' as const };
  },
});
