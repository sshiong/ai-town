import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { captureSource, correctionHead, currentMemory } from '../agent/memorySources';
import { digest } from './security';

/** Synthetic observations only; exercises reverse-allocated correction ancestry. */
export async function seedMemoryBackupEvidence(ctx: MutationCtx, memoryId: Id<'memories'>) {
  const memory = (await ctx.db.get(memoryId))!;
  if (!memory.worldId) throw new Error('FIXTURE_WORLD_REQUIRED');
  const owner = { worldId: memory.worldId, playerId: memory.playerId, agentGlobalId: memory.agentGlobalId };
  const key = memory.data.type === 'travel' ? `travel:${memory.data.eventId}` : memory.data.type === 'conversation' ? `conversation:${memory.data.conversationId}` : null;
  if (!key) throw new Error('FIXTURE_EPISODIC_REQUIRED');
  const latestId = await ctx.db.insert('memorySourceCorrections', { ...owner, sourceMemoryId: memoryId, sourceKey: key,
    evidenceMemoryIds: [memoryId], correctionOrder: 200, text: 'Newest reported correction', operator: 'fixture', verification: 'ADMIN_REPORTED', createdAt: 200 });
  const earlierId = await ctx.db.insert('memorySourceCorrections', { ...owner, sourceMemoryId: memoryId, sourceKey: key,
    evidenceMemoryIds: [memoryId], correctionOrder: 100, text: 'Earlier reported correction', operator: 'fixture', verification: 'ADMIN_REPORTED', createdAt: 100 });
  await ctx.db.patch(latestId, { previousCorrectionId: earlierId });
  const source = await captureSource(ctx.db, memory, owner);
  const jobFields = { ...owner, kind: 'BATCH' as const, snapshotAt: 1, cursor: null, scanDone: true,
    sources: [source], revision: 2, attempts: 1, nextAttemptAt: 1, batchesCompleted: 1, sourcesCompleted: 1, createdAt: 1, updatedAt: 1 };
  const jobId = await ctx.db.insert('memoryCompressionJobs', { ...jobFields, state: 'DONE' });
  const summaryMemoryId = await ctx.db.insert('memories', { ...owner, description: 'Synthetic subjective summary', importance: 5, lastAccess: 1,
    data: { type: 'reflection', relatedMemoryIds: [memoryId] } });
  await ctx.db.insert('memorySummaryProvenance', { ...owner, summaryMemoryId, jobId, sources: [source], subjective: true,
    confidenceKind: 'MODEL_ESTIMATE', confidence: 0.6, firstSourceAt: 1, lastSourceAt: 1, createdAt: 1 });
  await ctx.db.insert('memorySourceClaims', { ...owner, memoryId, sourceKey: key, digest: source.digest, generation: latestId, jobId, state: 'DONE', createdAt: 1 });
  const pendingId = await ctx.db.insert('memories', { ...owner, description: 'Synthetic pending observation', importance: 5, lastAccess: 1,
    data: { type: 'travel', eventId: 'pending-compression', visitId: 'fixture-visit', hostTownId: 'fixture-host', participants: [], occurredAt: 1 } });
  const pending = await captureSource(ctx.db, (await ctx.db.get(pendingId))!, owner);
  const pendingJobId = await ctx.db.insert('memoryCompressionJobs', { ...jobFields, state: 'RUNNING', sources: [pending], scanDone: false,
    leaseUntil: Date.now() + 60_000, batchesCompleted: 0, sourcesCompleted: 0 });
  await ctx.db.insert('memorySourceClaims', { ...owner, memoryId: pendingId, sourceKey: pending.sourceKey, digest: pending.digest,
    generation: 'ORIGINAL', jobId: pendingJobId, state: 'CLAIMED', createdAt: 1 });
  return { latestId, earlierId, summaryMemoryId, pendingId, pendingJobId };
}

export async function useLegacyMemoryBackupDigests(ctx: MutationCtx) {
  const provenance = (await ctx.db.query('memorySummaryProvenance').first())!;
  const source = provenance.sources[0], memory = (await ctx.db.get(source.memoryId))!;
  const correction = (await ctx.db.get(source.correctionId!))!;
  const legacy = await digest({ worldId: memory.worldId, playerId: memory.playerId, agentGlobalId: memory.agentGlobalId,
    description: memory.description, data: memory.data, correctionId: correction._id, correctionText: correction.text });
  const sources = [{ ...source, digest: legacy }];
  await ctx.db.patch(provenance._id, { sources });
  await ctx.db.patch(provenance.jobId, { sources });
  const claim = (await ctx.db.query('memorySourceClaims').withIndex('job', q => q.eq('jobId', provenance.jobId)).first())!;
  await ctx.db.patch(claim._id, { digest: legacy });
}

export async function assertMemoryBackupEvidence(ctx: QueryCtx, includeInterruptedJob = true, expectedCurrent = true) {
  const provenance = await ctx.db.query('memorySummaryProvenance').collect();
  expect(provenance).toHaveLength(1);
  const metadata = provenance[0], source = metadata.sources[0];
  const memory = (await ctx.db.get(source.memoryId))!;
  const current = await captureSource(ctx.db, memory, metadata);
  if (expectedCurrent) expect(source).toEqual(current);
  else expect(source.digest).not.toBe(current.digest);
  const latest = (await ctx.db.get(source.correctionId!))!;
  const previous = (await ctx.db.get(latest.previousCorrectionId!))!;
  expect(latest).toMatchObject({ worldId: metadata.worldId, playerId: metadata.playerId,
    sourceMemoryId: memory._id, correctionOrder: 200, text: 'Newest reported correction', evidenceMemoryIds: [memory._id] });
  expect(previous).toMatchObject({ sourceMemoryId: memory._id, correctionOrder: 100, text: 'Earlier reported correction' });
  expect((await correctionHead(ctx.db, metadata, source.sourceKey))!._id).toBe(latest._id);
  const summary = (await ctx.db.get(metadata.summaryMemoryId))!;
  expect(summary.data).toEqual({ type: 'reflection', relatedMemoryIds: [memory._id] });
  if (expectedCurrent) expect(await currentMemory(ctx.db, summary)).not.toBeNull();
  else expect(await currentMemory(ctx.db, summary)).toBeNull();
  const claims = await ctx.db.query('memorySourceClaims').collect();
  expect(claims).toHaveLength(1);
  expect(claims[0]).toMatchObject({ state: 'DONE', memoryId: memory._id, generation: latest._id, digest: source.digest });
  const jobs = await ctx.db.query('memoryCompressionJobs').collect();
  expect(jobs).toHaveLength(includeInterruptedJob ? 2 : 1);
  expect(jobs.find(job => job._id === metadata.jobId)).toMatchObject({ state: 'DONE', sources: [source] });
  if (includeInterruptedJob) {
    const interrupted = jobs.find(job => job.state === 'CANCELLED');
    expect(interrupted).toMatchObject({ errorCode: 'BACKUP_RESTORE_INTERRUPTED_COMPRESSION', cursor: null, scanDone: true });
    expect(interrupted!.leaseUntil).toBeUndefined();
  }
  return { metadata, memory, summary, latest, previous, jobs };
}
