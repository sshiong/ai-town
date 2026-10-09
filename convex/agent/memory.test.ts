import { convexTest } from 'convex-test';
import { jest } from '@jest/globals';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { concernsParticipant } from './memory';
import { recallConversationMemories } from './conversation';
import { parseGameId } from '../aiTown/ids';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../agent/memory.ts': () => import('./memory'),
  '../agent/conversation.ts': () => import('./conversation'),
  '../agent/embeddingsCache.ts': () => import('./embeddingsCache'),
  '../models/embeddings.ts': () => import('../models/embeddings'),
};

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
    await ctx.db.insert('modelSettings', { key: 'local', activeEmbeddingSpaceId });
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
