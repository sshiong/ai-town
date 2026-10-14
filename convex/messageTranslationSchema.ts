import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { conversationId, playerId } from './aiTown/ids';

export const messageTranslationState = v.union(
  v.literal('QUEUED'),
  v.literal('TRANSLATING'),
  v.literal('READY'),
  v.literal('FAILED'),
);
export const messageTranslationTables = {
  playerTextTranslations: defineTable({
    worldId: v.id('worlds'),
    playerId,
    field: v.union(v.literal('description'), v.literal('activity')),
    targetLanguage: v.literal('zh-CN'),
    sourceText: v.string(),
    state: messageTranslationState,
    attempts: v.number(),
    generation: v.number(),
    updatedAt: v.number(),
    translatedText: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    retryAt: v.optional(v.number()),
    leaseUntil: v.optional(v.number()),
  }).index('player_field', ['worldId', 'playerId', 'field', 'targetLanguage']),
  messageTranslations: defineTable({
    messageId: v.id('messages'),
    worldId: v.id('worlds'),
    conversationId,
    targetLanguage: v.literal('zh-CN'),
    sourceDigest: v.string(),
    sourceText: v.string(),
    state: messageTranslationState,
    attempts: v.number(),
    updatedAt: v.number(),
    translatedText: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    retryAt: v.optional(v.number()),
    leaseGeneration: v.optional(v.number()),
    leaseUntil: v.optional(v.number()),
  })
    .index('message_language', ['messageId', 'targetLanguage'])
    .index('state_updated', ['state', 'updatedAt'])
    .index('conversation_state', ['worldId', 'conversationId', 'state']),
  messageTranslationPreferences: defineTable({
    worldId: v.id('worlds'),
    targetLanguage: v.literal('zh-CN'),
    enabledAt: v.number(),
    blockedUntil: v.optional(v.number()),
  }).index('world_language', ['worldId', 'targetLanguage']),
  messageTranslationWorker: defineTable({
    key: v.literal('zh-CN'),
    cacheRows: v.number(),
    generation: v.number(),
    activeId: v.optional(v.id('messageTranslations')),
    leaseUntil: v.optional(v.number()),
    wakeAt: v.optional(v.number()),
    scheduledId: v.optional(v.id('_scheduled_functions')),
  }).index('key', ['key']),
};
