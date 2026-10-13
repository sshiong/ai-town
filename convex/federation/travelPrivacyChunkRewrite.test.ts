import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import type { Doc } from '../_generated/dataModel';
import { actionRef, mutationRef, queryRef } from './refs';
import { encodeRow, decodeRow, type BackupRow } from './backupHelpers';
import { descriptor, largeTables, type LargeManifest } from './backupLargeHelpers';
import { digest, toBase64, verifySignature } from './security';
import { rewriteChunkRows, loadManifestDescriptors } from './travelPrivacyChunkRewrite';
import { canonicalJson } from './protocol';
import {
  dataRevision,
  privacyRevisionKey,
  archiveReferenceRevisionKey,
  withEmbeddingRevision,
} from '../models/embeddingDataRevision';
import { describeArchiveUpload } from './archiveUploadProvenance';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/travelPrivacyChunkRewrite.ts': () => import('./travelPrivacyChunkRewrite'),
  '../federation/travelPrivacyChunkReferenceProof.ts': () =>
    import('./travelPrivacyChunkReferenceProof'),
  '../federation/archiveUploadProvenance.ts': () => import('./archiveUploadProvenance'),
};
beforeAll(() =>
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }),
);
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
  const rewriteId = await t.mutation(mutationRef('travelPrivacyChunkRewrite/startRewrite'), {
    scanId: ids.scanId,
  });
  return { t, ...ids, rewriteId, storageId, chunk, d };
}
async function status(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<Doc<'travelPrivacyChunkRewrites'> | null> {
  return f.t.query(queryRef('travelPrivacyChunkRewrite/status'), { rewriteId: f.rewriteId });
}
async function step(f: Awaited<ReturnType<typeof fixture>>) {
  const current = (await status(f))!;
  // convex-test 0.0.60 omits Blob.type from stored metadata. Repair only the emulator field,
  // then exercise the real recovery path (the production writer still checks every byte).
  const invoke = async () => {
    const latest = await f.t.run((ctx) => ctx.db.system.query('_storage').order('desc').first());
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Math.max(Date.now(), Math.ceil(latest?._creationTime ?? 0) + 10));
    try {
      await f.t.action(actionRef('travelPrivacyChunkRewrite/page'), {
        rewriteId: f.rewriteId,
        revision: (await status(f))!.revision,
      });
    } finally {
      clock.mockRestore();
    }
  };
  await invoke();
  for (let retry = 0; retry < 100; retry++) {
    const repaired = await f.t.run(async (ctx) => {
      const operations = await ctx.db.query('archiveUploadOperations').collect();
      let changed = false;
      for (const object of await ctx.db.system.query('_storage').collect()) {
        const op = operations.find(
          (op) =>
            op.state === 'UPLOADING' &&
            op.size === object.size &&
            Buffer.from(op.sha256Hex, 'hex').toString('base64') === object.sha256,
        );
        if (op && !object.contentType) {
          await ctx.db.patch(object._id as never, { contentType: op.contentType } as never);
          changed = true;
        }
      }
      return changed;
    });
    if (!repaired) break;
    await invoke();
  }
  return (await status(f))!;
}
async function until(f: Awaited<ReturnType<typeof fixture>>, phase: string) {
  for (let n = 0; n < 2000; n++) {
    const s = await status(f);
    if (s!.phase === phase) return s!;
    const next = await step(f);
    if (next.errorCode) throw new Error(`${next.phase}: ${next.errorCode}`);
  }
  throw new Error('Page limit');
}

test('rewrites OLD chunk, preserves unrelated bytes, shifts staged rows, publishes manifest then confirms deletion', async () => {
  const f = await fixture();
  await until(f, 'DELETE');
  expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).not.toBeNull();
  const chunk = await f.t.run((ctx) => ctx.db.get(f.chunkId));
  const raw = await f.t.action(async (ctx) =>
    JSON.parse(await (await ctx.storage.get(chunk!.storageId))!.text()),
  );
  expect(raw.rows).toEqual([f.chunk.rows[1]]);
  expect(raw.privacyRewriteOperationId).toBeTruthy();
  const staged = await f.t.run((ctx) => ctx.db.query('backupLargeRows').collect());
  expect(staged).toHaveLength(1);
  expect(staged[0].sourceId).toBe('other');
  expect(staged[0].rowIndex).toBe(0);
  expect(staged[0].metadata.oldPrivateCopy).toBeUndefined();
  const backup = (await f.t.run((ctx) => ctx.db.get(f.backupId)))!;
  const local = await f.t.action(async (ctx) =>
    JSON.parse(await (await ctx.storage.get(backup.manifestStorageId!))!.text()),
  );
  expect(local.sourceSignatureValid).toBe(false);
  expect(local.chunks[0].count).toBe(1);
  expect(backup.signature).toBeUndefined();
  await until(f, 'DONE');
  expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).toBeNull();
  expect((await f.t.run((ctx) => ctx.db.get(f.backupId)))!.archivePrivacyState).toBe(
    'LOCAL_SANITIZED',
  );
  const operations = await f.t.run((ctx) => ctx.db.query('archiveUploadOperations').collect());
  expect(operations).toHaveLength(2);
  expect(operations.every((op) => op.state === 'PUBLISHED')).toBe(true);
});

test('redacts selected payload and staged metadata while retaining the neighboring record', async () => {
  const f = await fixture('federationEventFacts', [
    { _id: 'selected', payload: { secret: 'private-test-payload' } },
    { _id: 'other', payload: { harmless: 'other-data' } },
  ]);
  await until(f, 'DONE');
  const chunk = (await f.t.run((ctx) => ctx.db.get(f.chunkId)))!;
  const raw = await f.t.action(async (ctx) =>
    JSON.parse(await (await ctx.storage.get(chunk.storageId))!.text()),
  );
  expect(JSON.stringify(decodeRow(raw.rows[0]))).not.toContain('private-test-payload');
  expect(raw.rows[1]).toBe(f.chunk.rows[1]);
  expect(
    JSON.stringify(await f.t.run((ctx) => ctx.db.query('backupLargeRows').collect())),
  ).not.toContain('private-test-payload');
});

test('changed alias aborts publication and preserves both source and candidate', async () => {
  const f = await fixture();
  await until(f, 'OBJECTS');
  await step(f);
  await f.t.run((ctx) => ctx.db.patch(f.chunkId, { digest: 'changed-alias' }));
  const s = await step(f);
  expect(s.errorCode).toBe('ALIAS_CHANGED');
  expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).not.toBeNull();
  const op = (await f.t.run((ctx) => ctx.db.query('archiveUploadOperations').collect()))[0];
  expect(op.state).toBe('UPLOADED');
});

test('lost upload acknowledgement recovers the same operation without a duplicate store', async () => {
  const f = await fixture();
  await until(f, 'OBJECTS');
  const candidate = (
    await f.t.run((ctx) => ctx.db.query('travelPrivacyChunkReplacements').collect())
  )[0];
  const rewritten = rewriteChunkRows(f.chunk, [0], false, candidate._id);
  const replacementDescriptor = await descriptor(rewritten.chunk),
    blob = new Blob([JSON.stringify(rewritten.chunk)]);
  const s = (await status(f))!;
  const lease = await f.t.mutation(mutationRef('travelPrivacyChunkRewrite/reserveObject'), {
    rewriteId: f.rewriteId,
    revision: s.revision,
    candidateId: candidate._id,
    replacementDescriptor,
    rowIndices: rewritten.rowIndices,
    ...(await describeArchiveUpload(blob)),
  });
  const stored = await f.t.action((ctx) =>
    ctx.storage.store(new Blob([blob], { type: lease.contentType })),
  );
  await f.t.run((ctx) =>
    ctx.db.patch(stored as never, { contentType: lease.contentType } as never),
  );
  await step(f);
  expect((await f.t.run((ctx) => ctx.db.get(candidate._id)))!.state).toBe('VERIFIED');
  expect(await f.t.run((ctx) => ctx.db.query('archiveUploadOperations').collect())).toHaveLength(1);
  await until(f, 'DONE');
});

test('new nested metadata reference prevents deletion after publication', async () => {
  const f = await fixture();
  await until(f, 'DELETE');
  await f.t.run(async (ctx) => {
    const backup = (await ctx.db.get(f.backupId))!;
    await ctx.db.patch(backup._id, {
      metadata: { ...backup.metadata, unexpected: { storageAlias: f.storageId } },
    });
  });
  for (let i = 0; i < 1000 && !(await status(f))!.errorCode; i++) await step(f);
  expect((await status(f))!.errorCode).toBe('STRONG_REFERENCE');
  expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).not.toBeNull();
});

test('empty upload lease stays UNKNOWN and never creates an invented replacement', async () => {
  const f = await fixture();
  await until(f, 'OBJECTS');
  const c = (await f.t.run((ctx) => ctx.db.query('travelPrivacyChunkReplacements').collect()))[0];
  const rewritten = rewriteChunkRows(f.chunk, [0], false, c._id),
    blob = new Blob([JSON.stringify(rewritten.chunk)]);
  await f.t.mutation(mutationRef('travelPrivacyChunkRewrite/reserveObject'), {
    rewriteId: f.rewriteId,
    revision: (await status(f))!.revision,
    candidateId: c._id,
    replacementDescriptor: await descriptor(rewritten.chunk),
    rowIndices: rewritten.rowIndices,
    ...(await describeArchiveUpload(blob)),
  });
  expect((await step(f)).errorCode).toBe('UPLOAD_COVERAGE_UNKNOWN');
  expect((await f.t.run((ctx) => ctx.db.get(c._id)))!.replacementStorageId).toBeUndefined();
  expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).not.toBeNull();
});

test('a second cleanup retires superseded upload ownership and deletes its actual old replacement', async () => {
  const f = await fixture();
  await until(f, 'DONE');
  const old = (await f.t.run((ctx) => ctx.db.get(f.chunkId)))!;
  const scanId = await f.t.run(async (ctx) => {
    const scanId = await ctx.db.insert('travelPrivacyChunkScans', {
      jobId: f.jobId,
      privacyRevision: 0,
      version: 1,
      revision: 0,
      phase: 'READY_TO_REWRITE',
      cursor: null,
      cutoff: 1,
      changedInPass: false,
      objects: 1,
      rows: 1,
      selectedRows: 1,
      blockers: 0,
      blockerCodes: [],
      sourceRevision: await dataRevision(ctx.db, privacyRevisionKey),
      createdAt: 2,
      updatedAt: 2,
    });
    const d = {
      index: old.index,
      table: old.table,
      count: old.count,
      bytes: old.bytes,
      digest: old.digest,
    };
    const planId = await ctx.db.insert('travelPrivacyChunkObjects', {
      scanId,
      backupJobId: f.backupId,
      chunkId: f.chunkId,
      role: 'OLD',
      originalStorageId: old.storageId,
      originalDigest: old.digest,
      descriptor: d,
      backupDigest: await digest((await ctx.db.get(f.backupId))!),
      state: 'CHECKED',
      rowOffset: 1,
      selectedRows: 1,
      selectionDigest: 'second',
      nextCursor: null,
      scanDone: true,
      referenceCursor: null,
      blockers: [],
      aliases: [{ table: 'backupLargeChunks', id: f.chunkId }],
    });
    await ctx.db.insert('travelPrivacyChunkRows', {
      scanId,
      objectId: planId,
      backupJobId: f.backupId,
      role: 'OLD',
      selected: true,
      evidence: {
        sourceId: 'other',
        table: 'memories',
        rowIndex: 0,
        relatedMemoryIds: [],
        evidenceMemoryIds: [],
        storageIds: [],
      },
    });
    return scanId;
  });
  f.rewriteId = await f.t.mutation(mutationRef('travelPrivacyChunkRewrite/startRewrite'), {
    scanId,
  });
  const proof = await readyReferenceProof(f);
  await until(f, 'DONE');
  expect((await f.t.run((ctx) => ctx.db.get(proof._id)))!.referenceRevision).toBe(
    proof.referenceRevision + 4,
  );
  expect(await f.t.run((ctx) => ctx.db.system.get(old.storageId))).toBeNull();
  expect((await f.t.run((ctx) => ctx.db.get(f.chunkId)))!.count).toBe(0);
  const uploads = await f.t.run((ctx) => ctx.db.query('archiveUploadOperations').collect());
  const retired = uploads.find((op) => op.publishedStorageId === old.storageId)!;
  expect(retired.state).toBe('RETIRED');
  expect(retired.producerTerminalAt).toBeDefined();
  expect(
    (await f.t.run((ctx) =>
      ctx.db
        .query('archiveUploadCandidates')
        .withIndex('storage', (q) => q.eq('storageId', old.storageId))
        .first(),
    ))!.state,
  ).toBe('DELETED');
});

test.each([false, true])(
  'retains count-zero SOURCE slots and authentic original source evidence; selective=%s',
  async (selective) => {
    const f = await fixture('memories', [
      {
        _id: 'selected',
        playerId: 'p:0',
        data: { type: 'travel', visitId: 'selected-visit' },
        description: 'private-selected',
      },
    ]);
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const publicKey = toBase64(
      new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)),
    );
    const source: BackupRow = {
      _id: 'identity',
      _creationTime: 1,
      townId: 'source-town',
      townName: 'Fixture',
      publicKey,
      fingerprint: `sha256:${await digest(publicKey)}`,
      deploymentInstanceId: 'instance',
      deploymentEpoch: 1,
      endpoint: 'https://fixture.invalid/federation/v1',
      enabled: false,
      allowIncomingPairRequests: false,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 1,
      maxVisitDurationMs: 300_000,
      mode: 'ACTIVE',
      createdAt: 1,
    };
    const sourceChunks: Array<
      Awaited<ReturnType<typeof descriptor>> & {
        storageId: import('../_generated/dataModel').Id<'_storage'>;
      }
    > = [];
    for (const [index, table] of (selective
      ? ['federationIdentity', 'memories']
      : [...largeTables]
    ).entries()) {
      const rawRows =
        table === 'memories'
          ? f.chunk.rows
          : table === 'federationIdentity'
            ? [encodeRow(source)]
            : [];
      const chunk = {
        index,
        table,
        rows: selective
          ? rawRows.map((record) =>
              encodeRow({ kind: 'record', role: 'primary', record, references: [] }),
            )
          : rawRows,
      };
      const d = await descriptor(chunk);
      const storageId = await f.t.action((ctx) =>
        ctx.storage.store(new Blob([JSON.stringify(chunk)])),
      );
      sourceChunks.push({ ...d, storageId });
    }
    const summaries = sourceChunks.map(({ storageId: _storageId, ...d }) => d);
    const manifest: LargeManifest | import('./backupSelectiveHelpers').SelectiveManifest = selective
      ? {
          format: 'ai-town-selective-archive',
          version: 2,
          schemaVersion: 1,
          scope: 'config-only',
          exportId: 'source-export',
          source,
          exportedAt: 1,
          chunks: summaries,
          selection: {
            scope: 'config-only',
            owners: [],
            categories: ['configuration'],
            from: null,
            to: null,
            includePublicPeers: false,
            dependencyPolicy: 'same-owner-evidence-and-public-context',
            timePolicy: 'event-time-else-creation-time-half-open',
          },
          usage: 'selective-transfer',
          operator: 'fixture',
          reason: 'fixture',
        }
      : {
          format: 'ai-town-chunks',
          version: 1,
          schemaVersion: 1,
          scope: 'town',
          exportId: 'source-export',
          source,
          exportedAt: 1,
          chunks: summaries,
        };
    const signature = toBase64(
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          keys.privateKey,
          new TextEncoder().encode(canonicalJson(manifest)),
        ),
      ),
    );
    const manifestStorageId = await f.t.action((ctx) =>
      ctx.storage.store(new Blob([JSON.stringify(manifest)])),
    );
    const chosen = sourceChunks.find((chunk) => chunk.table === 'memories')!;
    await f.t.run(async (ctx) => {
      await ctx.db.delete(f.rewriteId);
      await ctx.db.patch(f.backupId, {
        chunkCount: sourceChunks.length,
        source,
        manifestStorageId,
        signature,
        mode: selective ? 'selective-import' : 'restore',
        bytes: sourceChunks.reduce((n, c) => n + c.bytes, 0),
      });
      for (const chunk of sourceChunks) {
        if (chunk.table === 'memories') await ctx.db.patch(f.chunkId, chunk);
        else await ctx.db.insert('backupLargeChunks', { jobId: f.backupId, ...chunk });
      }
      const { storageId: _storageId, ...d } = chosen;
      await ctx.db.patch(f.planId, {
        role: 'SOURCE',
        descriptor: d,
        originalStorageId: chosen.storageId,
        originalDigest: chosen.digest,
        backupDigest: await digest((await ctx.db.get(f.backupId))!),
        sourceManifestDigest: await digest(manifest),
        sourceManifestStorageId: manifestStorageId,
        sourceSignature: signature,
        sourcePublicKey: publicKey,
      });
      for (const row of await ctx.db.query('travelPrivacyChunkRows').collect())
        await ctx.db.patch(row._id, { role: 'SOURCE' });
      for (const row of await ctx.db.query('backupLargeRows').collect())
        await ctx.db.patch(row._id, { role: 'SOURCE', chunkIndex: chosen.index });
    });
    f.rewriteId = await f.t.mutation(mutationRef('travelPrivacyChunkRewrite/startRewrite'), {
      scanId: f.scanId,
    });
    await until(f, 'DONE');
    const backup = (await f.t.run((ctx) => ctx.db.get(f.backupId)))!;
    const local = await f.t.action(async (ctx) =>
      JSON.parse(await (await ctx.storage.get(backup.manifestStorageId!))!.text()),
    );
    expect(local.chunks).toHaveLength(sourceChunks.length);
    expect(local.chunks.find((c: any) => c.table === 'memories').count).toBe(0);
    expect(local.sourceEvidence.manifest).toEqual(manifest);
    expect(
      await verifySignature(
        local.sourceEvidence.manifest,
        local.sourceEvidence.signature,
        publicKey,
      ),
    ).toBe(true);
    expect(local.sourceSignatureValid).toBe(false);
    expect(await f.t.run((ctx) => ctx.db.system.get(chosen.storageId))).toBeNull();
  },
);

test('oversized reference coverage is rejected before any canonical archive pointer is changed', async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    await ctx.db.delete(f.rewriteId);
    for (let index = 0; index < 129; index++)
      await ctx.db.insert('music', { type: 'background', storageId: f.storageId });
  });
  await expect(
    f.t.mutation(mutationRef('travelPrivacyChunkRewrite/startRewrite'), { scanId: f.scanId }),
  ).rejects.toThrow('REFERENCE_COVERAGE_UNKNOWN');
  expect((await f.t.run((ctx) => ctx.db.get(f.chunkId)))!.storageId).toBe(f.storageId);
  expect((await f.t.run((ctx) => ctx.db.get(f.backupId)))!.archivePrivacyState).toBeUndefined();
});

test('a nested encoded reference inside another physical archive prevents deletion', async () => {
  const f = await fixture();
  await until(f, 'DELETE');
  const storageId = await f.t.action((ctx) =>
    ctx.storage.store(
      new Blob([
        JSON.stringify({
          sections: {
            arbitrary: [encodeRow({ _id: 'external', dynamicMetadata: { alias: f.storageId } })],
          },
        }),
      ]),
    ),
  );
  await f.t.run((ctx) =>
    ctx.db.insert('backupLargeJobs', {
      kind: 'import',
      state: 'COMPLETE',
      phase: 'COMPLETE',
      tableIndex: 0,
      cursor: null,
      chunkCount: 0,
      processedChunks: 0,
      recordCount: 0,
      bytes: 0,
      createdAt: 1,
      updatedAt: 1,
      source: {},
      manifestStorageId: storageId,
    }),
  );
  for (let i = 0; i < 1000 && !(await status(f))!.errorCode; i++) await step(f);
  expect((await status(f))!.errorCode).toBe('STRONG_REFERENCE');
  expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).not.toBeNull();
});

async function manifestOnlyFixture(entries: number, chunkBytes: number) {
  const f = await fixture();
  const manifestId = await f.t.run(async (ctx) => {
    await ctx.db.delete(f.chunkId);
    await ctx.db.patch(f.backupId, {
      chunkCount: Math.min(20000, entries),
      archivePrivacyState: 'REWRITING',
      archiveRevision: 1,
    });
    await ctx.db.patch(f.rewriteId, { phase: 'MANIFESTS' });
    return ctx.db.insert('travelPrivacyChunkManifestRewrites', {
      rewriteId: f.rewriteId,
      backupJobId: f.backupId,
      expectedProducerDigest: await digest((await ctx.db.get(f.backupId))!),
      producerRevision: 1,
      state: 'PLANNED',
      cursor: null,
      sourceManifestDigest: await digest({}),
      sourceSignature: '',
      sourcePublicKey: '',
      clearedVisits: ['selected-visit'],
    });
  });
  // This test exercises real DB pagination at the full descriptor limit. It deliberately does not
  // claim to have uploaded/read 2GiB of bodies: storage-byte proof has its own separate test path.
  for (let offset = 0; offset < entries; offset += 500) {
    await f.t.run(async (ctx) => {
      for (let index = offset; index < Math.min(offset + 500, entries); index++)
        await ctx.db.insert('backupLargeChunks', {
          jobId: f.backupId,
          index,
          table: 'memories',
          count: 0,
          bytes: chunkBytes,
          digest: f.d.digest,
          storageId: f.storageId,
        });
    });
  }
  return { ...f, manifestId };
}
async function buildDescriptors(f: Awaited<ReturnType<typeof manifestOnlyFixture>>) {
  let steps = 0;
  for (;;) {
    const producer = (await f.t.run((ctx) => ctx.db.get(f.manifestId)))!;
    if (producer.state === 'BUILDING') return { producer, steps };
    await f.t.mutation(mutationRef('travelPrivacyChunkRewrite/buildManifestPage'), {
      rewriteId: f.rewriteId,
      revision: (await status(f))!.revision,
    });
    if (++steps > 500) throw new Error('Descriptor page limit');
  }
}

test('40k mixed SOURCE/OLD descriptors paginate without a large producer document or truncating 2GiB budget', async () => {
  const f = await manifestOnlyFixture(40000, Math.floor((2 * 1024 ** 3) / 40000));
  const { producer, steps } = await buildDescriptors(f);
  expect(steps).toBe(400);
  expect(producer.chunks).toBeUndefined();
  expect(producer.descriptorCount).toBe(40000);
  expect(producer.descriptorPageCount).toBe(400);
  expect(producer.lastDescriptorIndex).toBe(39999);
  expect(producer.archiveBytes).toBe(40000 * Math.floor((2 * 1024 ** 3) / 40000));
  expect(new TextEncoder().encode(JSON.stringify(producer)).length).toBeLessThan(2048);
  let cursor: string | null = null,
    count = 0,
    source = 0,
    old = 0,
    nextPage = 0;
  for (;;) {
    const page: any = await f.t.query(
      queryRef('travelPrivacyChunkRewrite/manifestDescriptorPage'),
      {
        rewriteId: f.rewriteId,
        revision: (await status(f))!.revision,
        manifestId: f.manifestId,
        cursor,
        expectedPageNumber: nextPage,
      },
    );
    expect(page.page.length).toBeLessThanOrEqual(1);
    for (const row of page.page) {
      expect(row.pageNumber).toBe(nextPage++);
      expect(row.descriptors.length).toBeLessThanOrEqual(100);
      expect(new TextEncoder().encode(JSON.stringify(row)).length).toBeLessThan(32768);
      for (const d of row.descriptors) {
        expect(d.index).toBe(count++);
        expect(d.count).toBe(0);
        if (d.role === 'SOURCE') source++;
        else if (d.role === 'OLD') old++;
      }
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  expect(count).toBe(40000);
  expect(source).toBe(20000);
  expect(old).toBe(20000);
}, 180000);

test('manifest page append rejects mixed archive bytes over 2GiB without committing a partial journal', async () => {
  const f = await manifestOnlyFixture(1, 900000);
  await f.t.run((ctx) => ctx.db.patch(f.manifestId, { archiveBytes: 2 * 1024 ** 3 - 1 }));
  await expect(
    f.t.mutation(mutationRef('travelPrivacyChunkRewrite/buildManifestPage'), {
      rewriteId: f.rewriteId,
      revision: (await status(f))!.revision,
    }),
  ).rejects.toThrow('MANIFEST_BUDGET');
  expect(
    await f.t.run((ctx) => ctx.db.query('travelPrivacyChunkManifestPages').collect()),
  ).toHaveLength(0);
  expect((await f.t.run((ctx) => ctx.db.get(f.manifestId)))!.state).toBe('PLANNED');
});

test('bounded legacy descriptor array migrates atomically and remains readable by original index', async () => {
  const f = await manifestOnlyFixture(2, 100);
  const legacy = {
    index: 0,
    table: 'memories',
    count: 0,
    bytes: 100,
    digest: f.d.digest,
    role: 'SOURCE' as const,
    encoding: 'RAW' as const,
  };
  await f.t.run(async (ctx) => {
    const zero = await ctx.db
      .query('backupLargeChunks')
      .withIndex('job_index', (q) => q.eq('jobId', f.backupId).eq('index', 0))
      .unique();
    await ctx.db.delete(zero!._id);
    await ctx.db.patch(f.manifestId, { chunks: [legacy] });
  });
  const { producer } = await buildDescriptors(f);
  expect(producer.chunks).toBeUndefined();
  expect(producer.descriptorCount).toBe(2);
  const pages = await f.t.run((ctx) =>
    ctx.db
      .query('travelPrivacyChunkManifestPages')
      .withIndex('manifest_page', (q) => q.eq('manifestId', f.manifestId))
      .collect(),
  );
  expect(pages.flatMap((page) => page.descriptors).map((d) => d.index)).toEqual([0, 1]);
  expect(pages[0].descriptors[0]).toEqual(legacy);
});

async function readDescriptors(f: Awaited<ReturnType<typeof manifestOnlyFixture>>) {
  const manifest = (await f.t.run((ctx) => ctx.db.get(f.manifestId)))!;
  return loadManifestDescriptors(
    { runQuery: (ref: any, args: any) => f.t.query(ref, args) },
    { rewriteId: f.rewriteId, revision: (await status(f))!.revision },
    manifest,
  );
}

test.each(['missing', 'duplicate', 'unordered', 'digest', 'replacement'])(
  'descriptor reader rejects %s page corruption before upload reservation',
  async (corruption) => {
    const f = await manifestOnlyFixture(101, 100);
    await buildDescriptors(f);
    expect(await readDescriptors(f)).toHaveLength(101);
    await f.t.run(async (ctx) => {
      const pages = await ctx.db
        .query('travelPrivacyChunkManifestPages')
        .withIndex('manifest_page', (q) => q.eq('manifestId', f.manifestId))
        .collect();
      const last = pages[1];
      if (corruption === 'missing') await ctx.db.delete(last._id);
      else if (corruption === 'duplicate')
        await ctx.db.insert('travelPrivacyChunkManifestPages', {
          manifestId: f.manifestId,
          pageNumber: last.pageNumber,
          descriptors: last.descriptors,
          digest: last.digest,
        });
      else if (corruption === 'unordered') await ctx.db.patch(last._id, { pageNumber: 5 });
      else if (corruption === 'digest') await ctx.db.patch(last._id, { digest: 'changed' });
      else {
        const descriptors = last.descriptors.map((d) => ({ ...d, table: 'inputs' }));
        // A recomputed per-page digest alone cannot replace the append chain pinned on producer.
        await ctx.db.patch(last._id, { descriptors, digest: await digest(descriptors) });
      }
    });
    await expect(readDescriptors(f)).rejects.toThrow('MANIFEST_PAGE_CHANGED');
    expect(await f.t.run((ctx) => ctx.db.query('archiveUploadOperations').collect())).toHaveLength(
      0,
    );
  },
);

test('descriptor reads fail CAS when canonical producer changes after descriptor pagination', async () => {
  const f = await manifestOnlyFixture(101, 100);
  await buildDescriptors(f);
  await f.t.run((ctx) => ctx.db.patch(f.backupId, { recordCount: 500 }));
  await expect(readDescriptors(f)).rejects.toThrow('PRODUCER_CHANGED');
});

async function readyReferenceProof(f: Awaited<ReturnType<typeof fixture>>) {
  await until(f, 'DELETE');
  for (let i = 0; i < 2000; i++) {
    const s = (await status(f))!;
    if (s.referenceProofId) {
      const proof = await f.t.run((ctx) => ctx.db.get(s.referenceProofId!));
      if (proof?.phase === 'READY') return proof;
    }
    const next = await step(f);
    if (next.errorCode) throw new Error(next.errorCode);
  }
  throw new Error('Reference proof page limit');
}

test('actual DELETE transaction reuses one proof across two candidates and stale retries do not advance it', async () => {
  const f = await fixture();
  const secondChunk = { ...f.chunk, index: 1 };
  const d = await descriptor(secondChunk);
  const secondOriginal = await f.t.action((ctx) =>
    ctx.storage.store(new Blob([JSON.stringify(secondChunk)])),
  );
  await f.t.run(async (ctx) => {
    const chunkId = await ctx.db.insert('backupLargeChunks', {
      jobId: f.backupId,
      ...d,
      storageId: secondOriginal,
    });
    const { _id, _creationTime, ...plan } = (await ctx.db.get(f.planId))!;
    const planId = await ctx.db.insert('travelPrivacyChunkObjects', {
      ...plan,
      chunkId,
      originalStorageId: secondOriginal,
      originalDigest: d.digest,
      descriptor: d,
      aliases: [{ table: 'backupLargeChunks', id: chunkId }],
    });
    for (const row of await ctx.db
      .query('travelPrivacyChunkRows')
      .withIndex('object', (q) => q.eq('objectId', f.planId))
      .collect()) {
      const { _id, _creationTime, ...fields } = row;
      await ctx.db.insert('travelPrivacyChunkRows', { ...fields, objectId: planId });
    }
    for (const row of await ctx.db.query('backupLargeRows').collect()) {
      const { _id, _creationTime, ...fields } = row;
      await ctx.db.insert('backupLargeRows', { ...fields, chunkIndex: 1 });
    }
  });
  const proof = await readyReferenceProof(f);
  expect(proof.targets).toBe(2);
  const candidates = await f.t.run((ctx) =>
    ctx.db
      .query('travelPrivacyChunkReplacements')
      .withIndex('rewrite_state', (q) => q.eq('rewriteId', f.rewriteId).eq('state', 'PUBLISHED'))
      .collect(),
  );
  const initial = (await status(f))!;
  const args = {
    rewriteId: f.rewriteId,
    revision: initial.revision,
    candidateId: candidates[0]._id,
    proofId: proof._id,
  };
  expect(await f.t.mutation(mutationRef('travelPrivacyChunkRewrite/eraseOriginal'), args)).toBe(
    true,
  );
  const firstProof = (await f.t.run((ctx) => ctx.db.get(proof._id)))!;
  expect(firstProof.referenceRevision).toBe(proof.referenceRevision + 1);
  expect(firstProof.rewriteRevision).toBe(initial.revision + 1);
  expect(await f.t.mutation(mutationRef('travelPrivacyChunkRewrite/eraseOriginal'), args)).toBe(
    false,
  );
  expect(await f.t.run((ctx) => ctx.db.get(proof._id))).toEqual(firstProof);
  expect(
    await f.t.mutation(mutationRef('travelPrivacyChunkRewrite/eraseOriginal'), {
      ...args,
      revision: initial.revision + 1,
      candidateId: candidates[1]._id,
    }),
  ).toBe(true);
  const secondProof = (await f.t.run((ctx) => ctx.db.get(proof._id)))!;
  expect(secondProof.referenceRevision).toBe(proof.referenceRevision + 2);
  expect(secondProof.rewriteRevision).toBe(initial.revision + 2);
  expect(await f.t.run((ctx) => dataRevision(ctx.db, archiveReferenceRevisionKey))).toBe(
    secondProof.referenceRevision,
  );
  expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.system.get(secondOriginal))).toBeNull();
  expect(
    await f.t.run((ctx) => ctx.db.query('travelPrivacyChunkReferenceProofs').collect()),
  ).toHaveLength(1);
  await until(f, 'DONE');
});

test('actual erase rejects a late tracked reference after READY without deleting original or refreshing proof', async () => {
  const f = await fixture();
  const proof = await readyReferenceProof(f);
  await f.t.run((ctx) =>
    withEmbeddingRevision(ctx).db.insert('music', { type: 'background', storageId: f.storageId }),
  );
  const deletion: { candidate: Doc<'travelPrivacyChunkReplacements'> } = await f.t.query(
    queryRef('travelPrivacyChunkRewrite/deletionData'),
    {
      rewriteId: f.rewriteId,
      revision: (await status(f))!.revision,
    },
  );
  const candidate = deletion.candidate;
  await expect(
    f.t.mutation(mutationRef('travelPrivacyChunkRewrite/eraseOriginal'), {
      rewriteId: f.rewriteId,
      revision: (await status(f))!.revision,
      candidateId: candidate._id,
      proofId: proof._id,
    }),
  ).rejects.toThrow('REFERENCE_EPOCH_CHANGED');
  expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).not.toBeNull();
  expect(await f.t.run((ctx) => ctx.db.get(proof._id))).toEqual(proof);
  expect((await status(f))!.deleted).toBe(0);
  expect((await f.t.run((ctx) => ctx.db.get(candidate._id)))!.state).toBe('PUBLISHED');
});

test.each(['sha256', 'size', 'contentType'] as const)(
  'actual erase rechecks replacement %s metadata after the completed proof',
  async (field) => {
    const f = await fixture();
    const proof = await readyReferenceProof(f);
    const candidate = (await f.t.run((ctx) =>
      ctx.db
        .query('travelPrivacyChunkReplacements')
        .withIndex('rewrite_state', (q) => q.eq('rewriteId', f.rewriteId).eq('state', 'PUBLISHED'))
        .first(),
    ))!;
    const metadata = (await f.t.run((ctx) => ctx.db.system.get(candidate.replacementStorageId!)))!;
    await f.t.run((ctx) =>
      (ctx.db.patch as any)(candidate.replacementStorageId, {
        [field]:
          field === 'size'
            ? metadata.size + 1
            : field === 'sha256'
              ? '0'.repeat(64)
              : 'application/json',
      }),
    );
    await expect(
      f.t.mutation(mutationRef('travelPrivacyChunkRewrite/eraseOriginal'), {
        rewriteId: f.rewriteId,
        revision: (await status(f))!.revision,
        candidateId: candidate._id,
        proofId: proof._id,
      }),
    ).rejects.toThrow('REPLACEMENT_MISSING');
    expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).not.toBeNull();
    expect(await f.t.run((ctx) => ctx.db.get(proof._id))).toEqual(proof);
    expect((await status(f))!.deleted).toBe(0);
  },
);
