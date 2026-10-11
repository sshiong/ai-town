import { v } from 'convex/values';
import { action, internalMutation, internalQuery } from '../maintenanceFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import {
  archiveFor,
  captureSource,
  load,
  ownerArgs,
  source,
  type Manifest,
  type Payload,
  type OwnerArgs,
} from './coldHistory';
import { digest, requireAdmin, verifySignature } from './security';
import { queryRef, mutationRef } from './refs';
import { validateColdPart, type PortableColdPart } from './coldHistoryChunkFormat';
import { EMPTY_COLD_CHAIN } from './coldHistoryChunkFormat';

export type PortableHistoryV1 = {
  format: 'ai-town-cold-history-file';
  version: 1;
  manifest: Manifest;
  publicKey: string;
  signature: string;
  payload: Payload;
};
export type PortableHistory = PortableHistoryV1 | PortableColdPart;
export const fileStorageDescriptor = (file: PortableHistory) =>
  file.version === 2 ? file.descriptor : file.manifest;
type Alias = { sourceAuthor: string; targetAuthor: string };
const alias = v.object({ sourceAuthor: v.string(), targetAuthor: v.string() });
const fileArgs = {
  ...ownerArgs,
  fileJson: v.string(),
  expectedFingerprint: v.string(),
  authorAliases: v.array(alias),
};
const MAX_FILE_BYTES = 2_000_000;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((k) => keys.includes(k))
  );
}
/** Portable files never execute URLs/scripts or grant federation trust. */
export async function validateFile(
  fileJson: string,
  expectedFingerprint: string,
): Promise<PortableHistory> {
  if (new TextEncoder().encode(fileJson).length > MAX_FILE_BYTES)
    throw new Error('COLD_FILE_SIZE_LIMIT');
  const file: PortableHistory = JSON.parse(fileJson);
  if (file.version === 2) return validateColdPart(file as PortableColdPart, expectedFingerprint);
  if (
    !exactKeys(file, ['format', 'version', 'manifest', 'publicKey', 'signature', 'payload']) ||
    file.format !== 'ai-town-cold-history-file' ||
    file.version !== 1 ||
    typeof file.publicKey !== 'string' ||
    typeof file.signature !== 'string' ||
    !exactKeys(file.manifest, [
      'format',
      'version',
      'schemaVersion',
      'sourceTownId',
      'sourceKey',
      'kind',
      'sourceId',
      'exportedAt',
      'count',
      'bytes',
      'digest',
    ]) ||
    !exactKeys(file.payload, ['format', 'version', 'sourceKey', 'messages'])
  )
    throw new Error('UNSUPPORTED_COLD_FILE');
  const m = file.manifest,
    p = file.payload;
  if (
    m.format !== 'ai-town-cold-history' ||
    m.version !== 1 ||
    m.schemaVersion !== 1 ||
    p.format !== m.format ||
    p.version !== 1 ||
    !['conversation', 'travel'].includes(m.kind) ||
    typeof m.sourceTownId !== 'string' ||
    !m.sourceTownId ||
    typeof m.sourceId !== 'string' ||
    !m.sourceId ||
    typeof m.sourceKey !== 'string' ||
    m.sourceKey.length > 2000 ||
    p.sourceKey !== m.sourceKey ||
    !Number.isFinite(m.exportedAt) ||
    !Number.isSafeInteger(m.count) ||
    m.count < 1 ||
    m.count > 1000 ||
    !Number.isSafeInteger(m.bytes) ||
    m.bytes < 1 ||
    m.bytes > 900000 ||
    !Array.isArray(p.messages) ||
    p.messages.length !== m.count ||
    bytes(p) !== m.bytes
  )
    throw new Error('COLD_FILE_MANIFEST_INVALID');
  const key: unknown = JSON.parse(m.sourceKey);
  if (
    !Array.isArray(key) ||
    key[0] !== m.kind ||
    typeof key[1] !== 'string' ||
    (m.kind === 'conversation' && (![3, 5].includes(key.length) || key[2] !== m.sourceId)) ||
    (m.kind === 'travel' &&
      (![4, 6].includes(key.length) || typeof key[2] !== 'string' || key[3] !== m.sourceId))
  )
    throw new Error('COLD_FILE_SOURCE_SCOPE_INVALID');
  const ids = new Set<string>();
  for (const message of p.messages) {
    if (
      !exactKeys(message, [
        'messageId',
        'text',
        'authorPlayerId',
        'authorGlobalId',
        'occurredAt',
      ]) ||
      typeof message.messageId !== 'string' ||
      !message.messageId ||
      message.messageId.length > 500 ||
      ids.has(message.messageId) ||
      typeof message.text !== 'string' ||
      !Number.isFinite(message.occurredAt) ||
      message.occurredAt < 0 ||
      (m.kind === 'conversation' &&
        (typeof message.authorPlayerId !== 'string' ||
          !/^p:\d+$/.test(message.authorPlayerId) ||
          message.authorGlobalId !== undefined)) ||
      (m.kind === 'travel' &&
        (typeof message.authorGlobalId !== 'string' ||
          !message.authorGlobalId ||
          message.authorGlobalId.length > 1000 ||
          message.authorPlayerId !== undefined))
    )
      throw new Error('COLD_FILE_MESSAGE_INVALID');
    ids.add(message.messageId);
  }
  if (expectedFingerprint !== `sha256:${await digest(file.publicKey)}`)
    throw new Error('COLD_FILE_INDEPENDENT_FINGERPRINT_REQUIRED');
  if ((await digest(p)) !== m.digest || !(await verifySignature(m, file.signature, file.publicKey)))
    throw new Error('COLD_FILE_INTEGRITY_FAILED');
  return file;
}
export async function plan(
  ctx: QueryCtx,
  args: OwnerArgs,
  file: PortableHistory,
  authorAliases: Alias[],
) {
  const target = file.version === 2
    ? await capturePartSource(ctx, args, file)
    : await captureSource(ctx, args, true);
  if (target.source.kind !== file.manifest.kind) throw new Error('COLD_FILE_TARGET_KIND_MISMATCH');
  if (authorAliases.length > 100) throw new Error('COLD_FILE_AUTHOR_MAPPING_INVALID');
  const actor = (m: Payload['messages'][number]) => m.authorGlobalId ?? m.authorPlayerId!;
  const from = new Set(file.payload.messages.map(actor)),
    to = new Set(target.messages.map(actor)),
    mapping = new Map<string, string>();
  if (file.manifest.kind === 'travel') {
    from.add(JSON.parse(file.manifest.sourceKey)[2]);
    if (args.agentGlobalId) to.add(args.agentGlobalId);
  }
  for (const a of authorAliases) {
    if (
      (file.version === 1 && (!from.has(a.sourceAuthor) || !to.has(a.targetAuthor))) ||
      mapping.has(a.sourceAuthor) ||
      [...mapping.values()].includes(a.targetAuthor)
    )
      throw new Error('COLD_FILE_AUTHOR_MAPPING_INVALID');
    mapping.set(a.sourceAuthor, a.targetAuthor);
  }
  if (file.manifest.kind === 'travel') {
    const originalOwner = JSON.parse(file.manifest.sourceKey)[2];
    if ((mapping.get(originalOwner) ?? originalOwner) !== args.agentGlobalId)
      throw new Error('COLD_FILE_OWNER_MAPPING_REQUIRED');
  }
  const normalized = (messages: Payload['messages'], mapped: boolean) =>
    messages
      .map((m) => ({
        messageId: m.messageId,
        text: m.text,
        author: mapped ? (mapping.get(actor(m)) ?? actor(m)) : actor(m),
      }))
      .sort((a, b) => a.messageId.localeCompare(b.messageId));
  if (
    (await digest(normalized(file.payload.messages, true))) !==
    (await digest(normalized(target.messages, false)))
  )
    throw new Error('COLD_FILE_TARGET_MESSAGES_MISMATCH');
  const sortedAliases = [...authorAliases].sort((a, b) =>
    a.sourceAuthor.localeCompare(b.sourceAuthor),
  );
  const confirmation = await digest({
    targetOwner: {
      worldId: args.worldId,
      playerId: args.playerId,
      agentGlobalId: args.agentGlobalId,
      memoryId: args.memoryId,
    },
    sourceKey: target.source.sourceKey,
    messages: target.messages,
    fileDigest: file.manifest.digest,
    sourceFingerprint: `sha256:${await digest(file.publicKey)}`,
    authorAliases: sortedAliases,
  });
  if (
    target.existing?.state === 'VERIFIED' &&
    (target.existing.manifest.digest !== file.manifest.digest ||
      (file.version === 2 && (await digest(target.existing.manifest) !== await digest(file.manifest) ||
        target.existing.publicKey !== file.publicKey || target.existing.signature !== file.signature ||
        sortedAliases.some(a => !(target.existing!.authorAliases ?? []).some(existing =>
          existing.sourceAuthor === a.sourceAuthor && existing.targetAuthor === a.targetAuthor)))))
  )
    throw new Error('COLD_FILE_TARGET_ALREADY_ARCHIVED');
  return { ...target, confirmation, sortedAliases };
}
/** A portable part binds exact UUIDs. Restored native insertion order and times
 * are allowed to differ; travel pages retain their source page numbers. */
export async function capturePartSource(ctx: QueryCtx, args: OwnerArgs, file: PortableColdPart) {
  const s = await source(ctx, args), existing = await archiveFor(ctx, s.sourceKey);
  if (s.kind !== file.manifest.kind) throw new Error('COLD_FILE_TARGET_KIND_MISMATCH');
  let messages: Payload['messages'];
  if (s.kind === 'conversation') {
    messages = [];
    for (const original of file.payload.messages) {
      const rows = await ctx.db.query('messages').withIndex('messageUuid', q =>
        q.eq('conversationId', s.sourceId as `c:${number}`).eq('messageUuid', original.messageId))
        .filter(q => q.eq(q.field('worldId'), args.worldId)).take(2);
      if (rows.length !== 1) throw new Error('COLD_FILE_TARGET_MESSAGES_MISMATCH');
      const r = rows[0]; messages.push({ messageId: r.messageUuid, text: r.text, authorPlayerId: r.author, occurredAt: r._creationTime });
    }
  } else {
    const page = await ctx.db.query('homeTravelTranscriptPages').withIndex('owner_transcript_page', q =>
      q.eq('agentGlobalId', args.agentGlobalId!).eq('transcriptId', s.sourceId).eq('pageNumber', file.payload.sourcePageNumber!)).unique();
    if (!page) throw new Error('COLD_FILE_TARGET_MESSAGES_MISMATCH');
    messages = file.payload.messages.map(original => {
      const matches = page.messages.filter(m => m.messageId === original.messageId);
      if (matches.length !== 1) throw new Error('COLD_FILE_TARGET_MESSAGES_MISMATCH');
      const r = matches[0]; return { messageId: r.messageId, text: r.text, authorGlobalId: r.author, occurredAt: r.occurredAt };
    });
  }
  return { source: s, existing, messages };
}
export const preflightData = internalQuery({
  args: fileArgs,
  handler: async (ctx, args) => {
    const file = await validateFile(args.fileJson, args.expectedFingerprint),
      p = await plan(ctx, args, file, args.authorAliases);
    return {
      confirmation: p.confirmation,
      messages: file.manifest.count,
      bytes: file.manifest.bytes,
      sourceTownId: file.manifest.sourceTownId,
      sourceFingerprint: args.expectedFingerprint,
      sourceId: file.manifest.sourceId,
      targetSourceId: p.source.sourceId,
      targetMemoryId: args.memoryId,
      authorAliases: p.sortedAliases,
      originalTimesRetained: true as const,
      changesFederationTrust: false as const,
    };
  },
});
export const preflight = action({
  args: fileArgs,
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    return ctx.runQuery(queryRef('coldHistoryFiles/preflightData'), args);
  },
});
export async function adoptHistoryFile(
  ctx: MutationCtx,
  args: OwnerArgs & {
    fileJson: string;
    expectedFingerprint: string;
    authorAliases: Alias[];
    storageId: Id<'_storage'>;
    confirmation: string;
  },
) {
  const file = await validateFile(args.fileJson, args.expectedFingerprint),
    p = await plan(ctx, args, file, args.authorAliases);
  if (args.confirmation !== p.confirmation)
    throw new Error('COLD_FILE_TARGET_CHANGED_REVIEW_AGAIN');
  if (p.existing?.state === 'VERIFIED')
    return { archiveId: p.existing._id, storageId: p.existing.storageId };
  if (file.version === 2) return adoptHistoryPart(ctx, args, file, p);
  const fields = {
    sourceKey: file.manifest.sourceKey,
    lookupKey: p.source.sourceKey,
    sourceId: file.manifest.sourceId,
    worldId: args.worldId,
    kind: file.manifest.kind,
    ownerGlobalId: p.source.ownerGlobalId,
    state: 'VERIFIED' as const,
    manifest: file.manifest,
    signature: file.signature,
    publicKey: file.publicKey,
    storageId: args.storageId,
    createdAt: p.existing?.createdAt ?? Date.now(),
    verifiedAt: Date.now(),
    importedAt: Date.now(),
    authorAliases: p.sortedAliases,
  };
  const archiveId = p.existing
    ? p.existing._id
    : await ctx.db.insert('coldHistoryArchives', fields);
  if (p.existing) await ctx.db.replace(archiveId, fields);
  return { archiveId, storageId: args.storageId };
}
export async function adoptHistoryPart(
  ctx: MutationCtx,
  args: OwnerArgs & { storageId: Id<'_storage'>; authorAliases: Alias[] },
  file: PortableColdPart,
  p: Awaited<ReturnType<typeof plan>>,
) {
  const m = file.manifest, d = file.descriptor;
  if (p.existing?.jobId) throw new Error('COLD_HISTORY_JOB_IN_PROGRESS');
  if (p.existing && ((await digest(p.existing.manifest)) !== (await digest(m)) ||
      p.existing.publicKey !== file.publicKey || p.existing.signature !== file.signature))
    throw new Error('COLD_FILE_TARGET_ALREADY_ARCHIVED');
  const fields = { sourceKey: m.sourceKey, lookupKey: p.source.sourceKey, sourceId: m.sourceId,
    worldId: args.worldId, kind: m.kind, ownerGlobalId: p.source.ownerGlobalId, state: 'PENDING' as const,
    manifest: m, signature: file.signature, publicKey: file.publicKey,
    createdAt: p.existing?.createdAt ?? Date.now(), importedAt: Date.now(), authorAliases: p.sortedAliases };
  const archiveId = p.existing?._id ?? await ctx.db.insert('coldHistoryArchives', fields);
  const mappings = new Map((p.existing?.authorAliases ?? []).map(a => [a.sourceAuthor, a.targetAuthor]));
  for (const alias of p.sortedAliases) {
    if ((mappings.has(alias.sourceAuthor) && mappings.get(alias.sourceAuthor) !== alias.targetAuthor) ||
        [...mappings.entries()].some(([source, target]) => source !== alias.sourceAuthor && target === alias.targetAuthor))
      throw new Error('COLD_FILE_AUTHOR_MAPPING_INVALID');
    mappings.set(alias.sourceAuthor, alias.targetAuthor);
  }
  const mergedAliases = [...mappings].map(([sourceAuthor, targetAuthor]) => ({ sourceAuthor, targetAuthor }))
    .sort((a, b) => a.sourceAuthor.localeCompare(b.sourceAuthor));
  if (mergedAliases.length > 100) throw new Error('COLD_FILE_AUTHOR_MAPPING_INVALID');
  await ctx.db.patch(archiveId, { authorAliases: mergedAliases });
  const existing = await ctx.db.query('coldHistoryChunks').withIndex('archive_index', q => q.eq('archiveId', archiveId).eq('index', d.index)).unique();
  if (existing) {
    if (existing.digest !== d.digest || existing.chainDigest !== d.chainDigest) throw new Error('COLD_HISTORY_CHUNK_CONFLICT');
    return { archiveId, storageId: existing.storageId };
  }
  const previous = d.index ? await ctx.db.query('coldHistoryChunks').withIndex('archive_index', q => q.eq('archiveId', archiveId).eq('index', d.index - 1)).unique() : null;
  if (d.start !== (previous ? previous.start + previous.count : 0) || d.previousDigest !== (previous?.chainDigest ?? EMPTY_COLD_CHAIN) ||
      (d.index > 0 && !previous)) throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
  const cumulativeBytes = (previous?.cumulativeBytes ?? 0) + d.bytes;
  await ctx.db.insert('coldHistoryChunks', { archiveId, ...d, signature: file.chunkSignature, storageId: args.storageId, cumulativeBytes });
  if (d.index + 1 === m.chunkCount) {
    if (d.start + d.count !== m.count || cumulativeBytes !== m.bytes || d.chainDigest !== m.digest)
      throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
    await ctx.db.patch(archiveId, { state: 'VERIFIED', verifiedAt: Date.now() });
  }
  return { archiveId, storageId: args.storageId };
}
export const adopt = internalMutation({
  args: { ...fileArgs, storageId: v.id('_storage'), confirmation: v.string() },
  handler: adoptHistoryFile,
});
export const referenced = internalQuery({
  args: { ...ownerArgs, storageId: v.id('_storage') },
  handler: async (ctx, args) => {
    const s = await source(ctx, args),
      row = await archiveFor(ctx, s.sourceKey);
    if (row?.storageId === args.storageId) return true;
    return !!(await ctx.db.query('coldHistoryChunks').withIndex('storage', q => q.eq('storageId', args.storageId)).first());
  },
});
export const importFile = action({
  args: { ...fileArgs, confirmation: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const file = await validateFile(args.fileJson, args.expectedFingerprint);
    if (file.version === 2) throw new Error('COLD_HISTORY_USE_PART_IMPORT');
    const { confirmation, ...preflightArgs } = args;
    const checked: { confirmation: string } = await ctx.runQuery(
      queryRef('coldHistoryFiles/preflightData'),
      preflightArgs,
    );
    if (checked.confirmation !== confirmation)
      throw new Error('COLD_FILE_TARGET_CHANGED_REVIEW_AGAIN');
    const storageId = await ctx.storage.store(
      new Blob([JSON.stringify(file.payload)], { type: 'application/json' }),
    );
    let retained = false, publicationStarted = false, acknowledged = false;
    try {
      const object = await ctx.storage.get(storageId);
      if (!object) throw new Error('COLD_HISTORY_STORAGE_MISSING');
      if (
        object.size !== file.manifest.bytes ||
        (await digest(JSON.parse(await object.text()))) !== file.manifest.digest
      )
        throw new Error('COLD_FILE_INTEGRITY_FAILED');
      publicationStarted = true;
      const result: { archiveId: Id<'coldHistoryArchives'>; storageId?: Id<'_storage'> } =
        await ctx.runMutation(mutationRef('coldHistoryFiles/adopt'), { ...args, storageId });
      acknowledged = true;
      retained = result.storageId === storageId;
      return { archiveId: result.archiveId, state: 'VERIFIED' as const };
    } finally {
      if (!retained && (!publicationStarted || acknowledged)) {
        let safeToDelete = false;
        try {
          safeToDelete = !(await ctx.runQuery(queryRef('coldHistoryFiles/referenced'), {
            adminToken: args.adminToken,
            worldId: args.worldId,
            playerId: args.playerId,
            agentGlobalId: args.agentGlobalId,
            memoryId: args.memoryId,
            storageId,
          }));
        } catch {
          /* Keep an unconfirmed file after a lost publication response. */
        }
        if (safeToDelete) await ctx.storage.delete(storageId);
      }
    }
  },
});
export const exportFile = action({
  args: ownerArgs,
  handler: async (ctx, args): Promise<PortableHistory> => {
    requireAdmin(args.adminToken);
    const archive: Doc<'coldHistoryArchives'> = await ctx.runQuery(
      queryRef('coldHistory/readData'),
      args,
    );
    const payload = await load(ctx, archive);
    return {
      format: 'ai-town-cold-history-file',
      version: 1,
      manifest: archive.manifest,
      publicKey: archive.publicKey,
      signature: archive.signature,
      payload,
    };
  },
});
