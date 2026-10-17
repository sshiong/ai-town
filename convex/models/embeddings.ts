import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  ActionCtx,
  MutationCtx,
  DatabaseReader,
} from '../maintenanceFunctions';
import { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { assertFederationAdmin } from '../federation/auth';
import { EmbeddingConfig, fetchEmbedding, getEmbeddingConfig } from '../util/llm';
import { connectionFields } from './schema';
import { embeddingFingerprint, cosineSimilarity, validateVector, verifiedCompatible } from './compatibility';
import { assertSpaceCertificate, assertVectorCertificate, guardEmbeddingRoute, latestCertificate } from './embeddingProvenance';
import { CERTIFICATE_FRESHNESS_MS, trustedOllamaProvider, fetchCertifiedOllamaEmbedding } from './ollamaEvidence';
import { audit, settings, validateConnection } from './profiles';
import * as cache from '../agent/embeddingsCache';
import { trackedModelCall } from './usage';
import { dataRevision, memorySourceDigest, sourceKey, vectorKey } from './embeddingDataRevision';

export type EmbeddingRoute = { space: Doc<'embeddingSpaces'>; profile: Doc<'embeddingProfiles'> };
export const saveEmbeddingProfile = mutation({
  args: {
    adminToken: v.string(),
    ...connectionFields,
    dimensions: v.number(),
    immutableRevision: v.optional(v.string()),
    weightsDigest: v.optional(v.string()),
    preprocessingRevision: v.optional(v.string()),
    queryPrefix: v.optional(v.string()),
    documentPrefix: v.optional(v.string()),
    normalization: v.optional(v.string()),
  },
  handler: async (ctx, { adminToken, ...args }): Promise<Id<'embeddingProfiles'>> => {
    assertFederationAdmin(adminToken);
    validateConnection(args);
    if (!Number.isSafeInteger(args.dimensions) || args.dimensions < 1 || args.dimensions > 16384)
      throw new Error('INVALID_EMBEDDING_DIMENSIONS');
    if (args.weightsDigest && !/^[a-f0-9]{64}$/i.test(args.weightsDigest))
      throw new Error('INVALID_WEIGHTS_DIGEST');
    if ((args.queryPrefix?.length ?? 0) > 1024 || (args.documentPrefix?.length ?? 0) > 1024)
      throw new Error('INVALID_EMBEDDING_PREFIX');
    if (args.preprocessingRevision && args.preprocessingRevision !== 'newline-to-space-v1')
      throw new Error('UNSUPPORTED_PREPROCESSING_REVISION');
    if (args.normalization && args.normalization !== 'none')
      throw new Error('UNSUPPORTED_EMBEDDING_NORMALIZATION');
    const profile = {
      ...args,
      url: args.url.replace(/\/$/, ''),
      preprocessingRevision: args.preprocessingRevision ?? 'newline-to-space-v1',
      queryPrefix: args.queryPrefix ?? '',
      documentPrefix: args.documentPrefix ?? '',
      normalization: args.normalization ?? 'none',
    };
    const id = await ctx.db.insert('embeddingProfiles', {
      ...profile,
      fingerprint: embeddingFingerprint(profile),
      createdAt: Date.now(),
    });
    await audit(ctx, 'CREATE_EMBEDDING_PROFILE', id, id, 'Administrator saved profile');
    return id;
  },
});
export function profileEmbeddingConfig(profile: Doc<'embeddingProfiles'>): EmbeddingConfig {
  if (profile.disabled) throw new Error('EMBEDDING_PROFILE_DISABLED');
  const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  if (profile.apiKeyEnv && !apiKey)
    throw new Error(`MODEL_CREDENTIAL_MISSING: ${profile.apiKeyEnv}`);
  return {
    provider: profile.provider,
    url: profile.url,
    embeddingModel: profile.model,
    apiKey,
    dimensions: profile.dimensions,
    queryPrefix: profile.queryPrefix,
    documentPrefix: profile.documentPrefix,
  };
}
export async function ensureEmbeddingSpace(ctx: MutationCtx): Promise<Id<'embeddingSpaces'>> {
  const config = await settings(ctx);
  if (config?.activeEmbeddingSpaceId) return config.activeEmbeddingSpaceId;
  const embedding = getEmbeddingConfig();
  const credentialCandidate = process.env.EMBEDDING_API_KEY
    ? 'EMBEDDING_API_KEY'
    : {
        openai: 'OPENAI_API_KEY',
        together: 'TOGETHER_API_KEY',
        custom: 'LLM_API_KEY',
        ollama: undefined,
      }[embedding.provider];
  const credentialEnv =
    credentialCandidate && process.env[credentialCandidate] ? credentialCandidate : undefined;
  const profile = {
    name: 'Original environment embedding',
    provider: embedding.provider,
    url: embedding.url,
    model: embedding.embeddingModel,
    apiKeyEnv: credentialEnv,
    dimensions: embedding.dimensions,
    immutableRevision: process.env.EMBEDDING_IMMUTABLE_REVISION,
    weightsDigest: process.env.EMBEDDING_WEIGHTS_DIGEST,
    preprocessingRevision: 'newline-to-space-v1',
    queryPrefix: '',
    documentPrefix: '',
    normalization: 'none',
  };
  const profileId = await ctx.db.insert('embeddingProfiles', {
    ...profile,
    fingerprint: embeddingFingerprint(profile),
    createdAt: Date.now(),
  });
  const spaceId = await ctx.db.insert('embeddingSpaces', {
    profileId,
    fingerprint: embeddingFingerprint(profile),
    status: 'ACTIVE',
    createdAt: Date.now(),
  });
  if (config) await ctx.db.patch(config._id, { activeEmbeddingSpaceId: spaceId });
  else await ctx.db.insert('modelSettings', { key: 'town', activeEmbeddingSpaceId: spaceId });
  // Legacy vectors have no trustworthy space evidence. Rebuild from their retained text.
  await ctx.scheduler.runAfter(0, internal.models.embeddings.rebuildPage, {
    spaceId,
    cursor: null,
  });
  return spaceId;
}
export const ensureActiveSpace = internalMutation({
  args: {},
  handler: async (ctx): Promise<Id<'embeddingSpaces'>> => ensureEmbeddingSpace(ctx),
});
export const getRoute = internalQuery({
  args: { spaceId: v.optional(v.id('embeddingSpaces')) },
  handler: async (ctx, args): Promise<EmbeddingRoute> => {
    const id = args.spaceId ?? (await settings(ctx))?.activeEmbeddingSpaceId;
    if (!id) throw new Error('EMBEDDING_SPACE_MISSING');
    const space = await ctx.db.get(id);
    if (!space) throw new Error('EMBEDDING_SPACE_NOT_FOUND');
    const profile = await ctx.db.get(space.profileId);
    if (!profile) throw new Error('EMBEDDING_PROFILE_NOT_FOUND');
    if (profile.disabled) throw new Error('EMBEDDING_PROFILE_DISABLED');
    return { space, profile };
  },
});
export async function activeRoute(ctx: ActionCtx): Promise<EmbeddingRoute> {
  await ctx.runMutation(internal.models.embeddings.ensureActiveSpace, {});
  return ctx.runQuery(internal.models.embeddings.getRoute, {});
}
export const planSwitch = query({
  args: { adminToken: v.string(), targetProfileId: v.id('embeddingProfiles') },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    const target = await ctx.db.get(args.targetProfileId);
    if (!target) throw new Error('EMBEDDING_PROFILE_NOT_FOUND');
    if (target.disabled) throw new Error('EMBEDDING_PROFILE_DISABLED');
    const config = await settings(ctx);
    const space = config?.activeEmbeddingSpaceId
      ? await ctx.db.get(config.activeEmbeddingSpaceId)
      : null;
    const current = space ? await ctx.db.get(space.profileId) : null;
    const sourceCertificate = space?.embeddingCertificateId ? await ctx.db.get(space.embeddingCertificateId) : null;
    const targetCertificate = await latestCertificate(ctx.db, target._id);
    const canReuse = !!current && !!space?.embeddingCertificateId && !!targetCertificate &&
      trustedOllamaProvider(target)?.providerId === targetCertificate.providerId && targetCertificate.providerUrl === target.url &&
      verifiedCompatible(current, target, { source: sourceCertificate, target: targetCertificate });
    return {
      compatibility: canReuse ? 'VERIFIED_COMPATIBLE' : 'REBUILD_REQUIRED',
      canReuse,
      evidenceStatus: canReuse ? 'VERIFIED_COMPATIBLE' : 'UNKNOWN',
      reason: canReuse ? 'SYSTEM_VERIFIED_WEIGHTS_AND_PIPELINE' : 'TRUSTED_GENERATION_EVIDENCE_REQUIRED',
      sourceFingerprint: current?.fingerprint ?? null,
      targetFingerprint: target.fingerprint,
      affectedMemories: (await ctx.db.query('embeddingScanJobs').withIndex('profile', q => q.eq('profileId', target._id)).order('desc').first())?.memoryCount ?? 0,
      planningComplete: await completedPlan(ctx, target._id),
    };
  },
});
async function completedPlan(ctx: { db: DatabaseReader }, profileId: Id<'embeddingProfiles'>) {
  const job = await ctx.db.query('embeddingScanJobs').withIndex('profile', q => q.eq('profileId', profileId)).order('desc').first();
  return !!job && job.phase === 'DONE' && job.sourceRevision === await dataRevision(ctx.db, sourceKey);
}
export const startSwitchPlan = mutation({
  args: { adminToken: v.string(), targetProfileId: v.id('embeddingProfiles') },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    const profile = await ctx.db.get(args.targetProfileId);
    if (!profile || profile.disabled) throw new Error('EMBEDDING_PROFILE_NOT_AVAILABLE');
    const jobId = await createScan(ctx, 'PLAN', { profileId: args.targetProfileId });
    await advanceScan(ctx, jobId);
    await ctx.scheduler.runAfter(0, internal.models.embeddings.scanWork, { jobId });
    return jobId;
  },
});
export const scanProgress = query({
  args: { adminToken: v.string(), jobId: v.id('embeddingScanJobs') },
  handler: async (ctx, args) => { assertFederationAdmin(args.adminToken); return ctx.db.get(args.jobId); },
});
export const beginRebuild = internalMutation({
  args: { targetProfileId: v.id('embeddingProfiles') },
  handler: async (ctx, args): Promise<Id<'embeddingSpaces'>> => {
    const profile = await ctx.db.get(args.targetProfileId);
    if (!profile) throw new Error('EMBEDDING_PROFILE_NOT_FOUND');
    if (profile.disabled) throw new Error('EMBEDDING_PROFILE_DISABLED');
    const certificate = await latestCertificate(ctx.db, profile._id);
    const embeddingCertificateId = certificate?.state === 'ACTIVE' && trustedOllamaProvider(profile)?.providerId === certificate.providerId &&
      certificate.providerUrl === profile.url && certificate.profileFingerprint === embeddingFingerprint(profile) &&
      certificate.checkedAt <= Date.now() && Date.now() - certificate.checkedAt <= CERTIFICATE_FRESHNESS_MS
      ? certificate._id : undefined;
    const spaceId = await ctx.db.insert('embeddingSpaces', {
      embeddingCertificateId,
      profileId: profile._id,
      fingerprint: profile.fingerprint,
      status: 'BUILDING',
      createdAt: Date.now(),
    });
    await audit(ctx, 'BEGIN_EMBEDDING_REBUILD', spaceId, profile._id, 'Old active space retained');
    return spaceId;
  },
});
export const startRebuild = action({
  args: { adminToken: v.string(), targetProfileId: v.id('embeddingProfiles') },
  handler: async (ctx, args): Promise<Id<'embeddingSpaces'>> => {
    assertFederationAdmin(args.adminToken);
    const spaceId = await ctx.runMutation(internal.models.embeddings.beginRebuild, {
      targetProfileId: args.targetProfileId,
    });
    await ctx.scheduler.runAfter(0, internal.models.embeddings.rebuildPage, {
      spaceId,
      cursor: null,
    });
    return spaceId;
  },
});
export const startCompatibleReuse = action({
  args: { adminToken: v.string(), targetProfileId: v.id('embeddingProfiles') },
  handler: async (ctx, args): Promise<Id<'embeddingSpaces'>> => {
    assertFederationAdmin(args.adminToken);
    const plan = await ctx.runQuery(makeFunctionReference<'query'>('models/embeddings:planSwitch'), args);
    if (!plan.canReuse) throw new Error('EMBEDDING_REBUILD_REQUIRED');
    const source = await ctx.runQuery(internal.models.embeddings.getRoute, {});
    const spaceId = await ctx.runMutation(internal.models.embeddings.beginRebuild, { targetProfileId: args.targetProfileId });
    try {
      const target = await ctx.runQuery(internal.models.embeddings.getRoute, { spaceId });
      await guardEmbeddingRoute(ctx, target);
      await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('models/embeddings:reusePage'), {
        sourceSpaceId: source.space._id, spaceId, cursor: null,
      });
      return spaceId;
    } catch (error) {
      await ctx.runMutation(internal.models.embeddings.failBuild, { spaceId, failure: 'COMPATIBILITY_RECHECK_FAILED' });
      throw error;
    }
  },
});
export const copyReusePage = internalMutation({
  args: { sourceSpaceId: v.id('embeddingSpaces'), spaceId: v.id('embeddingSpaces'), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceSpaceId), target = await ctx.db.get(args.spaceId);
    if (!source?.embeddingCertificateId || !target?.embeddingCertificateId || target.status !== 'BUILDING')
      throw new Error('EMBEDDING_REBUILD_REQUIRED');
    await assertSpaceCertificate(ctx.db, target._id);
    const page = await ctx.db.query('modelMemoryVectors').withIndex('space', q => q.eq('spaceId', source._id))
      .paginate({ cursor: args.cursor, numItems: 20, maximumBytesRead: 512 * 1024 });
    for (const vector of page.page) {
      await assertVectorCertificate(ctx.db, target._id, vector.embeddingCertificateId);
      const memory = await ctx.db.get(vector.memoryId);
      if (!memory || memory.worldId !== vector.worldId || memory.playerId !== vector.playerId || memory.agentGlobalId !== vector.agentGlobalId ||
        await memorySourceDigest(memory) !== vector.sourceDigest) throw new Error('EMBEDDING_SOURCE_VECTOR_STALE');
      const prior = await ctx.db.query('modelMemoryVectors').withIndex('memory_space', q => q.eq('memoryId', vector.memoryId).eq('spaceId', target._id)).unique();
      if (!prior) {
        const { _id, _creationTime, ...fields } = vector;
        await ctx.db.insert('modelMemoryVectors', { ...fields, spaceId: target._id });
      }
    }
    return { isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
export const reusePage = internalAction({
  args: { sourceSpaceId: v.id('embeddingSpaces'), spaceId: v.id('embeddingSpaces'), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<void> => {
    try {
      const route = await ctx.runQuery(internal.models.embeddings.getRoute, { spaceId: args.spaceId });
      await guardEmbeddingRoute(ctx, route);
      const page = await ctx.runMutation(makeFunctionReference<'mutation'>('models/embeddings:copyReusePage'), args);
      if (!page.isDone) await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('models/embeddings:reusePage'), { ...args, cursor: page.continueCursor });
      else await ctx.runMutation(internal.models.embeddings.finishBuild, { spaceId: args.spaceId });
    } catch (error) {
      await ctx.runMutation(internal.models.embeddings.failBuild, { spaceId: args.spaceId, failure: String(error).slice(0, 500) });
    }
  },
});
export const resumeRebuild = mutation({
  args: { adminToken: v.string(), spaceId: v.id('embeddingSpaces') },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    const space = await ctx.db.get(args.spaceId);
    const profile = space && await ctx.db.get(space.profileId);
    if (!space || !profile || profile.disabled) throw new Error('EMBEDDING_SPACE_NOT_AVAILABLE');
    await ctx.db.patch(space._id, { failure: undefined, validatedAt: undefined, validationSampleCount: undefined,
      ...(space.status === 'FAILED' ? { status: 'BUILDING' as const } : {}) });
    await ctx.scheduler.runAfter(0, internal.models.embeddings.rebuildPage, { spaceId: args.spaceId, cursor: null });
  },
});
export const memoryPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), batchSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 25;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100)
      throw new Error('INVALID_REBUILD_BATCH_SIZE');
    return ctx.db.query('memories').paginate({
      cursor: args.cursor,
      numItems: batchSize,
      maximumBytesRead: 512000,
    });
  },
});
export const vectorOwner = internalQuery({
  args: { memoryId: v.id('memories') },
  handler: async (ctx, args) => {
    const memory = await ctx.db.get(args.memoryId);
    if (!memory) return null;
    if (memory.worldId)
      return { memory, worldId: memory.worldId, agentGlobalId: memory.agentGlobalId };
    const bindings = await ctx.db.query('residentModelBindings').withIndex('player', q => q.eq('playerId', memory.playerId)).take(2);
    if (bindings.length !== 1) throw new Error('LEGACY_MEMORY_OWNER_AMBIGUOUS');
    return { memory, worldId: bindings[0].worldId, agentGlobalId: bindings[0].agentGlobalId };
  },
});
export const putVector = internalMutation({
  args: {
    memoryId: v.id('memories'),
    spaceId: v.id('embeddingSpaces'),
    embedding: v.array(v.float64()),
    worldId: v.id('worlds'),
    agentGlobalId: v.optional(v.string()),
    expectedSourceDigest: v.optional(v.string()),
    embeddingCertificateId: v.optional(v.id('embeddingCertificates')),
  },
  handler: async (ctx, args) => {
    let memory = await ctx.db.get(args.memoryId);
    const space = await ctx.db.get(args.spaceId);
    const profile = space && (await ctx.db.get(space.profileId));
    if (!memory || !profile) throw new Error('EMBEDDING_SOURCE_MISSING');
    await assertVectorCertificate(ctx.db, args.spaceId, args.embeddingCertificateId);
    validateVector(args.embedding, profile.dimensions);
    if (memory.worldId && memory.worldId !== args.worldId) throw new Error('MEMORY_OWNER_MISMATCH');
    const prior = await ctx.db
      .query('modelMemoryVectors')
      .withIndex('memory_space', (q) => q.eq('memoryId', args.memoryId).eq('spaceId', args.spaceId))
      .unique();
    if (memory.worldId && memory.agentGlobalId !== args.agentGlobalId) throw new Error('MEMORY_OWNER_MISMATCH');
    if (args.expectedSourceDigest && args.expectedSourceDigest !== await memorySourceDigest(memory))
      throw new Error('EMBEDDING_SOURCE_CHANGED');
    if (!memory.worldId) {
      await ctx.db.patch(memory._id, { worldId: args.worldId, agentGlobalId: args.agentGlobalId });
      memory = (await ctx.db.get(memory._id))!;
    }
    const { expectedSourceDigest: _, ...fields } = args;
    const sourceDigest = await memorySourceDigest(memory);
    if (!prior) await ctx.db.insert('modelMemoryVectors', { ...fields, playerId: memory.playerId, sourceDigest });
    else if (prior.sourceDigest !== sourceDigest) await ctx.db.replace(prior._id, { ...fields, playerId: memory.playerId, sourceDigest });
  },
});
export const rebuildPage = internalAction({
  args: { spaceId: v.id('embeddingSpaces'), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<void> => {
    try {
      const route = await ctx.runQuery(internal.models.embeddings.getRoute, {
        spaceId: args.spaceId,
      });
      if (route.space.status === 'FAILED') return;
      const budget = await ctx.runQuery(internal.federation.storagePolicy.rebuildBudget, {
        requestedBatchSize: 25,
      });
      if (budget.paused) {
        // Retain the cursor and old active space. Maintenance refreshes usage;
        // retrying lets a budget increase or safe cleanup resume this build.
        await ctx.scheduler.runAfter(60000, internal.models.embeddings.rebuildPage, args);
        return;
      }
      const page = await ctx.runQuery(internal.models.embeddings.memoryPage, {
        cursor: args.cursor,
        batchSize: budget.allowedBatchSize,
      });
      for (const memory of page.page) await indexOne(ctx, memory._id, route);
      if (!page.isDone)
        await ctx.scheduler.runAfter(0, internal.models.embeddings.rebuildPage, {
          spaceId: args.spaceId,
          cursor: page.continueCursor,
        });
      else await ctx.runMutation(internal.models.embeddings.finishBuild, { spaceId: args.spaceId });
    } catch (error) {
      await ctx.runMutation(internal.models.embeddings.failBuild, {
        spaceId: args.spaceId,
        failure: String(error).slice(0, 500),
      });
    }
  },
});
export const existingVector = internalQuery({
  args: { memoryId: v.id('memories'), spaceId: v.id('embeddingSpaces') },
  handler: async (ctx, args) =>
    ctx.db
      .query('modelMemoryVectors')
      .withIndex('memory_space', (q) => q.eq('memoryId', args.memoryId).eq('spaceId', args.spaceId))
      .unique(),
});
async function indexOne(ctx: ActionCtx, memoryId: Id<'memories'>, route: EmbeddingRoute) {
  await guardEmbeddingRoute(ctx, route);
  const owner = await ctx.runQuery(internal.models.embeddings.vectorOwner, { memoryId });
  if (!owner) return;
  const sourceDigest = await memorySourceDigest(owner.memory);
  const existing = await ctx.runQuery(internal.models.embeddings.existingVector, { memoryId, spaceId: route.space._id });
  if (existing?.sourceDigest === sourceDigest && existing.embeddingCertificateId === route.space.embeddingCertificateId) return;
  const result = await cache.fetchBatch(ctx, [owner.memory.description], {
    route,
    inputMode: 'document',
    owner: { worldId: owner.worldId, playerId: owner.memory.playerId },
  });
  await ctx.runMutation(internal.models.embeddings.putVector, {
    memoryId,
    spaceId: route.space._id,
    embedding: result.embeddings[0],
    worldId: owner.worldId,
    agentGlobalId: owner.agentGlobalId,
    expectedSourceDigest: sourceDigest,
    embeddingCertificateId: result.embeddingCertificateId,
  });
}
export const allWritableSpaces = internalQuery({
  args: {},
  handler: async (ctx) => {
    const spaces = await ctx.db.query('embeddingSpaces').collect();
    return spaces.filter((s) => s.status !== 'FAILED').map((s) => s._id);
  },
});
export const indexMemory = internalAction({
  args: { memoryId: v.id('memories') },
  handler: async (ctx, args): Promise<void> => {
    await ctx.runMutation(internal.models.embeddings.ensureActiveSpace, {});
    const spaces = await ctx.runQuery(internal.models.embeddings.allWritableSpaces, {});
    const failures: string[] = [];
    for (const spaceId of spaces) {
      try {
        const route = await ctx.runQuery(internal.models.embeddings.getRoute, { spaceId });
        await indexOne(ctx, args.memoryId, route);
      } catch (error) {
        const failure = String(error).slice(0, 500);
        failures.push(`${spaceId}: ${failure}`);
        await ctx.runMutation(internal.models.embeddings.failBuild, { spaceId, failure });
      }
    }
    if (failures.length) throw new Error(`MEMORY_INDEX_FAILED: ${failures.join('; ')}`);
  },
});
const SCAN_PAGE_SIZE = 25;
async function scanRevisions(ctx: { db: DatabaseReader }, spaceId?: Id<'embeddingSpaces'>) {
  return {
    sourceRevision: await dataRevision(ctx.db, sourceKey),
    vectorRevision: spaceId ? await dataRevision(ctx.db, vectorKey(spaceId)) : 0,
  };
}
async function createScan(ctx: MutationCtx, kind: Doc<'embeddingScanJobs'>['kind'], options: {
  spaceId?: Id<'embeddingSpaces'>; profileId?: Id<'embeddingProfiles'>;
}) {
  const now = Date.now();
  const jobId = await ctx.db.insert('embeddingScanJobs', {
    ...options, kind, phase: 'MEMORIES', cursor: null,
    ...await scanRevisions(ctx, options.spaceId), memoryCount: 0, vectorCount: 0,
    sampleIndex: 0, sampleMemoryIds: [], sampleCount: 0, restarts: 0,
    createdAt: now, updatedAt: now,
  });
  if (options.spaceId) await ctx.db.patch(options.spaceId, kind === 'VALIDATION'
    ? { validationJobId: jobId, validatedAt: undefined, validationSampleCount: undefined }
    : { coverageJobId: jobId });
  return jobId;
}
async function assertScanCurrent(ctx: MutationCtx, job: Doc<'embeddingScanJobs'>) {
  const current = await scanRevisions(ctx, job.spaceId);
  if (job.sourceRevision !== current.sourceRevision || job.vectorRevision !== current.vectorRevision)
    throw new Error('EMBEDDING_SOURCE_CHANGED');
}
async function verifyMemoryVector(ctx: MutationCtx, memory: Doc<'memories'>, spaceId: Id<'embeddingSpaces'>, dimensions: number, allowMissing?: false): Promise<Doc<'modelMemoryVectors'>>;
async function verifyMemoryVector(ctx: MutationCtx, memory: Doc<'memories'>, spaceId: Id<'embeddingSpaces'>, dimensions: number, allowMissing: true): Promise<Doc<'modelMemoryVectors'> | null>;
async function verifyMemoryVector(ctx: MutationCtx, memory: Doc<'memories'>, spaceId: Id<'embeddingSpaces'>, dimensions: number, allowMissing = false) {
  const vector = await ctx.db.query('modelMemoryVectors')
    .withIndex('memory_space', q => q.eq('memoryId', memory._id).eq('spaceId', spaceId)).unique();
  if (!vector) {
    if (allowMissing) return null;
    throw new Error('EMBEDDING_COVERAGE_INCOMPLETE');
  }
  validateVector(vector.embedding, dimensions);
  await assertVectorCertificate(ctx.db, spaceId, vector.embeddingCertificateId);
  if (!memory.worldId || vector.playerId !== memory.playerId || vector.worldId !== memory.worldId ||
      vector.agentGlobalId !== memory.agentGlobalId) throw new Error('MEMORY_OWNER_MISMATCH');
  if (vector.sourceDigest !== await memorySourceDigest(memory)) throw new Error('EMBEDDING_SOURCE_VECTOR_STALE');
  return vector;
}
async function advanceScan(ctx: MutationCtx, jobId: Id<'embeddingScanJobs'>) {
  const job = await ctx.db.get(jobId);
  if (!job || ['DONE', 'FAILED'].includes(job.phase)) return;
  try {
    await assertScanCurrent(ctx, job);
    const route = job.spaceId ? await ctx.db.get(job.spaceId) : null;
    const profile = route ? await ctx.db.get(route.profileId) : null;
    if (job.spaceId && (!profile || profile.disabled || route?.status === 'FAILED'))
      throw new Error('EMBEDDING_SPACE_NOT_AVAILABLE');
    const patch: Partial<Doc<'embeddingScanJobs'>> = { updatedAt: Date.now() };
    if (job.phase === 'MEMORIES') {
      // Exactly one paginate call per mutation. Later phases use separate transactions.
      const page = await ctx.db.query('memories').paginate({ cursor: job.cursor, numItems: SCAN_PAGE_SIZE, maximumBytesRead: 512000 });
      const samples = [...job.sampleMemoryIds];
      const missingMemoryIds: Id<'memories'>[] = [];
      const buildingCoverage = job.kind === 'COVERAGE' && route?.status === 'BUILDING' && route.coverageJobId === job._id;
      for (const memory of page.page) {
        if (job.spaceId && !await verifyMemoryVector(ctx, memory, job.spaceId, profile!.dimensions, true)) {
          if (!buildingCoverage) throw new Error('EMBEDDING_COVERAGE_INCOMPLETE');
          missingMemoryIds.push(memory._id);
        }
        if (samples.length < 3) samples.push(memory._id);
      }
      if (missingMemoryIds.length) {
        if (job.restarts >= 3) throw new Error('EMBEDDING_COVERAGE_INCOMPLETE');
        // A source can commit after the final rebuild page but before coverage starts.
        // Persist the shared retry budget and repair dispatch together; keep old routing.
        await ctx.db.patch(jobId, { phase: 'MEMORIES', cursor: null, memoryCount: 0, vectorCount: 0,
          sampleIndex: 0, sampleMemoryIds: [], queryVector: undefined, sampleCount: 0,
          restarts: job.restarts + 1, updatedAt: Date.now() });
        await ctx.scheduler.runAfter(0, internal.models.embeddings.repairCoverage, {
          jobId, attempt: job.restarts + 1, memoryIds: missingMemoryIds,
        });
        return true;
      }
      patch.memoryCount = job.memoryCount + page.page.length;
      patch.sampleMemoryIds = samples;
      patch.cursor = page.isDone ? null : page.continueCursor;
      if (page.isDone) patch.phase = job.kind === 'PLAN' ? 'DONE' : 'VECTORS';
    } else if (job.phase === 'VECTORS') {
      const page = await ctx.db.query('modelMemoryVectors').withIndex('space', q => q.eq('spaceId', job.spaceId!))
        .paginate({ cursor: job.cursor, numItems: 4, maximumBytesRead: 512000 });
      for (const vector of page.page) {
        const memory = await ctx.db.get(vector.memoryId);
        if (!memory) throw new Error('DANGLING_MEMORY_VECTOR');
        // The preceding source pass already proved uniqueness for every memory.
        // Check every stored row as well so dangling/extra owner rows cannot hide outside it.
        validateVector(vector.embedding, profile!.dimensions);
        await assertVectorCertificate(ctx.db, job.spaceId!, vector.embeddingCertificateId);
        if (vector.worldId !== memory.worldId || vector.playerId !== memory.playerId ||
            vector.agentGlobalId !== memory.agentGlobalId) throw new Error('MEMORY_OWNER_MISMATCH');
      }
      patch.vectorCount = job.vectorCount + page.page.length;
      patch.cursor = page.isDone ? null : page.continueCursor;
      if (page.isDone) {
        if (patch.vectorCount !== job.memoryCount) throw new Error('EMBEDDING_COVERAGE_INCOMPLETE');
        patch.phase = job.kind === 'VALIDATION' && job.sampleMemoryIds.length ? 'SAMPLES' : 'DONE';
        if (route && route.status !== 'ACTIVE' && route.status !== 'RETIRED')
          await ctx.db.patch(route._id, { status: 'READY' });
      }
    } else {
      if (!job.queryVector) throw new Error('EMBEDDING_QUERY_SAMPLE_REQUIRED');
      const memory = await ctx.db.get(job.sampleMemoryIds[job.sampleIndex]);
      if (!memory) throw new Error('EMBEDDING_SOURCE_CHANGED');
      const expected = await verifyMemoryVector(ctx, memory, job.spaceId!, profile!.dimensions);
      validateVector(job.queryVector, profile!.dimensions);
      const expectedScore = cosineSimilarity(job.queryVector, expected.embedding);
      if (expectedScore <= 0) throw new Error('EMBEDDING_RETRIEVAL_SAMPLE_MISSED');
      const page = await ctx.db.query('modelMemoryVectors').withIndex('resident_space', q =>
        q.eq('worldId', expected.worldId).eq('playerId', expected.playerId).eq('spaceId', job.spaceId!))
        .paginate({ cursor: job.cursor, numItems: SCAN_PAGE_SIZE, maximumBytesRead: 512000 });
      for (const candidate of page.page) {
        // Full source/row coverage has already checked each candidate under the unchanged
        // generation fence. The source digest includes text and the same owner namespace,
        // so equal digests preserve the existing same-description tie exception without
        // dereferencing an unbounded number of potentially 1 MiB source documents.
        if (candidate.agentGlobalId !== expected.agentGlobalId) throw new Error('MEMORY_OWNER_MISMATCH');
        validateVector(candidate.embedding, profile!.dimensions);
        if (candidate.sourceDigest !== expected.sourceDigest && cosineSimilarity(job.queryVector, candidate.embedding) >= expectedScore)
          throw new Error('EMBEDDING_RETRIEVAL_SAMPLE_MISSED');
      }
      patch.cursor = page.isDone ? null : page.continueCursor;
      if (page.isDone) {
        patch.sampleIndex = job.sampleIndex + 1;
        patch.sampleCount = job.sampleCount + 1;
        patch.queryVector = undefined;
        if (patch.sampleIndex === job.sampleMemoryIds.length) patch.phase = 'DONE';
      }
    }
    await ctx.db.patch(jobId, patch);
    if (patch.phase === 'DONE' && job.kind === 'VALIDATION' && route?.validationJobId === job._id)
      await ctx.db.patch(job.spaceId!, { validatedAt: Date.now(), validationSampleCount: patch.sampleCount ?? job.sampleCount, failure: undefined });
  } catch (error) {
    const failure = String(error).slice(0, 500);
    if (failure.includes('EMBEDDING_SOURCE_CHANGED') && job.restarts < 3) {
      await ctx.db.patch(jobId, { ...await scanRevisions(ctx, job.spaceId), phase: 'MEMORIES', cursor: null,
        memoryCount: 0, vectorCount: 0, sampleIndex: 0, sampleMemoryIds: [], queryVector: undefined,
        sampleCount: 0, restarts: job.restarts + 1, updatedAt: Date.now() });
    } else {
      await ctx.db.patch(jobId, { phase: 'FAILED', failure, updatedAt: Date.now() });
      const space = job.spaceId && await ctx.db.get(job.spaceId);
      if (space && (space.validationJobId === job._id || space.coverageJobId === job._id))
        await ctx.db.patch(space._id, { failure, validatedAt: undefined, validationSampleCount: undefined,
          ...(job.kind === 'COVERAGE' && space.status === 'BUILDING' && job.restarts >= 3 &&
            (failure.includes('EMBEDDING_COVERAGE_INCOMPLETE') || failure.includes('EMBEDDING_SOURCE_CHANGED'))
            ? { status: 'FAILED' as const } : {}) });
    }
  }
}
export const advanceScanPage = internalMutation({
  args: { jobId: v.id('embeddingScanJobs') },
  handler: async (ctx, args) => {
    const repairScheduled = await advanceScan(ctx, args.jobId);
    const job = await ctx.db.get(args.jobId);
    return job && { ...job, repairScheduled: !!repairScheduled };
  },
});
export const resumeCoverageScan = internalMutation({
  args: { jobId: v.id('embeddingScanJobs'), attempt: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId), space = job?.spaceId && await ctx.db.get(job.spaceId);
    if (!job || job.kind !== 'COVERAGE' || job.phase !== 'MEMORIES' || job.restarts !== args.attempt ||
      !space || space.status !== 'BUILDING' || space.coverageJobId !== job._id) return;
    // Repair writes advance vector revisions; certify a fresh full scan after those writes.
    await ctx.db.patch(job._id, { ...await scanRevisions(ctx, job.spaceId), updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.models.embeddings.scanWork, { jobId: job._id });
  },
});
export const repairCoverage = internalAction({
  args: { jobId: v.id('embeddingScanJobs'), attempt: v.number(), memoryIds: v.array(v.id('memories')) },
  handler: async (ctx, args): Promise<void> => {
    if (!args.memoryIds.length || args.memoryIds.length > SCAN_PAGE_SIZE) throw new Error('INVALID_COVERAGE_REPAIR_PAGE');
    const job = await ctx.runQuery(internal.models.embeddings.scanJob, { jobId: args.jobId });
    if (!job?.spaceId || job.kind !== 'COVERAGE' || job.phase !== 'MEMORIES' || job.restarts !== args.attempt) return;
    try {
      const route = await ctx.runQuery(internal.models.embeddings.getRoute, { spaceId: job.spaceId });
      if (route.space.status !== 'BUILDING' || route.space.coverageJobId !== job._id) return;
      const budget = await ctx.runQuery(internal.federation.storagePolicy.rebuildBudget, { requestedBatchSize: args.memoryIds.length });
      if (budget.paused) {
        await ctx.scheduler.runAfter(60000, internal.models.embeddings.repairCoverage, args);
        return;
      }
      for (const memoryId of args.memoryIds.slice(0, budget.allowedBatchSize)) {
        // Delayed indexMemory may already have filled this key. Never overwrite an
        // existing malformed/stale vector: the full verification must reject it.
        if (!await ctx.runQuery(internal.models.embeddings.existingVector, { memoryId, spaceId: job.spaceId }))
          await indexOne(ctx, memoryId, route);
      }
      if (args.memoryIds.length > budget.allowedBatchSize) {
        await ctx.scheduler.runAfter(0, internal.models.embeddings.repairCoverage, {
          ...args, memoryIds: args.memoryIds.slice(budget.allowedBatchSize),
        });
        return;
      }
      await ctx.runMutation(internal.models.embeddings.resumeCoverageScan, { jobId: job._id, attempt: args.attempt });
    } catch (error) {
      if (String(error).includes('MAINTENANCE_LOCKED')) {
        await ctx.scheduler.runAfter(60000, internal.models.embeddings.repairCoverage, args);
      } else if (String(error).includes('EMBEDDING_SOURCE_CHANGED')) {
        await ctx.runMutation(internal.models.embeddings.resumeCoverageScan, { jobId: job._id, attempt: args.attempt });
      } else {
        await ctx.runMutation(internal.models.embeddings.failScan, { jobId: job._id, failure: String(error).slice(0, 500) });
      }
    }
  },
});
export const scanJob = internalQuery({
  args: { jobId: v.id('embeddingScanJobs') }, handler: (ctx, args) => ctx.db.get(args.jobId),
});
export const saveQuerySample = internalMutation({
  args: { jobId: v.id('embeddingScanJobs'), sampleIndex: v.number(), embedding: v.array(v.float64()), embeddingCertificateId: v.optional(v.id('embeddingCertificates')) },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.phase !== 'SAMPLES' || job.sampleIndex !== args.sampleIndex || job.queryVector) return false;
    await assertScanCurrent(ctx, job);
    const certificate = await assertSpaceCertificate(ctx.db, job.spaceId!, args.embeddingCertificateId);
    if (certificate && certificate._id !== args.embeddingCertificateId) throw new Error('EMBEDDING_GENERATION_EVIDENCE_MISSING');
    await ctx.db.patch(job._id, { queryVector: args.embedding, updatedAt: Date.now() });
    return true;
  },
});
export const scanWork = internalAction({
  args: { jobId: v.id('embeddingScanJobs') },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.runQuery(internal.models.embeddings.scanJob, args);
    if (!job || ['DONE', 'FAILED'].includes(job.phase)) return;
    try {
      // Coverage may take longer than a serving certificate's freshness window.
      // Refresh authority on every bounded page, including pages without samples.
      const route = job.spaceId ? await ctx.runQuery(internal.models.embeddings.getRoute, { spaceId: job.spaceId }) : null;
      const embeddingCertificateId = route ? await guardEmbeddingRoute(ctx, route) : undefined;
      if (job.phase === 'SAMPLES' && !job.queryVector) {
        const samples = await ctx.runQuery(internal.models.embeddings.validationSamples, { spaceId: job.spaceId!, memoryIds: [job.sampleMemoryIds[job.sampleIndex]] });
        const sample = samples[0];
        if (!sample?.memory || !sample.vector) throw new Error('DANGLING_MEMORY_VECTOR');
        // Validation always probes the live query pipeline, never a cached sample.
        const result = await trackedModelCall(ctx, 'EMBEDDING', {
          profileId: route!.profile._id, worldId: sample.vector.worldId, playerId: sample.vector.playerId,
        }, async () => {
          const response = embeddingCertificateId
            ? { embedding: await fetchCertifiedOllamaEmbedding(route!.profile, sample.memory!.description, 'query'), usage: undefined, retries: 0 }
            : await fetchEmbedding(sample.memory!.description, profileEmbeddingConfig(route!.profile), 'query');
          validateVector(response.embedding, route!.profile.dimensions);
          return response;
        }, response => response.usage);
        await guardEmbeddingRoute(ctx, route!);
        const accepted = await ctx.runMutation(internal.models.embeddings.saveQuerySample, { jobId: job._id, sampleIndex: job.sampleIndex,
          embedding: result.embedding, embeddingCertificateId });
        if (!accepted) {
          await ctx.scheduler.runAfter(0, internal.models.embeddings.scanWork, args);
          return;
        }
      }
      const next = await ctx.runMutation(internal.models.embeddings.advanceScanPage, args);
      if (next && !next.repairScheduled && !['DONE', 'FAILED'].includes(next.phase))
        await ctx.scheduler.runAfter(0, internal.models.embeddings.scanWork, args);
    } catch (error) {
      if (String(error).includes('MAINTENANCE_LOCKED')) {
        await ctx.scheduler.runAfter(60000, internal.models.embeddings.scanWork, args);
        return;
      }
      if (String(error).includes('EMBEDDING_SOURCE_CHANGED')) {
        const next = await ctx.runMutation(internal.models.embeddings.advanceScanPage, args);
        if (next && !next.repairScheduled && !['DONE', 'FAILED'].includes(next.phase))
          await ctx.scheduler.runAfter(0, internal.models.embeddings.scanWork, args);
        return;
      }
      await ctx.runMutation(internal.models.embeddings.failScan, { jobId: args.jobId, failure: String(error).slice(0, 500) });
    }
  },
});
export const failScan = internalMutation({
  args: { jobId: v.id('embeddingScanJobs'), failure: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.phase === 'DONE') return;
    await ctx.db.patch(job._id, { phase: 'FAILED', failure: args.failure, updatedAt: Date.now() });
    const space = job.spaceId && await ctx.db.get(job.spaceId);
    if (space && (space.validationJobId === job._id || space.coverageJobId === job._id))
      await ctx.db.patch(space._id, { validatedAt: undefined, validationSampleCount: undefined, failure: args.failure });
  },
});
export const finishBuild = internalMutation({
  args: { spaceId: v.id('embeddingSpaces') },
  handler: async (ctx, args) => {
    if (!await ctx.db.get(args.spaceId)) throw new Error('EMBEDDING_SPACE_NOT_FOUND');
    const jobId = await createScan(ctx, 'COVERAGE', args);
    const repairScheduled = await advanceScan(ctx, jobId);
    if (!repairScheduled) await ctx.scheduler.runAfter(0, internal.models.embeddings.scanWork, { jobId });
    return jobId;
  },
});
export const failBuild = internalMutation({
  args: { spaceId: v.id('embeddingSpaces'), failure: v.string() },
  handler: async (ctx, args) => {
    const space = await ctx.db.get(args.spaceId);
    if (!space) return;
    // An existing active space remains queryable if a background catch-up fails.
    await ctx.db.patch(space._id, {
      ...(space.status === 'ACTIVE' ? {} : { status: 'FAILED' as const }),
      failure: args.failure,
    });
  },
});
export const validationSamples = internalQuery({
  args: { spaceId: v.id('embeddingSpaces'), memoryIds: v.optional(v.array(v.id('memories'))) },
  handler: async (ctx, args) => {
    const ids = args.memoryIds ?? (await ctx.db.query('modelMemoryVectors').withIndex('space', q => q.eq('spaceId', args.spaceId)).take(3)).map(row => row.memoryId);
    if (ids.length > 3) throw new Error('INVALID_VALIDATION_SAMPLE_COUNT');
    return Promise.all(ids.map(async memoryId => ({
      memory: await ctx.db.get(memoryId),
      vector: await ctx.db.query('modelMemoryVectors').withIndex('memory_space', q => q.eq('memoryId', memoryId).eq('spaceId', args.spaceId)).unique(),
    })));
  },
});
export const beginValidation = internalMutation({
  args: { spaceId: v.id('embeddingSpaces') }, handler: async (ctx, args) => {
    const space = await ctx.db.get(args.spaceId);
    if (!space || space.status === 'FAILED') throw new Error('EMBEDDING_SPACE_NOT_AVAILABLE');
    const current = space.validationJobId && await ctx.db.get(space.validationJobId);
    if (current && !['DONE', 'FAILED'].includes(current.phase)) return current._id;
    return createScan(ctx, 'VALIDATION', args);
  },
});
export const validateSpace = action({
  args: { adminToken: v.string(), spaceId: v.id('embeddingSpaces') },
  handler: async (ctx, args): Promise<{ valid: false; inProgress: true; jobId: Id<'embeddingScanJobs'> }> => {
    assertFederationAdmin(args.adminToken);
    const jobId = await ctx.runMutation(internal.models.embeddings.beginValidation, { spaceId: args.spaceId });
    await ctx.scheduler.runAfter(0, internal.models.embeddings.scanWork, { jobId });
    return { valid: false, inProgress: true, jobId };
  },
});
async function switchSpace(ctx: MutationCtx, spaceId: Id<'embeddingSpaces'>, operation: string) {
  const target = await ctx.db.get(spaceId);
  if (!target || !['READY', 'RETIRED', 'ACTIVE'].includes(target.status) || !target.validatedAt)
    throw new Error('EMBEDDING_SPACE_NOT_VALIDATED');
  if ((await ctx.db.get(target.profileId))?.disabled) throw new Error('EMBEDDING_PROFILE_DISABLED');
  await assertSpaceCertificate(ctx.db, spaceId);
  const certificate = target.validationJobId && await ctx.db.get(target.validationJobId);
  if (!certificate || certificate.phase !== 'DONE' || certificate.kind !== 'VALIDATION')
    throw new Error('EMBEDDING_SPACE_NOT_VALIDATED');
  if (certificate.spaceId !== spaceId) throw new Error('EMBEDDING_SPACE_NOT_VALIDATED');
  await assertScanCurrent(ctx, certificate);
  const config = await settings(ctx);
  if (!config) throw new Error('MODEL_SETTINGS_MISSING');
  if (config.activeEmbeddingSpaceId && config.activeEmbeddingSpaceId !== spaceId)
    await ctx.db.patch(config.activeEmbeddingSpaceId, { status: 'RETIRED' });
  await ctx.db.patch(spaceId, { status: 'ACTIVE' });
  await ctx.db.patch(config._id, { activeEmbeddingSpaceId: spaceId });
  await audit(
    ctx,
    operation,
    'activeEmbeddingSpace',
    spaceId,
    'Validated atomic switch',
    config.activeEmbeddingSpaceId,
  );
}
export const activateSpace = mutation({
  args: { adminToken: v.string(), spaceId: v.id('embeddingSpaces') },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    await switchSpace(ctx, args.spaceId, 'ACTIVATE_EMBEDDING_SPACE');
  },
});
export const rollback = mutation({
  args: { adminToken: v.string(), spaceId: v.id('embeddingSpaces') },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    await switchSpace(ctx, args.spaceId, 'ROLLBACK_EMBEDDING_SPACE');
  },
});

export const profileById = internalQuery({
  args: { embeddingProfileId: v.id('embeddingProfiles') },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.embeddingProfileId);
    if (!profile) throw new Error('EMBEDDING_PROFILE_NOT_FOUND');
    return profile;
  },
});
export const probeEmbedding = action({
  args: { adminToken: v.string(), embeddingProfileId: v.id('embeddingProfiles') },
  handler: async (ctx, args): Promise<{ ok: true; model: string; dimensions: number }> => {
    assertFederationAdmin(args.adminToken);
    const profile = await ctx.runQuery(internal.models.embeddings.profileById, {
      embeddingProfileId: args.embeddingProfileId,
    });
    try {
      await trackedModelCall(ctx, 'EMBEDDING', { profileId: profile._id }, async () => {
        const result = await fetchEmbedding('Connection validation', profileEmbeddingConfig(profile), 'query');
        validateVector(result.embedding, profile.dimensions);
        return result;
      }, response => response.usage);
      await ctx.runMutation(internal.models.embeddings.recordEmbeddingProbe, { profileId: profile._id, ok: true });
      return { ok: true, model: profile.model, dimensions: profile.dimensions };
    } catch (error) {
      await ctx.runMutation(internal.models.embeddings.recordEmbeddingProbe, { profileId: profile._id, ok: false });
      throw error;
    }
  },
});
export const recordEmbeddingProbe = internalMutation({
  args: { profileId: v.id('embeddingProfiles'), ok: v.boolean() },
  handler: async (ctx, args) => {
    if (!await ctx.db.get(args.profileId)) return;
    await audit(ctx, args.ok ? 'PROBE_EMBEDDING_SUCCESS' : 'PROBE_EMBEDDING_FAILED', args.profileId,
      args.profileId, args.ok ? 'Availability probe returned a valid vector' : 'Availability probe failed');
  },
});
