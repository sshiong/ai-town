import { v } from 'convex/values';
import { playerId } from '../aiTown/ids';
import type { Id } from '../_generated/dataModel';

export const ownerArgs = {
  adminToken: v.string(),
  worldId: v.id('worlds'),
  playerId,
  agentGlobalId: v.optional(v.string()),
  memoryId: v.id('memories'),
};
export type OwnerArgs = {
  adminToken: string;
  worldId: Id<'worlds'>;
  playerId: string;
  agentGlobalId?: string;
  memoryId: Id<'memories'>;
};
