import { messageTranslationTables } from './messageTranslationSchema';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { memoryCompressionTables } from './agent/memoryCompressionSchema';
import { agentTables } from './agent/schema';
import { aiTownTables } from './aiTown/schema';
import { conversationId, playerId } from './aiTown/ids';
import { engineTables } from './engine/schema';
import { federationTables } from './federation/schema';
import { autonomyTables } from './federation/autonomySchema';
import { runtimeTables } from './federation/runtimeSchema';
import { modelTables } from './models/schema';
import { backupTables } from './federation/backupSchema';
import { backupLargeTables } from './federation/backupLargeSchema';
import { identityRecoveryTables } from './federation/identityRecoverySchema';
import { storagePolicyTables } from './federation/storageSchema';
import { endpointTables } from './federation/endpointsSchema';
import { coldHistoryTables } from './federation/coldHistorySchema';
import { coldArchiveTables } from './federation/coldArchiveSchema';
import { residentPolicyTables } from './federation/residentPolicySchema';
import { travelPrivacyChunkTables } from './federation/travelPrivacyChunkSchema';
import { archiveUploadTables } from './federation/archiveUploadProvenanceSchema';
import { travelPrivacyChunkRewriteTables } from './federation/travelPrivacyChunkRewriteSchema';

export default defineSchema({
  ...messageTranslationTables,
  music: defineTable({
    storageId: v.string(),
    type: v.union(v.literal('background'), v.literal('player')),
  }).index('storage', ['storageId']),

  messages: defineTable({
    conversationId,
    messageUuid: v.string(),
    author: playerId,
    text: v.string(),
    worldId: v.optional(v.id('worlds')),
  })
    .index('conversationId', ['worldId', 'conversationId'])
    .index('messageUuid', ['conversationId', 'messageUuid']),

  ...agentTables,
  ...memoryCompressionTables,
  ...aiTownTables,
  ...engineTables,
  ...federationTables,
  ...autonomyTables,
  ...runtimeTables,
  ...modelTables,
  ...backupTables,
  ...backupLargeTables,
  ...identityRecoveryTables,
  ...storagePolicyTables,
  ...endpointTables,
  ...coldHistoryTables,
  ...coldArchiveTables,
  ...residentPolicyTables,
  ...travelPrivacyChunkTables,
  ...archiveUploadTables,
  ...travelPrivacyChunkRewriteTables,
});
