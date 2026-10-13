import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery, type QueryCtx, type MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { archiveReferenceRevisionKey, archiveReferenceTables, dataRevision } from '../models/embeddingDataRevision';
import { archiveUploadSha256Hex, archiveUploadMetadataMatches, archiveStorageReferenceKind } from './archiveUploadProvenance';
import { mutationRef, queryRef } from './refs';
import { toBase64 } from './security';

/* Integration contract:
 * 1. After all aliases/manifests publish, start(rewriteId, exact revision). Drive TARGETS, ROWS, BLOBS, finish.
 * 2. In eraseOriginal's single transaction, call assertPagedReferenceProofAbsent BEFORE any reference write.
 *    Preserve final writer alias, provenance, producer and replacement-byte metadata checks.
 * 3. This module deliberately exposes no generic epoch refresh. Continuing the same proof after deletion
 *    requires an audited writer transaction that changes ONLY current candidate PUBLISHED->DELETED,
 *    qualified prior op PUBLISHED->RETIRED + terminal acknowledgement, and its candidate ->DELETED.
 *    No pointer, arbitrary metadata, alias or publication may be added/changed by that transaction.
 *    Count these exact tracked reference writes and require final epoch === pinned epoch + that count;
 *    in the SAME transaction update proof.referenceRevision and proof.rewriteRevision after writer advance.
 *    Convex transaction conflicts retry the entry epoch check, invalidating any concurrent source change.
 *    Until this audited integration exists, a changed epoch/rewrite revision ALWAYS requires a new proof.
 * 4. Retirements are classification evidence only: no upload is deleted, CLEANED or retired here.
 *    Closing retirement still needs the provenance module's post-terminal full recovery window.
 * 5. Global unjournaled storage or foreign binary uploads are outside this registered-source proof.
 *    This module never authorizes orphan payload cleanup or claims the 40k/2GB workload completed.
 *    A physical object is bounded at 10 MiB (chunks 900KB, ordinary 5MiB); it is reread per leaf page.
 *    Generic provenance permits larger uploads; these deliberately remain UNKNOWN without streaming.
 *    These caps do not prove runtime memory use or large-workload liveness.
 */
const LEAF_PAGE = 32;
// Larger registered generic uploads are UNKNOWN until a streaming scanner exists.
const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
// Replacements precede upload journals so confirmed former publications can be classified.
export const referenceSourceTables = [
  ...archiveReferenceTables.filter(t => !['archiveUploadOperations', 'archiveUploadCandidates'].includes(t)),
  'archiveUploadOperations', 'archiveUploadCandidates',
] as const;
type DB = QueryCtx | MutationCtx;
type Proof = Doc<'travelPrivacyChunkReferenceProofs'>;
type Leaf = { storageId: Id<'_storage'>; path: string };
type PhysicalLeaf = Leaf & { maxBytes: number };
function requireProof(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
/** Decodes string-transport records recursively. Unknown field names remain conservative references. */
export function storageLeaves(value: unknown, normalize: (id: string) => Id<'_storage'> | null, path = '', result: Leaf[] = [], depth = 0): Leaf[] {
  requireProof(depth <= 100, 'REFERENCE_NESTING_UNKNOWN');
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) {
      let decoded: unknown;
      try { decoded = JSON.parse(value); } catch { decoded = undefined; }
      if (decoded !== undefined) {
        storageLeaves(decoded, normalize, path, result, depth + 1);
        return result;
      }
    }
    const id = normalize(value);
    if (id) result.push({ storageId: id, path });
  } else if (Array.isArray(value)) {
    for (const child of value) storageLeaves(child, normalize, `${path}[]`, result, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) storageLeaves(child, normalize, path ? `${path}.${key}` : key, result, depth + 1);
  }
  return result;
}
/** Only records with explicit archive table semantics declare physical roots.
 * Literal IDs in messages, audio references and arbitrary metadata remain edges only.
 * String-transport records and legacy object records have identical ownership semantics.
 */
export function nestedArchiveRoots(value: unknown, table?: string, path = '', result: PhysicalLeaf[] = [], depth = 0): PhysicalLeaf[] {
  requireProof(depth <= 100, 'REFERENCE_NESTING_UNKNOWN');
  if (table && !['backupImports', 'backupLargeJobs', 'backupLargeChunks', 'coldHistoryArchives', 'coldHistoryChunks'].includes(table)) table = undefined;
  if (typeof value === 'string' && /^\s*[\[{]/.test(value)) {
    let decoded: unknown;
    try { decoded = JSON.parse(value); } catch { requireProof(!table, 'REFERENCE_FORMAT_UNKNOWN'); return result; }
    return nestedArchiveRoots(decoded, table, path, result, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const child of value) nestedArchiveRoots(child, table, `${path}[]`, result, depth + 1);
    return result;
  }
  if (!value || typeof value !== 'object') {
    requireProof(!table, 'REFERENCE_FORMAT_UNKNOWN'); return result;
  }
  const row = value as Record<string, unknown>;
  if (table) {
    const fields = table === 'backupImports' ? ['localArchiveStorageId', 'manifest.vectorArchiveStorageId'] :
      table === 'backupLargeJobs' ? ['manifestStorageId'] :
      ['backupLargeChunks', 'coldHistoryArchives', 'coldHistoryChunks'].includes(table) ? ['storageId'] : [];
    for (const field of fields) {
      const id = field.split('.').reduce<unknown>((parent, key) => parent && typeof parent === 'object' ? (parent as Record<string, unknown>)[key] : undefined, row);
      if (id === undefined) {
        requireProof(!['backupLargeChunks', 'coldHistoryChunks'].includes(table), 'REFERENCE_POINTER_UNKNOWN'); continue;
      }
      requireProof(typeof id === 'string' && id.length > 0 && id.length <= 256, 'REFERENCE_POINTER_UNKNOWN');
      const maxBytes = ['backupLargeChunks', 'coldHistoryChunks'].includes(table) ? 900_000 : table === 'backupImports' ? 5 * 1024 * 1024 : MAX_OBJECT_BYTES;
      result.push({ storageId: id as Id<'_storage'>, path: path ? `${path}.${field}` : field, maxBytes });
    }
  }
  const recordTable = typeof row.table === 'string' ? row.table : undefined;
  for (const [key, child] of Object.entries(row)) {
    const childPath = path ? `${path}.${key}` : key;
    if ((key === 'sections' || key === 'dataSections') && child && typeof child === 'object' && !Array.isArray(child)) {
      for (const [section, records] of Object.entries(child)) {
        if (Array.isArray(records)) nestedArchiveRoots(records, section, `${childPath}.${section}`, result, depth + 1);
        else nestedArchiveRoots(records, undefined, `${childPath}.${section}`, result, depth + 1);
      }
    } else {
      const envelopeMetadata = key === 'metadata' && child && typeof child === 'object' && 'envelope' in child;
      const childTable = !envelopeMetadata && recordTable && (key === 'rows' || key === 'record' || key === 'payload' || key === 'metadata') ? recordTable : undefined;
      nestedArchiveRoots(child, childTable, childPath, result, depth + 1);
    }
  }
  return result;
}
async function checked(ctx: DB, proofId: Id<'travelPrivacyChunkReferenceProofs'>): Promise<Proof> {
  const proof = await ctx.db.get(proofId);
  requireProof(proof, 'REFERENCE_PROOF_MISSING');
  const rewrite = await ctx.db.get(proof.rewriteId);
  requireProof(rewrite?.revision === proof.rewriteRevision && rewrite.phase === 'DELETE', 'REFERENCE_WRITER_CHANGED');
  requireProof(await dataRevision(ctx.db, archiveReferenceRevisionKey) === proof.referenceRevision, 'REFERENCE_EPOCH_CHANGED');
  return proof;
}
const args = { proofId: v.id('travelPrivacyChunkReferenceProofs') };
export const status = internalQuery({ args, handler: (ctx, a) => checked(ctx, a.proofId) });
export const start = internalMutation({
  args: { rewriteId: v.id('travelPrivacyChunkRewrites'), revision: v.number() },
  handler: async (ctx, a) => {
    const rewrite = await ctx.db.get(a.rewriteId);
    requireProof(rewrite?.phase === 'DELETE' && rewrite.revision === a.revision, 'REFERENCE_WRITER_CHANGED');
    for (const state of ['PLANNING', 'PREPARED', 'UPLOADED', 'VERIFIED'] as const)
      requireProof(!await ctx.db.query('travelPrivacyChunkReplacements').withIndex('rewrite_state', q => q.eq('rewriteId', a.rewriteId).eq('state', state)).first(), 'REFERENCE_PUBLICATION_INCOMPLETE');
    for (const state of ['PLANNED', 'BUILDING', 'UPLOADED'] as const)
      requireProof(!await ctx.db.query('travelPrivacyChunkManifestRewrites').withIndex('rewrite_state', q => q.eq('rewriteId', a.rewriteId).eq('state', state)).first(), 'REFERENCE_PUBLICATION_INCOMPLETE');
    return ctx.db.insert('travelPrivacyChunkReferenceProofs', {
      rewriteId: a.rewriteId, rewriteRevision: a.revision,
      referenceRevision: await dataRevision(ctx.db, archiveReferenceRevisionKey), phase: 'TARGETS',
      tableIndex: 0, cursor: null, leafOffset: 0, rows: 0, targets: 0, objects: 0, bytes: 0,
    });
  },
});
export const targetPage = internalMutation({ args, handler: async (ctx, a) => {
  const p = await checked(ctx, a.proofId);
  if (p.phase !== 'TARGETS') return p.phase;
  const page = await ctx.db.query('travelPrivacyChunkReplacements').withIndex('rewrite_storage', q => q.eq('rewriteId', p.rewriteId))
    .paginate({ cursor: p.cursor, numItems: 10, maximumRowsRead: 10, maximumBytesRead: 128 * 1024 });
  let targets = p.targets;
  for (const row of page.page) {
    requireProof(['PUBLISHED', 'DELETED'].includes(row.state), 'REFERENCE_PUBLICATION_INCOMPLETE');
    if (!await ctx.db.query('travelPrivacyChunkReferenceTargets').withIndex('target', q => q.eq('proofId', p._id).eq('storageId', row.originalStorageId)).first()) {
      await ctx.db.insert('travelPrivacyChunkReferenceTargets', { proofId: p._id, storageId: row.originalStorageId }); targets++;
    }
  }
  await ctx.db.patch(p._id, { targets, cursor: page.isDone ? null : page.continueCursor, phase: page.isDone ? 'ROWS' : 'TARGETS' });
  return page.isDone ? 'ROWS' : 'TARGETS';
} });
async function superseded(ctx: DB, p: Proof, row: Doc<'travelPrivacyChunkReplacements'>) {
  if (!row.operationId || !row.replacementStorageId || row.state !== 'DELETED') return false;
  const parent = await ctx.db.get(row.rewriteId), op = await ctx.db.get(row.operationId);
  return parent?.phase === 'DONE' && op?.producerKind === 'CHUNK_PRIVACY_REPLACEMENT' && op.uploadAcknowledged &&
    op.publishedStorageId === row.replacementStorageId && ['PUBLISHED', 'RETIRED'].includes(op.state);
}
async function historical(ctx: DB, p: Proof, table: string, row: any, leaf: Leaf): Promise<boolean> {
  if (archiveStorageReferenceKind(leaf.path) === 'HISTORICAL_EVIDENCE') return true;
  const rewrite = (await ctx.db.get(p.rewriteId))!;
  if (table === 'travelPrivacyChunkObjects' && row.scanId === rewrite.scanId && leaf.path === 'originalStorageId') return true;
  if (table === 'travelPrivacyChunkReplacements') {
    if (row.rewriteId === p.rewriteId && leaf.path === 'originalStorageId') return true;
    if (leaf.path === 'replacementStorageId' && await superseded(ctx, p, row)) return true;
  }
  const operationId = table === 'archiveUploadOperations' ? row._id : table === 'archiveUploadCandidates' ? row.operationId : null;
  if (operationId && ['publishedStorageId', 'storageId'].includes(leaf.path))
    return !!await ctx.db.query('travelPrivacyChunkReferenceRetirements').withIndex('operation', q => q.eq('proofId', p._id).eq('operationId', operationId).eq('storageId', leaf.storageId)).first();
  return false;
}
function physicalPointer(table: string, path: string) {
  return (['backupImports', 'backupLargeJobs', 'backupLargeChunks', 'coldHistoryArchives', 'coldHistoryChunks'].includes(table) &&
    ['localArchiveStorageId', 'manifest.vectorArchiveStorageId', 'manifestStorageId', 'storageId'].includes(path)) ||
    (['travelPrivacyArchiveObjects', 'travelPrivacyChunkObjects', 'travelPrivacyChunkReplacements', 'travelPrivacyChunkManifestRewrites'].includes(table) &&
      ['originalStorageId', 'replacementStorageId', 'manifestStorageId', 'sourceManifestStorageId'].includes(path));
}
function producerObjectLimit(kind: string) {
  if (['LARGE_CHUNK', 'SELECTIVE_CHUNK', 'CHUNK_PRIVACY_REPLACEMENT'].includes(kind)) return 900_000;
  if (['ORDINARY_BUNDLE', 'ORDINARY_PRIVACY_REPLACEMENT'].includes(kind)) return 5 * 1024 * 1024;
  return MAX_OBJECT_BYTES;
}
async function enqueue(ctx: MutationCtx, p: Proof, id: Id<'_storage'>, maxBytes = MAX_OBJECT_BYTES) {
  const meta = await ctx.db.system.get(id);
  requireProof(meta && meta.size <= maxBytes, 'REFERENCE_OBJECT_UNKNOWN');
  if (await ctx.db.query('travelPrivacyChunkReferenceObjects').withIndex('object', q => q.eq('proofId', p._id).eq('storageId', id)).first()) return 0;
  await ctx.db.insert('travelPrivacyChunkReferenceObjects', { proofId: p._id, storageId: id, sha256: meta.sha256, size: meta.size, state: 'PENDING', leafOffset: 0 });
  return 1;
}
async function edge(ctx: MutationCtx, p: Proof, leaf: Leaf, table: string, sourceId: string, kind: 'STRONG' | 'UNKNOWN' | 'HISTORICAL') {
  if (await ctx.db.query('travelPrivacyChunkReferenceTargets').withIndex('target', q => q.eq('proofId', p._id).eq('storageId', leaf.storageId)).first())
    await ctx.db.insert('travelPrivacyChunkReferenceEdges', { proofId: p._id, targetStorageId: leaf.storageId, sourceTable: table, sourceId, kind });
}
export const rowPage = internalMutation({ args, handler: async (ctx, a) => {
  const p = await checked(ctx, a.proofId);
  if (p.phase !== 'ROWS') return p.phase;
  const table = referenceSourceTables[p.tableIndex];
  const page = await ctx.db.query(table as (typeof archiveReferenceTables)[number])
    .paginate({ cursor: p.cursor, numItems: 1, maximumRowsRead: 1, maximumBytesRead: 1024 * 1024 });
  const row = page.page[0] as any;
  let objects = p.objects;
  if (row) {
    const leaves = storageLeaves(row, id => ctx.db.system.normalizeId('_storage', id));
    const roots = nestedArchiveRoots(row);
    if (table === 'archiveUploadCandidates' && p.leafOffset === 0 && row.state !== 'DELETED') {
      const leaf = { storageId: row.storageId, path: 'storageId' };
      if (!await historical(ctx, p, table, row, leaf)) {
        const op = await ctx.db.get(row.operationId as Id<'archiveUploadOperations'>), metadata = await ctx.db.system.get(row.storageId as Id<'_storage'>);
        requireProof(op && metadata && op.contentType === 'application/vnd.ai-town.archive-upload+json; operation=' + await archiveUploadSha256Hex(new TextEncoder().encode(op._id)) && !['RESERVED', 'CLEANED'].includes(op.state) && archiveUploadMetadataMatches(op, metadata), 'REFERENCE_UPLOAD_UNKNOWN');
        objects += await enqueue(ctx, p, row.storageId, producerObjectLimit(op.producerKind));
      }
    }
    if (table === 'travelPrivacyChunkReplacements' && p.leafOffset === 0 && await superseded(ctx, p, row))
      await ctx.db.insert('travelPrivacyChunkReferenceRetirements', { proofId: p._id, operationId: row.operationId, storageId: row.replacementStorageId });
    const batch = leaves.slice(p.leafOffset, p.leafOffset + LEAF_PAGE);
    for (const leaf of batch) {
      const history = await historical(ctx, p, table, row, leaf);
      await edge(ctx, p, leaf, table, row._id, history ? 'HISTORICAL' : 'STRONG');
      if (physicalPointer(table, leaf.path) && !history) {
        // Writer original pointers are audit evidence, not declarations that a deleted file still exists.
        // Their strings still create STRONG edges above; any canonical pointer is independently mandatory.
        const auditOriginal = ['travelPrivacyArchiveObjects', 'travelPrivacyChunkObjects', 'travelPrivacyChunkReplacements'].includes(table) && leaf.path === 'originalStorageId';
        if (!auditOriginal || await ctx.db.system.get(leaf.storageId)) {
          const limit = ['backupLargeChunks', 'coldHistoryChunks', 'travelPrivacyChunkObjects', 'travelPrivacyChunkReplacements'].includes(table) ? 900_000 :
            ['backupImports', 'travelPrivacyArchiveObjects'].includes(table) ? 5 * 1024 * 1024 : MAX_OBJECT_BYTES;
          objects += await enqueue(ctx, p, leaf.storageId, limit);
        }
      }
    }
    // Roots discovered inside OLD metadata/encoded journal records share the leaf
    // checkpoint, so a row with many nested roots never enqueues them all at once.
    const rootOffset = Math.max(0, p.leafOffset - leaves.length);
    const rootBatch = roots.slice(rootOffset, rootOffset + LEAF_PAGE - batch.length);
    for (const root of rootBatch) {
      const id = ctx.db.system.normalizeId('_storage', root.storageId);
      requireProof(id, 'REFERENCE_POINTER_UNKNOWN');
      objects += await enqueue(ctx, p, id, root.maxBytes);
    }
    if (p.leafOffset + batch.length + rootBatch.length < leaves.length + roots.length) {
      await ctx.db.patch(p._id, { leafOffset: p.leafOffset + batch.length + rootBatch.length, objects }); return 'ROWS';
    }
  }
  const nextTable = page.isDone ? p.tableIndex + 1 : p.tableIndex;
  await ctx.db.patch(p._id, { rows: p.rows + (row ? 1 : 0), objects, leafOffset: 0,
    cursor: page.isDone ? null : page.continueCursor, tableIndex: nextTable,
    phase: nextTable === referenceSourceTables.length ? 'BLOBS' : 'ROWS' });
  return nextTable === referenceSourceTables.length ? 'BLOBS' : 'ROWS';
} });
export const blobData = internalQuery({ args, handler: async (ctx, a) => {
  const p = await checked(ctx, a.proofId);
  requireProof(p.phase === 'BLOBS', 'REFERENCE_PHASE');
  const object = await ctx.db.query('travelPrivacyChunkReferenceObjects').withIndex('pending', q => q.eq('proofId', p._id).eq('state', 'PENDING')).first();
  return object;
} });
// Only this action supplies blob observations to saveBlobStrings. No payload crosses into a journal.
export const blobPage = internalAction({ args, handler: async (ctx, a): Promise<boolean> => {
  const object: Doc<'travelPrivacyChunkReferenceObjects'> | null = await ctx.runQuery(queryRef('travelPrivacyChunkReferenceProof/blobData'), a);
  if (!object) return false;
  const blob = await ctx.storage.get(object.storageId);
  requireProof(blob && blob.size === object.size && blob.size <= MAX_OBJECT_BYTES, 'REFERENCE_OBJECT_CHANGED');
  const bytes = await blob.arrayBuffer();
  const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(hashBytes, b => b.toString(16).padStart(2, '0')).join('');
  requireProof(toBase64(hashBytes) === object.sha256 || hex === object.sha256.toLowerCase(), 'REFERENCE_OBJECT_CHANGED');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('REFERENCE_FORMAT_UNKNOWN'); }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const declared = (raw as { format?: unknown; manifest?: { format?: unknown } }).format ??
      (raw as { manifest?: { format?: unknown } }).manifest?.format;
    requireProof(declared === undefined || ['ai-town-backup', 'ai-town-chunks', 'ai-town-selective-archive',
      'ai-town-local-sanitized-backup', 'ai-town-local-sanitized-chunks', 'ai-town-cold-history',
      'ai-town-cold-history-chunk', 'ai-town-cold-history-part', 'ai-town-cold-history-manifest',
      'ai-town-cold-history-file'].includes(declared as string), 'REFERENCE_FORMAT_UNKNOWN');
  }
  // normalizeId is a DB operation; return candidate strings only after server-side normalization.
  const leaves: (Leaf & { maxBytes?: number })[] = [
    ...storageLeaves(raw, id => id.length <= 256 && /^[A-Za-z0-9_;:-]+$/.test(id) ? id as Id<'_storage'> : null),
    ...nestedArchiveRoots(raw),
  ];
  // The normalizer above accepts strings, so use a query to normalize and classify only this bounded slice.
  const normalized: { storageId: Id<'_storage'>; historical: boolean; maxBytes?: number }[] = await ctx.runQuery(queryRef('travelPrivacyChunkReferenceProof/normalizeBlobLeaves'), {
    ...a, values: leaves.slice(object.leafOffset, object.leafOffset + LEAF_PAGE).map(leaf => ({ storageId: leaf.storageId, historical: archiveStorageReferenceKind(leaf.path) === 'HISTORICAL_EVIDENCE', ...(leaf.maxBytes === undefined ? {} : { maxBytes: leaf.maxBytes }) })),
  });
  // Offset counts all syntactically possible IDs, including normalized nonmatches; no target is skipped.
  await ctx.runMutation(mutationRef('travelPrivacyChunkReferenceProof/saveBlobStrings'), { ...a, objectId: object._id,
    offset: object.leafOffset, total: leaves.length, scanned: Math.min(LEAF_PAGE, leaves.length - object.leafOffset), sha256: object.sha256, leaves: normalized });
  return true;
} });
export const normalizeBlobLeaves = internalQuery({ args: { ...args, values: v.array(v.object({ storageId: v.string(), historical: v.boolean(), maxBytes: v.optional(v.number()) })) }, handler: async (ctx, a) => {
  await checked(ctx, a.proofId); requireProof(a.values.length <= LEAF_PAGE, 'REFERENCE_PAGE_BUDGET');
  return a.values.flatMap(value => {
    const id = ctx.db.system.normalizeId('_storage', value.storageId);
    requireProof(value.maxBytes === undefined || id, 'REFERENCE_POINTER_UNKNOWN');
    return id ? [{ storageId: id, historical: value.historical, ...(value.maxBytes === undefined ? {} : { maxBytes: value.maxBytes }) }] : [];
  });
} });
export const saveBlobStrings = internalMutation({ args: { ...args, objectId: v.id('travelPrivacyChunkReferenceObjects'), offset: v.number(), total: v.number(), scanned: v.number(), sha256: v.string(),
  leaves: v.array(v.object({ storageId: v.id('_storage'), historical: v.boolean(), maxBytes: v.optional(v.number()) })) }, handler: async (ctx, a) => {
  const p = await checked(ctx, a.proofId), object = await ctx.db.get(a.objectId);
  requireProof(p.phase === 'BLOBS' && object?.proofId === p._id, 'REFERENCE_PHASE');
  if (object.state === 'VERIFIED' || object.leafOffset > a.offset) return false;
  requireProof(object.leafOffset === a.offset && Number.isSafeInteger(a.total) && Number.isSafeInteger(a.scanned) && a.scanned >= 0 &&
    a.scanned <= LEAF_PAGE && a.leaves.length <= a.scanned && a.offset + a.scanned <= a.total &&
    (a.scanned === LEAF_PAGE || a.offset + a.scanned === a.total), 'REFERENCE_PAGE_CHANGED');
  const meta = await ctx.db.system.get(object.storageId);
  requireProof(meta && meta.sha256 === object.sha256 && meta.size === object.size && a.sha256 === meta.sha256, 'REFERENCE_OBJECT_CHANGED');
  let objects = p.objects;
  for (const leaf of a.leaves) {
    await edge(ctx, p, { storageId: leaf.storageId, path: '' }, '_storage', object.storageId, leaf.historical ? 'HISTORICAL' : 'STRONG');
    if (leaf.maxBytes !== undefined) {
      requireProof([900_000, 5 * 1024 * 1024, MAX_OBJECT_BYTES].includes(leaf.maxBytes), 'REFERENCE_PAGE_CHANGED');
      objects += await enqueue(ctx, p, leaf.storageId, leaf.maxBytes);
    }
  }
  const done = a.offset + a.scanned === a.total;
  await ctx.db.patch(object._id, { leafOffset: a.offset + a.scanned, state: done ? 'VERIFIED' : 'PENDING' });
  await ctx.db.patch(p._id, { objects, bytes: p.bytes + (done ? object.size : 0) });
  return true;
} });
export const finish = internalMutation({ args, handler: async (ctx, a) => {
  const p = await checked(ctx, a.proofId);
  if (p.phase === 'READY') return;
  requireProof(p.phase === 'BLOBS' && p.tableIndex === referenceSourceTables.length && p.cursor === null && p.leafOffset === 0 &&
    !await ctx.db.query('travelPrivacyChunkReferenceObjects').withIndex('pending', q => q.eq('proofId', p._id).eq('state', 'PENDING')).first(), 'REFERENCE_COVERAGE_INCOMPLETE');
  await ctx.db.patch(p._id, { phase: 'READY' });
} });
/** Call in the SAME mutation as final alias/metadata checks and deletion, before any source write. */
export async function assertPagedReferenceProofAbsent(ctx: DB, proofId: Id<'travelPrivacyChunkReferenceProofs'>, rewriteId: Id<'travelPrivacyChunkRewrites'>, storageId: Id<'_storage'>) {
  const p = await checked(ctx, proofId);
  requireProof(p.phase === 'READY' && p.rewriteId === rewriteId &&
    await ctx.db.query('travelPrivacyChunkReferenceTargets').withIndex('target', q => q.eq('proofId', p._id).eq('storageId', storageId)).first(), 'REFERENCE_TARGET_NOT_PROVEN');
  for (const kind of ['STRONG', 'UNKNOWN'] as const)
    requireProof(!await ctx.db.query('travelPrivacyChunkReferenceEdges').withIndex('target_kind', q => q.eq('proofId', p._id).eq('targetStorageId', storageId).eq('kind', kind)).first(), 'STRONG_REFERENCE');
  return p;
}
