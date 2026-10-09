import { v } from 'convex/values';
import { Doc, Id } from '../_generated/dataModel';
import { MutationCtx, internalMutation } from '../maintenanceFunctions';
import { identity, visit } from './store';
import { enqueueMessage } from './queue';
import { mutationRef } from './refs';
import { digest } from './security';

export const TRANSCRIPT_PAGE_MESSAGES = 12;
export const TRANSCRIPT_PAYLOAD_BYTES = 60000;
type Participant = {
  playerId: string;
  agentGlobalId: string;
  name: string;
  homeTownId: string;
};
type TranscriptMessage = {
  messageId: string;
  text: string;
  author: string;
  occurredAt: number;
};
type Job = Doc<'federationTranscriptJobs'>;

/** Persist only the final transcript job in the world transaction; delivery cannot block the Tick. */
export async function captureEndedConversation(
  ctx: MutationCtx,
  worldId: Id<'worlds'>,
  existingWorld: Doc<'worlds'>,
  conversation: Doc<'worlds'>['conversations'][number],
  endedAt: number,
) {
  const visitors = conversation.participants.flatMap((member) => {
    const visitor = existingWorld.players.find((p) => p.id === member.playerId)?.remoteVisitor;
    return visitor ? [visitor] : [];
  });
  if (!visitors.length) return;
  const local = await identity(ctx);
  if (!local) return;
  const participants: Participant[] = [];
  for (const member of conversation.participants) {
    const player = existingWorld.players.find((p) => p.id === member.playerId);
    const description = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', worldId).eq('playerId', member.playerId))
      .unique();
    const binding = await ctx.db
      .query('residentModelBindings')
      .withIndex('resident', (q) => q.eq('worldId', worldId).eq('playerId', member.playerId))
      .unique();
    participants.push({
      playerId: member.playerId,
      agentGlobalId:
        player?.remoteVisitor?.agentGlobalId ??
        binding?.agentGlobalId ??
        `${local.townId}/human:${worldId}:${member.playerId}`,
      name: description?.name ?? member.playerId,
      homeTownId: player?.remoteVisitor?.homeTownId ?? local.townId,
    });
  }
  const federationConversationId = `${local.townId}/${worldId}/${conversation.id}`;
  for (const visitor of visitors) {
    const transcriptId = `${federationConversationId}/${visitor.visitId}`;
    const existing = await ctx.db
      .query('federationTranscriptJobs')
      .withIndex('transcript', (q) => q.eq('transcriptId', transcriptId))
      .unique();
    if (existing) continue;
    await ctx.db.insert('federationTranscriptJobs', {
      transcriptId,
      visitId: visitor.visitId,
      worldId,
      conversationId: conversation.id,
      federationConversationId,
      endedAt,
      participants,
      pageNumber: 0,
      state: 'PENDING',
      attempts: 0,
      nextRetryAt: 0,
      createdAt: Date.now(),
    });
  }
}

function payload(job: Job, messages: TranscriptMessage[], finalPage: boolean) {
  return {
    eventId: `${job.transcriptId}:page:${job.pageNumber}`,
    transcriptId: job.transcriptId,
    federationConversationId: job.federationConversationId,
    endedAt: job.endedAt,
    participants: job.participants as Participant[],
    messages,
    pageNumber: job.pageNumber,
    finalPage,
  };
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
async function retryLater(
  ctx: MutationCtx,
  job: Job,
  error: string,
  progress: { cursor?: string; pendingMessages: TranscriptMessage[]; pageReadDone: boolean },
) {
  const attempts = (job.attempts ?? 0) + 1;
  await ctx.db.patch(job._id, {
    ...progress,
    attempts,
    lastError: error,
    nextRetryAt: Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)),
  });
}

export const flushJob = internalMutation({
  args: { jobId: v.id('federationTranscriptJobs') },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (
      !job ||
      !['PENDING', 'WAITING_ACK'].includes(job.state) ||
      (job.nextRetryAt ?? 0) > Date.now()
    )
      return;
    if (job.state === 'WAITING_ACK') {
      const item = await ctx.db
        .query('federationOutbox')
        .withIndex('messageId', (q) => q.eq('messageId', job.pendingMessageId!))
        .unique();
      if (!item?.ackedAt || item.lastError) {
        await ctx.db.patch(job._id, {
          nextRetryAt: Date.now() + 10_000,
          lastError: item ? item.lastError : 'TRANSCRIPT_OUTBOX_MISSING',
        });
        return;
      }
      await ctx.db.patch(job._id, {
        state: job.pendingFinalPage ? 'DELIVERED' : 'PENDING',
        pendingMessageId: undefined,
        pendingFinalPage: undefined,
        nextRetryAt: 0,
      });
      return;
    }
    let messages = (job.pendingMessages ?? []) as TranscriptMessage[];
    let cursor = job.cursor;
    let pageReadDone = job.pageReadDone ?? false;
    if (!messages.length && !pageReadDone) {
      const page = await ctx.db
        .query('messages')
        .withIndex('conversationId', (q) =>
          q.eq('worldId', job.worldId).eq('conversationId', job.conversationId as any),
        )
        .order('asc')
        .paginate({ cursor: job.cursor ?? null, numItems: TRANSCRIPT_PAGE_MESSAGES });
      messages = page.page.map((message) => ({
        messageId: message.messageUuid,
        text: message.text,
        author: message.author,
        occurredAt: message._creationTime,
      }));
      cursor = page.continueCursor;
      pageReadDone = page.isDone;
    }
    const progress = { cursor, pendingMessages: messages, pageReadDone };
    if (bytes(payload(job, [], false)) >= TRANSCRIPT_PAYLOAD_BYTES) {
      await retryLater(ctx, job, 'TRANSCRIPT_METADATA_TOO_LARGE', progress);
      return;
    }
    let count = 0;
    for (let candidate = 1; candidate <= messages.length; candidate++) {
      const part = payload(
        job,
        messages.slice(0, candidate),
        pageReadDone && candidate === messages.length,
      );
      if (bytes(part) >= TRANSCRIPT_PAYLOAD_BYTES) break;
      count = candidate;
    }
    if (messages.length && !count) {
      await retryLater(ctx, job, 'TRANSCRIPT_MESSAGE_TOO_LARGE', progress);
      return;
    }
    const finalPage = pageReadDone && count === messages.length;
    const body = payload(job, messages.slice(0, count), finalPage);
    const ledger = await visit(ctx, job.visitId);
    if (!ledger || ledger.role !== 'host') {
      await retryLater(ctx, job, 'TRANSCRIPT_VISIT_MISSING', progress);
      return;
    }
    let messageId: string;
    try {
      messageId = await enqueueMessage(ctx, {
        peerTownId: ledger.homeTownId,
        type: 'CONVERSATION_ENDED',
        visitId: job.visitId,
        // Each immutable page has its own stream, so journal cleanup cannot
        // create an artificial sequence gap during a much later catch-up.
        streamId: `history:${await digest([job.transcriptId, job.pageNumber])}`,
        payload: body,
      });
    } catch (error) {
      // These refusals happen before enqueue mutates any cursor/Outbox. Unexpected
      // transaction failures roll back this flush and leave the durable job retryable.
      if (
        !(error instanceof Error) ||
        !['OUTBOX_CAPACITY_EXCEEDED', 'PEER_NOT_TRUSTED'].includes(error.message)
      )
        throw error;
      await retryLater(ctx, job, error.message, progress);
      return;
    }
    await ctx.db.patch(job._id, {
      cursor,
      pendingMessages: messages.slice(count),
      pageReadDone,
      pageNumber: job.pageNumber + 1,
      state: 'WAITING_ACK',
      pendingMessageId: messageId,
      pendingFinalPage: finalPage,
      lastError: undefined,
      attempts: 0,
      nextRetryAt: 0,
    });
  },
});

/** Separate mutations use one database pagination query each and cannot starve other jobs. */
export const flushPending = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const state of ['PENDING', 'WAITING_ACK']) {
      const jobs = await ctx.db
        .query('federationTranscriptJobs')
        .withIndex('retry', (q) => q.eq('state', state).lte('nextRetryAt', Date.now()))
        .take(10);
      for (const job of jobs)
        await ctx.scheduler.runAfter(0, mutationRef('transcripts/flushJob'), { jobId: job._id });
    }
  },
});
