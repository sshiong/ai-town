import { v } from 'convex/values';
import {
  ActionCtx,
  MutationCtx,
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from '../maintenanceFunctions';
import { internal } from '../_generated/api';
import { Doc, Id } from '../_generated/dataModel';
import { GameId, parseGameId, playerId } from '../aiTown/ids';
import { assertFederationAdmin } from '../federation/auth';
import { ChatConfig, chatCompletion, getChatConfig } from '../util/llm';
import { chatOptions, connectionFields } from './schema';

export function validateConnection(profile: {
  name: string;
  url: string;
  model: string;
  apiKeyEnv?: string;
}) {
  if (
    !profile.name.trim() ||
    profile.name.length > 120 ||
    !profile.model.trim() ||
    profile.model.length > 256
  )
    throw new Error('INVALID_MODEL_PROFILE');
  const url = new URL(profile.url);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('INVALID_MODEL_URL');
  if (profile.apiKeyEnv && !/^[A-Z][A-Z0-9_]{0,127}$/.test(profile.apiKeyEnv))
    throw new Error('INVALID_CREDENTIAL_REFERENCE');
}
export async function settings(ctx: { db: import('../maintenanceFunctions').DatabaseReader }) {
  return await ctx.db
    .query('modelSettings')
    .withIndex('key', (q) => q.eq('key', 'town'))
    .unique();
}
async function chatProfileHealth(ctx: { db: import('../maintenanceFunctions').DatabaseReader }, id: Id<'chatProfiles'>) {
  return await ctx.db.query('modelAudits').filter(q => q.and(
    q.eq(q.field('subject'), id),
    q.or(q.eq(q.field('operation'), 'PROBE_CHAT_SUCCESS'), q.eq(q.field('operation'), 'PROBE_CHAT_FAILED')),
  )).order('desc').first();
}
export async function audit(
  ctx: MutationCtx,
  operation: string,
  subject: string,
  next: string,
  reason: string,
  previous?: string,
) {
  await ctx.db.insert('modelAudits', {
    operation,
    subject,
    next,
    reason,
    previous,
    at: Date.now(),
  });
}
export const saveChatProfile = mutation({
  args: {
    adminToken: v.string(),
    ...connectionFields,
    ...chatOptions,
    stopWords: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { adminToken, stopWords, ...profile }): Promise<Id<'chatProfiles'>> => {
    assertFederationAdmin(adminToken);
    validateConnection(profile);
    if (stopWords && (stopWords.length > 16 || stopWords.some((word) => word.length > 200)))
      throw new Error('INVALID_STOP_WORDS');
    const id = await ctx.db.insert('chatProfiles', {
      ...profile,
      url: profile.url.replace(/\/$/, ''),
      stopWords: stopWords ?? [],
      createdAt: Date.now(),
    });
    if (!(await settings(ctx))) await ctx.db.insert('modelSettings', { key: 'town' });
    await audit(ctx, 'CREATE_CHAT_PROFILE', id, id, 'Administrator saved profile');
    return id;
  },
});
export const setMain = mutation({
  args: { adminToken: v.string(), chatProfileId: v.id('chatProfiles') },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    if (!(await ctx.db.get(args.chatProfileId))) throw new Error('CHAT_PROFILE_NOT_FOUND');
    const health = await chatProfileHealth(ctx, args.chatProfileId);
    if (health?.operation !== 'PROBE_CHAT_SUCCESS') throw new Error('CHAT_PROFILE_NOT_VALIDATED');
    const config = await settings(ctx);
    if (config) await ctx.db.patch(config._id, { mainChatProfileId: args.chatProfileId });
    else
      await ctx.db.insert('modelSettings', { key: 'town', mainChatProfileId: args.chatProfileId });
    await audit(
      ctx,
      'SET_MAIN',
      'main',
      args.chatProfileId,
      'New residents only',
      config?.mainChatProfileId,
    );
  },
});

function legacyCredentialEnv(provider: ChatConfig['provider']) {
  if (process.env.CHAT_API_KEY) return 'CHAT_API_KEY';
  const reference = {
    openai: 'OPENAI_API_KEY',
    together: 'TOGETHER_API_KEY',
    custom: 'LLM_API_KEY',
    ollama: undefined,
  }[provider];
  return reference && process.env[reference] ? reference : undefined;
}
export async function bindResident(
  ctx: MutationCtx,
  worldId: Id<'worlds'>,
  id: GameId<'players'>,
  agentGlobalId?: string,
): Promise<Id<'residentModelBindings'>> {
  const existing = await ctx.db
    .query('residentModelBindings')
    .withIndex('resident', (q) => q.eq('worldId', worldId).eq('playerId', id))
    .unique();
  if (existing) {
    if (agentGlobalId && existing.agentGlobalId && existing.agentGlobalId !== agentGlobalId)
      throw new Error('RESIDENT_GLOBAL_ID_CONFLICT');
    if (agentGlobalId && existing.agentGlobalId !== agentGlobalId)
      await ctx.db.patch(existing._id, { agentGlobalId });
    return existing._id;
  }
  const config = await settings(ctx);
  let chatProfileId = config?.mainChatProfileId;
  if (chatProfileId) {
    const main = await ctx.db.get(chatProfileId);
    if (!main) throw new Error('MAIN_CHAT_PROFILE_MISSING');
    const health = await chatProfileHealth(ctx, chatProfileId);
    if (health?.operation === 'PROBE_CHAT_FAILED' || (!main.legacy && health?.operation !== 'PROBE_CHAT_SUCCESS'))
      throw new Error('MAIN_CHAT_PROFILE_NOT_VALIDATED');
  }
  if (!chatProfileId) {
    const profiles = await ctx.db.query('chatProfiles').collect();
    if (profiles.some((p) => !p.legacy)) throw new Error('MAIN_CHAT_PROFILE_MISSING');
    chatProfileId = profiles.find((p) => p.legacy)?._id;
    if (!chatProfileId) {
      const chat = getChatConfig();
      chatProfileId = await ctx.db.insert('chatProfiles', {
        name: 'Original environment model',
        provider: chat.provider,
        url: chat.url,
        model: chat.chatModel,
        stopWords: chat.stopWords,
        apiKeyEnv: legacyCredentialEnv(chat.provider),
        createdAt: Date.now(),
        legacy: true,
      });
    }
  }
  if (!config)
    await ctx.db.insert('modelSettings', { key: 'town', mainChatProfileId: chatProfileId });
  else if (!config.mainChatProfileId)
    await ctx.db.patch(config._id, { mainChatProfileId: chatProfileId });
  return await ctx.db.insert('residentModelBindings', {
    worldId,
    playerId: id,
    agentGlobalId,
    chatProfileId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}
export const ensureResidentBinding = internalMutation({
  args: { worldId: v.id('worlds'), playerId, agentGlobalId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Id<'residentModelBindings'>> =>
    bindResident(ctx, args.worldId, parseGameId('players', args.playerId), args.agentGlobalId),
});
export async function linkGlobalIdentity(
  ctx: MutationCtx,
  worldId: Id<'worlds'>,
  id: GameId<'players'>,
  agentGlobalId: string,
) {
  return bindResident(ctx, worldId, id, agentGlobalId);
}
export const setResidentChat = mutation({
  args: {
    adminToken: v.string(),
    worldId: v.id('worlds'),
    playerId,
    chatProfileId: v.id('chatProfiles'),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    if (!args.reason.trim() || args.reason.length > 1000) throw new Error('AUDIT_REASON_REQUIRED');
    if (!(await ctx.db.get(args.chatProfileId))) throw new Error('CHAT_PROFILE_NOT_FOUND');
    const bindingId = await bindResident(ctx, args.worldId, parseGameId('players', args.playerId));
    const binding = await ctx.db.get(bindingId);
    await ctx.db.patch(bindingId, { chatProfileId: args.chatProfileId, updatedAt: Date.now() });
    await audit(
      ctx,
      'SET_RESIDENT_CHAT',
      `${args.worldId}/${args.playerId}`,
      args.chatProfileId,
      args.reason,
      binding?.chatProfileId,
    );
  },
});
export const getResidentProfile = internalQuery({
  args: {
    worldId: v.optional(v.id('worlds')),
    playerId: v.optional(playerId),
    agentGlobalId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Doc<'chatProfiles'>> => {
    const binding = args.agentGlobalId
      ? await ctx.db
          .query('residentModelBindings')
          .withIndex('globalAgent', (q) => q.eq('agentGlobalId', args.agentGlobalId))
          .unique()
      : args.worldId && args.playerId
        ? await ctx.db
            .query('residentModelBindings')
            .withIndex('resident', (q) =>
              q.eq('worldId', args.worldId!).eq('playerId', args.playerId!),
            )
            .unique()
        : null;
    if (!binding) throw new Error('RESIDENT_MODEL_BINDING_MISSING');
    const profile = await ctx.db.get(binding.chatProfileId);
    if (!profile) throw new Error('BOUND_CHAT_PROFILE_MISSING');
    return profile;
  },
});
export function profileChatConfig(profile: Doc<'chatProfiles'>): ChatConfig {
  const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  if (profile.apiKeyEnv && !apiKey)
    throw new Error(`MODEL_CREDENTIAL_MISSING: ${profile.apiKeyEnv}`);
  return {
    provider: profile.provider,
    url: profile.url,
    chatModel: profile.model,
    stopWords: profile.stopWords,
    reasoningEffort: profile.reasoningEffort,
    apiKey,
  };
}
export async function chatConfigForResident(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  id: GameId<'players'>,
): Promise<ChatConfig> {
  await ctx.runMutation(internal.models.profiles.ensureResidentBinding, { worldId, playerId: id });
  return profileChatConfig(
    await ctx.runQuery(internal.models.profiles.getResidentProfile, { worldId, playerId: id }),
  );
}
export async function chatConfigForGlobalAgent(
  ctx: ActionCtx,
  agentGlobalId: string,
): Promise<ChatConfig> {
  return profileChatConfig(
    await ctx.runQuery(internal.models.profiles.getResidentProfile, { agentGlobalId }),
  );
}
export const list = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    const [chatProfiles, embeddingProfiles, embeddingSpaces, bindings, audits, config] =
      await Promise.all([
        ctx.db.query('chatProfiles').collect(),
        ctx.db.query('embeddingProfiles').collect(),
        ctx.db.query('embeddingSpaces').collect(),
        ctx.db.query('residentModelBindings').collect(),
        ctx.db.query('modelAudits').order('desc').take(100),
        settings(ctx),
      ]);
    return {
      chatProfiles: chatProfiles.map((p) => ({
        ...p,
        credentialAvailable: !p.apiKeyEnv || !!process.env[p.apiKeyEnv],
      })),
      embeddingProfiles: embeddingProfiles.map((p) => ({
        ...p,
        credentialAvailable: !p.apiKeyEnv || !!process.env[p.apiKeyEnv],
      })),
      embeddingSpaces,
      bindings,
      audits,
      settings: config,
    };
  },
});

export const profileById = internalQuery({
  args: { chatProfileId: v.id('chatProfiles') },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.chatProfileId);
    if (!profile) throw new Error('CHAT_PROFILE_NOT_FOUND');
    return profile;
  },
});
export const recordChatProbe = internalMutation({
  args: { chatProfileId: v.id('chatProfiles'), ok: v.boolean() },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.chatProfileId))) throw new Error('CHAT_PROFILE_NOT_FOUND');
    await audit(
      ctx,
      args.ok ? 'PROBE_CHAT_SUCCESS' : 'PROBE_CHAT_FAILED',
      args.chatProfileId,
      args.chatProfileId,
      args.ok ? 'Availability probe returned nonempty output' : 'Availability probe failed',
    );
    if (args.ok) {
      const config = await settings(ctx);
      if (!config?.mainChatProfileId) {
        if (config) await ctx.db.patch(config._id, { mainChatProfileId: args.chatProfileId });
        else await ctx.db.insert('modelSettings', { key: 'town', mainChatProfileId: args.chatProfileId });
        await audit(ctx, 'SET_MAIN', 'main', args.chatProfileId, 'First validated Chat Profile');
      }
    }
  },
});
export const probeChat = action({
  args: {
    adminToken: v.string(),
    chatProfileId: v.id('chatProfiles'),
    timeoutMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ ok: true; model: string; ms: number }> => {
    assertFederationAdmin(args.adminToken);
    const timeoutMs = args.timeoutMs ?? 90_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000)
      throw new Error('INVALID_CHAT_PROBE_TIMEOUT');
    const profile = await ctx.runQuery(internal.models.profiles.profileById, {
      chatProfileId: args.chatProfileId,
    });
    try {
      const response = await chatCompletion(
        { messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 256 },
        profileChatConfig(profile),
        { deadline: Date.now() + timeoutMs },
      );
      if (!response.content.trim()) throw new Error('EMPTY_CHAT_RESPONSE');
      await ctx.runMutation(internal.models.profiles.recordChatProbe, {
        chatProfileId: args.chatProfileId,
        ok: true,
      });
      return { ok: true, model: profile.model, ms: response.ms };
    } catch (error) {
      await ctx.runMutation(internal.models.profiles.recordChatProbe, {
        chatProfileId: args.chatProfileId,
        ok: false,
      });
      throw error;
    }
  },
});
