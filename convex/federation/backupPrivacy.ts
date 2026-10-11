import type { DatabaseReader, MutationCtx } from '../_generated/server';
import type { BackupRow } from './backupHelpers';
import { privacyTombstone, privatePayloadSummary } from './travelPrivacyGuard';

export const privacyBackupTables = ['travelPrivacyTombstones'] as const;
const privateContentTables = new Set(['memories', 'modelMemoryVectors', 'memorySourceCorrections',
  'memorySourceClaims', 'memoryCompressionJobs', 'memorySummaryProvenance', 'messages', 'archivedConversations',
  'coldHistoryFiles', 'homeTravelTranscripts', 'homeTravelTranscriptPages', 'federationActionFacts',
  'federationEventFacts', 'autonomousTravelDecisions']);

export function validatePrivacyBackupRow(row: BackupRow) {
  const allowed = ['_id', '_creationTime', 'key', 'visitId', 'createdAt', 'worldId', 'ownerGlobalId', 'playerId', 'playerIds'];
  if (Object.keys(row).some(key => !allowed.includes(key)) ||
    typeof row.key !== 'string' || typeof row.visitId !== 'string' || !row.visitId ||
    !Number.isFinite(row.createdAt) || row.createdAt < 0 ||
    ['worldId', 'ownerGlobalId', 'playerId'].some(key => row[key] !== undefined && (typeof row[key] !== 'string' || !row[key])) ||
    (row.playerIds !== undefined && (!Array.isArray(row.playerIds) || row.playerIds.some((id: unknown) => typeof id !== 'string' || !id))))
    throw new Error('BACKUP_PRIVACY_RECORD_INVALID');
  if (row.key === `visit:${row.visitId}`) return;
  if (row.key.startsWith('memory:') && row.key.length > 'memory:'.length) return;
  if (row.key.startsWith('conversation:')) {
    const parts = row.key.slice('conversation:'.length);
    const separator = parts.indexOf(':');
    if (separator > 0 && separator < parts.length - 1) return;
  }
  throw new Error('BACKUP_PRIVACY_RECORD_INVALID');
}

export function privacyRowBelongsToResident(row: BackupRow, owner: { worldId: string; playerId: string; agentGlobalId: string }) {
  if (row.worldId !== owner.worldId) return false;
  if (row.ownerGlobalId !== undefined) return row.ownerGlobalId === owner.agentGlobalId;
  if (row.playerId !== undefined) return row.playerId === owner.playerId;
  return !!row.playerIds?.includes(owner.playerId);
}

export async function residentPrivacyRows(db: DatabaseReader, owner: { worldId: string; playerId: string; agentGlobalId: string }) {
  const worldId = db.normalizeId('worlds', owner.worldId);
  if (!worldId) throw new Error('BACKUP_PRIVACY_OWNER_INVALID');
  const rows: BackupRow[] = [];
  let cursor: string | null = null;
  do {
    // Convex allows only one cursor pagination call in a query. The unique key
    // provides a stable indexed boundary for bounded reads within this export.
    const page = await db.query('travelPrivacyTombstones').withIndex('world_key', q =>
      cursor === null ? q.eq('worldId', worldId) : q.eq('worldId', worldId).gt('key', cursor))
      .take(100);
    rows.push(...page.filter(row => privacyRowBelongsToResident(row, owner)));
    if (rows.length > 500) throw new Error('BACKUP_ATOMIC_RECORD_LIMIT');
    if (page.length < 100) return rows;
    cursor = page[page.length - 1].key;
  } while (cursor !== null);
  return rows;
}

/** Negative state is unioned, never replaced or deleted by restore. */
export async function restorePrivacyRows(ctx: MutationCtx, rows: BackupRow[], mapping: Record<string, string>, remapLocal = false) {
  for (const row of rows) {
    validatePrivacyBackupRow(row);
    let mappedKey = row.key;
    if (row.key.startsWith('memory:')) {
      const id = row.key.slice('memory:'.length);
      mappedKey = `memory:${mapping[id] ?? id}`;
    } else if (row.key.startsWith('conversation:')) {
      const parts = row.key.slice('conversation:'.length), separator = parts.indexOf(':');
      const world = parts.slice(0, separator), conversation = parts.slice(separator + 1);
      mappedKey = `conversation:${mapping[world] ?? world}:${mapping[conversation] ?? conversation}`;
    }
    const fields = {
      visitId: row.visitId, createdAt: row.createdAt,
      ...(row.worldId ? { worldId: mapping[row.worldId] ?? row.worldId } : {}),
      ...(row.ownerGlobalId ? { ownerGlobalId: mapping[row.ownerGlobalId] ?? row.ownerGlobalId } : {}),
      ...(row.playerId ? { playerId: mapping[row.playerId] ?? row.playerId } : {}),
      ...(row.playerIds ? { playerIds: row.playerIds.map((id: string) => mapping[id] ?? id) } : {}),
    };
    // Keep the original key as well: a later old archive still names that ID.
    for (const key of new Set([row.key, mappedKey])) {
      const existing = await privacyTombstone(ctx.db, key);
      if (!existing) await ctx.db.insert('travelPrivacyTombstones', { ...fields, key } as never);
      else if (remapLocal) await ctx.db.patch(existing._id, fields as never);
    }
  }
}

/** Preserve local negative state when full-town restore replaces world IDs. */
export async function remapLocalPrivacy(ctx: MutationCtx, sourceTownId: string, mapping: Record<string, string>) {
  if (!(await ctx.db.query('travelPrivacyTombstones').first())) return;
  const imports = await ctx.db.query('backupImports').withIndex('sourceTown', q => q.eq('sourceTownId', sourceTownId)).take(501);
  if (imports.length > 500) throw new Error('BACKUP_PRIVACY_HISTORY_LIMIT');
  const worldMapping: Record<string, string> = {};
  for (const [source, target] of Object.entries(mapping)) {
    if (!ctx.db.normalizeId('worlds', source) || !ctx.db.normalizeId('worlds', target)) continue;
    worldMapping[source] = target;
    for (const record of imports) {
      const prior = record.mapping?.[source];
      if (typeof prior === 'string' && ctx.db.normalizeId('worlds', prior)) {
        if (worldMapping[prior] && worldMapping[prior] !== target) throw new Error('BACKUP_PRIVACY_MAPPING_CONFLICT');
        worldMapping[prior] = target;
      }
    }
  }
  for (const [source, target] of Object.entries(worldMapping)) {
    if (source === target) continue;
    const worldId = ctx.db.normalizeId('worlds', source)!;
    let cursor: string | null = null;
    while (true) {
      const page = await ctx.db.query('travelPrivacyTombstones').withIndex('world_key', q =>
        cursor === null ? q.eq('worldId', worldId) : q.eq('worldId', worldId).gt('key', cursor)).take(100);
      if (!page.length) break;
      await restorePrivacyRows(ctx, page, { ...mapping, ...worldMapping }, true);
      if (page.length < 100) break;
      cursor = page[page.length - 1].key;
    }
  }
}

function redactedPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as BackupRow;
  const summary = privatePayloadSummary(row);
  return row.privacyRedacted === true && Object.keys(row).length === Object.keys(summary).length &&
    Object.entries(row).every(([key, item]) => summary[key] === item);
}
export function redactedFact(table: string, row: BackupRow): boolean {
  if (table === 'federationEventFacts') return redactedPayload(row.payload);
  if (table !== 'federationActionFacts') return false;
  return row.action?.privacyRedacted === true &&
    Object.keys(row.action).every(key => ['type', 'privacyRedacted'].includes(key)) &&
    (row.action.type === undefined || typeof row.action.type === 'string') &&
    redactedPayload(row.receiptPayload) &&
    (JSON.stringify(row.result) === JSON.stringify({ kind: 'ok', value: null }) ||
      JSON.stringify(row.result) === JSON.stringify({ kind: 'error', message: 'PRIVACY_REDACTED' }));
}

/** Check source identities before import allocates replacement IDs. */
export async function assertBackupPrivacy(
  db: DatabaseReader,
  rows: Record<string, BackupRow[]>,
  sourceTownId: string,
  stagedTombstone?: (key: string) => Promise<boolean>,
) {
  const incoming = new Set((rows.travelPrivacyTombstones ?? []).map(row => {
    validatePrivacyBackupRow(row);
    return row.key as string;
  }));
  if (!Object.entries(rows).some(([table, values]) => privateContentTables.has(table) && values.length)) return;
  if (!stagedTombstone && !incoming.size && !(await db.query('travelPrivacyTombstones').first())) return;
  // Small archives already have bounded atomic imports. Do not silently ignore
  // an older mapping merely because its destination document was deleted.
  const imports = await db.query('backupImports')
    .withIndex('sourceTown', q => q.eq('sourceTownId', sourceTownId)).take(501);
  if (imports.length > 500) throw new Error('BACKUP_PRIVACY_HISTORY_LIMIT');
  const mappings = imports.map(record => record.mapping as Record<string, string>);
  const keys = new Set<string>();
  const memoryIds = new Set<string>();
  const conversations = new Map<string, { worldId: string; conversationId: string }>();
  const memory = (id: unknown) => {
    if (typeof id !== 'string') return;
    memoryIds.add(id);
    keys.add(`memory:${id}`);
    for (const mapping of mappings)
      if (typeof mapping?.[id] === 'string') keys.add(`memory:${mapping[id]}`);
  };
  const conversation = (worldId: unknown, conversationId: unknown) => {
    if (typeof worldId !== 'string' || typeof conversationId !== 'string') return;
    conversations.set(`${worldId}:${conversationId}`, { worldId, conversationId });
    keys.add(`conversation:${worldId}:${conversationId}`);
    for (const mapping of mappings)
      keys.add(`conversation:${mapping?.[worldId] ?? worldId}:${mapping?.[conversationId] ?? conversationId}`);
  };
  for (const [table, values] of Object.entries(rows)) for (const row of values) {
    if (table === 'memories') {
      memory(row._id);
      if (row.data?.type === 'travel') keys.add(`visit:${row.data.visitId}`);
      if (row.data?.type === 'conversation') conversation(row.worldId, row.data.conversationId);
      for (const id of row.data?.relatedMemoryIds ?? []) memory(id);
    }
    // Ledger/control snapshots remain restorable. Only tables carrying source
    // content or derived content participate in the privacy rejection.
    if (['homeTravelTranscripts', 'homeTravelTranscriptPages', 'federationActionFacts',
      'federationEventFacts', 'autonomousTravelDecisions'].includes(table) && row.visitId && !redactedFact(table, row))
      keys.add(`visit:${row.visitId}`);
    if (['messages', 'archivedConversations'].includes(table))
      conversation(row.worldId, table === 'messages' ? row.conversationId : row.id);
    if (table === 'coldHistoryFiles') memory(row.owner?.memoryId);
    if (['modelMemoryVectors', 'memorySourceCorrections', 'memorySourceClaims',
      'memoryCompressionJobs', 'memorySummaryProvenance'].includes(table)) {
      for (const id of [row.memoryId, row.sourceMemoryId, row.summaryMemoryId,
        ...(row.evidenceMemoryIds ?? []), ...(row.sources ?? []).map((source: BackupRow) => source.memoryId)])
        memory(id);
    }
  }
  // Large restores keep document mappings in indexed staging rows rather than
  // an unbounded mapping object in backupImports. Follow those durable aliases.
  for (const record of imports) {
    const sourceJobId = record.manifest?.largeJobId ?? record.manifest?.selectiveJobId;
    const jobId = typeof sourceJobId === 'string' ? db.normalizeId('backupLargeJobs', sourceJobId) : null;
    if (!jobId) continue;
    const mapped = async (id: string) => (await db.query('backupLargeRows')
      .withIndex('job_role_source', q => q.eq('jobId', jobId).eq('role', 'SOURCE').eq('sourceId', id)).unique())?.newId;
    for (const id of memoryIds) {
      const target = await mapped(id);
      if (target) keys.add(`memory:${target}`);
    }
    for (const { worldId, conversationId } of conversations.values()) {
      if (record.manifest?.selectiveJobId) {
        const local = async (kind: string, ...parts: string[]) => (await db.query('backupLargeGlobalMappings')
          .withIndex('job_source', q => q.eq('jobId', jobId).eq('sourceId', JSON.stringify([kind, ...parts]))).unique())?.targetId;
        const target = await local('world', worldId), conversation = await local('conversation', worldId, conversationId);
        if (target && conversation) keys.add(`conversation:${target}:${conversation}`);
      } else {
        const target = await mapped(worldId);
        if (target) keys.add(`conversation:${target}:${conversationId}`);
      }
    }
  }
  for (const key of keys)
    if (incoming.has(key) || await privacyTombstone(db, key) || await stagedTombstone?.(key))
      throw new Error('BACKUP_PRIVACY_REDACTED');
}
