import { convexToJson, jsonToConvex, Value } from 'convex/values';
import { digest, verifySignature } from './security';
import { validateResourceLimits } from './resources';

export const dataTables = [
  'engines',
  'worlds',
  'worldStatus',
  'maps',
  'playerDescriptions',
  'agentDescriptions',
  'archivedPlayers',
  'archivedAgents',
  'archivedConversations',
  'participatedTogether',
  'messages',
  'chatProfiles',
  'embeddingProfiles',
  'embeddingSpaces',
  'modelSettings',
  'residentModelBindings',
  'memories',
  'modelMemoryVectors',
  'modelAudits',
  'federationAgentRuntimes',
  'deploymentRecords',
  'migrationHandoffRecords',
  'federationIdentityKeyHistory',
  'storagePolicies',
  'federationActionFacts',
  'federationEventFacts',
  'homeTravelTranscripts',
  'homeTravelTranscriptPages',
  'autonomousTravelPolicies',
  'autonomousTravelDecisions',
  'federationResourcePolicy',
  'federationResourceAudit',
] as const;
export const snapshotTables = [
  'visitLedger',
  'federationInbox',
  'federationOutbox',
  'messageStreamCursors',
  'inputs',
  'federationDecisionJobs',
  'federationPresenceJobs',
  'federationTurns',
  'federationPendingActions',
  'transportSessions',
  'visitReservations',
  'federationTranscriptJobs',
] as const;
export type BackupRow = Record<string, any>;
export function restoredAutonomyFields(table: string, fields: BackupRow): BackupRow {
  if (table === 'federationIdentityKeyHistory')
    return { ...fields, verified: false };
  if (table === 'autonomousTravelPolicies')
    return { ...fields, nextDecisionAt: Date.now() + fields.decisionIntervalMs };
  if (table === 'autonomousTravelDecisions' && fields.state === 'RUNNING')
    return { ...fields, state: 'STALE', completedAt: Date.now(), error: 'BACKUP_RESTORE_INTERRUPTED_DECISION' };
  return fields;
}
export type BackupBundle = {
  manifest: {
    format: 'ai-town-backup';
    version: 1;
    schemaVersion: 1;
    scope: 'town' | 'resident';
    sourceTownId: string;
    exportedAt: number;
    sections: Record<string, { digest: string; count: number; bytes: number }>;
  };
  sections: Record<string, unknown[]>;
  signature?: string;
};
export type ImportMode = 'restore' | 'migrate' | 'clone' | 'merge';
const allowed = new Set<string>([
  ...dataTables,
  ...snapshotTables,
  'federationIdentity',
  'federationPeers',
]);
export function encodeRow(row: BackupRow) {
  // JSON tagged values use reserved $float/$bytes/$integer keys. Keep each
  // encoded row inside a string so it can cross Convex RPC without re-encoding.
  return JSON.stringify(convexToJson(row as Value));
}
export function decodeRow(row: unknown): BackupRow {
  // Version 1 files written before string transport contain JSON objects.
  const value = typeof row === 'string' ? JSON.parse(row) : row;
  const decoded = jsonToConvex(value as Parameters<typeof jsonToConvex>[0]);
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded) ||
    decoded instanceof ArrayBuffer
  )
    throw new Error('INVALID_BACKUP_ROW');
  return decoded as BackupRow;
}
export function stripSystem(row: BackupRow) {
  const { _id, _creationTime, ...fields } = row;
  return fields;
}
export function validateResourcePolicy(row: BackupRow) {
  const value = row.maxVisitorsPerSourceTown;
  if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 1000))
    throw new Error('INVALID_SOURCE_VISITOR_QUOTA');
  const rate = row.maxRemoteEventsPerSecond;
  if (rate !== undefined && rate !== null && (!Number.isSafeInteger(rate) || rate < 0 || rate > 1000))
    throw new Error('INVALID_REMOTE_EVENT_RATE');
}
export function assertNoSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoSecrets);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (
      /(privateKey|secretEncrypted|credentialEncrypted|ephemeralPrivate|apiKey$|adminToken|fencingToken)/i.test(
        key,
      )
    )
      throw new Error('BACKUP_CONTAINS_CREDENTIALS');
    assertNoSecrets(item);
  }
}
export async function createBundle(
  sourceTownId: string,
  scope: 'town' | 'resident',
  rows: Record<string, BackupRow[]>,
): Promise<BackupBundle> {
  const sections: BackupBundle['sections'] = {};
  const summaries: BackupBundle['manifest']['sections'] = {};
  for (const [name, values] of Object.entries(rows)) {
    sections[name] = values.map(encodeRow);
    summaries[name] = {
      digest: await digest(sections[name]),
      count: values.length,
      bytes: new TextEncoder().encode(JSON.stringify(sections[name])).length,
    };
  }
  return {
    manifest: {
      format: 'ai-town-backup',
      version: 1,
      schemaVersion: 1,
      scope,
      sourceTownId,
      exportedAt: Date.now(),
      sections: summaries,
    },
    sections,
  };
}
export async function validateBundle(value: unknown): Promise<BackupBundle> {
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).length > 5_000_000) throw new Error('BACKUP_SIZE_LIMIT');
    value = JSON.parse(value);
  }
  const bundle = value as BackupBundle;
  if (
    !bundle?.manifest ||
    bundle.manifest.format !== 'ai-town-backup' ||
    bundle.manifest.version !== 1 ||
    bundle.manifest.schemaVersion !== 1 ||
    !['town', 'resident'].includes(bundle.manifest.scope) ||
    !bundle.manifest.sourceTownId ||
    !Number.isFinite(bundle.manifest.exportedAt) ||
    !bundle.sections ||
    !bundle.manifest.sections ||
    typeof bundle.sections !== 'object'
  )
    throw new Error('UNSUPPORTED_BACKUP_MANIFEST');
  if (new TextEncoder().encode(JSON.stringify(bundle)).length > 5_000_000)
    throw new Error('BACKUP_SIZE_LIMIT');
  if (
    Object.keys(bundle.sections).sort().join() !==
    Object.keys(bundle.manifest.sections).sort().join()
  )
    throw new Error('BACKUP_SECTION_MISMATCH');
  let count = 0;
  const ids = new Set<string>();
  for (const [name, rows] of Object.entries(bundle.sections)) {
    if (!allowed.has(name) || !Array.isArray(rows)) throw new Error('INVALID_BACKUP_SECTION');
    assertNoSecrets(rows);
    const summary = bundle.manifest.sections[name];
    if (
      !summary ||
      rows.length !== summary.count ||
      new TextEncoder().encode(JSON.stringify(rows)).length !== summary.bytes ||
      (await digest(rows)) !== summary.digest
    )
      throw new Error('BACKUP_CHECKSUM_MISMATCH');
    count += rows.length;
    for (const row of rows) {
      const doc = decodeRow(row);
      assertNoSecrets(doc);
      if (name === 'federationResourcePolicy') validateResourcePolicy(doc);
      if (typeof doc._id !== 'string' || ids.has(doc._id))
        throw new Error('INVALID_BACKUP_DOCUMENT_ID');
      ids.add(doc._id);
    }
  }
  if (count > 500) throw new Error('BACKUP_ATOMIC_RECORD_LIMIT');
  if (bundle.manifest.scope === 'town' && dataTables.some((t) => !['federationIdentityKeyHistory', 'storagePolicies', 'federationActionFacts', 'federationEventFacts', 'homeTravelTranscripts', 'homeTravelTranscriptPages', 'migrationHandoffRecords', 'autonomousTravelPolicies', 'autonomousTravelDecisions', 'federationResourcePolicy', 'federationResourceAudit'].includes(t) && !bundle.sections[t]))
    throw new Error('INCOMPLETE_TOWN_BACKUP');
  if ((bundle.sections.federationResourcePolicy?.length ?? 0) > 1)
    throw new Error('BACKUP_SINGLETON_MISMATCH');
  if (bundle.manifest.scope === 'resident' &&
    ['federationResourcePolicy', 'federationResourceAudit'].some(t => bundle.sections[t]?.length))
    throw new Error('RESIDENT_BACKUP_CONTAINS_TOWN_RESOURCE_POLICY');
  const identities = bundle.sections.federationIdentity?.map(decodeRow) ?? [];
  if (identities.length !== 1 || identities[0].townId !== bundle.manifest.sourceTownId)
    throw new Error('BACKUP_IDENTITY_MISMATCH');
  if (identities[0].resourceLimits !== undefined) validateResourceLimits(identities[0].resourceLimits);
  if (
    bundle.signature &&
    !(await verifySignature(bundle.manifest, bundle.signature, identities[0].publicKey))
  )
    throw new Error('BACKUP_SIGNATURE_INVALID');
  return bundle;
}

/** Mirrors the table validators for preflight, before IDs are allocated in the import transaction. */
export function validateFields(value: any, validator: any): void {
  switch (validator.type) {
    case 'any':
      return;
    case 'string':
    case 'boolean':
    case 'number':
      if (
        typeof value !== validator.type ||
        (validator.type === 'number' && !Number.isFinite(value))
      )
        throw new Error('BACKUP_SCHEMA_MISMATCH');
      return;
    case 'null':
      if (value !== null) throw new Error('BACKUP_SCHEMA_MISMATCH');
      return;
    case 'bytes':
      if (!(value instanceof ArrayBuffer)) throw new Error('BACKUP_SCHEMA_MISMATCH');
      return;
    case 'id':
      if (typeof value !== 'string' || !value) throw new Error('BACKUP_SCHEMA_MISMATCH');
      return;
    case 'literal':
      if (value !== validator.value) throw new Error('BACKUP_SCHEMA_MISMATCH');
      return;
    case 'array':
      if (!Array.isArray(value)) throw new Error('BACKUP_SCHEMA_MISMATCH');
      value.forEach((v) => validateFields(v, validator.value));
      return;
    case 'union':
      for (const member of validator.value) {
        try {
          validateFields(value, member);
          return;
        } catch {
          /* Try the next declared variant. */
        }
      }
      throw new Error('BACKUP_SCHEMA_MISMATCH');
    case 'object':
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value instanceof ArrayBuffer
      )
        throw new Error('BACKUP_SCHEMA_MISMATCH');
      for (const [name, field] of Object.entries<any>(validator.value)) {
        if (value[name] === undefined) {
          if (!field.optional) throw new Error('BACKUP_SCHEMA_MISMATCH');
        } else validateFields(value[name], field.fieldType);
      }
      if (Object.keys(value).some((k) => !validator.value[k]))
        throw new Error('BACKUP_SCHEMA_MISMATCH');
      return;
    default:
      throw new Error('UNSUPPORTED_BACKUP_SCHEMA_FIELD');
  }
}

/** Exact ID mapping avoids rewriting arbitrary prose and retains foreign relationship identities. */
export function remapValue(value: any, mapping: Record<string, string>, key = ''): any {
  if (typeof value === 'string')
    return key === 'description' || key === 'text' || key === 'messageText' || key === 'identity' || key === 'plan'
      ? value
      : (mapping[value] ?? value);
  if (value instanceof ArrayBuffer || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => remapValue(v, mapping, key));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapValue(v, mapping, k)]));
}
