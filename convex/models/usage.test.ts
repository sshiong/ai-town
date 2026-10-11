import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { profileChatConfig } from './profiles';
import { residentChatCompletion } from '../federation/resources';
import { fetchBatch } from '../agent/embeddingsCache';
import { providerUsageKey, trackedModelCall } from './usage';
import { validateProviderQuotaPortable } from './usageSchema';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../models/profiles.ts': () => import('./profiles'),
  '../models/profileLifecycle.ts': () => import('./profileLifecycle'),
  '../models/usage.ts': () => import('./usage'),
  '../models/embeddings.ts': () => import('./embeddings'),
  '../agent/embeddingsCache.ts': () => import('../agent/embeddingsCache'),
  '../federation/resources.ts': () => import('../federation/resources'),
};
const mutation = (name: string) => makeFunctionReference<'mutation'>(`models/${name.replace('/', ':')}`);
const query = (name: string) => makeFunctionReference<'query'>(`models/${name.replace('/', ':')}`);
const adminToken = 'model-management-test-admin-token';
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1700000000000); process.env.FEDERATION_ADMIN_TOKEN = adminToken; });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
async function setup() {
  const t = convexTest(schema, modules);
  const worldId = await t.run(ctx => ctx.db.insert('worlds', { nextId: 2, agents: [], players: [], conversations: [] }));
  const create = async (name: string): Promise<Id<'chatProfiles'>> => t.mutation(mutation('profiles/saveChatProfile'), {
    adminToken, name, provider: 'custom', url: 'https://same-provider.example', model: name,
  });
  const first = await create('first'), second = await create('second');
  const bindingId = await t.run(async ctx => {
    const settings = (await ctx.db.query('modelSettings').unique())!;
    await ctx.db.patch(settings._id, { mainChatProfileId: second });
    return ctx.db.insert('residentModelBindings', { worldId, playerId: 'p:0', agentGlobalId: 'town/agent:0',
      chatProfileId: first, createdAt: Date.now(), updatedAt: Date.now() });
  });
  return { t, worldId, first, second, bindingId };
}
test('main and binding references prevent deletion; disabling requires a fresh affected-resident review without rebinding', async () => {
  const { t, first, second, bindingId } = await setup();
  const lifecycle = { adminToken, reason: 'Administrator pauses this model' };
  await expect(t.mutation(mutation('profileLifecycle/setEnabled'), { ...lifecycle, profileId: second, enabled: false, affectedBindingIds: [] }))
    .rejects.toThrow('CHANGE_MAIN_BEFORE_DISABLING_PROFILE');
  await expect(t.mutation(mutation('profileLifecycle/remove'), { ...lifecycle, profileId: second }))
    .rejects.toThrow('CHANGE_MAIN_BEFORE_DELETING_PROFILE');
  await expect(t.mutation(mutation('profileLifecycle/remove'), { ...lifecycle, profileId: first }))
    .rejects.toThrow('CHAT_PROFILE_REFERENCED_BY_RESIDENTS');
  await expect(t.mutation(mutation('profileLifecycle/setEnabled'), { ...lifecycle, profileId: first, enabled: false, affectedBindingIds: [] }))
    .rejects.toThrow('REVIEW_AFFECTED_RESIDENTS_AGAIN');
  await t.mutation(mutation('profileLifecycle/setEnabled'), { ...lifecycle, profileId: first, enabled: false, affectedBindingIds: [bindingId] });
  const listing = await t.query(api.models.profiles.list, { adminToken });
  expect(listing.affectedResidents).toMatchObject([{ _id: bindingId, chatProfileId: first, name: 'p:0' }]);
  expect((await t.run(ctx => ctx.db.get(bindingId)))?.chatProfileId).toBe(first);
  expect(() => profileChatConfig(listing.chatProfiles.find(row => row._id === first)!)).toThrow('BOUND_CHAT_PROFILE_DISABLED');
  const blocked = jest.fn(async () => ({ retries: 0 }));
  await expect(t.action(ctx => trackedModelCall(ctx, 'CHAT', { profileId: first }, blocked, () => undefined)))
    .rejects.toThrow('MODEL_PROFILE_DISABLED');
  expect(blocked).not.toHaveBeenCalled();
  await t.mutation(mutation('profileLifecycle/setEnabled'), { ...lifecycle, profileId: first, enabled: true, affectedBindingIds: [] });
  expect((await t.run(ctx => ctx.db.get(first)))?.disabled).toBe(false);
});
test('embedding lifecycle protects active/building spaces and every retained rollback reference', async () => {
  const { t } = await setup();
  const profileId = await t.mutation(mutation('embeddings/saveEmbeddingProfile'), {
    adminToken, name: 'embedding', provider: 'custom', url: 'https://embed.example', model: 'embed', dimensions: 2,
  });
  const spaceId = await t.run(ctx => ctx.db.insert('embeddingSpaces', { profileId, fingerprint: 'fixture', status: 'BUILDING', createdAt: Date.now() }));
  const request = { adminToken, profileId, reason: 'Administrator reviews references' };
  await expect(t.mutation(mutation('profileLifecycle/setEnabled'), { ...request, enabled: false, affectedBindingIds: [] }))
    .rejects.toThrow('EMBEDDING_PROFILE_ACTIVE_OR_BUILDING');
  await t.run(ctx => ctx.db.patch(spaceId, { status: 'RETIRED' }));
  await expect(t.mutation(mutation('profileLifecycle/remove'), request)).rejects.toThrow('EMBEDDING_PROFILE_REFERENCED_BY_SPACES');
  await t.mutation(mutation('profileLifecycle/setEnabled'), { ...request, enabled: false, affectedBindingIds: [] });
  await expect(t.query(query('embeddings/getRoute'), { spaceId })).rejects.toThrow('EMBEDDING_PROFILE_DISABLED');
  expect(await t.run(ctx => ctx.db.get(spaceId))).not.toBeNull();
});
test('provider/profile/resident quotas share atomic starts and quota edits do not replenish usage', async () => {
  const { t, first, second, worldId, bindingId } = await setup();
  const providerKey = providerUsageKey((await t.run(ctx => ctx.db.get(first)))!);
  await t.mutation(mutation('usage/configureProviderQuota'), { adminToken, kind: 'CHAT', providerKey, maxRequestsPerDay: 1, reason: 'Limit provider usage' });
  const request = { kind: 'CHAT' as const, profileId: first, worldId, playerId: 'p:0' };
  const [a, b] = await Promise.all([t.mutation(mutation('usage/startCall'), request), t.mutation(mutation('usage/startCall'), { ...request, profileId: second })]);
  expect([a, b].filter(row => row.callId)).toHaveLength(1);
  await t.mutation(mutation('usage/configureProviderQuota'), { adminToken, kind: 'CHAT', providerKey, maxRequestsPerDay: 1, reason: 'Repeat save' });
  expect(await t.mutation(mutation('usage/startCall'), request)).toMatchObject({ callId: null, deniedReason: 'MODEL_PROVIDER_DAILY_QUOTA_EXCEEDED' });
  await t.mutation(mutation('usage/configureProviderQuota'), { adminToken, kind: 'CHAT', providerKey, maxRequestsPerDay: null, reason: 'Remove provider limit' });
  await t.mutation(mutation('usage/configureProfileQuota'), { adminToken, profileId: second, maxRequestsPerDay: 0, reason: 'Pause second profile' });
  expect(await t.mutation(mutation('usage/startCall'), { ...request, profileId: second })).toMatchObject({ deniedReason: 'MODEL_PROFILE_DAILY_QUOTA_EXCEEDED' });
  await t.mutation(mutation('usage/configureResidentQuota'), { adminToken, bindingId, quotas: { chat: 0, embedding: 5 }, reason: 'Pause resident chat' });
  expect(await t.mutation(mutation('usage/startCall'), request)).toMatchObject({ deniedReason: 'MODEL_RESIDENT_DAILY_QUOTA_EXCEEDED' });
  const stats = await t.query(api.models.usage.summary, { adminToken });
  expect(stats.buckets.find(row => row.dimension === 'PROVIDER')?.started).toBe(1);
  expect(stats.buckets.find(row => row.dimension === 'PROVIDER')?.denied).toBe(4);
});
test('real request responses record reported tokens, missing tokens, sanitized failures and idempotent completion', async () => {
  const { t, first, worldId } = await setup();
  const profile = (await t.run(ctx => ctx.db.get(first)))!;
  const config = { ...profileChatConfig(profile), modelUsage: { profileId: first, worldId, playerId: 'p:0' } };
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 9 } })));
  await t.action(ctx => residentChatCompletion(ctx, { messages: [{ role: 'user', content: 'private-memory-sentinel' }] }, config));
  fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
  await t.action(ctx => residentChatCompletion(ctx, { messages: [{ role: 'user', content: 'private-memory-sentinel' }] }, config));
  await expect(t.action(ctx => trackedModelCall(ctx, 'CHAT', config.modelUsage,
    async () => { throw new Error('private-api-key-sentinel private-memory-sentinel'); }, () => undefined)))
    .rejects.toThrow('private-api-key-sentinel');
  const receipt = (await t.run(ctx => ctx.db.query('modelCallReceipts').collect()))[0];
  await t.mutation(mutation('usage/finishCall'), { callId: receipt._id, ok: true, totalTokens: 9 });
  const stats = await t.query(api.models.usage.summary, { adminToken });
  for (const row of stats.buckets) expect(row).toMatchObject({ started: 3, succeeded: 2, failed: 1,
    totalTokens: 9, reportedTokenCalls: 1, unknownTokenCalls: 2, unfinished: 0 });
  expect(stats.failures).toMatchObject([{ errorCode: 'PROVIDER_FAILURE' }]);
  expect(JSON.stringify(stats)).not.toMatch(/private-api-key-sentinel|private-memory-sentinel/);
});
test('cache hits do not invoke a provider or consume quota; missing usage stays null', async () => {
  const { t, worldId } = await setup();
  const route = await t.run(async ctx => {
    const profileId = await ctx.db.insert('embeddingProfiles', { name: 'embedding', provider: 'custom', url: 'https://embed.example', model: 'embed',
      dimensions: 2, preprocessingRevision: 'newline-to-space-v1', queryPrefix: '', documentPrefix: '', normalization: 'none', fingerprint: 'fixture', createdAt: Date.now() });
    const spaceId = await ctx.db.insert('embeddingSpaces', { profileId, fingerprint: 'fixture', status: 'ACTIVE', createdAt: Date.now() });
    return { profile: (await ctx.db.get(profileId))!, space: (await ctx.db.get(spaceId))! };
  });
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
  const options = { route, owner: { worldId, playerId: 'p:0' } };
  await t.action(ctx => fetchBatch(ctx, ['private-memory-sentinel'], options));
  await t.mutation(mutation('usage/configureProfileQuota'), { adminToken, profileId: route.profile._id, maxRequestsPerDay: 0, reason: 'Pause misses' });
  expect((await t.action(ctx => fetchBatch(ctx, ['private-memory-sentinel'], options))).hits).toBe(1);
  expect(spy).toHaveBeenCalledTimes(1);
  const stats = await t.query(api.models.usage.summary, { adminToken });
  expect(stats.buckets.every(row => row.kind === 'EMBEDDING' && row.started === 1 && row.totalTokens === null && row.unknownTokenCalls === 1)).toBe(true);
});
test('failed provider responses cannot expose echoed credentials or memory through admin errors and retry usage stays unknown', async () => {
  const { t, first } = await setup();
  const profile = (await t.run(ctx => ctx.db.get(first)))!;
  jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('private-api-key-sentinel private-memory-sentinel', { status: 400 }));
  await expect(t.action(ctx => residentChatCompletion(ctx, { messages: [{ role: 'user', content: 'private-memory-sentinel' }] }, profileChatConfig(profile))))
    .rejects.toThrow(/^Chat completion failed with code 400$/);
  await t.action(ctx => trackedModelCall(ctx, 'CHAT', { profileId: first }, async () => ({ retries: 2, tokens: 4 }), result => result.tokens));
  const stats = await t.query(api.models.usage.summary, { adminToken });
  expect(stats.buckets.find(row => row.dimension === 'PROFILE')).toMatchObject({ started: 2, succeeded: 1, failed: 1,
    totalTokens: 4, reportedTokenCalls: 1, unknownTokenCalls: 2, retries: 2 });
  expect(JSON.stringify(stats)).not.toMatch(/private-api-key-sentinel|private-memory-sentinel/);
});
test('portable quota validation rejects invalid ranges and authentication protects all management writes', async () => {
  const { t, first } = await setup();
  for (const value of [-1, 1.5, 1000001, NaN]) {
    expect(() => validateProviderQuotaPortable({ kind: 'CHAT', providerKey: '["custom","https://provider.example"]', maxRequestsPerDay: value, updatedAt: Date.now() }))
      .toThrow('INVALID_MODEL_REQUEST_QUOTA');
    await expect(t.mutation(mutation('usage/configureProfileQuota'), { adminToken, profileId: first, maxRequestsPerDay: value, reason: 'invalid' }))
      .rejects.toThrow('INVALID_MODEL_REQUEST_QUOTA');
  }
  await expect(t.mutation(mutation('profileLifecycle/remove'), { adminToken: 'invalid', profileId: first, reason: 'unauthorized' }))
    .rejects.toThrow();
  await expect(t.query(query('usage/summary'), { adminToken: 'invalid' })).rejects.toThrow();
});

test('unreferenced profile deletion is audited with administrator role and never rewrites main or resident bindings', async () => {
  const { t, second, bindingId, first } = await setup();
  const disposable = await t.mutation(api.models.profiles.saveChatProfile, {
    adminToken, name: 'Unused', provider: 'custom', url: 'https://unused.example', model: 'unused',
  });
  await t.mutation(api.models.profileLifecycle.remove, { adminToken, profileId: disposable, reason: 'Remove unused connection' });
  expect(await t.run(ctx => ctx.db.get(disposable))).toBeNull();
  expect((await t.run(ctx => ctx.db.get(bindingId)))?.chatProfileId).toBe(first);
  expect((await t.run(ctx => ctx.db.query('modelSettings').unique()))?.mainChatProfileId).toBe(second);
  expect(await t.run(ctx => ctx.db.query('modelAudits').filter(q => q.eq(q.field('operation'), 'DELETE_MODEL_PROFILE')).unique()))
    .toMatchObject({ actor: 'FEDERATION_ADMIN', subject: disposable, reason: 'Remove unused connection', at: Date.now() });
});
test('daily quota resets at UTC midnight and Chat quotas are independent of Embedding', async () => {
  const { t, first } = await setup();
  const profile = (await t.run(ctx => ctx.db.get(first)))!;
  const providerKey = providerUsageKey(profile);
  await t.mutation(api.models.usage.configureProviderQuota, { adminToken, kind: 'CHAT', providerKey, maxRequestsPerDay: 1, reason: 'One chat request per UTC day' });
  const before = await t.mutation(internal.models.usage.startCall, { kind: 'CHAT', profileId: first });
  expect(before.callId).not.toBeNull();
  expect(await t.mutation(internal.models.usage.startCall, { kind: 'CHAT', profileId: first })).toMatchObject({ callId: null });
  const embeddingProfileId = await t.mutation(api.models.embeddings.saveEmbeddingProfile, {
    adminToken, name: 'Independent embeddings', provider: 'custom', url: profile.url, model: 'embed', dimensions: 2,
  });
  expect((await t.mutation(internal.models.usage.startCall, { kind: 'EMBEDDING', profileId: embeddingProfileId })).callId).not.toBeNull();
  jest.setSystemTime(Math.floor(Date.now() / 86400000) * 86400000 + 86400000);
  expect((await t.mutation(internal.models.usage.startCall, { kind: 'CHAT', profileId: first })).callId).not.toBeNull();
  await t.mutation(internal.models.usage.finishCall, { callId: before.callId!, ok: true, totalTokens: 5 });
  const rows = await t.run(ctx => ctx.db.query('modelUsageBuckets').collect());
  expect(rows.filter(row => row.kind === 'CHAT' && row.dimension === 'PROVIDER').map(row => row.started)).toEqual([1, 1]);
  const current = await t.query(api.models.usage.summary, { adminToken });
  expect(current.buckets.every(row => row.succeeded === 0 && row.totalTokens === null && row.unfinished === 1)).toBe(true);
});
