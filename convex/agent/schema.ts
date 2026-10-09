import { v } from 'convex/values';
import { playerId, conversationId } from '../aiTown/ids';
import { defineTable } from 'convex/server';
import { EMBEDDING_DIMENSION } from '../util/llm';

export const memoryFields = {
  playerId,
  worldId: v.optional(v.id('worlds')),
  agentGlobalId: v.optional(v.string()),
  embeddingSpaceId: v.optional(v.id('embeddingSpaces')),
  description: v.string(),
  embeddingId: v.optional(v.id('memoryEmbeddings')),
  importance: v.number(),
  lastAccess: v.number(),
  data: v.union(
    // Setting up dynamics between players
    v.object({
      type: v.literal('relationship'),
      // The player this memory is about, from the perspective of the player
      // whose memory this is.
      playerId,
      agentGlobalId: v.optional(v.string()),
      homeTownId: v.optional(v.string()),
    }),
    v.object({
      type: v.literal('conversation'),
      conversationId,
      // The other player(s) in the conversation.
      playerIds: v.array(playerId),
      participants: v.optional(
        v.array(v.object({ agentGlobalId: v.string(), name: v.string(), homeTownId: v.string() })),
      ),
    }),
    v.object({
      type: v.literal('travel'),
      eventId: v.string(),
      visitId: v.string(),
      hostTownId: v.string(),
      sourceObservationEventId: v.optional(v.string()),
      federationConversationId: v.optional(v.string()),
      messageId: v.optional(v.string()),
      messageText: v.optional(v.string()),
      authorGlobalId: v.optional(v.string()),
      participants: v.array(
        v.object({ agentGlobalId: v.string(), name: v.string(), homeTownId: v.string() }),
      ),
      occurredAt: v.number(),
    }),
    v.object({
      type: v.literal('reflection'),
      relatedMemoryIds: v.array(v.id('memories')),
    }),
  ),
};
export const memoryTables = {
  memories: defineTable(memoryFields)
    .index('embeddingId', ['embeddingId'])
    .index('playerId_type', ['playerId', 'data.type'])
    .index('playerId', ['playerId'])
    .index('resident', ['worldId', 'playerId'])
    .index('globalAgent', ['agentGlobalId'])
    .index('travelEvent', ['agentGlobalId', 'data.type', 'data.eventId']),
  memoryEmbeddings: defineTable({
    playerId,
    embedding: v.array(v.float64()),
  }).vectorIndex('embedding', {
    vectorField: 'embedding',
    filterFields: ['playerId'],
    dimensions: EMBEDDING_DIMENSION,
  }),
};

export const agentTables = {
  ...memoryTables,
  embeddingsCache: defineTable({
    namespace: v.optional(v.string()),
    textHash: v.bytes(),
    embedding: v.array(v.float64()),
  })
    .index('text', ['textHash'])
    .index('namespace_text', ['namespace', 'textHash']),
};
