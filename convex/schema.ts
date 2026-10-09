import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
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

export default defineSchema({
  music: defineTable({
    storageId: v.string(),
    type: v.union(v.literal('background'), v.literal('player')),
  }),

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
});
