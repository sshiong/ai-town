import { v } from 'convex/values';
import { internalAction, internalQuery, trackedInternalMutation as internalMutation } from '../maintenanceFunctions';
import { actionRef, mutationRef, queryRef } from './refs';
import { assertTerminal, scheduled } from './travelPrivacy';
import { dataRevision, privacyRevisionKey } from '../models/embeddingDataRevision';

const checkpoint = { jobId: v.id('travelPrivacyJobs'), revision: v.number() };
export const data = internalQuery({
  args: checkpoint, handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job || job.revision !== a.revision ||
      !(job.state === 'INSPECTING' && job.phase === 'CHUNK_CHECK' || job.state === 'RUNNING' && job.phase === 'CHUNK_REWRITE')) return null;
    await assertTerminal(ctx, job.visitId, job.history);
    return { job, scan: job.chunkScanId ? await ctx.db.get(job.chunkScanId) : null,
      rewrite: job.chunkRewriteId ? await ctx.db.get(job.chunkRewriteId) : null };
  },
});
export const finishInspection = internalMutation({
  args: checkpoint, handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job || job.revision !== a.revision || job.state !== 'INSPECTING' || job.phase !== 'CHUNK_CHECK' || !job.chunkScanId) return;
    await assertTerminal(ctx, job.visitId, job.history);
    const scan = await ctx.db.get(job.chunkScanId);
    if (!scan || scan.jobId !== job._id || scan.privacyRevision !== job.revision ||
      !['READY_TO_REWRITE', 'BLOCKED'].includes(scan.phase)) return;
    const blockers = [...job.blockers];
    if (scan.phase === 'BLOCKED' || scan.blockers) blockers.push('CHUNK_ARCHIVE_BLOCKED', ...scan.blockerCodes);
    if (scan.sourceRevision !== await dataRevision(ctx.db, privacyRevisionKey)) blockers.push('PREVIEW_STALE');
    const revision = job.revision + 1;
    await ctx.db.patch(job._id, { state: blockers.length ? 'BLOCKED' : 'READY', revision,
      blockers: [...new Set(blockers)], archiveError: undefined, updatedAt: Date.now(),
      archiveCoverage: { ordinaryBundles: 'READY', largeChunks: 'READY', orphanObjects: 'NOT_VERIFIED' } });
    await ctx.db.patch(scan._id, { privacyRevision: revision });
  },
});
export const continuePage = internalMutation({
  args: checkpoint, handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job || job.revision !== a.revision || !['CHUNK_CHECK', 'CHUNK_REWRITE'].includes(job.phase) ||
      !['INSPECTING', 'RUNNING'].includes(job.state)) return;
    await scheduled(ctx, job);
  },
});
export const finishRewrite = internalMutation({
  args: checkpoint, handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job || job.revision !== a.revision || job.state !== 'RUNNING' || job.phase !== 'CHUNK_REWRITE' || !job.chunkRewriteId) return;
    await assertTerminal(ctx, job.visitId, job.history);
    const rewrite = await ctx.db.get(job.chunkRewriteId);
    if (!rewrite || rewrite.privacyJobId !== job._id || rewrite.expectedParentRevision !== job.revision || rewrite.phase !== 'DONE') return;
    if (await ctx.db.query('travelPrivacyChunkReplacements').withIndex('rewrite_state', q => q.eq('rewriteId', rewrite._id))
      .filter(q => q.neq(q.field('state'), 'DELETED')).first()) throw new Error('CHUNK_DELETE_NOT_CONFIRMED');
    const ordinary = await ctx.db.query('travelPrivacyArchiveObjects').withIndex('job', q => q.eq('jobId', job._id))
      .filter(q => q.neq(q.field('state'), 'DELETED')).first();
    const next = { ...job, phase: ordinary ? 'ARCHIVE_REWRITE' : 'PURGE', cursor: null, tableIndex: 0,
      revision: job.revision + 1, archiveError: undefined, updatedAt: Date.now(),
      archiveCoverage: { ordinaryBundles: ordinary ? 'RUNNING' as const : 'COMPLETE' as const,
        largeChunks: 'COMPLETE' as const, orphanObjects: 'NOT_VERIFIED' as const } };
    await ctx.db.patch(job._id, { phase: next.phase, cursor: next.cursor, tableIndex: next.tableIndex,
      revision: next.revision, archiveError: undefined, updatedAt: next.updatedAt, archiveCoverage: next.archiveCoverage });
    await scheduled(ctx, next);
  },
});
export const fail = internalMutation({
  args: { ...checkpoint, code: v.string() }, handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job || job.revision !== a.revision || !['CHUNK_CHECK', 'CHUNK_REWRITE'].includes(job.phase)) return;
    await ctx.db.patch(job._id, { archiveError: /^[A-Z_]{1,80}$/.test(a.code) ? a.code : 'CHUNK_VALIDATION_FAILED', updatedAt: Date.now() });
  },
});
export const page = internalAction({
  args: checkpoint, handler: async (ctx, a) => {
    try {
      const current = await ctx.runQuery(queryRef('travelPrivacyChunkCoordinator/data'), a);
      if (!current) return;
      if (current.job.phase === 'CHUNK_CHECK') {
        const scan = current.scan;
        if (!scan || scan.privacyRevision !== a.revision) throw new Error('CHUNK_PLAN_MISSING');
        if (['READY_TO_REWRITE', 'BLOCKED'].includes(scan.phase)) {
          await ctx.runMutation(mutationRef('travelPrivacyChunkCoordinator/finishInspection'), a); return;
        }
        const args = { scanId: scan._id, revision: scan.revision };
        if (scan.phase === 'OBJECTS') await ctx.runAction(actionRef('travelPrivacyChunkArchives/inspectPage'), args);
        else await ctx.runMutation(mutationRef('travelPrivacyChunkArchives/planPage'), args);
      } else {
        const rewrite = current.rewrite;
        if (!rewrite || rewrite.expectedParentRevision !== a.revision) throw new Error('CHUNK_REWRITE_CHECKPOINT_CHANGED');
        if (rewrite.phase === 'DONE') {
          await ctx.runMutation(mutationRef('travelPrivacyChunkCoordinator/finishRewrite'), a); return;
        }
        await ctx.runAction(actionRef('travelPrivacyChunkRewrite/page'), { rewriteId: rewrite._id, revision: rewrite.revision });
        const after = await ctx.runQuery(queryRef('travelPrivacyChunkRewrite/status'), { rewriteId: rewrite._id });
        if (after?.errorCode) {
          await ctx.runMutation(mutationRef('travelPrivacyChunkCoordinator/fail'), { ...a, code: after.errorCode }); return;
        }
      }
      await ctx.runMutation(mutationRef('travelPrivacyChunkCoordinator/continuePage'), a);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      await ctx.runMutation(mutationRef('travelPrivacyChunkCoordinator/fail'), {
        ...a, code: /^[A-Z_]{1,80}$/.test(message) ? message : 'CHUNK_VALIDATION_FAILED',
      });
    }
  },
});
