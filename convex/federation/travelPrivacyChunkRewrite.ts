import { v } from 'convex/values';
import {
  internalAction,
  trackedInternalMutation as internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../maintenanceFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { decodeRow, encodeRow, type BackupRow } from './backupHelpers';
import {
  descriptor,
  MAX_CHUNK_BYTES,
  MAX_CHUNKS,
  MAX_ARCHIVE_BYTES,
  rowMetadata,
  validateManifest,
  type LargeChunk,
} from './backupLargeHelpers';
import { digest } from './security';
import { actionRef, mutationRef, queryRef } from './refs';
import {
  describeArchiveUpload,
  reserveArchiveUpload,
  beginArchiveUpload,
  confirmArchiveUploadCandidate,
  markArchiveUploadPublished,
  archiveHasStrongStorageReference,
  archiveUploadMetadataMatches,
  archiveUploadSha256Hex,
  retireArchiveUpload,
  confirmArchiveUploadProducerTerminal,
  beginArchiveUploadRecovery,
  saveArchiveUploadRecovery,
} from './archiveUploadProvenance';
import { validatePrivacyChunk } from './backupPrivacyChunks';
import { validatePrivacyBackupRow } from './backupPrivacy';
import { privatePayloadSummary } from './travelPrivacyGuard';
import { validateSelectiveManifest } from './backupSelectiveHelpers';
import { sanitizeTravelAuditSummary } from './travelAuditWriter';
import {
  dataRevision,
  privacyRevisionKey,
  archiveReferenceRevisionKey,
} from '../models/embeddingDataRevision';
import {
  createLocalChunkManifest,
  validateLocalChunkManifest,
  type LocalSanitizedChunkManifest,
  type LocalChunkDescriptor,
  validateLocalChunk,
} from './travelPrivacyLocalChunkManifest';

import { assertPagedReferenceProofAbsent, assertPreflightReferenceProofReady } from './travelPrivacyChunkReferenceProof';

type Session = Doc<'travelPrivacyChunkRewrites'>;
type Candidate = Doc<'travelPrivacyChunkReplacements'>;
type Producer = Doc<'travelPrivacyChunkManifestRewrites'>;
type DB = QueryCtx | MutationCtx;
const checkpoint = { rewriteId: v.id('travelPrivacyChunkRewrites'), revision: v.number() };
const ROW_PAGE = 5;
const MANIFEST_DESCRIPTOR_PAGE = 100;
const runtimeTypes = new Set(['OBSERVATION', 'DECISION', 'ACTION_RESULT', 'CONVERSATION_ENDED']);
const removeTables = new Set([
  'memories',
  'modelMemoryVectors',
  'memoryEmbeddings',
  'memorySourceCorrections',
  'memorySourceClaims',
  'memorySummaryProvenance',
  'messages',
  'archivedConversations',
  'messageTranslations',
  'homeTravelTranscripts',
  'homeTravelTranscriptPages',
  'coldHistoryFiles',
  'coldHistoryArchives',
  'coldHistoryChunks',
]);
const expectedDescriptor = (chunk: Doc<'backupLargeChunks'>) => ({
  index: chunk.index,
  table: chunk.table,
  count: chunk.count,
  bytes: chunk.bytes,
  digest: chunk.digest,
});
function fail(code: string): never {
  throw new Error(`CHUNK_REWRITE_${code}`);
}

/** Unselected encoded rows are copied verbatim; only selected rows are decoded and rewritten. */
export function rewriteChunkRows(
  chunk: LargeChunk,
  selected: readonly number[],
  selective: boolean,
  operationKey: string,
) {
  if (
    chunk.rows.length > 20 ||
    selected.some(
      (index) => !Number.isSafeInteger(index) || index < 0 || index >= chunk.rows.length,
    ) ||
    new Set(selected).size !== selected.length
  )
    fail('ROW_SELECTION_INVALID');
  const selection = new Set(selected),
    rowIndices: number[] = [];
  const rows: unknown[] = [];
  for (const [oldIndex, encoded] of chunk.rows.entries()) {
    let next = encoded;
    if (selection.has(oldIndex)) {
      const envelope = decodeRow(encoded);
      if (selective && envelope.kind !== 'record') fail('SELECTED_EXTERNAL_REFERENCE');
      const raw = selective ? decodeRow(envelope.record) : envelope;
      const sanitized = sanitizeSelectedRow(chunk.table, raw);
      if (!sanitized) {
        rowIndices.push(-1);
        continue;
      }
      next = selective
        ? encodeRow({ ...envelope, record: encodeRow(sanitized) })
        : encodeRow(sanitized);
    }
    rowIndices.push(rows.length);
    rows.push(next);
  }
  return {
    chunk: {
      index: chunk.index,
      table: chunk.table,
      rows,
      privacyRewriteOperationId: operationKey,
    },
    rowIndices,
  };
}

export function sanitizeSelectedRow(table: string, raw: BackupRow): BackupRow | null {
  if (removeTables.has(table)) return null;
  const row = { ...raw };
  if (table === 'federationEventFacts') row.payload = privatePayloadSummary(row.payload);
  else if (['federationActionFacts', 'federationPendingActions'].includes(table)) {
    row.action = { type: row.action?.type, privacyRedacted: true };
    row.result =
      row.result?.kind === 'ok'
        ? { kind: 'ok', value: null }
        : { kind: 'error', message: 'PRIVACY_REDACTED' };
    row.receiptPayload = privatePayloadSummary(row.receiptPayload);
  } else if (table === 'federationTravelAudit') {
    for (const field of ['previous', 'next']) {
      const summary = sanitizeTravelAuditSummary(row[field]);
      if (summary === undefined) delete row[field];
      else row[field] = summary;
    }
  } else if (table === 'autonomousTravelDecisions') {
    delete row.reason;
    delete row.error;
  } else if (
    ['federationInbox', 'federationOutbox'].includes(table) &&
    runtimeTypes.has(row.envelope?.type)
  ) {
    row.envelope = { ...row.envelope, payload: privatePayloadSummary(row.envelope.payload) };
    delete row.lastError;
  } else if (table === 'federationDecisionJobs') {
    row.observation = {};
    delete row.error;
  } else if (table === 'federationTranscriptJobs') {
    delete row.pendingMessages;
    delete row.lastError;
  } else if (table === 'inputs') {
    row.args = {};
    if (row.returnValue !== undefined)
      row.returnValue =
        row.returnValue?.kind === 'ok'
          ? { kind: 'ok', value: null }
          : { kind: 'error', message: 'PRIVACY_REDACTED' };
  } else if (table === 'memoryCompressionJobs') {
    row.state = 'CANCELLED';
    row.sources = [];
    delete row.errorCode;
  }
  return row;
}

async function checked(
  ctx: DB,
  a: { rewriteId: Id<'travelPrivacyChunkRewrites'>; revision: number },
  allowReferenceResume = false,
) {
  const session = await ctx.db.get(a.rewriteId);
  if (
    !session ||
    session.revision !== a.revision ||
    session.phase === 'DONE' ||
    session.key !== 'town'
  )
    return null;
  const parent = await ctx.db.get(session.privacyJobId);
  if (!parent || parent.revision !== session.expectedParentRevision)
    fail('PARENT_CHECKPOINT_CHANGED');
  if ((await dataRevision(ctx.db, privacyRevisionKey)) !== session.sourceRevision)
    fail('SOURCE_REVISION_CHANGED');
  if (!allowReferenceResume && session.referenceResume) fail('REFERENCE_PREFLIGHT_INCOMPLETE');
  if (!allowReferenceResume && session.referenceRevision !== undefined &&
    await dataRevision(ctx.db, archiveReferenceRevisionKey) !== session.referenceRevision)
    fail('REFERENCE_EPOCH_CHANGED');
  return { session, parent };
}
async function advance(ctx: MutationCtx, session: Session, fields: Partial<Session>) {
  await ctx.db.patch(session._id, {
    ...fields,
    revision: session.revision + 1,
    sourceRevision: await dataRevision(ctx.db, privacyRevisionKey),
    // checked() read the entry epoch in this transaction. Convex retries that
    // check after any conflict; only this writer's transaction can advance it.
    referenceRevision: await dataRevision(ctx.db, archiveReferenceRevisionKey),
    updatedAt: Date.now(),
    errorCode: undefined,
  });
}

export async function beginChunkRewrite(
  ctx: MutationCtx,
  scanId: Id<'travelPrivacyChunkScans'>,
  expectedParentRevision?: number,
) {
  const prior = await ctx.db
    .query('travelPrivacyChunkRewrites')
    .withIndex('scan', (q) => q.eq('scanId', scanId))
    .unique();
  if (prior) return prior._id;
  const scan = await ctx.db.get(scanId);
  if (!scan || scan.phase !== 'READY_TO_REWRITE' || scan.blockers) fail('PLAN_NOT_READY');
  const parent = await ctx.db.get(scan.jobId);
  if (
    !parent ||
    parent.scope !== 'SENSITIVE' ||
    parent.revision !== (expectedParentRevision ?? scan.privacyRevision) ||
    scan.sourceRevision !== (await dataRevision(ctx.db, privacyRevisionKey))
  )
    fail('PLAN_STALE');
  if (
    await ctx.db
      .query('travelPrivacyChunkRewrites')
      .withIndex('key', (q) => q.eq('key', 'town'))
      .first()
  )
    fail('REWRITE_BUSY');
  // Public archive readers/producers must check this global fence before their per-job fence.
  return ctx.db.insert('travelPrivacyChunkRewrites', {
    scanId,
    privacyJobId: scan.jobId,
    expectedParentRevision: parent.revision,
    key: 'town',
    revision: 0,
    sourceRevision: scan.sourceRevision,
    phase: 'PREPARING',
    cursor: null,
    objects: 0,
    published: 0,
    deleted: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}
export const startRewrite = internalMutation({
  args: { scanId: v.id('travelPrivacyChunkScans'), expectedParentRevision: v.optional(v.number()) },
  handler: (ctx, a) => beginChunkRewrite(ctx, a.scanId, a.expectedParentRevision),
});

async function prepareProducer(
  ctx: MutationCtx,
  session: Session,
  plan: Doc<'travelPrivacyChunkObjects'>,
) {
  const prior = await ctx.db
    .query('travelPrivacyChunkManifestRewrites')
    .withIndex('rewrite_job', (q) =>
      q.eq('rewriteId', session._id).eq('backupJobId', plan.backupJobId),
    )
    .unique();
  if (prior) return;
  const backup = await ctx.db.get(plan.backupJobId);
  if (
    !backup ||
    (await digest(backup)) !== plan.backupDigest ||
    backup.archivePrivacyState === 'REWRITING'
  )
    fail('PRODUCER_CHANGED');
  const revision = (backup.archiveRevision ?? 0) + 1;
  const metadata = { ...backup.metadata, activePrivacyRewriteId: session._id };
  const next = {
    ...backup,
    archivePrivacyState: 'REWRITING' as const,
    archiveRevision: revision,
    metadata,
  };
  await ctx.db.patch(backup._id, {
    archivePrivacyState: next.archivePrivacyState,
    archiveRevision: revision,
    metadata,
  });
  const parent = (await ctx.db.get(session.privacyJobId))!;
  await ctx.db.insert('travelPrivacyChunkManifestRewrites', {
    rewriteId: session._id,
    backupJobId: backup._id,
    expectedProducerDigest: await digest(next),
    producerRevision: revision,
    state: 'PLANNED',
    cursor: null,
    sourceManifestStorageId:
      backup.metadata?.archiveSourceEvidence?.manifestStorageId ?? plan.sourceManifestStorageId,
    sourceManifestDigest:
      backup.metadata?.archiveSourceEvidence?.digest ??
      plan.sourceManifestDigest ??
      (await digest({})),
    sourceSignature:
      backup.metadata?.archiveSourceEvidence?.signature ?? plan.sourceSignature ?? '',
    sourcePublicKey:
      backup.metadata?.archiveSourceEvidence?.publicKey ?? plan.sourcePublicKey ?? '',
    clearedVisits: [
      ...new Set<string>([...(backup.metadata?.archiveClearedVisits ?? []), parent.visitId]),
    ].sort(),
  });
}

export const preparePage = internalMutation({
  args: checkpoint,
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current) return;
    const { session } = current;
    if (session.phase === 'PREPARING' && !session.preflightComplete) {
      if (!session.preflightProofId) fail('REFERENCE_PREFLIGHT_INCOMPLETE');
      await assertPreflightReferenceProofReady(ctx, session.preflightProofId, session._id);
      // No await outside this transaction can separate consumption from the first
      // producer/source write below. Tracked source writes then invalidate this proof.
      await ctx.db.patch(session._id, { preflightComplete: true });
    }
    if (session.phase === 'PREPARING') {
      const page = await ctx.db
        .query('travelPrivacyChunkObjects')
        .withIndex('scan', (q) => q.eq('scanId', session.scanId))
        .paginate({ cursor: session.cursor, numItems: 1, maximumBytesRead: 128 * 1024 });
      let objects = session.objects;
      for (const plan of page.page) {
        if (!plan.selectedRows) continue;
        if (plan.state !== 'CHECKED' || plan.blockers.length) fail('PLAN_CHANGED');
        const existing = await ctx.db
          .query('travelPrivacyChunkReplacements')
          .withIndex('rewrite_storage', (q) =>
            q.eq('rewriteId', session._id).eq('originalStorageId', plan.originalStorageId),
          )
          .unique();
        if (existing) continue;
        const aliases: Candidate['aliases'] = [];
        const encodings = new Set<string>();
        for (const reference of plan.aliases) {
          if (reference.table !== 'backupLargeChunks') fail('UNPLANNED_STORAGE_ALIAS');
          const chunk = await ctx.db.get(reference.id as Id<'backupLargeChunks'>);
          const aliasPlan = chunk
            ? await ctx.db
                .query('travelPrivacyChunkObjects')
                .withIndex('scan_chunk', (q) =>
                  q.eq('scanId', session.scanId).eq('chunkId', chunk._id),
                )
                .unique()
            : null;
          if (
            !chunk ||
            !aliasPlan ||
            aliasPlan.selectionDigest !== plan.selectionDigest ||
            chunk.storageId !== plan.originalStorageId ||
            (await digest(expectedDescriptor(chunk))) !== (await digest(plan.descriptor))
          )
            fail('ALIAS_CHANGED');
          const aliasProducer = await ctx.db.get(chunk.jobId);
          encodings.add(
            aliasPlan.role !== 'OLD' && aliasProducer?.mode?.startsWith('selective-')
              ? 'SELECTIVE'
              : 'RAW',
          );
          if (encodings.size > 1) fail('ALIAS_ENCODING_MISMATCH');
          await prepareProducer(ctx, session, aliasPlan);
          aliases.push({
            chunkId: chunk._id,
            planObjectId: aliasPlan._id,
            jobId: chunk.jobId,
            role: aliasPlan.role,
            descriptor: expectedDescriptor(chunk),
            published: false,
          });
        }
        if (!aliases.length) fail('ALIAS_MISSING');
        await ctx.db.insert('travelPrivacyChunkReplacements', {
          rewriteId: session._id,
          planObjectId: plan._id,
          originalStorageId: plan.originalStorageId,
          originalDescriptor: plan.descriptor,
          state: 'PLANNING',
          selectedIndices: [],
          expectedSelectedRows: plan.selectedRows,
          planCursor: null,
          aliasIndex: 0,
          rowOffset: 0,
          retainedRows: 0,
          aliases,
        });
        objects++;
      }
      await advance(ctx, session, {
        objects,
        cursor: page.isDone ? null : page.continueCursor,
        phase: page.isDone ? 'IMPORT_FENCE' : session.phase,
      });
      return;
    }
    if (session.phase === 'IMPORT_FENCE') {
      const page = await ctx.db
        .query('backupImports')
        .paginate({ cursor: session.cursor, numItems: 1, maximumBytesRead: 2 * 1024 * 1024 });
      for (const imported of page.page) {
        const producerId =
          imported.manifest.largeJobId ??
          imported.manifest.selectiveJobId ??
          imported.runtimeSnapshot.largeJobId ??
          imported.runtimeSnapshot.selectiveJobId;
        if (!producerId) continue;
        const producer = await ctx.db
          .query('travelPrivacyChunkManifestRewrites')
          .withIndex('rewrite_job', (q) =>
            q.eq('rewriteId', session._id).eq('backupJobId', producerId),
          )
          .unique();
        if (!producer) continue;
        await ctx.db.patch(imported._id, {
          archivePrivacyState: 'REWRITING',
          archiveRevision: (imported.archiveRevision ?? 0) + 1,
        });
      }
      await advance(ctx, session, {
        cursor: page.isDone ? null : page.continueCursor,
        phase: page.isDone ? 'ROWS' : session.phase,
      });
      return;
    }
    if (session.phase === 'ROWS') {
      const candidate = await ctx.db
        .query('travelPrivacyChunkReplacements')
        .withIndex('rewrite_state', (q) => q.eq('rewriteId', session._id).eq('state', 'PLANNING'))
        .first();
      if (!candidate) {
        await advance(ctx, session, { phase: 'OBJECTS' });
        return;
      }
      const page = await ctx.db
        .query('travelPrivacyChunkRows')
        .withIndex('object', (q) => q.eq('objectId', candidate.planObjectId))
        .paginate({ cursor: candidate.planCursor, numItems: 20, maximumBytesRead: 256 * 1024 });
      const indices = [
        ...candidate.selectedIndices,
        ...page.page.filter((row) => row.selected).map((row) => row.evidence.rowIndex),
      ];
      if (
        indices.length > candidate.expectedSelectedRows ||
        new Set(indices).size !== indices.length ||
        (page.isDone && indices.length !== candidate.expectedSelectedRows)
      )
        fail('ROW_PLAN_CHANGED');
      await ctx.db.patch(candidate._id, {
        selectedIndices: indices,
        planCursor: page.isDone ? null : page.continueCursor,
        state: page.isDone ? 'PREPARED' : candidate.state,
      });
      await advance(ctx, session, {});
    }
  },
});

export const pageData = internalQuery({
  args: checkpoint,
  handler: async (ctx, a) => {
    const sessionBefore = await ctx.db.get(a.rewriteId);
    const current = await checked(ctx, a, sessionBefore?.referenceResume === true);
    if (!current) return null;
    const { session } = current;
    const candidates = ['PREPARED', 'UPLOADED', 'VERIFIED'] as const;
    if (session.phase === 'OBJECTS')
      for (const state of candidates) {
        const candidate = await ctx.db
          .query('travelPrivacyChunkReplacements')
          .withIndex('rewrite_state', (q) => q.eq('rewriteId', session._id).eq('state', state))
          .first();
        if (candidate)
          return {
            ...current,
            manifest: null,
            candidate,
            producer: await ctx.db.get(candidate.aliases[candidate.aliasIndex].jobId),
          };
      }
    const manifest =
      session.phase === 'MANIFESTS'
        ? ((await ctx.db
            .query('travelPrivacyChunkManifestRewrites')
            .withIndex('rewrite_state', (q) =>
              q.eq('rewriteId', session._id).eq('state', 'PLANNED'),
            )
            .first()) ??
          (await ctx.db
            .query('travelPrivacyChunkManifestRewrites')
            .withIndex('rewrite_state', (q) =>
              q.eq('rewriteId', session._id).eq('state', 'BUILDING'),
            )
            .first()) ??
          (await ctx.db
            .query('travelPrivacyChunkManifestRewrites')
            .withIndex('rewrite_state', (q) =>
              q.eq('rewriteId', session._id).eq('state', 'UPLOADED'),
            )
            .first()))
        : null;
    return {
      ...current,
      candidate: null,
      producer: manifest ? await ctx.db.get(manifest.backupJobId) : null,
      manifest,
    };
  },
});

export const status = internalQuery({
  args: { rewriteId: v.id('travelPrivacyChunkRewrites') },
  handler: (ctx, a) => ctx.db.get(a.rewriteId),
});

const objectArgs = { ...checkpoint, candidateId: v.id('travelPrivacyChunkReplacements') };
const manifestArgs = { ...checkpoint, manifestId: v.id('travelPrivacyChunkManifestRewrites') };
async function producerChecked(ctx: DB, producer: Producer) {
  const job = await ctx.db.get(producer.backupJobId);
  if (
    !job ||
    job.archivePrivacyState !== 'REWRITING' ||
    job.archiveRevision !== producer.producerRevision ||
    (await digest(job)) !== producer.expectedProducerDigest
  )
    fail('PRODUCER_CHANGED');
  return job;
}
async function candidateChecked(
  ctx: DB,
  session: Session,
  id: Id<'travelPrivacyChunkReplacements'>,
) {
  const candidate = await ctx.db.get(id);
  if (!candidate || candidate.rewriteId !== session._id) fail('CANDIDATE_CHANGED');
  return candidate;
}
export const reserveObject = internalMutation({
  args: {
    ...objectArgs,
    replacementDescriptor: v.any(),
    rowIndices: v.array(v.number()),
    sha256Hex: v.string(),
    size: v.number(),
  },
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'OBJECTS') return null;
    const candidate = await candidateChecked(ctx, current.session, a.candidateId);
    if (candidate.state !== 'PREPARED' || candidate.operationId) return null;
    const d = a.replacementDescriptor;
    if (
      d.index !== candidate.originalDescriptor.index ||
      d.table !== candidate.originalDescriptor.table ||
      d.count < 0 ||
      d.count > candidate.originalDescriptor.count ||
      d.bytes !== a.size ||
      d.bytes > MAX_CHUNK_BYTES ||
      a.rowIndices.length !== candidate.originalDescriptor.count ||
      a.rowIndices.filter((n) => n >= 0).some((n, index) => n !== index)
    )
      fail('REPLACEMENT_PLAN_INVALID');
    const op = await reserveArchiveUpload(ctx, {
      producerKind: 'CHUNK_PRIVACY_REPLACEMENT',
      ownerKey: current.session._id,
      operationKey: candidate._id,
      sha256Hex: a.sha256Hex,
      size: a.size,
    });
    const lease = await beginArchiveUpload(ctx, op);
    await ctx.db.patch(candidate._id, {
      operationId: lease.operationId,
      operationRevision: lease.revision,
      replacementDescriptor: d,
      rowIndices: a.rowIndices,
      retainedRows: d.count,
      state: 'UPLOADED',
    });
    await advance(ctx, current.session, {});
    return { ...lease, rewriteRevision: current.session.revision + 1 };
  },
});
export const saveObjectUpload = internalMutation({
  args: { ...objectArgs, storageId: v.id('_storage') },
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'OBJECTS') return false;
    const candidate = await candidateChecked(ctx, current.session, a.candidateId);
    if (
      candidate.state !== 'UPLOADED' ||
      !candidate.operationId ||
      candidate.operationRevision === undefined
    )
      return false;
    await confirmArchiveUploadCandidate(ctx, {
      operationId: candidate.operationId,
      revision: candidate.operationRevision,
      storageId: a.storageId,
    });
    await ctx.db.patch(candidate._id, { replacementStorageId: a.storageId, state: 'VERIFIED' });
    await advance(ctx, current.session, {});
    return true;
  },
});

/** One alias and at most twenty staged row records are changed in the same pointer transaction. */
export const publishObject = internalMutation({
  args: { ...objectArgs, rows: v.array(v.any()) },
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'OBJECTS') return false;
    const candidate = await candidateChecked(ctx, current.session, a.candidateId);
    if (
      candidate.state !== 'VERIFIED' ||
      !candidate.replacementStorageId ||
      !candidate.replacementDescriptor ||
      !candidate.rowIndices
    )
      fail('NOT_VERIFIED');
    if (a.rows.length !== candidate.retainedRows || a.rows.length > 20) fail('ROW_BUDGET');
    const alias = candidate.aliases[candidate.aliasIndex];
    if (!alias || alias.published) fail('ALIAS_CHECKPOINT_CHANGED');
    const chunk = await ctx.db.get(alias.chunkId);
    if (
      !chunk ||
      chunk.storageId !== candidate.originalStorageId ||
      (await digest(expectedDescriptor(chunk))) !== (await digest(alias.descriptor))
    )
      fail('ALIAS_CHANGED');
    const producer = await ctx.db
      .query('travelPrivacyChunkManifestRewrites')
      .withIndex('rewrite_job', (q) =>
        q.eq('rewriteId', current.session._id).eq('backupJobId', alias.jobId),
      )
      .unique();
    if (!producer) fail('PRODUCER_MISSING');
    const job = await producerChecked(ctx, producer);
    const staged =
      alias.role === 'EXPORT'
        ? []
        : await ctx.db
            .query('backupLargeRows')
            .withIndex('job_table', (q) =>
              q
                .eq('jobId', alias.jobId)
                .eq('role', alias.role as 'SOURCE' | 'OLD')
                .eq('table', chunk.table),
            )
            .filter((q) => q.eq(q.field('chunkIndex'), chunk.index))
            .take(21);
    if (staged.length > 20) fail('STAGED_ROW_BUDGET');
    for (const row of staged) {
      const newIndex = candidate.rowIndices[row.rowIndex];
      if (newIndex === undefined) fail('STAGED_ROW_CHANGED');
      if (newIndex < 0) await ctx.db.delete(row._id);
      else {
        const raw = a.rows[newIndex];
        if (!raw || raw._id !== row.sourceId) fail('STAGED_ROW_CHANGED');
        await ctx.db.patch(row._id, {
          rowIndex: newIndex,
          metadata: {
            ...rowMetadata(chunk.table, raw),
            ...(chunk.table === 'memories'
              ? {
                  worldId: raw.worldId,
                  playerId: raw.playerId,
                  agentGlobalId: raw.agentGlobalId,
                  sourceDigest: row.metadata?.sourceDigest,
                  contentDigest: row.metadata?.contentDigest,
                }
              : {}),
          },
        });
      }
    }
    const plannedRows = await ctx.db
      .query('travelPrivacyChunkRows')
      .withIndex('object', (q) => q.eq('objectId', alias.planObjectId))
      .take(21);
    if (plannedRows.length > 20) fail('ROW_PLAN_BUDGET');
    for (const planned of plannedRows.filter((row) => row.selected)) {
      const histories = await ctx.db
        .query('backupSelectiveHistory')
        .withIndex('job_source', (q) =>
          q.eq('jobId', alias.jobId).eq('sourceId', planned.evidence.sourceId),
        )
        .take(21);
      if (histories.length > 20) fail('HISTORY_ALIAS_BUDGET');
      const index = candidate.rowIndices[planned.evidence.rowIndex];
      for (const history of histories) {
        if (history.table !== chunk.table) fail('HISTORY_ALIAS_CHANGED');
        if (index < 0) await ctx.db.delete(history._id);
        else await ctx.db.patch(history._id, { record: encodeRow(a.rows[index]) });
      }
    }
    // Detect aliases introduced after inspection before committing any canonical pointer.
    const references = await ctx.db
      .query('backupLargeChunks')
      .withIndex('storage', (q) => q.eq('storageId', candidate.originalStorageId))
      .take(101);
    if (
      references.length > 100 ||
      references.some(
        (ref) => !candidate.aliases.some((x) => x.chunkId === ref._id && !x.published),
      )
    )
      fail('UNPLANNED_STORAGE_ALIAS');
    await ctx.db.patch(chunk._id, {
      ...candidate.replacementDescriptor,
      storageId: candidate.replacementStorageId,
    });
    if (candidate.aliasIndex === 0)
      await markArchiveUploadPublished(ctx, {
        operationId: candidate.operationId!,
        revision: candidate.operationRevision!,
        storageId: candidate.replacementStorageId,
        publication: { table: 'backupLargeChunks', rowId: chunk._id, field: 'storageId' },
      });
    const aliases = candidate.aliases.map((x, index) =>
      index === candidate.aliasIndex ? { ...x, published: true } : x,
    );
    const last = candidate.aliasIndex + 1 === aliases.length;
    await ctx.db.patch(candidate._id, {
      aliases,
      aliasIndex: candidate.aliasIndex + 1,
      state: last ? 'PUBLISHED' : candidate.state,
    });
    const next = {
      ...job,
      bytes: job.bytes + candidate.replacementDescriptor.bytes - chunk.bytes,
      recordCount: job.recordCount + candidate.replacementDescriptor.count - chunk.count,
    };
    await ctx.db.patch(job._id, { bytes: next.bytes, recordCount: next.recordCount });
    await ctx.db.patch(producer._id, { expectedProducerDigest: await digest(next) });
    await advance(ctx, current.session, { published: current.session.published + (last ? 1 : 0) });
    return true;
  },
});

export const buildManifestPage = internalMutation({
  args: checkpoint,
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current) return;
    const { session } = current;
    if (session.phase === 'OBJECTS') {
      for (const state of ['PLANNING', 'PREPARED', 'UPLOADED', 'VERIFIED'] as const)
        if (
          await ctx.db
            .query('travelPrivacyChunkReplacements')
            .withIndex('rewrite_state', (q) => q.eq('rewriteId', session._id).eq('state', state))
            .first()
        )
          return;
      await advance(ctx, session, { phase: 'MANIFESTS' });
      return;
    }
    if (session.phase !== 'MANIFESTS') return;
    const producer = await ctx.db
      .query('travelPrivacyChunkManifestRewrites')
      .withIndex('rewrite_state', (q) => q.eq('rewriteId', session._id).eq('state', 'PLANNED'))
      .first();
    if (!producer) {
      if (
        (await ctx.db
          .query('travelPrivacyChunkManifestRewrites')
          .withIndex('rewrite_state', (q) => q.eq('rewriteId', session._id).eq('state', 'UPLOADED'))
          .first()) ||
        (await ctx.db
          .query('travelPrivacyChunkManifestRewrites')
          .withIndex('rewrite_state', (q) => q.eq('rewriteId', session._id).eq('state', 'BUILDING'))
          .first())
      )
        return;
      await advance(ctx, session, { phase: 'DELETE' });
      return;
    }
    const job = await producerChecked(ctx, producer);
    const page = await ctx.db
      .query('backupLargeChunks')
      .withIndex('job_index', (q) => q.eq('jobId', producer.backupJobId))
      .paginate({
        cursor: producer.cursor,
        numItems: MANIFEST_DESCRIPTOR_PAGE,
        maximumBytesRead: 128 * 1024,
      });
    const chunks: LocalChunkDescriptor[] = page.page.map((chunk) => {
      const role =
        job.kind === 'export'
          ? ('EXPORT' as const)
          : chunk.index < job.chunkCount
            ? ('SOURCE' as const)
            : ('OLD' as const);
      return {
        ...expectedDescriptor(chunk),
        role,
        encoding:
          role !== 'OLD' && job.mode?.startsWith('selective-')
            ? ('SELECTIVE' as const)
            : ('RAW' as const),
      };
    });
    // Migrate bounded legacy PLANNED sessions once; their existing descriptors are not discarded.
    const legacy = producer.chunks ?? [];
    if (legacy.length > 128) fail('LEGACY_MANIFEST_BUDGET');
    let pageNumber = producer.descriptorPageCount ?? 0;
    let descriptorChainDigest = producer.descriptorChainDigest ?? (await digest([]));
    let count = producer.descriptorCount ?? 0,
      descriptorBytes = producer.descriptorBytes ?? 0;
    let archiveBytes = producer.archiveBytes ?? 0,
      lastIndex = producer.lastDescriptorIndex ?? -1;
    for (const batch of [legacy, chunks]) {
      for (let offset = 0; offset < batch.length; offset += MANIFEST_DESCRIPTOR_PAGE) {
        const descriptors = batch.slice(offset, offset + MANIFEST_DESCRIPTOR_PAGE);
        for (const entry of descriptors) {
          if (
            !Number.isSafeInteger(entry.index) ||
            entry.index <= lastIndex ||
            entry.index >= 2 * MAX_CHUNKS ||
            entry.count < 0 ||
            entry.count > 20 ||
            entry.bytes < 1 ||
            entry.bytes > MAX_CHUNK_BYTES
          )
            fail('MANIFEST_DESCRIPTOR_INVALID');
          lastIndex = entry.index;
          count++;
          archiveBytes += entry.bytes;
          // Include array separator bytes in the running bound, including across journal pages.
          descriptorBytes +=
            new TextEncoder().encode(JSON.stringify(entry)).length + (count > 1 ? 1 : 0);
        }
        if (
          count > 2 * MAX_CHUNKS ||
          descriptorBytes > 10_000_000 ||
          archiveBytes > 2 * MAX_ARCHIVE_BYTES
        )
          fail('MANIFEST_BUDGET');
        if (
          await ctx.db
            .query('travelPrivacyChunkManifestPages')
            .withIndex('manifest_page', (q) =>
              q.eq('manifestId', producer._id).eq('pageNumber', pageNumber),
            )
            .first()
        )
          fail('MANIFEST_PAGE_CHANGED');
        const pageDigest = await digest(descriptors);
        descriptorChainDigest = await digest([descriptorChainDigest, pageNumber, pageDigest]);
        await ctx.db.insert('travelPrivacyChunkManifestPages', {
          manifestId: producer._id,
          pageNumber,
          descriptors,
          digest: pageDigest,
        });
        pageNumber++;
      }
    }
    await ctx.db.patch(producer._id, {
      chunks: undefined,
      descriptorChainDigest,
      descriptorCount: count,
      descriptorBytes,
      archiveBytes,
      descriptorPageCount: pageNumber,
      lastDescriptorIndex: lastIndex,
      cursor: page.isDone ? null : page.continueCursor,
      state: page.isDone ? 'BUILDING' : 'PLANNED',
    });
    await advance(ctx, session, {});
  },
});
/** Read a fixed number of small journals; the producer checkpoint pins the entire page set. */
export const manifestDescriptorPage = internalQuery({
  args: { ...manifestArgs, cursor: v.union(v.string(), v.null()), expectedPageNumber: v.number() },
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'MANIFESTS') return null;
    const producer = await ctx.db.get(a.manifestId);
    if (!producer || producer.rewriteId !== a.rewriteId || producer.state !== 'BUILDING')
      fail('MANIFEST_CHECKPOINT_CHANGED');
    await producerChecked(ctx, producer);
    const page = await ctx.db
      .query('travelPrivacyChunkManifestPages')
      .withIndex('manifest_page', (q) => q.eq('manifestId', producer._id))
      .paginate({ cursor: a.cursor, numItems: 1, maximumBytesRead: 32 * 1024 });
    if (
      (page.page.length && page.page[0].pageNumber !== a.expectedPageNumber) ||
      (page.isDone && a.expectedPageNumber + page.page.length !== producer.descriptorPageCount)
    )
      fail('MANIFEST_PAGE_CHANGED');
    for (const row of page.page)
      if (
        row.descriptors.length > MANIFEST_DESCRIPTOR_PAGE ||
        (await digest(row.descriptors)) !== row.digest
      )
        fail('MANIFEST_PAGE_CHANGED');
    return {
      ...page,
      descriptorCount: producer.descriptorCount ?? 0,
      descriptorPageCount: producer.descriptorPageCount ?? 0,
      descriptorBytes: producer.descriptorBytes ?? 0,
      archiveBytes: producer.archiveBytes ?? 0,
      lastDescriptorIndex: producer.lastDescriptorIndex ?? -1,
    };
  },
});

/** Persist identifier-only evidence before uploading it, with one bounded scan page per transaction. */
export const buildEvidencePage = internalMutation({
  args: manifestArgs, handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'MANIFESTS') return;
    const producer = await ctx.db.get(a.manifestId);
    if (!producer || producer.state !== 'BUILDING' || producer.evidenceComplete) return;
    const backup = await producerChecked(ctx, producer);
    const { parent, session } = current;
    const page = await ctx.db.query('travelPrivacyChunkRows').withIndex('backup_selected', q =>
      q.eq('scanId', session.scanId).eq('backupJobId', producer.backupJobId).eq('role', backup.kind === 'export' ? 'EXPORT' : 'SOURCE').eq('selected', true))
      .paginate({ cursor: producer.evidenceCursor ?? null, numItems: 20 });
    const rows: BackupRow[] = [];
    const base = { visitId: parent.visitId, createdAt: session.createdAt };
    if (!producer.evidenceStarted && page.page.length) {
      // Parent identifiers are direct deletion evidence, never inferred from a text hash.
      rows.push(...producer.clearedVisits.map(visitId => ({ key: `visit:${visitId}`, visitId,
        createdAt: session.createdAt, ...(visitId === parent.visitId ? { worldId: parent.worldId, ownerGlobalId: parent.ownerGlobalId } : {}) })));
    }
    for (const selected of page.page) {
      if (selected.backupJobId !== producer.backupJobId || selected.role === 'OLD') continue;
      const e = selected.evidence;
      const memoryOwner = e.table === 'memories' ? parent.memoryOwners.find(owner => owner.memoryId === e.sourceId) : undefined;
      const conversationOwner = e.worldId === parent.worldId ? parent.conversationOwners.find(owner => owner.conversationId === e.conversationId) : undefined;
      const fields = { ...base, ...(e.worldId ? { worldId: e.worldId } : {}),
        ...((e.ownerGlobalId ?? memoryOwner?.ownerGlobalId) ? { ownerGlobalId: e.ownerGlobalId ?? memoryOwner?.ownerGlobalId } : {}),
        ...((e.playerId ?? memoryOwner?.playerId) ? { playerId: e.playerId ?? memoryOwner?.playerId } : {}) };
      if (e.table === 'memories') rows.push({ ...fields, key: `memory:${e.sourceId}` });
      if (e.worldId && e.conversationId) rows.push({ ...fields, key: `conversation:${e.worldId}:${e.conversationId}`,
        ...((e.conversationPlayerIds ?? conversationOwner?.playerIds) ? { playerIds: e.conversationPlayerIds ?? conversationOwner?.playerIds } : e.playerId ? { playerIds: [e.playerId] } : {}) });
    }
    if (!producer.evidenceStarted && !page.page.length) rows.push(...producer.clearedVisits.map(visitId =>
      ({ key: `visit:${visitId}`, visitId, createdAt: session.createdAt })));
    let pageNumber = producer.evidencePageCount;
    if (pageNumber === undefined) {
      const last = await ctx.db.query('backupPrivacyChunks').withIndex('job_page', q => q.eq('jobId', producer.backupJobId)).order('desc').first();
      pageNumber = last ? last.pageNumber + 1 : 0;
    }
    const unique = [...new Map(rows.map(row => [row.key, row])).values()];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const batch = unique.slice(offset, offset + 100);
      for (const row of batch) validatePrivacyBackupRow(row);
      await ctx.db.insert('travelPrivacyChunkEvidencePages', { manifestId: producer._id, pageNumber: pageNumber++, rows: batch, state: 'PREPARED' });
    }
    await ctx.db.patch(producer._id, { evidenceStarted: true, evidenceCursor: page.isDone ? null : page.continueCursor,
      evidencePageCount: pageNumber, evidenceComplete: page.isDone });
    await advance(ctx, session, {});
  },
});
export const evidencePageData = internalQuery({
  args: manifestArgs, handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'MANIFESTS') return null;
    const producer = await ctx.db.get(a.manifestId);
    if (!producer || producer.rewriteId !== a.rewriteId || producer.state !== 'BUILDING') fail('MANIFEST_CHECKPOINT_CHANGED');
    await producerChecked(ctx, producer);
    const page = await ctx.db.query('travelPrivacyChunkEvidencePages').withIndex('manifest_page', q => q.eq('manifestId', producer._id))
      .filter(q => q.neq(q.field('state'), 'PUBLISHED')).first();
    return { producer, page };
  },
});
const evidenceArgs = { ...manifestArgs, evidenceId: v.id('travelPrivacyChunkEvidencePages') };
export const reserveEvidence = internalMutation({
  args: { ...evidenceArgs, descriptor: v.any(), sha256Hex: v.string(), size: v.number() }, handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'MANIFESTS') return null;
    const page = await ctx.db.get(a.evidenceId), producer = await ctx.db.get(a.manifestId);
    if (!producer || !page || page.manifestId !== producer._id || page.state !== 'PREPARED') return null;
    await producerChecked(ctx, producer);
    const chunk = { index: page.pageNumber, table: 'travelPrivacyTombstones', rows: page.rows.map(encodeRow) };
    await validatePrivacyChunk(chunk, a.descriptor);
    const operation = await reserveArchiveUpload(ctx, { producerKind: 'CHUNK_PRIVACY_MANIFEST', ownerKey: a.rewriteId,
      operationKey: page._id, sha256Hex: a.sha256Hex, size: a.size });
    const lease = await beginArchiveUpload(ctx, operation);
    await ctx.db.patch(page._id, { state: 'UPLOADED', descriptor: a.descriptor, operationId: lease.operationId, operationRevision: lease.revision });
    await advance(ctx, current.session, {});
    return { ...lease, rewriteRevision: current.session.revision + 1 };
  },
});
export const publishEvidence = internalMutation({
  args: { ...evidenceArgs, storageId: v.id('_storage') }, handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'MANIFESTS') return;
    const page = await ctx.db.get(a.evidenceId), producer = await ctx.db.get(a.manifestId);
    if (!producer || !page || page.manifestId !== producer._id || page.state !== 'UPLOADED' || !page.operationId || !page.descriptor)
      fail('EVIDENCE_CHECKPOINT_CHANGED');
    await producerChecked(ctx, producer);
    await confirmArchiveUploadCandidate(ctx, { operationId: page.operationId, revision: page.operationRevision!, storageId: a.storageId });
    if (await ctx.db.query('backupPrivacyChunks').withIndex('job_page', q => q.eq('jobId', producer.backupJobId).eq('pageNumber', page.pageNumber)).first())
      fail('EVIDENCE_PAGE_CHANGED');
    const rowId = await ctx.db.insert('backupPrivacyChunks', { jobId: producer.backupJobId, pageNumber: page.pageNumber,
      descriptor: page.descriptor, storageId: a.storageId, rewriteId: a.rewriteId });
    await ctx.db.patch(page._id, { storageId: a.storageId, state: 'PUBLISHED' });
    await markArchiveUploadPublished(ctx, { operationId: page.operationId, revision: page.operationRevision!, storageId: a.storageId,
      publication: { table: 'backupPrivacyChunks', rowId, field: 'storageId' } });
    await advance(ctx, current.session, {});
  },
});
export const privacyDescriptorPage = internalQuery({
  args: { ...manifestArgs, cursor: v.union(v.string(), v.null()) }, handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'MANIFESTS') return null;
    const producer = await ctx.db.get(a.manifestId);
    if (!producer || producer.rewriteId !== a.rewriteId || !producer.evidenceComplete) fail('EVIDENCE_INCOMPLETE');
    await producerChecked(ctx, producer);
    return ctx.db.query('backupPrivacyChunks').withIndex('job_page', q => q.eq('jobId', producer.backupJobId)).paginate({ cursor: a.cursor, numItems: 100 });
  },
});
export const reserveManifest = internalMutation({
  args: { ...manifestArgs, manifestDigest: v.string(), sha256Hex: v.string(), size: v.number() },
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'MANIFESTS') return null;
    const producer = await ctx.db.get(a.manifestId);
    if (
      !producer ||
      producer.rewriteId !== current.session._id ||
      producer.state !== 'BUILDING' ||
      producer.operationId
    )
      return null;
    await producerChecked(ctx, producer);
    const op = await reserveArchiveUpload(ctx, {
      producerKind: 'CHUNK_PRIVACY_MANIFEST',
      ownerKey: current.session._id,
      operationKey: producer._id,
      sha256Hex: a.sha256Hex,
      size: a.size,
    });
    const lease = await beginArchiveUpload(ctx, op);
    await ctx.db.patch(producer._id, {
      operationId: lease.operationId,
      operationRevision: lease.revision,
      manifestDigest: a.manifestDigest,
      state: 'UPLOADED',
    });
    await advance(ctx, current.session, {});
    return { ...lease, rewriteRevision: current.session.revision + 1 };
  },
});
export const publishManifest = internalMutation({
  args: { ...manifestArgs, storageId: v.id('_storage') },
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'MANIFESTS') return false;
    const producer = await ctx.db.get(a.manifestId);
    if (
      !producer ||
      producer.rewriteId !== current.session._id ||
      producer.state !== 'UPLOADED' ||
      !producer.operationId
    )
      fail('MANIFEST_CHECKPOINT_CHANGED');
    const job = await producerChecked(ctx, producer);
    await confirmArchiveUploadCandidate(ctx, {
      operationId: producer.operationId,
      revision: producer.operationRevision!,
      storageId: a.storageId,
    });
    const metadata = {
      ...job.metadata,
      archiveLocalManifestDigest: producer.manifestDigest,
      archiveLocalProof: undefined,
      archiveClearedVisits: producer.clearedVisits,
      archivePrivacyChunkCount: producer.evidencePageCount ?? 0,
      archiveSourceEvidence: {
        manifestStorageId: producer.sourceManifestStorageId,
        digest: producer.sourceManifestDigest,
        signature: producer.sourceSignature,
        publicKey: producer.sourcePublicKey,
      },
    };
    // The original source signature remains evidence and never authenticates this local derivative.
    const next = { ...job, manifestStorageId: a.storageId, signature: undefined, metadata };
    await ctx.db.patch(job._id, { manifestStorageId: a.storageId, signature: undefined, metadata });
    await markArchiveUploadPublished(ctx, {
      operationId: producer.operationId,
      revision: producer.operationRevision!,
      storageId: a.storageId,
      publication: { table: 'backupLargeJobs', rowId: job._id, field: 'manifestStorageId' },
    });
    await ctx.db.patch(producer._id, {
      manifestStorageId: a.storageId,
      state: 'PUBLISHED',
      expectedProducerDigest: await digest(next),
    });
    await advance(ctx, current.session, {});
    return true;
  },
});

async function supersededUpload(
  ctx: DB,
  storageId: Id<'_storage'>,
  operationId: Id<'archiveUploadOperations'>,
) {
  const op = await ctx.db.get(operationId);
  if (
    !op ||
    op.producerKind !== 'CHUNK_PRIVACY_REPLACEMENT' ||
    !op.uploadAcknowledged ||
    op.publishedStorageId !== storageId ||
    !['PUBLISHED', 'RETIRED'].includes(op.state)
  )
    return null;
  const writer = await ctx.db.query('travelPrivacyChunkReplacements')
    .withIndex('operation_storage', q => q.eq('operationId', op._id).eq('replacementStorageId', storageId)).unique();
  if (writer?.state !== 'DELETED') return null;
  const parent = writer ? await ctx.db.get(writer.rewriteId) : null;
  return parent?.phase === 'DONE' ? op : null;
}

export const bindPreflightProof = internalMutation({
  args: { ...checkpoint, proofId: v.id('travelPrivacyChunkReferenceProofs') }, handler: async (ctx, a) => {
    const sessionBefore = await ctx.db.get(a.rewriteId);
    const current = await checked(ctx, a, sessionBefore?.referenceResume === true);
    if (!current || (!current.session.referenceResume && (current.session.phase !== 'PREPARING' || current.session.preflightComplete))) return false;
    const proof = await ctx.db.get(a.proofId);
    const referenceRevision = await dataRevision(ctx.db, archiveReferenceRevisionKey);
    const previous = current.session.preflightProofId && await ctx.db.get(current.session.preflightProofId);
    if (!proof || proof.purpose !== 'PREPARING' || proof.rewriteId !== a.rewriteId || proof.rewriteRevision !== a.revision ||
      proof.referenceRevision !== referenceRevision ||
      (previous && previous._id !== a.proofId && previous.referenceRevision === referenceRevision)) fail('REFERENCE_CHECKPOINT_CHANGED');
    await ctx.db.patch(a.rewriteId, { preflightProofId: a.proofId });
    return true;
  },
});
export const preflightData = internalQuery({ args: checkpoint, handler: async (ctx, a) => {
  const sessionBefore = await ctx.db.get(a.rewriteId);
  const current = await checked(ctx, a, sessionBefore?.referenceResume === true);
  if (!current || (!current.session.referenceResume && (current.session.phase !== 'PREPARING' || current.session.preflightComplete))) return null;
  const proof = current.session.preflightProofId && await ctx.db.get(current.session.preflightProofId);
  return { stale: !!proof && proof.referenceRevision !== await dataRevision(ctx.db, archiveReferenceRevisionKey) };
} });
export async function requestReferencePreflightRetry(ctx: MutationCtx, a: { rewriteId: Id<'travelPrivacyChunkRewrites'>; revision: number }) {
  const current = await checked(ctx, a, true);
  if (!current || !['PREPARING', 'IMPORT_FENCE', 'ROWS', 'OBJECTS', 'MANIFESTS'].includes(current.session.phase)) return false;
  await ctx.db.patch(a.rewriteId, { referenceResume: true, preflightProofId: undefined, errorCode: undefined });
  return true;
}
export const retryReferencePreflight = internalMutation({ args: checkpoint, handler: requestReferencePreflightRetry });
export const resumeReferenceWriter = internalMutation({ args: { ...checkpoint, proofId: v.id('travelPrivacyChunkReferenceProofs') }, handler: async (ctx, a) => {
  const current = await checked(ctx, a, true);
  if (!current?.session.referenceResume || current.session.preflightProofId !== a.proofId) fail('REFERENCE_CHECKPOINT_CHANGED');
  const proof = await assertPreflightReferenceProofReady(ctx, a.proofId, a.rewriteId);
  await ctx.db.patch(a.rewriteId, { referenceRevision: proof.referenceRevision, referenceResume: false, errorCode: undefined });
  return true;
} });
export const bindReferenceProof = internalMutation({
  args: { ...checkpoint, proofId: v.id('travelPrivacyChunkReferenceProofs') },
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'DELETE') return false;
    const proof = await ctx.db.get(a.proofId);
    if (
      !proof ||
      proof.rewriteId !== a.rewriteId ||
      proof.rewriteRevision !== a.revision ||
      proof.referenceRevision !== (await dataRevision(ctx.db, archiveReferenceRevisionKey))
    )
      fail('REFERENCE_CHECKPOINT_CHANGED');
    // Binding does not advance the writer checkpoint pinned by start().
    if (current.session.referenceProofId && current.session.referenceProofId !== a.proofId)
      fail('REFERENCE_CHECKPOINT_CHANGED');
    await ctx.db.patch(a.rewriteId, { referenceProofId: a.proofId });
    return true;
  },
});
export const deletionData = internalQuery({
  args: checkpoint,
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'DELETE') return null;
    const candidate = await ctx.db
      .query('travelPrivacyChunkReplacements')
      .withIndex('rewrite_state', (q) => q.eq('rewriteId', a.rewriteId).eq('state', 'PUBLISHED'))
      .first();
    return candidate ? { candidate } : null;
  },
});
export const eraseOriginal = internalMutation({
  args: { ...objectArgs, proofId: v.id('travelPrivacyChunkReferenceProofs') },
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'DELETE') return false;
    const candidate = await candidateChecked(ctx, current.session, a.candidateId);
    if (candidate.state !== 'PUBLISHED' || candidate.aliases.some((x) => !x.published))
      fail('NOT_PUBLISHED');
    if (current.session.referenceProofId !== a.proofId) fail('REFERENCE_CHECKPOINT_CHANGED');
    // Validate the pinned epoch before the first reference-source write in this transaction.
    const proof = await assertPagedReferenceProofAbsent(
      ctx,
      a.proofId,
      a.rewriteId,
      candidate.originalStorageId,
    );
    let referenceWrites = 1; // This candidate's PUBLISHED -> DELETED transition.
    for (const alias of candidate.aliases) {
      const chunk = await ctx.db.get(alias.chunkId);
      if (
        !chunk ||
        chunk.storageId !== candidate.replacementStorageId ||
        (await digest(expectedDescriptor(chunk))) !==
          (await digest(candidate.replacementDescriptor))
      )
        fail('PUBLICATION_CHANGED');
      const producer = await ctx.db
        .query('travelPrivacyChunkManifestRewrites')
        .withIndex('rewrite_job', (q) =>
          q.eq('rewriteId', a.rewriteId).eq('backupJobId', alias.jobId),
        )
        .unique();
      if (!producer || producer.state !== 'PUBLISHED') fail('MANIFEST_NOT_PUBLISHED');
      await producerChecked(ctx, producer);
    }
    const replacement = await ctx.db.system.get(candidate.replacementStorageId!);
    const operation = await ctx.db.get(candidate.operationId!);
    if (
      !replacement ||
      !operation ||
      operation.state !== 'PUBLISHED' ||
      operation.publishedStorageId !== candidate.replacementStorageId ||
      operation.producerKind !== 'CHUNK_PRIVACY_REPLACEMENT' ||
      operation.ownerKey !==
        (await archiveUploadSha256Hex(new TextEncoder().encode(a.rewriteId))) ||
      operation.operationKey !==
        (await archiveUploadSha256Hex(new TextEncoder().encode(candidate._id))) ||
      !operation.uploadAcknowledged ||
      !archiveUploadMetadataMatches(operation, replacement)
    )
      fail('REPLACEMENT_MISSING');
    const formerUploads = await ctx.db
      .query('archiveUploadCandidates')
      .withIndex('storage', (q) => q.eq('storageId', candidate.originalStorageId))
      .take(129);
    if (formerUploads.length > 128) fail('REFERENCE_COVERAGE_UNKNOWN');
    for (const upload of formerUploads) {
      if (upload.state === 'DELETED') continue;
      if (upload.state !== 'PUBLISHED') fail('UPLOAD_REFERENCE_CHANGED');
      const op = await supersededUpload(ctx, candidate.originalStorageId, upload.operationId);
      const retirement = await ctx.db
        .query('travelPrivacyChunkReferenceRetirements')
        .withIndex('operation', (q) =>
          q
            .eq('proofId', proof._id)
            .eq('operationId', upload.operationId)
            .eq('storageId', candidate.originalStorageId),
        )
        .first();
      if (!retirement) fail('UPLOAD_REFERENCE_CHANGED');
      if (!op) fail('UPLOAD_REFERENCE_CHANGED');
      const retired =
        op.state === 'RETIRED'
          ? { operationId: op._id, revision: op.revision }
          : await retireArchiveUpload(ctx, {
              operationId: op._id,
              revision: op.revision,
              reasonCode: 'PRIVACY_SUPERSEDED',
            });
      referenceWrites +=
        (op.state === 'PUBLISHED' ? 1 : 0) + (op.producerTerminalAt === undefined ? 1 : 0) + 1;
      await confirmArchiveUploadProducerTerminal(ctx, retired, async (_ctx, terminal) => {
        // A successful ACK plus a published single-start lease proves its only store invocation returned.
        if (
          !terminal.uploadAcknowledged ||
          terminal.publishedStorageId !== candidate.originalStorageId
        )
          fail('UPLOAD_COVERAGE_UNKNOWN');
      });
      await ctx.db.patch(upload._id, { state: 'DELETED', deletedAt: Date.now() });
    }
    if (await ctx.db.system.get(candidate.originalStorageId))
      await ctx.storage.delete(candidate.originalStorageId);
    if (await ctx.db.system.get(candidate.originalStorageId)) fail('DELETE_NOT_CONFIRMED');
    await ctx.db.patch(candidate._id, { state: 'DELETED', deletedAt: Date.now() });
    await advance(ctx, current.session, { deleted: current.session.deleted + 1 });
    const referenceRevision = await dataRevision(ctx.db, archiveReferenceRevisionKey);
    if (referenceRevision !== proof.referenceRevision + referenceWrites)
      fail('REFERENCE_WRITE_SET_CHANGED');
    // Only the audited monotone transitions above can carry this proof to the next deletion.
    await ctx.db.patch(proof._id, {
      referenceRevision,
      rewriteRevision: current.session.revision + 1,
    });
    return true;
  },
});
export const finishPage = internalMutation({
  args: checkpoint,
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (!current || current.session.phase !== 'DELETE') return;
    const { session } = current;
    if (session.deleted !== session.objects || session.published !== session.objects)
      fail('OBJECTS_REMAIN');
    const producer = await ctx.db
      .query('travelPrivacyChunkManifestRewrites')
      .withIndex('rewrite_state', (q) => q.eq('rewriteId', a.rewriteId).eq('state', 'PUBLISHED'))
      .first();
    if (producer) {
      const job = await producerChecked(ctx, producer);
      const metadata = { ...job.metadata };
      delete metadata.activePrivacyRewriteId;
      await ctx.db.patch(job._id, { archivePrivacyState: 'LOCAL_SANITIZED', metadata });
      await ctx.db.patch(producer._id, { state: 'COMPLETE' });
      await advance(ctx, session, {});
      return;
    }
    const imports = await ctx.db
      .query('backupImports')
      .paginate({ cursor: session.cursor, numItems: 1, maximumBytesRead: 2 * 1024 * 1024 });
    for (const imported of imports.page) {
      const producerId =
        imported.manifest.largeJobId ??
        imported.manifest.selectiveJobId ??
        imported.runtimeSnapshot.largeJobId ??
        imported.runtimeSnapshot.selectiveJobId;
      if (!producerId) continue;
      const owned = await ctx.db
        .query('travelPrivacyChunkManifestRewrites')
        .withIndex('rewrite_job', (q) =>
          q.eq('rewriteId', a.rewriteId).eq('backupJobId', producerId),
        )
        .unique();
      if (owned) await ctx.db.patch(imported._id, { archivePrivacyState: 'LOCAL_SANITIZED' });
    }
    await advance(ctx, session, {
      cursor: imports.isDone ? null : imports.continueCursor,
      ...(imports.isDone ? { phase: 'DONE', key: undefined, finishedAt: Date.now() } : {}),
    });
  },
});
export const recordError = internalMutation({
  args: { ...checkpoint, code: v.string() },
  handler: async (ctx, a) => {
    const session = await ctx.db.get(a.rewriteId);
    if (session?.revision === a.revision && session.phase !== 'DONE')
      await ctx.db.patch(session._id, {
        errorCode: /^[A-Z_]{1,80}$/.test(a.code) ? a.code : 'VALIDATION_FAILED',
        updatedAt: Date.now(),
      });
  },
});

export const clearError = internalMutation({
  args: checkpoint,
  handler: async (ctx, a) => {
    const current = await checked(ctx, a);
    if (current) await ctx.db.patch(a.rewriteId, { errorCode: undefined });
  },
});
const recoveryArgs = { ...checkpoint, operationId: v.id('archiveUploadOperations'), operationRevision: v.number() };
async function ownedRecovery(ctx: MutationCtx, a: { rewriteId: Id<'travelPrivacyChunkRewrites'>; revision: number; operationId: Id<'archiveUploadOperations'>; operationRevision: number }) {
  const current = await checked(ctx, a);
  if (!current || !['OBJECTS', 'MANIFESTS'].includes(current.session.phase)) fail('UPLOAD_RECOVERY_CHECKPOINT_CHANGED');
  const op = await ctx.db.get(a.operationId);
  if (!op || op.revision !== a.operationRevision || !['UPLOADING', 'UPLOADED'].includes(op.state) ||
    op.ownerKey !== await archiveUploadSha256Hex(new TextEncoder().encode(a.rewriteId)) ||
    op.contentType !== 'application/vnd.ai-town.archive-upload+json; operation=' + await archiveUploadSha256Hex(new TextEncoder().encode(op._id)))
    fail('UPLOAD_RECOVERY_CHECKPOINT_CHANGED');
  // During UPLOADING there is no publication. Ownership is the reserved operation
  // key of the candidate/manifest chosen by this writer's durable checkpoint.
  let record: any = current.session.phase === 'OBJECTS'
    ? await ctx.db.query('travelPrivacyChunkReplacements').withIndex('operation_storage', q => q.eq('operationId', op._id)).unique()
    : await ctx.db.query('travelPrivacyChunkManifestRewrites').withIndex('operation', q => q.eq('operationId', op._id)).unique();
  if (!record && current.session.phase === 'MANIFESTS') {
    const evidence = await ctx.db.query('travelPrivacyChunkEvidencePages').withIndex('operation', q => q.eq('operationId', op._id)).unique();
    const producer = evidence && await ctx.db.get(evidence.manifestId);
    if (evidence && producer) record = { ...evidence, rewriteId: producer.rewriteId };
  }
  if (!record || record.rewriteId !== a.rewriteId || record.state !== 'UPLOADED' || record.operationRevision !== op.revision ||
    op.operationKey !== await archiveUploadSha256Hex(new TextEncoder().encode(record._id)) ||
    op.producerKind !== (current.session.phase === 'OBJECTS' ? 'CHUNK_PRIVACY_REPLACEMENT' : 'CHUNK_PRIVACY_MANIFEST'))
    fail('UPLOAD_RECOVERY_CHECKPOINT_CHANGED');
  return current;
}
export const recoveryBegin = internalMutation({ args: recoveryArgs, handler: async (ctx, a) => {
  await ownedRecovery(ctx, a);
  const token = await beginArchiveUploadRecovery(ctx, { operationId: a.operationId, revision: a.operationRevision });
  await ctx.db.patch(a.rewriteId, { referenceRevision: await dataRevision(ctx.db, archiveReferenceRevisionKey) });
  return token;
} });
export const recoverySave = internalMutation({ args: { ...recoveryArgs, recoveryRevision: v.number(), expectedCursor: v.union(v.string(), v.null()),
  cursor: v.string(), done: v.boolean(), storageIds: v.array(v.id('_storage')), conflict: v.boolean() }, handler: async (ctx, a) => {
  await ownedRecovery(ctx, a);
  const saved = await saveArchiveUploadRecovery(ctx, { ...a, revision: a.operationRevision });
  await ctx.db.patch(a.rewriteId, { referenceRevision: await dataRevision(ctx.db, archiveReferenceRevisionKey) });
  return saved;
} });

async function readChunk(
  ctx: { storage: { get(id: Id<'_storage'>): Promise<Blob | null> } },
  storageId: Id<'_storage'>,
  expected: Candidate['originalDescriptor'],
) {
  const blob = await ctx.storage.get(storageId);
  if (!blob || blob.size > MAX_CHUNK_BYTES) fail('CHUNK_MISSING_OR_SIZE');
  const chunk = JSON.parse(await blob.text()) as LargeChunk;
  if ((await digest(await descriptor(chunk))) !== (await digest(expected)))
    fail('CHUNK_CHECKSUM_CHANGED');
  return chunk;
}
/** A pinned local derivative authenticates its embedded original evidence;
 * its own JSON must never be substituted for the original signed manifest.
 */
export async function readRewriteSourceEvidence(
  ctx: { storage: { get(id: Id<'_storage'>): Promise<Blob | null> } },
  producer: Doc<'backupLargeJobs'>,
  evidence: Pick<Producer, 'sourceSignature' | 'sourcePublicKey' | 'sourceManifestStorageId' | 'sourceManifestDigest'>,
): Promise<LocalSanitizedChunkManifest['sourceEvidence']> {
  if (!evidence.sourceSignature || !evidence.sourceManifestStorageId) fail('SOURCE_EVIDENCE_MISSING');
  const sourceBlob = await ctx.storage.get(evidence.sourceManifestStorageId);
  let raw: any;
  let localDigest: string | undefined;
  if (sourceBlob && sourceBlob.size <= 6_000_000) {
    raw = JSON.parse(await sourceBlob.text());
    localDigest = evidence.sourceManifestStorageId === producer.manifestStorageId
      ? producer.metadata?.archiveLocalManifestDigest : evidence.sourceManifestDigest;
  } else {
    const currentBlob = producer.manifestStorageId && await ctx.storage.get(producer.manifestStorageId);
    if (!currentBlob || currentBlob.size > 10_000_000) fail('SOURCE_MANIFEST_MISSING_OR_SIZE');
    raw = JSON.parse(await currentBlob.text());
    localDigest = producer.metadata?.archiveLocalManifestDigest;
    if (raw.format !== 'ai-town-local-sanitized-chunks') fail('SOURCE_EVIDENCE_MISSING');
  }
  let source: LocalSanitizedChunkManifest['sourceEvidence'];
  if (raw.format === 'ai-town-local-sanitized-chunks') {
    if (!localDigest) fail('SOURCE_EVIDENCE_MISSING');
    const local = await validateLocalChunkManifest(raw, { expectedDigest: localDigest });
    source = local.sourceEvidence;
    if (!source.manifest) fail('SOURCE_EVIDENCE_MISSING');
  } else {
    if (await digest(raw) !== evidence.sourceManifestDigest) fail('SOURCE_EVIDENCE_CHANGED');
    if (raw.format === 'ai-town-chunks') await validateManifest(raw, evidence.sourceSignature);
    else if (raw.format === 'ai-town-selective-archive') await validateSelectiveManifest(raw, evidence.sourceSignature);
    else fail('SOURCE_EVIDENCE_MISSING');
    source = { manifest: raw, digest: evidence.sourceManifestDigest!, signature: evidence.sourceSignature, publicKey: evidence.sourcePublicKey };
  }
  if (source.signature !== evidence.sourceSignature || source.publicKey !== evidence.sourcePublicKey)
    fail('SOURCE_EVIDENCE_CHANGED');
  return source;
}

/** Retry only recovers the original lease; it never invokes storage.store a second time. */
export const page = internalAction({
  args: checkpoint,
  handler: async (ctx, a): Promise<void> => {
    let revision = a.revision;
    try {
      const data = await ctx.runQuery(queryRef('travelPrivacyChunkRewrite/pageData'), a);
      if (!data) return;
      const { session, candidate, producer, manifest } = data;
      if ((session.phase === 'PREPARING' && !session.preflightComplete) || session.referenceResume) {
        const proofId = session.preflightProofId;
        const preflight = await ctx.runQuery(queryRef('travelPrivacyChunkRewrite/preflightData'), a);
        if (!proofId || preflight?.stale) {
          const created = await ctx.runMutation(mutationRef('travelPrivacyChunkReferenceProof/startPreflight'), { ...a, ...(session.referenceResume ? { resume: true } : {}) });
          await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/bindPreflightProof'), { ...a, proofId: created });
          return;
        }
        const proof = await ctx.runQuery(queryRef('travelPrivacyChunkReferenceProof/status'), { proofId });
        if (proof.phase === 'TARGETS' || proof.phase === 'ROWS') {
          await ctx.runMutation(mutationRef('travelPrivacyChunkReferenceProof/' +
            (proof.phase === 'TARGETS' ? 'targetPage' : 'rowPage')), { proofId });
          return;
        }
        if (proof.phase === 'BLOBS') {
          if (!await ctx.runAction(actionRef('travelPrivacyChunkReferenceProof/blobPage'), { proofId }))
            await ctx.runMutation(mutationRef('travelPrivacyChunkReferenceProof/finish'), { proofId });
          return;
        }
        if (session.referenceResume) {
          await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/resumeReferenceWriter'), { ...a, proofId });
          return;
        }
      }
      if (['PREPARING', 'IMPORT_FENCE', 'ROWS'].includes(session.phase)) {
        await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/preparePage'), a);
        return;
      }
      if (session.phase === 'OBJECTS' && candidate) {
        if (!producer) fail('PRODUCER_MISSING');
        const selective =
          candidate.aliases[0].role !== 'OLD' && !!producer.mode?.startsWith('selective-');
        if (candidate.state === 'PREPARED') {
          const raw = await readChunk(
            ctx,
            candidate.originalStorageId,
            candidate.originalDescriptor,
          );
          const rewritten = rewriteChunkRows(
            raw,
            candidate.selectedIndices,
            selective,
            candidate._id,
          );
          const d = await descriptor(rewritten.chunk);
          const blob = new Blob([JSON.stringify(rewritten.chunk)]);
          const upload = await describeArchiveUpload(blob);
          const lease = await ctx.runMutation(
            mutationRef('travelPrivacyChunkRewrite/reserveObject'),
            {
              ...a,
              candidateId: candidate._id,
              replacementDescriptor: d,
              rowIndices: rewritten.rowIndices,
              ...upload,
            },
          );
          if (!lease) return;
          revision = lease.rewriteRevision;
          const storageId = await ctx.storage.store(new Blob([blob], { type: lease.contentType }));
          await readChunk(ctx, storageId, d);
          await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/saveObjectUpload'), {
            ...a,
            revision,
            candidateId: candidate._id,
            storageId,
          });
          return;
        }
        if (candidate.state === 'UPLOADED') {
          await recoverLease(
            ctx,
            a,
            candidate.operationId!,
            candidate.operationRevision!,
            async (storageId) => {
              await readChunk(ctx, storageId, candidate.replacementDescriptor!);
              await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/saveObjectUpload'), {
                ...a,
                candidateId: candidate._id,
                storageId,
              });
            },
          );
          return;
        }
        const chunk = await readChunk(
          ctx,
          candidate.replacementStorageId!,
          candidate.replacementDescriptor!,
        );
        await validateLocalChunk(chunk, {
          ...candidate.replacementDescriptor!,
          role: candidate.aliases[candidate.aliasIndex].role,
          encoding: selective ? 'SELECTIVE' : 'RAW',
        });
        const rows = chunk.rows.map((encoded) => {
          const row = decodeRow(encoded);
          return selective ? decodeRow(row.record) : row;
        });
        await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/publishObject'), {
          ...a,
          candidateId: candidate._id,
          rows,
        });
        return;
      }
      if (session.phase === 'OBJECTS') {
        await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/buildManifestPage'), a);
        return;
      }
      if (session.phase === 'MANIFESTS' && manifest && producer) {
        if (manifest.state === 'PLANNED') {
          await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/buildManifestPage'), a);
          return;
        }
        if (manifest.state === 'BUILDING') {
          const evidence = await ctx.runQuery(queryRef('travelPrivacyChunkRewrite/evidencePageData'), { ...a, manifestId: manifest._id });
          if (evidence?.page) {
            const page = evidence.page;
            const chunk = { index: page.pageNumber, table: 'travelPrivacyTombstones', rows: page.rows.map(encodeRow) };
            const expected = await descriptor(chunk);
            const save = async (storageId: Id<'_storage'>) => {
              const blob = await ctx.storage.get(storageId);
              if (!blob || blob.size > MAX_CHUNK_BYTES) fail('EVIDENCE_UPLOAD_MISSING');
              await validatePrivacyChunk(JSON.parse(await blob.text()), expected);
              await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/publishEvidence'), { ...a, revision, manifestId: manifest._id, evidenceId: page._id, storageId });
            };
            if (page.state === 'UPLOADED') {
              await recoverLease(ctx, a, page.operationId!, page.operationRevision!, save);
              return;
            }
            const blob = new Blob([JSON.stringify(chunk)]);
            const lease = await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/reserveEvidence'), {
              ...a, manifestId: manifest._id, evidenceId: page._id, descriptor: expected, ...(await describeArchiveUpload(blob)) });
            if (!lease) return;
            revision = lease.rewriteRevision;
            await save(await ctx.storage.store(new Blob([blob], { type: lease.contentType })));
            return;
          }
          if (!manifest.evidenceComplete) {
            await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/buildEvidencePage'), { ...a, manifestId: manifest._id });
            return;
          }
        }
        const validateStored = async (storageId: Id<'_storage'>) => {
          const blob = await ctx.storage.get(storageId);
          if (!blob || blob.size > 10_000_000) fail('MANIFEST_MISSING_OR_SIZE');
          await validateLocalChunkManifest(JSON.parse(await blob.text()), {
            expectedDigest: manifest.manifestDigest,
          });
          await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/publishManifest'), {
            ...a,
            manifestId: manifest._id,
            storageId,
          });
        };
        if (manifest.state === 'UPLOADED') {
          await recoverLease(
            ctx,
            a,
            manifest.operationId!,
            manifest.operationRevision!,
            validateStored,
          );
          return;
        }
        let source: LocalSanitizedChunkManifest['sourceEvidence']['manifest'];
        let sourceDigest = manifest.sourceManifestDigest;
        if (manifest.sourceSignature) {
          const original = await readRewriteSourceEvidence(ctx, producer, manifest);
          source = original.manifest;
          sourceDigest = original.digest;
        }
        const privacyChunks: any[] = [];
        let privacyCursor: string | null = null;
        do {
          const page: any = await ctx.runQuery(queryRef('travelPrivacyChunkRewrite/privacyDescriptorPage'), { ...a, manifestId: manifest._id, cursor: privacyCursor });
          if (!page) fail('EVIDENCE_CHECKPOINT_CHANGED');
          privacyChunks.push(...page.page.map((row: any) => row.descriptor));
          privacyCursor = page.isDone ? null : page.continueCursor;
        } while (privacyCursor);
        if (producer.metadata?.archiveLocalManifestDigest && producer.manifestStorageId) {
          const priorBlob = await ctx.storage.get(producer.manifestStorageId);
          if (!priorBlob || priorBlob.size > 10_000_000) fail('EVIDENCE_SOURCE_MANIFEST_MISSING');
          const prior = await validateLocalChunkManifest(JSON.parse(await priorBlob.text()), { expectedDigest: producer.metadata.archiveLocalManifestDigest });
          for (const entry of prior.privacyChunks ?? [])
            if (!privacyChunks[entry.index] || await digest(privacyChunks[entry.index]) !== await digest(entry)) fail('EVIDENCE_SOURCE_CHANGED');
        }
        let privacyChainDigest = await digest([]);
        for (const entry of privacyChunks) privacyChainDigest = await digest([privacyChainDigest, entry.index, entry.digest]);
        const local = await createLocalChunkManifest({
          ...(privacyChunks.length ? { privacyChunks, privacyCount: privacyChunks.reduce((n, entry) => n + entry.count, 0), privacyChainDigest } : {}),
          archiveId: producer._id,
          derivedAt: session.createdAt,
          chunks: await loadManifestDescriptors(ctx, a, manifest),
          clearedVisits: manifest.clearedVisits,
          sourceEvidence: {
            ...(source ? { manifest: source } : {}),
            ...(manifest.sourceManifestStorageId
              ? { manifestStorageId: manifest.sourceManifestStorageId }
              : {}),
            digest: sourceDigest!,
            signature: manifest.sourceSignature,
            publicKey: manifest.sourcePublicKey,
          },
        });
        const blob = new Blob([JSON.stringify(local)]),
          manifestDigest = await digest(local);
        const lease = await ctx.runMutation(
          mutationRef('travelPrivacyChunkRewrite/reserveManifest'),
          {
            ...a,
            manifestId: manifest._id,
            manifestDigest,
            ...(await describeArchiveUpload(blob)),
          },
        );
        if (!lease) return;
        revision = lease.rewriteRevision;
        const storageId = await ctx.storage.store(new Blob([blob], { type: lease.contentType }));
        const stored = await ctx.storage.get(storageId);
        if (!stored) fail('MANIFEST_UPLOAD_MISSING');
        await validateLocalChunkManifest(JSON.parse(await stored.text()), {
          expectedDigest: manifestDigest,
        });
        await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/publishManifest'), {
          ...a,
          revision,
          manifestId: manifest._id,
          storageId,
        });
        return;
      }
      if (session.phase === 'MANIFESTS') {
        await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/buildManifestPage'), a);
        return;
      }
      if (session.phase === 'DELETE') {
        const deletion = await ctx.runQuery(queryRef('travelPrivacyChunkRewrite/deletionData'), a);
        if (!deletion) {
          await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/finishPage'), a);
          return;
        }
        let proofId = session.referenceProofId;
        if (!proofId) {
          proofId = await ctx.runMutation(mutationRef('travelPrivacyChunkReferenceProof/start'), a);
          await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/bindReferenceProof'), {
            ...a,
            proofId,
          });
          return;
        }
        const proof = await ctx.runQuery(queryRef('travelPrivacyChunkReferenceProof/status'), {
          proofId,
        });
        if (proof.phase === 'TARGETS' || proof.phase === 'ROWS') {
          await ctx.runMutation(
            mutationRef(
              'travelPrivacyChunkReferenceProof/' +
                (proof.phase === 'TARGETS' ? 'targetPage' : 'rowPage'),
            ),
            { proofId },
          );
          return;
        }
        if (proof.phase === 'BLOBS') {
          if (
            !(await ctx.runAction(actionRef('travelPrivacyChunkReferenceProof/blobPage'), {
              proofId,
            }))
          )
            await ctx.runMutation(mutationRef('travelPrivacyChunkReferenceProof/finish'), {
              proofId,
            });
          return;
        }
        const replacement = await readChunk(
          ctx,
          deletion.candidate.replacementStorageId!,
          deletion.candidate.replacementDescriptor!,
        );
        if (!replacement) fail('REPLACEMENT_MISSING');
        await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/eraseOriginal'), {
          ...a,
          candidateId: deletion.candidate._id,
          proofId,
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      const code = /^CHUNK_REWRITE_[A-Z_]+$/.test(message)
        ? message.slice('CHUNK_REWRITE_'.length)
        : /^(REFERENCE_[A-Z_]+|STRONG_REFERENCE)$/.test(message)
          ? message
          : /^LOCAL_ARCHIVE_[A-Z_]+$/.test(message)
            ? message
            : 'VALIDATION_FAILED';
      await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/recordError'), {
        ...a,
        revision,
        code,
      });
    }
  },
});

export async function loadManifestDescriptors(
  ctx: { runQuery: any },
  a: { rewriteId: Id<'travelPrivacyChunkRewrites'>; revision: number },
  manifest: Producer,
) {
  if (manifest.chunks) {
    if (manifest.chunks.length > 128) fail('LEGACY_MANIFEST_BUDGET');
    return manifest.chunks;
  }
  const chunks: LocalChunkDescriptor[] = [];
  let cursor: string | null = null,
    pageNumber = 0,
    bytes = 0,
    archiveBytes = 0,
    lastIndex = -1;
  let chainDigest = await digest([]);
  do {
    const page: {
      page: Doc<'travelPrivacyChunkManifestPages'>[];
      isDone: boolean;
      continueCursor: string;
      descriptorCount: number;
      descriptorPageCount: number;
      descriptorBytes: number;
      archiveBytes: number;
      lastDescriptorIndex: number;
    } | null = await ctx.runQuery(queryRef('travelPrivacyChunkRewrite/manifestDescriptorPage'), {
      ...a,
      manifestId: manifest._id,
      cursor,
      expectedPageNumber: pageNumber,
    });
    if (!page) fail('MANIFEST_CHECKPOINT_CHANGED');
    for (const row of page.page) {
      if (row.pageNumber !== pageNumber++) fail('MANIFEST_PAGE_CHANGED');
      chainDigest = await digest([chainDigest, row.pageNumber, row.digest]);
      for (const entry of row.descriptors) {
        if (entry.index <= lastIndex) fail('MANIFEST_DESCRIPTOR_INVALID');
        lastIndex = entry.index;
        archiveBytes += entry.bytes;
        bytes += new TextEncoder().encode(JSON.stringify(entry)).length + (chunks.length ? 1 : 0);
        chunks.push(entry);
        if (
          chunks.length > 2 * MAX_CHUNKS ||
          bytes > 10_000_000 ||
          archiveBytes > 2 * MAX_ARCHIVE_BYTES
        )
          fail('MANIFEST_BUDGET');
      }
    }
    if (page.isDone) {
      if (
        chunks.length !== page.descriptorCount ||
        pageNumber !== page.descriptorPageCount ||
        bytes !== page.descriptorBytes ||
        archiveBytes !== page.archiveBytes ||
        lastIndex !== page.lastDescriptorIndex ||
        chainDigest !== manifest.descriptorChainDigest
      )
        fail('MANIFEST_PAGE_CHANGED');
      return chunks;
    }
    if (page.continueCursor === cursor) fail('MANIFEST_CURSOR_CHANGED');
    cursor = page.continueCursor;
  } while (true);
}

async function recoverLease(
  ctx: { runMutation: any; runQuery: any },
  a: { rewriteId: Id<'travelPrivacyChunkRewrites'>; revision: number },
  operationId: Id<'archiveUploadOperations'>,
  operationRevision: number,
  save: (storageId: Id<'_storage'>) => Promise<void>,
) {
  await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/clearError'), a);
  const args = { operationId, revision: operationRevision };
  const token = await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/recoveryBegin'), { ...a, operationId, operationRevision });
  const page = await ctx.runQuery(queryRef('archiveUploadProvenance/recoveryRead'), {
    ...args,
    recoveryRevision: token.recoveryRevision,
  });
  const saved = await ctx.runMutation(mutationRef('travelPrivacyChunkRewrite/recoverySave'), {
    ...a, operationId, operationRevision,
    recoveryRevision: token.recoveryRevision,
    expectedCursor: page.cursor,
    cursor: page.continueCursor,
    done: page.done,
    storageIds: page.storageIds,
    conflict: page.conflict,
  });
  if (saved && page.storageIds.length === 1 && !page.conflict) await save(page.storageIds[0]);
  else if (page.conflict || page.storageIds.length > 1) fail('UPLOAD_RECOVERY_CONFLICT');
  else if (saved && page.done) fail('UPLOAD_COVERAGE_UNKNOWN');
}
