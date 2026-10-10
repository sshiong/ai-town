import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { verifiedIdentityKeySuccessor } from './identityKeyRotationProof';

async function matchesDeployment(
  ctx: QueryCtx | MutationCtx,
  remote: Doc<'federationPeers'>,
  rotation: Doc<'federationCredentialRotations'>,
) {
  const local = await ctx.db.query('federationIdentity').unique();
  if (
    !local ||
    !(await verifiedIdentityKeySuccessor(
      ctx,
      remote.townId,
      rotation.peerPublicKey,
      remote.publicKey,
    )) ||
    !(await verifiedIdentityKeySuccessor(
      ctx,
      local.townId,
      rotation.localPublicKey,
      local.publicKey,
    ))
  )
    return false;
  const sender = rotation.direction === 'OUTBOUND' ? local : remote;
  const recipient = rotation.direction === 'OUTBOUND' ? remote : local;
  const b = rotation.packet.body;
  return (
    b.fromTownId === sender.townId &&
    b.toTownId === recipient.townId &&
    b.senderDeploymentEpoch === sender.deploymentEpoch &&
    b.senderDeploymentInstanceId === sender.deploymentInstanceId &&
    b.expectedRecipientDeploymentEpoch === recipient.deploymentEpoch &&
    b.recipientDeploymentInstanceId === recipient.deploymentInstanceId
  );
}

export async function credentialForPeer(
  ctx: QueryCtx | MutationCtx,
  remote: Doc<'federationPeers'>,
  credentialId: string,
  now = Date.now(),
): Promise<string | undefined> {
  if (credentialId === remote.credentialId) return remote.credentialEncrypted || undefined;
  if (remote.trustState !== 'TRUSTED') return undefined;
  const rotation = await ctx.db
    .query('federationCredentialRotations')
    .withIndex('credential', (q) =>
      q.eq('peerTownId', remote.townId).eq('newCredentialId', remote.credentialId),
    )
    .unique();
  if (
    rotation?.state !== 'COMMITTED' ||
    rotation.overlapUntil <= now ||
    rotation.oldCredentialId !== credentialId ||
    !(await matchesDeployment(ctx, remote, rotation))
  )
    return undefined;
  return rotation.previousCredentialEncrypted;
}

// Reauthenticate an immutable queued message after a known rotation. This does
// not accept packets MACed with an expired key or grant a new visit authority.
export async function renewedCredentialIdForPeer(
  ctx: QueryCtx | MutationCtx,
  remote: Doc<'federationPeers'>,
  credentialId: string,
): Promise<string | undefined> {
  if (remote.trustState !== 'TRUSTED') return undefined;
  const seen = new Set<string>();
  let nextCredentialId = credentialId;
  while (nextCredentialId !== remote.credentialId) {
    if (seen.has(nextCredentialId)) return undefined;
    seen.add(nextCredentialId);
    const rotation = await ctx.db
      .query('federationCredentialRotations')
      .withIndex('old_credential', (q) =>
        q
          .eq('peerTownId', remote.townId)
          .eq('oldCredentialId', nextCredentialId)
          .eq('state', 'COMMITTED'),
      )
      .unique();
    if (!rotation || !(await matchesDeployment(ctx, remote, rotation))) return undefined;
    nextCredentialId = rotation.newCredentialId;
  }
  return remote.credentialId;
}
