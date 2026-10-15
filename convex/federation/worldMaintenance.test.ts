import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../testing.ts': () => import('../testing'),
  '../world.ts': () => import('../world'),
};
test('explicitly pausing an idle world prevents a browser heartbeat from restarting it during backup preparation', async () => {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 0,
      players: [],
      agents: [],
      conversations: [],
    });
    const engineId = await ctx.db.insert('engines', { running: false, generationNumber: 0 });
    const statusId = await ctx.db.insert('worldStatus', {
      worldId,
      engineId,
      status: 'inactive',
      isDefault: true,
      lastViewed: 1,
    });
    return { worldId, engineId, statusId };
  });
  await t.mutation(makeFunctionReference<'mutation'>('testing:stop'), {});
  await t.mutation(makeFunctionReference<'mutation'>('world:heartbeatWorld'), {
    worldId: ids.worldId,
  });
  expect((await t.run((ctx) => ctx.db.get(ids.statusId)))!.status).toBe('stoppedByDeveloper');
  expect((await t.run((ctx) => ctx.db.get(ids.engineId)))!.running).toBe(false);
});

test.each(['backup', 'cold'] as const)(
  'browser heartbeat during %s maintenance is readonly and leaves all writers guarded',
  async (kind) => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const worldId = await ctx.db.insert('worlds', {
        nextId: 0,
        players: [],
        agents: [],
        conversations: [],
      });
      const engineId = await ctx.db.insert('engines', { running: false, generationNumber: 0 });
      const statusId = await ctx.db.insert('worldStatus', {
        worldId,
        engineId,
        status: 'stoppedByDeveloper',
        isDefault: true,
        lastViewed: 1,
      });
      if (kind === 'backup') {
        const jobId = await ctx.db.insert('backupLargeJobs', {
          kind: 'export',
          state: 'RUNNING',
          phase: 'EXPORTING',
          tableIndex: 0,
          cursor: null,
          chunkCount: 0,
          processedChunks: 0,
          recordCount: 0,
          bytes: 0,
          createdAt: 1,
          updatedAt: 1,
          source: {},
        });
        await ctx.db.insert('backupMaintenanceLocks', { key: 'town', jobId, createdAt: 1 });
      } else {
        const archiveId = await ctx.db.insert('coldHistoryArchives', {
          sourceKey: 'test',
          worldId,
          kind: 'conversation',
          sourceId: 'c:0',
          state: 'PENDING',
          manifest: {},
          signature: '',
          publicKey: '',
          createdAt: 1,
        });
        const jobId = await ctx.db.insert('coldHistoryJobs', {
          archiveId,
          owner: {},
          source: {},
          snapshotId: 'test',
          state: 'RUNNING',
          phase: 'CAPTURE',
          revision: 0,
          cursor: null,
          pageNumber: 0,
          messageOffset: 0,
          chunkCount: 0,
          count: 0,
          bytes: 0,
          chainDigest: '',
          verifiedChunks: 0,
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert('coldHistoryLocks', { key: 'town', jobId, createdAt: 1 });
      }
      return { worldId, statusId, engineId };
    });
    const before = await t.run(async (ctx) => ({
      status: await ctx.db.get(ids.statusId),
      engine: await ctx.db.get(ids.engineId),
    }));
    const visibleStatus = await t.query(makeFunctionReference<'query'>('world:defaultWorldStatus'), {});
    expect(visibleStatus).toEqual({ ...before.status, maintenance: true });
    expect(visibleStatus).not.toHaveProperty('jobId');
    // A clone can publish world/status before its map. Keep the missing-map
    // invariant intact; the UI must skip this query while maintenance is active.
    await expect(t.query(makeFunctionReference<'query'>('world:gameDescriptions'), {
      worldId: ids.worldId,
    })).rejects.toThrow('No map for world');
    await t.mutation(makeFunctionReference<'mutation'>('world:heartbeatWorld'), {
      worldId: ids.worldId,
    });
    expect(
      await t.run(async (ctx) => ({
        status: await ctx.db.get(ids.statusId),
        engine: await ctx.db.get(ids.engineId),
      })),
    ).toEqual(before);
    await expect(t.mutation(makeFunctionReference<'mutation'>('testing:stop'), {})).rejects.toThrow(
      kind === 'backup' ? 'TOWN_BACKUP_MAINTENANCE_LOCKED' : 'TOWN_COLD_HISTORY_MAINTENANCE_LOCKED',
    );
    await t.run(async ctx => {
      for (const lock of await ctx.db.query(kind === 'backup' ? 'backupMaintenanceLocks' : 'coldHistoryLocks').collect())
        await ctx.db.delete(lock._id);
    });
    expect(await t.query(makeFunctionReference<'query'>('world:defaultWorldStatus'), {})).toEqual({
      ...before.status, maintenance: false,
    });
  },
);
