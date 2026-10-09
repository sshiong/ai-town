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
