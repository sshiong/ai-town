import { v } from 'convex/values';
import { internalMutation, mutation, MutationCtx } from '../_generated/server';
import { Doc } from '../_generated/dataModel';
import { requireAdmin } from './security';
import { identity, peer, ready, session, visit } from './store';
import { enqueueMessage } from './queue';
import { mutationRef } from './refs';
import { FederationMessage, LEASE_SAFETY_MS } from './protocol';
import { syncResidentRuntimes } from './runtime';

const TERMINAL = new Set(['COMPLETED', 'REJECTED']);
const RESERVATION_MS = 30_000;
const runtimeJob = async (ctx: MutationCtx, name: string, visitId: string) => {
  await ctx.scheduler.runAfter(0, mutationRef(`runtime/${name}`), { visitId });
};
async function reservation(ctx: MutationCtx, visitId: string) {
  return ctx.db.query('visitReservations').withIndex('visitId', q => q.eq('visitId', visitId)).unique();
}
async function releaseSlot(ctx: MutationCtx, visitId: string) {
  const slot = await reservation(ctx, visitId);
  if (slot) await ctx.db.patch(slot._id, { reservedSlot: false });
}
export function visitPeer(ledger: Doc<'visitLedger'>) {
  return ledger.role === 'home' ? ledger.hostTownId : ledger.homeTownId;
}
export async function assertVisitAuthority(ctx: MutationCtx, message: FederationMessage) {
  const ledger = await visit(ctx, message.visitId!);
  if (!ledger || ledger.agentGlobalId !== message.agentGlobalId || visitPeer(ledger) !== message.fromTownId) throw new Error('VISIT_IDENTITY_MISMATCH');
  if (ledger.agentAuthorityEpoch !== message.agentAuthorityEpoch) throw new Error('STALE_AGENT_AUTHORITY');
  const renewing = message.type === 'VISIT_RENEW' && ledger.role === 'host' && message.visitLeaseVersion === ledger.visitLeaseVersion + 1;
  if (ledger.visitLeaseVersion !== message.visitLeaseVersion && !renewing) throw new Error('STALE_VISIT_LEASE');
  const senderEpoch = ledger.role === 'home' ? ledger.hostDeploymentEpoch : ledger.homeDeploymentEpoch;
  const recipientEpoch = ledger.role === 'home' ? ledger.homeDeploymentEpoch : ledger.hostDeploymentEpoch;
  if (senderEpoch !== message.senderDeploymentEpoch || recipientEpoch !== message.expectedRecipientDeploymentEpoch) throw new Error('VISIT_DEPLOYMENT_MISMATCH');
  if (['OBSERVATION', 'DECISION', 'ACTION_RESULT', 'VISIT_CONFIRM', 'VISIT_RENEW'].includes(message.type) && ledger.leaseExpiry <= Date.now()) throw new Error('VISIT_LEASE_EXPIRED');
  // The fencing token is checked on all lifecycle messages. Runtime decisions are
  // fenced by the immutable visitId plus separate authority and lease generations.
  if (message.type.startsWith('VISIT_') && message.payload.fencingToken !== ledger.fencingToken) throw new Error('INVALID_FENCING_TOKEN');
  return ledger;
}

export const startVisit = mutation({
  args: { adminToken: v.string(), peerTownId: v.string(), worldId: v.id('worlds'), homePlayerId: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const local = await identity(ctx), remote = await peer(ctx, args.peerTownId), connection = await session(ctx, args.peerTownId);
    if (!local?.enabled || local.mode !== 'ACTIVE') throw new Error('FEDERATION_DISABLED');
    if (!remote || remote.trustState !== 'TRUSTED' || !remote.outboundVisitsAllowed || !ready(connection) || connection!.localDeploymentEpoch !== local.deploymentEpoch || connection!.verifiedPeerDeploymentEpoch !== remote.deploymentEpoch) throw new Error('DIRECT_PEER_NOT_MUTUALLY_REACHABLE');
    await syncResidentRuntimes(ctx, args.worldId);
    const resident = await ctx.db.query('federationAgentRuntimes').withIndex('world', q => q.eq('worldId', args.worldId).eq('playerId', args.homePlayerId as any)).unique();
    if (!resident || resident.homeTownId !== local.townId || resident.state !== 'HOME_ACTIVE' || resident.visitId) throw new Error('RESIDENT_NOT_AVAILABLE');
    const current = await ctx.db.query('visitLedger').withIndex('agentGlobalId', q => q.eq('agentGlobalId', resident.agentGlobalId)).collect();
    if (current.some(l => !TERMINAL.has(l.state))) throw new Error('AGENT_ALREADY_TRAVELING');
    const description = await ctx.db.query('playerDescriptions').withIndex('worldId', q => q.eq('worldId', args.worldId).eq('playerId', resident.playerId)).unique();
    if (!description) throw new Error('RESIDENT_PROFILE_MISSING');
    const now = Date.now(), visitId = crypto.randomUUID(), fencingToken = crypto.randomUUID();
    const agentAuthorityEpoch = resident.agentAuthorityEpoch + 1;
    const leaseExpiry = now + local.maxVisitDurationMs;
    const profile = { name: description.name, character: description.character, description: description.description, homeTownName: local.townName };
    await ctx.db.insert('visitLedger', { visitId, agentGlobalId: resident.agentGlobalId, homeTownId: local.townId, hostTownId: remote.townId,
      homeDeploymentEpoch: local.deploymentEpoch, hostDeploymentEpoch: remote.deploymentEpoch, agentAuthorityEpoch, visitLeaseVersion: 1,
      leaseExpiry, fencingToken, state: 'REQUESTED', role: 'home', worldId: args.worldId, homePlayerId: resident.playerId, profile, createdAt: now, updatedAt: now });
    // Claim exclusive travel authority before the asynchronous reservation request.
    await ctx.db.patch(resident._id, { state: 'TRAVEL_PREPARING', visitId, agentAuthorityEpoch, updatedAt: now });
    await enqueueMessage(ctx, { peerTownId: remote.townId, type: 'VISIT_RESERVE', visitId, payload: { profile, leaseExpiry, fencingToken } });
    return { visitId, state: 'REQUESTED' };
  },
});

async function sendLifecycle(ctx: MutationCtx, ledger: Doc<'visitLedger'>, type: string, payload: Record<string, any> = {}) {
  try {
    await enqueueMessage(ctx, { peerTownId: visitPeer(ledger), type, visitId: ledger.visitId, payload: { ...payload, fencingToken: ledger.fencingToken } });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'OUTBOX_CAPACITY_EXCEEDED' || !['VISIT_RETURN', 'VISIT_CLEANED'].includes(type)) throw error;
    // Exhausted notification capacity must not roll back local revocation or
    // cleanup. Home still waits the full last-issued lease plus safety margin;
    // resync snapshots can also prove this persisted cleanup later.
    await ctx.db.patch(ledger._id, { lastError: 'OUTBOX_CAPACITY_EXCEEDED' });
  }
}
export async function beginReturn(ctx: MutationCtx, ledger: Doc<'visitLedger'>, reason: string) {
  if (TERMINAL.has(ledger.state)) return;
  if (ledger.role === 'host') {
    if (ledger.state === 'RESERVED') {
      await ctx.db.patch(ledger._id, { state: 'COMPLETED', cleanupConfirmed: true, updatedAt: Date.now(), lastError: reason });
      await releaseSlot(ctx, ledger.visitId);
      await sendLifecycle(ctx, ledger, 'VISIT_CLEANED');
    } else {
      await ctx.db.patch(ledger._id, { state: 'REMOVING', updatedAt: Date.now(), lastError: reason });
      await runtimeJob(ctx, 'removeHostPresence', ledger.visitId);
    }
  } else {
    await ctx.db.patch(ledger._id, { state: 'RETURN_PENDING', updatedAt: Date.now(), lastError: reason });
    const remote = await peer(ctx, ledger.hostTownId);
    if (remote) await sendLifecycle(ctx, ledger, 'VISIT_RETURN', { reason });
    if (ledger.cleanupConfirmed || ledger.leaseExpiry + LEASE_SAFETY_MS <= Date.now()) await runtimeJob(ctx, 'resumeHome', ledger.visitId);
  }
}
export const returnVisit = mutation({ args: { adminToken: v.string(), visitId: v.string() }, handler: async (ctx, args) => {
  requireAdmin(args.adminToken);
  const ledger = await visit(ctx, args.visitId); if (!ledger) throw new Error('VISIT_NOT_FOUND');
  await beginReturn(ctx, ledger, 'ADMIN_RETURN');
  return { visitId: ledger.visitId, state: TERMINAL.has(ledger.state) ? ledger.state : 'RETURN_PENDING' };
} });

export const renewVisit = mutation({ args: { adminToken: v.string(), visitId: v.string() }, handler: async (ctx, args) => {
  requireAdmin(args.adminToken);
  const ledger = await visit(ctx, args.visitId), local = await identity(ctx);
  if (!ledger || ledger.role !== 'home' || ledger.state !== 'ACTIVE' || ledger.leaseExpiry <= Date.now() || !local?.enabled || local.mode !== 'ACTIVE') throw new Error('VISIT_NOT_RENEWABLE');
  const remote = await peer(ctx, ledger.hostTownId), connection = await session(ctx, ledger.hostTownId);
  if (!remote || remote.trustState !== 'TRUSTED' || !remote.outboundVisitsAllowed || !ready(connection)) throw new Error('DIRECT_PEER_NOT_MUTUALLY_REACHABLE');
  const leaseExpiry = Date.now() + local.maxVisitDurationMs;
  if (leaseExpiry <= ledger.leaseExpiry) throw new Error('LEASE_NOT_EXTENDED');
  // Record the largest lease we might grant before any packet leaves Home. A
  // lost renewal ACK must never shorten the safe-return waiting period.
  await ctx.db.patch(ledger._id, { visitLeaseVersion: ledger.visitLeaseVersion + 1, leaseExpiry, updatedAt: Date.now() });
  await enqueueMessage(ctx, { peerTownId: ledger.hostTownId, type: 'VISIT_RENEW', visitId: ledger.visitId, payload: { fencingToken: ledger.fencingToken, leaseExpiry } });
  return { visitId: ledger.visitId, visitLeaseVersion: ledger.visitLeaseVersion + 1, leaseExpiry };
} });

async function receiveReserve(ctx: MutationCtx, message: FederationMessage) {
  const local = await identity(ctx), remote = await peer(ctx, message.fromTownId);
  if (!local || !remote) throw new Error('PEER_NOT_TRUSTED');
  const old = await visit(ctx, message.visitId!);
  if (old) { await assertVisitAuthority(ctx, message); return; }
  const payload = message.payload, now = Date.now();
  if (message.sequence !== 1 || !message.agentGlobalId!.startsWith(`${message.fromTownId}/agent:`) || typeof payload.fencingToken !== 'string' || payload.fencingToken.length < 16 || payload.fencingToken.length > 200 ||
      !Number.isFinite(payload.leaseExpiry) || payload.leaseExpiry <= now || payload.leaseExpiry > now + local.maxVisitDurationMs + 30_000 || message.visitLeaseVersion !== 1 ||
      typeof payload.profile?.name !== 'string' || payload.profile.name.length > 100 || typeof payload.profile.character !== 'string' || payload.profile.character.length > 100 ||
      typeof payload.profile.description !== 'string' || payload.profile.description.length > 4000 || typeof payload.profile.homeTownName !== 'string' || payload.profile.homeTownName.length > 80) throw new Error('INVALID_RESERVATION');
  const activeAgent = await ctx.db.query('visitLedger').withIndex('agentGlobalId', q => q.eq('agentGlobalId', message.agentGlobalId!)).collect();
  const slots = await ctx.db.query('visitReservations').withIndex('active', q => q.eq('reservedSlot', true)).collect();
  const slotLedgers = await Promise.all(slots.map(slot => visit(ctx, slot.visitId)));
  const occupiedSlots = slots.filter((slot, index) => slot.expiresAt > now || slotLedgers[index]?.role === 'host' && ['CREATING', 'ACTIVE', 'REMOVING'].includes(slotLedgers[index]!.state)).length;
  const connection = await session(ctx, remote.townId);
  let refusal: string | undefined;
  if (!local.enabled || local.mode !== 'ACTIVE' || !remote.inboundVisitsAllowed || !ready(connection) || connection!.localDeploymentEpoch !== local.deploymentEpoch || connection!.verifiedPeerDeploymentEpoch !== remote.deploymentEpoch) refusal = 'VISITS_NOT_ALLOWED';
  else if (activeAgent.some(l => !TERMINAL.has(l.state))) refusal = 'AGENT_ALREADY_PRESENT';
  else if (activeAgent.some(l => l.agentAuthorityEpoch >= message.agentAuthorityEpoch!)) refusal = 'STALE_AGENT_AUTHORITY';
  else if (occupiedSlots >= local.maxVisitors) refusal = 'HOST_CAPACITY_EXCEEDED';
  const state = refusal ? 'REJECTED' : 'RESERVED';
  const id = await ctx.db.insert('visitLedger', { visitId: message.visitId!, agentGlobalId: message.agentGlobalId!, homeTownId: message.fromTownId, hostTownId: local.townId,
    homeDeploymentEpoch: message.senderDeploymentEpoch, hostDeploymentEpoch: message.expectedRecipientDeploymentEpoch,
    agentAuthorityEpoch: message.agentAuthorityEpoch!, visitLeaseVersion: 1, leaseExpiry: payload.leaseExpiry, fencingToken: payload.fencingToken,
    role: 'host', state, profile: payload.profile, createdAt: now, updatedAt: now, cleanupConfirmed: !!refusal, ...(refusal ? { lastError: refusal } : {}) });
  const ledger = (await ctx.db.get(id))!;
  if (refusal) await sendLifecycle(ctx, ledger, 'VISIT_REJECT', { reason: refusal });
  else {
    await ctx.db.insert('visitReservations', { visitId: ledger.visitId, hostTownId: local.townId, reservedSlot: true, expiresAt: Math.min(now + RESERVATION_MS, ledger.leaseExpiry) });
    await sendLifecycle(ctx, ledger, 'VISIT_RESERVED', { reservedUntil: Math.min(now + RESERVATION_MS, ledger.leaseExpiry), leaseExpiry: ledger.leaseExpiry });
  }
}

export async function dispatchLedgerMessage(ctx: MutationCtx, message: FederationMessage) {
  if (message.type === 'VISIT_RESERVE') { await receiveReserve(ctx, message); return; }
  const ledger = await assertVisitAuthority(ctx, message);
  switch (message.type) {
    case 'VISIT_RESERVED':
      if (ledger.role !== 'home') throw new Error('INVALID_VISIT_DIRECTION');
      if (ledger.state !== 'REQUESTED') return;
      if (message.payload.reservedUntil <= Date.now() || message.payload.leaseExpiry !== ledger.leaseExpiry) { await beginReturn(ctx, ledger, 'RESERVATION_EXPIRED'); return; }
      await ctx.db.patch(ledger._id, { state: 'FREEZING', updatedAt: Date.now() });
      await runtimeJob(ctx, 'freezeHome', ledger.visitId); return;
    case 'VISIT_CONFIRM': {
      if (ledger.role !== 'host') throw new Error('INVALID_VISIT_DIRECTION');
      if (ledger.state === 'ACTIVE') { await sendLifecycle(ctx, ledger, 'VISIT_ACTIVE', { hostPlayerId: ledger.hostPlayerId }); return; }
      if (ledger.state !== 'RESERVED') return;
      const slot = await reservation(ctx, ledger.visitId);
      if (!slot?.reservedSlot || slot.expiresAt <= Date.now()) { await beginReturn(ctx, ledger, 'RESERVATION_EXPIRED'); return; }
      await ctx.db.patch(slot._id, { expiresAt: ledger.leaseExpiry });
      await ctx.db.patch(ledger._id, { state: 'CREATING', updatedAt: Date.now() });
      await runtimeJob(ctx, 'createHostPresence', ledger.visitId); return;
    }
    case 'VISIT_ACTIVE':
      if (ledger.role !== 'home') throw new Error('INVALID_VISIT_DIRECTION');
      if (ledger.state === 'CONFIRMING') await ctx.db.patch(ledger._id, { state: 'ACTIVE', hostPlayerId: message.payload.hostPlayerId, updatedAt: Date.now() });
      else if (ledger.state === 'RETURN_PENDING') await sendLifecycle(ctx, ledger, 'VISIT_RETURN');
      return;
    case 'VISIT_REJECT':
      if (ledger.role !== 'home') throw new Error('INVALID_VISIT_DIRECTION');
      if (TERMINAL.has(ledger.state)) return;
      if (ledger.state !== 'REQUESTED') throw new Error('INVALID_REJECTION_STATE');
      await ctx.db.patch(ledger._id, { cleanupConfirmed: true, state: 'RETURN_PENDING', updatedAt: Date.now(), lastError: String(message.payload.reason ?? 'HOST_REJECTED') });
      await runtimeJob(ctx, 'resumeHome', ledger.visitId); return;
    case 'VISIT_RETURN':
      await beginReturn(ctx, ledger, String(message.payload.reason ?? 'PEER_RETURN')); return;
    case 'VISIT_CLEANED':
      if (ledger.role !== 'home') throw new Error('INVALID_VISIT_DIRECTION');
      if (!TERMINAL.has(ledger.state)) {
        await ctx.db.patch(ledger._id, { cleanupConfirmed: true, state: 'RETURN_PENDING', updatedAt: Date.now() });
        await runtimeJob(ctx, 'resumeHome', ledger.visitId);
      } return;
    case 'VISIT_RENEW': {
      if (ledger.role !== 'host' || ledger.state !== 'ACTIVE' || message.visitLeaseVersion !== ledger.visitLeaseVersion + 1) throw new Error('INVALID_RENEWAL');
      const local = await identity(ctx), expiry = message.payload.leaseExpiry;
      if (!Number.isFinite(expiry) || expiry <= ledger.leaseExpiry || expiry > Date.now() + local!.maxVisitDurationMs + 30_000) throw new Error('INVALID_LEASE_EXPIRY');
      await ctx.db.patch(ledger._id, { visitLeaseVersion: message.visitLeaseVersion!, leaseExpiry: expiry, updatedAt: Date.now() });
      const slot = await reservation(ctx, ledger.visitId); if (slot) await ctx.db.patch(slot._id, { expiresAt: expiry });
      await runtimeJob(ctx, 'updateHostLease', ledger.visitId);
      return;
    }
    default: throw new Error('UNKNOWN_VISIT_MESSAGE');
  }
}
export async function homeFrozen(ctx: MutationCtx, visitId: string) {
  const ledger = await visit(ctx, visitId); if (!ledger || ledger.role !== 'home') throw new Error('INVALID_HOME_VISIT');
  if (ledger.state !== 'FREEZING') return;
  if (ledger.leaseExpiry <= Date.now()) { await beginReturn(ctx, ledger, 'LEASE_EXPIRED'); return; }
  await ctx.db.patch(ledger._id, { state: 'CONFIRMING', updatedAt: Date.now() });
  await sendLifecycle(ctx, ledger, 'VISIT_CONFIRM');
}
export async function hostCreated(ctx: MutationCtx, visitId: string, playerId: string) {
  const ledger = await visit(ctx, visitId); if (!ledger || ledger.role !== 'host') throw new Error('INVALID_HOST_VISIT');
  // Engine inputs are serialized: a persisted cleanup has already processed
  // any earlier create input. A late duplicate result must not reopen the visit.
  if (TERMINAL.has(ledger.state) && ledger.cleanupConfirmed) return;
  if (ledger.state === 'ACTIVE' && ledger.hostPlayerId === playerId && ledger.leaseExpiry > Date.now()) return;
  if (ledger.state !== 'CREATING' || ledger.leaseExpiry <= Date.now()) {
    await ctx.db.patch(ledger._id, { hostPlayerId: playerId, state: 'REMOVING', updatedAt: Date.now() });
    await runtimeJob(ctx, 'removeHostPresence', visitId); return;
  }
  await ctx.db.patch(ledger._id, { hostPlayerId: playerId, state: 'ACTIVE', updatedAt: Date.now() });
  await sendLifecycle(ctx, ledger, 'VISIT_ACTIVE', { hostPlayerId: playerId });
}
export async function hostRemoved(ctx: MutationCtx, visitId: string) {
  const ledger = await visit(ctx, visitId); if (!ledger || ledger.role !== 'host') throw new Error('INVALID_HOST_VISIT');
  if (ledger.state === 'COMPLETED') return;
  await ctx.db.patch(ledger._id, { state: 'COMPLETED', cleanupConfirmed: true, updatedAt: Date.now() });
  await releaseSlot(ctx, visitId);
  const remote = await peer(ctx, ledger.homeTownId);
  if (remote) await sendLifecycle(ctx, ledger, 'VISIT_CLEANED');
}
export async function homeResumed(ctx: MutationCtx, visitId: string) {
  const ledger = await visit(ctx, visitId); if (!ledger || ledger.role !== 'home') throw new Error('INVALID_HOME_VISIT');
  if (!ledger.cleanupConfirmed && ledger.leaseExpiry + LEASE_SAFETY_MS > Date.now()) throw new Error('HOST_LEASE_STILL_VALID');
  await ctx.db.patch(ledger._id, { state: 'COMPLETED', updatedAt: Date.now() });
}

export const reconcile = internalMutation({ args: {}, handler: async ctx => {
  const now = Date.now(), ledgers = await ctx.db.query('visitLedger').collect();
  for (const ledger of ledgers.filter(l => !TERMINAL.has(l.state))) {
    if (ledger.role === 'host') {
      const slot = await reservation(ctx, ledger.visitId);
      if (ledger.leaseExpiry <= now || ledger.state === 'RESERVED' && (!slot || slot.expiresAt <= now)) await beginReturn(ctx, ledger, 'LEASE_EXPIRED');
      else if (ledger.state === 'CREATING') await runtimeJob(ctx, 'createHostPresence', ledger.visitId);
      else if (ledger.state === 'REMOVING') await runtimeJob(ctx, 'removeHostPresence', ledger.visitId);
    } else if (ledger.state === 'RETURN_PENDING') {
      if (ledger.cleanupConfirmed || ledger.leaseExpiry + LEASE_SAFETY_MS <= now) await runtimeJob(ctx, 'resumeHome', ledger.visitId);
    } else if (ledger.leaseExpiry <= now) await beginReturn(ctx, ledger, 'LEASE_EXPIRED');
    else if (ledger.state === 'FREEZING') await runtimeJob(ctx, 'freezeHome', ledger.visitId);
    else if (ledger.state === 'CONFIRMING' && now - ledger.updatedAt > RESERVATION_MS) await beginReturn(ctx, ledger, 'CONFIRM_TIMEOUT');
    // REQUESTED is bounded by its lease; Outbox retries survive process restarts.
  }
} });
