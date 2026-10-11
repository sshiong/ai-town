import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import * as embeddings from './embeddings';
import { memorySourceDigest, withEmbeddingRevision } from './embeddingDataRevision';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../models/embeddings.ts': () => import('./embeddings'),
  '../models/profiles.ts': () => import('./profiles'),
  '../models/usage.ts': () => import('./usage'),
};
const mutation = (name: string) => makeFunctionReference<'mutation'>(`models/embeddings:${name}`);
const query = (name: string) => makeFunctionReference<'query'>(`models/embeddings:${name}`);
const action = (name: string) => makeFunctionReference<'action'>(`models/embeddings:${name}`);
const adminToken = 'test-admin-token-24-characters';
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
beforeEach(() => { jest.useFakeTimers(); process.env.FEDERATION_ADMIN_TOKEN = adminToken; });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

async function fixture(count = 2607) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const worldId = await ctx.db.insert('worlds', { nextId: 3, players: [], agents: [], conversations: [] });
    const profileId = await ctx.db.insert('embeddingProfiles', { name: 'Target', provider: 'custom', url: 'https://embed.example', model: 'target', dimensions: 2,
      preprocessingRevision: 'newline-to-space-v1', queryPrefix: '', documentPrefix: '', normalization: 'none', fingerprint: 'target', createdAt: 1 });
    const old = await ctx.db.insert('embeddingSpaces', { profileId, fingerprint: 'old', status: 'ACTIVE', createdAt: 1 });
    const next = await ctx.db.insert('embeddingSpaces', { profileId, fingerprint: 'next', status: 'BUILDING', createdAt: 2 });
    await ctx.db.insert('modelSettings', { key: 'town', activeEmbeddingSpaceId: old });
    return { worldId, profileId, old, next };
  });
  const memories: Id<'memories'>[] = [], vectors: Id<'modelMemoryVectors'>[] = [];
  for (let offset = 0; offset < count; offset += 100) await t.run(async ctx => {
    for (let i = offset; i < Math.min(count, offset + 100); i++) {
      const memory = { worldId: ids.worldId, playerId: 'p:0' as const, agentGlobalId: 'home/owner', description: i < 3 ? 'Travel anchor' : `Unrelated canonical fact ${i}`,
        importance: 8, lastAccess: 1, data: { type: 'reflection' as const, relatedMemoryIds: [] } };
      const memoryId = await ctx.db.insert('memories', memory);
      memories.push(memoryId);
      const vector = { memoryId, worldId: ids.worldId, playerId: memory.playerId, agentGlobalId: memory.agentGlobalId,
        sourceDigest: await memorySourceDigest(memory), embedding: i < 3 ? [1, 0] : [0, 1] };
      vectors.push(await ctx.db.insert('modelMemoryVectors', { ...vector, spaceId: ids.next }));
      await ctx.db.insert('modelMemoryVectors', { ...vector, spaceId: ids.old });
    }
  });
  // A different owner and a different space have equally scoring negatives; both must be excluded.
  await t.run(async ctx => {
    const fields = { worldId: ids.worldId, playerId: 'p:1' as const, agentGlobalId: 'home/other', description: 'Other owner secret', importance: 1, lastAccess: 1,
      data: { type: 'reflection' as const, relatedMemoryIds: [] } };
    const memoryId = await ctx.db.insert('memories', fields);
    for (const spaceId of [ids.next, ids.old]) await ctx.db.insert('modelMemoryVectors', { memoryId, spaceId, worldId: ids.worldId, playerId: fields.playerId,
      agentGlobalId: fields.agentGlobalId, sourceDigest: await memorySourceDigest(fields), embedding: [1, 0] });
  });
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
  return { t, ...ids, memories, vectors };
}

async function onePage(t: ReturnType<typeof convexTest>, jobId: any) {
  let paginates = 0;
  await t.run(async ctx => {
    function boundedQuery(value: any): any {
      return new Proxy(value, { get(target, key) {
        const method = Reflect.get(target, key);
        if (key === 'collect') return () => { throw new Error('UNBOUNDED_SCAN_FORBIDDEN'); };
        if (key === 'paginate') return (options: any) => {
          if (++paginates > 1) throw new Error('MULTIPLE_PAGINATES_FORBIDDEN');
          expect(options.numItems).toBeLessThanOrEqual(25);
          expect(options.maximumBytesRead).toBeLessThanOrEqual(512000);
          return method.call(target, options);
        };
        if (typeof method !== 'function') return method;
        return (...args: any[]) => {
          const result = method.apply(target, args);
          return result && typeof result === 'object' && typeof result.paginate === 'function' ? boundedQuery(result) : result;
        };
      } });
    }
    const db = new Proxy(ctx.db, { get(target, key) {
      if (key === 'query') return (...args: any[]) => boundedQuery((target.query as any)(...args));
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await (embeddings.advanceScanPage as any)._handler({ ...ctx, db }, { jobId });
  });
  return paginates;
}
async function drain(t: ReturnType<typeof convexTest>, jobId: any) {
  let pages = 0;
  for (let i = 0; i < 5000; i++) {
    const job = await t.query(query('scanJob'), { jobId });
    if (job && ['DONE', 'FAILED'].includes(job.phase)) return { ...job, pages };
    if (job?.phase === 'SAMPLES' && !job.queryVector) {
      await t.action(action('scanWork'), { jobId });
      pages++;
    } else pages += await onePage(t, jobId);
  }
  throw new Error('SCAN_DID_NOT_FINISH');
}

 test('over 2500 memories use persistent bounded planning, complete coverage, expected retrieval and rollback', async () => {
  const f = await fixture();
  const jobId = await f.t.mutation(mutation('startSwitchPlan'), { adminToken, targetProfileId: f.profileId });
  expect((await f.t.query(query('planSwitch'), { adminToken, targetProfileId: f.profileId })).planningComplete).toBe(false);
  const plan = await drain(f.t, jobId);
  expect(plan.pages).toBeGreaterThan(100);
  expect(plan.memoryCount).toBe(2608);
  expect((await f.t.query(query('planSwitch'), { adminToken, targetProfileId: f.profileId }))).toMatchObject({ affectedMemories: 2608, planningComplete: true, canReuse: false });
  const start = await f.t.action(action('validateSpace'), { adminToken, spaceId: f.next });
  // The process can stop after any page; a repeated Validate reuses the saved job.
  await onePage(f.t, start.jobId);
  expect((await f.t.action(action('validateSpace'), { adminToken, spaceId: f.next })).jobId).toBe(start.jobId);
  await expect(f.t.mutation(mutation('activateSpace'), { adminToken, spaceId: f.next })).rejects.toThrow('EMBEDDING_SPACE_NOT_VALIDATED');
  const validated = await drain(f.t, start.jobId);
  expect(validated).toMatchObject({ phase: 'DONE', sampleCount: 3, memoryCount: 2608, vectorCount: 2608 });
  expect(validated.pages).toBeGreaterThan(500);
  await f.t.mutation(mutation('activateSpace'), { adminToken, spaceId: f.next });
  expect((await f.t.query(query('getRoute'), {})).space._id).toBe(f.next);
  const oldValidation = await f.t.action(action('validateSpace'), { adminToken, spaceId: f.old });
  expect((await drain(f.t, oldValidation.jobId)).phase).toBe('DONE');
  await f.t.mutation(mutation('rollback'), { adminToken, spaceId: f.old });
  expect((await f.t.query(query('getRoute'), {})).space._id).toBe(f.old);
  expect(await f.t.run(ctx => ctx.db.query('modelMemoryVectors').collect())).toHaveLength(5216);
}, 300000);

 test('late-page missing vector, extra owner vector and late negative cannot authorize activation', async () => {
  const f = await fixture();
  await f.t.run(ctx => withEmbeddingRevision(ctx).db.delete(f.vectors[2580]));
  const missing = await drain(f.t, await f.t.mutation(mutation('finishBuild'), { spaceId: f.next }));
  expect(missing.memoryCount).toBeGreaterThan(2500);
  expect(missing.failure).toContain('EMBEDDING_COVERAGE_INCOMPLETE');
  await f.t.mutation(mutation('putVector'), { memoryId: f.memories[2580], spaceId: f.next, worldId: f.worldId, agentGlobalId: 'home/owner', embedding: [0, 1] });
  const extraId = await f.t.run(async ctx => {
    const original = await ctx.db.get(f.vectors[2579]);
    const { _id, _creationTime, ...fields } = original!;
    return withEmbeddingRevision(ctx).db.insert('modelMemoryVectors', { ...fields, playerId: 'p:2', agentGlobalId: 'forged/owner' });
  });
  const extra = await drain(f.t, await f.t.mutation(mutation('finishBuild'), { spaceId: f.next }));
  expect(extra.phase).toBe('FAILED');
  expect(extra.memoryCount).toBeGreaterThan(2500);
  await f.t.run(ctx => withEmbeddingRevision(ctx).db.delete(extraId));
  await f.t.run(ctx => withEmbeddingRevision(ctx).db.patch(f.vectors[2581], { embedding: [1, 0] }));
  const start = await f.t.action(action('validateSpace'), { adminToken, spaceId: f.next });
  const negative = await drain(f.t, start.jobId);
  expect(negative.phase).toBe('FAILED');
  expect(negative.memoryCount).toBe(2608);
  expect(negative.failure).toContain('EMBEDDING_RETRIEVAL_SAMPLE_MISSED');
  await expect(f.t.mutation(mutation('activateSpace'), { adminToken, spaceId: f.next })).rejects.toThrow('EMBEDDING_SPACE_NOT_VALIDATED');
  expect((await f.t.query(query('getRoute'), {})).space._id).toBe(f.old);
}, 300000);

 test('material source changes invalidate scans and atomic certificates; new memory catches up without changing active routing', async () => {
  const f = await fixture(81);
  const start = await f.t.action(action('validateSpace'), { adminToken, spaceId: f.next });
  await onePage(f.t, start.jobId);
  const inserted = await f.t.run(ctx => withEmbeddingRevision(ctx).db.insert('memories', {
    worldId: f.worldId, playerId: 'p:0', agentGlobalId: 'home/owner', description: 'Concurrent fact', importance: 9, lastAccess: 1,
    data: { type: 'reflection', relatedMemoryIds: [] },
  }));
  await f.t.mutation(mutation('putVector'), { memoryId: inserted, spaceId: f.next, worldId: f.worldId, agentGlobalId: 'home/owner', embedding: [0, 1] });
  expect((await f.t.query(query('getRoute'), {})).space._id).toBe(f.old);
  const done = await drain(f.t, start.jobId);
  expect(done).toMatchObject({ phase: 'DONE', memoryCount: 83, vectorCount: 83, restarts: 1 });
  await f.t.run(ctx => withEmbeddingRevision(ctx).db.patch(f.memories[0], { lastAccess: 100 }));
  // Last access is not source text or ownership and must not invalidate the certificate.
  await f.t.mutation(mutation('activateSpace'), { adminToken, spaceId: f.next });
  await f.t.run(ctx => withEmbeddingRevision(ctx).db.patch(f.memories[0], { description: 'Edited after validation' }));
  await expect(f.t.mutation(mutation('activateSpace'), { adminToken, spaceId: f.next })).rejects.toThrow('EMBEDDING_SOURCE_CHANGED');
  const changed = await f.t.action(action('validateSpace'), { adminToken, spaceId: f.next });
  expect((await drain(f.t, changed.jobId)).failure).toContain('EMBEDDING_SOURCE_VECTOR_STALE');
  await expect(f.t.mutation(mutation('putVector'), { memoryId: f.memories[0], spaceId: f.next, worldId: f.worldId, agentGlobalId: 'wrong/owner', embedding: [1, 0] })).rejects.toThrow('MEMORY_OWNER_MISMATCH');
  const memory = await f.t.run(ctx => ctx.db.get(f.memories[0]));
  const sourceDigest = await memorySourceDigest(memory!);
  await f.t.run(ctx => withEmbeddingRevision(ctx).db.patch(f.memories[0], { description: 'Changed during embedding request' }));
  await expect(f.t.mutation(mutation('putVector'), { memoryId: f.memories[0], spaceId: f.next, worldId: f.worldId, agentGlobalId: 'home/owner', expectedSourceDigest: sourceDigest, embedding: [1, 0] })).rejects.toThrow('EMBEDDING_SOURCE_CHANGED');
}, 60000);
