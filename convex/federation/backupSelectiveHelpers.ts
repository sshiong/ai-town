import { v } from 'convex/values';
import { BackupRow, assertNoSecrets, decodeRow, validateFields } from './backupHelpers';
import {
  ChunkDescriptor,
  LargeChunk,
  MAX_ARCHIVE_BYTES,
  MAX_CHUNKS,
  MAX_CHUNK_BYTES,
  size,
  validateChunk,
  validateSourceRow,
} from './backupLargeHelpers';
import { digest, verifySignature } from './security';

export const selectiveScope = v.union(
  v.literal('agent-one'),
  v.literal('agents-selected'),
  v.literal('config-only'),
  v.literal('memories-only'),
  v.literal('history'),
);
export type SelectiveScope =
  | 'agent-one'
  | 'agents-selected'
  | 'config-only'
  | 'memories-only'
  | 'history';
export const categories = [
  'configuration',
  'conversation',
  'relationship',
  'reflection',
  'travel',
  'social',
] as const;
export type Owner = {
  agentGlobalId: string;
  worldId: string;
  playerId: string;
  agentId: string;
  chatProfileId: string;
};
export type Selection = {
  scope: SelectiveScope;
  owners: Owner[];
  categories: string[];
  from: number | null;
  to: number | null;
  includePublicPeers: boolean;
  dependencyPolicy: 'same-owner-evidence-and-public-context';
  timePolicy: 'event-time-else-creation-time-half-open';
};
export const configTables = [
  'worlds',
  'maps',
  'chatProfiles',
  'embeddingProfiles',
  'embeddingSpaces',
  'modelSettings',
  'storagePolicies',
  'federationResourcePolicy',
  'federationIdentity',
  'federationPeers',
] as const;
export const residentTables = [
  'residentModelBindings',
  'playerDescriptions',
  'agentDescriptions',
  'archivedPlayers',
  'archivedAgents',
  'federationAgentRuntimes',
  'autonomousTravelPolicies',
] as const;
export const historyTables = [
  'archivedConversations',
  'messages',
  'participatedTogether',
  'homeTravelTranscripts',
  'homeTravelTranscriptPages',
  'autonomousTravelDecisions',
  'visitLedger',
  'federationActionFacts',
  'federationEventFacts',
] as const;
export const selectiveTables = [
  ...configTables,
  ...residentTables,
  'memories',
  ...historyTables,
] as const;
export type PublicParticipant = {
  worldId: string;
  playerId: string;
  agentGlobalId: string | null;
  homeTownId: string | null;
  name: string;
};
export type ArchiveEnvelope =
  | {
      kind: 'record';
      role: 'primary' | 'dependency';
      record: string;
      references: { id: string; table: string }[];
      publicParticipants?: PublicParticipant[];
      conversationContext?: {
        id: string;
        worldId: string;
        source: 'live' | 'archived';
        created: number;
        participants: string[];
        numMessages: number;
      };
    }
  | {
      kind: 'external-reference';
      sourceId: string;
      table: string;
      reason: 'PRIVATE_OWNER_EXCLUDED' | 'SOURCE_MISSING' | 'UNSUPPORTED_DEPENDENCY';
    };
const archiveEnvelope = v.union(
  v.object({
    kind: v.literal('record'),
    role: v.union(v.literal('primary'), v.literal('dependency')),
    record: v.string(),
    references: v.array(v.object({ id: v.string(), table: v.string() })),
    publicParticipants: v.optional(
      v.array(
        v.object({
          worldId: v.string(),
          playerId: v.string(),
          agentGlobalId: v.union(v.string(), v.null()),
          homeTownId: v.union(v.string(), v.null()),
          name: v.string(),
        }),
      ),
    ),
    conversationContext: v.optional(
      v.object({
        id: v.string(),
        worldId: v.string(),
        source: v.union(v.literal('live'), v.literal('archived')),
        created: v.number(),
        participants: v.array(v.string()),
        numMessages: v.number(),
      }),
    ),
  }),
  v.object({
    kind: v.literal('external-reference'),
    sourceId: v.string(),
    table: v.string(),
    reason: v.union(
      v.literal('PRIVATE_OWNER_EXCLUDED'),
      v.literal('SOURCE_MISSING'),
      v.literal('UNSUPPORTED_DEPENDENCY'),
    ),
  }),
);
export type SelectiveManifest = {
  format: 'ai-town-selective-archive';
  version: 1;
  schemaVersion: 1;
  exportId: string;
  source: BackupRow;
  exportedAt: number;
  scope: SelectiveScope;
  selection: Selection;
  includeVectors: false;
  usage: 'read-only-archive';
  operator: string;
  reason: string;
  chunks: ChunkDescriptor[];
};
export function allowedCategories(scope: SelectiveScope): readonly string[] {
  if (scope === 'config-only') return ['configuration'];
  if (scope === 'memories-only') return ['conversation', 'relationship', 'reflection', 'travel'];
  if (scope === 'history') return ['conversation', 'social', 'travel'];
  return categories.filter((c) => c !== 'configuration');
}
export function validateSelection(s: Selection) {
  if (
    !['agent-one', 'agents-selected', 'config-only', 'memories-only', 'history'].includes(
      s?.scope,
    ) ||
    !Array.isArray(s.owners) ||
    s.owners.length > 100 ||
    !Array.isArray(s.categories) ||
    !s.categories.length ||
    new Set(s.categories).size !== s.categories.length ||
    s.categories.some((c) => !allowedCategories(s.scope).includes(c)) ||
    typeof s.includePublicPeers !== 'boolean' ||
    s.dependencyPolicy !== 'same-owner-evidence-and-public-context' ||
    s.timePolicy !== 'event-time-else-creation-time-half-open'
  )
    throw new Error('INVALID_SELECTIVE_SCOPE');
  if (
    [s.from, s.to].some((v) => v !== null && (!Number.isSafeInteger(v) || v < 0)) ||
    (s.from !== null && s.to !== null && s.from >= s.to)
  )
    throw new Error('INVALID_SELECTIVE_TIME_RANGE');
  if (
    (s.scope === 'config-only' && (s.owners.length || s.from !== null || s.to !== null)) ||
    (s.scope !== 'config-only' && !s.owners.length) ||
    (s.scope === 'agent-one' && s.owners.length !== 1)
  )
    throw new Error('INVALID_SELECTIVE_OWNERS');
  const globalIds = new Set<string>();
  const residents = new Set<string>();
  for (const o of s.owners) {
    if (
      ['agentGlobalId', 'worldId', 'playerId', 'agentId', 'chatProfileId'].some(
        (key) => typeof o[key as keyof Owner] !== 'string' || !o[key as keyof Owner],
      ) ||
      globalIds.has(o.agentGlobalId) ||
      residents.has(`${o.worldId}:${o.playerId}`)
    )
      throw new Error('INVALID_SELECTIVE_OWNERS');
    globalIds.add(o.agentGlobalId);
    residents.add(`${o.worldId}:${o.playerId}`);
  }
}
export function rowOwner(row: BackupRow, s: Selection): Owner | undefined {
  return s.owners.find((o) =>
    row.agentGlobalId
      ? row.agentGlobalId === o.agentGlobalId &&
        (!row.worldId || row.worldId === o.worldId) &&
        (!row.playerId || row.playerId === o.playerId)
      : row.worldId === o.worldId && row.playerId === o.playerId,
  );
}
export function eventTime(table: string, row: BackupRow) {
  return table === 'memories' && row.data?.type === 'travel'
    ? row.data.occurredAt
    : (row.occurredAt ??
        row.receivedAt ??
        row.endedAt ??
        row.ended ??
        row.createdAt ??
        row._creationTime);
}
export function inBounds(table: string, row: BackupRow, s: Selection) {
  const at = eventTime(table, row);
  return Number.isFinite(at) && (s.from === null || at >= s.from) && (s.to === null || at < s.to);
}
export function scopedWorld(row: BackupRow, s: Selection): BackupRow {
  const owners = s.owners.filter((o) => o.worldId === row._id);
  return {
    ...row,
    players: row.players.filter((p: BackupRow) => owners.some((o) => o.playerId === p.id)),
    agents: row.agents.filter((a: BackupRow) => owners.some((o) => o.agentId === a.id)),
    conversations: [],
    historicalLocations: [],
  };
}
export async function validateSelectiveManifest(m: SelectiveManifest, signature: string) {
  if (
    m?.format !== 'ai-town-selective-archive' ||
    m.version !== 1 ||
    m.schemaVersion !== 1 ||
    m.usage !== 'read-only-archive' ||
    m.includeVectors !== false ||
    m.scope !== m.selection?.scope ||
    typeof m.exportId !== 'string' ||
    !m.exportId ||
    !Number.isFinite(m.exportedAt) ||
    !m.source?.townId ||
    !m.source?.publicKey ||
    typeof m.operator !== 'string' ||
    !m.operator.trim() ||
    typeof m.reason !== 'string' ||
    !m.reason.trim() ||
    !Array.isArray(m.chunks)
  )
    throw new Error('UNSUPPORTED_SELECTIVE_ARCHIVE');
  validateSelection(m.selection);
  assertNoSecrets(m);
  if (m.source.fingerprint !== `sha256:${await digest(m.source.publicKey)}`)
    throw new Error('BACKUP_IDENTITY_MISMATCH');
  validateSourceRow('federationIdentity', m.source);
  let bytes = 0;
  if (m.chunks.length > MAX_CHUNKS || size(m) > 5_000_000)
    throw new Error('SELECTIVE_ARCHIVE_BUDGET');
  for (const [index, c] of m.chunks.entries()) {
    if (
      c.index !== index ||
      ![...selectiveTables, 'referenceMappings'].includes(c.table as any) ||
      !Number.isSafeInteger(c.count) ||
      c.count < 0 ||
      c.count > 20 ||
      !Number.isSafeInteger(c.bytes) ||
      c.bytes < 1 ||
      c.bytes > MAX_CHUNK_BYTES ||
      typeof c.digest !== 'string'
    )
      throw new Error('INVALID_SELECTIVE_DESCRIPTOR');
    bytes += c.bytes;
  }
  if (bytes > MAX_ARCHIVE_BYTES) throw new Error('SELECTIVE_ARCHIVE_BUDGET');
  if (
    m.chunks
      .filter((c) => c.table === 'federationIdentity')
      .reduce((sum, c) => sum + c.count, 0) !== 1
  )
    throw new Error('BACKUP_SINGLETON_MISMATCH');
  if (!(await verifySignature(m, signature, m.source.publicKey)))
    throw new Error('BACKUP_SIGNATURE_INVALID');
}
export async function validateSelectiveChunk(chunk: LargeChunk, expected: ChunkDescriptor) {
  const envelopes = await validateChunk(chunk, expected);
  return envelopes.map((value) => {
    try {
      validateFields(value, (archiveEnvelope as unknown as { json: unknown }).json);
    } catch {
      throw new Error('INVALID_SELECTIVE_RECORD');
    }
    const e = value as ArchiveEnvelope;
    if (e.kind === 'record') {
      if (
        chunk.table === 'referenceMappings' ||
        !['primary', 'dependency'].includes(e.role) ||
        typeof e.record !== 'string' ||
        !Array.isArray(e.references)
      )
        throw new Error('INVALID_SELECTIVE_RECORD');
      const row = decodeRow(e.record);
      assertNoSecrets(row);
      try {
        validateSourceRow(chunk.table, row);
      } catch {
        throw new Error('INVALID_SELECTIVE_RECORD');
      }
      if (
        typeof row._id !== 'string' ||
        !Number.isFinite(row._creationTime) ||
        e.references.some(
          (r) =>
            !r ||
            typeof r.id !== 'string' ||
            !r.id ||
            !(selectiveTables as readonly string[]).includes(r.table),
        )
      )
        throw new Error('INVALID_SELECTIVE_RECORD');
      if (
        e.publicParticipants !== undefined &&
        (!Array.isArray(e.publicParticipants) ||
          e.publicParticipants.some(
            (p) =>
              !p ||
              ['worldId', 'playerId', 'name'].some(
                (key) => typeof p[key as keyof PublicParticipant] !== 'string',
              ) ||
              (p.agentGlobalId !== null && typeof p.agentGlobalId !== 'string') ||
              (p.homeTownId !== null && typeof p.homeTownId !== 'string'),
          ))
      )
        throw new Error('INVALID_SELECTIVE_RECORD');
      const context = e.conversationContext;
      if (
        context !== undefined &&
        (!context ||
          typeof context.id !== 'string' ||
          typeof context.worldId !== 'string' ||
          !['live', 'archived'].includes(context.source) ||
          !Number.isFinite(context.created) ||
          !Number.isSafeInteger(context.numMessages) ||
          context.numMessages < 0 ||
          !Array.isArray(context.participants) ||
          context.participants.some((p) => typeof p !== 'string'))
      )
        throw new Error('INVALID_SELECTIVE_RECORD');
    } else if (
      chunk.table !== 'referenceMappings' ||
      e.kind !== 'external-reference' ||
      typeof e.sourceId !== 'string' ||
      !e.sourceId ||
      typeof e.table !== 'string' ||
      !e.table ||
      !['PRIVATE_OWNER_EXCLUDED', 'SOURCE_MISSING', 'UNSUPPORTED_DEPENDENCY'].includes(e.reason)
    )
      throw new Error('INVALID_SELECTIVE_RECORD');
    return e;
  });
}
