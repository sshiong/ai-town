import { v } from 'convex/values';
import { mutation, query } from './maintenanceFunctions';
import { insertInput } from './aiTown/insertInput';
import { conversationId, playerId } from './aiTown/ids';
import { validatePublicInput } from './federation/publicInput';

export const listMessages = query({
  args: {
    worldId: v.id('worlds'),
    conversationId,
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query('messages')
      .withIndex('conversationId', (q) =>
        q.eq('worldId', args.worldId).eq('conversationId', args.conversationId),
      )
      .collect();
    const out = [];
    for (const message of messages) {
      const playerDescription = await ctx.db
        .query('playerDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', message.author))
        .first();
      if (!playerDescription) {
        throw new Error(`Invalid author ID: ${message.author}`);
      }
      out.push({ ...message, authorName: playerDescription.name });
    }
    return out;
  },
});

export const writeMessage = mutation({
  args: {
    worldId: v.id('worlds'),
    conversationId,
    messageUuid: v.string(),
    playerId,
    text: v.string(),
  },
  handler: async (ctx, args) => {
    await validatePublicInput(ctx, args.worldId, 'finishSendingMessage', args);
    const world = await ctx.db.get(args.worldId);
    const conversation = world?.conversations.find((c) => c.id === args.conversationId);
    if (
      !conversation ||
      !conversation.participants.some(
        (m) => m.playerId === args.playerId && m.status.kind === 'participating',
      )
    )
      throw new Error('CONVERSATION_CLOSED');
    if (conversation.federationTurn && conversation.federationTurn.deadline > Date.now())
      throw new Error('TURN_RESERVED');
    if (!args.text.trim() || args.text.length > 2000) throw new Error('INVALID_TEXT');
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
      messageUuid: args.messageUuid,
      text: args.text,
      worldId: args.worldId,
    });
    await insertInput(ctx, args.worldId, 'finishSendingMessage', {
      conversationId: args.conversationId,
      playerId: args.playerId,
      timestamp: Date.now(),
    });
  },
});
