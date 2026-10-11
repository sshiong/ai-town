import { convexTest } from 'convex-test';
import schema from '../schema';
import { assertBackupPrivacy, residentPrivacyRows, restorePrivacyRows } from './backupPrivacy';

async function fixture() {
  const t = convexTest(schema, { '../_generated/server.ts': () => import('../_generated/server') });
  await t.run(ctx => ctx.db.insert('travelPrivacyTombstones', {
    key: 'memory:removed-target', visitId: 'removed-visit', createdAt: 1,
  }));
  await t.run(ctx => ctx.db.insert('travelPrivacyTombstones', {
    key: 'visit:removed-visit', visitId: 'removed-visit', createdAt: 1,
  }));
  return t;
}
test('rejects an old memory snapshot even after its destination document was removed', async () => {
  const t = await fixture();
  await t.run(ctx => ctx.db.insert('backupImports', {
    sourceTownId: 'source', mode: 'restore', exportedAt: 1, importedAt: 2,
    mapping: { 'source-memory': 'removed-target' }, runtimeSnapshot: {}, manifest: {},
  }));
  await expect(t.run(ctx => assertBackupPrivacy(ctx.db, {
    memories: [{ _id: 'source-memory', data: { type: 'reflection', relatedMemoryIds: [] } }],
  }, 'source'))).rejects.toThrow('BACKUP_PRIVACY_REDACTED');
});
test('checks derived provenance rather than requiring the deleted original in the archive', async () => {
  const t = await fixture();
  await expect(t.run(ctx => assertBackupPrivacy(ctx.db, {
    memorySummaryProvenance: [{ sources: [{ memoryId: 'removed-target' }] }],
  }, 'source'))).rejects.toThrow('BACKUP_PRIVACY_REDACTED');
});
test('unrelated memories remain importable while deleted visit bodies are rejected', async () => {
  const t = await fixture();
  await expect(t.run(ctx => assertBackupPrivacy(ctx.db, {
    memories: [{ _id: 'other', data: { type: 'travel', visitId: 'other-visit' } }],
  }, 'source'))).resolves.toBeNull();
  await expect(t.run(ctx => assertBackupPrivacy(ctx.db, {
    homeTravelTranscriptPages: [{ visitId: 'removed-visit', messages: ['private text'] }],
  }, 'source'))).rejects.toThrow('BACKUP_PRIVACY_REDACTED');
});
test('ledger and strictly redacted facts survive without accepting a forged redaction flag', async () => {
  const t = await fixture();
  const rows = {
    visitLedger: [{ visitId: 'removed-visit', state: 'COMPLETED' }],
    federationEventFacts: [{ visitId: 'removed-visit', payload: { privacyRedacted: true, messageId: 'm' } }],
  };
  await expect(t.run(ctx => assertBackupPrivacy(ctx.db, rows, 'source'))).resolves.toBeNull();
  await expect(t.run(ctx => assertBackupPrivacy(ctx.db, {
    federationEventFacts: [{ visitId: 'removed-visit', payload: { privacyRedacted: true, text: 'private' } }],
  }, 'source'))).rejects.toThrow('BACKUP_PRIVACY_REDACTED');
});
test('conversation clearing follows world and conversation remapping together', async () => {
  const t = await fixture();
  await t.run(async ctx => {
    await ctx.db.insert('travelPrivacyTombstones', { key: 'conversation:target-world:c:9', visitId: 'removed-visit', createdAt: 1 });
    await ctx.db.insert('backupImports', { sourceTownId: 'source', mode: 'merge', exportedAt: 1, importedAt: 2,
      mapping: { 'source-world': 'target-world', 'c:1': 'c:9' }, runtimeSnapshot: {}, manifest: {} });
  });
  await expect(t.run(ctx => assertBackupPrivacy(ctx.db, {
    messages: [{ worldId: 'source-world', conversationId: 'c:1', text: 'old' }],
  }, 'source'))).rejects.toThrow('BACKUP_PRIVACY_REDACTED');
});

test('incoming deletion history rejects a contradictory archive even on an empty destination', async () => {
  const t = convexTest(schema, { '../_generated/server.ts': () => import('../_generated/server') });
  await expect(t.run(ctx => assertBackupPrivacy(ctx.db, {
    travelPrivacyTombstones: [{ key: 'memory:deleted', visitId: 'v', createdAt: 1 }],
    memories: [{ _id: 'deleted', data: { type: 'reflection', relatedMemoryIds: [] } }],
  }, 'source'))).rejects.toThrow('BACKUP_PRIVACY_REDACTED');
});

test('privacy restore unions original and mapped keys without replacing existing deletion evidence', async () => {
  const t = await fixture();
  const worlds = await t.run(async ctx => {
    const fields = { nextId: 1, players: [], agents: [], conversations: [] };
    return [await ctx.db.insert('worlds', fields), await ctx.db.insert('worlds', fields)];
  });
  const rows = [{ key: `conversation:${worlds[0]}:c:1`, visitId: 'v', createdAt: 3,
    worldId: worlds[0], playerIds: ['p:0'] }];
  const mapping = { [worlds[0]]: worlds[1], 'c:1': 'c:9', 'p:0': 'p:7' };
  await t.run(ctx => restorePrivacyRows(ctx, rows, mapping));
  const first = await t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect());
  expect(first.find(row => row.key === `conversation:${worlds[1]}:c:9`))
    .toMatchObject({ worldId: worlds[1], playerIds: ['p:7'] });
  expect(first.some(row => row.key === 'memory:removed-target')).toBe(true);
  await t.run(ctx => restorePrivacyRows(ctx, rows, mapping));
  expect(await t.run(ctx => ctx.db.query('travelPrivacyTombstones').collect())).toEqual(first);
});

test('resident export finds owned deletion evidence beyond unrelated records on later pages', async () => {
  const t = await fixture();
  const worldId = await t.run(ctx => ctx.db.insert('worlds', { nextId: 1, players: [], agents: [], conversations: [] }));
  await t.run(async ctx => {
    for (let i = 0; i < 520; i++) await ctx.db.insert('travelPrivacyTombstones', {
      key: `memory:other-${i}`, visitId: `v-${i}`, createdAt: 1, worldId, playerId: 'p:9', ownerGlobalId: 'other',
    });
    await ctx.db.insert('travelPrivacyTombstones', {
      key: 'memory:owned-last', visitId: 'mine', createdAt: 1, worldId, playerId: 'p:0', ownerGlobalId: 'me',
    });
  });
  const rows = await t.run(ctx => residentPrivacyRows(ctx.db, { worldId, playerId: 'p:0', agentGlobalId: 'me' }));
  expect(rows.map(row => row.key)).toEqual(['memory:owned-last']);
});

test('configuration-only checks do not scan unrelated deletion-mapping history', async () => {
  const t = await fixture();
  await t.run(async ctx => {
    for (let i = 0; i < 501; i++) await ctx.db.insert('backupImports', { sourceTownId: 'source', mode: 'merge',
      exportedAt: i, importedAt: i, mapping: {}, runtimeSnapshot: {}, manifest: {} });
  });
  await expect(t.run(ctx => assertBackupPrivacy(ctx.db, { chatProfiles: [{ name: 'Updated profile' }] }, 'source')))
    .resolves.toBeNull();
  await expect(t.run(ctx => assertBackupPrivacy(ctx.db, { memories: [{ _id: 'old', data: { type: 'reflection', relatedMemoryIds: [] } }] }, 'source')))
    .rejects.toThrow('BACKUP_PRIVACY_HISTORY_LIMIT');
});
