import type { QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { captureSource } from './coldHistory';
import { plan, validateFile } from './coldHistoryFiles';
import { digest } from './security';
import type { ColdBackupAttachment } from './coldBackup';
import type { BackupRow } from './backupHelpers';
export type ColdLargeRow = ColdBackupAttachment & { _id: string; _creationTime: number };
export async function validateColdLargeRow(row: BackupRow) {
  if (
    !row ||
    Object.keys(row).some(
      (k) => !['_id', '_creationTime', 'owner', 'file', 'authorAliases'].includes(k),
    ) ||
    typeof row._id !== 'string' ||
    !row._id ||
    !Number.isFinite(row._creationTime) ||
    !row.owner ||
    Object.keys(row.owner).some(
      (k) => !['worldId', 'playerId', 'agentGlobalId', 'memoryId'].includes(k),
    ) ||
    ['worldId', 'playerId', 'memoryId'].some(
      (k) => typeof row.owner[k] !== 'string' || !row.owner[k],
    ) ||
    (row.owner.agentGlobalId !== undefined && typeof row.owner.agentGlobalId !== 'string') ||
    !Array.isArray(row.authorAliases) ||
    row.authorAliases.length > 100
  )
    throw new Error('BACKUP_COLD_FILES_OWNER_INVALID');
  for (const a of row.authorAliases)
    if (
      !a ||
      Object.keys(a).some((k) => !['sourceAuthor', 'targetAuthor'].includes(k)) ||
      typeof a.sourceAuthor !== 'string' ||
      typeof a.targetAuthor !== 'string'
    )
      throw new Error('BACKUP_COLD_FILES_AUTHOR_MAPPING_INVALID');
  await validateFile(JSON.stringify(row.file), `sha256:${await digest(row.file.publicKey)}`);
  return row as ColdLargeRow;
}
/** Resolve one eligible canonical memory, without scanning private unrelated memory. */
export async function coldLargeOwner(
  ctx: QueryCtx,
  archive: Doc<'coldHistoryArchives'>,
  adminToken: string,
) {
  const key = JSON.parse(archive.lookupKey ?? archive.sourceKey);
  if (!Array.isArray(key) || key[1] !== archive.worldId || key[0] !== archive.kind)
    throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
  let memories: Doc<'memories'>[] = [];
  if (archive.kind === 'conversation') {
    const c = await ctx.db
      .query('archivedConversations')
      .withIndex('worldId', (q) => q.eq('worldId', archive.worldId).eq('id', key[2]))
      .unique();
    if (!c) throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
    for (const p of c.participants) {
      const binding = await ctx.db
        .query('residentModelBindings')
        .withIndex('resident', (q) => q.eq('worldId', archive.worldId).eq('playerId', p))
        .unique();
      if (!binding) continue;
      memories = await ctx.db
        .query('memories')
        .withIndex('resident_conversation', (q) =>
          q
            .eq('worldId', archive.worldId)
            .eq('playerId', p)
            .eq('data.type', 'conversation')
            .eq('data.conversationId', key[2]),
        )
        .take(2);
      if (memories.length) break;
    }
  } else {
    const transcript = await ctx.db
      .query('homeTravelTranscripts')
      .withIndex('owner_transcript', (q) =>
        q.eq('agentGlobalId', key[2]).eq('transcriptId', key[3]),
      )
      .unique();
    if (!transcript) throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
    const page = await ctx.db
      .query('homeTravelTranscriptPages')
      .withIndex('owner_transcript_page', (q) =>
        q.eq('agentGlobalId', key[2]).eq('transcriptId', key[3]),
      )
      .first();
    for (const id of [transcript.endMemoryId, ...(page?.memoryIds ?? [])].filter(
      (id): id is Id<'memories'> => !!id,
    )) {
      const memory = await ctx.db.get(id);
      if (
        memory?.data.type === 'travel' &&
        (memory.data.transcriptId ??
          `${memory.data.federationConversationId}/${memory.data.visitId}`) === key[3]
      ) {
        memories = [memory];
        break;
      }
    }
  }
  const memory = memories[0];
  if (!memory) throw new Error('BACKUP_COLD_FILES_OWNER_INVALID');
  const binding = await ctx.db
    .query('residentModelBindings')
    .withIndex('resident', (q) => q.eq('worldId', archive.worldId).eq('playerId', memory.playerId))
    .unique();
  if (!binding) throw new Error('BACKUP_COLD_FILES_OWNER_INVALID');
  const owner = {
    worldId: archive.worldId,
    playerId: memory.playerId,
    agentGlobalId: binding.agentGlobalId,
    memoryId: memory._id,
  };
  const captured = await captureSource(ctx, { ...owner, adminToken }, true);
  if (captured.existing?._id !== archive._id) throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
  return owner;
}
export async function checkColdLargeExport(ctx: QueryCtx, row: ColdLargeRow, adminToken: string) {
  await validateColdLargeRow(row);
  return plan(
    ctx,
    {
      ...row.owner,
      worldId: row.owner.worldId as Id<'worlds'>,
      memoryId: row.owner.memoryId as Id<'memories'>,
      adminToken,
    },
    row.file,
    row.authorAliases,
  );
}
export function coldScope(table: string, row: BackupRow): string | undefined {
  if (table === 'messages') return row.conversationId;
  if (table === 'archivedConversations') return row.id;
  if (['homeTravelTranscripts', 'homeTravelTranscriptPages'].includes(table))
    return JSON.stringify([row.agentGlobalId, row.transcriptId]);
  return undefined;
}
