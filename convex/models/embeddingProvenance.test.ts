import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { embeddingFingerprint, verifiedCompatible } from './compatibility';
import { fetchBatch } from '../agent/embeddingsCache';
import { trustedOllamaProvider, observeOllamaEvidence } from './ollamaEvidence';
import { memorySourceDigest } from './embeddingDataRevision';
import { portableVector } from '../federation/vectorEvidence';
import { captureSource } from '../agent/memorySources';
import { latestCertificate } from './embeddingProvenance';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../models/embeddingProvenance.ts': () => import('./embeddingProvenance'),
  '../models/embeddings.ts': () => import('./embeddings'),
  '../models/usage.ts': () => import('./usage'),
  '../agent/embeddingsCache.ts': () => import('../agent/embeddingsCache'),
  '../agent/memory.ts': () => import('../agent/memory'),
  '../agent/memoryCompression.ts': () => import('../agent/memoryCompression'),
  '../federation/resources.ts': () => import('../federation/resources'),
  '../federation/backupVectorRestore.ts': () => import('../federation/backupVectorRestore'),
};
const url = 'http://approved-provider.example:11434', otherUrl = 'http://approved-provider.example:11435';
const adminToken = 'embedding-evidence-admin-token';
const profile = { name: 'Evidence fixture', provider: 'ollama' as const, url, model: 'fixture-embed:v1', dimensions: 2,
  preprocessingRevision: 'newline-to-space-v1', queryPrefix: 'Q: ', documentPrefix: 'D: ', normalization: 'none' };
const action = (name: string) => makeFunctionReference<'action'>(name);
const mutation = (name: string) => makeFunctionReference<'mutation'>(name);
const query = (name: string) => makeFunctionReference<'query'>(name);
const json = (value: unknown) => new Response(JSON.stringify(value));
const originalTrust = process.env.EMBEDDING_TRUSTED_OLLAMA_PROVIDERS;
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
beforeEach(() => {
  jest.useFakeTimers(); jest.setSystemTime(1791696000000);
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.EMBEDDING_TRUSTED_OLLAMA_PROVIDERS = JSON.stringify([url, otherUrl].map(url => ({
    providerId: 'managed-provider-fixture', url, trustedModelManagement: true,
  })));
});
afterEach(() => {
  if (originalTrust === undefined) delete process.env.EMBEDDING_TRUSTED_OLLAMA_PROVIDERS;
  else process.env.EMBEDDING_TRUSTED_OLLAMA_PROVIDERS = originalTrust;
  jest.restoreAllMocks(); jest.useRealTimers();
});
function mockProvider() {
  const state = { digest: 'a'.repeat(64), runningDigest: undefined as string | undefined, embeddingCalls: 0, failMetadata: false,
    afterEmbedding: undefined as (() => Promise<void>) | undefined };
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (state.failMetadata && path !== '/api/embeddings') return new Response('private-provider-error-sentinel', { status: 500 });
    if (path === '/api/tags') return json({ models: [{ name: profile.model, digest: state.digest }] });
    if (path === '/api/ps') return json({ models: [{ name: profile.model, digest: state.runningDigest ?? state.digest }] });
    if (path === '/api/version') return json({ version: 'fixture-runtime-v1' });
    if (path === '/api/show') return json({ capabilities: ['embedding'], details: { format: 'gguf' },
      model_info: { 'general.architecture': 'fixture', 'fixture.embedding_length': 2 } });
    if (path === '/api/embeddings') {
      state.embeddingCalls++;
      const body = JSON.parse(String(init?.body));
      const embedding = body.prompt.includes('Beta') ? [0, 1] : body.prompt.startsWith('Q: ') ? [0.9, 0.1] : [1, 0];
      if (state.afterEmbedding) await state.afterEmbedding();
      return json({ embedding });
    }
    throw new Error('UNEXPECTED_PROVIDER_ROUTE');
  });
  return { state, spy };
}
async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const profileId = await ctx.db.insert('embeddingProfiles', { ...profile, fingerprint: embeddingFingerprint(profile), createdAt: Date.now() });
    const worldId = await ctx.db.insert('worlds', { nextId: 2, players: [], agents: [], conversations: [] });
    const memoryId = await ctx.db.insert('memories', { worldId, playerId: 'p:0' as any, agentGlobalId: 'home/agent:a', description: 'Alpha memory', importance: 5,
      lastAccess: Date.now(), data: { type: 'reflection', relatedMemoryIds: [] } });
    const oldSpaceId = await ctx.db.insert('embeddingSpaces', { profileId, fingerprint: embeddingFingerprint(profile), status: 'ACTIVE', createdAt: Date.now() });
    await ctx.db.insert('modelSettings', { key: 'town', activeEmbeddingSpaceId: oldSpaceId });
    const memory = (await ctx.db.get(memoryId))!;
    await ctx.db.insert('modelMemoryVectors', { memoryId, worldId, playerId: memory.playerId, agentGlobalId: memory.agentGlobalId,
      sourceDigest: await memorySourceDigest(memory), spaceId: oldSpaceId, embedding: [1, 0] });
    return { profileId, worldId, memoryId, oldSpaceId };
  });
  return { t, ...ids };
}
async function certify(f: Awaited<ReturnType<typeof fixture>>, profileId = f.profileId): Promise<Id<'embeddingCertificates'>> {
  const verified = await f.t.action(action('models/embeddingProvenance:verifyProvider'), { adminToken, embeddingProfileId: profileId });
  expect(verified.compatibility).toBe('VERIFIED_PROVIDER');
  return verified.embeddingCertificateId;
}
async function certifiedSpace(f: Awaited<ReturnType<typeof fixture>>) {
  const embeddingCertificateId = await certify(f);
  const spaceId = await f.t.mutation(mutation('models/embeddings:beginRebuild'), { targetProfileId: f.profileId });
  const route = await f.t.query(query('models/embeddings:getRoute'), { spaceId });
  return { embeddingCertificateId, spaceId, route };
}
test('only exact server-authorized provider identity establishes trust; profile claims and localhost do not', () => {
  expect(trustedOllamaProvider(profile)?.providerId).toBe('managed-provider-fixture');
  expect(trustedOllamaProvider({ ...profile, url: 'http://127.0.0.1:11434' })).toBeNull();
  expect(trustedOllamaProvider({ ...profile, url: url + '/other' })).toBeNull();
  expect(trustedOllamaProvider({ ...profile, provider: 'custom' })).toBeNull();
  expect(verifiedCompatible({ ...profile, weightsDigest: 'a'.repeat(64), immutableRevision: 'fixed' }, profile)).toBe(false);
});
test('verification is authenticated, rejects unknown providers without fetching, and never certifies old vectors', async () => {
  const f = await fixture(), { spy } = mockProvider();
  await expect(f.t.action(action('models/embeddingProvenance:verifyProvider'), { adminToken: 'invalid', embeddingProfileId: f.profileId })).rejects.toThrow();
  await f.t.run(ctx => ctx.db.patch(f.profileId, { url: 'http://unapproved.example' }));
  expect(await f.t.action(action('models/embeddingProvenance:verifyProvider'), { adminToken, embeddingProfileId: f.profileId })).toMatchObject({ compatibility: 'UNKNOWN' });
  expect(spy).not.toHaveBeenCalled();
  await f.t.run(ctx => ctx.db.patch(f.profileId, { url }));
  const id = await certify(f);
  expect(await f.t.run(ctx => ctx.db.get(f.oldSpaceId))).not.toHaveProperty('embeddingCertificateId');
  expect((await f.t.run(ctx => ctx.db.query('modelMemoryVectors').unique()))?.embeddingCertificateId).toBeUndefined();
  expect(await f.t.query(query('models/embeddings:planSwitch'), { adminToken, targetProfileId: f.profileId })).toMatchObject({ canReuse: false, evidenceStatus: 'UNKNOWN' });
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ artifactDigest: 'a'.repeat(64), state: 'ACTIVE' });
});
test('certified generation binds query/document cache namespaces and the vector commit to its system certificate', async () => {
  const f = await fixture(), { state } = mockProvider(), certified = await certifiedSpace(f);
  const document = await f.t.action(ctx => fetchBatch(ctx, ['Alpha memory'], { route: certified.route, inputMode: 'document' }));
  const queryResult = await f.t.action(ctx => fetchBatch(ctx, ['Alpha memory'], { route: certified.route, inputMode: 'query' }));
  expect(document.embeddings).toEqual([[1, 0]]); expect(queryResult.embeddings).toEqual([[0.9, 0.1]]);
  const count = state.embeddingCalls;
  expect((await f.t.action(ctx => fetchBatch(ctx, ['Alpha memory'], { route: certified.route, inputMode: 'document' }))).hits).toBe(1);
  expect(state.embeddingCalls).toBe(count);
  await f.t.mutation(mutation('models/embeddings:putVector'), { memoryId: f.memoryId, spaceId: certified.spaceId, worldId: f.worldId,
    agentGlobalId: 'home/agent:a', embedding: document.embeddings[0], embeddingCertificateId: document.embeddingCertificateId });
  expect((await f.t.run(ctx => ctx.db.query('modelMemoryVectors').withIndex('space', q => q.eq('spaceId', certified.spaceId)).unique()))?.embeddingCertificateId).toBe(certified.embeddingCertificateId);
  expect(await f.t.run(ctx => ctx.db.get(f.oldSpaceId))).not.toHaveProperty('embeddingCertificateId');
});
test.each(['tag', 'running', 'outage'])('a %s change blocks even cached hits and persistently revokes serving authority', async kind => {
  const f = await fixture(), { state } = mockProvider(), certified = await certifiedSpace(f);
  await f.t.action(ctx => fetchBatch(ctx, ['Alpha'], { route: certified.route }));
  const count = state.embeddingCalls;
  if (kind === 'tag') state.digest = 'b'.repeat(64);
  else if (kind === 'running') state.runningDigest = 'b'.repeat(64);
  else state.failMetadata = true;
  await expect(f.t.action(ctx => fetchBatch(ctx, ['Alpha'], { route: certified.route }))).rejects.toThrow(/EMBEDDING_PROVIDER/);
  expect(state.embeddingCalls).toBe(count);
  expect(await f.t.run(ctx => ctx.db.get(certified.embeddingCertificateId))).toMatchObject({ state: 'REVOKED' });
  state.digest = 'a'.repeat(64); state.runningDigest = undefined; state.failMetadata = false;
  await expect(f.t.action(ctx => fetchBatch(ctx, ['Alpha'], { route: certified.route }))).rejects.toThrow('EMBEDDING_CERTIFICATE_FENCED');
});
test('tag change during a response discards the response and creates no cache or vector', async () => {
  const f = await fixture(), { state } = mockProvider(), certified = await certifiedSpace(f);
  state.afterEmbedding = async () => { state.digest = 'b'.repeat(64); };
  await expect(f.t.action(ctx => fetchBatch(ctx, ['Alpha'], { route: certified.route }))).rejects.toThrow('EMBEDDING_PROVIDER_CHANGED');
  expect(await f.t.run(ctx => ctx.db.query('embeddingsCache').collect())).toEqual([]);
  expect(await f.t.run(ctx => ctx.db.query('modelMemoryVectors').withIndex('space', q => q.eq('spaceId', certified.spaceId)).collect())).toEqual([]);
});
test('generation evidence is mandatory for vector, conversation and reflection writes and revocation fences late commits', async () => {
  const f = await fixture(); mockProvider(); const certified = await certifiedSpace(f);
  const vector = { memoryId: f.memoryId, spaceId: certified.spaceId, worldId: f.worldId, agentGlobalId: 'home/agent:a', embedding: [1, 0] };
  await expect(f.t.mutation(mutation('models/embeddings:putVector'), vector)).rejects.toThrow('EMBEDDING_GENERATION_EVIDENCE_MISSING');
  const sources = await f.t.run(async ctx => {
    await ctx.db.patch(f.memoryId, { data: { type: 'travel', eventId: 'fixture-event', visitId: 'fixture-visit',
      hostTownId: 'fixture-host', participants: [], occurredAt: Date.now() } });
    return [await captureSource(ctx.db, (await ctx.db.get(f.memoryId))!, { worldId: f.worldId, playerId: 'p:0' })];
  });
  const token = await f.t.mutation(mutation('agent/memoryCompression:beginReflection'), { worldId: f.worldId, playerId: 'p:0', sources });
  expect(token).not.toBeNull();
  const reflectionClaim = { reflectionJobId: token.jobId, reflectionRevision: token.revision };
  const reflection = { description: 'Insight', relatedMemoryIds: [f.memoryId], importance: 3, embedding: [1, 0] };
  await expect(f.t.mutation(mutation('agent/memory:insertReflectionMemories'), { worldId: f.worldId, playerId: 'p:0', embeddingSpaceId: certified.spaceId,
    ...reflectionClaim, reflections: [reflection] })).rejects.toThrow('EMBEDDING_GENERATION_EVIDENCE_MISSING');
  await expect(f.t.mutation(mutation('agent/memory:insertMemory'), { agentId: 'a:0', worldId: f.worldId, playerId: 'p:0',
    embeddingSpaceId: certified.spaceId, embedding: [1, 0], description: 'Conversation', importance: 3, lastAccess: Date.now(),
    data: { type: 'conversation', conversationId: 'c:0', playerIds: [] } })).rejects.toThrow('EMBEDDING_GENERATION_EVIDENCE_MISSING');
  const generated = await f.t.action(ctx => fetchBatch(ctx, ['Alpha memory'], { route: certified.route, inputMode: 'document' }));
  await f.t.mutation(mutation('models/embeddingProvenance:revokeCertificate'), { embeddingCertificateId: certified.embeddingCertificateId, reason: 'SERVICE_CHANGED' });
  await expect(f.t.mutation(mutation('models/embeddings:putVector'), { ...vector, embeddingCertificateId: generated.embeddingCertificateId })).rejects.toThrow('EMBEDDING_CERTIFICATE_FENCED');
  await expect(f.t.mutation(mutation('agent/memory:insertReflectionMemories'), { worldId: f.worldId, playerId: 'p:0',
    embeddingSpaceId: certified.spaceId, ...reflectionClaim,
    reflections: [{ ...reflection, embeddingCertificateId: generated.embeddingCertificateId }] })).rejects.toThrow('EMBEDDING_CERTIFICATE_FENCED');
  expect(await f.t.run(ctx => ctx.db.query('memories').collect())).toHaveLength(1);
  expect(await f.t.run(ctx => ctx.db.query('memorySourceClaims').unique())).toMatchObject({ state: 'CLAIMED' });
});
test('metadata failure cannot echo provider secrets and unknown custom profiles still generate without certificates', async () => {
  const f = await fixture(), { state } = mockProvider(); state.failMetadata = true;
  await expect(observeOllamaEvidence(profile)).rejects.toThrow(/^EMBEDDING_PROVIDER_METADATA_UNAVAILABLE$/);
  await f.t.run(ctx => ctx.db.patch(f.profileId, { provider: 'custom', url: 'https://custom.example' }));
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [{ index: 0, embedding: [1, 0] }] }));
  const route = await f.t.query(query('models/embeddings:getRoute'), { spaceId: f.oldSpaceId });
  expect(await f.t.action(ctx => fetchBatch(ctx, ['Alpha'], { route }))).toMatchObject({ embeddings: [[1, 0]] });
  expect(await f.t.run(ctx => ctx.db.query('embeddingCertificates').collect())).toEqual([]);
});
test('expired certificates reject bare mutations until a live serving check refreshes the certificate', async () => {
  const f = await fixture(); mockProvider(); const certified = await certifiedSpace(f);
  jest.setSystemTime(Date.now() + 60001);
  const args = { memoryId: f.memoryId, spaceId: certified.spaceId, worldId: f.worldId, agentGlobalId: 'home/agent:a', embedding: [1, 0], embeddingCertificateId: certified.embeddingCertificateId };
  await expect(f.t.mutation(mutation('models/embeddings:putVector'), args)).rejects.toThrow('EMBEDDING_CERTIFICATE_FENCED');
  const generated = await f.t.action(ctx => fetchBatch(ctx, ['Alpha memory'], { route: certified.route, inputMode: 'document' }));
  await f.t.mutation(mutation('models/embeddings:putVector'), { ...args, embedding: generated.embeddings[0] });
});
test('independently verified matching pipelines support bounded vector reuse while retaining original generation evidence', async () => {
  const f = await fixture(); mockProvider(); const source = await certifiedSpace(f);
  const generated = await f.t.action(ctx => fetchBatch(ctx, ['Alpha memory'], { route: source.route, inputMode: 'document' }));
  await f.t.mutation(mutation('models/embeddings:putVector'), { memoryId: f.memoryId, spaceId: source.spaceId, worldId: f.worldId,
    agentGlobalId: 'home/agent:a', embedding: generated.embeddings[0], embeddingCertificateId: generated.embeddingCertificateId });
  const targetProfileId = await f.t.run(async ctx => {
    const settings = (await ctx.db.query('modelSettings').unique())!;
    await ctx.db.patch(settings._id, { activeEmbeddingSpaceId: source.spaceId });
    const target = { ...profile, url: otherUrl };
    return ctx.db.insert('embeddingProfiles', { ...target, fingerprint: embeddingFingerprint(target), createdAt: Date.now() });
  });
  const targetCertificate = await certify(f, targetProfileId);
  expect(await f.t.query(query('models/embeddings:planSwitch'), { adminToken, targetProfileId })).toMatchObject({ compatibility: 'VERIFIED_COMPATIBLE', canReuse: true });
  const targetSpaceId: Id<'embeddingSpaces'> = await f.t.action(action('models/embeddings:startCompatibleReuse'), { adminToken, targetProfileId });
  expect(await f.t.mutation(mutation('models/embeddings:copyReusePage'), { sourceSpaceId: source.spaceId, spaceId: targetSpaceId, cursor: null })).toMatchObject({ isDone: true });
  const copied = await f.t.run(ctx => ctx.db.query('modelMemoryVectors').withIndex('space', q => q.eq('spaceId', targetSpaceId)).unique());
  expect(copied).toMatchObject({ embedding: [1, 0], embeddingCertificateId: source.embeddingCertificateId, memoryId: f.memoryId });
  expect((await f.t.run(ctx => ctx.db.get(targetSpaceId)))?.embeddingCertificateId).toBe(targetCertificate);
  expect((await f.t.run(ctx => ctx.db.query('modelSettings').unique()))?.activeEmbeddingSpaceId).toBe(source.spaceId);
  await f.t.run(ctx => ctx.db.patch(f.memoryId, { description: 'Changed canonical text' }));
  await expect(f.t.mutation(mutation('models/embeddings:copyReusePage'), { sourceSpaceId: source.spaceId, spaceId: targetSpaceId, cursor: null })).rejects.toThrow('EMBEDDING_SOURCE_VECTOR_STALE');
});

test('trusted portable vectors retain historical proof in a remapped space and revoked local authority fences restoration', async () => {
  const f = await fixture(); mockProvider(); const source = await certifiedSpace(f);
  const generated = await f.t.action(ctx => fetchBatch(ctx, ['Alpha memory'], { route: source.route, inputMode: 'document' }));
  await f.t.mutation(mutation('models/embeddings:putVector'), { memoryId: f.memoryId, spaceId: source.spaceId,
    worldId: f.worldId, agentGlobalId: 'home/agent:a', embedding: generated.embeddings[0], embeddingCertificateId: generated.embeddingCertificateId });
  const snapshot = await f.t.run(async ctx => {
    const vector = (await ctx.db.query('modelMemoryVectors').withIndex('space', q => q.eq('spaceId', source.spaceId)).unique())!;
    return { vector: (await portableVector(ctx.db, vector))!, original: (await ctx.db.get(f.memoryId))! };
  });
  const destination = await f.t.run(async ctx => {
    const targetId = await ctx.db.insert('memories', { worldId: f.worldId, playerId: 'p:1' as any,
      agentGlobalId: 'target/agent:b', description: snapshot.original.description, importance: 5,
      lastAccess: Date.now(), data: { type: 'reflection', relatedMemoryIds: [] } });
    const importId = await ctx.db.insert('backupImports', { sourceTownId: 'source-town', mode: 'merge',
      exportedAt: Date.now(), importedAt: Date.now(), mapping: { [f.memoryId]: targetId, [f.worldId]: f.worldId,
        'p:0': 'p:1', 'home/agent:a': 'target/agent:b' }, runtimeSnapshot: {},
      manifest: { vectorSourceTrusted: true, includeVectors: true } });
    return { targetId, importId };
  });
  const spaceId: Id<'embeddingSpaces'> = await f.t.mutation(mutation('models/embeddings:beginRebuild'), { targetProfileId: f.profileId });
  const jobId: Id<'embeddingRestoreJobs'> = await f.t.mutation(mutation('federation/backupVectorRestore:createJob'),
    { importId: destination.importId, targetProfileId: f.profileId, spaceId });
  const args = { jobId, expectedCursor: null, expectedOffset: 0, nextCursor: null, nextOffset: 1, done: true,
    entries: [{ vector: snapshot.vector, original: snapshot.original, targetId: destination.targetId,
      sourcePublicKey: 'trusted-source-fixture', mapping: { [f.worldId]: f.worldId,
        'p:0': 'p:1', 'home/agent:a': 'target/agent:b' } }] };
  const otherTargetId = await f.t.run(async ctx => {
    const { _id, _creationTime, ...fields } = (await ctx.db.get(destination.targetId))!;
    return ctx.db.insert('memories', fields);
  });
  await expect(f.t.mutation(mutation('federation/backupVectorRestore:copyPage'), { ...args,
    entries: [{ ...args.entries[0], targetId: otherTargetId }] })).rejects.toThrow('VECTOR_IMPORT_MAPPING_CHANGED');
  await expect(f.t.mutation(mutation('federation/backupVectorRestore:copyPage'), { ...args,
    entries: [{ ...args.entries[0], original: { ...snapshot.original, description: 'Changed canonical text' } }] }))
    .rejects.toThrow('VECTOR_SOURCE_OWNER_OR_TEXT_CHANGED');
  await expect(f.t.mutation(mutation('federation/backupVectorRestore:copyPage'), args)).resolves.toEqual({ copied: 1, skipped: 0 });
  const restored = await f.t.run(ctx => ctx.db.query('modelMemoryVectors').withIndex('space', q => q.eq('spaceId', spaceId)).unique());
  expect(restored).toMatchObject({ memoryId: destination.targetId, playerId: 'p:1', agentGlobalId: 'target/agent:b', embedding: [1, 0] });
  const historical = await f.t.run(ctx => ctx.db.get(restored!.embeddingCertificateId!));
  expect(historical).toMatchObject({ state: 'REVOKED', checkedAt: 0, sourceTownId: 'source-town',
    generationEvidenceId: snapshot.vector.generationEvidenceId });
  expect(restored!.embeddingCertificateId).not.toBe(source.embeddingCertificateId);
  expect((await f.t.run(ctx => latestCertificate(ctx.db, f.profileId)))?._id).toBe(source.embeddingCertificateId);
  const nextSpaceId: Id<'embeddingSpaces'> = await f.t.mutation(mutation('models/embeddings:beginRebuild'), { targetProfileId: f.profileId });
  expect((await f.t.run(ctx => ctx.db.get(nextSpaceId)))?.embeddingCertificateId).toBe(source.embeddingCertificateId);
  expect((await f.t.run(ctx => ctx.db.get(spaceId)))?.status).toBe('BUILDING');
  expect((await f.t.run(ctx => ctx.db.query('modelSettings').unique()))?.activeEmbeddingSpaceId).toBe(f.oldSpaceId);
  const secondJobId: Id<'embeddingRestoreJobs'> = await f.t.mutation(mutation('federation/backupVectorRestore:createJob'),
    { importId: destination.importId, targetProfileId: f.profileId, spaceId });
  await f.t.run(ctx => ctx.db.patch(spaceId, { status: 'READY' }));
  await expect(f.t.mutation(mutation('federation/backupVectorRestore:copyPage'), { ...args, jobId: secondJobId }))
    .rejects.toThrow('VECTOR_TARGET_NOT_VERIFIED');
  await f.t.run(ctx => ctx.db.patch(spaceId, { status: 'BUILDING' }));
  await f.t.mutation(mutation('models/embeddingProvenance:revokeCertificate'),
    { embeddingCertificateId: source.embeddingCertificateId, reason: 'SERVICE_CHANGED' });
  await expect(f.t.mutation(mutation('federation/backupVectorRestore:copyPage'), { ...args, jobId: secondJobId }))
    .rejects.toThrow('EMBEDDING_CERTIFICATE_FENCED');
});

test('historical proofs cannot hide revoked serving authority or revive an older verification', async () => {
  const f = await fixture(); mockProvider();
  const first = await certify(f), latest = await certify(f);
  await f.t.mutation(mutation('models/embeddingProvenance:revokeCertificate'), {
    embeddingCertificateId: latest, reason: 'SERVING_ROUTE_CHANGED',
  });
  await f.t.run(async ctx => {
    const { _id, _creationTime, ...fields } = (await ctx.db.get(first))!;
    await ctx.db.insert('embeddingCertificates', { ...fields, state: 'REVOKED', checkedAt: 0,
      generationEvidenceId: 'historical-proof', sourceTownId: 'source-town' });
  });
  expect((await f.t.run(ctx => latestCertificate(ctx.db, f.profileId)))?._id).toBe(latest);
  const spaceId: Id<'embeddingSpaces'> = await f.t.mutation(mutation('models/embeddings:beginRebuild'), { targetProfileId: f.profileId });
  expect((await f.t.run(ctx => ctx.db.get(spaceId)))?.embeddingCertificateId).toBeUndefined();
});

test('matching names, dimensions and samples cannot bypass independently verified artifact and pipeline identity', async () => {
  const f = await fixture(); mockProvider(); const id = await certify(f);
  const source = (await f.t.run(ctx => ctx.db.get(id)))!;
  expect(verifiedCompatible(profile, profile, { source, target: source })).toBe(true);
  for (const change of [
    { artifactDigest: 'b'.repeat(64) }, { pipelineFingerprint: 'different-pipeline' },
    { providerId: 'different-provider' }, { dimensions: 3 }, { profileFingerprint: 'unverified-profile' },
    { state: 'REVOKED' }, { checkedAt: Date.now() + 1 }, { checkedAt: Date.now() - 60001 },
  ]) expect(verifiedCompatible(profile, profile, { source, target: { ...source, ...change } })).toBe(false);
  expect(verifiedCompatible(profile, { ...profile, documentPrefix: 'Different: ' }, { source, target: source })).toBe(false);
});

test('bounded coverage refreshes serving evidence after a delayed page and still fences provider changes', async () => {
  const f = await fixture(), { state } = mockProvider(), certified = await certifiedSpace(f);
  const result = await f.t.action(ctx => fetchBatch(ctx, ['Alpha memory'], { route: certified.route, inputMode: 'document' }));
  await f.t.mutation(mutation('models/embeddings:putVector'), { memoryId: f.memoryId, spaceId: certified.spaceId,
    worldId: f.worldId, agentGlobalId: 'home/agent:a', embedding: result.embeddings[0], embeddingCertificateId: result.embeddingCertificateId });
  const jobId: Id<'embeddingScanJobs'> = await f.t.mutation(mutation('models/embeddings:finishBuild'), { spaceId: certified.spaceId });
  jest.setSystemTime(Date.now() + 60001);
  await f.t.action(action('models/embeddings:scanWork'), { jobId });
  expect((await f.t.query(query('models/embeddings:scanJob'), { jobId }))?.phase).toBe('DONE');
  expect((await f.t.run(ctx => ctx.db.get(certified.embeddingCertificateId)))?.checkedAt).toBe(Date.now());
  const changedJobId: Id<'embeddingScanJobs'> = await f.t.mutation(mutation('models/embeddings:finishBuild'), { spaceId: certified.spaceId });
  state.digest = 'b'.repeat(64);
  await f.t.action(action('models/embeddings:scanWork'), { jobId: changedJobId });
  expect(await f.t.query(query('models/embeddings:scanJob'), { jobId: changedJobId })).toMatchObject({
    phase: 'FAILED', failure: expect.stringContaining('EMBEDDING_PROVIDER_CHANGED'),
  });
  expect((await f.t.run(ctx => ctx.db.get(certified.embeddingCertificateId)))?.state).toBe('REVOKED');
});
