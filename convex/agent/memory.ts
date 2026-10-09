import { v } from 'convex/values';
import { ActionCtx, DatabaseReader, internalMutation, internalQuery } from '../_generated/server';
import { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { LLMMessage, chatCompletion, ChatConfig } from '../util/llm';
import { chatConfigForResident } from '../models/profiles';
import { activeRoute, ensureEmbeddingSpace } from '../models/embeddings';
import { cosineSimilarity, validateVector } from '../models/compatibility';
import * as embeddingsCache from './embeddingsCache';
import { asyncMap } from '../util/asyncMap';
import { GameId, agentId, conversationId, playerId } from '../aiTown/ids';
import { SerializedPlayer } from '../aiTown/player';
import { memoryFields } from './schema';

// How long to wait before updating a memory's last access time.
export const MEMORY_ACCESS_THROTTLE = 300_000; // In ms
// We fetch 10x the number of memories by relevance, to have more candidates
// for sorting by relevance + recency + importance.
const MEMORY_OVERFETCH = 10;
const selfInternal = internal.agent.memory;

export type Memory = Doc<'memories'>;
export type MemoryType = Memory['data']['type'];
export type MemoryOfType<T extends MemoryType> = Omit<Memory, 'data'> & {
  data: Extract<Memory['data'], { type: T }>;
};

export async function rememberConversation(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  agentId: GameId<'agents'>,
  playerId: GameId<'players'>,
  conversationId: GameId<'conversations'>,
) {
  const data = await ctx.runQuery(selfInternal.loadConversation, {
    worldId,
    playerId,
    conversationId,
  });
  const { player, otherPlayer } = data;
  const messages = await ctx.runQuery(selfInternal.loadMessages, { worldId, conversationId });
  if (!messages.length) {
    return;
  }

  const llmMessages: LLMMessage[] = [
    {
      role: 'user',
      content: `You are ${player.name}, and you just finished a conversation with ${otherPlayer.name}. I would
      like you to summarize the conversation from ${player.name}'s perspective, using first-person pronouns like
      "I," and add if you liked or disliked this interaction.`,
    },
  ];
  const authors = new Set<GameId<'players'>>();
  for (const message of messages) {
    const author = message.author === player.id ? player : otherPlayer;
    authors.add(author.id as GameId<'players'>);
    const recipient = message.author === player.id ? otherPlayer : player;
    llmMessages.push({
      role: 'user',
      content: `${author.name} to ${recipient.name}: ${message.text}`,
    });
  }
  llmMessages.push({ role: 'user', content: 'Summary:' });
  const chatConfig = await chatConfigForResident(ctx, worldId, playerId);
  const { content } = await chatCompletion(
    {
      messages: llmMessages,
      max_tokens: 500,
    },
    chatConfig,
  );
  const description = `Conversation with ${otherPlayer.name} at ${new Date(
    data.conversation._creationTime,
  ).toLocaleString()}: ${content}`;
  const importance = await calculateImportance(description, chatConfig);
  const route = await activeRoute(ctx);
  const embedding = await embeddingsCache.fetch(ctx, description, { route, inputMode: 'document' });
  authors.delete(player.id as GameId<'players'>);
  await ctx.runMutation(selfInternal.insertMemory, {
    agentId,
    worldId,
    embeddingSpaceId: route.space._id,
    playerId: player.id,
    description,
    importance,
    lastAccess: messages[messages.length - 1]._creationTime,
    data: {
      type: 'conversation',
      conversationId,
      playerIds: [...authors],
      participants: otherPlayer.globalIdentity
        ? [{ ...otherPlayer.globalIdentity, name: otherPlayer.name }]
        : [],
    },
    embedding,
  });
  await reflectOnMemories(ctx, worldId, playerId);
  return description;
}

export const loadConversation = internalQuery({
  args: {
    worldId: v.id('worlds'),
    playerId,
    conversationId,
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`World ${args.worldId} not found`);
    }
    const player = world.players.find((p) => p.id === args.playerId);
    if (!player) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (!playerDescription) {
      throw new Error(`Player description for ${args.playerId} not found`);
    }
    const conversation = await ctx.db
      .query('archivedConversations')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('id', args.conversationId))
      .first();
    if (!conversation) {
      throw new Error(`Conversation ${args.conversationId} not found`);
    }
    const otherParticipator = await ctx.db
      .query('participatedTogether')
      .withIndex('conversation', (q) =>
        q
          .eq('worldId', args.worldId)
          .eq('player1', args.playerId)
          .eq('conversationId', args.conversationId),
      )
      .first();
    if (!otherParticipator) {
      throw new Error(
        `Couldn't find other participant in conversation ${args.conversationId} with player ${args.playerId}`,
      );
    }
    const otherPlayerId = otherParticipator.player2;
    let otherPlayer: SerializedPlayer | Doc<'archivedPlayers'> | null =
      world.players.find((p) => p.id === otherPlayerId) ?? null;
    if (!otherPlayer) {
      otherPlayer = await ctx.db
        .query('archivedPlayers')
        .withIndex('worldId', (q) => q.eq('worldId', world._id).eq('id', otherPlayerId))
        .first();
    }
    if (!otherPlayer) {
      throw new Error(`Conversation ${args.conversationId} other player not found`);
    }
    const otherPlayerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', otherPlayerId))
      .first();
    if (!otherPlayerDescription) {
      throw new Error(`Player description for ${otherPlayerId} not found`);
    }
    const otherBinding = await ctx.db
      .query('residentModelBindings')
      .withIndex('resident', (q) => q.eq('worldId', args.worldId).eq('playerId', otherPlayerId))
      .unique();
    const localIdentity = await ctx.db.query('federationIdentity').unique();
    const globalIdentity = otherPlayer.remoteVisitor
      ? {
          agentGlobalId: otherPlayer.remoteVisitor.agentGlobalId,
          homeTownId: otherPlayer.remoteVisitor.homeTownId,
        }
      : otherBinding?.agentGlobalId && localIdentity
        ? {
            agentGlobalId: otherBinding.agentGlobalId,
            homeTownId: localIdentity.townId,
          }
        : undefined;
    return {
      player: { ...player, name: playerDescription.name },
      conversation,
      otherPlayer: { ...otherPlayer, name: otherPlayerDescription.name, globalIdentity },
    };
  },
});

export async function searchMemories(
  ctx: ActionCtx,
  playerId: GameId<'players'>,
  searchEmbedding: number[],
  n: number = 3,
  worldId?: Id<'worlds'>,
  spaceId?: Id<'embeddingSpaces'>,
) {
  if (!worldId) throw new Error('MEMORY_WORLD_REQUIRED');
  const route = spaceId
    ? await ctx.runQuery(internal.models.embeddings.getRoute, { spaceId })
    : await activeRoute(ctx);
  validateVector(searchEmbedding, route.profile.dimensions);
  const vectors = await ctx.runQuery(selfInternal.getSpaceVectors, {
    worldId,
    playerId,
    spaceId: route.space._id,
  });
  const candidates = vectors
    .map((vector) => ({
      memoryId: vector.memoryId,
      _score: cosineSimilarity(searchEmbedding, vector.embedding),
    }))
    .sort((a, b) => b._score - a._score)
    .slice(0, n * MEMORY_OVERFETCH);
  const ranked = await ctx.runMutation(selfInternal.rankSpaceMemories, {
    candidates,
    n,
    worldId,
    playerId,
  });
  return ranked;
}
export const getSpaceVectors = internalQuery({
  args: { worldId: v.id('worlds'), playerId, spaceId: v.id('embeddingSpaces') },
  handler: async (ctx, args) => {
    const vectors = await ctx.db
      .query('modelMemoryVectors')
      .withIndex('resident_space', (q) =>
        q.eq('worldId', args.worldId).eq('playerId', args.playerId).eq('spaceId', args.spaceId),
      )
      .take(2001);
    if (vectors.length > 2000)
      throw new Error('MEMORY_VECTOR_BUDGET_EXCEEDED: archive or increase the search budget');
    return vectors;
  },
});
export const rankSpaceMemories = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    n: v.number(),
    candidates: v.array(v.object({ memoryId: v.id('memories'), _score: v.number() })),
  },
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.n) || args.n < 1 || args.n > 100)
      throw new Error('INVALID_MEMORY_SEARCH_LIMIT');
    const now = Date.now();
    const rows = [];
    for (const candidate of args.candidates) {
      const memory = await ctx.db.get(candidate.memoryId);
      if (!memory || memory.worldId !== args.worldId || memory.playerId !== args.playerId)
        throw new Error('MEMORY_OWNER_MISMATCH');
      rows.push({
        ...candidate,
        memory,
        recency: 0.99 ** Math.floor((now - memory.lastAccess) / 3600000),
      });
    }
    if (!rows.length) {
      // Text survives reindexing and provider outages; keep recent facts available while vectors catch up.
      return await ctx.db
        .query('memories')
        .withIndex('resident', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
        .order('desc')
        .take(args.n);
    }
    const relevanceRange = makeRange(rows.map((r) => r._score));
    const importanceRange = makeRange(rows.map((r) => r.memory.importance));
    const recencyRange = makeRange(rows.map((r) => r.recency));
    rows.sort(
      (a, b) =>
        normalize(b._score, relevanceRange) +
        normalize(b.memory.importance, importanceRange) +
        normalize(b.recency, recencyRange) -
        (normalize(a._score, relevanceRange) +
          normalize(a.memory.importance, importanceRange) +
          normalize(a.recency, recencyRange)),
    );
    const selected = rows.slice(0, args.n);
    for (const { memory } of selected)
      if (memory.lastAccess < now - MEMORY_ACCESS_THROTTLE)
        await ctx.db.patch(memory._id, { lastAccess: now });
    return selected.map((r) => r.memory);
  },
});

function makeRange(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return [min, max] as const;
}

function normalize(value: number, range: readonly [number, number]) {
  const [min, max] = range;
  return max === min ? 0 : (value - min) / (max - min);
}

export const rankAndTouchMemories = internalMutation({
  args: {
    candidates: v.array(v.object({ _id: v.id('memoryEmbeddings'), _score: v.number() })),
    n: v.number(),
  },
  handler: async (ctx, args) => {
    const ts = Date.now();
    const relatedMemories = await asyncMap(args.candidates, async ({ _id }) => {
      const memory = await ctx.db
        .query('memories')
        .withIndex('embeddingId', (q) => q.eq('embeddingId', _id))
        .first();
      if (!memory) throw new Error(`Memory for embedding ${_id} not found`);
      return memory;
    });

    // TODO: fetch <count> recent memories and <count> important memories
    // so we don't miss them in case they were a little less relevant.
    const recencyScore = relatedMemories.map((memory) => {
      const hoursSinceAccess = (ts - memory.lastAccess) / 1000 / 60 / 60;
      return 0.99 ** Math.floor(hoursSinceAccess);
    });
    const relevanceRange = makeRange(args.candidates.map((c) => c._score));
    const importanceRange = makeRange(relatedMemories.map((m) => m.importance));
    const recencyRange = makeRange(recencyScore);
    const memoryScores = relatedMemories.map((memory, idx) => ({
      memory,
      overallScore:
        normalize(args.candidates[idx]._score, relevanceRange) +
        normalize(memory.importance, importanceRange) +
        normalize(recencyScore[idx], recencyRange),
    }));
    memoryScores.sort((a, b) => b.overallScore - a.overallScore);
    const accessed = memoryScores.slice(0, args.n);
    await asyncMap(accessed, async ({ memory }) => {
      if (memory.lastAccess < ts - MEMORY_ACCESS_THROTTLE) {
        await ctx.db.patch(memory._id, { lastAccess: ts });
      }
    });
    return accessed;
  },
});

export const loadMessages = internalQuery({
  args: {
    worldId: v.id('worlds'),
    conversationId,
  },
  handler: async (ctx, args): Promise<Doc<'messages'>[]> => {
    const messages = await ctx.db
      .query('messages')
      .withIndex('conversationId', (q) =>
        q.eq('worldId', args.worldId).eq('conversationId', args.conversationId),
      )
      .collect();
    return messages;
  },
});

async function calculateImportance(description: string, config: ChatConfig) {
  const { content: importanceRaw } = await chatCompletion(
    {
      messages: [
        {
          role: 'user',
          content: `On the scale of 0 to 9, where 0 is purely mundane (e.g., brushing teeth, making bed) and 9 is extremely poignant (e.g., a break up, college acceptance), rate the likely poignancy of the following piece of memory.
      Memory: ${description}
      Answer on a scale of 0 to 9. Respond with number only, e.g. "5"`,
        },
      ],
      temperature: 0.0,
      max_tokens: 1,
    },
    config,
  );

  let importance = parseFloat(importanceRaw);
  if (isNaN(importance)) {
    importance = +(importanceRaw.match(/\d+/)?.[0] ?? NaN);
  }
  if (isNaN(importance)) {
    console.debug('Could not parse memory importance from: ', importanceRaw);
    importance = 5;
  }
  return Math.min(9, Math.max(0, importance));
}

const { embeddingId: _embeddingId, ...memoryFieldsWithoutEmbeddingId } = memoryFields;

export const insertMemory = internalMutation({
  args: {
    agentId,
    embedding: v.array(v.float64()),
    ...memoryFieldsWithoutEmbeddingId,
  },
  handler: async (ctx, { agentId: _, embedding, ...memory }): Promise<void> => {
    if (!memory.worldId) throw new Error('MEMORY_WORLD_REQUIRED');
    const spaceId = memory.embeddingSpaceId ?? (await ensureEmbeddingSpace(ctx));
    const space = await ctx.db.get(spaceId);
    const profile = space && (await ctx.db.get(space.profileId));
    if (!profile) throw new Error('EMBEDDING_SPACE_NOT_FOUND');
    validateVector(embedding, profile.dimensions);
    const binding = await ctx.db
      .query('residentModelBindings')
      .withIndex('resident', (q) =>
        q.eq('worldId', memory.worldId!).eq('playerId', memory.playerId),
      )
      .unique();
    const memoryId = await ctx.db.insert('memories', {
      ...memory,
      agentGlobalId: binding?.agentGlobalId,
      embeddingSpaceId: spaceId,
    });
    await ctx.db.insert('modelMemoryVectors', {
      memoryId,
      spaceId,
      worldId: memory.worldId,
      playerId: memory.playerId,
      agentGlobalId: binding?.agentGlobalId,
      embedding,
    });
    await ctx.scheduler.runAfter(0, internal.models.embeddings.indexMemory, { memoryId });
  },
});

export const insertReflectionMemories = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    embeddingSpaceId: v.id('embeddingSpaces'),
    reflections: v.array(
      v.object({
        description: v.string(),
        relatedMemoryIds: v.array(v.id('memories')),
        importance: v.number(),
        embedding: v.array(v.float64()),
      }),
    ),
  },
  handler: async (ctx, { worldId, playerId, embeddingSpaceId, reflections }) => {
    const space = await ctx.db.get(embeddingSpaceId);
    const profile = space && (await ctx.db.get(space.profileId));
    if (!profile) throw new Error('EMBEDDING_SPACE_NOT_FOUND');
    const binding = await ctx.db
      .query('residentModelBindings')
      .withIndex('resident', (q) => q.eq('worldId', worldId).eq('playerId', playerId))
      .unique();
    for (const { embedding, relatedMemoryIds, ...rest } of reflections) {
      validateVector(embedding, profile.dimensions);
      const memoryId = await ctx.db.insert('memories', {
        worldId,
        playerId,
        agentGlobalId: binding?.agentGlobalId,
        embeddingSpaceId,
        lastAccess: Date.now(),
        ...rest,
        data: { type: 'reflection', relatedMemoryIds },
      });
      await ctx.db.insert('modelMemoryVectors', {
        memoryId,
        spaceId: embeddingSpaceId,
        worldId,
        playerId,
        agentGlobalId: binding?.agentGlobalId,
        embedding,
      });
      await ctx.scheduler.runAfter(0, internal.models.embeddings.indexMemory, { memoryId });
    }
  },
});

async function reflectOnMemories(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  playerId: GameId<'players'>,
) {
  const { memories, lastReflectionTs, name } = await ctx.runQuery(
    internal.agent.memory.getReflectionMemories,
    {
      worldId,
      playerId,
      numberOfItems: 100,
    },
  );

  // should only reflect if lastest 100 items have importance score of >500
  const sumOfImportanceScore = memories
    .filter((m) => m._creationTime > (lastReflectionTs ?? 0))
    .reduce((acc, curr) => acc + curr.importance, 0);
  const shouldReflect = sumOfImportanceScore > 500;

  if (!shouldReflect) {
    return false;
  }
  console.debug('sum of importance score = ', sumOfImportanceScore);
  console.debug('Reflecting...');
  const prompt = ['[no prose]', '[Output only JSON]', `You are ${name}, statements about you:`];
  memories.forEach((m, idx) => {
    prompt.push(`Statement ${idx}: ${m.description}`);
  });
  prompt.push('What 3 high-level insights can you infer from the above statements?');
  prompt.push(
    'Return in JSON format, where the key is a list of input statements that contributed to your insights and value is your insight. Make the response parseable by Typescript JSON.parse() function. DO NOT escape characters or include "\n" or white space in response.',
  );
  prompt.push(
    'Example: [{insight: "...", statementIds: [1,2]}, {insight: "...", statementIds: [1]}, ...]',
  );

  const chatConfig = await chatConfigForResident(ctx, worldId, playerId);
  const route = await activeRoute(ctx);
  const { content: reflection } = await chatCompletion(
    {
      messages: [
        {
          role: 'user',
          content: prompt.join('\n'),
        },
      ],
    },
    chatConfig,
  );

  try {
    const insights = JSON.parse(reflection) as { insight: string; statementIds: number[] }[];
    const memoriesToSave = await asyncMap(insights, async (item) => {
      const relatedMemoryIds = item.statementIds.map((idx: number) => memories[idx]._id);
      const importance = await calculateImportance(item.insight, chatConfig);
      const embedding = await embeddingsCache.fetch(ctx, item.insight, {
        route,
        inputMode: 'document',
      });
      console.debug('adding reflection memory...', item.insight);
      return {
        description: item.insight,
        embedding,
        importance,
        relatedMemoryIds,
      };
    });

    await ctx.runMutation(selfInternal.insertReflectionMemories, {
      worldId,
      playerId,
      reflections: memoriesToSave,
      embeddingSpaceId: route.space._id,
    });
  } catch (e) {
    console.error('error saving or parsing reflection', e);
    console.debug('reflection', reflection);
    return false;
  }
  return true;
}
export const getReflectionMemories = internalQuery({
  args: { worldId: v.id('worlds'), playerId, numberOfItems: v.number() },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`World ${args.worldId} not found`);
    }
    const player = world.players.find((p) => p.id === args.playerId);
    if (!player) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (!playerDescription) {
      throw new Error(`Player description for ${args.playerId} not found`);
    }
    const memories = await ctx.db
      .query('memories')
      .withIndex('resident', (q) => q.eq('worldId', args.worldId).eq('playerId', player.id))
      .order('desc')
      .take(args.numberOfItems);

    const lastReflection = await ctx.db
      .query('memories')
      .withIndex('resident', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .filter((q) => q.eq(q.field('data.type'), 'reflection'))
      .order('desc')
      .first();

    return {
      name: playerDescription.name,
      memories,
      lastReflectionTs: lastReflection?._creationTime,
    };
  },
});

export async function latestMemoryOfType<T extends MemoryType>(
  db: DatabaseReader,
  playerId: GameId<'players'>,
  type: T,
) {
  const entry = await db
    .query('memories')
    .withIndex('playerId_type', (q) => q.eq('playerId', playerId).eq('data.type', type))
    .order('desc')
    .first();
  if (!entry) return null;
  return entry as MemoryOfType<T>;
}
