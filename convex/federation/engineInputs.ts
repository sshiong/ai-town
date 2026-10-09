import { v } from 'convex/values';
import { inputHandler } from '../aiTown/inputHandler';
import { agentId, playerId, parseGameId } from '../aiTown/ids';
import { Player } from '../aiTown/player';
import { movePlayer, stopPlayer, blocked, findRoute } from '../aiTown/movement';
import { Conversation } from '../aiTown/conversation';
import { point } from '../util/types';

import { remoteVisitor } from './presence';

export const federationInputs = {
  federationUpdateLease: inputHandler({
    args: {
      visitId: v.string(),
      agentAuthorityEpoch: v.number(),
      visitLeaseVersion: v.number(),
      leaseExpiry: v.number(),
    },
    handler: (game, now, args) => {
      const player = [...game.world.players.values()].find(
        (p) => p.remoteVisitor?.visitId === args.visitId,
      );
      if (!player?.remoteVisitor) throw new Error('VISITOR_NOT_FOUND');
      const visitor = player.remoteVisitor;
      if (
        visitor.agentAuthorityEpoch !== args.agentAuthorityEpoch ||
        args.visitLeaseVersion < visitor.visitLeaseVersion
      )
        throw new Error('STALE_AUTHORITY');
      if (
        visitor.leaseExpiry <= Math.max(now, Date.now()) ||
        args.leaseExpiry <= Math.max(now, Date.now())
      )
        throw new Error('LEASE_EXPIRED');
      visitor.visitLeaseVersion = args.visitLeaseVersion;
      visitor.leaseExpiry = args.leaseExpiry;
      delete visitor.pendingTurn;
      const conversation = game.world.playerConversation(player);
      if (conversation?.federationTurn?.playerId === player.id) delete conversation.federationTurn;
      return null;
    },
  }),
  federationSuspend: inputHandler({
    args: { agentId, visitId: v.string() },
    handler: (game, now, args) => {
      const agent = game.world.agents.get(parseGameId('agents', args.agentId));
      if (!agent) throw new Error('RESIDENT_NOT_FOUND');
      if (agent.travelVisitId) {
        if (agent.travelVisitId !== args.visitId) throw new Error('RESIDENT_ALREADY_TRAVELING');
        return null;
      }
      const player = game.world.players.get(agent.playerId);
      if (!player || player.remoteVisitor) throw new Error('RESIDENT_NOT_ACTIVE');
      player.leave(game, now);
      stopPlayer(player);
      agent.suspendedPlayer = player.serialize();
      agent.travelVisitId = args.visitId;
      delete agent.inProgressOperation;
      return null;
    },
  }),
  federationResume: inputHandler({
    args: { agentId, visitId: v.string() },
    handler: (game, now, args) => {
      const agent = game.world.agents.get(parseGameId('agents', args.agentId));
      if (!agent) throw new Error('RESIDENT_NOT_FOUND');
      if (!agent.travelVisitId) return null;
      if (agent.travelVisitId !== args.visitId || !agent.suspendedPlayer) {
        throw new Error('STALE_VISIT');
      }
      const snapshot = agent.suspendedPlayer;
      // Restore the original presence ID: memory ownership and social edges stay stable.
      let position = snapshot.position;
      if (blocked(game, now, position)) {
        let found = false;
        for (let y = 0; y < game.worldMap.height && !found; y++) {
          for (let x = 0; x < game.worldMap.width; x++) {
            if (!blocked(game, now, { x, y })) {
              position = { x, y };
              found = true;
              break;
            }
          }
        }
        if (!found) throw new Error('NO_FREE_SPAWN');
      }
      game.world.players.set(
        agent.playerId,
        new Player({
          ...snapshot,
          position,
          speed: 0,
          pathfinding: undefined,
          activity: undefined,
          lastInput: now,
        }),
      );
      delete agent.suspendedPlayer;
      delete agent.travelVisitId;
      return null;
    },
  }),
  federationCreateVisitor: inputHandler({
    args: {
      visitor: remoteVisitor,
      name: v.string(),
      character: v.string(),
      description: v.string(),
    },
    handler: (game, now, args) => {
      if (args.visitor.leaseExpiry <= Math.max(now, Date.now())) throw new Error('LEASE_EXPIRED');
      const existing = [...game.world.players.values()].find(
        (p) => p.remoteVisitor?.visitId === args.visitor.visitId,
      );
      if (existing) return existing.id;
      const id = Player.join(game, now, args.name, args.character, args.description);
      game.world.players.get(id)!.remoteVisitor = args.visitor;
      const description = game.playerDescriptions.get(id)!;
      description.originTownId = args.visitor.homeTownId;
      description.originTownName = args.visitor.homeTownName;
      description.visitId = args.visitor.visitId;
      return id;
    },
  }),
  federationRemoveVisitor: inputHandler({
    args: { visitId: v.string() },
    handler: (game, now, args) => {
      for (const player of game.world.players.values()) {
        if (player.remoteVisitor?.visitId === args.visitId) player.leave(game, now);
      }
      return null;
    },
  }),
  federationAction: inputHandler({
    args: {
      playerId,
      visitId: v.string(),
      actionId: v.string(),
      turnId: v.string(),
      agentAuthorityEpoch: v.number(),
      visitLeaseVersion: v.number(),
      deadline: v.number(),
      conversationId: v.optional(v.string()),
      expectedNumMessages: v.optional(v.number()),
      action: v.union(
        v.object({ type: v.literal('moveTo'), destination: point }),
        v.object({ type: v.literal('say'), text: v.string() }),
        v.object({ type: v.literal('inviteToTalk'), playerId }),
        v.object({ type: v.literal('acceptInvite') }),
        v.object({ type: v.literal('rejectInvite') }),
        v.object({ type: v.literal('leaveConversation') }),
        v.object({ type: v.literal('wait') }),
        v.object({ type: v.literal('leaveTown') }),
      ),
    },
    handler: (game, now, args) => {
      const player = game.world.players.get(parseGameId('players', args.playerId));
      const visitor = player?.remoteVisitor;
      if (!player || !visitor || visitor.visitId !== args.visitId)
        throw new Error('VISITOR_NOT_FOUND');
      const wallNow = Math.max(now, Date.now());
      if (visitor.leaseExpiry <= wallNow) throw new Error('LEASE_EXPIRED');
      if (args.deadline <= wallNow) throw new Error('STALE_TURN');
      if (
        visitor.agentAuthorityEpoch !== args.agentAuthorityEpoch ||
        visitor.visitLeaseVersion !== args.visitLeaseVersion
      )
        throw new Error('STALE_AUTHORITY');
      const conversation = game.world.playerConversation(player);
      if (!visitor.pendingTurn || visitor.pendingTurn.turnId !== args.turnId)
        throw new Error('STALE_TURN');
      if (
        args.conversationId &&
        (conversation?.id !== args.conversationId ||
          conversation.numMessages !== args.expectedNumMessages)
      )
        throw new Error('STALE_TURN');
      const action = args.action;
      if (action.type === 'moveTo') {
        const { destination } = action;
        if (
          !Number.isInteger(destination.x) ||
          !Number.isInteger(destination.y) ||
          blocked(game, now, destination, player.id)
        )
          throw new Error('INVALID_DESTINATION');
        const route = findRoute(game, now, player, destination);
        if (!route || route.newDestination) throw new Error('DESTINATION_UNREACHABLE');
        movePlayer(game, now, player, destination);
      } else if (action.type === 'inviteToTalk') {
        const invitee = game.world.players.get(parseGameId('players', action.playerId));
        if (!invitee) throw new Error('INVITEE_NOT_FOUND');
        const result = Conversation.start(game, now, player, invitee);
        if (result.error) throw new Error(result.error);
      } else if (action.type === 'say') {
        if (
          !conversation ||
          conversation.participants.get(player.id)?.status.kind !== 'participating'
        ) {
          throw new Error('CONVERSATION_CLOSED');
        }
        if (!action.text.trim() || action.text.length > 2000) throw new Error('INVALID_TEXT');
        if (conversation.isTyping && conversation.isTyping.playerId !== player.id)
          throw new Error('STALE_TURN');
        // Persistence happens in the same mutation that commits this engine step.
        conversation.lastMessage = { author: player.id, timestamp: wallNow };
        conversation.numMessages++;
        delete conversation.isTyping;
      } else if (action.type === 'acceptInvite' || action.type === 'rejectInvite') {
        if (!conversation) throw new Error('CONVERSATION_CLOSED');
        if (action.type === 'acceptInvite') conversation.acceptInvite(game, player);
        else conversation.rejectInvite(game, now, player);
      } else if (action.type === 'leaveConversation') {
        if (!conversation) throw new Error('CONVERSATION_CLOSED');
        conversation.leave(game, now, player);
      } else if (action.type === 'leaveTown') {
        player.leave(game, now);
      }
      delete visitor.pendingTurn;
      if (conversation?.federationTurn?.turnId === args.turnId) delete conversation.federationTurn;
      return {
        actionId: args.actionId,
        conversationId: args.conversationId ?? null,
        text: action.type === 'say' ? action.text : null,
      };
    },
  }),
};
