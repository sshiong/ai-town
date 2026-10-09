import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { ChatConfig, CreateChatCompletionRequest } from '../util/llm';
import { decideRemoteAction, decisionRules, validateObservedDecision } from './decision';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/resources.ts': () => import('./resources'),
};
const config: ChatConfig = {
  provider: 'ollama',
  url: 'http://model.example',
  chatModel: 'qwen3.5:4b',
  reasoningEffort: 'none',
  stopWords: [],
};
const invited = {
  conversation: { status: 'invited' },
  nearby: [{ playerId: 'p:1', available: false }],
};
function args(observation = invited) {
  return {
    identity: 'A friendly resident who likes meeting neighbors.',
    plan: 'Meet a local resident.',
    rememberedFacts: ['I met Maya at Home.'],
    memoryRetrievalMode: 'canonical-fallback',
    observation,
    deadline: Date.now() + 25000,
  };
}
const response = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }));
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('observed membership gates speech and invitation responses without inventing an action', () => {
  expect(decisionRules(invited).allowedActionTypes).toContain('acceptInvite');
  expect(decisionRules(invited).allowedActionTypes).not.toContain('say');
  expect(() => validateObservedDecision({ type: 'say', text: 'hello' }, invited)).toThrow(
    'ACTION_NOT_ALLOWED:say:invited',
  );
  expect(validateObservedDecision({ type: 'rejectInvite' }, invited)).toEqual({
    type: 'rejectInvite',
  });
  const walking = { conversation: { status: 'walkingOver' } };
  expect(() => validateObservedDecision({ type: 'say', text: 'hello' }, walking)).toThrow();
  expect(() => validateObservedDecision({ type: 'acceptInvite' }, walking)).toThrow();
  const participating = { conversation: { status: 'participating' } };
  expect(validateObservedDecision({ type: 'say', text: 'hello' }, participating)).toEqual({
    type: 'say',
    text: 'hello',
  });
  expect(() => validateObservedDecision({ type: 'acceptInvite' }, participating)).toThrow();
  expect(() =>
    validateObservedDecision({ type: 'leaveConversation' }, { conversation: null }),
  ).toThrow();
});

test('invitations only target observed available players; Host still checks movement', () => {
  const observation = {
    conversation: null,
    nearby: [
      { playerId: 'p:1', available: true },
      { playerId: 'p:2', available: false },
    ],
  };
  expect(validateObservedDecision({ type: 'inviteToTalk', playerId: 'p:1' }, observation)).toEqual({
    type: 'inviteToTalk',
    playerId: 'p:1',
  });
  expect(() =>
    validateObservedDecision({ type: 'inviteToTalk', playerId: 'p:2' }, observation),
  ).toThrow('INVITEE_NOT_AVAILABLE_IN_OBSERVATION');
  expect(() =>
    validateObservedDecision({ type: 'inviteToTalk', playerId: 'p:3' }, observation),
  ).toThrow();
  expect(
    validateObservedDecision({ type: 'moveTo', destination: { x: 1, y: 2 } }, observation),
  ).toEqual({
    type: 'moveTo',
    destination: { x: 1, y: 2 },
  });
});

test('an invited greeting is corrected by a second real model call with original deadline and permits', async () => {
  const t = convexTest(schema, modules);
  const input = args();
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response('{"type":"say","text":"Hello!"}'))
    .mockResolvedValueOnce(response('{"type":"acceptInvite"}'));
  expect(await t.action((ctx) => decideRemoteAction(ctx, config, input))).toEqual({
    type: 'acceptInvite',
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as CreateChatCompletionRequest;
  const correction = JSON.parse(
    String(fetchMock.mock.calls[1][1]?.body),
  ) as CreateChatCompletionRequest;
  expect(first).toMatchObject({
    model: 'qwen3.5:4b',
    max_tokens: 1500,
    reasoning_effort: 'none',
    response_format: { type: 'json_object' },
  });
  expect(first.messages[0].content).toContain('"conversationStatus":"invited"');
  expect(JSON.parse(first.messages[1].content ?? '') as unknown).toMatchObject({
    rememberedFacts: input.rememberedFacts,
  });
  expect(correction.messages.at(-2)).toEqual({
    role: 'assistant',
    content: '{"type":"say","text":"Hello!"}',
  });
  expect(correction.messages.at(-1)?.role).toBe('user');
  expect(correction.messages.at(-1)?.content).toContain('ACTION_NOT_ALLOWED:say:invited');
  expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
});

test.each(['not JSON', '{"type":"say","text":"still invited"}'])(
  'two invalid decisions fail with no fabricated wait or accept: %s',
  async (invalid) => {
    const t = convexTest(schema, modules);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response(invalid));
    await expect(t.action((ctx) => decideRemoteAction(ctx, config, args()))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
  },
);

test('the correction cannot start after the original turn deadline', async () => {
  const t = convexTest(schema, modules);
  const input = args();
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    jest.setSystemTime(input.deadline);
    return Promise.resolve(response('{"type":"say","text":"too late"}'));
  });
  await expect(t.action((ctx) => decideRemoteAction(ctx, config, input))).rejects.toThrow(
    'CHAT_REQUEST_DEADLINE',
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
});

test('a stalled correction is aborted at the original deadline and releases its permit', async () => {
  const t = convexTest(schema, modules);
  const input = args();
  let started!: () => void;
  const correctionStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => {
      jest.setSystemTime(input.deadline - 1000);
      return Promise.resolve(response('{"type":"say","text":"too early"}'));
    })
    .mockImplementationOnce(async (_url, options) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
  const completion = t
    .action((ctx) => decideRemoteAction(ctx, config, input))
    .catch((error: unknown) => error);
  await correctionStarted;
  const permits = await t.run((ctx) => ctx.db.query('federationLlmRequests').collect());
  expect(permits).toHaveLength(1);
  expect(permits[0].deadline).toBe(input.deadline);
  await jest.advanceTimersByTimeAsync(1000);
  expect(String(await completion)).toContain('CHAT_REQUEST_DEADLINE');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
});

test('custom providers retain their request format and valid decisions need no correction', async () => {
  const t = convexTest(schema, modules);
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(response('{"type":"rejectInvite"}'));
  expect(
    await t.action((ctx) => decideRemoteAction(ctx, { ...config, provider: 'custom' }, args())),
  ).toEqual({
    type: 'rejectInvite',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as CreateChatCompletionRequest;
  expect(body.response_format).toBeUndefined();
});

test('provider failures release the permit and are not mistaken for invalid decisions', async () => {
  const t = convexTest(schema, modules);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('bad request', { status: 400 }));
  await expect(t.action((ctx) => decideRemoteAction(ctx, config, args()))).rejects.toThrow(
    'code 400',
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await t.run((ctx) => ctx.db.query('federationLlmRequests').collect())).toEqual([]);
});
