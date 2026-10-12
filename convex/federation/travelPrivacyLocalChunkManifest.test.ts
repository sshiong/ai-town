import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { encodeRow, decodeRow, type BackupRow } from './backupHelpers';
import { descriptor, largeTables, validateManifest, type LargeChunk, type LargeManifest } from './backupLargeHelpers';
import { validateSelectiveManifest, type SelectiveManifest } from './backupSelectiveHelpers';
import { canonicalJson } from './protocol';
import { digest, toBase64, verifySignature } from './security';
import { createLocalChunkManifest, createLocalArchiveProof, portableLocalChunkManifest,
  validateLocalChunkManifest, validateLocalChunk, type LocalChunkDescriptor } from './travelPrivacyLocalChunkManifest';

beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
async function signer(townId: string) {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  return { townId, publicKey, sign: async (value: unknown) => toBase64(new Uint8Array(await crypto.subtle.sign('Ed25519',
    keys.privateKey, new TextEncoder().encode(canonicalJson(value))))) };
}
async function fixture(selective = false) {
  const sourceSigner = await signer('source-town'), localSigner = await signer('local-town');
  const source: BackupRow = { _id: 'identity', _creationTime: 1, townId: sourceSigner.townId, townName: 'Fixture',
    publicKey: sourceSigner.publicKey, fingerprint: `sha256:${await digest(sourceSigner.publicKey)}`,
    deploymentInstanceId: 'source-instance', deploymentEpoch: 1, endpoint: 'https://fixture.invalid/federation/v1', enabled: false,
    allowIncomingPairRequests: false, allowUnencryptedHttp: false, allowPublicHttp: false,
    maxVisitors: 1, maxVisitDurationMs: 300_000, mode: 'ACTIVE', createdAt: 1 };
  const retained: BackupRow = { _id: 'other-world', _creationTime: 1, nextId: 1, players: [], agents: [], conversations: [] };
  const chunk = (table: string, rows: BackupRow[], index: number): LargeChunk => ({ index, table, rows: rows.map(row =>
    selective ? encodeRow({ kind: 'record', role: 'primary', record: encodeRow(row), references: [] }) : encodeRow(row)) });
  const originalChunks = (selective ? ['federationIdentity', 'worlds'] : [...largeTables]).map((table, index) =>
    chunk(table, table === 'federationIdentity' ? [source] : table === 'worlds' ? [retained] : [], index));
  const summaries = await Promise.all(originalChunks.map(descriptor));
  const manifest: LargeManifest | SelectiveManifest = selective ? {
    format: 'ai-town-selective-archive', version: 2, schemaVersion: 1, exportId: 'source-export', source, exportedAt: 1,
    scope: 'config-only', selection: { scope: 'config-only', owners: [], categories: ['configuration'], from: null, to: null,
      includePublicPeers: false, dependencyPolicy: 'same-owner-evidence-and-public-context', timePolicy: 'event-time-else-creation-time-half-open' },
    usage: 'selective-transfer', operator: 'fixture-operator', reason: 'fixture-reason', chunks: summaries,
  } : { format: 'ai-town-chunks', version: 1, schemaVersion: 1, scope: 'town', exportId: 'source-export', source,
    exportedAt: 1, chunks: summaries };
  const signature = await sourceSigner.sign(manifest);
  const sourceEvidence = { manifest, digest: await digest(manifest), signature, publicKey: sourceSigner.publicKey,
    manifestStorageId: 'source-manifest-storage' };
  const chunks: LocalChunkDescriptor[] = summaries.map(summary => ({ ...summary, role: 'EXPORT', encoding: selective ? 'SELECTIVE' : 'RAW' }));
  const local = await createLocalChunkManifest({ archiveId: 'local-export', derivedAt: 2, chunks,
    clearedVisits: ['cleared-visit'], sourceEvidence });
  return { sourceSigner, localSigner, sourceEvidence, local, originalChunks, retained };
}

test.each([false, true])('signed RAW/SELECTIVE source evidence survives independently of local proof; selective=%s', async selective => {
  const f = await fixture(selective);
  expect(await verifySignature(f.sourceEvidence.manifest, f.sourceEvidence.signature, f.sourceEvidence.publicKey)).toBe(true);
  expect(f.local.sourceSignatureValid).toBe(false);
  expect(f.local).not.toHaveProperty('signature');
  if (selective) await expect(validateSelectiveManifest(f.local as any, f.sourceEvidence.signature)).rejects.toThrow('UNSUPPORTED_SELECTIVE_ARCHIVE');
  else await expect(validateManifest(f.local as any, f.sourceEvidence.signature)).rejects.toThrow('UNSUPPORTED_LARGE_BACKUP_MANIFEST');
  const proof = await createLocalArchiveProof(f.local, f.localSigner, f.localSigner.sign);
  expect(await validateLocalChunkManifest(f.local, { localProof: proof }, { portable: true })).toEqual(f.local);
  for (const [index, original] of f.originalChunks.entries()) {
    const decoded = await validateLocalChunk(original, f.local.chunks[index]);
    if (original.table === 'worlds') expect(selective ? decodeRow((decoded[0] as { record: string }).record) : decoded[0]).toEqual(f.retained);
  }
  await expect(validateLocalChunkManifest(f.local, { localProof: { ...proof, signature: f.sourceEvidence.signature } }, { portable: true }))
    .rejects.toThrow('LOCAL_ARCHIVE_LOCAL_PROOF_INVALID');
});

test('real stored local manifest and replacement chunk read by pinned digest preserve retained records', async () => {
  const f = await fixture(), t = convexTest(schema, { '../_generated/server.ts': () => import('../_generated/server') });
  const worlds = f.originalChunks.find(chunk => chunk.table === 'worlds')!;
  const tagged = { ...worlds, privacyRewriteOperationId: 'replacement-operation' };
  const chunks = f.local.chunks.map(chunk => chunk.index === worlds.index ? { ...chunk } : chunk);
  Object.assign(chunks.find(chunk => chunk.index === worlds.index)!, await descriptor(tagged));
  const local = await createLocalChunkManifest({ ...f.local, chunks });
  const localDigest = await digest(local);
  const stored = await t.action(async ctx => ({ manifestId: await ctx.storage.store(new Blob([JSON.stringify(local)])),
    chunkId: await ctx.storage.store(new Blob([JSON.stringify(tagged)])) }));
  const read = await t.action(async ctx => {
    const manifest = await validateLocalChunkManifest(JSON.parse(await (await ctx.storage.get(stored.manifestId))!.text()), { expectedDigest: localDigest });
    return validateLocalChunk(JSON.parse(await (await ctx.storage.get(stored.chunkId))!.text()), manifest.chunks.find(c => c.index === worlds.index)!);
  });
  expect(read).toEqual([f.retained]);
  await expect(validateLocalChunk({ ...tagged, privacyRewriteOperationId: 'changed-operation' }, chunks.find(c => c.index === worlds.index)!))
    .rejects.toThrow('BACKUP_CHECKSUM_MISMATCH');
});

test('empty replacements keep all descriptor slots and mixed private OLD is excluded from portable form', async () => {
  const f = await fixture();
  const index = f.originalChunks.find(chunk => chunk.table === 'worlds')!.index;
  const empty = { index, table: 'worlds', rows: [] };
  const replacement = { ...await descriptor(empty), role: 'EXPORT' as const, encoding: 'RAW' as const };
  const oldChunk = { index: f.local.chunks.length, table: 'worlds', rows: [encodeRow(f.retained)] };
  const old = { ...await descriptor(oldChunk), role: 'OLD' as const, encoding: 'RAW' as const };
  const mixed = await createLocalChunkManifest({ ...f.local, chunks: [...f.local.chunks.map(c => c.index === index ? replacement : c), old] });
  expect(await validateLocalChunk(empty, replacement)).toEqual([]);
  expect(await validateLocalChunkManifest(mixed, { expectedDigest: await digest(mixed) })).toEqual(mixed);
  await expect(createLocalArchiveProof(mixed, f.localSigner, f.localSigner.sign)).rejects.toThrow('LOCAL_ARCHIVE_PRIVATE_ROLLBACK_NOT_PORTABLE');
  const portable = await portableLocalChunkManifest(mixed);
  expect(portable.chunks).toHaveLength(f.local.chunks.length);
  expect(portable.sourceEvidence).toEqual(f.sourceEvidence);
  await createLocalArchiveProof(portable, f.localSigner, f.localSigner.sign);
  await expect(createLocalChunkManifest({ ...f.local, chunks: f.local.chunks.filter(c => c.index !== index) }))
    .rejects.toThrow('LOCAL_ARCHIVE_SOURCE_CHUNK_SET_INCOMPLETE');
});

test.each(['manifest', 'descriptor', 'source', 'nested-source', 'selection', 'owner'])('unknown signed %s metadata blocks without cropping evidence', async kind => {
  const f = await fixture(kind === 'selection' || kind === 'owner');
  const manifest = structuredClone(f.sourceEvidence.manifest) as any;
  if (kind === 'manifest') manifest.privateBody = 'fixture-private-prose';
  if (kind === 'descriptor') manifest.chunks[0].privateBody = 'fixture-private-prose';
  if (kind === 'source') manifest.source.privateBody = 'fixture-private-prose';
  if (kind === 'nested-source') manifest.source.endpointCandidates = [{ url: 'https://fixture.invalid', priority: 1, privateBody: 'fixture-private-prose' }];
  if (kind === 'selection') manifest.selection.privateBody = 'fixture-private-prose';
  if (kind === 'owner') { manifest.scope = manifest.selection.scope = 'agent-one'; manifest.selection.categories = ['travel'];
    manifest.selection.owners = [{ agentGlobalId: 'owner', worldId: 'world', playerId: 'p:0', agentId: 'a:0', chatProfileId: 'profile', privateBody: 'fixture-private-prose' }]; }
  const evidence = { ...f.sourceEvidence, manifest, digest: await digest(manifest), signature: await f.sourceSigner.sign(manifest) };
  expect(await verifySignature(manifest, evidence.signature, evidence.publicKey)).toBe(true);
  await expect(createLocalChunkManifest({ ...f.local, sourceEvidence: evidence })).rejects.toThrow('LOCAL_ARCHIVE_METADATA_INVALID');
  expect(JSON.stringify(evidence.manifest)).toContain('fixture-private-prose');
});

test('manifest tampering, absent authentication, forged public validity and upload fields fail closed', async () => {
  const f = await fixture(), pinned = await digest(f.local);
  await expect(validateLocalChunkManifest(f.local, {})).rejects.toThrow('LOCAL_ARCHIVE_AUTHENTICATION_REQUIRED');
  await expect(validateLocalChunkManifest({ ...f.local, derivedAt: 3 }, { expectedDigest: pinned })).rejects.toThrow('LOCAL_ARCHIVE_DIGEST_MISMATCH');
  await expect(validateLocalChunkManifest({ ...f.local, sourceSignatureValid: true }, { expectedDigest: pinned })).rejects.toThrow('LOCAL_ARCHIVE_MANIFEST_INVALID');
  await expect(validateLocalChunkManifest({ ...f.local, signature: f.sourceEvidence.signature }, { expectedDigest: pinned })).rejects.toThrow('LOCAL_ARCHIVE_METADATA_INVALID');
  await expect(validateLocalChunk({ ...f.originalChunks[0], privateBody: 'fixture-private-prose' }, f.local.chunks[0])).rejects.toThrow('LOCAL_ARCHIVE_METADATA_INVALID');
  await expect(validateLocalChunk(f.originalChunks[0], { ...f.local.chunks[0], encoding: 'unknown' as any })).rejects.toThrow('LOCAL_ARCHIVE_DESCRIPTOR_INVALID');
});

test('unsigned OLD checkpoints remain locally readable but are never portable source archives', async () => {
  const chunk = { index: 42, table: 'worlds', rows: [] };
  const expected = { ...await descriptor(chunk), role: 'OLD' as const, encoding: 'RAW' as const };
  const local = await createLocalChunkManifest({ archiveId: 'private-checkpoint', derivedAt: 2,
    clearedVisits: ['selected'], chunks: [expected], sourceEvidence: { digest: await digest({ originalCheckpoint: 1 }), signature: '', publicKey: '' } });
  expect(await validateLocalChunkManifest(local, { expectedDigest: await digest(local) })).toEqual(local);
  expect(await validateLocalChunk(chunk, expected)).toEqual([]);
  await expect(portableLocalChunkManifest(local)).rejects.toThrow('LOCAL_ARCHIVE_PRIVATE_ROLLBACK_NOT_PORTABLE');
});


test('private OLD-only tables and encrypted rollback credentials remain readable without portable exposure', async () => {
  const row = { _id: 'old-pair', credentialEncrypted: 'encrypted-test-fixture', response: { state: 'old-state' } };
  const chunk = { index: 4, table: 'pairRequests', rows: [encodeRow(row)] };
  const expected = { ...await descriptor(chunk), role: 'OLD' as const, encoding: 'RAW' as const };
  const manifest = await createLocalChunkManifest({ archiveId: 'rollback', derivedAt: 2, chunks: [expected], clearedVisits: ['selected'],
    sourceEvidence: { digest: await digest({ checkpoint: 1 }), signature: '', publicKey: '' } });
  expect(await validateLocalChunk(chunk, expected)).toEqual([row]);
  await expect(validateLocalChunkManifest(manifest, { expectedDigest: await digest(manifest) }, { portable: true }))
    .rejects.toThrow('LOCAL_ARCHIVE_PRIVATE_ROLLBACK_NOT_PORTABLE');
});

const readerModules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/backupLarge.ts': () => import('./backupLarge'),
  '../federation/backupSelective.ts': () => import('./backupSelective'),
};
async function readerFixture(selective: boolean) {
  const f = await fixture(selective), t = convexTest(schema, readerModules);
  const jobId = await t.run(ctx => ctx.db.insert('backupLargeJobs', {
    kind: 'export', state: 'COMPLETE', phase: 'COMPLETE', tableIndex: 0, cursor: null,
    chunkCount: f.local.chunks.length, processedChunks: 0, recordCount: 2, bytes: 1, createdAt: 1, updatedAt: 1,
    source: f.sourceEvidence.manifest!.source, ...(selective ? { mode: 'selective-archive' } : {}),
  }));
  const local = await createLocalChunkManifest({ ...f.local, archiveId: jobId });
  const storageId = await t.action(ctx => ctx.storage.store(new Blob([JSON.stringify(local)])));
  await t.run(ctx => ctx.db.patch(jobId, { manifestStorageId: storageId, archivePrivacyState: 'LOCAL_SANITIZED',
    metadata: { archiveLocalManifestDigest: '' } }));
  const expectedDigest = await digest(local);
  await t.run(ctx => ctx.db.patch(jobId, { metadata: { archiveLocalManifestDigest: expectedDigest } }));
  const world = f.originalChunks.find(chunk => chunk.table === 'worlds')!;
  const chunkStorageId = await t.action(ctx => ctx.storage.store(new Blob([JSON.stringify(world)])));
  const summary = await descriptor(world);
  const chunkId = await t.run(ctx => ctx.db.insert('backupLargeChunks', { ...summary, jobId, storageId: chunkStorageId }));
  const { makeFunctionReference } = await import('convex/server');
  const ref = (name: string) => makeFunctionReference<'action'>(`federation/${selective ? 'backupSelective' : 'backupLarge'}:${name}`);
  const adminToken = 'reader-test-token-only-0000000000';
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  return { ...f, t, jobId, local, world, chunkId, expectedDigest, ref, args: { jobId, adminToken } };
}

test.each([false, true])('official export readers load pinned LOCAL_SANITIZED manifest and chunk; selective=%s', async selective => {
  const f = await readerFixture(selective);
  const response = await f.t.action(f.ref('getManifest'), f.args);
  expect(response).toEqual({ manifest: f.local, signature: '', sourceSignatureValid: false });
  expect(JSON.parse(await f.t.action(f.ref('getChunk'), { ...f.args, index: f.world.index }))).toEqual(f.world);
  await f.t.run(ctx => ctx.db.patch(f.jobId, { metadata: { archiveLocalManifestDigest: 'A'.repeat(43) + '=' } }));
  await expect(f.t.action(f.ref('getManifest'), f.args)).rejects.toThrow('LOCAL_ARCHIVE_DIGEST_MISMATCH');
  await expect(f.t.action(f.ref('getChunk'), { ...f.args, index: f.world.index })).rejects.toThrow('LOCAL_ARCHIVE_DIGEST_MISMATCH');
});


test.each([false, true])('official export readers block REWRITING and reject tampered chunks; selective=%s', async selective => {
  const f = await readerFixture(selective);
  await f.t.run(ctx => ctx.db.patch(f.jobId, { archivePrivacyState: 'REWRITING' }));
  await expect(f.t.action(f.ref('getManifest'), f.args)).rejects.toThrow('BACKUP_PRIVACY_REWRITE_ACTIVE');
  await expect(f.t.action(f.ref('getChunk'), { ...f.args, index: f.world.index })).rejects.toThrow('BACKUP_PRIVACY_REWRITE_ACTIVE');
  const changed = { ...f.world, rows: [] };
  const storageId = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify(changed)])));
  await f.t.run(async ctx => {
    await ctx.db.patch(f.jobId, { archivePrivacyState: 'LOCAL_SANITIZED' });
    await ctx.db.patch(f.chunkId, { storageId });
  });
  await expect(f.t.action(f.ref('getChunk'), { ...f.args, index: f.world.index })).rejects.toThrow('BACKUP_CHECKSUM_MISMATCH');
});

async function insertRewriteFence(t: ReturnType<typeof convexTest>) {
  return t.run(async ctx => {
    const jobId = await ctx.db.insert('travelPrivacyJobs', {
      visitId: 'synthetic-reader-visit', scope: 'SENSITIVE', state: 'RUNNING', phase: 'ARCHIVE_REWRITE',
      tableIndex: 0, cursor: null, revision: 1, sourceRevision: 0, privacyRevision: 0, changed: false,
      role: 'home', ownerGlobalId: 'reader-owner', conversationIds: [], conversationOwners: [], transcriptIds: [],
      memoryIds: [], memoryOwners: [], archiveIds: [], textHashes: [], blockers: [], externalCopies: 0,
      counts: {}, processedRows: 0, createdAt: 1, updatedAt: 1,
    });
    const scanId = await ctx.db.insert('travelPrivacyChunkScans', {
      jobId, privacyRevision: 1, version: 1, revision: 0, phase: 'READY_TO_REWRITE', cursor: null, cutoff: 1,
      changedInPass: false, objects: 0, rows: 0, selectedRows: 0, blockers: 0, blockerCodes: [],
      sourceRevision: 0, createdAt: 1, updatedAt: 1,
    });
    return ctx.db.insert('travelPrivacyChunkRewrites', {
      scanId, privacyJobId: jobId, expectedParentRevision: 1, key: 'town', revision: 0, sourceRevision: 0,
      phase: 'PREPARING', cursor: null, objects: 0, published: 0, deleted: 0, createdAt: 1, updatedAt: 1,
    });
  });
}

test.each([false, true])('global rewrite fence blocks both readers until DONE; selective=%s', async selective => {
  const f = await readerFixture(selective), rewriteId = await insertRewriteFence(f.t);
  await expect(f.t.action(f.ref('getManifest'), f.args)).rejects.toThrow('BACKUP_PRIVACY_REWRITE_ACTIVE');
  await expect(f.t.action(f.ref('getChunk'), { ...f.args, index: f.world.index })).rejects.toThrow('BACKUP_PRIVACY_REWRITE_ACTIVE');
  await f.t.run(ctx => ctx.db.patch(rewriteId, { phase: 'DONE' }));
  expect((await f.t.action(f.ref('getManifest'), f.args)).sourceSignatureValid).toBe(false);
});

test.each([false, true])('public readers never expose private OLD payload and reject descriptor pointer drift; selective=%s', async selective => {
  const f = await readerFixture(selective);
  await f.t.run(ctx => ctx.db.patch(f.chunkId, { count: f.world.rows.length + 1 }));
  await expect(f.t.action(f.ref('getChunk'), { ...f.args, index: f.world.index })).rejects.toThrow('LOCAL_ARCHIVE_CHUNK_POINTER_MISMATCH');
  const old = { index: f.local.chunks.length, table: 'embeddingsCache', rows: [encodeRow({ _id: 'private-old', _creationTime: 1, text: 'private-rollback' })] };
  const summary = await descriptor(old);
  const local = await createLocalChunkManifest({ ...f.local, chunks: [...f.local.chunks, { ...summary, role: 'OLD', encoding: 'RAW' }] });
  const manifestStorageId = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify(local)])));
  const oldStorageId = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify(old)])));
  await f.t.run(async ctx => {
    await ctx.db.patch(f.jobId, { manifestStorageId, metadata: { archiveLocalManifestDigest: await digest(local) } });
    await ctx.db.insert('backupLargeChunks', { ...summary, jobId: f.jobId, storageId: oldStorageId });
  });
  await expect(f.t.action(f.ref('getManifest'), f.args)).rejects.toThrow('LOCAL_ARCHIVE_PRIVATE_ROLLBACK_NOT_PORTABLE');
  await expect(f.t.action(f.ref('getChunk'), { ...f.args, index: old.index })).rejects.toThrow('LOCAL_ARCHIVE_PRIVATE_ROLLBACK_NOT_PORTABLE');
});

test.each([false, true])('readers recheck publication revision after reading storage; selective=%s', async selective => {
  const f = await readerFixture(selective);
  const functions = selective ? await import('./backupSelective') : await import('./backupLarge');
  for (const method of ['getManifest', 'getChunk'] as const) {
    let changed = false;
    await expect(f.t.action(async ctx => (functions[method] as any)._handler({ ...ctx,
      storage: { ...ctx.storage, get: async (...args: [any]) => {
        const blob = await ctx.storage.get(...args);
        if (!changed) {
          changed = true;
          await f.t.run(async dbCtx => {
            const job = await dbCtx.db.get(f.jobId);
            await dbCtx.db.patch(f.jobId, { archiveRevision: (job!.archiveRevision ?? 0) + 1 });
          });
        }
        return blob;
      } },
    }, { ...f.args, ...(method === 'getChunk' ? { index: f.world.index } : {}) })))
      .rejects.toThrow('BACKUP_CHECKPOINT_CHANGED');
    expect(changed).toBe(true);
  }
});
