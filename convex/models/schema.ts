import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { playerId } from '../aiTown/ids';

export const provider = v.union(
  v.literal('openai'),
  v.literal('together'),
  v.literal('ollama'),
  v.literal('custom'),
);
export const chatOptions = {
  reasoningEffort: v.optional(v.literal('none')),
};
export const connectionFields = {
  name: v.string(),
  provider,
  url: v.string(),
  model: v.string(),
  apiKeyEnv: v.optional(v.string()),
};
export const embeddingProfileFields = {
  ...connectionFields,
  dimensions: v.number(),
  immutableRevision: v.optional(v.string()),
  weightsDigest: v.optional(v.string()),
  preprocessingRevision: v.string(),
  queryPrefix: v.string(),
  documentPrefix: v.string(),
  normalization: v.string(),
  fingerprint: v.string(),
};
export const modelTables = {
  chatProfiles: defineTable({
    ...connectionFields,
    ...chatOptions,
    stopWords: v.array(v.string()),
    createdAt: v.number(),
    legacy: v.optional(v.boolean()),
  }),
  embeddingProfiles: defineTable({ ...embeddingProfileFields, createdAt: v.number() }),
  modelSettings: defineTable({
    key: v.string(),
    mainChatProfileId: v.optional(v.id('chatProfiles')),
    activeEmbeddingSpaceId: v.optional(v.id('embeddingSpaces')),
  }).index('key', ['key']),
  residentModelBindings: defineTable({
    worldId: v.id('worlds'),
    playerId,
    agentGlobalId: v.optional(v.string()),
    chatProfileId: v.id('chatProfiles'),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('resident', ['worldId', 'playerId'])
    .index('globalAgent', ['agentGlobalId']),
  modelAudits: defineTable({
    operation: v.string(),
    subject: v.string(),
    previous: v.optional(v.string()),
    next: v.string(),
    reason: v.string(),
    at: v.number(),
  }),
  embeddingSpaces: defineTable({
    profileId: v.id('embeddingProfiles'),
    fingerprint: v.string(),
    status: v.union(
      v.literal('BUILDING'),
      v.literal('READY'),
      v.literal('ACTIVE'),
      v.literal('RETIRED'),
      v.literal('FAILED'),
    ),
    createdAt: v.number(),
    validatedAt: v.optional(v.number()),
    validationSampleCount: v.optional(v.number()),
    failure: v.optional(v.string()),
  }),
  modelMemoryVectors: defineTable({
    memoryId: v.id('memories'),
    worldId: v.id('worlds'),
    playerId,
    agentGlobalId: v.optional(v.string()),
    spaceId: v.id('embeddingSpaces'),
    embedding: v.array(v.float64()),
  })
    .index('memory_space', ['memoryId', 'spaceId'])
    .index('resident_space', ['worldId', 'playerId', 'spaceId'])
    .index('space', ['spaceId']),
};
