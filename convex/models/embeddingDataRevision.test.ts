import { convexTest } from 'convex-test';
import schema from '../schema';
import { dataRevision, privacyRevisionKey, sourceKey, withEmbeddingRevision } from './embeddingDataRevision';

const modules = { '../_generated/server.ts': () => import('../_generated/server') };

test.each(['job metadata', 'chunk descriptor', 'resident mapping'] as const)(
  'registered %s changes invalidate a privacy plan without changing canonical memory revision', async kind => {
    const t = convexTest(schema, modules);
    await t.run(async ctx => {
      const job = { kind: 'import' as const, state: 'COMPLETE', phase: 'DONE', tableIndex: 0, cursor: null,
        chunkCount: 0, processedChunks: 0, recordCount: 0, bytes: 0, createdAt: 1, updatedAt: 1, source: {} };
      const jobId = await ctx.db.insert('backupLargeJobs', job);
      const storageId = await ctx.storage.store(new Blob(['{}']));
      const db = withEmbeddingRevision(ctx).db;
      const before = await dataRevision(ctx.db, privacyRevisionKey);
      const canonical = await dataRevision(ctx.db, sourceKey);
      if (kind === 'job metadata') {
        const id = await db.insert('backupLargeJobs', job);
        await db.patch(id, { state: 'CANCELLED' });
        await db.replace(id, { ...job, source: { sourceTownId: 'changed' } });
        await db.delete(id);
      } else if (kind === 'chunk descriptor') {
        const row = { jobId, storageId, index: 0, table: 'memories', count: 0, bytes: 2, digest: 'fixture-digest' };
        const id = await db.insert('backupLargeChunks', row);
        await db.patch(id, { count: 1 });
        await db.replace(id, { ...row, table: 'inputs' });
        await db.delete(id);
      } else {
        const row = { jobId, sourceId: 'source-resident', targetId: 'first-resident' };
        const id = await db.insert('backupLargeGlobalMappings', row);
        await db.patch(id, { targetId: 'other-resident' });
        await db.replace(id, { ...row, sourceId: 'other-source' });
        await db.delete(id);
      }
      expect(await dataRevision(ctx.db, privacyRevisionKey)).toBe(before + 4);
      expect(await dataRevision(ctx.db, sourceKey)).toBe(canonical);
    });
  },
);
