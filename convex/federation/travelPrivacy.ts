import { messageDigest } from './transport';
import { v } from 'convex/values';
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
import { mutationRef } from './refs';
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
type Job = Doc<'travelPrivacyJobs'>;
const discoveryTables: TableNames[] = [
  'federationTurns',
  'federationTranscriptJobs',
  'homeTravelTranscripts',
];
const checkTables: TableNames[] = [
  'backupImports',
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

async function assertTerminal(ctx: QueryCtx | MutationCtx, visitId: string) {
  const ledger = await visit(ctx, visitId);
  if (
    !ledger ||
    !['COMPLETED', 'REJECTED'].includes(ledger.state) ||
    ledger.leaseExpiry + Math.max(60000, ledger.leaseSafetyMs ?? 0) >= Date.now()
  )
    throw new Error('TRAVEL_PRIVACY_VISIT_NOT_SAFE_TERMINAL');
  return ledger;
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
async function bodyMemory(ctx: MutationCtx, job: Job, row: Doc<'memories'>) {
  if (row.data.type === 'travel' && row.data.visitId === job.visitId) {
    const binding = row.worldId ? await ctx.db.query('residentModelBindings')
      .withIndex('resident', q => q.eq('worldId', row.worldId!).eq('playerId', row.playerId)).unique() : null;
    const owner = row.agentGlobalId ?? binding?.agentGlobalId;
    if (!row.worldId || !owner) {
      block(job, 'MISSING_MEMORY_OWNERSHIP');
      return false;
    }
    if (row.worldId !== job.worldId || owner !== job.ownerGlobalId ||
      (binding?.agentGlobalId && binding.agentGlobalId !== owner)) {
      block(job, 'SHARED_VISIT_OWNERSHIP');
      return false;
    }
    return true;
  }
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
async function scheduled(ctx: MutationCtx, job: Job) {
  await ctx.scheduler.runAfter(0, mutationRef('travelPrivacy/page'), {
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
export const inspect = mutation({
  args: { adminToken: v.string(), visitId: v.string(), scope },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const ledger = await assertTerminal(ctx, args.visitId);
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
    await assertTerminal(ctx, job.visitId);
    if (
      job.sourceRevision !== (await dataRevision(ctx.db, sourceKey)) ||
      job.privacyRevision !== (await dataRevision(ctx.db, privacyRevisionKey))
    )
      throw new Error('TRAVEL_PRIVACY_PREVIEW_STALE');
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
    const next = {
      state: 'RUNNING',
      phase: 'PURGE',
      tableIndex: 0,
      cursor: null,
      revision: job.revision + 1,
      updatedAt: Date.now(),
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
    if (!row.agentGlobalIds.includes(job.ownerGlobalId)) return false;
    if (!['federationEventFacts', 'federationActionFacts', 'autonomousTravelDecisions', 'federationTravelAudit'].includes(row.table))
      return false;
    const archived = decodeRow(row.record);
    if (archived.visitId !== job.visitId) return false;
    if (row.table === 'federationEventFacts')
      archived.payload = privatePayloadSummary(archived.payload);
    else if (row.table === 'federationActionFacts') {
      archived.action = { type: archived.action?.type, privacyRedacted: true };
      archived.result = archived.result?.kind === 'ok'
        ? { kind: 'ok', value: null }
        : { kind: 'error', message: 'PRIVACY_REDACTED' };
      archived.receiptPayload = privatePayloadSummary(archived.receiptPayload);
    } else if (row.table === 'federationTravelAudit') {
      for (const field of ['previous', 'next']) {
        const summary = sanitizeTravelAuditSummary(archived[field]);
        if (summary === undefined) delete archived[field];
        else archived[field] = summary;
      }
    } else {
      delete archived.reason;
      delete archived.error;
    }
    await ctx.db.patch(row._id, { record: encodeRow(archived) });
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
        job.state = job.blockers.length ? 'BLOCKED' : 'READY';
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
