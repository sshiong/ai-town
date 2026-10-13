import { jest } from '@jest/globals';
import { getFunctionName } from 'convex/server';
import { page as archivePage } from './travelPrivacyArchives';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { actionRef, mutationRef, queryRef } from './refs';
import { createBundle, dataTables, decodeRow, encodeRow, snapshotTables, validateBundle, type BackupBundle, type BackupRow } from './backupHelpers';
import { descriptor } from './backupLargeHelpers';
import { canonicalJson } from './protocol';
import { digest, toBase64, verifySignature } from './security';
import { withEmbeddingRevision } from '../models/embeddingDataRevision';
import type { Doc, Id } from '../_generated/dataModel';
import type { LocalPrivacyArchive } from './travelPrivacyArchives';
import type { ColdBackupAttachment } from './coldBackup';

const modules = {
  '../federation/archiveUploadProvenance.ts': () => import('./archiveUploadProvenance'),
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/travelPrivacy.ts': () => import('./travelPrivacy'),
  '../federation/travelPrivacyArchives.ts': () => import('./travelPrivacyArchives'),
  '../federation/travelPrivacyChunkCoordinator.ts': () => import('./travelPrivacyChunkCoordinator'),
  '../federation/travelPrivacyChunkArchives.ts': () => import('./travelPrivacyChunkArchives'),
  '../federation/travelPrivacyChunkRewrite.ts': () => import('./travelPrivacyChunkRewrite'),
  '../federation/travelPrivacyChunkReferenceProof.ts': () => import('./travelPrivacyChunkReferenceProof'),
};
const adminToken = 'archive-privacy-test-administrator';
type Test = ReturnType<typeof convexTest<typeof schema.tables>>;
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(2_000_000); process.env.FEDERATION_ADMIN_TOKEN = adminToken; });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
const storageText = (t: Test, id: Id<'_storage'>) => t.action(async ctx => (await ctx.storage.get(id))?.text() ?? null);
const currentJob = (t: Test, jobId: Id<'travelPrivacyJobs'>) => t.run(ctx => ctx.db.get(jobId));
async function step(t: Test, jobId: Id<'travelPrivacyJobs'>) {
  const job = (await currentJob(t, jobId))!;
  const args = { jobId, revision: job.revision };
  if (job.phase.startsWith('CHUNK_')) await t.action(actionRef('travelPrivacyChunkCoordinator/page'), args);
  else if (job.phase.startsWith('ARCHIVE_')) await t.action(actionRef('travelPrivacyArchives/page'), args);
  else await t.mutation(mutationRef('travelPrivacy/page'), args);
}
async function until(t: Test, jobId: Id<'travelPrivacyJobs'>, check: (job: Doc<'travelPrivacyJobs'>) => boolean) {
  for (let i = 0; i < 500; i++) {
    const job = (await currentJob(t, jobId))!;
    if (check(job)) return job;
    if (job.archiveError) throw new Error(job.archiveError);
    await step(t, jobId);
  }
  throw new Error('Privacy fixture exceeded its deterministic page budget');
}
async function fixture(options: { history?: boolean; unsigned?: boolean; cold?: boolean; conflict?: string } = {}) {
  const t = convexTest(schema, modules);
  const local = await t.run(async ctx => {
    const worldId = await ctx.db.insert('worlds', { nextId: 1, players: [], agents: [], conversations: [] });
    const chatProfileId = await ctx.db.insert('chatProfiles', { name: 'archive fixture', provider: 'openai', url: 'https://fixture.invalid', model: 'fixture',
      stopWords: [], createdAt: 1 });
    await ctx.db.insert('residentModelBindings', { worldId, playerId: 'p:0', agentGlobalId: 'resident', chatProfileId, createdAt: 1, updatedAt: 1 });
    await ctx.db.insert('federationAgentRuntimes', { worldId, playerId: 'p:0', agentId: 'a:0', agentGlobalId: 'resident',
      homeTownId: 'local', state: 'HOME_ACTIVE', agentAuthorityEpoch: 1, updatedAt: 1 });
    const ledger = { visitId: 'selected', agentGlobalId: 'resident', worldId, homePlayerId: 'p:0',
      homeTownId: 'home', hostTownId: 'host', homeDeploymentEpoch: 1, hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 1, visitLeaseVersion: 1, leaseExpiry: 1, fencingToken: 'local-fixture-fence',
      state: 'COMPLETED', role: 'home', profile: {}, createdAt: 1, updatedAt: 1 };
    const ledgerId = options.history ? undefined : await ctx.db.insert('visitLedger', ledger);
    const memoryId = await ctx.db.insert('memories', { worldId, playerId: 'p:0', agentGlobalId: 'resident',
      description: 'native-selected-body', importance: 5, lastAccess: 1,
      data: { type: 'travel', visitId: 'selected', eventId: 'native-event', hostTownId: 'host', messageText: 'native-selected-text',
        participants: [], occurredAt: 1 } });
    const otherId = await ctx.db.insert('memories', { worldId, playerId: 'p:0', agentGlobalId: 'resident',
      description: 'native-other-body', importance: 5, lastAccess: 1,
      data: { type: 'travel', visitId: 'other', eventId: 'other-event', hostTownId: 'host', participants: [], occurredAt: 1 } });
    return { worldId, memoryId, otherId, ledgerId };
  });
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  const signValue = async (value: unknown) => toBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey,
    new TextEncoder().encode(canonicalJson(value)))));
  const ledger = { _id: 'source-ledger', worldId: 'source-world', agentGlobalId: 'source-resident', homePlayerId: 'p:0',
    visitId: 'selected', role: 'home', state: 'COMPLETED', leaseExpiry: 1, agentAuthorityEpoch: 3, visitLeaseVersion: 2 };
  const travel = (id: string, visitId: string, owner: string, playerId: string, text: string, transcriptId?: string) => ({
    _id: id, worldId: 'source-world', agentGlobalId: owner, playerId, description: text, importance: 5, lastAccess: 1,
    data: { type: 'travel', visitId, eventId: id, hostTownId: 'host', messageText: text, participants: [], occurredAt: 1,
      ...(transcriptId ? { transcriptId, federationConversationId: `federation-${visitId}` } : {}) },
  });
  const selectedMemory = travel('source-memory', 'selected', 'source-resident', 'p:0', 'archive-selected-memory', 'source-transcript');
  const otherMemory = travel('source-other', 'other', 'source-resident', 'p:0', 'other-visit-memory', 'other-transcript');
  const transcript = (id: string, visitId: string) => ({ _id: id, worldId: 'source-world', playerId: 'p:0', agentGlobalId: 'source-resident',
    transcriptId: id === 'source-transcript-row' ? 'source-transcript' : 'other-transcript', visitId, hostTownId: 'host',
    federationConversationId: `federation-${visitId}`, endedAt: 1, state: 'COMPLETE', summaryState: 'DONE', finalPageNumber: 0, totalMessageCount: 1 });
  const page = (id: string, transcriptId: string, visitId: string, text: string) => ({ _id: id,
    agentGlobalId: 'source-resident', transcriptId, visitId, pageNumber: 0, finalPage: true,
    messages: [{ messageId: `${visitId}-message`, author: 'source-resident', text, occurredAt: 1 }] });
  const rows: Record<string, BackupRow[]> = Object.fromEntries([...dataTables, ...snapshotTables].map(name => [name, []]));
  Object.assign(rows, {
    worlds: [{ _id: 'source-world', nextId: 1, players: [], agents: [], conversations: [] }],
    federationIdentity: [{ _id: 'source-identity', townId: 'source-town', publicKey }],
    residentModelBindings: [{ _id: 'source-binding', worldId: 'source-world', playerId: 'p:0', agentGlobalId: 'source-resident' },
      { _id: 'other-binding', worldId: 'source-world', playerId: 'p:1', agentGlobalId: 'other-resident' }],
    visitLedger: [ledger, { ...ledger, _id: 'other-ledger', visitId: 'other' }],
    memories: [selectedMemory, otherMemory, travel('other-owner-memory', 'foreign', 'other-resident', 'p:1', 'other-owner-memory'),
      { _id: 'source-reflection', worldId: 'source-world', playerId: 'p:0', agentGlobalId: 'source-resident',
        description: 'archive-selected-reflection', data: { type: 'reflection', relatedMemoryIds: ['source-memory'] } }],
    modelMemoryVectors: [{ _id: 'selected-vector', memoryId: 'source-memory', embedding: [7, 9] },
      { _id: 'other-vector', memoryId: 'source-other', embedding: [3, 4] }],
    federationEventFacts: [{ _id: 'selected-fact', visitId: 'selected', messageId: 'fact-message', payload: { eventId: 'selected-event', text: 'archive-selected-fact' } },
      { _id: 'other-fact', visitId: 'other', payload: { text: 'other-fact-body' } }],
    federationActionFacts: [{ _id: 'selected-action-fact', visitId: 'selected', actionId: 'stable-action', action: { type: 'say', text: 'archive-selected-action' },
      result: { kind: 'ok', value: 'archive-selected-result' }, receiptPayload: { actionId: 'stable-action', text: 'archive-selected-receipt' } }],
    federationPendingActions: [{ _id: 'selected-pending', visitId: 'selected', inputId: 'selected-input', action: { type: 'say', text: 'archive-selected-pending' },
      result: { kind: 'ok', value: 'archive-selected-pending-result' } }],
    inputs: [{ _id: 'selected-input', args: { text: 'archive-selected-input' }, returnValue: { kind: 'ok', value: 'archive-selected-return' } },
      { _id: 'other-input', args: { text: 'other-input-body' } }],
    federationInbox: [{ _id: 'selected-inbox', payloadDigest: 'original-replay-digest', ack: { status: 'COMMITTED' },
      envelope: { visitId: 'selected', type: 'OBSERVATION', payload: { eventId: 'selected-event', text: 'archive-selected-inbox' } } }],
    federationOutbox: [{ _id: 'selected-outbox', envelope: { visitId: 'selected', type: 'DECISION', payload: { text: 'archive-selected-outbox' } } }],
    federationDecisionJobs: [{ _id: 'selected-decision-job', visitId: 'selected', observation: { text: 'archive-selected-observation' }, error: 'archive-selected-error' }],
    autonomousTravelDecisions: [{ _id: 'selected-autonomy', visitId: 'selected', state: 'COMPLETED', reason: 'archive-selected-reason', error: 'archive-selected-error' }],
    federationTravelAudit: [{ _id: 'selected-audit', visitId: 'selected', previous: { state: 'RETURN_PENDING', text: 'archive-selected-audit' }, next: { state: 'COMPLETED' } }],
    federationTurns: [{ _id: 'selected-turn', worldId: 'source-world', visitId: 'selected', conversationId: 'c:1' }],
    messages: [{ _id: 'selected-message', worldId: 'source-world', conversationId: 'c:1', text: 'archive-selected-message' },
      { _id: 'other-message', worldId: 'source-world', conversationId: 'c:2', text: 'other-message-body' }],
    homeTravelTranscripts: [transcript('source-transcript-row', 'selected'), transcript('other-transcript-row', 'other')],
    homeTravelTranscriptPages: [page('selected-page', 'source-transcript', 'selected', 'archive-selected-cold'),
      page('other-page', 'other-transcript', 'other', 'other-cold-body')],
  });
  if (options.conflict === 'foreign-reflection') rows.memories[3] = { ...rows.memories[3], playerId: 'p:1', agentGlobalId: 'other-resident' };
  if (options.conflict === 'mixed-reflection') rows.memories[3].data.relatedMemoryIds.push('source-other');
  if (options.conflict === 'shared-input') rows.federationPendingActions.push({ _id: 'foreign-pending', visitId: 'other', inputId: 'selected-input' });
  if (options.conflict === 'missing-ledger') rows.visitLedger = rows.visitLedger.filter(row => row.visitId !== 'selected');
  if (options.conflict === 'duplicate-global-binding') rows.residentModelBindings.push({ _id: 'duplicate-binding', worldId: 'source-world', playerId: 'p:2', agentGlobalId: 'source-resident' });
  if (options.conflict === 'contradictory-global-binding') rows.residentModelBindings[0].playerId = 'p:2';
  if (options.conflict === 'contradictory-binding') rows.residentModelBindings[0].agentGlobalId = 'other-resident';
  let bundle = await createBundle('source-town', 'town', rows);
  bundle.manifest.includeVectors = true;
  if (options.cold !== false && !options.unsigned) {
    const files: ColdBackupAttachment[] = [];
    for (const [memory, selected] of [[selectedMemory, true], [otherMemory, false]] as const) {
      const sourceKey = JSON.stringify(['travel', 'source-world', 'source-resident', memory.data.transcriptId, 'host', 1]);
      const payload = { format: 'ai-town-cold-history' as const, version: 1 as const, sourceKey,
        messages: [{ messageId: `${memory.data.visitId}-message`, text: selected ? 'archive-selected-cold' : 'other-cold-body',
          authorGlobalId: 'source-resident', occurredAt: 1 }] };
      const manifest = { format: 'ai-town-cold-history' as const, version: 1 as const, schemaVersion: 1 as const,
        sourceTownId: 'source-town', sourceKey, kind: 'travel' as const, sourceId: memory.data.transcriptId!, exportedAt: 1,
        count: 1, bytes: new TextEncoder().encode(JSON.stringify(payload)).length, digest: await digest(payload) };
      files.push({ owner: { worldId: 'source-world', playerId: 'p:0', agentGlobalId: 'source-resident', memoryId: memory._id },
        file: { format: 'ai-town-cold-history-file', version: 1, manifest, publicKey, signature: await signValue(manifest), payload }, authorAliases: [] });
    }
    bundle.coldHistoryFiles = files;
    bundle.manifest.coldHistoryFiles = { count: files.length, bytes: new TextEncoder().encode(JSON.stringify(files)).length, digest: await digest(files) };
  }
  if (options.conflict === 'manifest-body') (bundle.manifest as any).privateBody = 'archive-selected-manifest-body';
  if (options.conflict === 'summary-body') (bundle.manifest.sections.memories as any).privateBody = 'archive-selected-summary-body';
  if (!options.unsigned) bundle.signature = await signValue(bundle.manifest);
  await validateBundle(bundle);
  if (options.conflict === 'signature') bundle = { ...bundle, signature: 'invalid-fixture-signature' };
  if (options.conflict === 'checksum') bundle.sections.memories[0] = encodeRow({ ...selectedMemory, description: 'changed-body' });
  const storageId = await t.action(ctx => ctx.storage.store(new Blob([JSON.stringify(bundle)])));
  const importId = await t.run(ctx => ctx.db.insert('backupImports', { sourceTownId: 'source-town', mode: 'restore', exportedAt: 1, importedAt: 2,
    mapping: { 'source-world': local.worldId, 'source-resident': 'resident', 'source-memory': local.memoryId, 'source-other': local.otherId },
    runtimeSnapshot: { visitLedger: rows.visitLedger.map(encodeRow) }, manifest: { ...bundle.manifest, vectorSourceTrusted: true, vectorArchiveStorageId: storageId } }));
  return { t, ...local, storageId, importId, bundle, history: options.history ? { importId, worldId: local.worldId, ownerGlobalId: 'resident' } : undefined };
}
async function preview(f: Awaited<ReturnType<typeof fixture>>, scope: 'CACHE' | 'SENSITIVE' = 'SENSITIVE') {
  const jobId: Id<'travelPrivacyJobs'> = await f.t.mutation(mutationRef('travelPrivacy/inspect'), { adminToken, visitId: 'selected', scope,
    ...(f.history ? { history: f.history } : {}) });
  const report = await until(f.t, jobId, job => ['READY', 'BLOCKED'].includes(job.state));
  return { jobId, report };
}
async function readLocal(f: Awaited<ReturnType<typeof fixture>>) {
  const imported = (await f.t.run(ctx => ctx.db.get(f.importId)))!;
  const text = await storageText(f.t, imported.localArchiveStorageId!);
  return { imported, archive: JSON.parse(text!) as LocalPrivacyArchive };
}

test.each([false, true])('ordinary signed mixed bundle is physically cleared before native purge; history=%s', async history => {
  const f = await fixture({ history }), { jobId, report } = await preview(f);
  expect(report.state).toBe('READY');
  expect(await storageText(f.t, f.storageId)).not.toBeNull();
  await f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  expect((await f.t.run(ctx => ctx.db.get(f.importId)))!.archivePrivacyState).toBe('REWRITING');
  await step(f.t, jobId);
  expect((await currentJob(f.t, jobId))!.phase).toBe('ARCHIVE_REWRITE');
  expect(await f.t.run(ctx => ctx.db.get(f.memoryId))).not.toBeNull();
  expect(await storageText(f.t, f.storageId)).not.toBeNull();
  const { imported, archive } = await readLocal(f);
  expect(imported.manifest).not.toHaveProperty('vectorArchiveStorageId');
  expect(imported.manifest.sections).toEqual(f.bundle.manifest.sections);
  expect(imported.archiveSourceEvidence!.signature).toBe(f.bundle.signature);
  expect(await verifySignature(imported.archiveSourceEvidence!.manifest, imported.archiveSourceEvidence!.signature,
    imported.archiveSourceEvidence!.sourcePublicKey)).toBe(true);
  expect(archive.sourceSignatureValid).toBe(false);
  expect(archive).not.toHaveProperty('signature');
  await expect(validateBundle(archive)).rejects.toThrow('UNSUPPORTED_BACKUP_MANIFEST');
  expect(JSON.stringify(archive)).not.toContain('archive-selected-');
  for (const value of ['other-visit-memory', 'other-owner-memory', 'other-message-body', 'other-input-body', 'other-fact-body', 'other-cold-body'])
    expect(JSON.stringify(archive)).toContain(value);
  const rows = (table: string) => archive.sections[table].map(decodeRow);
  for (const [table, ids] of Object.entries({
    memories: ['source-other', 'other-owner-memory'], modelMemoryVectors: ['other-vector'],
    federationEventFacts: ['other-fact'], inputs: ['other-input'], messages: ['other-message'],
    homeTravelTranscripts: ['other-transcript-row'], homeTravelTranscriptPages: ['other-page'],
  })) expect(rows(table).filter(row => ids.includes(row._id)))
    .toEqual(f.bundle.sections[table].map(decodeRow).filter(row => ids.includes(row._id)));
  for (const table of ['worlds', 'federationIdentity', 'residentModelBindings'])
    expect(archive.sections[table]).toEqual(f.bundle.sections[table]);
  expect(rows('visitLedger')).toEqual(f.bundle.sections.visitLedger.map(decodeRow));
  expect(rows('federationInbox')[0]).toMatchObject({ payloadDigest: 'original-replay-digest', ack: { status: 'COMMITTED' } });
  expect(rows('modelMemoryVectors')).toEqual(f.bundle.sections.modelMemoryVectors.slice(1).map(decodeRow));
  expect(archive.coldHistoryFiles).toEqual(f.bundle.coldHistoryFiles!.slice(1));
  await step(f.t, jobId);
  expect(await storageText(f.t, f.storageId)).toBeNull();
  expect(await f.t.run(ctx => ctx.db.system.get(f.storageId))).toBeNull();
  expect((await f.t.run(ctx => ctx.db.get(f.importId)))!.archivePrivacyState).toBe('LOCAL_SANITIZED');
  await until(f.t, jobId, job => job.state === 'COMPLETE');
  expect(await f.t.run(ctx => ctx.db.get(f.memoryId))).toBeNull();
  expect(await f.t.run(ctx => ctx.db.get(f.otherId))).not.toBeNull();
  if (history) {
    const candidates = await f.t.query(queryRef('travelPrivacy/historicalCandidates'), { adminToken, visitId: 'selected', paginationOpts: { cursor: null, numItems: 5 } });
    expect(candidates.page[0].history).toEqual(f.history);
  } else expect(await f.t.run(ctx => ctx.db.get(f.ledgerId!))).not.toBeNull();
  const completed = (await currentJob(f.t, jobId))!;
  const scan = await f.t.run(ctx => ctx.db.get(completed.chunkScanId!));
  expect(scan!.phase).toBe('READY_TO_REWRITE');
  expect(scan!.objects).toBe(0);
  expect(scan!.selectedRows).toBe(0);
  expect(completed.archiveCoverage).toEqual({ ordinaryBundles: 'COMPLETE', largeChunks: 'COMPLETE', orphanObjects: 'NOT_VERIFIED' });
});

test('unsigned legacy bundle uses its published import mapping and checksum without inventing a source signature', async () => {
  const f = await fixture({ unsigned: true }), { jobId, report } = await preview(f);
  expect(report.state).toBe('READY');
  await f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await until(f.t, jobId, job => job.state === 'COMPLETE');
  expect((await readLocal(f)).imported.archiveSourceEvidence!.signature).toBe('');
  expect(await storageText(f.t, f.storageId)).toBeNull();
});

test.each(['signature', 'checksum', 'missing-ledger', 'shared-input', 'mixed-reflection', 'foreign-reflection', 'contradictory-binding', 'duplicate-global-binding', 'contradictory-global-binding', 'manifest-body', 'summary-body'])
  ('archive %s conflict blocks before changing any source object or native memory', async conflict => {
    const f = await fixture({ conflict, cold: false }), { jobId, report } = await preview(f);
    expect(report.state).toBe('BLOCKED');
    expect(report.blockers.some(code => code.startsWith('ARCHIVE_'))).toBe(true);
    if (['manifest-body', 'summary-body'].includes(conflict)) {
      expect(report.blockers).toContain('ARCHIVE_MANIFEST_METADATA_INVALID');
      expect(await verifySignature(f.bundle.manifest, f.bundle.signature!, decodeRow(f.bundle.sections.federationIdentity[0]).publicKey)).toBe(true);
      expect(JSON.parse((await storageText(f.t, f.storageId))!)).toEqual(f.bundle);
    }
    await expect(f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId })).rejects.toThrow('TRAVEL_PRIVACY_PREFLIGHT_BLOCKED');
    expect((await f.t.run(ctx => ctx.db.get(f.importId)))!.archivePrivacyState).toBeUndefined();
    expect(await storageText(f.t, f.storageId)).not.toBeNull();
    expect(await f.t.run(ctx => ctx.db.get(f.memoryId))).not.toBeNull();
  });

test('shared imports with identical mapping are paginated, migrated together, and their old blob is deleted once', async () => {
  const f = await fixture();
  const refs = await f.t.run(async ctx => {
    const imported = (await ctx.db.get(f.importId))!, { _id, _creationTime, ...fields } = imported;
    for (let i = 0; i < 30; i++) await ctx.db.insert('backupImports', { ...fields, manifest: {}, runtimeSnapshot: {}, mapping: {} });
    const ids = [f.importId];
    for (let i = 0; i < 11; i++) ids.push(await ctx.db.insert('backupImports', { ...fields,
      manifest: { ...fields.manifest, vectorSourceTrusted: i % 2 === 0 } }));
    return ids;
  });
  const { jobId, report } = await preview(f);
  expect(report.state).toBe('READY');
  const journal = await f.t.run(ctx => ctx.db.query('travelPrivacyArchiveObjects').withIndex('job', q => q.eq('jobId', jobId)).collect());
  expect(journal).toHaveLength(1);
  expect(journal[0].references.map(ref => ref.importId).sort()).toEqual([...refs].sort());
  await f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await until(f.t, jobId, job => job.state === 'COMPLETE');
  const imports = await f.t.run(async ctx => Promise.all(refs.map(id => ctx.db.get(id))));
  expect(new Set(imports.map(row => row!.localArchiveStorageId)).size).toBe(1);
  expect(imports.every(row => row!.archivePrivacyState === 'LOCAL_SANITIZED' && row!.archiveRevision === 1)).toBe(true);
  expect(await storageText(f.t, f.storageId)).toBeNull();
});

test('a shared old blob with a different owner mapping blocks instead of changing the other import', async () => {
  const f = await fixture();
  const otherId = await f.t.run(async ctx => {
    const { _id, _creationTime, ...fields } = (await ctx.db.get(f.importId))!;
    return ctx.db.insert('backupImports', { ...fields, mapping: { ...fields.mapping, 'source-resident': 'foreign-owner' } });
  });
  const before = await f.t.run(ctx => ctx.db.get(otherId));
  const { report } = await preview(f);
  expect(report.state).toBe('BLOCKED');
  expect(report.blockers).toContain('ARCHIVE_SHARED_STORAGE');
  expect(await f.t.run(ctx => ctx.db.get(otherId))).toEqual(before);
  expect(await storageText(f.t, f.storageId)).not.toBeNull();
});

test.each(['pointer', 'revision', 'mapping'])('a ready archive %s change rejects start before installing tombstones', async change => {
  const f = await fixture(), { jobId } = await preview(f);
  await f.t.run(async ctx => {
    const row = (await ctx.db.get(f.importId))!;
    const update = change === 'pointer' ? { manifest: { ...row.manifest, vectorArchiveStorageId: undefined } }
      : change === 'revision' ? { archiveRevision: 8 } : { mapping: { ...row.mapping, 'source-resident': 'changed-owner' } };
    await withEmbeddingRevision(ctx).db.patch(f.importId, update);
  });
  await expect(f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId })).rejects.toThrow('TRAVEL_PRIVACY_PREVIEW_STALE');
  expect(await f.t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toEqual([]);
  expect(await storageText(f.t, f.storageId)).not.toBeNull();
});

test('a deletion blocker preserves the RUNNING checkpoint and retry completes without replaying old revision actions', async () => {
  const f = await fixture(), { jobId } = await preview(f);
  await f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  const oldRevision = (await currentJob(f.t, jobId))!.revision;
  await step(f.t, jobId);
  const blockerId = await f.t.run(ctx => ctx.db.insert('music', { storageId: f.storageId, type: 'background' }));
  await step(f.t, jobId);
  const failed = (await currentJob(f.t, jobId))!;
  expect(failed.state).toBe('RUNNING');
  expect(failed.phase).toBe('ARCHIVE_REWRITE');
  expect(failed.archiveError).toBe('ARCHIVE_SHARED_STORAGE');
  expect(await storageText(f.t, f.storageId)).not.toBeNull();
  expect(await f.t.run(ctx => ctx.db.get(f.memoryId))).not.toBeNull();
  const published = (await readLocal(f)).imported.localArchiveStorageId;
  await f.t.action(actionRef('travelPrivacyArchives/page'), { jobId, revision: oldRevision });
  expect((await readLocal(f)).imported.localArchiveStorageId).toBe(published);
  await f.t.run(ctx => ctx.db.delete(blockerId));
  await f.t.mutation(mutationRef('travelPrivacy/retry'), { adminToken, jobId });
  await until(f.t, jobId, job => job.state === 'COMPLETE');
  expect(await storageText(f.t, f.storageId)).toBeNull();
  expect((await readLocal(f)).imported.localArchiveStorageId).toBe(published);
  const journal = await f.t.run(ctx => ctx.db.query('travelPrivacyArchiveObjects').withIndex('job', q => q.eq('jobId', jobId)).collect());
  expect(journal[0].state).toBe('DELETED');
});

test('replacement corruption prevents old object deletion and native purge', async () => {
  const f = await fixture(), { jobId } = await preview(f);
  await f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await step(f.t, jobId);
  const imported = (await readLocal(f)).imported;
  await f.t.action(ctx => ctx.storage.delete(imported.localArchiveStorageId!));
  await step(f.t, jobId);
  expect((await currentJob(f.t, jobId))!.archiveError).toBe('ARCHIVE_REPLACEMENT_MISSING');
  expect((await currentJob(f.t, jobId))!.state).toBe('RUNNING');
  expect(await storageText(f.t, f.storageId)).not.toBeNull();
  expect(await f.t.run(ctx => ctx.db.get(f.memoryId))).not.toBeNull();
});

test('a second visit clear rewrites the local archive while retaining the original source manifest evidence', async () => {
  const f = await fixture(), { jobId } = await preview(f);
  await f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await until(f.t, jobId, job => job.state === 'COMPLETE');
  const before = (await readLocal(f)).imported;
  await f.t.run(async ctx => {
    const ledger = (await ctx.db.get(f.ledgerId!))!, { _id, _creationTime, ...fields } = ledger;
    await ctx.db.insert('visitLedger', { ...fields, visitId: 'other' });
  });
  const secondId: Id<'travelPrivacyJobs'> = await f.t.mutation(mutationRef('travelPrivacy/inspect'), { adminToken, visitId: 'other', scope: 'SENSITIVE' });
  expect((await until(f.t, secondId, job => ['READY', 'BLOCKED'].includes(job.state))).state).toBe('READY');
  await f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId: secondId });
  await until(f.t, secondId, job => job.state === 'COMPLETE');
  const after = await readLocal(f);
  expect(after.imported.archiveSourceEvidence).toEqual(before.archiveSourceEvidence);
  expect(after.imported.archiveRevision).toBe(2);
  expect(await storageText(f.t, before.localArchiveStorageId!)).toBeNull();
  expect(JSON.stringify(after.archive)).not.toContain('other-visit-memory');
  expect(JSON.stringify(after.archive)).toContain('other-owner-memory');
  expect(after.archive.clearedVisits).toEqual(['other', 'selected']);
});

test('CACHE scope leaves the full archive pointer, signed bytes and native memories unchanged', async () => {
  const f = await fixture(), { jobId, report } = await preview(f, 'CACHE');
  expect(report.state).toBe('READY');
  await f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  await until(f.t, jobId, job => job.state === 'COMPLETE');
  const row = (await f.t.run(ctx => ctx.db.get(f.importId)))!;
  expect(row.manifest.vectorArchiveStorageId).toBe(f.storageId);
  expect(row.archivePrivacyState).toBeUndefined();
  expect(await f.t.run(ctx => ctx.db.get(f.memoryId))).not.toBeNull();
  const blob = await storageText(f.t, f.storageId);
  expect(JSON.parse(blob!)).toEqual(f.bundle);
  expect(await f.t.run(ctx => ctx.db.query('travelPrivacyArchiveObjects').collect())).toEqual([]);
});


test.each(['upload-verification', 'before-publication', 'after-publication'] as const)
  ('%s failure fences replacement cleanup and resumes from its durable journal', async failure => {
    const f = await fixture(), { jobId } = await preview(f);
    await f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
    const revision = (await currentJob(f.t, jobId))!.revision;
    let uploaded: Id<'_storage'> | undefined, injected = false;
    let publication: { objectId: Id<'travelPrivacyArchiveObjects'>; storageId: Id<'_storage'>; replacementDigest: string } | undefined;
    await f.t.action(async ctx => (archivePage as any)._handler({ ...ctx,
      storage: { ...ctx.storage,
        store: async (blob: Blob) => { uploaded = await ctx.storage.store(blob); return uploaded; },
        get: async (id: Id<'_storage'>) => {
          if (failure === 'upload-verification' && id === uploaded) {
            injected = true;
            return new Blob(['{}']);
          }
          return ctx.storage.get(id);
        },
      },
      runMutation: async (ref: any, args: any) => {
        if (getFunctionName(ref).endsWith(':publish')) {
          publication = args;
          injected = true;
          if (failure === 'before-publication') throw new Error('SIMULATED_PUBLICATION_ACK_LOST');
          const result = await ctx.runMutation(ref, args);
          if (failure === 'after-publication') throw new Error('SIMULATED_PUBLICATION_ACK_LOST');
          return result;
        }
        return ctx.runMutation(ref, args);
      },
    }, { jobId, revision }));
    expect(injected).toBe(true);
    expect(uploaded).toBeDefined();
    expect(await storageText(f.t, f.storageId)).not.toBeNull();
    expect(await f.t.run(ctx => ctx.db.get(f.memoryId))).not.toBeNull();
    const failed = (await currentJob(f.t, jobId))!;
    expect(failed.state).toBe('RUNNING');
    expect(failed.revision).toBeGreaterThan(revision);
    const plan = await f.t.run(ctx => ctx.db.query('travelPrivacyArchiveObjects').withIndex('job', q => q.eq('jobId', jobId)).unique());
    if (failure === 'after-publication') {
      expect(plan!.state).toBe('PUBLISHED');
      expect((await readLocal(f)).imported.localArchiveStorageId).toBe(uploaded);
      expect(await storageText(f.t, uploaded!)).not.toBeNull();
    } else {
      expect(plan!.state).toBe('PLANNED');
      expect(await storageText(f.t, uploaded!)).toBeNull();
      expect((await f.t.run(ctx => ctx.db.get(f.importId)))!.localArchiveStorageId).toBeUndefined();
      if (publication) expect(await f.t.mutation(mutationRef('travelPrivacyArchives/publish'), {
        ...publication, jobId, revision,
      })).toBe(false);
      await f.t.mutation(mutationRef('travelPrivacy/retry'), { adminToken, jobId });
    }
    await until(f.t, jobId, job => job.state === 'COMPLETE');
    expect(await storageText(f.t, f.storageId)).toBeNull();
    expect(await f.t.run(ctx => ctx.db.system.get(f.storageId))).toBeNull();
    expect(await f.t.run(ctx => ctx.db.get(f.otherId))).not.toBeNull();
    expect((await currentJob(f.t, jobId))!.counts.ordinaryArchiveObjects).toBe(1);
    expect((await f.t.run(ctx => ctx.db.query('travelPrivacyArchiveObjects').withIndex('job', q => q.eq('jobId', jobId)).unique()))!.state).toBe('DELETED');
    const remaining = await f.t.run(ctx => ctx.db.system.query('_storage').collect());
    expect(remaining.map(row => row._id)).toEqual([(await readLocal(f)).imported.localArchiveStorageId]);
  });

async function addOldMemoryChunks(f: Awaited<ReturnType<typeof fixture>>, conflictingOwner = false) {
  const records = await f.t.run(async ctx => {
    const bindings = await ctx.db.query('residentModelBindings').collect();
    const selected = (await ctx.db.get(f.memoryId))!, other = (await ctx.db.get(f.otherId))!;
    return { bindings, selected: conflictingOwner ? { ...selected, agentGlobalId: 'foreign-owner' } : selected, other };
  });
  const chunks = [{ index: 0, table: 'residentModelBindings', rows: records.bindings.map(encodeRow) },
    { index: 1, table: 'memories', rows: [records.selected, records.other].map(encodeRow) }];
  const stored = [] as { chunk: typeof chunks[number]; storageId: Id<'_storage'>; summary: Awaited<ReturnType<typeof descriptor>> }[];
  for (const chunk of chunks) stored.push({ chunk, summary: await descriptor(chunk),
    storageId: await f.t.action(ctx => ctx.storage.store(new Blob([JSON.stringify(chunk)]))) });
  const backupId = await f.t.run(async ctx => {
    const id = await ctx.db.insert('backupLargeJobs', { kind: 'import', state: 'COMPLETE', phase: 'COMPLETE',
      tableIndex: 0, cursor: null, chunkCount: 0, processedChunks: 0, recordCount: 3, bytes: stored.reduce((sum, s) => sum+s.summary.bytes,0),
      createdAt: 1, updatedAt: 1, source: {}, metadata: { oldChunkCount: 2 } });
    for (const s of stored) await ctx.db.insert('backupLargeChunks', { jobId: id, ...s.summary, storageId: s.storageId });
    return id;
  });
  return { backupId, stored, records };
}

test('formal sensitive start clears OLD chunk and ordinary bundle before native purge', async () => {
  const f = await fixture({ cold: false }), old = await addOldMemoryChunks(f);
  const { jobId, report } = await preview(f);
  expect(report.state).toBe('READY');
  expect(report.archiveCoverage!.largeChunks).toBe('READY');
  await f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken, jobId });
  expect((await currentJob(f.t, jobId))!.phase).toBe('CHUNK_REWRITE');
  for (let n = 0; n < 200; n++) {
    const job = (await currentJob(f.t, jobId))!;
    if (job.phase !== 'CHUNK_REWRITE') break;
    const latest = await f.t.run(ctx => ctx.db.system.query('_storage').order('desc').first());
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Math.max(Date.now(), Math.ceil(latest?._creationTime ?? 0) + 10));
    try { await step(f.t, jobId); } finally { clock.mockRestore(); }
    // Emulate only Blob.type omitted by convex-test 0.0.60. SHA/size and actual stored bytes remain authoritative.
    const repaired = await f.t.run(async ctx => {
      let changed = false;
      const operations = await ctx.db.query('archiveUploadOperations').collect();
      for (const object of await ctx.db.system.query('_storage').collect()) {
        const operation = operations.find(op => op.state === 'UPLOADING' && op.size === object.size &&
          Buffer.from(op.sha256Hex, 'hex').toString('base64') === object.sha256);
        if (operation && !object.contentType) { await ctx.db.patch(object._id as never, { contentType: operation.contentType } as never); changed = true; }
      }
      return changed;
    });
    if (repaired) await f.t.mutation(mutationRef('travelPrivacy/retry'), { adminToken, jobId });
    else if ((await currentJob(f.t, jobId))!.archiveError) throw new Error((await currentJob(f.t, jobId))!.archiveError);
  }
  const afterChunks = (await currentJob(f.t, jobId))!;
  expect(afterChunks.phase).toBe('ARCHIVE_REWRITE');
  expect(await f.t.run(ctx => ctx.db.get(f.memoryId))).not.toBeNull();
  expect(await f.t.run(ctx => ctx.db.system.get(old.stored[1].storageId))).toBeNull();
  expect(await storageText(f.t, f.storageId)).not.toBeNull();
  const rewritten = await f.t.run(ctx => ctx.db.query('backupLargeChunks').withIndex('job_index', q => q.eq('jobId',old.backupId).eq('index',1)).unique());
  const json = JSON.parse((await storageText(f.t, rewritten!.storageId))!);
  expect(json.rows).toEqual([encodeRow(old.records.other)]);
  await until(f.t, jobId, j => j.state === 'COMPLETE');
  expect(await f.t.run(ctx => ctx.db.get(f.memoryId))).toBeNull();
  expect(await f.t.run(ctx => ctx.db.get(f.otherId))).not.toBeNull();
  expect(await storageText(f.t, f.storageId)).toBeNull();
  expect((await currentJob(f.t, jobId))!.archiveCoverage).toEqual({ ordinaryBundles:'COMPLETE',largeChunks:'COMPLETE',orphanObjects:'NOT_VERIFIED' });
});

test('chunk ownership blocker prevents ordinary cleanup, tombstones and native deletion through formal preview', async () => {
  const f = await fixture({ cold: false }), old = await addOldMemoryChunks(f, true);
  const { jobId, report } = await preview(f);
  expect(report.state).toBe('BLOCKED');
  expect(report.blockers).toContain('CHUNK_ARCHIVE_BLOCKED');
  await expect(f.t.mutation(mutationRef('travelPrivacy/start'), { adminToken,jobId })).rejects.toThrow('TRAVEL_PRIVACY_PREFLIGHT_BLOCKED');
  expect(await f.t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toEqual([]);
  expect(await f.t.run(ctx => ctx.db.get(f.memoryId))).not.toBeNull();
  expect(await storageText(f.t, old.stored[1].storageId)).not.toBeNull();
  expect(await storageText(f.t, f.storageId)).not.toBeNull();
});
