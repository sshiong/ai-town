import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { playerId } from '../aiTown/ids';
import { modelUsageTables, requestQuota, residentRequestQuotas } from './usageSchema';
import { certificateEvidenceFields } from './embeddingCertificateSchema';

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
  ...modelUsageTables,
  embeddingCertificates: defineTable({
    profileId: v.id('embeddingProfiles'), ...certificateEvidenceFields,
    state: v.union(v.literal('ACTIVE'), v.literal('REVOKED')),
    verifiedAt: v.number(), checkedAt: v.number(), trustBoundary: v.string(),
    revokedAt: v.optional(v.number()), reason: v.optional(v.string()),
    generationEvidenceId: v.optional(v.string()), sourceTownId: v.optional(v.string()), sourcePublicKey: v.optional(v.string()),
  }).index('profile', ['profileId']),
  embeddingRestoreJobs: defineTable({
    importId: v.id('backupImports'), targetProfileId: v.id('embeddingProfiles'), spaceId: v.id('embeddingSpaces'),
    state: v.union(v.literal('COPYING'), v.literal('PENDING_VALIDATION'), v.literal('REBUILD_REQUIRED')),
    cursor: v.union(v.string(), v.null()), offset: v.number(), copied: v.number(), skipped: v.number(),
    reason: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number(),
  }).index('import', ['importId']),
  chatProfiles: defineTable({
    ...connectionFields,
    ...chatOptions,
    stopWords: v.array(v.string()),
    createdAt: v.number(),
    legacy: v.optional(v.boolean()),
    disabled: v.optional(v.boolean()),
    dailyRequestLimit: v.optional(requestQuota),
  }),
  embeddingProfiles: defineTable({ ...embeddingProfileFields, createdAt: v.number(),
    disabled: v.optional(v.boolean()), dailyRequestLimit: v.optional(requestQuota) }),
  modelSettings: defineTable({
    key: v.string(),
    mainChatProfileId: v.optional(v.id('chatProfiles')),
    activeEmbeddingSpaceId: v.optional(v.id('embeddingSpaces')),
  }).index('key', ['key']),
  residentModelBindings: defineTable({
    requestQuotas: v.optional(residentRequestQuotas),
    worldId: v.id('worlds'),
    playerId,
    agentGlobalId: v.optional(v.string()),
    chatProfileId: v.id('chatProfiles'),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('resident', ['worldId', 'playerId'])
    .index('globalAgent', ['agentGlobalId'])
    .index('player', ['playerId']),
  modelAudits: defineTable({
    actor: v.optional(v.literal('FEDERATION_ADMIN')),
    operation: v.string(),
    subject: v.string(),
    previous: v.optional(v.string()),
    next: v.string(),
    reason: v.string(),
    at: v.number(),
  }),
  embeddingDataRevisions: defineTable({ key: v.string(), revision: v.number() }).index('key', ['key']),
  embeddingScanJobs: defineTable({
    kind: v.union(v.literal('PLAN'), v.literal('COVERAGE'), v.literal('VALIDATION')),
    profileId: v.optional(v.id('embeddingProfiles')),
    spaceId: v.optional(v.id('embeddingSpaces')),
    phase: v.union(v.literal('MEMORIES'), v.literal('VECTORS'), v.literal('SAMPLES'), v.literal('DONE'), v.literal('FAILED')),
    cursor: v.union(v.string(), v.null()),
    sourceRevision: v.number(),
    vectorRevision: v.number(),
    memoryCount: v.number(),
    vectorCount: v.number(),
    sampleIndex: v.number(),
    sampleMemoryIds: v.array(v.id('memories')),
    queryVector: v.optional(v.array(v.float64())),
    sampleCount: v.number(),
    restarts: v.number(),
    failure: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('profile', ['profileId']).index('space', ['spaceId']),
  embeddingSpaces: defineTable({
    embeddingCertificateId: v.optional(v.id('embeddingCertificates')),
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
    validationJobId: v.optional(v.id('embeddingScanJobs')),
    coverageJobId: v.optional(v.id('embeddingScanJobs')),
    failure: v.optional(v.string()),
  }),
  modelMemoryVectors: defineTable({
    embeddingCertificateId: v.optional(v.id('embeddingCertificates')),
    memoryId: v.id('memories'),
    sourceDigest: v.optional(v.string()),
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
