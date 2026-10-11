import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { source, type OwnerArgs } from './coldHistory';
import { COLD_CHUNK_MAX_BYTES } from './coldHistoryChunkFormat';

/** A complete hot scope is checked before the first part is emitted. Selection
 * exclusion applies to the whole archive, never to an already emitted prefix. */
export async function coldExportSourcePage(ctx: QueryCtx, job: Doc<'backupLargeJobs'>,
  archive: Doc<'coldHistoryArchives'>, owner: OwnerArgs, selected = false) {
  const s = await source(ctx, owner);
  if (s.sourceKey !== (archive.lookupKey ?? archive.sourceKey)) throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
  const progress = job.metadata?.coldScopeScan ?? { cursor: null, count: 0, pageNumber: 0, excluded: false };
  const emitted = async (id: string) => !!(await ctx.db.query('backupLargeRows').withIndex('job_source', q =>
    q.eq('jobId', job._id).eq('sourceId', id)).unique())?.state?.includes('EMITTED');
  let count = progress.count, pageNumber = progress.pageNumber, excluded = progress.excluded;
  if (s.kind === 'conversation') {
    const page = await ctx.db.query('messages').withIndex('conversationId', q =>
      q.eq('worldId', owner.worldId).eq('conversationId', s.sourceId as `c:${number}`)).order('asc')
      .paginate({ cursor: progress.cursor, numItems: 100, maximumBytesRead: COLD_CHUNK_MAX_BYTES });
    for (const message of page.page) if (selected && !await emitted(message._id)) excluded = true;
    count += page.page.length;
    if (count > archive.manifest.count || (page.isDone && count !== archive.manifest.count)) throw new Error('BACKUP_COLD_FILES_MESSAGES_MISMATCH');
    return { scan: { count, pageNumber, excluded, cursor: page.isDone ? null : page.continueCursor }, done: page.isDone };
  }
  const page = await ctx.db.query('homeTravelTranscriptPages').withIndex('owner_transcript_page', q =>
    q.eq('agentGlobalId', owner.agentGlobalId!).eq('transcriptId', s.sourceId))
    .paginate({ cursor: progress.cursor, numItems: 1, maximumBytesRead: COLD_CHUNK_MAX_BYTES });
  if (!page.page.length || page.page[0].pageNumber !== pageNumber || page.page[0].finalPage !== page.isDone ||
      !Number.isSafeInteger(s.expectedPageCount) || s.expectedPageCount < 1 ||
      page.page[0].pageNumber >= s.expectedPageCount || page.isDone !== (pageNumber + 1 === s.expectedPageCount))
    throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
  for (const p of page.page) { count += p.messages.length; pageNumber++; if (selected && !await emitted(p._id)) excluded = true; }
  if (count > archive.manifest.count || (page.isDone && count !== archive.manifest.count)) throw new Error('BACKUP_COLD_FILES_MESSAGES_MISMATCH');
  return { scan: { count, pageNumber, excluded, cursor: page.isDone ? null : page.continueCursor }, done: page.isDone };
}
