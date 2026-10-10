import { v } from 'convex/values';
import { action, internalMutation, internalQuery } from '../maintenanceFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
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

export type PortableHistory = {
  format: 'ai-town-cold-history-file';
  version: 1;
  manifest: Manifest;
  publicKey: string;
  signature: string;
  payload: Payload;
};
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
async function plan(ctx: QueryCtx, args: OwnerArgs, file: PortableHistory, authorAliases: Alias[]) {
  const target = await captureSource(ctx, args, true);
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
      !from.has(a.sourceAuthor) ||
      !to.has(a.targetAuthor) ||
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
    messages.map((m) => ({
      messageId: m.messageId,
      text: m.text,
      author: mapped ? (mapping.get(actor(m)) ?? actor(m)) : actor(m),
    }));
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
    target.existing.manifest.digest !== file.manifest.digest
  )
    throw new Error('COLD_FILE_TARGET_ALREADY_ARCHIVED');
  return { ...target, confirmation, sortedAliases };
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
export const adopt = internalMutation({
  args: { ...fileArgs, storageId: v.id('_storage'), confirmation: v.string() },
  handler: async (ctx, args) => {
    const file = await validateFile(args.fileJson, args.expectedFingerprint),
      p = await plan(ctx, args, file, args.authorAliases);
    if (args.confirmation !== p.confirmation)
      throw new Error('COLD_FILE_TARGET_CHANGED_REVIEW_AGAIN');
    if (p.existing?.state === 'VERIFIED')
      return { archiveId: p.existing._id, storageId: p.existing.storageId };
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
  },
});
export const referenced = internalQuery({
  args: { ...ownerArgs, storageId: v.id('_storage') },
  handler: async (ctx, args) => {
    const s = await source(ctx, args),
      row = await archiveFor(ctx, s.sourceKey);
    return row?.storageId === args.storageId;
  },
});
export const importFile = action({
  args: { ...fileArgs, confirmation: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const file = await validateFile(args.fileJson, args.expectedFingerprint);
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
    let retained = false;
    try {
      const object = await ctx.storage.get(storageId);
      if (!object) throw new Error('COLD_HISTORY_STORAGE_MISSING');
      if (
        object.size !== file.manifest.bytes ||
        (await digest(JSON.parse(await object.text()))) !== file.manifest.digest
      )
        throw new Error('COLD_FILE_INTEGRITY_FAILED');
      const result: { archiveId: Id<'coldHistoryArchives'>; storageId?: Id<'_storage'> } =
        await ctx.runMutation(mutationRef('coldHistoryFiles/adopt'), { ...args, storageId });
      retained = result.storageId === storageId;
      return { archiveId: result.archiveId, state: 'VERIFIED' as const };
    } finally {
      if (!retained) {
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
