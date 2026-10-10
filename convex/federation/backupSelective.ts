import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  DatabaseReader,
} from '../_generated/server';
import { Doc, Id, TableNames } from '../_generated/dataModel';
import { requireAdmin, sign } from './security';
import { assertTownUnlocked } from './maintenanceLock';
import { BackupRow, decodeRow, encodeRow } from './backupHelpers';
import {
  ChunkDescriptor,
  LargeChunk,
  MAX_ARCHIVE_BYTES,
  MAX_CHUNKS,
  MAX_CHUNK_BYTES,
  TARGET_CHUNK_BYTES,
  descriptor,
  sanitizeLargeValue,
  size,
  validateSourceRow,
} from './backupLargeHelpers';
import {
  ArchiveEnvelope,
  Owner,
  PublicParticipant,
  Selection,
  SelectiveManifest,
  configTables,
  historyTables,
  inBounds,
  residentTables,
  rowOwner,
  scopedWorld,
  selectiveScope,
  selectiveTables,
  validateSelection,
  validateSelectiveManifest,
} from './backupSelectiveHelpers';

type Job = Doc<'backupLargeJobs'>;
const mode = 'selective-archive';
const args = { adminToken: v.string(), jobId: v.id('backupLargeJobs') };
const refQ = (name: string) => makeFunctionReference<'query'>(`federation/backupSelective:${name}`);
const refM = (name: string) =>
  makeFunctionReference<'mutation'>(`federation/backupSelective:${name}`);
const name = (table: string) => table as TableNames;
const terminal = new Set(['COMPLETE', 'CANCELLED']);
function view(j: Job) {
  return {
    jobId: j._id,
    state: j.state,
    phase: j.phase,
    recordCount: j.recordCount,
    chunkCount: j.chunkCount,
    bytes: j.bytes,
    selection: j.metadata.selection as Selection,
    operator: j.metadata.operator as string,
    updatedAt: j.updatedAt,
    error: j.error,
  };
}
async function owned(ctx: { db: DatabaseReader }, id: Id<'backupLargeJobs'>) {
  const job = await ctx.db.get(id);
  if (!job || job.kind !== 'export' || job.mode !== mode)
    throw new Error('SELECTIVE_ARCHIVE_JOB_NOT_FOUND');
  if (!terminal.has(job.state)) {
    const lock = await ctx.db
      .query('backupMaintenanceLocks')
      .withIndex('key', (q) => q.eq('key', 'town'))
      .unique();
    if (lock?.jobId !== id) throw new Error('BACKUP_MAINTENANCE_LOCK_LOST');
  }
  return job;
}
async function stable(ctx: { db: DatabaseReader }) {
  const local = await ctx.db.query('federationIdentity').unique();
  if (!local) throw new Error('INITIALIZE_IDENTITY_FIRST');
  if (local.enabled) throw new Error('DISABLE_FEDERATION_BEFORE_BACKUP');
  if (
    await ctx.db
      .query('engines')
      .filter((q) => q.eq(q.field('running'), true))
      .first()
  )
    throw new Error('STOP_TARGET_ENGINE_FIRST');
  if (
    await ctx.db
      .query('visitLedger')
      .filter((q) =>
        q.and(q.neq(q.field('state'), 'COMPLETED'), q.neq(q.field('state'), 'REJECTED')),
      )
      .first()
  )
    throw new Error('RECONCILE_TARGET_VISITS_FIRST');
  return local;
}
export const startExport = mutation({
  args: {
    adminToken: v.string(),
    scope: selectiveScope,
    agentGlobalIds: v.array(v.string()),
    categories: v.array(v.string()),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    includePublicPeers: v.optional(v.boolean()),
    operator: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    await assertTownUnlocked(ctx);
    const local = await stable(ctx);
    if (
      !a.operator.trim() ||
      a.operator.trim().length > 200 ||
      !a.reason.trim() ||
      a.reason.trim().length > 1000
    )
      throw new Error('EXPORT_OPERATOR_REASON_REQUIRED');
    if (a.agentGlobalIds.length > 100 || new Set(a.agentGlobalIds).size !== a.agentGlobalIds.length)
      throw new Error('INVALID_SELECTIVE_OWNERS');
    const owners: Owner[] = [];
    for (const globalId of a.agentGlobalIds) {
      const binding = await ctx.db
        .query('residentModelBindings')
        .withIndex('globalAgent', (q) => q.eq('agentGlobalId', globalId))
        .unique();
      const runtime = await ctx.db
        .query('federationAgentRuntimes')
        .withIndex('globalId', (q) => q.eq('agentGlobalId', globalId))
        .unique();
      const world = binding && (await ctx.db.get(binding.worldId));
      const agent = world?.agents.find((agent) => agent.playerId === binding!.playerId);
      if (
        !binding ||
        !runtime ||
        runtime.homeTownId !== local.townId ||
        runtime.worldId !== binding.worldId ||
        runtime.playerId !== binding.playerId ||
        !agent ||
        agent.id !== runtime.agentId
      )
        throw new Error('SELECTIVE_OWNER_HOME_PROOF_REQUIRED');
      owners.push({
        agentGlobalId: globalId,
        worldId: binding.worldId,
        playerId: binding.playerId,
        agentId: agent.id,
        chatProfileId: binding.chatProfileId,
      });
    }
    owners.sort((a, b) => a.agentGlobalId.localeCompare(b.agentGlobalId));
    const selection: Selection = {
      scope: a.scope,
      owners,
      categories: [...a.categories].sort(),
      from: a.from ?? null,
      to: a.to ?? null,
      includePublicPeers: a.includePublicPeers ?? false,
      dependencyPolicy: 'same-owner-evidence-and-public-context',
      timePolicy: 'event-time-else-creation-time-half-open',
    };
    validateSelection(selection);
    const now = Date.now();
    const jobId = await ctx.db.insert('backupLargeJobs', {
      kind: 'export',
      mode,
      state: 'RUNNING',
      phase: 'SCANNING',
      tableIndex: 0,
      cursor: null,
      chunkCount: 0,
      processedChunks: 0,
      recordCount: 0,
      bytes: 0,
      createdAt: now,
      updatedAt: now,
      source: sanitizeLargeValue(local),
      metadata: { selection, operator: a.operator.trim(), reason: a.reason.trim() },
    });
    await ctx.db.insert('backupMaintenanceLocks', { key: 'town', jobId, createdAt: now });
    return { jobId };
  },
});
export const status = query({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    return view(await owned(ctx, a.jobId));
  },
});
export const listJobs = query({
  args: { adminToken: v.string() },
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    return (
      await ctx.db
        .query('backupLargeJobs')
        .filter((q) => q.eq(q.field('mode'), mode))
        .order('desc')
        .take(30)
    ).map(view);
  },
});
export const jobData = internalQuery({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => owned(ctx, a.jobId),
});

async function normalizeMemory(
  db: DatabaseReader,
  row: BackupRow,
  s: Selection,
): Promise<BackupRow> {
  if (row.worldId) return row;
  // Local player IDs repeat across worlds. Never guess ownership of old rows.
  const bindings = await db
    .query('residentModelBindings')
    .filter((q) => q.eq(q.field('playerId'), row.playerId))
    .take(2);
  if (bindings.length !== 1) {
    if (s.owners.some((o) => o.playerId === row.playerId))
      throw new Error('LEGACY_MEMORY_OWNER_AMBIGUOUS');
    return row;
  }
  return { ...row, worldId: bindings[0].worldId, agentGlobalId: bindings[0].agentGlobalId };
}
async function conversation(db: DatabaseReader, row: BackupRow) {
  if (!row.worldId) return null;
  const archived = await db
    .query('archivedConversations')
    .withIndex('worldId', (q) => q.eq('worldId', row.worldId).eq('id', row.conversationId))
    .unique();
  if (archived) return { ...archived, contextSource: 'archived' as const };
  const world = await db.get(row.worldId as Id<'worlds'>);
  const live = world?.conversations.find((c) => c.id === row.conversationId);
  if (!live) return null;
  return {
    ...live,
    _id: world!._id,
    worldId: world!._id,
    participants: live.participants.map((p) => p.playerId),
    contextSource: 'live' as const,
  };
}
function includesResident(table: string, row: BackupRow, s: Selection) {
  if (['playerDescriptions', 'archivedPlayers'].includes(table))
    return s.owners.some(
      (o) => o.worldId === row.worldId && o.playerId === (row.playerId ?? row.id),
    );
  if (['agentDescriptions', 'archivedAgents'].includes(table))
    return s.owners.some((o) => o.worldId === row.worldId && o.agentId === (row.agentId ?? row.id));
  return !!rowOwner(row, s);
}
async function primary(db: DatabaseReader, table: string, row: BackupRow, s: Selection) {
  if (s.scope === 'config-only')
    return (
      (configTables as readonly string[]).includes(table) &&
      (table !== 'federationPeers' || s.includePublicPeers)
    );
  const residents = ['agent-one', 'agents-selected'].includes(s.scope);
  if (table === 'federationIdentity') return true;
  if (residents && ['worlds', 'maps'].includes(table))
    return s.owners.some((o) => o.worldId === (table === 'worlds' ? row._id : row.worldId));
  if (residents && (residentTables as readonly string[]).includes(table))
    return includesResident(table, row, s);
  if (table === 'memories')
    return (
      s.scope !== 'history' &&
      !!rowOwner(row, s) &&
      s.categories.includes(row.data?.type) &&
      inBounds(table, row, s)
    );
  if (
    s.scope === 'memories-only' ||
    !(historyTables as readonly string[]).includes(table) ||
    !inBounds(table, row, s)
  )
    return false;
  const category =
    table === 'participatedTogether'
      ? 'social'
      : ['archivedConversations', 'messages'].includes(table)
        ? 'conversation'
        : 'travel';
  if (!s.categories.includes(category)) return false;
  if (table === 'archivedConversations')
    return s.owners.some((o) => o.worldId === row.worldId && row.participants.includes(o.playerId));
  if (table === 'messages') {
    const parent = await conversation(db, row);
    return (
      !!parent &&
      s.owners.some((o) => o.worldId === parent.worldId && parent.participants.includes(o.playerId))
    );
  }
  if (table === 'participatedTogether')
    return s.owners.some(
      (o) => o.worldId === row.worldId && [row.player1, row.player2].includes(o.playerId),
    );
  if (['federationActionFacts', 'federationEventFacts'].includes(table)) {
    const visit = await db
      .query('visitLedger')
      .withIndex('visitId', (q) => q.eq('visitId', row.visitId))
      .unique();
    return !!visit && s.owners.some((o) => o.agentGlobalId === visit.agentGlobalId);
  }
  return !!rowOwner(row, s);
}
async function envelope(
  db: DatabaseReader,
  table: string,
  raw: BackupRow,
  s: Selection,
  role: 'primary' | 'dependency',
): Promise<ArchiveEnvelope> {
  let row = sanitizeLargeValue(raw);
  if (table === 'worlds') row = scopedWorld(row, s);
  if (table === 'memories') {
    const { embeddingId: _embeddingId, embeddingSpaceId: _embeddingSpaceId, ...canonical } = row;
    row = canonical;
  }
  // Only completed, non-executable Home ownership is part of this archive.
  if (table === 'federationAgentRuntimes') {
    const {
      visitId: _visitId,
      activeDecisionId: _activeDecisionId,
      lastError: _lastError,
      ...ownership
    } = row;
    row = ownership;
  }
  const references = validateSourceRow(table, row);
  if (
    table === 'homeTravelTranscriptPages' ||
    (table === 'memories' && row.data.type === 'travel' && row.data.transcriptId)
  ) {
    const transcriptId = table === 'memories' ? row.data.transcriptId : row.transcriptId;
    const transcript = await db
      .query('homeTravelTranscripts')
      .withIndex('owner_transcript', (q) =>
        q.eq('agentGlobalId', row.agentGlobalId).eq('transcriptId', transcriptId),
      )
      .unique();
    if (transcript) references.push({ id: transcript._id, table: 'homeTravelTranscripts' });
  }
  let context: Awaited<ReturnType<typeof conversation>> = null;
  if (['federationActionFacts', 'federationEventFacts'].includes(table)) {
    const visit = await db
      .query('visitLedger')
      .withIndex('visitId', (q) => q.eq('visitId', row.visitId))
      .unique();
    if (visit) references.push({ id: visit._id, table: 'visitLedger' });
  }
  if (
    (table === 'memories' && row.data.type === 'conversation') ||
    ['messages', 'participatedTogether'].includes(table)
  ) {
    context = await conversation(
      db,
      table === 'memories'
        ? { worldId: row.worldId, conversationId: row.data.conversationId }
        : row,
    );
    if (context)
      references.push({
        id: context._id,
        table: context.contextSource === 'archived' ? 'archivedConversations' : 'worlds',
      });
  }
  // Public resident/profile context preserves source bindings without cloning identities.
  if (table === 'memories' || (historyTables as readonly string[]).includes(table)) {
    const own = rowOwner(row, s);
    const involved = own
      ? [own]
      : s.owners.filter(
          (o) =>
            o.worldId === row.worldId &&
            (row.participants?.includes(o.playerId) ||
              [row.player1, row.player2].includes(o.playerId) ||
              row.author === o.playerId),
        );
    for (const owner of involved) {
      const binding = await db
        .query('residentModelBindings')
        .withIndex('globalAgent', (q) => q.eq('agentGlobalId', owner.agentGlobalId))
        .unique();
      if (binding) references.push({ id: binding._id, table: 'residentModelBindings' });
      for (const contextTable of ['playerDescriptions', 'agentDescriptions'] as const) {
        const context =
          contextTable === 'playerDescriptions'
            ? await db
                .query(contextTable)
                .withIndex('worldId', (q) =>
                  q.eq('worldId', owner.worldId as Id<'worlds'>).eq('playerId', owner.playerId),
                )
                .unique()
            : await db
                .query(contextTable)
                .withIndex('worldId', (q) =>
                  q.eq('worldId', owner.worldId as Id<'worlds'>).eq('agentId', owner.agentId),
                )
                .unique();
        if (context) references.push({ id: context._id, table: contextTable });
      }
    }
  }
  const publicParticipants: PublicParticipant[] = [];
  const participants =
    context?.participants ??
    (table === 'archivedConversations'
      ? row.participants
      : table === 'participatedTogether'
        ? [row.player1, row.player2]
        : table === 'memories' && row.data.type === 'relationship' && row.data.playerId
          ? [row.data.playerId]
          : []);
  if (participants.length > 100) throw new Error('SELECTIVE_PARTICIPANT_BUDGET');
  for (const playerId of new Set<string>(participants)) {
    const binding = await db
      .query('residentModelBindings')
      .withIndex('resident', (q) => q.eq('worldId', row.worldId).eq('playerId', playerId))
      .unique();
    const description = await db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', row.worldId).eq('playerId', playerId))
      .unique();
    const globalId = binding?.agentGlobalId;
    const runtime =
      globalId &&
      (await db
        .query('federationAgentRuntimes')
        .withIndex('globalId', (q) => q.eq('agentGlobalId', globalId))
        .unique());
    publicParticipants.push({
      worldId: row.worldId,
      playerId,
      name: description?.name ?? playerId,
      agentGlobalId: binding?.agentGlobalId ?? null,
      homeTownId: runtime ? runtime.homeTownId : (description?.originTownId ?? null),
    });
  }
  return {
    kind: 'record',
    role,
    record: encodeRow(row),
    references: [...new Map(references.map((r) => [r.id, r])).values()],
    ...(publicParticipants.length ? { publicParticipants } : {}),
    ...(context
      ? {
          conversationContext: {
            id: context.id,
            worldId: context.worldId,
            source: context.contextSource,
            created: context.created,
            participants: context.participants,
            numMessages: context.numMessages,
          },
        }
      : {}),
  };
}
export const page = internalQuery({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    const local = await stable(ctx);
    if (local.fingerprint !== job.source.fingerprint) throw new Error('BACKUP_IDENTITY_CHANGED');
    const selection = job.metadata.selection as Selection;
    if (job.phase === 'SCANNING') {
      const table = selectiveTables[job.tableIndex];
      if (!table) throw new Error('BACKUP_CHECKPOINT_CHANGED');
      const page = await ctx.db
        .query(name(table))
        .paginate({ cursor: job.cursor, numItems: 20, maximumBytesRead: TARGET_CHUNK_BYTES });
      const rows: ArchiveEnvelope[] = [];
      for (let row of page.page as BackupRow[]) {
        if (table === 'memories') row = await normalizeMemory(ctx.db, row, selection);
        if (await primary(ctx.db, table, row, selection))
          rows.push(await envelope(ctx.db, table, row, selection, 'primary'));
      }
      return {
        table,
        rows,
        cursor: page.continueCursor,
        done: page.isDone,
        queued: [] as string[],
      };
    }
    if (job.phase === 'REFERENCE_MAPPINGS') {
      const deferred = await ctx.db
        .query('backupLargeRows')
        .withIndex('job_state', (q) => q.eq('jobId', job._id).eq('state', 'DEFERRED'))
        .take(1);
      return {
        table: 'referenceMappings',
        rows: deferred.map((p) => ({
          kind: 'external-reference' as const,
          sourceId: p.sourceId,
          table: p.table,
          reason: p.metadata.reason as Extract<
            ArchiveEnvelope,
            { kind: 'external-reference' }
          >['reason'],
        })),
        cursor: '',
        done: deferred.length === 0,
        queued: [] as string[],
      };
    }
    if (job.phase !== 'CLOSURE') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const pending = await ctx.db
      .query('backupLargeRows')
      .withIndex('job_state', (q) => q.eq('jobId', job._id).eq('state', 'QUEUED'))
      .take(1);
    const rows: ArchiveEnvelope[] = [];
    const deferred: {
      sourceId: string;
      reason: string;
      ownerGlobalId?: string;
    }[] = [];
    let table = 'referenceMappings';
    for (const p of pending) {
      let row: BackupRow | null = null;
      if ((selectiveTables as readonly string[]).includes(p.table)) {
        const id = ctx.db.normalizeId(name(p.table), p.sourceId);
        if (id) row = await ctx.db.get(id);
      }
      if (row && p.table === 'memories') row = await normalizeMemory(ctx.db, row, selection);
      const memoryOwner = row && rowOwner(row, selection);
      const permitted =
        row &&
        (!(residentTables as readonly string[]).includes(p.table) ||
          includesResident(p.table, row, selection)) &&
        (p.table !== 'memories' ||
          (!!memoryOwner && p.metadata.requestingOwners?.includes(memoryOwner.agentGlobalId))) &&
        (p.table !== 'archivedConversations' ||
          selection.owners.some(
            (o) => o.worldId === row!.worldId && row!.participants.includes(o.playerId),
          ));
      if (!permitted)
        deferred.push({
          sourceId: p.sourceId,
          reason: !(selectiveTables as readonly string[]).includes(p.table)
            ? 'UNSUPPORTED_DEPENDENCY'
            : !row
              ? 'SOURCE_MISSING'
              : 'PRIVATE_OWNER_EXCLUDED',
          ...(memoryOwner ? { ownerGlobalId: memoryOwner.agentGlobalId } : {}),
        });
      else {
        table = p.table;
        rows.push(await envelope(ctx.db, p.table, row!, selection, 'dependency'));
      }
    }
    return {
      table,
      rows,
      cursor: '',
      done: pending.length === 0,
      queued: pending.map((p) => p.sourceId),
      deferred,
    };
  },
});
export const savePage = internalMutation({
  args: {
    jobId: v.id('backupLargeJobs'),
    expectedPhase: v.string(),
    expectedCursor: v.union(v.string(), v.null()),
    expectedTableIndex: v.number(),
    expectedChunkCount: v.number(),
    page: v.any(),
    chunks: v.array(v.any()),
  },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (
      job.state !== 'RUNNING' ||
      job.phase !== a.expectedPhase ||
      job.cursor !== a.expectedCursor ||
      job.tableIndex !== a.expectedTableIndex ||
      job.chunkCount !== a.expectedChunkCount
    )
      throw new Error('BACKUP_CHECKPOINT_CHANGED');
    let bytes = job.bytes;
    let records = job.recordCount;
    for (const [offset, chunk] of a.chunks.entries()) {
      if (chunk.index !== job.chunkCount + offset) throw new Error('BACKUP_CHUNK_SEQUENCE');
      bytes += chunk.bytes;
      records += chunk.count;
      await ctx.db.insert('backupLargeChunks', { ...chunk, jobId: job._id });
    }
    if (bytes > MAX_ARCHIVE_BYTES || job.chunkCount + a.chunks.length > MAX_CHUNKS)
      throw new Error('SELECTIVE_ARCHIVE_BUDGET');
    // Seen markers and dependency work are transactional with the storage descriptors.
    for (const deferred of a.page.deferred ?? []) {
      const existing = await ctx.db
        .query('backupLargeRows')
        .withIndex('job_source', (q) => q.eq('jobId', job._id).eq('sourceId', deferred.sourceId))
        .unique();
      if (!existing) throw new Error('BACKUP_CHECKPOINT_CHANGED');
      await ctx.db.patch(existing._id, {
        state: 'DEFERRED',
        metadata: {
          ...existing.metadata,
          reason: deferred.reason,
          ownerGlobalId: deferred.ownerGlobalId ?? null,
        },
      });
    }
    for (const e of a.page.rows as ArchiveEnvelope[]) {
      const sourceId = e.kind === 'record' ? decodeRow(e.record)._id : e.sourceId;
      const existing = await ctx.db
        .query('backupLargeRows')
        .withIndex('job_source', (q) => q.eq('jobId', job._id).eq('sourceId', sourceId))
        .unique();
      if (existing) await ctx.db.patch(existing._id, { state: 'EMITTED' });
      else
        await ctx.db.insert('backupLargeRows', {
          jobId: job._id,
          role: 'SOURCE',
          table: a.page.table,
          sourceId,
          chunkIndex: job.chunkCount,
          rowIndex: 0,
          state: 'EMITTED',
          references: [],
          metadata: {},
        });
    }
    for (const e of a.page.rows as ArchiveEnvelope[]) {
      if (e.kind !== 'record') continue;
      const sourceOwner = rowOwner(decodeRow(e.record), job.metadata.selection);
      for (const reference of e.references) {
        const existing = await ctx.db
          .query('backupLargeRows')
          .withIndex('job_source', (q) => q.eq('jobId', job._id).eq('sourceId', reference.id))
          .unique();
        const requestingOwners = [
          ...new Set([
            ...(existing?.metadata.requestingOwners ?? []),
            ...(sourceOwner ? [sourceOwner.agentGlobalId] : []),
          ]),
        ];
        if (!existing)
          await ctx.db.insert('backupLargeRows', {
            jobId: job._id,
            role: 'SOURCE',
            table: reference.table,
            sourceId: reference.id,
            chunkIndex: -1,
            rowIndex: 0,
            state: 'QUEUED',
            references: [],
            metadata: { requestingOwners },
          });
        else if (
          existing.state === 'QUEUED' ||
          (existing.state === 'DEFERRED' &&
            existing.table === 'memories' &&
            existing.metadata.ownerGlobalId === sourceOwner?.agentGlobalId)
        )
          await ctx.db.patch(existing._id, {
            state: 'QUEUED',
            metadata: { ...existing.metadata, requestingOwners },
          });
      }
    }
    const scanDone =
      job.phase === 'SCANNING' && a.page.done && job.tableIndex + 1 === selectiveTables.length;
    await ctx.db.patch(job._id, {
      bytes,
      recordCount: records,
      chunkCount: job.chunkCount + a.chunks.length,
      processedChunks: job.chunkCount + a.chunks.length,
      cursor: job.phase === 'SCANNING' && !a.page.done ? a.page.cursor : null,
      tableIndex: job.phase === 'SCANNING' && a.page.done ? job.tableIndex + 1 : job.tableIndex,
      phase: scanDone
        ? 'CLOSURE'
        : job.phase === 'CLOSURE' && a.page.done
          ? 'REFERENCE_MAPPINGS'
          : job.phase === 'REFERENCE_MAPPINGS' && a.page.done
            ? 'SIGNING'
            : job.phase,
      updatedAt: Date.now(),
    });
  },
});
export const signingData = internalQuery({
  args: { jobId: v.id('backupLargeJobs'), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    const local = await stable(ctx);
    if (local.fingerprint !== job.source.fingerprint) throw new Error('BACKUP_IDENTITY_CHANGED');
    return {
      local,
      chunks: await ctx.db
        .query('backupLargeChunks')
        .withIndex('job_index', (q) => q.eq('jobId', job._id))
        .paginate({ cursor: a.cursor, numItems: 200 }),
    };
  },
});
export const finish = internalMutation({
  args: { jobId: v.id('backupLargeJobs'), storageId: v.id('_storage'), signature: v.string() },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (job.state !== 'RUNNING' || job.phase !== 'SIGNING')
      throw new Error('BACKUP_CHECKPOINT_CHANGED');
    await ctx.db.patch(job._id, {
      manifestStorageId: a.storageId,
      signature: a.signature,
      state: 'COMPLETE',
      phase: 'COMPLETE',
      updatedAt: Date.now(),
    });
    const lock = await ctx.db
      .query('backupMaintenanceLocks')
      .withIndex('key', (q) => q.eq('key', 'town'))
      .unique();
    await ctx.db.delete(lock!._id);
  },
});
export const fail = internalMutation({
  args: { jobId: v.id('backupLargeJobs'), error: v.string() },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (!terminal.has(job.state))
      await ctx.db.patch(job._id, {
        state: 'FAILED',
        error: a.error.slice(0, 1000),
        updatedAt: Date.now(),
      });
  },
});
export const resume = mutation({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    const job = await owned(ctx, a.jobId);
    await stable(ctx);
    if (job.state !== 'FAILED') throw new Error('BACKUP_JOB_NOT_FAILED');
    await ctx.db.patch(job._id, { state: 'RUNNING', error: undefined, updatedAt: Date.now() });
  },
});
export const cancel = mutation({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    const job = await owned(ctx, a.jobId);
    if (terminal.has(job.state)) return;
    await ctx.db.patch(job._id, { state: 'CANCELLED', phase: 'CANCELLED', updatedAt: Date.now() });
    const lock = await ctx.db
      .query('backupMaintenanceLocks')
      .withIndex('key', (q) => q.eq('key', 'town'))
      .unique();
    await ctx.db.delete(lock!._id);
  },
});
export const advanceExport = action({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    let job: Job = await ctx.runQuery(refQ('jobData'), { jobId: a.jobId });
    if (terminal.has(job.state)) return view(job);
    if (job.state === 'FAILED') throw new Error('RESUME_BACKUP_JOB_FIRST');
    const created: Id<'_storage'>[] = [];
    try {
      if (job.phase === 'SIGNING') {
        const chunks: ChunkDescriptor[] = [];
        let cursor: string | null = null;
        let privateKey = '';
        do {
          const result: {
            local: Doc<'federationIdentity'>;
            chunks: { page: Doc<'backupLargeChunks'>[]; isDone: boolean; continueCursor: string };
          } = await ctx.runQuery(refQ('signingData'), { jobId: a.jobId, cursor });
          privateKey = result.local.privateKeyEncrypted;
          chunks.push(
            ...result.chunks.page.map(
              ({ index, table, count, bytes, digest }: ChunkDescriptor) => ({
                index,
                table,
                count,
                bytes,
                digest,
              }),
            ),
          );
          cursor = result.chunks.isDone ? null : result.chunks.continueCursor;
        } while (cursor);
        const manifest: SelectiveManifest = {
          format: 'ai-town-selective-archive',
          version: 2,
          schemaVersion: 1,
          exportId: job._id,
          source: job.source,
          exportedAt: job.createdAt,
          scope: job.metadata.selection.scope,
          selection: job.metadata.selection,
          includeVectors: false,
          usage: 'selective-transfer',
          operator: job.metadata.operator,
          reason: job.metadata.reason,
          chunks,
        };
        const signature = await sign(manifest, privateKey);
        await validateSelectiveManifest(manifest, signature);
        const storageId = await ctx.storage.store(
          new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
        );
        created.push(storageId);
        await ctx.runMutation(refM('finish'), { jobId: job._id, storageId, signature });
      } else {
        const page = await ctx.runQuery(refQ('page'), { jobId: a.jobId });
        const groups: string[][] = [];
        let current: string[] = [];
        for (const row of page.rows) {
          const encoded = encodeRow(row);
          if (
            current.length &&
            size({
              index: job.chunkCount + groups.length,
              table: page.table,
              rows: [...current, encoded],
            }) > TARGET_CHUNK_BYTES
          ) {
            groups.push(current);
            current = [];
          }
          current.push(encoded);
        }
        if (current.length) groups.push(current);
        const chunks = [];
        for (const [offset, rows] of groups.entries()) {
          const chunk: LargeChunk = { index: job.chunkCount + offset, table: page.table, rows };
          if (size(chunk) > MAX_CHUNK_BYTES) throw new Error('BACKUP_SINGLE_DOCUMENT_BUDGET');
          const storageId = await ctx.storage.store(
            new Blob([JSON.stringify(chunk)], { type: 'application/json' }),
          );
          created.push(storageId);
          chunks.push({ ...(await descriptor(chunk)), storageId });
        }
        await ctx.runMutation(refM('savePage'), {
          jobId: job._id,
          expectedPhase: job.phase,
          expectedCursor: job.cursor,
          expectedTableIndex: job.tableIndex,
          expectedChunkCount: job.chunkCount,
          page,
          chunks,
        });
      }
    } catch (error) {
      for (const id of created) await ctx.storage.delete(id);
      if (!String(error).includes('BACKUP_CHECKPOINT_CHANGED'))
        await ctx.runMutation(refM('fail'), { jobId: a.jobId, error: String(error) });
    }
    job = await ctx.runQuery(refQ('jobData'), { jobId: a.jobId });
    return view(job);
  },
});
export const chunkData = internalQuery({
  args: { jobId: v.id('backupLargeJobs'), index: v.number() },
  handler: async (ctx, a) => {
    const job = await owned(ctx, a.jobId);
    if (job.state !== 'COMPLETE') throw new Error('BACKUP_MANIFEST_NOT_READY');
    return ctx.db
      .query('backupLargeChunks')
      .withIndex('job_index', (q) => q.eq('jobId', a.jobId).eq('index', a.index))
      .unique();
  },
});
export const getManifest = action({
  args,
  handler: async (ctx, a): Promise<{ manifest: SelectiveManifest; signature: string }> => {
    requireAdmin(a.adminToken);
    const job: Job = await ctx.runQuery(refQ('jobData'), { jobId: a.jobId });
    if (job.state !== 'COMPLETE' || !job.manifestStorageId || !job.signature)
      throw new Error('BACKUP_MANIFEST_NOT_READY');
    const blob = await ctx.storage.get(job.manifestStorageId);
    if (!blob) throw new Error('BACKUP_CHUNK_STORAGE_MISSING');
    return { manifest: JSON.parse(await blob.text()), signature: job.signature };
  },
});
export const getChunk = action({
  args: { ...args, index: v.number() },
  handler: async (ctx, a): Promise<string> => {
    requireAdmin(a.adminToken);
    const chunk = await ctx.runQuery(refQ('chunkData'), { jobId: a.jobId, index: a.index });
    if (!chunk) throw new Error('BACKUP_CHUNK_NOT_FOUND');
    const blob = await ctx.storage.get(chunk.storageId);
    if (!blob) throw new Error('BACKUP_CHUNK_STORAGE_MISSING');
    return blob.text();
  },
});
