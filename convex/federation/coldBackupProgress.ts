import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { BackupRow } from './backupHelpers';
import { decodeRow } from './backupHelpers';
import { digest } from './security';
import { EMPTY_COLD_CHAIN, type ChunkManifest, type ColdChunkDescriptor } from './coldHistoryChunkFormat';

type PartMetadata = { manifest: ChunkManifest; descriptor: ColdChunkDescriptor; publicKey: string; signature: string;
  owner: BackupRow; aliases: BackupRow[]; messageIds: string[]; messageAuthors: string[] };
/** Claim the local canonical scope and every UUID in the same transaction that
 * advances preflight. No target data has been changed at this stage. */
export async function claimColdBackupPart(ctx: MutationCtx, jobId: Id<'backupLargeJobs'>, scope: string,
  sourceScope: string, part: PartMetadata, expectedPageCount?: number) {
  const m = part.manifest, d = part.descriptor;
  const rootDigest = await digest({ manifest: m, publicKey: part.publicKey, signature: part.signature,
    owner: part.owner, aliases: part.aliases });
  let check = await ctx.db.query('coldBackupChecks').withIndex('job_scope', q => q.eq('jobId', jobId).eq('scope', scope)).unique();
  if (check && check.rootDigest !== rootDigest) throw new Error('BACKUP_COLD_FILES_DUPLICATE_SOURCE');
  if (!check) {
    const id = await ctx.db.insert('coldBackupChecks', { jobId, scope, rootDigest, root: m, owner: part.owner,
      aliases: part.aliases, seenAliases: [], kind: m.kind, sourceScope, index: 0, count: 0, bytes: 0,
      chainDigest: EMPTY_COLD_CHAIN, state: 'PARTS', cursor: null, sourceCount: 0, sourcePageNumber: 0, expectedPageCount });
    check = (await ctx.db.get(id))!;
  }
  if (check.state !== 'PARTS' || d.index !== check.index || d.start !== check.count || d.previousDigest !== check.chainDigest)
    throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
  for (const messageId of part.messageIds) {
    if (await ctx.db.query('coldBackupMessageIds').withIndex('job_scope_message', q => q.eq('jobId', jobId).eq('scope', scope).eq('messageId', messageId)).unique())
      throw new Error('COLD_HISTORY_EMPTY_OR_DUPLICATE_MESSAGES');
    await ctx.db.insert('coldBackupMessageIds', { jobId, scope, messageId });
  }
  const authors = new Set(part.messageAuthors);
  if (m.kind === 'travel') authors.add(JSON.parse(m.sourceKey)[2]);
  const seenAliases = [...new Set([...check.seenAliases, ...part.aliases.filter(a => authors.has(a.sourceAuthor)).map(a => a.sourceAuthor)])];
  const count = check.count + d.count, bytes = check.bytes + d.bytes, done = d.index + 1 === m.chunkCount;
  if (done && (count !== m.count || bytes !== m.bytes || d.chainDigest !== m.digest || part.aliases.some(a => !seenAliases.includes(a.sourceAuthor))))
    throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
  await ctx.db.patch(check._id, { index: check.index + 1, count, bytes, chainDigest: d.chainDigest,
    seenAliases, state: done ? 'PARTS_COMPLETE' : 'PARTS' });
}
export async function advanceColdBackupCounts(ctx: MutationCtx, jobId: Id<'backupLargeJobs'>) {
  if (await ctx.db.query('coldBackupChecks').withIndex('job_state', q => q.eq('jobId', jobId).eq('state', 'PARTS')).first())
    throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
  const check = await ctx.db.query('coldBackupChecks').withIndex('job_state', q => q.eq('jobId', jobId).eq('state', 'PARTS_COMPLETE')).first();
  if (!check) return true;
  const name = check.kind === 'conversation' ? 'messages' : 'homeTravelTranscriptPages';
  if (name === 'homeTravelTranscriptPages') {
    let pageNumber = check.sourcePageNumber, count = check.sourceCount;
    if (!Number.isSafeInteger(check.expectedPageCount) || check.expectedPageCount! < 1)
      throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
    for (let step = 0; step < 20 && pageNumber < check.expectedPageCount!; step++, pageNumber++) {
      const transcriptId = JSON.parse(check.sourceScope)[1];
      const staged = await ctx.db.query('backupLargeRows').withIndex('job_relation', q => q.eq('jobId', jobId).eq('role', 'SOURCE')
        .eq('table', name).eq('relationKey', JSON.stringify([check.owner.agentGlobalId, transcriptId, pageNumber]))).unique();
      if (!staged) throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
      const row = staged.metadata.envelope ? decodeRow(staged.metadata.envelope.record) : staged.metadata;
      if (row.pageNumber !== pageNumber || row.finalPage !== (pageNumber + 1 === check.expectedPageCount))
        throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
      count += row.messageCount ?? row.messages.length;
    }
    const done = pageNumber === check.expectedPageCount;
    if (count > check.root.count || (done && count !== check.root.count)) throw new Error('BACKUP_COLD_FILES_MESSAGES_MISMATCH');
    await ctx.db.patch(check._id, { sourceCount: count, sourcePageNumber: pageNumber, state: done ? 'VERIFIED' : 'PARTS_COMPLETE' });
    return false;
  }
  const page = await ctx.db.query('backupLargeRows').withIndex('job_scope', q => q.eq('jobId', jobId).eq('role', 'SOURCE').eq('table', name)
    .eq('worldId', check.owner.worldId).eq('sourceScope', check.sourceScope))
    .paginate({ cursor: check.cursor, numItems: 100, maximumBytesRead: 512 * 1024 });
  let count = check.sourceCount, pageNumber = check.sourcePageNumber;
  for (const staged of page.page) {
    const row = staged.metadata.envelope ? decodeRow(staged.metadata.envelope.record) : staged.metadata;
    if (!await ctx.db.query('coldBackupMessageIds').withIndex('job_scope_message', q => q.eq('jobId', jobId).eq('scope', check.scope).eq('messageId', row.messageUuid)).unique())
      throw new Error('BACKUP_COLD_FILES_MESSAGES_MISMATCH');
    count++;
  }
  if (count > check.root.count || (page.isDone && count !== check.root.count))
    throw new Error('BACKUP_COLD_FILES_MESSAGES_MISMATCH');
  await ctx.db.patch(check._id, { sourceCount: count, sourcePageNumber: pageNumber,
    cursor: page.isDone ? null : page.continueCursor, state: page.isDone ? 'VERIFIED' : 'PARTS_COMPLETE' });
  return false;
}
export function portablePartMetadata(row: BackupRow): PartMetadata {
  return { owner: row.owner, manifest: row.file.manifest, descriptor: row.file.descriptor,
    signature: row.file.signature, publicKey: row.file.publicKey, aliases: row.authorAliases,
    messageIds: row.file.payload.messages.map((m: BackupRow) => m.messageId),
    messageAuthors: row.file.payload.messages.map((m: BackupRow) => m.authorGlobalId ?? m.authorPlayerId) };
}
