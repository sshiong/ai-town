import { jest } from '@jest/globals';
import { Agent } from './agentModel';
import { World } from './world';
import type { Game } from './game';
import { Id } from '../_generated/dataModel';
import { parseGameId } from './ids';

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
  expect(agent.toRemember).toBeUndefined();
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
