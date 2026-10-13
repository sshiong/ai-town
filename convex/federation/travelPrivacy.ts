import { messageDigest } from './transport';
import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from '../maintenanceFunctions';
import type { Doc, Id, TableNames } from '../_generated/dataModel';
import { requireAdmin } from './security';
import { visit } from './store';
import { actionRef, mutationRef } from './refs';
import { beginArchiveRewrite } from './travelPrivacyArchives';
import { beginChunkInspection } from './travelPrivacyChunkArchives';
import { beginChunkRewrite } from './travelPrivacyChunkRewrite';
import { decodeRow, encodeRow } from './backupHelpers';
import { sanitizeTravelAuditSummary } from './travelAuditWriter';
import { dataRevision, sourceKey, privacyRevisionKey } from '../models/embeddingDataRevision';
import {
  privacyTextHash,
  privatePayloadSummary,
  privacyTombstone,
  privacyCacheRevisionKey,
} from './travelPrivacyGuard';

const PAGE = 5,
  MAX_SELECTION = 1000;
const runtimeTypes = new Set(['OBSERVATION', 'DECISION', 'ACTION_RESULT', 'CONVERSATION_ENDED']);
const scope = v.union(v.literal('CACHE'), v.literal('SENSITIVE'));
const history = v.object({ importId: v.id('backupImports'), worldId: v.id('worlds'), ownerGlobalId: v.string() });
type Job = Doc<'travelPrivacyJobs'>;
const discoveryTables: TableNames[] = [
  'federationTurns',
  'federationTranscriptJobs',
  'homeTravelTranscripts',
];
const checkTables: TableNames[] = [
  'backupImports',
  'backupSelectiveHistory',
  'federationTranscriptJobs',
  'federationTurns',
  'federationInbox',
  'federationOutbox',
  'federationPendingActions',
  'federationDecisionJobs',
  'homeTravelTranscripts',
  'coldHistoryArchives',
  'coldHistoryChunks',
  'coldHistoryJobs',
  'coldArchiveMirrorJobs',
  'memorySourceCorrections',
  'memoryCompressionJobs',
];
const purgeTables: TableNames[] = [
  'federationInbox',
  'federationOutbox',
  'federationEventFacts',
  'federationActionFacts',
  'backupImports',
  'backupSelectiveHistory',
  'autonomousTravelDecisions',
  'federationTravelAudit',
  'federationPendingActions',
  'federationDecisionJobs',
  'federationTranscriptJobs',
  'homeTravelTranscriptPages',
  'homeTravelTranscripts',
  'messages',
  'messageTranslations',
  'modelMemoryVectors',
  'memoryEmbeddings',
  'embeddingsCache',
  'memorySourceCorrections',
  'memorySummaryProvenance',
  'memoryCompressionJobs',
  'coldArchiveMirrorObjects',
  'coldArchiveMirrorJobs',
  'coldHistoryMessageIds',
  'coldHistoryChunks',
  'coldHistoryJobs',
  'coldHistoryArchives',
  'memories',
];

function safeTerminal(ledger: any) {
  return ledger && ['COMPLETED', 'REJECTED'].includes(ledger.state) &&
    Number.isFinite(ledger.leaseExpiry) && Number.isFinite(ledger.leaseSafetyMs ?? 0) &&
    ledger.leaseExpiry + Math.max(60000, ledger.leaseSafetyMs ?? 0) < Date.now();
}
async function importedVisitEvidence(ctx: QueryCtx | MutationCtx, imported: Doc<'backupImports'>, visitId: string) {
  if (Array.isArray(imported.runtimeSnapshot?.visitLedger))
    return imported.runtimeSnapshot.visitLedger.map(decodeRow).filter((row: any) => row.visitId === visitId)
      .map((row: any) => ({ ledger: row,
        worldId: imported.mapping[row.worldId] ?? row.worldId,
        ownerGlobalId: imported.mapping[row.agentGlobalId] ?? row.agentGlobalId,
        playerId: imported.mapping[row.homePlayerId] ?? row.homePlayerId }));
  const selective = imported.runtimeSnapshot?.selectiveJobId;
  const jobId = selective ?? imported.runtimeSnapshot?.largeJobId;
  if (!jobId) return [];
  const job = await ctx.db.get(jobId as Id<'backupLargeJobs'>);
  if (!job || job.kind !== 'import' || job.state !== 'COMPLETE' ||
    job.metadata?.importId !== imported._id || job.source.townId !== imported.sourceTownId)
    throw new Error('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
  const staged = await ctx.db.query('backupLargeRows').withIndex('job_relation', q =>
    q.eq('jobId', job._id).eq('role', 'SOURCE').eq('table', 'visitLedger').eq('relationKey', `visit:${visitId}`)).take(2);
  if (staged.length !== 1) return [];
  if (!selective) {
    const row = staged[0].metadata;
    if (!row.state || row.visitId !== visitId || !row.worldId || !row.agentGlobalId || !row.homePlayerId)
      throw new Error('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
    const world = await ctx.db.query('backupLargeRows').withIndex('job_role_source', q =>
      q.eq('jobId', job._id).eq('role', 'SOURCE').eq('sourceId', row.worldId)).unique();
    const binding = await ctx.db.query('backupLargeRows').withIndex('job_relation', q =>
      q.eq('jobId', job._id).eq('role', 'SOURCE').eq('table', 'residentModelBindings')
        .eq('relationKey', `${row.worldId}:${row.homePlayerId}`)).unique();
    if (world?.table !== 'worlds' || !world.newId || !binding?.newId ||
      binding.metadata.agentGlobalId !== row.agentGlobalId)
      throw new Error('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
    const currentBinding = await ctx.db.get(binding.newId as Id<'residentModelBindings'>);
    const global = await ctx.db.query('backupLargeGlobalMappings').withIndex('job_source', q =>
      q.eq('jobId', job._id).eq('sourceId', row.agentGlobalId)).unique();
    const ownerGlobalId = global?.targetId ?? row.agentGlobalId;
    if (!currentBinding || currentBinding.worldId !== world.newId || currentBinding.agentGlobalId !== ownerGlobalId)
      throw new Error('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
    if (binding.metadata.worldId !== row.worldId || binding.metadata.playerId !== row.homePlayerId ||
      currentBinding.playerId !== binding.metadata.playerId)
      throw new Error('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
    return [{ ledger: row, worldId: world.newId, ownerGlobalId, playerId: currentBinding.playerId }];
  }
  const envelope = staged[0].metadata.envelope;
  if (envelope?.kind !== 'record') throw new Error('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
  const stagedLedger = decodeRow(envelope.record);
  if (stagedLedger.visitId !== visitId) return [];
  const records = await ctx.db.query('backupSelectiveHistory').withIndex('job_source', q =>
    q.eq('jobId', job._id).eq('sourceId', staged[0].sourceId)).take(2);
  if (records.length !== 1 || records[0].table !== 'visitLedger' || records[0].sourceTownId !== imported.sourceTownId)
    throw new Error('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
  const row = decodeRow(records[0].record);
  if (row._id !== staged[0].sourceId || row.visitId !== visitId ||
    JSON.stringify(row) !== JSON.stringify(stagedLedger))
    throw new Error('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
  const sourceOwners = job.metadata.selection.owners.filter((owner: any) => owner.agentGlobalId === row.agentGlobalId);
  if (sourceOwners.length !== 1 || (row.worldId && row.worldId !== sourceOwners[0].worldId) ||
    (row.homePlayerId && row.homePlayerId !== sourceOwners[0].playerId)) return [];
  return job.metadata.targetOwners.filter((owner: any) => owner.sourceAgentGlobalId === row.agentGlobalId &&
    owner.operation !== 'skip' && records[0].agentGlobalIds.includes(owner.agentGlobalId))
    .map((owner: any) => ({ ledger: row, worldId: owner.worldId, ownerGlobalId: owner.agentGlobalId, playerId: owner.playerId }));
}
export async function assertTerminal(ctx: QueryCtx | MutationCtx, visitId: string, source?: Job['history']) {
  const ledger = await visit(ctx, visitId);
  if (source) {
    // Historical evidence is never inserted into the execution ledger. A
    // current ledger always takes precedence over imported authority claims.
    if (ledger) throw new Error('TRAVEL_PRIVACY_HISTORY_HAS_CURRENT_LEDGER');
    const imported = await ctx.db.get(source.importId);
    if (!imported)
      throw new Error('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
    const candidates = (await importedVisitEvidence(ctx, imported, visitId)).filter((item: any) =>
      item.worldId === source.worldId && item.ownerGlobalId === source.ownerGlobalId);
    if (candidates.length !== 1 || candidates[0].ledger.role !== 'home' || !safeTerminal(candidates[0].ledger))
      throw new Error('TRAVEL_PRIVACY_VISIT_NOT_SAFE_TERMINAL');
    const bindings = await ctx.db.query('residentModelBindings')
      .withIndex('globalAgent', q => q.eq('agentGlobalId', source.ownerGlobalId)).take(2);
    const runtime = await ctx.db.query('federationAgentRuntimes')
      .withIndex('globalId', q => q.eq('agentGlobalId', source.ownerGlobalId)).unique();
    if (bindings.length !== 1 || bindings[0].worldId !== source.worldId ||
      candidates[0].playerId !== bindings[0].playerId ||
      !runtime || runtime.worldId !== source.worldId || runtime.playerId !== bindings[0].playerId ||
      runtime.state !== 'HOME_ACTIVE') throw new Error('TRAVEL_PRIVACY_HISTORY_RESIDENT_NOT_HOME');
    return { worldId: source.worldId, agentGlobalId: source.ownerGlobalId, role: 'home' };
  }
  if (!safeTerminal(ledger))
    throw new Error('TRAVEL_PRIVACY_VISIT_NOT_SAFE_TERMINAL');
  return ledger!;
}
function inConversation(job: Job, row: any) {
  return row.worldId === job.worldId && job.conversationIds.includes(row.conversationId);
}
function inTranscript(job: Job, row: any) {
  return row.agentGlobalId === job.ownerGlobalId && job.transcriptIds.includes(row.transcriptId);
}
function selectedArchive(job: Job, row: any) {
  return (
    row.worldId === job.worldId &&
    (row.kind === 'travel'
      ? row.ownerGlobalId === job.ownerGlobalId && job.transcriptIds.includes(row.sourceId)
      : job.conversationIds.includes(row.sourceId))
  );
}
function add<T>(array: T[], value: T) {
  if (!array.includes(value)) array.push(value);
  if (array.length > MAX_SELECTION) throw new Error('TRAVEL_PRIVACY_SELECTION_LIMIT');
}
function block(job: Job, reason: string) {
  if (!job.blockers.includes(reason)) job.blockers.push(reason);
}
async function ownedMemory(ctx: MutationCtx, job: Job, row: Doc<'memories'>, sharedReason: string) {
  const bindings = row.worldId ? await ctx.db.query('residentModelBindings')
    .withIndex('resident', q => q.eq('worldId', row.worldId!).eq('playerId', row.playerId)).take(2) : [];
  const binding = bindings[0], owner = row.agentGlobalId ?? binding?.agentGlobalId;
  if (!row.worldId || !owner) {
    block(job, 'MISSING_MEMORY_OWNERSHIP');
    return false;
  }
  const ownerBindings = await ctx.db.query('residentModelBindings')
    .withIndex('globalAgent', q => q.eq('agentGlobalId', owner)).take(2);
  if (bindings.length > 1 || ownerBindings.length > 1 || row.worldId !== job.worldId || owner !== job.ownerGlobalId ||
    (binding?.agentGlobalId && binding.agentGlobalId !== owner) ||
    ownerBindings.some(current => current.worldId !== row.worldId || current.playerId !== row.playerId)) {
    block(job, sharedReason);
    return false;
  }
  return true;
}
async function bodyMemory(ctx: MutationCtx, job: Job, row: Doc<'memories'>) {
  if (row.data.type === 'travel' && row.data.visitId === job.visitId)
    return ownedMemory(ctx, job, row, 'SHARED_VISIT_OWNERSHIP');
  return (
    (row.data.type === 'conversation' &&
      row.worldId === job.worldId &&
      job.conversationIds.includes(row.data.conversationId))
  );
}
function ownsSnapshot(job: Job, row: Doc<'backupImports'>) {
  return Array.isArray(row.runtimeSnapshot?.visitLedger) &&
    row.runtimeSnapshot.visitLedger.map(decodeRow).some((ledger: any) =>
      ledger.visitId === job.visitId &&
      (row.mapping[ledger.agentGlobalId] ?? ledger.agentGlobalId) === job.ownerGlobalId);
}
function snapshotInputs(job: Job, snapshot: Record<string, any>) {
  const actions = (snapshot.federationPendingActions ?? []).map(decodeRow);
  const selected = new Set(actions.filter((action: any) => action.visitId === job.visitId)
    .map((action: any) => action.inputId));
  const other = new Set(actions.filter((action: any) => action.visitId !== job.visitId)
    .map((action: any) => action.inputId));
  return { selected, shared: [...selected].some(id => other.has(id)) };
}
export async function scheduled(ctx: MutationCtx, job: Job) {
  await ctx.scheduler.runAfter(0, job.phase.startsWith('CHUNK_')
    ? actionRef('travelPrivacyChunkCoordinator/page') : job.phase.startsWith('ARCHIVE_')
    ? actionRef('travelPrivacyArchives/page') : mutationRef('travelPrivacy/page'), {
    jobId: job._id,
    revision: job.revision,
  });
}
function publicJob(job: Job) {
  return {
    jobId: job._id,
    visitId: job.visitId,
    scope: job.scope,
    state: job.state,
    phase: job.phase,
    counts: job.counts,
    blockers: job.blockers,
    externalCopies: job.externalCopies,
    processedRows: job.processedRows,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    archiveError: job.archiveError,
    archiveCoverage: job.archiveCoverage,
  };
}
export const status = query({
  args: { adminToken: v.string(), jobId: v.id('travelPrivacyJobs') },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const job = await ctx.db.get(args.jobId);
    return job ? publicJob(job) : null;
  },
});
export const historicalCandidates = query({
  args: { adminToken: v.string(), visitId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const records = await ctx.db.query('backupImports').order('desc').paginate({
      ...args.paginationOpts, numItems: Math.max(1, Math.min(5, args.paginationOpts.numItems)),
      maximumRowsRead: 5, maximumBytesRead: 2 * 1024 * 1024,
    });
    const page = [];
    for (const imported of records.page) {
      let evidence;
      try { evidence = await importedVisitEvidence(ctx, imported, args.visitId); }
      catch (error) {
        if (error instanceof Error && error.message === 'TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING') continue;
        throw error;
      }
      for (const item of evidence) {
        const row = item.ledger;
        if (row.visitId !== args.visitId || row.role !== 'home' || !safeTerminal(row)) continue;
        const worldId = ctx.db.normalizeId('worlds', item.worldId);
        const ownerGlobalId = item.ownerGlobalId;
        if (!worldId || typeof ownerGlobalId !== 'string') continue;
        const source = { importId: imported._id, worldId, ownerGlobalId };
        try { await assertTerminal(ctx, args.visitId, source); }
        catch (error) {
          if (error instanceof Error && ['TRAVEL_PRIVACY_HISTORY_HAS_CURRENT_LEDGER',
            'TRAVEL_PRIVACY_VISIT_NOT_SAFE_TERMINAL', 'TRAVEL_PRIVACY_HISTORY_RESIDENT_NOT_HOME'].includes(error.message)) continue;
          throw error;
        }
        const binding = await ctx.db.query('residentModelBindings')
          .withIndex('globalAgent', q => q.eq('agentGlobalId', ownerGlobalId)).unique();
        const description = binding ? await ctx.db.query('playerDescriptions')
          .withIndex('worldId', q => q.eq('worldId', worldId).eq('playerId', binding.playerId)).unique() : null;
        page.push({ history: source, residentName: description?.name ?? ownerGlobalId,
          sourceTownId: imported.sourceTownId, importedAt: imported.importedAt });
      }
    }
    return { ...records, page };
  },
});
export const inspect = mutation({
  args: { adminToken: v.string(), visitId: v.string(), scope, history: v.optional(history) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const ledger = await assertTerminal(ctx, args.visitId, args.history);
    const jobId = await ctx.db.insert('travelPrivacyJobs', {
      visitId: args.visitId,
      scope: args.scope,
      state: 'INSPECTING',
      phase: 'DISCOVER',
      tableIndex: 0,
      cursor: null,
      revision: 1,
      sourceRevision: await dataRevision(ctx.db, sourceKey),
      privacyRevision: await dataRevision(ctx.db, privacyRevisionKey),
      changed: false,
      worldId: ledger.worldId,
      role: ledger.role,
      ownerGlobalId: ledger.agentGlobalId,
      history: args.history,
      conversationIds: [],
      conversationOwners: [],
      transcriptIds: [],
      memoryIds: [],
      memoryOwners: [],
      archiveIds: [],
      textHashes: [],
      blockers: [],
      externalCopies: 0,
      counts: {},
      processedRows: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await scheduled(ctx, (await ctx.db.get(jobId))!);
    return jobId;
  },
});
export const retry = mutation({
  args: { adminToken: v.string(), jobId: v.id('travelPrivacyJobs') },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error('TRAVEL_PRIVACY_JOB_NOT_FOUND');
    if (job.state === 'COMPLETE') return publicJob(job);
    if (!['INSPECTING', 'RUNNING'].includes(job.state))
      throw new Error('TRAVEL_PRIVACY_JOB_NOT_RETRYABLE');
    const ledger = await assertTerminal(ctx, job.visitId, job.history);
    if (ledger.worldId !== job.worldId || ledger.agentGlobalId !== job.ownerGlobalId || ledger.role !== job.role)
      throw new Error('TRAVEL_PRIVACY_PREVIEW_STALE');
    // A failed mutation leaves its entire page uncommitted. Preserve that
    // checkpoint and fence any older scheduled invocation with a new revision.
    const next = { ...job, revision: job.revision + 1, updatedAt: Date.now(), archiveError: undefined };
    const rewrite = job.chunkRewriteId ? await ctx.db.get(job.chunkRewriteId) : null;
    if (rewrite && rewrite.phase !== 'DONE' && rewrite.sourceRevision !== await dataRevision(ctx.db, privacyRevisionKey))
      throw new Error('TRAVEL_PRIVACY_PREVIEW_STALE');
    await ctx.db.patch(job._id, { revision: next.revision, updatedAt: next.updatedAt, archiveError: undefined });
    await ctx.db.insert('federationTravelAudit', {
      visitId: job.visitId, source: 'travelPrivacy', operation: 'ADMIN_LOCAL_CLEAR_RETRY',
      at: Date.now(), next: { state: job.state, role: job.role },
    });
    if (rewrite && (rewrite.phase !== 'DONE' || job.phase === 'CHUNK_REWRITE')) await ctx.db.patch(rewrite._id, {
      revision: rewrite.revision + 1, expectedParentRevision: next.revision,
      // A retry fences the old scan; a fresh proof must cover the new writer checkpoint.
      referenceProofId: undefined,
      sourceRevision: rewrite.phase === 'DONE' ? rewrite.sourceRevision : await dataRevision(ctx.db, privacyRevisionKey), errorCode: undefined,
    });
    if (job.phase === 'CHUNK_CHECK') {
      const chunkScanId = await beginChunkInspection(ctx, next);
      await ctx.db.patch(job._id, { chunkScanId });
    }
    await scheduled(ctx, next);
    return publicJob(next);
  },
});
export const start = mutation({
  args: { adminToken: v.string(), jobId: v.id('travelPrivacyJobs') },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error('TRAVEL_PRIVACY_JOB_NOT_FOUND');
    if (job.state === 'RUNNING' || job.state === 'COMPLETE') return publicJob(job);
    if (job.state !== 'READY' || job.blockers.length)
      throw new Error('TRAVEL_PRIVACY_PREFLIGHT_BLOCKED');
    if (
      await ctx.db
        .query('travelPrivacyJobs')
        .withIndex('state', (q) => q.eq('state', 'RUNNING'))
        .first()
    )
      throw new Error('TRAVEL_PRIVACY_CLEAR_IN_PROGRESS');
    await assertTerminal(ctx, job.visitId, job.history);
    if (
      job.sourceRevision !== (await dataRevision(ctx.db, sourceKey)) ||
      job.privacyRevision !== (await dataRevision(ctx.db, privacyRevisionKey))
    )
      throw new Error('TRAVEL_PRIVACY_PREVIEW_STALE');
    let chunkRewriteId: Id<'travelPrivacyChunkRewrites'> | undefined;
    if (job.scope === 'SENSITIVE') {
      if (job.chunkScanId) {
        const scan = await ctx.db.get(job.chunkScanId);
        if (!scan || scan.jobId !== job._id || scan.privacyRevision !== job.revision || scan.phase !== 'READY_TO_REWRITE' ||
          scan.blockers || scan.sourceRevision !== await dataRevision(ctx.db, privacyRevisionKey))
          throw new Error('TRAVEL_PRIVACY_PREVIEW_STALE');
        if (scan.selectedRows) chunkRewriteId = await beginChunkRewrite(ctx, scan._id);
      }
      else if (await ctx.db.query('backupLargeChunks').first())
        throw new Error('TRAVEL_PRIVACY_PREVIEW_STALE');
    }
    if (job.scope === 'SENSITIVE') {
      const cacheRevision = await ctx.db
        .query('embeddingDataRevisions')
        .withIndex('key', (q) => q.eq('key', privacyCacheRevisionKey))
        .unique();
      if (cacheRevision)
        await ctx.db.patch(cacheRevision._id, { revision: cacheRevision.revision + 1 });
      else
        await ctx.db.insert('embeddingDataRevisions', {
          key: privacyCacheRevisionKey,
          revision: 1,
        });
      const keys = [
        `visit:${job.visitId}`,
        ...job.memoryIds.map((id) => `memory:${id}`),
        ...job.conversationIds.map((id) => `conversation:${job.worldId}:${id}`),
      ];
      for (const key of keys)
        if (!(await privacyTombstone(ctx.db, key)))
          await ctx.db.insert('travelPrivacyTombstones', {
            key,
            visitId: job.visitId,
            createdAt: Date.now(),
            worldId: job.worldId,
            ...(key.startsWith('conversation:')
              ? {
                  playerIds: job.conversationOwners.find(
                    (owner) => `conversation:${job.worldId}:${owner.conversationId}` === key,
                  )?.playerIds,
                }
              : {}),
            ...(key.startsWith('visit:') ? { ownerGlobalId: job.ownerGlobalId } : {}),
            ...(key.startsWith('memory:')
              ? (() => {
                  const owner = job.memoryOwners.find((item) => `memory:${item.memoryId}` === key);
                  return owner
                    ? {
                        worldId: owner.worldId,
                        ownerGlobalId: owner.ownerGlobalId,
                        playerId: owner.playerId,
                      }
                    : {};
                })()
              : {}),
          });
    }
    const archiveRewrite = job.scope === 'SENSITIVE' && await beginArchiveRewrite(ctx, job);
    const next = {
      state: 'RUNNING',
      phase: chunkRewriteId ? 'CHUNK_REWRITE' : archiveRewrite ? 'ARCHIVE_REWRITE' : 'PURGE',
      ...(chunkRewriteId ? { chunkRewriteId } : {}),
      tableIndex: 0,
      cursor: null,
      revision: job.revision + 1,
      updatedAt: Date.now(),
      ...(job.scope === 'SENSITIVE' ? { archiveCoverage: { ordinaryBundles: archiveRewrite ? 'RUNNING' as const : 'COMPLETE' as const,
        largeChunks: chunkRewriteId ? 'RUNNING' as const : 'COMPLETE' as const, orphanObjects: 'NOT_VERIFIED' as const } } : {}),
    };
    await ctx.db.patch(job._id, next);
    await ctx.db.insert('federationTravelAudit', {
      visitId: job.visitId,
      source: 'travelPrivacy',
      operation:
        job.scope === 'SENSITIVE' ? 'ADMIN_SENSITIVE_CLEAR_STARTED' : 'ADMIN_CACHE_CLEAR_STARTED',
      at: Date.now(),
      next: { state: 'RUNNING', role: job.role },
    });
    if (chunkRewriteId) await ctx.db.patch(chunkRewriteId, { expectedParentRevision: next.revision,
      sourceRevision: await dataRevision(ctx.db, privacyRevisionKey) });
    await scheduled(ctx, { ...job, ...next });
    return publicJob({ ...job, ...next });
  },
});
async function discover(ctx: MutationCtx, job: Job, table: TableNames, row: any) {
  if (row.visitId !== job.visitId) return;
  if (table === 'homeTravelTranscripts') {
    if (row.worldId === job.worldId && row.agentGlobalId === job.ownerGlobalId)
      add(job.transcriptIds, row.transcriptId);
    else if (job.scope === 'SENSITIVE') block(job, 'SHARED_VISIT_OWNERSHIP');
  }
  if (job.role === 'host' && row.worldId === job.worldId && row.conversationId) {
    add(job.conversationIds, row.conversationId);
    if (!job.conversationOwners.some((owner) => owner.conversationId === row.conversationId)) {
      const archived = await ctx.db
        .query('archivedConversations')
        .withIndex('worldId', (q) => q.eq('worldId', row.worldId).eq('id', row.conversationId))
        .unique();
      if (!archived) block(job, 'MISSING_CONVERSATION_OWNERSHIP');
      else
        job.conversationOwners.push({
          conversationId: row.conversationId,
          playerIds: archived.participants,
        });
    }
  }
}
async function inspectMemory(ctx: MutationCtx, job: Job, row: Doc<'memories'>, final: boolean) {
  if (await bodyMemory(ctx, job, row) && !job.memoryIds.includes(row._id)) {
    add(job.memoryIds, row._id);
    job.changed = true;
  }
  if (
    row.data.type === 'reflection' &&
    row.data.relatedMemoryIds.some((id) => job.memoryIds.includes(id))
  ) {
    // Exclusive dependencies do not prove ownership. A foreign or ambiguous
    // dependent must block clearing its sources as well as its own body.
    if (!await ownedMemory(ctx, job, row, 'SHARED_DERIVED_MEMORY')) return;
    if (row.data.relatedMemoryIds.every((id) => job.memoryIds.includes(id))) {
      if (!job.memoryIds.includes(row._id)) {
        add(job.memoryIds, row._id);
        job.changed = true;
      }
    } else if (final) block(job, 'SHARED_DERIVED_MEMORY');
  }
  if (job.memoryIds.includes(row._id)) {
    if (!job.memoryOwners.some((owner) => owner.memoryId === row._id)) {
      const binding =
        row.worldId && !row.agentGlobalId
          ? await ctx.db
              .query('residentModelBindings')
              .withIndex('resident', (q) =>
                q.eq('worldId', row.worldId!).eq('playerId', row.playerId),
              )
              .unique()
          : null;
      job.memoryOwners.push({
        memoryId: row._id,
        worldId: row.worldId,
        playerId: row.playerId,
        ownerGlobalId: row.agentGlobalId ?? binding?.agentGlobalId,
      });
    }
    add(job.textHashes, await privacyTextHash(row.description));
    if (row.data.type === 'travel' && row.data.messageText)
      add(job.textHashes, await privacyTextHash(row.data.messageText));
  }
}
async function check(ctx: MutationCtx, job: Job, table: TableNames, row: any) {
  const ownVisit = (row.visitId ?? row.envelope?.visitId) === job.visitId;
  if (
    job.scope === 'SENSITIVE' &&
    (table === 'federationTranscriptJobs' || table === 'federationTurns') &&
    inConversation(job, row) &&
    !ownVisit
  )
    block(job, 'SHARED_CONVERSATION');
  if (ownVisit) {
    if (table === 'federationInbox' && !['COMMITTED', 'REJECTED', 'DISCARDED'].includes(row.status))
      block(job, 'PENDING_DELIVERY');
    if (table === 'federationOutbox' && !(row.failedAt || (row.ackedAt && !row.lastError)))
      block(job, 'PENDING_DELIVERY');
    if (
      table === 'federationPendingActions' &&
      (!['COMMITTED', 'REJECTED'].includes(row.state) || row.receiptPending)
    )
      block(job, 'PENDING_ACTION');
    if (
      table === 'federationDecisionJobs' &&
      !['COMPLETED', 'COMMITTED', 'EXPIRED', 'FAILED', 'REJECTED'].includes(row.state)
    )
      block(job, 'PENDING_DECISION');
    if (
      table === 'federationTranscriptJobs' &&
      !['DELIVERED', 'COMPLETE', 'COMPLETED', 'FAILED'].includes(row.state)
    )
      block(job, 'PENDING_TRANSCRIPT');
    if (table === 'homeTravelTranscripts' && row.summaryState === 'RUNNING')
      block(job, 'PENDING_SUMMARY');
  }
  if (job.scope === 'CACHE') return;
  if (table === 'backupSelectiveHistory') {
    try { await historicalFactRedaction(ctx, job, row); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING')
        throw error;
      block(job, 'IMPORTED_HISTORY_EVIDENCE_MISMATCH');
    }
  }
  if (table === 'backupImports' && ownsSnapshot(job, row) && snapshotInputs(job, row.runtimeSnapshot).shared)
    block(job, 'SHARED_IMPORTED_INPUT');
  if (table === 'coldHistoryArchives' && selectedArchive(job, row)) {
    add(job.archiveIds, row._id);
    if (row.state !== 'VERIFIED') block(job, 'PENDING_COLD_ARCHIVE');
    if (row.storageId) await checkStorageSharing(ctx, job, row.storageId, row._id);
  }
  if (table === 'coldHistoryChunks' && job.archiveIds.includes(row.archiveId))
    await checkStorageSharing(ctx, job, row.storageId, row.archiveId);
  if (
    table === 'coldHistoryJobs' &&
    job.archiveIds.includes(row.archiveId) &&
    !['COMPLETE', 'FAILED', 'CANCELLED'].includes(row.state)
  )
    block(job, 'PENDING_COLD_ARCHIVE');
  if (table === 'coldArchiveMirrorJobs' && job.archiveIds.includes(row.archiveId)) {
    job.externalCopies++;
    if (row.state === 'RUNNING') block(job, 'PENDING_EXTERNAL_MIRROR');
  }
  if (
    table === 'memorySourceCorrections' &&
    (job.memoryIds.includes(row.sourceMemoryId) ||
      row.evidenceMemoryIds.some((id: any) => job.memoryIds.includes(id)))
  ) {
    if (!job.memoryIds.includes(row.sourceMemoryId)) block(job, 'SHARED_CORRECTION');
  }
  if (
    table === 'memoryCompressionJobs' &&
    row.sources.some((s: any) => job.memoryIds.includes(s.memoryId)) &&
    !['DONE', 'FAILED', 'CANCELLED'].includes(row.state)
  )
    block(job, 'PENDING_MEMORY_JOB');
  if (
    (table === 'federationTurns' || table === 'federationTranscriptJobs') &&
    ownVisit &&
    row.worldId &&
    row.conversationId
  ) {
    const world = await ctx.db.get(row.worldId as Id<'worlds'>);
    if (world?.conversations.some((c) => c.id === row.conversationId))
      block(job, 'ACTIVE_CONVERSATION');
  }
}
async function checkStorageSharing(ctx: MutationCtx, job: Job, id: any, archiveId: any) {
  const archives = await ctx.db
    .query('coldHistoryArchives')
    .withIndex('storage', (q) => q.eq('storageId', id))
    .take(2);
  const chunks = await ctx.db
    .query('coldHistoryChunks')
    .withIndex('storage', (q) => q.eq('storageId', id))
    .take(2);
  if (
    archives.some((a) => a._id !== archiveId) ||
    chunks.length > 1 ||
    chunks.some((c) => c.archiveId !== archiveId)
  )
    block(job, 'SHARED_COLD_OBJECT');
}
async function eraseStorage(ctx: MutationCtx, id: any, archiveId: any) {
  // Shared storage objects are immutable; the preflight rejects sharing before any deletion.
  const archives = await ctx.db
    .query('coldHistoryArchives')
    .withIndex('storage', (q) => q.eq('storageId', id))
    .take(2);
  const chunks = await ctx.db
    .query('coldHistoryChunks')
    .withIndex('storage', (q) => q.eq('storageId', id))
    .take(2);
  if (
    archives.some((a) => a._id !== archiveId) ||
    chunks.length > 1 ||
    chunks.some((c) => c.archiveId !== archiveId)
  )
    throw new Error('TRAVEL_PRIVACY_SHARED_STORAGE');
  await ctx.storage.delete(id);
}
function redactHistoricalFact(table: string, archived: Record<string, any>) {
  if (table === 'federationEventFacts')
    archived.payload = privatePayloadSummary(archived.payload);
  else if (table === 'federationActionFacts') {
    archived.action = { type: archived.action?.type, privacyRedacted: true };
    archived.result = archived.result?.kind === 'ok'
      ? { kind: 'ok', value: null }
      : { kind: 'error', message: 'PRIVACY_REDACTED' };
    archived.receiptPayload = privatePayloadSummary(archived.receiptPayload);
  } else if (table === 'federationTravelAudit') {
    for (const field of ['previous', 'next']) {
      const summary = sanitizeTravelAuditSummary(archived[field]);
      if (summary === undefined) delete archived[field];
      else archived[field] = summary;
    }
  } else {
    delete archived.reason;
    delete archived.error;
  }
  return archived;
}
async function historicalFactRedaction(ctx: MutationCtx, job: Job, row: Doc<'backupSelectiveHistory'>) {
  if (!row.agentGlobalIds.includes(job.ownerGlobalId) ||
    !['federationEventFacts', 'federationActionFacts', 'autonomousTravelDecisions', 'federationTravelAudit'].includes(row.table))
    return null;
  const archived = decodeRow(row.record);
  if (archived.visitId !== job.visitId) return null;
  const record = encodeRow(redactHistoricalFact(row.table, archived));
  const sources = await ctx.db.query('backupLargeRows').withIndex('job_role_source', q =>
    q.eq('jobId', row.jobId).eq('role', 'SOURCE').eq('sourceId', row.sourceId)).take(2);
  if (sources.length > 1) throw new Error('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
  const staged = sources[0] ?? null;
  if (staged) {
    const imported = await ctx.db.get(row.jobId);
    const envelope = staged.metadata.envelope;
    if (!imported || imported.kind !== 'import' || imported.mode !== 'selective-import' ||
      imported.state !== 'COMPLETE' || imported.source.townId !== row.sourceTownId ||
      staged.table !== row.table || envelope?.kind !== 'record')
      throw new Error('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
    const source = decodeRow(envelope.record);
    // Normalize both copies before comparing: an older clear may already
    // have erased History while leaving its SOURCE body intact.
    if (source._id !== row.sourceId || archived._id !== row.sourceId ||
      source.visitId !== job.visitId || encodeRow(redactHistoricalFact(row.table, source)) !== record)
      throw new Error('TRAVEL_PRIVACY_HISTORY_EVIDENCE_MISSING');
  }
  return { record, staged };
}
async function purge(ctx: MutationCtx, job: Job, table: TableNames, row: any): Promise<boolean> {
  const sensitive = job.scope === 'SENSITIVE',
    own = (row.visitId ?? row.envelope?.visitId) === job.visitId;
  if (sensitive && table === 'backupImports') {
    const snapshot = row.runtimeSnapshot;
    // Large/selective snapshots are references, handled separately. Ordinary
    // snapshots contain encoded source rows and must retain reconciliation evidence.
    if (!ownsSnapshot(job, row)) return false;
    const next = { ...snapshot };
    const { selected: inputIds, shared } = snapshotInputs(job, snapshot);
    if (shared)
      throw new Error('TRAVEL_PRIVACY_SHARED_IMPORTED_INPUT');
    let changed = false;
    for (const name of ['federationInbox', 'federationOutbox', 'federationPendingActions',
      'federationDecisionJobs', 'federationTranscriptJobs', 'inputs']) {
      if (!Array.isArray(snapshot[name])) continue;
      next[name] = snapshot[name].map((encoded: unknown) => {
        const source = decodeRow(encoded);
        if (name === 'inputs') {
          if (!inputIds.has(source._id)) return encoded;
          source.args = {};
          if (source.returnValue !== undefined)
            source.returnValue = source.returnValue?.kind === 'ok'
              ? { kind: 'ok', value: null } : { kind: 'error', message: 'PRIVACY_REDACTED' };
        } else {
          if ((source.visitId ?? source.envelope?.visitId) !== job.visitId) return encoded;
          if (name === 'federationInbox' || name === 'federationOutbox') {
            if (!runtimeTypes.has(source.envelope?.type)) return encoded;
            source.envelope = { ...source.envelope, payload: privatePayloadSummary(source.envelope.payload) };
            delete source.lastError;
          } else if (name === 'federationPendingActions') {
            source.action = { type: source.action?.type, privacyRedacted: true };
            source.result = source.result?.kind === 'ok'
              ? { kind: 'ok', value: null } : { kind: 'error', message: 'PRIVACY_REDACTED' };
            source.receiptPayload = privatePayloadSummary(source.receiptPayload);
          } else if (name === 'federationDecisionJobs') {
            source.observation = {};
            delete source.error;
          } else {
            delete source.pendingMessages;
            delete source.lastError;
          }
        }
        changed = true;
        return encodeRow(source);
      });
    }
    if (changed) await ctx.db.patch(row._id, { runtimeSnapshot: next });
    return changed;
  }
  if (sensitive && table === 'backupSelectiveHistory') {
    // Imported history is an inert local copy. It must not retain a second
    // message body after clearing its owner, nor confer execution authority.
    const redaction = await historicalFactRedaction(ctx, job, row);
    if (!redaction) return false;
    const { record, staged } = redaction;
    if (staged) {
      const envelope = staged.metadata.envelope;
      await ctx.db.patch(staged._id, {
        metadata: { ...staged.metadata, envelope: { ...envelope, record } },
      });
    }
    await ctx.db.patch(row._id, { record });
    return true;
  }
  if (sensitive && table === 'autonomousTravelDecisions' && own) {
    await ctx.db.patch(row._id, { reason: undefined, error: undefined });
    return true;
  }
  if (sensitive && table === 'federationTravelAudit' && own) {
    await ctx.db.patch(row._id, {
      previous: sanitizeTravelAuditSummary(row.previous),
      next: sanitizeTravelAuditSummary(row.next),
    });
    return true;
  }
  if (
    table === 'federationInbox' &&
    own &&
    runtimeTypes.has(row.envelope.type) &&
    (sensitive || ['COMMITTED', 'REJECTED', 'DISCARDED'].includes(row.status))
  ) {
    if (
      !sensitive &&
      ['OBSERVATION', 'ACTION_RESULT'].includes(row.envelope.type) &&
      row.status === 'COMMITTED'
    ) {
      const fact = await ctx.db
        .query('federationEventFacts')
        .withIndex('messageId', (q) => q.eq('messageId', row.messageId))
        .unique();
      if (!fact)
        await ctx.db.insert('federationEventFacts', {
          messageId: row.messageId,
          visitId: job.visitId,
          fromTownId: row.fromTownId,
          type: row.envelope.type,
          payload: row.envelope.payload,
          receivedAt: row.receivedAt,
        });
    }
    // Keep original digest and ACK: replay protection and historical outcomes survive body erasure.
    await ctx.db.patch(row._id, {
      privacyPayloadDigest:
        row.privacyPayloadDigest ?? (await messageDigest({ ...row.envelope, credentialId: '' })),
      envelope: { ...row.envelope, payload: privatePayloadSummary(row.envelope.payload) },
    });
    return true;
  }
  if (
    table === 'federationOutbox' &&
    own &&
    runtimeTypes.has(row.envelope.type) &&
    (row.failedAt || (row.ackedAt && !row.lastError))
  ) {
    await ctx.db.patch(row._id, {
      envelope: { ...row.envelope, payload: privatePayloadSummary(row.envelope.payload) },
      lastError: undefined,
    });
    return true;
  }
  if (sensitive && table === 'federationEventFacts' && own) {
    await ctx.db.patch(row._id, { payload: privatePayloadSummary(row.payload) });
    return true;
  }
  if (
    ((table === 'federationActionFacts' && sensitive) || table === 'federationPendingActions') &&
    own
  ) {
    if (!sensitive && table === 'federationPendingActions') {
      const fact = await ctx.db
        .query('federationActionFacts')
        .withIndex('action', (q) => q.eq('actionId', row.actionId))
        .unique();
      if (!fact)
        await ctx.db.insert('federationActionFacts', {
          actionId: row.actionId,
          visitId: row.visitId,
          turnId: row.turnId,
          basedOnEventId: row.basedOnEventId,
          agentAuthorityEpoch: row.agentAuthorityEpoch,
          visitLeaseVersion: row.visitLeaseVersion,
          action: row.action,
          result: row.result,
          receiptPayload: row.receiptPayload,
          occurredAt: row.createdAt,
        });
    }
    await ctx.db.patch(row._id, {
      action: { type: row.action?.type, privacyRedacted: true },
      result:
        row.result?.kind === 'ok'
          ? { kind: 'ok', value: null }
          : { kind: 'error', message: 'PRIVACY_REDACTED' },
      receiptPayload: privatePayloadSummary(row.receiptPayload),
    });
    if (table === 'federationPendingActions') {
      const input = await ctx.db.get(row.inputId);
      if (input)
        await ctx.db.patch(input._id, {
          args: {},
          returnValue:
            row.result?.kind === 'ok'
              ? { kind: 'ok', value: null }
              : { kind: 'error', message: 'PRIVACY_REDACTED' },
        });
    }
    return true;
  }
  if (table === 'federationDecisionJobs' && own) {
    await ctx.db.patch(row._id, { observation: {}, error: undefined });
    return true;
  }
  if (table === 'federationTranscriptJobs' && own) {
    await ctx.db.patch(row._id, { pendingMessages: undefined, lastError: undefined });
    return true;
  }
  if (!sensitive) return false;
  let remove =
    (table === 'memories' && job.memoryIds.includes(row._id)) ||
    (table === 'modelMemoryVectors' && job.memoryIds.includes(row.memoryId)) ||
    table === 'embeddingsCache' ||
    (table === 'memorySourceCorrections' && job.memoryIds.includes(row.sourceMemoryId)) ||
    (table === 'memorySummaryProvenance' && job.memoryIds.includes(row.summaryMemoryId)) ||
    (table === 'homeTravelTranscriptPages' && inTranscript(job, row)) ||
    (table === 'homeTravelTranscripts' && inTranscript(job, row)) ||
    ((table === 'messages' || table === 'messageTranslations') && inConversation(job, row)) ||
    (table === 'coldHistoryChunks' && job.archiveIds.includes(row.archiveId)) ||
    (table === 'coldHistoryJobs' && job.archiveIds.includes(row.archiveId)) ||
    (table === 'coldHistoryArchives' && job.archiveIds.includes(row._id)) ||
    (table === 'coldArchiveMirrorJobs' && job.archiveIds.includes(row.archiveId));
  if (table === 'memoryEmbeddings') {
    const memory = await ctx.db
      .query('memories')
      .withIndex('embeddingId', (q) => q.eq('embeddingId', row._id))
      .first();
    remove = !!memory && job.memoryIds.includes(memory._id);
  }
  if (
    table === 'memoryCompressionJobs' &&
    row.sources.some((s: any) => job.memoryIds.includes(s.memoryId))
  ) {
    await ctx.db.patch(row._id, {
      state: 'CANCELLED',
      sources: [],
      revision: row.revision + 1,
      errorCode: undefined,
    });
    return true;
  }
  if (table === 'coldHistoryMessageIds') {
    const parent = await ctx.db.get(row.jobId as Id<'coldHistoryJobs'>);
    remove = !!parent && job.archiveIds.includes(parent.archiveId);
  }
  if (table === 'coldArchiveMirrorObjects') {
    const parent = await ctx.db.get(row.jobId as Id<'coldArchiveMirrorJobs'>);
    remove = !!parent && job.archiveIds.includes(parent.archiveId);
  }
  if (!remove) return false;
  if ((table === 'coldHistoryChunks' || table === 'coldHistoryArchives') && row.storageId)
    await eraseStorage(ctx, row.storageId, row.archiveId ?? row._id);
  if (table === 'messageTranslations') {
    const worker = await ctx.db
      .query('messageTranslationWorker')
      .withIndex('key', (q) => q.eq('key', 'zh-CN'))
      .unique();
    if (worker) await ctx.db.patch(worker._id, { cacheRows: Math.max(0, worker.cacheRows - 1) });
  }
  await ctx.db.delete(row._id);
  return true;
}
export const page = internalMutation({
  args: { jobId: v.id('travelPrivacyJobs'), revision: v.number() },
  handler: async (ctx, args) => {
    const stored = await ctx.db.get(args.jobId);
    if (
      !stored ||
      stored.revision !== args.revision ||
      !['INSPECTING', 'RUNNING'].includes(stored.state)
    )
      return;
    if (stored.history) await assertTerminal(ctx, stored.visitId, stored.history);
    // Archive phases are actions because storage bodies cannot be read in mutations.
    if (stored.phase.startsWith('ARCHIVE_') || stored.phase.startsWith('CHUNK_')) { await scheduled(ctx, stored); return; }
    const job = {
      ...stored,
      conversationIds: [...stored.conversationIds],
      conversationOwners: [...stored.conversationOwners],
      transcriptIds: [...stored.transcriptIds],
      memoryIds: [...stored.memoryIds],
      memoryOwners: [...stored.memoryOwners],
      archiveIds: [...stored.archiveIds],
      textHashes: [...stored.textHashes],
      blockers: [...stored.blockers],
      counts: { ...stored.counts },
    };
    const tables =
      job.phase === 'DISCOVER'
        ? discoveryTables
        : job.phase === 'CHECK'
          ? checkTables
          : job.phase === 'PURGE'
            ? purgeTables
            : (['memories'] as TableNames[]);
    const table = tables[job.tableIndex];
    const result = await ctx.db.query(table).paginate({
      cursor: job.cursor,
      numItems: PAGE,
      maximumRowsRead: PAGE,
      maximumBytesRead: 5 * 1024 * 1024,
    });
    try {
      for (const row of result.page) {
        if (job.phase === 'DISCOVER') await discover(ctx, job, table, row);
        else if (job.phase === 'MEMORY' || job.phase === 'MEMORY_FINAL')
          await inspectMemory(ctx, job, row as Doc<'memories'>, job.phase === 'MEMORY_FINAL');
        else if (job.phase === 'CHECK') await check(ctx, job, table, row);
        else if (await purge(ctx, job, table, row)) {
          job.processedRows++;
          job.counts[table] = (job.counts[table] ?? 0) + 1;
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'TRAVEL_PRIVACY_SELECTION_LIMIT')
        throw error;
      block(job, 'SELECTION_LIMIT');
      job.state = 'BLOCKED';
    }
    job.cursor = result.isDone ? null : result.continueCursor;
    if (result.isDone) job.tableIndex++;
    if (job.tableIndex === tables.length) {
      job.tableIndex = 0;
      if (job.phase === 'DISCOVER') job.phase = job.scope === 'SENSITIVE' ? 'MEMORY' : 'CHECK';
      else if (job.phase === 'MEMORY') {
        if (job.changed) job.changed = false;
        else job.phase = 'MEMORY_FINAL';
      } else if (job.phase === 'MEMORY_FINAL') job.phase = 'CHECK';
      else if (job.phase === 'CHECK') {
        if (
          job.sourceRevision !== (await dataRevision(ctx.db, sourceKey)) ||
          job.privacyRevision !== (await dataRevision(ctx.db, privacyRevisionKey))
        )
          block(job, 'PREVIEW_STALE');
        if (job.scope === 'SENSITIVE' && !job.blockers.length) {
          job.phase = 'ARCHIVE_CHECK';
          job.archiveCoverage = { ordinaryBundles: 'CHECKING', largeChunks: 'NOT_IMPLEMENTED', orphanObjects: 'NOT_VERIFIED' };
        } else job.state = job.blockers.length ? 'BLOCKED' : 'READY';
        job.counts = {
          memories: job.memoryIds.length,
          conversations: job.conversationIds.length,
          transcripts: job.transcriptIds.length,
          coldArchives: job.archiveIds.length,
        };
      } else {
        if (job.scope === 'SENSITIVE') {
          const cacheRevision = await ctx.db
            .query('embeddingDataRevisions')
            .withIndex('key', (q) => q.eq('key', privacyCacheRevisionKey))
            .unique();
          if (cacheRevision)
            await ctx.db.patch(cacheRevision._id, { revision: cacheRevision.revision + 1 });
        }
        job.state = 'COMPLETE';
        job.finishedAt = Date.now();
        await ctx.db.insert('federationTravelAudit', {
          visitId: job.visitId,
          source: 'travelPrivacy',
          operation: 'ADMIN_LOCAL_CLEAR_COMPLETED',
          at: Date.now(),
          next: { state: 'COMPLETE', role: job.role },
        });
      }
    }
    job.revision++;
    job.updatedAt = Date.now();
    const { _id, _creationTime, ...fields } = job;
    await ctx.db.patch(_id, fields);
    if (['INSPECTING', 'RUNNING'].includes(job.state)) await scheduled(ctx, job);
  },
});
