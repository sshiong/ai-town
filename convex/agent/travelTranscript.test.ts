import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { receiveConversationEnded, ConversationEndedPayload } from './travelTranscript';
import { recordConfirmedObservation } from './travelMemory';
import { recallConversationMemories } from './conversation';
import { parseGameId } from '../aiTown/ids';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../agent/travelTranscript.ts': () => import('./travelTranscript'),
  '../agent/travelMemory.ts': () => import('./travelMemory'),
  '../agent/memory.ts': () => import('./memory'),
  '../agent/conversation.ts': () => import('./conversation'),
  '../agent/embeddingsCache.ts': () => import('./embeddingsCache'),
  '../models/profiles.ts': () => import('../models/profiles'),
  '../models/embeddings.ts': () => import('../models/embeddings'),
};
beforeAll(() =>
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }),
);
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const player = {
      id: 'p:0',
      lastInput: 1,
      position: { x: 1, y: 1 },
      facing: { dx: 1, dy: 0 },
      speed: 0,
    };
    const worldId = await ctx.db.insert('worlds', {
      nextId: 2,
      players: [player],
      agents: [{ id: 'a:0', playerId: 'p:0' }],
      conversations: [],
    });
    await ctx.db.insert('playerDescriptions', {
      worldId,
      playerId: 'p:0',
      name: 'Ava',
      character: 'f1',
      description: 'Astronomer',
    });
    const profileId = await ctx.db.insert('chatProfiles', {
      name: 'Fixed resident model',
      provider: 'custom',
      url: 'https://chat.example',
      model: 'resident-model',
      apiKeyEnv: 'UNAVAILABLE_TRAVEL_SUMMARY_KEY',
      stopWords: [],
      createdAt: 1,
    });
    await ctx.db.insert('residentModelBindings', {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'home/ava',
      chatProfileId: profileId,
      createdAt: 1,
      updatedAt: 1,
    });
    const visitId = await ctx.db.insert('visitLedger', {
      visitId: 'visit',
      agentGlobalId: 'home/ava',
      homeTownId: 'home',
      hostTownId: 'host',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      leaseExpiry: 2000,
      fencingToken: 'fence',
      state: 'COMPLETED',
      role: 'home',
      worldId,
      homePlayerId: 'p:0',
      profile: {},
      createdAt: 1,
      updatedAt: 1,
    });
    return { worldId, visitId, profileId };
  });
  const payload: ConversationEndedPayload = {
    eventId: 'end-page-0',
    transcriptId: 'host/conversation-1',
    federationConversationId: 'host/world/c:1',
    endedAt: 1000,
    pageNumber: 0,
    finalPage: false,
    participants: [
      { playerId: 'p:visitor', agentGlobalId: 'home/ava', name: 'Ava', homeTownId: 'home' },
      { playerId: 'p:local', agentGlobalId: 'host/bea', name: 'Bea', homeTownId: 'host' },
    ],
    messages: [
      {
        messageId: 'message-self-1',
        text: 'I like stars.',
        author: 'p:visitor',
        occurredAt: 10,
        committedEventSeq: 1,
      },
      {
        messageId: 'message-host-1',
        text: 'I have a red scarf.',
        author: 'p:local',
        occurredAt: 20,
        committedEventSeq: 2,
      },
    ],
  };
  const finalPayload = {
    ...payload,
    eventId: 'end-page-1',
    pageNumber: 1,
    finalPage: true,
    messages: [
      {
        messageId: 'message-self-2',
        text: 'Let us meet again.',
        author: 'p:visitor',
        occurredAt: 30,
        committedEventSeq: 3,
      },
    ],
  };
  const receive = (p: ConversationEndedPayload) =>
    t.run(async (ctx) => receiveConversationEnded(ctx, (await ctx.db.get(ids.visitId))!, p));
  return { t, ...ids, payload, finalPayload, receive };
}

test('the complete ordered transcript survives late return, deduplicates observed speech, and creates a global encounter once', async () => {
  const { t, worldId, payload, finalPayload, receive } = await setup();
  await t.run((ctx) =>
    recordConfirmedObservation(ctx, {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'home/ava',
      visitId: 'visit',
      hostTownId: 'host',
      observationEventId: 'obs',
      federationConversationId: payload.federationConversationId,
      observedAt: 100,
      participants: payload.participants,
      messages: payload.messages,
    }),
  );
  const transcriptId = await receive(finalPayload);
  expect((await t.run((ctx) => ctx.db.get(transcriptId)))?.state).toBe('RECEIVING');
  expect(
    await t.run((ctx) =>
      ctx.db
        .query('memories')
        .filter((q) => q.eq(q.field('data.type'), 'relationship'))
        .collect(),
    ),
  ).toEqual([]);
  await receive(payload);
  await receive(payload);
  await receive(finalPayload);
  const result = await t.run(async (ctx) => ({
    transcript: await ctx.db.get(transcriptId),
    pages: await ctx.db.query('homeTravelTranscriptPages').collect(),
    memories: await ctx.db.query('memories').collect(),
    world: await ctx.db.get(worldId),
  }));
  expect(result.transcript?.state).toBe('COMPLETE');
  expect(result.pages).toHaveLength(2);
  expect(result.memories.filter((m) => m.data.type === 'travel' && m.data.messageId)).toHaveLength(
    3,
  );
  expect(
    result.memories.some(
      (m) =>
        m.data.type === 'travel' &&
        m.data.messageText === 'I like stars.' &&
        m.data.authorGlobalId === 'home/ava',
    ),
  ).toBe(true);
  const relationship = result.memories.find((m) => m.data.type === 'relationship');
  expect(relationship?.data).toMatchObject({
    type: 'relationship',
    agentGlobalId: 'host/bea',
    homeTownId: 'host',
    encounterCount: 1,
    evidenceMemoryIds: [result.transcript?.endMemoryId],
  });
  expect(result.world?.conversations).toEqual([]);
  expect(result.world?.players.map((p) => p.id)).toEqual(['p:0']);
  const recalled = await t.query(
    makeFunctionReference<'query'>('agent/memory:participantMemories'),
    { worldId, playerId: 'p:0', agentGlobalId: 'host/bea' },
  );
  expect(
    recalled.some((m: { description: string }) => m.description.includes('confirmed conversation')),
  ).toBe(true);
  expect(
    await t.query(makeFunctionReference<'query'>('agent/memory:participantMemories'), {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'another-town/bea',
    }),
  ).toEqual([]);
});

test('missing pages never produce a completed summary or relationship, and conflicting/repeated messages roll back', async () => {
  const { t, payload, finalPayload, receive } = await setup();
  await receive(payload);
  await expect(receive({ ...finalPayload, messages: [payload.messages[0]] })).rejects.toThrow(
    'DUPLICATE_TRANSCRIPT_MESSAGE',
  );
  await expect(
    receive({ ...payload, messages: [{ ...payload.messages[0], text: 'replacement' }] }),
  ).rejects.toThrow('TRANSCRIPT_PAGE_CONFLICT');
  const transcriptId = await receive({ ...finalPayload, pageNumber: 2 });
  expect((await t.run((ctx) => ctx.db.get(transcriptId)))?.state).toBe('RECEIVING');
  expect(
    await t.mutation(makeFunctionReference<'mutation'>('agent/travelTranscript:claimSummary'), {
      transcriptDocId: transcriptId,
    }),
  ).toBeNull();
  await expect(
    receive({
      ...finalPayload,
      pageNumber: 1,
      eventId: 'page-1',
      finalPage: false,
      messages: [{ ...finalPayload.messages[0], messageId: 'new-message', committedEventSeq: 2 }],
    }),
  ).rejects.toThrow('UNORDERED_TRANSCRIPT_MESSAGES');
});

test('large committed text is retained in raw pages and facts while inference is explicitly an excerpt', async () => {
  const { t, payload, receive } = await setup();
  const text = 'long committed speech '.repeat(2000);
  const transcriptId = await receive({
    ...payload,
    finalPage: true,
    messages: [{ ...payload.messages[0], text }],
  });
  const pages = await t.run((ctx) => ctx.db.query('homeTravelTranscriptPages').collect());
  const facts = await t.run((ctx) => ctx.db.query('memories').collect());
  expect(pages[0].messages[0].text).toBe(text);
  expect(facts.find((m) => m.data.type === 'travel' && m.data.messageId)?.data).toMatchObject({
    messageText: text,
  });
  const summaryData = await t.query(
    makeFunctionReference<'query'>('agent/travelTranscript:summaryData'),
    { transcriptDocId: transcriptId },
  );
  expect(summaryData.partial).toBe(true);
  expect(summaryData.messages[0].textTruncated).toBe(true);
  expect(summaryData.messages[0].text).toHaveLength(24000);
});

test('unavailable fixed model keeps facts and failed summary retry produces one evidence-linked reflection', async () => {
  const { t, worldId, profileId, payload, receive } = await setup();
  const transcriptDocId = await receive({ ...payload, finalPage: true });
  const summarize = makeFunctionReference<'action'>('agent/travelTranscript:summarize');
  await t.action(summarize, { transcriptDocId });
  const failed = await t.run((ctx) => ctx.db.get(transcriptDocId));
  expect(failed?.summaryState).toBe('FAILED');
  expect(failed?.summaryError).toContain('MODEL_CREDENTIAL_MISSING');
  const canonicalCount = (await t.run((ctx) => ctx.db.query('memories').collect())).length;
  await t.run((ctx) => ctx.db.patch(profileId, { apiKeyEnv: undefined }));
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: 'I enjoyed talking with Bea about the stars and her red scarf.' },
            },
          ],
        }),
        { status: 200 },
      ),
    );
  await t.action(summarize, { transcriptDocId });
  await t.action(summarize, { transcriptDocId });
  const done = await t.run((ctx) => ctx.db.get(transcriptDocId));
  expect(done?.summaryState).toBe('DONE');
  const memories = await t.run((ctx) => ctx.db.query('memories').collect());
  expect(memories).toHaveLength(canonicalCount + 1);
  expect(memories.find((m) => m._id === done?.summaryMemoryId)?.data).toMatchObject({
    type: 'reflection',
    relatedMemoryIds: expect.arrayContaining([done?.endMemoryId]),
  });
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe('resident-model');
  const recalled = await t.action((ctx) =>
    recallConversationMemories(ctx, worldId, parseGameId('players', 'p:0'), 'Bea', 3, 'host/bea'),
  );
  expect(recalled.some((m) => m.data.type === 'relationship')).toBe(true);
});

test.each([
  { eventId: 12 },
  { participants: [null, null] },
  { messages: [{ messageId: 'm', text: 12, author: 'p:local', occurredAt: 1 }] },
])('malformed signed payload cannot create canonical rows: %p', async (change) => {
  const { t, payload, receive } = await setup();
  await expect(receive({ ...payload, ...change } as any)).rejects.toThrow(
    'INVALID_CONVERSATION_TRANSCRIPT',
  );
  expect(await t.run((ctx) => ctx.db.query('homeTravelTranscripts').collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query('memories').collect())).toEqual([]);
});

test('large completed history receives one bounded page at a time and keeps a deliberately bounded summary excerpt', async () => {
  const { t, payload, receive } = await setup();
  let transcriptDocId;
  for (let page = 0; page < 150; page++) {
    transcriptDocId = await receive({
      ...payload,
      eventId: `large-page-${page}`,
      pageNumber: page,
      finalPage: page === 149,
      messages: [0, 1].map((n) => ({
        messageId: `large-message-${page}-${n}`,
        text: String(page).padStart(3, '0') + 'x'.repeat(24997),
        author: n ? 'p:local' : 'p:visitor',
        occurredAt: 2 * page + n,
        committedEventSeq: 2 * page + n,
      })),
    });
  }
  const result = await t.run((ctx) => ctx.db.get(transcriptDocId!));
  expect(result).toMatchObject({
    state: 'COMPLETE',
    receivedPageCount: 150,
    totalMessageCount: 300,
  });
  const excerpt = await t.query(
    makeFunctionReference<'query'>('agent/travelTranscript:summaryData'),
    { transcriptDocId: transcriptDocId! },
  );
  expect(excerpt.totalMessages).toBe(300);
  expect(excerpt.partial).toBe(true);
  expect(excerpt.messages[0].text).toHaveLength(24000);
  const tail = await t.run((ctx) =>
    ctx.db
      .query('homeTravelTranscriptPages')
      .withIndex('owner_transcript_page', (q) =>
        q
          .eq('agentGlobalId', 'home/ava')
          .eq('transcriptId', payload.transcriptId)
          .eq('pageNumber', 149),
      )
      .unique(),
  );
  expect(tail?.messages[1].text).toHaveLength(25000);
});
