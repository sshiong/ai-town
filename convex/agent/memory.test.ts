import { convexTest } from 'convex-test';
import { jest } from '@jest/globals';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { concernsParticipant, searchMemories } from './memory';
import { recallConversationMemories } from './conversation';
import { recallHomeMemories } from '../federation/decision';
import { parseGameId } from '../aiTown/ids';
import { internal } from '../_generated/api';
import { Id } from '../_generated/dataModel';
import { ActionCtx } from '../_generated/server';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../agent/memory.ts': () => import('./memory'),
  '../agent/conversation.ts': () => import('./conversation'),
  '../agent/embeddingsCache.ts': () => import('./embeddingsCache'),
  '../models/embeddings.ts': () => import('../models/embeddings'),
  '../federation/decision.ts': () => import('../federation/decision'),
};

async function memorySearchFixture(dimensions = 2) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const world = { nextId: 1, players: [], agents: [], conversations: [] };
    const worldId = await ctx.db.insert('worlds', world);
    const otherWorldId = await ctx.db.insert('worlds', world);
    const profileId = await ctx.db.insert('embeddingProfiles', {
      name: 'Fixed embedding', provider: 'custom', url: 'https://embedding.example',
      model: 'fixed', dimensions, preprocessingRevision: 'newline-to-space-v1',
      queryPrefix: '', documentPrefix: '', normalization: 'none', fingerprint: 'fixed', createdAt: 1,
    });
    const spaceId = await ctx.db.insert('embeddingSpaces', {
      profileId, fingerprint: 'fixed', status: 'ACTIVE', createdAt: 1,
    });
    const otherSpaceId = await ctx.db.insert('embeddingSpaces', {
      profileId, fingerprint: 'other', status: 'RETIRED', createdAt: 1,
    });
    await ctx.db.insert('modelSettings', { key: 'town', activeEmbeddingSpaceId: spaceId });
    return { worldId, otherWorldId, spaceId, otherSpaceId };
  });
  return { t, ...ids };
}

test.each([{ dimensions: 2, count: 2501 }, { dimensions: 1536, count: 2051 }])(
  'full-history semantic recall searches $count vectors of $dimensions dimensions and isolates owners/spaces',
  async ({ dimensions, count }) => {
  const { t, worldId, otherWorldId, spaceId, otherSpaceId } = await memorySearchFixture(dimensions);
  const oldQuery = Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0);
  const lateQuery = Array.from({ length: dimensions }, (_, i) => i === 1 ? 1 : 0);
  const lastAccess = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const ids = await t.run(async (ctx) => {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const memoryId = await ctx.db.insert('memories', {
        worldId, playerId: 'p:0', description: i === 0 ? 'The old red scarf fact' : `Fact ${i}`,
        importance: 5, lastAccess, data: { type: 'reflection', relatedMemoryIds: [] },
      });
      await ctx.db.insert('modelMemoryVectors', {
        worldId, playerId: 'p:0', spaceId, memoryId,
        embedding: i === 0 ? oldQuery : i === count - 1 ? lateQuery : Array.from({ length: dimensions }, () => -1),
      });
      ids.push(memoryId);
    }
    for (const scope of [
      { worldId: otherWorldId, playerId: 'p:0', spaceId },
      { worldId, playerId: 'p:1', spaceId },
      { worldId, playerId: 'p:0', spaceId: otherSpaceId },
    ]) {
      const memoryId = await ctx.db.insert('memories', {
        worldId: scope.worldId, playerId: scope.playerId, description: 'Foreign fact',
        importance: 9, lastAccess: Date.now(), data: { type: 'reflection', relatedMemoryIds: [] },
      });
      // A malformed foreign vector must never even enter this resident-space scan.
      await ctx.db.insert('modelMemoryVectors', { ...scope, memoryId, embedding: [1] });
    }
    return ids;
  });
  for (const [embedding, expected] of [[oldQuery, ids[0]], [lateQuery, ids[count - 1]]] as const) {
    // Keep the weighting inputs identical for the two independent semantic probes.
    await t.run((ctx) => ctx.db.patch(ids[0], { lastAccess }));
    const result = await t.action((ctx) =>
      searchMemories(ctx, parseGameId('players', 'p:0'), [...embedding], 1, worldId, spaceId),
    );
    expect(result.map((m) => m._id)).toEqual([expected]);
  }
  const retained = await t.query((ctx) => ctx.db.query('memories').collect());
  expect(retained).toHaveLength(count + 3);
  expect(retained.find((m) => m._id === ids[0])?.description).toBe('The old red scarf fact');
  expect(retained.find((m) => m._id === ids[count - 1])?.lastAccess).toBeGreaterThan(lastAccess);
}, 30_000);

test('wide vectors split on byte budget and pages return only bounded semantic candidates', async () => {
  const dimensions = 16384;
  const { t, worldId, spaceId } = await memorySearchFixture(dimensions);
  const embedding = Array.from({ length: dimensions }, () => 1);
  await t.run(async (ctx) => {
    for (let i = 0; i < 12; i++) {
      const memoryId = await ctx.db.insert('memories', {
        worldId, playerId: 'p:0', description: `Wide ${i}`, importance: 5,
        lastAccess: 1, data: { type: 'reflection', relatedMemoryIds: [] },
      });
      await ctx.db.insert('modelMemoryVectors', { worldId, playerId: 'p:0', spaceId, memoryId, embedding });
    }
  });
  let upperCreationTime: number | undefined;
  let cursor: string | null = null;
  let count = 0;
  let pages = 0;
  while (true) {
    const page: {
      candidates: { memoryId: Id<'memories'>; _score: number }[];
      isDone: boolean; continueCursor: string; upperCreationTime: number;
    } = await t.query(internal.agent.memory.searchSpaceVectorPage, {
      worldId, playerId: 'p:0', spaceId, searchEmbedding: embedding,
      dimensions, n: 3, cursor, upperCreationTime,
    });
    expect(page.candidates.length).toBeLessThan(12);
    expect(JSON.stringify(page.candidates).length).toBeLessThan(2048);
    expect(page.candidates.every((c) => !('embedding' in c) && Number.isFinite(c._score))).toBe(true);
    count += page.candidates.length;
    pages++;
    upperCreationTime = page.upperCreationTime;
    if (page.isDone) break;
    expect(page.continueCursor).not.toBe(cursor);
    cursor = page.continueCursor;
  }
  expect(count).toBe(12);
  expect(pages).toBeGreaterThan(1);
});

test('relevance candidates retain the original importance and recency ranking', async () => {
  const { t, worldId, spaceId } = await memorySearchFixture();
  const ids = await t.run(async (ctx) => {
    const ids = [];
    for (const [description, importance, lastAccess, embedding] of [
      ['Relevant old mundane fact', 0, 1, [1, 0]],
      ['Important recent reflection', 9, Date.now(), [0.8, 0.6]],
    ] as const) {
      const memoryId = await ctx.db.insert('memories', {
        worldId, playerId: 'p:0', description, importance, lastAccess,
        data: { type: 'reflection', relatedMemoryIds: [] },
      });
      await ctx.db.insert('modelMemoryVectors', {
        worldId, playerId: 'p:0', spaceId, memoryId, embedding: [...embedding],
      });
      ids.push(memoryId);
    }
    return ids;
  });
  const result = await t.action((ctx) =>
    searchMemories(ctx, parseGameId('players', 'p:0'), [1, 0], 1, worldId, spaceId),
  );
  expect(result.map((m) => m._id)).toEqual([ids[1]]);
});

test('retrieval corruption is explicit for local and travelling brains, without recent-text fallback', async () => {
  const { t, worldId, spaceId } = await memorySearchFixture();
  await t.run(async (ctx) => {
    const memoryId = await ctx.db.insert('memories', {
      worldId, playerId: 'p:0', description: 'Retained fact', importance: 5,
      lastAccess: 1, data: { type: 'reflection', relatedMemoryIds: [] },
    });
    await ctx.db.insert('modelMemoryVectors', {
      worldId, playerId: 'p:0', spaceId, memoryId, embedding: [1],
    });
  });
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }))),
  );
  const warnMock = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(t.action((ctx) => recallConversationMemories(
      ctx, worldId, parseGameId('players', 'p:0'), 'Remember', 3,
    ))).rejects.toThrow('INVALID_EMBEDDING_VECTOR');
    await expect(t.action((ctx) => recallHomeMemories(ctx, {
      worldId, playerId: 'p:0', agentGlobalId: 'home/resident', observation: 'Remember',
    }))).rejects.toThrow('INVALID_EMBEDDING_VECTOR');
    expect(warnMock).not.toHaveBeenCalled();
    expect(await t.query((ctx) => ctx.db.query('memories').collect())).toHaveLength(1);
  } finally {
    fetchMock.mockRestore();
    warnMock.mockRestore();
  }
});

test('full-history search times out explicitly and never ranks a partial scan', async () => {
  const { t, worldId, spaceId } = await memorySearchFixture();
  const route = await t.query(internal.models.embeddings.getRoute, { spaceId });
  const runMutation = jest.fn();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(100_000);
  const runQuery = jest.fn((_reference, args: { cursor?: string | null }) => {
    if (args.cursor === undefined) return Promise.resolve(route);
    clock.mockReturnValue(160_000);
    return Promise.resolve({ candidates: [], isDone: false, continueCursor: 'next', upperCreationTime: 1 });
  });
  try {
    await expect(searchMemories(
      { runQuery, runMutation } as unknown as ActionCtx,
      parseGameId('players', 'p:0'), [1, 0], 3, worldId, spaceId,
    )).rejects.toThrow('MEMORY_SEARCH_TIMEOUT');
    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(runMutation).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

test('invalid search limits are rejected before any route or history lookup', async () => {
  const { worldId, spaceId } = await memorySearchFixture();
  const runQuery = jest.fn();
  for (const n of [0, -1, 1.5, 101, NaN, Infinity]) {
    await expect(searchMemories(
      { runQuery } as unknown as ActionCtx,
      parseGameId('players', 'p:0'), [1, 0], n, worldId, spaceId,
    )).rejects.toThrow('INVALID_MEMORY_SEARCH_LIMIT');
  }
  expect(runQuery).not.toHaveBeenCalled();
});

test('pagination excludes vectors committed after the first database high watermark', async () => {
  const { t, worldId, spaceId } = await memorySearchFixture();
  const add = () => t.run(async (ctx) => {
    const memoryId = await ctx.db.insert('memories', {
      worldId, playerId: 'p:0', description: 'Fact', importance: 5,
      lastAccess: 1, data: { type: 'reflection', relatedMemoryIds: [] },
    });
    await ctx.db.insert('modelMemoryVectors', {
      worldId, playerId: 'p:0', spaceId, memoryId, embedding: [1, 0],
    });
    return memoryId;
  });
  const original = await add();
  const first = await t.query(internal.agent.memory.searchSpaceVectorPage, {
    worldId, playerId: 'p:0', spaceId, searchEmbedding: [1, 0], dimensions: 2, n: 3, cursor: null,
  });
  await add();
  const pinned = await t.query(internal.agent.memory.searchSpaceVectorPage, {
    worldId, playerId: 'p:0', spaceId, searchEmbedding: [1, 0], dimensions: 2, n: 3,
    cursor: null, upperCreationTime: first.upperCreationTime,
  });
  expect(pinned.candidates.map((c) => c.memoryId)).toEqual([original]);
});

test('a local conversation recalls retained travel text when its independent Embedding provider is down', async () => {
  const t = convexTest(schema, modules);
  const worldId = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const profileId = await ctx.db.insert('embeddingProfiles', {
      name: 'Unavailable',
      provider: 'custom',
      url: 'https://embedding.example',
      model: 'embed',
      dimensions: 2,
      preprocessingRevision: 'newline-to-space-v1',
      queryPrefix: '',
      documentPrefix: '',
      normalization: 'none',
      fingerprint: 'test-space',
      createdAt: 1,
    });
    const activeEmbeddingSpaceId = await ctx.db.insert('embeddingSpaces', {
      profileId,
      fingerprint: 'test-space',
      status: 'ACTIVE',
      createdAt: 1,
    });
    await ctx.db.insert('modelSettings', { key: 'town', activeEmbeddingSpaceId });
    await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'home/ava',
      description: 'Bea told me about the red scarf.',
      importance: 5,
      lastAccess: 1,
      data: {
        type: 'travel',
        eventId: 'event',
        visitId: 'visit',
        hostTownId: 'host',
        occurredAt: 1,
        participants: [{ agentGlobalId: 'host/bea', name: 'Bea', homeTownId: 'host' }],
      },
    });
    return worldId;
  });
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Embedding service unavailable'));
  const warnMock = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const memories = await t.action((ctx) =>
      recallConversationMemories(
        ctx,
        worldId,
        parseGameId('players', 'p:0'),
        'What did Bea tell me?',
        3,
      ),
    );
    expect(memories.map((m) => m.description)).toEqual(['Bea told me about the red scarf.']);
    expect(fetchMock).toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      'CONVERSATION_MEMORY_CANONICAL_FALLBACK',
      expect.stringContaining('Embedding service unavailable'),
    );
  } finally {
    fetchMock.mockRestore();
    warnMock.mockRestore();
  }
});

test('a global social memory recognizes a returning visitor and keeps namesakes distinct', () => {
  const remembered = {
    data: {
      type: 'conversation' as const,
      conversationId: 'c:1',
      playerIds: ['p:4'],
      participants: [{ agentGlobalId: 'town-a/ava', homeTownId: 'town-a', name: 'Ava' }],
    },
  };
  expect(concernsParticipant(remembered, 'p:99', 'town-a/ava')).toBe(true);
  expect(concernsParticipant(remembered, 'p:4', 'town-b/ava')).toBe(false);
  expect(concernsParticipant(remembered, 'p:4')).toBe(false);
  expect(
    concernsParticipant({ data: { ...remembered.data, participants: undefined } }, 'p:4'),
  ).toBe(true);
  expect(
    concernsParticipant(
      {
        data: {
          type: 'travel',
          eventId: 'event',
          visitId: 'visit',
          hostTownId: 'town-a',
          occurredAt: 1,
          participants: remembered.data.participants,
        },
      },
      'p:99',
      'town-a/ava',
    ),
  ).toBe(true);
});

test('local chat prompts use a visitor public profile and stable identity without a Host Agent', async () => {
  const t = convexTest(schema, modules);
  const worldId = await t.run(async (ctx) => {
    const player = {
      id: 'p:0',
      lastInput: 1,
      position: { x: 1, y: 1 },
      facing: { dx: 1, dy: 0 },
      speed: 0,
    };
    const worldId = await ctx.db.insert('worlds', {
      nextId: 10,
      players: [
        player,
        {
          ...player,
          id: 'p:9',
          remoteVisitor: {
            visitId: 'visit',
            agentGlobalId: 'town-a/ava',
            homeTownId: 'town-a',
            homeTownName: 'Town A',
            agentAuthorityEpoch: 1,
            visitLeaseVersion: 1,
            leaseExpiry: Date.now() + 60000,
            lastObservationAt: 1,
          },
        },
      ],
      agents: [{ id: 'a:0', playerId: 'p:0' }],
      conversations: [
        {
          id: 'c:1',
          creator: 'p:0',
          created: 1,
          numMessages: 0,
          participants: [
            { playerId: 'p:0', invited: 1, status: { kind: 'participating', started: 1 } },
            { playerId: 'p:9', invited: 1, status: { kind: 'participating', started: 1 } },
          ],
        },
      ],
    });
    await ctx.db.insert('playerDescriptions', {
      worldId,
      playerId: 'p:0',
      name: 'Bea',
      character: 'f1',
      description: 'Local resident',
    });
    await ctx.db.insert('playerDescriptions', {
      worldId,
      playerId: 'p:9',
      name: 'Ava',
      character: 'f1',
      description: 'A travelling astronomer',
      originTownId: 'town-a',
    });
    await ctx.db.insert('agentDescriptions', {
      worldId,
      agentId: 'a:0',
      identity: 'Bea',
      plan: 'Make friends',
    });
    return worldId;
  });
  const result = await t.query(
    makeFunctionReference<'query'>('agent/conversation:queryPromptData'),
    {
      worldId,
      playerId: 'p:0',
      otherPlayerId: 'p:9',
      conversationId: 'c:1',
    },
  );
  expect(result.otherPlayer.globalIdentity).toEqual({
    agentGlobalId: 'town-a/ava',
    homeTownId: 'town-a',
  });
  expect(result.otherAgent).toEqual({ identity: 'A travelling astronomer', plan: '' });
});

test('reflection retains the same resident identity while its map presence is suspended for travel', async () => {
  const t = convexTest(schema, modules);
  const worldId = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 2,
      players: [],
      conversations: [],
      agents: [
        {
          id: 'a:0',
          playerId: 'p:0',
          travelVisitId: 'visit',
          suspendedPlayer: {
            id: 'p:0',
            lastInput: 1,
            position: { x: 1, y: 1 },
            facing: { dx: 1, dy: 0 },
            speed: 0,
          },
        },
      ],
    });
    await ctx.db.insert('playerDescriptions', {
      worldId,
      playerId: 'p:0',
      name: 'Ava',
      character: 'f1',
      description: 'Resident',
    });
    await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'home/ava',
      description: 'I met Bea.',
      importance: 5,
      lastAccess: 1,
      data: {
        type: 'travel',
        eventId: 'event',
        visitId: 'visit',
        hostTownId: 'host',
        occurredAt: 1,
        participants: [{ agentGlobalId: 'host/bea', name: 'Bea', homeTownId: 'host' }],
      },
    });
    return worldId;
  });
  const result = await t.query(
    makeFunctionReference<'query'>('agent/memory:getReflectionMemories'),
    { worldId, playerId: 'p:0', numberOfItems: 100 },
  );
  expect(result.name).toBe('Ava');
  expect(result.memories.map((m: { description: string }) => m.description)).toEqual([
    'I met Bea.',
  ]);
});

test('conversation memory retries do not duplicate canonical summaries, vectors or encounter counts', async () => {
  jest.useFakeTimers();
  try {
  const { t, worldId, otherWorldId, spaceId } = await memorySearchFixture();
  const args = { agentId: 'a:1', worldId, embeddingSpaceId: spaceId, playerId: 'p:0', description: 'A real archived conversation', importance: 5, lastAccess: 100,
    data: { type: 'conversation' as const, conversationId: 'c:1', playerIds: ['p:2'], participants: [{ agentGlobalId: 'town:other/agent:2', homeTownId: 'town:other', name: 'Bob' }] }, embedding: [1, 0] };
  const insert = makeFunctionReference<'mutation'>('agent/memory:insertMemory');
  await t.mutation(insert, args);
  await t.mutation(insert, args);
  const memories = await t.run(ctx => ctx.db.query('memories').withIndex('resident', q => q.eq('worldId', worldId).eq('playerId', 'p:0')).collect());
  expect(memories.filter(m => m.data.type === 'conversation')).toHaveLength(1);
  const relationship = memories.find(m => m.data.type === 'relationship');
  expect(relationship?.data).toMatchObject({ encounterCount: 1, evidenceMemoryIds: [memories.find(m => m.data.type === 'conversation')!._id] });
  expect(await t.run(ctx => ctx.db.query('modelMemoryVectors').collect())).toHaveLength(1);
  await t.mutation(insert, { ...args, worldId: otherWorldId });
  expect(await t.run(ctx => ctx.db.query('memories').withIndex('resident_conversation', q => q.eq('worldId', otherWorldId).eq('playerId', 'p:0').eq('data.type', 'conversation').eq('data.conversationId', 'c:1')).collect())).toHaveLength(1);
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});
