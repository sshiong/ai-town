import { v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  QueryCtx,
  MutationCtx,
} from '../maintenanceFunctions';
import { Doc, Id, TableNames } from '../_generated/dataModel';
import { storagePolicyFields } from './storageSchema';
import { requireAdmin } from './security';
import { mutationRef } from './refs';
import { visit } from './store';

const DAY = 86400000,
  PAGE = 50;
export const defaultStoragePolicy = {
  hotMemoryBytes: 512 * 1024 * 1024,
  historyBytes: 1024 * 1024 * 1024,
  vectorBytes: 256 * 1024 * 1024,
  cacheBytes: 64 * 1024 * 1024,
  operationalBytes: 128 * 1024 * 1024,
  warningRatio: 0.8,
  messageRetentionMs: 7 * DAY,
  runtimeRetentionMs: 7 * DAY,
  cacheRetentionMs: 7 * DAY,
  pauseNonessentialOnLimit: true,
  backupIntervalHours: 24,
  vectorRebuildBatchSize: 32,
};
type Policy = typeof defaultStoragePolicy & {
  coldArchiveLocation?: string;
  lastVerifiedBackupAt?: number;
};
type Category = 'canonicalMemory' | 'history' | 'vectors' | 'cache' | 'operational';
type Group = {
  category: Category;
  records: number;
  bytes: number;
  metadataBytes?: number;
  payloadBytes?: number;
};
const MEASUREMENT_VERSION = 2;
const emptyObjects = () => ({
  objects: 0,
  bytes: 0,
  publishedColdObjects: 0,
  publishedColdBytes: 0,
  otherOrUnpublishedObjects: 0,
  otherOrUnpublishedBytes: 0,
  classificationLimitedObjects: 0,
});

type ClassificationBudget = { remainingReads: number };
async function classifyStorageObject(
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
  budget: ClassificationBudget,
) {
  // A transaction shares eight classification reads, not eight per object.
  // Each indexed lookup/get reads at most one document (max 1 MiB). Alongside
  // the metadata page this stays below Convex's transaction read budget even
  // for unusually large archive metadata. The main scan owns the sole paginate.
  if (!budget.remainingReads) return { publishedCold: false, limited: true };
  budget.remainingReads--;
  const archives = await ctx.db
    .query('coldHistoryArchives')
    .withIndex('storage', (q) => q.eq('storageId', storageId))
    .take(1);
  if (archives[0]?.state === 'VERIFIED') return { publishedCold: true, limited: false };
  if (!budget.remainingReads) return { publishedCold: false, limited: true };
  budget.remainingReads--;
  const chunks = await ctx.db
    .query('coldHistoryChunks')
    .withIndex('storage', (q) => q.eq('storageId', storageId))
    .take(1);
  const chunk = chunks[0];
  if (chunk) {
    if (!budget.remainingReads) return { publishedCold: false, limited: true };
    budget.remainingReads--;
    const archive = await ctx.db.get(chunk.archiveId);
    const manifest = archive?.manifest as { version?: unknown; chunkCount?: unknown } | undefined;
    if (
      archive?.state === 'VERIFIED' &&
      manifest?.version === 2 &&
      typeof manifest.chunkCount === 'number' &&
      chunk.index >= 0 &&
      chunk.index < manifest.chunkCount
    )
      return { publishedCold: true, limited: false };
  }
  // Nonpublished prefixes can hide another shared published reference. Count
  // every physical byte while making incomplete classification explicit.
  return { publishedCold: false, limited: !!archives.length || !!chunks.length };
}

export async function summarizeStoredObjects(
  ctx: MutationCtx,
  page: { _id: Id<'_storage'>; size: number }[],
) {
  const objects = emptyObjects(),
    budget = { remainingReads: 8 };
  for (const object of page) {
    const classification = await classifyStorageObject(ctx, object._id, budget);
    objects.objects++;
    objects.bytes += object.size;
    if (classification.publishedCold) {
      objects.publishedColdObjects++;
      objects.publishedColdBytes += object.size;
    } else {
      objects.otherOrUnpublishedObjects++;
      objects.otherOrUnpublishedBytes += object.size;
    }
    if (classification.limited) objects.classificationLimitedObjects++;
  }
  return objects;
}
const measuredTables: Array<[TableNames, Category]> = [
  ['memories', 'canonicalMemory'],
  ['messages', 'history'],
  ['coldHistoryArchives', 'history'],
  ['homeTravelTranscripts', 'history'],
  ['homeTravelTranscriptPages', 'history'],
  ['archivedConversations', 'history'],
  ['participatedTogether', 'history'],
  ['visitLedger', 'history'],
  ['federationTravelAudit', 'history'],
  ['federationActionFacts', 'history'],
  ['federationEventFacts', 'history'],
  ['backupLargeChunks', 'history'],
  ['backupImports', 'history'],
  ['memoryEmbeddings', 'vectors'],
  ['modelMemoryVectors', 'vectors'],
  ['embeddingCertificates', 'vectors'],
  ['embeddingRestoreJobs', 'operational'],
  ['embeddingScanJobs', 'operational'],
  ['modelUsageBuckets', 'operational'],
  ['modelCallReceipts', 'operational'],
  ['federationPublicRateLimits', 'operational'],
  ['federationDisclosurePolicy', 'operational'],
  ['federationDisclosureAudit', 'history'],
  ['embeddingsCache', 'cache'],
  ['messageTranslations', 'cache'],
  ['playerTextTranslations', 'cache'],
  ['messageTranslationPreferences', 'operational'],
  ['messageTranslationWorker', 'operational'],
  ['federationInbox', 'operational'],
  ['federationOutbox', 'operational'],
  ['federationDecisionJobs', 'operational'],
  ['federationLlmRequests', 'operational'],
  ['federationChatScheduling', 'operational'],
  ['federationTranscriptJobs', 'operational'],
  ['federationTurns', 'operational'],
  ['federationPendingActions', 'operational'],
  ['federationPresenceJobs', 'operational'],
  ['messageStreamCursors', 'operational'],
  ['federationReplayNonces', 'operational'],
  ['inputs', 'operational'],
  ['pairRequests', 'operational'],
  ['visitReservations', 'operational'],
  ['federationAgentRuntimes', 'operational'],
  ['transportSessions', 'operational'],
  ['backupLargeJobs', 'operational'],
  ['backupLargeRows', 'operational'],
  ['backupLargeVisitEvidence', 'operational'],
  ['backupLargeGlobalMappings', 'operational'],
  ['coldHistoryChunks', 'history'],
  ['coldHistoryJobs', 'operational'],
  ['coldHistoryMessageIds', 'operational'],
  ['coldHistoryLocks', 'operational'],
  ['coldBackupChecks', 'operational'],
  ['coldBackupMessageIds', 'operational'],
  ['coldArchiveDestinations', 'operational'],
  ['coldArchiveMirrorJobs', 'operational'],
  ['coldArchiveMirrorObjects', 'operational'],
  ['memoryCompressionJobs', 'operational'],
  ['memorySourceClaims', 'history'],
  ['memorySummaryProvenance', 'history'],
  ['memorySourceCorrections', 'history'],
];
const cleanupTables: TableNames[] = [
  'embeddingsCache',
  'federationReplayNonces',
  'federationPendingActions',
  'federationDecisionJobs',
  'federationPresenceJobs',
  'federationTurns',
  'federationInbox',
  'federationOutbox',
  'visitReservations',
  'messageStreamCursors',
  'inputs',
];
const groups = (): Group[] =>
  (['canonicalMemory', 'history', 'vectors', 'cache', 'operational'] as Category[]).map(
    (category) => ({ category, records: 0, bytes: 0, metadataBytes: 0, payloadBytes: 0 }),
  );
const budget = (policy: Policy, category: Category) =>
  ({
    canonicalMemory: policy.hotMemoryBytes,
    history: policy.historyBytes,
    vectors: policy.vectorBytes,
    cache: policy.cacheBytes,
    operational: policy.operationalBytes,
  })[category];
export function estimateRecordBytes(record: unknown): number {
  let binaryBytes = 0;
  const serialized = JSON.stringify(record, (_key, value) => {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      binaryBytes += value.byteLength;
      return null;
    }
    return typeof value === 'bigint' ? value.toString() : value;
  });
  return new TextEncoder().encode(serialized).byteLength + binaryBytes;
}
async function policyFor(ctx: QueryCtx | MutationCtx): Promise<Policy> {
  const row = await ctx.db
    .query('storagePolicies')
    .withIndex('key', (q) => q.eq('key', 'local'))
    .unique();
  return { ...defaultStoragePolicy, ...row };
}
function evaluate(policy: Policy, usage: Group[]) {
  const alerts = usage.flatMap((group) => {
    const limit = budget(policy, group.category),
      ratio = group.bytes / limit;
    return ratio >= policy.warningRatio
      ? [
          {
            category: group.category,
            level: ratio >= 1 ? 'EXCEEDED' : 'WARNING',
            bytes: group.bytes,
            budgetBytes: limit,
            ratio,
          },
        ]
      : [];
  });
  const exceeded = alerts.some((alert) => alert.level === 'EXCEEDED');
  return {
    alerts,
    nonessential: {
      cacheWritesPaused: policy.pauseNonessentialOnLimit && exceeded,
      vectorRebuildPaused: policy.pauseNonessentialOnLimit && exceeded,
    },
  };
}
export async function nonessentialWritesAllowed(ctx: MutationCtx) {
  const policy = await policyFor(ctx),
    snapshot = await ctx.db
      .query('storageUsageSnapshots')
      .withIndex('key', (q) => q.eq('key', 'local'))
      .unique();
  return !evaluate(policy, snapshot?.groups ?? groups()).nonessential.cacheWritesPaused;
}
export async function cacheWritesAllowed(ctx: MutationCtx) {
  return nonessentialWritesAllowed(ctx);
}
export const rebuildBudget = internalQuery({
  args: { requestedBatchSize: v.number() },
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.requestedBatchSize) || args.requestedBatchSize < 1)
      throw new Error('INVALID_REBUILD_BATCH_SIZE');
    const policy = await policyFor(ctx),
      snapshot = await ctx.db
        .query('storageUsageSnapshots')
        .withIndex('key', (q) => q.eq('key', 'local'))
        .unique();
    const paused = evaluate(policy, snapshot?.groups ?? groups()).nonessential.vectorRebuildPaused;
    return {
      allowedBatchSize: paused
        ? 0
        : Math.min(policy.vectorRebuildBatchSize, Math.max(1, Math.floor(args.requestedBatchSize))),
      paused,
      reason: paused ? 'STORAGE_BUDGET_EXCEEDED' : undefined,
    };
  },
});
export const configure = mutation({
  args: { adminToken: v.string(), ...storagePolicyFields },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    for (const field of [
      'hotMemoryBytes',
      'historyBytes',
      'vectorBytes',
      'cacheBytes',
      'operationalBytes',
    ] as const)
      if (!Number.isSafeInteger(args[field]) || args[field] < 1 || args[field] > 1e15)
        throw new Error('INVALID_STORAGE_BUDGET');
    if (!Number.isFinite(args.warningRatio) || args.warningRatio < 0.5 || args.warningRatio >= 1)
      throw new Error('INVALID_WARNING_RATIO');
    for (const field of ['messageRetentionMs', 'runtimeRetentionMs', 'cacheRetentionMs'] as const)
      if (!Number.isSafeInteger(args[field]) || args[field] < DAY || args[field] > 365 * DAY)
        throw new Error('RETENTION_MUST_BE_1_TO_365_DAYS');
    if (
      !Number.isSafeInteger(args.backupIntervalHours) ||
      args.backupIntervalHours < 1 ||
      args.backupIntervalHours > 8760 ||
      !Number.isSafeInteger(args.vectorRebuildBatchSize) ||
      args.vectorRebuildBatchSize < 1 ||
      args.vectorRebuildBatchSize > 100
    )
      throw new Error('INVALID_STORAGE_OPERATIONS_POLICY');
    if (
      args.coldArchiveLocation &&
      (args.coldArchiveLocation.length > 1000 || /[\r\n\u0000]/.test(args.coldArchiveLocation))
    )
      throw new Error('INVALID_ARCHIVE_LOCATION');
    const { adminToken: _token, ...policy } = args;
    const prior = await ctx.db
      .query('storagePolicies')
      .withIndex('key', (q) => q.eq('key', 'local'))
      .unique();
    if (prior) await ctx.db.patch(prior._id, { ...policy, updatedAt: Date.now() });
    else await ctx.db.insert('storagePolicies', { key: 'local', ...policy, updatedAt: Date.now() });
    await startScan(ctx);
    return { configured: true };
  },
});
async function startScan(ctx: MutationCtx) {
  const previous = await ctx.db
    .query('storageUsageScans')
    .withIndex('key', (q) => q.eq('key', 'local'))
    .unique();
  if (previous?.state === 'RUNNING' && previous.measurementVersion === MEASUREMENT_VERSION) {
    if (previous.updatedAt <= Date.now() - 300000)
      await ctx.scheduler.runAfter(0, mutationRef('storagePolicy/scanPage'), {
        scanId: previous._id,
        revision: previous.revision ?? 0,
      });
    return previous._id;
  }
  const revision = (previous?.revision ?? 0) + 1;
  const latestObject = await ctx.db.system.query('_storage').order('desc').first();
  const data = {
    key: 'local',
    state: 'RUNNING',
    revision,
    tableIndex: 0,
    cursor: null,
    groups: groups(),
    objects: emptyObjects(),
    measurementVersion: MEASUREMENT_VERSION,
    storageCreationCutoff: latestObject?._creationTime ?? 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  const scanId = previous ? previous._id : await ctx.db.insert('storageUsageScans', data);
  if (previous) await ctx.db.replace(previous._id, data);
  await ctx.scheduler.runAfter(0, mutationRef('storagePolicy/scanPage'), { scanId, revision });
  return scanId;
}
export const refresh = mutation({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    return { scanId: await startScan(ctx), state: 'RUNNING' };
  },
});
export const scanPage = internalMutation({
  args: { scanId: v.id('storageUsageScans'), revision: v.number() },
  handler: async (ctx, { scanId, revision }) => {
    const task = await ctx.db.get(scanId);
    if (!task || task.state !== 'RUNNING' || (task.revision ?? 0) !== revision) return;
    if (task.measurementVersion !== MEASUREMENT_VERSION) {
      await startScan(ctx);
      return;
    }
    const usage = task.groups as Group[];
    const objects = task.objects ?? emptyObjects();
    const objectPhase = task.tableIndex === measuredTables.length;
    const pageOptions = { cursor: task.cursor, numItems: PAGE, maximumBytesRead: 512000 };
    let isDone: boolean, continueCursor: string;
    if (objectPhase) {
      // System metadata is authoritative for physical bytes and enumerates each
      // storageId once, including unpublished files and unreferenced uploads.
      // Capture a creation cutoff; concurrent deletes may still change this
      // paged estimate. No Blob, URL, private payload or signed body is read.
      const page = await ctx.db.system
        .query('_storage')
        .withIndex('by_creation_time', (q) =>
          q.lte('_creationTime', task.storageCreationCutoff ?? 0),
        )
        .paginate(pageOptions);
      const group = usage.find((group) => group.category === 'history')!;
      const summary = await summarizeStoredObjects(ctx, page.page);
      for (const key of Object.keys(summary) as (keyof typeof summary)[])
        objects[key] += summary[key];
      group.bytes += summary.bytes;
      group.payloadBytes = (group.payloadBytes ?? 0) + summary.bytes;
      ({ isDone, continueCursor } = page);
    } else {
      const [table, category] = measuredTables[task.tableIndex];
      const page = await ctx.db.query(table).paginate(pageOptions);
      const group = usage.find((group) => group.category === category)!;
      for (const record of page.page) {
        const bytes = estimateRecordBytes(record);
        group.records++;
        group.bytes += bytes;
        group.metadataBytes = (group.metadataBytes ?? 0) + bytes;
      }
      ({ isDone, continueCursor } = page);
    }
    const tableIndex = task.tableIndex + (isDone ? 1 : 0),
      done = tableIndex > measuredTables.length;
    await ctx.db.patch(task._id, {
      groups: usage,
      objects,
      tableIndex,
      revision: revision + 1,
      cursor: isDone ? null : continueCursor,
      state: done ? 'COMPLETE' : 'RUNNING',
      updatedAt: Date.now(),
    });
    if (done) {
      const prior = await ctx.db
        .query('storageUsageSnapshots')
        .withIndex('key', (q) => q.eq('key', 'local'))
        .unique();
      const data = {
        key: 'local',
        groups: usage,
        objects,
        measurementVersion: MEASUREMENT_VERSION,
        storageCreationCutoff: task.storageCreationCutoff ?? 0,
        measuredAt: Date.now(),
        scanStartedAt: task.startedAt,
      };
      if (prior) await ctx.db.replace(prior._id, data);
      else await ctx.db.insert('storageUsageSnapshots', data);
    } else
      await ctx.scheduler.runAfter(0, mutationRef('storagePolicy/scanPage'), {
        scanId,
        revision: revision + 1,
      });
  },
});
export const status = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const policy = await policyFor(ctx);
    const snapshot = await ctx.db
      .query('storageUsageSnapshots')
      .withIndex('key', (q) => q.eq('key', 'local'))
      .unique();
    const scan = await ctx.db
      .query('storageUsageScans')
      .withIndex('key', (q) => q.eq('key', 'local'))
      .unique();
    const cleanup = await ctx.db
      .query('storageCleanupJobs')
      .withIndex('key', (q) => q.eq('key', 'local'))
      .unique();
    return {
      policy,
      usage: {
        groups: snapshot?.groups ?? groups(),
        measuredAt: snapshot?.measuredAt ?? null,
        scanStartedAt: snapshot?.scanStartedAt ?? null,
        measurement:
          snapshot?.measurementVersion === MEASUREMENT_VERSION
            ? 'serialized-record-estimate-plus-storage-object-size'
            : 'serialized-record-bytes',
        objects: snapshot?.objects ?? null,
        consistency: 'paged-estimate-with-storage-creation-cutoff',
        storageCreationCutoff: snapshot?.storageCreationCutoff ?? null,
        scanState: scan?.state ?? 'NOT_MEASURED',
      },
      ...evaluate(policy, snapshot?.groups ?? groups()),
      cleanup: cleanup
        ? {
            state: cleanup.state,
            tableIndex: cleanup.tableIndex,
            deletedRows: cleanup.deletedRows,
            compactedActions: cleanup.compactedActions,
            compactedEvents: cleanup.compactedEvents,
            startedAt: cleanup.startedAt,
            updatedAt: cleanup.updatedAt,
            finishedAt: cleanup.finishedAt,
            table: cleanupTables[cleanup.tableIndex] ?? null,
          }
        : null,
      backup: {
        lastVerifiedBackupAt: policy.lastVerifiedBackupAt ?? null,
        due:
          !policy.lastVerifiedBackupAt ||
          policy.lastVerifiedBackupAt + policy.backupIntervalHours * 3600000 <= Date.now(),
        automatic: false,
      },
    };
  },
});

async function safeTerminal(ctx: MutationCtx, visitId: unknown, cutoff: number) {
  if (typeof visitId !== 'string') return false;
  const ledger = await visit(ctx, visitId);
  return (
    !!ledger &&
    ['COMPLETED', 'REJECTED'].includes(ledger.state) &&
    ledger.updatedAt < cutoff &&
    ledger.leaseExpiry + 60000 < Date.now()
  );
}
async function preserveInboxEvent(ctx: MutationCtx, item: Doc<'federationInbox'>) {
  if (!['OBSERVATION', 'ACTION_RESULT'].includes(item.envelope.type) || item.status !== 'COMMITTED')
    return;
  const existing = await ctx.db
    .query('federationEventFacts')
    .withIndex('messageId', (q) => q.eq('messageId', item.messageId))
    .unique();
  if (!existing)
    await ctx.db.insert('federationEventFacts', {
      messageId: item.messageId,
      visitId: item.envelope.visitId,
      fromTownId: item.fromTownId,
      type: item.envelope.type,
      payload: item.envelope.payload,
      receivedAt: item.receivedAt,
    });
}
async function pruneRecord(
  ctx: MutationCtx,
  table: TableNames,
  record: any,
  policy: Policy,
): Promise<{ deleted: boolean; action?: boolean; event?: boolean }> {
  const age = Date.now() - record._creationTime,
    runtimeCutoff = Date.now() - policy.runtimeRetentionMs,
    messageCutoff = Date.now() - policy.messageRetentionMs;
  let eligible = false,
    action = false,
    event = false;
  if (table === 'embeddingsCache') eligible = age > policy.cacheRetentionMs;
  else if (table === 'federationReplayNonces') eligible = record.expiresAt < Date.now();
  else if (table === 'inputs') {
    if (age <= policy.runtimeRetentionMs || !record.returnValue) return { deleted: false };
    const presence = await ctx.db
      .query('federationPresenceJobs')
      .withIndex('input', (q) => q.eq('inputId', record._id))
      .first();
    const actionJob = await ctx.db
      .query('federationPendingActions')
      .withIndex('input', (q) => q.eq('inputId', record._id))
      .first();
    eligible = !presence && !actionJob;
  } else if (table === 'federationInbox') {
    eligible =
      !!record.processedAt &&
      record.processedAt < messageCutoff &&
      record.envelope.expiresAt < Date.now() &&
      ['COMMITTED', 'REJECTED', 'DISCARDED'].includes(record.status) &&
      (await safeTerminal(ctx, record.envelope.visitId, messageCutoff));
    if (eligible) {
      await preserveInboxEvent(ctx, record);
      event =
        ['OBSERVATION', 'ACTION_RESULT'].includes(record.envelope.type) &&
        record.status === 'COMMITTED';
    }
  } else if (table === 'federationOutbox') {
    const transcript = await ctx.db
      .query('federationTranscriptJobs')
      .withIndex('pendingMessage', (q) => q.eq('pendingMessageId', record.messageId))
      .first();
    if (transcript) return { deleted: false };
    // Failed deliveries retain their error until the same bounded message retention
    // and safe visit termination checks as actual acknowledgements are satisfied.
    // Legacy error-bearing ackedAt records are not proof of acknowledgement.
    const finishedAt = record.failedAt ?? (!record.lastError ? record.ackedAt : undefined);
    eligible =
      !!finishedAt &&
      finishedAt < messageCutoff &&
      record.envelope.expiresAt < Date.now() &&
      (await safeTerminal(ctx, record.envelope.visitId, messageCutoff));
  } else if (table === 'messageStreamCursors') {
    if (!(await safeTerminal(ctx, record.visitIdOrPairSessionId, messageCutoff)))
      return { deleted: false };
    const inbox = await ctx.db
      .query('federationInbox')
      .withIndex('visit', (q) => q.eq('envelope.visitId', record.visitIdOrPairSessionId))
      .first();
    const outbox = await ctx.db
      .query('federationOutbox')
      .withIndex('visit', (q) => q.eq('envelope.visitId', record.visitIdOrPairSessionId))
      .first();
    eligible = !inbox && !outbox;
  } else if (
    (await safeTerminal(ctx, record.visitId, runtimeCutoff)) &&
    age > policy.runtimeRetentionMs
  ) {
    if (table === 'federationDecisionJobs')
      eligible = ['COMPLETED', 'COMMITTED', 'EXPIRED', 'FAILED', 'REJECTED'].includes(record.state);
    else if (table === 'federationPresenceJobs')
      eligible = ['COMMITTED', 'FAILED'].includes(record.state);
    else if (table === 'federationTurns')
      eligible = ['COMMITTED', 'REJECTED', 'EXPIRED'].includes(record.state);
    else if (table === 'visitReservations') eligible = !record.reservedSlot;
    else if (table === 'federationPendingActions') {
      eligible =
        ['COMMITTED', 'REJECTED'].includes(record.state) &&
        record.receiptPending !== true &&
        !!record.result;
      if (eligible) {
        const old = await ctx.db
          .query('federationActionFacts')
          .withIndex('action', (q) => q.eq('actionId', record.actionId))
          .unique();
        if (!old)
          await ctx.db.insert('federationActionFacts', {
            actionId: record.actionId,
            visitId: record.visitId,
            turnId: record.turnId,
            basedOnEventId: record.basedOnEventId,
            agentAuthorityEpoch: record.agentAuthorityEpoch,
            visitLeaseVersion: record.visitLeaseVersion,
            action: record.action,
            result: record.result,
            receiptPayload: record.receiptPayload,
            occurredAt: record.createdAt,
          });
        action = true;
      }
    }
  }
  if (eligible) await ctx.db.delete(record._id);
  return { deleted: eligible, action, event };
}
async function startCleanup(ctx: MutationCtx) {
  const old = await ctx.db
    .query('storageCleanupJobs')
    .withIndex('key', (q) => q.eq('key', 'local'))
    .unique();
  if (old?.state === 'RUNNING') {
    if (old.updatedAt < Date.now() - 300000)
      await ctx.scheduler.runAfter(0, mutationRef('storagePolicy/cleanupPage'), {
        cleanupId: old._id,
        revision: old.revision ?? 0,
      });
    return old._id;
  }
  const revision = (old?.revision ?? 0) + 1;
  const data = {
    key: 'local',
    state: 'RUNNING',
    revision,
    tableIndex: 0,
    cursor: null,
    deletedRows: 0,
    compactedActions: 0,
    compactedEvents: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  const cleanupId = old ? old._id : await ctx.db.insert('storageCleanupJobs', data);
  if (old) await ctx.db.replace(old._id, data);
  await ctx.scheduler.runAfter(0, mutationRef('storagePolicy/cleanupPage'), {
    cleanupId,
    revision,
  });
  return cleanupId;
}
export const cleanupNow = mutation({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    return { cleanupId: await startCleanup(ctx), state: 'RUNNING' };
  },
});
export const cleanupPage = internalMutation({
  args: { cleanupId: v.id('storageCleanupJobs'), revision: v.number() },
  handler: async (ctx, { cleanupId, revision }) => {
    const task = await ctx.db.get(cleanupId);
    if (!task || task.state !== 'RUNNING' || (task.revision ?? 0) !== revision) return;
    const policy = await policyFor(ctx),
      table = cleanupTables[task.tableIndex];
    const page = await ctx.db
      .query(table)
      .paginate({ cursor: task.cursor, numItems: PAGE, maximumBytesRead: 512000 });
    let deletedRows = task.deletedRows,
      compactedActions = task.compactedActions,
      compactedEvents = task.compactedEvents;
    for (const record of page.page) {
      const result = await pruneRecord(ctx, table, record, policy);
      if (result.deleted) deletedRows++;
      if (result.action) compactedActions++;
      if (result.event) compactedEvents++;
    }
    const tableIndex = task.tableIndex + (page.isDone ? 1 : 0),
      done = tableIndex >= cleanupTables.length;
    await ctx.db.patch(task._id, {
      tableIndex,
      revision: revision + 1,
      cursor: page.isDone ? null : page.continueCursor,
      deletedRows,
      compactedActions,
      compactedEvents,
      state: done ? 'COMPLETE' : 'RUNNING',
      updatedAt: Date.now(),
      ...(done ? { finishedAt: Date.now() } : {}),
    });
    if (!done)
      await ctx.scheduler.runAfter(0, mutationRef('storagePolicy/cleanupPage'), {
        cleanupId,
        revision: revision + 1,
      });
  },
});
export const maintenance = internalMutation({
  args: {},
  handler: async (ctx) => {
    await startScan(ctx);
    await startCleanup(ctx);
  },
});
