import { replyTimeoutMs } from './replyPolicy';
import type { Game } from '../aiTown/game';
import { Player } from '../aiTown/player';
import { movePlayer, stopPlayer } from '../aiTown/movement';
import { distance } from '../util/geometry';
import { CONVERSATION_DISTANCE, INVITE_TIMEOUT, MESSAGE_COOLDOWN } from '../constants';

/** Least-recently-served sources take turns; waiting visitors stay ordered within each source. */
export function tickRemoteVisitors(game: Game, now: number) {
  const groups = new Map<string, Player[]>();
  for (const player of game.world.players.values()) {
    const visitor = player.remoteVisitor;
    if (!visitor || visitor.leaseExpiry <= Math.max(now, Date.now())) continue;
    const group = groups.get(visitor.homeTownId) ?? [];
    group.push(player);
    groups.set(visitor.homeTownId, group);
  }
  const ordered = [...groups.entries()]
    .map(([townId, players]) => ({
      townId,
      lastServedAt: Math.max(...players.map((p) => p.remoteVisitor!.lastObservationAt)),
      players: players.sort(
        (a, b) =>
          a.remoteVisitor!.lastObservationAt - b.remoteVisitor!.lastObservationAt ||
          a.id.localeCompare(b.id),
      ),
    }))
    .sort((a, b) => a.lastServedAt - b.lastServedAt || a.townId.localeCompare(b.townId));
  // One visitor per source per round prevents a source with many bodies taking
  // every remaining decision slot before a smaller source is considered.
  const rounds = Math.max(0, ...ordered.map((group) => group.players.length));
  for (let round = 0; round < rounds; round++)
    for (const group of ordered)
      if (group.players[round]) tickRemoteVisitor(game, now, group.players[round]);
}

/** Only Host physics and observation timing run here; visitor reasoning stays at Home. */
export function tickRemoteVisitor(game: Game, now: number, player: Player) {
  const visitor = player.remoteVisitor;
  if (!visitor || visitor.leaseExpiry <= Math.max(now, Date.now())) return;
  const conversation = game.world.playerConversation(player);
  const member = conversation?.participants.get(player.id);
  if (member?.status.kind === 'walkingOver' && conversation) {
    if (member.invited + INVITE_TIMEOUT < now) {
      conversation.leave(game, now, player);
      return;
    }
    const otherId = [...conversation.participants.keys()].find((id) => id !== player.id);
    const other = otherId ? game.world.players.get(otherId) : undefined;
    if (
      other &&
      distance(player.position, other.position) >= CONVERSATION_DISTANCE &&
      !player.pathfinding
    ) {
      movePlayer(game, now, player, {
        x: Math.floor((player.position.x + other.position.x) / 2),
        y: Math.floor((player.position.y + other.position.y) / 2),
      });
    }
    return;
  }
  if (visitor.pendingTurn && visitor.pendingTurn.deadline > now) return;
  const pending = [...game.world.players.values()].filter(
    (p) => p.remoteVisitor?.pendingTurn && p.remoteVisitor.pendingTurn.deadline > now,
  ).length;
  if (pending + game.otherPendingDecisions >= game.resourceLimits.maxPendingDecisions) return;
  if (visitor.lastObservationAt + 5000 > now) return;
  if (conversation?.federationTurn && conversation.federationTurn.deadline > now) return;
  if (conversation?.isTyping && conversation.isTyping.playerId !== player.id) return;
  if (conversation?.lastMessage && conversation.lastMessage.timestamp + MESSAGE_COOLDOWN > now)
    return;
  if (
    conversation?.lastMessage?.author === player.id &&
    conversation.lastMessage.timestamp + 15000 > now
  )
    return;
  const eventId = crypto.randomUUID(),
    turnId = crypto.randomUUID();
  const deadline = Math.min(now + replyTimeoutMs(visitor.replyTimeoutMs), visitor.leaseExpiry);
  visitor.pendingTurn = { eventId, turnId, deadline };
  visitor.lastObservationAt = now;
  if (conversation && member?.status.kind === 'participating') {
    stopPlayer(player);
    conversation.federationTurn = {
      playerId: player.id,
      eventId,
      turnId,
      deadline,
      expectedNumMessages: conversation.numMessages,
    };
    conversation.setIsTyping(now, player, turnId);
  }
}
