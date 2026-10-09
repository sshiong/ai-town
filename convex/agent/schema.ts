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
      playerId: v.optional(playerId),
      agentGlobalId: v.optional(v.string()),
      homeTownId: v.optional(v.string()),
      evidenceMemoryIds: v.optional(v.array(v.id('memories'))),
      firstMetAt: v.optional(v.number()),
      lastMetAt: v.optional(v.number()),
      encounterCount: v.optional(v.number()),
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
      transcriptId: v.optional(v.string()),
      transcriptPageNumber: v.optional(v.number()),
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
    .index('residentRelationship', ['worldId', 'playerId', 'data.type', 'data.agentGlobalId'])
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
  homeTravelTranscripts: defineTable({
    transcriptId: v.string(),
    agentGlobalId: v.string(),
    worldId: v.id('worlds'),
    playerId,
    visitId: v.string(),
    hostTownId: v.string(),
    federationConversationId: v.string(),
    endedAt: v.number(),
    participants: v.array(v.object({ playerId: v.string(), agentGlobalId: v.string(), name: v.string(), homeTownId: v.string() })),
    finalPageNumber: v.optional(v.number()),
    receivedPageCount: v.number(),
    highestPageNumber: v.number(),
    totalMessageCount: v.number(),
    state: v.union(v.literal('RECEIVING'), v.literal('COMPLETE')),
    summaryState: v.union(v.literal('PENDING'), v.literal('RUNNING'), v.literal('DONE'), v.literal('FAILED')),
    summaryMemoryId: v.optional(v.id('memories')),
    endMemoryId: v.optional(v.id('memories')),
    summaryError: v.optional(v.string()),
    summaryStartedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  }).index('owner_transcript', ['agentGlobalId', 'transcriptId']).index('completionSummary', ['state', 'summaryState']),
  homeTravelTranscriptPages: defineTable({
    transcriptId: v.string(),
    agentGlobalId: v.string(),
    pageNumber: v.number(),
    eventId: v.string(),
    finalPage: v.boolean(),
    messages: v.array(v.object({ messageId: v.string(), text: v.string(), author: v.string(), occurredAt: v.number(), committedEventSeq: v.optional(v.number()) })),
    memoryIds: v.array(v.id('memories')),
  }).index('owner_transcript_page', ['agentGlobalId', 'transcriptId', 'pageNumber']).index('owner_event', ['agentGlobalId', 'eventId']),
  embeddingsCache: defineTable({
    namespace: v.optional(v.string()),
    textHash: v.bytes(),
    embedding: v.array(v.float64()),
  })
    .index('text', ['textHash'])
    .index('namespace_text', ['namespace', 'textHash']),
};
