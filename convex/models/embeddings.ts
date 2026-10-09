import { v } from 'convex/values';
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  ActionCtx,
  MutationCtx,
} from '../maintenanceFunctions';
import { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { assertFederationAdmin } from '../federation/auth';
import { EmbeddingConfig, fetchEmbedding, getEmbeddingConfig } from '../util/llm';
import { connectionFields } from './schema';
import { embeddingFingerprint, cosineSimilarity, validateVector } from './compatibility';
import { audit, settings, validateConnection } from './profiles';
import * as cache from '../agent/embeddingsCache';

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
    const config = await settings(ctx);
    const space = config?.activeEmbeddingSpaceId
      ? await ctx.db.get(config.activeEmbeddingSpaceId)
      : null;
    const current = space ? await ctx.db.get(space.profileId) : null;
    return {
      // Administrator supplied digests and revisions are claims, not verified provenance.
      compatibility: 'REBUILD_REQUIRED',
      canReuse: false,
      sourceFingerprint: current?.fingerprint ?? null,
      targetFingerprint: target.fingerprint,
      affectedMemories: (await ctx.db.query('memories').collect()).length,
    };
  },
});
export const beginRebuild = internalMutation({
  args: { targetProfileId: v.id('embeddingProfiles') },
  handler: async (ctx, args): Promise<Id<'embeddingSpaces'>> => {
    const profile = await ctx.db.get(args.targetProfileId);
    if (!profile) throw new Error('EMBEDDING_PROFILE_NOT_FOUND');
    const spaceId = await ctx.db.insert('embeddingSpaces', {
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
    const bindings = (await ctx.db.query('residentModelBindings').collect()).filter(
      (b) => b.playerId === memory.playerId,
    );
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
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db.get(args.memoryId);
    const space = await ctx.db.get(args.spaceId);
    const profile = space && (await ctx.db.get(space.profileId));
    if (!memory || !profile) throw new Error('EMBEDDING_SOURCE_MISSING');
    validateVector(args.embedding, profile.dimensions);
    if (memory.worldId && memory.worldId !== args.worldId) throw new Error('MEMORY_OWNER_MISMATCH');
    const prior = await ctx.db
      .query('modelMemoryVectors')
      .withIndex('memory_space', (q) => q.eq('memoryId', args.memoryId).eq('spaceId', args.spaceId))
      .unique();
    if (!prior) await ctx.db.insert('modelMemoryVectors', { ...args, playerId: memory.playerId });
    if (!memory.worldId)
      await ctx.db.patch(memory._id, { worldId: args.worldId, agentGlobalId: args.agentGlobalId });
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
  if (
    await ctx.runQuery(internal.models.embeddings.existingVector, {
      memoryId,
      spaceId: route.space._id,
    })
  )
    return;
  const owner = await ctx.runQuery(internal.models.embeddings.vectorOwner, { memoryId });
  if (!owner) return;
  const result = await cache.fetchBatch(ctx, [owner.memory.description], {
    route,
    inputMode: 'document',
  });
  await ctx.runMutation(internal.models.embeddings.putVector, {
    memoryId,
    spaceId: route.space._id,
    embedding: result.embeddings[0],
    worldId: owner.worldId,
    agentGlobalId: owner.agentGlobalId,
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
async function verifyCoverage(ctx: MutationCtx, spaceId: Id<'embeddingSpaces'>) {
  const space = await ctx.db.get(spaceId);
  const profile = space && (await ctx.db.get(space.profileId));
  if (!profile) throw new Error('EMBEDDING_SPACE_NOT_FOUND');
  const memories = await ctx.db.query('memories').collect();
  for (const memory of memories) {
    const vector = await ctx.db
      .query('modelMemoryVectors')
      .withIndex('memory_space', (q) => q.eq('memoryId', memory._id).eq('spaceId', spaceId))
      .unique();
    if (!vector) throw new Error('EMBEDDING_COVERAGE_INCOMPLETE');
    validateVector(vector.embedding, profile.dimensions);
    if (
      vector.playerId !== memory.playerId ||
      (memory.worldId && vector.worldId !== memory.worldId)
    )
      throw new Error('MEMORY_OWNER_MISMATCH');
  }
  return memories.length;
}
export const finishBuild = internalMutation({
  args: { spaceId: v.id('embeddingSpaces') },
  handler: async (ctx, args) => {
    const space = await ctx.db.get(args.spaceId);
    if (!space) throw new Error('EMBEDDING_SPACE_NOT_FOUND');
    await verifyCoverage(ctx, args.spaceId);
    if (space.status !== 'ACTIVE') await ctx.db.patch(space._id, { status: 'READY' });
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
  args: { spaceId: v.id('embeddingSpaces') },
  handler: async (ctx, args) => {
    const samples = await ctx.db
      .query('modelMemoryVectors')
      .withIndex('space', (q) => q.eq('spaceId', args.spaceId))
      .take(3);
    return await Promise.all(
      samples.map(async (vector) => ({
        vector,
        memory: await ctx.db.get(vector.memoryId),
        candidates: await Promise.all(
          (
            await ctx.db
              .query('modelMemoryVectors')
              .withIndex('resident_space', (q) =>
                q
                  .eq('worldId', vector.worldId)
                  .eq('playerId', vector.playerId)
                  .eq('spaceId', args.spaceId),
              )
              .collect()
          ).map(async (candidate) => ({
            memoryId: candidate.memoryId,
            embedding: candidate.embedding,
            description: (await ctx.db.get(candidate.memoryId))?.description,
          })),
        ),
      })),
    );
  },
});
export const markValidated = internalMutation({
  args: { spaceId: v.id('embeddingSpaces'), sampleCount: v.number() },
  handler: async (ctx, args) => {
    const count = await verifyCoverage(ctx, args.spaceId);
    if (count && args.sampleCount < 1) throw new Error('EMBEDDING_SAMPLE_VALIDATION_REQUIRED');
    await ctx.db.patch(args.spaceId, {
      validatedAt: Date.now(),
      validationSampleCount: args.sampleCount,
      failure: undefined,
    });
  },
});
export const invalidateValidation = internalMutation({
  args: { spaceId: v.id('embeddingSpaces'), failure: v.string() },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.spaceId))) return;
    await ctx.db.patch(args.spaceId, {
      validatedAt: undefined,
      validationSampleCount: undefined,
      failure: args.failure,
    });
  },
});
export const validateSpace = action({
  args: { adminToken: v.string(), spaceId: v.id('embeddingSpaces') },
  handler: async (ctx, args): Promise<{ valid: true; sampleCount: number }> => {
    assertFederationAdmin(args.adminToken);
    const route = await ctx.runQuery(internal.models.embeddings.getRoute, {
      spaceId: args.spaceId,
    });
    const samples = await ctx.runQuery(internal.models.embeddings.validationSamples, {
      spaceId: args.spaceId,
    });
    try {
      for (const sample of samples) {
        if (!sample.memory) throw new Error('DANGLING_MEMORY_VECTOR');
        // Validation must contact the endpoint, rather than reuse a prior query cache hit.
        const result = await fetchEmbedding(
          sample.memory.description,
          profileEmbeddingConfig(route.profile),
          'query',
        );
        validateVector(result.embedding, route.profile.dimensions);
        const ranked = sample.candidates
          .map((candidate) => {
            validateVector(candidate.embedding, route.profile.dimensions);
            return {
              ...candidate,
              score: cosineSimilarity(result.embedding, candidate.embedding),
            };
          })
          .sort((a, b) => b.score - a.score);
        const expected = ranked.find((candidate) => candidate.memoryId === sample.vector.memoryId);
        if (
          !expected ||
          expected.score <= 0 ||
          ranked.some(
            (candidate) =>
              candidate.description !== sample.memory!.description &&
              candidate.score >= expected.score,
          )
        )
          throw new Error('EMBEDDING_RETRIEVAL_SAMPLE_MISSED');
      }
      await ctx.runMutation(internal.models.embeddings.markValidated, {
        spaceId: args.spaceId,
        sampleCount: samples.length,
      });
      return { valid: true, sampleCount: samples.length };
    } catch (error) {
      await ctx.runMutation(internal.models.embeddings.invalidateValidation, {
        spaceId: args.spaceId,
        failure: String(error).slice(0, 500),
      });
      throw error;
    }
  },
});
async function switchSpace(ctx: MutationCtx, spaceId: Id<'embeddingSpaces'>, operation: string) {
  const target = await ctx.db.get(spaceId);
  if (!target || !['READY', 'RETIRED', 'ACTIVE'].includes(target.status) || !target.validatedAt)
    throw new Error('EMBEDDING_SPACE_NOT_VALIDATED');
  await verifyCoverage(ctx, spaceId);
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
    const result = await fetchEmbedding(
      'Connection validation',
      profileEmbeddingConfig(profile),
      'query',
    );
    validateVector(result.embedding, profile.dimensions);
    return { ok: true, model: profile.model, dimensions: profile.dimensions };
  },
});
