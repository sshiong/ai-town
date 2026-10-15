import { jest } from '@jest/globals';
import { Agent } from './agentModel';
import { World } from './world';
import type { Game } from './game';
import { Id } from '../_generated/dataModel';
import { parseGameId } from './ids';
import { agentInputs } from './agentInputs';
import { Conversation, conversationInputs } from './conversation';
import { ACTION_TIMEOUT } from '../constants';
import { Player } from './player';
import { blocked } from './movement';
import type { GenericId } from 'convex/values';

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

function invitationFixture() {
  const fixtureValue = fixture();
  const { agent, game } = fixtureValue;
  const human = new Player({
    id: 'p:1',
    human: 'test-human',
    lastInput: 1000,
    position: { x: 7, y: 1 },
    facing: { dx: -1, dy: 0 },
    speed: 0,
  });
  game.world.players.set(human.id, human);
  const conversation = new Conversation({
    id: 'c:10',
    creator: agent.playerId,
    created: 1000,
    numMessages: 0,
    participants: [
      { playerId: agent.playerId, invited: 1000, status: { kind: 'walkingOver' } },
      { playerId: human.id, invited: 1000, status: { kind: 'invited' } },
    ],
  });
  game.world.conversations.set(conversation.id, conversation);
  Object.assign(game.worldMap, {
    width: 10,
    height: 8,
    objectTiles: [Array.from({ length: 10 }, () => Array(8).fill(-1))],
  });
  return { ...fixtureValue, human, conversation, player: game.world.players.get(agent.playerId)! };
}

test('an unaccepted human invitation does not start moving the human', () => {
  const { game, human, conversation } = invitationFixture();
  conversation.tick(game, 1000);
  expect(human.pathfinding).toBeUndefined();
  expect(conversation.participants.get(human.id)!.status.kind).toBe('invited');
});

test.each(['pending', 'inProgress'] as const)(
  'accepted human invitation approaches without waiting for %s memory',
  (memoryState) => {
    const { agent, game, human, conversation, player, scheduleOperation } = invitationFixture();
    if (memoryState === 'inProgress') {
      agent.inProgressOperation = {
        name: 'agentRememberConversation',
        operationId: 'o:old',
        started: 999,
        conversationId: agent.toRemember,
      };
    }
    player.pathfinding = {
      destination: { x: 0, y: 7 },
      started: 999,
      state: { kind: 'needsPath' },
    };
    human.pathfinding = {
      destination: { x: 9, y: 7 },
      started: 999,
      state: { kind: 'needsPath' },
    };
    conversationInputs.acceptInvite.handler(game, 1000, {
      playerId: human.id,
      conversationId: conversation.id,
    });
    expect(player.pathfinding).toBeUndefined();
    expect(human.pathfinding).toBeUndefined();
    conversation.tick(game, 1000);
    agent.tick(game, 1000);
    expect(player.pathfinding?.destination).toEqual({ x: 4, y: 1 });
    expect(human.pathfinding?.destination).toEqual({ x: 1, y: 1 });
    expect(agent.toRemember).toBe('c:3');
    expect(scheduleOperation).not.toHaveBeenCalled();
    if (memoryState === 'inProgress') expect(agent.inProgressOperation?.operationId).toBe('o:old');
  },
);

test('agent accepts a human invitation even while an earlier memory operation is running', () => {
  const { agent, game, human, conversation } = invitationFixture();
  conversation.creator = human.id;
  conversation.participants.get(human.id)!.status = { kind: 'walkingOver' };
  conversation.participants.get(agent.playerId)!.status = { kind: 'invited' };
  agent.inProgressOperation = { name: 'agentRememberConversation', operationId: 'o:old', started: 999 };
  agent.tick(game, 1000);
  expect(conversation.participants.get(agent.playerId)!.status.kind).toBe('walkingOver');
  expect(agent.inProgressOperation?.operationId).toBe('o:old');
  expect(agent.toRemember).toBe('c:3');
});

test('memory completion while approaching preserves the new conversation and queued memory', () => {
  const { agent, game, human, conversation, player } = invitationFixture();
  agent.queuedConversations = [parseGameId('conversations', 'c:4')];
  agent.inProgressOperation = {
    name: 'agentRememberConversation', operationId: 'o:old', started: 999, conversationId: agent.toRemember,
  };
  conversation.acceptInvite(game, human);
  agent.tick(game, 1000);
  const pathfinding = player.pathfinding;
  agentInputs.finishRememberConversation.handler(game, 1001, {
    agentId: agent.id, operationId: 'o:old', conversationId: 'c:3',
  });
  agent.tick(game, 1002);
  expect(player.pathfinding).toBe(pathfinding);
  expect(agent.toRemember).toBe('c:4');
  expect(agent.inProgressOperation).toBeUndefined();
  expect(conversation.participants.get(agent.playerId)!.status.kind).toBe('walkingOver');
});

test.each(['before', 'after'] as const)(
  'old idle callback %s the first conversation tick cannot replace its movement or activity',
  (timing) => {
    const { agent, game, human, conversation, player } = invitationFixture();
    agent.inProgressOperation = { name: 'agentDoSomething', operationId: 'o:old', started: 999 };
    conversation.acceptInvite(game, human);
    if (timing === 'after') agent.tick(game, 1000);
    const pathfinding = player.pathfinding;
    agentInputs.finishDoSomething.handler(game, 1001, {
      agentId: String(agent.id) as GenericId<'agents'>,
      operationId: 'o:old',
      destination: { x: 0, y: 7 },
      invitee: String(human.id) as GenericId<'players'>,
      activity: { description: 'Old activity', until: 10000 },
    });
    expect(player.pathfinding).toBe(pathfinding);
    expect(player.activity).toBeUndefined();
    expect(agent.inProgressOperation).toBeUndefined();
    expect(game.world.conversations.get(conversation.id)).toBe(conversation);
  },
);

test('accepted human invitation follows collision-safe paths around obstacles and starts the conversation during memory', () => {
  const { agent, game, human, conversation, player } = invitationFixture();
  // The midpoint is blocked; reaching the other side requires going around the wall.
  for (let y = 0; y < 3; y++) game.worldMap.objectTiles[0][4][y] = 1;
  agent.inProgressOperation = { name: 'agentRememberConversation', operationId: 'o:old', started: 999 };
  conversation.acceptInvite(game, human);
  const random = jest.spyOn(Math, 'random').mockReturnValue(0);
  try {
    for (let now = 1000; now < 21000; now += 16) {
      game.numPathfinds = 0;
      for (const participant of [player, human]) participant.tickPathfinding(game, now);
      for (const participant of [player, human]) participant.tickPosition(game, now);
      for (const participant of [player, human]) {
        expect(blocked(game, now, participant.position, participant.id)).toBeNull();
      }
      conversation.tick(game, now);
      agent.tick(game, now);
      if (conversation.participants.get(human.id)!.status.kind === 'participating') break;
    }
  } finally {
    random.mockRestore();
  }
  expect(conversation.participants.get(human.id)!.status.kind).toBe('participating');
  expect(conversation.participants.get(agent.playerId)!.status.kind).toBe('participating');
  expect(agent.inProgressOperation?.operationId).toBe('o:old');
  expect(agent.toRemember).toBe('c:3');
});

test('two residents route around a wide blocked midpoint and meet without crossing terrain', () => {
  const { agent, game, human: otherPlayer, conversation, player } = invitationFixture();
  delete otherPlayer.human;
  otherPlayer.position = { x: 12, y: 1 };
  const otherAgent = new Agent({ id: 'a:2', playerId: otherPlayer.id });
  game.world.agents.set(otherAgent.id, otherAgent);
  Object.assign(game.worldMap, { width: 14, height: 8,
    objectTiles: [Array.from({ length: 14 }, () => Array(8).fill(-1))] });
  // A wide river leaves the two nearest banks farther apart than the direct
  // approach threshold. The only crossing is at the bottom of the map.
  for (let x = 3; x <= 8; x++)
    for (let y = 0; y < 7; y++) game.worldMap.objectTiles[0][x][y] = 1;
  conversation.acceptInvite(game, otherPlayer);
  const random = jest.spyOn(Math, 'random').mockReturnValue(0);
  try {
    for (let now = 1000; now < 51000; now += 16) {
      game.numPathfinds = 0;
      for (const participant of [player, otherPlayer]) participant.tickPathfinding(game, now);
      for (const participant of [player, otherPlayer]) participant.tickPosition(game, now);
      for (const participant of [player, otherPlayer])
        expect(blocked(game, now, participant.position, participant.id)).toBeNull();
      conversation.tick(game, now);
      if (conversation.participants.get(player.id)!.status.kind === 'participating') break;
      agent.tick(game, now);
      otherAgent.tick(game, now);
    }
  } finally { random.mockRestore(); }
  expect(conversation.participants.get(player.id)!.status.kind).toBe('participating');
  expect(conversation.participants.get(otherPlayer.id)!.status.kind).toBe('participating');
});

test('cancelling an accepted invitation stops both approach paths and preserves pending memories', () => {
  const { agent, game, human, conversation, player } = invitationFixture();
  conversation.acceptInvite(game, human);
  conversation.tick(game, 1000);
  agent.tick(game, 1000);
  expect(player.pathfinding).toBeDefined();
  expect(human.pathfinding).toBeDefined();
  conversationInputs.leaveConversation.handler(game, 1001, { playerId: human.id, conversationId: conversation.id });
  expect(game.world.conversations.has(conversation.id)).toBe(false);
  expect(player.pathfinding).toBeUndefined();
  expect(human.pathfinding).toBeUndefined();
  expect(player.speed).toBe(0);
  expect(human.speed).toBe(0);
  expect(agent.toRemember).toBe('c:3');
});

test('cancelling an outgoing invitation stops the caller but preserves the unaccepted invitee movement', () => {
  const { game, human, conversation, player } = invitationFixture();
  conversation.creator = human.id;
  conversation.participants.get(human.id)!.status = { kind: 'walkingOver' };
  conversation.participants.get(player.id)!.status = { kind: 'invited' };
  const wander = { destination: { x: 3, y: 5 }, started: 1000, state: { kind: 'needsPath' as const } };
  player.pathfinding = wander;
  human.pathfinding = { destination: { x: 1, y: 1 }, started: 1000, state: { kind: 'needsPath' } };
  conversationInputs.leaveConversation.handler(game, 1001, { playerId: human.id, conversationId: conversation.id });
  expect(game.world.conversations.has(conversation.id)).toBe(false);
  expect(human.pathfinding).toBeUndefined();
  expect(player.pathfinding).toBe(wander);
});
