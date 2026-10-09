import { ObjectType, v } from 'convex/values';
import { MutationCtx, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { digest } from '../federation/security';
import { playerId } from '../aiTown/ids';

/** Only the authenticated Home receipt processor may call this internal mutation. */
const confirmedEventFields = {
  worldId: v.id('worlds'),
  playerId,
  agentGlobalId: v.string(),
  visitId: v.string(),
  eventId: v.string(),
  hostTownId: v.string(),
  description: v.string(),
  occurredAt: v.number(),
  importance: v.optional(v.number()),
  participants: v.array(
    v.object({ agentGlobalId: v.string(), name: v.string(), homeTownId: v.string() }),
  ),
};
type ConfirmedEvent = ObjectType<typeof confirmedEventFields> & {
  sourceObservationEventId?: string;
  federationConversationId?: string;
  messageId?: string;
  messageText?: string;
  authorGlobalId?: string;
};
async function persistConfirmedEvent(ctx: MutationCtx, args: ConfirmedEvent) {
  if (
    !args.description.trim() ||
    args.description.length > 16000 ||
    !args.eventId ||
    args.eventId.length > 256 ||
    !Number.isFinite(args.occurredAt) ||
    args.occurredAt < 0 ||
    args.occurredAt > Date.now() + 60_000 ||
    args.participants.length > 100 ||
    args.participants.some(
      (p) => !p.agentGlobalId || !p.homeTownId || !p.name || p.name.length > 256,
    )
  ) {
    throw new Error('INVALID_CONFIRMED_TRAVEL_EVENT');
  }
  const importance = args.importance ?? 5;
  if (!Number.isFinite(importance) || importance < 0 || importance > 9)
    throw new Error('INVALID_MEMORY_IMPORTANCE');
  const binding = await ctx.db
    .query('residentModelBindings')
    .withIndex('resident', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
    .unique();
  const visit = await ctx.db
    .query('visitLedger')
    .withIndex('visitId', (q) => q.eq('visitId', args.visitId))
    .unique();
  if (
    binding?.agentGlobalId !== args.agentGlobalId ||
    !visit ||
    visit.role !== 'home' ||
    visit.agentGlobalId !== args.agentGlobalId ||
    visit.hostTownId !== args.hostTownId ||
    visit.worldId !== args.worldId ||
    visit.homePlayerId !== args.playerId
  )
    throw new Error('TRAVEL_MEMORY_OWNER_MISMATCH');
  const existing = await ctx.db
    .query('memories')
    .withIndex('travelEvent', (q) =>
      q
        .eq('agentGlobalId', args.agentGlobalId)
        .eq('data.type', 'travel')
        .eq('data.eventId', args.eventId),
    )
    .unique();
  if (existing) {
    if (
      existing.description !== args.description ||
      existing.importance !== importance ||
      existing.data.type !== 'travel' ||
      existing.data.visitId !== args.visitId ||
      existing.data.hostTownId !== args.hostTownId ||
      existing.data.occurredAt !== args.occurredAt ||
      JSON.stringify(existing.data.participants) !== JSON.stringify(args.participants)
    ) {
      throw new Error('TRAVEL_EVENT_ID_CONFLICT');
    }
    return existing._id;
  }
  const memoryId = await ctx.db.insert('memories', {
    worldId: args.worldId,
    playerId: args.playerId,
    agentGlobalId: args.agentGlobalId,
    description: args.description,
    importance,
    lastAccess: args.occurredAt,
    data: {
      type: 'travel',
      eventId: args.eventId,
      visitId: args.visitId,
      hostTownId: args.hostTownId,
      participants: args.participants,
      sourceObservationEventId: args.sourceObservationEventId,
      federationConversationId: args.federationConversationId,
      messageId: args.messageId,
      messageText: args.messageText,
      authorGlobalId: args.authorGlobalId,
      occurredAt: args.occurredAt,
    },
  });
  // Persist facts before inference: unavailable credentials must not discard a committed event.
  await ctx.scheduler.runAfter(0, internal.models.embeddings.indexMemory, { memoryId });
  return memoryId;
}
export const recordConfirmedEvent = internalMutation({
  args: confirmedEventFields,
  handler: persistConfirmedEvent,
});

const observedConversationFields = {
  worldId: v.id('worlds'),
  playerId,
  agentGlobalId: v.string(),
  visitId: v.string(),
  hostTownId: v.string(),
  observationEventId: v.string(),
  federationConversationId: v.string(),
  observedAt: v.number(),
  messages: v.array(
    v.object({
      messageId: v.string(),
      text: v.string(),
      author: v.string(),
      occurredAt: v.number(),
    }),
  ),
  participants: v.array(
    v.object({
      playerId: v.string(),
      agentGlobalId: v.string(),
      name: v.string(),
      homeTownId: v.string(),
    }),
  ),
};
export type ConfirmedObservation = ObjectType<typeof observedConversationFields>;
/** Called inside the authenticated Inbox transaction, before scheduling a decision. */
export async function recordConfirmedObservation(ctx: MutationCtx, args: ConfirmedObservation) {
  if (
    !args.observationEventId ||
    !args.federationConversationId ||
    args.federationConversationId.length > 512 ||
    !Number.isFinite(args.observedAt) ||
    args.observedAt < 0 ||
    args.observedAt > Date.now() + 60_000 ||
    args.messages.length > 12 ||
    args.participants.length > 100 ||
    !args.participants.some((p) => p.agentGlobalId === args.agentGlobalId) ||
    new Set(args.participants.map((p) => p.playerId)).size !== args.participants.length
  )
    throw new Error('INVALID_CONFIRMED_OBSERVATION');
  const binding = await ctx.db
    .query('residentModelBindings')
    .withIndex('resident', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
    .unique();
  const ledger = await ctx.db
    .query('visitLedger')
    .withIndex('visitId', (q) => q.eq('visitId', args.visitId))
    .unique();
  if (
    binding?.agentGlobalId !== args.agentGlobalId ||
    !ledger ||
    ledger.role !== 'home' ||
    ledger.agentGlobalId !== args.agentGlobalId ||
    ledger.hostTownId !== args.hostTownId ||
    ledger.worldId !== args.worldId ||
    ledger.homePlayerId !== args.playerId
  )
    throw new Error('TRAVEL_MEMORY_OWNER_MISMATCH');
  const ids = [];
  for (const message of args.messages) {
    const author = args.participants.find((p) => p.playerId === message.author);
    if (
      !author ||
      !message.messageId ||
      message.messageId.length > 256 ||
      !message.text.trim() ||
      message.text.length > 4000 ||
      !Number.isFinite(message.occurredAt) ||
      message.occurredAt < 0 ||
      message.occurredAt > args.observedAt + 1000
    )
      throw new Error('INVALID_CONFIRMED_HOST_MESSAGE');
    // Home's own utterances have reliable ACTION_RESULT receipts; avoid recording them a second time.
    if (author.agentGlobalId === args.agentGlobalId) continue;
    const eventId = `host-message:${await digest([args.hostTownId, args.federationConversationId, message.messageId])}`;
    const existing = await ctx.db
      .query('memories')
      .withIndex('travelEvent', (q) =>
        q
          .eq('agentGlobalId', args.agentGlobalId)
          .eq('data.type', 'travel')
          .eq('data.eventId', eventId),
      )
      .unique();
    if (existing) {
      if (
        existing.data.type !== 'travel' ||
        existing.data.messageText !== message.text ||
        existing.data.authorGlobalId !== author.agentGlobalId ||
        existing.data.occurredAt !== message.occurredAt
      )
        throw new Error('TRAVEL_EVENT_ID_CONFLICT');
      ids.push(existing._id);
      continue;
    }
    const { playerId: _, ...participant } = author;
    ids.push(
      await persistConfirmedEvent(ctx, {
        worldId: args.worldId,
        playerId: args.playerId,
        agentGlobalId: args.agentGlobalId,
        visitId: args.visitId,
        hostTownId: args.hostTownId,
        eventId,
        description: `At ${args.hostTownId}, ${author.name} (${author.agentGlobalId}) said: ${message.text}`,
        participants: [participant],
        occurredAt: message.occurredAt,
        sourceObservationEventId: args.observationEventId,
        federationConversationId: args.federationConversationId,
        messageId: message.messageId,
        messageText: message.text,
        authorGlobalId: author.agentGlobalId,
      }),
    );
  }
  return ids;
}
export const recordObservedConversation = internalMutation({
  args: observedConversationFields,
  handler: recordConfirmedObservation,
});
