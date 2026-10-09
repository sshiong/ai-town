import { Conversation } from '../aiTown/conversation';
import { tickRemoteVisitor } from './remoteTick';
import { Game } from '../aiTown/game';
import { parseGameId } from '../aiTown/ids';
import { federationInputs } from './engineInputs';
import { parseDecision } from './decision';
import { Id } from '../_generated/dataModel';

function gameFixture(): Game {
  const now = Date.now();
  return new Game(
    {
      _id: 'engine' as Id<'engines'>,
      _creationTime: now,
      currentTime: now,
      running: true,
      generationNumber: 0,
    },
    'world' as Id<'worlds'>,
    {
      world: {
        nextId: 10,
        players: [
          {
            id: 'p:0',
            lastInput: now,
            position: { x: 1, y: 1 },
            facing: { dx: 1, dy: 0 },
            speed: 0,
          },
        ],
        agents: [{ id: 'a:1', playerId: 'p:0' }],
        conversations: [],
      },
      playerDescriptions: [
        { playerId: 'p:0', name: 'Resident', character: 'f1', description: 'Friendly' },
      ],
      agentDescriptions: [
        { agentId: 'a:1', identity: 'Friendly resident', plan: 'Enjoy the town' },
      ],
      worldMap: {
        width: 8,
        height: 8,
        tileSetUrl: 'map',
        tileSetDimX: 8,
        tileSetDimY: 8,
        tileDim: 16,
        bgTiles: [],
        objectTiles: [Array.from({ length: 8 }, () => Array(8).fill(-1))],
        animatedSprites: [],
      },
    },
  );
}
describe('persistent brain and temporary presence', () => {
  test('departure removes only the body, retains identity and resumes original player', () => {
    const game = gameFixture(),
      now = Date.now();
    federationInputs.federationSuspend.handler(game, now, { agentId: 'a:1', visitId: 'visit' });
    expect(game.world.players.size).toBe(0);
    expect(game.world.agents.size).toBe(1);
    const agent = game.world.agents.get(parseGameId('agents', 'a:1'))!;
    expect(agent.travelVisitId).toBe('visit');
    expect(() => agent.tick(game, now)).not.toThrow();
    expect(game.pendingOperations).toHaveLength(0);
    federationInputs.federationResume.handler(game, now, { agentId: 'a:1', visitId: 'visit' });
    expect(game.world.players.has(parseGameId('players', 'p:0'))).toBe(true);
    expect(agent.travelVisitId).toBeUndefined();
    expect(game.playerDescriptions.get(parseGameId('players', 'p:0'))!.name).toBe('Resident');
  });
  test('visitors have no Host Agent and creation replay does not duplicate a presence', () => {
    const game = gameFixture(),
      now = Date.now();
    const args = {
      visitor: {
        visitId: 'visit',
        agentGlobalId: 'town:A/agent:1',
        homeTownId: 'town:A',
        homeTownName: 'A',
        agentAuthorityEpoch: 2,
        visitLeaseVersion: 1,
        leaseExpiry: now + 90_000,
        lastObservationAt: 0,
      },
      name: 'Guest',
      character: 'f2',
      description: 'Visitor',
    };
    const id = federationInputs.federationCreateVisitor.handler(game, now, args);
    expect(federationInputs.federationCreateVisitor.handler(game, now, args)).toBe(id);
    expect(game.world.players.size).toBe(2);
    expect(game.world.agents.size).toBe(1);
    expect(game.playerDescriptions.get(id)?.originTownName).toBe('A');
  });
  test('expired visitor stops its map body independently of remote availability', () => {
    const game = gameFixture(),
      now = Date.now();
    const id = federationInputs.federationCreateVisitor.handler(game, now, {
      visitor: {
        visitId: 'visit',
        agentGlobalId: 'town:A/agent:1',
        homeTownId: 'town:A',
        homeTownName: 'A',
        agentAuthorityEpoch: 2,
        visitLeaseVersion: 1,
        leaseExpiry: now + 1,
        lastObservationAt: 0,
      },
      name: 'Guest',
      character: 'f2',
      description: 'Visitor',
    });
    game.world.players.get(id)!.tick(game, now + 2);
    expect(game.world.players.has(id)).toBe(false);
  });
});
describe('Host action authority', () => {
  test('old lease, expired turn and invalid model actions cannot execute', () => {
    const game = gameFixture(),
      now = Date.now();
    const id = federationInputs.federationCreateVisitor.handler(game, now, {
      visitor: {
        visitId: 'visit',
        agentGlobalId: 'town:A/agent:1',
        homeTownId: 'town:A',
        homeTownName: 'A',
        agentAuthorityEpoch: 2,
        visitLeaseVersion: 3,
        leaseExpiry: now + 90_000,
        lastObservationAt: 0,
      },
      name: 'Guest',
      character: 'f2',
      description: 'Visitor',
    });
    game.world.players.get(id)!.remoteVisitor!.pendingTurn = {
      turnId: 'turn',
      eventId: 'event',
      deadline: now + 20_000,
    };
    const actionArgs = {
      playerId: id,
      visitId: 'visit',
      actionId: 'action',
      turnId: 'turn',
      agentAuthorityEpoch: 2,
      visitLeaseVersion: 3,
      deadline: now + 20_000,
      action: { type: 'wait' as const },
    };
    expect(() =>
      federationInputs.federationAction.handler(game, now, { ...actionArgs, visitLeaseVersion: 2 }),
    ).toThrow('STALE_AUTHORITY');
    expect(() =>
      federationInputs.federationAction.handler(game, now, { ...actionArgs, deadline: now - 1 }),
    ).toThrow('STALE_TURN');
    expect(() =>
      federationInputs.federationAction.handler(game, now, {
        ...actionArgs,
        action: { type: 'moveTo', destination: { x: -1, y: 0 } },
      }),
    ).toThrow('INVALID_DESTINATION');
    expect(() => federationInputs.federationAction.handler(game, now, actionArgs)).not.toThrow();
    expect(() => federationInputs.federationAction.handler(game, now, actionArgs)).toThrow(
      'STALE_TURN',
    );
  });
  test('structured model replies never accept arbitrary code or extra fields', () => {
    expect(() => parseDecision('')).toThrow('EMPTY_MODEL_DECISION');
    expect(parseDecision('{"type":"say","text":"hello"}')).toEqual({ type: 'say', text: 'hello' });
    expect(() => parseDecision('{"type":"deleteWorld"}')).toThrow('INVALID_MODEL_DECISION');
    expect(() => parseDecision('{"type":"wait","shell":"rm -rf"}')).toThrow(
      'INVALID_MODEL_DECISION',
    );
    expect(() => parseDecision('{"type":"moveTo","destination":{"x":1.2,"y":2}}')).toThrow(
      'INVALID_MODEL_DECISION',
    );
  });
});

test('remote turn retains authority after the 15-second typing indicator expires', () => {
  const game = gameFixture(),
    now = Date.now();
  const guestId = federationInputs.federationCreateVisitor.handler(game, now, {
    visitor: {
      visitId: 'typing-visit',
      agentGlobalId: 'town:B/agent:guest',
      homeTownId: 'town:B',
      homeTownName: 'B',
      agentAuthorityEpoch: 2,
      visitLeaseVersion: 1,
      leaseExpiry: now + 90000,
      lastObservationAt: 0,
    },
    name: 'Guest',
    character: 'f2',
    description: 'Visitor',
  });
  const guest = game.world.players.get(guestId)!,
    local = game.world.players.get(parseGameId('players', 'p:0'))!;
  guest.position = { x: 1, y: 2 };
  const { conversationId } = Conversation.start(game, now, guest, local);
  if (!conversationId) throw new Error('Test conversation was not created');
  const conversation = game.world.conversations.get(conversationId)!;
  conversation.acceptInvite(game, local);
  conversation.tick(game, now + 1);
  tickRemoteVisitor(game, now + 1000, guest);
  const turn = guest.remoteVisitor!.pendingTurn!;
  conversation.tick(game, now + 17000);
  expect(conversation.isTyping).toBeUndefined();
  expect(conversation.federationTurn?.turnId).toBe(turn.turnId);
  game.world.agents.get(parseGameId('agents', 'a:1'))!.tick(game, now + 17000);
  expect(game.pendingOperations).toHaveLength(0);
  federationInputs.federationAction.handler(game, now + 18000, {
    playerId: guestId,
    visitId: 'typing-visit',
    actionId: 'say',
    turnId: turn.turnId,
    agentAuthorityEpoch: 2,
    visitLeaseVersion: 1,
    deadline: turn.deadline,
    conversationId,
    expectedNumMessages: 0,
    action: { type: 'say', text: 'An authorized delayed reply' },
  });
  expect(conversation.numMessages).toBe(1);
  expect(conversation.federationTurn).toBeUndefined();
});
