import { jest } from '@jest/globals';
import type { convexTest } from 'convex-test';
import type schema from '../../convex/schema';
import type { Id } from '../../convex/_generated/dataModel';
import { actionRef, mutationRef } from '../../convex/federation/refs';

type Test = ReturnType<typeof convexTest<typeof schema.tables>>;
/** Drive real privacy handlers; convex-test omits Blob.type, so restore only that metadata field. */
export async function drivePrivacyWithStorageMetadata(t: Test, jobId: Id<'travelPrivacyJobs'>) {
  for (let n = 0; n < 2000; n++) {
    const job = (await t.run(ctx => ctx.db.get(jobId)))!;
    if (job.state === 'COMPLETE') return;
    if (job.state !== 'RUNNING') throw new Error(`PRIVACY_TEST_STATE_${job.state}`);
    const latest = await t.run(ctx => ctx.db.system.query('_storage').order('desc').first());
    const now = Math.max(Date.now(), Math.ceil(latest?._creationTime ?? 0) + 10);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const args = { jobId, revision: job.revision };
      if (job.phase.startsWith('CHUNK_')) await t.action(actionRef('travelPrivacyChunkCoordinator/page'), args);
      else if (job.phase.startsWith('ARCHIVE_')) await t.action(actionRef('travelPrivacyArchives/page'), args);
      else await t.mutation(mutationRef('travelPrivacy/page'), args);
    } finally { clock.mockRestore(); }
    const repaired = await t.run(async ctx => {
      const operations = await ctx.db.query('archiveUploadOperations').collect();
      let changed = false;
      for (const object of await ctx.db.system.query('_storage').collect()) {
        const op = operations.find(o => o.state === 'UPLOADING' && o.size === object.size &&
          Buffer.from(o.sha256Hex, 'hex').toString('base64') === object.sha256);
        if (op && !object.contentType) {
          await ctx.db.patch(object._id as never, { contentType: op.contentType } as never);
          changed = true;
        }
      }
      return changed;
    });
    if (repaired) {
      await t.mutation(mutationRef('travelPrivacy/retry'), { adminToken: process.env.FEDERATION_ADMIN_TOKEN!, jobId });
    } else {
      const next = (await t.run(ctx => ctx.db.get(jobId)))!;
      if (next.archiveError) throw new Error(`PRIVACY_TEST_${next.phase}_${next.archiveError}`);
    }
  }
  throw new Error('PRIVACY_TEST_PAGE_LIMIT');
}
