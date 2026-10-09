import { action, httpAction, internalMutation, mutation } from '../_generated/server';
import { v } from 'convex/values';
import { constantTimeEqual, deriveCredential, digest, ephemeralKeys, mac, openSecret, requireAdmin, sealSecret, sign, validatePairingSecret, verifyMac, verifySignature } from './security';
import { PROTOCOL, normalizeEndpoint } from './protocol';
import { actionRef, mutationRef, queryRef } from './refs';
import { directRequest, readRequest } from './direct';
import { identity, peer, session } from './store';

const pairById = async (ctx: any, requestId: string) => ctx.db.query('pairRequests').withIndex('requestId', (q: any) => q.eq('pairRequestId', requestId)).unique();
export const requestPair = action({ args: { adminToken: v.string(), endpoint: v.string(), pairingSecret: v.string() }, handler: async (ctx, args) => {
  requireAdmin(args.adminToken); validatePairingSecret(args.pairingSecret);
  const endpoint = normalizeEndpoint(args.endpoint); const data = await ctx.runQuery(queryRef('store/context'), {});
  if (!data.identity?.enabled || data.identity.mode !== 'ACTIVE') throw new Error('FEDERATION_DISABLED');
  const local = data.identity;
  const discovery = await directRequest(endpoint, '/health');
  if (!await verifySignature(discovery.body, discovery.signature, discovery.body.publicKey) || discovery.body.protocol !== PROTOCOL || discovery.body.expiresAt < Date.now()) throw new Error('INVALID_DISCOVERY');
  if (discovery.body.townId === local.townId) throw new Error('TOWN_ID_CONFLICT');
  const keys = await ephemeralKeys(); const pairRequestId = crypto.randomUUID();
  const request = { protocol: PROTOCOL, pairRequestId, townId: local.townId, townName: local.townName, publicKey: local.publicKey, fingerprint: local.fingerprint, deploymentInstanceId: local.deploymentInstanceId, deploymentEpoch: local.deploymentEpoch, targetTownId: discovery.body.townId, endpoint: local.endpoint, ephemeralPublicKey: keys.publicKey, nonce: crypto.randomUUID(), expiresAt: Date.now() + 10 * 60_000 };
  const packet = { body: request, signature: await sign(request, local.privateKeyEncrypted), proof: await mac({ direction: 'offer', request }, args.pairingSecret) };
  await ctx.runMutation(mutationRef('peers/storeOutbound'), { request, endpoint, secretEncrypted: await sealSecret(args.pairingSecret), ephemeralPrivateEncrypted: keys.privateKeyEncrypted });
  const response = await directRequest(endpoint, '/pair', { operation: 'request', packet });
  if (!await verifySignature(response.body, response.signature, discovery.body.publicKey) || response.body.pairRequestId !== pairRequestId || response.body.townId !== discovery.body.townId) throw new Error('INVALID_PAIR_RESPONSE');
  return { pairRequestId, state: response.body.state as string };
} });
export const storeOutbound = internalMutation({ args: { request: v.any(), endpoint: v.string(), secretEncrypted: v.string(), ephemeralPrivateEncrypted: v.string() }, handler: async (ctx, args) => {
  const existing = await pairById(ctx, args.request.pairRequestId); if (existing) return;
  const recent = await ctx.db.query('pairRequests').order('desc').take(100);
  if (recent.some((r) => r.endpoint === args.endpoint && r.direction === 'OUTBOUND' && r.requestedAt > Date.now() - 60_000)) throw new Error('PAIR_RATE_LIMITED');
  await ctx.db.insert('pairRequests', { pairRequestId: args.request.pairRequestId, direction: 'OUTBOUND', state: 'PENDING_APPROVAL', request: args.request, endpoint: args.endpoint, secretEncrypted: args.secretEncrypted, ephemeralPrivateEncrypted: args.ephemeralPrivateEncrypted, requestedAt: Date.now(), expiresAt: args.request.expiresAt, attempts: 0 });
} });
export const receiveRequest = internalMutation({ args: { request: v.any(), proof: v.string() }, handler: async (ctx, args) => {
  const local = await identity(ctx); const request = args.request;
  if (!local?.enabled || !local.allowIncomingPairRequests || local.mode !== 'ACTIVE') throw new Error('PAIR_REQUESTS_DISABLED');
  if (request.targetTownId !== local.townId || request.townId === local.townId || request.protocol !== PROTOCOL || !request.pairRequestId || request.pairRequestId.length > 100 || !request.townId || request.townId.length > 200 || typeof request.townName !== 'string' || request.townName.length > 80 || typeof request.nonce !== 'string' || !request.nonce || request.nonce.length > 200 || request.expiresAt <= Date.now() || request.expiresAt > Date.now() + 10 * 60_000 || !Number.isSafeInteger(request.deploymentEpoch) || request.deploymentEpoch < 1) throw new Error('INVALID_PAIR_REQUEST');
  normalizeEndpoint(request.endpoint);
  const existing = await pairById(ctx, request.pairRequestId);
  if (existing) {
    if (existing.request.publicKey !== request.publicKey || existing.request.nonce !== request.nonce) throw new Error('PAIR_REQUEST_CONFLICT');
    return { state: existing.state };
  }
  const recent = await ctx.db.query('pairRequests').order('desc').take(100);
  if (recent.filter((r) => r.direction === 'INBOUND' && r.requestedAt > Date.now() - 60_000).length >= 10 || recent.some((r) => r.request.townId === request.townId && r.requestedAt > Date.now() - 60_000)) throw new Error('PAIR_RATE_LIMITED');
  await ctx.db.insert('pairRequests', { pairRequestId: request.pairRequestId, direction: 'INBOUND', state: 'PENDING_APPROVAL', request: { ...request, proof: args.proof }, endpoint: request.endpoint, requestedAt: Date.now(), expiresAt: request.expiresAt, attempts: 0 });
  return { state: 'PENDING_APPROVAL' };
} });
export const approvePair = action({ args: { adminToken: v.string(), pairRequestId: v.string(), pairingSecret: v.string() }, handler: async (ctx, args) => {
  requireAdmin(args.adminToken); validatePairingSecret(args.pairingSecret);
  const data = await ctx.runQuery(queryRef('store/context'), { pairRequestId: args.pairRequestId });
  const pair = data.pair; const local = data.identity;
  if (!pair || pair.direction !== 'INBOUND' || pair.state !== 'PENDING_APPROVAL' || pair.expiresAt <= Date.now() || (!local?.enabled || local.mode !== 'ACTIVE')) throw new Error('PAIR_NOT_PENDING');
  const { proof, ...request } = pair.request;
  if (!await verifyMac({ direction: 'offer', request }, proof, args.pairingSecret)) {
    await ctx.runMutation(mutationRef('peers/authFailure'), { pairRequestId: args.pairRequestId });
    throw new Error('AUTH_FAILED');
  }
  const keys = await ephemeralKeys();
  const response = { protocol: PROTOCOL, pairRequestId: args.pairRequestId, townId: local.townId, townName: local.townName, publicKey: local.publicKey, fingerprint: local.fingerprint, deploymentInstanceId: local.deploymentInstanceId, deploymentEpoch: local.deploymentEpoch, endpoint: local.endpoint, ephemeralPublicKey: keys.publicKey, nonce: crypto.randomUUID(), expiresAt: pair.expiresAt };
  const transcript = { request, response };
  const credential = await deriveCredential(keys.privateKeyEncrypted, request.ephemeralPublicKey, args.pairingSecret, transcript);
  const packet = { body: response, signature: await sign(response, local.privateKeyEncrypted), proof: await mac({ direction: 'response', transcript }, args.pairingSecret) };
  await ctx.runMutation(mutationRef('peers/storeApproval'), { pairRequestId: args.pairRequestId, response: packet, credentialEncrypted: await sealSecret(credential) });
  return { pairRequestId: args.pairRequestId, state: 'PENDING_BOTH_CONFIRM' };
} });
export const storeApproval = internalMutation({ args: { pairRequestId: v.string(), response: v.any(), credentialEncrypted: v.string() }, handler: async (ctx, args) => {
  const pair = await pairById(ctx, args.pairRequestId);
  if (!pair || pair.direction !== 'INBOUND' || pair.state !== 'PENDING_APPROVAL' || pair.expiresAt <= Date.now()) throw new Error('PAIR_NOT_PENDING');
  await ctx.db.patch(pair._id, { state: 'PENDING_BOTH_CONFIRM', response: args.response, credentialEncrypted: args.credentialEncrypted });
} });
export const authFailure = internalMutation({ args: { pairRequestId: v.string() }, handler: async (ctx, args) => {
  const pair = await pairById(ctx, args.pairRequestId); if (pair && pair.state !== 'TRUSTED') await ctx.db.patch(pair._id, { state: 'AUTH_FAILED', attempts: pair.attempts + 1, credentialEncrypted: undefined, secretEncrypted: undefined, ephemeralPrivateEncrypted: undefined });
} });
export const rejectPair = mutation({ args: { adminToken: v.string(), pairRequestId: v.string() }, handler: async (ctx, args) => {
  requireAdmin(args.adminToken); const pair = await pairById(ctx, args.pairRequestId);
  if (!pair || pair.direction !== 'INBOUND' || pair.state !== 'PENDING_APPROVAL') throw new Error('PAIR_NOT_PENDING');
  await ctx.db.patch(pair._id, { state: 'REJECTED', secretEncrypted: undefined, credentialEncrypted: undefined });
} });
export const continuePair = action({ args: { adminToken: v.string(), pairRequestId: v.string() }, handler: async (ctx, args) => {
  requireAdmin(args.adminToken);
  const data = await ctx.runQuery(queryRef('store/context'), { pairRequestId: args.pairRequestId });
  const pair = data.pair; const local = data.identity;
  if (!pair || pair.direction !== 'OUTBOUND' || !local || pair.expiresAt <= Date.now() || !pair.secretEncrypted || !pair.ephemeralPrivateEncrypted) throw new Error('PAIR_NOT_PENDING');
  const query = { pairRequestId: pair.pairRequestId, townId: local.townId, nonce: crypto.randomUUID(), expiresAt: Date.now() + 30_000 };
  const status = await directRequest(pair.endpoint, '/pair', { operation: 'status', body: query, signature: await sign(query, local.privateKeyEncrypted) });
  if (!status.body || !await verifySignature(status.body, status.signature, status.body.publicKey) || status.body.pairRequestId !== pair.pairRequestId || status.body.townId !== pair.request.targetTownId) throw new Error('INVALID_PAIR_STATUS');
  if (status.body.state !== 'PENDING_BOTH_CONFIRM' && status.body.state !== 'TRUSTED') {
    await ctx.runMutation(mutationRef('peers/updatePairState'), { pairRequestId: pair.pairRequestId, state: status.body.state });
    return { pairRequestId: pair.pairRequestId, state: status.body.state };
  }
  const response = status.body.response;
  if (!response || response.body.townId !== pair.request.targetTownId || response.body.expiresAt < Date.now() || !await verifySignature(response.body, response.signature, response.body.publicKey)) throw new Error('AUTH_FAILED');
  const transcript = { request: pair.request, response: response.body };
  const secret = await openSecret(pair.secretEncrypted);
  if (!await verifyMac({ direction: 'response', transcript }, response.proof, secret)) {
    await ctx.runMutation(mutationRef('peers/authFailure'), { pairRequestId: pair.pairRequestId }); throw new Error('AUTH_FAILED');
  }
  const credential = await deriveCredential(pair.ephemeralPrivateEncrypted, response.body.ephemeralPublicKey, secret, transcript);
  const confirmation = { pairRequestId: pair.pairRequestId, townId: local.townId, transcriptDigest: await digest(transcript), direction: 'initiator-confirm', expiresAt: pair.expiresAt };
  const result = await directRequest(pair.endpoint, '/pair', { operation: 'confirm', body: confirmation, signature: await sign(confirmation, local.privateKeyEncrypted), proof: await mac(confirmation, credential) });
  if (!await verifySignature(result.body, result.signature, response.body.publicKey) || !await verifyMac(result.body, result.proof, credential) || result.body.pairRequestId !== pair.pairRequestId || result.body.direction !== 'responder-confirm' || result.body.transcriptDigest !== confirmation.transcriptDigest) throw new Error('AUTH_FAILED');
  await ctx.runMutation(mutationRef('peers/finalizePair'), { pairRequestId: pair.pairRequestId, remote: response.body, credentialEncrypted: await sealSecret(credential) });
  return { pairRequestId: pair.pairRequestId, state: 'TRUSTED' };
} });
export const updatePairState = internalMutation({ args: { pairRequestId: v.string(), state: v.string() }, handler: async (ctx, args) => {
  const pair = await pairById(ctx, args.pairRequestId); if (!pair || pair.state === 'TRUSTED') return;
  if (!['PENDING_APPROVAL', 'REJECTED', 'EXPIRED', 'AUTH_FAILED'].includes(args.state)) throw new Error('INVALID_PAIR_STATE');
  await ctx.db.patch(pair._id, { state: args.state });
} });
export const finalizePair = internalMutation({ args: { pairRequestId: v.string(), remote: v.any(), credentialEncrypted: v.string() }, handler: async (ctx, args) => {
  const pair = await pairById(ctx, args.pairRequestId); const local = await identity(ctx);
  if (!pair || !local?.enabled || local.mode !== 'ACTIVE' || pair.expiresAt < Date.now() || !['PENDING_APPROVAL', 'PENDING_BOTH_CONFIRM', 'TRUSTED'].includes(pair.state)) throw new Error('PAIR_NOT_CONFIRMABLE');
  if (pair.state === 'TRUSTED') return;
  const remote = args.remote; const previous = await peer(ctx, remote.townId);
  if (remote.townId === local.townId || previous && (previous.publicKey !== remote.publicKey || previous.deploymentInstanceId !== remote.deploymentInstanceId || previous.deploymentEpoch !== remote.deploymentEpoch)) throw new Error('IDENTITY_OR_DEPLOYMENT_CONFLICT');
  const record = { townId: remote.townId, townName: remote.townName, publicKey: remote.publicKey, fingerprint: remote.fingerprint, deploymentInstanceId: remote.deploymentInstanceId, deploymentEpoch: remote.deploymentEpoch, endpoint: normalizeEndpoint(remote.endpoint), credentialId: `peer:${args.pairRequestId}`, credentialEncrypted: args.credentialEncrypted, trustState: 'TRUSTED', inboundVisitsAllowed: true, outboundVisitsAllowed: true, pairedAt: Date.now() };
  if (previous) await ctx.db.patch(previous._id, record); else await ctx.db.insert('federationPeers', record);
  const transport = await session(ctx, remote.townId);
  const transportRecord = { peerTownId: remote.townId, channelState: 'TRANSPORT_TESTING', transportType: 'DIRECT_HTTPS', localDeploymentEpoch: local.deploymentEpoch, verifiedPeerDeploymentEpoch: remote.deploymentEpoch, outboundVerifiedAt: undefined, inboundVerifiedAt: undefined };
  if (transport) await ctx.db.patch(transport._id, transportRecord); else await ctx.db.insert('transportSessions', transportRecord);
  await ctx.db.patch(pair._id, { state: 'TRUSTED', credentialEncrypted: undefined, secretEncrypted: undefined, ephemeralPrivateEncrypted: undefined });
  await ctx.scheduler.runAfter(500, actionRef('transport/probeInternal'), { peerTownId: remote.townId });
} });
export const setPolicy = mutation({ args: { adminToken: v.string(), peerTownId: v.string(), inboundVisitsAllowed: v.boolean(), outboundVisitsAllowed: v.boolean(), trustState: v.union(v.literal('TRUSTED'), v.literal('PAUSED'), v.literal('REVOKED')) }, handler: async (ctx, args) => {
  requireAdmin(args.adminToken); const remote = await peer(ctx, args.peerTownId); if (!remote) throw new Error('PEER_NOT_FOUND');
  if (remote.trustState === 'REVOKED' && args.trustState === 'TRUSTED') throw new Error('REPAIR_REQUIRED');
  await ctx.db.patch(remote._id, { inboundVisitsAllowed: args.inboundVisitsAllowed, outboundVisitsAllowed: args.outboundVisitsAllowed, trustState: args.trustState });
  const transport = await session(ctx, remote.townId); if (transport) await ctx.db.patch(transport._id, { channelState: 'TRANSPORT_TESTING', inboundVerifiedAt: undefined, outboundVerifiedAt: undefined });
} });
export const updateEndpoint = action({ args: { adminToken: v.string(), peerTownId: v.string(), endpoint: v.string() }, handler: async (ctx, args) => {
  requireAdmin(args.adminToken); const data = await ctx.runQuery(queryRef('store/context'), { peerTownId: args.peerTownId }); if (!data.peer) throw new Error('PEER_NOT_FOUND');
  const endpoint = normalizeEndpoint(args.endpoint); const discovery = await directRequest(endpoint, '/health');
  if (!await verifySignature(discovery.body, discovery.signature, data.peer.publicKey) || discovery.body.townId !== data.peer.townId || discovery.body.deploymentEpoch !== data.peer.deploymentEpoch || discovery.body.deploymentInstanceId !== data.peer.deploymentInstanceId || discovery.body.expiresAt <= Date.now()) throw new Error('IDENTITY_OR_DEPLOYMENT_CONFLICT');
  await ctx.runMutation(mutationRef('peers/saveEndpoint'), { peerTownId: args.peerTownId, endpoint });
  await ctx.runAction(actionRef('transport/probeInternal'), { peerTownId: args.peerTownId });
} });
export const saveEndpoint = internalMutation({ args: { peerTownId: v.string(), endpoint: v.string() }, handler: async (ctx, args) => {
  const remote = await peer(ctx, args.peerTownId); if (!remote) throw new Error('PEER_NOT_FOUND');
  await ctx.db.patch(remote._id, { endpoint: normalizeEndpoint(args.endpoint) });
  const transport = await session(ctx, args.peerTownId); if (transport) await ctx.db.patch(transport._id, { channelState: 'TRANSPORT_TESTING', outboundVerifiedAt: undefined, inboundVerifiedAt: undefined });
} });

export const consumePairNonce = internalMutation({ args: { pairRequestId: v.string(), townId: v.string(), nonce: v.string(), expiresAt: v.number() }, handler: async (ctx, args) => {
  const pair = await pairById(ctx, args.pairRequestId);
  if (!pair || pair.direction !== 'INBOUND' || pair.request.townId !== args.townId || !args.nonce || args.nonce.length > 200 || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + 10 * 60_000) throw new Error('INVALID_PAIR_CONTROL');
  const existing = await ctx.db.query('federationReplayNonces').withIndex('nonce', q => q.eq('peerTownId', args.townId).eq('nonce', args.nonce)).unique();
  if (existing && existing.expiresAt > Date.now()) throw new Error('REPLAYED_NONCE');
  if (existing) await ctx.db.delete(existing._id);
  const recent = await ctx.db.query('federationReplayNonces').withIndex('expiry', q => q.gt('expiresAt', Date.now())).take(4001);
  if (recent.length >= 4000) throw new Error('REPLAY_WINDOW_CAPACITY_EXCEEDED');
  await ctx.db.insert('federationReplayNonces', { peerTownId: args.townId, nonce: args.nonce, expiresAt: args.expiresAt });
} });

export function registerPairingRoutes(http: import('convex/server').HttpRouter) {
  http.route({ path: '/federation/v1/health', method: 'GET', handler: httpAction(async ctx => {
    const data = await ctx.runQuery(queryRef('store/context'), {}), local = data.identity;
    if (!local || local.mode !== 'ACTIVE') return new Response(JSON.stringify({ error: 'FEDERATION_UNAVAILABLE' }), { status: 503 });
    const body = { protocol: PROTOCOL, townId: local.townId, townName: local.townName, publicKey: local.publicKey, fingerprint: local.fingerprint,
      deploymentInstanceId: local.deploymentInstanceId, deploymentEpoch: local.deploymentEpoch, endpoint: local.endpoint, expiresAt: Date.now() + 30_000 };
    return jsonResponse({ body, signature: await sign(body, local.privateKeyEncrypted) });
  }) });
  http.route({ path: '/federation/v1/pair', method: 'POST', handler: httpAction(async (ctx, request) => {
    try {
      const input = await readRequest(request);
      if (input.operation === 'request') {
        const packet = input.packet, body = packet?.body;
        if (!body || typeof body.publicKey !== 'string' || body.fingerprint !== `sha256:${await digest(body.publicKey)}` || !await verifySignature(body, packet.signature, body.publicKey) || typeof packet.proof !== 'string') throw new Error('INVALID_PAIR_SIGNATURE');
        const result = await ctx.runMutation(mutationRef('peers/receiveRequest'), { request: body, proof: packet.proof });
        const { identity: local } = await ctx.runQuery(queryRef('store/context'), {});
        const response = { protocol: PROTOCOL, pairRequestId: body.pairRequestId, townId: local.townId, state: result.state, expiresAt: Date.now() + 30_000 };
        return jsonResponse({ body: response, signature: await sign(response, local.privateKeyEncrypted) });
      }
      if (!['status', 'confirm'].includes(input.operation) || !input.body || typeof input.body.pairRequestId !== 'string') throw new Error('INVALID_PAIR_OPERATION');
      const body = input.body, data = await ctx.runQuery(queryRef('store/context'), { pairRequestId: body.pairRequestId });
      const pair = data.pair, local = data.identity;
      if (!pair || !local || pair.direction !== 'INBOUND' || body.townId !== pair.request.townId || !await verifySignature(body, input.signature, pair.request.publicKey) || body.expiresAt <= Date.now() || body.expiresAt > Date.now() + 10 * 60_000) throw new Error('INVALID_PAIR_SIGNATURE');
      if (input.operation === 'status') {
        await ctx.runMutation(mutationRef('peers/consumePairNonce'), { pairRequestId: pair.pairRequestId, townId: body.townId, nonce: body.nonce, expiresAt: body.expiresAt });
        const response = { protocol: PROTOCOL, pairRequestId: pair.pairRequestId, townId: local.townId, publicKey: local.publicKey, state: pair.expiresAt <= Date.now() && !['TRUSTED', 'REJECTED', 'AUTH_FAILED'].includes(pair.state) ? 'EXPIRED' : pair.state, response: pair.response ?? null, expiresAt: Date.now() + 30_000, nonce: body.nonce };
        return jsonResponse({ body: response, signature: await sign(response, local.privateKeyEncrypted) });
      }
      if (!['PENDING_BOTH_CONFIRM', 'TRUSTED'].includes(pair.state) || pair.expiresAt <= Date.now() || !pair.response) throw new Error('PAIR_NOT_CONFIRMABLE');
      const trusted = pair.state === 'TRUSTED' ? await ctx.runQuery(queryRef('store/context'), { peerTownId: body.townId }) : null;
      const encrypted = pair.credentialEncrypted ?? (trusted?.peer?.credentialId === `peer:${pair.pairRequestId}` ? trusted.peer.credentialEncrypted : undefined);
      if (!encrypted) throw new Error('PAIR_NOT_CONFIRMABLE');
      const { proof: offerProof, ...offer } = pair.request;
      const transcriptDigest = await digest({ request: offer, response: pair.response.body });
      if (body.direction !== 'initiator-confirm' || body.transcriptDigest !== transcriptDigest || body.expiresAt > pair.expiresAt || !await verifyMac(body, input.proof, await openSecret(encrypted))) throw new Error('AUTH_FAILED');
      // Confirmation is idempotent by pairRequestId and transcript, including a
      // retry after the responder committed but its HTTP response was lost.
      await ctx.runMutation(mutationRef('peers/finalizePair'), { pairRequestId: pair.pairRequestId, remote: offer, credentialEncrypted: encrypted });
      const response = { protocol: PROTOCOL, pairRequestId: pair.pairRequestId, townId: local.townId, transcriptDigest, direction: 'responder-confirm', expiresAt: pair.expiresAt };
      return jsonResponse({ body: response, signature: await sign(response, local.privateKeyEncrypted), proof: await mac(response, await openSecret(encrypted)) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'FEDERATION_REJECTED';
      return jsonResponse({ error: /^[A-Z][A-Z0-9_]+$/.test(reason) ? reason : 'FEDERATION_REJECTED' }, 400);
    }
  }) });
}
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
