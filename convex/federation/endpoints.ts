import { v } from 'convex/values';
import type { HttpRouter } from 'convex/server';
import {
  action,
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  ActionCtx,
  MutationCtx,
} from '../maintenanceFunctions';
import type { Doc } from '../_generated/dataModel';
import { identity, peer, session } from './store';
import { actionRef, mutationRef, queryRef } from './refs';
import { directRequest, readRequest } from './direct';
import {
  FederationMessage,
  normalizeEndpoint,
  PROTOCOL,
  SignedPacket,
  validateEnvelope,
} from './protocol';
import { digest, requireAdmin, signPacket, verifyPacket } from './security';
import { assertNoIdentityConflict, observeSignedIdentity } from './identityConflict';

type Local = Doc<'federationIdentity'>;
type Peer = Doc<'federationPeers'>;
type Update = {
  protocol: string;
  type: 'ENDPOINT_UPDATE';
  updateId: string;
  fromTownId: string;
  toTownId: string;
  senderDeploymentInstanceId: string;
  senderDeploymentEpoch: number;
  recipientDeploymentInstanceId: string;
  expectedRecipientDeploymentEpoch: number;
  credentialId: string;
  previousEndpoint: string;
  newEndpoint: string;
  sequence: number;
  operator: string;
  reason: string;
  nonce: string;
  sentAt: number;
  expiresAt: number;
};
type UpdatePacket = SignedPacket<Update>;
type ProbeAck = {
  protocol: string;
  type: string;
  fromTownId: string;
  toTownId: string;
  senderDeploymentInstanceId: string;
  senderDeploymentEpoch: number;
  expectedRecipientDeploymentEpoch: number;
  credentialId: string;
  nonce: string;
  probeId: string;
  messageId: string;
  expiresAt: number;
  endpoint?: string;
  endpointSequence?: number;
};
const updateRow = async (ctx: MutationCtx, direction: string, townId: string, updateId: string) =>
  ctx.db
    .query('federationEndpointUpdates')
    .withIndex('update', (q) =>
      q.eq('direction', direction).eq('peerTownId', townId).eq('updateId', updateId),
    )
    .unique();
const details = { operator: v.string(), reason: v.string() };
function validateDetails(operator: string, reason: string) {
  if (
    typeof operator !== 'string' ||
    typeof reason !== 'string' ||
    !operator.trim() ||
    operator.length > 100 ||
    !reason.trim() ||
    reason.length > 1000
  )
    throw new Error('ENDPOINT_REVIEW_DETAILS_REQUIRED');
}
function validateUpdate(packet: UpdatePacket) {
  const b = packet?.body;
  if (
    !b ||
    b.protocol !== PROTOCOL ||
    b.type !== 'ENDPOINT_UPDATE' ||
    typeof packet.signature !== 'string' ||
    typeof packet.mac !== 'string' ||
    [
      'updateId',
      'fromTownId',
      'toTownId',
      'senderDeploymentInstanceId',
      'recipientDeploymentInstanceId',
      'credentialId',
      'nonce',
    ].some(
      (field) =>
        typeof (b as any)[field] !== 'string' ||
        !(b as any)[field] ||
        (b as any)[field].length > 200,
    ) ||
    !Number.isSafeInteger(b.sequence) ||
    b.sequence < 1 ||
    b.sequence >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(b.senderDeploymentEpoch) ||
    b.senderDeploymentEpoch < 1 ||
    !Number.isSafeInteger(b.expectedRecipientDeploymentEpoch) ||
    b.expectedRecipientDeploymentEpoch < 1 ||
    !Number.isFinite(b.sentAt) ||
    b.sentAt < 0 ||
    b.sentAt > Date.now() + 30000 ||
    !Number.isFinite(b.expiresAt) ||
    b.expiresAt <= Date.now() ||
    b.expiresAt <= b.sentAt ||
    b.expiresAt > Date.now() + 60000 ||
    new TextEncoder().encode(JSON.stringify(packet)).length > 16000
  )
    throw new Error('INVALID_ENDPOINT_UPDATE');
  validateDetails(b.operator, b.reason);
  if (
    normalizeEndpoint(b.newEndpoint) !== b.newEndpoint ||
    normalizeEndpoint(b.previousEndpoint) !== b.previousEndpoint
  )
    throw new Error('INVALID_ENDPOINT_UPDATE');
  return b;
}
function acceptedSequence(remote: Peer) {
  return remote.endpointSequenceDeploymentInstanceId === remote.deploymentInstanceId &&
    remote.endpointSequenceDeploymentEpoch === remote.deploymentEpoch
    ? (remote.endpointSequence ?? 0)
    : 0;
}
async function resetConnection(ctx: MutationCtx, townId: string, error?: string) {
  const connection = await session(ctx, townId);
  if (connection)
    await ctx.db.patch(connection._id, {
      channelState: 'TRANSPORT_TESTING',
      inboundVerifiedAt: undefined,
      outboundVerifiedAt: undefined,
      lastError: error,
    });
}
async function verifyIdentity(packet: UpdatePacket, local: Local | null, remote: Peer | null) {
  const b = validateUpdate(packet);
  if (
    !local ||
    !remote ||
    b.fromTownId !== remote.townId ||
    b.toTownId !== local.townId ||
    b.credentialId !== remote.credentialId ||
    !remote.credentialEncrypted ||
    !(await verifyPacket(packet, remote.publicKey, remote.credentialEncrypted))
  )
    throw new Error('ENDPOINT_AUTH_FAILED');
  return { b, local, remote };
}
function assertCurrent(b: Update, local: Local, remote: Peer) {
  if (local.mode !== 'ACTIVE' || remote.trustState !== 'TRUSTED')
    throw new Error('PEER_NOT_TRUSTED');
  if (
    b.senderDeploymentInstanceId !== remote.deploymentInstanceId ||
    b.senderDeploymentEpoch !== remote.deploymentEpoch
  )
    throw new Error('SENDER_DEPLOYMENT_MISMATCH');
  if (
    b.recipientDeploymentInstanceId !== local.deploymentInstanceId ||
    b.expectedRecipientDeploymentEpoch !== local.deploymentEpoch
  )
    throw new Error('RECIPIENT_DEPLOYMENT_MISMATCH');
}

/** Endpoint changes retain the pair credential; identity, credentials and addresses are separate. */
export async function commitLocalEndpoint(
  ctx: MutationCtx,
  args: { endpoint: string; operator: string; reason: string },
) {
  validateDetails(args.operator, args.reason);
  await assertNoIdentityConflict(ctx);
  const local = await identity(ctx);
  if (!local) throw new Error('INITIALIZE_IDENTITY_FIRST');
  if (local.mode !== 'ACTIVE') throw new Error('DEPLOYMENT_NOT_ACTIVE');
  const endpoint = normalizeEndpoint(args.endpoint);
  if (endpoint === local.endpoint)
    return { townId: local.townId, endpoint, sequence: local.endpointSequence ?? 0 };
  const sequence = (local.endpointSequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER)
    throw new Error('ENDPOINT_SEQUENCE_EXHAUSTED');
  await ctx.db.patch(local._id, { endpoint, endpointSequence: sequence });
  await ctx.db.insert('federationEndpointAudit', {
    operation: 'LOCAL_CHANGED',
    previousEndpoint: local.endpoint,
    newEndpoint: endpoint,
    sequence,
    operator: args.operator.trim(),
    reason: args.reason.trim(),
    createdAt: Date.now(),
  });
  for (const remote of await ctx.db.query('federationPeers').take(100)) {
    await resetConnection(ctx, remote.townId);
    if (remote.trustState !== 'TRUSTED') continue;
    const updateId = `${local.deploymentInstanceId}:${sequence}:${remote.townId}`;
    await ctx.db.insert('federationEndpointUpdates', {
      updateId,
      peerTownId: remote.townId,
      direction: 'OUTBOUND',
      senderDeploymentInstanceId: local.deploymentInstanceId,
      senderDeploymentEpoch: local.deploymentEpoch,
      sequence,
      previousEndpoint: local.endpoint,
      newEndpoint: endpoint,
      credentialId: remote.credentialId,
      operator: args.operator.trim(),
      reason: args.reason.trim(),
      state: 'PENDING',
      attempts: 0,
      createdAt: Date.now(),
      nextRetryAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, actionRef('endpoints/deliver'), {
      peerTownId: remote.townId,
      updateId,
    });
  }
  return { townId: local.townId, endpoint, sequence };
}
export const changeAddress = mutation({
  args: { adminToken: v.string(), endpoint: v.string(), ...details },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    return commitLocalEndpoint(ctx, args);
  },
});

export const prepareDelivery = internalMutation({
  args: { peerTownId: v.string(), updateId: v.string() },
  handler: async (ctx, args) => {
    const row = await updateRow(ctx, 'OUTBOUND', args.peerTownId, args.updateId);
    if (!row || !['PENDING', 'RUNNING'].includes(row.state) || row.nextRetryAt > Date.now())
      return null;
    const local = await identity(ctx),
      remote = await peer(ctx, args.peerTownId);
    if (!local || !remote || local.mode !== 'ACTIVE' || remote.trustState !== 'TRUSTED')
      return null;
    await assertNoIdentityConflict(ctx);
    if (
      row.senderDeploymentInstanceId !== local.deploymentInstanceId ||
      row.senderDeploymentEpoch !== local.deploymentEpoch ||
      row.sequence !== local.endpointSequence ||
      row.newEndpoint !== local.endpoint ||
      row.credentialId !== remote.credentialId
    ) {
      await ctx.db.patch(row._id, { state: 'SUPERSEDED', lastError: 'ENDPOINT_UPDATE_FENCED' });
      return null;
    }
    const body: Update = {
      protocol: PROTOCOL,
      type: 'ENDPOINT_UPDATE',
      updateId: row.updateId,
      fromTownId: local.townId,
      toTownId: remote.townId,
      senderDeploymentInstanceId: local.deploymentInstanceId,
      senderDeploymentEpoch: local.deploymentEpoch,
      recipientDeploymentInstanceId: remote.deploymentInstanceId,
      expectedRecipientDeploymentEpoch: remote.deploymentEpoch,
      credentialId: remote.credentialId,
      previousEndpoint: row.previousEndpoint,
      newEndpoint: row.newEndpoint,
      sequence: row.sequence,
      operator: row.operator,
      reason: row.reason,
      nonce: crypto.randomUUID(),
      sentAt: Date.now(),
      expiresAt: Date.now() + 60000,
    };
    const packet = await signPacket(body, local.privateKeyEncrypted, remote.credentialEncrypted);
    await ctx.db.patch(row._id, {
      state: 'RUNNING',
      attempts: row.attempts + 1,
      packet,
      requestDigest: await digest(packet),
      nextRetryAt: Date.now() + 30000,
    });
    return { packet, endpoint: remote.endpoint, attempt: row.attempts + 1 };
  },
});
export const deliveryFailed = internalMutation({
  args: { peerTownId: v.string(), updateId: v.string(), attempt: v.number(), error: v.string() },
  handler: async (ctx, args) => {
    const row = await updateRow(ctx, 'OUTBOUND', args.peerTownId, args.updateId);
    if (!row || row.state !== 'RUNNING' || row.attempts !== args.attempt) return;
    const delay = Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 9));
    await ctx.db.patch(row._id, {
      state: 'PENDING',
      nextRetryAt: Date.now() + delay,
      lastError: args.error,
    });
    await ctx.db.insert('federationEndpointAudit', {
      operation: 'DELIVERY_FAILED',
      peerTownId: row.peerTownId,
      updateId: row.updateId,
      previousEndpoint: row.previousEndpoint,
      newEndpoint: row.newEndpoint,
      sequence: row.sequence,
      operator: row.operator,
      reason: args.error,
      createdAt: Date.now(),
    });
  },
});
export const acceptAck = internalMutation({
  args: { peerTownId: v.string(), updateId: v.string(), attempt: v.number(), response: v.any() },
  handler: async (ctx, args) => {
    const row = await updateRow(ctx, 'OUTBOUND', args.peerTownId, args.updateId);
    const local = await identity(ctx),
      remote = await peer(ctx, args.peerTownId),
      response = args.response as SignedPacket<any>,
      b = response?.body;
    if (
      !row ||
      row.state !== 'RUNNING' ||
      row.attempts !== args.attempt ||
      !local ||
      !remote ||
      !row.packet
    )
      throw new Error('ENDPOINT_UPDATE_CONTEXT_CHANGED');
    await assertNoIdentityConflict(ctx);
    const request = row.packet as UpdatePacket;
    if (
      local.mode !== 'ACTIVE' ||
      remote.trustState !== 'TRUSTED' ||
      row.sequence !== local.endpointSequence ||
      local.endpoint !== row.newEndpoint ||
      local.deploymentInstanceId !== row.senderDeploymentInstanceId ||
      local.deploymentEpoch !== row.senderDeploymentEpoch ||
      row.credentialId !== remote.credentialId ||
      !b ||
      !(await verifyPacket(response, remote.publicKey, remote.credentialEncrypted)) ||
      b.protocol !== PROTOCOL ||
      b.type !== 'ENDPOINT_UPDATE_ACK' ||
      b.status !== 'ACCEPTED' ||
      b.fromTownId !== remote.townId ||
      b.toTownId !== local.townId ||
      b.credentialId !== remote.credentialId ||
      b.senderDeploymentInstanceId !== remote.deploymentInstanceId ||
      b.senderDeploymentEpoch !== remote.deploymentEpoch ||
      b.expectedRecipientDeploymentEpoch !== local.deploymentEpoch ||
      b.updateId !== row.updateId ||
      b.sequence !== row.sequence ||
      b.nonce !== request.body.nonce ||
      b.requestDigest !== row.requestDigest ||
      !Number.isFinite(b.expiresAt) ||
      b.expiresAt <= Date.now() ||
      b.expiresAt > Date.now() + 60000
    )
      throw new Error('INVALID_ENDPOINT_UPDATE_ACK');
    await ctx.db.patch(row._id, { state: 'ACKED', response, lastError: undefined });
    await ctx.db.insert('federationEndpointAudit', {
      operation: 'UPDATE_ACKED',
      peerTownId: remote.townId,
      updateId: row.updateId,
      previousEndpoint: row.previousEndpoint,
      newEndpoint: row.newEndpoint,
      sequence: row.sequence,
      operator: row.operator,
      reason: row.reason,
      createdAt: Date.now(),
      evidence: { body: b, signature: response.signature },
    });
    await ctx.scheduler.runAfter(0, actionRef('transport/probeInternal'), {
      peerTownId: remote.townId,
    });
  },
});
export const deliver = internalAction({
  args: { peerTownId: v.string(), updateId: v.string() },
  handler: async (ctx, args) => {
    const prepared = (await ctx.runMutation(mutationRef('endpoints/prepareDelivery'), args)) as {
      packet: UpdatePacket;
      endpoint: string;
      attempt: number;
    } | null;
    if (!prepared) return;
    try {
      const response = await directRequest(prepared.endpoint, '/peers/endpoints', prepared.packet);
      await observeSignedIdentity(ctx, response, 'ENDPOINT');
      await ctx.runMutation(mutationRef('endpoints/acceptAck'), {
        ...args,
        attempt: prepared.attempt,
        response,
      });
    } catch (error) {
      await ctx.runMutation(mutationRef('endpoints/deliveryFailed'), {
        ...args,
        attempt: prepared.attempt,
        error: error instanceof Error ? error.message : 'ENDPOINT_DELIVERY_FAILED',
      });
    }
  },
});

export const stageUpdate = internalMutation({
  args: { packet: v.any() },
  handler: async (ctx, args) => {
    const packet = args.packet as UpdatePacket;
    const { b, local, remote } = await verifyIdentity(
      packet,
      await identity(ctx),
      await peer(ctx, packet?.body?.fromTownId),
    );
    assertCurrent(b, local, remote);
    await assertNoIdentityConflict(ctx);
    const existing = await updateRow(ctx, 'INBOUND', remote.townId, b.updateId),
      requestDigest = await digest(packet);
    if (
      existing &&
      (existing.sequence !== b.sequence ||
        existing.newEndpoint !== b.newEndpoint ||
        existing.senderDeploymentInstanceId !== b.senderDeploymentInstanceId ||
        existing.senderDeploymentEpoch !== b.senderDeploymentEpoch)
    )
      throw new Error('ENDPOINT_UPDATE_ID_CONFLICT');
    if (existing?.state === 'ACKED' && existing.requestDigest === requestDigest)
      return { response: existing.response };
    if (
      b.sequence < acceptedSequence(remote) ||
      (b.sequence === acceptedSequence(remote) && b.newEndpoint !== remote.endpoint)
    )
      throw new Error('STALE_ENDPOINT_SEQUENCE');
    const higher = await ctx.db
      .query('federationEndpointUpdates')
      .withIndex('sender_sequence', (q) =>
        q
          .eq('peerTownId', remote.townId)
          .eq('direction', 'INBOUND')
          .eq('senderDeploymentInstanceId', remote.deploymentInstanceId)
          .eq('senderDeploymentEpoch', remote.deploymentEpoch)
          .gt('sequence', b.sequence),
      )
      .first();
    if (higher) throw new Error('STALE_ENDPOINT_SEQUENCE');
    const oldNonce = await ctx.db
      .query('federationReplayNonces')
      .withIndex('nonce', (q) => q.eq('peerTownId', remote.townId).eq('nonce', b.nonce))
      .unique();
    if (oldNonce && oldNonce.expiresAt > Date.now()) throw new Error('REPLAYED_NONCE');
    if (oldNonce) await ctx.db.delete(oldNonce._id);
    if (
      (
        await ctx.db
          .query('federationReplayNonces')
          .withIndex('expiry', (q) => q.gt('expiresAt', Date.now()))
          .take(4001)
      ).length >= 4000
    )
      throw new Error('REPLAY_WINDOW_CAPACITY_EXCEEDED');
    await ctx.db.insert('federationReplayNonces', {
      peerTownId: remote.townId,
      nonce: b.nonce,
      expiresAt: b.expiresAt,
    });
    const fields = {
      updateId: b.updateId,
      peerTownId: remote.townId,
      direction: 'INBOUND',
      senderDeploymentInstanceId: b.senderDeploymentInstanceId,
      senderDeploymentEpoch: b.senderDeploymentEpoch,
      sequence: b.sequence,
      previousEndpoint: remote.endpoint,
      newEndpoint: b.newEndpoint,
      credentialId: b.credentialId,
      operator: b.operator,
      reason: b.reason,
      state: 'VERIFYING',
      packet,
      requestDigest,
      attempts: (existing?.attempts ?? 0) + 1,
      createdAt: existing?.createdAt ?? Date.now(),
      nextRetryAt: 0,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert('federationEndpointUpdates', fields);
    await resetConnection(ctx, remote.townId, 'ENDPOINT_VERIFYING');
    return {
      local,
      remote,
      requestDigest,
      expectedLocalEndpoint: local.endpoint,
      expectedPeerEndpoint: remote.endpoint,
    };
  },
});

async function challengeEndpoint(
  ctx: Pick<ActionCtx, 'runMutation'>,
  local: Local,
  remote: Peer,
  endpoint: string,
) {
  const nonce = crypto.randomUUID();
  const probe: FederationMessage = {
    protocol: PROTOCOL,
    type: 'TRANSPORT_PROBE',
    messageId: crypto.randomUUID(),
    fromTownId: local.townId,
    toTownId: remote.townId,
    senderDeploymentInstanceId: local.deploymentInstanceId,
    senderDeploymentEpoch: local.deploymentEpoch,
    expectedRecipientDeploymentEpoch: remote.deploymentEpoch,
    credentialId: remote.credentialId,
    sentAt: Date.now(),
    expiresAt: Date.now() + 30000,
    nonce,
    payload: { probeId: crypto.randomUUID(), nonce },
  };
  const probePacket = await signPacket(
    probe,
    local.privateKeyEncrypted,
    remote.credentialEncrypted,
  );
  const ack = (await directRequest(endpoint, '/probe', probePacket)) as SignedPacket<ProbeAck>;
  await observeSignedIdentity(ctx, ack, 'ACK');
  await validateProbeProof(local, remote, probePacket, ack);
  return { probe: probePacket, ack };
}
async function validateProbeProof(
  local: Local,
  remote: Peer,
  probePacket: SignedPacket<FederationMessage>,
  ack: SignedPacket<ProbeAck>,
) {
  const p = probePacket?.body,
    b = ack?.body;
  validateEnvelope(p);
  if (
    p.type !== 'TRANSPORT_PROBE' ||
    p.fromTownId !== local.townId ||
    p.toTownId !== remote.townId ||
    p.senderDeploymentInstanceId !== local.deploymentInstanceId ||
    p.senderDeploymentEpoch !== local.deploymentEpoch ||
    p.expectedRecipientDeploymentEpoch !== remote.deploymentEpoch ||
    p.credentialId !== remote.credentialId ||
    !(await verifyPacket(probePacket, local.publicKey, remote.credentialEncrypted)) ||
    !b ||
    !(await verifyPacket(ack, remote.publicKey, remote.credentialEncrypted)) ||
    b.protocol !== PROTOCOL ||
    b.type !== 'TRANSPORT_PROBE_ACK' ||
    b.fromTownId !== remote.townId ||
    b.toTownId !== local.townId ||
    b.senderDeploymentInstanceId !== remote.deploymentInstanceId ||
    b.senderDeploymentEpoch !== remote.deploymentEpoch ||
    b.expectedRecipientDeploymentEpoch !== local.deploymentEpoch ||
    b.credentialId !== remote.credentialId ||
    b.probeId !== p.payload.probeId ||
    b.nonce !== p.nonce ||
    b.messageId !== p.messageId ||
    !Number.isFinite(b.expiresAt) ||
    b.expiresAt <= Date.now() ||
    b.expiresAt > p.expiresAt
  )
    throw new Error('ENDPOINT_IDENTITY_UNVERIFIED');
}
export const commitUpdate = internalMutation({
  args: {
    packet: v.any(),
    probe: v.any(),
    ack: v.any(),
    expectedLocalEndpoint: v.string(),
    expectedPeerEndpoint: v.string(),
  },
  handler: async (ctx, args) => {
    const packet = args.packet as UpdatePacket,
      b = validateUpdate(packet);
    const verified = await verifyIdentity(
      packet,
      await identity(ctx),
      await peer(ctx, b.fromTownId),
    );
    const { local, remote } = verified;
    assertCurrent(b, local, remote);
    await assertNoIdentityConflict(ctx);
    const row = await updateRow(ctx, 'INBOUND', remote.townId, b.updateId);
    if (
      !row ||
      row.state !== 'VERIFYING' ||
      row.requestDigest !== (await digest(packet)) ||
      local.endpoint !== args.expectedLocalEndpoint ||
      remote.endpoint !== args.expectedPeerEndpoint ||
      b.sequence < acceptedSequence(remote) ||
      (b.sequence === acceptedSequence(remote) && remote.endpoint !== b.newEndpoint)
    )
      throw new Error('ENDPOINT_UPDATE_CONTEXT_CHANGED');
    const probe = args.probe as SignedPacket<FederationMessage>,
      ack = args.ack as SignedPacket<ProbeAck>;
    await validateProbeProof(local, remote, probe, ack);
    if (ack.body.endpoint !== b.newEndpoint || ack.body.endpointSequence !== b.sequence)
      throw new Error('ENDPOINT_SOURCE_CHANGED');
    const higher = await ctx.db
      .query('federationEndpointUpdates')
      .withIndex('sender_sequence', (q) =>
        q
          .eq('peerTownId', remote.townId)
          .eq('direction', 'INBOUND')
          .eq('senderDeploymentInstanceId', remote.deploymentInstanceId)
          .eq('senderDeploymentEpoch', remote.deploymentEpoch)
          .gt('sequence', b.sequence),
      )
      .first();
    if (higher) throw new Error('STALE_ENDPOINT_SEQUENCE');
    await ctx.db.patch(remote._id, {
      endpoint: b.newEndpoint,
      endpointSequence: b.sequence,
      endpointSequenceDeploymentInstanceId: remote.deploymentInstanceId,
      endpointSequenceDeploymentEpoch: remote.deploymentEpoch,
    });
    const response = await signPacket(
      {
        protocol: PROTOCOL,
        type: 'ENDPOINT_UPDATE_ACK',
        status: 'ACCEPTED',
        updateId: b.updateId,
        sequence: b.sequence,
        fromTownId: local.townId,
        toTownId: remote.townId,
        senderDeploymentInstanceId: local.deploymentInstanceId,
        senderDeploymentEpoch: local.deploymentEpoch,
        expectedRecipientDeploymentEpoch: remote.deploymentEpoch,
        credentialId: remote.credentialId,
        nonce: b.nonce,
        requestDigest: row.requestDigest,
        sentAt: Date.now(),
        expiresAt: Date.now() + 30000,
      },
      local.privateKeyEncrypted,
      remote.credentialEncrypted,
    );
    await ctx.db.patch(row._id, { state: 'ACKED', response });
    await ctx.db.insert('federationEndpointAudit', {
      operation: 'PEER_UPDATED',
      peerTownId: remote.townId,
      updateId: b.updateId,
      previousEndpoint: remote.endpoint,
      newEndpoint: b.newEndpoint,
      sequence: b.sequence,
      operator: b.operator,
      reason: b.reason,
      createdAt: Date.now(),
      evidence: { body: b, signature: packet.signature },
    });
    await resetConnection(ctx, remote.townId);
    await ctx.scheduler.runAfter(0, actionRef('transport/probeInternal'), {
      peerTownId: remote.townId,
    });
    return response;
  },
});
export const receiveUpdate = internalAction({
  args: { packet: v.any() },
  handler: async (ctx, args) => {
    const packet = args.packet as UpdatePacket,
      b = validateUpdate(packet);
    // The evidence transaction commits separately if this is a genuinely signed clone.
    await observeSignedIdentity(ctx, packet, 'ENDPOINT');
    const staged = (await ctx.runMutation(mutationRef('endpoints/stageUpdate'), args)) as {
      response?: unknown;
      local: Local;
      remote: Peer;
      expectedLocalEndpoint: string;
      expectedPeerEndpoint: string;
    };
    if (staged.response) return staged.response;
    try {
      const proof = await challengeEndpoint(ctx, staged.local, staged.remote, b.newEndpoint);
      return await ctx.runMutation(mutationRef('endpoints/commitUpdate'), {
        packet,
        ...proof,
        expectedLocalEndpoint: staged.expectedLocalEndpoint,
        expectedPeerEndpoint: staged.expectedPeerEndpoint,
      });
    } catch (error) {
      await ctx.runMutation(mutationRef('endpoints/verificationFailed'), {
        peerTownId: b.fromTownId,
        updateId: b.updateId,
        requestDigest: await digest(packet),
        error: error instanceof Error ? error.message : 'ENDPOINT_IDENTITY_UNVERIFIED',
      });
      throw error;
    }
  },
});

export const verificationFailed = internalMutation({
  args: {
    peerTownId: v.string(),
    updateId: v.string(),
    requestDigest: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await updateRow(ctx, 'INBOUND', args.peerTownId, args.updateId);
    if (!row || row.state !== 'VERIFYING' || row.requestDigest !== args.requestDigest) return;
    await ctx.db.patch(row._id, { state: 'FAILED', lastError: args.error });
    await resetConnection(ctx, args.peerTownId, 'ENDPOINT_IDENTITY_UNVERIFIED');
    await ctx.db.insert('federationEndpointAudit', {
      operation: 'VERIFICATION_FAILED',
      peerTownId: row.peerTownId,
      updateId: row.updateId,
      previousEndpoint: row.previousEndpoint,
      newEndpoint: row.newEndpoint,
      sequence: row.sequence,
      operator: row.operator,
      reason: args.error,
      createdAt: Date.now(),
    });
  },
});

export const commitManualVerification = internalMutation({
  args: {
    peerTownId: v.string(),
    endpoint: v.string(),
    probe: v.any(),
    ack: v.any(),
    expectedLocalEndpoint: v.string(),
    expectedPeerEndpoint: v.string(),
    ...details,
  },
  handler: async (ctx, args) => {
    validateDetails(args.operator, args.reason);
    await assertNoIdentityConflict(ctx);
    const local = await identity(ctx),
      remote = await peer(ctx, args.peerTownId);
    if (!local || !remote || local.mode !== 'ACTIVE' || remote.trustState !== 'TRUSTED')
      throw new Error('PEER_NOT_TRUSTED');
    if (
      local.endpoint !== args.expectedLocalEndpoint ||
      remote.endpoint !== args.expectedPeerEndpoint
    )
      throw new Error('ENDPOINT_UPDATE_CONTEXT_CHANGED');
    const endpoint = normalizeEndpoint(args.endpoint),
      probe = args.probe as SignedPacket<FederationMessage>,
      ack = args.ack as SignedPacket<ProbeAck>;
    await validateProbeProof(local, remote, probe, ack);
    if (
      !Number.isSafeInteger(ack.body.endpointSequence) ||
      ack.body.endpointSequence! < 0 ||
      ack.body.endpointSequence! >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('INVALID_ENDPOINT_SEQUENCE');
    const sequence = ack.body.endpointSequence!;
    if (ack.body.endpoint !== endpoint) throw new Error('ENDPOINT_SOURCE_CHANGED');
    if (
      sequence < acceptedSequence(remote) ||
      (sequence === acceptedSequence(remote) && sequence > 0 && endpoint !== remote.endpoint)
    )
      throw new Error('STALE_ENDPOINT_SEQUENCE');
    await ctx.db.patch(remote._id, {
      endpoint,
      endpointSequence: sequence,
      endpointSequenceDeploymentInstanceId: remote.deploymentInstanceId,
      endpointSequenceDeploymentEpoch: remote.deploymentEpoch,
    });
    await resetConnection(ctx, remote.townId);
    await ctx.db.insert('federationEndpointAudit', {
      operation: 'MANUAL_VERIFIED',
      peerTownId: remote.townId,
      previousEndpoint: remote.endpoint,
      newEndpoint: endpoint,
      sequence,
      operator: args.operator.trim(),
      reason: args.reason.trim(),
      createdAt: Date.now(),
      evidence: { body: ack.body, signature: ack.signature },
    });
    await ctx.scheduler.runAfter(0, actionRef('transport/probeInternal'), {
      peerTownId: remote.townId,
    });
    return { endpoint, sequence, channelState: 'TRANSPORT_TESTING' };
  },
});
export const verifyPeerEndpoint = action({
  args: { adminToken: v.string(), peerTownId: v.string(), endpoint: v.string(), ...details },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    validateDetails(args.operator, args.reason);
    const endpoint = normalizeEndpoint(args.endpoint);
    const { identity: local, peer: remote } = (await ctx.runQuery(queryRef('store/context'), {
      peerTownId: args.peerTownId,
    })) as { identity: Local | null; peer: Peer | null };
    if (!local || !remote || local.mode !== 'ACTIVE' || remote.trustState !== 'TRUSTED')
      throw new Error('PEER_NOT_TRUSTED');
    const proof = await challengeEndpoint(ctx, local, remote, endpoint);
    const { adminToken: _token, ...fields } = args;
    return ctx.runMutation(mutationRef('endpoints/commitManualVerification'), {
      ...fields,
      endpoint,
      ...proof,
      expectedLocalEndpoint: local.endpoint,
      expectedPeerEndpoint: remote.endpoint,
    });
  },
});
export const pending = internalQuery({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query('federationEndpointUpdates')
      .withIndex('retry', (q) => q.eq('state', 'PENDING').lte('nextRetryAt', Date.now()))
      .take(20);
    const abandoned = await ctx.db
      .query('federationEndpointUpdates')
      .withIndex('retry', (q) => q.eq('state', 'RUNNING').lte('nextRetryAt', Date.now()))
      .take(20);
    return [...pending, ...abandoned].map((row) => ({
      updateId: row.updateId,
      peerTownId: row.peerTownId,
    }));
  },
});
export const retryPending = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows = (await ctx.runQuery(queryRef('endpoints/pending'), {})) as {
      peerTownId: string;
      updateId: string;
    }[];
    for (let index = 0; index < rows.length; index += 4)
      await Promise.all(
        rows
          .slice(index, index + 4)
          .map((row) => ctx.runAction(actionRef('endpoints/deliver'), row)),
      );
  },
});
export const retry = action({
  args: { adminToken: v.string(), peerTownId: v.string(), updateId: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    await ctx.runMutation(mutationRef('endpoints/allowRetry'), {
      peerTownId: args.peerTownId,
      updateId: args.updateId,
    });
    return ctx.runAction(actionRef('endpoints/deliver'), {
      peerTownId: args.peerTownId,
      updateId: args.updateId,
    });
  },
});
export const allowRetry = internalMutation({
  args: { peerTownId: v.string(), updateId: v.string() },
  handler: async (ctx, args) => {
    await assertNoIdentityConflict(ctx);
    const row = await updateRow(ctx, 'OUTBOUND', args.peerTownId, args.updateId);
    if (!row || !['PENDING', 'RUNNING'].includes(row.state))
      throw new Error('ENDPOINT_UPDATE_NOT_PENDING');
    if (row.state === 'RUNNING' && row.nextRetryAt > Date.now())
      throw new Error('ENDPOINT_UPDATE_IN_PROGRESS');
    await ctx.db.patch(row._id, { state: 'PENDING', nextRetryAt: Date.now() });
  },
});
export const history = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const local = await identity(ctx),
      rows = await ctx.db.query('federationEndpointUpdates').order('desc').take(100);
    return {
      endpoint: local?.endpoint,
      sequence: local?.endpointSequence ?? 0,
      updates: rows.map(
        ({
          updateId,
          peerTownId,
          direction,
          previousEndpoint,
          newEndpoint,
          sequence,
          state,
          attempts,
          nextRetryAt,
          lastError,
          createdAt,
        }) => ({
          updateId,
          peerTownId,
          direction,
          previousEndpoint,
          newEndpoint,
          sequence,
          state,
          attempts,
          nextRetryAt,
          lastError,
          createdAt,
        }),
      ),
      audit: await ctx.db.query('federationEndpointAudit').order('desc').take(100),
    };
  },
});
export function registerEndpointRoutes(http: HttpRouter) {
  http.route({
    path: '/federation/v1/peers/endpoints',
    method: 'POST',
    handler: httpAction(async (ctx, request) => {
      try {
        const packet = await readRequest(request);
        const response = await ctx.runAction(actionRef('endpoints/receiveUpdate'), { packet });
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'ENDPOINT_UPDATE_REJECTED';
        return new Response(
          JSON.stringify({
            error: /^[A-Z][A-Z0-9_]+$/.test(reason) ? reason : 'ENDPOINT_UPDATE_REJECTED',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          },
        );
      }
    }),
  });
}
