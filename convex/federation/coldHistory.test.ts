import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { createIdentityKeys, digest } from './security';
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/coldHistory.ts': () => import('./coldHistory'),
};
const token = 'cold-history-test-admin-token';
const query = (name: string) => makeFunctionReference<'query'>(`federation/coldHistory:${name}`);
const action = (name: string) => makeFunctionReference<'action'>(`federation/coldHistory:${name}`);
const mutation = (name: string) =>
  makeFunctionReference<'mutation'>(`federation/coldHistory:${name}`);
beforeEach(() => {
  process.env.FEDERATION_ADMIN_TOKEN = token;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = btoa('12345678901234567890123456789012');
});
afterEach(() => {
  delete process.env.FEDERATION_ADMIN_TOKEN;
  delete process.env.FEDERATION_KEY_ENCRYPTION_KEY;
});
async function fixture() {
  const t = convexTest(schema, modules),
    keys = await createIdentityKeys();
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert('federationIdentity', {
      ...keys,
      townId: 'original-town',
      townName: 'Original',
      deploymentInstanceId: 'instance',
      deploymentEpoch: 1,
      endpoint: 'https://original.example/federation/v1',
      enabled: true,
      allowIncomingPairRequests: false,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 1,
      maxVisitDurationMs: 300000,
      mode: 'ACTIVE',
      createdAt: 1,
    });
    const worldId = await ctx.db.insert('worlds', {
      nextId: 5,
      players: [],
      agents: [],
      conversations: [],
    });
    const profileId = await ctx.db.insert('chatProfiles', {
      name: 'brain',
      provider: 'ollama',
      url: 'http://localhost:11434',
      model: 'qwen3.5:4b',
      stopWords: [],
      createdAt: 1,
    });
    await ctx.db.insert('residentModelBindings', {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'original-town/ava',
      chatProfileId: profileId,
      createdAt: 1,
      updatedAt: 1,
    });
    const memoryId = await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'original-town/ava',
      description: 'A long-ago conversation about a red scarf',
      importance: 5,
      lastAccess: 1,
      data: { type: 'conversation', conversationId: 'c:1', playerIds: ['p:1'] },
    });
    await ctx.db.insert('archivedConversations', {
      worldId,
      id: 'c:1',
      creator: 'p:0',
      created: 1,
      ended: 2,
      numMessages: 3,
      participants: ['p:0', 'p:1'],
    });
    for (let i = 0; i < 3; i++)
      await ctx.db.insert('messages', {
        worldId,
        conversationId: 'c:1',
        author: i % 2 ? 'p:0' : 'p:1',
        messageUuid: `uuid-${i}`,
        text: `原始消息 ${i} <script> is plain text`,
      });
    return { worldId, memoryId };
  });
  const owner = { ...ids, playerId: 'p:0', agentGlobalId: 'original-town/ava', adminToken: token };
  return { t, owner };
}
test('publishes a signed private file only after read-back verification; preserves original hot data and pages exact source', async () => {
  const { t, owner } = await fixture();
  const before = await t.run((ctx) => ctx.db.query('messages').collect());
  expect(await t.query(query('discover'), owner)).toBeNull();
  const result = await t.action(action('archive'), owner);
  expect(result.state).toBe('VERIFIED');
  const found = await t.query(query('discover'), owner);
  expect(found.hotRecordsRetained).toBe(true);
  expect(found.location).toBe('PRIVATE_FILE_STORAGE');
  expect(await t.run((ctx) => ctx.db.query('messages').collect())).toEqual(before);
  const first = await t.action(action('read'), { ...owner, offset: 0, numItems: 2 });
  const last = await t.action(action('read'), { ...owner, offset: first.nextOffset, numItems: 2 });
  expect([...first.page, ...last.page]).toEqual(
    before.map((r) => ({
      messageId: r.messageUuid,
      text: r.text,
      authorPlayerId: r.author,
      occurredAt: r._creationTime,
    })),
  );
  expect(first.isDone).toBe(false);
  expect(last.isDone).toBe(true);
  const again = await t.action(action('archive'), owner);
  expect(again.archiveId).toBe(result.archiveId);
  expect(await t.run((ctx) => ctx.db.query('coldHistoryArchives').collect())).toHaveLength(1);
  // Simulated hot-record loss is confined to this test: cold reads remain available.
  await t.run(async (ctx) => {
    for (const r of await ctx.db.query('messages').collect()) await ctx.db.delete(r._id);
  });
  expect((await t.action(action('read'), { ...owner, offset: 0, numItems: 25 })).page).toHaveLength(
    3,
  );
});
test('rejects unauthorized owners, active/missing source, incomplete history and invalid pages', async () => {
  const { t, owner } = await fixture();
  for (const call of [
    (a: any) => t.query(query('discover'), a),
    (a: any) => t.action(action('archive'), a),
    (a: any) => t.action(action('read'), { ...a, offset: 0, numItems: 10 }),
  ]) {
    await expect(call({ ...owner, adminToken: 'wrong' })).rejects.toThrow('ADMIN_UNAUTHORIZED');
    await expect(call({ ...owner, agentGlobalId: 'namesake' })).rejects.toThrow(
      'SOCIAL_HISTORY_OWNER_MISMATCH',
    );
  }
  for (const offset of [-1, 0.5])
    await expect(t.action(action('read'), { ...owner, offset, numItems: 10 })).rejects.toThrow(
      'INVALID_COLD_HISTORY_PAGE',
    );
  await t.run(async (ctx) => {
    const rows = await ctx.db.query('messages').collect();
    await ctx.db.delete(rows[0]._id);
  });
  await expect(t.action(action('archive'), owner)).rejects.toThrow(
    'COLD_HISTORY_INCOMPLETE_MESSAGES',
  );
  expect(await t.run((ctx) => ctx.db.query('coldHistoryArchives').collect())).toHaveLength(0);
  await t.run(async (ctx) => {
    const archived = await ctx.db.query('archivedConversations').first();
    await ctx.db.delete(archived!._id);
  });
  expect((await t.query(query('discover'), owner)).state).toBe('UNAVAILABLE');
  await expect(t.action(action('archive'), owner)).rejects.toThrow('COLD_HISTORY_NOT_COMPLETED');
});
test('tampered file, missing file and forged signed manifest fail closed without replacing hot records', async () => {
  const { t, owner } = await fixture();
  await t.action(action('archive'), owner);
  const before = await t.run((ctx) => ctx.db.query('messages').collect());
  const stored = await t.run((ctx) => ctx.db.query('coldHistoryArchives').first());
  await t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob(['{}']));
    await ctx.db.patch(stored!._id, { storageId: id });
  });
  await expect(t.action(action('read'), { ...owner, offset: 0, numItems: 25 })).rejects.toThrow(
    'COLD_HISTORY_BYTES_MISMATCH',
  );
  await t.run(async (ctx) => {
    await ctx.db.patch(stored!._id, { storageId: stored!.storageId, signature: 'forged' });
  });
  await expect(t.action(action('read'), { ...owner, offset: 0, numItems: 25 })).rejects.toThrow(
    'COLD_HISTORY_INTEGRITY_FAILED',
  );
  await t.run(async (ctx) => {
    await ctx.db.patch(stored!._id, { signature: stored!.signature });
    await ctx.storage.delete(stored!.storageId!);
  });
  await expect(t.action(action('read'), { ...owner, offset: 0, numItems: 25 })).rejects.toThrow(
    'COLD_HISTORY_STORAGE_MISSING',
  );
  expect(await t.run((ctx) => ctx.db.query('messages').collect())).toEqual(before);
});
test('source changes before publication leave a retryable pending archive and every hot message intact', async () => {
  const { t, owner } = await fixture();
  const snapshot = await t.query(query('capture'), owner);
  const payload = {
    format: 'ai-town-cold-history',
    version: 1,
    sourceKey: snapshot.source.sourceKey,
    messages: snapshot.messages,
  };
  const manifest = {
    format: payload.format,
    version: 1,
    schemaVersion: 1,
    sourceTownId: 'original-town',
    sourceKey: payload.sourceKey,
    kind: 'conversation',
    sourceId: 'c:1',
    exportedAt: 1,
    count: 3,
    bytes: JSON.stringify(payload).length,
    digest: await digest(payload),
  };
  const pending = await t.mutation(mutation('reserve'), { ...owner, manifest });
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([JSON.stringify(payload)])));
  await t.run(async (ctx) => {
    const row = await ctx.db.query('messages').first();
    await ctx.db.patch(row!._id, { text: 'corrected original' });
  });
  await expect(
    t.mutation(mutation('publish'), {
      ...owner,
      archiveId: pending._id,
      storageId,
      contentDigest: manifest.digest,
    }),
  ).rejects.toThrow('COLD_HISTORY_SOURCE_CHANGED');
  expect((await t.query(query('discover'), owner)).state).toBe('PENDING');
  expect(await t.run((ctx) => ctx.db.query('messages').collect())).toHaveLength(3);
  expect((await t.action(action('archive'), owner)).state).toBe('VERIFIED');
  expect((await t.action(action('read'), { ...owner, offset: 0, numItems: 25 })).page[0].text).toBe(
    'corrected original',
  );
});
test('complete Home transcripts preserve original global authors and reject missing pages', async () => {
  const { t, owner } = await fixture();
  const travelId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('memories', {
      worldId: owner.worldId,
      playerId: 'p:0',
      agentGlobalId: owner.agentGlobalId,
      description: 'Confirmed journey',
      importance: 5,
      lastAccess: 1,
      data: {
        type: 'travel',
        eventId: 'end',
        visitId: 'visit',
        hostTownId: 'host',
        occurredAt: 1,
        participants: [],
        federationConversationId: 'conversation',
      },
    });
    await ctx.db.insert('homeTravelTranscripts', {
      worldId: owner.worldId,
      playerId: 'p:0',
      agentGlobalId: owner.agentGlobalId,
      transcriptId: 'conversation/visit',
      visitId: 'visit',
      hostTownId: 'host',
      federationConversationId: 'conversation',
      endedAt: 2,
      participants: [],
      finalPageNumber: 1,
      receivedPageCount: 2,
      highestPageNumber: 1,
      totalMessageCount: 2,
      state: 'COMPLETE',
      summaryState: 'DONE',
    });
    for (let i = 0; i < 2; i++)
      await ctx.db.insert('homeTravelTranscriptPages', {
        agentGlobalId: owner.agentGlobalId,
        transcriptId: 'conversation/visit',
        pageNumber: i,
        eventId: `page-${i}`,
        finalPage: i === 1,
        memoryIds: [],
        messages: [
          {
            messageId: `remote-${i}`,
            text: `Original ${i}`,
            author: i ? 'host/bob' : owner.agentGlobalId,
            occurredAt: i + 1,
          },
        ],
      });
    return id;
  });
  const args = { ...owner, memoryId: travelId };
  const lastPage = await t.run(async (ctx) => {
    const pages = await ctx.db.query('homeTravelTranscriptPages').collect();
    const last = pages.find((p) => p.pageNumber === 1)!;
    await ctx.db.delete(last._id);
    return last;
  });
  await expect(t.action(action('archive'), args)).rejects.toThrow('COLD_HISTORY_INCOMPLETE_PAGES');
  await t.run((ctx) => {
    const { _id, _creationTime, ...fields } = lastPage;
    return ctx.db.insert('homeTravelTranscriptPages', fields);
  });
  await t.action(action('archive'), args);
  expect(
    (await t.action(action('read'), { ...args, offset: 0, numItems: 25 })).page.map(
      (m: any) => m.authorGlobalId,
    ),
  ).toEqual([owner.agentGlobalId, 'host/bob']);
});

test('oversized and duplicate retained sources fail before publication and preserve every hot row', async () => {
  const { t, owner } = await fixture();
  await t.run(async (ctx) => {
    for (const r of await ctx.db.query('messages').collect()) await ctx.db.delete(r._id);
    const conversation = await ctx.db.query('archivedConversations').first();
    await ctx.db.patch(conversation!._id, { numMessages: 2 });
    for (let i = 0; i < 2; i++)
      await ctx.db.insert('messages', {
        worldId: owner.worldId,
        conversationId: 'c:1',
        author: 'p:0',
        messageUuid: `large-${i}`,
        text: 'x'.repeat(450000),
      });
  });
  await expect(t.action(action('archive'), owner)).rejects.toThrow(
    'COLD_HISTORY_REQUIRES_CHUNKED_ARCHIVE',
  );
  expect(await t.run((ctx) => ctx.db.query('coldHistoryArchives').collect())).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query('messages').collect())).toHaveLength(2);
  await t.run(async (ctx) => {
    for (const r of await ctx.db.query('messages').collect())
      await ctx.db.patch(r._id, { text: 'small', messageUuid: 'duplicate' });
  });
  await expect(t.action(action('archive'), owner)).rejects.toThrow(
    'COLD_HISTORY_EMPTY_OR_DUPLICATE_MESSAGES',
  );
  expect(await t.run((ctx) => ctx.db.query('messages').collect())).toHaveLength(2);
});

test('retains native text persisted before a finish-sending Tick rather than truncating to the game counter', async () => {
  const { t, owner } = await fixture();
  await t.run((ctx) =>
    ctx.db.insert('messages', {
      worldId: owner.worldId,
      conversationId: 'c:1',
      author: 'p:0',
      messageUuid: 'persisted-before-last-tick',
      text: 'Last retained original',
    }),
  );
  const result = await t.action(action('archive'), owner);
  expect(result.count).toBe(4);
  expect((await t.action(action('read'), { ...owner, offset: 0, numItems: 25 })).page[3].text).toBe(
    'Last retained original',
  );
});
