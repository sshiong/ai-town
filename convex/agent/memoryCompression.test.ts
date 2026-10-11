import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { parseSummaries } from './memoryCompression';
import { currentMemory } from './memorySources';
import type { Id } from '../_generated/dataModel';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../agent/memoryCompression.ts': () => import('./memoryCompression'),
};
const ref = (name: string) => makeFunctionReference<'mutation'>(`agent/memoryCompression:${name}`);
const adminToken = 'compression-fixture-admin';
const previousToken = process.env.FEDERATION_ADMIN_TOKEN;
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1791696000000); process.env.FEDERATION_ADMIN_TOKEN = adminToken; });
afterEach(() => {
  jest.useRealTimers();
  if (previousToken === undefined) delete process.env.FEDERATION_ADMIN_TOKEN;
  else process.env.FEDERATION_ADMIN_TOKEN = previousToken;
});

async function fixture(count = 9, description = 'Original observation') {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const worldId = await ctx.db.insert('worlds', { nextId: 1, players: [], agents: [], conversations: [] });
    const profileId = await ctx.db.insert('chatProfiles', { name: 'Fixture', provider: 'ollama', url: 'http://fixture.example', model: 'fixture', stopWords: [], createdAt: Date.now() });
    await ctx.db.insert('residentModelBindings', { worldId, playerId: 'p:0', agentGlobalId: 'home/agent:a', chatProfileId: profileId, createdAt: Date.now(), updatedAt: Date.now() });
    const memoryIds = [];
    for (let i = 0; i < count; i++) memoryIds.push(await ctx.db.insert('memories', {
      worldId, playerId: 'p:0', agentGlobalId: 'home/agent:a', description: `${description} ${i}`, importance: 5, lastAccess: Date.now(),
      data: { type: 'travel', eventId: `event:${i}`, visitId: 'visit:fixture', hostTownId: 'host', participants: [], occurredAt: Date.now() },
    }));
    return { worldId, memoryIds };
  });
  return { t, ...ids, playerId: 'p:0' as const };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  const jobId = await f.t.mutation(ref('start'), { adminToken, worldId: f.worldId, playerId: f.playerId }) as Id<'memoryCompressionJobs'>;
  for (let step = 0; step < 30; step++) {
    await f.t.mutation(ref('capture'), { jobId });
    const job = await f.t.run(ctx => ctx.db.get(jobId));
    if (job!.state !== 'CAPTURING') return { jobId, job: job! };
  }
  throw new Error('CAPTURE_DID_NOT_COMPLETE');
}

test('capture checkpoints one page, caps each batch, and excludes post-snapshot observations', async () => {
  const f = await fixture();
  const jobId = await f.t.mutation(ref('start'), { adminToken, worldId: f.worldId, playerId: f.playerId }) as Id<'memoryCompressionJobs'>;
  await f.t.mutation(ref('capture'), { jobId });
  const first = (await f.t.run(ctx => ctx.db.get(jobId)))!;
  expect(first.sources).toHaveLength(1);
  expect(first.state).toBe('CAPTURING');
  expect(first.cursor).not.toBeNull();
  jest.setSystemTime(Date.now() + 1000);
  const late = await f.t.run(ctx => ctx.db.insert('memories', {
    worldId: f.worldId, playerId: f.playerId, description: 'Late observation', importance: 5, lastAccess: Date.now(),
    data: { type: 'travel', eventId: 'late', visitId: 'v', hostTownId: 'h', participants: [], occurredAt: Date.now() },
  }));
  for (let i = 0; i < 7; i++) await f.t.mutation(ref('capture'), { jobId });
  const batch = (await f.t.run(ctx => ctx.db.get(jobId)))!;
  expect(batch.state).toBe('READY');
  expect(batch.sources).toHaveLength(8);
  expect(batch.sources.map(source => source.memoryId)).not.toContain(late);
});

test('successful commit preserves originals, records subjective provenance, and consumes claims once', async () => {
  const f = await fixture(2), { jobId } = await ready(f);
  const originals = await f.t.run(async ctx => Promise.all(f.memoryIds.map(id => ctx.db.get(id))));
  const token = await f.t.mutation(ref('lease'), { jobId });
  const args = { jobId, revision: token!.revision, summaries: [{ description: 'My subjective recollection', sourceIndexes: [0, 1], importance: 5, confidence: 0.6 }] };
  expect(await f.t.mutation(ref('finish'), args)).toBe(true);
  expect(await f.t.mutation(ref('finish'), args)).toBe(false);
  await f.t.run(async ctx => {
    expect(await Promise.all(f.memoryIds.map(id => ctx.db.get(id)))).toEqual(originals);
    const provenance = await ctx.db.query('memorySummaryProvenance').collect();
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({ subjective: true, confidenceKind: 'MODEL_ESTIMATE', confidence: 0.6 });
    expect(provenance[0].sources.map(source => source.memoryId)).toEqual(f.memoryIds);
    const claims = await ctx.db.query('memorySourceClaims').collect();
    expect(claims).toHaveLength(2);
    expect(claims.every(claim => claim.state === 'DONE')).toBe(true);
  });
  const next = await ready(f);
  expect(next.job.state).toBe('DONE');
  expect(next.job.sources).toHaveLength(0);
});

test('expired action responses cannot commit after recovery or cancellation', async () => {
  const f = await fixture(2), { jobId } = await ready(f);
  const token = await f.t.mutation(ref('lease'), { jobId });
  jest.setSystemTime(Date.now() + 10 * 60_000 + 1);
  await f.t.mutation(ref('recover'), {});
  expect(await f.t.mutation(ref('finish'), { jobId, revision: token!.revision, summaries: [{ description: 'Stale', sourceIndexes: [0, 1], importance: 5 }] })).toBe(false);
  await f.t.mutation(ref('cancel'), { adminToken, jobId });
  await f.t.mutation(ref('capture'), { jobId });
  await f.t.run(async ctx => {
    expect((await ctx.db.get(jobId))!.state).toBe('CANCELLED');
    expect(await ctx.db.query('memorySourceClaims').collect()).toEqual([]);
    expect(await ctx.db.query('memorySummaryProvenance').collect()).toEqual([]);
  });
});

test('source changes fence commit and a correction cannot cite another resident evidence', async () => {
  const f = await fixture(2), { jobId } = await ready(f);
  const token = await f.t.mutation(ref('lease'), { jobId });
  const foreignId = await f.t.run(async ctx => {
    await ctx.db.patch(f.memoryIds[0], { description: 'Changed authoritative source' });
    return ctx.db.insert('memories', { worldId: f.worldId, playerId: 'p:1', description: 'Private foreign source', importance: 5,
      lastAccess: Date.now(), data: { type: 'reflection', relatedMemoryIds: [] } });
  });
  await expect(f.t.mutation(ref('finish'), { jobId, revision: token!.revision, summaries: [{ description: 'Obsolete', sourceIndexes: [0, 1], importance: 5 }] })).rejects.toThrow('MEMORY_SOURCE_CHANGED');
  await expect(f.t.mutation(ref('appendCorrection'), { adminToken, worldId: f.worldId, playerId: f.playerId,
    sourceMemoryId: f.memoryIds[0], evidenceMemoryIds: [foreignId], text: 'Reported', operator: 'fixture' })).rejects.toThrow('MEMORY_SOURCE_OWNER_MISMATCH');
  await f.t.run(async ctx => {
    expect(await ctx.db.query('memorySummaryProvenance').collect()).toEqual([]);
    expect(await ctx.db.query('memorySourceCorrections').collect()).toEqual([]);
  });
});

test('authentication protects job admission and repeated start returns the active batch', async () => {
  const f = await fixture(1);
  await expect(f.t.mutation(ref('start'), { adminToken: 'wrong-token', worldId: f.worldId, playerId: f.playerId })).rejects.toThrow();
  const args = { adminToken, worldId: f.worldId, playerId: f.playerId };
  expect(await f.t.mutation(ref('start'), args)).toBe(await f.t.mutation(ref('start'), args));
  expect(await f.t.run(ctx => ctx.db.query('memoryCompressionJobs').collect())).toHaveLength(1);
});

test('append-only corrections invalidate old summaries and preserve the exact original source', async () => {
  const f = await fixture(1), { jobId } = await ready(f);
  const original = await f.t.run(ctx => ctx.db.get(f.memoryIds[0]));
  const token = await f.t.mutation(ref('lease'), { jobId });
  await f.t.mutation(ref('finish'), { jobId, revision: token!.revision, summaries: [{ description: 'My recollection', sourceIndexes: [0], importance: 5 }] });
  const correctionArgs = { adminToken, worldId: f.worldId, playerId: f.playerId, sourceMemoryId: f.memoryIds[0], evidenceMemoryIds: [], text: 'A reported correction', operator: 'fixture operator' };
  const correctionId = await f.t.mutation(ref('appendCorrection'), correctionArgs);
  await expect(f.t.mutation(ref('appendCorrection'), correctionArgs)).rejects.toThrow('MEMORY_CORRECTION_HEAD_CHANGED');
  await f.t.run(async ctx => {
    expect(await ctx.db.get(f.memoryIds[0])).toEqual(original);
    const provenance = (await ctx.db.query('memorySummaryProvenance').collect())[0];
    expect(await currentMemory(ctx.db, (await ctx.db.get(provenance.summaryMemoryId))!)).toBeNull();
    const corrected = await currentMemory(ctx.db, original!);
    expect(corrected!.description).toContain('administrator report, not verified fact');
    expect(corrected!.description).toContain('A reported correction');
  });
  const next = await ready(f);
  expect(next.job.state).toBe('READY');
  expect(next.job.sources[0].correctionId).toBe(correctionId);
});

test('oversized original fails explicitly without rewriting it or retaining a claim', async () => {
  const f = await fixture(1, 'x'.repeat(24_001)), { job } = await ready(f);
  expect(job.state).toBe('FAILED');
  expect(job.errorCode).toBe('MEMORY_SOURCE_TOO_LARGE');
  await f.t.run(async ctx => {
    expect((await ctx.db.get(f.memoryIds[0]))!.description).toHaveLength(24_003);
    expect(await ctx.db.query('memorySourceClaims').collect()).toEqual([]);
  });
});

test('model output must cover all sources and cannot invent source indexes or certainty', () => {
  const summary = { description: 'I recall', sourceIndexes: [0, 1], importance: 5 };
  expect(parseSummaries(JSON.stringify([summary]), 2)).toEqual([summary]);
  expect(() => parseSummaries(JSON.stringify([{ ...summary, sourceIndexes: [0] }]), 2)).toThrow('MEMORY_SUMMARY_INCOMPLETE');
  for (const invalid of [{ sourceIndexes: [0, 2] }, { sourceIndexes: [0, 0] }, { confidence: 1.1 }, { description: '' }])
    expect(() => parseSummaries(JSON.stringify([{ ...summary, ...invalid }]), 2)).toThrow('MEMORY_SUMMARY_INVALID');
});

test('batch prompt counts complete corrections, JSON escaping, and instructions before claiming sources', async () => {
  const f = await fixture(3, '"'.repeat(4500));
  const correction = 'Reported correction '.repeat(180) + 'COMPLETE_CORRECTION_END';
  for (const sourceMemoryId of f.memoryIds) await f.t.mutation(ref('appendCorrection'), {
    adminToken, worldId: f.worldId, playerId: f.playerId, sourceMemoryId,
    evidenceMemoryIds: [], text: correction, operator: 'fixture',
  });
  const { jobId, job } = await ready(f);
  expect(job.sources).toHaveLength(1);
  const token = await f.t.mutation(ref('lease'), { jobId });
  const payload = await f.t.query(makeFunctionReference<'query'>('agent/memoryCompression:input'), { jobId, revision: token!.revision });
  expect(payload!.sources[0].correction!.text).toBe(correction);
  expect(new TextEncoder().encode(JSON.stringify(payload!.sources)).byteLength).toBeLessThan(24_000);
  await f.t.mutation(ref('finish'), { jobId, revision: token!.revision,
    summaries: [{ description: 'Reported subjective summary', sourceIndexes: [0], importance: 5 }] });
  await f.t.mutation(ref('capture'), { jobId });
  expect((await f.t.run(ctx => ctx.db.get(jobId)))!.sources[0].memoryId).toBe(f.memoryIds[1]);
  expect((await f.t.run(ctx => ctx.db.get(f.memoryIds[0])))!.description).toBe('"'.repeat(4500) + ' 0');
});

test('JSON-expanded oversized input fails explicitly while retaining the original source', async () => {
  const f = await fixture(1, '"'.repeat(13_000)), { job } = await ready(f);
  expect(job).toMatchObject({ state: 'FAILED', errorCode: 'MEMORY_SOURCE_TOO_LARGE' });
  expect(await f.t.run(ctx => ctx.db.query('memorySourceClaims').collect())).toHaveLength(0);
  expect((await f.t.run(ctx => ctx.db.get(f.memoryIds[0])))!.description).toBe('"'.repeat(13_000) + ' 0');
});
