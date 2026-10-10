import { v } from 'convex/values';
import { query, QueryCtx } from '../maintenanceFunctions';
import { Doc, Id } from '../_generated/dataModel';
import { playerId } from '../aiTown/ids';
import { requireAdmin } from '../federation/security';
import { concernsParticipant } from './memory';

const ownerArgs = {
  adminToken: v.string(),
  worldId: v.id('worlds'),
  playerId,
  agentGlobalId: v.optional(v.string()),
};
type Owner = { worldId: Id<'worlds'>; playerId: string; agentGlobalId?: string };
const pageArgs = { cursor: v.union(v.string(), v.null()), numItems: v.number() };

async function requireOwner(ctx: QueryCtx, args: Owner & { adminToken: string }) {
  requireAdmin(args.adminToken);
  const binding = await ctx.db
    .query('residentModelBindings')
    .withIndex('resident', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
    .unique();
  if (!binding || binding.agentGlobalId !== args.agentGlobalId)
    throw new Error('SOCIAL_HISTORY_OWNER_MISMATCH');
}

function owns(memory: Doc<'memories'>, owner: Owner) {
  // Older local memories have no global owner. Their world/player scope remains authoritative.
  return (
    memory.worldId === owner.worldId &&
    memory.playerId === owner.playerId &&
    (!memory.agentGlobalId || memory.agentGlobalId === owner.agentGlobalId)
  );
}

function readCursor(cursor: string | null, scope: string, numItems: number) {
  if (!Number.isSafeInteger(numItems) || numItems < 1 || numItems > 25)
    throw new Error('INVALID_SOCIAL_PAGE_SIZE');
  if (cursor === null) return null;
  try {
    const value: unknown = JSON.parse(cursor);
    if (
      !value ||
      typeof value !== 'object' ||
      !('scope' in value) ||
      !('position' in value) ||
      value.scope !== scope ||
      typeof value.position !== 'string'
    )
      throw new Error();
    return value.position;
  } catch {
    throw new Error('SOCIAL_CURSOR_SCOPE_MISMATCH');
  }
}
const writeCursor = (scope: string, position: string) => JSON.stringify({ scope, position });
const scopeFor = (owner: Owner, kind: string, filter: unknown) =>
  JSON.stringify([owner.worldId, owner.playerId, owner.agentGlobalId ?? null, kind, filter]);
const memoryView = (row: Doc<'memories'>) => ({
  memoryId: row._id,
  recordedAt: row._creationTime,
  description: row.description,
  importance: row.importance,
  data: row.data,
});

/** Each page scans canonical text directly. An empty filtered page can still have older matches. */
export const history = query({
  args: {
    ...ownerArgs,
    ...pageArgs,
    kind: v.optional(
      v.union(
        v.literal('relationship'),
        v.literal('conversation'),
        v.literal('travel'),
        v.literal('reflection'),
      ),
    ),
    text: v.optional(v.string()),
    participantGlobalId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args);
    if ((args.text?.length ?? 0) > 200 || (args.participantGlobalId?.length ?? 0) > 300)
      throw new Error('INVALID_SOCIAL_FILTER');
    const text = args.text?.trim().toLowerCase() ?? '';
    const scope = scopeFor(args, 'history', [
      args.kind ?? null,
      text,
      args.participantGlobalId ?? null,
    ]);
    const cursor = readCursor(args.cursor, scope, args.numItems);
    const rows = args.kind
      ? ctx.db
          .query('memories')
          .withIndex('resident_type', (q) =>
            q.eq('worldId', args.worldId).eq('playerId', args.playerId).eq('data.type', args.kind!),
          )
      : ctx.db
          .query('memories')
          .withIndex('resident', (q) =>
            q.eq('worldId', args.worldId).eq('playerId', args.playerId),
          );
    const page = await rows.order('desc').paginate({ cursor, numItems: args.numItems });
    return {
      page: page.page
        .filter(
          (row) =>
            owns(row, args) &&
            (!text || row.description.toLowerCase().includes(text)) &&
            (!args.participantGlobalId || concernsParticipant(row, '', args.participantGlobalId)),
        )
        .map(memoryView),
      scanned: page.page.length,
      isDone: page.isDone,
      continueCursor: writeCursor(scope, page.continueCursor),
    };
  },
});

export const relationships = query({
  args: { ...ownerArgs, ...pageArgs },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args);
    const scope = scopeFor(args, 'relationships', null);
    const cursor = readCursor(args.cursor, scope, args.numItems);
    const page = await ctx.db
      .query('memories')
      .withIndex('resident_type', (q) =>
        q.eq('worldId', args.worldId).eq('playerId', args.playerId).eq('data.type', 'relationship'),
      )
      .order('desc')
      .paginate({ cursor, numItems: args.numItems });
    return {
      page: page.page.filter((row) => owns(row, args)).map(memoryView),
      isDone: page.isDone,
      continueCursor: writeCursor(scope, page.continueCursor),
    };
  },
});

/** A citation is visible only through a canonical memory owned by this resident. */
export const evidence = query({
  args: { ...ownerArgs, ...pageArgs, memoryId: v.id('memories') },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args);
    const memory = await ctx.db.get(args.memoryId);
    if (!memory)
      return { status: 'MISSING_MEMORY' as const, page: [], isDone: true, continueCursor: null };
    if (!owns(memory, args)) throw new Error('SOCIAL_HISTORY_EVIDENCE_OWNER_MISMATCH');
    const ids =
      memory.data.type === 'relationship'
        ? (memory.data.evidenceMemoryIds ?? [])
        : memory.data.type === 'reflection'
          ? memory.data.relatedMemoryIds
          : [];
    const uniqueIds = [...new Set(ids)];
    const scope = scopeFor(args, 'evidence', args.memoryId);
    const position = readCursor(args.cursor, scope, args.numItems);
    const offset = position === null ? 0 : Number(position);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > uniqueIds.length)
      throw new Error('INVALID_SOCIAL_EVIDENCE_CURSOR');
    const page = await Promise.all(
      uniqueIds.slice(offset, offset + args.numItems).map(async (id) => {
        const source = await ctx.db.get(id);
        if (!source) return { memoryId: id, status: 'MISSING_SOURCE' as const, memory: null };
        if (!owns(source, args))
          return { memoryId: id, status: 'OWNER_MISMATCH' as const, memory: null };
        if (
          memory.data.type === 'relationship' &&
          !concernsParticipant(source, memory.data.playerId ?? '', memory.data.agentGlobalId)
        )
          return { memoryId: id, status: 'PARTICIPANT_MISMATCH' as const, memory: null };
        return { memoryId: id, status: 'AVAILABLE' as const, memory: memoryView(source) };
      }),
    );
    const next = offset + page.length;
    return {
      status: 'AVAILABLE' as const,
      page,
      isDone: next >= uniqueIds.length,
      continueCursor: writeCursor(scope, String(next)),
    };
  },
});

export const conversationSource = query({
  args: { ...ownerArgs, ...pageArgs, memoryId: v.id('memories') },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args);
    const memory = await ctx.db.get(args.memoryId);
    if (!memory)
      return { status: 'MISSING_MEMORY' as const, page: [], isDone: true, continueCursor: null };
    if (!owns(memory, args)) throw new Error('SOCIAL_HISTORY_EVIDENCE_OWNER_MISMATCH');
    if (memory.data.type !== 'conversation') throw new Error('NOT_CONVERSATION_MEMORY');
    const conversationId = memory.data.conversationId;
    const scope = scopeFor(args, 'conversation', args.memoryId);
    const cursor = readCursor(args.cursor, scope, args.numItems);
    const archived = await ctx.db
      .query('archivedConversations')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('id', conversationId))
      .unique();
    const world = archived ? null : await ctx.db.get(args.worldId);
    const live = world?.conversations.find((c) => c.id === conversationId);
    const members = archived?.participants ?? live?.participants.map((p) => p.playerId);
    if (!members?.includes(args.playerId))
      return {
        status: 'MISSING_OR_UNVERIFIED_CONVERSATION' as const,
        page: [],
        isDone: true,
        continueCursor: null,
      };
    const page = await ctx.db
      .query('messages')
      .withIndex('conversationId', (q) =>
        q.eq('worldId', args.worldId).eq('conversationId', conversationId),
      )
      .order('asc')
      .paginate({ cursor, numItems: args.numItems });
    return {
      status: page.page.length ? ('AVAILABLE' as const) : ('NO_RETAINED_MESSAGES' as const),
      page: page.page.map((message) => ({
        messageId: message.messageUuid,
        text: message.text,
        authorPlayerId: message.author,
        occurredAt: message._creationTime,
      })),
      isDone: page.isDone,
      continueCursor: writeCursor(scope, page.continueCursor),
    };
  },
});

export const transcriptSource = query({
  args: { ...ownerArgs, memoryId: v.id('memories'), pageNumber: v.number() },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args);
    if (!Number.isSafeInteger(args.pageNumber) || args.pageNumber < 0 || args.pageNumber >= 1000)
      throw new Error('INVALID_TRANSCRIPT_PAGE');
    const memory = await ctx.db.get(args.memoryId);
    if (!memory) return { status: 'MISSING_MEMORY' as const, transcript: null, page: null };
    if (!owns(memory, args)) throw new Error('SOCIAL_HISTORY_EVIDENCE_OWNER_MISMATCH');
    if (
      memory.data.type !== 'travel' ||
      !memory.data.federationConversationId ||
      !args.agentGlobalId
    )
      return { status: 'NO_TRANSCRIPT_REFERENCE' as const, transcript: null, page: null };
    // End-event memories predate transcript links; the stable conversation + visit identifies them.
    const transcriptId =
      memory.data.transcriptId ?? `${memory.data.federationConversationId}/${memory.data.visitId}`;
    const transcript = await ctx.db
      .query('homeTravelTranscripts')
      .withIndex('owner_transcript', (q) =>
        q.eq('agentGlobalId', args.agentGlobalId!).eq('transcriptId', transcriptId),
      )
      .unique();
    if (!transcript) return { status: 'MISSING_TRANSCRIPT' as const, transcript: null, page: null };
    if (
      transcript.worldId !== args.worldId ||
      transcript.playerId !== args.playerId ||
      transcript.visitId !== memory.data.visitId ||
      transcript.hostTownId !== memory.data.hostTownId ||
      transcript.federationConversationId !== memory.data.federationConversationId
    )
      return { status: 'TRANSCRIPT_OWNER_MISMATCH' as const, transcript: null, page: null };
    const page = await ctx.db
      .query('homeTravelTranscriptPages')
      .withIndex('owner_transcript_page', (q) =>
        q
          .eq('agentGlobalId', args.agentGlobalId!)
          .eq('transcriptId', transcriptId)
          .eq('pageNumber', args.pageNumber),
      )
      .unique();
    return {
      status: page ? ('AVAILABLE' as const) : ('MISSING_PAGE' as const),
      transcript: {
        transcriptId,
        visitId: transcript.visitId,
        hostTownId: transcript.hostTownId,
        federationConversationId: transcript.federationConversationId,
        endedAt: transcript.endedAt,
        participants: transcript.participants,
        state: transcript.state,
        summaryState: transcript.summaryState,
        finalPageNumber: transcript.finalPageNumber,
        highestPageNumber: transcript.highestPageNumber,
        receivedPageCount: transcript.receivedPageCount,
        totalMessageCount: transcript.totalMessageCount,
      },
      page: page
        ? {
            pageNumber: page.pageNumber,
            eventId: page.eventId,
            finalPage: page.finalPage,
            messages: page.messages,
            memoryIds: page.memoryIds,
          }
        : null,
    };
  },
});
