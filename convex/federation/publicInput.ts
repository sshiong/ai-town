import { MutationCtx } from '../_generated/server';
import { Id } from '../_generated/dataModel';

const humanInputs = new Set([
  'moveTo',
  'leave',
  'startConversation',
  'startTyping',
  'finishSendingMessage',
  'acceptInvite',
  'rejectInvite',
  'leaveConversation',
]);
/** The browser controls only its human presence; system and federation inputs stay internal. */
export async function validatePublicInput(
  ctx: MutationCtx,
  worldId: Id<'worlds'>,
  name: string,
  args: Record<string, unknown>,
) {
  if (!humanInputs.has(name)) throw new Error('SYSTEM_INPUT_NOT_PUBLIC');
  const world = await ctx.db.get(worldId);
  const player = world?.players.find((p) => p.id === args?.playerId);
  if (!player || !player.human || player.remoteVisitor) throw new Error('PLAYER_NOT_HUMAN');
  const identity = await ctx.auth.getUserIdentity();
  const token = identity?.tokenIdentifier;
  // Preserve the upstream anonymous single-human mode; authenticated games are owner checked.
  if (token && player.human !== token) throw new Error('PLAYER_NOT_OWNED');
}
