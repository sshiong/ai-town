import { assertMemoryNotRedacted, privacyTombstone } from '../federation/travelPrivacyGuard';
import type { DatabaseReader, MutationCtx } from '../maintenanceFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { digest } from '../federation/security';

export type Source = Doc<'memoryCompressionJobs'>['sources'][number];
export type Owner = { worldId: Id<'worlds'>; playerId: string; agentGlobalId?: string };
export function sourceKey(memory: Doc<'memories'>): string | null {
  if (memory.data.type === 'travel') return `travel:${memory.data.eventId}`;
  if (memory.data.type === 'conversation') return `conversation:${memory.data.conversationId}`;
  return null;
}
export function assertOwner(memory: Doc<'memories'> | null, owner: Owner): asserts memory is Doc<'memories'> {
  if (!memory || memory.worldId !== owner.worldId || memory.playerId !== owner.playerId ||
      (owner.agentGlobalId && memory.agentGlobalId && memory.agentGlobalId !== owner.agentGlobalId))
    throw new Error('MEMORY_SOURCE_OWNER_MISMATCH');
}
export async function correctionHead(db: DatabaseReader, owner: Owner, key: string) {
  // Dependency imports may allocate the latest correction before its ancestors.
  const ordered = await db.query('memorySourceCorrections').withIndex('source_order', q =>
    q.eq('worldId', owner.worldId).eq('playerId', owner.playerId).eq('sourceKey', key)).order('desc').first();
  const legacy = await db.query('memorySourceCorrections').withIndex('source_order', q =>
    q.eq('worldId', owner.worldId).eq('playerId', owner.playerId).eq('sourceKey', key).eq('correctionOrder', undefined)).order('desc').first();
  if (!ordered) return legacy;
  if (!legacy) return ordered;
  return (ordered.correctionOrder ?? ordered._creationTime) >= legacy._creationTime ? ordered : legacy;
}
export async function captureSource(db: DatabaseReader, memory: Doc<'memories'>, owner: Owner): Promise<Source> {
  assertOwner(memory, owner);
  await assertMemoryNotRedacted(db, memory._id);
  const key = sourceKey(memory);
  if (!key) throw new Error('MEMORY_SOURCE_NOT_EPISODIC');
  const correction = await correctionHead(db, owner, key);
  return { memoryId: memory._id, sourceKey: key, correctionId: correction?._id,
    digest: await sourceEvidenceDigest(memory, correction) };
}
/** Compact evidence permits backup verification without duplicating retained text. */
export async function sourceContentDigest(memory: Pick<Doc<'memories'>, 'description' | 'data'>) {
  return digest({ description: memory.description, data: memory.data });
}
export async function sourceEvidenceDigest(
  memory: Pick<Doc<'memories'>, 'worldId' | 'playerId' | 'agentGlobalId'> & { description?: string; data?: Doc<'memories'>['data']; contentDigest?: string },
  correction: { _id: string; text: string } | null,
) {
  const contentDigest = memory.contentDigest ?? await sourceContentDigest(memory as Doc<'memories'>);
  return 'v2:' + await digest({ worldId: memory.worldId, playerId: memory.playerId, agentGlobalId: memory.agentGlobalId,
    contentDigest, correctionId: correction?._id, correctionText: correction?.text });
}
export async function sourceDigestMatches(
  memory: Parameters<typeof sourceEvidenceDigest>[0], correction: Parameters<typeof sourceEvidenceDigest>[1], expected: string,
) {
  if (expected.startsWith('v2:')) {
    if (!memory.contentDigest && (memory.description === undefined || memory.data === undefined)) return false;
    return expected === await sourceEvidenceDigest(memory, correction);
  }
  // Older packages remain readable; without complete legacy evidence an old
  // summary must remain stale rather than being legitimized during remapping.
  if (memory.description === undefined || memory.data === undefined) return false;
  return expected === await digest({ worldId: memory.worldId, playerId: memory.playerId, agentGlobalId: memory.agentGlobalId,
    description: memory.description, data: memory.data, correctionId: correction?._id, correctionText: correction?.text });
}
export async function availableSource(db: DatabaseReader, owner: Owner, source: Source) {
  return !(await db.query('memorySourceClaims').withIndex('source_generation', q =>
    q.eq('worldId', owner.worldId).eq('playerId', owner.playerId).eq('sourceKey', source.sourceKey)
      .eq('generation', source.correctionId ?? 'ORIGINAL')).unique());
}
export function sourceDocumentBytes(memory: Doc<'memories'>) {
  // Travel transcript text can live in data as well as description.
  return new TextEncoder().encode(JSON.stringify(memory)).byteLength;
}
export async function validateSources(db: DatabaseReader, owner: Owner, sources: Source[], maximumBytes = 8 * 1024 * 1024) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || sources.length > 100)
    throw new Error('MEMORY_SOURCE_BUDGET_EXCEEDED');
  const rows: Doc<'memories'>[] = [];
  let usedBytes = 0;
  for (const source of sources) {
    const memory = await db.get(source.memoryId);
    assertOwner(memory, owner);
    usedBytes += sourceDocumentBytes(memory);
    if (usedBytes > maximumBytes) throw new Error('MEMORY_SOURCE_BUDGET_EXCEEDED');
    const current = await captureSource(db, memory, owner);
    const correction = current.correctionId ? await db.get(current.correctionId) : null;
    if (!await sourceDigestMatches(memory, correction, source.digest) || current.sourceKey !== source.sourceKey || current.correctionId !== source.correctionId)
      throw new Error('MEMORY_SOURCE_CHANGED');
    rows.push(memory);
  }
  return rows;
}
export async function claimSources(ctx: MutationCtx, owner: Owner, jobId: Id<'memoryCompressionJobs'>, sources: Source[]) {
  for (const source of sources) {
    if (!await availableSource(ctx.db, owner, source)) throw new Error('MEMORY_SOURCE_ALREADY_CLAIMED');
    await ctx.db.insert('memorySourceClaims', { ...owner, memoryId: source.memoryId, sourceKey: source.sourceKey, digest: source.digest,
      generation: source.correctionId ?? 'ORIGINAL', jobId, state: 'CLAIMED', createdAt: Date.now() });
  }
}
export async function releaseSources(ctx: MutationCtx, jobId: Id<'memoryCompressionJobs'>) {
  const claims = await ctx.db.query('memorySourceClaims').withIndex('job_state', q => q.eq('jobId', jobId).eq('state', 'CLAIMED')).take(100);
  for (const claim of claims) await ctx.db.delete(claim._id);
}
/** Preserve originals, but never present an obsolete derived summary as current evidence. */
export async function currentMemory(db: DatabaseReader, memory: Doc<'memories'>) {
  if (await privacyTombstone(db, `memory:${memory._id}`)) return null;
  if (!memory.worldId) return memory;
  const owner = { worldId: memory.worldId, playerId: memory.playerId, agentGlobalId: memory.agentGlobalId };
  const provenance = await db.query('memorySummaryProvenance').withIndex('summary', q => q.eq('summaryMemoryId', memory._id)).unique();
  if (provenance) {
    try { await validateSources(db, owner, provenance.sources); } catch (error) {
      if (error instanceof Error && ['MEMORY_SOURCE_CHANGED', 'MEMORY_SOURCE_OWNER_MISMATCH', 'TRAVEL_PRIVACY_REDACTED'].includes(error.message)) return null;
      throw error;
    }
    return { ...memory, description: `${memory.description}\n[Subjective reflection; confidence is ${provenance.confidence === undefined ? 'unknown (model estimate not supplied)' : `a model estimate (${provenance.confidence}), not verified fact`}.]` };
  }
  const key = sourceKey(memory);
  const correction = key && await correctionHead(db, owner, key);
  return correction ? { ...memory, description: `${memory.description}\n[Source correction; administrator report, not verified fact: ${correction.text}]` } : memory;
}

export async function currentMemories(db: DatabaseReader, memories: Doc<'memories'>[]) {
  const result: Doc<'memories'>[] = [];
  for (const memory of memories) { const current = await currentMemory(db, memory); if (current) result.push(current); }
  return result;
}
