import { v } from 'convex/values';
import { action, internalQuery, internalMutation, query } from '../maintenanceFunctions';
import type { QueryCtx, ActionCtx } from '../_generated/server';
import type { Id, Doc } from '../_generated/dataModel';
import { owns, requireOwner } from '../agent/social';
import { identity } from './store';
import { digest, requireAdmin, sign, verifySignature } from './security';
import { queryRef, mutationRef } from './refs';
import { loadChunkPayload } from './coldHistoryChunks';
import { coldBytes, validateChunkRoot, type ChunkManifest } from './coldHistoryChunkFormat';

import { ownerArgs, type OwnerArgs } from './coldHistoryOwner';
export { ownerArgs, type OwnerArgs } from './coldHistoryOwner';
const MAX_BYTES = 900_000;
const MAX_RECORDS = 1000;
type RawMessage = {
  messageId: string;
  text: string;
  authorPlayerId?: string;
  authorGlobalId?: string;
  occurredAt: number;
};
export type Payload = {
  format: 'ai-town-cold-history';
  version: 1;
  sourceKey: string;
  messages: RawMessage[];
};
export type Manifest = {
  format: 'ai-town-cold-history';
  version: 1;
  schemaVersion: 1;
  sourceTownId: string;
  sourceKey: string;
  kind: 'conversation' | 'travel';
  sourceId: string;
  exportedAt: number;
  count: number;
  bytes: number;
  digest: string;
};
export async function source(ctx: QueryCtx, args: OwnerArgs) {
  await requireOwner(ctx, args);
  const memory = await ctx.db.get(args.memoryId);
  if (!memory || !owns(memory, args)) throw new Error('COLD_HISTORY_OWNER_MISMATCH');
  if (memory.data.type === 'conversation') {
    const conversationId = memory.data.conversationId;
    const archived = await ctx.db
      .query('archivedConversations')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('id', conversationId))
      .unique();
    if (!archived?.participants.includes(args.playerId))
      throw new Error('COLD_HISTORY_NOT_COMPLETED');
    return {
      kind: 'conversation' as const,
      sourceId: memory.data.conversationId,
      sourceKey: JSON.stringify([
        'conversation',
        args.worldId,
        conversationId,
        archived.created,
        archived.ended,
      ]),
      ownerGlobalId: undefined,
      expectedCount: archived.numMessages,
    };
  }
  if (memory.data.type === 'travel' && memory.data.federationConversationId && args.agentGlobalId) {
    const sourceId =
      memory.data.transcriptId ?? `${memory.data.federationConversationId}/${memory.data.visitId}`;
    const transcript = await ctx.db
      .query('homeTravelTranscripts')
      .withIndex('owner_transcript', (q) =>
        q.eq('agentGlobalId', args.agentGlobalId!).eq('transcriptId', sourceId),
      )
      .unique();
    if (
      !transcript ||
      transcript.worldId !== args.worldId ||
      transcript.playerId !== args.playerId ||
      transcript.visitId !== memory.data.visitId ||
      transcript.hostTownId !== memory.data.hostTownId ||
      transcript.federationConversationId !== memory.data.federationConversationId
    )
      throw new Error('COLD_HISTORY_TRANSCRIPT_OWNER_MISMATCH');
    if (transcript.state !== 'COMPLETE' || transcript.summaryState !== 'DONE')
      throw new Error('COLD_HISTORY_NOT_COMPLETED');
    return {
      kind: 'travel' as const,
      sourceId,
      sourceKey: JSON.stringify([
        'travel',
        args.worldId,
        args.agentGlobalId,
        sourceId,
        transcript.hostTownId,
        transcript.endedAt,
      ]),
      ownerGlobalId: args.agentGlobalId,
      expectedCount: transcript.totalMessageCount,
      expectedPageCount: (transcript.finalPageNumber ?? -1) + 1,
    };
  }
  throw new Error('COLD_HISTORY_NO_SOURCE');
}
export async function archiveFor(ctx: QueryCtx, sourceKey: string) {
  const mapped = await ctx.db
    .query('coldHistoryArchives')
    .withIndex('lookup', (q) => q.eq('lookupKey', sourceKey))
    .unique();
  if (mapped) return mapped;
  return ctx.db
    .query('coldHistoryArchives')
    .withIndex('source', (q) => q.eq('sourceKey', sourceKey))
    .filter((q) => q.eq(q.field('lookupKey'), undefined))
    .unique();
}
export const discover = query({
  args: ownerArgs,
  handler: async (ctx, args) => {
    let s: Awaited<ReturnType<typeof source>>;
    try {
      s = await source(ctx, args);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      if (
        [
          'COLD_HISTORY_NO_SOURCE',
          'COLD_HISTORY_NOT_COMPLETED',
          'COLD_HISTORY_TRANSCRIPT_OWNER_MISMATCH',
        ].includes(reason)
      )
        return { state: 'UNAVAILABLE' as const, reason };
      throw error;
    }
    const archive = await archiveFor(ctx, s.sourceKey);
    return archive
      ? {
          archiveId: archive._id,
          state: archive.state,
          verifiedAt: archive.verifiedAt,
          count: (archive.manifest as Manifest).count,
          bytes: (archive.manifest as Manifest).bytes,
          version: archive.manifest.version as 1 | 2,
          chunkCount: archive.manifest.chunkCount as number | undefined,
          jobId: archive.jobId,
          location: 'PRIVATE_FILE_STORAGE' as const,
          hotRecordsRetained: true as const,
        }
      : null;
  },
});
export async function captureSource(ctx: QueryCtx, args: OwnerArgs, readHot = false) {
  const s = await source(ctx, args),
    existing = await archiveFor(ctx, s.sourceKey);
  if (existing?.state === 'VERIFIED' && !readHot)
    return { existing, source: s, messages: [] as RawMessage[] };
  let messages: RawMessage[];
  if (s.kind === 'conversation') {
    const rows = await ctx.db
      .query('messages')
      .withIndex('conversationId', (q) =>
        q.eq('worldId', args.worldId).eq('conversationId', s.sourceId as `c:${number}`),
      )
      .order('asc')
      .take(MAX_RECORDS + 1);
    if (rows.length > MAX_RECORDS) throw new Error('COLD_HISTORY_REQUIRES_CHUNKED_ARCHIVE');
    messages = rows.map((r) => ({
      messageId: r.messageUuid,
      text: r.text,
      authorPlayerId: r.author,
      occurredAt: r._creationTime,
    }));
  } else {
    const transcript = await ctx.db
      .query('homeTravelTranscripts')
      .withIndex('owner_transcript', (q) =>
        q.eq('agentGlobalId', args.agentGlobalId!).eq('transcriptId', s.sourceId),
      )
      .unique();
    const rows = await ctx.db
      .query('homeTravelTranscriptPages')
      .withIndex('owner_transcript_page', (q) =>
        q.eq('agentGlobalId', args.agentGlobalId!).eq('transcriptId', s.sourceId),
      )
      .take(1001);
    if (
      !transcript ||
      rows.length > 1000 ||
      rows.length !== (transcript.finalPageNumber ?? -1) + 1 ||
      rows.some((r, i) => r.pageNumber !== i || r.finalPage !== (i === rows.length - 1))
    )
      throw new Error('COLD_HISTORY_INCOMPLETE_PAGES');
    messages = rows.flatMap((r) =>
      r.messages.map((m) => ({
        messageId: m.messageId,
        text: m.text,
        authorGlobalId: m.author,
        occurredAt: m.occurredAt,
      })),
    );
    if (messages.length > MAX_RECORDS) throw new Error('COLD_HISTORY_REQUIRES_CHUNKED_ARCHIVE');
  }
  if (!messages.length || new Set(messages.map((m) => m.messageId)).size !== messages.length)
    throw new Error('COLD_HISTORY_EMPTY_OR_DUPLICATE_MESSAGES');
  // Native text is persisted before its finish-sending engine input. That Tick
  // counter can lag retained rows after closure; never truncate these originals.
  if (
    (s.kind === 'travel' && messages.length !== s.expectedCount) ||
    (s.kind === 'conversation' && messages.length < s.expectedCount)
  )
    throw new Error('COLD_HISTORY_INCOMPLETE_MESSAGES');
  return { existing, source: s, messages };
}
export const capture = internalQuery({ args: ownerArgs, handler: captureSource });
export const reserve = internalMutation({
  args: { ...ownerArgs, manifest: v.any() },
  handler: async (ctx, args) => {
    const s = await source(ctx, args),
      existing = await archiveFor(ctx, s.sourceKey);
    if (existing?.state === 'VERIFIED') {
      if (existing.manifest.digest !== args.manifest.digest)
        throw new Error('COLD_HISTORY_SOURCE_CHANGED');
      return existing;
    }
    const local = await identity(ctx);
    if (!local) throw new Error('INITIALIZE_IDENTITY_FIRST');
    if (args.manifest.sourceKey !== s.sourceKey || args.manifest.sourceTownId !== local.townId)
      throw new Error('COLD_HISTORY_MANIFEST_SCOPE');
    if (existing) {
      if (existing.manifest.digest === args.manifest.digest) return existing;
      // Only unpublished snapshots can be refreshed after a correction; a signed
      // verified archive remains immutable historical evidence.
      await ctx.db.patch(existing._id, {
        manifest: args.manifest,
        signature: await sign(args.manifest, local.privateKeyEncrypted),
        publicKey: local.publicKey,
      });
      return (await ctx.db.get(existing._id))!;
    }
    const id = await ctx.db.insert('coldHistoryArchives', {
      sourceKey: s.sourceKey,
      lookupKey: s.sourceKey,
      sourceId: s.sourceId,
      kind: s.kind,
      ownerGlobalId: s.ownerGlobalId,
      worldId: args.worldId,
      state: 'PENDING',
      manifest: args.manifest,
      signature: await sign(args.manifest, local.privateKeyEncrypted),
      publicKey: local.publicKey,
      createdAt: Date.now(),
    });
    return (await ctx.db.get(id))!;
  },
});
export const publish = internalMutation({
  args: {
    ...ownerArgs,
    archiveId: v.id('coldHistoryArchives'),
    storageId: v.id('_storage'),
    contentDigest: v.string(),
  },
  handler: async (ctx, args) => {
    const s = await source(ctx, args),
      archive = await ctx.db.get(args.archiveId);
    if (
      !archive ||
      archive.sourceKey !== s.sourceKey ||
      archive.manifest.digest !== args.contentDigest
    )
      throw new Error('COLD_HISTORY_PUBLICATION_MISMATCH');
    if (archive.state === 'VERIFIED') return archive.storageId;
    const current = await captureSource(ctx, args);
    const payload: Payload = {
      format: 'ai-town-cold-history',
      version: 1,
      sourceKey: s.sourceKey,
      messages: current.messages,
    };
    if ((await digest(payload)) !== args.contentDigest)
      throw new Error('COLD_HISTORY_SOURCE_CHANGED');
    await ctx.db.patch(archive._id, {
      state: 'VERIFIED',
      storageId: args.storageId,
      verifiedAt: Date.now(),
    });
    return args.storageId;
  },
});
export async function load(ctx: ActionCtx, archive: Doc<'coldHistoryArchives'>): Promise<Payload> {
  if (archive.manifest.version === 2) throw new Error('COLD_HISTORY_USE_PART_EXPORT');
  if (!archive.storageId) throw new Error('COLD_HISTORY_NOT_VERIFIED');
  const blob = await ctx.storage.get(archive.storageId);
  if (!blob) throw new Error('COLD_HISTORY_STORAGE_MISSING');
  const manifest = archive.manifest as Manifest;
  if (blob.size !== manifest.bytes || blob.size > MAX_BYTES)
    throw new Error('COLD_HISTORY_BYTES_MISMATCH');
  const payload: Payload = JSON.parse(await blob.text());
  if (
    payload.format !== 'ai-town-cold-history' ||
    payload.version !== 1 ||
    payload.sourceKey !== archive.sourceKey ||
    !Array.isArray(payload.messages) ||
    payload.messages.length !== manifest.count ||
    manifest.count > MAX_RECORDS ||
    manifest.sourceKey !== archive.sourceKey ||
    manifest.kind !== archive.kind ||
    manifest.sourceId !== archive.sourceId ||
    (await digest(payload)) !== manifest.digest ||
    !(await verifySignature(manifest, archive.signature, archive.publicKey))
  )
    throw new Error('COLD_HISTORY_INTEGRITY_FAILED');
  return payload;
}
export const signingTown = internalQuery({
  args: {},
  handler: async (ctx) => {
    const local = await identity(ctx);
    if (!local) throw new Error('INITIALIZE_IDENTITY_FIRST');
    return local.townId;
  },
});
export const archive = action({
  args: ownerArgs,
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    let captured: {
      existing: Doc<'coldHistoryArchives'> | null;
      source: Awaited<ReturnType<typeof source>>;
      messages: RawMessage[];
    };
    try {
      captured = await ctx.runQuery(queryRef('coldHistory/capture'), args);
    } catch (error) {
      if (!String(error).includes('COLD_HISTORY_REQUIRES_CHUNKED_ARCHIVE')) throw error;
      return ctx.runMutation(mutationRef('coldHistoryChunks/start'), args);
    }
    if (captured.existing?.state === 'VERIFIED') {
      if (captured.existing.manifest.version === 2) {
        await validateChunkRoot(captured.existing.manifest, captured.existing.signature, captured.existing.publicKey);
      } else await load(ctx, captured.existing);
      return {
        archiveId: captured.existing._id,
        state: 'VERIFIED' as const,
        count: captured.existing.manifest.count,
      };
    }
    const payload: Payload = {
      format: 'ai-town-cold-history',
      version: 1,
      sourceKey: captured.source.sourceKey,
      messages: captured.messages,
    };
    const text = JSON.stringify(payload),
      bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_BYTES) return ctx.runMutation(mutationRef('coldHistoryChunks/start'), args);
    const townId: string = await ctx.runQuery(queryRef('coldHistory/signingTown'), {});
    const manifest: Manifest = {
      format: payload.format,
      version: 1,
      schemaVersion: 1,
      sourceTownId: townId,
      sourceKey: payload.sourceKey,
      kind: captured.source.kind,
      sourceId: captured.source.sourceId,
      exportedAt: Date.now(),
      count: captured.messages.length,
      bytes,
      digest: await digest(payload),
    };
    const reservation: Doc<'coldHistoryArchives'> = await ctx.runMutation(
      mutationRef('coldHistory/reserve'),
      { ...args, manifest },
    );
    if (reservation.state === 'VERIFIED') {
      await load(ctx, reservation);
      return { archiveId: reservation._id, state: 'VERIFIED' as const, count: manifest.count };
    }
    const storageId = await ctx.storage.store(new Blob([text], { type: 'application/json' }));
    let committed = false;
    try {
      // Publication follows a real read of the newly written object, not a client-claimed digest.
      await load(ctx, { ...reservation, storageId });
      const actual: Id<'_storage'> = await ctx.runMutation(mutationRef('coldHistory/publish'), {
        ...args,
        archiveId: reservation._id,
        storageId,
        contentDigest: manifest.digest,
      });
      committed = actual === storageId;
      return { archiveId: reservation._id, state: 'VERIFIED' as const, count: manifest.count };
    } finally {
      if (!committed) {
        // A lost mutation response can follow a durable publication. Never delete
        // its object unless a subsequent authoritative query proves it unreferenced.
        let safeToDelete = false;
        try {
          const current: Doc<'coldHistoryArchives'> = await ctx.runQuery(
            queryRef('coldHistory/readData'),
            args,
          );
          safeToDelete = current.storageId !== storageId;
        } catch {
          /* Preserve an unconfirmed object; failure must not destroy history. */
        }
        if (safeToDelete) await ctx.storage.delete(storageId);
      }
    }
  },
});
export const readData = internalQuery({
  args: ownerArgs,
  handler: async (ctx, args) => {
    const s = await source(ctx, args),
      archive = await archiveFor(ctx, s.sourceKey);
    if (!archive || archive.state !== 'VERIFIED') throw new Error('COLD_HISTORY_NOT_VERIFIED');
    return archive;
  },
});
export const read = action({
  args: { ...ownerArgs, offset: v.number(), numItems: v.number() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    if (
      !Number.isSafeInteger(args.offset) ||
      args.offset < 0 ||
      !Number.isSafeInteger(args.numItems) ||
      args.numItems < 1 ||
      args.numItems > 25
    )
      throw new Error('INVALID_COLD_HISTORY_PAGE');
    const { offset, numItems, ...owner } = args;
    const archive: Doc<'coldHistoryArchives'> = await ctx.runQuery(
      queryRef('coldHistory/readData'),
      owner,
    );
    const count = archive.manifest.count;
    if (offset > count) throw new Error('INVALID_COLD_HISTORY_PAGE');
    let messages: RawMessage[];
    if (archive.manifest.version === 2) {
      await validateChunkRoot(archive.manifest as ChunkManifest, archive.signature, archive.publicKey);
      const chunks: Doc<'coldHistoryChunks'>[] = await ctx.runQuery(queryRef('coldHistoryChunks/pageChunks'), {
        archiveId: archive._id, offset, numItems,
      });
      messages = [];
      let position = offset;
      let responseBudgetReached = false;
      for (const chunk of chunks) {
        if (position >= Math.min(count, offset + numItems)) break;
        if (position < chunk.start || position >= chunk.start + chunk.count)
          throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
        const payload = await loadChunkPayload(ctx, archive, chunk, false);
        const selected = payload.messages.slice(position - chunk.start, offset + numItems - chunk.start);
        for (const message of selected) {
          // A message is never truncated. Large originals may make a page
          // shorter than numItems so the RPC stays below Convex's 1 MiB limit.
          if (messages.length && coldBytes([...messages, message]) > 950_000) {
            responseBudgetReached = true;
            break;
          }
          messages.push(message); position++;
        }
        if (responseBudgetReached) break;
      }
      if (!responseBudgetReached && messages.length !== Math.min(numItems, count - offset)) throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
    } else messages = (await load(ctx, archive)).messages.slice(offset, offset + numItems);
    return {
      location: 'PRIVATE_FILE_STORAGE' as const,
      state: 'VERIFIED' as const,
      page: messages.map((message) => {
        const alias = archive.authorAliases?.find(
          (a) => a.sourceAuthor === (message.authorGlobalId ?? message.authorPlayerId),
        );
        return alias ? { ...message, targetAuthor: alias.targetAuthor } : message;
      }),
      isDone: offset + messages.length >= count,
      nextOffset: offset + messages.length,
      sourceTownId: archive.manifest.sourceTownId,
      verifiedAt: archive.verifiedAt,
    };
  },
});
