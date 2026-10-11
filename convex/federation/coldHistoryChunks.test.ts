import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import { makeFunctionReference, getFunctionName } from 'convex/server';
import schema from '../schema';
import * as chunksFunctions from './coldHistoryChunks';
import { createIdentityKeys, digest } from './security';
import { validateColdParts, type PortableColdPart } from './coldHistoryChunkFormat';
import type { Id } from '../_generated/dataModel';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/coldHistory.ts': () => import('./coldHistory'),
  '../federation/coldHistoryFiles.ts': () => import('./coldHistoryFiles'),
  '../federation/coldHistoryChunks.ts': () => import('./coldHistoryChunks'),
  '../messages.ts': () => import('../messages'),
};
const token = 'chunked-cold-history-test-admin-token';
const ref = <K extends 'action' | 'query' | 'mutation'>(module: string, name: string, kind: K) =>
  makeFunctionReference<K>(`federation/${module}:${name}`);
const act = (name: string) => ref('coldHistoryChunks', name, 'action');
const mut = (name: string) => ref('coldHistoryChunks', name, 'mutation');
const qry = (name: string) => ref('coldHistoryChunks', name, 'query');
jest.setTimeout(60000);
beforeEach(() => {
  process.env.FEDERATION_ADMIN_TOKEN = token;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');
});
afterEach(() => { delete process.env.FEDERATION_ADMIN_TOKEN; delete process.env.FEDERATION_KEY_ENCRYPTION_KEY; });
async function fixture(count = 1207, town = 'original', large = false) {
  const t = convexTest(schema, modules), keys = await createIdentityKeys();
  const ids = await t.run(async ctx => {
    await ctx.db.insert('federationIdentity', { ...keys, townId: town, townName: town, deploymentInstanceId: `${town}-instance`,
      deploymentEpoch: 1, endpoint: `https://${town}.example/federation/v1`, enabled: false,
      allowIncomingPairRequests: false, allowUnencryptedHttp: false, allowPublicHttp: false,
      maxVisitors: 1, maxVisitDurationMs: 300000, mode: 'ACTIVE', createdAt: 1 });
    const worldId = await ctx.db.insert('worlds', { nextId: 5, players: [], agents: [], conversations: [] });
    const profile = await ctx.db.insert('chatProfiles', { name: 'Fixed', provider: 'ollama', url: 'http://localhost:11434', model: 'fixed', stopWords: [], createdAt: 1 });
    const playerId = town === 'original' ? 'p:0' : 'p:8', other = town === 'original' ? 'p:1' : 'p:9', agentGlobalId = `${town}/ava`;
    await ctx.db.insert('residentModelBindings', { worldId, playerId, agentGlobalId, chatProfileId: profile, createdAt: 1, updatedAt: 1 });
    const memoryId = await ctx.db.insert('memories', { worldId, playerId, agentGlobalId, description: 'Permanent canonical source', importance: 8,
      lastAccess: 1, data: { type: 'conversation', conversationId: 'c:1', playerIds: [other] } });
    await ctx.db.insert('archivedConversations', { worldId, id: 'c:1', creator: playerId, created: 1, ended: 2,
      numMessages: count - 1, participants: [playerId, other] });
    for (let i = 0; i < count; i++) await ctx.db.insert('messages', { worldId, conversationId: 'c:1', author: i % 2 ? other : playerId,
      messageUuid: `uuid-${i}`, text: large ? `${i}:${'x'.repeat(450000)}` : `Original ${i} 原文` });
    return { worldId, memoryId, playerId, agentGlobalId };
  });
  return { t, owner: { ...ids, adminToken: token } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function drive(f: Fixture, jobId: Id<'coldHistoryJobs'>) {
  for (let n = 0; n < 300; n++) {
    const state = await f.t.action(act('advance'), { ...f.owner, jobId });
    if (state.state === 'FAILED') throw new Error(state.error);
    if (state.state === 'COMPLETE') return state;
  }
  throw new Error('Cold job did not finish');
}
async function archive(f: Fixture) {
  const started = await f.t.mutation(mut('start'), f.owner);
  const done = await drive(f, started.jobId);
  const root = await f.t.action(act('exportHeader'), f.owner), parts: PortableColdPart[] = [];
  for (let index = 0; index < root.manifest.chunkCount; index++) parts.push(await f.t.action(act('exportPart'), { ...f.owner, index }));
  return { root, parts, done };
}
async function travelFixture(town = 'original') {
  const f = await fixture(1, town), transcriptId = 'journey/visit';
  await f.t.run(async ctx => {
    await ctx.db.patch(f.owner.memoryId, { data: { type: 'travel', eventId: 'ended', visitId: 'visit', hostTownId: 'host',
      federationConversationId: 'journey', transcriptId, participants: [], occurredAt: 2 } });
    await ctx.db.insert('homeTravelTranscripts', { worldId: f.owner.worldId, playerId: f.owner.playerId,
      agentGlobalId: f.owner.agentGlobalId, transcriptId, visitId: 'visit', hostTownId: 'host', federationConversationId: 'journey',
      endedAt: 2, participants: [], finalPageNumber: 5, receivedPageCount: 6, highestPageNumber: 5,
      totalMessageCount: 1105, state: 'COMPLETE', summaryState: 'DONE', endMemoryId: f.owner.memoryId });
    for (let page = 0; page < 6; page++) await ctx.db.insert('homeTravelTranscriptPages', { agentGlobalId: f.owner.agentGlobalId,
      transcriptId, pageNumber: page, eventId: `page-${page}`, finalPage: page === 5, memoryIds: [f.owner.memoryId],
      messages: Array.from({ length: page === 5 ? 105 : 200 }, (_, n) => ({ messageId: `journey-${page * 200 + n}`,
        text: `Original journey ${page * 200 + n}`, author: page === 5 ? 'host/bob' : f.owner.agentGlobalId, occurredAt: page * 200 + n + 1 })) });
  });
  return f;
}
test('v2 travel preserves >1000 originals and every source page through independent mapped restoration', async () => {
  const src = await travelFixture(), exported = await archive(src), dst = await travelFixture('restored');
  expect(exported.root.manifest.count).toBe(1105);
  expect(new Set(exported.parts.map(p => p.payload.sourcePageNumber)).size).toBe(6);
  const started = await dst.t.mutation(mut('startImport'), { ...dst.owner, rootJson: JSON.stringify(exported.root),
    expectedFingerprint: `sha256:${await digest(exported.root.publicKey)}`,
    authorAliases: [{ sourceAuthor: src.owner.agentGlobalId, targetAuthor: dst.owner.agentGlobalId }] });
  for (const part of exported.parts) await dst.t.action(act('acceptPart'), { ...dst.owner, jobId: started.jobId, fileJson: JSON.stringify(part) });
  await drive(dst, started.jobId);
  for (let index = 0; index < exported.parts.length; index++) expect(await dst.t.action(act('exportPart'), { ...dst.owner, index })).toEqual(exported.parts[index]);
});
test('travel final-page metadata cannot hide a missing page even when its retained total matches', async () => {
  const f = await travelFixture();
  await f.t.run(async ctx => { const transcript = (await ctx.db.query('homeTravelTranscripts').unique())!; await ctx.db.patch(transcript._id, { finalPageNumber: 6 }); });
  const started = await f.t.mutation(mut('start'), f.owner);
  let state;
  for (let n = 0; n < 6; n++) state = await f.t.action(act('advance'), { ...f.owner, jobId: started.jobId });
  expect(state!.state).toBe('FAILED'); expect(state!.error).toContain('COLD_HISTORY_INCOMPLETE_PAGES');
  expect((await f.t.run(ctx => ctx.db.query('coldHistoryArchives').unique()))!.state).toBe('PENDING');
});
test('more than 1000 originals publish with bounded chunks, exact boundary pages, signatures and unchanged hot/canonical data', async () => {
  const f = await fixture(), before = await f.t.run(async ctx => ({ messages: await ctx.db.query('messages').collect(), memory: await ctx.db.get(f.owner.memoryId) }));
  const started = await f.t.action(ref('coldHistory', 'archive', 'action'), f.owner);
  expect(started.phase).toBe('CAPTURE');
  const done = await drive(f, started.jobId); expect(done.count).toBe(1207);
  const first = await f.t.action(ref('coldHistory', 'read', 'action'), { ...f.owner, offset: 24, numItems: 25 });
  expect(first.page.map((m: any) => m.messageId)).toEqual(before.messages.slice(24, 49).map(m => m.messageUuid));
  expect(first.nextOffset).toBe(49);
  const root = await f.t.action(act('exportHeader'), f.owner), parts: PortableColdPart[] = [];
  expect(JSON.stringify(root).length).toBeLessThan(2000);
  for (let index = 0; index < done.chunkCount; index++) parts.push(await f.t.action(act('exportPart'), { ...f.owner, index }));
  await validateColdParts(parts, `sha256:${await digest(root.publicKey)}`);
  expect(parts.flatMap(p => p.payload.messages)).toEqual(before.messages.map(m => ({ messageId: m.messageUuid, text: m.text, authorPlayerId: m.author, occurredAt: m._creationTime })));
  expect(await f.t.run(async ctx => ({ messages: await ctx.db.query('messages').collect(), memory: await ctx.db.get(f.owner.memoryId) }))).toEqual(before);
  expect(await f.t.run(ctx => ctx.db.query('coldHistoryLocks').first())).toBeNull();
});
test('900000-byte aggregate is split without raising the per-object budget or dropping text', async () => {
  const f = await fixture(2, 'original', true), result = await archive(f);
  expect(result.root.manifest.count).toBe(2); expect(result.root.manifest.bytes).toBeGreaterThan(900000);
  expect(result.parts).toHaveLength(2); expect(result.parts.every(p => p.descriptor.bytes <= 480000)).toBe(true);
  expect((await f.t.action(ref('coldHistory', 'read', 'action'), { ...f.owner, offset: 0, numItems: 25 })).page.map((m: any) => m.text.length)).toEqual([450002, 450002]);
});
test('large originals page by response bytes without truncating or skipping any message', async () => {
  const f = await fixture(3, 'original', true), result = await archive(f);
  expect(result.parts).toHaveLength(3);
  const first = await f.t.action(ref('coldHistory', 'read', 'action'), { ...f.owner, offset: 0, numItems: 25 });
  expect(first.page).toHaveLength(2); expect(first.nextOffset).toBe(2); expect(first.isDone).toBe(false);
  expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThan(1_000_000);
  const last = await f.t.action(ref('coldHistory', 'read', 'action'), { ...f.owner, offset: first.nextOffset, numItems: 25 });
  expect(last.page).toHaveLength(1); expect(last.nextOffset).toBe(3); expect(last.isDone).toBe(true);
  expect([...first.page, ...last.page].map((m: any) => m.messageId)).toEqual(['uuid-0', 'uuid-1', 'uuid-2']);
});
test('a single message above the object budget fails with all hot text retained and no published archive', async () => {
  const f = await fixture(1);
  await f.t.run(async ctx => { const message = (await ctx.db.query('messages').unique())!; await ctx.db.patch(message._id, { text: 'x'.repeat(490000) }); });
  const started = await f.t.mutation(mut('start'), f.owner);
  const failed = await f.t.action(act('advance'), { ...f.owner, jobId: started.jobId });
  expect(failed.state).toBe('FAILED'); expect(failed.error).toContain('COLD_HISTORY_SINGLE_MESSAGE_BUDGET');
  expect(await f.t.run(async ctx => (await ctx.db.query('messages').unique())!.text.length)).toBe(490000);
  expect((await f.t.run(ctx => ctx.db.query('coldHistoryArchives').unique()))!.state).toBe('PENDING');
});
test('cross-chunk duplicate UUIDs fail closed, cancellation releases the maintenance lock and a corrected retry gets a fresh snapshot', async () => {
  const f = await fixture(30);
  await f.t.run(async ctx => { const rows = await ctx.db.query('messages').collect(); await ctx.db.patch(rows[29]._id, { messageUuid: rows[0].messageUuid }); });
  const started = await f.t.mutation(mut('start'), f.owner);
  await f.t.action(act('advance'), { ...f.owner, jobId: started.jobId });
  const failed = await f.t.action(act('advance'), { ...f.owner, jobId: started.jobId });
  expect(failed.state).toBe('FAILED'); expect(failed.error).toContain('COLD_HISTORY_EMPTY_OR_DUPLICATE_MESSAGES');
  expect(await f.t.run(ctx => ctx.db.query('coldHistoryLocks').first())).not.toBeNull();
  await f.t.mutation(mut('cancel'), { ...f.owner, jobId: started.jobId });
  expect(await f.t.run(ctx => ctx.db.query('messages').collect())).toHaveLength(30);
  expect(await f.t.run(ctx => ctx.db.query('coldHistoryLocks').first())).toBeNull();
  await f.t.run(async ctx => { const rows = await ctx.db.query('messages').collect(); await ctx.db.patch(rows[29]._id, { messageUuid: 'uuid-29' }); });
  const result = await archive(f); expect(result.done.count).toBe(30);
});
test('independent part import requires every signed contiguous part, preserves source authors/times and rejects tampering before storage publication', async () => {
  const src = await fixture(55), exported = await archive(src), dst = await fixture(55, 'restored');
  const before = await dst.t.run(ctx => ctx.db.query('messages').collect());
  const authorAliases = [{ sourceAuthor: 'p:0', targetAuthor: 'p:8' }, { sourceAuthor: 'p:1', targetAuthor: 'p:9' }];
  const started = await dst.t.mutation(mut('startImport'), { ...dst.owner, rootJson: JSON.stringify(exported.root), expectedFingerprint: `sha256:${await digest(exported.root.publicKey)}`, authorAliases });
  const ownerJob = { ...dst.owner, jobId: started.jobId };
  await expect(dst.t.action(act('acceptPart'), { ...ownerJob, fileJson: JSON.stringify(exported.parts[1]) })).rejects.toThrow('COLD_HISTORY_INCOMPLETE_CHUNKS');
  expect(await dst.t.run(ctx => ctx.db.query('coldHistoryChunks').collect())).toHaveLength(0);
  const forged = structuredClone(exported.parts[0]); forged.payload.messages[0].text = 'Tampered';
  await expect(dst.t.action(act('acceptPart'), { ...ownerJob, fileJson: JSON.stringify(forged) })).rejects.toThrow('COLD_FILE_INTEGRITY_FAILED');
  await dst.t.action(act('acceptPart'), { ...ownerJob, fileJson: JSON.stringify(exported.parts[0]) });
  await dst.t.action(act('acceptPart'), { ...ownerJob, fileJson: JSON.stringify(exported.parts[0]) });
  expect(await dst.t.run(ctx => ctx.db.query('coldHistoryChunks').collect())).toHaveLength(1);
  expect((await dst.t.action(act('advance'), ownerJob)).phase).toBe('IMPORT_STAGE');
  await expect(dst.t.action(ref('coldHistory', 'read', 'action'), { ...dst.owner, offset: 0, numItems: 25 })).rejects.toThrow('COLD_HISTORY_NOT_VERIFIED');
  for (const part of exported.parts.slice(1)) await dst.t.action(act('acceptPart'), { ...ownerJob, fileJson: JSON.stringify(part) });
  await drive(dst, started.jobId);
  for (let index = 0; index < exported.parts.length; index++) expect(await dst.t.action(act('exportPart'), { ...dst.owner, index })).toEqual(exported.parts[index]);
  expect((await dst.t.action(ref('coldHistory', 'read', 'action'), { ...dst.owner, offset: 24, numItems: 25 })).page[0].targetAuthor).toBe('p:8');
  expect(await dst.t.run(ctx => ctx.db.query('messages').collect())).toEqual(before);
});
test.each(['savePage', 'publish'])('a lost %s acknowledgement preserves referenced parts and resumes at the durable revision', async method => {
  const f = await fixture(30), started = await f.t.mutation(mut('start'), f.owner), args = { ...f.owner, jobId: started.jobId };
  if (method === 'publish') for (let n = 0; n < 20; n++) {
    if ((await f.t.query(qry('status'), args)).phase === 'PUBLISH') break;
    await f.t.action(act('advance'), args);
  }
  let lost = false;
  await f.t.action(async ctx => (chunksFunctions.advance as any)._handler({ ...ctx, runMutation: async (reference: any, values: any) => {
    const result = await ctx.runMutation(reference, values);
    if (!lost && getFunctionName(reference).endsWith(`:${method}`)) { lost = true; throw new Error('SIMULATED_COLD_ACK_LOST'); }
    return result;
  } }, args));
  expect(lost).toBe(true);
  await drive(f, started.jobId);
  for (const chunk of await f.t.run(ctx => ctx.db.query('coldHistoryChunks').collect())) expect(await f.t.run(async ctx => !!await ctx.storage.get(chunk.storageId))).toBe(true);
  expect(await f.t.run(ctx => ctx.db.query('messages').collect())).toHaveLength(30);
});
test('a lost independent import-part response keeps its committed storage and duplicate retry resumes safely', async () => {
  const src = await fixture(30), exported = await archive(src), dst = await fixture(30, 'restored');
  const started = await dst.t.mutation(mut('startImport'), { ...dst.owner, rootJson: JSON.stringify(exported.root),
    expectedFingerprint: `sha256:${await digest(exported.root.publicKey)}`,
    authorAliases: [{ sourceAuthor: 'p:0', targetAuthor: 'p:8' }, { sourceAuthor: 'p:1', targetAuthor: 'p:9' }] });
  const args = { ...dst.owner, jobId: started.jobId, fileJson: JSON.stringify(exported.parts[0]) };
  await expect(dst.t.action(async ctx => (chunksFunctions.acceptPart as any)._handler({ ...ctx,
    runMutation: async (reference: any, values: any) => { await ctx.runMutation(reference, values); throw new Error('SIMULATED_IMPORT_PART_ACK_LOST'); } }, args)))
    .rejects.toThrow('SIMULATED_IMPORT_PART_ACK_LOST');
  const row = (await dst.t.run(ctx => ctx.db.query('coldHistoryChunks').unique()))!;
  expect(await dst.t.run(async ctx => !!await ctx.storage.get(row.storageId))).toBe(true);
  await dst.t.action(act('acceptPart'), args);
  for (const part of exported.parts.slice(1)) await dst.t.action(act('acceptPart'), { ...args, fileJson: JSON.stringify(part) });
  await drive(dst, started.jobId);
  expect(await dst.t.action(act('exportPart'), { ...dst.owner, index: 0 })).toEqual(exported.parts[0]);
});
