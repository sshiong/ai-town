import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { embeddingFingerprint, verifiedCompatible, validateVector } from './compatibility';
import { cacheNamespace } from '../agent/embeddingsCache';
import { bindResident, profileChatConfig } from './profiles';
import { ensureEmbeddingSpace, profileEmbeddingConfig } from './embeddings';
import { chatCompletion, fetchEmbeddingBatch } from '../util/llm';
import { recallHomeMemories } from '../federation/decision';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../models/profiles.ts': () => import('./profiles'),
  '../models/embeddings.ts': () => import('./embeddings'),
  '../agent/embeddingsCache.ts': () => import('../agent/embeddingsCache'),
  '../agent/memory.ts': () => import('../agent/memory'),
  '../agent/travelMemory.ts': () => import('../agent/travelMemory'),
  '../federation/decision.ts': () => import('../federation/decision'),
};
const mutation = (name: string) => makeFunctionReference<'mutation'>(name);
const query = (name: string) => makeFunctionReference<'query'>(name);
const profile = {
  name: 'Embed',
  provider: 'custom' as const,
  url: 'https://models.example',
  model: 'embed',
  dimensions: 2,
  preprocessingRevision: 'newline-to-space-v1',
  queryPrefix: 'query: ',
  documentPrefix: 'doc: ',
  normalization: 'none',
};

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
});
beforeEach(() => {
  jest.useFakeTimers();
  process.env.FEDERATION_ADMIN_TOKEN = 'test-admin-token-24-characters';
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('same dimensions and model name are not embedding compatibility evidence; caches isolate modes and spaces', () => {
  expect(verifiedCompatible(profile, profile)).toBe(false);
  const evidence = { ...profile, immutableRevision: 'r1', weightsDigest: 'a'.repeat(64) };
  expect(verifiedCompatible(evidence, { ...evidence, url: 'https://another.example' })).toBe(false);
  expect(verifiedCompatible(evidence, { ...evidence, documentPrefix: 'changed' })).toBe(false);
  expect(embeddingFingerprint(profile)).not.toBe(
    embeddingFingerprint({ ...profile, dimensions: 3 }),
  );
  const route = {
    space: { _id: 'space-a' },
    profile: { ...profile, fingerprint: embeddingFingerprint(profile) },
  } as never;
  expect(cacheNamespace(route, 'query')).not.toBe(cacheNamespace(route, 'document'));
  expect(() => validateVector([0, 0], 2)).toThrow('ZERO_EMBEDDING_VECTOR');
  expect(() => validateVector([1, Infinity], 2)).toThrow('INVALID_EMBEDDING_VECTOR');
});

test('main applies only to new residents; explicit resident bindings and global identity stay fixed', async () => {
  const t = convexTest(schema, modules);
  const worldId = await t.run((ctx) =>
    ctx.db.insert('worlds', { nextId: 2, players: [], agents: [], conversations: [] }),
  );
  const adminToken = process.env.FEDERATION_ADMIN_TOKEN!;
  jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })),
    );
  const first = await t.mutation(mutation('models/profiles:saveChatProfile'), {
    adminToken,
    name: 'First',
    provider: 'custom',
    url: 'https://one.example',
    model: 'one',
  });
  await t.action(makeFunctionReference<'action'>('models/profiles:probeChat'), {
    adminToken,
    chatProfileId: first,
  });
  await t.mutation(mutation('models/profiles:setMain'), { adminToken, chatProfileId: first });
  await t.run((ctx) => bindResident(ctx, worldId, 'p:0' as never, 'town:test/agent:0'));
  const second = await t.mutation(mutation('models/profiles:saveChatProfile'), {
    adminToken,
    name: 'Second',
    provider: 'custom',
    url: 'https://two.example',
    model: 'two',
  });
  await t.action(makeFunctionReference<'action'>('models/profiles:probeChat'), {
    adminToken,
    chatProfileId: second,
  });
  await t.mutation(mutation('models/profiles:setMain'), { adminToken, chatProfileId: second });
  await t.run((ctx) => bindResident(ctx, worldId, 'p:1' as never, 'town:test/agent:1'));
  const bindings = await t.query((ctx) => ctx.db.query('residentModelBindings').collect());
  expect(bindings.find((b) => b.playerId === 'p:0')?.chatProfileId).toBe(first);
  expect(bindings.find((b) => b.playerId === 'p:1')?.chatProfileId).toBe(second);
  await expect(
    t.run((ctx) => bindResident(ctx, worldId, 'p:0' as never, 'town:other/agent:0')),
  ).rejects.toThrow('RESIDENT_GLOBAL_ID_CONFLICT');
});

test('embedding switch requires complete coverage and validation, with old vectors available for rollback', async () => {
  const t = convexTest(schema, modules);
  const adminToken = process.env.FEDERATION_ADMIN_TOKEN!;
  const ids = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const profileId = await ctx.db.insert('embeddingProfiles', {
      ...profile,
      fingerprint: embeddingFingerprint(profile),
      createdAt: 1,
    });
    const old = await ctx.db.insert('embeddingSpaces', {
      profileId,
      fingerprint: 'old',
      status: 'ACTIVE',
      createdAt: 1,
      validatedAt: 1,
    });
    const next = await ctx.db.insert('embeddingSpaces', {
      profileId,
      fingerprint: 'next',
      status: 'BUILDING',
      createdAt: 2,
    });
    await ctx.db.insert('modelSettings', { key: 'town', activeEmbeddingSpaceId: old });
    const memoryId = await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:0',
      description: 'fact',
      importance: 9,
      lastAccess: 1,
      data: { type: 'relationship', playerId: 'p:1' },
    });
    await ctx.db.insert('modelMemoryVectors', {
      worldId,
      playerId: 'p:0',
      memoryId,
      spaceId: old,
      embedding: [1, 0],
    });
    return { worldId, profileId, old, next, memoryId };
  });
  await expect(
    t.mutation(mutation('models/embeddings:finishBuild'), { spaceId: ids.next }),
  ).rejects.toThrow('EMBEDDING_COVERAGE_INCOMPLETE');
  await t.mutation(mutation('models/embeddings:putVector'), {
    spaceId: ids.next,
    memoryId: ids.memoryId,
    worldId: ids.worldId,
    embedding: [0, 1],
  });
  await t.mutation(mutation('models/embeddings:finishBuild'), { spaceId: ids.next });
  await expect(
    t.mutation(mutation('models/embeddings:activateSpace'), { adminToken, spaceId: ids.next }),
  ).rejects.toThrow('EMBEDDING_SPACE_NOT_VALIDATED');
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 1] }] })));
  await t.action(makeFunctionReference<'action'>('models/embeddings:validateSpace'), {
    adminToken,
    spaceId: ids.next,
  });
  await t.mutation(mutation('models/embeddings:activateSpace'), { adminToken, spaceId: ids.next });
  expect((await t.query(query('models/embeddings:getRoute'), {})).space._id).toBe(ids.next);
  await t.mutation(mutation('models/embeddings:rollback'), { adminToken, spaceId: ids.old });
  expect((await t.query(query('models/embeddings:getRoute'), {})).space._id).toBe(ids.old);
  expect(await t.query((ctx) => ctx.db.query('modelMemoryVectors').collect())).toHaveLength(2);
});

test('travel receipts persist once without embeddings or local conversations and retain global participants', async () => {
  const t = convexTest(schema, modules);
  const worldId = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const chatProfileId = await ctx.db.insert('chatProfiles', {
      name: 'Home',
      provider: 'custom',
      url: 'https://home.example',
      model: 'home',
      stopWords: [],
      createdAt: 1,
    });
    await ctx.db.insert('residentModelBindings', {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'town:home/agent:0',
      chatProfileId,
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('visitLedger', {
      visitId: 'visit-1',
      agentGlobalId: 'town:home/agent:0',
      homeTownId: 'town:home',
      hostTownId: 'town:host',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      leaseExpiry: 10,
      fencingToken: 'secret',
      state: 'RETURNED',
      role: 'home',
      worldId,
      homePlayerId: 'p:0',
      profile: {},
      createdAt: 1,
      updatedAt: 1,
    });
    return worldId;
  });
  const args = {
    worldId,
    playerId: 'p:0',
    agentGlobalId: 'town:home/agent:0',
    visitId: 'visit-1',
    eventId: 'event-1',
    hostTownId: 'town:host',
    description: 'I talked to Ava.',
    occurredAt: 1,
    participants: [{ agentGlobalId: 'town:host/agent:ava', name: 'Ava', homeTownId: 'town:host' }],
  };
  const id = await t.mutation(mutation('agent/travelMemory:recordConfirmedEvent'), args);
  expect(await t.mutation(mutation('agent/travelMemory:recordConfirmedEvent'), args)).toBe(id);
  const memories = await t.query((ctx) => ctx.db.query('memories').collect());
  expect(memories).toHaveLength(1);
  expect(memories[0].data).toMatchObject({ type: 'travel', participants: args.participants });
  expect(await t.query((ctx) => ctx.db.query('modelMemoryVectors').collect())).toHaveLength(0);
  await expect(
    t.mutation(mutation('agent/travelMemory:recordConfirmedEvent'), {
      ...args,
      description: 'different',
    }),
  ).rejects.toThrow('TRAVEL_EVENT_ID_CONFLICT');
});

test('Chat and Embedding issue real independent provider requests without switching on failure', async () => {
  const requests: { url: string; body: any }[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify(
        String(input).includes('embeddings')
          ? { data: [{ index: 0, embedding: [1, 0] }] }
          : { choices: [{ message: { content: 'OK' } }] },
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  await chatCompletion(
    { messages: [{ role: 'user', content: 'Hi' }] },
    { provider: 'custom', url: 'https://chat.example/v1', chatModel: 'chat-one', stopWords: [] },
  );
  await fetchEmbeddingBatch(
    ['fact'],
    {
      provider: 'custom',
      url: 'https://embed.example',
      embeddingModel: 'embed-two',
      dimensions: 2,
      documentPrefix: 'document: ',
    },
    'document',
  );
  expect(requests.map((r) => r.url)).toEqual([
    'https://chat.example/v1/chat/completions',
    'https://embed.example/v1/embeddings',
  ]);
  expect(requests[0].body.model).toBe('chat-one');
  expect(requests[1].body).toMatchObject({ model: 'embed-two', input: ['document: fact'] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Unauthorized', { status: 401 }));
  await expect(
    chatCompletion(
      { messages: [{ role: 'user', content: 'Hi' }] },
      { provider: 'custom', url: 'https://chat.example/v1', chatModel: 'chat-one', stopWords: [] },
    ),
  ).rejects.toThrow('401');
  expect(globalThis.fetch).toHaveBeenLastCalledWith(
    'https://chat.example/v1/chat/completions',
    expect.anything(),
  );
});

test('cache lookup cannot reuse a legacy entry, another space, or another input mode', async () => {
  const t = convexTest(schema, modules);
  const textHash = new Uint8Array([1, 2, 3]).buffer;
  await t.run(async (ctx) => {
    await ctx.db.insert('embeddingsCache', { textHash, embedding: [99, 99] });
    await ctx.db.insert('embeddingsCache', {
      namespace: 'space-old/document',
      textHash,
      embedding: [1, 0],
    });
    await ctx.db.insert('embeddingsCache', {
      namespace: 'space-new/query',
      textHash,
      embedding: [0, 1],
    });
  });
  expect(
    await t.query(query('agent/embeddingsCache:getEmbeddingsByText'), {
      textHashes: [textHash],
      namespace: 'space-new/document',
    }),
  ).toHaveLength(0);
  const hit = await t.query(query('agent/embeddingsCache:getEmbeddingsByText'), {
    textHashes: [textHash],
    namespace: 'space-new/query',
  });
  expect(hit).toHaveLength(1);
  expect(hit[0].embedding).toEqual([0, 1]);
});

test('different dimensional vectors coexist in separate spaces and failed rebuild leaves active retrieval untouched', async () => {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const memoryId = await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:0',
      description: 'old fact',
      importance: 7,
      lastAccess: 1,
      data: { type: 'relationship', playerId: 'p:1' },
    });
    const p2 = await ctx.db.insert('embeddingProfiles', {
      ...profile,
      fingerprint: embeddingFingerprint(profile),
      createdAt: 1,
    });
    const p3 = await ctx.db.insert('embeddingProfiles', {
      ...profile,
      dimensions: 3,
      fingerprint: embeddingFingerprint({ ...profile, dimensions: 3 }),
      createdAt: 1,
    });
    const active = await ctx.db.insert('embeddingSpaces', {
      profileId: p2,
      fingerprint: '2d',
      status: 'ACTIVE',
      createdAt: 1,
    });
    const building = await ctx.db.insert('embeddingSpaces', {
      profileId: p3,
      fingerprint: '3d',
      status: 'BUILDING',
      createdAt: 1,
    });
    await ctx.db.insert('modelSettings', { key: 'town', activeEmbeddingSpaceId: active });
    return { worldId, memoryId, active, building };
  });
  await t.mutation(mutation('models/embeddings:putVector'), {
    worldId: ids.worldId,
    memoryId: ids.memoryId,
    spaceId: ids.active,
    embedding: [1, 0],
  });
  await t.mutation(mutation('models/embeddings:putVector'), {
    worldId: ids.worldId,
    memoryId: ids.memoryId,
    spaceId: ids.building,
    embedding: [1, 0, 0],
  });
  await t.mutation(mutation('models/embeddings:failBuild'), {
    spaceId: ids.building,
    failure: 'provider unavailable',
  });
  expect((await t.query(query('models/embeddings:getRoute'), {})).space._id).toBe(ids.active);
  const vectors = await t.query((ctx) => ctx.db.query('modelMemoryVectors').collect());
  expect(vectors.map((v) => v.embedding.length)).toEqual([2, 3]);
  expect(
    (await t.query(query('models/embeddings:getRoute'), { spaceId: ids.building })).space.status,
  ).toBe('FAILED');
});

test('confirmed Host dialogue deduplicates message IDs across observations and stores only actual remote utterances', async () => {
  const t = convexTest(schema, modules);
  const worldId = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const chatProfileId = await ctx.db.insert('chatProfiles', {
      name: 'Home',
      provider: 'custom',
      url: 'https://home.example',
      model: 'home',
      stopWords: [],
      createdAt: 1,
    });
    await ctx.db.insert('residentModelBindings', {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'town:home/agent:0',
      chatProfileId,
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('visitLedger', {
      visitId: 'visit-1',
      agentGlobalId: 'town:home/agent:0',
      homeTownId: 'town:home',
      hostTownId: 'town:host',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      leaseExpiry: Date.now() + 30000,
      fencingToken: 'secret',
      state: 'ACTIVE',
      role: 'home',
      worldId,
      homePlayerId: 'p:0',
      profile: {},
      createdAt: 1,
      updatedAt: 1,
    });
    return worldId;
  });
  const args = {
    worldId,
    playerId: 'p:0',
    agentGlobalId: 'town:home/agent:0',
    visitId: 'visit-1',
    hostTownId: 'town:host',
    observationEventId: 'obs-1',
    federationConversationId: 'town:host/world/c:1',
    observedAt: 10,
    participants: [
      {
        playerId: 'p:visitor',
        agentGlobalId: 'town:home/agent:0',
        name: 'Me',
        homeTownId: 'town:home',
      },
      {
        playerId: 'p:host',
        agentGlobalId: 'town:host/agent:ava',
        name: 'Ava',
        homeTownId: 'town:host',
      },
    ],
    messages: [
      {
        messageId: 'message-host-1',
        text: 'I remember your favourite red scarf.',
        author: 'p:host',
        occurredAt: 5,
      },
      { messageId: 'message-self-1', text: 'Thank you.', author: 'p:visitor', occurredAt: 6 },
    ],
  };
  const first = await t.mutation(mutation('agent/travelMemory:recordObservedConversation'), args);
  expect(
    await t.mutation(mutation('agent/travelMemory:recordObservedConversation'), {
      ...args,
      observationEventId: 'obs-2',
      observedAt: 20,
    }),
  ).toEqual(first);
  let memories = await t.query((ctx) => ctx.db.query('memories').collect());
  expect(memories).toHaveLength(1);
  expect(memories[0].description).toContain('red scarf');
  expect(memories[0].data).toMatchObject({
    type: 'travel',
    messageId: 'message-host-1',
    authorGlobalId: 'town:host/agent:ava',
    sourceObservationEventId: 'obs-1',
  });
  await t.mutation(mutation('agent/travelMemory:recordObservedConversation'), {
    ...args,
    observationEventId: 'obs-3',
    observedAt: 30,
    messages: [
      ...args.messages,
      { messageId: 'message-host-2', text: 'See you next week.', author: 'p:host', occurredAt: 25 },
    ],
  });
  memories = await t.query((ctx) => ctx.db.query('memories').collect());
  expect(memories).toHaveLength(2);
  await expect(
    t.mutation(mutation('agent/travelMemory:recordObservedConversation'), {
      ...args,
      messages: [{ ...args.messages[0], text: 'fabricated replacement' }],
    }),
  ).rejects.toThrow('TRAVEL_EVENT_ID_CONFLICT');
  await expect(
    t.mutation(mutation('agent/travelMemory:recordObservedConversation'), {
      ...args,
      messages: [{ ...args.messages[0], author: 'unknown' }],
    }),
  ).rejects.toThrow('INVALID_CONFIRMED_HOST_MESSAGE');
  expect(await t.query((ctx) => ctx.db.query('memories').collect())).toHaveLength(2);
});

test('Home semantic retrieval finds old travel facts beyond recent polling history using its own Embedding profile', async () => {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const worldId = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const profileId = await ctx.db.insert('embeddingProfiles', {
      ...profile,
      fingerprint: embeddingFingerprint(profile),
      createdAt: 1,
    });
    const spaceId = await ctx.db.insert('embeddingSpaces', {
      profileId,
      fingerprint: embeddingFingerprint(profile),
      status: 'ACTIVE',
      createdAt: 1,
    });
    await ctx.db.insert('modelSettings', { key: 'town', activeEmbeddingSpaceId: spaceId });
    const oldId = await ctx.db.insert('memories', {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'town:home/agent:0',
      description: 'Ava likes a red scarf.',
      importance: 9,
      lastAccess: now - 60 * 86400000,
      data: {
        type: 'travel',
        eventId: 'old-event',
        visitId: 'old-visit',
        hostTownId: 'town:host',
        participants: [
          { agentGlobalId: 'town:host/agent:ava', name: 'Ava', homeTownId: 'town:host' },
        ],
        occurredAt: 1,
      },
    });
    await ctx.db.insert('modelMemoryVectors', {
      worldId,
      playerId: 'p:0',
      memoryId: oldId,
      spaceId,
      embedding: [1, 0],
    });
    for (let i = 0; i < 55; i++) {
      const memoryId = await ctx.db.insert('memories', {
        worldId,
        playerId: 'p:0',
        agentGlobalId: 'town:home/agent:0',
        description: `Recent unrelated fact ${i}`,
        importance: 1,
        lastAccess: now,
        data: { type: 'relationship', playerId: 'p:1' },
      });
      await ctx.db.insert('modelMemoryVectors', {
        worldId,
        playerId: 'p:0',
        memoryId,
        spaceId,
        embedding: [0, 1],
      });
    }
    return worldId;
  });
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 }),
    );
  const args = {
    worldId,
    playerId: 'p:0',
    agentGlobalId: 'town:home/agent:0',
    observation: { conversation: { messages: [{ text: 'Do you remember my red scarf?' }] } },
  };
  const canonical = await t.query(query('federation/decision:rememberedFacts'), {
    worldId,
    playerId: args.playerId,
    agentGlobalId: args.agentGlobalId,
  });
  expect(canonical).not.toContain('Ava likes a red scarf.');
  const recall = await t.action((ctx) => recallHomeMemories(ctx, args));
  expect(recall.retrievalMode).toBe('semantic');
  expect(recall.descriptions).toContain('Ava likes a red scarf.');
  expect(globalThis.fetch).toHaveBeenCalledWith(
    'https://models.example/v1/embeddings',
    expect.objectContaining({ body: expect.stringContaining('query: ') }),
  );
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('Unavailable credentials', { status: 401 }));
  const fallback = await t.action((ctx) =>
    recallHomeMemories(ctx, { ...args, observation: { different: 'uncached-query' } }),
  );
  expect(fallback.retrievalMode).toBe('canonical-fallback');
  expect(fallback.descriptions).toEqual(canonical);
  expect(console.warn).toHaveBeenCalledWith('HOME_MEMORY_CANONICAL_FALLBACK', expect.any(String));
});

test.each(['custom', 'ollama'] as const)(
  'bootstrap %s without authentication never invents a missing credential reference',
  async (provider) => {
    const envKeys = [
      'CHAT_API_KEY',
      'EMBEDDING_API_KEY',
      'LLM_API_KEY',
      'OPENAI_API_KEY',
      'TOGETHER_API_KEY',
      'CHAT_PROVIDER',
      'EMBEDDING_PROVIDER',
      'CHAT_API_URL',
      'EMBEDDING_API_URL',
      'CHAT_MODEL',
      'EMBEDDING_MODEL',
      'EMBEDDING_DIMENSIONS',
    ];
    const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    try {
      for (const key of envKeys) delete process.env[key];
      process.env.CHAT_PROVIDER = provider;
      process.env.EMBEDDING_PROVIDER = provider;
      process.env.CHAT_API_URL = 'http://127.0.0.1:11434';
      process.env.EMBEDDING_API_URL = 'http://127.0.0.1:11434';
      process.env.CHAT_MODEL = 'local-chat';
      process.env.EMBEDDING_MODEL = 'local-embed';
      process.env.EMBEDDING_DIMENSIONS = '2';
      const t = convexTest(schema, modules);
      const worldId = await t.run((ctx) =>
        ctx.db.insert('worlds', { nextId: 1, players: [], agents: [], conversations: [] }),
      );
      await t.run(async (ctx) => {
        await bindResident(ctx, worldId, 'p:0' as never);
        await ensureEmbeddingSpace(ctx);
      });
      const profiles = await t.query(async (ctx) => ({
        chat: await ctx.db.query('chatProfiles').unique(),
        embedding: await ctx.db.query('embeddingProfiles').unique(),
      }));
      expect(profiles.chat?.apiKeyEnv).toBeUndefined();
      expect(profiles.embedding?.apiKeyEnv).toBeUndefined();
      expect(profileChatConfig(profiles.chat!).apiKey).toBeUndefined();
      expect(profileEmbeddingConfig(profiles.embedding!).apiKey).toBeUndefined();
      expect(() => profileChatConfig({ ...profiles.chat!, apiKeyEnv: 'LLM_API_KEY' })).toThrow(
        'MODEL_CREDENTIAL_MISSING',
      );
      expect(() =>
        profileEmbeddingConfig({ ...profiles.embedding!, apiKeyEnv: 'LLM_API_KEY' }),
      ).toThrow('MODEL_CREDENTIAL_MISSING');
    } finally {
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  },
);

test('Chat availability probe rejects a successful HTTP response without usable model output', async () => {
  const t = convexTest(schema, modules);
  const adminToken = process.env.FEDERATION_ADMIN_TOKEN!;
  const chatProfileId = await t.mutation(mutation('models/profiles:saveChatProfile'), {
    adminToken,
    name: 'Reasoning provider',
    provider: 'custom',
    url: 'https://chat.example',
    model: 'reasoning',
  });
  const request = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 }),
    );
  const probe = makeFunctionReference<'action'>('models/profiles:probeChat');
  await expect(t.action(probe, { adminToken, chatProfileId })).rejects.toThrow(
    'EMPTY_CHAT_RESPONSE',
  );
  await expect(t.action(probe, { adminToken, chatProfileId })).resolves.toMatchObject({
    ok: true,
    model: 'reasoning',
  });
  expect(JSON.parse(request.mock.calls[0][1]!.body as string).max_tokens).toBe(256);
});

test('empty Chat output reports safe provider metadata without executing or exposing reasoning', async () => {
  const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        model: 'actual-provider-model',
        choices: [
          {
            finish_reason: 'length',
            message: { content: null, reasoning_content: 'secret reasoning' },
          },
        ],
        usage: { completion_tokens: 350, completion_tokens_details: { reasoning_tokens: 350 } },
      }),
    ),
  );
  const error = await chatCompletion(
    { messages: [{ role: 'user', content: 'private prompt' }], max_tokens: 350 },
    { provider: 'custom', url: 'https://chat.example', chatModel: 'claw', stopWords: [] },
  ).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain('EMPTY_CHAT_RESPONSE');
  expect(String(error)).toContain('"model":"actual-provider-model"');
  expect(String(error)).toContain('"finishReason":"length"');
  expect(String(error)).toContain('"reasoningTokens":350');
  expect(String(error)).not.toContain('secret reasoning');
  expect(String(error)).not.toContain('private prompt');
  expect(JSON.parse(request.mock.calls[0][1]!.body as string).model).toBe('claw');
});

test('Chat deadline aborts a live request while keeping its bound model and stop words', async () => {
  const request = jest.spyOn(globalThis, 'fetch').mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('provider cancelled')), {
          once: true,
        });
      }),
  );
  const completion = chatCompletion(
    { messages: [{ role: 'user', content: 'action' }] },
    { provider: 'custom', url: 'https://chat.example', chatModel: 'claw', stopWords: ['END'] },
    { deadline: Date.now() + 50 },
  );
  const rejected = expect(completion).rejects.toThrow('CHAT_REQUEST_DEADLINE');
  await jest.advanceTimersByTimeAsync(50);
  await rejected;
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1]!.signal!.aborted).toBe(true);
  expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toMatchObject({
    model: 'claw',
    stop: ['END'],
  });
  expect(jest.getTimerCount()).toBe(0);
});

test('Chat deadline interrupts retry backoff and rejects expired requests before contacting provider', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const request = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('Busy', { status: 503 }));
  const config = {
    provider: 'custom' as const,
    url: 'https://chat.example',
    chatModel: 'claw',
    stopWords: [],
  };
  const completion = chatCompletion({ messages: [{ role: 'user', content: 'action' }] }, config, {
    deadline: Date.now() + 50,
  });
  const rejected = expect(completion).rejects.toThrow('CHAT_REQUEST_DEADLINE');
  await jest.advanceTimersByTimeAsync(50);
  await rejected;
  expect(request).toHaveBeenCalledTimes(1);
  await expect(
    chatCompletion({ messages: [{ role: 'user', content: 'action' }] }, config, {
      deadline: Date.now(),
    }),
  ).rejects.toThrow('CHAT_REQUEST_DEADLINE');
  expect(request).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('saved Chat profiles require successful current probes for main and cannot trigger a legacy fallback', async () => {
  const t = convexTest(schema, modules);
  const adminToken = process.env.FEDERATION_ADMIN_TOKEN!;
  const worldId = await t.run((ctx) =>
    ctx.db.insert('worlds', { nextId: 1, players: [], agents: [], conversations: [] }),
  );
  const id = await t.mutation(mutation('models/profiles:saveChatProfile'), {
    adminToken,
    name: 'Selected',
    provider: 'custom',
    url: 'https://chat.example',
    model: 'claw',
  });
  const state = await t.query(query('models/profiles:list'), { adminToken });
  expect(state.settings?.mainChatProfileId).toBeUndefined();
  await expect(
    t.mutation(mutation('models/profiles:setMain'), { adminToken, chatProfileId: id }),
  ).rejects.toThrow('CHAT_PROFILE_NOT_VALIDATED');
  await expect(t.run((ctx) => bindResident(ctx, worldId, 'p:0' as never))).rejects.toThrow(
    'MAIN_CHAT_PROFILE_MISSING',
  );
  const request = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }] })),
    );
  const probe = makeFunctionReference<'action'>('models/profiles:probeChat');
  await t.action(probe, { adminToken, chatProfileId: id });
  await t.mutation(mutation('models/profiles:setMain'), { adminToken, chatProfileId: id });
  await t.run((ctx) => bindResident(ctx, worldId, 'p:0' as never));
  await expect(t.action(probe, { adminToken, chatProfileId: id })).rejects.toThrow(
    'EMPTY_CHAT_RESPONSE',
  );
  await expect(
    t.mutation(mutation('models/profiles:setMain'), { adminToken, chatProfileId: id }),
  ).rejects.toThrow('CHAT_PROFILE_NOT_VALIDATED');
  expect(
    (await t.query((ctx) => ctx.db.query('residentModelBindings').unique()))?.chatProfileId,
  ).toBe(id);
  expect(request).toHaveBeenCalledTimes(2);
});

test('embedding validation requires a live retrieval hit in the correct resident namespace', async () => {
  const t = convexTest(schema, modules);
  const adminToken = process.env.FEDERATION_ADMIN_TOKEN!;
  const spaceId = await t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 2,
      players: [],
      agents: [],
      conversations: [],
    });
    const profileId = await ctx.db.insert('embeddingProfiles', {
      ...profile,
      fingerprint: embeddingFingerprint(profile),
      createdAt: 1,
    });
    const spaceId = await ctx.db.insert('embeddingSpaces', {
      profileId,
      fingerprint: embeddingFingerprint(profile),
      status: 'READY',
      createdAt: 1,
      validatedAt: 1,
    });
    for (const [description, embedding, playerId] of [
      ['Alpha', [1, 0], 'p:0'],
      ['Beta', [0, 1], 'p:0'],
      ['Other owner', [1, 0], 'p:1'],
    ] as const) {
      const memoryId = await ctx.db.insert('memories', {
        worldId,
        playerId,
        description,
        importance: 1,
        lastAccess: 1,
        data: { type: 'relationship', playerId: 'p:2' },
      });
      await ctx.db.insert('modelMemoryVectors', {
        worldId,
        playerId,
        spaceId,
        memoryId,
        embedding: [...embedding],
      });
    }
    return spaceId;
  });
  const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: body.input[0].includes('Beta') ? [0, 1] : [1, 0] }],
      }),
    );
  });
  const validate = makeFunctionReference<'action'>('models/embeddings:validateSpace');
  await expect(t.action(validate, { adminToken, spaceId })).resolves.toEqual({
    valid: true,
    sampleCount: 3,
  });
  request.mockImplementation(
    async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 1] }] })),
  );
  await expect(t.action(validate, { adminToken, spaceId })).rejects.toThrow(
    'EMBEDDING_RETRIEVAL_SAMPLE_MISSED',
  );
  expect(
    (await t.query(query('models/embeddings:getRoute'), { spaceId })).space.validatedAt,
  ).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(4);
});

test('administrator asserted weights and revision cannot authorize cross profile vector reuse', async () => {
  const t = convexTest(schema, modules);
  const adminToken = process.env.FEDERATION_ADMIN_TOKEN!;
  const targetProfileId = await t.run(async (ctx) => {
    const fields = {
      ...profile,
      immutableRevision: 'revision',
      weightsDigest: 'a'.repeat(64),
      createdAt: 1,
    };
    const source = await ctx.db.insert('embeddingProfiles', {
      ...fields,
      fingerprint: embeddingFingerprint(fields),
    });
    const target = await ctx.db.insert('embeddingProfiles', {
      ...fields,
      url: 'https://other.example',
      fingerprint: embeddingFingerprint({ ...fields, url: 'https://other.example' }),
    });
    const spaceId = await ctx.db.insert('embeddingSpaces', {
      profileId: source,
      fingerprint: 'source',
      status: 'ACTIVE',
      createdAt: 1,
    });
    await ctx.db.insert('modelSettings', { key: 'town', activeEmbeddingSpaceId: spaceId });
    return target;
  });
  await expect(
    t.query(query('models/embeddings:planSwitch'), { adminToken, targetProfileId }),
  ).resolves.toMatchObject({ compatibility: 'REBUILD_REQUIRED', canReuse: false });
});
