import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from './schema';
import type { Doc } from './_generated/dataModel';
import type { CreateChatCompletionRequest } from './util/llm';

const modules = {
  './_generated/server.ts': () => import('./_generated/server'),
  './playerTextTranslations.ts': () => import('./playerTextTranslations'),
  './messageTranslations.ts': () => import('./messageTranslations'),
  './models/profiles.ts': () => import('./models/profiles'),
  './models/usage.ts': () => import('./models/usage'),
  './federation/resources.ts': () => import('./federation/resources'),
};
const mutation = (name: string) =>
  makeFunctionReference<'mutation'>(`playerTextTranslations:${name}`);
const get = makeFunctionReference<'query'>('playerTextTranslations:get');
const translate = makeFunctionReference<'action'>('playerTextTranslations:translate');
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1700000000000);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});
async function setup() {
  const t = convexTest(schema, modules);
  const worldId = await t.run((ctx) =>
    ctx.db.insert('worlds', {
      nextId: 2,
      agents: [],
      conversations: [],
      players: [
        {
          id: 'p:0',
          lastInput: Date.now(),
          position: { x: 0, y: 0 },
          facing: { dx: 1, dy: 0 },
          speed: 0,
          activity: { description: 'Reading a book.', until: Date.now() + 600_000 },
        },
      ],
    }),
  );
  const descriptionId = await t.run((ctx) =>
    ctx.db.insert('playerDescriptions', {
      worldId,
      playerId: 'p:0',
      name: 'Alice',
      description: 'Alice enjoys reading.',
      character: 'f1',
    }),
  );
  await t.run(async (ctx) => {
    const id = await ctx.db.insert('chatProfiles', {
      name: 'Main',
      model: 'current-main',
      provider: 'ollama',
      url: 'http://localhost:11434',
      stopWords: [],
      createdAt: Date.now(),
    });
    await ctx.db.insert('modelSettings', { key: 'town', mainChatProfileId: id });
  });
  const args = { worldId, playerId: 'p:0', field: 'description' as const };
  const row = () => t.run((ctx) => ctx.db.query('playerTextTranslations').first());
  return { t, worldId, descriptionId, args, row };
}
function mockCompletion(content = 'Alice喜欢阅读。') {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { total_tokens: 12 },
      }),
    ),
  );
}
test('authority, current model, cache hits and absent map residents preserve original description', async () => {
  const { t, worldId, descriptionId, args, row } = await setup();
  await t.run((ctx) => ctx.db.patch(worldId, { players: [] }));
  const original = await t.run((ctx) => ctx.db.get(descriptionId));
  const fetch = mockCompletion();
  await expect(
    t.mutation(mutation('request'), { ...args, text: 'Client prompt' }),
  ).rejects.toThrow();
  expect(await t.mutation(mutation('request'), { ...args, playerId: 'p:9' })).toEqual({
    queued: false,
  });
  await t.mutation(mutation('request'), args);
  await t.mutation(mutation('request'), args);
  const queued = (await row())!;
  await t.action(translate, { id: queued._id, generation: queued.generation });
  await t.mutation(mutation('request'), args);
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(fetch.mock.calls[0][1]!.body as string) as CreateChatCompletionRequest;
  expect(body).toMatchObject({ model: 'current-main', reasoning_effort: 'none', temperature: 0 });
  expect(body.messages[1].content).toBe(JSON.stringify({ description: original!.description }));
  expect(await t.query(get, args)).toMatchObject({
    status: 'READY',
    translatedText: 'Alice喜欢阅读。',
  });
  expect(await t.run((ctx) => ctx.db.get(descriptionId))).toEqual(original);
});
test('activity source changes invalidate and replace one cache row; stale completions cannot publish', async () => {
  const { t, worldId, args, row } = await setup();
  const activityArgs = { ...args, field: 'activity' as const };
  await t.mutation(mutation('request'), activityArgs);
  const old = (await row())!;
  const claimed = (await t.mutation(mutation('claim'), {
    id: old._id,
    generation: old.generation,
  })) as Doc<'playerTextTranslations'>;
  await t.run(async (ctx) => {
    const world = (await ctx.db.get(worldId))!;
    world.players[0].activity!.description = 'Drinking tea.';
    await ctx.db.patch(worldId, { players: world.players });
  });
  expect(await t.query(get, activityArgs)).toBeNull();
  await t.mutation(mutation('request'), activityArgs);
  await t.mutation(mutation('finish'), {
    id: claimed._id,
    generation: claimed.generation,
    translatedText: '过时译文。',
  });
  expect(await row()).toMatchObject({ state: 'QUEUED', sourceText: 'Drinking tea.' });
  expect(await t.run((ctx) => ctx.db.query('playerTextTranslations').collect())).toHaveLength(1);
  const current = (await row())!;
  mockCompletion('正在喝茶。');
  await t.action(translate, { id: current._id, generation: current.generation });
  expect(await t.query(get, activityArgs)).toMatchObject({
    status: 'READY',
    translatedText: '正在喝茶。',
  });
  jest.setSystemTime(Date.now() + 600_001);
  expect(await t.query(get, activityArgs)).toBeNull();
  expect(await t.mutation(mutation('request'), activityArgs)).toEqual({ queued: false });
});
test('failed translations use explicit bounded retries and sanitized errors', async () => {
  const { t, args, row } = await setup();
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('private credential', { status: 400 }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    await t.mutation(mutation('request'), args);
    const queued = (await row())!;
    await t.action(translate, { id: queued._id, generation: queued.generation });
    expect(await row()).toMatchObject({
      state: 'FAILED',
      attempts: attempt,
      errorCode: 'TRANSLATION_PROVIDER_FAILED',
    });
    expect(JSON.stringify(await row())).not.toContain('credential');
    await t.mutation(mutation('request'), args);
    expect((await row())!.state).toBe('FAILED');
    if (attempt < 3) jest.setSystemTime((await row())!.retryAt);
  }
  expect(fetch).toHaveBeenCalledTimes(3);
  expect((await row())!.retryAt).toBeUndefined();
});
test('abandoned jobs expire and late completion cannot replace timeout', async () => {
  const { t, args, row } = await setup();
  await t.mutation(mutation('request'), args);
  const queued = (await row())!;
  await t.mutation(mutation('claim'), { id: queued._id, generation: queued.generation });
  jest.setSystemTime(Date.now() + 100_001);
  await t.mutation(mutation('expire'), { id: queued._id, generation: queued.generation });
  await t.mutation(mutation('finish'), {
    id: queued._id,
    generation: queued.generation,
    translatedText: '迟到译文。',
  });
  expect(await row()).toMatchObject({ state: 'FAILED', errorCode: 'TRANSLATION_TIMEOUT' });
});
test('already Chinese descriptions do not call provider; invalid output remains a failure', async () => {
  const { t, args, descriptionId, row } = await setup();
  const fetch = mockCompletion('English only');
  await t.run((ctx) => ctx.db.patch(descriptionId, { description: '喜欢阅读。' }));
  await t.mutation(mutation('request'), args);
  expect(await t.query(get, args)).toMatchObject({ status: 'READY', translatedText: '喜欢阅读。' });
  expect(fetch).not.toHaveBeenCalled();
  await t.run((ctx) => ctx.db.patch(descriptionId, { description: 'Likes music.' }));
  await t.mutation(mutation('request'), args);
  const queued = (await row())!;
  await t.action(translate, { id: queued._id, generation: queued.generation });
  expect(await t.query(get, args)).toMatchObject({
    status: 'FAILED',
    errorCode: 'TRANSLATION_NOT_CHINESE',
  });
});

test.each(['小明 enjoys reading.', 'Alice喜欢阅读。'])(
  'mixed description replaces legacy passthrough once and preserves source: %s',
  async (text) => {
    const { t, args, descriptionId, row } = await setup();
    await t.run((ctx) => ctx.db.patch(descriptionId, { description: text }));
    const original = await t.run((ctx) => ctx.db.get(descriptionId));
    await t.mutation(mutation('request'), args);
    const initial = (await row())!;
    await t.run((ctx) =>
      ctx.db.patch(initial._id, {
        state: 'READY',
        translatedText: text,
        languagePolicyVersion: undefined,
      }),
    );
    expect(await t.query(get, args)).toBeNull();
    await t.mutation(mutation('request'), args);
    const queued = (await row())!;
    expect(queued).toMatchObject({ state: 'QUEUED', languagePolicyVersion: 2 });
    expect(queued.generation).toBe(initial.generation + 1);
    await t.mutation(mutation('request'), args);
    expect((await row())!.generation).toBe(queued.generation);
    const fetch = mockCompletion(text.includes('enjoys') ? '小明喜欢阅读。' : text);
    await t.action(translate, { id: queued._id, generation: queued.generation });
    expect(await t.query(get, args)).toMatchObject({ status: 'READY' });
    await t.mutation(mutation('request'), args);
    expect((await row())!.generation).toBe(queued.generation);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await t.run((ctx) => ctx.db.get(descriptionId))).toEqual(original);
  },
);

test.each(['READY', 'QUEUED', 'TRANSLATING', 'FAILED'] as const)(
  'legacy %s description preserves translated results, active jobs and retry cooldown',
  async (state) => {
    const { t, args, descriptionId, row } = await setup();
    await t.run((ctx) => ctx.db.patch(descriptionId, { description: '小明 enjoys reading.' }));
    await t.mutation(mutation('request'), args);
    const initial = (await row())!;
    await t.run((ctx) =>
      ctx.db.patch(initial._id, {
        state,
        languagePolicyVersion: undefined,
        translatedText: state === 'READY' ? '小明喜欢阅读。' : undefined,
        retryAt: state === 'FAILED' ? Date.now() + 30_000 : undefined,
      }),
    );
    const before = await row();
    expect(await t.query(get, args)).toMatchObject({ status: state });
    await t.mutation(mutation('request'), args);
    expect(await row()).toEqual(before);
  },
);
