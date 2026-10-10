import { Infer, v } from 'convex/values';
import { BackupRow, stripSystem } from './backupHelpers';
import { Selection } from './backupSelectiveHelpers';

export const ownerMapping = v.object({
  sourceAgentGlobalId: v.string(),
  operation: v.union(
    v.literal('clone'),
    v.literal('merge'),
    v.literal('restore'),
    v.literal('skip'),
  ),
  targetWorldId: v.optional(v.id('worlds')),
  targetAgentGlobalId: v.optional(v.string()),
});
export const profileMapping = v.object({
  sourceId: v.string(),
  operation: v.union(v.literal('map'), v.literal('draft'), v.literal('skip')),
  targetId: v.optional(v.id('chatProfiles')),
});
export const externalMapping = v.object({
  sourceId: v.string(),
  sourceAgentGlobalId: v.string(),
  operation: v.union(v.literal('map'), v.literal('skip-edge')),
  targetId: v.optional(v.id('memories')),
});
export const importOptions = {
  mode: v.union(v.literal('merge'), v.literal('restore')),
  owners: v.array(ownerMapping),
  profiles: v.array(profileMapping),
  externalReferences: v.array(externalMapping),
  configuration: v.array(
    v.union(
      v.literal('storagePolicies'),
      v.literal('federationResourcePolicy'),
      v.literal('visitorPolicy'),
      v.literal('mainChatProfile'),
      v.literal('embeddingProfiles'),
    ),
  ),
  worlds: v.array(
    v.object({ sourceId: v.string(), targetId: v.id('worlds'), importMap: v.boolean() }),
  ),
  sourceStopped: v.boolean(),
  operator: v.string(),
  reason: v.string(),
};
export type OwnerMapping = Infer<typeof ownerMapping>;
export type ProfileMapping = Infer<typeof profileMapping>;
export type ExternalMapping = Infer<typeof externalMapping>;
export type Options = {
  mode: 'merge' | 'restore';
  owners: OwnerMapping[];
  profiles: ProfileMapping[];
  externalReferences: ExternalMapping[];
  configuration: (
    | 'storagePolicies'
    | 'federationResourcePolicy'
    | 'visitorPolicy'
    | 'mainChatProfile'
    | 'embeddingProfiles'
  )[];
  worlds: {
    sourceId: string;
    targetId: Infer<typeof ownerMapping>['targetWorldId'] & string;
    importMap: boolean;
  }[];
  sourceStopped: boolean;
  operator: string;
  reason: string;
};
export type TargetOwner = {
  sourceAgentGlobalId: string;
  operation: OwnerMapping['operation'];
  worldId: string;
  playerId: string;
  agentId: string;
  agentGlobalId: string;
  chatProfileId?: string;
};
export const key = (kind: string, ...parts: string[]) => JSON.stringify([kind, ...parts]);
export function validateOptions(options: Options, selection: Selection) {
  if (
    !options.operator.trim() ||
    options.operator.length > 200 ||
    !options.reason.trim() ||
    options.reason.length > 1000
  )
    throw new Error('SELECTIVE_IMPORT_OPERATOR_REQUIRED');
  if (
    new Set(options.configuration).size !== options.configuration.length ||
    new Set(options.worlds.map((w) => w.sourceId)).size !== options.worlds.length ||
    (selection.scope !== 'config-only' && (options.configuration.length || options.worlds.length))
  )
    throw new Error('SELECTIVE_IMPORT_CONFIG_MAPPING_INVALID');
  const owners = new Set(options.owners.map((o) => o.sourceAgentGlobalId));
  if (
    owners.size !== options.owners.length ||
    owners.size !== selection.owners.length ||
    selection.owners.some((o) => !owners.has(o.agentGlobalId))
  )
    throw new Error('SELECTIVE_IMPORT_OWNER_MAPPING_REQUIRED');
  if (
    new Set(options.profiles.map((p) => p.sourceId)).size !== options.profiles.length ||
    options.profiles.length > 1000 ||
    options.externalReferences.length > 1000
  )
    throw new Error('SELECTIVE_IMPORT_DUPLICATE_MAPPING');
  if (
    new Set(
      options.externalReferences.map((e) => key('external', e.sourceId, e.sourceAgentGlobalId)),
    ).size !== options.externalReferences.length
  )
    throw new Error('SELECTIVE_IMPORT_DUPLICATE_MAPPING');
  for (const o of options.owners) {
    if (o.operation === 'skip') continue;
    if (!o.targetWorldId || (o.operation !== 'clone' && !o.targetAgentGlobalId))
      throw new Error('SELECTIVE_IMPORT_TARGET_OWNER_REQUIRED');
    if (o.operation === 'clone' && !['agent-one', 'agents-selected'].includes(selection.scope))
      throw new Error('SELECTIVE_IMPORT_RESIDENT_SCOPE_REQUIRED');
    if ((options.mode === 'restore') !== (o.operation === 'restore'))
      throw new Error('SELECTIVE_IMPORT_MODE_MISMATCH');
  }
  for (const p of options.profiles)
    if ((p.operation === 'map') !== !!p.targetId)
      throw new Error('SELECTIVE_IMPORT_PROFILE_MAPPING_REQUIRED');
  for (const e of options.externalReferences)
    if ((e.operation === 'map') !== !!e.targetId || !owners.has(e.sourceAgentGlobalId))
      throw new Error('SELECTIVE_IMPORT_EXTERNAL_MAPPING_REQUIRED');
}
export function allocationFields(table: string, fields: BackupRow) {
  if (table === 'memories' && fields.data.type === 'reflection')
    return { ...fields, data: { ...fields.data, relatedMemoryIds: [] } };
  if (table === 'memories' && fields.data.type === 'relationship')
    return { ...fields, data: { ...fields.data, evidenceMemoryIds: [] } };
  if (table === 'homeTravelTranscripts') {
    const { summaryMemoryId: _summary, endMemoryId: _end, ...rest } = fields;
    return rest;
  }
  if (table === 'homeTravelTranscriptPages') return { ...fields, memoryIds: [] };
  return fields;
}
export function canonicalFields(table: string, row: BackupRow) {
  let fields = stripSystem(row);
  if (table === 'memories') {
    const { embeddingId: _embedding, embeddingSpaceId: _space, ...rest } = fields;
    fields = rest;
  }
  if (table === 'homeTravelTranscripts') {
    const { summaryStartedAt: _started, summaryError: _error, ...rest } = fields;
    fields = {
      ...rest,
      summaryState: rest.summaryState === 'DONE' ? 'DONE' : 'FAILED',
      ...(rest.summaryState === 'DONE'
        ? {}
        : { summaryError: 'Imported history has no executable summary job.' }),
    };
  }
  return fields;
}
