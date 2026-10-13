import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { createIdentityKeys, digest } from './security';
import { archiveReferenceRevisionKey, dataRevision } from '../models/embeddingDataRevision';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/coldHistory.ts': () => import('./coldHistory'),
  '../federation/coldHistoryChunks.ts': () => import('./coldHistoryChunks'),
};
const token = 'cold-reference-revision-test-token';
const mutation = (name: string) => makeFunctionReference<'mutation'>(`federation/coldHistoryChunks:${name}`);
const action = (name: string) => makeFunctionReference<'action'>(`federation/coldHistoryChunks:${name}`);
jest.setTimeout(60000);
beforeEach(() => {
  process.env.FEDERATION_ADMIN_TOKEN = token;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');
});
afterEach(() => {
  delete process.env.FEDERATION_ADMIN_TOKEN;
  delete process.env.FEDERATION_KEY_ENCRYPTION_KEY;
});
async function fixture(town: string) {
  const t = convexTest(schema, modules), keys = await createIdentityKeys();
  const owner = await t.run(async ctx => {
    await ctx.db.insert('federationIdentity', { ...keys, townId: town, townName: town,
      deploymentInstanceId: `${town}-instance`, deploymentEpoch: 1, endpoint: `https://${town}.example/federation/v1`,
      enabled: false, allowIncomingPairRequests: false, allowUnencryptedHttp: false, allowPublicHttp: false,
      maxVisitors: 1, maxVisitDurationMs: 300000, mode: 'ACTIVE', createdAt: 1 });
    const worldId = await ctx.db.insert('worlds', { nextId: 3, players: [], agents: [], conversations: [] });
    const agentGlobalId = `${town}/owner`;
    const chatProfileId = await ctx.db.insert('chatProfiles', { name: 'test', provider: 'ollama',
      url: 'http://localhost:11434', model: 'test', stopWords: [], createdAt: 1 });
    await ctx.db.insert('residentModelBindings', { worldId, playerId: 'p:0', agentGlobalId, chatProfileId, createdAt: 1, updatedAt: 1 });
    const memoryId = await ctx.db.insert('memories', { worldId, playerId: 'p:0', agentGlobalId, description: 'source', importance: 1,
      lastAccess: 1, data: { type: 'conversation', conversationId: 'c:1', playerIds: ['p:1'] } });
    await ctx.db.insert('archivedConversations', { worldId, id: 'c:1', creator: 'p:0', created: 1, ended: 2,
      numMessages: 1, participants: ['p:0', 'p:1'] });
    await ctx.db.insert('messages', { worldId, conversationId: 'c:1', author: 'p:0', messageUuid: 'one', text: 'retained' });
    return { worldId, memoryId, playerId: 'p:0', agentGlobalId, adminToken: token };
  });
  return { t, owner, revision: () => t.run(ctx => dataRevision(ctx.db, archiveReferenceRevisionKey)) };
}
test('cold chunk archive and import writers invalidate reference generations while owning their maintenance lock', async () => {
  const src = await fixture('source');
  const started = await src.t.mutation(mutation('start'), src.owner);
  expect(await src.revision()).toBeGreaterThan(0);
  const beforeCapture = await src.revision();
  await src.t.action(action('advance'), { ...src.owner, jobId: started.jobId });
  expect(await src.revision()).toBeGreaterThan(beforeCapture);
  for (let n = 0; n < 10; n++) {
    const result = await src.t.action(action('advance'), { ...src.owner, jobId: started.jobId });
    if (result.state === 'FAILED') throw new Error(result.error);
    if (result.state === 'COMPLETE') break;
  }
  const root = await src.t.action(action('exportHeader'), src.owner);
  const part = await src.t.action(action('exportPart'), { ...src.owner, index: 0 });
  const dst = await fixture('target');
  const imported = await dst.t.mutation(mutation('startImport'), { ...dst.owner,
    rootJson: JSON.stringify(root), expectedFingerprint: `sha256:${await digest(root.publicKey)}`, authorAliases: [] });
  const beforePart = await dst.revision();
  expect(beforePart).toBeGreaterThan(0);
  await dst.t.action(action('acceptPart'), { ...dst.owner, jobId: imported.jobId, fileJson: JSON.stringify(part) });
  expect(await dst.revision()).toBeGreaterThan(beforePart);
  const beforeCancel = await dst.revision();
  await dst.t.mutation(mutation('cancel'), { ...dst.owner, jobId: imported.jobId });
  expect(await dst.revision()).toBeGreaterThan(beforeCancel);
});
