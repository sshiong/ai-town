import * as selectiveImportFunctions from './backupSelectiveImport';
import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference, getFunctionName } from 'convex/server';
import { v } from 'convex/values';
import schema from '../schema';
import { internalAction } from '../_generated/server';
import { Id } from '../_generated/dataModel';
import { createIdentityKeys, sign } from './security';
import { decodeRow, encodeRow } from './backupHelpers';
import { LargeChunk, descriptor } from './backupLargeHelpers';
import { SelectiveManifest } from './backupSelectiveHelpers';
import { Options } from './backupSelectiveImportHelpers';
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/backupSelective.ts': () => import('./backupSelective'),
  '../federation/backupSelectiveImport.ts': () => import('./backupSelectiveImport'),
  '../federation/backupLarge.ts': () => import('./backupLarge'),
  '../federation/coldHistory.ts': () => import('./coldHistory'),
  '../federation/coldHistoryFiles.ts': () => import('./coldHistoryFiles'),
  '../models/embeddings.ts': async () => ({
    indexMemory: internalAction({ args: { memoryId: v.id('memories') }, handler: () => undefined }),
  }),
};
const adminToken = 'selective-import-test-admin-token-long';
const ref = <K extends 'action' | 'query' | 'mutation'>(module: string, name: string, kind: K) =>
  makeFunctionReference<K>(`federation/${module}:${name}`);
const aq = (name: string) => ref('backupSelectiveImport', name, 'query');
const am = (name: string) => ref('backupSelectiveImport', name, 'mutation');
const aa = (name: string) => ref('backupSelectiveImport', name, 'action');
jest.setTimeout(120000);
beforeAll(() =>
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }),
);
beforeEach(() => {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
});
async function fixture(town = 'source', count = 3) {
  const t = convexTest(schema, modules),
    keys = await createIdentityKeys();
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert('federationIdentity', {
      ...keys,
      townId: `town:${town}`,
      townName: town,
      deploymentInstanceId: `${town}:instance`,
      deploymentEpoch: 1,
      endpoint: `https://${town}.example/federation/v1`,
      enabled: false,
      allowIncomingPairRequests: false,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 8,
      maxVisitDurationMs: 300000,
      mode: 'ACTIVE',
      createdAt: 1,
    });
    const engineId = await ctx.db.insert('engines', { running: false, generationNumber: 1 });
    const worldId = await ctx.db.insert('worlds', {
      nextId: 10,
      players: [0, 1].map((i) => ({
        id: `p:${i}`,
        lastInput: 1,
        position: { x: i + 1, y: 1 },
        facing: { dx: 1, dy: 0 },
        speed: 0,
      })),
      agents: [0, 1].map((i) => ({ id: `a:${i}`, playerId: `p:${i}` })),
      conversations: [],
    });
    await ctx.db.insert('worldStatus', {
      worldId,
      engineId,
      isDefault: true,
      lastViewed: 1,
      status: 'stoppedByDeveloper',
    });
    await ctx.db.insert('maps', {
      worldId,
      width: 20,
      height: 20,
      tileSetUrl: 'https://tiles.example/tiles.png',
      tileSetDimX: 16,
      tileSetDimY: 16,
      tileDim: 16,
      bgTiles: [],
      objectTiles: [],
      animatedSprites: [],
    });
    const profileId = await ctx.db.insert('chatProfiles', {
      name: `${town} model`,
      provider: 'custom',
      model: `${town}-model`,
      url: `https://${town}.example/chat`,
      stopWords: [],
      createdAt: 1,
    });
    await ctx.db.insert('modelSettings', { key: 'town', mainChatProfileId: profileId });
    const globals = [0, 1].map((i) => `town:${town}/agent:${worldId}:a:${i}`);
    for (const [i, globalId] of globals.entries()) {
      await ctx.db.insert('residentModelBindings', {
        worldId,
        playerId: `p:${i}`,
        agentGlobalId: globalId,
        chatProfileId: profileId,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('federationAgentRuntimes', {
        worldId,
        playerId: `p:${i}`,
        agentId: `a:${i}`,
        agentGlobalId: globalId,
        homeTownId: `town:${town}`,
        state: 'HOME_ACTIVE',
        agentAuthorityEpoch: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('playerDescriptions', {
        worldId,
        playerId: `p:${i}`,
        name: `${town} resident ${i}`,
        description: `${town} personality ${i}`,
        character: 'f1',
      });
      await ctx.db.insert('agentDescriptions', {
        worldId,
        agentId: `a:${i}`,
        identity: `${town} identity ${i}`,
        plan: `${town} original plan ${i}`,
      });
    }
    const memories: Id<'memories'>[] = [];
    for (let i = 0; i < count; i++)
      memories.push(
        await ctx.db.insert('memories', {
          worldId,
          playerId: 'p:0',
          agentGlobalId: globals[0],
          description: `${town} memory ${i}`,
          importance: 7,
          lastAccess: 1,
          data: { type: 'reflection', relatedMemoryIds: [] },
        }),
      );
    const privateMemory = await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:1',
      agentGlobalId: globals[1],
      description: `${town} other-owner PRIVATE`,
      importance: 9,
      lastAccess: 1,
      data: { type: 'reflection', relatedMemoryIds: [] },
    });
    if (memories.length > 1) {
      await ctx.db.patch(memories[0], {
        data: { type: 'reflection', relatedMemoryIds: [memories[1]] },
      });
      await ctx.db.patch(memories[1], {
        data: { type: 'reflection', relatedMemoryIds: [memories[0]] },
      });
    }
    return { worldId, engineId, profileId, globals, memories, privateMemory };
  });
  return { t, ...ids };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function archive(f: Fixture, overrides: Record<string, unknown> = {}) {
  const { jobId } = await f.t.mutation(ref('backupSelective', 'startExport', 'mutation'), {
    adminToken,
    scope: 'agent-one',
    agentGlobalIds: [f.globals[0]],
    categories: ['conversation', 'relationship', 'reflection', 'travel', 'social'],
    operator: 'test',
    reason: 'Transfer',
    ...overrides,
  });
  for (let n = 0; n < 3000; n++) {
    const state = await f.t.action(ref('backupSelective', 'advanceExport', 'action'), {
      adminToken,
      jobId,
    });
    if (state.state === 'FAILED') throw new Error(state.error);
    if (state.state === 'COMPLETE') break;
  }
  const result = await f.t.action(ref('backupSelective', 'getManifest', 'action'), {
    adminToken,
    jobId,
  });
  const manifest = result.manifest as SelectiveManifest,
    chunks: LargeChunk[] = [];
  for (const c of manifest.chunks)
    chunks.push(
      JSON.parse(
        await f.t.action(ref('backupSelective', 'getChunk', 'action'), {
          adminToken,
          jobId,
          index: c.index,
        }),
      ) as LargeChunk,
    );
  return { manifest, signature: result.signature as string, chunks };
}
type Archive = Awaited<ReturnType<typeof archive>>;
function options(
  target: Fixture,
  source: Archive,
  operation: 'clone' | 'merge' | 'restore' = 'clone',
): Options {
  return {
    mode: operation === 'restore' ? 'restore' : 'merge',
    owners: source.manifest.selection.owners.map((o, i) => ({
      sourceAgentGlobalId: o.agentGlobalId,
      operation,
      targetWorldId: target.worldId,
      ...(operation !== 'clone' ? { targetAgentGlobalId: target.globals[i] } : {}),
    })),
    profiles: [
      {
        sourceId: source.manifest.selection.owners[0].chatProfileId,
        operation: 'map',
        targetId: target.profileId,
      },
    ],
    externalReferences: [],
    configuration: [],
    worlds: [],
    sourceStopped: operation === 'restore',
    operator: 'test-admin',
    reason: 'Explicit transfer test',
  };
}
async function start(f: Fixture, source: Archive, configuration = options(f, source)) {
  const { jobId } = await f.t.action(aa('createImport'), {
    adminToken,
    manifest: source.manifest,
    signature: source.signature,
    ...configuration,
  });
  for (const chunk of source.chunks)
    await f.t.action(aa('stageChunk'), { adminToken, jobId, chunk: JSON.stringify(chunk) });
  return jobId as Id<'backupLargeJobs'>;
}
async function drive(f: Fixture, jobId: Id<'backupLargeJobs'>, until = 'COMPLETE') {
  for (let n = 0; n < 3000; n++) {
    const state = await f.t.query(aq('status'), { adminToken, jobId });
    if (state.state === 'FAILED') throw new Error(state.error);
    if (state.state === until || state.phase === until) {
      if (state.state === 'COMPLETE') await f.t.finishAllScheduledFunctions(() => undefined, 2000);
      return f.t.query(aq('status'), { adminToken, jobId });
    }
    await f.t.action(aa('advanceImport'), { adminToken, jobId });
  }
  throw new Error('Import checkpoint did not finish');
}
async function apply(f: Fixture, jobId: Id<'backupLargeJobs'>) {
  const ready = await drive(f, jobId, 'READY');
  await f.t.mutation(am('startApply'), {
    adminToken,
    jobId,
    expectedPlanDigest: ready.planDigest,
    expectedTargetDigest: ready.targetDigest,
    confirmChanges: true,
  });
  return drive(f, jobId);
}
async function signedConversation(f: Fixture, index = 0, firstText?: string) {
  const conversationId: `c:${number}` = `c:${40 + index}`;
  const memoryId = await f.t.run(async ctx => {
    const memoryId = await ctx.db.insert('memories', { worldId: f.worldId, playerId: `p:${index}`,
      agentGlobalId: f.globals[index], description: `Signed conversation owner ${index}`, importance: 8, lastAccess: 1,
      data: { type: 'conversation', conversationId, playerIds: index ? [] : ['p:1'] } });
    await ctx.db.insert('archivedConversations', { worldId: f.worldId, id: conversationId,
      creator: `p:${index}`, created: 10, ended: 20, numMessages: 3, participants: index ? ['p:1'] : ['p:0', 'p:1'] });
    for (let n = 0; n < 3; n++) await ctx.db.insert('messages', { worldId: f.worldId, conversationId,
      author: index ? 'p:1' : n % 2 ? 'p:1' : 'p:0', text: n === 0 && firstText ? firstText : `Signed owner ${index} message ${n}`,
      messageUuid: `signed-owner-${index}-${n}` });
    return memoryId;
  });
  const owner = { adminToken, worldId: f.worldId, playerId: `p:${index}`, agentGlobalId: f.globals[index], memoryId };
  const { archiveId } = await f.t.action(ref('coldHistory', 'archive', 'action'), owner);
  const file = await f.t.action(ref('coldHistoryFiles', 'exportFile', 'action'), owner);
  const original = (await f.t.run(ctx => ctx.db.get(archiveId as Id<'coldHistoryArchives'>)))!;
  return { owner, file, original };
}
async function restoredColdOwner(f: Fixture, globalId: string) {
  const binding = (await f.t.run(ctx => ctx.db.query('residentModelBindings').withIndex('globalAgent', q => q.eq('agentGlobalId', globalId)).unique()))!;
  const memory = (await f.t.run(ctx => ctx.db.query('memories').withIndex('globalAgent', q => q.eq('agentGlobalId', globalId))
    .filter(q => q.eq(q.field('description'), 'Signed conversation owner 0')).unique()))!;
  return { adminToken, worldId: binding.worldId, playerId: binding.playerId, agentGlobalId: globalId, memoryId: memory._id };
}
test('selective clone carries only the selected complete signed cold scope and preserves source proof through re-export', async () => {
  const source = await fixture('cold-source'), cold = await signedConversation(source);
  await signedConversation(source, 1, 'Other resident private cold original');
  const exported = await archive(source);
  const attached = exported.chunks.filter(c => c.table === 'coldHistoryFiles').flatMap(c => c.rows.map(decodeRow)).map(e => decodeRow(e.record));
  expect(attached).toHaveLength(1);
  expect(attached[0].file).toEqual(cold.file);
  expect(attached[0].owner.memoryId).toBe(cold.owner.memoryId);
  expect(JSON.stringify(exported)).not.toContain('Other resident private cold original');
  expect(JSON.stringify(exported)).not.toContain('storageId');
  const target = await fixture('cold-target');
  const result = await apply(target, await start(target, exported));
  const owner = await restoredColdOwner(target, result.targetOwners[0].agentGlobalId);
  expect(await target.t.action(ref('coldHistoryFiles', 'exportFile', 'action'), owner)).toEqual(cold.file);
  const reexported = await archive(target, { agentGlobalIds: [owner.agentGlobalId] });
  const carried = reexported.chunks.find(c => c.table === 'coldHistoryFiles')!;
  expect(decodeRow(decodeRow(carried.rows[0]).record).file).toEqual(cold.file);
});
test('memory-only and filtered history state why immutable cold files are excluded without adding out-of-range originals', async () => {
  const source = await fixture('filtered-cold');
  await signedConversation(source);
  const memoryOnly = await archive(source, { scope: 'memories-only', categories: ['conversation'] });
  expect(memoryOnly.manifest.coldHistoryFiles).toMatchObject({ included: 0, excluded: { SOURCE_SCOPE_NOT_SELECTED: 1 } });
  expect(JSON.stringify(memoryOnly)).not.toContain('Signed owner 0 message');
  expect(JSON.stringify(memoryOnly)).toContain('Signed conversation owner 0');
  const fullHistory = await archive(source, { scope: 'history', categories: ['conversation'] });
  expect(fullHistory.manifest.coldHistoryFiles).toMatchObject({ included: 0, excluded: { CANONICAL_MEMORY_NOT_SELECTED: 1 } });
  const filtered = await archive(source, { scope: 'history', categories: ['conversation'], from: 10, to: 21 });
  expect(filtered.manifest.coldHistoryFiles?.included).toBe(0);
  // The conversation's event-time is selected, while the retained message times
  // are outside it. Immutable files must not add those excluded original texts.
  expect(filtered.chunks.some(c => c.table === 'coldHistoryFiles')).toBe(false);
  expect(JSON.stringify(filtered)).not.toContain('Signed owner 0 message');
});
test('missing signed cold entity fails export at a resumable checkpoint and never becomes a silent exclusion', async () => {
  const source = await fixture('missing-cold'), cold = await signedConversation(source);
  const body = await source.t.run(async ctx => (await ctx.storage.get(cold.original.storageId!))!.text());
  await source.t.run(ctx => ctx.storage.delete(cold.original.storageId!));
  await expect(archive(source)).rejects.toThrow('COLD_HISTORY_STORAGE_MISSING');
  const job = (await source.t.run(ctx => ctx.db.query('backupLargeJobs').filter(q => q.eq(q.field('mode'), 'selective-archive')).unique()))!;
  expect(job).toMatchObject({ state: 'FAILED', phase: 'COLD_FILES' });
  const storageId = await source.t.run(ctx => ctx.storage.store(new Blob([body], { type: 'application/json' })));
  await source.t.run(ctx => ctx.db.patch(cold.original._id, { storageId }));
  await source.t.mutation(ref('backupSelective', 'resume', 'mutation'), { adminToken, jobId: job._id });
  for (let n = 0; n < 20; n++) {
    const state = await source.t.action(ref('backupSelective', 'advanceExport', 'action'), { adminToken, jobId: job._id });
    if (state.state === 'COMPLETE') break;
  }
  expect((await source.t.query(ref('backupSelective', 'status', 'query'), { adminToken, jobId: job._id })).state).toBe('COMPLETE');
});
test('required cold-only original history fails, while independently complete canonical memory-only export stays available', async () => {
  const source = await fixture('missing-hot-cold');
  await signedConversation(source);
  await source.t.run(async ctx => { for (const message of await ctx.db.query('messages').collect()) await ctx.db.delete(message._id); });
  const memories = await archive(source, { scope: 'memories-only', categories: ['conversation'] });
  expect(memories.manifest.coldHistoryFiles).toMatchObject({ included: 0, excluded: { SOURCE_SCOPE_NOT_SELECTED: 1 } });
  expect(JSON.stringify(memories)).toContain('Signed conversation owner 0');
  expect(JSON.stringify(memories)).not.toContain('Signed owner 0 message');
  await expect(archive(source, { scope: 'history', categories: ['conversation'] })).rejects.toThrow('COLD_HISTORY_EMPTY_OR_DUPLICATE_MESSAGES');
});
test('inner signature forgery and signed hot original mismatch reject selective import before target writes', async () => {
  const source = await fixture('forged-cold');
  await signedConversation(source);
  const exported = await archive(source), target = await fixture('forged-target');
  const forged = structuredClone(exported), chunk = forged.chunks.find(c => c.table === 'coldHistoryFiles')!;
  const envelope = decodeRow(chunk.rows[0]), row = decodeRow(envelope.record);
  row.file.signature = 'invalid'; envelope.record = encodeRow(row); chunk.rows[0] = encodeRow(envelope);
  await resign(source, forged);
  await expect(start(target, forged)).rejects.toThrow('COLD_FILE_INTEGRITY_FAILED');
  const job = (await target.t.run(ctx => ctx.db.query('backupLargeJobs').unique()))!;
  await target.t.mutation(am('cancel'), { adminToken, jobId: job._id });
  const inconsistent = structuredClone(exported), messages = inconsistent.chunks.find(c => c.table === 'messages')!;
  const messageEnvelope = decodeRow(messages.rows[0]), message = decodeRow(messageEnvelope.record);
  message.text = 'Signed outer package disagrees with immutable history'; messageEnvelope.record = encodeRow(message); messages.rows[0] = encodeRow(messageEnvelope);
  await resign(source, inconsistent);
  await expectPreflightFailure(target, inconsistent, options(target, inconsistent), 'BACKUP_COLD_FILES_MESSAGES_MISMATCH');
});
test('cancellation after publishing selective cold files restores original target indexes, storage and readable signatures', async () => {
  const source = await fixture('cancel-cold-source'), cold = await signedConversation(source), exported = await archive(source);
  const target = await fixture('cancel-cold-target'), prior = await signedConversation(target);
  const originalWorld = await target.t.run(ctx => ctx.db.get(target.worldId));
  const jobId = await start(target, exported), ready = await drive(target, jobId, 'READY');
  await target.t.mutation(am('startApply'), { adminToken, jobId, expectedPlanDigest: ready.planDigest, expectedTargetDigest: ready.targetDigest, confirmChanges: true });
  await drive(target, jobId, 'VECTOR_RESET');
  expect(await target.t.run(ctx => ctx.db.query('coldHistoryArchives').collect())).toHaveLength(2);
  await target.t.mutation(am('cancel'), { adminToken, jobId });
  await drive(target, jobId, 'CANCELLED');
  expect(await target.t.run(ctx => ctx.db.get(target.worldId))).toEqual(originalWorld);
  expect(await target.t.run(ctx => ctx.db.query('coldHistoryArchives').collect())).toEqual([prior.original]);
  expect(await target.t.action(ref('coldHistoryFiles', 'exportFile', 'action'), prior.owner)).toEqual(prior.file);
  expect(cold.file.signature).toBeTruthy();
});
test('selective travel files map worldless pages and global authors while keeping the original signed file', async () => {
  const source = await fixture('travel-cold'), transcriptId = 'conversation/completed-visit';
  const memoryId = await source.t.run(async ctx => {
    const memoryId = await ctx.db.insert('memories', { worldId: source.worldId, playerId: 'p:0',
      agentGlobalId: source.globals[0], description: 'Signed travel original', importance: 8, lastAccess: 1,
      data: { type: 'travel', eventId: 'travel-ended', visitId: 'completed-visit', hostTownId: 'town:friend',
        federationConversationId: 'conversation', transcriptId, participants: [], occurredAt: 20 } });
    await ctx.db.insert('homeTravelTranscripts', { worldId: source.worldId, playerId: 'p:0',
      agentGlobalId: source.globals[0], transcriptId, visitId: 'completed-visit', hostTownId: 'town:friend',
      federationConversationId: 'conversation', endedAt: 20, participants: [], finalPageNumber: 0,
      receivedPageCount: 1, highestPageNumber: 0, totalMessageCount: 2, state: 'COMPLETE', summaryState: 'DONE', endMemoryId: memoryId });
    await ctx.db.insert('homeTravelTranscriptPages', { agentGlobalId: source.globals[0], transcriptId,
      pageNumber: 0, eventId: 'travel-page', finalPage: true, memoryIds: [memoryId],
      messages: [{ messageId: 'travel-message-0', text: 'Home travel original', author: source.globals[0], occurredAt: 10 },
        { messageId: 'travel-message-1', text: 'Foreign travel original', author: 'town:friend/visitor:bob', occurredAt: 11 }] });
    return memoryId;
  });
  const owner = { adminToken, worldId: source.worldId, playerId: 'p:0', agentGlobalId: source.globals[0], memoryId };
  await source.t.action(ref('coldHistory', 'archive', 'action'), owner);
  const file = await source.t.action(ref('coldHistoryFiles', 'exportFile', 'action'), owner);
  const bounded = await archive(source, { categories: ['travel'], from: 10, to: 25 });
  expect(bounded.manifest.coldHistoryFiles).toMatchObject({ included: 0, excluded: { SOURCE_SCOPE_INCOMPLETE: 1 } });
  expect(JSON.stringify(bounded)).not.toContain('Home travel original');
  const exported = await archive(source), target = await fixture('travel-cold-target');
  const result = await apply(target, await start(target, exported)), clone = result.targetOwners[0];
  const memory = (await target.t.run(ctx => ctx.db.query('memories').withIndex('globalAgent', q => q.eq('agentGlobalId', clone.agentGlobalId))
    .filter(q => q.eq(q.field('description'), 'Signed travel original')).unique()))!;
  const targetOwner = { adminToken, worldId: target.worldId, playerId: clone.playerId, agentGlobalId: clone.agentGlobalId, memoryId: memory._id };
  expect(await target.t.action(ref('coldHistoryFiles', 'exportFile', 'action'), targetOwner)).toEqual(file);
  const page = (await target.t.run(ctx => ctx.db.query('homeTravelTranscriptPages').unique()))!;
  expect(page.messages[0].author).toBe(clone.agentGlobalId);
  expect(page.messages[1].author).toBe('town:friend/visitor:bob');
});
test('lost selective cold publication response retains the referenced file and resumes after the saved checkpoint', async () => {
  const source = await fixture('lost-cold-source'), cold = await signedConversation(source), exported = await archive(source);
  const target = await fixture('lost-cold-target'), jobId = await start(target, exported), ready = await drive(target, jobId, 'READY');
  await target.t.mutation(am('startApply'), { adminToken, jobId, expectedPlanDigest: ready.planDigest, expectedTargetDigest: ready.targetDigest, confirmChanges: true });
  await drive(target, jobId, 'APPLY_COLD');
  await selectiveLostAck(target, selectiveImportFunctions.advanceImport, 'applyColdPage', { adminToken, jobId });
  const state = await target.t.query(aq('status'), { adminToken, jobId });
  expect(state).toMatchObject({ state: 'FAILED', phase: 'VECTOR_RESET' });
  const owner = await restoredColdOwner(target, state.targetOwners[0].agentGlobalId);
  expect(await target.t.action(ref('coldHistoryFiles', 'exportFile', 'action'), owner)).toEqual(cold.file);
  await target.t.mutation(am('resume'), { adminToken, jobId });
  await drive(target, jobId);
  expect(await target.t.action(ref('coldHistoryFiles', 'exportFile', 'action'), owner)).toEqual(cold.file);
});
test('selective cold preflight rejects the same local source across files and across saved validation pages', async () => {
  const source = await fixture('duplicate-cold'), cold = await signedConversation(source), exported = await archive(source);
  const original = exported.chunks.find(c => c.table === 'coldHistoryFiles')!, envelope = decodeRow(original.rows[0]), row = decodeRow(envelope.record);
  row._id = 'distinct-import-file'; envelope.record = encodeRow(row);
  exported.chunks.push({ index: exported.chunks.length, table: 'coldHistoryFiles', rows: [encodeRow(envelope)] });
  exported.manifest.coldHistoryFiles!.included++;
  await resign(source, exported);
  const target = await fixture('duplicate-cold-target'), jobId = await start(target, exported);
  await expect(drive(target, jobId, 'READY')).rejects.toThrow('BACKUP_COLD_FILES_DUPLICATE_SOURCE');
  const checked = await target.t.run(ctx => ctx.db.query('backupLargeRows').withIndex('job_relation', q =>
    q.eq('jobId', jobId).eq('role', 'SOURCE').eq('table', 'coldHistoryFiles')
      .eq('relationKey', JSON.stringify(['conversation', source.worldId, 'c:40']))).collect());
  expect(checked).toHaveLength(1);
  expect(checked[0].sourceId).toBe(cold.original._id);
  expect(await target.t.run(ctx => ctx.db.query('coldHistoryArchives').collect())).toEqual([]);
});
test('clone imports all 530 canonical memories and cyclic references with explicit Chat mapping and new Home identity', async () => {
  const original = await fixture('source', 530),
    exported = await archive(original),
    target = await fixture('target');
  const jobId = await start(target, exported),
    result = await apply(target, jobId);
  const clone = result.targetOwners[0];
  expect(clone.agentGlobalId).not.toBe(original.globals[0]);
  const rows = await target.t.run(async (ctx) => ({
    memories: await ctx.db
      .query('memories')
      .withIndex('globalAgent', (q) => q.eq('agentGlobalId', clone.agentGlobalId))
      .collect(),
    binding: await ctx.db
      .query('residentModelBindings')
      .withIndex('globalAgent', (q) => q.eq('agentGlobalId', clone.agentGlobalId))
      .unique(),
    persona: await ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', target.worldId).eq('agentId', clone.agentId))
      .unique(),
    local: await ctx.db.query('federationIdentity').unique(),
    locks: await ctx.db.query('backupMaintenanceLocks').collect(),
  }));
  expect(rows.memories).toHaveLength(530);
  expect(rows.binding?.chatProfileId).toBe(target.profileId);
  expect(rows.persona?.identity).toBe('source identity 0');
  const byDescription = new Map(rows.memories.map((row) => [row.description, row]));
  expect(byDescription.get('source memory 0')?.data).toEqual({
    type: 'reflection',
    relatedMemoryIds: [byDescription.get('source memory 1')!._id],
  });
  expect(byDescription.get('source memory 1')?.data).toEqual({
    type: 'reflection',
    relatedMemoryIds: [byDescription.get('source memory 0')!._id],
  });
  expect(JSON.stringify(rows.memories)).not.toContain('other-owner PRIVATE');
  expect(rows.local?.townId).toBe('town:target');
  expect(rows.locks).toEqual([]);
  expect(result.report.rebuildCount).toBe(530);
});
test('raw memory merge requires explicit target Home proof and keeps target personality and Chat binding', async () => {
  const original = await fixture(),
    source = await archive(original, { scope: 'memories-only', categories: ['reflection'] }),
    target = await fixture('target');
  const configured = options(target, source, 'merge');
  configured.profiles = [];
  const jobId = await start(target, source, configured);
  await apply(target, jobId);
  const result = await target.t.run(async (ctx) => ({
    memories: await ctx.db
      .query('memories')
      .withIndex('globalAgent', (q) => q.eq('agentGlobalId', target.globals[0]))
      .collect(),
    binding: await ctx.db
      .query('residentModelBindings')
      .withIndex('globalAgent', (q) => q.eq('agentGlobalId', target.globals[0]))
      .unique(),
    persona: await ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', target.worldId).eq('agentId', 'a:0'))
      .unique(),
  }));
  expect(result.memories).toHaveLength(6);
  expect(result.persona?.identity).toBe('target identity 0');
  expect(result.binding?.chatProfileId).toBe(target.profileId);
  const bad = options(target, source, 'merge');
  bad.owners[0].targetAgentGlobalId = original.globals[0];
  await expect(start(target, source, bad)).rejects.toThrow(
    'SELECTIVE_IMPORT_TARGET_OWNER_PROOF_REQUIRED',
  );
});
test('original Home restore preserves global identity, restores personality and memory IDs, and clears stale vectors', async () => {
  const f = await fixture(),
    exported = await archive(f);
  await f.t.run(async (ctx) => {
    const persona = await ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', f.worldId).eq('agentId', 'a:0'))
      .unique();
    await ctx.db.patch(persona!._id, { identity: 'Changed personality' });
    await ctx.db.patch(f.memories[0], { description: 'Changed text' });
    const profileId = await ctx.db.insert('embeddingProfiles', {
      name: 'Embedding',
      provider: 'custom',
      url: 'https://embedding.example',
      model: 'embedding',
      dimensions: 2,
      preprocessingRevision: 'newline-to-space-v1',
      queryPrefix: '',
      documentPrefix: '',
      normalization: 'none',
      fingerprint: 'fingerprint',
      createdAt: 1,
    });
    const spaceId = await ctx.db.insert('embeddingSpaces', {
      profileId,
      fingerprint: 'fingerprint',
      status: 'ACTIVE',
      createdAt: 1,
    });
    await ctx.db.insert('modelMemoryVectors', {
      memoryId: f.memories[0],
      worldId: f.worldId,
      playerId: 'p:0',
      agentGlobalId: f.globals[0],
      spaceId,
      embedding: [1, 0],
    });
  });
  const jobId = await start(f, exported, options(f, exported, 'restore'));
  await apply(f, jobId);
  const result = await f.t.run(async (ctx) => ({
    memory: await ctx.db.get(f.memories[0]),
    vectors: await ctx.db.query('modelMemoryVectors').collect(),
    persona: await ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', f.worldId).eq('agentId', 'a:0'))
      .unique(),
    runtime: await ctx.db
      .query('federationAgentRuntimes')
      .withIndex('globalId', (q) => q.eq('agentGlobalId', f.globals[0]))
      .unique(),
  }));
  expect(result.memory?.description).toBe('source memory 0');
  expect(result.vectors).toEqual([]);
  expect(result.persona?.identity).toBe('source identity 0');
  expect(result.runtime?.agentGlobalId).toBe(f.globals[0]);
});
test('partial application cancellation restores private target snapshots with original IDs and removes new residents', async () => {
  const original = await fixture(),
    exported = await archive(original),
    target = await fixture('target');
  const snapshot = await target.t.run(async (ctx) => ({
    world: await ctx.db.get(target.worldId),
    memories: await ctx.db.query('memories').collect(),
    profiles: await ctx.db.query('chatProfiles').collect(),
    bindings: await ctx.db.query('residentModelBindings').collect(),
  }));
  const jobId = await start(target, exported),
    ready = await drive(target, jobId, 'READY');
  await target.t.mutation(am('startApply'), {
    adminToken,
    jobId,
    expectedPlanDigest: ready.planDigest,
    expectedTargetDigest: ready.targetDigest,
    confirmChanges: true,
  });
  await drive(target, jobId, 'REMAP');
  await target.t.mutation(am('cancel'), { adminToken, jobId });
  await drive(target, jobId, 'CANCELLED');
  const actual = await target.t.run(async (ctx) => ({
    world: await ctx.db.get(target.worldId),
    memories: await ctx.db.query('memories').collect(),
    profiles: await ctx.db.query('chatProfiles').collect(),
    bindings: await ctx.db.query('residentModelBindings').collect(),
  }));
  expect(actual).toEqual(snapshot);
});
test('missing chunks and tampering cannot reach live writes', async () => {
  const original = await fixture(),
    exported = await archive(original),
    target = await fixture('target');
  const { jobId } = await target.t.action(aa('createImport'), {
    adminToken,
    manifest: exported.manifest,
    signature: exported.signature,
    ...options(target, exported),
  });
  const bad = structuredClone(exported.chunks[0]);
  bad.rows[0] = String(bad.rows[0]).replace('primary', 'dependency');
  await expect(
    target.t.action(aa('stageChunk'), { adminToken, jobId, chunk: JSON.stringify(bad) }),
  ).rejects.toThrow('BACKUP_CHECKSUM_MISMATCH');
  await target.t.action(aa('advanceImport'), { adminToken, jobId });
  expect((await target.t.query(aq('status'), { adminToken, jobId })).error).toContain(
    'BACKUP_UPLOAD_INCOMPLETE',
  );
  await expect(
    target.t.mutation(am('startApply'), {
      adminToken,
      jobId,
      expectedPlanDigest: '',
      expectedTargetDigest: '',
      confirmChanges: true,
    }),
  ).rejects.toThrow('BACKUP_NOT_READY');
  expect((await target.t.run((ctx) => ctx.db.get(target.worldId)))?.agents).toHaveLength(2);
});

async function resign(f: Fixture, source: Archive) {
  source.manifest.chunks = await Promise.all(source.chunks.map(descriptor));
  const identity = await f.t.run((ctx) => ctx.db.query('federationIdentity').unique());
  source.signature = await sign(source.manifest, identity!.privateKeyEncrypted);
  return source;
}
async function expectPreflightFailure(
  target: Fixture,
  source: Archive,
  configured: Options,
  error: string,
) {
  const before = await target.t.run(async (ctx) => ({
    world: await ctx.db.get(target.worldId),
    memories: await ctx.db.query('memories').collect(),
    profiles: await ctx.db.query('chatProfiles').collect(),
  }));
  const jobId = await start(target, source, configured);
  await expect(drive(target, jobId, 'READY')).rejects.toThrow(error);
  expect(
    await target.t.run(async (ctx) => ({
      world: await ctx.db.get(target.worldId),
      memories: await ctx.db.query('memories').collect(),
      profiles: await ctx.db.query('chatProfiles').collect(),
    })),
  ).toEqual(before);
  await target.t.mutation(am('cancel'), { adminToken, jobId });
  expect((await target.t.query(aq('status'), { adminToken, jobId })).state).toBe('CANCELLED');
}

test('missing and forged profile mappings fail preflight without falling back to target main', async () => {
  const original = await fixture(),
    exported = await archive(original),
    target = await fixture('target');
  const missing = options(target, exported);
  missing.profiles = [];
  await expectPreflightFailure(
    target,
    exported,
    missing,
    'SELECTIVE_IMPORT_PROFILE_MAPPING_REQUIRED',
  );
  const forged = options(target, exported);
  forged.profiles.push({
    sourceId: 'not-in-the-signed-archive',
    operation: 'map',
    targetId: target.profileId,
  });
  await expectPreflightFailure(target, exported, forged, 'SELECTIVE_IMPORT_SOURCE_PROFILE_MISSING');
  const draft = options(target, exported);
  draft.profiles[0] = { sourceId: draft.profiles[0].sourceId, operation: 'draft' };
  const jobId = await start(target, exported, draft);
  const result = await apply(target, jobId);
  const targetOwner = result.targetOwners[0];
  const profile = await target.t.run((ctx) =>
    ctx.db.get(targetOwner.chatProfileId as Id<'chatProfiles'>),
  );
  expect(profile?.model).toBe('source-model');
  expect(profile?.apiKeyEnv).toMatch(/^SELECTIVE_CHAT_/);
  expect(profile?._id).not.toBe(target.profileId);
  expect(await target.t.run((ctx) => ctx.db.query('modelSettings').unique())).toMatchObject({
    mainChatProfileId: target.profileId,
  });
});

test('external evidence requires explicit owner-safe mapping or an audited skipped edge', async () => {
  const original = await fixture();
  await original.t.run((ctx) =>
    ctx.db.patch(original.memories[0], {
      data: {
        type: 'reflection',
        relatedMemoryIds: [original.memories[1], original.privateMemory],
      },
    }),
  );
  const exported = await archive(original, { scope: 'memories-only', categories: ['reflection'] });
  const target = await fixture('target');
  const configured = options(target, exported, 'merge');
  configured.profiles = [];
  await expectPreflightFailure(
    target,
    exported,
    configured,
    'SELECTIVE_IMPORT_EXTERNAL_MAPPING_REQUIRED',
  );
  configured.externalReferences = [
    {
      sourceId: original.privateMemory,
      sourceAgentGlobalId: original.globals[0],
      operation: 'map',
      targetId: target.privateMemory,
    },
  ];
  await expectPreflightFailure(
    target,
    exported,
    configured,
    'SELECTIVE_IMPORT_EXTERNAL_OWNER_MISMATCH',
  );
  configured.externalReferences[0].targetId = target.memories[0];
  const mapped = await start(target, exported, configured);
  const result = await apply(target, mapped);
  const imported = await target.t.run((ctx) =>
    ctx.db
      .query('memories')
      .filter((q) => q.eq(q.field('description'), 'source memory 0'))
      .unique(),
  );
  expect(imported?.data.type === 'reflection' && imported.data.relatedMemoryIds).toContain(
    target.memories[0],
  );
  expect(result.report.externalEdgesSkipped).toBe(0);
  const otherTarget = await fixture('skip-target');
  const skipped = options(otherTarget, exported, 'merge');
  skipped.profiles = [];
  skipped.externalReferences = [
    {
      sourceId: original.privateMemory,
      sourceAgentGlobalId: original.globals[0],
      operation: 'skip-edge',
    },
  ];
  const skippedResult = await apply(otherTarget, await start(otherTarget, exported, skipped));
  expect(skippedResult.report.externalEdgesSkipped).toBe(1);
  const skippedMemory = await otherTarget.t.run((ctx) =>
    ctx.db
      .query('memories')
      .filter((q) => q.eq(q.field('description'), 'source memory 0'))
      .unique(),
  );
  expect(
    skippedMemory?.data.type === 'reflection' && skippedMemory.data.relatedMemoryIds,
  ).toHaveLength(1);
  expect(
    skippedMemory?.data.type === 'reflection' && skippedMemory.data.relatedMemoryIds,
  ).not.toContain(otherTarget.privateMemory);
});

test('signed primary owner and time scope violations and orphan dependencies cannot reach live writes', async () => {
  const original = await fixture(),
    base = await archive(original),
    target = await fixture('target');
  const wrongOwner = structuredClone(base);
  const memoryChunk = wrongOwner.chunks.find((chunk) => chunk.table === 'memories')!;
  const envelope = decodeRow(memoryChunk.rows[0]);
  const row = decodeRow(envelope.record);
  envelope.record = encodeRow({ ...row, playerId: 'p:1', agentGlobalId: original.globals[1] });
  memoryChunk.rows[0] = encodeRow(envelope);
  await resign(original, wrongOwner);
  await expectPreflightFailure(
    target,
    wrongOwner,
    options(target, wrongOwner),
    'SELECTIVE_IMPORT_SOURCE_OWNER_MISMATCH',
  );
  const outside = structuredClone(base);
  outside.manifest.selection.from = Date.now() + 100000;
  await resign(original, outside);
  await expectPreflightFailure(
    target,
    outside,
    options(target, outside),
    'SELECTIVE_IMPORT_PRIMARY_SCOPE_MISMATCH',
  );
  const orphan = structuredClone(base);
  const chunk = orphan.chunks.find((chunk) => chunk.table === 'chatProfiles')!;
  const originalProfile = decodeRow(decodeRow(chunk.rows[0]).record);
  orphan.chunks.push({
    index: orphan.chunks.length,
    table: 'chatProfiles',
    rows: [
      encodeRow({
        kind: 'record',
        role: 'dependency',
        references: [],
        record: encodeRow({
          ...originalProfile,
          _id: 'unrelated-profile',
          name: 'Unexpected configuration',
        }),
      }),
    ],
  });
  await resign(original, orphan);
  await expectPreflightFailure(
    target,
    orphan,
    options(target, orphan),
    'SELECTIVE_IMPORT_DEPENDENCY_SCOPE_MISMATCH',
  );
});

test('clone allocates collision-free world-local IDs and never replays queued Agent snapshots', async () => {
  const original = await fixture();
  await original.t.run(async (ctx) => {
    const world = (await ctx.db.get(original.worldId))!;
    await ctx.db.patch(world._id, {
      agents: world.agents.map((a) => ({
        ...a,
        toRemember: 'c:40',
        queuedConversations: ['c:41'],
        inProgressOperation: {
          name: 'agentRememberConversation',
          operationId: 'old-operation',
          started: 1,
        },
      })),
    });
  });
  const exported = await archive(original),
    target = await fixture('target');
  await target.t.run(async (ctx) => {
    await ctx.db.patch(target.worldId, { nextId: 0 });
    await ctx.db.insert('archivedPlayers', {
      worldId: target.worldId,
      id: 'p:2',
      lastInput: 1,
      position: { x: 3, y: 3 },
      facing: { dx: 1, dy: 0 },
      speed: 0,
    });
  });
  const result = await apply(target, await start(target, exported));
  const cloned = result.targetOwners[0];
  expect(cloned.playerId).toBe('p:3');
  const world = await target.t.run((ctx) => ctx.db.get(target.worldId));
  expect(new Set(world!.players.map((p) => p.id)).size).toBe(world!.players.length);
  expect(new Set(world!.agents.map((a) => a.id)).size).toBe(world!.agents.length);
  expect(world!.agents.find((a) => a.id === cloned.agentId)).toEqual({
    id: cloned.agentId,
    playerId: cloned.playerId,
  });
  await expect(
    target.t.action(ref('backupLarge', 'advanceImport', 'action'), {
      adminToken,
      jobId: result.jobId,
    }),
  ).rejects.toThrow('SELECTIVE_ARCHIVE_USE_SELECTIVE_API');
  const dirty = await fixture('dirty-target');
  await dirty.t.run(async (ctx) => {
    const world = (await ctx.db.get(dirty.worldId))!;
    await ctx.db.patch(world._id, {
      agents: world.agents.map((a) => ({ ...a, queuedConversations: ['c:99'] })),
    });
  });
  await expect(start(dirty, exported, options(dirty, exported, 'merge'))).rejects.toThrow(
    'DRAIN_TARGET_WORK_BEFORE_SELECTIVE_IMPORT',
  );
});

test('read-only v1 and original Home identity mismatches are rejected; config-only never mutates residents', async () => {
  const original = await fixture(),
    base = await archive(original),
    target = await fixture('target');
  const legacy = structuredClone(base);
  legacy.manifest.version = 1;
  legacy.manifest.usage = 'read-only-archive';
  await resign(original, legacy);
  await expect(start(target, legacy)).rejects.toThrow('SELECTIVE_READ_ONLY_ARCHIVE_NOT_IMPORTABLE');
  await expect(start(target, base, options(target, base, 'restore'))).rejects.toThrow(
    'RESTORE_IDENTITY_PROOF_REQUIRED',
  );
  const config = await archive(original, {
    scope: 'config-only',
    agentGlobalIds: [],
    categories: ['configuration'],
  });
  const configured: Options = {
    mode: 'merge',
    owners: [],
    profiles: [{ sourceId: original.profileId, operation: 'map', targetId: target.profileId }],
    externalReferences: [],
    worlds: [],
    configuration: ['mainChatProfile', 'visitorPolicy'],
    sourceStopped: false,
    operator: 'config-admin',
    reason: 'Explicit source configuration',
  };
  const before = await target.t.run(async (ctx) => ({
    world: await ctx.db.get(target.worldId),
    bindings: await ctx.db.query('residentModelBindings').collect(),
    memories: await ctx.db.query('memories').collect(),
    identity: await ctx.db.query('federationIdentity').unique(),
  }));
  await apply(target, await start(target, config, configured));
  const after = await target.t.run(async (ctx) => ({
    world: await ctx.db.get(target.worldId),
    bindings: await ctx.db.query('residentModelBindings').collect(),
    memories: await ctx.db.query('memories').collect(),
    identity: await ctx.db.query('federationIdentity').unique(),
  }));
  expect(after.world).toEqual(before.world);
  expect(after.bindings).toEqual(before.bindings);
  expect(after.memories).toEqual(before.memories);
  expect(after.identity?.townId).toBe(before.identity?.townId);
  expect(after.identity?.privateKeyEncrypted).toBe(before.identity?.privateKeyEncrypted);
  expect(after.identity?.enabled).toBe(false);
});

test('selected owner evidence is remapped together; skipping an included owner requires a preflight edge policy', async () => {
  const original = await fixture();
  await original.t.run((ctx) =>
    ctx.db.patch(original.memories[0], {
      data: { type: 'reflection', relatedMemoryIds: [original.privateMemory] },
    }),
  );
  const exported = await archive(original, {
    scope: 'agents-selected',
    agentGlobalIds: original.globals,
  });
  const target = await fixture('selected-target');
  const invalidClosure = structuredClone(exported);
  for (const chunk of invalidClosure.chunks.filter((c) => c.table === 'memories'))
    for (const [i, encoded] of chunk.rows.entries()) {
      const envelope = decodeRow(encoded);
      if (decodeRow(envelope.record)._id === original.privateMemory) {
        envelope.role = 'dependency';
        chunk.rows[i] = encodeRow(envelope);
      }
    }
  await resign(original, invalidClosure);
  await expectPreflightFailure(
    target,
    invalidClosure,
    options(target, invalidClosure),
    'SELECTIVE_IMPORT_ORPHAN_DEPENDENCY',
  );
  const configured = options(target, exported);
  const complete = await apply(target, await start(target, exported, configured));
  const memories = await target.t.run((ctx) => ctx.db.query('memories').collect());
  const first = memories.find((m) => m.description === 'source memory 0')!;
  const second = memories.find((m) => m.description === 'source other-owner PRIVATE')!;
  expect(first.agentGlobalId).toBe(complete.targetOwners[0].agentGlobalId);
  expect(second.agentGlobalId).toBe(complete.targetOwners[1].agentGlobalId);
  expect(first.data).toEqual({ type: 'reflection', relatedMemoryIds: [second._id] });
  const skipTarget = await fixture('selected-skip-target');
  const skipped = options(skipTarget, exported);
  skipped.owners[1] = { sourceAgentGlobalId: original.globals[1], operation: 'skip' };
  await expectPreflightFailure(
    skipTarget,
    exported,
    skipped,
    'SELECTIVE_IMPORT_EXTERNAL_MAPPING_REQUIRED',
  );
  skipped.externalReferences = [
    {
      sourceId: original.privateMemory,
      sourceAgentGlobalId: original.globals[0],
      operation: 'skip-edge',
    },
  ];
  const result = await apply(skipTarget, await start(skipTarget, exported, skipped));
  expect(result.targetOwners).toHaveLength(1);
  expect(result.report.externalEdgesSkipped).toBe(1);
  const skippedMemory = await skipTarget.t.run((ctx) =>
    ctx.db
      .query('memories')
      .filter((q) => q.eq(q.field('description'), 'source memory 0'))
      .unique(),
  );
  expect(skippedMemory?.data).toEqual({ type: 'reflection', relatedMemoryIds: [] });
});

test('failed application resumes the saved remap checkpoint and retains allocated memory IDs', async () => {
  const original = await fixture(),
    exported = await archive(original),
    target = await fixture('resume-target');
  const jobId = await start(target, exported),
    ready = await drive(target, jobId, 'READY');
  await expect(
    target.t.mutation(am('startApply'), {
      adminToken,
      jobId,
      expectedPlanDigest: 'unreviewed',
      expectedTargetDigest: ready.targetDigest,
      confirmChanges: true,
    }),
  ).rejects.toThrow('SELECTIVE_IMPORT_REVIEW_REQUIRED');
  await target.t.mutation(am('startApply'), {
    adminToken,
    jobId,
    expectedPlanDigest: ready.planDigest,
    expectedTargetDigest: ready.targetDigest,
    confirmChanges: true,
  });
  await drive(target, jobId, 'REMAP');
  const allocated = await target.t.run((ctx) =>
    ctx.db
      .query('memories')
      .filter((q) => q.eq(q.field('description'), 'source memory 0'))
      .unique(),
  );
  await target.t.mutation(am('fail'), { jobId, error: 'Injected interruption after allocation' });
  expect(await target.t.query(aq('status'), { adminToken, jobId })).toMatchObject({
    state: 'FAILED',
    phase: 'REMAP',
  });
  await target.t.mutation(am('resume'), { adminToken, jobId });
  const completed = await drive(target, jobId);
  expect(completed.state).toBe('COMPLETE');
  const restored = await target.t.run((ctx) => ctx.db.get(allocated!._id));
  expect(restored?.description).toBe('source memory 0');
  expect(restored?.data.type === 'reflection' && restored.data.relatedMemoryIds).toHaveLength(1);
});

async function selectiveLostAck(f: Fixture, fn:any, method:string, args:any) {
  let lost=false;
  try { return await f.t.action(async ctx => fn._handler({...ctx,runMutation:async (ref:any,values:any) => {
    const result = await ctx.runMutation(ref,values);
    if (!lost && getFunctionName(ref).endsWith(`:${method}`)) {lost=true;throw new Error('SIMULATED_PUBLICATION_ACK_LOST');}
    return result;
  }},args)); } finally { expect(lost).toBe(true); }
}
test('selective import-job and staged-chunk lost responses preserve referenced entities for duplicate retry', async () => {
  const src=await fixture(), source=await archive(src), dst=await fixture('target');
  await expect(selectiveLostAck(dst,selectiveImportFunctions.createImport,'createImportJob',{adminToken,manifest:source.manifest,signature:source.signature,...options(dst,source)})).rejects.toThrow('SIMULATED_PUBLICATION_ACK_LOST');
  const job=await dst.t.run(ctx=>ctx.db.query('backupLargeJobs').filter(q=>q.eq(q.field('kind'),'import')).first());
  expect(await dst.t.run(async ctx => !!(await ctx.storage.get(job!.manifestStorageId!)))).toBe(true);
  const chunk=source.chunks[0];
  await expect(selectiveLostAck(dst,selectiveImportFunctions.stageChunk,'saveChunk',{adminToken,jobId:job!._id,chunk:JSON.stringify(chunk)})).rejects.toThrow('SIMULATED_PUBLICATION_ACK_LOST');
  const accepted=await dst.t.run(ctx=>ctx.db.query('backupLargeChunks').withIndex('job_index',q=>q.eq('jobId',job!._id).eq('index',0)).unique());
  expect(await dst.t.run(async ctx => !!(await ctx.storage.get(accepted!.storageId)))).toBe(true);
  await dst.t.action(aa('stageChunk'),{adminToken,jobId:job!._id,chunk:JSON.stringify(chunk)});
  expect(await dst.t.run(async ctx => !!(await ctx.storage.get(accepted!.storageId)))).toBe(true);
  expect(await dst.t.run(ctx=>ctx.db.query('backupLargeChunks').withIndex('job_index',q=>q.eq('jobId',job!._id)).collect())).toHaveLength(1);
  await dst.t.mutation(am('cancel'),{adminToken,jobId:job!._id});
});

test('lost target-snapshot response preserves private rollback data through resumed partial application and cancellation', async () => {
  const src=await fixture(), source=await archive(src), dst=await fixture('target');
  const before=await dst.t.run(async ctx=>({memories:await ctx.db.query('memories').collect(),worlds:await ctx.db.query('worlds').collect(),bindings:await ctx.db.query('residentModelBindings').collect()}));
  const jobId=await start(dst,source);
  await drive(dst,jobId,'CAPTURE_TARGET');
  await selectiveLostAck(dst,selectiveImportFunctions.advanceImport,'saveCapture',{adminToken,jobId});
  const saved=await dst.t.run(ctx=>ctx.db.query('backupLargeChunks').withIndex('job_index',q=>q.eq('jobId',jobId).gte('index',source.manifest.chunks.length)).collect());
  expect(saved.length).toBeGreaterThan(0);
  for (const chunk of saved) expect(await dst.t.run(async ctx => !!(await ctx.storage.get(chunk.storageId)))).toBe(true);
  await dst.t.mutation(am('resume'),{adminToken,jobId});
  const ready=await drive(dst,jobId,'READY');
  await dst.t.mutation(am('startApply'),{adminToken,jobId,expectedPlanDigest:ready.planDigest,expectedTargetDigest:ready.targetDigest,confirmChanges:true});
  await drive(dst,jobId,'ALLOCATE');
  await dst.t.action(aa('advanceImport'),{adminToken,jobId});
  await dst.t.mutation(am('cancel'),{adminToken,jobId});
  await drive(dst,jobId,'CANCELLED');
  expect(await dst.t.run(async ctx=>({memories:await ctx.db.query('memories').collect(),worlds:await ctx.db.query('worlds').collect(),bindings:await ctx.db.query('residentModelBindings').collect()}))).toEqual(before);
});

test('repeated cancellation and failed rollback cancellation preserve the current restore checkpoint', async () => {
  const src=await fixture(), source=await archive(src), dst=await fixture('target');
  const before=await dst.t.run(async ctx=>({memories:await ctx.db.query('memories').collect(),worlds:await ctx.db.query('worlds').collect(),bindings:await ctx.db.query('residentModelBindings').collect()}));
  const jobId=await start(dst,source),ready=await drive(dst,jobId,'READY');
  await dst.t.mutation(am('startApply'),{adminToken,jobId,expectedPlanDigest:ready.planDigest,expectedTargetDigest:ready.targetDigest,confirmChanges:true});
  await drive(dst,jobId,'REMAP');
  await dst.t.mutation(am('cancel'),{adminToken,jobId});
  await drive(dst,jobId,'ROLLBACK_RESTORE');
  await dst.t.action(aa('advanceImport'),{adminToken,jobId});
  const checkpoint=await dst.t.run(ctx=>ctx.db.get(jobId));
  expect(checkpoint!.state).toBe('ROLLING_BACK');
  expect(checkpoint!.processedChunks).toBeGreaterThan(0);
  await dst.t.mutation(am('cancel'),{adminToken,jobId});
  const repeated=await dst.t.run(ctx=>ctx.db.get(jobId));
  expect(repeated!.phase).toBe(checkpoint!.phase);
  expect(repeated!.processedChunks).toBe(checkpoint!.processedChunks);
  await dst.t.mutation(ref('backupSelectiveImport','fail','mutation'),{jobId,error:'Simulated rollback request failure'});
  await dst.t.mutation(am('cancel'),{adminToken,jobId});
  const recovered=await dst.t.run(ctx=>ctx.db.get(jobId));
  expect(recovered!.state).toBe('ROLLING_BACK');
  expect(recovered!.phase).toBe(checkpoint!.phase);
  expect(recovered!.processedChunks).toBe(checkpoint!.processedChunks);
  await drive(dst,jobId,'CANCELLED');
  expect(await dst.t.run(async ctx=>({memories:await ctx.db.query('memories').collect(),worlds:await ctx.db.query('worlds').collect(),bindings:await ctx.db.query('residentModelBindings').collect()}))).toEqual(before);
});
