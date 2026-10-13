import { v } from 'convex/values';
import { action, internalQuery, trackedInternalMutation, type MutationCtx, type QueryCtx } from '../maintenanceFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { mutationRef, queryRef } from './refs';
import { requireAdmin } from './security';

type Operation = Doc<'archiveUploadOperations'>;
type Checkpoint = { operationId: Id<'archiveUploadOperations'>; revision: number };
type Reserve = { producerKind: Operation['producerKind']; ownerKey: string; operationKey: string; sha256Hex: string; size: number };
const MAX_SIZE = 64 * 1024 * 1024, PAGE = 32, MAX_CANDIDATES = 100;
const MARKER = 'application/vnd.ai-town.archive-upload+json; operation=';
function fail(code: string): never { throw new Error(`ARCHIVE_UPLOAD_${code}`); }
function assert(value: unknown, code: string): asserts value { if (!value) fail(code); }
export async function archiveUploadSha256Hex(value: ArrayBuffer | Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
  return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
}
/** SHA is over exact stored bytes, not canonical/semantic JSON. */
export async function describeArchiveUpload(blob: Blob) {
  assert(Number.isSafeInteger(blob.size) && blob.size >= 0 && blob.size <= MAX_SIZE, 'SIZE_LIMIT');
  return { sha256Hex: await archiveUploadSha256Hex(await blob.arrayBuffer()), size: blob.size };
}
const hashedKey = (key: string) => archiveUploadSha256Hex(new TextEncoder().encode(key));
function shaMatches(metadata: { sha256: string }, expected: string) {
  if (metadata.sha256.toLowerCase() === expected) return true;
  const bytes = Uint8Array.from(expected.match(/../g)!, part => parseInt(part, 16));
  return metadata.sha256 === btoa(String.fromCharCode(...bytes));
}
export function archiveUploadMetadataMatches(op: Operation, row: { contentType?: string | null; sha256: string; size: number }) {
  return row.contentType === op.contentType && row.size === op.size && shaMatches(row, op.sha256Hex);
}
function reservation(op: Operation) {
  return { operationId: op._id, revision: op.revision, contentType: op.contentType, state: op.state,
    publishedStorageId: op.publishedStorageId, uploadAcknowledged: op.uploadAcknowledged };
}
async function checked(ctx: QueryCtx | MutationCtx, a: Checkpoint) {
  const op = await ctx.db.get(a.operationId);
  assert(op && op.revision === a.revision, 'CHECKPOINT_CHANGED'); return op;
}

/** Producer authorization and checkpoint validation must happen before calling this helper. Keys are hashed before persistence. */
export async function reserveArchiveUpload(ctx: MutationCtx, a: Reserve) {
  assert(typeof a.ownerKey === 'string' && a.ownerKey.length > 0 && a.ownerKey.length <= 512 &&
    typeof a.operationKey === 'string' && a.operationKey.length > 0 && a.operationKey.length <= 512, 'KEY_LIMIT');
  assert(/^[a-f0-9]{64}$/.test(a.sha256Hex) && Number.isSafeInteger(a.size) && a.size >= 0 && a.size <= MAX_SIZE, 'DESCRIPTOR_INVALID');
  const ownerKey = await hashedKey(a.ownerKey), operationKey = await hashedKey(a.operationKey);
  const prior = await ctx.db.query('archiveUploadOperations').withIndex('operation', q =>
    q.eq('producerKind', a.producerKind).eq('ownerKey', ownerKey).eq('operationKey', operationKey)).unique();
  if (prior) {
    assert(prior.sha256Hex === a.sha256Hex && prior.size === a.size, 'OPERATION_CHANGED');
    return reservation(prior);
  }
  const now = Date.now();
  const id = await ctx.db.insert('archiveUploadOperations', { producerKind: a.producerKind, ownerKey, operationKey,
    state: 'RESERVED', revision: 1, contentType: '', sha256Hex: a.sha256Hex, size: a.size, uploadAcknowledged: false,
    recoveryRevision: 0, recoveryCursor: null, recoveryPasses: 0, recoveryConflict: false, createdAt: now, updatedAt: now });
  const contentType = MARKER + await hashedKey(id);
  await ctx.db.patch(id, { contentType });
  return reservation((await ctx.db.get(id))!);
}
/** Single-start lease: never retry storage.store under the same operation. Recover it, or reserve a new attempt key. */
export async function beginArchiveUpload(ctx: MutationCtx, a: Checkpoint) {
  const op = await checked(ctx, a); assert(op.state === 'RESERVED', 'UPLOAD_ALREADY_STARTED');
  await ctx.db.patch(op._id, { state: 'UPLOADING', revision: op.revision + 1, updatedAt: Date.now() });
  return reservation((await ctx.db.get(op._id))!);
}
async function rememberCandidate(ctx: MutationCtx, op: Operation, storageId: Id<'_storage'>, discoveredBy: Doc<'archiveUploadCandidates'>['discoveredBy']) {
  const prior = await ctx.db.query('archiveUploadCandidates').withIndex('operation_storage', q =>
    q.eq('operationId', op._id).eq('storageId', storageId)).unique();
  if (prior) return prior._id;
  const candidates = await ctx.db.query('archiveUploadCandidates').withIndex('operation', q => q.eq('operationId', op._id)).take(MAX_CANDIDATES + 1);
  assert(candidates.length < MAX_CANDIDATES, 'CANDIDATE_BUDGET');
  return ctx.db.insert('archiveUploadCandidates', { operationId: op._id, storageId, state: 'STORED', discoveredBy, createdAt: Date.now() });
}
export async function confirmArchiveUploadCandidate(ctx: MutationCtx, a: Checkpoint & { storageId: Id<'_storage'> }) {
  const op = await checked(ctx, a); assert(['UPLOADING', 'UPLOADED'].includes(op.state), 'NOT_UPLOADING');
  const metadata = await ctx.db.system.get(a.storageId); assert(metadata && archiveUploadMetadataMatches(op, metadata), 'METADATA_MISMATCH');
  const candidateId = await rememberCandidate(ctx, op, a.storageId, 'ACKNOWLEDGED_UPLOAD');
  await ctx.db.patch(op._id, { state: 'UPLOADED', uploadAcknowledged: true, updatedAt: Date.now() });
  return candidateId;
}
export async function assertArchiveUploadPublishable(ctx: MutationCtx, a: Checkpoint & { storageId: Id<'_storage'> }) {
  const op = await checked(ctx, a); assert(['UPLOADING', 'UPLOADED'].includes(op.state), 'NOT_PUBLISHABLE');
  const candidate = await ctx.db.query('archiveUploadCandidates').withIndex('operation_storage', q =>
    q.eq('operationId', op._id).eq('storageId', a.storageId)).unique();
  const metadata = await ctx.db.system.get(a.storageId);
  assert(candidate?.state === 'STORED' && metadata && archiveUploadMetadataMatches(op, metadata), 'CANDIDATE_NOT_VERIFIED');
  return { op, candidate };
}
/** Must run in the SAME mutation as the producer's canonical pointer writes. Not an independent publication acknowledgement. */
export async function markArchiveUploadPublished(ctx: MutationCtx, a: Checkpoint & { storageId: Id<'_storage'>;
  publication: { table: string; rowId: string; field: string } }) {
  const { op, candidate } = await assertArchiveUploadPublishable(ctx, a);
  for (const value of Object.values(a.publication)) assert(/^[A-Za-z0-9_.:/-]{1,160}$/.test(value), 'PUBLICATION_REF_INVALID');
  await ctx.db.patch(candidate._id, { state: 'PUBLISHED' });
  await ctx.db.patch(op._id, { state: 'PUBLISHED', publishedStorageId: a.storageId, publication: a.publication,
    revision: op.revision + 1, updatedAt: Date.now() });
  return reservation((await ctx.db.get(op._id))!);
}
/** This fence commits before cleanup. A publication with any older revision can no longer commit. */
export async function retireArchiveUpload(ctx: MutationCtx, a: Checkpoint & { reasonCode: string }) {
  const op = await checked(ctx, a); assert(op.state !== 'CLEANED', 'ALREADY_CLEANED');
  assert(/^[A-Z_]{1,64}$/.test(a.reasonCode), 'REASON_INVALID');
  if (op.state === 'RETIRED') return reservation(op);
  await ctx.db.patch(op._id, { state: 'RETIRED', revision: op.revision + 1, reasonCode: a.reasonCode,
    retiredAt: Date.now(), updatedAt: Date.now() });
  return reservation((await ctx.db.get(op._id))!);
}
/** Caller must prove ALL possible upload invocations are terminal, not merely that a parent job was cancelled. */
export async function confirmArchiveUploadProducerTerminal(ctx: MutationCtx, a: Checkpoint,
  proveTerminal: (ctx: MutationCtx, op: Operation) => Promise<void>) {
  const op = await checked(ctx, a); assert(op.state === 'RETIRED', 'NOT_RETIRED'); await proveTerminal(ctx, op);
  if (op.producerTerminalAt === undefined) await ctx.db.patch(op._id, { producerTerminalAt: Date.now(), updatedAt: Date.now() });
}

/** Only named source-evidence pointers are historical. Every other nested storage pointer needs a strong-reference proof. */
export function archiveStorageReferenceKind(path: string): 'HISTORICAL_EVIDENCE' | 'STRONG_OR_UNKNOWN' {
  return ['archiveSourceEvidence.originalStorageId', 'sourceEvidence.originalStorageId', 'sourceEvidence.manifestStorageId',
    'metadata.archiveSourceEvidence.originalStorageId', 'metadata.sourceEvidence.manifestStorageId'].includes(path)
    ? 'HISTORICAL_EVIDENCE' : 'STRONG_OR_UNKNOWN';
}
/** Indexed canonical references only; the deletion helper additionally checks nested archive rows and writer journals. */
export async function assertIndexedArchiveStorageReferencesAbsent(ctx: MutationCtx, storageId: Id<'_storage'>, ownOperationId: Id<'archiveUploadOperations'>) {
  assert(!await ctx.db.query('backupImports').withIndex('vectorArchiveStorage', q => q.eq('manifest.vectorArchiveStorageId', storageId)).first() &&
    !await ctx.db.query('backupImports').withIndex('localArchiveStorage', q => q.eq('localArchiveStorageId', storageId)).first() &&
    !await ctx.db.query('backupLargeChunks').withIndex('storage', q => q.eq('storageId', storageId)).first() &&
    !await ctx.db.query('backupPrivacyChunks').withIndex('storage', q => q.eq('storageId', storageId)).first() &&
    !await ctx.db.query('travelPrivacyChunkEvidencePages').withIndex('storage', q => q.eq('storageId', storageId)).first() &&
    !await ctx.db.query('backupLargeJobs').withIndex('manifestStorage', q => q.eq('manifestStorageId', storageId)).first() &&
    !await ctx.db.query('coldHistoryArchives').withIndex('storage', q => q.eq('storageId', storageId)).first() &&
    !await ctx.db.query('coldHistoryChunks').withIndex('storage', q => q.eq('storageId', storageId)).first() &&
    !await ctx.db.query('music').withIndex('storage', q => q.eq('storageId', storageId)).first(), 'STRONG_REFERENCE');
  const otherCandidate = await ctx.db.query('archiveUploadCandidates').withIndex('storage', q => q.eq('storageId', storageId))
    .filter(q => q.and(q.neq(q.field('operationId'), ownOperationId), q.neq(q.field('state'), 'DELETED'))).first();
  const otherPublication = await ctx.db.query('archiveUploadOperations').withIndex('publishedStorage', q => q.eq('publishedStorageId', storageId))
    .filter(q => q.and(q.neq(q.field('_id'), ownOperationId), q.neq(q.field('state'), 'CLEANED'))).first();
  assert(!otherCandidate && !otherPublication, 'OTHER_UPLOAD_REFERENCE');
}
/** Any matching string is conservative evidence, including OLD arrays and aliases with unfamiliar names. */
export function archiveHasStrongStorageReference(value: unknown, storageId: string, path = ''): boolean {
  if (typeof value === 'string') return value === storageId && archiveStorageReferenceKind(path) !== 'HISTORICAL_EVIDENCE';
  if (Array.isArray(value)) return value.some(child => archiveHasStrongStorageReference(child, storageId, `${path}[]`));
  if (value && typeof value === 'object') return Object.entries(value).some(([key, child]) =>
    archiveHasStrongStorageReference(child, storageId, path ? `${path}.${key}` : key));
  return false;
}
/** Full bounded reads in the deletion transaction: a partial scan is never proof of absence.
 * Larger archives remain UNKNOWN until the caller supplies a separately fenced proof mechanism.
 * Original pointers in writer journals remain strong; only explicit source-evidence fields are historical.
 */
export async function assertNestedArchiveStorageReferencesAbsent(ctx: MutationCtx, storageId: Id<'_storage'>) {
  const tables = ['backupImports', 'backupLargeJobs', 'backupLargeRows', 'coldHistoryArchives',
    'coldArchiveMirrorJobs', 'travelPrivacyArchiveObjects', 'travelPrivacyChunkObjects', 'travelPrivacyChunkRows',
    'travelPrivacyChunkReplacements', 'travelPrivacyChunkManifestRewrites',
    'backupPrivacyRows', 'backupPrivacyChunks', 'travelPrivacyChunkEvidencePages'] as const;
  let bytes = 0;
  for (const table of tables) {
    const rows = await ctx.db.query(table).take(129);
    assert(rows.length <= 128, 'REFERENCE_COVERAGE_UNKNOWN');
    for (const row of rows) {
      bytes += new TextEncoder().encode(JSON.stringify(row)).length;
      assert(bytes <= 512 * 1024, 'REFERENCE_COVERAGE_UNKNOWN');
      assert(!archiveHasStrongStorageReference(row, storageId), 'STRONG_REFERENCE');
    }
  }
}
/** Additional proof must cover references outside these archive tables, including pointers inside stored manifests. */
export async function eraseRetiredArchiveUploadCandidate(ctx: MutationCtx, a: Checkpoint & { candidateId: Id<'archiveUploadCandidates'> },
  proveAdditionalReferencesAbsent: (ctx: MutationCtx, storageId: Id<'_storage'>) => Promise<void>) {
  const op = await checked(ctx, a); assert(op.state === 'RETIRED', 'NOT_RETIRED');
  assert(op.producerTerminalAt !== undefined, 'UPLOAD_COVERAGE_UNKNOWN');
  const candidate = await ctx.db.get(a.candidateId); assert(candidate && candidate.operationId === op._id, 'CANDIDATE_CHANGED');
  if (candidate.state === 'DELETED') return false;
  const metadata = await ctx.db.system.get(candidate.storageId);
  assert(!metadata || archiveUploadMetadataMatches(op, metadata), 'METADATA_MISMATCH');
  await assertIndexedArchiveStorageReferencesAbsent(ctx, candidate.storageId, op._id);
  await assertNestedArchiveStorageReferencesAbsent(ctx, candidate.storageId);
  await proveAdditionalReferencesAbsent(ctx, candidate.storageId);
  if (metadata) await ctx.storage.delete(candidate.storageId);
  assert(!await ctx.db.system.get(candidate.storageId), 'DELETE_NOT_CONFIRMED');
  await ctx.db.patch(candidate._id, { state: 'DELETED', deletedAt: Date.now() }); return true;
}
/** A scan window alone never closes an unknown upload. Terminal proof plus a later full window is mandatory. */
export async function completeArchiveUploadRetirement(ctx: MutationCtx, a: Checkpoint) {
  const op = await checked(ctx, a); assert(op.state === 'RETIRED', 'NOT_RETIRED');
  assert(op.producerTerminalAt !== undefined && op.recoveryCompleteCutoff !== undefined &&
    op.recoveryCompleteCutoff > op.producerTerminalAt && op.recoveryCutoff === undefined && !op.recoveryConflict, 'UPLOAD_COVERAGE_UNKNOWN');
  const candidates = await ctx.db.query('archiveUploadCandidates').withIndex('operation', q => q.eq('operationId', op._id)).take(MAX_CANDIDATES + 1);
  assert(candidates.length <= MAX_CANDIDATES && candidates.every(candidate => candidate.state === 'DELETED'), 'CANDIDATES_REMAIN');
  await ctx.db.patch(op._id, { state: 'CLEANED', revision: op.revision + 1, cleanedAt: Date.now(), updatedAt: Date.now() });
}

const checkpoint = { operationId: v.id('archiveUploadOperations'), revision: v.number() };
export async function beginArchiveUploadRecovery(ctx: MutationCtx, a: Checkpoint) {
  const op = await checked(ctx, a); assert(op.state !== 'CLEANED', 'ALREADY_CLEANED');
  if (op.recoveryCutoff === undefined) await ctx.db.patch(op._id, { recoveryCutoff: Date.now(), recoveryCursor: null,
    recoveryRevision: op.recoveryRevision + 1, updatedAt: Date.now() });
  const next = (await ctx.db.get(op._id))!;
  return { ...reservation(next), recoveryRevision: next.recoveryRevision, cursor: next.recoveryCursor, cutoff: next.recoveryCutoff! };
}
export const recoveryBegin = trackedInternalMutation({ args: checkpoint, handler: beginArchiveUploadRecovery });
export const recoveryRead = internalQuery({ args: { ...checkpoint, recoveryRevision: v.number() }, handler: async (ctx, a) => {
  const op = await checked(ctx, a); assert(op.recoveryRevision === a.recoveryRevision && op.recoveryCutoff !== undefined, 'RECOVERY_CHANGED');
  const page = await ctx.db.system.query('_storage').filter(q => q.lte(q.field('_creationTime'), op.recoveryCutoff!))
    .paginate({ cursor: op.recoveryCursor, numItems: PAGE, maximumRowsRead: PAGE * 2, maximumBytesRead: 64 * 1024 });
  const owned = page.page.filter(row => row.contentType === op.contentType);
  return { cursor: op.recoveryCursor, continueCursor: page.continueCursor, done: page.isDone, scanned: page.page.length,
    storageIds: owned.filter(row => archiveUploadMetadataMatches(op, row)).map(row => row._id), conflict: owned.some(row => !archiveUploadMetadataMatches(op, row)) };
} });
type RecoverySave = Checkpoint & { recoveryRevision: number; expectedCursor: string | null; cursor: string;
  done: boolean; storageIds: Id<'_storage'>[]; conflict: boolean };
export async function saveArchiveUploadRecovery(ctx: MutationCtx, a: RecoverySave) {
  const op = await checked(ctx, a);
  if (op.state === 'CLEANED' || op.recoveryRevision !== a.recoveryRevision || op.recoveryCursor !== a.expectedCursor || op.recoveryCutoff === undefined) return false;
  assert(a.storageIds.length <= PAGE, 'RECOVERY_PAGE_BUDGET');
  for (const storageId of a.storageIds) {
    const metadata = await ctx.db.system.get(storageId); assert(metadata && archiveUploadMetadataMatches(op, metadata), 'METADATA_MISMATCH');
    await rememberCandidate(ctx, op, storageId, 'METADATA_RECOVERY');
  }
  await ctx.db.patch(op._id, { recoveryCursor: a.done ? null : a.cursor, recoveryRevision: op.recoveryRevision + 1,
    recoveryConflict: op.recoveryConflict || a.conflict,
    ...(a.done ? { recoveryCompleteCutoff: op.recoveryCutoff, recoveryCutoff: undefined, recoveryPasses: op.recoveryPasses + 1 } : {}), updatedAt: Date.now() });
  return true;
}
export const recoverySave = trackedInternalMutation({ args: { ...checkpoint, recoveryRevision: v.number(), expectedCursor: v.union(v.string(), v.null()),
  cursor: v.string(), done: v.boolean(), storageIds: v.array(v.id('_storage')), conflict: v.boolean() }, handler: saveArchiveUploadRecovery });


/** One bounded page per call; callers schedule further pages/windows and retain UNKNOWN until terminal proof. */
export const recoverPage = action({ args: { ...checkpoint, adminToken: v.string() }, handler: async (ctx, a) => {
  requireAdmin(a.adminToken);
  const token = await ctx.runMutation(mutationRef('archiveUploadProvenance/recoveryBegin'), { operationId: a.operationId, revision: a.revision });
  const page = await ctx.runQuery(queryRef('archiveUploadProvenance/recoveryRead'), { operationId: a.operationId, revision: a.revision, recoveryRevision: token.recoveryRevision });
  const saved = await ctx.runMutation(mutationRef('archiveUploadProvenance/recoverySave'), { operationId: a.operationId, revision: a.revision,
    recoveryRevision: token.recoveryRevision, expectedCursor: page.cursor, cursor: page.continueCursor, done: page.done, storageIds: page.storageIds, conflict: page.conflict });
  return { saved, windowComplete: saved && page.done, discovered: page.storageIds.length, scanned: page.scanned,
    conflict: page.conflict, cutoff: token.cutoff, coverage: 'WINDOW_ONLY' as const };
} });
