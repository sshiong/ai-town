import { serializedPlayer } from './player';
import { PLAYER_CONVERSATION_COOLDOWN } from '../constants';
import { distance } from '../util/geometry';
import { v } from 'convex/values';
import { agentId, conversationId, playerId } from './ids';
import { MutationCtx, internalMutation, internalQuery } from '../maintenanceFunctions';
import { internal } from '../_generated/api';
import { insertInput } from './insertInput';
export { Agent, serializedAgent } from './agentModel';
export type { SerializedAgent } from './agentModel';

export async function runAgentOperation(ctx: MutationCtx, operation: string, args: any) {
  let reference;
  switch (operation) {
    case 'agentRememberConversation':
      reference = internal.aiTown.agentOperations.agentRememberConversation;
      break;
    case 'agentGenerateMessage':
      reference = internal.aiTown.agentOperations.agentGenerateMessage;
      break;
    case 'agentDoSomething':
      reference = internal.aiTown.agentOperations.agentDoSomething;
      break;
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
  await ctx.scheduler.runAfter(0, reference, args);
}

export const agentSendMessage = internalMutation({
  args: {
    worldId: v.id('worlds'),
    conversationId,
    agentId,
    playerId,
    text: v.string(),
    messageUuid: v.string(),
    leaveConversation: v.boolean(),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    const agent = world?.agents.find((a) => a.id === args.agentId);
    const conversation = world?.conversations.find((c) => c.id === args.conversationId);
    if (
      !agent ||
      agent.travelVisitId ||
      !world?.players.some((p) => p.id === args.playerId) ||
      agent.inProgressOperation?.operationId !== args.operationId ||
      conversation?.isTyping?.messageUuid !== args.messageUuid ||
      conversation.isTyping.playerId !== args.playerId
    )
      return;
    const duplicate = await ctx.db
      .query('messages')
      .withIndex('messageUuid', (q) =>
        q.eq('conversationId', args.conversationId).eq('messageUuid', args.messageUuid),
      )
      .first();
    if (duplicate) return;
    await ctx.db.insert('messages', {
      conversationId: args.conversationId,
      author: args.playerId,
      text: args.text,
      messageUuid: args.messageUuid,
      worldId: args.worldId,
    });
    await insertInput(ctx, args.worldId, 'agentFinishSendingMessage', {
      conversationId: args.conversationId,
      agentId: args.agentId,
      timestamp: Date.now(),
      leaveConversation: args.leaveConversation,
      operationId: args.operationId,
    });
  },
});

export const findConversationCandidate = internalQuery({
  args: {
    now: v.number(),
    worldId: v.id('worlds'),
    player: v.object(serializedPlayer),
    otherFreePlayers: v.array(v.object(serializedPlayer)),
  },
  handler: async (ctx, { now, worldId, player, otherFreePlayers }) => {
    const { position } = player;
    const candidates = [];

    for (const otherPlayer of otherFreePlayers) {
      // Find the latest conversation we're both members of.
      const lastMember = await ctx.db
        .query('participatedTogether')
        .withIndex('edge', (q) =>
          q.eq('worldId', worldId).eq('player1', player.id).eq('player2', otherPlayer.id),
        )
        .order('desc')
        .first();
      if (lastMember) {
        if (now < lastMember.ended + PLAYER_CONVERSATION_COOLDOWN) {
          continue;
        }
      }
      candidates.push({ id: otherPlayer.id, position });
    }

    // Sort by distance and take the nearest candidate.
    candidates.sort((a, b) => distance(a.position, position) - distance(b.position, position));
    return candidates[0]?.id;
  },
});
