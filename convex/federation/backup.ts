import { ObjectType, v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import {
  action,
  mutation,
  internalMutation,
  internalQuery,
  query,
  DatabaseReader,
  MutationCtx,
  QueryCtx,
} from '../maintenanceFunctions';
import { Doc, Id, TableNames } from '../_generated/dataModel';
import { blockedWithPositions } from '../aiTown/movement';
import { WorldMap } from '../aiTown/worldMap';
import { Point } from '../util/types';
import { playerId } from '../aiTown/ids';
import { requireAdmin, createIdentityKeys, sign } from './security';
import { LEASE_SAFETY_MS, normalizeEndpoint } from './protocol';
import { identity } from './store';
import {
  BackupBundle,
  BackupRow,
  ImportMode,
  createBundle,
  dataTables,
  decodeRow,
  encodeRow,
  remapValue,
  snapshotTables,
  stripSystem,
  validateBundle,
  validateFields,
  restoredAutonomyFields,
} from './backupHelpers';
import { ensureEmbeddingSpace } from '../models/embeddings';
import schema from '../schema';
import { validateConnection } from '../models/profiles';
import { embeddingFingerprint } from '../models/compatibility';
import { assertNoIdentityConflict } from './identityConflict';
import { applyResidentRestore, residentRestoreConfirmation, residentRestorePlan } from './backupResident';

const mode = v.union(
  v.literal('restore'),
  v.literal('migrate'),
  v.literal('clone'),
  v.literal('merge'),
);
const importArgs = {
  adminToken: v.string(),
  bundle: v.optional(v.any()),
  bundleJson: v.optional(v.string()),
  mode,
  targetWorldId: v.optional(v.id('worlds')),
  sourceStopped: v.optional(v.boolean()),
  targetEndpoint: v.optional(v.string()),
  residentRestore: v.optional(residentRestoreConfirmation),
};
const table = (name: string) => name as TableNames;
function importBundle(args: { bundle?: unknown; bundleJson?: string }): unknown {
  if (args.bundleJson !== undefined && args.bundle !== undefined) throw new Error('BACKUP_TRANSPORT_AMBIGUOUS');
  const json = args.bundleJson ?? (typeof args.bundle === 'string' ? args.bundle : undefined);
  if (json !== undefined) {
    if (new TextEncoder().encode(json).length > 5_000_000) throw new Error('BACKUP_SIZE_LIMIT');
    return JSON.parse(json);
  }
  return args.bundle;
}

function sanitize(value: any): any {
  if (value instanceof ArrayBuffer || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/(privateKey|secretEncrypted|credentialEncrypted|ephemeralPrivate|apiKey$|adminToken|fencingToken)/i.test(
            key,
          ),
      )
      .map(([key, item]) => [key, sanitize(item)]),
  );
}
async function collect(db: DatabaseReader): Promise<Record<string, BackupRow[]>> {
  const rows: Record<string, BackupRow[]> = {};
  for (const name of [...dataTables, ...snapshotTables, 'federationIdentity', 'federationPeers']) {
    rows[name] = (await db.query(table(name)).take(501)).map(sanitize);
  }
  for (const memory of rows.memories)
    if (!memory.worldId) {
      const owners = rows.residentModelBindings.filter((b) => b.playerId === memory.playerId);
      if (owners.length !== 1) throw new Error('LEGACY_MEMORY_OWNER_AMBIGUOUS');
      memory.worldId = owners[0].worldId;
      memory.agentGlobalId = owners[0].agentGlobalId;
    }
  return rows;
}
export const getTown = internalQuery({
  args: { adminToken: v.string() },
  handler: async (ctx, args): Promise<BackupBundle> => {
    requireAdmin(args.adminToken);
    const local = await identity(ctx);
    if (!local) throw new Error('INITIALIZE_IDENTITY_FIRST');
    const bundle = await createBundle(local.townId, 'town', await collect(ctx.db));
    bundle.signature = await sign(bundle.manifest, local.privateKeyEncrypted);
    await validateBundle(bundle);
    return bundle;
  },
});
export const getResident = internalQuery({
  args: { adminToken: v.string(), worldId: v.id('worlds'), playerId },
  handler: async (ctx, args): Promise<BackupBundle> => {
    requireAdmin(args.adminToken);
    const local = await identity(ctx);
    if (!local) throw new Error('INITIALIZE_IDENTITY_FIRST');
    // A small resident archive must not first collect/truncate the whole town.
    // Bound only this resident's canonical records; the final bundle cap still
    // redirects residents with large histories to the paginated archive format.
    const world = await ctx.db.get(args.worldId);
    const agent = world?.agents.find((a) => a.playerId === args.playerId);
    if (!world || !agent) throw new Error('RESIDENT_NOT_FOUND');
    const binding = await ctx.db.query('residentModelBindings')
      .withIndex('resident', q => q.eq('worldId', args.worldId).eq('playerId', args.playerId)).unique();
    if (!binding) throw new Error('RESIDENT_BINDING_MISSING');
    const history = await ctx.db.query('participatedTogether')
      .withIndex('playerHistory', q => q.eq('worldId', args.worldId).eq('player1', args.playerId)).take(501);
    const archived: BackupRow[] = [];
    const messages: BackupRow[] = [];
    for (const conversationId of new Set(history.map(h => h.conversationId))) {
      const conversation = await ctx.db.query('archivedConversations')
        .withIndex('worldId', q => q.eq('worldId', args.worldId).eq('id', conversationId)).unique();
      if (conversation) archived.push(conversation);
      if (messages.length < 501) messages.push(...await ctx.db.query('messages')
        .withIndex('conversationId', q => q.eq('worldId', args.worldId).eq('conversationId', conversationId))
        .take(501 - messages.length));
    }
    const descriptions: BackupRow[] = [];
    const oldPlayers: BackupRow[] = [];
    const related = new Set([args.playerId, ...archived.flatMap(c => c.participants)]);
    for (const relatedPlayer of related) {
      const description = await ctx.db.query('playerDescriptions').withIndex('worldId', q =>
        q.eq('worldId', args.worldId).eq('playerId', relatedPlayer)).unique();
      if (description) descriptions.push(description);
      const oldPlayer = await ctx.db.query('archivedPlayers').withIndex('worldId', q =>
        q.eq('worldId', args.worldId).eq('id', relatedPlayer)).first();
      if (oldPlayer) oldPlayers.push(oldPlayer);
    }
    const all: Record<string, BackupRow[]> = {
      worlds: [world], residentModelBindings: [binding],
      memories: await ctx.db.query('memories').withIndex('resident', q => q.eq('worldId', args.worldId).eq('playerId', args.playerId)).take(501),
      maps: await ctx.db.query('maps').withIndex('worldId', q => q.eq('worldId', args.worldId)).take(2),
      playerDescriptions: descriptions,
      agentDescriptions: await ctx.db.query('agentDescriptions').withIndex('worldId', q => q.eq('worldId', args.worldId).eq('agentId', agent.id)).take(2),
      chatProfiles: [await ctx.db.get(binding.chatProfileId)].filter((p): p is Doc<'chatProfiles'> => !!p),
      federationAgentRuntimes: await ctx.db.query('federationAgentRuntimes').withIndex('world', q => q.eq('worldId', args.worldId).eq('playerId', args.playerId)).take(2),
      archivedConversations: archived, messages, participatedTogether: history,
      archivedPlayers: oldPlayers, federationIdentity: [sanitize(local)],
    };
    // Unscoped legacy memories can only be attributed when the local player ID
    // has exactly one fixed Home binding across all worlds.
    const legacy = await ctx.db.query('memories').withIndex('playerId', q => q.eq('playerId', args.playerId))
      .filter(q => q.eq(q.field('worldId'), undefined)).take(501);
    if (legacy.length) {
      const owners = await ctx.db.query('residentModelBindings').filter(q => q.eq(q.field('playerId'), args.playerId)).take(2);
      if (owners.length !== 1) throw new Error('LEGACY_MEMORY_OWNER_AMBIGUOUS');
      all.memories.push(...legacy.map(m => ({ ...m, worldId: args.worldId, agentGlobalId: binding.agentGlobalId })));
    }
    const rows: Record<string, BackupRow[]> = {};
    const memories = all.memories.filter(
      (m) => m.worldId === args.worldId && m.playerId === args.playerId,
    );
    for (const name of dataTables) rows[name] = [];
    rows.worlds = [
      {
        ...world,
        players: world.players.filter((p: BackupRow) => p.id === args.playerId),
        agents: [agent],
        conversations: [],
        historicalLocations: [],
      },
    ];
    rows.maps = all.maps.filter((m) => m.worldId === args.worldId);
    rows.playerDescriptions = all.playerDescriptions.filter(
      (d) => d.worldId === args.worldId && d.playerId === args.playerId,
    );
    rows.agentDescriptions = all.agentDescriptions.filter(
      (d) => d.worldId === args.worldId && d.agentId === agent.id,
    );
    rows.residentModelBindings = binding ? [binding] : [];
    rows.chatProfiles = all.chatProfiles.filter((p) => p._id === binding?.chatProfileId);
    rows.memories = memories;
    rows.federationAgentRuntimes = all.federationAgentRuntimes.filter(
      (r) => r.worldId === args.worldId && r.playerId === args.playerId,
    );
    const conversations = all.archivedConversations.filter(
      (c) => c.worldId === args.worldId && c.participants.includes(args.playerId),
    );
    const conversationIds = new Set(conversations.map((c) => c.id));
    rows.archivedConversations = conversations;
    rows.messages = all.messages.filter(
      (m) => m.worldId === args.worldId && conversationIds.has(m.conversationId),
    );
    rows.participatedTogether = all.participatedTogether.filter(
      (p) =>
        p.worldId === args.worldId && (p.player1 === args.playerId || p.player2 === args.playerId),
    );
    const relatedPlayers = new Set(conversations.flatMap((c) => c.participants));
    rows.archivedPlayers = all.archivedPlayers.filter(
      (p) => p.worldId === args.worldId && relatedPlayers.has(p.id),
    );
    rows.playerDescriptions = all.playerDescriptions.filter(
      (p) =>
        p.worldId === args.worldId &&
        (p.playerId === args.playerId || relatedPlayers.has(p.playerId)),
    );
    for (const current of world.players)
      if (current.id !== args.playerId && relatedPlayers.has(current.id))
        rows.archivedPlayers.push({
          ...current,
          _id: `snapshot-player:${world._id}:${current.id}`,
          _creationTime: world._creationTime,
          worldId: world._id,
        });
    rows.homeTravelTranscripts = await ctx.db.query('homeTravelTranscripts')
      .withIndex('owner_transcript', q => q.eq('agentGlobalId', binding.agentGlobalId!)).take(501);
    rows.homeTravelTranscriptPages = await ctx.db.query('homeTravelTranscriptPages')
      .withIndex('owner_transcript_page', q => q.eq('agentGlobalId', binding.agentGlobalId!)).take(501);
    rows.federationIdentity = all.federationIdentity;
    rows.federationPeers = [];
    const bundle = await createBundle(local.townId, 'resident', rows);
    bundle.signature = await sign(bundle.manifest, local.privateKeyEncrypted);
    await validateBundle(bundle);
    return bundle;
  },
});

async function checkImport(
  ctx: QueryCtx | MutationCtx,
  args: {
    bundle?: unknown;
    mode: ImportMode;
    targetWorldId?: Id<'worlds'>;
    sourceStopped?: boolean;
    targetEndpoint?: string;
  },
) {
  const bundle = await validateBundle(args.bundle);
  await assertNoIdentityConflict(ctx);
  if (decodeRow(bundle.sections.federationIdentity[0]).mode === 'QUARANTINED')
    throw new Error('TOWN_CLONE_CONFLICT');
  const local = await identity(ctx);
  if (bundle.manifest.scope === 'resident' && args.mode !== 'merge')
    throw new Error('RESIDENT_BACKUP_REQUIRES_MERGE');
  if (args.mode === 'clone') {
    if (!args.targetEndpoint) throw new Error('CLONE_ENDPOINT_REQUIRED');
    normalizeEndpoint(args.targetEndpoint);
    if (local || (await ctx.db.query('worlds').first()))
      throw new Error('CLONE_REQUIRES_EMPTY_DESTINATION');
  } else if (args.mode === 'merge') {
    if (!local || !args.targetWorldId || !(await ctx.db.get(args.targetWorldId)))
      throw new Error('MERGE_TARGET_REQUIRED');
    const status = await ctx.db
      .query('worldStatus')
      .withIndex('worldId', (q) => q.eq('worldId', args.targetWorldId!))
      .unique();
    if (!status || (await ctx.db.get(status.engineId))?.running)
      throw new Error('STOP_TARGET_ENGINE_FIRST');
  } else {
    const source = decodeRow(bundle.sections.federationIdentity[0]);
    if (
      !local ||
      local.townId !== source.townId ||
      local.fingerprint !== source.fingerprint ||
      local.publicKey !== source.publicKey
    )
      throw new Error('RESTORE_IDENTITY_PROOF_REQUIRED');
    if (!args.sourceStopped)
      throw new Error(
        args.mode === 'migrate' ? 'MIGRATION_SOURCE_STOP_REQUIRED' : 'RESTORE_SOURCE_STOP_REQUIRED',
      );
    if ((await ctx.db.query('engines').collect()).some((e) => e.running))
      throw new Error('STOP_TARGET_ENGINE_FIRST');
    const visits = await ctx.db.query('visitLedger').collect();
    if (visits.some((v) => !['COMPLETED', 'REJECTED'].includes(v.state)))
      throw new Error('RECONCILE_TARGET_VISITS_FIRST');
  }
  const rows = Object.fromEntries(
    Object.entries(bundle.sections).map(([key, values]) => [key, values.map(decodeRow)]),
  );
  for (const name of dataTables) {
    const definition = schema.tables[table(name)];
    for (const row of rows[name] ?? [])
      validateFields(stripSystem(row), (definition.validator as unknown as { json: unknown }).json);
  }
  for (const profile of [...(rows.chatProfiles ?? []), ...(rows.embeddingProfiles ?? [])])
    validateConnection(profile as never);
  for (const profile of rows.embeddingProfiles ?? [])
    if (
      !Number.isSafeInteger(profile.dimensions) ||
      profile.dimensions < 1 ||
      profile.dimensions > 16384 ||
      profile.preprocessingRevision !== 'newline-to-space-v1' ||
      profile.normalization !== 'none'
    )
      throw new Error('UNSUPPORTED_BACKUP_EMBEDDING_CONFIGURATION');
    else if (profile.fingerprint !== embeddingFingerprint(profile as never))
      throw new Error('EMBEDDING_FINGERPRINT_MISMATCH');
  if ((rows.federationResourcePolicy?.length ?? 0) > 1) throw new Error('BACKUP_SINGLETON_MISMATCH');
  if (args.mode === 'merge' && rows.worlds?.length !== 1)
    throw new Error('MERGE_REQUIRES_SINGLE_WORLD_PACKAGE');
  validateFields(
    { ...stripSystem(rows.federationIdentity[0]), privateKeyEncrypted: '' },
    (schema.tables.federationIdentity.validator as unknown as { json: unknown }).json,
  );
  for (const peer of rows.federationPeers ?? [])
    validateFields(
      { ...stripSystem(peer), credentialEncrypted: '' },
      (schema.tables.federationPeers.validator as unknown as { json: unknown }).json,
    );
  const worldIds = new Set(rows.worlds?.map((w) => w._id));
  const engineIds = new Set(rows.engines?.map((e) => e._id));
  if (rows.worldStatus?.some((s) => !worldIds.has(s.worldId) || !engineIds.has(s.engineId)))
    throw new Error('BACKUP_ENGINE_REFERENCE_MISSING');
  const profileIds = new Set(rows.chatProfiles?.map((p) => p._id));
  for (const binding of rows.residentModelBindings ?? []) {
    if (!worldIds.has(binding.worldId) || !profileIds.has(binding.chatProfileId))
      throw new Error('BACKUP_BINDING_REFERENCE_MISSING');
  }
  for (const name of [
    'maps',
    'playerDescriptions',
    'agentDescriptions',
    'memories',
    'messages',
    'archivedPlayers',
    'archivedAgents',
    'archivedConversations',
    'participatedTogether',
    'homeTravelTranscripts',
    'autonomousTravelPolicies',
    'autonomousTravelDecisions',
  ]) {
    if ((rows[name] ?? []).some((r) => r.worldId && !worldIds.has(r.worldId)))
      throw new Error('BACKUP_WORLD_REFERENCE_MISSING');
  }
  const travelPolicyIds = new Set((rows.autonomousTravelPolicies ?? []).map(p => p._id));
  if ((rows.autonomousTravelDecisions ?? []).some(d => !travelPolicyIds.has(d.policyId)))
    throw new Error('BACKUP_AUTONOMOUS_POLICY_REFERENCE_MISSING');
  for (const policy of rows.autonomousTravelPolicies ?? [])
    if (!(rows.residentModelBindings ?? []).some(b => b.worldId === policy.worldId &&
        b.playerId === policy.playerId && b.agentGlobalId === policy.agentGlobalId))
      throw new Error('BACKUP_AUTONOMOUS_POLICY_OWNER_MISMATCH');
  for (const decision of rows.autonomousTravelDecisions ?? [])
    if (!(rows.autonomousTravelPolicies ?? []).some(p => p._id === decision.policyId &&
        p.worldId === decision.worldId && p.playerId === decision.playerId && p.agentGlobalId === decision.agentGlobalId))
      throw new Error('BACKUP_AUTONOMOUS_DECISION_OWNER_MISMATCH');
  if (rows.memories?.some((m) => !m.worldId)) throw new Error('LEGACY_MEMORY_OWNER_AMBIGUOUS');
  const spaceIds = new Set(rows.embeddingSpaces?.map((s) => s._id));
  const embeddingProfiles = new Map(rows.embeddingProfiles?.map((p) => [p._id, p]));
  for (const space of rows.embeddingSpaces ?? [])
    if (
      !embeddingProfiles.has(space.profileId) ||
      embeddingProfiles.get(space.profileId)!.fingerprint !== space.fingerprint
    )
      throw new Error('BACKUP_EMBEDDING_SPACE_REFERENCE_MISSING');
  for (const config of rows.modelSettings ?? [])
    if (
      (config.mainChatProfileId && !profileIds.has(config.mainChatProfileId)) ||
      (config.activeEmbeddingSpaceId && !spaceIds.has(config.activeEmbeddingSpaceId))
    )
      throw new Error('BACKUP_SETTINGS_REFERENCE_MISSING');
  for (const world of rows.worlds ?? []) {
    for (const agent of world.agents)
      if (
        !(rows.residentModelBindings ?? []).some(
          (b) => b.worldId === world._id && b.playerId === agent.playerId,
        )
      )
        throw new Error('BACKUP_RESIDENT_BINDING_MISSING');
    if (args.mode !== 'merge' && !(rows.maps ?? []).some((m) => m.worldId === world._id))
      throw new Error('BACKUP_MAP_REFERENCE_MISSING');
  }
  const memoryIds = new Set(rows.memories?.map((m) => m._id));
  if (
    rows.memories?.some(
      (m) =>
        m.data?.type === 'reflection' &&
        m.data.relatedMemoryIds.some((id: string) => !memoryIds.has(id)),
    )
  )
    throw new Error('BACKUP_REFLECTION_REFERENCE_MISSING');
  for (const memory of rows.memories ?? []) {
    if (memory.data?.type === 'relationship' && (memory.data.evidenceMemoryIds ?? []).some((id: string) => !memoryIds.has(id)))
      throw new Error('BACKUP_RELATIONSHIP_REFERENCE_MISSING');
  }
  for (const transcript of rows.homeTravelTranscripts ?? []) {
    if (!(rows.residentModelBindings ?? []).some(b => b.worldId === transcript.worldId && b.playerId === transcript.playerId && b.agentGlobalId === transcript.agentGlobalId))
      throw new Error('BACKUP_TRANSCRIPT_OWNER_MISSING');
    if ([transcript.endMemoryId, transcript.summaryMemoryId].some(id => id && !memoryIds.has(id)))
      throw new Error('BACKUP_TRANSCRIPT_MEMORY_REFERENCE_MISSING');
    const pages = (rows.homeTravelTranscriptPages ?? []).filter(p => p.agentGlobalId === transcript.agentGlobalId && p.transcriptId === transcript.transcriptId);
    const pageNumbers = new Set(pages.map(p => p.pageNumber));
    if (pageNumbers.size !== pages.length || pages.length !== transcript.receivedPageCount ||
        pages.reduce((sum, p) => sum + p.messages.length, 0) !== transcript.totalMessageCount ||
        pages.some(p => p.memoryIds.length !== p.messages.length || p.memoryIds.some((id: string) => !memoryIds.has(id))) ||
        (transcript.state === 'COMPLETE' && (transcript.finalPageNumber === undefined || pages.length !== transcript.finalPageNumber + 1 ||
          pages.some(p => p.pageNumber < 0 || p.pageNumber > transcript.finalPageNumber))))
      throw new Error('BACKUP_TRANSCRIPT_PAGE_REFERENCE_MISSING');
  }
  if ((rows.homeTravelTranscriptPages ?? []).some(p => !(rows.homeTravelTranscripts ?? []).some(t => t.agentGlobalId === p.agentGlobalId && t.transcriptId === p.transcriptId)))
    throw new Error('BACKUP_TRANSCRIPT_REFERENCE_MISSING');
  return { bundle, local, rows };
}
export const checkPreflight = internalQuery({
  args: importArgs,
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    args = { ...args, bundle: importBundle(args) };
    if (args.mode === 'restore' && args.bundle?.manifest?.scope === 'resident') {
      const plan = await residentRestorePlan(ctx, args);
      return { valid: true as const, mode: args.mode, scope: 'resident', counts: plan.counts, vectorPolicy: 'REBUILD' as const,
        warnings: ['Only this Home resident is restored; newer memory IDs and other residents are retained.',
          'Runtime snapshots, travel leases and pending jobs are not replayed.',
          'Confirm the target digest before applying the resident restore.'], residentRestorePlan: plan.report };
    }
    const { bundle, rows } = await checkImport(ctx, args);
    return {
      valid: true as const,
      mode: args.mode,
      scope: bundle.manifest.scope,
      counts: Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values.length])),
      vectorPolicy: 'REBUILD' as const,
      warnings: [
        'Imported vectors and caches are rebuilt.',
        'Peer credentials require pairing again.',
        'Runtime snapshots are retained for reconciliation and never replayed.',
      ],
    };
  },
});
export const importBackup = action({
  args: importArgs,
  handler: async (
    ctx,
    args,
  ): Promise<{
    mode: ImportMode;
    worldIds: string[];
    mapping: Record<string, string>;
    rebuildRequired: true;
    importId?: Id<'backupImports'>;
    residentRestoreReport?: Awaited<ReturnType<typeof residentRestorePlan>>['report'];
  }> => {
    requireAdmin(args.adminToken);
    // Generate fresh identity material outside the database transaction; never accept an imported private key.
    const keys = args.mode === 'clone' ? await createIdentityKeys() : undefined;
    return ctx.runMutation(makeFunctionReference<'mutation'>('federation/backup:applyImport'), {
      ...args,
      keys,
    });
  },
});

function mergePosition(map: WorldMap, occupied: Point[], desired: Point): Point {
  if (!blockedWithPositions(desired, occupied, map)) return desired;
  let checked = 0;
  for (let x = 0; x < map.width; x++)
    for (let y = 0; y < map.height; y++) {
      if (++checked > 100000) throw new Error('MERGE_SPAWN_SCAN_BUDGET');
      const candidate = { x, y };
      if (!blockedWithPositions(candidate, occupied, map)) return candidate;
    }
  throw new Error('MERGE_NO_AVAILABLE_POSITION');
}
const applyImportFields = {
  ...importArgs,
  keys: v.optional(
    v.object({ publicKey: v.string(), privateKeyEncrypted: v.string(), fingerprint: v.string() }),
  ),
};
export async function applyBackupData(
  ctx: MutationCtx,
  args: ObjectType<typeof applyImportFields>,
) {
  requireAdmin(args.adminToken);
  args = { ...args, bundle: importBundle(args) };
  if (args.mode === 'restore' && args.bundle?.manifest?.scope === 'resident') return applyResidentRestore(ctx, args);
  const { bundle, local, rows } = await checkImport(ctx, args);
  const mapping: Record<string, string> = {};
  const snapshots = Object.fromEntries(
    [...snapshotTables, 'federationIdentity', 'engines', 'worlds', 'federationAgentRuntimes'].map(
      (name) => [name, (bundle.sections[name] ?? []).map(row => encodeRow(decodeRow(row)))],
    ),
  );
  let townId = local?.townId;
  if (args.mode !== 'merge') {
    for (const name of dataTables)
      for (const doc of await ctx.db.query(table(name)).collect()) await ctx.db.delete(doc._id);
    for (const name of [
      ...snapshotTables,
      'pairRequests',
      'migrationPeerExchanges',
      'visitReservations',
      'transportSessions',
      'federationReplayNonces',
      'federationDecisionJobs',
      'federationPresenceJobs',
      'federationTurns',
      'federationPendingActions',
      'federationPeers',
      'embeddingsCache',
      'inputs',
    ]) {
      for (const doc of await ctx.db.query(table(name)).collect()) await ctx.db.delete(doc._id);
    }
    const source = stripSystem(rows.federationIdentity[0]);
    if (args.mode === 'clone') {
      if (!args.keys) throw new Error('CLONE_IDENTITY_KEYS_REQUIRED');
      townId = `town:${crypto.randomUUID()}`;
      await ctx.db.insert('federationIdentity', {
        ...source,
        ...args.keys,
        townId,
        endpoint: normalizeEndpoint(args.targetEndpoint!),
        deploymentInstanceId: crypto.randomUUID(),
        deploymentEpoch: 1,
        enabled: false,
        allowIncomingPairRequests: false,
        mode: 'DISABLED',
        activeHandoffId: undefined,
        migrationFrozenAt: undefined,
        migrationOperator: undefined,
        createdAt: Date.now(),
      } as never);
    } else {
      await ctx.db.patch(local!._id, {
        deploymentInstanceId: crypto.randomUUID(),
        deploymentEpoch: Math.max(local!.deploymentEpoch, source.deploymentEpoch) + 1,
        townName: source.townName,
        maxVisitors: source.maxVisitors,
        maxVisitDurationMs: source.maxVisitDurationMs,
        resourceLimits: source.resourceLimits,
        allowUnencryptedHttp: false,
        allowPublicHttp: false,
        enabled: false,
        allowIncomingPairRequests: false,
        mode: 'NEEDS_RECONCILIATION',
        activeHandoffId: undefined,
        migrationFrozenAt: undefined,
        migrationOperator: undefined,
      });
    }
  }
  // Allocate every destination ID before repairing references; cycles such as reflection memory IDs remain valid.
  if (args.mode === 'merge') {
    const destination = await ctx.db.get(args.targetWorldId!);
    if (!destination) throw new Error('MERGE_TARGET_REQUIRED');
    const destinationMap = await ctx.db
      .query('maps')
      .withIndex('worldId', (q) => q.eq('worldId', destination._id))
      .unique();
    if (!destinationMap) throw new Error('MERGE_TARGET_MAP_REQUIRED');
    const map = new WorldMap(destinationMap);
    const occupied = destination.players.map((p) => p.position);
    for (const world of rows.worlds ?? []) {
      mapping[world._id] = destination._id;
      const players: BackupRow[] = [];
      const agents: BackupRow[] = [];
      let nextId = destination.nextId;
      for (const agent of world.agents) {
        const original =
          world.players.find((p: BackupRow) => p.id === agent.playerId) ?? agent.suspendedPlayer;
        if (!original || original.remoteVisitor || original.human)
          throw new Error('MERGE_RESIDENT_PRESENCE_MISSING');
        const newPlayerId = `p:${nextId++}`;
        const newAgentId = `a:${nextId++}`;
        // Local player IDs are scoped by source world. Resident packages have one source world.
        if (mapping[agent.playerId] || mapping[agent.id])
          throw new Error('MERGE_AMBIGUOUS_LOCAL_IDS');
        mapping[agent.playerId] = newPlayerId;
        mapping[agent.id] = newAgentId;
        const runtime = (rows.federationAgentRuntimes ?? []).find(
          (r) => r.worldId === world._id && r.agentId === agent.id,
        );
        const binding = (rows.residentModelBindings ?? []).find(
          (b) => b.worldId === world._id && b.playerId === agent.playerId,
        );
        if (runtime?.agentGlobalId || binding?.agentGlobalId)
          mapping[runtime?.agentGlobalId ?? binding!.agentGlobalId] =
            `${townId}/agent:${destination._id}:${newAgentId}`;
        const { travelVisitId, suspendedPlayer, inProgressOperation, toRemember, ...freshAgent } =
          agent;
        const { pathfinding, activity, ...freshPlayer } = original;
        const position = mergePosition(map, occupied, freshPlayer.position as Point);
        occupied.push(position);
        players.push({
          ...freshPlayer,
          id: newPlayerId,
          position,
          speed: 0,
          lastInput: Date.now(),
        });
        agents.push({ ...freshAgent, id: newAgentId, playerId: newPlayerId });
      }
      for (const row of [...(rows.archivedPlayers ?? []), ...(rows.playerDescriptions ?? [])]) {
        const old = row.id ?? row.playerId;
        if (old && !mapping[old]) mapping[old] = `p:${nextId++}`;
      }
      for (const row of rows.archivedConversations ?? [])
        if (!mapping[row.id]) mapping[row.id] = `c:${nextId++}`;
      for (const row of rows.archivedAgents ?? [])
        if (!mapping[row.id]) mapping[row.id] = `a:${nextId++}`;
      await ctx.db.patch(destination._id, {
        nextId,
        players: [...destination.players, ...players] as never,
        agents: [...destination.agents, ...agents] as never,
      });
    }
  }
  const skip = new Set([
    'modelMemoryVectors',
    'embeddingSpaces',
    'modelSettings',
    'federationAgentRuntimes',
    ...(args.mode === 'merge'
      ? ['engines', 'worlds', 'worldStatus', 'maps', 'deploymentRecords', 'modelAudits', 'storagePolicies', 'federationActionFacts', 'federationEventFacts', 'federationResourcePolicy', 'federationResourceAudit']
      : []),
  ]);
  for (const name of dataTables) {
    if (skip.has(name)) continue;
    for (const row of rows[name] ?? []) {
      let fields = stripSystem(row);
      if (name === 'engines')
        // Runtime inputs are audit snapshots, not the new active input queue.
        fields = { ...fields, running: false, generationNumber: fields.generationNumber + 1, processedInputNumber: undefined };
      if (name === 'worldStatus') fields = { ...fields, status: 'stoppedByDeveloper' };
      if (name === 'memories') {
        const { embeddingId, embeddingSpaceId, ...text } = fields;
        fields = text;
        if (fields.data.type === 'reflection')
          fields = { ...fields, data: { type: 'reflection', relatedMemoryIds: [] } };
      }
      if (name === 'worlds') {
        fields = {
          ...fields,
          players: fields.players.filter((p: BackupRow) => !p.remoteVisitor),
          conversations: [],
          historicalLocations: [],
        };
        fields.agents = fields.agents.map((a: BackupRow) => {
          const { inProgressOperation, toRemember, ...rest } = a;
          if (args.mode === 'clone') {
            if (a.suspendedPlayer && !fields.players.some((p: BackupRow) => p.id === a.playerId))
              fields.players.push(a.suspendedPlayer);
            delete rest.travelVisitId;
            delete rest.suspendedPlayer;
          }
          return rest;
        });
      }
      fields = restoredAutonomyFields(name, fields);
      const id = await ctx.db.insert(table(name), remapValue(fields, mapping) as never);
      mapping[row._id] = id;
    }
  }
  // Global identity uses persistent source IDs for same-town recovery, and new destination ownership for copies.
  for (const row of rows.residentModelBindings ?? []) {
    if (!mapping[row._id]) continue;
    const destinationWorld = mapping[row.worldId];
    const runtime = (rows.federationAgentRuntimes ?? []).find(
      (r) => r.worldId === row.worldId && r.playerId === row.playerId,
    );
    if (args.mode === 'clone' && row.agentGlobalId)
      mapping[row.agentGlobalId] =
        `${townId}/agent:${destinationWorld}:${runtime?.agentId ?? row.playerId}`;
  }
  for (const name of dataTables) {
    if (skip.has(name)) continue;
    for (const row of rows[name] ?? []) {
      if (!mapping[row._id]) continue;
      const current = await ctx.db.get(mapping[row._id] as Id<typeof name>);
      if (current)
        await ctx.db.replace(current._id, remapValue(stripSystem(current), mapping) as never);
    }
  }
  // Repair original document-ID references (which were unresolved during allocation).
  for (const row of rows.memories ?? [])
    if (row.data.type === 'reflection')
      await ctx.db.patch(mapping[row._id] as Id<'memories'>, {
        data: {
          type: 'reflection',
          relatedMemoryIds: row.data.relatedMemoryIds.map(
            (id: string) => mapping[id] as Id<'memories'>,
          ),
        },
      });
  for (const row of rows.federationAgentRuntimes ?? []) {
    const fields = remapValue(stripSystem(row), mapping);
    await ctx.db.insert('federationAgentRuntimes', {
      ...fields,
      homeTownId: townId,
      state:
        args.mode === 'merge' || args.mode === 'clone'
          ? 'HOME_ACTIVE'
          : row.visitId
            ? 'NEEDS_RECONCILIATION'
            : 'HOME_ACTIVE',
      agentAuthorityEpoch: row.agentAuthorityEpoch + 1,
      activeDecisionId: undefined,
      lastError: undefined,
      visitId: args.mode === 'merge' || args.mode === 'clone' ? undefined : row.visitId,
      updatedAt: Date.now(),
    } as never);
  }
  if (args.mode !== 'merge') {
    const sourceSettings = rows.modelSettings?.[0];
    const oldSpace = rows.embeddingSpaces?.find(
      (s) => s._id === sourceSettings?.activeEmbeddingSpaceId,
    );
    let activeEmbeddingSpaceId: Id<'embeddingSpaces'> | undefined;
    if (oldSpace) {
      const profileId = mapping[oldSpace.profileId] as Id<'embeddingProfiles'>;
      if (!profileId) throw new Error('BACKUP_EMBEDDING_PROFILE_REFERENCE_MISSING');
      activeEmbeddingSpaceId = await ctx.db.insert('embeddingSpaces', {
        profileId,
        fingerprint: oldSpace.fingerprint,
        status: 'ACTIVE',
        createdAt: Date.now(),
      });
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'action'>('models/embeddings:rebuildPage'),
        { spaceId: activeEmbeddingSpaceId, cursor: null },
      );
    }
    await ctx.db.insert('modelSettings', {
      key: 'town',
      mainChatProfileId: sourceSettings?.mainChatProfileId
        ? (mapping[sourceSettings.mainChatProfileId] as Id<'chatProfiles'>)
        : undefined,
      activeEmbeddingSpaceId,
    });
    for (const peer of rows.federationPeers ?? [])
      await ctx.db.insert('federationPeers', {
        ...stripSystem(peer),
        credentialId: '',
        credentialEncrypted: '',
        trustState: 'UNTRUSTED',
        inboundVisitsAllowed: false,
        outboundVisitsAllowed: false,
      } as never);
    const updated = await identity(ctx);
    await ctx.db.insert('deploymentRecords', {
      townId: townId!,
      deploymentInstanceId: updated!.deploymentInstanceId,
      deploymentEpoch: updated!.deploymentEpoch,
      mode: args.mode,
      createdAt: Date.now(),
    });
  }
  await ctx.db.insert('backupImports', {
    sourceTownId: bundle.manifest.sourceTownId,
    mode: args.mode,
    exportedAt: bundle.manifest.exportedAt,
    importedAt: Date.now(),
    sourceStoppedAt: args.mode === 'restore' || args.mode === 'migrate' ? Date.now() : undefined,
    mapping,
    runtimeSnapshot: snapshots,
    manifest: bundle.manifest,
  });
  await ensureEmbeddingSpace(ctx);
  // Same active space may already exist during a resident merge; explicitly reindex imported canonical text.
  for (const memory of rows.memories ?? [])
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'action'>('models/embeddings:indexMemory'),
      { memoryId: mapping[memory._id] },
    );
  return {
    mode: args.mode,
    worldIds: [...new Set((rows.worlds ?? []).map((w) => mapping[w._id]))],
    mapping,
    rebuildRequired: true as const,
  };
}
export const applyImport = internalMutation({ args: applyImportFields, handler: applyBackupData });

export const history = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    return (await ctx.db.query('backupImports').order('desc').take(30)).map(
      ({ _id, sourceTownId, mode, exportedAt, importedAt }) => ({
        _id,
        sourceTownId,
        mode,
        exportedAt,
        importedAt,
      }),
    );
  },
});

export const exportTown = action({
  args: { adminToken: v.string() },
  handler: async (ctx, args): Promise<BackupBundle> =>
    ctx.runQuery(makeFunctionReference<'query'>('federation/backup:getTown'), args),
});
export const exportResident = action({
  args: { adminToken: v.string(), worldId: v.id('worlds'), playerId },
  handler: async (ctx, args): Promise<BackupBundle> =>
    ctx.runQuery(makeFunctionReference<'query'>('federation/backup:getResident'), args),
});
export const preflight = action({
  args: importArgs,
  handler: async (
    ctx,
    args,
  ): Promise<{
    valid: true;
    mode: ImportMode;
    scope: string;
    counts: Record<string, number>;
    vectorPolicy: 'REBUILD';
    warnings: string[];
    residentRestorePlan?: Awaited<ReturnType<typeof residentRestorePlan>>['report'];
  }> => ctx.runQuery(makeFunctionReference<'query'>('federation/backup:checkPreflight'), args),
});

type RestoreEvidence = { importRecord: Doc<'backupImports'>; source: BackupRow; safeAfter: number };
async function largeRestoreEvidence(
  ctx: { db: DatabaseReader },
  runtime: Doc<'federationAgentRuntimes'>,
  record: Doc<'backupImports'>,
  local: Doc<'federationIdentity'>,
): Promise<RestoreEvidence | null> {
  const jobId = record.runtimeSnapshot.largeJobId as Id<'backupLargeJobs'>;
  const job = await ctx.db.get(jobId);
  if (
    !job ||
    job.kind !== 'import' ||
    job.state !== 'COMPLETE' ||
    job.metadata?.importId !== record._id
  )
    throw new Error('RESTORED_RUNTIME_SNAPSHOT_MISSING');
  const staged = await ctx.db
    .query('backupLargeRows')
    .withIndex('job_new', (q) => q.eq('jobId', jobId).eq('role', 'SOURCE').eq('newId', runtime._id))
    .unique();
  const oldRuntime = staged?.metadata;
  if (
    !oldRuntime ||
    oldRuntime.agentGlobalId !== runtime.agentGlobalId ||
    oldRuntime.playerId !== runtime.playerId ||
    oldRuntime.agentId !== runtime.agentId ||
    oldRuntime.visitId !== runtime.visitId
  )
    return null;
  const world = await ctx.db
    .query('backupLargeRows')
    .withIndex('job_role_source', (q) =>
      q.eq('jobId', jobId).eq('role', 'SOURCE').eq('sourceId', oldRuntime.worldId),
    )
    .unique();
  if (world?.newId !== runtime.worldId) throw new Error('RESTORED_RESIDENT_IDENTITY_MISMATCH');
  const source = job.source;
  if (!record.sourceStoppedAt) throw new Error('RESTORE_SOURCE_STOP_ATTESTATION_MISSING');
  if (
    source.townId !== local.townId ||
    source.publicKey !== local.publicKey ||
    source.fingerprint !== local.fingerprint ||
    source.deploymentInstanceId === local.deploymentInstanceId ||
    source.deploymentEpoch >= local.deploymentEpoch
  )
    throw new Error('RESTORED_DEPLOYMENT_IDENTITY_MISMATCH');
  const ledger = await ctx.db
    .query('backupLargeRows')
    .withIndex('job_relation', (q) =>
      q
        .eq('jobId', jobId)
        .eq('role', 'SOURCE')
        .eq('table', 'visitLedger')
        .eq('relationKey', `visit:${runtime.visitId}`),
    )
    .unique();
  const m = ledger?.metadata;
  if (
    !m ||
    m.role !== 'home' ||
    m.agentGlobalId !== runtime.agentGlobalId ||
    m.homeTownId !== local.townId ||
    m.homePlayerId !== runtime.playerId ||
    m.worldId !== oldRuntime.worldId ||
    !Number.isFinite(m.leaseExpiry)
  )
    throw new Error('RESTORED_HOME_LEDGER_MISSING');
  const evidence = await ctx.db
    .query('backupLargeVisitEvidence')
    .withIndex('job_visit', (q) => q.eq('jobId', jobId).eq('visitId', runtime.visitId!))
    .unique();
  const duration = Math.max(source.maxVisitDurationMs, local.maxVisitDurationMs);
  if (!Number.isFinite(duration) || duration < 60000 || duration > 30 * 60000)
    throw new Error('INVALID_RESTORED_LEASE_DURATION');
  return {
    importRecord: record,
    source,
    safeAfter:
      Math.max(record.sourceStoppedAt + duration, m.leaseExpiry, evidence?.leaseExpiry ?? 0) +
      LEASE_SAFETY_MS,
  };
}

async function restoreEvidence(
  ctx: { db: DatabaseReader },
  runtime: Doc<'federationAgentRuntimes'>,
): Promise<RestoreEvidence> {
  if (!runtime.visitId) throw new Error('RESTORED_VISIT_REQUIRED');
  const local = await ctx.db.query('federationIdentity').unique();
  if (!local || runtime.homeTownId !== local.townId)
    throw new Error('RESTORED_HOME_IDENTITY_MISMATCH');
  const imports = await ctx.db.query('backupImports').order('desc').take(100);
  for (const record of imports) {
    if (!['restore', 'migrate'].includes(record.mode) || record.sourceTownId !== local.townId)
      continue;
    if (record.runtimeSnapshot.largeJobId) {
      const evidence = await largeRestoreEvidence(ctx, runtime, record, local);
      if (evidence) return evidence;
      continue;
    }
    const snapshot = record.runtimeSnapshot as Record<string, unknown[]>;
    const oldRuntime = (snapshot.federationAgentRuntimes ?? [])
      .map(decodeRow)
      .find(
        (r) =>
          r.agentGlobalId === runtime.agentGlobalId &&
          record.mapping[r.worldId] === runtime.worldId &&
          r.playerId === runtime.playerId &&
          r.agentId === runtime.agentId &&
          r.visitId === runtime.visitId,
      );
    if (!oldRuntime) continue;
    if (!record.sourceStoppedAt) throw new Error('RESTORE_SOURCE_STOP_ATTESTATION_MISSING');
    const source = (snapshot.federationIdentity ?? []).map(decodeRow)[0];
    if (
      !source ||
      source.townId !== local.townId ||
      source.publicKey !== local.publicKey ||
      source.fingerprint !== local.fingerprint ||
      source.deploymentInstanceId === local.deploymentInstanceId ||
      source.deploymentEpoch >= local.deploymentEpoch
    )
      throw new Error('RESTORED_DEPLOYMENT_IDENTITY_MISMATCH');
    const oldLedgers = (snapshot.visitLedger ?? [])
      .map(decodeRow)
      .filter((l) => l.visitId === runtime.visitId);
    if (
      !oldLedgers.length ||
      oldLedgers.some(
        (l) =>
          l.role !== 'home' ||
          l.agentGlobalId !== runtime.agentGlobalId ||
          l.homeTownId !== local.townId ||
          l.homePlayerId !== runtime.playerId ||
          record.mapping[l.worldId] !== runtime.worldId ||
          !Number.isFinite(l.leaseExpiry),
      )
    )
      throw new Error('RESTORED_HOME_LEDGER_MISSING');
    // The source could have renewed after export. Its stop attestation bounds all later leases,
    // so wait a full maximum lease duration after import as well as every recorded proposal.
    const duration = Math.max(source.maxVisitDurationMs, local.maxVisitDurationMs);
    if (!Number.isFinite(duration) || duration < 60_000 || duration > 30 * 60_000)
      throw new Error('INVALID_RESTORED_LEASE_DURATION');
    let maxLease = Math.max(
      record.sourceStoppedAt + duration,
      ...oldLedgers.map((l) => l.leaseExpiry),
    );
    function inspect(value: any, belongs = false): void {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach((v) => inspect(v, belongs));
        return;
      }
      const matched = belongs || value.visitId === runtime.visitId;
      if (matched && value.leaseExpiry !== undefined) {
        if (!Number.isFinite(value.leaseExpiry)) throw new Error('INVALID_RESTORED_LEASE');
        maxLease = Math.max(maxLease, value.leaseExpiry);
      }
      for (const child of Object.values(value)) inspect(child, matched);
    }
    for (const name of snapshotTables)
      for (const row of snapshot[name] ?? []) inspect(decodeRow(row));
    return { importRecord: record, source, safeAfter: maxLease + LEASE_SAFETY_MS };
  }
  throw new Error('RESTORED_RUNTIME_SNAPSHOT_MISSING');
}

export const restoredResidents = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const runtimes = await ctx.db.query('federationAgentRuntimes').take(101);
    if (runtimes.length > 100) throw new Error('RESTORED_RESIDENT_LIST_BUDGET');
    return Promise.all(
      runtimes
        .filter((r) => r.state === 'NEEDS_RECONCILIATION')
        .map(async (runtime) => {
          const base = {
            agentGlobalId: runtime.agentGlobalId,
            worldId: runtime.worldId,
            playerId: runtime.playerId,
            agentId: runtime.agentId,
            visitId: runtime.visitId,
          };
          try {
            const { safeAfter } = await restoreEvidence(ctx, runtime);
            const status = await ctx.db
              .query('worldStatus')
              .withIndex('worldId', (q) => q.eq('worldId', runtime.worldId))
              .unique();
            const engineStopped =
              !!status && (await ctx.db.get(status.engineId))?.running === false;
            const reason =
              Date.now() < safeAfter
                ? 'OLD_HOST_LEASE_STILL_VALID'
                : !engineStopped
                  ? 'STOP_TARGET_ENGINE_FIRST'
                  : null;
            return { ...base, safeAfter, engineStopped, canResume: reason === null, reason };
          } catch (error) {
            return {
              ...base,
              safeAfter: null,
              engineStopped: false,
              canResume: false,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        }),
    );
  },
});

export const reconcileRestoredResident = mutation({
  args: { adminToken: v.string(), agentGlobalId: v.string(), sourceStopped: v.boolean() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    if (!args.sourceStopped) throw new Error('RESTORE_SOURCE_STOP_REQUIRED');
    const runtime = await ctx.db
      .query('federationAgentRuntimes')
      .withIndex('globalId', (q) => q.eq('agentGlobalId', args.agentGlobalId))
      .unique();
    if (!runtime) throw new Error('RESTORED_RESIDENT_NOT_FOUND');
    if (runtime.state === 'HOME_ACTIVE') {
      const audit = await ctx.db
        .query('backupReconciliations')
        .withIndex('agent', (q) => q.eq('agentGlobalId', args.agentGlobalId))
        .order('desc')
        .first();
      const world = await ctx.db.get(runtime.worldId);
      if (audit && world?.players.some((p) => p.id === runtime.playerId) && !runtime.visitId)
        return {
          state: 'HOME_ACTIVE' as const,
          worldId: runtime.worldId,
          playerId: runtime.playerId,
          agentGlobalId: runtime.agentGlobalId,
          safeAfter: audit.safeAfter,
        };
      throw new Error('RESIDENT_NOT_A_RESTORED_TRAVELER');
    }
    if (runtime.state !== 'NEEDS_RECONCILIATION')
      throw new Error('RESIDENT_NOT_A_RESTORED_TRAVELER');
    const evidence = await restoreEvidence(ctx, runtime);
    if (Date.now() < evidence.safeAfter)
      throw new Error(`OLD_HOST_LEASE_STILL_VALID: ${evidence.safeAfter}`);
    const status = await ctx.db
      .query('worldStatus')
      .withIndex('worldId', (q) => q.eq('worldId', runtime.worldId))
      .unique();
    const engine = status && (await ctx.db.get(status.engineId));
    if (!status || !engine || engine.running) throw new Error('STOP_TARGET_ENGINE_FIRST');
    const binding = await ctx.db
      .query('residentModelBindings')
      .withIndex('resident', (q) =>
        q.eq('worldId', runtime.worldId).eq('playerId', runtime.playerId),
      )
      .unique();
    const world = await ctx.db.get(runtime.worldId);
    const agent = world?.agents.find(
      (a) => a.id === runtime.agentId && a.playerId === runtime.playerId,
    );
    if (
      binding?.agentGlobalId !== runtime.agentGlobalId ||
      !world ||
      !agent ||
      agent.travelVisitId !== runtime.visitId ||
      !agent.suspendedPlayer ||
      agent.suspendedPlayer.id !== runtime.playerId ||
      agent.suspendedPlayer.remoteVisitor ||
      world.players.some((p) => p.id === runtime.playerId)
    )
      throw new Error('RESTORED_RESIDENT_IDENTITY_MISMATCH');
    const map = await ctx.db
      .query('maps')
      .withIndex('worldId', (q) => q.eq('worldId', runtime.worldId))
      .unique();
    if (!map) throw new Error('MERGE_TARGET_MAP_REQUIRED');
    const position = mergePosition(
      new WorldMap(map),
      world.players.map((p) => p.position),
      agent.suspendedPlayer.position,
    );
    const {
      travelVisitId: _,
      suspendedPlayer: snapshot,
      inProgressOperation: _operation,
      toRemember: _remember,
      ...rest
    } = agent;
    const player = {
      ...snapshot,
      position,
      pathfinding: undefined,
      activity: undefined,
      speed: 0,
      lastInput: Date.now(),
    };
    // Engine is stopped and its generation is fenced in this transaction. No old lease or action
    // is inserted into live protocol tables, and original local/global resident identities survive.
    await ctx.db.patch(world._id, {
      players: [...world.players, player],
      agents: world.agents.map((a) => (a.id === agent.id ? rest : a)),
    });
    await ctx.db.patch(engine._id, { generationNumber: engine.generationNumber + 1 });
    await ctx.db.patch(runtime._id, {
      state: 'HOME_ACTIVE',
      visitId: undefined,
      activeDecisionId: undefined,
      lastError: undefined,
      agentAuthorityEpoch: runtime.agentAuthorityEpoch + 1,
      updatedAt: Date.now(),
    });
    const local = await identity(ctx);
    await ctx.db.insert('backupReconciliations', {
      importId: evidence.importRecord._id,
      agentGlobalId: runtime.agentGlobalId,
      worldId: runtime.worldId,
      playerId: runtime.playerId,
      visitId: runtime.visitId!,
      safeAfter: evidence.safeAfter,
      reconciledAt: Date.now(),
      sourceDeploymentInstanceId: evidence.source.deploymentInstanceId,
      currentDeploymentInstanceId: local!.deploymentInstanceId,
    });
    return {
      state: 'HOME_ACTIVE' as const,
      worldId: runtime.worldId,
      playerId: runtime.playerId,
      agentGlobalId: runtime.agentGlobalId,
      safeAfter: evidence.safeAfter,
    };
  },
});
