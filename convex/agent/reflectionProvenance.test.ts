import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../maintenanceFunctions';
import type { Id } from '../_generated/dataModel';
import { parseGameId } from '../aiTown/ids';
import { reflectOnMemories } from './memory';
import { captureSource, currentMemory, sourceDocumentBytes, validateSources } from './memorySources';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../agent/memory.ts': () => import('./memory'),
  '../agent/memoryCompression.ts': () => import('./memoryCompression'),
  '../models/embeddings.ts': () => import('../models/embeddings'),
  '../models/profiles.ts': () => import('../models/profiles'),
  '../models/usage.ts': () => import('../models/usage'),
  '../federation/resources.ts': () => import('../federation/resources'),
};
const mutation = (name: string) => makeFunctionReference<'mutation'>(`agent/memoryCompression:${name}`);
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1791696000000); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

async function fixture(count = 2, importance = 6, description = 'Retained observation') {
  const t = convexTest(schema, modules);
  const result = await t.run(async ctx => {
    const worldId = await ctx.db.insert('worlds', { nextId: 2, players: [{ id: 'p:0', lastInput: 1,
      position: { x: 1, y: 1 }, facing: { dx: 1, dy: 0 }, speed: 0 }], agents: [], conversations: [] });
    await ctx.db.insert('playerDescriptions', { worldId, playerId: 'p:0', name: 'Ava', character: 'f1', description: 'Resident' });
    const chatProfileId = await ctx.db.insert('chatProfiles', { name: 'Fixture', provider: 'ollama',
      url: 'http://fixture.example', model: 'fixture', stopWords: [], createdAt: Date.now() });
    await ctx.db.insert('residentModelBindings', { worldId, playerId: 'p:0', agentGlobalId: 'home/ava',
      chatProfileId, createdAt: Date.now(), updatedAt: Date.now() });
    const profileId = await ctx.db.insert('embeddingProfiles', { name: 'Fixture', provider: 'custom',
      url: 'https://embedding.example', model: 'fixture', dimensions: 2, preprocessingRevision: 'newline-to-space-v1',
      queryPrefix: '', documentPrefix: '', normalization: 'none', fingerprint: 'fixture', createdAt: Date.now() });
    const spaceId = await ctx.db.insert('embeddingSpaces', { profileId, fingerprint: 'fixture', status: 'ACTIVE', createdAt: Date.now() });
    await ctx.db.insert('modelSettings', { key: 'town', activeEmbeddingSpaceId: spaceId });
    const memoryIds: Id<'memories'>[] = [];
    for (let index = 0; index < count; index++) memoryIds.push(await ctx.db.insert('memories', {
      worldId, playerId: 'p:0', agentGlobalId: 'home/ava', description: `${description} ${index}`, importance,
      lastAccess: Date.now(), data: { type: 'travel', eventId: `event:${index}`, visitId: 'visit', hostTownId: 'host',
        participants: [], occurredAt: Date.now() },
    }));
    return { worldId, spaceId, memoryIds };
  });
  return { t, ...result, owner: { worldId: result.worldId, playerId: 'p:0', agentGlobalId: 'home/ava' } };
}
async function sourcesFor(f: Awaited<ReturnType<typeof fixture>>) {
  return f.t.run(async ctx => Promise.all(f.memoryIds.map(async id => captureSource(ctx.db, (await ctx.db.get(id))!, f.owner))));
}
async function begin(f: Awaited<ReturnType<typeof fixture>>) {
  const sources = await sourcesFor(f);
  const token = await f.t.mutation(mutation('beginReflection'), { worldId: f.worldId, playerId: 'p:0', sources });
  return { sources, token: token! };
}
function insertArgs(f: Awaited<ReturnType<typeof fixture>>, token: { jobId: Id<'memoryCompressionJobs'>; revision: number }, ids = [f.memoryIds[0]]) {
  return { worldId: f.worldId, playerId: 'p:0', embeddingSpaceId: f.spaceId,
    reflectionJobId: token.jobId, reflectionRevision: token.revision,
    reflections: [{ description: 'I value these encounters.', importance: 6, relatedMemoryIds: ids, embedding: [1, 0] }] };
}

test('personality reflection consumes only cited observations and releases omitted claims', async () => {
  const f = await fixture(), { sources, token } = await begin(f);
  const originals = await f.t.run(async ctx => Promise.all(f.memoryIds.map(id => ctx.db.get(id))));
  await f.t.mutation(internal.agent.memory.insertReflectionMemories, insertArgs(f, token));
  await f.t.run(async ctx => {
    expect(await Promise.all(f.memoryIds.map(id => ctx.db.get(id)))).toEqual(originals);
    const claims = await ctx.db.query('memorySourceClaims').collect();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ memoryId: f.memoryIds[0], state: 'DONE' });
    const provenance = await ctx.db.query('memorySummaryProvenance').collect();
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({ subjective: true, confidenceKind: 'MODEL_ESTIMATE', sources: [sources[0]] });
    expect(await ctx.db.get(token.jobId)).toMatchObject({ state: 'DONE', sourcesCompleted: 1 });
  });
  await expect(f.t.mutation(internal.agent.memory.insertReflectionMemories, insertArgs(f, token)))
    .rejects.toThrow('MEMORY_REFLECTION_CLAIM_EXPIRED');
  expect(await f.t.mutation(mutation('beginReflection'), { worldId: f.worldId, playerId: 'p:0', sources: [sources[0]] })).toBeNull();
  expect(await f.t.mutation(mutation('beginReflection'), { worldId: f.worldId, playerId: 'p:0', sources: [sources[1]] })).not.toBeNull();
  expect(await f.t.run(ctx => ctx.db.query('modelMemoryVectors').collect())).toHaveLength(1);
});

test('a corrected observation rejects stale reflection and failure uses the revision CAS', async () => {
  const f = await fixture(), { token } = await begin(f);
  const correctionId = await f.t.run(ctx => ctx.db.insert('memorySourceCorrections', {
    ...f.owner, sourceMemoryId: f.memoryIds[0], sourceKey: 'travel:event:0', evidenceMemoryIds: [],
    text: 'The encounter was reported incorrectly.', operator: 'fixture', verification: 'ADMIN_REPORTED', createdAt: Date.now(),
  }));
  await expect(f.t.mutation(internal.agent.memory.insertReflectionMemories, insertArgs(f, token))).rejects.toThrow('MEMORY_SOURCE_CHANGED');
  await f.t.mutation(mutation('fail'), { jobId: token.jobId, revision: token.revision + 1, code: 'MEMORY_REFLECTION_FAILED' });
  expect(await f.t.run(ctx => ctx.db.get(token.jobId))).toMatchObject({ state: 'RUNNING', revision: token.revision });
  expect(await f.t.run(ctx => ctx.db.query('memorySourceClaims').collect())).toHaveLength(2);
  await f.t.mutation(mutation('fail'), { jobId: token.jobId, revision: token.revision, code: 'MEMORY_REFLECTION_FAILED' });
  expect(await f.t.run(ctx => ctx.db.query('memorySourceClaims').collect())).toHaveLength(0);
  expect(await f.t.run(ctx => ctx.db.query('memorySummaryProvenance').collect())).toHaveLength(0);
  const retry = await begin(f);
  expect(retry.sources[0].correctionId).toBe(correctionId);
  await expect(f.t.run(ctx => validateSources(ctx.db, f.owner, [{ ...retry.sources[0], correctionId: undefined }])))
    .rejects.toThrow('MEMORY_SOURCE_CHANGED');
  await f.t.mutation(internal.agent.memory.insertReflectionMemories, insertArgs(f, retry.token));
  await f.t.run(async ctx => {
    const summary = (await ctx.db.query('memories').withIndex('resident_type', q =>
      q.eq('worldId', f.worldId).eq('playerId', 'p:0').eq('data.type', 'reflection')).first())!;
    expect(await currentMemory(ctx.db, summary)).not.toBeNull();
    expect((await ctx.db.get(f.memoryIds[0]))!.description).toBe('Retained observation 0');
  });
});

test('cross-owner sources and uncaptured statement IDs cannot create a reflection', async () => {
  const f = await fixture(), { token } = await begin(f);
  const foreign = await f.t.run(ctx => ctx.db.insert('memories', {
    worldId: f.worldId, playerId: 'p:1', description: 'Someone else', importance: 9, lastAccess: 1,
    data: { type: 'conversation', conversationId: 'c:1', playerIds: [] },
  }));
  await expect(f.t.run(async ctx => captureSource(ctx.db, (await ctx.db.get(foreign))!, f.owner)))
    .rejects.toThrow('MEMORY_SOURCE_OWNER_MISMATCH');
  await expect(f.t.mutation(internal.agent.memory.insertReflectionMemories, insertArgs(f, token, [foreign])))
    .rejects.toThrow('MEMORY_REFLECTION_SOURCE_NOT_CLAIMED');
  expect(await f.t.run(ctx => ctx.db.query('memorySummaryProvenance').collect())).toHaveLength(0);
  expect(await f.t.run(ctx => ctx.db.query('memorySourceClaims').collect())).toHaveLength(2);
});

test.each([{ count: 100, importance: 6, triggered: true }, { count: 101, importance: 5, triggered: false }])(
  'the 100-observation threshold remains usable with an eight-source prompt ($count/$importance)', async ({ count, importance, triggered }) => {
    const f = await fixture(count, importance);
    const runQuery = jest.fn((_reference: unknown, args: { worldId: Id<'worlds'>; playerId: string; numberOfItems: number; cursor?: string | null; upperCreationTime?: number }) =>
      f.t.query(internal.agent.memory.getReflectionMemories, args));
    const runMutation = jest.fn(async () => null);
    expect(await reflectOnMemories({ runQuery, runMutation } as unknown as ActionCtx, f.worldId, parseGameId('players', 'p:0'))).toBe(false);
    expect(runQuery).toHaveBeenCalledTimes(13);
    expect(runMutation).toHaveBeenCalledTimes(triggered ? 1 : 0);
    if (triggered) expect((runMutation.mock.calls[0] as unknown as [unknown, { sources: unknown[] }])[1].sources).toHaveLength(8);
    const cutoffs = runQuery.mock.calls.slice(1).map(([, args]) => args.upperCreationTime);
    expect(new Set(cutoffs).size).toBe(1);
  },
);

test('reflection pages exclude post-snapshot arrivals and retain complete corrections after excerpts', async () => {
  const f = await fixture(10, 6, 'Observation '.repeat(1000));
  const correctionText = 'Correction '.repeat(350) + 'COMPLETE_CORRECTION_END';
  await f.t.run(ctx => ctx.db.insert('memorySourceCorrections', {
    ...f.owner, sourceMemoryId: f.memoryIds[9], sourceKey: 'travel:event:9', evidenceMemoryIds: [],
    text: correctionText, operator: 'fixture', verification: 'ADMIN_REPORTED', createdAt: Date.now(),
  }));
  const first = await f.t.query(internal.agent.memory.getReflectionMemories, { worldId: f.worldId, playerId: 'p:0', numberOfItems: 100 });
  expect(first.memories).toHaveLength(8);
  expect(first.memories[0].description).toContain('[Excerpt truncated; original source retained.]');
  expect(first.memories[0].description).toContain(correctionText);
  expect(JSON.stringify(first).length).toBeLessThan(32_000);
  const late = await f.t.run(ctx => ctx.db.insert('memories', { worldId: f.worldId, playerId: 'p:0',
    description: 'Late arrival', importance: 9, lastAccess: Date.now(), data: { type: 'conversation', conversationId: 'c:99', playerIds: [] } }));
  const rest = await f.t.query(internal.agent.memory.getReflectionMemories, { worldId: f.worldId, playerId: 'p:0', numberOfItems: 100,
    cursor: first.continueCursor, upperCreationTime: first.upperCreationTime });
  expect(rest.memories).toHaveLength(2);
  expect([...first.memories, ...rest.memories].map(memory => memory._id)).not.toContain(late);
  expect((await f.t.run(ctx => ctx.db.get(f.memoryIds[9])))!.description).toBe('Observation '.repeat(1000) + ' 9');
});

test('source validation includes retained transcript data in its cumulative byte budget', async () => {
  const f = await fixture(1);
  await f.t.run(async ctx => {
    const memory = (await ctx.db.get(f.memoryIds[0]))!;
    if (memory.data.type !== 'travel') throw new Error('FIXTURE_TRAVEL_REQUIRED');
    await ctx.db.patch(memory._id, { data: { ...memory.data, messageText: 'Transcript'.repeat(10000) } });
  });
  const sources = await sourcesFor(f);
  const fullBytes = await f.t.run(async ctx => sourceDocumentBytes((await ctx.db.get(f.memoryIds[0]))!));
  await expect(f.t.run(ctx => validateSources(ctx.db, f.owner, sources, fullBytes - 1))).rejects.toThrow('MEMORY_SOURCE_BUDGET_EXCEEDED');
  expect(await f.t.run(ctx => validateSources(ctx.db, f.owner, sources, fullBytes))).toHaveLength(1);
});

test('the model prompt stays under 24KB and malformed output releases reflection claims', async () => {
  const f = await fixture(100, 6, 'Observation '.repeat(1000));
  const correctionText = 'Unverified report '.repeat(210) + 'FULL_CORRECTION_END';
  await f.t.run(async ctx => {
    for (let index = 0; index < f.memoryIds.length; index++) await ctx.db.insert('memorySourceCorrections', {
      ...f.owner, sourceMemoryId: f.memoryIds[index], sourceKey: `travel:event:${index}`, evidenceMemoryIds: [],
      text: correctionText, operator: 'fixture', verification: 'ADMIN_REPORTED', createdAt: Date.now(),
    });
  });
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] })));
  const errorMock = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await f.t.action(ctx => reflectOnMemories(ctx, f.worldId, parseGameId('players', 'p:0')))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    const prompt = request.messages[0].content as string;
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(24_000);
    expect(prompt).toContain(correctionText);
    expect(prompt).toContain('high-level subjective insights');
    expect(request.max_tokens).toBe(1800);
    expect(await f.t.run(ctx => ctx.db.query('memorySourceClaims').collect())).toHaveLength(0);
    expect(await f.t.run(ctx => ctx.db.query('memoryCompressionJobs').first())).toMatchObject({ state: 'FAILED' });
  } finally { fetchMock.mockRestore(); errorMock.mockRestore(); }
});
