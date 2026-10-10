import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { captureSource } from './coldHistory';
import { inBounds, type Selection } from './backupSelectiveHelpers';
import type { BackupRow } from './backupHelpers';

export function selectiveColdScope(table: string, row: BackupRow) {
  if (table === 'memories') {
    if (row.data.type === 'conversation')
      return JSON.stringify(['conversation', row.data.conversationId]);
    if (row.data.type === 'travel')
      return JSON.stringify([
        'travel',
        row.agentGlobalId,
        row.data.transcriptId ?? `${row.data.federationConversationId}/${row.data.visitId}`,
      ]);
  }
  return undefined;
}

/** Only selected resident memories can own an attachment. Never choose another
 * participant's private memory merely because it indexes the same conversation. */
export async function selectiveColdCandidate(
  ctx: QueryCtx,
  job: Doc<'backupLargeJobs'>,
  archive: Doc<'coldHistoryArchives'>,
) {
  const selection = job.metadata.selection as Selection;
  if (
    selection.scope === 'config-only' ||
    !selection.owners.some((o) => o.worldId === archive.worldId)
  )
    return null;
  const lookup = JSON.parse(archive.lookupKey ?? archive.sourceKey);
  if (!Array.isArray(lookup) || lookup[0] !== archive.kind || lookup[1] !== archive.worldId)
    throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
  const sourceScope =
    archive.kind === 'conversation'
      ? JSON.stringify(['conversation', lookup[2]])
      : JSON.stringify(['travel', lookup[2], lookup[3]]);
  const markers = await ctx.db
    .query('backupLargeRows')
    .withIndex('job_scope', (q) =>
      q
        .eq('jobId', job._id)
        .eq('role', 'SOURCE')
        .eq('table', 'memories')
        .eq('worldId', archive.worldId)
        .eq('sourceScope', sourceScope),
    )
    .take(1);
  const emitted = async (id: string) => {
    const marker = await ctx.db
      .query('backupLargeRows')
      .withIndex('job_source', (q) => q.eq('jobId', job._id).eq('sourceId', id))
      .unique();
    return marker?.state === 'EMITTED';
  };
  let memory: Doc<'memories'> | undefined;
  if (markers[0]?.state === 'EMITTED')
    memory = (await ctx.db.get(markers[0].sourceId as Doc<'memories'>['_id'])) ?? undefined;
  // History deliberately excludes private canonical memories. Still inspect its
  // eligible signed source so missing hot originals cannot become an empty export.
  if (
    !memory &&
    selection.scope === 'history' &&
    selection.categories.includes(archive.kind) &&
    inBounds(
      'archivedConversations',
      { ended: archive.kind === 'conversation' ? lookup[4] : lookup[5] },
      selection,
    )
  )
    for (const owner of selection.owners.filter((o) => o.worldId === archive.worldId)) {
      if (archive.kind === 'conversation')
        memory =
          (await ctx.db
            .query('memories')
            .withIndex('resident_conversation', (q) =>
              q
                .eq('worldId', archive.worldId)
                .eq('playerId', owner.playerId)
                .eq('data.type', 'conversation')
                .eq('data.conversationId', lookup[2]),
            )
            .first()) ?? undefined;
      else if (lookup[2] === owner.agentGlobalId) {
        const transcript = await ctx.db
          .query('homeTravelTranscripts')
          .withIndex('owner_transcript', (q) =>
            q.eq('agentGlobalId', owner.agentGlobalId).eq('transcriptId', lookup[3]),
          )
          .unique();
        if (transcript?.endMemoryId)
          memory = (await ctx.db.get(transcript.endMemoryId)) ?? undefined;
        if (!memory) {
          const page = await ctx.db
            .query('homeTravelTranscriptPages')
            .withIndex('owner_transcript_page', (q) =>
              q.eq('agentGlobalId', owner.agentGlobalId).eq('transcriptId', lookup[3]),
            )
            .first();
          if (page?.memoryIds[0]) memory = (await ctx.db.get(page.memoryIds[0])) ?? undefined;
        }
        if (!memory) throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
      }
      if (memory) break;
    }
  if (!memory) return null;
  const selectedOwner = selection.owners.find(
    (o) => o.worldId === memory!.worldId && o.playerId === memory!.playerId,
  )!;
  if (!selectedOwner) throw new Error('BACKUP_COLD_FILES_OWNER_INVALID');
  const owner = {
    worldId: archive.worldId,
    playerId: memory.playerId,
    agentGlobalId: selectedOwner.agentGlobalId,
    memoryId: memory._id,
  };
  if (selection.scope === 'memories-only' || !selection.categories.includes(archive.kind))
    return {
      archive,
      owner,
      exclusion: 'SOURCE_SCOPE_NOT_SELECTED' as const,
      verifyOriginal: false,
    };
  const captured = await captureSource(
    ctx,
    { ...owner, adminToken: process.env.FEDERATION_ADMIN_TOKEN ?? '' },
    true,
  );
  if (captured.existing?._id !== archive._id) throw new Error('BACKUP_COLD_FILES_SOURCE_INVALID');
  let originals: BackupRow[];
  if (archive.kind === 'conversation') {
    const conversation = await ctx.db
      .query('archivedConversations')
      .withIndex('worldId', (q) => q.eq('worldId', archive.worldId).eq('id', lookup[2]))
      .unique();
    const messages = await ctx.db
      .query('messages')
      .withIndex('conversationId', (q) =>
        q.eq('worldId', archive.worldId).eq('conversationId', lookup[2]),
      )
      .take(1001);
    originals = [conversation!, ...messages];
  } else {
    const transcript = await ctx.db
      .query('homeTravelTranscripts')
      .withIndex('owner_transcript', (q) =>
        q.eq('agentGlobalId', owner.agentGlobalId).eq('transcriptId', lookup[3]),
      )
      .unique();
    const pages = await ctx.db
      .query('homeTravelTranscriptPages')
      .withIndex('owner_transcript_page', (q) =>
        q.eq('agentGlobalId', owner.agentGlobalId).eq('transcriptId', lookup[3]),
      )
      .take(1001);
    originals = [transcript!, ...pages];
  }
  let exclusion: 'CANONICAL_MEMORY_NOT_SELECTED' | 'SOURCE_SCOPE_INCOMPLETE' | undefined;
  if (!(await emitted(memory._id))) exclusion = 'CANONICAL_MEMORY_NOT_SELECTED';
  else
    for (const row of originals)
      if (!(await emitted(row._id))) {
        exclusion = 'SOURCE_SCOPE_INCOMPLETE';
        break;
      }
  return { archive, owner, exclusion, verifyOriginal: true };
}
