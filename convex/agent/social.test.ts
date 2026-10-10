import { convexTest } from 'convex-test';
import { makeFunctionReference, type ApiFromModules, type FunctionReturnType } from 'convex/server';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import type * as social from './social';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../agent/social.ts': () => import('./social'),
};
type SocialApi = ApiFromModules<{ social: typeof social }>['social'];
const ref = <Name extends keyof SocialApi>(name: Name) =>
  makeFunctionReference<'query'>(`agent/social:${name}`) as SocialApi[Name];
const token = 'social-history-test-admin-token';
beforeEach(() => {
  process.env.FEDERATION_ADMIN_TOKEN = token;
});
afterEach(() => {
  delete process.env.FEDERATION_ADMIN_TOKEN;
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const world = { nextId: 1, players: [], agents: [], conversations: [] };
    const worldId = await ctx.db.insert('worlds', world);
    const otherWorldId = await ctx.db.insert('worlds', world);
    const chatProfileId = await ctx.db.insert('chatProfiles', {
      name: 'Original brain',
      provider: 'custom',
      url: 'https://chat.example',
      model: 'original',
      stopWords: [],
      createdAt: 1,
    });
    for (const [id, agentGlobalId] of [
      [worldId, 'home/ava'],
      [otherWorldId, 'other/ava'],
    ] as const)
      await ctx.db.insert('residentModelBindings', {
        worldId: id,
        playerId: 'p:0',
        agentGlobalId,
        chatProfileId,
        createdAt: 1,
        updatedAt: 1,
      });
    return { worldId, otherWorldId };
  });
  return {
    t,
    ...ids,
    owner: { adminToken: token, worldId: ids.worldId, playerId: 'p:0', agentGlobalId: 'home/ava' },
  };
}

test('administrator and exact resident world/global identity are required on every endpoint', async () => {
  const { t, owner, otherWorldId } = await setup();
  const memoryId = await t.run((ctx) =>
    ctx.db.insert('memories', {
      ...ownerFields(owner),
      description: 'Private',
      importance: 5,
      lastAccess: 1,
      data: { type: 'reflection', relatedMemoryIds: [] },
    }),
  );
  type Override = Partial<typeof owner>;
  const args = { ...owner, cursor: null, numItems: 10 };
  const queries = [
    (override: Override) => t.query(ref('history'), { ...args, ...override }),
    (override: Override) => t.query(ref('relationships'), { ...args, ...override }),
    (override: Override) => t.query(ref('evidence'), { ...args, memoryId, ...override }),
    (override: Override) => t.query(ref('conversationSource'), { ...args, memoryId, ...override }),
    (override: Override) =>
      t.query(ref('transcriptSource'), { ...owner, memoryId, pageNumber: 0, ...override }),
  ];
  for (const query of queries) {
    await expect(query({ adminToken: 'wrong' })).rejects.toThrow('ADMIN_UNAUTHORIZED');
    await expect(query({ worldId: otherWorldId })).rejects.toThrow('SOCIAL_HISTORY_OWNER_MISMATCH');
    await expect(query({ agentGlobalId: 'home/namesake' })).rejects.toThrow(
      'SOCIAL_HISTORY_OWNER_MISMATCH',
    );
  }
});

function ownerFields(owner: { worldId: Id<'worlds'>; playerId: string; agentGlobalId: string }) {
  return { worldId: owner.worldId, playerId: owner.playerId, agentGlobalId: owner.agentGlobalId };
}

test('history reaches facts older than 500 records and keeps namesakes and owners separate', async () => {
  const { t, owner, otherWorldId } = await setup();
  const oldest = await t.run(async (ctx) => {
    let first: Id<'memories'> | undefined;
    for (let i = 0; i < 521; i++) {
      const id = await ctx.db.insert('memories', {
        ...ownerFields(owner),
        description: i === 0 ? 'Old red scarf' : `Fact ${i}`,
        importance: 5,
        lastAccess: 1,
        data: {
          type: 'travel',
          eventId: `event:${i}`,
          visitId: 'visit',
          hostTownId: 'town-a',
          occurredAt: i,
          participants: [{ name: 'Bea', homeTownId: 'town-a', agentGlobalId: 'town-a/bea' }],
        },
      });
      first ??= id;
    }
    for (const scope of [
      { worldId: otherWorldId },
      { playerId: 'p:1' },
      { agentGlobalId: 'home/wrong' },
    ])
      await ctx.db.insert('memories', {
        ...ownerFields(owner),
        ...scope,
        description: 'Old red scarf foreign',
        importance: 5,
        lastAccess: 1,
        data: { type: 'reflection', relatedMemoryIds: [] },
      });
    await ctx.db.insert('memories', {
      ...ownerFields(owner),
      description: 'Other Bea red scarf',
      importance: 5,
      lastAccess: 1,
      data: {
        type: 'travel',
        eventId: 'namesake',
        visitId: 'visit',
        hostTownId: 'town-b',
        occurredAt: 1,
        participants: [{ name: 'Bea', homeTownId: 'town-b', agentGlobalId: 'town-b/bea' }],
      },
    });
    return first!;
  });
  let cursor: string | null = null;
  const matched: string[] = [];
  let pages = 0;
  do {
    const result: FunctionReturnType<SocialApi['history']> = await t.query(ref('history'), {
      ...owner,
      cursor,
      numItems: 25,
      text: 'red scarf',
      participantGlobalId: 'town-a/bea',
    });
    matched.push(...result.page.map((m) => m.memoryId));
    pages++;
    if (result.isDone) break;
    expect(result.continueCursor).not.toBe(cursor);
    cursor = result.continueCursor;
  } while (pages < 30);
  expect(matched).toEqual([oldest]);
  expect(pages).toBeGreaterThan(20);
  const namesake = await t.query(ref('history'), {
    ...owner,
    cursor: null,
    numItems: 25,
    participantGlobalId: 'town-b/bea',
  });
  expect(namesake.page.map((m) => m.description)).toEqual(['Other Bea red scarf']);
});

test('cursors reject different residents, filters, query kinds and invalid limits', async () => {
  const { t, owner, otherWorldId } = await setup();
  const page = await t.query(ref('history'), { ...owner, cursor: null, numItems: 1 });
  for (const args of [
    { text: 'changed' },
    { participantGlobalId: 'town-b/bea' },
    { kind: 'travel' as const },
    { worldId: otherWorldId, agentGlobalId: 'other/ava' },
  ])
    await expect(
      t.query(ref('history'), { ...owner, cursor: page.continueCursor, numItems: 1, ...args }),
    ).rejects.toThrow('SOCIAL_CURSOR_SCOPE_MISMATCH');
  await expect(
    t.query(ref('relationships'), { ...owner, cursor: page.continueCursor, numItems: 1 }),
  ).rejects.toThrow('SOCIAL_CURSOR_SCOPE_MISMATCH');
  for (const numItems of [0, -1, 1.5, 26])
    await expect(t.query(ref('history'), { ...owner, cursor: null, numItems })).rejects.toThrow(
      'INVALID_SOCIAL_PAGE_SIZE',
    );
});

test('namesake relationship edges remain distinct and typed history orders by recorded time', async () => {
  const { t, owner } = await setup();
  await t.run(async (ctx) => {
    for (const agentGlobalId of ['town-z/bea', 'town-a/bea']) {
      await ctx.db.insert('memories', {
        ...ownerFields(owner),
        description: `I met Bea (${agentGlobalId}).`,
        importance: 5,
        lastAccess: 1,
        data: {
          type: 'relationship',
          agentGlobalId,
          homeTownId: agentGlobalId.split('/')[0],
          encounterCount: 1,
          firstMetAt: 1,
          lastMetAt: 1,
          evidenceMemoryIds: [],
        },
      });
    }
  });
  const first = await t.query(ref('relationships'), { ...owner, cursor: null, numItems: 1 });
  const next = await t.query(ref('relationships'), {
    ...owner,
    cursor: first.continueCursor,
    numItems: 1,
  });
  expect(first.page[0].data.type === 'relationship' && first.page[0].data.agentGlobalId).toBe(
    'town-a/bea',
  );
  expect(next.page[0].data.type === 'relationship' && next.page[0].data.agentGlobalId).toBe(
    'town-z/bea',
  );
  const timeline = await t.query(ref('history'), {
    ...owner,
    cursor: null,
    numItems: 10,
    kind: 'relationship',
  });
  expect(
    timeline.page.map((memory) => memory.data.type === 'relationship' && memory.data.agentGlobalId),
  ).toEqual(['town-a/bea', 'town-z/bea']);
});

test('relationship citations deduplicate IDs, page all evidence and explicitly hide missing or foreign sources', async () => {
  const { t, owner, otherWorldId } = await setup();
  const ids = await t.run(async (ctx) => {
    const add = (globalId: string, overrides = {}) =>
      ctx.db.insert('memories', {
        ...ownerFields(owner),
        ...overrides,
        description: 'Private source',
        importance: 5,
        lastAccess: 1,
        data: {
          type: 'conversation' as const,
          conversationId: 'c:1',
          playerIds: ['p:7'],
          participants: [
            { name: 'Bea', agentGlobalId: globalId, homeTownId: globalId.split('/')[0] },
          ],
        },
      });
    const first = await add('town-a/bea');
    const second = await add('town-a/bea');
    const foreign = await add('town-a/bea', { worldId: otherWorldId });
    const foreignGlobalOwner = await add('town-a/bea', { agentGlobalId: 'home/another-resident' });
    const namesake = await add('town-b/bea');
    const missing = await add('town-a/bea');
    await ctx.db.delete(missing);
    const relationship = await ctx.db.insert('memories', {
      ...ownerFields(owner),
      description: 'Two confirmed encounters',
      importance: 5,
      lastAccess: 1,
      data: {
        type: 'relationship',
        agentGlobalId: 'town-a/bea',
        homeTownId: 'town-a',
        encounterCount: 2,
        firstMetAt: 1,
        lastMetAt: 2,
        evidenceMemoryIds: [first, first, second, foreign, foreignGlobalOwner, namesake, missing],
      },
    });
    return { relationship, first, second, foreign, foreignGlobalOwner, namesake, missing };
  });
  const edges = await t.query(ref('relationships'), { ...owner, cursor: null, numItems: 10 });
  expect(edges.page[0].data.type).toBe('relationship');
  expect(edges.page[0].data.type === 'relationship' && edges.page[0].data.encounterCount).toBe(2);
  expect(edges.page[0].data).not.toHaveProperty('affinity');
  let cursor: string | null = null;
  const sources: Array<FunctionReturnType<SocialApi['evidence']>['page'][number]> = [];
  while (true) {
    const result: FunctionReturnType<SocialApi['evidence']> = await t.query(ref('evidence'), {
      ...owner,
      memoryId: ids.relationship,
      cursor,
      numItems: 2,
    });
    sources.push(...result.page);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  expect(sources.map((s) => s.memoryId)).toEqual([
    ids.first,
    ids.second,
    ids.foreign,
    ids.foreignGlobalOwner,
    ids.namesake,
    ids.missing,
  ]);
  expect(sources.map((s) => s.status)).toEqual([
    'AVAILABLE',
    'AVAILABLE',
    'OWNER_MISMATCH',
    'OWNER_MISMATCH',
    'PARTICIPANT_MISMATCH',
    'MISSING_SOURCE',
  ]);
  expect(sources.slice(2).every((s) => s.memory === null)).toBe(true);
  await expect(
    t.query(ref('evidence'), { ...owner, memoryId: ids.foreign, cursor: null, numItems: 10 }),
  ).rejects.toThrow('SOCIAL_HISTORY_EVIDENCE_OWNER_MISMATCH');
});

test('Home transcript citations resolve end events, expose missing pages, and reject foreign transcript metadata', async () => {
  const { t, owner, otherWorldId } = await setup();
  const ids = await t.run(async (ctx) => {
    const memoryId = await ctx.db.insert('memories', {
      ...ownerFields(owner),
      description: 'Conversation ended',
      importance: 5,
      lastAccess: 1,
      data: {
        type: 'travel',
        eventId: 'end',
        visitId: 'visit',
        hostTownId: 'host',
        occurredAt: 100,
        federationConversationId: 'host/world/c:1',
        participants: [{ name: 'Bea', homeTownId: 'host', agentGlobalId: 'host/bea' }],
      },
    });
    const transcriptId = 'host/world/c:1/visit';
    const transcriptDocId = await ctx.db.insert('homeTravelTranscripts', {
      ...ownerFields(owner),
      transcriptId,
      visitId: 'visit',
      hostTownId: 'host',
      federationConversationId: 'host/world/c:1',
      endedAt: 100,
      participants: [
        { name: 'Ava', playerId: 'p:9', homeTownId: 'home', agentGlobalId: 'home/ava' },
        { name: 'Bea', playerId: 'p:8', homeTownId: 'host', agentGlobalId: 'host/bea' },
      ],
      finalPageNumber: 2,
      receivedPageCount: 2,
      highestPageNumber: 2,
      totalMessageCount: 2,
      state: 'RECEIVING',
      summaryState: 'PENDING',
    });
    for (const pageNumber of [0, 2])
      await ctx.db.insert('homeTravelTranscriptPages', {
        transcriptId,
        agentGlobalId: 'home/ava',
        pageNumber,
        eventId: `page:${pageNumber}`,
        finalPage: pageNumber === 2,
        memoryIds: [memoryId],
        messages: [
          {
            messageId: `message:${pageNumber}`,
            text: `Exact text ${pageNumber}`,
            author: 'p:8',
            occurredAt: pageNumber,
          },
        ],
      });
    return { memoryId, transcriptDocId };
  });
  const first = await t.query(ref('transcriptSource'), {
    ...owner,
    memoryId: ids.memoryId,
    pageNumber: 0,
  });
  expect(first.status).toBe('AVAILABLE');
  expect(first.page!.messages[0].text).toBe('Exact text 0');
  expect(first.transcript!.participants[1].agentGlobalId).toBe('host/bea');
  const gap = await t.query(ref('transcriptSource'), {
    ...owner,
    memoryId: ids.memoryId,
    pageNumber: 1,
  });
  expect(gap.status).toBe('MISSING_PAGE');
  expect(gap.page).toBeNull();
  const last = await t.query(ref('transcriptSource'), {
    ...owner,
    memoryId: ids.memoryId,
    pageNumber: 2,
  });
  expect(last.page!.messages[0].text).toBe('Exact text 2');
  await t.run((ctx) => ctx.db.patch(ids.transcriptDocId, { worldId: otherWorldId }));
  const restricted = await t.query(ref('transcriptSource'), {
    ...owner,
    memoryId: ids.memoryId,
    pageNumber: 0,
  });
  expect(restricted.status).toBe('TRANSCRIPT_OWNER_MISMATCH');
  expect(restricted.transcript).toBeNull();
  expect(restricted.page).toBeNull();
});

test('local raw messages require resident membership and paginate exact durable text', async () => {
  const { t, owner } = await setup();
  const memoryId = await t.run(async (ctx) => {
    const memoryId = await ctx.db.insert('memories', {
      ...ownerFields(owner),
      description: 'Local encounter',
      importance: 5,
      lastAccess: 1,
      data: { type: 'conversation', conversationId: 'c:1', playerIds: ['p:1'] },
    });
    await ctx.db.insert('archivedConversations', {
      worldId: owner.worldId,
      id: 'c:1',
      creator: 'p:0',
      created: 1,
      ended: 2,
      numMessages: 3,
      participants: ['p:0', 'p:1'],
    });
    for (let i = 0; i < 3; i++)
      await ctx.db.insert('messages', {
        worldId: owner.worldId,
        conversationId: 'c:1',
        author: 'p:1',
        messageUuid: `local:${i}`,
        text: `Raw ${i}`,
      });
    return memoryId;
  });
  const first = await t.query(ref('conversationSource'), {
    ...owner,
    memoryId,
    cursor: null,
    numItems: 2,
  });
  expect(first.page.map((m) => m.text)).toEqual(['Raw 0', 'Raw 1']);
  const next = await t.query(ref('conversationSource'), {
    ...owner,
    memoryId,
    cursor: first.continueCursor,
    numItems: 2,
  });
  expect(next.page.map((m) => m.text)).toEqual(['Raw 2']);
  expect(next.isDone).toBe(true);
  await t.run(async (ctx) => {
    const conversation = await ctx.db.query('archivedConversations').first();
    await ctx.db.patch(conversation!._id, { participants: ['p:1', 'p:2'] });
  });
  const restricted = await t.query(ref('conversationSource'), {
    ...owner,
    memoryId,
    cursor: null,
    numItems: 2,
  });
  expect(restricted.status).toBe('MISSING_OR_UNVERIFIED_CONVERSATION');
  expect(restricted.page).toEqual([]);
});
