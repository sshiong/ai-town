import { configuredTimePolicy, observeClock, canResume, readClock } from './timePolicy';
import { v } from 'convex/values';
import { HttpRouter } from 'convex/server';
import { action, httpAction, internalAction, internalMutation, internalQuery, query, MutationCtx } from '../maintenanceFunctions';
import { identity, peer, ready, session, visit } from './store';
import { directPeerRequest, endpointContextKey, readRequest } from './direct';
import { digest, requireAdmin, signPacket, verifyPacket } from './security';
import { FederationMessage, SignedPacket, PROTOCOL, sequenceDisposition, streamKey, validateEnvelope, endpointGeneration, normalizeEndpointCandidates } from './protocol';
import { actionRef, mutationRef, queryRef } from './refs';
import { enqueueMessage } from './queue';
import { assertVisitAuthority, beginReturn, dispatchLedgerMessage } from './ledger';
import { dispatchRuntimeMessage } from './runtime';
import { Doc } from '../_generated/dataModel';
import { observeSignedIdentity } from './identityConflict';
import { consumeRemoteEventBudget, recordResourceMetric } from './resourceMonitoring';
import { credentialForPeer, renewedCredentialIdForPeer } from './credentials';
import { maintainCredentialRotations } from './peerCredentialRotation';
import { maintainIdentityKeyRotations } from './identityKeyRotation';

const CLEANUP_TYPES = new Set(['VISIT_RETURN', 'VISIT_CLEANED', 'SESSION_RESYNC', 'STREAM_NACK']);
const VISIT_TYPES = new Set(['VISIT_RESERVE', 'VISIT_QUEUED', 'VISIT_RESERVED', 'VISIT_CONFIRM', 'VISIT_ACTIVE', 'VISIT_REJECT', 'VISIT_RETURN', 'VISIT_CLEANED', 'VISIT_RENEW']);
const RUNTIME_TYPES = new Set(['OBSERVATION', 'DECISION', 'ACTION_RESULT', 'CONVERSATION_ENDED']);
const EPHEMERAL_RUNTIME_TYPES = new Set(['OBSERVATION', 'DECISION', 'ACTION_RESULT']);
const CONTROL_TYPES = new Set(['STREAM_NACK', 'SESSION_RESYNC']);
const PRIORITY_DELIVERY_TYPES = new Set(['VISIT_RETURN', 'VISIT_CLEANED', 'VISIT_REJECT', 'VISIT_RENEW', 'CONVERSATION_ENDED', 'SESSION_RESYNC', 'STREAM_NACK']);
const now = () => Date.now();
function runtimeRetirementReason(message: FederationMessage, ledger: Doc<'visitLedger'> | null) {
  // History and lease cleanup have independent reliable recovery paths. Only
  // immediate runtime messages lose their meaning with their execution authority.
  if (!EPHEMERAL_RUNTIME_TYPES.has(message.type) || !ledger) return undefined;
  if (['COMPLETED', 'REJECTED'].includes(ledger.state)) return 'OUTBOX_VISIT_TERMINATED';
  if (ledger.leaseExpiry <= now()) return 'OUTBOX_VISIT_LEASE_EXPIRED';
  if (message.agentAuthorityEpoch !== ledger.agentAuthorityEpoch ||
      message.visitLeaseVersion !== ledger.visitLeaseVersion) return 'OUTBOX_RUNTIME_AUTHORITY_ENDED';
  return undefined;
}
// Historical pages retain their message/nonce/sequence and immutable contents
// across transport TTL renewal. They cannot authorize any new engine action.
export async function messageDigest(message: FederationMessage) {
  if (message.type !== 'CONVERSATION_ENDED') return digest(message);
  const { sentAt, expiresAt, ...immutable } = message;
  return digest(immutable);
}

async function verifiedContext(ctx: any, packet: SignedPacket<FederationMessage>) {
  validateEnvelope(packet?.body, now(), configuredTimePolicy(), true);
  const data = await ctx.runQuery(queryRef('store/context'), { peerTownId: packet.body.fromTownId, credentialId: packet.body.credentialId });
  validateEnvelope(packet?.body, now(), configuredTimePolicy(data.identity), !data.clock.healthy);
  if (!data.identity || !data.peer || !data.authCredentialEncrypted || !await verifyPacket(packet, data.peer.publicKey, data.authCredentialEncrypted)) throw new Error('MESSAGE_AUTH_FAILED');
  if (packet.body.senderDeploymentInstanceId !== data.peer.deploymentInstanceId || packet.body.senderDeploymentEpoch !== data.peer.deploymentEpoch)
    await observeSignedIdentity(ctx, packet, 'MESSAGE');
  return data;
}
async function authenticateIdentity(ctx: MutationCtx, message: FederationMessage) {
  const local = await identity(ctx), remote = await peer(ctx, message.fromTownId);
  if (!local || !remote || message.toTownId !== local.townId || !await credentialForPeer(ctx, remote, message.credentialId)) throw new Error('MESSAGE_AUTH_FAILED');
  if (remote.trustState !== 'TRUSTED' && !CLEANUP_TYPES.has(message.type)) throw new Error('PEER_NOT_TRUSTED');
  if (local.mode !== 'ACTIVE' && !CLEANUP_TYPES.has(message.type)) throw new Error('DEPLOYMENT_NOT_ACTIVE');
  if (message.senderDeploymentEpoch !== remote.deploymentEpoch || message.senderDeploymentInstanceId !== remote.deploymentInstanceId) throw new Error('SENDER_DEPLOYMENT_MISMATCH');
  if (message.expectedRecipientDeploymentEpoch !== local.deploymentEpoch) throw new Error('RECIPIENT_DEPLOYMENT_MISMATCH');
  return { local, remote };
}
async function rememberNonce(ctx: MutationCtx, message: FederationMessage) {
  const old = await ctx.db.query('federationReplayNonces').withIndex('nonce', q => q.eq('peerTownId', message.fromTownId).eq('nonce', message.nonce)).unique();
  if (old && old.expiresAt > now()) throw new Error('REPLAYED_NONCE');
  if (old) await ctx.db.delete(old._id);
  const active = await ctx.db.query('federationReplayNonces').withIndex('expiry', q => q.gt('expiresAt', now())).take(4001);
  if (active.length >= 4000) throw new Error('REPLAY_WINDOW_CAPACITY_EXCEEDED');
  await ctx.db.insert('federationReplayNonces', { peerTownId: message.fromTownId, nonce: message.nonce, expiresAt: message.expiresAt });
}
async function updateProbeState(ctx: MutationCtx, peerTownId: string, direction: 'inbound' | 'outbound', success: boolean, error?: string, endpoint?: string) {
  const local = await identity(ctx), remote = await peer(ctx, peerTownId); if (!local || !remote) throw new Error('PEER_NOT_TRUSTED');
  const existing = await session(ctx, peerTownId);
  const matches = existing?.localDeploymentEpoch === local.deploymentEpoch && existing?.verifiedPeerDeploymentEpoch === remote.deploymentEpoch &&
    (existing?.localEndpointGeneration ?? 0) === endpointGeneration(local) && (existing?.peerEndpointGeneration ?? 0) === endpointGeneration(remote);
  const inboundVerifiedAt = direction === 'inbound' ? success ? now() : undefined : matches ? existing?.inboundVerifiedAt : undefined;
  const outboundVerifiedAt = direction === 'outbound' ? success ? now() : undefined : matches ? existing?.outboundVerifiedAt : undefined;
  const isReady = !!inboundVerifiedAt && !!outboundVerifiedAt && Math.min(inboundVerifiedAt, outboundVerifiedAt) > now() - configuredTimePolicy(local).probeFreshnessMs;
  const record = { peerTownId, transportType: 'DIRECT_HTTPS', channelState: isReady ? 'TRANSPORT_READY' : success ? 'TRANSPORT_TESTING' : 'PAIRED_BUT_NOT_REACHABLE',
    localDeploymentEpoch: local.deploymentEpoch, verifiedPeerDeploymentEpoch: remote.deploymentEpoch, inboundVerifiedAt, outboundVerifiedAt,
    localEndpointGeneration: endpointGeneration(local), peerEndpointGeneration: endpointGeneration(remote),
    outboundEndpoint: direction === 'outbound' && success ? endpoint : matches ? existing?.outboundEndpoint : undefined,
    lastReadyAt: isReady ? now() : existing?.lastReadyAt, lastError: error ?? (success && !isReady && outboundVerifiedAt && !inboundVerifiedAt ? 'NO_BIDIRECTIONAL_PATH' : undefined) };
  if (existing) await ctx.db.patch(existing._id, record); else await ctx.db.insert('transportSessions', record);
  return record.channelState;
}
export const recordProbe = internalMutation({ args: { peerTownId: v.string(), success: v.boolean(), error: v.optional(v.string()), endpoint: v.string(), localEndpoint: v.string(), credentialId: v.string(), localDeploymentEpoch: v.number(), peerDeploymentEpoch: v.number(), peerDeploymentInstanceId: v.string(), localEndpointGeneration: v.optional(v.number()), peerEndpointGeneration: v.optional(v.number()), localDeploymentInstanceId: v.optional(v.string()), endpointContextKey: v.optional(v.string()) }, handler: async (ctx, args) => {
  const local = await identity(ctx), remote = await peer(ctx, args.peerTownId);
  if (!local || !remote) throw new Error('PEER_NOT_TRUSTED');
  if (remote.trustState !== 'TRUSTED' || !normalizeEndpointCandidates(remote.endpoint, remote.endpointCandidates).some(candidate => candidate.url === args.endpoint) || remote.credentialId !== args.credentialId || remote.deploymentEpoch !== args.peerDeploymentEpoch || remote.deploymentInstanceId !== args.peerDeploymentInstanceId || local.deploymentEpoch !== args.localDeploymentEpoch || local.endpoint !== args.localEndpoint ||
    endpointGeneration(local) !== (args.localEndpointGeneration ?? 0) || endpointGeneration(remote) !== (args.peerEndpointGeneration ?? 0) ||
    args.localDeploymentInstanceId !== undefined && local.deploymentInstanceId !== args.localDeploymentInstanceId || args.endpointContextKey !== undefined && endpointContextKey(local, remote) !== args.endpointContextKey) return (await session(ctx, args.peerTownId))?.channelState ?? 'TRANSPORT_TESTING';
  return updateProbeState(ctx, args.peerTownId, 'outbound', args.success, args.error, args.endpoint);
} });
export const acceptProbe = internalMutation({ args: { message: v.any() }, handler: async (ctx, { message }) => {
  const configured = await identity(ctx);
  validateEnvelope(message, now(), configuredTimePolicy(configured)); if (message.type !== 'TRANSPORT_PROBE') throw new Error('INVALID_PROBE');
  const { local } = await authenticateIdentity(ctx, message);
  await rememberNonce(ctx, message);
  await updateProbeState(ctx, message.fromTownId, 'inbound', true);
  return { protocol: PROTOCOL, type: 'TRANSPORT_PROBE_ACK', fromTownId: local.townId, toTownId: message.fromTownId,
    senderDeploymentInstanceId: local.deploymentInstanceId, senderDeploymentEpoch: local.deploymentEpoch,
    expectedRecipientDeploymentEpoch: message.senderDeploymentEpoch, credentialId: message.credentialId,
    probeId: message.payload.probeId, nonce: message.nonce, messageId: message.messageId, endpoint: local.endpoint, endpointCandidates: normalizeEndpointCandidates(local.endpoint, local.endpointCandidates), endpointGeneration: endpointGeneration(local), endpointSequence: local.endpointSequence ?? 0, sentAt: now(), expiresAt: Math.min(message.expiresAt, now() + 30_000) };
} });
export const receiveProbe = internalAction({ args: { packet: v.any() }, handler: async (ctx, { packet }) => {
  const data = await verifiedContext(ctx, packet);
  const body = await ctx.runMutation(mutationRef('transport/acceptProbe'), { message: packet.body });
  return signPacket(body, data.identity.privateKeyEncrypted, data.authCredentialEncrypted);
} });
export const probeInternal = internalAction({ args: { peerTownId: v.string() }, handler: async (ctx, { peerTownId }) => {
  const data = await ctx.runQuery(queryRef('store/context'), { peerTownId }), local = data.identity, remote = data.peer;
  if (!local || !remote || remote.trustState !== 'TRUSTED' || local.mode !== 'ACTIVE') throw new Error('PEER_NOT_TRUSTED');
  const message: FederationMessage = { protocol: PROTOCOL, type: 'TRANSPORT_PROBE', messageId: crypto.randomUUID(), fromTownId: local.townId, toTownId: remote.townId,
    senderDeploymentInstanceId: local.deploymentInstanceId, senderDeploymentEpoch: local.deploymentEpoch, expectedRecipientDeploymentEpoch: remote.deploymentEpoch,
    credentialId: remote.credentialId, sentAt: now(), expiresAt: now() + 30_000, nonce: crypto.randomUUID(), payload: { probeId: crypto.randomUUID() } };
  message.payload.nonce = message.nonce;
  const probeContext = { peerTownId, endpoint: remote.endpoint, localEndpoint: local.endpoint, credentialId: remote.credentialId, localDeploymentEpoch: local.deploymentEpoch, peerDeploymentEpoch: remote.deploymentEpoch, peerDeploymentInstanceId: remote.deploymentInstanceId,
    localEndpointGeneration: endpointGeneration(local), peerEndpointGeneration: endpointGeneration(remote), localDeploymentInstanceId: local.deploymentInstanceId, endpointContextKey: endpointContextKey(local, remote) };
  try {
    const result = await directPeerRequest(ctx, local, remote, '/probe', await signPacket(message, local.privateKeyEncrypted, remote.credentialEncrypted)), ack = result.value;
    const body = ack?.body;
    if (body && (body.senderDeploymentInstanceId !== remote.deploymentInstanceId || body.senderDeploymentEpoch !== remote.deploymentEpoch))
      await observeSignedIdentity(ctx, ack, 'ACK');
    if (!body || !await verifyPacket(ack, remote.publicKey, remote.credentialEncrypted) || body.protocol !== PROTOCOL || body.type !== 'TRANSPORT_PROBE_ACK' || body.fromTownId !== remote.townId || body.toTownId !== local.townId || body.senderDeploymentInstanceId !== remote.deploymentInstanceId || body.senderDeploymentEpoch !== remote.deploymentEpoch || body.expectedRecipientDeploymentEpoch !== local.deploymentEpoch || body.credentialId !== remote.credentialId || body.probeId !== message.payload.probeId || body.nonce !== message.nonce || body.messageId !== message.messageId || body.expiresAt <= now() || body.expiresAt > message.expiresAt) throw new Error('INVALID_PROBE_ACK');
    return { channelState: await ctx.runMutation(mutationRef('transport/recordProbe'), { ...probeContext, endpoint: result.endpoint, success: true }) };
  } catch (error) {
    return { channelState: await ctx.runMutation(mutationRef('transport/recordProbe'), { ...probeContext, success: false, error: error instanceof Error ? error.message : 'DIRECT_CONNECTION_FAILED' }) };
  }
} });
export const probe = action({ args: { adminToken: v.string(), peerTownId: v.string() }, handler: async (ctx, args) => {
  requireAdmin(args.adminToken); return ctx.runAction(actionRef('transport/probeInternal'), { peerTownId: args.peerTownId });
} });

async function cursorFor(ctx: MutationCtx, message: FederationMessage) {
  const key = streamKey(message, message.fromTownId);
  const old = await ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', key)).unique();
  if (old) return old;
  const id = await ctx.db.insert('messageStreamCursors', { streamKey: key, peerTownId: message.fromTownId, visitIdOrPairSessionId: message.visitId!, streamId: message.streamId!,
    senderTownId: message.fromTownId, senderDeploymentEpoch: message.senderDeploymentEpoch, direction: 'inbound', nextExpectedSequence: 1, nextOutgoingSequence: 1, lastAckedSequence: 0, resyncState: 'OK' });
  return (await ctx.db.get(id))!;
}
function ackFor(message: FederationMessage, status: string, extra: Record<string, any> = {}) {
  return { messageId: message.messageId, nonce: message.nonce, status, ...extra };
}
async function snapshot(ctx: MutationCtx, visitId: string, streamId: string) {
  const ledger = await visit(ctx, visitId);
  if (!ledger) throw new Error('VISIT_NOT_FOUND');
  const local = await identity(ctx);
  const peerTownId = ledger.role === 'home' ? ledger.hostTownId : ledger.homeTownId;
  const key = streamKey({ visitId, streamId, fromTownId: local!.townId, senderDeploymentEpoch: local!.deploymentEpoch } as FederationMessage, peerTownId);
  const cursor = await ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', key)).unique();
  const messages = await ctx.db.query('federationInbox').withIndex('visit_status', q => q.eq('envelope.visitId', visitId).eq('status', 'COMMITTED')).order('desc').take(100);
  return { visitId, state: ledger.state, role: ledger.role, cleanupConfirmed: !!ledger.cleanupConfirmed, leaseExpiry: ledger.leaseExpiry,
    agentAuthorityEpoch: ledger.agentAuthorityEpoch, visitLeaseVersion: ledger.visitLeaseVersion, streamId, nextOutgoingSequence: cursor?.nextOutgoingSequence ?? 1,
    committedMessageIds: messages.reverse().map(m => m.messageId) };
}
async function requireResync(ctx: MutationCtx, message: FederationMessage, cursor: any, reason: string) {
  await ctx.db.patch(cursor._id, { resyncState: 'RESYNC_REQUIRED', gapSince: cursor.gapSince ?? now() });
  const ledger = await visit(ctx, message.visitId!);
  if (!ledger) return;
  await beginReturn(ctx, ledger, reason);
  await enqueueMessage(ctx, { peerTownId: message.fromTownId, type: 'SESSION_RESYNC', visitId: message.visitId, payload: { mode: 'request', streamId: message.streamId, expectedSequence: cursor.nextExpectedSequence, reason } });
}
async function dispatchControl(ctx: MutationCtx, message: FederationMessage) {
  const ledger = await assertVisitAuthority(ctx, message);
  const payload = message.payload;
  if (typeof payload.streamId !== 'string' || payload.streamId.length > 100) throw new Error('INVALID_STREAM_CONTROL');
  if (message.type === 'STREAM_NACK') {
    if (!Number.isSafeInteger(payload.expectedSequence) || payload.expectedSequence < 1 || !Number.isSafeInteger(payload.receivedSequence) || payload.receivedSequence <= payload.expectedSequence || payload.receivedSequence - payload.expectedSequence > 16) throw new Error('INVALID_NACK');
    const matches = await ctx.db.query('federationOutbox').withIndex('transportSequence', q => q.eq('toTownId', message.fromTownId).eq('envelope.visitId', message.visitId).eq('envelope.streamId', payload.streamId).eq('envelope.senderDeploymentEpoch', message.expectedRecipientDeploymentEpoch).gte('envelope.sequence', payload.expectedSequence).lt('envelope.sequence', payload.receivedSequence)).take(17);
    if (matches.length !== payload.receivedSequence - payload.expectedSequence || matches.some((o, index) => o.envelope.sequence !== payload.expectedSequence + index || o.failedAt || o.envelope.expiresAt <= now())) {
      await beginReturn(ctx, ledger, 'OUTBOX_HISTORY_UNAVAILABLE');
      await enqueueMessage(ctx, { peerTownId: message.fromTownId, type: 'SESSION_RESYNC', visitId: message.visitId, payload: { mode: 'snapshot', ...(await snapshot(ctx, ledger.visitId, payload.streamId)), reason: 'OUTBOX_HISTORY_UNAVAILABLE' } });
    } else for (const item of matches) {
      await ctx.db.patch(item._id, { ackedAt: undefined, nextRetryAt: now() });
      await ctx.scheduler.runAfter(0, actionRef('transport/deliver'), { messageId: item.messageId });
    }
    return;
  }
  if (!['request', 'snapshot'].includes(payload.mode)) throw new Error('INVALID_RESYNC');
  await beginReturn(ctx, ledger, 'STREAM_RESYNC');
  if (payload.mode === 'request') {
    await enqueueMessage(ctx, { peerTownId: message.fromTownId, type: 'SESSION_RESYNC', visitId: message.visitId, payload: { mode: 'snapshot', ...(await snapshot(ctx, ledger.visitId, payload.streamId)) } });
    return;
  }
  // Missing side effects cannot be guessed. Only close/reset a stream after the
  // authenticated ledger snapshot establishes a terminated execution session.
  if (payload.role !== (ledger.role === 'home' ? 'host' : 'home') || payload.agentAuthorityEpoch !== ledger.agentAuthorityEpoch || payload.visitLeaseVersion !== ledger.visitLeaseVersion || !Number.isSafeInteger(payload.nextOutgoingSequence) || payload.nextOutgoingSequence < 1 || !Array.isArray(payload.committedMessageIds)) throw new Error('INVALID_RESYNC_SNAPSHOT');
  const peerFinished = ['COMPLETED', 'REJECTED'].includes(payload.state) && payload.cleanupConfirmed === true;
  if (peerFinished && ledger.role === 'home') {
    await ctx.db.patch(ledger._id, { cleanupConfirmed: true, state: 'RETURN_PENDING', updatedAt: now() });
    await ctx.scheduler.runAfter(0, mutationRef('runtime/resumeHome'), { visitId: ledger.visitId });
  }
  const safe = peerFinished || await canResume(ctx.db, ledger);
  if (safe) {
    // Authentication and ledger authority have already fenced both deployment
    // epochs. A snapshot must only reset the stream from that authenticated epoch.
    const key = streamKey({ ...message, streamId: payload.streamId }, message.fromTownId);
    const cursor = await ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', key)).unique();
    if (cursor) await ctx.db.patch(cursor._id, { nextExpectedSequence: Math.max(cursor.nextExpectedSequence, payload.nextOutgoingSequence), resyncState: 'ABORTED', gapSince: undefined });
    const inbox = await ctx.db.query('federationInbox').withIndex('status', q => q.eq('status', 'BUFFERED')).take(256);
    for (const item of inbox.filter(i => streamKey(i.envelope, i.fromTownId) === key)) await ctx.db.patch(item._id, { status: 'DISCARDED', processedAt: now(), ack: ackFor(item.envelope, 'DISCARDED') });
  }
}
async function dispatch(ctx: MutationCtx, message: FederationMessage) {
  if (CONTROL_TYPES.has(message.type)) return dispatchControl(ctx, message);
  if (VISIT_TYPES.has(message.type)) return dispatchLedgerMessage(ctx, message);
  if (RUNTIME_TYPES.has(message.type)) { await assertVisitAuthority(ctx, message); return dispatchRuntimeMessage(ctx, message); }
  throw new Error('UNKNOWN_MESSAGE_TYPE');
}

export const acceptMessage = internalMutation({ args: { message: v.any(), payloadDigest: v.string() }, handler: async (ctx, args) => {
  const message: FederationMessage = args.message;
  const configured = await identity(ctx);
  validateEnvelope(message, now(), configuredTimePolicy(configured), !(await readClock(ctx.db, configured)).healthy); await authenticateIdentity(ctx, message);
  if (!VISIT_TYPES.has(message.type) && !RUNTIME_TYPES.has(message.type) && !CONTROL_TYPES.has(message.type)) throw new Error('UNKNOWN_MESSAGE_TYPE');
  const existing = await ctx.db.query('federationInbox').withIndex('messageId', q => q.eq('messageId', message.messageId)).unique();
  if (existing) {
    if (existing.fromTownId !== message.fromTownId || existing.payloadDigest !== args.payloadDigest &&
        await messageDigest({ ...existing.envelope, credentialId: message.credentialId }) !== args.payloadDigest)
      throw new Error('MESSAGE_ID_CONFLICT');
    return existing.ack ?? ackFor(message, existing.status);
  }
  // Only the first reservation can precede its ledger. Retries with a new
  // message ID must still prove authority before any stale-sequence ACK.
  if (message.type !== 'VISIT_RESERVE' || await visit(ctx, message.visitId!)) await assertVisitAuthority(ctx, message);
  await consumeRemoteEventBudget(ctx, message.type);
  await rememberNonce(ctx, message);
  const pending = await ctx.db.query('federationInbox').withIndex('status', q => q.eq('status', 'BUFFERED')).take(257);
  if (pending.length >= 256) throw new Error('INBOX_CAPACITY_EXCEEDED');
  const inboxId = await ctx.db.insert('federationInbox', { messageId: message.messageId, fromTownId: message.fromTownId, payloadDigest: args.payloadDigest, envelope: message, status: 'RECEIVED', receivedAt: now() });
  await recordResourceMetric(ctx, 'INBOUND_EVENT');
  if (CONTROL_TYPES.has(message.type)) {
    await dispatch(ctx, message);
    const ack = ackFor(message, 'COMMITTED'); await ctx.db.patch(inboxId, { status: 'COMMITTED', processedAt: now(), ack }); return ack;
  }
  const cursor = await cursorFor(ctx, message);
  const disposition = sequenceDisposition(message.sequence!, cursor.nextExpectedSequence);
  if (cursor.resyncState !== 'OK' || disposition === 'resync' || cursor.gapSince && cursor.gapSince + configuredTimePolicy(await identity(ctx)).gapTimeoutMs <= now()) {
    const ack = ackFor(message, 'RESYNC_REQUIRED');
    await ctx.db.patch(inboxId, { status: 'BUFFERED', ack }); await requireResync(ctx, message, cursor, 'STREAM_GAP_UNRECOVERABLE'); return ack;
  }
  if (disposition === 'stale') {
    const ack = ackFor(message, 'STALE_SEQUENCE'); await ctx.db.patch(inboxId, { status: 'REJECTED', processedAt: now(), ack }); return ack;
  }
  if (disposition === 'buffer') {
    const ack = ackFor(message, 'BUFFERED', { expectedSequence: cursor.nextExpectedSequence });
    await ctx.db.patch(inboxId, { status: 'BUFFERED', ack }); await ctx.db.patch(cursor._id, { gapSince: cursor.gapSince ?? now() });
    await enqueueMessage(ctx, { peerTownId: message.fromTownId, type: 'STREAM_NACK', visitId: message.visitId, payload: { streamId: message.streamId, expectedSequence: cursor.nextExpectedSequence, receivedSequence: message.sequence } }); return ack;
  }
  await dispatch(ctx, message);
  const ack = ackFor(message, 'COMMITTED'); await ctx.db.patch(inboxId, { status: 'COMMITTED', processedAt: now(), ack });
  await ctx.db.patch(cursor._id, { nextExpectedSequence: message.sequence! + 1, gapSince: undefined });
  if (message.type === 'CONVERSATION_ENDED') {
    const ledger = await visit(ctx, message.visitId!);
    if (ledger) await ctx.db.patch(ledger._id, { lastDurableEventSeq: message.sequence, lastAckedEventSeq: message.sequence });
  }
  await ctx.scheduler.runAfter(0, mutationRef('transport/drainStream'), { streamKey: cursor.streamKey });
  return ack;
} });
export const drainStream = internalMutation({ args: { streamKey: v.string() }, handler: async (ctx, args) => {
  const cursor = await ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', args.streamKey)).unique();
  if (!cursor || cursor.resyncState !== 'OK') return;
  const buffered = await ctx.db.query('federationInbox').withIndex('status', q => q.eq('status', 'BUFFERED')).take(256);
  let next = cursor.nextExpectedSequence;
  for (const item of buffered.filter(i => streamKey(i.envelope, i.fromTownId) === args.streamKey).sort((a, b) => a.envelope.sequence - b.envelope.sequence)) {
    if (item.envelope.sequence !== next) break;
    try {
      validateEnvelope(item.envelope, now(), configuredTimePolicy(await identity(ctx)), !(await readClock(ctx.db, await identity(ctx))).healthy);
      const remote = await peer(ctx, item.fromTownId);
      const credentialId = remote && !await credentialForPeer(ctx, remote, item.envelope.credentialId)
        ? await renewedCredentialIdForPeer(ctx, remote, item.envelope.credentialId) : item.envelope.credentialId;
      await authenticateIdentity(ctx, { ...item.envelope, credentialId: credentialId ?? item.envelope.credentialId });
      if (item.envelope.type !== 'VISIT_RESERVE' || await visit(ctx, item.envelope.visitId!)) await assertVisitAuthority(ctx, item.envelope);
    }
    catch { await requireResync(ctx, item.envelope, cursor, 'BUFFERED_MESSAGE_NO_LONGER_VALID'); return; }
    await dispatch(ctx, item.envelope);
    await ctx.db.patch(item._id, { status: 'COMMITTED', processedAt: now(), ack: ackFor(item.envelope, 'COMMITTED') });
    if (item.envelope.type === 'CONVERSATION_ENDED') {
      const ledger = await visit(ctx, item.envelope.visitId);
      if (ledger) await ctx.db.patch(ledger._id, { lastDurableEventSeq: next, lastAckedEventSeq: next });
    }
    next++;
  }
  const remaining = buffered.some(i => streamKey(i.envelope, i.fromTownId) === args.streamKey && i.envelope.sequence >= next);
  await ctx.db.patch(cursor._id, { nextExpectedSequence: next, gapSince: remaining ? cursor.gapSince ?? now() : undefined });
} });
export const receiveMessage = internalAction({ args: { packet: v.any() }, handler: async (ctx, { packet }) => {
  const data = await verifiedContext(ctx, packet);
  const result = await ctx.runMutation(mutationRef('transport/acceptMessage'), { message: packet.body, payloadDigest: await messageDigest(packet.body) });
  const body = { protocol: PROTOCOL, type: 'MESSAGE_ACK', fromTownId: data.identity.townId, toTownId: data.peer.townId,
    senderDeploymentInstanceId: data.identity.deploymentInstanceId, senderDeploymentEpoch: data.identity.deploymentEpoch,
    expectedRecipientDeploymentEpoch: data.peer.deploymentEpoch, credentialId: packet.body.credentialId, sentAt: now(), expiresAt: now() + 30_000, ...result };
  return signPacket(body, data.identity.privateKeyEncrypted, data.authCredentialEncrypted);
} });
export const deliveryContext = internalQuery({ args: { messageId: v.string() }, handler: async (ctx, { messageId }) => {
  const item = await ctx.db.query('federationOutbox').withIndex('messageId', q => q.eq('messageId', messageId)).unique();
  const remote = item ? await peer(ctx, item.toTownId) : null;
  let authCredentialId = item?.envelope.credentialId;
  let authCredentialEncrypted = item && remote ? await credentialForPeer(ctx, remote, authCredentialId) : undefined;
  if (item && remote && !authCredentialEncrypted) {
    authCredentialId = await renewedCredentialIdForPeer(ctx, remote, item.envelope.credentialId);
    authCredentialEncrypted = authCredentialId ? await credentialForPeer(ctx, remote, authCredentialId) : undefined;
  }
  const local = await identity(ctx), clock = await readClock(ctx.db, local);
  return { item, identity: local, peer: remote, clock,
    authCredentialId, authCredentialEncrypted,
    retirementReason: item && typeof item.envelope.visitId === 'string' ? runtimeRetirementReason(item.envelope, await visit(ctx, item.envelope.visitId)) : undefined };
} });
export const markDelivery = internalMutation({ args: { messageId: v.string(), status: v.string(), error: v.optional(v.string()), localEndpointGeneration: v.optional(v.number()), peerEndpointGeneration: v.optional(v.number()), endpointContextKey: v.optional(v.string()) }, handler: async (ctx, args) => {
  const item = await ctx.db.query('federationOutbox').withIndex('messageId', q => q.eq('messageId', args.messageId)).unique();
  if (!item || item.ackedAt || item.failedAt) return;
  if (args.localEndpointGeneration !== undefined || args.peerEndpointGeneration !== undefined) {
    const local = await identity(ctx), remote = await peer(ctx, item.toTownId);
    if (!local || !remote || endpointGeneration(local) !== args.localEndpointGeneration || endpointGeneration(remote) !== args.peerEndpointGeneration || args.endpointContextKey !== undefined && endpointContextKey(local, remote) !== args.endpointContextKey) throw new Error('ENDPOINT_UPDATE_CONTEXT_CHANGED');
  }
  const attempts = item.attempts + 1;
  const committed = ['COMMITTED', 'DISCARDED'].includes(args.status);
  const retirement = !committed && typeof item.envelope.visitId === 'string' && runtimeRetirementReason(item.envelope, await visit(ctx, item.envelope.visitId));
  if (retirement) {
    await ctx.db.patch(item._id, { attempts, failedAt: now(), lastError: args.error && args.error !== retirement ? `${retirement}:${args.error}` : retirement });
    return;
  }
  await ctx.db.patch(item._id, { attempts, nextRetryAt: now() + Math.min(60_000, 500 * 2 ** Math.min(attempts, 7)), lastError: args.error ?? (committed ? undefined : args.status), ...(committed ? { ackedAt: now() } : {}) });
  if (args.status === 'COMMITTED' && item.envelope.type === 'CONVERSATION_ENDED') {
    const ledger = await visit(ctx, item.envelope.visitId);
    if (ledger) await ctx.db.patch(ledger._id, { lastAckedEventSeq: Math.max(ledger.lastAckedEventSeq ?? 0, item.envelope.sequence) });
  }
  if (committed && item.envelope.streamId) {
    const key = streamKey(item.envelope, item.toTownId);
    const cursor = await ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', key)).unique();
    if (cursor) await ctx.db.patch(cursor._id, { lastAckedSequence: Math.max(cursor.lastAckedSequence, item.envelope.sequence) });
  }
  if (args.status === 'EXPIRED' && item.envelope.type === 'CONVERSATION_ENDED') {
    await ctx.db.patch(item._id, { envelope: { ...item.envelope, sentAt: now(), expiresAt: now() + 10 * 60_000 },
      ackedAt: undefined, nextRetryAt: now(), lastError: undefined });
    return;
  }
  if (['EXPIRED', 'STALE_SEQUENCE'].includes(args.status)) {
    const ledger = await visit(ctx, item.envelope.visitId);
    if (ledger) await beginReturn(ctx, ledger, args.status === 'EXPIRED' ? 'OUTBOX_MESSAGE_EXPIRED' : 'INVALID_STALE_SEQUENCE');
    await ctx.db.patch(item._id, { failedAt: now() });
  }
  const connection = await session(ctx, item.toTownId);
  if (args.error && connection) await ctx.db.patch(connection._id, { channelState: 'TRANSPORT_DEGRADED', lastError: args.error });
} });
export const deliver = internalAction({ args: { messageId: v.string() }, handler: async (ctx, { messageId }) => {
  const data = await ctx.runQuery(queryRef('transport/deliveryContext'), { messageId });
  const item = data.item, local = data.identity, remote = data.peer;
  if (!item || item.ackedAt || item.failedAt) return;
  if (data.retirementReason) {
    await ctx.runMutation(mutationRef('transport/markDelivery'), { messageId, status: 'OBSOLETE', error: data.retirementReason });
    return;
  }
  if (!local || !remote) { await ctx.runMutation(mutationRef('transport/markDelivery'), { messageId, status: 'FAILED', error: 'PEER_NOT_FOUND' }); return; }
  const recovery = !data.clock.healthy && ['VISIT_RETURN', 'VISIT_CLEANED', 'VISIT_REJECT', 'SESSION_RESYNC', 'STREAM_NACK', 'CONVERSATION_ENDED'].includes(item.envelope.type);
  if (!recovery && item.envelope.expiresAt <= now()) { await ctx.runMutation(mutationRef('transport/markDelivery'), { messageId, status: 'EXPIRED' }); return; }
  try {
    if (!data.clock.healthy && ['VISIT_RESERVE', 'VISIT_RESERVED', 'VISIT_CONFIRM', 'VISIT_RENEW', 'OBSERVATION', 'DECISION'].includes(item.envelope.type)) throw new Error('CLOCK_UNCERTAIN');
    if (remote.trustState !== 'TRUSTED' && !CLEANUP_TYPES.has(item.envelope.type)) throw new Error('PEER_NOT_TRUSTED');
    if (local.mode !== 'ACTIVE' && !CLEANUP_TYPES.has(item.envelope.type)) throw new Error('DEPLOYMENT_NOT_ACTIVE');
    if (item.envelope.senderDeploymentEpoch !== local.deploymentEpoch || item.envelope.senderDeploymentInstanceId !== local.deploymentInstanceId || item.envelope.expectedRecipientDeploymentEpoch !== remote.deploymentEpoch) throw new Error('OUTBOX_DEPLOYMENT_FENCED');
    if (!data.authCredentialEncrypted) throw new Error('OUTBOX_CREDENTIAL_EXPIRED');
    const packet = await signPacket({ ...item.envelope, credentialId: data.authCredentialId }, local.privateKeyEncrypted, data.authCredentialEncrypted);
    const result = await directPeerRequest(ctx, local, remote, '/messages', packet), ack = result.value, body = ack?.body;
    if (body && (body.senderDeploymentInstanceId !== remote.deploymentInstanceId || body.senderDeploymentEpoch !== remote.deploymentEpoch))
      await observeSignedIdentity(ctx, ack, 'ACK');
    if (!body || !await verifyPacket(ack, remote.publicKey, data.authCredentialEncrypted) || body.protocol !== PROTOCOL || body.type !== 'MESSAGE_ACK' || body.fromTownId !== remote.townId || body.toTownId !== local.townId || body.senderDeploymentInstanceId !== remote.deploymentInstanceId || body.senderDeploymentEpoch !== remote.deploymentEpoch || body.expectedRecipientDeploymentEpoch !== local.deploymentEpoch || body.credentialId !== data.authCredentialId || body.messageId !== messageId || body.nonce !== item.envelope.nonce || !Number.isSafeInteger(body.sentAt) || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= body.sentAt || body.expiresAt - body.sentAt > 60_000 || !recovery && (body.expiresAt <= now() || body.expiresAt > now() + 60_000) || !['COMMITTED', 'BUFFERED', 'RESYNC_REQUIRED', 'DISCARDED', 'STALE_SEQUENCE'].includes(body.status)) throw new Error('INVALID_MESSAGE_ACK');
    await ctx.runMutation(mutationRef('transport/markDelivery'), { messageId, status: body.status, localEndpointGeneration: endpointGeneration(local), peerEndpointGeneration: endpointGeneration(remote), endpointContextKey: endpointContextKey(local, remote) });
  } catch (error) {
    await ctx.runMutation(mutationRef('transport/markDelivery'), { messageId, status: 'FAILED', error: error instanceof Error ? error.message : 'DIRECT_DELIVERY_FAILED' });
  }
} });
export const pendingDeliveries = internalQuery({ args: {}, handler: async ctx => {
  // Select priority work across the whole due queue, before taking the delivery
  // batch. Sorting only the first ordinary page can starve lease/history recovery.
  const priority: Doc<'federationOutbox'>[] = [];
  for (const type of PRIORITY_DELIVERY_TYPES) priority.push(...await ctx.db.query('federationOutbox').withIndex('priorityRetry', q => q.eq('envelope.type', type).eq('ackedAt', undefined).eq('failedAt', undefined).lte('nextRetryAt', now())).take(20));
  const ordinary = await ctx.db.query('federationOutbox').withIndex('retry', q => q.eq('ackedAt', undefined).eq('failedAt', undefined).lte('nextRetryAt', now())).take(20);
  const items = [...new Map([...priority, ...ordinary].map(item => [item.messageId, item])).values()];
  return items.sort((a, b) => Number(!PRIORITY_DELIVERY_TYPES.has(a.envelope.type)) - Number(!PRIORITY_DELIVERY_TYPES.has(b.envelope.type)) || a.nextRetryAt - b.nextRetryAt || a._creationTime - b._creationTime || a.messageId.localeCompare(b.messageId)).slice(0, 20).map(i => i.messageId);
} });
async function maintainSessionBatch(ctx: MutationCtx, cursor: string | null) {
  const local = await identity(ctx), policy = configuredTimePolicy(local);
  const page = await ctx.db.query('transportSessions').paginate({ cursor, numItems: 50 });
  for (const connection of page.page) {
    if (!ready(connection, now(), policy) && connection.channelState === 'TRANSPORT_READY') await ctx.db.patch(connection._id, { channelState: 'TRANSPORT_TESTING' });
    const remote = await peer(ctx, connection.peerTownId);
    if (remote?.trustState === 'TRUSTED' && Math.min(connection.outboundVerifiedAt ?? 0, connection.inboundVerifiedAt ?? 0) < now() - policy.probeIntervalMs) await ctx.scheduler.runAfter(0, actionRef('transport/probeInternal'), { peerTownId: connection.peerTownId });
  }
  // The continuation is committed with the page changes, so all later sessions
  // are visited even when the session table grows past a single transaction.
  if (!page.isDone) await ctx.scheduler.runAfter(0, mutationRef('transport/maintainSessions'), { cursor: page.continueCursor });
  return { cursor: page.continueCursor, isDone: page.isDone };
}
export const maintainSessions = internalMutation({ args: { cursor: v.union(v.string(), v.null()) }, handler: async (ctx, { cursor }) => maintainSessionBatch(ctx, cursor) });
async function recoverStreamGap(ctx: MutationCtx, messageId: string) {
  const item = await ctx.db.query('federationInbox').withIndex('messageId', q => q.eq('messageId', messageId)).unique();
  if (!item || item.status !== 'BUFFERED') return;
  const key = streamKey(item.envelope, item.fromTownId);
  const cursor = await ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', key)).unique();
  if (!cursor || cursor.direction !== 'inbound' || !['OK', 'RESYNC_REQUIRED'].includes(cursor.resyncState) || !cursor.gapSince || cursor.gapSince + configuredTimePolicy(await identity(ctx)).gapTimeoutMs > now()) return;
  try { await requireResync(ctx, item.envelope, cursor, 'STREAM_GAP_TIMEOUT'); }
  catch (error) {
    // Preserve the safe return and RESYNC_REQUIRED fence under backpressure.
    // The buffered row remains a durable retry source for the next maintenance.
    if (!(error instanceof Error) || error.message !== 'OUTBOX_CAPACITY_EXCEEDED') throw error;
  }
  await ctx.db.patch(cursor._id, { gapSince: now() });
}
export const retryStreamGap = internalMutation({ args: { messageId: v.string() }, handler: async (ctx, { messageId }) => recoverStreamGap(ctx, messageId) });
export const maintenance = internalMutation({ args: {}, handler: async ctx => {
  const local = await identity(ctx);
  await observeClock(ctx, local);
  await maintainCredentialRotations(ctx);
  await maintainIdentityKeyRotations(ctx);
  const nonces = await ctx.db.query('federationReplayNonces').withIndex('expiry', q => q.lte('expiresAt', now())).take(500);
  for (const nonce of nonces) await ctx.db.delete(nonce._id);
  await maintainSessionBatch(ctx, null);
  const buffered = await ctx.db.query('federationInbox').withIndex('status', q => q.eq('status', 'BUFFERED')).take(256);
  const streams = new Set<string>();
  let recoveredInline = false;
  // BUFFERED has an enforced global capacity of 256. Historical cursors need
  // no periodic scan; every actionable gap is reachable from its buffered row.
  for (const item of buffered) {
    const key = streamKey(item.envelope, item.fromTownId);
    if (streams.has(key)) continue;
    streams.add(key);
    const cursor = await ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', key)).unique();
    if (!cursor || cursor.direction !== 'inbound' || !['OK', 'RESYNC_REQUIRED'].includes(cursor.resyncState) || !cursor.gapSince || cursor.gapSince + configuredTimePolicy(local).gapTimeoutMs > now()) continue;
    // Each recovery may read the bounded pending Outbox twice. Split additional
    // streams into separate transactions instead of multiplying that read budget.
    if (!recoveredInline) { await recoverStreamGap(ctx, item.messageId); recoveredInline = true; }
    else await ctx.scheduler.runAfter(0, mutationRef('transport/retryStreamGap'), { messageId: item.messageId });
  }
} });
export const tick = internalAction({ args: {}, handler: async ctx => {
  await ctx.runMutation(mutationRef('transport/maintenance'), {});
  await ctx.runMutation(mutationRef('ledger/reconcile'), {});
  const ids = await ctx.runQuery(queryRef('transport/pendingDeliveries'), {});
  for (let offset = 0; offset < ids.length; offset += 4) await Promise.all(ids.slice(offset, offset + 4).map((messageId: string) => ctx.runAction(actionRef('transport/deliver'), { messageId })));
} });
export const retry = action({ args: { adminToken: v.string() }, handler: async (ctx, args) => { requireAdmin(args.adminToken); await ctx.runAction(actionRef('transport/tick'), {}); } });
export const diagnostics = query({ args: { adminToken: v.string() }, handler: async (ctx, args) => {
  requireAdmin(args.adminToken);
  const outbox = await ctx.db.query('federationOutbox').order('desc').take(100), inbox = await ctx.db.query('federationInbox').order('desc').take(100);
  return { outbox: outbox.map(({ messageId, toTownId, envelope, attempts, nextRetryAt, ackedAt, failedAt, lastError }) => ({ messageId, toTownId, type: envelope.type, visitId: envelope.visitId, attempts, nextRetryAt, ackedAt, failedAt, lastError })),
    inbox: inbox.map(({ messageId, fromTownId, envelope, status, receivedAt }) => ({ messageId, fromTownId, type: envelope.type, visitId: envelope.visitId, status, receivedAt })), actions: (await ctx.db.query('federationPendingActions').order('desc').take(100)).map(({actionId,visitId,state,result,receiptPending}) => ({actionId,visitId,state,accepted:result?.kind === 'ok',receiptPending})), streams: await ctx.db.query('messageStreamCursors').take(100) };
} });
export function registerFederationRoutes(http: HttpRouter) {
  for (const [path, reference] of [['/probe', 'transport/receiveProbe'], ['/messages', 'transport/receiveMessage']]) http.route({ path: `/federation/v1${path}`, method: 'POST', handler: httpAction(async (ctx, request) => {
    try {
      const packet = await readRequest(request);
      const response = await ctx.runAction(actionRef(reference), { packet });
      return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'FEDERATION_REJECTED';
      // Return protocol error codes only; never expose credentials or stack traces.
      const rateLimited = reason.includes('REMOTE_EVENT_RATE_EXCEEDED');
      const code = rateLimited ? 'REMOTE_EVENT_RATE_EXCEEDED' : /^[A-Z][A-Z0-9_]+$/.test(reason) ? reason : 'FEDERATION_REJECTED';
      return new Response(JSON.stringify({ error: code }), { status: rateLimited ? 429 : 400, headers: {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(rateLimited ? { 'Retry-After': '1' } : {}),
      } });
    }
  }) });
}
