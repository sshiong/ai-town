import { jest } from '@jest/globals';
import { Agent } from './agentModel';
import { World } from './world';
import type { Game } from './game';
import { Id } from '../_generated/dataModel';
import { parseGameId } from './ids';
import { agentInputs } from './agentInputs';
import { Conversation } from './conversation';
import { ACTION_TIMEOUT } from '../constants';

function fixture() {
  const agent = new Agent({ id: 'a:1', playerId: 'p:0', toRemember: 'c:3' });
  const world = new World({
    nextId: 10,
    agents: [],
    conversations: [],
    players: [
      { id: 'p:0', lastInput: 1, position: { x: 1, y: 1 }, facing: { dx: 1, dy: 0 }, speed: 0 },
    ],
  });
  world.agents.set(agent.id, agent);
  const scheduleOperation = jest.fn();
  const game = {
    world,
    worldId: 'test-world' as Id<'worlds'>,
    worldMap: { serialize: () => ({}) },
    allocId: () => parseGameId('operations', 'o:10'),
    scheduleOperation,
  } as unknown as Game;
  return { agent, game, scheduleOperation };
}

test('an idle resident remembers the completed conversation before starting another activity', () => {
  const { agent, game, scheduleOperation } = fixture();
  agent.tick(game, 1000);
  expect(scheduleOperation).toHaveBeenCalledTimes(1);
  expect(scheduleOperation).toHaveBeenCalledWith('agentRememberConversation', {
    worldId: game.worldId,
    playerId: 'p:0',
    agentId: 'a:1',
    conversationId: 'c:3',
    operationId: 'o:10',
  });
  expect(agent.toRemember).toBe('c:3');
  expect(agent.inProgressOperation?.name).toBe('agentRememberConversation');
  agent.tick(game, 1001);
  expect(scheduleOperation).toHaveBeenCalledTimes(1);
});

test('remembering waits for the existing operation without starting a second brain', () => {
  const { agent, game, scheduleOperation } = fixture();
  agent.inProgressOperation = { name: 'agentDoSomething', operationId: 'o:9', started: 999 };
  agent.tick(game, 1000);
  expect(scheduleOperation).not.toHaveBeenCalled();
  expect(agent.toRemember).toBe('c:3');
});

test('a resident without pending memory retains the original idle operation', () => {
  const { agent, game, scheduleOperation } = fixture();
  delete agent.toRemember;
  agent.tick(game, 1000);
  expect(scheduleOperation.mock.calls[0][0]).toBe('agentDoSomething');
});

test('a timed-out memory operation retries the same durable conversation', () => {
  const { agent, game, scheduleOperation } = fixture();
  agent.tick(game, 1000);
  agent.tick(game, 1000 + ACTION_TIMEOUT);
  expect(scheduleOperation).toHaveBeenCalledTimes(2);
  expect(scheduleOperation.mock.calls[1][0]).toBe('agentRememberConversation');
  expect(agent.toRemember).toBe('c:3');
});

test('finishing one memory preserves the next queued conversation and ignores stale callbacks', () => {
  const { agent, game } = fixture();
  agent.queuedConversations = [parseGameId('conversations', 'c:4')];
  agent.tick(game, 1000);
  agentInputs.finishRememberConversation.handler(game, 1001, {
    agentId: agent.id,
    operationId: 'o:old',
    conversationId: 'c:3',
  });
  expect(agent.toRemember).toBe('c:3');
  agentInputs.finishRememberConversation.handler(game, 1002, {
    agentId: agent.id,
    operationId: 'o:10',
    conversationId: 'c:3',
  });
  expect(agent.toRemember).toBe('c:4');
  expect(agent.inProgressOperation).toBeUndefined();
  expect(new Agent(agent.serialize()).toRemember).toBe('c:4');
});

test('a newer ended conversation queues once while empty conversations do not erase pending memory', () => {
  const { agent, game } = fixture();
  const make = (id: string, numMessages: number) =>
    new Conversation({
      id,
      creator: 'p:0',
      created: 1,
      numMessages,
      participants: [
        { playerId: 'p:0', invited: 1, status: { kind: 'participating', started: 1 } },
      ],
    });
  make('c:4', 2).stop(game, 1000);
  make('c:4', 2).stop(game, 1001);
  make('c:5', 0).stop(game, 1002);
  expect(agent.toRemember).toBe('c:3');
  expect(agent.queuedConversations).toEqual(['c:4']);
  expect(new Agent(agent.serialize()).queuedConversations).toEqual(['c:4']);
});
