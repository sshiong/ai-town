import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import type { MutationCtx } from '../_generated/server';
import {
  archiveHasStrongStorageReference, archiveStorageReferenceKind, assertArchiveUploadPublishable,
  beginArchiveUpload, completeArchiveUploadRetirement, confirmArchiveUploadCandidate,
  confirmArchiveUploadProducerTerminal, describeArchiveUpload, eraseRetiredArchiveUploadCandidate,
  markArchiveUploadPublished, reserveArchiveUpload, retireArchiveUpload, assertNestedArchiveStorageReferencesAbsent,
} from './archiveUploadProvenance';

beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/archiveUploadProvenance.ts': () => import('./archiveUploadProvenance'),
};
const noAdditionalReferences = async () => {};
async function fixture() {
  const t = convexTest(schema, modules);
  const source = new Blob(['{"archive":true}'], { type: 'application/json' });
  const descriptor = await describeArchiveUpload(source);
  const args = { producerKind: 'LARGE_CHUNK' as const, ownerKey: 'owner:secret', operationKey: 'attempt:1', ...descriptor };
  const reserved = await t.run(ctx => reserveArchiveUpload(ctx, args));
  const lease = await t.run(ctx => beginArchiveUpload(ctx, reserved));
  const storageId = await t.run(ctx => ctx.storage.store(new Blob([source], { type: lease.contentType })));
  // convex-test 0.0.60 omits Blob.type in _storage; fill only the missing emulator metadata.
  await t.run(ctx => ctx.db.patch(storageId as never, { contentType: lease.contentType } as never));
  return { t, source, descriptor, args, reserved, lease, storageId };
}
// The emulator advances _creationTime monotonically beyond wall-clock within one millisecond.
// Start the test recovery window after the actual last storage creation timestamp.
async function beginRecovery(t: ReturnType<typeof convexTest>, checkpoint: { operationId: string; revision: number }) {
  const last = await t.run(ctx => ctx.db.system.query('_storage').order('desc').first());
  const now = jest.spyOn(Date, 'now').mockReturnValue(Math.max(Date.now(), Math.ceil(last?._creationTime ?? 0) + 1));
  try {
    return await t.mutation(makeFunctionReference<'mutation'>('federation/archiveUploadProvenance:recoveryBegin'), checkpoint);
  } finally { now.mockRestore(); }
}
async function retiredFixture() {
  const f = await fixture();
  const candidateId = await f.t.run(ctx => confirmArchiveUploadCandidate(ctx, { ...f.lease, storageId: f.storageId }));
  const retired = await f.t.run(ctx => retireArchiveUpload(ctx, { ...f.lease, reasonCode: 'TEST_ABORT' }));
  await f.t.run(ctx => confirmArchiveUploadProducerTerminal(ctx, retired, noAdditionalReferences));
  return { ...f, retired, candidateId };
}

test('reservation hashes keys, binds exact bytes and starts only one upload lease', async () => {
  const f = await fixture();
  const row = await f.t.run(ctx => ctx.db.get(f.lease.operationId));
  expect(row!.ownerKey).toMatch(/^[a-f0-9]{64}$/);
  expect(row!.operationKey).not.toContain('attempt');
  expect(f.lease.revision).toBe(f.reserved.revision + 1);
  expect(f.lease.contentType).toMatch(/^application\/vnd.ai-town.archive-upload\+json; operation=[a-f0-9]{64}$/);
  await expect(f.t.run(ctx => beginArchiveUpload(ctx, f.lease))).rejects.toThrow('UPLOAD_ALREADY_STARTED');
  await expect(f.t.run(ctx => beginArchiveUpload(ctx, f.reserved))).rejects.toThrow('CHECKPOINT_CHANGED');
  expect(await f.t.run(ctx => reserveArchiveUpload(ctx, f.args))).toEqual(f.lease);
  await expect(f.t.run(ctx => reserveArchiveUpload(ctx, { ...f.args, size: f.args.size + 1 })))
    .rejects.toThrow('OPERATION_CHANGED');
});

test('confirmation validates contentType, size and exact-byte SHA in Base64 or hex', async () => {
  const f = await fixture();
  const metadata = await f.t.run(ctx => ctx.db.system.get(f.storageId));
  // Convex production _storage.sha256 is Base64; the emulator also validates the actual stored bytes.
  expect(metadata!.sha256).toBe(Buffer.from(f.descriptor.sha256Hex, 'hex').toString('base64'));
  await f.t.run(ctx => confirmArchiveUploadCandidate(ctx, { ...f.lease, storageId: f.storageId }));
  await f.t.run(async ctx => {
    const withMetadata = (overrides: Record<string, unknown>) => ({ ...ctx, db: { ...ctx.db,
      system: { ...ctx.db.system, get: async () => ({ ...metadata, ...overrides }) } } }) as MutationCtx;
    await confirmArchiveUploadCandidate(withMetadata({ sha256: f.descriptor.sha256Hex }), { ...f.lease, storageId: f.storageId });
    for (const overrides of [{ sha256: '0'.repeat(64) }, { size: f.descriptor.size + 1 }, { contentType: 'application/json' }]) {
      await expect(confirmArchiveUploadCandidate(withMetadata(overrides), { ...f.lease, storageId: f.storageId }))
        .rejects.toThrow('METADATA_MISMATCH');
    }
  });
  expect(await f.t.run(ctx => ctx.db.query('archiveUploadCandidates').collect())).toHaveLength(1);
});

test('publication requires a verified candidate and rolls back with canonical pointer transaction', async () => {
  const f = await fixture();
  await expect(f.t.run(ctx => assertArchiveUploadPublishable(ctx, { ...f.lease, storageId: f.storageId })))
    .rejects.toThrow('CANDIDATE_NOT_VERIFIED');
  await f.t.run(ctx => confirmArchiveUploadCandidate(ctx, { ...f.lease, storageId: f.storageId }));
  await expect(f.t.run(async ctx => {
    await ctx.db.insert('music', { type: 'background', storageId: f.storageId });
    await markArchiveUploadPublished(ctx, { ...f.lease, storageId: f.storageId,
      publication: { table: 'music', rowId: 'example', field: 'storageId' } });
    throw new Error('CANONICAL_WRITE_FAILED');
  })).rejects.toThrow('CANONICAL_WRITE_FAILED');
  expect(await f.t.run(ctx => ctx.db.query('music').collect())).toHaveLength(0);
  expect((await f.t.run(ctx => ctx.db.get(f.lease.operationId)))!.state).toBe('UPLOADED');
  const published = await f.t.run(ctx => markArchiveUploadPublished(ctx, { ...f.lease, storageId: f.storageId,
    publication: { table: 'backupLargeChunks', rowId: 'example', field: 'storageId' } }));
  expect(published.state).toBe('PUBLISHED');
  expect(published.revision).toBe(f.lease.revision + 1);
  const retry = await f.t.run(ctx => reserveArchiveUpload(ctx, f.args));
  expect(retry).toEqual(published);
  await expect(f.t.run(ctx => beginArchiveUpload(ctx, retry))).rejects.toThrow('UPLOAD_ALREADY_STARTED');
  await expect(f.t.run(ctx => assertArchiveUploadPublishable(ctx, { ...f.lease, storageId: f.storageId })))
    .rejects.toThrow('CHECKPOINT_CHANGED');
});

test('retirement fences stale publication and deletion requires terminal proof', async () => {
  const f = await fixture();
  const candidateId = await f.t.run(ctx => confirmArchiveUploadCandidate(ctx, { ...f.lease, storageId: f.storageId }));
  const retired = await f.t.run(ctx => retireArchiveUpload(ctx, { ...f.lease, reasonCode: 'CANCELLED' }));
  await expect(f.t.run(ctx => assertArchiveUploadPublishable(ctx, { ...f.lease, storageId: f.storageId })))
    .rejects.toThrow('CHECKPOINT_CHANGED');
  await expect(f.t.run(ctx => eraseRetiredArchiveUploadCandidate(ctx, { ...retired, candidateId }, noAdditionalReferences)))
    .rejects.toThrow('UPLOAD_COVERAGE_UNKNOWN');
  await expect(f.t.run(ctx => confirmArchiveUploadProducerTerminal(ctx, retired, async () => { throw new Error('STILL_RUNNING'); })))
    .rejects.toThrow('STILL_RUNNING');
  expect((await f.t.run(ctx => ctx.db.get(retired.operationId)))!.producerTerminalAt).toBeUndefined();
});

test('nested OLD aliases are strong and only explicit source-evidence paths are historical', () => {
  const id = 'storage:one';
  expect(archiveStorageReferenceKind('archiveSourceEvidence.originalStorageId')).toBe('HISTORICAL_EVIDENCE');
  expect(archiveHasStrongStorageReference({ archiveSourceEvidence: { originalStorageId: id } }, id)).toBe(false);
  for (const value of [ { metadata: { OLD: [{ alias: id }] } }, { sourceEvidence: { unknownStorageId: id } },
    { sourceEvidence: { manifestStorageId: [id] } }, { replacementStorageId: id }, { metadata: { sourceEvidence: { originalStorageId: id } } } ]) {
    expect(archiveHasStrongStorageReference(value, id)).toBe(true);
  }
});

test('cleanup protects nested OLD metadata and extra references before deleting', async () => {
  const f = await retiredFixture();
  const importId = await f.t.run(ctx => ctx.db.insert('backupImports', { sourceTownId: 'test', mode: 'test',
    exportedAt: 0, importedAt: 0, mapping: {}, runtimeSnapshot: {}, manifest: { OLD: [{ alias: f.storageId }] } }));
  await expect(f.t.run(ctx => eraseRetiredArchiveUploadCandidate(ctx, { ...f.retired, candidateId: f.candidateId }, noAdditionalReferences)))
    .rejects.toThrow('STRONG_REFERENCE');
  await f.t.run(ctx => ctx.db.patch(importId, { manifest: {}, archiveSourceEvidence: {
    originalStorageId: f.storageId, originalDigest: 'history', manifest: {}, signature: 'sig', sourcePublicKey: 'key' } }));
  await expect(f.t.run(ctx => eraseRetiredArchiveUploadCandidate(ctx, { ...f.retired, candidateId: f.candidateId }, async () => { throw new Error('EXTRA_REFERENCE'); })))
    .rejects.toThrow('EXTRA_REFERENCE');
  expect(await f.t.run(async ctx => !!await ctx.storage.get(f.storageId))).toBe(true);
  expect(await f.t.run(ctx => eraseRetiredArchiveUploadCandidate(ctx, { ...f.retired, candidateId: f.candidateId }, noAdditionalReferences))).toBe(true);
  expect(await f.t.run(async ctx => !!await ctx.storage.get(f.storageId))).toBe(false);
  expect(await f.t.run(ctx => eraseRetiredArchiveUploadCandidate(ctx, { ...f.retired, candidateId: f.candidateId }, noAdditionalReferences))).toBe(false);
});

test('reference checks cannot hide a later live candidate behind deleted candidates', async () => {
  const f = await retiredFixture();
  const other = await f.t.run(ctx => reserveArchiveUpload(ctx, { ...f.args, operationKey: 'another' }));
  await f.t.run(async ctx => {
    for (let i = 0; i < 2; i++) await ctx.db.insert('archiveUploadCandidates', { operationId: other.operationId,
      storageId: f.storageId, state: 'DELETED', discoveredBy: 'METADATA_RECOVERY', createdAt: i });
    await ctx.db.insert('archiveUploadCandidates', { operationId: other.operationId, storageId: f.storageId,
      state: 'STORED', discoveredBy: 'METADATA_RECOVERY', createdAt: 2 });
  });
  await expect(f.t.run(ctx => eraseRetiredArchiveUploadCandidate(ctx, { ...f.retired, candidateId: f.candidateId }, noAdditionalReferences)))
    .rejects.toThrow('OTHER_UPLOAD_REFERENCE');
});

test('oversized nested reference scans fail closed instead of treating a prefix as absence', async () => {
  const f = await retiredFixture();
  await f.t.run(async ctx => {
    for (let i = 0; i < 129; i++) await ctx.db.insert('backupImports', { sourceTownId: 'test', mode: 'test', exportedAt: 0,
      importedAt: 0, mapping: {}, runtimeSnapshot: {}, manifest: i === 128 ? { OLD: f.storageId } : {} });
  });
  await expect(f.t.run(ctx => eraseRetiredArchiveUploadCandidate(ctx, { ...f.retired, candidateId: f.candidateId }, noAdditionalReferences)))
    .rejects.toThrow('REFERENCE_COVERAGE_UNKNOWN');
});

test('bounded recovery discovers lost acknowledgement only through the reserved marker and exact bytes', async () => {
  const f = await fixture();
  const unrelated = await f.t.run(ctx => ctx.storage.store(new Blob([f.source], { type: 'application/json' })));
  const token = await beginRecovery(f.t, { operationId: f.lease.operationId, revision: f.lease.revision });
  const page = await f.t.query(makeFunctionReference<'query'>('federation/archiveUploadProvenance:recoveryRead'), {
    operationId: f.lease.operationId, revision: f.lease.revision, recoveryRevision: token.recoveryRevision });
  expect(page.storageIds).toEqual([f.storageId]);
  expect(page.storageIds).not.toContain(unrelated);
  const save = { operationId: f.lease.operationId, revision: f.lease.revision, recoveryRevision: token.recoveryRevision,
    expectedCursor: page.cursor, cursor: page.continueCursor, done: page.done, storageIds: page.storageIds, conflict: page.conflict };
  expect(await f.t.mutation(makeFunctionReference<'mutation'>('federation/archiveUploadProvenance:recoverySave'), save)).toBe(true);
  expect(await f.t.mutation(makeFunctionReference<'mutation'>('federation/archiveUploadProvenance:recoverySave'), save)).toBe(false);
  const retired = await f.t.run(ctx => retireArchiveUpload(ctx, { ...f.lease, reasonCode: 'ABORTED' }));
  await expect(f.t.run(ctx => completeArchiveUploadRetirement(ctx, retired))).rejects.toThrow('UPLOAD_COVERAGE_UNKNOWN');
  await expect(f.t.mutation(makeFunctionReference<'mutation'>('federation/archiveUploadProvenance:recoverySave'), save))
    .rejects.toThrow('CHECKPOINT_CHANGED');
  await expect(f.t.query(makeFunctionReference<'query'>('federation/archiveUploadProvenance:recoveryRead'), {
    operationId: f.lease.operationId, revision: f.lease.revision, recoveryRevision: token.recoveryRevision }))
    .rejects.toThrow('CHECKPOINT_CHANGED');
  expect(await f.t.run(async ctx => !!await ctx.storage.get(unrelated))).toBe(true);
});


test('current privacy replacement and manifest journals are always strong references', async () => {
  for (const [table, row] of [
    ['travelPrivacyChunkReplacements', { replacementStorageId: 'storage:current', state: 'PUBLISHED' }],
    ['travelPrivacyArchiveObjects', { replacementStorageId: 'storage:current', state: 'PUBLISHED' }],
    ['travelPrivacyChunkManifestRewrites', { manifestStorageId: 'storage:current', state: 'COMPLETE' }],
  ] as const) {
    const ctx = { db: { query: (name: string) => ({ take: async () => name === table ? [row] : [] }) } } as unknown as MutationCtx;
    await expect(assertNestedArchiveStorageReferencesAbsent(ctx, 'storage:current' as never)).rejects.toThrow('STRONG_REFERENCE');
  }
});

test('cleanup completion requires a full recovery window after terminal proof and all candidates deleted', async () => {
  const f = await retiredFixture();
  const terminalAt = (await f.t.run(ctx => ctx.db.get(f.retired.operationId)))!.producerTerminalAt!;
  await f.t.run(ctx => ctx.db.patch(f.retired.operationId, { recoveryCompleteCutoff: terminalAt }));
  await expect(f.t.run(ctx => completeArchiveUploadRetirement(ctx, f.retired))).rejects.toThrow('UPLOAD_COVERAGE_UNKNOWN');
  const checkpoint = { operationId: f.retired.operationId, revision: f.retired.revision };
  const token = await beginRecovery(f.t, checkpoint);
  const page = await f.t.query(makeFunctionReference<'query'>('federation/archiveUploadProvenance:recoveryRead'), {
    ...checkpoint, recoveryRevision: token.recoveryRevision });
  await f.t.mutation(makeFunctionReference<'mutation'>('federation/archiveUploadProvenance:recoverySave'), {
    ...checkpoint, recoveryRevision: token.recoveryRevision, expectedCursor: page.cursor, cursor: page.continueCursor,
    done: page.done, storageIds: page.storageIds, conflict: page.conflict });
  await expect(f.t.run(ctx => completeArchiveUploadRetirement(ctx, f.retired))).rejects.toThrow('CANDIDATES_REMAIN');
  await f.t.run(ctx => eraseRetiredArchiveUploadCandidate(ctx, { ...f.retired, candidateId: f.candidateId }, noAdditionalReferences));
  await f.t.run(ctx => completeArchiveUploadRetirement(ctx, f.retired));
  expect((await f.t.run(ctx => ctx.db.get(f.retired.operationId)))!.state).toBe('CLEANED');
});

test('matching ownership marker with different bytes is a conflict, never a deletion candidate', async () => {
  const f = await fixture();
  const wrongId = await f.t.run(ctx => ctx.storage.store(new Blob(['wrong bytes'], { type: f.lease.contentType })));
  await f.t.run(ctx => ctx.db.patch(wrongId as never, { contentType: f.lease.contentType } as never));
  const checkpoint = { operationId: f.lease.operationId, revision: f.lease.revision };
  const token = await beginRecovery(f.t, checkpoint);
  const page = await f.t.query(makeFunctionReference<'query'>('federation/archiveUploadProvenance:recoveryRead'), {
    ...checkpoint, recoveryRevision: token.recoveryRevision });
  expect(page.conflict).toBe(true);
  expect(page.storageIds).not.toContain(wrongId);
  await f.t.mutation(makeFunctionReference<'mutation'>('federation/archiveUploadProvenance:recoverySave'), {
    ...checkpoint, recoveryRevision: token.recoveryRevision, expectedCursor: page.cursor, cursor: page.continueCursor,
    done: page.done, storageIds: page.storageIds, conflict: page.conflict });
  expect((await f.t.run(ctx => ctx.db.get(f.lease.operationId)))!.recoveryConflict).toBe(true);
  expect(await f.t.run(async ctx => !!await ctx.storage.get(wrongId))).toBe(true);
});

test.each(['canonical', 'staged'])('retired upload cleanup protects %s privacy sidecar references', async kind => {
  const f = await retiredFixture();
  const rowId = await f.t.run(async ctx => {
    const jobId = await ctx.db.insert('backupLargeJobs', { kind: 'import', state: 'STAGING', phase: 'STAGING',
      tableIndex: 0, cursor: null, chunkCount: 0, processedChunks: 0, recordCount: 0, bytes: 0,
      createdAt: 1, updatedAt: 1, source: {} });
    return kind === 'canonical'
      ? ctx.db.insert('backupPrivacyChunks', { jobId, pageNumber: 0, storageId: f.storageId,
        descriptor: { index: 0, table: 'travelPrivacyTombstones', count: 0, bytes: 1, digest: 'sidecar' } })
      : ctx.db.insert('backupPrivacyRows', { jobId, key: 'negative-state', row: { nestedAlias: f.storageId } });
  });
  await expect(f.t.run(ctx => eraseRetiredArchiveUploadCandidate(ctx, { ...f.retired, candidateId: f.candidateId }, noAdditionalReferences)))
    .rejects.toThrow('STRONG_REFERENCE');
  expect(await f.t.run(ctx => ctx.db.system.get(f.storageId))).not.toBeNull();
  await f.t.run(ctx => ctx.db.delete(rowId));
  await expect(f.t.run(ctx => eraseRetiredArchiveUploadCandidate(ctx, { ...f.retired, candidateId: f.candidateId }, noAdditionalReferences)))
    .resolves.toBe(true);
});
