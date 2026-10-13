import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { actionRef, mutationRef, queryRef } from './refs';
import { encodeRow, type BackupRow } from './backupHelpers';
import { descriptor } from './backupLargeHelpers';
import { digest } from './security';
import { archiveUploadSha256Hex, reserveArchiveUpload, describeArchiveUpload } from './archiveUploadProvenance';
import { assertPagedReferenceProofAbsent, storageLeaves, nestedArchiveRoots } from './travelPrivacyChunkReferenceProof';
import { archiveReferenceRevisionKey, dataRevision, withEmbeddingRevision } from '../models/embeddingDataRevision';
const modules = { '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/travelPrivacyChunkReferenceProof.ts': () => import('./travelPrivacyChunkReferenceProof'),
};
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
async function fixture(
  table = 'memories',
  rows: BackupRow[] = [
    {
      _id: 'selected',
      description: 'selected-private-prose',
      playerId: 'p:0',
      data: { type: 'travel', visitId: 'selected-visit' },
    },
    {
      _id: 'other',
      description: 'other-retained-prose',
      playerId: 'p:1',
      data: { type: 'travel', visitId: 'other-visit' },
    },
  ],
) {
  const t = convexTest(schema, modules);
  const chunk = { index: 0, table, rows: rows.map(encodeRow) },
    d = await descriptor(chunk);
  const storageId = await t.action((ctx) =>
    ctx.storage.store(new Blob([JSON.stringify(chunk)], { type: 'application/json' })),
  );
  const ids = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const jobId = await ctx.db.insert('travelPrivacyJobs', {
      visitId: 'selected-visit',
      scope: 'SENSITIVE',
      state: 'READY',
      phase: 'ARCHIVE_CHUNK_CHECK',
      tableIndex: 0,
      cursor: null,
      revision: 0,
      sourceRevision: 0,
      privacyRevision: 0,
      changed: false,
      worldId,
      role: 'home',
      ownerGlobalId: 'owner',
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
      createdAt: 1,
      updatedAt: 1,
    });
    const backupId = await ctx.db.insert('backupLargeJobs', {
      kind: 'import',
      state: 'COMPLETE',
      phase: 'COMPLETE',
      tableIndex: 0,
      cursor: null,
      chunkCount: 0,
      processedChunks: 0,
      recordCount: rows.length,
      bytes: d.bytes,
      createdAt: 1,
      updatedAt: 1,
      source: {},
    });
    const chunkId = await ctx.db.insert('backupLargeChunks', { jobId: backupId, ...d, storageId });
    const scanId = await ctx.db.insert('travelPrivacyChunkScans', {
      jobId,
      privacyRevision: 0,
      version: 1,
      revision: 0,
      phase: 'READY_TO_REWRITE',
      cursor: null,
      cutoff: 1,
      changedInPass: false,
      objects: 1,
      rows: rows.length,
      selectedRows: 1,
      blockers: 0,
      blockerCodes: [],
      sourceRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const planId = await ctx.db.insert('travelPrivacyChunkObjects', {
      scanId,
      backupJobId: backupId,
      chunkId,
      role: 'OLD',
      originalStorageId: storageId,
      originalDigest: d.digest,
      descriptor: d,
      backupDigest: await digest((await ctx.db.get(backupId))!),
      state: 'CHECKED',
      rowOffset: rows.length,
      selectedRows: 1,
      selectionDigest: 'selection',
      nextCursor: null,
      scanDone: true,
      referenceCursor: null,
      blockers: [],
      aliases: [{ table: 'backupLargeChunks', id: chunkId }],
    });
    for (const [rowIndex, row] of rows.entries()) {
      await ctx.db.insert('travelPrivacyChunkRows', {
        scanId,
        objectId: planId,
        backupJobId: backupId,
        role: 'OLD',
        selected: rowIndex === 0,
        evidence: {
          sourceId: row._id,
          table,
          rowIndex,
          relatedMemoryIds: [],
          evidenceMemoryIds: [],
          storageIds: [],
        },
      });
      await ctx.db.insert('backupLargeRows', {
        jobId: backupId,
        role: 'OLD',
        table,
        sourceId: row._id,
        chunkIndex: 0,
        rowIndex,
        state: 'SNAPSHOT',
        references: [],
        metadata: { oldPrivateCopy: row.description ?? row.payload },
      });
    }
    return { jobId, backupId, chunkId, scanId, planId };
  });
  const replacementStorageId = await t.action(ctx => ctx.storage.store(new Blob([JSON.stringify({ rows: [] })], {type: 'application/json'})));
  const rewriteId = await t.run(async ctx => {
    await ctx.db.patch(ids.chunkId, { storageId: replacementStorageId });
    const id = await ctx.db.insert('travelPrivacyChunkRewrites', {
      scanId: ids.scanId, privacyJobId: ids.jobId, expectedParentRevision: 0, revision: 7, sourceRevision: 0,
      phase: 'DELETE', cursor: null, objects: 1, published: 1, deleted: 0, createdAt: 1, updatedAt: 1,
    });
    await ctx.db.insert('travelPrivacyChunkReplacements', {
      rewriteId: id, planObjectId: ids.planId, originalStorageId: storageId, originalDescriptor: d,
      state: 'PUBLISHED', selectedIndices: [0], expectedSelectedRows: 1, planCursor: null,
      aliasIndex: 0, rowOffset: rows.length, retainedRows: 0, aliases: [], replacementStorageId,
    });
    return id;
  });
  const proofId: Id<'travelPrivacyChunkReferenceProofs'> = await t.mutation(mutationRef('travelPrivacyChunkReferenceProof/start'), { rewriteId, revision: 7 });
  return { t, ...ids, rewriteId, proofId, storageId, replacementStorageId, d };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function rows(f: Fixture) {
  await f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/targetPage'), { proofId: f.proofId });
  for (let i = 0; i < 2000; i++) {
    const phase = await f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/rowPage'), { proofId: f.proofId });
    if (phase === 'BLOBS') return;
  }
  throw new Error('test page budget exhausted');
}
async function finish(f: Fixture) {
  await rows(f);
  for (let i = 0; i < 2000; i++) {
    if (!await f.t.action(actionRef('travelPrivacyChunkReferenceProof/blobPage'), { proofId: f.proofId })) break;
  }
  await f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/finish'), { proofId: f.proofId });
}
const absent = (f: Fixture, storageId = f.storageId) => f.t.run(ctx => assertPagedReferenceProofAbsent(ctx, f.proofId, f.rewriteId, storageId));
async function oldRow(f: Fixture, metadata: unknown) {
  return f.t.run(ctx => ctx.db.insert('backupLargeRows', { jobId: f.backupId, role: 'OLD', table: 'memories',
    sourceId: 'late', chunkIndex: 1, rowIndex: 0, state: 'SNAPSHOT', references: [], metadata }));
}
test('scans >128 rows and never skips a late alias after 32 leaves', async () => {
  const f = await fixture();
  for (let i = 0; i < 140; i++) await oldRow(f, { unrelated: i });
  await oldRow(f, { values: Array(70).fill(f.replacementStorageId), finalUnknownAlias: f.storageId });
  await finish(f);
  await expect(absent(f)).rejects.toThrow('STRONG_REFERENCE');
  const proof = await f.t.run(ctx => ctx.db.get(f.proofId));
  expect(proof!.rows).toBeGreaterThan(128);
});
test('safe proof is target scoped, contains no payload, and does not bump source epoch', async () => {
  const f = await fixture();
  const before = await f.t.run(ctx => dataRevision(ctx.db, archiveReferenceRevisionKey));
  await finish(f);
  await expect(absent(f)).resolves.toMatchObject({ phase: 'READY' });
  await expect(absent(f, f.replacementStorageId)).rejects.toThrow('REFERENCE_TARGET_NOT_PROVEN');
  expect(await f.t.run(ctx => dataRevision(ctx.db, archiveReferenceRevisionKey))).toBe(before);
  const journal = await f.t.run(async ctx => [await ctx.db.query('travelPrivacyChunkReferenceEdges').collect(),
    await ctx.db.query('travelPrivacyChunkReferenceObjects').collect()]);
  expect(JSON.stringify(journal)).not.toContain('selected-private-prose');
});
test('updating an already scanned OLD row invalidates both continuation and deletion', async () => {
  const f = await fixture(); const rowId = await oldRow(f, {});
  await finish(f);
  await f.t.run(ctx => withEmbeddingRevision(ctx).db.patch(rowId, { metadata: { late: f.storageId } }));
  await expect(absent(f)).rejects.toThrow('REFERENCE_EPOCH_CHANGED');
  await expect(f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/finish'), { proofId: f.proofId })).rejects.toThrow('REFERENCE_EPOCH_CHANGED');
});
test('writer revision change invalidates a fixed reference generation', async () => {
  const f = await fixture(); await finish(f);
  await f.t.run(ctx => ctx.db.patch(f.rewriteId, { revision: 8 }));
  await expect(absent(f)).rejects.toThrow('REFERENCE_WRITER_CHANGED');
});
test('finish rejects unscanned tables and pending physical objects', async () => {
  const f = await fixture();
  await expect(f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/finish'), { proofId: f.proofId })).rejects.toThrow('REFERENCE_COVERAGE_INCOMPLETE');
  await rows(f);
  await expect(f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/finish'), { proofId: f.proofId })).rejects.toThrow('REFERENCE_COVERAGE_INCOMPLETE');
});
test('physical manifest recursively scans encoded records beyond nonmatching strings', async () => {
  const f = await fixture();
  const physical = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify({ rows: [
    ...Array.from({length: 90}, (_, i) => `nonmatching${i}`),
    encodeRow({ _id: 'foreign', unknown: { alias: f.storageId } }),
  ] })], {type: 'application/json'})));
  await f.t.run(ctx => ctx.db.patch(f.backupId, { manifestStorageId: physical }));
  await finish(f);
  await expect(absent(f)).rejects.toThrow('STRONG_REFERENCE');
  const objects = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkReferenceObjects').collect());
  expect(objects.find(o => o.storageId === physical)?.leafOffset).toBeGreaterThan(32);
});
test('all ordinary/local/vector/chunk canonical physical pointers are scanned and deduplicated', async () => {
  const f = await fixture();
  const ordinary = await f.t.action(ctx => ctx.storage.store(new Blob(['{"safe":true}'])));
  const vector = await f.t.action(ctx => ctx.storage.store(new Blob(['{"safe":true}'])));
  const local = await f.t.action(ctx => ctx.storage.store(new Blob(['{"safe":true}'])));
  const cold = await f.t.action(ctx => ctx.storage.store(new Blob(['{"cold":true}'])));
  const coldChunk = await f.t.action(ctx => ctx.storage.store(new Blob(['{"coldChunk":true}'])));
  await f.t.run(async ctx => {
    await ctx.db.patch(f.backupId, { manifestStorageId: ordinary });
    const worldId = (await ctx.db.get(f.jobId))!.worldId!;
    const coldId = await ctx.db.insert('coldHistoryArchives', { sourceKey: 'cold', worldId, kind: 'travel', sourceId: 'cold', state: 'VERIFIED',
      manifest: {}, signature: 'sig', publicKey: 'key', storageId: cold, createdAt: 1 });
    await ctx.db.insert('coldHistoryChunks', { archiveId: coldId, index: 0, start: 0, count: 0, bytes: 18, digest: 'd', previousDigest: 'p', chainDigest: 'c', signature: 'sig', storageId: coldChunk });
    await ctx.db.insert('backupImports', { sourceTownId: 'town', mode: 'resident', exportedAt: 1, importedAt: 1,
      mapping: {}, runtimeSnapshot: {}, manifest: { vectorArchiveStorageId: vector }, localArchiveStorageId: local });
  });
  await finish(f);
  const objects = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkReferenceObjects').collect());
  expect(new Set(objects.map(o => o.storageId))).toEqual(new Set([f.replacementStorageId, ordinary, vector, local, cold, coldChunk]));
  expect(objects.every(o => o.state === 'VERIFIED')).toBe(true);
});
test('blob literal valid foreign/nonarchive IDs are checked for target edges, not dereferenced as archives', async () => {
  const f = await fixture();
  const audio = await f.t.action(ctx => ctx.storage.store(new Blob(['binary-audio'])));
  const missing = await f.t.action(ctx => ctx.storage.store(new Blob(['gone'])));
  await f.t.run(ctx => ctx.storage.delete(missing));
  const physical = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify({ literal: [audio, missing] })])));
  await f.t.run(ctx => ctx.db.patch(f.backupId, { manifestStorageId: physical }));
  await finish(f);
  await expect(absent(f)).resolves.toMatchObject({ phase: 'READY' });
});
test('a dangling canonical pointer fails closed', async () => {
  const f = await fixture();
  await f.t.run(async ctx => { await ctx.db.patch(f.backupId, { manifestStorageId: f.replacementStorageId }); await ctx.storage.delete(f.replacementStorageId); });
  await expect(rows(f)).rejects.toThrow('REFERENCE_OBJECT_UNKNOWN');
});
test('recursive JSON record paths preserve exact historical allowlist and opaque aliases', () => {
  const normalize = (s: string) => s === 'target' ? s as any : null;
  const leaves = storageLeaves({ sourceEvidence: { manifestStorageId: 'target' }, x: JSON.stringify({ OLD: [{ mystery: 'target' }] }) }, normalize);
  expect(leaves.map(l => l.path)).toEqual(['sourceEvidence.manifestStorageId', 'x.OLD[].mystery']);
});
async function previousPublication(f: Fixture, acknowledged: boolean) {
  const descriptor = await f.t.action(async ctx => describeArchiveUpload((await ctx.storage.get(f.storageId))!));
  const gone = await f.t.action(ctx => ctx.storage.store(new Blob(['{"prior":"body"}'])));
  await f.t.run(async ctx => {
    await ctx.storage.delete(gone);
    const current = (await ctx.db.get(f.rewriteId))!;
    const { _id, _creationTime, ...fields } = current;
    const prior = await ctx.db.insert('travelPrivacyChunkRewrites', { ...fields, phase: 'DONE' });
    const op = await ctx.db.insert('archiveUploadOperations', {
      producerKind: 'CHUNK_PRIVACY_REPLACEMENT', ownerKey: 'prior', operationKey: 'prior', state: 'PUBLISHED',
      revision: 1, contentType: 'application/vnd.ai-town.archive-upload+json; operation=previous', ...descriptor, uploadAcknowledged: acknowledged,
      publishedStorageId: f.storageId, recoveryRevision: 0, recoveryCursor: null, recoveryConflict: false,
      recoveryPasses: 0, createdAt: 1, updatedAt: 1,
    });
    const contentType = 'application/vnd.ai-town.archive-upload+json; operation=' + await archiveUploadSha256Hex(new TextEncoder().encode(op));
    await ctx.db.patch(op, { contentType });
    await (ctx.db.patch as any)(f.storageId, { contentType });
    await ctx.db.insert('archiveUploadCandidates', { operationId: op, storageId: f.storageId,
      state: 'PUBLISHED', discoveredBy: 'ACKNOWLEDGED_UPLOAD', createdAt: 1 });
    await ctx.db.insert('travelPrivacyChunkReplacements', {
      rewriteId: prior, planObjectId: f.planId, originalStorageId: gone, originalDescriptor: f.d,
      replacementStorageId: f.storageId, operationId: op, state: 'DELETED', selectedIndices: [0],
      expectedSelectedRows: 1, planCursor: null, aliasIndex: 0, rowOffset: 1, retainedRows: 0, aliases: [],
    });
  });
}
test('second-generation proof permits only ACK+published replacement in a DONE previous session', async () => {
  const f = await fixture(); await previousPublication(f, true); await finish(f);
  await expect(absent(f)).resolves.toMatchObject({ phase: 'READY' });
  const retirements = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkReferenceRetirements').collect());
  expect(retirements).toHaveLength(1);
});
test('unknown prior upload is never exempted by a DELETED writer row alone', async () => {
  const f = await fixture(); await previousPublication(f, false); await finish(f);
  await expect(absent(f)).rejects.toThrow('STRONG_REFERENCE');
});
test.each(['base64', 'hex'])('raw-byte SHA verifies actual %s metadata representation', async representation => {
  const f = await fixture();
  const bytes = await f.t.action(async ctx => (await ctx.storage.get(f.replacementStorageId))!.arrayBuffer());
  const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const base64 = btoa(String.fromCharCode(...hashBytes));
  const hex = Array.from(hashBytes, b => b.toString(16).padStart(2, '0')).join('');
  await f.t.run(ctx => (ctx.db.patch as any)(f.replacementStorageId, { sha256: representation === 'base64' ? base64 : hex }));
  await finish(f); await expect(absent(f)).resolves.toMatchObject({ phase: 'READY' });
});
test('blob save validates cursor CAS and its successful retry is idempotent', async () => {
  const f = await fixture(); await rows(f);
  const object = await f.t.query(queryRef('travelPrivacyChunkReferenceProof/blobData'), { proofId: f.proofId });
  const save = { proofId: f.proofId, objectId: object._id, offset: 1, total: 1, scanned: 0, leaves: [], sha256: object.sha256 };
  await expect(f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/saveBlobStrings'), save)).rejects.toThrow('REFERENCE_PAGE_CHANGED');
  await f.t.action(actionRef('travelPrivacyChunkReferenceProof/blobPage'), { proofId: f.proofId });
  await expect(f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/saveBlobStrings'), { ...save, offset: 0, total: 0 })).resolves.toBe(false);
  await f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/finish'), { proofId: f.proofId });
  await f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/finish'), { proofId: f.proofId });
});
test('new tracked late alias between row scan and blob scan invalidates the generation', async () => {
  const f = await fixture(); await rows(f);
  await f.t.run(ctx => withEmbeddingRevision(ctx).db.insert('backupLargeRows', { jobId: f.backupId, role: 'OLD',
    table: 'memories', sourceId: 'new-late', chunkIndex: 1, rowIndex: 0, state: 'SNAPSHOT', references: [], metadata: { alias: f.storageId } }));
  await expect(f.t.action(actionRef('travelPrivacyChunkReferenceProof/blobPage'), { proofId: f.proofId })).rejects.toThrow('REFERENCE_EPOCH_CHANGED');
});
test('physical raw-byte SHA mismatch fails before saving reference observations', async () => {
  const f = await fixture();
  await f.t.run(ctx => (ctx.db.patch as any)(f.replacementStorageId, { sha256: '0'.repeat(64) }));
  await rows(f);
  await expect(f.t.action(actionRef('travelPrivacyChunkReferenceProof/blobPage'), { proofId: f.proofId })).rejects.toThrow('REFERENCE_OBJECT_CHANGED');
});
test('physical metadata changed between read and save rejects the page CAS', async () => {
  const f = await fixture(); await rows(f);
  const object = await f.t.query(queryRef('travelPrivacyChunkReferenceProof/blobData'), { proofId: f.proofId });
  await f.t.run(ctx => (ctx.db.patch as any)(object.storageId, { sha256: '0'.repeat(64) }));
  await expect(f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/saveBlobStrings'), {
    proofId: f.proofId, objectId: object._id, offset: 0, total: 0, scanned: 0, leaves: [], sha256: object.sha256,
  })).rejects.toThrow('REFERENCE_OBJECT_CHANGED');
});
async function pendingUpload(f: Fixture, body: string) {
  const described = await f.t.action(() => describeArchiveUpload(new Blob([body])));
  const reserved = await f.t.run(ctx => reserveArchiveUpload(ctx, { producerKind: 'ORDINARY_BUNDLE', ownerKey: 'pending', operationKey: 'pending', ...described }));
  const storageId = await f.t.action(ctx => ctx.storage.store(new Blob([body], {type: reserved.contentType})));
  await f.t.run(async ctx => {
    await (ctx.db.patch as any)(storageId, { contentType: reserved.contentType });
    await ctx.db.patch(reserved.operationId, { state: 'UPLOADED', uploadAcknowledged: true });
    await ctx.db.insert('archiveUploadCandidates', { operationId: reserved.operationId, storageId, state: 'STORED', discoveredBy: 'ACKNOWLEDGED_UPLOAD', createdAt: 1 });
  });
  return storageId;
}
test('registered pending candidate physical JSON can contain a target without a direct target pointer', async () => {
  const f = await fixture();
  const stored = await pendingUpload(f, JSON.stringify({ rows: [encodeRow({ _id: 'pending-row', unknownAlias: f.storageId })] }));
  await finish(f); await expect(absent(f)).rejects.toThrow('STRONG_REFERENCE');
  const objects = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkReferenceObjects').collect());
  expect(objects.find(o => o.storageId === stored)?.state).toBe('VERIFIED');
});
test('registered pending candidate with verified metadata and no target references is covered', async () => {
  const f = await fixture(); await pendingUpload(f, '{"safe":true}');
  await finish(f); await expect(absent(f)).resolves.toMatchObject({ phase: 'READY' });
});
test('registered pending candidate with unknown physical ownership fails closed', async () => {
  const f = await fixture(); const storage = await pendingUpload(f, '{"safe":true}');
  await f.t.run(ctx => (ctx.db.patch as any)(storage, { contentType: 'application/json' }));
  await expect(rows(f)).rejects.toThrow('REFERENCE_UPLOAD_UNKNOWN');
});
test.each(['raw', 'encoded', 'sections', 'dataSections'])('scans legacy nested physical archive roots through %s records', async encoding => {
  const f = await fixture();
  const nested = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify({ retainedAlias: f.storageId })])));
  const row = { storageId: nested };
  const body = encoding === 'raw' ? { table: 'coldHistoryArchives', rows: [row] } :
    encoding === 'encoded' ? { table: 'coldHistoryArchives', rows: [encodeRow(row)] } :
    encoding === 'sections' ? { sections: { coldHistoryChunks: [encodeRow(row)] } } :
    { dataSections: { backupImports: [encodeRow({ localArchiveStorageId: nested })] } };
  const root = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify(body)])));
  await f.t.run(ctx => ctx.db.patch(f.backupId, { manifestStorageId: root }));
  await finish(f);
  await expect(absent(f)).rejects.toThrow('STRONG_REFERENCE');
  expect((await f.t.run(ctx => ctx.db.query('travelPrivacyChunkReferenceObjects').collect())).find(o => o.storageId === nested)?.state).toBe('VERIFIED');
});
test('nested safe archive chains deduplicate repeated physical roots and page beyond 32 roots', async () => {
  const f = await fixture();
  const nested = await f.t.action(ctx => ctx.storage.store(new Blob(['{"safe":true}'])));
  const root = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify({ sections: {
    coldHistoryChunks: Array.from({ length: 70 }, () => encodeRow({ storageId: nested })),
  } })])));
  await f.t.run(ctx => ctx.db.patch(f.backupId, { manifestStorageId: root }));
  await finish(f); await expect(absent(f)).resolves.toMatchObject({ phase: 'READY' });
  const objects = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkReferenceObjects').collect());
  expect(objects.filter(o => o.storageId === nested)).toHaveLength(1);
  expect(objects.find(o => o.storageId === root)!.leafOffset).toBeGreaterThan(128);
});
test.each(['missing', 'binary', 'unknown-format', 'invalid-owner'])('nested declared archive root %s fails closed', async failure => {
  const f = await fixture();
  const nested = await f.t.action(ctx => ctx.storage.store(new Blob([failure === 'binary' ? 'binary-data' :
    failure === 'unknown-format' ? '{"format":"unsupported-archive"}' : '{"safe":true}'])));
  if (failure === 'missing') await f.t.run(ctx => ctx.storage.delete(nested));
  const root = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify({ table: 'coldHistoryChunks',
    rows: [encodeRow({ storageId: failure === 'invalid-owner' ? 'not-a-storage-id' : nested })],
  })])));
  await f.t.run(ctx => ctx.db.patch(f.backupId, { manifestStorageId: root }));
  await expect(finish(f)).rejects.toThrow(failure === 'missing' ? 'REFERENCE_OBJECT_UNKNOWN' :
    failure === 'invalid-owner' ? 'REFERENCE_POINTER_UNKNOWN' : 'REFERENCE_FORMAT_UNKNOWN');
  await expect(absent(f)).rejects.toThrow('REFERENCE_TARGET_NOT_PROVEN');
});
test('OLD row metadata follows explicit archive table ownership without dereferencing arbitrary literals', async () => {
  const f = await fixture();
  const nested = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify({ alias: f.storageId })])));
  await f.t.run(ctx => ctx.db.insert('backupLargeRows', { jobId: f.backupId, role: 'OLD', table: 'coldHistoryChunks',
    sourceId: 'old-cold', chunkIndex: 2, rowIndex: 0, state: 'SNAPSHOT', references: [], metadata: { storageId: nested } }));
  await finish(f); await expect(absent(f)).rejects.toThrow('STRONG_REFERENCE');
  expect(nestedArchiveRoots({ table: 'messages', rows: [{ text: nested }] })).toEqual([]);
});
test('a cyclic physical root observation reuses its checkpoint and finishes without re-enqueueing', async () => {
  const f = await fixture(); await rows(f);
  const object = await f.t.query(queryRef('travelPrivacyChunkReferenceProof/blobData'), { proofId: f.proofId });
  await f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/saveBlobStrings'), {
    proofId: f.proofId, objectId: object._id, offset: 0, total: 1, scanned: 1, sha256: object.sha256,
    leaves: [{ storageId: object.storageId, historical: false, maxBytes: 900_000 }],
  });
  await expect(f.t.query(queryRef('travelPrivacyChunkReferenceProof/blobData'), { proofId: f.proofId })).resolves.toBeNull();
  await f.t.mutation(mutationRef('travelPrivacyChunkReferenceProof/finish'), { proofId: f.proofId });
  expect(await f.t.run(ctx => ctx.db.query('travelPrivacyChunkReferenceObjects').collect())).toHaveLength(1);
});
