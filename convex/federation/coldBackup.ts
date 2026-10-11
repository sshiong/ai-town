import { v } from 'convex/values';
import { internalQuery } from '../maintenanceFunctions';
import type { ActionCtx, MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { archiveFor, source, load } from './coldHistory';
import { adoptHistoryFile, plan, validateFile, type PortableHistory } from './coldHistoryFiles';
import { digest, requireAdmin, sign } from './security';
import { identity } from './store';
import { queryRef, actionRef } from './refs';
import { validateColdParts, type PortableColdPart } from './coldHistoryChunkFormat';
import { decodeRow, validateBundle, type BackupBundle, type BackupRow } from './backupHelpers';

export type ColdBackupAttachment = {
  owner: { worldId: string; playerId: string; agentGlobalId?: string; memoryId: string };
  file: PortableHistory;
  authorAliases: { sourceAuthor: string; targetAuthor: string }[];
};
export type PreparedColdFile = { index: number; storageId: Id<'_storage'> };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const actor = (m: PortableHistory['payload']['messages'][number]) =>
  m.authorGlobalId ?? m.authorPlayerId!;
const exactKeys = (x: any, allowed: string[]) =>
  x &&
  typeof x === 'object' &&
  !Array.isArray(x) &&
  Object.keys(x).every((k) => allowed.includes(k));

/** The exporting town signs the original file plus its local owner/alias binding.
 * A foreign historical signer is evidence only; it never becomes a trusted peer. */
export async function validateColdAttachments(
  bundle: BackupBundle,
  rows: Record<string, BackupRow[]>,
  allowPartialParts = false,
) {
  const files = bundle.coldHistoryFiles,
    summary = bundle.manifest.coldHistoryFiles;
  if (files === undefined && summary === undefined) return;
  if (
    !Array.isArray(files) ||
    !summary ||
    !bundle.signature ||
    files.length > 100 ||
    !exactKeys(summary, ['count', 'bytes', 'digest']) ||
    summary.count !== files.length ||
    summary.bytes !== bytes(files) ||
    summary.digest !== (await digest(files))
  )
    throw new Error('BACKUP_COLD_FILES_CHECKSUM_MISMATCH');
  const scopes = new Set<string>();
  const partGroups = new Map<string, PortableColdPart[]>();
  for (const a of files) if (a.file?.version === 2) {
    const group = JSON.stringify([a.owner, a.file.manifest.snapshotId, a.authorAliases]);
    const parts = partGroups.get(group) ?? []; parts.push(a.file); partGroups.set(group, parts);
  }
  if (!allowPartialParts) for (const parts of partGroups.values()) await validateColdParts(parts, `sha256:${await digest(parts[0].publicKey)}`);
  const scopeSnapshots = new Map<string, string>();
  for (const a of files) {
    if (
      !exactKeys(a, ['owner', 'file', 'authorAliases']) ||
      !exactKeys(a.owner, ['worldId', 'playerId', 'agentGlobalId', 'memoryId']) ||
      !Array.isArray(a.authorAliases) ||
      a.authorAliases.length > 100 ||
      [a.owner.worldId, a.owner.playerId, a.owner.memoryId].some(
        (x) => typeof x !== 'string' || !x,
      ) ||
      (a.owner.agentGlobalId !== undefined && typeof a.owner.agentGlobalId !== 'string')
    )
      throw new Error('BACKUP_COLD_FILES_OWNER_INVALID');
    const file = await validateFile(
      JSON.stringify(a.file),
      `sha256:${await digest(a.file.publicKey)}`,
    );
    const owner = a.owner,
      memory = rows.memories?.find((m) => m._id === owner.memoryId),
      binding = rows.residentModelBindings?.find(
        (b) => b.worldId === owner.worldId && b.playerId === owner.playerId,
      );
    if (
      !memory ||
      !binding ||
      !rows.worlds?.some((w) => w._id === owner.worldId) ||
      memory.worldId !== owner.worldId ||
      memory.playerId !== owner.playerId ||
      binding.agentGlobalId !== owner.agentGlobalId ||
      (memory.agentGlobalId !== undefined && memory.agentGlobalId !== owner.agentGlobalId) ||
      memory.data.type !== file.manifest.kind
    )
      throw new Error('BACKUP_COLD_FILES_OWNER_INVALID');
    let messages: { messageId: string; text: string; author: string }[], scope: string;
    if (file.manifest.kind === 'conversation') {
      const c = rows.archivedConversations?.find(
        (c) => c.worldId === owner.worldId && c.id === memory.data.conversationId,
      );
      if (!c?.participants.includes(owner.playerId))
        throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
      messages = (rows.messages ?? [])
        .filter((m) => m.worldId === owner.worldId && m.conversationId === c.id)
        .map((m) => ({ messageId: m.messageUuid, text: m.text, author: m.author }));
      if (!(allowPartialParts && file.version === 2) && messages.length < c.numMessages) throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
      scope = JSON.stringify(['conversation', owner.worldId, c.id, c.created, c.ended]);
    } else {
      const transcriptId =
        memory.data.transcriptId ??
        `${memory.data.federationConversationId}/${memory.data.visitId}`;
      const t = rows.homeTravelTranscripts?.find(
        (t) => t.agentGlobalId === owner.agentGlobalId && t.transcriptId === transcriptId,
      );
      const pages = (rows.homeTravelTranscriptPages ?? [])
        .filter((p) => p.agentGlobalId === owner.agentGlobalId && p.transcriptId === transcriptId)
        .sort((a, b) => a.pageNumber - b.pageNumber);
      if (
        !owner.agentGlobalId ||
        !t ||
        t.worldId !== owner.worldId ||
        t.playerId !== owner.playerId ||
        t.visitId !== memory.data.visitId ||
        t.hostTownId !== memory.data.hostTownId ||
        t.federationConversationId !== memory.data.federationConversationId ||
        t.state !== 'COMPLETE' ||
        t.summaryState !== 'DONE' ||
        (!(allowPartialParts && file.version === 2) && (pages.length !== t.finalPageNumber + 1 ||
        pages.some((p, i) => p.pageNumber !== i || p.finalPage !== (i === pages.length - 1)))) ||
        (allowPartialParts && file.version === 2 && (pages.length !== 1 || pages[0].pageNumber !== file.payload.sourcePageNumber ||
          pages[0].finalPage !== (pages[0].pageNumber === t.finalPageNumber)))
      )
        throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
      messages = pages.flatMap((p) =>
        p.messages.map((m: any) => ({ messageId: m.messageId, text: m.text, author: m.author })),
      );
      if (!(allowPartialParts && file.version === 2) && messages.length !== t.totalMessageCount)
        throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
      scope = JSON.stringify([
        'travel',
        owner.worldId,
        owner.agentGlobalId,
        transcriptId,
        t.hostTownId,
        t.endedAt,
      ]);
    }
    const snapshot = file.version === 2 ? await digest({ owner, manifest: file.manifest, aliases: a.authorAliases }) : undefined;
    if (scopes.has(scope) && (!snapshot || scopeSnapshots.get(scope) !== snapshot)) throw new Error('BACKUP_COLD_FILES_DUPLICATE_SOURCE');
    scopes.add(scope);
    if (snapshot) scopeSnapshots.set(scope, snapshot);
    const groupMessages = file.version === 2
      ? partGroups.get(JSON.stringify([a.owner, file.manifest.snapshotId, a.authorAliases]))!.flatMap(p => p.payload.messages)
      : file.payload.messages;
    if (file.version === 2 && !allowPartialParts && messages.length !== file.manifest.count) throw new Error('BACKUP_COLD_FILES_MESSAGES_MISMATCH');
    const from = new Set(groupMessages.map(actor)),
      to = new Set(messages.map((m) => m.author)),
      aliases = new Map<string, string>();
    if (file.manifest.kind === 'travel') {
      from.add(JSON.parse(file.manifest.sourceKey)[2]);
      to.add(owner.agentGlobalId!);
    }
    for (const alias of a.authorAliases) {
      if (
        !exactKeys(alias, ['sourceAuthor', 'targetAuthor']) ||
        (!(allowPartialParts && file.version === 2) && (!from.has(alias.sourceAuthor) || !to.has(alias.targetAuthor))) ||
        aliases.has(alias.sourceAuthor) ||
        [...aliases.values()].includes(alias.targetAuthor)
      )
        throw new Error('BACKUP_COLD_FILES_AUTHOR_MAPPING_INVALID');
      aliases.set(alias.sourceAuthor, alias.targetAuthor);
    }
    if (file.manifest.kind === 'travel') {
      const originalOwner = JSON.parse(file.manifest.sourceKey)[2];
      if ((aliases.get(originalOwner) ?? originalOwner) !== owner.agentGlobalId)
        throw new Error('BACKUP_COLD_FILES_AUTHOR_MAPPING_INVALID');
    }
    const normalized = file.payload.messages.map((m) => ({
      messageId: m.messageId,
      text: m.text,
      author: aliases.get(actor(m)) ?? actor(m),
    }));
    const sort = (m: typeof messages) =>
      [...m].sort((a, b) => a.messageId.localeCompare(b.messageId));
    if (
      new Set(messages.map((m) => m.messageId)).size !== messages.length ||
      (await digest(sort(file.version === 2 ? messages.filter(m => normalized.some(n => n.messageId === m.messageId)) : messages))) !== (await digest(sort(normalized)))
    )
      throw new Error('BACKUP_COLD_FILES_MESSAGES_MISMATCH');
  }
}

export const candidates = internalQuery({
  args: { adminToken: v.string(), bundle: v.any() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const bundle = await validateBundle(args.bundle),
      result = [],
      seen = new Set<string>();
    const bindings = (bundle.sections.residentModelBindings ?? []).map(decodeRow);
    for (const memory of (bundle.sections.memories ?? []).map(decodeRow)) {
      if (!['conversation', 'travel'].includes(memory.data.type)) continue;
      const binding = bindings.find(
        (b) => b.worldId === memory.worldId && b.playerId === memory.playerId,
      );
      if (!binding) throw new Error('BACKUP_COLD_FILES_OWNER_INVALID');
      const owner = {
        worldId: memory.worldId,
        playerId: memory.playerId,
        agentGlobalId: binding.agentGlobalId,
        memoryId: memory._id,
      };
      let s;
      try {
        s = await source(ctx, { ...owner, adminToken: args.adminToken });
      } catch (e) {
        if (
          e instanceof Error &&
          [
            'COLD_HISTORY_NO_SOURCE',
            'COLD_HISTORY_NOT_COMPLETED',
            'COLD_HISTORY_TRANSCRIPT_OWNER_MISMATCH',
          ].includes(e.message)
        )
          continue;
        throw e;
      }
      const archive = await archiveFor(ctx, s.sourceKey);
      if (!archive || archive.state !== 'VERIFIED' || seen.has(archive._id)) continue;
      seen.add(archive._id);
      result.push({ owner, archive });
      if (result.length > 100) throw new Error('BACKUP_COLD_FILES_REQUIRES_CHUNKED_ARCHIVE');
    }
    return result;
  },
});
export const seal = internalQuery({
  args: { adminToken: v.string(), bundle: v.any() },
  handler: async (ctx, args): Promise<BackupBundle> => {
    requireAdmin(args.adminToken);
    const local = await identity(ctx),
      bundle: BackupBundle = args.bundle;
    const exportedIdentity = (bundle.sections.federationIdentity ?? []).map(decodeRow)[0];
    if (
      !local ||
      local.townId !== exportedIdentity?.townId ||
      local.publicKey !== exportedIdentity.publicKey
    )
      throw new Error('BACKUP_IDENTITY_CHANGED_RETRY');
    bundle.signature = await sign(bundle.manifest, local.privateKeyEncrypted);
    return validateBundle(bundle);
  },
});
export async function packColdFiles(
  ctx: ActionCtx,
  adminToken: string,
  bundle: BackupBundle,
): Promise<BackupBundle> {
  const found: any[] = await ctx.runQuery(queryRef('coldBackup/candidates'), {
    adminToken,
    bundle,
  });
  if (!found.length) return bundle;
  const files: ColdBackupAttachment[] = [];
  // The atomic path stays small. Refuse before accumulating a complete v2
  // history larger than the bundle budget; large backups stream its parts.
  let packedBytes = bytes(bundle) + 256;
  const append = (attachment: ColdBackupAttachment) => {
    packedBytes += bytes(attachment) + 1;
    if (packedBytes > 5_000_000) throw new Error('BACKUP_COLD_FILES_REQUIRES_CHUNKED_ARCHIVE');
    files.push(attachment);
  };
  for (const { owner, archive } of found) {
    if (archive.manifest.version === 2) {
      if (files.length + archive.manifest.chunkCount > 100 || packedBytes + archive.manifest.bytes > 5_000_000)
        throw new Error('BACKUP_COLD_FILES_REQUIRES_CHUNKED_ARCHIVE');
      for (let index = 0; index < archive.manifest.chunkCount; index++) {
        const file: PortableColdPart = await ctx.runAction(actionRef('coldHistoryChunks/exportPart'), { ...owner, adminToken, index });
        append({ owner, file, authorAliases: archive.authorAliases ?? [] });
      }
      continue;
    }
    const payload = await load(ctx, archive);
    append({
      owner,
      file: {
        format: 'ai-town-cold-history-file',
        version: 1,
        manifest: archive.manifest,
        publicKey: archive.publicKey,
        signature: archive.signature,
        payload,
      },
      authorAliases: archive.authorAliases ?? [],
    });
  }
  const packed: BackupBundle = {
    ...bundle,
    manifest: {
      ...bundle.manifest,
      coldHistoryFiles: { count: files.length, bytes: bytes(files), digest: await digest(files) },
    },
    coldHistoryFiles: files,
  };
  return ctx.runQuery(queryRef('coldBackup/seal'), { adminToken, bundle: packed });
}
export async function restoreColdFiles(
  ctx: MutationCtx,
  adminToken: string,
  bundle: BackupBundle,
  mapping: Record<string, string>,
  prepared: PreparedColdFile[] = [],
) {
  const files = bundle.coldHistoryFiles ?? [];
  if (
    prepared.length !== files.length ||
    new Set(prepared.map((p) => p.index)).size !== files.length ||
    prepared.some((p) => !files[p.index])
  )
    throw new Error('BACKUP_COLD_FILES_STORAGE_REQUIRED');
  for (let index = 0; index < files.length; index++) {
    const a = files[index],
      map = (id: string) => mapping[id] ?? id;
    if (!mapping[a.owner.worldId] || !mapping[a.owner.memoryId])
      throw new Error('BACKUP_COLD_FILES_TARGET_MAPPING_REQUIRED');
    const owner = {
      adminToken,
      worldId: map(a.owner.worldId) as Id<'worlds'>,
      playerId: map(a.owner.playerId),
      agentGlobalId: a.owner.agentGlobalId ? map(a.owner.agentGlobalId) : undefined,
      memoryId: map(a.owner.memoryId) as Id<'memories'>,
    };
    const original = new Set([...a.file.payload.messages.map(actor), ...a.authorAliases.map(a => a.sourceAuthor)]);
    if (a.file.manifest.kind === 'travel') original.add(JSON.parse(a.file.manifest.sourceKey)[2]);
    const prior = new Map(a.authorAliases.map((a) => [a.sourceAuthor, a.targetAuthor]));
    const authorAliases = [...original]
      .map((sourceAuthor) => ({
        sourceAuthor,
        targetAuthor: map(prior.get(sourceAuthor) ?? sourceAuthor),
      }))
      .filter((a) => a.sourceAuthor !== a.targetAuthor);
    const p = await plan(ctx, owner, a.file, authorAliases);
    await adoptHistoryFile(ctx, {
      ...owner,
      fileJson: JSON.stringify(a.file),
      expectedFingerprint: `sha256:${await digest(a.file.publicKey)}`,
      authorAliases,
      confirmation: p.confirmation,
      storageId: prepared.find((p) => p.index === index)!.storageId,
    });
  }
  return files.length;
}
export const referenced = internalQuery({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, args) =>
    !!(await ctx.db
      .query('coldHistoryArchives')
      .withIndex('storage', (q) => q.eq('storageId', args.storageId))
      .first()) || !!(await ctx.db.query('coldHistoryChunks').withIndex('storage', q => q.eq('storageId', args.storageId)).first()),
});
