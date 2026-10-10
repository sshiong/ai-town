import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import {
  action,
  internalMutation,
  internalAction,
  internalQuery,
  mutation,
  query,
  MutationCtx,
  DatabaseReader,
} from '../_generated/server';
import { Doc, Id, TableNames } from '../_generated/dataModel';
import { assertTownUnlocked } from './maintenanceLock';
import { assertNoIdentityConflict } from './identityConflict';
import { requireAdmin, digest } from './security';
import { BackupRow, decodeRow, encodeRow, stripSystem } from './backupHelpers';
import {
  ChunkDescriptor,
  LargeChunk,
  MAX_ARCHIVE_BYTES,
  MAX_CHUNKS,
  MAX_CHUNK_BYTES,
  TARGET_CHUNK_BYTES,
  oldTables,
  descriptor,
  size,
  validateSourceRow,
} from './backupLargeHelpers';
import {
  ArchiveEnvelope,
  SelectiveManifest,
  configTables,
  historyTables,
  residentTables,
  rowOwner,
  inBounds,
  validateSelectiveChunk,
  validateSelectiveManifest,
} from './backupSelectiveHelpers';
import {
  Options,
  TargetOwner,
  allocationFields,
  canonicalFields,
  importOptions,
  key,
  validateOptions,
} from './backupSelectiveImportHelpers';
import { configuredResourceLimits } from './resources';
import { validateConnection } from '../models/profiles';
import { WorldMap } from '../aiTown/worldMap';
import { blockedWithPositions } from '../aiTown/movement';
import { Point } from '../util/types';
import { ACTION_TIMEOUT } from '../constants';

type Job = Doc<'backupLargeJobs'>;
type Row = Doc<'backupLargeRows'>;
type RecordEnvelope = Extract<ArchiveEnvelope, { kind: 'record' }>;
type Metadata = {
  options: Options;
  selection: SelectiveManifest['selection'];
  uploaded: number;
  exportedAt: number;
  plannedMemories: number;
  vectorBytesEstimate?: number;
  embeddingCallsEstimate?: number;
  oldChunks: number;
  oldBytes: number;
  snapshotDigest: string;
  planDigest?: string;
  targetOwners: TargetOwner[];
  created: number;
  replaced: number;
  skipped: number;
  externalEdgesSkipped: number;
  rebuildCount: number;
  destructive: boolean;
  indexState: string;
  indexError?: string;
};
const metadata = (j: Job) => j.metadata as Metadata;
const table = (s: string) => s as TableNames;
const args = { adminToken: v.string(), jobId: v.id('backupLargeJobs') };
const qref = (s: string) => makeFunctionReference<'query'>(`federation/backupSelectiveImport:${s}`);
const mref = (s: string) =>
  makeFunctionReference<'mutation'>(`federation/backupSelectiveImport:${s}`);
const aref = (s: string) =>
  makeFunctionReference<'action'>(`federation/backupSelectiveImport:${s}`);
const terminal = new Set(['COMPLETE', 'CANCELLED']);
const archivalTables = new Set([
  'visitLedger',
  'federationActionFacts',
  'federationEventFacts',
  'autonomousTravelDecisions',
  'autonomousTravelPolicies',
]);
const captureTables = [...oldTables, 'federationIdentity'] as const;
const canonicalTables = new Set([
  'playerDescriptions',
  'agentDescriptions',
  'archivedPlayers',
  'archivedAgents',
  'archivedConversations',
  'messages',
  'participatedTogether',
  'memories',
  'homeTravelTranscripts',
  'homeTravelTranscriptPages',
]);
function view(j: Job) {
  const m = metadata(j);
  return {
    jobId: j._id,
    state: j.state,
    phase: j.phase,
    error: j.error,
    selection: m.selection,
    options: m.options,
    targetOwners: m.targetOwners,
    uploadedChunks: m.uploaded,
    chunkCount: j.chunkCount,
    recordCount: j.recordCount,
    bytes: j.bytes,
    planDigest: m.planDigest,
    targetDigest: m.snapshotDigest,
    report: {
      created: m.created,
      replaced: m.replaced,
      skipped: m.skipped,
      externalEdgesSkipped: m.externalEdgesSkipped,
      rebuildCount: m.rebuildCount,
      indexState: m.indexState,
      indexError: m.indexError,
      rawBytesEstimate: j.bytes,
      vectorStorageBytesEstimate: m.vectorBytesEstimate ?? null,
      embeddingCallsEstimate: m.embeddingCallsEstimate ?? null,
      plannedMemories: m.plannedMemories,
      profiles: m.options.profiles,
      sourceTownId: j.source.townId as string,
      runtimePolicy: 'NO_ACTIVE_SNAPSHOT_REPLAY' as const,
    },
  };
}
async function owned(ctx: { db: DatabaseReader }, id: Id<'backupLargeJobs'>) {
  const j = await ctx.db.get(id);
  if (!j || j.kind !== 'import' || j.mode !== 'selective-import')
    throw new Error('SELECTIVE_IMPORT_JOB_NOT_FOUND');
  if (!terminal.has(j.state)) {
    const lock = await ctx.db
      .query('backupMaintenanceLocks')
      .withIndex('key', (q) => q.eq('key', 'town'))
      .unique();
    if (lock?.jobId !== j._id) throw new Error('BACKUP_MAINTENANCE_LOCK_LOST');
  }
  return j;
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
        q.and(
          q.neq(q.field('state'), 'COMPLETED'),
          q.neq(q.field('state'), 'REJECTED'),
          q.neq(q.field('state'), 'CANCELLED'),
        ),
      )
      .first()
  )
    throw new Error('RECONCILE_TARGET_VISITS_FIRST');
  if (
    await ctx.db
      .query('federationLlmRequests')
      .filter((q) => q.gt(q.field('expiresAt'), Date.now()))
      .first()
  )
    throw new Error('DRAIN_TARGET_WORK_BEFORE_SELECTIVE_IMPORT');
  return local;
}
async function source(
  ctx: { db: DatabaseReader },
  j: Job,
  id: string,
  role: 'SOURCE' | 'OLD' = 'SOURCE',
) {
  return ctx.db
    .query('backupLargeRows')
    .withIndex('job_role_source', (q) => q.eq('jobId', j._id).eq('role', role).eq('sourceId', id))
    .unique();
}
async function putMap(ctx: MutationCtx, j: Job, mapKey: string, targetId: string) {
  const existing = await ctx.db
    .query('backupLargeGlobalMappings')
    .withIndex('job_source', (q) => q.eq('jobId', j._id).eq('sourceId', mapKey))
    .unique();
  if (existing && existing.targetId !== targetId)
    throw new Error('SELECTIVE_IMPORT_MAPPING_CONFLICT');
  if (!existing)
    await ctx.db.insert('backupLargeGlobalMappings', { jobId: j._id, sourceId: mapKey, targetId });
}
async function getMap(ctx: { db: DatabaseReader }, j: Job, mapKey: string) {
  return (
    await ctx.db
      .query('backupLargeGlobalMappings')
      .withIndex('job_source', (q) => q.eq('jobId', j._id).eq('sourceId', mapKey))
      .unique()
  )?.targetId;
}
async function journal(ctx: MutationCtx, j: Job, name: string, targetId: string) {
  await ctx.db.insert('backupSelectiveJournal', { jobId: j._id, table: name, targetId });
}
async function targetProof(ctx: { db: DatabaseReader }, worldId: Id<'worlds'>, globalId: string) {
  const local = await stable(ctx);
  const binding = await ctx.db
    .query('residentModelBindings')
    .withIndex('globalAgent', (q) => q.eq('agentGlobalId', globalId))
    .unique();
  const runtime = await ctx.db
    .query('federationAgentRuntimes')
    .withIndex('globalId', (q) => q.eq('agentGlobalId', globalId))
    .unique();
  const world = await ctx.db.get(worldId);
  const agent = world?.agents.find((a) => a.playerId === binding?.playerId);
  if (
    !binding ||
    binding.worldId !== worldId ||
    !runtime ||
    runtime.homeTownId !== local.townId ||
    runtime.worldId !== worldId ||
    runtime.playerId !== binding.playerId ||
    runtime.agentId !== agent?.id ||
    runtime.state !== 'HOME_ACTIVE' ||
    runtime.visitId ||
    runtime.activeDecisionId ||
    !world?.players.some((p) => p.id === binding.playerId && !p.human && !p.remoteVisitor)
  )
    throw new Error('SELECTIVE_IMPORT_TARGET_OWNER_PROOF_REQUIRED');
  if (
    world.conversations.some((c) => c.participants.some((p) => p.playerId === binding.playerId)) ||
    agent?.toRemember ||
    agent?.queuedConversations?.length ||
    (agent?.inProgressOperation && agent.inProgressOperation.started + ACTION_TIMEOUT > Date.now())
  )
    throw new Error('DRAIN_TARGET_WORK_BEFORE_SELECTIVE_IMPORT');
  return { binding, runtime, world, agent: agent! };
}
async function allocateLocalId(
  ctx: { db: DatabaseReader },
  world: Doc<'worlds'>,
  kind: 'player' | 'agent' | 'conversation',
  start: number,
) {
  if (!Number.isSafeInteger(start) || start < 0)
    throw new Error('SELECTIVE_IMPORT_INVALID_NEXT_ID');
  const prefix = kind === 'player' ? 'p' : kind === 'agent' ? 'a' : 'c';
  for (let next = start; next < start + 1000 && Number.isSafeInteger(next + 1); next++) {
    const id = `${prefix}:${next}`;
    const live =
      kind === 'player' ? world.players : kind === 'agent' ? world.agents : world.conversations;
    if (live.some((row) => row.id === id)) continue;
    const archived =
      kind === 'player'
        ? await ctx.db
            .query('archivedPlayers')
            .withIndex('worldId', (q) => q.eq('worldId', world._id).eq('id', id))
            .first()
        : kind === 'agent'
          ? await ctx.db
              .query('archivedAgents')
              .withIndex('worldId', (q) => q.eq('worldId', world._id).eq('id', id))
              .first()
          : await ctx.db
              .query('archivedConversations')
              .withIndex('worldId', (q) => q.eq('worldId', world._id).eq('id', id))
              .first();
    if (!archived) return { id, next: next + 1 };
  }
  throw new Error('SELECTIVE_IMPORT_LOCAL_ID_BUDGET');
}
export const createImportJob = internalMutation({
  args: {
    adminToken: v.string(),
    manifest: v.any(),
    signature: v.string(),
    manifestStorageId: v.id('_storage'),
    ...importOptions,
  },
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    await assertTownUnlocked(ctx);
    await assertNoIdentityConflict(ctx);
    const local = await stable(ctx);
    const manifest = a.manifest as SelectiveManifest;
    await validateSelectiveManifest(manifest, a.signature);
    if (manifest.version !== 2 || manifest.usage !== 'selective-transfer')
      throw new Error('SELECTIVE_READ_ONLY_ARCHIVE_NOT_IMPORTABLE');
    if (manifest.source.mode === 'QUARANTINED') throw new Error('TOWN_CLONE_CONFLICT');
    const options: Options = {
      mode: a.mode,
      owners: a.owners,
      profiles: a.profiles,
      externalReferences: a.externalReferences,
      configuration: a.configuration,
      worlds: a.worlds,
      sourceStopped: a.sourceStopped,
      operator: a.operator.trim(),
      reason: a.reason.trim(),
    };
    validateOptions(options, manifest.selection);
    if (
      manifest.selection.owners.some(
        (o) =>
          o.agentGlobalId !== `${manifest.source.townId as string}/agent:${o.worldId}:${o.agentId}`,
      )
    )
      throw new Error('SELECTIVE_IMPORT_SOURCE_HOME_IDENTITY_MISMATCH');
    if (
      options.mode === 'restore' &&
      (!options.sourceStopped ||
        local.townId !== manifest.source.townId ||
        local.publicKey !== manifest.source.publicKey ||
        local.fingerprint !== manifest.source.fingerprint)
    )
      throw new Error('RESTORE_IDENTITY_PROOF_REQUIRED');
    const targetOwners: TargetOwner[] = [];
    const usedTargets = new Set<string>();
    const sourceWorldTargets = new Map<string, string>();
    const nextIds = new Map<string, number>();
    for (const mapping of options.owners) {
      const owner = manifest.selection.owners.find(
        (o) => o.agentGlobalId === mapping.sourceAgentGlobalId,
      )!;
      if (mapping.operation === 'skip') continue;
      const previousWorldTarget = sourceWorldTargets.get(owner.worldId);
      if (previousWorldTarget && previousWorldTarget !== mapping.targetWorldId)
        throw new Error('SELECTIVE_IMPORT_SHARED_WORLD_MAPPING_CONFLICT');
      sourceWorldTargets.set(owner.worldId, mapping.targetWorldId!);
      const world = await ctx.db.get(mapping.targetWorldId!);
      const status = await ctx.db
        .query('worldStatus')
        .withIndex('worldId', (q) => q.eq('worldId', mapping.targetWorldId!))
        .unique();
      if (!world || !status || status.status !== 'stoppedByDeveloper')
        throw new Error('SELECTIVE_IMPORT_TARGET_WORLD_REQUIRED');
      const engine = await ctx.db.get(status.engineId);
      if (
        !engine ||
        (await ctx.db
          .query('inputs')
          .withIndex('byInputNumber', (q) =>
            q.eq('engineId', engine._id).gt('number', engine.processedInputNumber ?? -1),
          )
          .first())
      )
        throw new Error('DRAIN_TARGET_WORK_BEFORE_SELECTIVE_IMPORT');
      let target: TargetOwner;
      if (mapping.operation === 'clone') {
        const player = await allocateLocalId(
          ctx,
          world,
          'player',
          nextIds.get(world._id) ?? world.nextId,
        );
        const agent = await allocateLocalId(ctx, world, 'agent', player.next);
        const playerId = player.id,
          agentId = agent.id;
        nextIds.set(world._id, agent.next);
        target = {
          sourceAgentGlobalId: owner.agentGlobalId,
          operation: 'clone',
          worldId: world._id,
          playerId,
          agentId,
          agentGlobalId: `${local.townId}/agent:${world._id}:${agentId}`,
        };
      } else {
        const proof = await targetProof(ctx, mapping.targetWorldId!, mapping.targetAgentGlobalId!);
        if (
          mapping.operation === 'restore' &&
          (owner.agentGlobalId !== mapping.targetAgentGlobalId ||
            owner.playerId !== proof.binding.playerId ||
            owner.agentId !== proof.agent.id)
        )
          throw new Error('SELECTIVE_IMPORT_RESTORE_OWNER_MISMATCH');
        target = {
          sourceAgentGlobalId: owner.agentGlobalId,
          operation: mapping.operation,
          worldId: world._id,
          playerId: proof.binding.playerId,
          agentId: proof.agent.id,
          agentGlobalId: mapping.targetAgentGlobalId!,
          chatProfileId: proof.binding.chatProfileId,
        };
      }
      if (usedTargets.has(target.agentGlobalId))
        throw new Error('SELECTIVE_IMPORT_DUPLICATE_TARGET_OWNER');
      usedTargets.add(target.agentGlobalId);
      targetOwners.push(target);
    }
    const limits = await configuredResourceLimits(ctx.db);
    const residentCount = (await ctx.db.query('federationAgentRuntimes').take(1001)).length;
    if (
      residentCount + targetOwners.filter((o) => o.operation === 'clone').length >
      limits.maxResidentAgents
    )
      throw new Error('SELECTIVE_IMPORT_RESIDENT_CAPACITY_EXCEEDED');
    const now = Date.now();
    const jobId = await ctx.db.insert('backupLargeJobs', {
      kind: 'import',
      mode: 'selective-import',
      state: 'STAGING',
      phase: 'STAGING',
      tableIndex: 0,
      cursor: null,
      chunkCount: manifest.chunks.length,
      processedChunks: 0,
      recordCount: manifest.chunks.reduce((n, c) => n + c.count, 0),
      bytes: manifest.chunks.reduce((n, c) => n + c.bytes, 0),
      createdAt: now,
      updatedAt: now,
      source: manifest.source,
      manifestStorageId: a.manifestStorageId,
      signature: a.signature,
      metadata: {
        options,
        selection: manifest.selection,
        uploaded: 0,
        exportedAt: manifest.exportedAt,
        plannedMemories: 0,
        oldChunks: 0,
        oldBytes: 0,
        snapshotDigest: '',
        targetOwners,
        created: 0,
        replaced: 0,
        skipped: 0,
        externalEdgesSkipped: 0,
        rebuildCount: 0,
        destructive: false,
        indexState: 'REBUILD_REQUIRED',
      } satisfies Metadata,
    });
    await ctx.db.insert('backupMaintenanceLocks', { key: 'town', jobId, createdAt: now });
    return { jobId };
  },
});
export const createImport = action({
  args: { adminToken: v.string(), manifest: v.any(), signature: v.string(), ...importOptions },
  handler: async (ctx, a): Promise<{ jobId: Id<'backupLargeJobs'> }> => {
    requireAdmin(a.adminToken);
    await validateSelectiveManifest(a.manifest as SelectiveManifest, a.signature);
    const manifestStorageId = await ctx.storage.store(
      new Blob([JSON.stringify(a.manifest)], { type: 'application/json' }),
    );
    // Preserve the manifest if publication acknowledgement is unknown.
    return await ctx.runMutation(mref('createImportJob'), { ...a, manifestStorageId });
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
        .filter((q) => q.eq(q.field('mode'), 'selective-import'))
        .order('desc')
        .take(30)
    ).map(view);
  },
});
export const importTargets = query({
  args: { adminToken: v.string() },
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    const worlds = await ctx.db.query('worldStatus').take(101);
    if (worlds.length > 100) throw new Error('SELECTIVE_IMPORT_TARGET_WORLD_BUDGET');
    return worlds.map((w) => ({ worldId: w.worldId, status: w.status, isDefault: w.isDefault }));
  },
});
export const jobData = internalQuery({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => owned(ctx, a.jobId),
});
export const saveChunk = internalMutation({
  args: {
    jobId: v.id('backupLargeJobs'),
    chunkJson: v.string(),
    expected: v.any(),
    storageId: v.id('_storage'),
  },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId),
      m = metadata(j);
    if (j.phase !== 'STAGING') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const chunk = JSON.parse(a.chunkJson) as LargeChunk;
    const existing = await ctx.db
      .query('backupLargeChunks')
      .withIndex('job_index', (q) => q.eq('jobId', j._id).eq('index', chunk.index))
      .unique();
    if (existing) {
      if (existing.digest !== (a.expected as ChunkDescriptor).digest)
        throw new Error('BACKUP_CHUNK_CONFLICT');
      return false;
    }
    const envelopes = await validateSelectiveChunk(chunk, a.expected as ChunkDescriptor);
    for (const [rowIndex, e] of envelopes.entries()) {
      const id = e.kind === 'record' ? (decodeRow(e.record)._id as string) : e.sourceId;
      if (await source(ctx, j, id)) throw new Error('DUPLICATE_BACKUP_DOCUMENT_ID');
      const row = e.kind === 'record' ? decodeRow(e.record) : null;
      if (
        row &&
        chunk.table === 'federationIdentity' &&
        (await digest(row)) !== (await digest(j.source))
      )
        throw new Error('BACKUP_IDENTITY_MISMATCH');
      if (row && ['chatProfiles', 'embeddingProfiles'].includes(chunk.table))
        validateConnection(row as never);
      await ctx.db.insert('backupLargeRows', {
        jobId: j._id,
        role: 'SOURCE',
        table: e.kind === 'record' ? chunk.table : e.table,
        sourceId: id,
        chunkIndex: chunk.index,
        rowIndex,
        state: e.kind === 'record' ? 'STAGED' : 'EXTERNAL',
        references: e.kind === 'record' ? e.references : [],
        metadata: { envelope: e },
        ownerGlobalId: row ? rowOwner(row, m.selection)?.agentGlobalId : undefined,
      });
    }
    await ctx.db.insert('backupLargeChunks', {
      jobId: j._id,
      ...(a.expected as ChunkDescriptor),
      storageId: a.storageId,
    });
    await ctx.db.patch(j._id, {
      metadata: { ...m, uploaded: m.uploaded + 1 },
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const stageChunk = action({
  args: { ...args, chunk: v.string() },
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    const j: Job = await ctx.runQuery(qref('jobData'), { jobId: a.jobId });
    if (size(a.chunk) > MAX_CHUNK_BYTES + 200000) throw new Error('SELECTIVE_IMPORT_CHUNK_BUDGET');
    const blob = await ctx.storage.get(j.manifestStorageId!);
    if (!blob) throw new Error('BACKUP_CHUNK_STORAGE_MISSING');
    const manifest = JSON.parse(await blob.text()) as SelectiveManifest;
    const chunk = JSON.parse(a.chunk) as LargeChunk;
    const expected = manifest.chunks[chunk.index];
    if (!expected) throw new Error('LARGE_BACKUP_CHUNK_MISMATCH');
    await validateSelectiveChunk(chunk, expected);
    const storageId = await ctx.storage.store(new Blob([a.chunk], { type: 'application/json' }));
    // Only a confirmed duplicate rejection makes this newly uploaded object disposable.
    if (
      !(await ctx.runMutation(mref('saveChunk'), {
        jobId: j._id,
        chunkJson: a.chunk,
        expected,
        storageId,
      }))
    )
      await ctx.storage.delete(storageId);
    return view(await ctx.runQuery(qref('jobData'), { jobId: j._id }));
  },
});

function record(r: Row) {
  return (r.metadata as { envelope: RecordEnvelope }).envelope;
}
function data(r: Row) {
  return decodeRow(record(r).record);
}
async function ownersFor(ctx: { db: DatabaseReader }, j: Job, r: Row): Promise<string[]> {
  const m = metadata(j),
    row = data(r),
    envelope = record(r);
  const owner = rowOwner(row, m.selection);
  if (owner) return [owner.agentGlobalId];
  if (['playerDescriptions', 'archivedPlayers'].includes(r.table))
    return m.selection.owners
      .filter((o) => o.worldId === row.worldId && o.playerId === (row.playerId ?? row.id))
      .map((o) => o.agentGlobalId);
  if (['agentDescriptions', 'archivedAgents'].includes(r.table))
    return m.selection.owners
      .filter((o) => o.worldId === row.worldId && o.agentId === (row.agentId ?? row.id))
      .map((o) => o.agentGlobalId);
  if (['federationActionFacts', 'federationEventFacts'].includes(r.table)) {
    const visitRef = r.references.find((ref) => ref.table === 'visitLedger');
    const visit = visitRef && (await source(ctx, j, visitRef.id));
    return visit ? ownersFor(ctx, j, visit) : [];
  }
  const participants =
    r.table === 'archivedConversations'
      ? (row.participants as string[])
      : r.table === 'participatedTogether'
        ? [row.player1 as string, row.player2 as string]
        : (envelope.conversationContext?.participants ?? []);
  return m.selection.owners
    .filter((o) => o.worldId === row.worldId && participants.includes(o.playerId))
    .map((o) => o.agentGlobalId);
}
async function checkRecord(ctx: { db: DatabaseReader }, j: Job, r: Row) {
  const m = metadata(j),
    row = data(r),
    e = record(r),
    scope = m.selection.scope;
  const owners = await ownersFor(ctx, j, r);
  const privateRow =
    r.table === 'memories' ||
    archivalTables.has(r.table) ||
    [
      'residentModelBindings',
      'agentDescriptions',
      'federationAgentRuntimes',
      'homeTravelTranscripts',
      'homeTravelTranscriptPages',
    ].includes(r.table);
  if (privateRow && !owners.length) throw new Error('SELECTIVE_IMPORT_SOURCE_OWNER_MISMATCH');
  if (
    scope !== 'config-only' &&
    ((r.table === 'chatProfiles' && !m.selection.owners.some((o) => o.chatProfileId === row._id)) ||
      (r.table === 'maps' && !m.selection.owners.some((o) => o.worldId === row.worldId)) ||
      (r.table === 'worlds' && !m.selection.owners.some((o) => o.worldId === row._id)) ||
      ((configTables as readonly string[]).includes(r.table) &&
        !['chatProfiles', 'maps', 'worlds', 'federationIdentity'].includes(r.table)) ||
      ((residentTables as readonly string[]).includes(r.table) && !owners.length) ||
      ((historyTables as readonly string[]).includes(r.table) && !owners.length))
  )
    throw new Error('SELECTIVE_IMPORT_DEPENDENCY_SCOPE_MISMATCH');
  if (r.table === 'worlds') {
    if (
      row.conversations.length ||
      row.players.some(
        (p: BackupRow) =>
          p.human ||
          p.remoteVisitor ||
          !m.selection.owners.some((o) => o.worldId === row._id && o.playerId === p.id),
      ) ||
      row.agents.some(
        (a: BackupRow) =>
          !m.selection.owners.some(
            (o) => o.worldId === row._id && o.agentId === a.id && o.playerId === a.playerId,
          ),
      )
    )
      throw new Error('SELECTIVE_IMPORT_SOURCE_WORLD_SCOPE_MISMATCH');
  }
  if (r.table === 'residentModelBindings') {
    const owner = m.selection.owners.find((o) => o.agentGlobalId === row.agentGlobalId);
    if (!owner || owner.chatProfileId !== row.chatProfileId)
      throw new Error('SELECTIVE_IMPORT_SOURCE_BINDING_MISMATCH');
  }
  if (
    r.table === 'federationAgentRuntimes' &&
    (row.homeTownId !== j.source.townId ||
      row.agentId !==
        m.selection.owners.find((o) => o.agentGlobalId === row.agentGlobalId)?.agentId ||
      row.state !== 'HOME_ACTIVE' ||
      row.visitId ||
      row.activeDecisionId)
  )
    throw new Error('SELECTIVE_IMPORT_ACTIVE_RUNTIME_FORBIDDEN');
  if (e.conversationContext) {
    const c = e.conversationContext;
    if (
      c.worldId !== row.worldId ||
      !m.selection.owners.some(
        (o) => o.worldId === c.worldId && c.participants.includes(o.playerId),
      ) ||
      (r.table === 'messages' &&
        (row.conversationId !== c.id || !c.participants.includes(row.author)))
    )
      throw new Error('SELECTIVE_IMPORT_CONVERSATION_OWNER_MISMATCH');
  }
  if (e.publicParticipants?.some((p) => p.worldId !== row.worldId))
    throw new Error('SELECTIVE_IMPORT_PUBLIC_CONTEXT_WORLD_MISMATCH');
  if (e.role === 'primary') {
    if ((residentTables as readonly string[]).includes(r.table) && !owners.length)
      throw new Error('SELECTIVE_IMPORT_PRIMARY_OWNER_MISMATCH');
    if (scope === 'config-only') {
      if (!(configTables as readonly string[]).includes(r.table))
        throw new Error('SELECTIVE_IMPORT_PRIMARY_SCOPE_MISMATCH');
    } else if (r.table === 'memories') {
      if (
        scope === 'history' ||
        !m.selection.categories.includes(row.data.type) ||
        !inBounds(r.table, row, m.selection)
      )
        throw new Error('SELECTIVE_IMPORT_PRIMARY_SCOPE_MISMATCH');
    } else if ((historyTables as readonly string[]).includes(r.table)) {
      const category =
        r.table === 'participatedTogether'
          ? 'social'
          : ['messages', 'archivedConversations'].includes(r.table)
            ? 'conversation'
            : 'travel';
      if (
        scope === 'memories-only' ||
        !owners.length ||
        !m.selection.categories.includes(category) ||
        !inBounds(r.table, row, m.selection)
      )
        throw new Error('SELECTIVE_IMPORT_PRIMARY_SCOPE_MISMATCH');
    } else if (
      r.table !== 'federationIdentity' &&
      (!['agent-one', 'agents-selected'].includes(scope) ||
        (!['worlds', 'maps'].includes(r.table) &&
          !(residentTables as readonly string[]).includes(r.table)))
    )
      throw new Error('SELECTIVE_IMPORT_PRIMARY_SCOPE_MISMATCH');
  }
  for (const required of validateSourceRow(r.table, row))
    if (!r.references.some((ref) => ref.id === required.id && ref.table === required.table))
      throw new Error('SELECTIVE_IMPORT_UNDECLARED_REFERENCE');
  for (const ref of r.references) {
    const target = await source(ctx, j, ref.id);
    if (!target || target.table !== ref.table)
      throw new Error('SELECTIVE_IMPORT_REFERENCE_MISSING');
    if (target.state === 'EXTERNAL' && ref.table !== 'memories')
      throw new Error('SELECTIVE_IMPORT_UNSUPPORTED_EXTERNAL_REFERENCE');
    if (
      ref.table === 'memories' &&
      (target.state === 'EXTERNAL' ||
        !m.targetOwners.some((owner) => owner.sourceAgentGlobalId === target.ownerGlobalId))
    )
      for (const owner of owners) {
        const policy = m.options.externalReferences.find(
          (p) => p.sourceId === ref.id && p.sourceAgentGlobalId === owner,
        );
        const targetOwner = m.targetOwners.find((o) => o.sourceAgentGlobalId === owner);
        if (!targetOwner) continue;
        if (!policy) throw new Error('SELECTIVE_IMPORT_EXTERNAL_MAPPING_REQUIRED');
        if (policy.operation === 'map') {
          const memory = await ctx.db.get(policy.targetId!);
          if (
            !memory ||
            memory.worldId !== targetOwner.worldId ||
            memory.playerId !== targetOwner.playerId ||
            (memory.agentGlobalId && memory.agentGlobalId !== targetOwner.agentGlobalId)
          )
            throw new Error('SELECTIVE_IMPORT_EXTERNAL_OWNER_MISMATCH');
        }
      }
  }
}
export const validatePage = internalMutation({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId),
      m = metadata(j);
    if (j.phase === 'STAGING') {
      if (m.uploaded !== j.chunkCount) throw new Error('BACKUP_UPLOAD_INCOMPLETE');
      await ctx.db.patch(j._id, { state: 'VALIDATING', phase: 'VALIDATING', cursor: null });
      return;
    }
    if (j.phase === 'VALIDATING') {
      const page = await ctx.db
        .query('backupLargeRows')
        .withIndex('job_role', (q) => q.eq('jobId', j._id).eq('role', 'SOURCE'))
        .paginate({ cursor: j.cursor, numItems: 20, maximumBytesRead: TARGET_CHUNK_BYTES });
      let plannedMemories = m.plannedMemories;
      for (const r of page.page) {
        if (r.state === 'EXTERNAL') continue;
        await checkRecord(ctx, j, r);
        if (
          r.table === 'memories' &&
          m.targetOwners.some((o) => o.sourceAgentGlobalId === r.ownerGlobalId)
        )
          plannedMemories++;
        await ctx.db.patch(r._id, { state: record(r).role === 'primary' ? 'ROOTED' : 'VERIFIED' });
      }
      await ctx.db.patch(j._id, {
        cursor: page.isDone ? null : page.continueCursor,
        phase: page.isDone ? 'REACHABILITY' : 'VALIDATING',
        metadata: { ...m, plannedMemories },
        updatedAt: Date.now(),
      });
      return;
    }
    if (j.phase !== 'REACHABILITY') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const rooted = await ctx.db
      .query('backupLargeRows')
      .withIndex('job_state', (q) => q.eq('jobId', j._id).eq('state', 'ROOTED'))
      .take(1);
    if (rooted.length) {
      const r = rooted[0];
      for (const ref of r.references) {
        const target = (await source(ctx, j, ref.id))!;
        // Another selected owner's primary record may be referenced, but its private
        // dependency must have an independent path from that owner's own primary data.
        if (
          target.state === 'VERIFIED' &&
          (ref.table !== 'memories' || (await ownersFor(ctx, j, r)).includes(target.ownerGlobalId!))
        )
          await ctx.db.patch(target._id, { state: 'ROOTED' });
      }
      await ctx.db.patch(r._id, { state: 'CHECKED' });
      return;
    }
    if (
      await ctx.db
        .query('backupLargeRows')
        .withIndex('job_state', (q) => q.eq('jobId', j._id).eq('state', 'VERIFIED'))
        .first()
    )
      throw new Error('SELECTIVE_IMPORT_ORPHAN_DEPENDENCY');
    for (const mapping of m.options.profiles) {
      const profile = await source(ctx, j, mapping.sourceId);
      if (!profile || profile.table !== 'chatProfiles' || profile.state === 'EXTERNAL')
        throw new Error('SELECTIVE_IMPORT_SOURCE_PROFILE_MISSING');
      if (mapping.operation === 'map' && !(await ctx.db.get(mapping.targetId!)))
        throw new Error('SELECTIVE_IMPORT_TARGET_PROFILE_MISSING');
    }
    for (const mapping of m.options.externalReferences) {
      const external = await source(ctx, j, mapping.sourceId);
      if (
        !external ||
        external.table !== 'memories' ||
        (external.state !== 'EXTERNAL' &&
          m.targetOwners.some((owner) => owner.sourceAgentGlobalId === external.ownerGlobalId))
      )
        throw new Error('SELECTIVE_IMPORT_EXTERNAL_MAPPING_INVALID');
    }
    const configuredWorldTargets = new Set<string>();
    for (const mapping of m.options.worlds) {
      const original = await source(ctx, j, mapping.sourceId);
      const world = await ctx.db.get(mapping.targetId);
      const status = await ctx.db
        .query('worldStatus')
        .withIndex('worldId', (q) => q.eq('worldId', mapping.targetId))
        .unique();
      if (
        !original ||
        original.table !== 'worlds' ||
        !world ||
        status?.status !== 'stoppedByDeveloper'
      )
        throw new Error('SELECTIVE_IMPORT_TARGET_WORLD_REQUIRED');
      if (configuredWorldTargets.has(mapping.targetId))
        throw new Error('SELECTIVE_IMPORT_DUPLICATE_TARGET_WORLD');
      configuredWorldTargets.add(mapping.targetId);
      if (mapping.importMap) {
        const maps = await ctx.db
          .query('backupLargeRows')
          .withIndex('job_table', (q) =>
            q.eq('jobId', j._id).eq('role', 'SOURCE').eq('table', 'maps'),
          )
          .take(101);
        if (maps.length > 100) throw new Error('SELECTIVE_IMPORT_SOURCE_MAP_BUDGET');
        const mapRow = maps.find((r) => data(r).worldId === mapping.sourceId);
        if (!mapRow) throw new Error('SELECTIVE_IMPORT_SOURCE_MAP_MISSING');
        const map = new WorldMap(data(mapRow) as never);
        if (world.players.some((p) => blockedWithPositions(p.position, [], map)))
          throw new Error('SELECTIVE_IMPORT_MAP_BLOCKS_EXISTING_PLAYER');
      }
    }
    if (m.options.configuration.includes('mainChatProfile')) {
      const settings = await ctx.db
        .query('backupLargeRows')
        .withIndex('job_table', (q) =>
          q.eq('jobId', j._id).eq('role', 'SOURCE').eq('table', 'modelSettings'),
        )
        .unique();
      const profileId = settings && data(settings).mainChatProfileId;
      if (
        !profileId ||
        !m.options.profiles.some((p) => p.sourceId === profileId && p.operation !== 'skip')
      )
        throw new Error('SELECTIVE_IMPORT_PROFILE_MAPPING_REQUIRED');
    }
    for (const owner of m.targetOwners)
      if (owner.operation !== 'merge') {
        const original = m.selection.owners.find(
          (o) => o.agentGlobalId === owner.sourceAgentGlobalId,
        )!;
        const binding = await source(ctx, j, key('binding', original.worldId, original.playerId));
        // Source bindings are located by their signed resident relation, never by target main.
        const stagedBinding =
          binding ??
          (await ctx.db
            .query('backupLargeRows')
            .withIndex('job_owner', (q) =>
              q
                .eq('jobId', j._id)
                .eq('role', 'SOURCE')
                .eq('table', 'residentModelBindings')
                .eq('ownerGlobalId', original.agentGlobalId),
            )
            .unique());
        const world = await source(ctx, j, original.worldId);
        const profile = await source(ctx, j, original.chatProfileId);
        const persona = await ctx.db
          .query('backupLargeRows')
          .withIndex('job_table', (q) =>
            q.eq('jobId', j._id).eq('role', 'SOURCE').eq('table', 'agentDescriptions'),
          )
          .filter((q) => q.eq(q.field('ownerGlobalId'), original.agentGlobalId))
          .unique();
        const publicPersona = await ctx.db
          .query('backupLargeRows')
          .withIndex('job_table', (q) =>
            q.eq('jobId', j._id).eq('role', 'SOURCE').eq('table', 'playerDescriptions'),
          )
          .filter((q) => q.eq(q.field('ownerGlobalId'), original.agentGlobalId))
          .unique();
        if (
          !stagedBinding ||
          !world ||
          !profile ||
          !persona ||
          !publicPersona ||
          !data(world).agents.some(
            (agent: BackupRow) =>
              agent.id === original.agentId && agent.playerId === original.playerId,
          )
        )
          throw new Error('SELECTIVE_IMPORT_RESIDENT_CONFIGURATION_MISSING');
        const policy = m.options.profiles.find((p) => p.sourceId === original.chatProfileId);
        if (!policy || policy.operation === 'skip')
          throw new Error('SELECTIVE_IMPORT_PROFILE_MAPPING_REQUIRED');
        if (policy.operation === 'map' && !(await ctx.db.get(policy.targetId!)))
          throw new Error('SELECTIVE_IMPORT_TARGET_PROFILE_MISSING');
      }
    let dimensions = 0,
      spacesCount = 0;
    const spaces = await ctx.db.query('embeddingSpaces').take(1001);
    if (spaces.length > 1000) throw new Error('SELECTIVE_IMPORT_EMBEDDING_SPACE_BUDGET');
    for (const space of spaces)
      if (['ACTIVE', 'READY', 'BUILDING'].includes(space.status)) {
        const profile = await ctx.db.get(space.profileId);
        if (!profile) throw new Error('SELECTIVE_IMPORT_EMBEDDING_PROFILE_MISSING');
        dimensions += profile.dimensions;
        spacesCount++;
      }
    const planDigest = await digest({
      source: j.source,
      selection: m.selection,
      options: m.options,
      targets: m.targetOwners,
    });
    await ctx.db.patch(j._id, {
      phase: 'CAPTURE_TARGET',
      state: 'VALIDATING',
      tableIndex: 0,
      cursor: null,
      metadata: {
        ...m,
        planDigest,
        vectorBytesEstimate: spacesCount ? m.plannedMemories * dimensions * 8 : undefined,
        embeddingCallsEstimate: spacesCount ? m.plannedMemories * spacesCount : undefined,
      },
      updatedAt: Date.now(),
    });
  },
});

export const capturePage = internalQuery({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId);
    if (j.phase !== 'CAPTURE_TARGET') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    await stable(ctx);
    const name = captureTables[j.tableIndex];
    const page = await ctx.db
      .query(table(name))
      .paginate({ cursor: j.cursor, numItems: 20, maximumBytesRead: TARGET_CHUNK_BYTES });
    return { ...page, table: name };
  },
});
export const saveCapture = internalMutation({
  args: {
    jobId: v.id('backupLargeJobs'),
    expectedCursor: v.union(v.string(), v.null()),
    expectedTableIndex: v.number(),
    cursor: v.string(),
    done: v.boolean(),
    chunks: v.array(v.any()),
  },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId),
      m = metadata(j);
    if (
      j.phase !== 'CAPTURE_TARGET' ||
      j.cursor !== a.expectedCursor ||
      j.tableIndex !== a.expectedTableIndex
    )
      throw new Error('BACKUP_CHECKPOINT_CHANGED');
    let oldChunks = m.oldChunks,
      oldBytes = m.oldBytes,
      snapshotDigest = m.snapshotDigest;
    for (const raw of a.chunks) {
      const entry = raw as ChunkDescriptor & { storageId: Id<'_storage'>; json: string };
      if (entry.index !== j.chunkCount + oldChunks || entry.table !== captureTables[j.tableIndex])
        throw new Error('BACKUP_CHUNK_SEQUENCE');
      const chunk = JSON.parse(entry.json) as LargeChunk;
      for (const [rowIndex, encoded] of chunk.rows.entries()) {
        const row = decodeRow(encoded);
        await ctx.db.insert('backupLargeRows', {
          jobId: j._id,
          role: 'OLD',
          table: entry.table,
          sourceId: row._id,
          chunkIndex: entry.index,
          rowIndex,
          state: 'CAPTURED',
          references: [],
          metadata: {},
        });
      }
      const { json: _json, ...saved } = entry;
      await ctx.db.insert('backupLargeChunks', { ...saved, jobId: j._id });
      oldChunks++;
      oldBytes += entry.bytes;
      snapshotDigest = await digest({
        previous: snapshotDigest,
        digest: entry.digest,
        table: entry.table,
      });
    }
    if (oldChunks > MAX_CHUNKS || oldBytes > MAX_ARCHIVE_BYTES)
      throw new Error('LARGE_BACKUP_ROLLBACK_BUDGET');
    const finished = a.done && j.tableIndex + 1 === captureTables.length;
    await ctx.db.patch(j._id, {
      phase: finished ? 'READY' : 'CAPTURE_TARGET',
      state: finished ? 'READY' : 'VALIDATING',
      tableIndex: a.done ? j.tableIndex + 1 : j.tableIndex,
      cursor: a.done ? null : a.cursor,
      metadata: { ...m, oldChunks, oldBytes, snapshotDigest },
      updatedAt: Date.now(),
    });
  },
});
export const startApply = mutation({
  args: {
    ...args,
    expectedPlanDigest: v.string(),
    expectedTargetDigest: v.string(),
    confirmChanges: v.boolean(),
  },
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    const j = await owned(ctx, a.jobId),
      m = metadata(j);
    await stable(ctx);
    await assertNoIdentityConflict(ctx);
    if (j.state !== 'READY' || j.phase !== 'READY') throw new Error('BACKUP_NOT_READY');
    if (
      !a.confirmChanges ||
      a.expectedPlanDigest !== m.planDigest ||
      a.expectedTargetDigest !== m.snapshotDigest
    )
      throw new Error('SELECTIVE_IMPORT_REVIEW_REQUIRED');
    await ctx.db.patch(j._id, {
      state: 'APPLYING',
      phase: 'PROFILES',
      cursor: null,
      processedChunks: 0,
      metadata: { ...m, destructive: true },
      updatedAt: Date.now(),
    });
  },
});

async function insert(ctx: MutationCtx, j: Job, name: string, fields: BackupRow) {
  const id = await ctx.db.insert(table(name), fields as never);
  await journal(ctx, j, name, id);
  return id;
}
export const profilePage = internalMutation({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId),
      m = metadata(j);
    if (j.phase !== 'PROFILES') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const page = await ctx.db
      .query('backupLargeRows')
      .withIndex('job_table', (q) =>
        q.eq('jobId', j._id).eq('role', 'SOURCE').eq('table', 'chatProfiles'),
      )
      .paginate({ cursor: j.cursor, numItems: 20, maximumBytesRead: TARGET_CHUNK_BYTES });
    let created = m.created,
      skipped = m.skipped;
    for (const r of page.page) {
      const policy = m.options.profiles.find((p) => p.sourceId === r.sourceId);
      if (!policy || policy.operation === 'skip') {
        skipped++;
        continue;
      }
      const row = data(r);
      const targetId =
        policy.operation === 'map'
          ? policy.targetId!
          : await insert(ctx, j, 'chatProfiles', {
              ...stripSystem(row),
              apiKeyEnv: `SELECTIVE_CHAT_${j._id}_${r.sourceId}`.replace(/[^A-Z0-9_]/gi, '_'),
              createdAt: Date.now(),
            });
      if (!(await ctx.db.get(targetId as Id<'chatProfiles'>)))
        throw new Error('SELECTIVE_IMPORT_TARGET_PROFILE_MISSING');
      if (policy.operation === 'draft') created++;
      await putMap(ctx, j, key('profile', r.sourceId), targetId);
      await ctx.db.patch(r._id, { newId: targetId, state: 'APPLIED' });
    }
    await ctx.db.patch(j._id, {
      phase: page.isDone ? 'PREPARE' : 'PROFILES',
      cursor: page.isDone ? null : page.continueCursor,
      metadata: { ...m, created, skipped },
      updatedAt: Date.now(),
    });
  },
});
function position(map: WorldMap, occupied: Point[], desired: Point) {
  if (!blockedWithPositions(desired, occupied, map)) return desired;
  for (let x = 0; x < map.width; x++)
    for (let y = 0; y < map.height; y++)
      if (!blockedWithPositions({ x, y }, occupied, map)) return { x, y };
  throw new Error('SELECTIVE_IMPORT_MAP_CAPACITY_EXCEEDED');
}
export const prepare = internalMutation({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId),
      m = metadata(j),
      local = await stable(ctx);
    if (j.phase !== 'PREPARE') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    let created = m.created,
      replaced = m.replaced;
    for (const target of m.targetOwners) {
      const original = m.selection.owners.find(
        (o) => o.agentGlobalId === target.sourceAgentGlobalId,
      )!;
      await putMap(ctx, j, key('world', original.worldId), target.worldId);
      await putMap(ctx, j, key('player', original.worldId, original.playerId), target.playerId);
      await putMap(ctx, j, key('agent', original.worldId, original.agentId), target.agentId);
      await putMap(ctx, j, key('global', original.agentGlobalId), target.agentGlobalId);
      const world = (await ctx.db.get(target.worldId as Id<'worlds'>))!;
      if (target.operation === 'merge') continue;
      const profileId = await getMap(ctx, j, key('profile', original.chatProfileId));
      if (!profileId) throw new Error('SELECTIVE_IMPORT_PROFILE_MAPPING_REQUIRED');
      target.chatProfileId = profileId;
      const binding = await ctx.db
        .query('residentModelBindings')
        .withIndex('globalAgent', (q) => q.eq('agentGlobalId', target.agentGlobalId))
        .unique();
      const bindingFields = {
        worldId: world._id,
        playerId: target.playerId,
        agentGlobalId: target.agentGlobalId,
        chatProfileId: profileId,
        createdAt: binding?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      if (binding) {
        await ctx.db.replace(binding._id, bindingFields as never);
        replaced++;
      } else {
        await insert(ctx, j, 'residentModelBindings', bindingFields);
        created++;
      }
      if (target.operation === 'clone') {
        const sourceWorld = data((await source(ctx, j, original.worldId))!);
        const sourcePlayer = sourceWorld.players.find(
          (p: BackupRow) => p.id === original.playerId,
        ) as BackupRow | undefined;
        if (!sourcePlayer) throw new Error('SELECTIVE_IMPORT_RESIDENT_CONFIGURATION_MISSING');
        const mapDoc = await ctx.db
          .query('maps')
          .withIndex('worldId', (q) => q.eq('worldId', world._id))
          .unique();
        if (!mapDoc) throw new Error('SELECTIVE_IMPORT_TARGET_MAP_REQUIRED');
        const map = new WorldMap(mapDoc);
        const freshPosition = position(
          map,
          world.players.map((p) => p.position),
          sourcePlayer.position as Point,
        );
        const player = {
          id: target.playerId,
          position: freshPosition,
          facing: sourcePlayer.facing,
          speed: 0,
          lastInput: Date.now(),
        };
        const agent = { id: target.agentId, playerId: target.playerId };
        await ctx.db.patch(world._id, {
          nextId: Math.max(world.nextId, Number(target.agentId.slice(2)) + 1),
          players: [...world.players, player] as never,
          agents: [...world.agents, agent] as never,
        });
        await insert(ctx, j, 'federationAgentRuntimes', {
          worldId: world._id,
          playerId: target.playerId,
          agentId: target.agentId,
          agentGlobalId: target.agentGlobalId,
          homeTownId: local.townId,
          state: 'HOME_ACTIVE',
          agentAuthorityEpoch: 1,
          updatedAt: Date.now(),
        });
        created++;
      }
    }
    for (const world of m.options.worlds) {
      if (!(await ctx.db.get(world.targetId)))
        throw new Error('SELECTIVE_IMPORT_TARGET_WORLD_REQUIRED');
      await putMap(ctx, j, key('world', world.sourceId), world.targetId);
    }
    await ctx.db.patch(j._id, {
      phase: 'ALLOCATE',
      cursor: null,
      metadata: { ...m, targetOwners: m.targetOwners, created, replaced },
      updatedAt: Date.now(),
    });
  },
});
async function localId(
  ctx: MutationCtx,
  j: Job,
  kind: 'player' | 'agent' | 'conversation',
  worldId: string,
  id: string,
): Promise<string> {
  const previous = await getMap(ctx, j, key(kind, worldId, id));
  if (previous) return previous;
  const targetWorldId = await getMap(ctx, j, key('world', worldId));
  if (!targetWorldId) throw new Error('SELECTIVE_IMPORT_WORLD_MAPPING_MISSING');
  const world = await ctx.db.get(targetWorldId as Id<'worlds'>);
  if (!world) throw new Error('SELECTIVE_IMPORT_TARGET_WORLD_REQUIRED');
  const allocated = await allocateLocalId(ctx, world, kind, world.nextId);
  await ctx.db.patch(world._id, { nextId: allocated.next });
  await putMap(ctx, j, key(kind, worldId, id), allocated.id);
  return allocated.id;
}
async function fieldsFor(ctx: MutationCtx, j: Job, r: Row, remapping: boolean) {
  const m = metadata(j),
    row = data(r),
    e = record(r),
    fields = canonicalFields(r.table, row);
  const own = rowOwner(row, m.selection),
    target = own && m.targetOwners.find((o) => o.sourceAgentGlobalId === own.agentGlobalId);
  const sourceWorld = row.worldId as string | undefined;
  if (sourceWorld) fields.worldId = await getMap(ctx, j, key('world', sourceWorld));
  if (own && target) {
    if (typeof fields.agentGlobalId === 'string') fields.agentGlobalId = target.agentGlobalId;
    if (fields.playerId) fields.playerId = target.playerId;
  }
  if (sourceWorld) {
    for (const name of ['playerId', 'creator', 'author', 'player1', 'player2'] as const)
      if (typeof row[name] === 'string')
        fields[name] = await localId(ctx, j, 'player', sourceWorld, row[name]);
    if (typeof row.agentId === 'string')
      fields.agentId = await localId(ctx, j, 'agent', sourceWorld, row.agentId);
    if (['archivedPlayers', 'archivedAgents', 'archivedConversations'].includes(r.table))
      fields.id = await localId(
        ctx,
        j,
        r.table === 'archivedPlayers'
          ? 'player'
          : r.table === 'archivedAgents'
            ? 'agent'
            : 'conversation',
        sourceWorld,
        row.id,
      );
    if (row.conversationId)
      fields.conversationId = await localId(
        ctx,
        j,
        'conversation',
        sourceWorld,
        row.conversationId,
      );
    if (Array.isArray(row.participants) && row.participants.every((p) => typeof p === 'string'))
      fields.participants = await Promise.all(
        (row.participants as string[]).map((p) => localId(ctx, j, 'player', sourceWorld, p)),
      );
  }
  if (r.table === 'playerDescriptions' && target?.operation === 'clone') {
    fields.name = `${row.name as string} (clone)`;
    fields.originTownId = j.source.townId;
    fields.originTownName = j.source.townName;
    delete fields.visitId;
  }
  if (r.table === 'archivedPlayers' || r.table === 'archivedAgents') {
    for (const transient of [
      'human',
      'remoteVisitor',
      'pathfinding',
      'activity',
      'travelVisitId',
      'suspendedPlayer',
      'inProgressOperation',
      'toRemember',
      'queuedConversations',
    ])
      delete fields[transient];
  }
  const memoryRef = async (id: string) => {
    const staged = await source(ctx, j, id);
    if (
      staged &&
      staged.state !== 'EXTERNAL' &&
      m.targetOwners.some((owner) => owner.sourceAgentGlobalId === staged.ownerGlobalId)
    ) {
      if (!staged?.newId && remapping) throw new Error('BACKUP_REFERENCE_NOT_ALLOCATED');
      return staged?.newId;
    }
    const policy = m.options.externalReferences.find(
      (p) => p.sourceId === id && p.sourceAgentGlobalId === own?.agentGlobalId,
    );
    if (!policy) throw new Error('SELECTIVE_IMPORT_EXTERNAL_MAPPING_REQUIRED');
    return policy.operation === 'map' ? policy.targetId : undefined;
  };
  if (r.table === 'memories') {
    const dataFields = { ...fields.data } as BackupRow;
    if (dataFields.conversationId)
      dataFields.conversationId = await localId(
        ctx,
        j,
        'conversation',
        own!.worldId,
        dataFields.conversationId,
      );
    if (dataFields.playerId)
      dataFields.playerId = await localId(ctx, j, 'player', own!.worldId, dataFields.playerId);
    if (Array.isArray(dataFields.playerIds))
      dataFields.playerIds = await Promise.all(
        (dataFields.playerIds as string[]).map((p) => localId(ctx, j, 'player', own!.worldId, p)),
      );
    for (const name of ['relatedMemoryIds', 'evidenceMemoryIds'] as const)
      if (Array.isArray(dataFields[name]))
        dataFields[name] = remapping
          ? (await Promise.all((dataFields[name] as string[]).map(memoryRef))).filter(Boolean)
          : [];
    if (typeof dataFields.agentGlobalId === 'string')
      dataFields.agentGlobalId =
        (await getMap(ctx, j, key('global', dataFields.agentGlobalId))) ?? dataFields.agentGlobalId;
    if (Array.isArray(dataFields.participants))
      dataFields.participants = await Promise.all(
        (dataFields.participants as BackupRow[]).map(async (p) => ({
          ...p,
          agentGlobalId: (await getMap(ctx, j, key('global', p.agentGlobalId))) ?? p.agentGlobalId,
        })),
      );
    if (dataFields.type === 'travel' && dataFields.transcriptId)
      dataFields.transcriptId = `selective:${j._id}:${dataFields.transcriptId as string}`;
    fields.data = dataFields;
  }
  if (r.table === 'homeTravelTranscripts') {
    fields.transcriptId = `selective:${j._id}:${row.transcriptId as string}`;
    for (const name of ['summaryMemoryId', 'endMemoryId'] as const)
      if (row[name]) {
        if (remapping) fields[name] = await memoryRef(row[name]);
        else delete fields[name];
      }
  }
  if (r.table === 'homeTravelTranscriptPages') {
    fields.transcriptId = `selective:${j._id}:${row.transcriptId as string}`;
    fields.memoryIds = remapping
      ? (await Promise.all((row.memoryIds as string[]).map(memoryRef))).filter(Boolean)
      : [];
  }
  if (r.table === 'homeTravelTranscripts' && target)
    fields.participants = await Promise.all(
      (row.participants as BackupRow[]).map(async (p) => ({
        ...p,
        playerId: await localId(ctx, j, 'player', own!.worldId, p.playerId),
        agentGlobalId: (await getMap(ctx, j, key('global', p.agentGlobalId))) ?? p.agentGlobalId,
      })),
    );
  if (e.publicParticipants)
    for (const p of e.publicParticipants) await localId(ctx, j, 'player', p.worldId, p.playerId);
  return remapping ? fields : allocationFields(r.table, fields);
}
async function existingPersona(ctx: MutationCtx, r: Row, fields: BackupRow) {
  if (r.table === 'playerDescriptions')
    return ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', fields.worldId).eq('playerId', fields.playerId))
      .unique();
  if (r.table === 'agentDescriptions')
    return ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', fields.worldId).eq('agentId', fields.agentId))
      .unique();
  return null;
}
async function ensureLiveConversationArchive(ctx: MutationCtx, j: Job, r: Row) {
  const context = record(r).conversationContext;
  if (!context || context.source !== 'live') return;
  const worldId = (await getMap(ctx, j, key('world', context.worldId)))!;
  const id = await localId(ctx, j, 'conversation', context.worldId, context.id);
  const existing = await ctx.db
    .query('archivedConversations')
    .withIndex('worldId', (q) => q.eq('worldId', worldId as Id<'worlds'>).eq('id', id))
    .unique();
  if (existing) return;
  const participants = await Promise.all(
    context.participants.map((p) => localId(ctx, j, 'player', context.worldId, p)),
  );
  await insert(ctx, j, 'archivedConversations', {
    worldId,
    id,
    creator: participants[0],
    created: context.created,
    ended: j.createdAt,
    numMessages: context.numMessages,
    participants,
  });
}
export const applyPage = internalMutation({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId),
      m = metadata(j);
    if (!['ALLOCATE', 'REMAP'].includes(j.phase)) throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const remapping = j.phase === 'REMAP';
    const page = await ctx.db
      .query('backupLargeRows')
      .withIndex('job_role', (q) => q.eq('jobId', j._id).eq('role', 'SOURCE'))
      .paginate({ cursor: j.cursor, numItems: 20, maximumBytesRead: TARGET_CHUNK_BYTES });
    let created = m.created,
      replaced = m.replaced,
      skipped = m.skipped,
      rebuildCount = m.rebuildCount,
      externalEdgesSkipped = m.externalEdgesSkipped;
    for (const r of page.page) {
      if (r.state === 'EXTERNAL' || r.table === 'chatProfiles') continue;
      const owners = await ownersFor(ctx, j, r);
      const targets = m.targetOwners.filter((t) => owners.includes(t.sourceAgentGlobalId));
      const row = data(r);
      if (archivalTables.has(r.table)) {
        if (!remapping && targets.length) {
          await insert(ctx, j, 'backupSelectiveHistory', {
            jobId: j._id,
            sourceTownId: j.source.townId,
            sourceId: r.sourceId,
            table: r.table,
            agentGlobalIds: targets.map((t) => t.agentGlobalId),
            record: record(r).record,
          });
          created++;
        }
        continue;
      }
      if (!canonicalTables.has(r.table)) {
        if (!remapping && m.selection.scope === 'config-only') await applyConfiguration(ctx, j, r);
        continue;
      }
      if (!targets.length) {
        if (!remapping) skipped++;
        continue;
      }
      if (
        ['playerDescriptions', 'agentDescriptions'].includes(r.table) &&
        targets.every((t) => t.operation === 'merge')
      ) {
        if (!remapping) skipped++;
        continue;
      }
      const fields = await fieldsFor(ctx, j, r, remapping);
      if (!fields.worldId && r.table !== 'homeTravelTranscriptPages')
        throw new Error('SELECTIVE_IMPORT_WORLD_MAPPING_MISSING');
      await ensureLiveConversationArchive(ctx, j, r);
      if (remapping) {
        if (!r.newId) throw new Error('BACKUP_ALLOCATED_ID_MISSING');
        await ctx.db.replace(r.newId as Id<TableNames>, fields as never);
        await ctx.db.patch(r._id, { state: 'APPLIED' });
        if (['memories', 'homeTravelTranscripts', 'homeTravelTranscriptPages'].includes(r.table))
          for (const ref of r.references.filter((ref) => ref.table === 'memories'))
            if (
              m.options.externalReferences.find(
                (p) => p.sourceId === ref.id && p.sourceAgentGlobalId === r.ownerGlobalId,
              )?.operation === 'skip-edge'
            )
              externalEdgesSkipped++;
      } else {
        let existing: Doc<TableNames> | null = await existingPersona(ctx, r, fields);
        if (r.table === 'memories' && targets[0].operation === 'restore') {
          const memoryId = ctx.db.normalizeId('memories', r.sourceId);
          const memory = memoryId && (await ctx.db.get(memoryId));
          if (
            memory &&
            (memory.worldId !== fields.worldId ||
              memory.playerId !== fields.playerId ||
              (memory.agentGlobalId && memory.agentGlobalId !== fields.agentGlobalId))
          )
            throw new Error('SELECTIVE_IMPORT_RESTORE_MEMORY_ID_CONFLICT');
          existing = memory || null;
        }
        const id = existing ? existing._id : await insert(ctx, j, r.table, fields);
        if (existing) {
          await ctx.db.replace(existing._id, fields as never);
          replaced++;
        } else created++;
        await ctx.db.patch(r._id, { newId: id, state: 'ALLOCATED' });
        if (r.table === 'memories') rebuildCount++;
      }
    }
    await ctx.db.patch(j._id, {
      phase: page.isDone ? (remapping ? 'VECTOR_RESET' : 'REMAP') : j.phase,
      cursor: page.isDone ? null : page.continueCursor,
      metadata: { ...m, created, replaced, skipped, rebuildCount, externalEdgesSkipped },
      updatedAt: Date.now(),
    });
  },
});

async function applyConfiguration(ctx: MutationCtx, j: Job, r: Row) {
  const m = metadata(j),
    row = data(r),
    fields = stripSystem(row),
    options = m.options;
  if (r.table === 'embeddingProfiles' && options.configuration.includes('embeddingProfiles')) {
    await insert(ctx, j, r.table, {
      ...fields,
      apiKeyEnv: `SELECTIVE_EMBEDDING_${j._id}_${r.rowIndex}`.replace(/[^A-Z0-9_]/gi, '_'),
      createdAt: Date.now(),
    });
    return;
  }
  if (r.table === 'maps') {
    const mapping = options.worlds.find((w) => w.sourceId === row.worldId);
    if (!mapping?.importMap) return;
    const world = (await ctx.db.get(mapping.targetId))!;
    const map = new WorldMap(row as never);
    if (world.players.some((p) => blockedWithPositions(p.position, [], map)))
      throw new Error('SELECTIVE_IMPORT_MAP_BLOCKS_EXISTING_PLAYER');
    const existing = await ctx.db
      .query('maps')
      .withIndex('worldId', (q) => q.eq('worldId', mapping.targetId))
      .unique();
    const next = { ...fields, worldId: mapping.targetId };
    if (existing) await ctx.db.replace(existing._id, next as never);
    else await insert(ctx, j, 'maps', next);
    return;
  }
  if (
    r.table === 'modelSettings' &&
    options.configuration.includes('mainChatProfile') &&
    row.mainChatProfileId
  ) {
    const profileId = await getMap(ctx, j, key('profile', row.mainChatProfileId));
    if (!profileId) throw new Error('SELECTIVE_IMPORT_PROFILE_MAPPING_REQUIRED');
    const existing = await ctx.db
      .query('modelSettings')
      .withIndex('key', (q) => q.eq('key', 'town'))
      .unique();
    if (existing)
      await ctx.db.patch(existing._id, { mainChatProfileId: profileId as Id<'chatProfiles'> });
    else await insert(ctx, j, 'modelSettings', { key: 'town', mainChatProfileId: profileId });
    return;
  }
  if (r.table === 'federationIdentity' && options.configuration.includes('visitorPolicy')) {
    const local = await stable(ctx);
    await ctx.db.patch(local._id, {
      maxVisitors: row.maxVisitors,
      maxVisitDurationMs: row.maxVisitDurationMs,
      resourceLimits: row.resourceLimits,
    });
    return;
  }
  if (
    ['storagePolicies', 'federationResourcePolicy'].includes(r.table) &&
    options.configuration.includes(r.table as 'storagePolicies')
  ) {
    const existing = await ctx.db
      .query(table(r.table))
      .filter((q) => q.eq(q.field('key'), row.key))
      .first();
    if (existing) await ctx.db.replace(existing._id, fields as never);
    else await insert(ctx, j, r.table, fields);
  }
}

export const clearVectors = internalMutation({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId);
    if (j.phase !== 'VECTOR_RESET') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const memory = await ctx.db
      .query('backupLargeRows')
      .withIndex('job_table', (q) =>
        q.eq('jobId', j._id).eq('role', 'SOURCE').eq('table', 'memories'),
      )
      .filter((q) => q.eq(q.field('state'), 'APPLIED'))
      .first();
    if (!memory) {
      await ctx.db.patch(j._id, { phase: 'FINALIZE' });
      return;
    }
    const vectors = await ctx.db
      .query('modelMemoryVectors')
      .withIndex('memory_space', (q) => q.eq('memoryId', memory.newId as Id<'memories'>))
      .take(20);
    for (const vector of vectors) await ctx.db.delete(vector._id);
    if (vectors.length < 20) await ctx.db.patch(memory._id, { state: 'VECTOR_CLEARED' });
  },
});
async function release(ctx: MutationCtx, j: Job, state: 'COMPLETE' | 'CANCELLED') {
  const lock = await ctx.db
    .query('backupMaintenanceLocks')
    .withIndex('key', (q) => q.eq('key', 'town'))
    .unique();
  if (lock?.jobId !== j._id) throw new Error('BACKUP_MAINTENANCE_LOCK_LOST');
  await ctx.db.delete(lock._id);
  await ctx.db.patch(j._id, { state, phase: state, error: undefined, updatedAt: Date.now() });
}
export const finalize = internalMutation({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId),
      m = metadata(j);
    if (j.phase !== 'FINALIZE') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    await stable(ctx);
    await assertNoIdentityConflict(ctx);
    const importId = await ctx.db.insert('backupImports', {
      sourceTownId: j.source.townId,
      mode: `selective-${m.options.mode}`,
      exportedAt: m.exportedAt,
      importedAt: Date.now(),
      sourceStoppedAt: m.options.sourceStopped ? j.createdAt : undefined,
      mapping: { selectiveJobId: j._id, owners: m.targetOwners },
      runtimeSnapshot: { selectiveJobId: j._id, snapshotDigest: m.snapshotDigest },
      manifest: {
        format: 'ai-town-selective-archive',
        version: 2,
        selectiveJobId: j._id,
        operator: m.options.operator,
        reason: m.options.reason,
        report: view(j).report,
      },
    });
    await ctx.db.patch(j._id, {
      metadata: { ...m, importId, indexState: m.rebuildCount ? 'QUEUED' : 'NOT_REQUIRED' },
    });
    await release(ctx, j, 'COMPLETE');
    if (m.rebuildCount)
      await ctx.scheduler.runAfter(0, aref('rebuildPage'), { jobId: j._id, cursor: null });
  },
});
export const fail = internalMutation({
  args: { jobId: v.id('backupLargeJobs'), error: v.string() },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId);
    if (terminal.has(j.state)) return;
    await ctx.db.patch(j._id, {
      state: 'FAILED',
      resumeState: j.state === 'FAILED' ? j.resumeState : j.state,
      error: a.error.slice(0, 1000),
      updatedAt: Date.now(),
    });
  },
});
export const resume = mutation({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    const j = await owned(ctx, a.jobId);
    await stable(ctx);
    if (j.state !== 'FAILED') throw new Error('BACKUP_JOB_NOT_FAILED');
    await ctx.db.patch(j._id, {
      state: j.resumeState ?? 'VALIDATING',
      resumeState: undefined,
      error: undefined,
    });
  },
});
export const cancel = mutation({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    const j = await owned(ctx, a.jobId);
    if (terminal.has(j.state)) return;
    // Retried cancellation must continue the saved rollback checkpoint.
    if (j.phase.startsWith('ROLLBACK')) {
      if (j.state === 'FAILED') await ctx.db.patch(j._id, {state:'ROLLING_BACK',resumeState:undefined,error:undefined,updatedAt:Date.now()});
      return;
    }
    if (!metadata(j).destructive) await release(ctx, j, 'CANCELLED');
    else
      await ctx.db.patch(j._id, {
        state: 'ROLLING_BACK',
        phase: 'ROLLBACK_DELETE',
        cursor: null,
        processedChunks: 0,
        error: undefined,
      });
  },
});
export const rollbackDelete = internalMutation({
  args: { jobId: v.id('backupLargeJobs') },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId);
    if (j.phase !== 'ROLLBACK_DELETE') throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const rows = await ctx.db
      .query('backupSelectiveJournal')
      .withIndex('job', (q) => q.eq('jobId', j._id))
      .take(20);
    for (const row of rows) {
      const id = ctx.db.normalizeId(table(row.table), row.targetId);
      if (id && (await ctx.db.get(id))) await ctx.db.delete(id);
      await ctx.db.delete(row._id);
    }
    if (rows.length < 20)
      await ctx.db.patch(j._id, { phase: 'ROLLBACK_RESTORE', processedChunks: 0 });
  },
});
export const rollbackChunk = internalMutation({
  args: { jobId: v.id('backupLargeJobs'), index: v.number(), chunkJson: v.string() },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId),
      m = metadata(j);
    if (j.phase !== 'ROLLBACK_RESTORE' || j.processedChunks !== a.index)
      throw new Error('BACKUP_CHECKPOINT_CHANGED');
    const chunk = JSON.parse(a.chunkJson) as LargeChunk;
    const saved = await ctx.db
      .query('backupLargeChunks')
      .withIndex('job_index', (q) => q.eq('jobId', j._id).eq('index', j.chunkCount + a.index))
      .unique();
    if (!saved || (await digest(chunk)) !== saved.digest)
      throw new Error('BACKUP_CHECKSUM_MISMATCH');
    for (const raw of chunk.rows) {
      const row = decodeRow(raw),
        id = ctx.db.normalizeId(table(chunk.table), row._id);
      if (!id) throw new Error('SELECTIVE_IMPORT_SNAPSHOT_ID_INVALID');
      if (await ctx.db.get(id)) await ctx.db.replace(id, stripSystem(row) as never);
      else if (chunk.table === 'modelMemoryVectors')
        await ctx.db.insert('modelMemoryVectors', stripSystem(row) as never);
      else throw new Error('SELECTIVE_IMPORT_TARGET_SNAPSHOT_ROW_MISSING');
    }
    if (a.index + 1 === m.oldChunks) await release(ctx, j, 'CANCELLED');
    else await ctx.db.patch(j._id, { processedChunks: a.index + 1, updatedAt: Date.now() });
  },
});
export const chunkData = internalQuery({
  args: { jobId: v.id('backupLargeJobs'), index: v.number() },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId);
    return ctx.db
      .query('backupLargeChunks')
      .withIndex('job_index', (q) => q.eq('jobId', j._id).eq('index', a.index))
      .unique();
  },
});
export const advanceImport = action({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    let j: Job = await ctx.runQuery(qref('jobData'), { jobId: a.jobId });
    if (terminal.has(j.state) || j.state === 'READY') return view(j);
    if (j.state === 'FAILED') throw new Error('RESUME_BACKUP_JOB_FIRST');
    const stored: Id<'_storage'>[] = [];
    let publicationPending = false;
    try {
      if (['STAGING', 'VALIDATING', 'REACHABILITY'].includes(j.phase))
        await ctx.runMutation(mref('validatePage'), { jobId: j._id });
      else if (j.phase === 'CAPTURE_TARGET') {
        const page = await ctx.runQuery(qref('capturePage'), { jobId: j._id });
        const groups: string[][] = [];
        let rows: string[] = [];
        for (const row of page.page as BackupRow[]) {
          const encoded = encodeRow(row);
          if (
            rows.length &&
            size({ rows: [...rows, encoded], table: page.table, index: 0 }) > TARGET_CHUNK_BYTES
          ) {
            groups.push(rows);
            rows = [];
          }
          rows.push(encoded);
        }
        if (rows.length) groups.push(rows);
        const chunks = [];
        for (const [offset, group] of groups.entries()) {
          const chunk: LargeChunk = {
            index: j.chunkCount + metadata(j).oldChunks + offset,
            table: page.table as string,
            rows: group,
          };
          if (size(chunk) > MAX_CHUNK_BYTES) throw new Error('BACKUP_SINGLE_DOCUMENT_BUDGET');
          const json = JSON.stringify(chunk),
            storageId = await ctx.storage.store(new Blob([json], { type: 'application/json' }));
          stored.push(storageId);
          chunks.push({ ...(await descriptor(chunk)), storageId, json });
        }
        publicationPending = true;
        await ctx.runMutation(mref('saveCapture'), {
          jobId: j._id,
          expectedCursor: j.cursor,
          expectedTableIndex: j.tableIndex,
          cursor: page.continueCursor,
          done: page.isDone,
          chunks,
        });
        publicationPending = false;
      } else if (j.phase === 'PROFILES')
        await ctx.runMutation(mref('profilePage'), { jobId: j._id });
      else if (j.phase === 'PREPARE') await ctx.runMutation(mref('prepare'), { jobId: j._id });
      else if (['ALLOCATE', 'REMAP'].includes(j.phase))
        await ctx.runMutation(mref('applyPage'), { jobId: j._id });
      else if (j.phase === 'VECTOR_RESET')
        await ctx.runMutation(mref('clearVectors'), { jobId: j._id });
      else if (j.phase === 'FINALIZE') await ctx.runMutation(mref('finalize'), { jobId: j._id });
      else if (j.phase === 'ROLLBACK_DELETE')
        await ctx.runMutation(mref('rollbackDelete'), { jobId: j._id });
      else if (j.phase === 'ROLLBACK_RESTORE') {
        const chunk: Doc<'backupLargeChunks'> = await ctx.runQuery(qref('chunkData'), {
          jobId: j._id,
          index: j.chunkCount + j.processedChunks,
        });
        const blob = chunk && (await ctx.storage.get(chunk.storageId));
        if (!blob) throw new Error('BACKUP_CHUNK_STORAGE_MISSING');
        await ctx.runMutation(mref('rollbackChunk'), {
          jobId: j._id,
          index: j.processedChunks,
          chunkJson: await blob.text(),
        });
      } else throw new Error('BACKUP_CHECKPOINT_CHANGED');
    } catch (e) {
      // A lost response may leave a committed or still-running publication.
      if (!publicationPending)
        for (const id of stored) await ctx.storage.delete(id);
      if (!String(e).includes('BACKUP_CHECKPOINT_CHANGED'))
        await ctx.runMutation(mref('fail'), { jobId: j._id, error: String(e) });
    }
    j = await ctx.runQuery(qref('jobData'), { jobId: j._id });
    return view(j);
  },
});
export const indexPageData = internalQuery({
  args: { jobId: v.id('backupLargeJobs'), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId);
    if (j.state !== 'COMPLETE') throw new Error('SELECTIVE_IMPORT_INDEX_NOT_READY');
    return ctx.db
      .query('backupLargeRows')
      .withIndex('job_table', (q) =>
        q.eq('jobId', j._id).eq('role', 'SOURCE').eq('table', 'memories'),
      )
      .filter((q) => q.neq(q.field('newId'), undefined))
      .paginate({ cursor: a.cursor, numItems: 20 });
  },
});
export const indexStatus = internalMutation({
  args: { jobId: v.id('backupLargeJobs'), state: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const j = await owned(ctx, a.jobId);
    await ctx.db.patch(j._id, {
      metadata: { ...metadata(j), indexState: a.state, indexError: a.error },
      updatedAt: Date.now(),
    });
  },
});
export const rebuildPage = internalAction({
  args: { jobId: v.id('backupLargeJobs'), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const page = await ctx.runQuery(qref('indexPageData'), a);
    try {
      for (const row of page.page as Row[])
        await ctx.runAction(makeFunctionReference<'action'>('models/embeddings:indexMemory'), {
          memoryId: row.newId,
        });
      await ctx.runMutation(mref('indexStatus'), {
        jobId: a.jobId,
        state: page.isDone ? 'COMPLETE' : 'BUILDING',
      });
      if (!page.isDone)
        await ctx.scheduler.runAfter(0, aref('rebuildPage'), {
          jobId: a.jobId,
          cursor: page.continueCursor,
        });
    } catch (e) {
      await ctx.runMutation(mref('indexStatus'), {
        jobId: a.jobId,
        state: 'FAILED',
        error: String(e).slice(0, 1000),
      });
    }
  },
});
export const retryIndex = mutation({
  args,
  handler: async (ctx, a) => {
    requireAdmin(a.adminToken);
    const j = await owned(ctx, a.jobId);
    if (j.state !== 'COMPLETE') throw new Error('SELECTIVE_IMPORT_INDEX_NOT_READY');
    await ctx.scheduler.runAfter(0, aref('rebuildPage'), { jobId: j._id, cursor: null });
  },
});
