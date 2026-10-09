import type { DatabaseReader } from '../_generated/server';

/** Keep paused-world archive snapshots stable until their owner releases the lock. */
export async function assertTownUnlocked(ctx: { db: DatabaseReader }) {
  const lock = await ctx.db
    .query('backupMaintenanceLocks')
    .withIndex('key', (q) => q.eq('key', 'town'))
    .unique();
  if (lock) throw new Error('TOWN_BACKUP_MAINTENANCE_LOCKED');
}
