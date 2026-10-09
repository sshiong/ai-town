import { Infer, v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Id, TableNames } from '../_generated/dataModel';
import {
  BackupRow,
  decodeRow,
  encodeRow,
  remapValue,
  stripSystem,
  validateBundle,
} from './backupHelpers';
import { validateSourceRow } from './backupLargeHelpers';
import { assertTownUnlocked } from './maintenanceLock';
import { assertNoIdentityConflict } from './identityConflict';
import { digest } from './security';
import { identity } from './store';
import { validateConnection } from '../models/profiles';
import { blockedWithPositions } from '../aiTown/movement';
import { WorldMap } from '../aiTown/worldMap';
import { ACTION_TIMEOUT } from '../constants';

export const residentRestoreConfirmation = v.object({
  expectedTargetDigest: v.string(),
  confirmOverwrite: v.boolean(),
  operator: v.string(),
  reason: v.string(),
});
type Args = {
  bundle?: unknown;
  targetWorldId?: Id<'worlds'>;
  sourceStopped?: boolean;
  residentRestore?: Infer<typeof residentRestoreConfirmation>;
};
const supported = new Set([
  'worlds',
  'maps',
  'playerDescriptions',
  'agentDescriptions',
  'archivedPlayers',
  'archivedConversations',
  'participatedTogether',
  'messages',
  'chatProfiles',
  'residentModelBindings',
  'memories',
  'federationAgentRuntimes',
  'federationIdentity',
  'homeTravelTranscripts',
  'homeTravelTranscriptPages',
]);
const sharedHistory = new Set([
  'archivedPlayers',
  'archivedConversations',
  'participatedTogether',
  'messages',
]);
const restoreTables = [
  'playerDescriptions',
  'agentDescriptions',
  'archivedPlayers',
  'archivedConversations',
  'participatedTogether',
  'messages',
  'homeTravelTranscripts',
  'homeTravelTranscriptPages',
] as const;
const tableName = (name: string) => name as TableNames;
const bounded = <T>(rows: T[]) => {
  if (rows.length > 500) throw new Error('RESIDENT_RESTORE_TARGET_TOO_LARGE');
  return rows;
};
const profileFields = (row: BackupRow) => {
  const { createdAt, ...fields } = stripSystem(row);
  return fields;
};

/** Match logical history keys after a whole-town restore has remapped database IDs. */
async function existingRow(ctx: QueryCtx | MutationCtx, name: string, row: BackupRow) {
  if (name === 'playerDescriptions')
    return ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', row.worldId).eq('playerId', row.playerId))
      .unique();
  if (name === 'agentDescriptions')
    return ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', row.worldId).eq('agentId', row.agentId))
      .unique();
  if (name === 'archivedPlayers')
    return ctx.db
      .query('archivedPlayers')
      .withIndex('worldId', (q) => q.eq('worldId', row.worldId).eq('id', row.id))
      .unique();
  if (name === 'archivedConversations')
    return ctx.db
      .query('archivedConversations')
      .withIndex('worldId', (q) => q.eq('worldId', row.worldId).eq('id', row.id))
      .unique();
  if (name === 'participatedTogether')
    return ctx.db
      .query('participatedTogether')
      .withIndex('conversation', (q) =>
        q
          .eq('worldId', row.worldId)
          .eq('player1', row.player1)
          .eq('conversationId', row.conversationId),
      )
      .filter((q) => q.eq(q.field('player2'), row.player2))
      .unique();
  if (name === 'messages')
    return ctx.db
      .query('messages')
      .withIndex('messageUuid', (q) =>
        q.eq('conversationId', row.conversationId).eq('messageUuid', row.messageUuid),
      )
      .filter((q) => q.eq(q.field('worldId'), row.worldId))
      .unique();
  if (name === 'homeTravelTranscripts')
    return ctx.db
      .query('homeTravelTranscripts')
      .withIndex('owner_transcript', (q) =>
        q.eq('agentGlobalId', row.agentGlobalId).eq('transcriptId', row.transcriptId),
      )
      .unique();
  if (name === 'homeTravelTranscriptPages')
    return ctx.db
      .query('homeTravelTranscriptPages')
      .withIndex('owner_transcript_page', (q) =>
        q
          .eq('agentGlobalId', row.agentGlobalId)
          .eq('transcriptId', row.transcriptId)
          .eq('pageNumber', row.pageNumber),
      )
      .unique();
  throw new Error('RESIDENT_RESTORE_TABLE_UNSUPPORTED');
}

export async function residentRestorePlan(ctx: QueryCtx | MutationCtx, args: Args) {
  await assertTownUnlocked(ctx);
  await assertNoIdentityConflict(ctx);
  const bundle = await validateBundle(args.bundle);
  if (bundle.manifest.scope !== 'resident') throw new Error('RESIDENT_BACKUP_REQUIRED');
  if (!bundle.signature) throw new Error('RESIDENT_RESTORE_SIGNED_BACKUP_REQUIRED');
  const rows: Record<string, BackupRow[]> = Object.fromEntries(
    Object.entries(bundle.sections).map(([name, values]) => [name, values.map(decodeRow)]),
  );
  for (const [name, values] of Object.entries(rows)) {
    if (values.length && !supported.has(name)) throw new Error('RESIDENT_BACKUP_SCOPE_MISMATCH');
    for (const row of values) validateSourceRow(name, row);
  }
  const source = rows.federationIdentity[0],
    local = await identity(ctx);
  if (
    !local ||
    local.townId !== source.townId ||
    local.publicKey !== source.publicKey ||
    local.fingerprint !== source.fingerprint
  )
    throw new Error('RESTORE_IDENTITY_PROOF_REQUIRED');
  if (source.mode === 'QUARANTINED') throw new Error('TOWN_CLONE_CONFLICT');
  if (local.enabled) throw new Error('DISABLE_FEDERATION_BEFORE_BACKUP');
  if (!args.sourceStopped) throw new Error('RESTORE_SOURCE_STOP_REQUIRED');
  if (
    rows.worlds?.length !== 1 ||
    rows.residentModelBindings?.length !== 1 ||
    rows.chatProfiles?.length !== 1
  )
    throw new Error('RESIDENT_BACKUP_SCOPE_MISMATCH');
  const sourceWorld = rows.worlds[0],
    binding = rows.residentModelBindings[0],
    profile = rows.chatProfiles[0];
  const agent = sourceWorld.agents?.[0],
    player = sourceWorld.players?.[0];
  if (
    sourceWorld.agents?.length !== 1 ||
    sourceWorld.players?.length !== 1 ||
    !agent ||
    !player ||
    binding.worldId !== sourceWorld._id ||
    binding.playerId !== agent.playerId ||
    player.id !== agent.playerId ||
    player.remoteVisitor ||
    player.human ||
    !/^p:\d+$/.test(player.id) ||
    !/^a:\d+$/.test(agent.id) ||
    !Number.isSafeInteger(Number(player.id.slice(2))) ||
    !Number.isSafeInteger(Number(agent.id.slice(2))) ||
    !binding.agentGlobalId?.startsWith(`${local.townId}/agent:`) ||
    binding.chatProfileId !== profile._id
  )
    throw new Error('RESIDENT_BACKUP_OWNER_MISMATCH');
  validateConnection(profile as never);
  if (
    agent.travelVisitId ||
    agent.suspendedPlayer ||
    rows.federationAgentRuntimes?.some((r) => r.visitId || r.state !== 'HOME_ACTIVE')
  )
    throw new Error('RECONCILE_SOURCE_RESIDENT_TRAVEL_FIRST');
  if (
    (rows.federationAgentRuntimes ?? []).some(
      (r) =>
        r.homeTownId !== local.townId ||
        r.agentGlobalId !== binding.agentGlobalId ||
        r.worldId !== sourceWorld._id ||
        r.playerId !== binding.playerId ||
        r.agentId !== agent.id,
    )
  )
    throw new Error('RESIDENT_BACKUP_OWNER_MISMATCH');
  if (
    (rows.memories ?? []).some(
      (m) =>
        m.worldId !== sourceWorld._id ||
        m.playerId !== binding.playerId ||
        (m.agentGlobalId && m.agentGlobalId !== binding.agentGlobalId),
    )
  )
    throw new Error('RESIDENT_BACKUP_MEMORY_OWNER_MISMATCH');
  if (
    (rows.agentDescriptions ?? []).length !== 1 ||
    rows.agentDescriptions[0].agentId !== agent.id ||
    (rows.playerDescriptions ?? []).filter((d) => d.playerId === binding.playerId).length !== 1
  )
    throw new Error('RESIDENT_BACKUP_PERSONA_MISSING');
  const byId = new Map(
    Object.entries(rows).flatMap(([name, values]) =>
      values.map((row) => [row._id, { name, row }] as const),
    ),
  );
  for (const [name, values] of Object.entries(rows))
    for (const row of values) {
      if (row.worldId && row.worldId !== sourceWorld._id)
        throw new Error('RESIDENT_BACKUP_OWNER_MISMATCH');
      if (
        name.startsWith('homeTravel') &&
        (row.agentGlobalId !== binding.agentGlobalId ||
          (name === 'homeTravelTranscripts' && row.playerId !== binding.playerId))
      )
        throw new Error('RESIDENT_BACKUP_OWNER_MISMATCH');
      for (const ref of validateSourceRow(name, row))
        if (byId.get(ref.id)?.name !== ref.table)
          throw new Error('RESIDENT_BACKUP_REFERENCE_MISSING');
    }
  const conversations = new Map((rows.archivedConversations ?? []).map((c) => [c.id, c]));
  if (
    [...conversations.values()].some((c) => !c.participants.includes(binding.playerId)) ||
    (rows.messages ?? []).some(
      (m) => !conversations.get(m.conversationId)?.participants.includes(m.author),
    ) ||
    (rows.participatedTogether ?? []).some(
      (p) =>
        p.player1 !== binding.playerId ||
        !conversations.get(p.conversationId)?.participants.includes(p.player2),
    )
  )
    throw new Error('RESIDENT_BACKUP_HISTORY_OWNER_MISMATCH');
  const relatedPlayers = new Set([
    binding.playerId,
    ...[...conversations.values()].flatMap((c) => c.participants),
  ]);
  if (
    (rows.playerDescriptions ?? []).some((d) => !relatedPlayers.has(d.playerId)) ||
    (rows.archivedPlayers ?? []).some((p) => !relatedPlayers.has(p.id))
  )
    throw new Error('RESIDENT_BACKUP_HISTORY_OWNER_MISMATCH');
  for (const transcript of rows.homeTravelTranscripts ?? []) {
    const pages = (rows.homeTravelTranscriptPages ?? []).filter(
      (p) => p.transcriptId === transcript.transcriptId,
    );
    if (
      new Set(pages.map((p) => p.pageNumber)).size !== pages.length ||
      pages.length !== transcript.receivedPageCount ||
      pages.reduce((sum, p) => sum + p.messages.length, 0) !== transcript.totalMessageCount ||
      pages.some(
        (p) =>
          !Number.isSafeInteger(p.pageNumber) ||
          p.pageNumber < 0 ||
          p.memoryIds.length !== p.messages.length,
      ) ||
      (transcript.state === 'COMPLETE' &&
        (transcript.finalPageNumber === undefined ||
          pages.length !== transcript.finalPageNumber + 1 ||
          pages.some((p) => p.pageNumber > transcript.finalPageNumber)))
    )
      throw new Error('BACKUP_TRANSCRIPT_PAGE_REFERENCE_MISSING');
  }
  if (
    (rows.homeTravelTranscriptPages ?? []).some(
      (p) => !(rows.homeTravelTranscripts ?? []).some((t) => t.transcriptId === p.transcriptId),
    )
  )
    throw new Error('BACKUP_TRANSCRIPT_REFERENCE_MISSING');
  const homeBinding = await ctx.db
    .query('residentModelBindings')
    .withIndex('globalAgent', (q) => q.eq('agentGlobalId', binding.agentGlobalId))
    .unique();
  const targetWorldId =
    args.targetWorldId ?? homeBinding?.worldId ?? (sourceWorld._id as Id<'worlds'>);
  const world = await ctx.db.get(targetWorldId);
  const status = await ctx.db
    .query('worldStatus')
    .withIndex('worldId', (q) => q.eq('worldId', targetWorldId))
    .unique();
  const engine = status ? await ctx.db.get(status.engineId) : null;
  if (!world || !status || !engine) throw new Error('RESIDENT_RESTORE_TARGET_WORLD_REQUIRED');
  if (engine.running || status.status !== 'stoppedByDeveloper')
    throw new Error('STOP_TARGET_ENGINE_FIRST');
  const pendingInput = await ctx.db
    .query('inputs')
    .withIndex('byInputNumber', (q) =>
      q.eq('engineId', engine._id).gt('number', engine.processedInputNumber ?? -1),
    )
    .first();
  const activeChat = await ctx.db
    .query('federationLlmRequests')
    .filter((q) => q.gt(q.field('expiresAt'), Date.now()))
    .first();
  const currentAgent = world.agents.find((a) => a.id === agent.id);
  if (
    pendingInput ||
    activeChat ||
    (currentAgent?.inProgressOperation &&
      currentAgent.inProgressOperation.started + ACTION_TIMEOUT > Date.now())
  )
    throw new Error('DRAIN_TARGET_WORK_BEFORE_RESIDENT_RESTORE');
  if (
    homeBinding &&
    (homeBinding.worldId !== targetWorldId || homeBinding.playerId !== binding.playerId)
  )
    throw new Error('RESIDENT_HOME_OWNER_MISMATCH');
  const occupiedBinding = await ctx.db
    .query('residentModelBindings')
    .withIndex('resident', (q) => q.eq('worldId', targetWorldId).eq('playerId', binding.playerId))
    .unique();
  if (occupiedBinding && occupiedBinding.agentGlobalId !== binding.agentGlobalId)
    throw new Error('RESIDENT_HOME_OWNER_MISMATCH');
  if (
    world.agents.some(
      (a) =>
        (a.id === agent.id || a.playerId === agent.playerId) &&
        (a.id !== agent.id || a.playerId !== agent.playerId),
    ) ||
    world.players.some((p) => p.id === player.id && (p.remoteVisitor || p.human))
  )
    throw new Error('RESIDENT_LOCAL_ID_CONFLICT');
  if (world.agents.find((a) => a.id === agent.id)?.travelVisitId)
    throw new Error('RECONCILE_TARGET_RESIDENT_TRAVEL_FIRST');
  if (world.conversations.some((c) => c.participants.some((p) => p.playerId === binding.playerId)))
    throw new Error('END_RESIDENT_CONVERSATION_BEFORE_RESTORE');
  const runtime = await ctx.db
    .query('federationAgentRuntimes')
    .withIndex('globalId', (q) => q.eq('agentGlobalId', binding.agentGlobalId))
    .unique();
  if (
    runtime &&
    (runtime.worldId !== targetWorldId ||
      runtime.playerId !== binding.playerId ||
      runtime.agentId !== agent.id ||
      runtime.homeTownId !== local.townId ||
      runtime.state !== 'HOME_ACTIVE' ||
      runtime.visitId)
  )
    throw new Error('RECONCILE_TARGET_RESIDENT_TRAVEL_FIRST');
  if (runtime?.activeDecisionId) throw new Error('DRAIN_TARGET_WORK_BEFORE_RESIDENT_RESTORE');
  const visits = bounded(
    await ctx.db
      .query('visitLedger')
      .withIndex('agentGlobalId', (q) => q.eq('agentGlobalId', binding.agentGlobalId))
      .take(501),
  );
  if (visits.some((v) => !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(v.state)))
    throw new Error('RECONCILE_TARGET_RESIDENT_TRAVEL_FIRST');
  const targetMemories = bounded(
    await ctx.db
      .query('memories')
      .withIndex('resident', (q) => q.eq('worldId', targetWorldId).eq('playerId', binding.playerId))
      .take(501),
  );
  const legacyMemories = bounded(
    await ctx.db
      .query('memories')
      .withIndex('playerId', (q) => q.eq('playerId', binding.playerId))
      .filter((q) => q.eq(q.field('worldId'), undefined))
      .take(501),
  );
  if (legacyMemories.length) {
    const owners = await ctx.db
      .query('residentModelBindings')
      .filter((q) => q.eq(q.field('playerId'), binding.playerId))
      .take(2);
    if (owners.length !== 1 || owners[0].worldId !== targetWorldId)
      throw new Error('LEGACY_MEMORY_OWNER_AMBIGUOUS');
    targetMemories.push(...legacyMemories);
    bounded(targetMemories);
  }
  const mapping: Record<string, string> = { [sourceWorld._id]: targetWorldId };
  const priorImports = bounded(
    await ctx.db
      .query('backupImports')
      .filter((q) => q.eq(q.field('sourceTownId'), local.townId))
      .order('desc')
      .take(501),
  );
  const memoryTargets = new Map<string, BackupRow | null>();
  for (const memory of rows.memories ?? []) {
    let existing = await ctx.db.get(memory._id as Id<'memories'>);
    if (!existing)
      for (const record of priorImports) {
        if (
          !['restore', 'migrate'].includes(record.mode) ||
          record.mapping?.[sourceWorld._id] !== targetWorldId
        )
          continue;
        const mappedId = record.mapping?.[memory._id];
        if (typeof mappedId !== 'string') continue;
        const candidate = await ctx.db.get(mappedId as Id<'memories'>);
        if (candidate) {
          existing = candidate;
          break;
        }
      }
    if (
      existing &&
      ((existing.worldId !== targetWorldId &&
        !legacyMemories.some((m) => m._id === existing?._id)) ||
        existing.playerId !== binding.playerId ||
        (existing.agentGlobalId && existing.agentGlobalId !== binding.agentGlobalId))
    )
      throw new Error('RESIDENT_MEMORY_ID_CONFLICT');
    memoryTargets.set(memory._id, existing);
    if (existing) mapping[memory._id] = existing._id;
  }
  const profiles = bounded(await ctx.db.query('chatProfiles').take(501));
  const profileDigest = await digest(profileFields(profile));
  let targetProfile: BackupRow | undefined;
  for (const candidate of profiles)
    if ((await digest(profileFields(candidate))) === profileDigest) {
      targetProfile = candidate;
      break;
    }
  const targets: Record<string, BackupRow[]> = {};
  for (const name of restoreTables) {
    targets[name] = [];
    for (const row of rows[name] ?? []) {
      const fields = remapValue(row, mapping);
      const existing = await existingRow(ctx, name, fields);
      if (existing) {
        if (name === 'homeTravelTranscripts' && (existing as BackupRow).summaryState === 'RUNNING')
          throw new Error('DRAIN_TARGET_WORK_BEFORE_RESIDENT_RESTORE');
        targets[name].push(existing);
        mapping[row._id] = existing._id;
        if (
          sharedHistory.has(name) &&
          (await digest(stripSystem(existing))) !== (await digest(stripSystem(fields)))
        )
          throw new Error('RESIDENT_SHARED_HISTORY_CONFLICT');
      }
    }
  }
  const snapshot = {
    identity: {
      townId: local.townId,
      deploymentInstanceId: local.deploymentInstanceId,
      deploymentEpoch: local.deploymentEpoch,
      mode: local.mode,
      enabled: local.enabled,
    },
    world,
    status,
    engine,
    binding: homeBinding,
    runtime,
    memories: targetMemories,
    history: targets,
    profiles,
  };
  if (new TextEncoder().encode(encodeRow({ snapshot, manifest: bundle.manifest })).length > 900_000)
    throw new Error('RESIDENT_RESTORE_TARGET_TOO_LARGE');
  const targetDigest = await digest({
    snapshot: encodeRow(snapshot),
    sourceManifest: bundle.manifest,
  });
  const counts = Object.fromEntries(
    Object.entries(rows).map(([name, values]) => [name, values.length]),
  );
  return {
    bundle,
    rows,
    local,
    world,
    binding,
    agent,
    player,
    targetProfile,
    homeBinding,
    runtime,
    memoryTargets,
    mapping,
    targets,
    snapshot,
    targetDigest,
    counts,
    report: {
      agentGlobalId: binding.agentGlobalId as string,
      targetWorldId,
      targetDigest,
      memoryCount: rows.memories?.length ?? 0,
      existingMemoriesPreserved: targetMemories.length,
      model: {
        sourceProfileId: profile._id as string,
        targetProfileId: targetProfile?._id as string | undefined,
        model: profile.model as string,
        credentialConfigured: !profile.apiKeyEnv || Boolean(process.env[profile.apiKeyEnv]),
      },
      conflictPolicy: 'RESTORE_ARCHIVED_RECORDS_KEEP_NEWER_MEMORY_IDS' as const,
      runtimePolicy: 'NO_SNAPSHOT_REPLAY' as const,
    },
  };
}

export async function applyResidentRestore(ctx: MutationCtx, args: Args) {
  const plan = await residentRestorePlan(ctx, args);
  const confirmation = args.residentRestore;
  if (
    !confirmation?.confirmOverwrite ||
    !confirmation.operator.trim() ||
    confirmation.operator.length > 120 ||
    !confirmation.reason.trim() ||
    confirmation.reason.length > 1000
  )
    throw new Error('RESIDENT_RESTORE_CONFIRMATION_REQUIRED');
  if (confirmation.expectedTargetDigest !== plan.targetDigest)
    throw new Error('RESIDENT_RESTORE_TARGET_CHANGED');
  const { rows, mapping, world, binding, agent, player } = plan;
  const now = Date.now();
  const importId = await ctx.db.insert('backupImports', {
    sourceTownId: plan.local.townId,
    mode: 'restore',
    exportedAt: plan.bundle.manifest.exportedAt,
    importedAt: now,
    sourceStoppedAt: now,
    mapping: {},
    runtimeSnapshot: {
      scope: 'resident',
      targetSnapshot: plan.snapshot,
      sourceRuntime: rows.federationAgentRuntimes ?? [],
    },
    manifest: {
      ...plan.bundle.manifest,
      residentRestore: {
        ...plan.report,
        operator: confirmation.operator.trim(),
        reason: confirmation.reason.trim(),
      },
    },
  });
  const profileId =
    plan.targetProfile?._id ??
    (await ctx.db.insert('chatProfiles', stripSystem(rows.chatProfiles[0]) as never));
  mapping[rows.chatProfiles[0]._id] = profileId;
  const bindingFields = {
    ...stripSystem(binding),
    worldId: world._id,
    chatProfileId: profileId,
    updatedAt: now,
  };
  const bindingId =
    plan.homeBinding?._id ?? (await ctx.db.insert('residentModelBindings', bindingFields as never));
  if (plan.homeBinding) await ctx.db.replace(plan.homeBinding._id, bindingFields as never);
  mapping[binding._id] = bindingId;
  const currentPlayer = world.players.find((p) => p.id === player.id);
  let restoredPlayer: BackupRow = {
    ...stripSystem(currentPlayer ?? player),
    pathfinding: undefined,
    activity: undefined,
    speed: 0,
  };
  if (!currentPlayer) {
    const mapDoc = await ctx.db
      .query('maps')
      .withIndex('worldId', (q) => q.eq('worldId', world._id))
      .unique();
    if (!mapDoc) throw new Error('RESIDENT_RESTORE_TARGET_MAP_REQUIRED');
    const map = new WorldMap(mapDoc),
      occupied = world.players.map((p) => p.position);
    if (blockedWithPositions(restoredPlayer.position, occupied, map)) {
      let position;
      for (let x = 0; x < map.width && !position; x++)
        for (let y = 0; y < map.height && !position; y++) {
          if (x * map.height + y > 100000) throw new Error('RESIDENT_RESTORE_SPAWN_SCAN_BUDGET');
          if (!blockedWithPositions({ x, y }, occupied, map)) position = { x, y };
        }
      if (!position) throw new Error('RESIDENT_RESTORE_NO_AVAILABLE_POSITION');
      restoredPlayer = { ...restoredPlayer, position };
    }
  }
  const { inProgressOperation, toRemember, travelVisitId, suspendedPlayer, ...restoredAgent } =
    stripSystem(agent);
  await ctx.db.patch(world._id, {
    players: [...world.players.filter((p) => p.id !== player.id), restoredPlayer] as never,
    agents: [...world.agents.filter((a) => a.id !== agent.id), restoredAgent] as never,
    nextId: Math.max(
      world.nextId,
      Number(player.id.split(':')[1]) + 1,
      Number(agent.id.split(':')[1]) + 1,
    ),
  });
  if (plan.runtime)
    await ctx.db.patch(plan.runtime._id, {
      agentAuthorityEpoch: plan.runtime.agentAuthorityEpoch + 1,
      activeDecisionId: undefined,
      lastError: undefined,
      updatedAt: now,
    });
  for (const row of rows.memories ?? []) {
    const { embeddingId, embeddingSpaceId, ...canonical } = stripSystem(row);
    const fields = {
      ...canonical,
      worldId: world._id,
      agentGlobalId: binding.agentGlobalId,
      data:
        row.data.type === 'reflection'
          ? { ...row.data, relatedMemoryIds: [] }
          : row.data.type === 'relationship'
            ? { ...row.data, evidenceMemoryIds: [] }
            : row.data,
    };
    const existing = plan.memoryTargets.get(row._id);
    const memoryId = existing?._id ?? (await ctx.db.insert('memories', fields as never));
    mapping[row._id] = memoryId;
    if (existing) await ctx.db.replace(existing._id as Id<'memories'>, fields as never);
    for (const vector of bounded(
      await ctx.db
        .query('modelMemoryVectors')
        .withIndex('memory_space', (q) => q.eq('memoryId', memoryId))
        .take(501),
    ))
      await ctx.db.delete(vector._id);
  }
  for (const row of rows.memories ?? []) {
    const { embeddingId, embeddingSpaceId, ...canonical } = stripSystem(row);
    await ctx.db.replace(
      mapping[row._id] as Id<'memories'>,
      remapValue({ ...canonical, agentGlobalId: binding.agentGlobalId }, mapping) as never,
    );
  }
  for (const name of restoreTables)
    for (const row of rows[name] ?? []) {
      let fields = remapValue(stripSystem(row), mapping);
      if (name === 'homeTravelTranscripts' && fields.summaryState === 'RUNNING')
        fields = {
          ...fields,
          summaryState: 'FAILED',
          summaryStartedAt: undefined,
          summaryError: 'BACKUP_RESTORE_INTERRUPTED_SUMMARY',
        };
      const existing = await existingRow(ctx, name, fields);
      // Shared history and the other participant's current persona are never overwritten.
      const preserve =
        sharedHistory.has(name) ||
        (name === 'playerDescriptions' && row.playerId !== binding.playerId);
      if (existing && preserve) {
        if (
          sharedHistory.has(name) &&
          (await digest(stripSystem(existing))) !== (await digest(fields))
        )
          throw new Error('RESIDENT_SHARED_HISTORY_CONFLICT');
        mapping[row._id] = existing._id;
      } else if (existing) {
        await ctx.db.replace(existing._id, fields as never);
        mapping[row._id] = existing._id;
      } else mapping[row._id] = await ctx.db.insert(tableName(name), fields as never);
    }
  await ctx.db.patch(importId, { mapping });
  for (const row of rows.memories ?? [])
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'action'>('models/embeddings:indexMemory'),
      { memoryId: mapping[row._id] },
    );
  return {
    mode: 'restore' as const,
    worldIds: [world._id],
    mapping,
    rebuildRequired: true as const,
    importId,
    residentRestoreReport: plan.report,
  };
}
