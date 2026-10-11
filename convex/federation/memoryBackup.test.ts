import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { currentMemory } from '../agent/memorySources';
import { repairMemoryBackupRow } from './memoryBackup';
import { seedMemoryBackupEvidence } from './memoryBackupTestHelpers';

beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));

test('missing compact source evidence conservatively preserves a stale restored summary', async () => {
  const t = convexTest(schema, { '../_generated/server.ts': () => import('../_generated/server') });
  await t.run(async ctx => {
    const worldId = await ctx.db.insert('worlds', { nextId: 1, players: [], agents: [], conversations: [] });
    const memoryId = await ctx.db.insert('memories', { worldId, playerId: 'p:0', description: 'Synthetic retained observation', importance: 5, lastAccess: 1,
      data: { type: 'travel', eventId: 'memory-evidence', visitId: 'fixture-visit', hostTownId: 'fixture-host', participants: [], occurredAt: 1 } });
    const seeded = await seedMemoryBackupEvidence(ctx, memoryId);
    const metadata = (await ctx.db.query('memorySummaryProvenance').first())!;
    await repairMemoryBackupRow(ctx, 'memorySummaryProvenance', metadata._id, metadata, async id => {
      if (id === memoryId) return { table: 'memories', row: { worldId, playerId: 'p:0' } };
      if (id === seeded.latestId) return { table: 'memorySourceCorrections', row: (await ctx.db.get(seeded.latestId))! };
      return null;
    });
    expect((await ctx.db.get(metadata._id))!.sources[0].digest).toBe('RESTORED_STALE_SOURCE');
    expect(await currentMemory(ctx.db, (await ctx.db.get(seeded.summaryMemoryId))!)).toBeNull();
    expect((await ctx.db.get(memoryId))!.description).toBe('Synthetic retained observation');
  });
});
