import { MutationCtx } from '../_generated/server';
import { FederationMessage, PROTOCOL, streamKey } from './protocol';
import { identity, peer, visit } from './store';
import { actionRef } from './refs';
export type EnqueueArgs = {
  peerTownId: string; type: string; payload: Record<string, any>; visitId?: string; streamId?: string;
  agentGlobalId?: string; agentAuthorityEpoch?: number; visitLeaseVersion?: number;
};
export async function enqueueMessage(ctx: MutationCtx, args: EnqueueArgs): Promise<string> {
  const local = await identity(ctx); const remote = await peer(ctx, args.peerTownId);
  if (!local || !remote || remote.trustState !== 'TRUSTED' && !['VISIT_RETURN', 'VISIT_CLEANED', 'SESSION_RESYNC', 'STREAM_NACK'].includes(args.type)) throw new Error('PEER_NOT_TRUSTED');
  const queued = await ctx.db.query('federationOutbox').withIndex('retry', (q) => q.eq('ackedAt', undefined)).take(1001);
  const critical = ['VISIT_RETURN', 'VISIT_CLEANED', 'VISIT_REJECT', 'SESSION_RESYNC', 'STREAM_NACK'].includes(args.type);
  // Keep admission headroom for lease termination and recovery controls.
  if (queued.length >= (critical ? 1000 : 900)) throw new Error('OUTBOX_CAPACITY_EXCEEDED');
  const ledger = args.visitId ? await visit(ctx, args.visitId) : null;
  const now = Date.now();
  const messageId = crypto.randomUUID();
  const envelope: FederationMessage = {
    protocol: PROTOCOL, messageId, fromTownId: local.townId, toTownId: remote.townId,
    senderDeploymentInstanceId: local.deploymentInstanceId, senderDeploymentEpoch: local.deploymentEpoch,
    expectedRecipientDeploymentEpoch: remote.deploymentEpoch, credentialId: remote.credentialId,
    type: args.type, payload: args.payload, sentAt: now, expiresAt: now + 10 * 60_000, nonce: crypto.randomUUID(),
  };
  if (args.visitId) {
    envelope.visitId = args.visitId;
    envelope.agentGlobalId = args.agentGlobalId ?? ledger?.agentGlobalId;
    envelope.agentAuthorityEpoch = args.agentAuthorityEpoch ?? ledger?.agentAuthorityEpoch;
    envelope.visitLeaseVersion = args.visitLeaseVersion ?? ledger?.visitLeaseVersion;
  }
  if (!['STREAM_NACK', 'SESSION_RESYNC'].includes(args.type)) {
    if (!envelope.visitId || !envelope.agentGlobalId || !envelope.agentAuthorityEpoch || !envelope.visitLeaseVersion) throw new Error('VISIT_AUTHORITY_REQUIRED');
    envelope.streamId = args.streamId ?? (args.type === 'OBSERVATION' ? 'host-observations' : args.type === 'DECISION' ? 'home-actions' : args.type === 'ACTION_RESULT' ? 'host-results' : 'lease-control');
    const key = streamKey(envelope, remote.townId);
    const cursor = await ctx.db.query('messageStreamCursors').withIndex('streamKey', (q) => q.eq('streamKey', key)).unique();
    envelope.sequence = cursor?.nextOutgoingSequence ?? 1;
    if (cursor) await ctx.db.patch(cursor._id, { nextOutgoingSequence: envelope.sequence + 1 });
    else await ctx.db.insert('messageStreamCursors', { streamKey: key, peerTownId: remote.townId, visitIdOrPairSessionId: envelope.visitId, streamId: envelope.streamId, senderTownId: local.townId, senderDeploymentEpoch: local.deploymentEpoch, direction: 'outbound', nextOutgoingSequence: 2, nextExpectedSequence: 1, lastAckedSequence: 0, resyncState: 'OK' });
  }
  await ctx.db.insert('federationOutbox', { messageId, toTownId: remote.townId, envelope, attempts: 0, nextRetryAt: now });
  await ctx.scheduler.runAfter(0, actionRef('transport/deliver'), { messageId });
  return messageId;
}
