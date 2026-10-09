import { cronJobs } from 'convex/server';
import { DELETE_BATCH_SIZE, IDLE_WORLD_TIMEOUT, VACUUM_MAX_AGE } from './constants';
import { internal } from './_generated/api';
import { internalMutation } from './maintenanceFunctions';
import { TableNames } from './_generated/dataModel';
import { v } from 'convex/values';

const crons = cronJobs();

crons.interval(
  'stop inactive worlds',
  { seconds: IDLE_WORLD_TIMEOUT / 1000 },
  internal.world.stopInactiveWorlds,
);

crons.interval('restart dead worlds', { seconds: 60 }, internal.world.restartDeadWorlds);

crons.interval(
  'federation transport and recovery',
  { seconds: 10 },
  internal.federation.transport.tick,
);
crons.interval('federation endpoint update retries', { seconds: 10 }, internal.federation.endpoints.retryPending);
crons.interval('federation final conversation delivery', { seconds: 10 }, internal.federation.transcripts.flushPending);
crons.interval('retry complete travel conversation summaries', { seconds: 60 }, internal.agent.travelTranscript.retrySummaries);
crons.interval('remote decision deadlines', { seconds: 10 }, internal.federation.decision.recover);
crons.interval(
  'federation engine receipts',
  { seconds: 10 },
  internal.federation.runtime.reconcileEngineJobs,
);

crons.hourly(
  'storage usage and safe cleanup',
  { minuteUTC: 35 },
  internal.federation.storagePolicy.maintenance,
);

crons.daily('vacuum old entries', { hourUTC: 4, minuteUTC: 20 }, internal.crons.vacuumOldEntries);

export default crons;

// Retention requiring reference checks is handled by storagePolicy cleanup.
const TablesToVacuum: TableNames[] = [];

export const vacuumOldEntries = internalMutation({
  args: {},
  handler: async (ctx, args) => {
    const before = Date.now() - VACUUM_MAX_AGE;
    for (const tableName of TablesToVacuum) {
      console.log(`Checking ${tableName}...`);
      const exists = await ctx.db
        .query(tableName)
        .withIndex('by_creation_time', (q) => q.lt('_creationTime', before))
        .first();
      if (exists) {
        console.log(`Vacuuming ${tableName}...`);
        await ctx.scheduler.runAfter(0, internal.crons.vacuumTable, {
          tableName,
          before,
          cursor: null,
          soFar: 0,
        });
      }
    }
  },
});

export const vacuumTable = internalMutation({
  args: {
    tableName: v.string(),
    before: v.number(),
    cursor: v.union(v.string(), v.null()),
    soFar: v.number(),
  },
  handler: async (ctx, { tableName, before, cursor, soFar }) => {
    if (!TablesToVacuum.includes(tableName as TableNames))
      throw new Error('TABLE_NOT_APPROVED_FOR_AGE_VACUUM');
    const results = await ctx.db
      .query(tableName as TableNames)
      .withIndex('by_creation_time', (q) => q.lt('_creationTime', before))
      .paginate({ cursor, numItems: DELETE_BATCH_SIZE });
    for (const row of results.page) {
      await ctx.db.delete(row._id);
    }
    if (!results.isDone) {
      await ctx.scheduler.runAfter(0, internal.crons.vacuumTable, {
        tableName,
        before,
        soFar: results.page.length + soFar,
        cursor: results.continueCursor,
      });
    } else {
      console.log(`Vacuumed ${soFar + results.page.length} entries from ${tableName}`);
    }
  },
});
