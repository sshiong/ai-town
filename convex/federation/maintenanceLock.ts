import type { DatabaseReader } from '../_generated/server';

/** Keep paused-world archive snapshots stable until their owner releases the lock. */
export async function townMaintenanceLock(ctx: { db: DatabaseReader }) {
  const lock = await ctx.db
    .query('backupMaintenanceLocks')
    .withIndex('key', (q) => q.eq('key', 'town'))
    .unique();
  if (lock) return 'TOWN_BACKUP_MAINTENANCE_LOCKED';
  const coldLock = await ctx.db
    .query('coldHistoryLocks')
    .withIndex('key', (q) => q.eq('key', 'town'))
    .unique();
  return coldLock ? 'TOWN_COLD_HISTORY_MAINTENANCE_LOCKED' : null;
}

export async function assertTownUnlocked(ctx: { db: DatabaseReader }) {
  const lock = await townMaintenanceLock(ctx);
  if (lock) throw new Error(lock);
}
