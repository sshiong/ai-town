import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { Id } from '../_generated/dataModel';
import { createIdentityKeys } from './security';
import { BackupRow, decodeRow, encodeRow, validateBundle } from './backupHelpers';
import { LargeChunk, descriptor, validateManifest } from './backupLargeHelpers';
import {
  ArchiveEnvelope,
  SelectiveManifest,
  validateSelectiveChunk,
  validateSelectiveManifest,
} from './backupSelectiveHelpers';
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/backupSelective.ts': () => import('./backupSelective'),
  '../federation/backupLarge.ts': () => import('./backupLarge'),
};
const adminToken = 'selective-test-admin-token-32-characters';
const q = (name: string) => makeFunctionReference<'query'>(`federation/backupSelective:${name}`);
const m = (name: string) => makeFunctionReference<'mutation'>(`federation/backupSelective:${name}`);
const a = (name: string) => makeFunctionReference<'action'>(`federation/backupSelective:${name}`);
jest.setTimeout(60000);
beforeAll(() =>
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }),
);
beforeEach(() => {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
});
async function fixture(count = 3) {
  const t = convexTest(schema, modules);
  const keys = await createIdentityKeys();
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert('federationIdentity', {
      ...keys,
      townId: 'town:selective',
      townName: 'Selective',
      deploymentInstanceId: 'instance:1',
      deploymentEpoch: 1,
      endpoint: 'https://selective.example/federation/v1',
      enabled: false,
      allowIncomingPairRequests: false,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 8,
      maxVisitDurationMs: 300000,
      mode: 'ACTIVE',
      createdAt: 1,
    });
    await ctx.db.insert('engines', { running: false, generationNumber: 1 });
    const worldId = await ctx.db.insert('worlds', {
      nextId: 4,
      players: [0, 1].map((i) => ({
        id: `p:${i}`,
        lastInput: 1,
        position: { x: 1, y: 1 },
        facing: { dx: 1, dy: 0 },
        speed: 0,
      })),
      agents: [
        { id: 'a:0', playerId: 'p:0' },
        { id: 'a:1', playerId: 'p:1' },
      ],
      conversations: [],
    });
    const chatProfileId = await ctx.db.insert('chatProfiles', {
      name: 'Fixed identity profile',
      provider: 'custom',
      url: 'https://chat.example',
      model: 'source-model',
      apiKeyEnv: 'SOURCE_CHAT_KEY',
      stopWords: [],
      createdAt: 1,
    });
    await ctx.db.insert('modelSettings', { key: 'town', mainChatProfileId: chatProfileId });
    const globals = [0, 1].map((i) => `town:selective/agent:${worldId}:a:${i}`);
    for (const [i, agentGlobalId] of globals.entries()) {
      await ctx.db.insert('residentModelBindings', {
        worldId,
        playerId: `p:${i}`,
        agentGlobalId,
        chatProfileId,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('federationAgentRuntimes', {
        worldId,
        playerId: `p:${i}`,
        agentId: `a:${i}`,
        agentGlobalId,
        homeTownId: 'town:selective',
        state: 'HOME_ACTIVE',
        agentAuthorityEpoch: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('playerDescriptions', {
        worldId,
        playerId: `p:${i}`,
        name: `Resident ${i}`,
        description: `Personality ${i}`,
        character: 'f1',
      });
      await ctx.db.insert('agentDescriptions', {
        worldId,
        agentId: `a:${i}`,
        identity: `Identity ${i}`,
        plan: 'Stable original plan',
      });
    }
    const memories: Id<'memories'>[] = [];
    for (let i = 0; i < count; i++)
      memories.push(
        await ctx.db.insert('memories', {
          worldId,
          playerId: 'p:0',
          agentGlobalId: globals[0],
          description: `Memory ${i}`,
          importance: 7,
          lastAccess: 100,
          data: {
            type: 'travel',
            eventId: `event:${i}`,
            visitId: 'visit:old',
            hostTownId: 'town:host',
            participants: [],
            occurredAt: i * 100,
          },
        }),
      );
    const secretMemory = await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:1',
      agentGlobalId: globals[1],
      description: 'Other owner PRIVATE',
      importance: 10,
      lastAccess: 1,
      data: { type: 'reflection', relatedMemoryIds: [] },
    });
    return { worldId, chatProfileId, globals, memories, secretMemory };
  });
  return { t, ...ids };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function drive(t: Fixture['t'], jobId: Id<'backupLargeJobs'>) {
  for (let n = 0; n < 1000; n++) {
    const job = await t.query(q('status'), { adminToken, jobId });
    if (job.state === 'COMPLETE') return;
    if (job.state === 'FAILED') throw new Error(job.error);
    await t.action(a('advanceExport'), { adminToken, jobId });
  }
  throw new Error('Archive did not complete');
}
async function exportArchive(f: Fixture, options: Record<string, unknown> = {}) {
  const { jobId } = await f.t.mutation(m('startExport'), {
    adminToken,
    scope: 'agent-one',
    agentGlobalIds: [f.globals[0]],
    categories: ['travel', 'conversation', 'relationship', 'reflection', 'social'],
    operator: 'test-admin',
    reason: 'Archive audit',
    ...options,
  });
  await drive(f.t, jobId);
  const result = await f.t.action(a('getManifest'), { adminToken, jobId });
  const manifest = result.manifest as SelectiveManifest;
  const chunks: LargeChunk[] = [];
  for (const d of manifest.chunks)
    chunks.push(JSON.parse(await f.t.action(a('getChunk'), { adminToken, jobId, index: d.index })));
  return { jobId, manifest, signature: result.signature as string, chunks };
}
function records(
  archive: Awaited<ReturnType<typeof exportArchive>>,
  table: string,
): (BackupRow & { role: 'primary' | 'dependency' })[] {
  return archive.chunks
    .filter((c) => c.table === table)
    .flatMap((c) => c.rows.map(decodeRow) as ArchiveEnvelope[])
    .filter((e): e is Extract<ArchiveEnvelope, { kind: 'record' }> => e.kind === 'record')
    .map((e) => ({ ...decodeRow(e.record), role: e.role }));
}
test('resident pagination exports all 530 rows, real bindings and personality with no other private memories', async () => {
  const f = await fixture(530);
  const archive = await exportArchive(f);
  expect(records(archive, 'memories')).toHaveLength(530);
  expect(records(archive, 'worlds')[0].players.map((p: any) => p.id)).toEqual(['p:0']);
  expect(records(archive, 'residentModelBindings')[0].chatProfileId).toBe(f.chatProfileId);
  expect(records(archive, 'chatProfiles')[0].model).toBe('source-model');
  expect(records(archive, 'agentDescriptions')[0].identity).toBe('Identity 0');
  expect(JSON.stringify(archive)).not.toContain('Other owner PRIVATE');
  expect(JSON.stringify(archive)).not.toMatch(
    /privateKeyEncrypted|fencingToken|credentialEncrypted/,
  );
  await validateSelectiveManifest(archive.manifest, archive.signature);
  for (const [i, chunk] of archive.chunks.entries())
    await validateSelectiveChunk(chunk, archive.manifest.chunks[i]);
  await expect(validateManifest(archive.manifest as any, archive.signature)).rejects.toThrow(
    'UNSUPPORTED_LARGE_BACKUP_MANIFEST',
  );
  expect(await f.t.query(async (ctx) => ctx.db.query('backupMaintenanceLocks').first())).toBeNull();
});
test('bounded primary rows retain cyclic same-owner evidence dependencies and map excluded private evidence', async () => {
  const f = await fixture(3);
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.memories[1], {
      data: {
        type: 'reflection',
        relatedMemoryIds: [f.memories[0], f.memories[2], f.secretMemory],
      },
    });
    await ctx.db.patch(f.memories[2], {
      data: { type: 'reflection', relatedMemoryIds: [f.memories[1]] },
    });
  });
  const archive = await exportArchive(f, {
    scope: 'memories-only',
    categories: ['reflection'],
    from: 1,
    to: Date.now() + 100000,
  });
  // The travel evidence falls outside both the category and time bounds, and is explicitly a dependency.
  const memories = records(archive, 'memories');
  expect(memories).toHaveLength(3);
  expect(memories.every((m) => m.playerId === 'p:0')).toBe(true);
  expect(memories.find((m) => m._id === f.memories[0])?.role).toBe('dependency');
  expect(memories.filter((m) => m.role === 'primary')).toHaveLength(2);
  const refs = archive.chunks
    .filter((c) => c.table === 'referenceMappings')
    .flatMap((c) => c.rows.map(decodeRow));
  expect(refs).toContainEqual({
    kind: 'external-reference',
    sourceId: f.secretMemory,
    table: 'memories',
    reason: 'PRIVATE_OWNER_EXCLUDED',
  });
  expect(JSON.stringify(archive)).not.toContain('Other owner PRIVATE');
  expect(archive.manifest.selection.dependencyPolicy).toBe(
    'same-owner-evidence-and-public-context',
  );
});
test('half-open event time and category bounds are immutable and signed', async () => {
  const f = await fixture(5);
  const archive = await exportArchive(f, {
    scope: 'memories-only',
    categories: ['travel'],
    from: 100,
    to: 300,
  });
  expect(records(archive, 'memories').map((m) => m.data.occurredAt)).toEqual([100, 200]);
  const bad = structuredClone(archive.manifest);
  bad.selection.from = 0;
  await expect(validateSelectiveManifest(bad, archive.signature)).rejects.toThrow(
    'BACKUP_SIGNATURE_INVALID',
  );
  const chunk = structuredClone(archive.chunks[0]);
  chunk.rows[0] = String(chunk.rows[0]).replace('primary', 'dependency');
  await expect(validateSelectiveChunk(chunk, archive.manifest.chunks[0])).rejects.toThrow(
    'BACKUP_CHECKSUM_MISMATCH',
  );
  await expect(
    f.t.mutation(m('startExport'), {
      adminToken,
      scope: 'history',
      agentGlobalIds: f.globals,
      categories: ['reflection'],
      operator: 'admin',
      reason: 'invalid',
    }),
  ).rejects.toThrow('INVALID_SELECTIVE_SCOPE');
});
test('config-only omits resident state and memory; selected owners can include both residents explicitly', async () => {
  const f = await fixture();
  const config = await exportArchive(f, {
    scope: 'config-only',
    agentGlobalIds: [],
    categories: ['configuration'],
  });
  expect(records(config, 'memories')).toEqual([]);
  expect(records(config, 'residentModelBindings')).toEqual([]);
  expect(records(config, 'worlds')[0].players).toEqual([]);
  expect(records(config, 'worlds')[0].agents).toEqual([]);
  expect(records(config, 'modelSettings')[0].mainChatProfileId).toBe(f.chatProfileId);
  const selected = await exportArchive(f, { scope: 'agents-selected', agentGlobalIds: f.globals });
  expect(records(selected, 'memories')).toHaveLength(4);
  expect(selected.manifest.selection.owners).toHaveLength(2);
});
test('history archives include only selected conversations in interval and bounded message context', async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    await ctx.db.insert('archivedConversations', {
      worldId: f.worldId,
      id: 'c:1',
      creator: 'p:0',
      created: 100,
      ended: 200,
      numMessages: 1,
      participants: ['p:0', 'p:1'],
    });
    await ctx.db.insert('messages', {
      worldId: f.worldId,
      conversationId: 'c:1',
      messageUuid: 'msg:1',
      author: 'p:1',
      text: 'Shared conversation',
    });
    await ctx.db.insert('participatedTogether', {
      worldId: f.worldId,
      conversationId: 'c:1',
      player1: 'p:0',
      player2: 'p:1',
      ended: 200,
    });
    await ctx.db.insert('archivedConversations', {
      worldId: f.worldId,
      id: 'c:2',
      creator: 'p:1',
      created: 100,
      ended: 200,
      numMessages: 1,
      participants: ['p:1'],
    });
    await ctx.db.insert('messages', {
      worldId: f.worldId,
      conversationId: 'c:2',
      messageUuid: 'msg:2',
      author: 'p:1',
      text: 'Private conversation not involving selected owner',
    });
  });
  const archive = await exportArchive(f, {
    scope: 'history',
    categories: ['conversation', 'social'],
    from: 100,
    to: 300,
  });
  expect(records(archive, 'archivedConversations').map((r) => r.id)).toEqual(['c:1']);
  expect(records(archive, 'participatedTogether')).toHaveLength(1);
  expect(records(archive, 'memories')).toEqual([]);
  expect(JSON.stringify(archive)).not.toContain('Private conversation');
});
test('failed jobs resume at existing checkpoint and wrong APIs cannot process selective jobs', async () => {
  const f = await fixture();
  const { jobId } = await f.t.mutation(m('startExport'), {
    adminToken,
    scope: 'agent-one',
    agentGlobalIds: [f.globals[0]],
    categories: ['travel'],
    operator: 'admin',
    reason: 'checkpoint',
  });
  await expect(
    f.t.action(makeFunctionReference<'action'>('federation/backupLarge:advanceExport'), {
      adminToken,
      jobId,
    }),
  ).rejects.toThrow('SELECTIVE_ARCHIVE_USE_SELECTIVE_API');
  await expect(
    f.t.mutation(makeFunctionReference<'mutation'>('federation/backupLarge:cancel'), {
      adminToken,
      jobId,
    }),
  ).rejects.toThrow('SELECTIVE_ARCHIVE_USE_SELECTIVE_API');
  await expect(
    f.t.mutation(makeFunctionReference<'mutation'>('federation/backupLarge:resume'), {
      adminToken,
      jobId,
    }),
  ).rejects.toThrow('SELECTIVE_ARCHIVE_USE_SELECTIVE_API');
  await f.t.action(a('advanceExport'), { adminToken, jobId });
  const before = await f.t.query(q('status'), { adminToken, jobId });
  await f.t.mutation(m('fail'), { jobId, error: 'Transient test error' });
  await f.t.mutation(m('resume'), { adminToken, jobId });
  await drive(f.t, jobId);
  const after = await f.t.query(q('status'), { adminToken, jobId });
  expect(after.recordCount).toBeGreaterThanOrEqual(before.recordCount);
  await expect(f.t.action(a('getManifest'), { adminToken: 'unauthorized', jobId })).rejects.toThrow(
    'ADMIN_UNAUTHORIZED',
  );
});
test('selective read-only archives never enter ordinary import and cancellation releases the lock', async () => {
  const f = await fixture();
  const archive = await exportArchive(f);
  await expect(
    validateBundle({ manifest: archive.manifest, signature: archive.signature }),
  ).rejects.toThrow('UNSUPPORTED_BACKUP_MANIFEST');
  const { jobId } = await f.t.mutation(m('startExport'), {
    adminToken,
    scope: 'history',
    agentGlobalIds: [f.globals[0]],
    categories: ['travel'],
    operator: 'admin',
    reason: 'cancel',
  });
  await f.t.mutation(m('cancel'), { adminToken, jobId });
  expect((await f.t.query(q('status'), { adminToken, jobId })).state).toBe('CANCELLED');
  expect(await f.t.query(async (ctx) => ctx.db.query('backupMaintenanceLocks').first())).toBeNull();
  await expect(f.t.action(a('getChunk'), { adminToken, jobId, index: 0 })).rejects.toThrow(
    'BACKUP_MANIFEST_NOT_READY',
  );
});
test('live committed messages retain public conversation mappings without unrelated live conversations or private memories', async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.worldId, {
      conversations: [
        {
          id: 'c:1',
          creator: 'p:0',
          created: 1,
          numMessages: 1,
          isTyping: { playerId: 'p:0', messageUuid: 'typing:1', since: 1 },
          participants: [
            { playerId: 'p:0', invited: 1, status: { kind: 'participating', started: 1 } },
            { playerId: 'p:1', invited: 1, status: { kind: 'participating', started: 1 } },
          ],
        },
        {
          id: 'c:2',
          creator: 'p:1',
          created: 1,
          numMessages: 1,
          participants: [
            { playerId: 'p:1', invited: 1, status: { kind: 'participating', started: 1 } },
          ],
        },
      ],
    });
    await ctx.db.insert('messages', {
      worldId: f.worldId,
      conversationId: 'c:1',
      messageUuid: 'msg:1',
      author: 'p:1',
      text: 'Live committed conversation',
    });
    await ctx.db.insert('messages', {
      worldId: f.worldId,
      conversationId: 'c:2',
      messageUuid: 'msg:2',
      author: 'p:1',
      text: 'Excluded unrelated live conversation',
    });
  });
  const archive = await exportArchive(f, { scope: 'history', categories: ['conversation'] });
  expect(records(archive, 'messages').map((row) => row.text)).toEqual([
    'Live committed conversation',
  ]);
  const message = archive.chunks
    .filter((c) => c.table === 'messages')
    .flatMap((c) => c.rows.map(decodeRow))[0];
  expect(message.conversationContext).toMatchObject({
    id: 'c:1',
    source: 'live',
    participants: ['p:0', 'p:1'],
  });
  expect(message.publicParticipants).toContainEqual({
    worldId: f.worldId,
    playerId: 'p:1',
    agentGlobalId: f.globals[1],
    homeTownId: 'town:selective',
    name: 'Resident 1',
  });
  expect(JSON.stringify(archive)).not.toMatch(
    /Excluded unrelated|isTyping|typing:1|Other owner PRIVATE/,
  );
  for (const [i, chunk] of archive.chunks.entries())
    await validateSelectiveChunk(chunk, archive.manifest.chunks[i]);
});
test('multiple selected residents still cannot expand evidence into another owner outside the primary filters', async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.memories[1], {
      data: { type: 'reflection', relatedMemoryIds: [f.secretMemory] },
    });
    await ctx.db.patch(f.secretMemory, {
      data: {
        type: 'travel',
        eventId: 'private:1',
        visitId: 'private:visit',
        hostTownId: 'town:host',
        participants: [],
        occurredAt: 1,
      },
    });
  });
  const archive = await exportArchive(f, {
    scope: 'memories-only',
    agentGlobalIds: f.globals,
    categories: ['reflection'],
  });
  expect(records(archive, 'memories')).toHaveLength(1);
  expect(JSON.stringify(archive)).not.toContain('Other owner PRIVATE');
  expect(
    archive.chunks
      .filter((c) => c.table === 'referenceMappings')
      .flatMap((c) => c.rows.map(decodeRow)),
  ).toContainEqual({
    kind: 'external-reference',
    sourceId: f.secretMemory,
    table: 'memories',
    reason: 'PRIVATE_OWNER_EXCLUDED',
  });
});
test('same-owner closure can authorize evidence after an earlier cross-owner reference', async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.memories[1], {
      data: { type: 'reflection', relatedMemoryIds: [f.secretMemory] },
    });
    await ctx.db.patch(f.secretMemory, {
      data: {
        type: 'travel',
        eventId: 'own:travel',
        visitId: 'own:visit',
        hostTownId: 'town:host',
        participants: [],
        occurredAt: 1,
      },
    });
    const relationship = await ctx.db.insert('memories', {
      worldId: f.worldId,
      playerId: 'p:1',
      agentGlobalId: f.globals[1],
      description: 'Same owner intermediate evidence',
      importance: 1,
      lastAccess: 1,
      data: { type: 'relationship', evidenceMemoryIds: [f.secretMemory] },
    });
    await ctx.db.insert('memories', {
      worldId: f.worldId,
      playerId: 'p:1',
      agentGlobalId: f.globals[1],
      description: 'Second owner primary reflection',
      importance: 1,
      lastAccess: 1,
      data: { type: 'reflection', relatedMemoryIds: [relationship] },
    });
  });
  const archive = await exportArchive(f, {
    scope: 'memories-only',
    agentGlobalIds: f.globals,
    categories: ['reflection'],
  });
  expect(records(archive, 'memories')).toHaveLength(4);
  expect(records(archive, 'memories').find((row) => row._id === f.secretMemory)?.role).toBe(
    'dependency',
  );
  expect(
    archive.chunks
      .filter((c) => c.table === 'referenceMappings')
      .flatMap((c) => c.rows.map(decodeRow))
      .some((row) => row.sourceId === f.secretMemory),
  ).toBe(false);
});
test('malformed roles, unknown reference tables and empty external references fail even with recomputed digests', async () => {
  const validRecord = encodeRow({
    _id: 'memory:1',
    _creationTime: 1,
    playerId: 'p:0',
    description: 'Valid canonical memory',
    importance: 1,
    lastAccess: 1,
    data: { type: 'reflection', relatedMemoryIds: [] },
  });
  const invalid = [
    {
      table: 'memories',
      row: {
        kind: 'record',
        role: 'restore',
        record: validRecord,
        references: [],
      },
    },
    {
      table: 'memories',
      row: {
        kind: 'record',
        role: 'primary',
        record: validRecord,
        references: [{ id: 'id:1', table: 'unknown' }],
      },
    },
    {
      table: 'memories',
      row: {
        kind: 'record',
        role: 'primary',
        record: encodeRow({ _id: 'memory:1', _creationTime: 1 }),
        references: [],
      },
    },
    {
      table: 'memories',
      row: {
        kind: 'record',
        role: 'primary',
        record: validRecord,
        references: [{ id: 'id:1', table: 'memories', unrecognized: 'extra' }],
      },
    },
    {
      table: 'memories',
      row: {
        kind: 'record',
        role: 'primary',
        record: validRecord,
        references: [],
        unrecognized: 'extra',
      },
    },
    {
      table: 'referenceMappings',
      row: { kind: 'external-reference', sourceId: '', table: '', reason: 'SOURCE_MISSING' },
    },
  ];
  for (const entry of invalid) {
    const chunk: LargeChunk = { index: 0, table: entry.table, rows: [encodeRow(entry.row)] };
    await expect(validateSelectiveChunk(chunk, await descriptor(chunk))).rejects.toThrow(
      'INVALID_SELECTIVE_RECORD',
    );
  }
});
