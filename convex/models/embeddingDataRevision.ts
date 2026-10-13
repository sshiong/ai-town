import { assertMemoryNotRedacted, assertConversationNotRedacted, isTravelRedacted } from '../federation/travelPrivacyGuard';
import type { DatabaseReader, MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

export const sourceKey = 'memories';
export const privacyRevisionKey = 'travelPrivacySources';
// Independent from memory ownership: every source of an archive storage reference invalidates a paged proof.
export const archiveReferenceRevisionKey = 'archiveStorageReferences';
export const archiveReferenceTables = [
  'backupImports', 'backupLargeJobs', 'backupLargeChunks', 'backupLargeRows', 'backupSelectiveHistory',
  'coldHistoryArchives', 'coldHistoryChunks', 'coldArchiveMirrorJobs', 'music',
  'travelPrivacyArchiveObjects', 'travelPrivacyChunkObjects', 'travelPrivacyChunkRows',
  'travelPrivacyChunkReplacements', 'travelPrivacyChunkManifestRewrites',
  'archiveUploadOperations', 'archiveUploadCandidates',
] as const;
const privacySourceTables = ['coldHistoryArchives', 'coldHistoryChunks', 'homeTravelTranscripts', 'memorySourceCorrections', 'federationTurns', 'federationTranscriptJobs', 'backupImports', 'backupLargeJobs', 'backupLargeChunks', 'backupLargeGlobalMappings', 'backupLargeRows', 'backupSelectiveHistory', 'residentModelBindings'] as const;
export const vectorKey = (spaceId: string) => `vectors:${spaceId}`;
export async function dataRevision(db: DatabaseReader, key: string) {
  return (await db.query('embeddingDataRevisions').withIndex('key', q => q.eq('key', key)).unique())?.revision ?? 0;
}
async function bump(db: MutationCtx['db'], key: string) {
  const row = await db.query('embeddingDataRevisions').withIndex('key', q => q.eq('key', key)).unique();
  if (row) await db.patch(row._id, { revision: row.revision + 1 });
  else await db.insert('embeddingDataRevisions', { key, revision: 1 });
}
export async function memorySourceDigest(memory: Pick<Doc<'memories'>, 'description' | 'worldId' | 'playerId' | 'agentGlobalId'>) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    memory.description, memory.worldId ?? null, memory.playerId, memory.agentGlobalId ?? null,
  ])));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

/** All registered writers use this fence, including maintenance import writers. */
export function withEmbeddingRevision(ctx: MutationCtx): MutationCtx {
  const db = ctx.db;
  const tracked = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (!['insert', 'patch', 'replace', 'delete'].includes(String(property)))
        return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: any[]) => {
        const archiveTable = property === 'insert' ? args[0] : archiveReferenceTables.find(name => db.normalizeId(name, args[0]));
        const write = async () => {
          const result = await value.apply(target, args);
          if ((archiveReferenceTables as readonly string[]).includes(archiveTable)) await bump(db, archiveReferenceRevisionKey);
          return result;
        };
        const privacyTable = property === 'insert' ? args[0] : privacySourceTables.find(name => db.normalizeId(name, args[0]));
        if ((privacySourceTables as readonly string[]).includes(privacyTable)) {
          const result = await write();
          await bump(db, privacyRevisionKey);
          return result;
        }
        const table = property === 'insert' ? args[0]
          : db.normalizeId('memories', args[0]) ? 'memories'
          : db.normalizeId('modelMemoryVectors', args[0]) ? 'modelMemoryVectors' : undefined;
        if (table !== 'memories' && table !== 'modelMemoryVectors') return write();
        const prior = property === 'insert' ? null : await (db.get as any)(args[0]);
        if (property !== 'delete') {
          if (table === 'memories') {
            if (prior) await assertMemoryNotRedacted(db, prior._id);
            const next = { ...prior, ...args[1] };
            if (next.data?.type === 'travel' && await isTravelRedacted(db, next.data.visitId)) throw new Error('TRAVEL_PRIVACY_REDACTED');
            if (next.data?.type === 'conversation' && next.worldId) await assertConversationNotRedacted(db, next.worldId, next.data.conversationId);
            if (next.data?.type === 'reflection') for (const id of next.data.relatedMemoryIds) await assertMemoryNotRedacted(db, id);
          } else await assertMemoryNotRedacted(db, args[1]?.memoryId ?? prior?.memoryId);
        }
        const result = await write();
        if (table === 'memories') {
          if (property === 'patch' && Object.prototype.hasOwnProperty.call(args[1], 'data') &&
              JSON.stringify(args[1].data) !== JSON.stringify(prior?.data)) await bump(db, privacyRevisionKey);
          const material = property !== 'patch' || ['description', 'worldId', 'playerId', 'agentGlobalId']
            .some(key => Object.prototype.hasOwnProperty.call(args[1], key) && args[1][key] !== prior?.[key]);
          if (material) await bump(db, sourceKey);
        } else if (table === 'modelMemoryVectors') {
          if (prior?.spaceId) await bump(db, vectorKey(prior.spaceId));
          const next = property === 'insert' ? args[1] : property === 'delete' ? null : await (db.get as any)(args[0]);
          if (next?.spaceId && next.spaceId !== prior?.spaceId) await bump(db, vectorKey(next.spaceId));
        }
        return result;
      };
    },
  });
  return { ...ctx, db: tracked };
}
