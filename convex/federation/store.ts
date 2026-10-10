import { internalQuery, MutationCtx, QueryCtx } from '../_generated/server';
import { v } from 'convex/values';
import { credentialForPeer } from './credentials';
export async function identity(ctx: QueryCtx | MutationCtx) {
  return await ctx.db.query('federationIdentity').unique();
}
export async function peer(ctx: QueryCtx | MutationCtx, townId: string) {
  return await ctx.db
    .query('federationPeers')
    .withIndex('townId', (q) => q.eq('townId', townId))
    .unique();
}
export async function visit(ctx: QueryCtx | MutationCtx, visitId: string) {
  return await ctx.db
    .query('visitLedger')
    .withIndex('visitId', (q) => q.eq('visitId', visitId))
    .unique();
}
export async function session(ctx: QueryCtx | MutationCtx, townId: string) {
  return await ctx.db
    .query('transportSessions')
    .withIndex('peerTownId', (q) => q.eq('peerTownId', townId))
    .unique();
}
export function ready(
  session: Awaited<ReturnType<typeof import('./store').session>>,
  now = Date.now(),
): boolean {
  return (
    !!session &&
    session.channelState === 'TRANSPORT_READY' &&
    !!session.outboundVerifiedAt &&
    !!session.inboundVerifiedAt &&
    Math.min(session.outboundVerifiedAt, session.inboundVerifiedAt) > now - 120_000
  );
}
export const context = internalQuery({
  args: {
    peerTownId: v.optional(v.string()),
    pairRequestId: v.optional(v.string()),
    credentialId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const remote = args.peerTownId ? await peer(ctx, args.peerTownId) : null;
    return {
      identity: await identity(ctx),
      peer: remote,
      authCredentialEncrypted:
        remote && args.credentialId
          ? await credentialForPeer(ctx, remote, args.credentialId)
          : undefined,
      pair: args.pairRequestId
        ? await ctx.db
            .query('pairRequests')
            .withIndex('requestId', (q) => q.eq('pairRequestId', args.pairRequestId!))
            .unique()
        : null,
    };
  },
});
