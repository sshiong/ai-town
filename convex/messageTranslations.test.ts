import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from './schema';
import type { Doc } from './_generated/dataModel';
import type { CreateChatCompletionRequest } from './util/llm';
import {
  scheduleNewMessageTranslation,
  translationSourceDigest,
  validateTranslationOutput,
} from './messageTranslations';
import { defaultStoragePolicy } from './federation/storagePolicy';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  './_generated/server.ts': () => import('./_generated/server'),
  './messageTranslations.ts': () => import('./messageTranslations'),
  './models/profiles.ts': () => import('./models/profiles'),
  './models/usage.ts': () => import('./models/usage'),
  './federation/resources.ts': () => import('./federation/resources'),
};
const mutation = (name: string) => makeFunctionReference<'mutation'>(`messageTranslations:${name}`);
const listRef = makeFunctionReference<'query'>('messageTranslations:list');
const pumpRef = makeFunctionReference<'action'>('messageTranslations:pump');
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1700000000000);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});
async function setup(text = 'Alice, let us meet at the bakery.') {
  const t = convexTest(schema, modules);
  const worldId = await t.run((ctx) =>
    ctx.db.insert('worlds', { nextId: 2, agents: [], players: [], conversations: [] }),
  );
  const profileId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('chatProfiles', {
      name: 'Current main model',
      model: 'current-main',
      provider: 'ollama',
      url: 'http://localhost:11434',
      stopWords: [],
      createdAt: Date.now(),
    });
    await ctx.db.insert('modelSettings', { key: 'town', mainChatProfileId: id });
    return id;
  });
  const messageId = await t.run((ctx) =>
    ctx.db.insert('messages', {
      worldId,
      conversationId: 'c:0',
      author: 'p:0',
      messageUuid: 'fixture-0',
      text,
    }),
  );
  const args = { worldId, conversationId: 'c:0', messageIds: [messageId] };
  const control = () => t.run((ctx) => ctx.db.query('messageTranslationWorker').unique());
  const rows = () => t.run((ctx) => ctx.db.query('messageTranslations').collect());
  const claim = async () =>
    t.mutation(mutation('claim'), {
      generation: (await control())!.generation,
    }) as Promise<Doc<'messageTranslations'> | null>;
  const pump = async () => t.action(pumpRef, { generation: (await control())!.generation });
  return { t, worldId, profileId, messageId, args, control, rows, claim, pump };
}
function mockCompletion(content: string, finish_reason: string | undefined = 'stop') {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content }, finish_reason }],
          usage: { total_tokens: 18 },
        }),
      ),
    ),
  );
}
test('bounded public API only accepts existing messages in the requested world/conversation', async () => {
  const { t, args, messageId, rows } = await setup();
  for (const invalid of [
    { ...args, conversationId: 'c:99' },
    { ...args, messageIds: [] },
    { ...args, messageIds: [messageId, messageId] },
    { ...args, messageIds: Array(21).fill(messageId) },
  ])
    await expect(t.mutation(mutation('request'), invalid)).rejects.toThrow();
  await expect(t.query(listRef, { ...args, conversationId: 'c:99' })).rejects.toThrow(
    'TRANSLATION_MESSAGE_MISMATCH',
  );
  expect(await rows()).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query('messageTranslationPreferences').collect())).toEqual([]);
});
test('translation uses the current main model, shared queue and usage; cache hits preserve canonical bytes', async () => {
  const { t, args, messageId, profileId, pump, rows } = await setup();
  const before = await t.run((ctx) => ctx.db.get(messageId));
  const fetch = mockCompletion('Alice，我们在面包店见面吧。');
  await t.mutation(mutation('request'), args);
  await t.mutation(mutation('request'), args);
  expect(await rows()).toHaveLength(1);
  await pump();
  expect(await t.query(listRef, args)).toMatchObject([
    { messageId, status: 'READY', translatedText: 'Alice，我们在面包店见面吧。' },
  ]);
  await t.mutation(mutation('request'), args);
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(fetch.mock.calls[0][1]!.body as string) as CreateChatCompletionRequest;
  expect(body).toMatchObject({ model: 'current-main', reasoning_effort: 'none', temperature: 0 });
  expect(body.max_tokens).toBeGreaterThanOrEqual(256);
  expect(body.max_tokens).toBeLessThanOrEqual(2048);
  expect(body.messages[0].content).toContain('untrusted text');
  expect(body.messages[1].content).toBe(JSON.stringify({ chatMessage: before!.text }));
  expect(await t.run((ctx) => ctx.db.get(messageId))).toEqual(before);
  expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
  const buckets = await t.run((ctx) => ctx.db.query('modelUsageBuckets').collect());
  expect(buckets.find((row) => row.dimension === 'PROFILE')).toMatchObject({
    started: 1,
    succeeded: 1,
    totalTokens: 18,
  });
  expect(await t.run((ctx) => ctx.db.query('modelCallReceipts').collect())).toMatchObject([
    { profileId, outcome: 'SUCCESS', finishedAt: Date.now() },
  ]);
  expect((await t.run((ctx) => ctx.db.get(profileId)))?.reasoningEffort).toBeUndefined();
});
test('Chinese text and punctuation are ready without a provider; oversized source is a permanent explicit failure', async () => {
  for (const text of ['Alice，你好。', '🙂!', 'x'.repeat(8193)]) {
    const { t, args, rows } = await setup(text);
    const fetch = mockCompletion('不应调用');
    await t.mutation(mutation('request'), args);
    const row = (await rows())[0];
    expect(row.state).toBe(text.length > 8192 ? 'FAILED' : 'READY');
    expect(row.retryAt).toBeUndefined();
    if (text.length > 8192)
      expect(row).toMatchObject({ errorCode: 'TRANSLATION_SOURCE_TOO_LARGE', sourceText: '' });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  }
});
test.each([
  ['你好，Alice。', 'length', 'TRANSLATION_INCOMPLETE'],
  ['Hello, Alice.', 'stop', 'TRANSLATION_NOT_CHINESE'],
  ['<think>思考</think>你好', 'stop', 'TRANSLATION_INVALID_OUTPUT'],
  ['你好', undefined, 'TRANSLATION_INCOMPLETE'],
])('invalid provider output is not ready: %s / %s', async (text, reason, errorCode) => {
  const { t, args, pump } = await setup();
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: text }, finish_reason: reason }] }),
      ),
    );
  await t.mutation(mutation('request'), args);
  await pump();
  expect(await t.query(listRef, args)).toMatchObject([
    { status: 'FAILED', errorCode, retryAt: Date.now() + 30_000 },
  ]);
  await t.mutation(mutation('request'), args);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('failures are sanitized, retry is explicit with exponential backoff, and three attempts terminate', async () => {
  const { t, args, rows, pump } = await setup();
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('secret-credential private-chat', { status: 400 }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    await t.mutation(mutation('request'), args);
    await pump();
    const row = (await rows())[0];
    expect(row).toMatchObject({
      state: 'FAILED',
      attempts: attempt,
      errorCode: 'TRANSLATION_PROVIDER_FAILED',
    });
    expect(JSON.stringify(row)).not.toMatch(/secret-credential|private-chat/);
    if (attempt < 3) {
      expect(row.retryAt).toBe(Date.now() + 30_000 * 2 ** (attempt - 1));
      await t.mutation(mutation('request'), args);
      expect((await rows())[0].state).toBe('FAILED');
      jest.setSystemTime(row.retryAt);
    } else expect(row.retryAt).toBeUndefined();
  }
  await t.mutation(mutation('request'), args);
  expect((await rows())[0].state).toBe('FAILED');
  expect(fetch).toHaveBeenCalledTimes(3);
});
test('duplicate/stale claims and completions cannot publish against another lease or changed source', async () => {
  const { t, args, messageId, rows, claim, control } = await setup();
  await t.mutation(mutation('request'), args);
  const leased = (await claim())!;
  expect(await claim()).toBeNull();
  expect((await rows())[0].attempts).toBe(1);
  await t.run((ctx) => ctx.db.patch(messageId, { text: 'A new original message.' }));
  await t.mutation(mutation('finish'), {
    id: leased._id,
    sourceDigest: leased.sourceDigest,
    leaseGeneration: leased.leaseGeneration!,
    translatedText: '陈旧译文',
  });
  expect((await rows())[0]).toMatchObject({
    state: 'FAILED',
    errorCode: 'TRANSLATION_SOURCE_CHANGED',
  });
  expect(await t.query(listRef, args)).toEqual([]);
  await t.mutation(mutation('request'), args);
  const next = (await claim())!;
  await t.mutation(mutation('finish'), {
    id: leased._id,
    sourceDigest: leased.sourceDigest,
    leaseGeneration: leased.leaseGeneration!,
    translatedText: '陈旧译文',
  });
  expect((await rows())[0].state).toBe('TRANSLATING');
  await t.mutation(mutation('finish'), {
    id: next._id,
    sourceDigest: next.sourceDigest,
    leaseGeneration: next.leaseGeneration!,
    translatedText: '一条新的原始消息。',
  });
  expect((await rows())[0].translatedText).toBe('一条新的原始消息。');
  expect((await control())?.cacheRows).toBe(1);
});
test('lease timeout survives an abandoned worker and recovery never starts duplicate in-flight translations', async () => {
  const { t, args, rows, claim, control } = await setup();
  await t.mutation(mutation('request'), args);
  const leased = (await claim())!;
  await t.mutation(mutation('recover'), {});
  expect((await control())?.activeId).toBe(leased._id);
  jest.setSystemTime(leased.leaseUntil! + 1);
  await t.mutation(mutation('recover'), {});
  expect((await rows())[0]).toMatchObject({
    state: 'FAILED',
    errorCode: 'TRANSLATION_TIMEOUT',
    retryAt: Date.now() + 30_000,
  });
  expect((await control())?.activeId).toBeUndefined();
  await t.mutation(mutation('finish'), {
    id: leased._id,
    sourceDigest: leased.sourceDigest,
    leaseGeneration: leased.leaseGeneration!,
    translatedText: '过期译文',
  });
  expect((await rows())[0].translatedText).toBeUndefined();
});
test('canonical writer hook only schedules after Chinese is enabled, and queue exhaustion retains the original', async () => {
  const { t, worldId, args, messageId, control } = await setup();
  await t.run((ctx) => scheduleNewMessageTranslation(ctx, messageId));
  expect(await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).toHaveLength(
    0,
  );
  await t.mutation(mutation('request'), args);
  const before = await t.run((ctx) => ctx.db.get(messageId));
  await t.run((ctx) => scheduleNewMessageTranslation(ctx, messageId));
  expect(await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).toHaveLength(
    2,
  );
  const controlId = (await control())!._id;
  await t.run(async (ctx) => {
    for (let index = 1; index < 200; index++)
      await ctx.db.insert('messageTranslations', {
        worldId,
        conversationId: 'c:0',
        messageId,
        targetLanguage: 'zh-CN',
        sourceDigest: `${index}`,
        sourceText: 'synthetic queued',
        state: 'QUEUED',
        attempts: 0,
        updatedAt: Date.now(),
      });
    await ctx.db.patch(controlId, { cacheRows: 200 });
  });
  const newId = await t.run((ctx) =>
    ctx.db.insert('messages', {
      worldId,
      conversationId: 'c:1',
      author: 'p:0',
      messageUuid: 'new',
      text: 'New text',
    }),
  );
  const newArgs = { worldId, conversationId: 'c:1', messageIds: [newId] };
  await t.mutation(mutation('request'), newArgs);
  expect(await t.query(listRef, newArgs)).toMatchObject([
    { status: 'FAILED', errorCode: 'TRANSLATION_QUEUE_FULL' },
  ]);
  expect(await t.run((ctx) => ctx.db.get(messageId))).toEqual(before);
  expect((await t.run((ctx) => ctx.db.get(newId)))?.text).toBe('New text');
});
test('capacity policy refuses derived writes explicitly; retired finished rows update the durable cache counter', async () => {
  const { t, args, rows, control } = await setup('你好。');
  await t.run((ctx) =>
    ctx.db.insert('storageUsageSnapshots', {
      key: 'local',
      groups: [{ category: 'cache', records: 1, bytes: defaultStoragePolicy.cacheBytes }],
      measuredAt: Date.now(),
      scanStartedAt: Date.now(),
    }),
  );
  expect(await t.mutation(mutation('request'), args)).toMatchObject({
    queued: false,
    errorCode: 'CACHE_LIMIT_REACHED',
  });
  expect(await rows()).toEqual([]);
  expect(await t.query(listRef, args)).toMatchObject([
    { status: 'FAILED', errorCode: 'CACHE_LIMIT_REACHED' },
  ]);
  await t.run(async (ctx) => {
    const snapshot = (await ctx.db.query('storageUsageSnapshots').unique())!;
    await ctx.db.delete(snapshot._id);
  });
  await t.mutation(mutation('request'), args);
  expect((await control())?.cacheRows).toBe(1);
  await t.run((ctx) =>
    ctx.db.insert('storagePolicies', {
      key: 'local',
      ...defaultStoragePolicy,
      cacheRetentionMs: 1000,
      updatedAt: Date.now(),
    }),
  );
  jest.setSystemTime(Date.now() + 2000);
  await t.mutation(mutation('recover'), {});
  expect(await rows()).toEqual([]);
  expect((await control())?.cacheRows).toBe(0);
});
test('cache capacity evicts only a finished entry with counter maintenance and never scans all cached payloads', async () => {
  const { t, worldId, args, messageId, rows, control } = await setup('新的中文消息。');
  const digest = await translationSourceDigest('旧消息。');
  await t.mutation(mutation('recover'), {});
  const controlId = (await control())!._id;
  const oldId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('messageTranslations', {
      worldId,
      conversationId: 'c:0',
      messageId,
      targetLanguage: 'zh-CN',
      sourceDigest: digest,
      sourceText: '旧消息。',
      state: 'READY',
      attempts: 0,
      updatedAt: Date.now() - 10,
      translatedText: '旧消息。',
    });
    await ctx.db.patch(controlId, { cacheRows: 5000 });
    return id;
  });
  const newId = await t.run((ctx) =>
    ctx.db.insert('messages', {
      worldId,
      conversationId: 'c:0',
      author: 'p:0',
      messageUuid: 'capacity',
      text: '新消息。',
    }),
  );
  await t.mutation(mutation('request'), { ...args, messageIds: [newId] });
  expect(await t.run((ctx) => ctx.db.get(oldId))).toBeNull();
  expect((await control())?.cacheRows).toBe(5000);
  expect((await rows())[0]).toMatchObject({ messageId: newId, state: 'READY' });
});
test('empty and enormous output are rejected before a cache commit', () => {
  expect(() => validateTranslationOutput(' ')).toThrow('TRANSLATION_EMPTY_OUTPUT');
  expect(() => validateTranslationOutput('中'.repeat(3000))).toThrow(
    'TRANSLATION_OUTPUT_TOO_LARGE',
  );
});

test('native scheduled jobs translate a batch serially and stop once the queue is drained', async () => {
  const { t, args, worldId, rows, control } = await setup();
  const secondId = await t.run((ctx) =>
    ctx.db.insert('messages', {
      worldId,
      conversationId: 'c:0',
      author: 'p:1',
      messageUuid: 'scheduled-second',
      text: 'I will bring some bread.',
    }),
  );
  const fetch = mockCompletion('我会带一些面包来。');
  await t.mutation(mutation('request'), { ...args, messageIds: [...args.messageIds, secondId] });
  await t.finishAllScheduledFunctions(() => jest.advanceTimersByTime(1000));
  expect((await rows()).map((row) => row.state)).toEqual(['READY', 'READY']);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((await control())?.activeId).toBeUndefined();
  expect((await control())?.wakeAt).toBeUndefined();
});

test('source deletion gives an explicit non-retryable display failure without disclosing a mismatched scope', async () => {
  const { t, args, messageId } = await setup();
  await t.mutation(mutation('request'), args);
  await t.run((ctx) => ctx.db.delete(messageId));
  expect(await t.query(listRef, args)).toMatchObject([
    { messageId, status: 'FAILED', errorCode: 'TRANSLATION_SOURCE_UNAVAILABLE' },
  ]);
  await expect(t.mutation(mutation('request'), args)).rejects.toThrow(
    'TRANSLATION_MESSAGE_MISMATCH',
  );
});
