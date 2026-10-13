import { inspectionEvidence } from './travelPrivacyChunkArchives';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { actionRef, mutationRef, queryRef } from './refs';
import { encodeRow, type BackupRow } from './backupHelpers';
import { descriptor, largeTables, type LargeChunk, type LargeManifest } from './backupLargeHelpers';
import { digest, toBase64 } from './security';
import { createLocalChunkManifest } from './travelPrivacyLocalChunkManifest';
import { canonicalJson } from './protocol';
import type { Id } from '../_generated/dataModel';
import { withEmbeddingRevision, dataRevision, privacyRevisionKey } from '../models/embeddingDataRevision';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/travelPrivacyChunkArchives.ts': () => import('./travelPrivacyChunkArchives'),
};
type Test = ReturnType<typeof convexTest<typeof schema.tables>>;
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
async function fixture() {
  const t = convexTest(schema, modules);
  const local = await t.run(async ctx => {
    const worldId = await ctx.db.insert('worlds', { nextId: 1, players: [], agents: [], conversations: [] });
    const jobId = await ctx.db.insert('travelPrivacyJobs', {
      visitId: 'selected-visit', scope: 'SENSITIVE', state: 'INSPECTING', phase: 'ARCHIVE_CHUNK_CHECK',
      tableIndex: 0, cursor: null, revision: 0, sourceRevision: 0, privacyRevision: 0, changed: false,
      worldId, role: 'home', ownerGlobalId: 'selected-owner', conversationIds: [], conversationOwners: [],
      transcriptIds: [], memoryIds: [], memoryOwners: [], archiveIds: [], textHashes: [], blockers: [],
      externalCopies: 0, counts: {}, processedRows: 0, createdAt: 1, updatedAt: 1,
    });
    return { worldId, jobId };
  });
  return { t, ...local };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const binding = (worldId: string, owner = 'selected-owner', player = 'p:0'): BackupRow =>
  ({ _id: `binding-${owner}`, worldId, playerId: player, agentGlobalId: owner });
const ledger = (worldId: string): BackupRow => ({ _id: 'ledger', visitId: 'selected-visit', worldId,
  homePlayerId: 'p:0', agentGlobalId: 'selected-owner', state: 'COMPLETED' });
const memory = (worldId: string, sourceId: string, owner = 'selected-owner', visitId = 'selected-visit'): BackupRow =>
  ({ _id: sourceId, worldId, playerId: owner === 'selected-owner' ? 'p:0' : 'p:1', agentGlobalId: owner,
    description: 'private-test-body', data: { type: 'travel', visitId, messageText: 'private-test-message' } });
async function archive(f: Fixture, entries: Array<[string, BackupRow[]]>, options: {
  kind?: 'import' | 'export'; old?: boolean; state?: string; selective?: boolean; sourceWorld?: string;
} = {}) {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  const chunks: Array<{ chunk: LargeChunk; storageId: Id<'_storage'>; descriptor: Awaited<ReturnType<typeof descriptor>> }> = [];
  for (const [index, [table, rows]] of entries.entries()) {
    const raw = options.selective && !options.old ? rows.map(row => encodeRow({ kind: 'record', role: 'primary', record: encodeRow(row), references: [] }))
      : rows.map(encodeRow);
    const chunk = { index: options.old ? entries.length + index : index, table, rows: raw };
    const storageId = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify(chunk)], { type: 'application/json' })));
    chunks.push({ chunk, storageId, descriptor: await descriptor(chunk) });
  }
  const source = { townId: 'source-town', publicKey };
  const manifest = { format: options.selective ? 'ai-town-selective-archive' : 'ai-town-chunks', source,
    chunks: chunks.filter(c => !options.old).map(c => c.descriptor) };
  const signature = toBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey,
    new TextEncoder().encode(canonicalJson(manifest)))));
  const manifestStorageId = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify(manifest)])));
  const jobId = await f.t.run(async ctx => {
    const jobId = await ctx.db.insert('backupLargeJobs', {
      kind: options.kind ?? 'import', state: options.state ?? 'COMPLETE', phase: options.state ?? 'COMPLETE',
      tableIndex: 0, cursor: null, chunkCount: entries.length, processedChunks: entries.length,
      recordCount: entries.reduce((n, e) => n + e[1].length, 0), bytes: chunks.reduce((n, c) => n + c.descriptor.bytes, 0),
      createdAt: 1, updatedAt: 1, source, manifestStorageId, signature,
      mode: options.selective ? 'selective-import' : 'restore',
      metadata: options.selective ? { selection: { owners: [{ agentGlobalId: 'selected-owner', worldId: options.sourceWorld ?? f.worldId, playerId: 'p:0' }] },
        targetOwners: [{ sourceAgentGlobalId: 'selected-owner', operation: 'merge', worldId: f.worldId, agentGlobalId: 'selected-owner', playerId: 'p:0' }] } : {},
    });
    for (const c of chunks) await ctx.db.insert('backupLargeChunks', { jobId, ...c.descriptor, storageId: c.storageId });
    if ((options.kind ?? 'import') === 'import' && !options.old && !options.selective) {
      await ctx.db.insert('backupLargeRows', { jobId, role: 'SOURCE', table: 'worlds', sourceId: options.sourceWorld ?? f.worldId,
        chunkIndex: 0, rowIndex: 0, state: 'APPLIED', newId: f.worldId, references: [], metadata: {} });
    }
    return jobId;
  });
  return { jobId, chunks, manifestStorageId };
}
async function inspect(f: Fixture) {
  const scanId = await f.t.mutation(mutationRef('travelPrivacyChunkArchives/startInspection'), { jobId: f.jobId });
  for (let n = 0; n < 500; n++) {
    const scan = await f.t.query(queryRef('travelPrivacyChunkArchives/result'), { scanId });
    if (['READY_TO_REWRITE', 'BLOCKED'].includes(scan!.phase)) return scan!;
    await f.t.action(actionRef('travelPrivacyChunkArchives/inspectPage'), { scanId, revision: scan!.revision });
  }
  throw new Error('Inspection exceeded deterministic page limit');
}
async function selected(f: Fixture, scanId: Id<'travelPrivacyChunkScans'>) {
  return f.t.run(ctx => ctx.db.query('travelPrivacyChunkRows').withIndex('selected', q => q.eq('scanId', scanId).eq('selected', true)).collect());
}

test('scans SOURCE, terminal OLD, and exports without backupImports; plans cross-chunk closure without retaining prose', async () => {
  const f = await fixture();
  for (const options of [{}, { old: true }, { kind: 'export' as const }]) {
    await archive(f, [
      ['residentModelBindings', [binding(f.worldId)]], ['visitLedger', [ledger(f.worldId)]],
      ['memories', [memory(f.worldId, 'source-memory')]],
      ['memories', [{ _id: 'reflection-1', worldId: f.worldId, playerId: 'p:0', agentGlobalId: 'selected-owner',
        description: 'private-reflection', data: { type: 'reflection', relatedMemoryIds: ['source-memory'] } }]],
      ['memories', [{ _id: 'reflection-2', worldId: f.worldId, playerId: 'p:0', agentGlobalId: 'selected-owner',
        data: { type: 'reflection', relatedMemoryIds: ['reflection-1'] } }]],
      ['memorySourceCorrections', [{ _id: 'correction', worldId: f.worldId, playerId: 'p:0', agentGlobalId: 'selected-owner',
        sourceMemoryId: 'source-memory', evidenceMemoryIds: [], text: 'private-correction' }]],
      ['modelMemoryVectors', [{ _id: 'vector', memoryId: 'source-memory', embedding: [1, 2, 3] }]],
    ], options);
  }
  const scan = await inspect(f);
  expect(scan.phase).toBe('READY_TO_REWRITE'); expect(scan.cleanupComplete).toBe(false);
  const rows = await selected(f, scan._id);
  expect(rows).toHaveLength(15);
  expect(new Set(rows.map(r => r.role))).toEqual(new Set(['SOURCE', 'OLD', 'EXPORT']));
  expect(JSON.stringify(rows)).not.toContain('private-'); expect(JSON.stringify(rows)).not.toContain('embedding');
  const objects = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkObjects').withIndex('scan', q => q.eq('scanId', scan._id)).collect());
  expect(objects).toHaveLength(21); expect(objects.every(o => o.state === 'CHECKED')).toBe(true);
  expect(objects.filter(o => o.role !== 'OLD').every(o => o.sourceManifestDigest && o.sourceSignature)).toBe(true);
  for (const object of objects) expect(await f.t.action(async ctx => !!await ctx.storage.get(object.originalStorageId))).toBe(true);
});

test('resumes a chunk exceeding one identifier page and fences old checkpoint calls', async () => {
  const f = await fixture();
  await archive(f, [['residentModelBindings', [binding(f.worldId)]], ['memories',
    Array.from({ length: 25 }, (_, n) => memory(f.worldId, `memory-${n}`))]], { kind: 'export' });
  const scanId = await f.t.mutation(mutationRef('travelPrivacyChunkArchives/startInspection'), { jobId: f.jobId });
  await f.t.action(actionRef('travelPrivacyChunkArchives/inspectPage'), { scanId, revision: 0 });
  await f.t.action(actionRef('travelPrivacyChunkArchives/inspectPage'), { scanId, revision: 0 });
  const scan = await inspect(f);
  expect(scan.objects).toBe(2); expect(scan.rows).toBe(26); expect(scan.selectedRows).toBe(25);
  expect((await selected(f, scanId))).toHaveLength(25);
});

test('persists owner and cross-block shared reflection/correction evidence before blocking', async () => {
  const f = await fixture();
  await archive(f, [['residentModelBindings', [binding(f.worldId), binding(f.worldId, 'other-owner', 'p:1')]],
    ['visitLedger', [ledger(f.worldId)]], ['memories', [memory(f.worldId, 'selected-memory'), memory(f.worldId, 'other-memory', 'other-owner', 'other-visit')]],
    ['memories', [{ _id: 'shared-reflection', worldId: f.worldId, playerId: 'p:0', agentGlobalId: 'selected-owner',
      data: { type: 'reflection', relatedMemoryIds: ['selected-memory', 'other-memory'] } }]],
    ['memorySourceCorrections', [{ _id: 'shared-correction', worldId: f.worldId, playerId: 'p:1', agentGlobalId: 'other-owner',
      sourceMemoryId: 'other-memory', evidenceMemoryIds: ['selected-memory'], text: 'private-shared' }]],
  ], { kind: 'export' });
  const scan = await inspect(f);
  expect(scan.phase).toBe('BLOCKED');
  const rows = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkRows').withIndex('scan', q => q.eq('scanId', scan._id)).collect());
  expect(rows.find(r => r.evidence.sourceId === 'shared-reflection')?.blocker).toBe('SHARED_DERIVED_MEMORY');
  expect(rows.find(r => r.evidence.sourceId === 'shared-correction')?.blocker).toBe('SHARED_CORRECTION');
  expect(rows.find(r => r.evidence.sourceId === 'other-memory')?.selected).toBe(false);
});

test('checks the physical descriptor, records missing or corrupt object evidence, and never deletes sources', async () => {
  const f = await fixture();
  const archived = await archive(f, [['memories', [memory(f.worldId, 'corrupt')]]], { kind: 'export' });
  await f.t.run(async ctx => {
    const chunk = await ctx.db.query('backupLargeChunks').withIndex('job_index', q => q.eq('jobId', archived.jobId)).first();
    await ctx.db.patch(chunk!._id, { digest: 'incorrect-digest' });
  });
  const scan = await inspect(f);
  expect(scan.phase).toBe('BLOCKED');
  const object = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkObjects').withIndex('scan', q => q.eq('scanId', scan._id)).first());
  expect(object?.blockers).toContain('DESCRIPTOR_MISMATCH');
  expect(await f.t.action(async ctx => !!await ctx.storage.get(archived.chunks[0].storageId))).toBe(true);
});

test('active OLD is pending and foreign shared aliases retain actionable reference ids', async () => {
  const f = await fixture();
  const archived = await archive(f, [['residentModelBindings', [binding(f.worldId)]], ['memories', [memory(f.worldId, 'old-memory')]]],
    { old: true, state: 'ROLLING_BACK' });
  const musicId = await f.t.run(ctx => ctx.db.insert('music', { type: 'background', storageId: archived.chunks[1].storageId }));
  const scan = await inspect(f); expect(scan.phase).toBe('BLOCKED');
  const objects = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkObjects').withIndex('scan', q => q.eq('scanId', scan._id)).collect());
  expect(objects.every(o => o.blockers.includes('ACTIVE_BACKUP_PENDING'))).toBe(true);
  expect(objects.find(o => o.descriptor.table === 'memories')?.aliases).toContainEqual({ table: 'music', id: musicId });
});

test('selective source world and owner mapping resolve cross-block bindings and ledger', async () => {
  const f = await fixture(), world = 'source-world';
  await archive(f, [['residentModelBindings', [binding(world)]], ['visitLedger', [ledger(world)]],
    ['memories', [memory(world, 'selective-memory')]]], { selective: true, sourceWorld: world });
  const scan = await inspect(f); expect(scan.phase).toBe('READY_TO_REWRITE');
  expect((await selected(f, scan._id)).map(r => r.evidence.sourceId)).toEqual(['selective-memory']);
});

test('cross-job aliases with different owner mappings cannot publish incompatible replacements', async () => {
  const f = await fixture();
  const archived = await archive(f, [['residentModelBindings', [binding(f.worldId)]], ['memories', [memory(f.worldId, 'shared-memory')]]]);
  await f.t.run(async ctx => {
    const original = (await ctx.db.get(archived.jobId))!;
    const { _id: _unused, _creationTime: _created, ...fields } = original;
    const jobId = await ctx.db.insert('backupLargeJobs', fields);
    for (const c of archived.chunks) await ctx.db.insert('backupLargeChunks', { jobId, ...c.descriptor, storageId: c.storageId });
    await ctx.db.insert('backupLargeRows', { jobId, role: 'SOURCE', table: 'worlds', sourceId: f.worldId,
      newId: f.worldId, chunkIndex: 0, rowIndex: 0, state: 'APPLIED', references: [], metadata: {} });
    await ctx.db.insert('backupLargeGlobalMappings', { jobId, sourceId: 'selected-owner', targetId: 'other-owner' });
  });
  const scan = await inspect(f); expect(scan.phase).toBe('BLOCKED');
  const plans = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkObjects').withIndex('scan', q => q.eq('scanId', scan._id)).collect());
  const memoryPlans = plans.filter(p => p.descriptor.table === 'memories');
  expect(memoryPlans.map(p => p.selectedRows).sort()).toEqual([0, 1]);
  expect(memoryPlans.every(p => p.blockers.includes('SHARED_STORAGE_PLAN_MISMATCH'))).toBe(true);
  expect(memoryPlans.every(p => p.aliases.filter(a => a.table === 'backupLargeChunks').length === 2)).toBe(true);
});

test('shared input and nested OLD storage aliases retain evidence before blocking', async () => {
  const f = await fixture();
  const target = await archive(f, [['residentModelBindings', [binding(f.worldId)]], ['visitLedger', [ledger(f.worldId)]],
    ['federationPendingActions', [{ _id: 'selected-action', inputId: 'shared-input', visitId: 'selected-visit' },
      { _id: 'other-action', inputId: 'shared-input', visitId: 'other-visit' }]],
    ['inputs', [{ _id: 'shared-input', args: { text: 'private-input' } }]],
    ['memories', [memory(f.worldId, 'selected-memory')]]], { kind: 'export' });
  await archive(f, [['coldHistoryArchives', [{ _id: 'nested-archive', worldId: f.worldId,
    ownerGlobalId: 'selected-owner', kind: 'travel', sourceId: 'irrelevant-transcript', storageId: target.chunks[4].storageId }]]], { old: true });
  const scan = await inspect(f); expect(scan.phase).toBe('BLOCKED');
  const rows = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkRows').withIndex('scan', q => q.eq('scanId', scan._id)).collect());
  expect(rows.find(r => r.evidence.sourceId === 'shared-input')?.blocker).toBe('SHARED_INPUT');
  const nested = rows.find(r => r.evidence.sourceId === 'nested-archive')!;
  const plans = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkObjects').withIndex('scan', q => q.eq('scanId', scan._id)).collect());
  const targetPlan = plans.find(p => p.originalStorageId === target.chunks[4].storageId)!;
  expect(targetPlan.aliases).toContainEqual({ table: 'travelPrivacyChunkRows.storage', id: nested._id });
  expect(targetPlan.blockers).toContain('NESTED_STORAGE_ALIAS_REQUIRES_REWRITE');
});

test('source job mutation during inspection invalidates the persisted plan', async () => {
  const f = await fixture();
  const archived = await archive(f, [['residentModelBindings', [binding(f.worldId)]], ['memories', [memory(f.worldId, 'selected-memory')]]], { kind: 'export' });
  const scanId = await f.t.mutation(mutationRef('travelPrivacyChunkArchives/startInspection'), { jobId: f.jobId });
  await f.t.action(actionRef('travelPrivacyChunkArchives/inspectPage'), { scanId, revision: 0 });
  await f.t.run(ctx => ctx.db.patch(archived.jobId, { updatedAt: 3 }));
  const scan = await inspect(f); expect(scan.phase).toBe('BLOCKED');
  const plan = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkObjects').withIndex('scan', q => q.eq('scanId', scanId)).first());
  expect(plan?.blockers).toContain('SOURCE_CHANGED');
});

test('duplicate global binding blocks rather than guessing resident ownership', async () => {
  const f = await fixture();
  await archive(f, [['residentModelBindings', [binding(f.worldId), { ...binding(f.worldId), _id: 'second-binding', playerId: 'p:2' }]],
    ['memories', [memory(f.worldId, 'duplicate-owner-memory')]]], { kind: 'export' });
  const scan = await inspect(f); expect(scan.phase).toBe('BLOCKED');
  const rows = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkRows').withIndex('scan', q => q.eq('scanId', scan._id)).collect());
  expect(rows.find(r => r.evidence.sourceId === 'duplicate-owner-memory')?.blocker).toBe('VISIT_OWNER_EVIDENCE_MISSING');
});

test('new archive objects after the fixed cutoff leave an explicit incomplete-plan fence', async () => {
  const f = await fixture();
  await archive(f, [['residentModelBindings', [binding(f.worldId)]], ['memories', [memory(f.worldId, 'first-memory')]]], { kind: 'export' });
  await f.t.mutation(mutationRef('travelPrivacyChunkArchives/startInspection'), { jobId: f.jobId });
  await archive(f, [['memories', [memory(f.worldId, 'late-memory')]]], { kind: 'export' });
  const scan = await inspect(f); expect(scan.phase).toBe('BLOCKED'); expect(scan.blockerCodes).toContain('SOURCE_SET_CHANGED');
});

test('descriptor metadata changed after physical verification fails the final CAS', async () => {
  const f = await fixture();
  const archived = await archive(f, [['residentModelBindings', [binding(f.worldId)]], ['memories', [memory(f.worldId, 'descriptor-memory')]]], { kind: 'export' });
  const scanId = await f.t.mutation(mutationRef('travelPrivacyChunkArchives/startInspection'), { jobId: f.jobId });
  for (let n = 0; n < 2; n++) {
    const scan = (await f.t.query(queryRef('travelPrivacyChunkArchives/result'), { scanId }))!;
    await f.t.action(actionRef('travelPrivacyChunkArchives/inspectPage'), { scanId, revision: scan.revision });
  }
  await f.t.run(async ctx => {
    const chunk = await ctx.db.query('backupLargeChunks').withIndex('job_index', q => q.eq('jobId', archived.jobId).eq('index', 1)).unique();
    await ctx.db.patch(chunk!._id, { count: chunk!.count + 1, table: 'inputs' });
  });
  const scan = await inspect(f); expect(scan.phase).toBe('BLOCKED');
  const plans = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkObjects').withIndex('scan', q => q.eq('scanId', scanId)).collect());
  expect(plans.some(p => p.blockers.includes('SOURCE_CHANGED'))).toBe(true);
});

test('foreign correction with optional global id cannot inherit selected memory ownership', async () => {
  const f = await fixture();
  await archive(f, [['residentModelBindings', [binding(f.worldId), binding(f.worldId, 'other-owner', 'p:1')]],
    ['memories', [memory(f.worldId, 'selected-memory')]],
    ['memorySourceCorrections', [{ _id: 'foreign-correction', worldId: f.worldId, playerId: 'p:1',
      sourceMemoryId: 'selected-memory', evidenceMemoryIds: [], text: 'private-foreign-correction' }]]], { kind: 'export' });
  const scan = await inspect(f); expect(scan.phase).toBe('BLOCKED');
  const rows = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkRows').withIndex('scan', q => q.eq('scanId', scan._id)).collect());
  expect(rows.find(r => r.evidence.sourceId === 'foreign-correction')?.blocker).toBe('SHARED_MEMORY_DEPENDENCY_OWNER');
  expect(rows.find(r => r.evidence.sourceId === 'foreign-correction')?.selected).toBe(false);
});

test('owner mapping changed between closure and reference checks invalidates selection', async () => {
  const f = await fixture();
  const archived = await archive(f, [['residentModelBindings', [binding(f.worldId)]], ['memories', [memory(f.worldId, 'mapped-memory')]]]);
  const scanId = await f.t.mutation(mutationRef('travelPrivacyChunkArchives/startInspection'), { jobId: f.jobId });
  for (let n = 0; n < 100; n++) {
    const scan = (await f.t.query(queryRef('travelPrivacyChunkArchives/result'), { scanId }))!;
    if (scan.phase === 'CHECK') break;
    await f.t.action(actionRef('travelPrivacyChunkArchives/inspectPage'), { scanId, revision: scan.revision });
  }
  await f.t.run(async ctx => {
    const mapping = await ctx.db.query('backupLargeRows').withIndex('job_role_source', q => q.eq('jobId', archived.jobId)
      .eq('role', 'SOURCE').eq('sourceId', f.worldId)).unique();
    await ctx.db.patch(mapping!._id, { newId: 'foreign-world' });
  });
  const scan = await inspect(f); expect(scan.phase).toBe('BLOCKED');
  const objects = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkObjects').withIndex('scan', q => q.eq('scanId', scan._id)).collect());
  expect(objects.some(o => o.blockers.includes('OWNER_MAPPING_CHANGED'))).toBe(true);
});

test.each(['descriptor', 'global-map', 'job'])('registered %s writers bump the source revision and invalidate an inspection', async change => {
  const f = await fixture();
  const archived = await archive(f, [['residentModelBindings', [binding(f.worldId)]], ['memories', [memory(f.worldId, 'mapped-memory')]]]);
  await f.t.mutation(mutationRef('travelPrivacyChunkArchives/startInspection'), { jobId: f.jobId });
  const before = await f.t.run(ctx => dataRevision(ctx.db, privacyRevisionKey));
  await f.t.run(async ctx => {
    const tracked = withEmbeddingRevision(ctx);
    if (change === 'descriptor') {
      const chunk = await ctx.db.query('backupLargeChunks').withIndex('job_index', q => q.eq('jobId', archived.jobId).eq('index', 0)).unique();
      await tracked.db.patch(chunk!._id, { count: chunk!.count });
    } else if (change === 'global-map') await tracked.db.insert('backupLargeGlobalMappings', { jobId: archived.jobId,
      sourceId: 'selected-owner', targetId: 'selected-owner' });
    else await tracked.db.patch(archived.jobId, { updatedAt: 4 });
  });
  expect(await f.t.run(ctx => dataRevision(ctx.db, privacyRevisionKey))).toBe(before + 1);
  const scan = await inspect(f); expect(scan.phase).toBe('BLOCKED');
  expect(scan.blockerCodes).toContain('SOURCE_REVISION_CHANGED');
});

test.each(['deleted-chunk', 'changed-producer'])('partial indexing checkpoints persist %s as actionable evidence', async change => {
  const f = await fixture();
  const archived = await archive(f, [['residentModelBindings', [binding(f.worldId)]],
    ['memories', Array.from({ length: 25 }, (_, n) => memory(f.worldId, `memory-${n}`))]], { kind: 'export' });
  const scanId = await f.t.mutation(mutationRef('travelPrivacyChunkArchives/startInspection'), { jobId: f.jobId });
  for (let n = 0; n < 2; n++) {
    const scan = (await f.t.query(queryRef('travelPrivacyChunkArchives/result'), { scanId }))!;
    await f.t.action(actionRef('travelPrivacyChunkArchives/inspectPage'), { scanId, revision: scan.revision });
  }
  await f.t.run(async ctx => {
    if (change === 'changed-producer') await ctx.db.patch(archived.jobId, { updatedAt: 2 });
    else {
      const chunk = await ctx.db.query('backupLargeChunks').withIndex('job_index', q => q.eq('jobId', archived.jobId).eq('index', 1)).unique();
      await ctx.db.delete(chunk!._id);
    }
  });
  const scan = await inspect(f); expect(scan.phase).toBe('BLOCKED');
  const objects = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkObjects').withIndex('scan', q => q.eq('scanId', scan._id)).collect());
  expect(objects.some(o => o.blockers.includes('SOURCE_CHANGED'))).toBe(true);
  expect(await f.t.action(async ctx => !!await ctx.storage.get(archived.chunks[1].storageId))).toBe(true);
});

async function sanitizedArchive(f: Fixture) {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  const source = { _id: 'synthetic-identity', _creationTime: 1, townId: 'source-town', publicKey, townName: 'Fixture',
    fingerprint: `sha256:${await digest(publicKey)}`, deploymentInstanceId: 'fixture-instance', deploymentEpoch: 1,
    endpoint: 'https://fixture.invalid/federation/v1', enabled: false, allowIncomingPairRequests: false,
    allowUnencryptedHttp: false, allowPublicHttp: false, maxVisitors: 1, maxVisitDurationMs: 300_000, mode: 'ACTIVE', createdAt: 1 };
  const chunks = largeTables.map((table, index) => ({ index, table, rows:
    (table === 'federationIdentity' ? [source] : table === 'residentModelBindings' ? [{ ...binding(f.worldId), _creationTime: 1, chatProfileId: 'synthetic-profile', createdAt: 1, updatedAt: 1 }] : table === 'memories'
      ? [{ _id: 'retained-visit-memory', _creationTime: 1, worldId: f.worldId, playerId: 'p:0', agentGlobalId: 'selected-owner',
        description: 'synthetic-private-memory', importance: 5, lastAccess: 1, data: { type: 'travel', eventId: 'event',
          visitId: 'second-visit', hostTownId: 'fixture-host', participants: [], occurredAt: 1 } }] : []).map(encodeRow) }));
  const summaries = await Promise.all(chunks.map(descriptor));
  const original: LargeManifest = { format: 'ai-town-chunks', version: 1, schemaVersion: 1, scope: 'town',
    exportId: 'synthetic-export', source, exportedAt: 1, chunks: summaries };
  const signature = toBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey,
    new TextEncoder().encode(canonicalJson(original)))));
  const jobId = await f.t.run(ctx => ctx.db.insert('backupLargeJobs', { kind: 'export', state: 'COMPLETE', phase: 'COMPLETE',
    tableIndex: 0, cursor: null, chunkCount: chunks.length, processedChunks: chunks.length,
    recordCount: 2, bytes: summaries.reduce((n, d) => n + d.bytes, 0), createdAt: 1, updatedAt: 1, source }));
  const manifest = await createLocalChunkManifest({ archiveId: jobId, derivedAt: 2, clearedVisits: ['first-visit'],
    chunks: summaries.map(d => ({ ...d, role: 'EXPORT', encoding: 'RAW' })),
    sourceEvidence: { manifest: original, digest: await digest(original), publicKey, signature,
      manifestStorageId: 'historical-source-storage-no-longer-present' } });
  const manifestStorageId = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify(manifest)])));
  await f.t.run(ctx => ctx.db.patch(jobId, { archivePrivacyState: 'LOCAL_SANITIZED', manifestStorageId,
    metadata: { archiveLocalManifestDigest: '' } }));
  await f.t.run(async ctx => ctx.db.patch(jobId, { metadata: { archiveLocalManifestDigest: await digest(manifest) } }));
  for (const [index, chunk] of chunks.entries()) {
    const storageId = await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify(chunk)])));
    await f.t.run(ctx => ctx.db.insert('backupLargeChunks', { jobId, ...summaries[index], storageId }));
  }
  return { jobId, manifest, manifestStorageId };
}

test('second visit inspection validates the pinned derivative while retaining original signed source evidence', async () => {
  const f = await fixture(), archived = await sanitizedArchive(f);
  await f.t.run(ctx => ctx.db.patch(f.jobId, { visitId: 'second-visit' }));
  const scan = await inspect(f);
  expect(scan.phase).toBe('READY_TO_REWRITE');
  const rows = await selected(f, scan._id);
  expect(rows.map(row => row.evidence.sourceId)).toEqual(['retained-visit-memory']);
  const objects = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkObjects').withIndex('scan', q => q.eq('scanId', scan._id)).collect());
  expect(objects.every(o => o.sourceManifestDigest === archived.manifest.sourceEvidence.digest)).toBe(false);
  expect(objects.every(o => o.sourceManifestStorageId === archived.manifestStorageId)).toBe(true);
  expect(objects.every(o => o.sourceSignature === archived.manifest.sourceEvidence.signature)).toBe(true);
});

test('second visit inspection blocks tampered local manifest authentication', async () => {
  const f = await fixture(), archived = await sanitizedArchive(f);
  await f.t.run(ctx => ctx.db.patch(archived.jobId, { metadata: { archiveLocalManifestDigest: 'A'.repeat(43) + '=' } }));
  const scan = await inspect(f);
  expect(scan.phase).toBe('BLOCKED');
  const objects = await f.t.run(ctx => ctx.db.query('travelPrivacyChunkObjects').withIndex('scan', q => q.eq('scanId', scan._id)).collect());
  expect(objects.every(o => o.blockers.includes('LOCAL_ARCHIVE_DIGEST_MISMATCH'))).toBe(true);
});

test('inspection retry reuses the newest matching parent revision scan', async () => {
  const f = await fixture();
  const first = await f.t.mutation(mutationRef('travelPrivacyChunkArchives/startInspection'), { jobId: f.jobId });
  await f.t.run(ctx => ctx.db.patch(f.jobId, { revision: 1 }));
  const second = await f.t.mutation(mutationRef('travelPrivacyChunkArchives/startInspection'), { jobId: f.jobId });
  const retry = await f.t.mutation(mutationRef('travelPrivacyChunkArchives/startInspection'), { jobId: f.jobId });
  expect(second).not.toBe(first);
  expect(retry).toBe(second);
});

test('conversation deletion scope preserves every bounded participant and rejects truncation', () => {
  const row = { _id: 'conversation-row', id: 'c:1', worldId: 'world', participants: ['p:0', 'p:1'] };
  expect(inspectionEvidence('archivedConversations', encodeRow(row), 0, false))
    .toMatchObject({ conversationId: 'c:1', conversationPlayerIds: ['p:0', 'p:1'] });
  for (const participants of [Array.from({ length: 101 }, (_, index) => `p:${index}`), ['p:0', 1], undefined])
    expect(() => inspectionEvidence('archivedConversations', encodeRow({ ...row, participants }), 0, false))
      .toThrow('CHUNK_CONVERSATION_PARTICIPANTS_INVALID');
});
