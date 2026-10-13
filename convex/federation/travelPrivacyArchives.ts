import { v } from 'convex/values';
import { beginChunkInspection } from './travelPrivacyChunkArchives';
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from '../maintenanceFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { assertNoSecrets, decodeRow, encodeRow, validateBundle, type BackupBundle, type BackupRow } from './backupHelpers';
import type { ColdBackupAttachment } from './coldBackup';
import { digest, verifySignature } from './security';
import { actionRef, mutationRef, queryRef } from './refs';
import { privatePayloadSummary } from './travelPrivacyGuard';
import { sanitizeTravelAuditSummary } from './travelAuditWriter';
import { assertTerminal, scheduled } from './travelPrivacy';
import { dataRevision, privacyRevisionKey, sourceKey } from '../models/embeddingDataRevision';

type Job = Doc<'travelPrivacyJobs'>;
type Imported = Doc<'backupImports'>;
type ObjectPlan = Doc<'travelPrivacyArchiveObjects'>;
type Evidence = NonNullable<Imported['archiveSourceEvidence']>;
export type LocalPrivacyArchive = {
  format: 'ai-town-local-sanitized-backup'; version: 1;
  sourceManifestDigest: string; sourceSignatureValid: false;
  clearedVisits: string[]; sections: BackupBundle['sections']; coldHistoryFiles?: ColdBackupAttachment[];
};
const MAX_PLANS = 100, MAX_IMPORT_BYTES = 6 * 1024 * 1024;
const runtimeTypes = new Set(['OBSERVATION', 'DECISION', 'ACTION_RESULT', 'CONVERSATION_ENDED']);
function error(code: string): never { throw new Error(`TRAVEL_PRIVACY_ARCHIVE_${code}`); }
const pointer = (row: Imported): Id<'_storage'> | undefined => row.localArchiveStorageId ?? row.manifest.vectorArchiveStorageId;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const sourceManifest = (row: Imported) => Object.fromEntries(Object.entries(row.manifest)
  .filter(([key]) => !['vectorSourceTrusted', 'vectorArchiveStorageId'].includes(key)));
const importDigest = (row: Imported) => digest({ manifest: row.manifest, mapping: row.mapping,
  runtimeSnapshot: row.runtimeSnapshot, archiveRevision: row.archiveRevision ?? 0,
  archivePrivacyState: row.archivePrivacyState ?? null, localArchiveStorageId: row.localArchiveStorageId ?? null,
  localArchiveDigest: row.localArchiveDigest ?? null, archiveSourceEvidence: row.archiveSourceEvidence ?? null });
const semanticDigest = (row: Imported) => digest({ sourceTownId: row.sourceTownId, mapping: row.mapping,
  manifest: sourceManifest(row), localArchiveDigest: row.localArchiveDigest ?? null });

/** Archive ownership is resolved in source space before mapping it to the selected resident. */
export async function sanitizeOrdinaryArchive(
  job: Job, imported: Imported, input: Pick<BackupBundle, 'sections' | 'coldHistoryFiles'>,
  manifestDigest: string, clearedVisits: string[] = [],
): Promise<{ archive: LocalPrivacyArchive; changed: boolean }> {
  const rows = Object.fromEntries(Object.entries(input.sections).map(([table, values]) => [table, values.map(decodeRow)]));
  const map = (id: string) => imported.mapping[id] ?? id;
  const bindings = rows.residentModelBindings ?? [];
  const owned = (row: BackupRow, allowGlobalOnly = false) => {
    if (row.worldId !== undefined && map(row.worldId) !== job.worldId) return false;
    const candidates = bindings.filter(b => b.worldId === row.worldId && b.playerId === row.playerId);
    if (candidates.length > 1 || row.agentGlobalId !== undefined && candidates.length === 1 &&
      candidates[0].agentGlobalId !== row.agentGlobalId) error('OWNER_AMBIGUOUS');
    const global = row.agentGlobalId ?? (candidates.length === 1 ? candidates[0].agentGlobalId : undefined);
    const globalBindings = global === undefined ? [] : bindings.filter(b => b.agentGlobalId === global);
    if (globalBindings.length > 1 || row.worldId !== undefined && globalBindings.length === 1 &&
      (globalBindings[0].worldId !== row.worldId || row.playerId !== undefined && globalBindings[0].playerId !== row.playerId))
      error('OWNER_AMBIGUOUS');
    return global !== undefined && map(global) === job.ownerGlobalId &&
      (row.worldId !== undefined || allowGlobalOnly);
  };
  const ledgers = (rows.visitLedger ?? []).filter(row => row.visitId === job.visitId);
  if (ledgers.length > 1) error('OWNER_AMBIGUOUS');
  const selectedLedger = ledgers.length === 1 && owned({ ...ledgers[0], playerId: ledgers[0].homePlayerId });
  const directVisit = (row: BackupRow) => {
    if ((row.visitId ?? row.envelope?.visitId) !== job.visitId) return false;
    if (row.agentGlobalId !== undefined || row.worldId !== undefined) {
      const hasOwner = row.agentGlobalId !== undefined || row.playerId !== undefined;
      if (hasOwner) return owned(row, true);
      if (map(row.worldId) !== job.worldId) return false;
    }
    if (!ledgers.length) error('OWNER_EVIDENCE_MISSING');
    return selectedLedger;
  };
  const conversations = new Set<string>();
  const conversationKey = (worldId: string, conversationId: string) => JSON.stringify([worldId, conversationId]);
  for (const table of ['federationTurns', 'federationTranscriptJobs']) for (const row of rows[table] ?? [])
    if (directVisit(row) && row.worldId && row.conversationId)
      conversations.add(conversationKey(row.worldId, row.conversationId));
  const inConversation = (row: BackupRow) => row.worldId && row.conversationId &&
    (conversations.has(conversationKey(row.worldId, row.conversationId)) ||
      map(row.worldId) === job.worldId && job.conversationIds.includes(map(row.conversationId)));
  for (const table of ['federationTurns', 'federationTranscriptJobs']) for (const row of rows[table] ?? [])
    if (inConversation(row) && row.visitId !== job.visitId) error('SHARED_CONVERSATION');
  const transcripts = new Set<string>();
  for (const row of rows.homeTravelTranscripts ?? []) if (directVisit(row))
    transcripts.add(JSON.stringify([row.agentGlobalId, row.transcriptId]));
  const inTranscript = (row: BackupRow) => row.agentGlobalId &&
    (transcripts.has(JSON.stringify([row.agentGlobalId, row.transcriptId])) ||
      map(row.agentGlobalId) === job.ownerGlobalId && job.transcriptIds.includes(map(row.transcriptId)));
  const memoryIds = new Set<string>();
  for (const row of rows.memories ?? []) {
    const selectedId = job.memoryIds.includes(map(row._id));
    if (selectedId && !owned(row)) error('OWNER_AMBIGUOUS');
    if (selectedId || row.data?.type === 'travel' && row.data.visitId === job.visitId && owned(row) ||
      row.data?.type === 'conversation' && inConversation({ ...row, conversationId: row.data.conversationId }))
      memoryIds.add(row._id);
    if (row.data?.type === 'travel' && row.data.visitId === job.visitId && !owned(row)) {
      // A visit shared across residents cannot authorize erasing a second owner's history.
      if (selectedLedger) error('SHARED_VISIT_OWNERSHIP');
    }
  }
  let extended = true;
  while (extended) {
    extended = false;
    for (const row of rows.memories ?? []) if (row.data?.type === 'reflection' && !memoryIds.has(row._id) &&
      row.data.relatedMemoryIds.some((id: string) => memoryIds.has(id))) {
      if (row.data.relatedMemoryIds.every((id: string) => memoryIds.has(id))) {
        if (!owned(row)) error('SHARED_DERIVED_MEMORY');
        memoryIds.add(row._id); extended = true;
      }
    }
  }
  for (const row of rows.memories ?? []) if (row.data?.type === 'reflection' && !memoryIds.has(row._id) &&
    row.data.relatedMemoryIds.some((id: string) => memoryIds.has(id))) error('SHARED_DERIVED_MEMORY');
  for (const row of rows.memorySourceCorrections ?? []) if (!memoryIds.has(row.sourceMemoryId) &&
    row.evidenceMemoryIds.some((id: string) => memoryIds.has(id))) error('SHARED_CORRECTION');
  const selectedInputs = new Set<string>(), otherInputs = new Set<string>();
  for (const row of rows.federationPendingActions ?? [])
    (directVisit(row) ? selectedInputs : otherInputs).add(row.inputId);
  if ([...selectedInputs].some(id => otherInputs.has(id))) error('SHARED_INPUT');
  let changed = false;
  const sections: BackupBundle['sections'] = {};
  for (const [table, values] of Object.entries(input.sections)) {
    sections[table] = [];
    for (const encoded of values) {
      const row = decodeRow(encoded), ownVisit = directVisit(row);
      const remove = table === 'memories' && memoryIds.has(row._id) ||
        table === 'modelMemoryVectors' && memoryIds.has(row.memoryId) ||
        table === 'memorySourceCorrections' && memoryIds.has(row.sourceMemoryId) ||
        table === 'memorySourceClaims' && memoryIds.has(row.memoryId) ||
        table === 'memorySummaryProvenance' && memoryIds.has(row.summaryMemoryId) ||
        table === 'messages' && inConversation(row) ||
        ['homeTravelTranscripts', 'homeTravelTranscriptPages'].includes(table) && inTranscript(row);
      if (remove) { changed = true; continue; }
      if (ownVisit && table === 'federationEventFacts') row.payload = privatePayloadSummary(row.payload);
      else if (ownVisit && ['federationActionFacts', 'federationPendingActions'].includes(table)) {
        row.action = { type: row.action?.type, privacyRedacted: true };
        row.result = row.result?.kind === 'ok' ? { kind: 'ok', value: null } : { kind: 'error', message: 'PRIVACY_REDACTED' };
        row.receiptPayload = privatePayloadSummary(row.receiptPayload);
      } else if (ownVisit && table === 'federationTravelAudit') {
        for (const field of ['previous', 'next']) {
          const summary = sanitizeTravelAuditSummary(row[field]);
          if (summary === undefined) delete row[field]; else row[field] = summary;
        }
      } else if (ownVisit && table === 'autonomousTravelDecisions') {
        delete row.reason; delete row.error;
      } else if (ownVisit && ['federationInbox', 'federationOutbox'].includes(table) && runtimeTypes.has(row.envelope?.type)) {
        row.envelope = { ...row.envelope, payload: privatePayloadSummary(row.envelope.payload) };
        delete row.lastError;
      } else if (ownVisit && table === 'federationDecisionJobs') {
        row.observation = {}; delete row.error;
      } else if (ownVisit && table === 'federationTranscriptJobs') {
        delete row.pendingMessages; delete row.lastError;
      } else if (table === 'inputs' && selectedInputs.has(row._id)) {
        row.args = {};
        if (row.returnValue !== undefined)
          row.returnValue = row.returnValue?.kind === 'ok' ? { kind: 'ok', value: null } : { kind: 'error', message: 'PRIVACY_REDACTED' };
      } else if (table === 'memoryCompressionJobs' && row.sources.some((s: BackupRow) => memoryIds.has(s.memoryId))) {
        row.state = 'CANCELLED'; row.sources = []; delete row.errorCode;
      }
      const next = encodeRow(row);
      if (next !== encodeRow(decodeRow(encoded))) { changed = true; sections[table].push(next); }
      else sections[table].push(encoded);
    }
  }
  const files = input.coldHistoryFiles?.filter(a => !memoryIds.has(a.owner.memoryId));
  if (files?.length !== input.coldHistoryFiles?.length) changed = true;
  return { changed, archive: { format: 'ai-town-local-sanitized-backup', version: 1,
    sourceManifestDigest: manifestDigest, sourceSignatureValid: false,
    clearedVisits: [...new Set([...clearedVisits, job.visitId])].sort(), sections,
    ...(files === undefined ? {} : { coldHistoryFiles: files }) } };
}

// Signed evidence must consist only of protocol metadata; unknown fields can carry erased bodies.
function assertManifestMetadata(manifest: BackupBundle['manifest']) {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const summary = (value: unknown) => object(value) &&
    Object.keys(value).sort().join() === 'bytes,count,digest' &&
    typeof value.digest === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value.digest) &&
    Number.isSafeInteger(value.count) && (value.count as number) >= 0 &&
    Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0;
  if (!object(manifest) || Object.keys(manifest).some(key => !['format', 'version', 'schemaVersion',
    'scope', 'sourceTownId', 'exportedAt', 'includeVectors', 'sections', 'coldHistoryFiles'].includes(key)) ||
    manifest.format !== 'ai-town-backup' || manifest.version !== 1 || manifest.schemaVersion !== 1 ||
    !['town', 'resident'].includes(manifest.scope) || typeof manifest.sourceTownId !== 'string' || !manifest.sourceTownId ||
    !Number.isFinite(manifest.exportedAt) ||
    manifest.includeVectors !== undefined && typeof manifest.includeVectors !== 'boolean' ||
    !object(manifest.sections) || Object.values(manifest.sections).some(value => !summary(value)) ||
    manifest.coldHistoryFiles !== undefined && !summary(manifest.coldHistoryFiles)) error('MANIFEST_METADATA_INVALID');
}

async function readArchive(imported: Imported, storageId: Id<'_storage'>, blob: Blob) {
  if (blob.size > 5_000_000) error('SIZE_LIMIT');
  const raw = JSON.parse(await blob.text());
  if (imported.localArchiveStorageId) {
    const evidence = imported.archiveSourceEvidence;
    if (evidence) assertManifestMetadata(evidence.manifest);
    if (!evidence || raw?.format !== 'ai-town-local-sanitized-backup' || raw.version !== 1 ||
      raw.sourceSignatureValid !== false || Object.keys(raw).some(key => !['format', 'version', 'sourceManifestDigest',
        'sourceSignatureValid', 'clearedVisits', 'sections', 'coldHistoryFiles'].includes(key)) ||
      !Array.isArray(raw.clearedVisits) || raw.clearedVisits.some((id: unknown) => typeof id !== 'string') ||
      !raw.sections || typeof raw.sections !== 'object' || Array.isArray(raw.sections) ||
      Object.keys(raw.sections).sort().join() !== Object.keys(evidence.manifest.sections).sort().join() ||
      raw.sourceManifestDigest !== await digest(evidence.manifest) || await digest(raw) !== imported.localArchiveDigest)
      error('LOCAL_INTEGRITY_FAILED');
    if (evidence.manifest.sourceTownId !== imported.sourceTownId ||
      await digest(evidence.manifest) !== await digest(sourceManifest(imported)) ||
      evidence.signature && !await verifySignature(evidence.manifest, evidence.signature, evidence.sourcePublicKey)) error('LOCAL_INTEGRITY_FAILED');
    assertNoSecrets(raw);
    for (const values of Object.values(raw.sections)) {
      if (!Array.isArray(values)) error('LOCAL_INTEGRITY_FAILED');
      for (const encoded of values as unknown[]) decodeRow(encoded);
    }
    return { input: raw as LocalPrivacyArchive, evidence, originalDigest: await digest(raw) };
  }
  assertManifestMetadata(raw?.manifest);
  const bundle = await validateBundle(raw);
  const source = decodeRow(bundle.sections.federationIdentity[0]);
  if (bundle.manifest.sourceTownId !== imported.sourceTownId || await digest(bundle.manifest) !== await digest(sourceManifest(imported)))
    error('MANIFEST_CHANGED');
  const originalDigest = await digest(bundle);
  return { input: bundle, originalDigest, evidence: { manifest: bundle.manifest,
    signature: bundle.signature ?? '', sourcePublicKey: source.publicKey ?? '', originalStorageId: storageId, originalDigest } as Evidence };
}

async function assertOtherReferencesAbsent(ctx: QueryCtx | MutationCtx, storageId: Id<'_storage'>) {
  if (await ctx.db.query('backupLargeChunks').withIndex('storage', q => q.eq('storageId', storageId)).first() ||
    await ctx.db.query('backupLargeJobs').withIndex('manifestStorage', q => q.eq('manifestStorageId', storageId)).first() ||
    await ctx.db.query('coldHistoryArchives').withIndex('storage', q => q.eq('storageId', storageId)).first() ||
    await ctx.db.query('coldHistoryChunks').withIndex('storage', q => q.eq('storageId', storageId)).first() ||
    await ctx.db.query('music').withIndex('storage', q => q.eq('storageId', storageId)).first()) error('SHARED_STORAGE');
}

async function assertReferencesMatch(ctx: MutationCtx, plan: ObjectPlan, published = false) {
  const originalImports = await ctx.db.query('backupImports').withIndex('vectorArchiveStorage', q =>
    q.eq('manifest.vectorArchiveStorageId', plan.originalStorageId)).take(MAX_PLANS + 1);
  const localImports = await ctx.db.query('backupImports').withIndex('localArchiveStorage', q =>
    q.eq('localArchiveStorageId', plan.originalStorageId)).take(MAX_PLANS + 1);
  const imports = [...new Map([...originalImports, ...localImports].map(row => [row._id, row])).values()];
  const expected = published ? [] : plan.references.map(ref => ref.importId).sort();
  if (imports.map(row => row._id).sort().join() !== expected.join()) error('SHARED_STORAGE_CHANGED');
  await assertOtherReferencesAbsent(ctx, plan.originalStorageId);
}

export async function beginArchiveRewrite(ctx: MutationCtx, job: Job) {
  const plans = await ctx.db.query('travelPrivacyArchiveObjects').withIndex('job', q => q.eq('jobId', job._id)).take(MAX_PLANS + 1);
  if (plans.length > MAX_PLANS || plans.reduce((sum, plan) => sum + plan.references.reduce((n, ref) => n + ref.importBytes, 0), 0) > MAX_IMPORT_BYTES)
    error('PLAN_BUDGET');
  for (const plan of plans) {
    if (plan.state !== 'PLANNED' || !plan.references.length) error('REFERENCES_INCOMPLETE');
    await assertReferencesMatch(ctx, plan);
    const references = [];
    for (const ref of plan.references) {
      const imported = await ctx.db.get(ref.importId as Id<'backupImports'>);
      if (!imported || pointer(imported) !== plan.originalStorageId || (imported.archiveRevision ?? 0) !== ref.expectedArchiveRevision ||
        await importDigest(imported) !== ref.expectedImportDigest) error('PREVIEW_STALE');
      const next = { ...imported, archivePrivacyState: 'REWRITING' as const, archiveRevision: ref.expectedArchiveRevision + 1 };
      await ctx.db.patch(imported._id, { archivePrivacyState: next.archivePrivacyState, archiveRevision: next.archiveRevision });
      references.push({ ...ref, rewritingImportDigest: await importDigest(next) });
    }
    await ctx.db.patch(plan._id, { references });
  }
  return plans.length > 0;
}

const checkpoint = { jobId: v.id('travelPrivacyJobs'), revision: v.number() };
async function checkedJob(ctx: QueryCtx | MutationCtx, a: { jobId: Id<'travelPrivacyJobs'>; revision: number }) {
  const job = await ctx.db.get(a.jobId);
  if (!job || job.revision !== a.revision || !['INSPECTING', 'RUNNING'].includes(job.state) ||
    !['ARCHIVE_CHECK', 'ARCHIVE_REWRITE'].includes(job.phase)) return null;
  await assertTerminal(ctx, job.visitId, job.history);
  return job;
}
export const pageData = internalQuery({
  args: checkpoint, handler: async (ctx, a) => {
    const job = await checkedJob(ctx, a);
    if (!job) return null;
    if (job.phase === 'ARCHIVE_CHECK') {
      const checking = await ctx.db.query('travelPrivacyArchiveObjects').withIndex('job_state', q =>
        q.eq('jobId', job._id).eq('state', 'CHECKING_REFERENCES')).first();
      if (checking) return { job, imported: await ctx.db.get(checking.importId), plan: checking, referenceCheck: true, cursor: null, done: false };
      if (job.cursor === 'ARCHIVE_IMPORTS_DONE') return { job, imported: null, plan: null, cursor: 'ARCHIVE_IMPORTS_DONE', done: true };
      const page = await ctx.db.query('backupImports').paginate({ cursor: job.cursor, numItems: 1, maximumBytesRead: 2 * 1024 * 1024 });
      const imported = page.page[0] ?? null;
      const skipImport = imported && pointer(imported) && await ctx.db.query('travelPrivacyArchiveObjects').withIndex('job_storage', q =>
        q.eq('jobId', job._id).eq('originalStorageId', pointer(imported)!)).first();
      return { job, imported, cursor: page.continueCursor, done: page.isDone, plan: null, skipImport: !!skipImport };
    }
    const plan = await ctx.db.query('travelPrivacyArchiveObjects').withIndex('job', q => q.eq('jobId', job._id))
      .filter(q => q.neq(q.field('state'), 'DELETED')).first();
    return { job, plan, imported: plan ? await ctx.db.get(plan.importId) : null, cursor: null, done: !plan };
  },
});
export const referencePage = internalQuery({
  args: { ...checkpoint, objectId: v.id('travelPrivacyArchiveObjects') }, handler: async (ctx, a) => {
    const job = await checkedJob(ctx, a), plan = await ctx.db.get(a.objectId);
    if (!job || !plan || plan.jobId !== job._id || plan.state !== 'CHECKING_REFERENCES') return null;
    // Each object starts in exactly one archive format. Cross-format references are ambiguous.
    const anchor = await ctx.db.get(plan.importId);
    if (!anchor) error('IMPORT_MISSING');
    const page = anchor.localArchiveStorageId
      ? await ctx.db.query('backupImports').withIndex('localArchiveStorage', q => q.eq('localArchiveStorageId', plan.originalStorageId))
        .paginate({ cursor: plan.referenceCursor, numItems: 5, maximumBytesRead: 2 * 1024 * 1024 })
      : await ctx.db.query('backupImports').withIndex('vectorArchiveStorage', q => q.eq('manifest.vectorArchiveStorageId', plan.originalStorageId))
        .paginate({ cursor: plan.referenceCursor, numItems: 5, maximumBytesRead: 2 * 1024 * 1024 });
    const crossFormat = anchor.localArchiveStorageId
      ? await ctx.db.query('backupImports').withIndex('vectorArchiveStorage', q => q.eq('manifest.vectorArchiveStorageId', plan.originalStorageId)).first()
      : await ctx.db.query('backupImports').withIndex('localArchiveStorage', q => q.eq('localArchiveStorageId', plan.originalStorageId)).first();
    return { ...page, references: await Promise.all(page.page.map(async imported => ({ importId: imported._id,
      expectedArchiveRevision: imported.archiveRevision ?? 0, expectedImportDigest: await importDigest(imported),
      semanticDigest: await semanticDigest(imported), importBytes: bytes(imported),
      available: !crossFormat && pointer(imported) === plan.originalStorageId && imported.archivePrivacyState !== 'REWRITING' }))) };
  },
});
export const saveReferences = internalMutation({
  args: { ...checkpoint, objectId: v.id('travelPrivacyArchiveObjects'), expectedCursor: v.union(v.string(), v.null()),
    cursor: v.string(), done: v.boolean(), references: v.array(v.any()) }, handler: async (ctx, a) => {
    const job = await checkedJob(ctx, a), plan = await ctx.db.get(a.objectId);
    if (!job || !plan || job.phase !== 'ARCHIVE_CHECK' || plan.jobId !== job._id || plan.state !== 'CHECKING_REFERENCES' ||
      plan.referenceCursor !== a.expectedCursor) return;
    const references = [...plan.references];
    let blocker: string | undefined;
    for (const ref of a.references) {
      if (!ref.available || ref.semanticDigest !== plan.semanticDigest) { blocker = 'ARCHIVE_SHARED_STORAGE'; break; }
      const imported = await ctx.db.get(ref.importId as Id<'backupImports'>);
      if (!imported || await importDigest(imported) !== ref.expectedImportDigest) { blocker = 'ARCHIVE_PREVIEW_STALE'; break; }
      if (references.some(prior => prior.importId === ref.importId)) { blocker = 'ARCHIVE_SHARED_STORAGE_CHANGED'; break; }
      const { available: _available, semanticDigest: _semantic, ...saved } = ref;
      references.push(saved);
    }
    const all = await ctx.db.query('travelPrivacyArchiveObjects').withIndex('job', q => q.eq('jobId', job._id)).take(MAX_PLANS + 1);
    const totalBytes = all.filter(other => other._id !== plan._id).reduce((sum, other) => sum + other.references.reduce((n, ref) => n + ref.importBytes, 0), 0)
      + references.reduce((sum, ref) => sum + ref.importBytes, 0);
    if (references.length > MAX_PLANS || totalBytes > MAX_IMPORT_BYTES) blocker = 'ARCHIVE_PLAN_BUDGET';
    if (a.done && !references.some(ref => ref.importId === plan.importId)) blocker = 'ARCHIVE_PREVIEW_STALE';
    if (!blocker) try { await assertOtherReferencesAbsent(ctx, plan.originalStorageId); }
    catch { blocker = 'ARCHIVE_SHARED_STORAGE'; }
    if (blocker) {
      await ctx.db.patch(job._id, { state: 'BLOCKED', blockers: [...new Set([...job.blockers, blocker])], revision: job.revision + 1 });
      return;
    }
    await ctx.db.patch(plan._id, { references, referenceCursor: a.done ? null : a.cursor, state: a.done ? 'PLANNED' : plan.state });
    await ctx.db.patch(job._id, { revision: job.revision + 1 });
    await scheduled(ctx, { ...job, revision: job.revision + 1 });
  },
});
export const saveInspection = internalMutation({
  args: { ...checkpoint, importId: v.optional(v.id('backupImports')), expectedImportDigest: v.optional(v.string()),
    cursor: v.string(), done: v.boolean(), plan: v.optional(v.any()), blocker: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const job = await checkedJob(ctx, a);
    if (!job || job.phase !== 'ARCHIVE_CHECK') return;
    let blocker = a.blocker;
    if (a.importId) {
      const imported = await ctx.db.get(a.importId);
      if (!imported || await importDigest(imported) !== a.expectedImportDigest) blocker = 'ARCHIVE_PREVIEW_STALE';
      if (a.plan && !blocker) {
        try { await assertOtherReferencesAbsent(ctx, a.plan.originalStorageId); }
        catch { blocker = 'ARCHIVE_SHARED_STORAGE'; }
        const prior = await ctx.db.query('travelPrivacyArchiveObjects').withIndex('job', q => q.eq('jobId', job._id)).take(MAX_PLANS + 1);
        if (prior.length >= MAX_PLANS || prior.reduce((sum, plan) => sum + plan.importBytes, 0) + a.plan.importBytes > MAX_IMPORT_BYTES)
          blocker = 'ARCHIVE_PLAN_BUDGET';
        if (!blocker) await ctx.db.insert('travelPrivacyArchiveObjects', { ...a.plan, jobId: job._id, importId: a.importId,
          state: 'CHECKING_REFERENCES', referenceCursor: null, references: [] });
      }
    }
    const blockers = [...job.blockers];
    if (blocker && !blockers.includes(blocker)) blockers.push(blocker);
    if (a.done && (job.sourceRevision !== await dataRevision(ctx.db, sourceKey) ||
      job.privacyRevision !== await dataRevision(ctx.db, privacyRevisionKey))) blockers.push('PREVIEW_STALE');
    // A final import page can still have a reference scan pending. Finish that scan before READY.
    const finish = a.done && !(a.plan && !blocker);
    const chunkCheck = finish && !blockers.length;
    const next = { ...job, blockers, cursor: a.done ? 'ARCHIVE_IMPORTS_DONE' : a.cursor, revision: job.revision + 1, updatedAt: Date.now(),
      phase: chunkCheck ? 'CHUNK_CHECK' : job.phase,
      state: finish ? (blockers.length ? 'BLOCKED' : 'INSPECTING') : job.state,
      archiveCoverage: { ordinaryBundles: finish ? 'READY' as const : 'CHECKING' as const,
        largeChunks: chunkCheck ? 'CHECKING' as const : 'NOT_IMPLEMENTED' as const, orphanObjects: 'NOT_VERIFIED' as const } };
    await ctx.db.patch(job._id, { blockers: next.blockers, cursor: next.cursor, revision: next.revision,
      updatedAt: next.updatedAt, state: next.state, phase: next.phase, archiveCoverage: next.archiveCoverage });
    if (chunkCheck) {
      const chunkScanId = await beginChunkInspection(ctx, next);
      await ctx.db.patch(job._id, { chunkScanId });
    }
    if (!finish || chunkCheck) await scheduled(ctx, next);
  },
});
export const publish = internalMutation({
  args: { ...checkpoint, objectId: v.id('travelPrivacyArchiveObjects'), storageId: v.id('_storage'), replacementDigest: v.string() },
  handler: async (ctx, a) => {
    const job = await checkedJob(ctx, a);
    if (!job || job.phase !== 'ARCHIVE_REWRITE') return false;
    const plan = await ctx.db.get(a.objectId);
    if (!plan || plan.jobId !== job._id || plan.state !== 'PLANNED' || plan.replacementDigest !== a.replacementDigest) error('CHECKPOINT_CHANGED');
    await assertReferencesMatch(ctx, plan);
    const references = [];
    for (const ref of plan.references) {
      const imported = await ctx.db.get(ref.importId);
      if (!imported || pointer(imported) !== plan.originalStorageId || imported.archivePrivacyState !== 'REWRITING' ||
        await importDigest(imported) !== ref.rewritingImportDigest) error('PREVIEW_STALE');
      const manifest = { ...imported.manifest };
      delete manifest.vectorArchiveStorageId;
      const next = { ...imported, manifest, localArchiveStorageId: a.storageId,
        localArchiveDigest: a.replacementDigest, archiveSourceEvidence: plan.sourceEvidence };
      await ctx.db.patch(imported._id, { manifest, localArchiveStorageId: next.localArchiveStorageId,
        localArchiveDigest: next.localArchiveDigest, archiveSourceEvidence: next.archiveSourceEvidence });
      references.push({ ...ref, publishedImportDigest: await importDigest(next) });
    }
    await ctx.db.patch(plan._id, { state: 'PUBLISHED', replacementStorageId: a.storageId, references });
    await ctx.db.patch(job._id, { revision: job.revision + 1, archiveError: undefined, updatedAt: Date.now() });
    await scheduled(ctx, { ...job, revision: job.revision + 1 });
    return true;
  },
});
export const eraseOriginal = internalMutation({
  args: { ...checkpoint, objectId: v.id('travelPrivacyArchiveObjects') },
  handler: async (ctx, a) => {
    const job = await checkedJob(ctx, a);
    if (!job || job.phase !== 'ARCHIVE_REWRITE') return;
    const plan = await ctx.db.get(a.objectId);
    if (!plan || plan.jobId !== job._id || plan.state !== 'PUBLISHED') error('CHECKPOINT_CHANGED');
    const imports = [];
    for (const ref of plan.references) {
      const imported = await ctx.db.get(ref.importId);
      if (!imported || await importDigest(imported) !== ref.publishedImportDigest ||
        imported.localArchiveStorageId !== plan.replacementStorageId) error('PREVIEW_STALE');
      imports.push(imported);
    }
    await assertReferencesMatch(ctx, plan, true);
    // Storage deletion and this journal checkpoint commit in the same mutation.
    await ctx.storage.delete(plan.originalStorageId);
    if (await ctx.db.system.get(plan.originalStorageId)) error('DELETE_NOT_CONFIRMED');
    for (const imported of imports) await ctx.db.patch(imported._id, { archivePrivacyState: 'LOCAL_SANITIZED' });
    await ctx.db.patch(plan._id, { state: 'DELETED', deletedAt: Date.now() });
    await ctx.db.patch(job._id, { revision: job.revision + 1, archiveError: undefined,
      processedRows: job.processedRows + 1, counts: { ...job.counts, ordinaryArchiveObjects: (job.counts.ordinaryArchiveObjects ?? 0) + 1 } });
    await scheduled(ctx, { ...job, revision: job.revision + 1 });
  },
});
export const finishRewrite = internalMutation({
  args: checkpoint, handler: async (ctx, a) => {
    const job = await checkedJob(ctx, a);
    if (!job || job.phase !== 'ARCHIVE_REWRITE') return;
    if (await ctx.db.query('travelPrivacyArchiveObjects').withIndex('job', q => q.eq('jobId', job._id))
      .filter(q => q.neq(q.field('state'), 'DELETED')).first()) error('DELETE_NOT_CONFIRMED');
    const next = { ...job, phase: 'PURGE', cursor: null, tableIndex: 0, revision: job.revision + 1, archiveError: undefined,
      archiveCoverage: { ordinaryBundles: 'COMPLETE' as const, largeChunks: job.archiveCoverage?.largeChunks ?? 'NOT_IMPLEMENTED', orphanObjects: 'NOT_VERIFIED' as const } };
    await ctx.db.patch(job._id, { phase: next.phase, cursor: next.cursor, tableIndex: next.tableIndex,
      revision: next.revision, archiveError: undefined, archiveCoverage: next.archiveCoverage });
    await scheduled(ctx, next);
  },
});
export const fail = internalMutation({
  args: { ...checkpoint, code: v.string() }, handler: async (ctx, a) => {
    const job = await checkedJob(ctx, a);
    if (job) await ctx.db.patch(job._id, { archiveError: a.code, updatedAt: Date.now() });
  },
});

export const discardReplacement = internalMutation({
  args: { ...checkpoint, objectId: v.id('travelPrivacyArchiveObjects'), storageId: v.id('_storage'), code: v.string() },
  handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId), plan = await ctx.db.get(a.objectId);
    if (!job || !plan || plan.jobId !== job._id || plan.originalStorageId === a.storageId) return;
    // Fence a publication whose response is unknown before proving the candidate unreferenced.
    // A late publication with the old revision will then fail its checkpoint check.
    if (job.revision === a.revision) await ctx.db.patch(job._id, {
      revision: job.revision + 1, archiveError: a.code, updatedAt: Date.now(),
    });
    if (plan.replacementStorageId === a.storageId ||
      await ctx.db.query('backupImports').withIndex('localArchiveStorage', q => q.eq('localArchiveStorageId', a.storageId)).first() ||
      await ctx.db.query('backupImports').withIndex('vectorArchiveStorage', q => q.eq('manifest.vectorArchiveStorageId', a.storageId)).first()) return;
    await assertOtherReferencesAbsent(ctx, a.storageId);
    if (await ctx.db.system.get(a.storageId)) await ctx.storage.delete(a.storageId);
  },
});

export const page = internalAction({
  args: checkpoint, handler: async (ctx, a): Promise<void> => {
    let uploaded: { storageId: Id<'_storage'>; objectId: Id<'travelPrivacyArchiveObjects'> } | undefined;
    try {
      const data = await ctx.runQuery(queryRef('travelPrivacyArchives/pageData'), a);
      if (!data) return;
      const { job, imported, plan } = data as { job: Job; imported: Imported | null; plan: ObjectPlan | null; cursor: string; done: boolean };
      if (job.phase === 'ARCHIVE_CHECK') {
        if (data.referenceCheck && plan) {
          const refs = await ctx.runQuery(queryRef('travelPrivacyArchives/referencePage'), { ...a, objectId: plan._id });
          if (refs) await ctx.runMutation(mutationRef('travelPrivacyArchives/saveReferences'), { ...a, objectId: plan._id,
            expectedCursor: plan.referenceCursor, cursor: refs.continueCursor, done: refs.isDone, references: refs.references });
          return;
        }
        let planned: Omit<ObjectPlan, '_id' | '_creationTime' | 'jobId' | 'importId' | 'state'> | undefined, blocker: string | undefined;
        const expectedImportDigest = imported ? await importDigest(imported) : undefined;
        if (imported && pointer(imported) && !data.skipImport) {
          try {
            if (imported.archivePrivacyState === 'REWRITING') error('REWRITE_IN_PROGRESS');
            const storageId = pointer(imported)!;
            const blob = await ctx.storage.get(storageId);
            if (!blob) error('STORAGE_MISSING');
            const checked = await readArchive(imported, storageId, blob);
            const sanitized = await sanitizeOrdinaryArchive(job, imported, checked.input, await digest(checked.evidence.manifest),
              'clearedVisits' in checked.input ? checked.input.clearedVisits : []);
            if (sanitized.changed) planned = { originalStorageId: storageId, originalDigest: checked.originalDigest,
              replacementDigest: await digest(sanitized.archive), sourceEvidence: checked.evidence,
              expectedArchiveRevision: imported.archiveRevision ?? 0, expectedImportDigest: expectedImportDigest!, importBytes: bytes(imported),
              referenceCursor: null, references: [], semanticDigest: await semanticDigest(imported) };
          } catch (cause) { blocker = safeError(cause); }
        }
        await ctx.runMutation(mutationRef('travelPrivacyArchives/saveInspection'), { ...a,
          ...(imported ? { importId: imported._id, expectedImportDigest } : {}), cursor: data.cursor, done: data.done,
          ...(planned ? { plan: planned } : {}), ...(blocker ? { blocker } : {}) });
        return;
      }
      if (!plan) { await ctx.runMutation(mutationRef('travelPrivacyArchives/finishRewrite'), a); return; }
      if (!imported) error('IMPORT_MISSING');
      if (plan.state === 'PUBLISHED') {
        const replacement = await ctx.storage.get(plan.replacementStorageId!);
        if (!replacement) error('REPLACEMENT_MISSING');
        await readArchive(imported, plan.replacementStorageId!, replacement);
        await ctx.runMutation(mutationRef('travelPrivacyArchives/eraseOriginal'), { ...a, objectId: plan._id });
        return;
      }
      const blob = await ctx.storage.get(plan.originalStorageId);
      if (!blob) error('STORAGE_MISSING');
      const checked = await readArchive(imported, plan.originalStorageId, blob);
      if (checked.originalDigest !== plan.originalDigest) error('INTEGRITY_CHANGED');
      const sanitized = await sanitizeOrdinaryArchive(job, imported, checked.input, await digest(checked.evidence.manifest),
        'clearedVisits' in checked.input ? checked.input.clearedVisits : []);
      if (await digest(sanitized.archive) !== plan.replacementDigest) error('PLAN_CHANGED');
      const storageId = await ctx.storage.store(new Blob([JSON.stringify(sanitized.archive)], { type: 'application/json' }));
      uploaded = { storageId, objectId: plan._id };
      const stored = await ctx.storage.get(storageId);
      if (!stored || await digest(JSON.parse(await stored.text())) !== plan.replacementDigest) error('REPLACEMENT_INVALID');
      const published = await ctx.runMutation(mutationRef('travelPrivacyArchives/publish'), { ...a, objectId: plan._id, storageId, replacementDigest: plan.replacementDigest });
      if (!published) await ctx.runMutation(mutationRef('travelPrivacyArchives/discardReplacement'), { ...a, ...uploaded, code: 'ARCHIVE_CHECKPOINT_CHANGED' });
    } catch (cause) {
      if (uploaded) {
        try { await ctx.runMutation(mutationRef('travelPrivacyArchives/discardReplacement'), { ...a, ...uploaded, code: safeError(cause) }); }
        catch { /* Preserve a candidate when the atomic publication fence/reference check cannot be established. */ }
      }
      await ctx.runMutation(mutationRef('travelPrivacyArchives/fail'), { ...a, code: safeError(cause) });
    }
  },
});
function safeError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : '';
  // Do not persist parser errors or provider/storage diagnostics containing source content.
  return /^TRAVEL_PRIVACY_ARCHIVE_[A-Z_]+$/.test(message) ? message.slice('TRAVEL_PRIVACY_'.length) : 'ARCHIVE_VALIDATION_FAILED';
}
