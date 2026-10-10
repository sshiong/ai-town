import type { DatabaseReader, MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { configuredResourceLimits, pendingDecisionCount } from './resources';
import { hostResourceHealth, remoteEventRate, sourceVisitorQuota } from './resourceMonitoring';
import { enqueueMessage } from './queue';
import { identity, peer, ready, session, visit } from './store';

export const MAX_VISITOR_QUEUE = 1000;
export const VISIT_RESERVATION_MS = 30_000;
export const VISITOR_QUEUE_BATCH_SIZE = 20;
const TERMINAL = new Set(['COMPLETED', 'REJECTED']);

export type VisitorQueuePolicy = {
  enabled: boolean;
  maxQueuedVisits: number;
  visitQueueTtlMs: number;
  visitorQueueMode: 'FIFO' | 'SOURCE_ROUND_ROBIN';
  maxQueuedVisitsPerSourceTown: number | null;
  visitorQueueLastSource?: string;
};

export async function configuredVisitorQueue(db: DatabaseReader): Promise<VisitorQueuePolicy> {
  const policy = await db.query('federationResourcePolicy').unique();
  return {
    enabled: policy?.visitorQueueEnabled ?? false,
    maxQueuedVisits: policy?.maxQueuedVisits ?? 50,
    visitQueueTtlMs: policy?.visitQueueTtlMs ?? 120_000,
    visitorQueueMode: policy?.visitorQueueMode ?? 'SOURCE_ROUND_ROBIN',
    maxQueuedVisitsPerSourceTown: policy?.maxQueuedVisitsPerSourceTown ?? null,
    visitorQueueLastSource: policy?.visitorQueueLastSource,
  };
}

/** Read the entire configured bounded queue, never just the first source's prefix. */
export async function queuedHostVisits(db: DatabaseReader) {
  return db.query('visitLedger')
    .withIndex('role_state_queued', q => q.eq('role', 'host').eq('state', 'QUEUED'))
    .take(MAX_VISITOR_QUEUE + 1);
}

export async function visitorQueueSummary(db: DatabaseReader) {
  const policy = await configuredVisitorQueue(db);
  const now = Date.now();
  const waiting = (await queuedHostVisits(db)).filter(row =>
    (row.queueExpiresAt ?? 0) > now && row.leaseExpiry > now);
  return {
    enabled: policy.enabled,
    maxQueuedVisits: policy.maxQueuedVisits,
    visitQueueTtlMs: policy.visitQueueTtlMs,
    visitorQueueMode: policy.visitorQueueMode,
    maxQueuedVisitsPerSourceTown: policy.maxQueuedVisitsPerSourceTown,
    waiting: waiting.length,
    paused: waiting.filter(row => row.queuePaused).length,
  };
}

/** Shared by immediate admissions and queue promotions inside their mutation. */
export async function visitorAdmissionSnapshot(ctx: MutationCtx) {
  const local = await identity(ctx);
  const now = Date.now();
  const limits = await configuredResourceLimits(ctx.db);
  const slots = await ctx.db.query('visitReservations')
    .withIndex('active', q => q.eq('reservedSlot', true)).take(MAX_VISITOR_QUEUE + 1);
  const slotLedgers = await Promise.all(slots.map(slot => visit(ctx, slot.visitId)));
  let occupied = 0, reservations = 0;
  const sources = new Map<string, number>();
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index], ledger = slotLedgers[index];
    if (slot.expiresAt > now || ledger?.role === 'host' && ['CREATING', 'ACTIVE', 'REMOVING'].includes(ledger.state)) {
      occupied++;
      if (ledger?.role === 'host') sources.set(ledger.homeTownId, (sources.get(ledger.homeTownId) ?? 0) + 1);
    }
    if (slot.expiresAt > now && ledger?.state === 'RESERVED') reservations++;
  }
  const pending = await pendingDecisionCount(ctx.db, now);
  const pendingChat = await ctx.db.query('federationLlmRequests')
    .withIndex('state_expiry', q => q.eq('state', 'PENDING').gt('expiresAt', now)).take(1001);
  const runningChat = await ctx.db.query('federationLlmRequests')
    .withIndex('state_expiry', q => q.eq('state', 'RUNNING').gt('expiresAt', now)).take(33);
  const chatQueueFull = pendingChat.length >= limits.maxPendingLocalLLM &&
    (pendingChat.length > 0 || runningChat.length >= limits.maxConcurrentLocalLLM);
  const maintenance = await ctx.db.query('backupMaintenanceLocks')
    .withIndex('key', q => q.eq('key', 'town')).unique();
  const conflict = await ctx.db.query('federationIdentityConflicts')
    .withIndex('state', q => q.eq('state', 'OPEN')).first();
  const eventRate = await remoteEventRate(ctx.db);
  const sourceQuota = await sourceVisitorQuota(ctx.db);
  const hardware = await hostResourceHealth(ctx.db, now);
  let reason: string | undefined;
  if (!local?.enabled || local.mode !== 'ACTIVE') reason = 'VISITS_NOT_ALLOWED';
  else if (maintenance) reason = 'HOST_MAINTENANCE';
  else if (conflict) reason = 'TOWN_CLONE_CONFLICT';
  else if (slots.length > MAX_VISITOR_QUEUE || pendingChat.length > MAX_VISITOR_QUEUE || runningChat.length > 32) reason = 'HOST_CAPACITY_SAMPLE_LIMIT';
  else if (occupied >= local.maxVisitors) reason = 'HOST_CAPACITY_EXCEEDED';
  else if (reservations >= limits.maxVisitReservations) reason = 'HOST_RESERVATION_CAPACITY_EXCEEDED';
  else if (hardware.reasons.length) reason = 'HOST_RESOURCE_DEGRADED';
  else if (pending >= limits.maxPendingDecisions || chatQueueFull || !limits.maxConcurrentLocalLLM || eventRate === 0) reason = 'HOST_RESOURCE_DEGRADED';
  return { local, limits, occupied, reservations, sources, sourceQuota, reason };
}
export type VisitorAdmissionSnapshot = Awaited<ReturnType<typeof visitorAdmissionSnapshot>>;

export function sourceAdmissionReason(snapshot: VisitorAdmissionSnapshot, townId: string) {
  return snapshot.reason ?? (snapshot.sourceQuota !== null &&
    (snapshot.sources.get(townId) ?? 0) >= snapshot.sourceQuota ? 'HOST_SOURCE_QUOTA_EXCEEDED' : undefined);
}

export async function reserveHostVisit(ctx: MutationCtx, ledger: Doc<'visitLedger'>) {
  const now = Date.now();
  if (ledger.leaseExpiry <= now) throw new Error('VISIT_LEASE_EXPIRED');
  const reservedUntil = Math.min(now + VISIT_RESERVATION_MS, ledger.leaseExpiry);
  await ctx.db.patch(ledger._id, { state: 'RESERVED', queuePaused: false, updatedAt: now });
  await ctx.db.insert('visitReservations', {
    visitId: ledger.visitId, hostTownId: ledger.hostTownId, reservedSlot: true, expiresAt: reservedUntil,
  });
  await enqueueMessage(ctx, {
    peerTownId: ledger.homeTownId, type: 'VISIT_RESERVED', visitId: ledger.visitId,
    payload: { fencingToken: ledger.fencingToken, reservedUntil, leaseExpiry: ledger.leaseExpiry },
  });
}

/** No presence or inference has been authorized for a queued Host visit. */
export async function terminateQueuedVisit(ctx: MutationCtx, ledger: Doc<'visitLedger'>, reason: string) {
  if (ledger.role !== 'host' || ledger.state !== 'QUEUED') return;
  await ctx.db.patch(ledger._id, {
    state: 'REJECTED', cleanupConfirmed: true, queueReason: reason, lastError: reason, updatedAt: Date.now(),
  });
  const remote = await peer(ctx, ledger.homeTownId);
  if (!remote) return;
  try {
    // Cleanup stays legal after trust is paused/revoked and under deployment pressure.
    await enqueueMessage(ctx, {
      peerTownId: ledger.homeTownId, type: 'VISIT_CLEANED', visitId: ledger.visitId,
      payload: { fencingToken: ledger.fencingToken, reason },
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'OUTBOX_CAPACITY_EXCEEDED') throw error;
    // The immutable terminal ledger proves cleanup during resync. Never undo it
    // merely because notification capacity is exhausted; Home still fences its lease.
    await ctx.db.patch(ledger._id, { lastError: `${reason}:OUTBOX_CAPACITY_EXCEEDED` });
  }
}

function compareQueued(a: Doc<'visitLedger'>, b: Doc<'visitLedger'>) {
  return (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt) ||
    a._creationTime - b._creationTime || a._id.localeCompare(b._id);
}

/** Re-check all authority and resource gates before every atomic reservation. */
export async function drainVisitorQueue(ctx: MutationCtx, transitionLimit = VISITOR_QUEUE_BATCH_SIZE) {
  const budget = Number.isFinite(transitionLimit)
    ? Math.max(0, Math.min(VISITOR_QUEUE_BATCH_SIZE, Math.floor(transitionLimit))) : 0;
  const result = { promoted: [] as string[], terminated: [] as string[] };
  if (!budget) return result;
  // Helpers may also be called by archive-aware code; preserve a locked snapshot.
  if (await ctx.db.query('backupMaintenanceLocks').withIndex('key', q => q.eq('key', 'town')).unique()) return result;
  const policy = await configuredVisitorQueue(ctx.db);
  const rows = (await queuedHostVisits(ctx.db)).sort(compareQueued);
  const local = await identity(ctx);
  const now = Date.now();
  const conflict = await ctx.db.query('federationIdentityConflicts')
    .withIndex('state', q => q.eq('state', 'OPEN')).first();
  const peers = new Map<string, Awaited<ReturnType<typeof peer>>>();
  const connections = new Map<string, Awaited<ReturnType<typeof session>>>();
  const candidates: Doc<'visitLedger'>[] = [];
  for (const row of rows) {
    if (!peers.has(row.homeTownId)) {
      peers.set(row.homeTownId, await peer(ctx, row.homeTownId));
      connections.set(row.homeTownId, await session(ctx, row.homeTownId));
    }
    const remote = peers.get(row.homeTownId);
    let ended: string | undefined;
    if ((row.queueExpiresAt ?? 0) <= now || row.leaseExpiry <= now) ended = 'VISITOR_QUEUE_EXPIRED';
    else if (!policy.enabled) ended = 'VISITOR_QUEUE_DISABLED';
    else if (local?.mode === 'QUARANTINED' || conflict) ended = 'VISITOR_QUEUE_IDENTITY_FENCED';
    else if (!local || local.townId !== row.hostTownId || local.deploymentEpoch !== row.hostDeploymentEpoch ||
      !remote || remote.deploymentEpoch !== row.homeDeploymentEpoch) ended = 'VISITOR_QUEUE_DEPLOYMENT_FENCED';
    else if (remote.trustState === 'REVOKED') ended = 'VISITOR_QUEUE_PEER_REVOKED';
    if (ended) {
      await terminateQueuedVisit(ctx, row, ended);
      result.terminated.push(row.visitId);
      // Each cleanup notification scans the bounded Outbox. Stop the batch
      // before considering any remaining authority-invalid row for admission.
      if (result.terminated.length >= budget) return result;
    } else candidates.push(row);
  }
  if (!candidates.length || rows.length > MAX_VISITOR_QUEUE) return result;
  const snapshot = await visitorAdmissionSnapshot(ctx);
  if (snapshot.reason) {
    for (const row of candidates) if (!row.queuePaused && row.queueReason !== snapshot.reason)
      await ctx.db.patch(row._id, { queueReason: snapshot.reason });
    return result;
  }
  const outbox = await ctx.db.query('federationOutbox')
    .withIndex('retry', q => q.eq('ackedAt', undefined).eq('failedAt', undefined)).take(901);
  let grantsAvailable = Math.min(budget - result.terminated.length, 900 - outbox.length);
  let lastSource = policy.visitorQueueLastSource;
  while (grantsAvailable > 0 && candidates.length) {
    const eligible: Doc<'visitLedger'>[] = [];
    for (const row of candidates) {
      const remote = peers.get(row.homeTownId), connection = connections.get(row.homeTownId);
      let blocked: string | undefined;
      if (row.queuePaused) continue;
      if (remote?.trustState !== 'TRUSTED' || !remote.inboundVisitsAllowed) blocked = 'VISITS_NOT_ALLOWED';
      else if (!ready(connection ?? null, now) || connection!.localDeploymentEpoch !== local!.deploymentEpoch ||
        connection!.verifiedPeerDeploymentEpoch !== remote.deploymentEpoch) blocked = 'DIRECT_PEER_NOT_MUTUALLY_REACHABLE';
      else blocked = sourceAdmissionReason(snapshot, row.homeTownId);
      if (blocked) {
        if (row.queueReason !== blocked) {
          await ctx.db.patch(row._id, { queueReason: blocked });
          row.queueReason = blocked;
        }
      } else eligible.push(row);
    }
    if (!eligible.length) break;
    let selected = eligible[0];
    if (policy.visitorQueueMode === 'SOURCE_ROUND_ROBIN') {
      const sources = [...new Set(eligible.map(row => row.homeTownId))].sort();
      const nextSource = sources.find(source => lastSource === undefined || source > lastSource) ?? sources[0];
      selected = eligible.find(row => row.homeTownId === nextSource)!;
    }
    // A corrupt/conflicting ledger can never be promoted into a second entity.
    const active = await ctx.db.query('visitLedger')
      .withIndex('agentGlobalId', q => q.eq('agentGlobalId', selected.agentGlobalId)).take(1001);
    if (active.length > 1000 || active.some(row => row._id !== selected._id &&
      (!TERMINAL.has(row.state) || row.agentAuthorityEpoch >= selected.agentAuthorityEpoch))) {
      await terminateQueuedVisit(ctx, selected, 'AGENT_ALREADY_PRESENT');
      result.terminated.push(selected.visitId);
    } else {
      await reserveHostVisit(ctx, selected);
      result.promoted.push(selected.visitId);
      snapshot.occupied++;
      snapshot.reservations++;
      snapshot.sources.set(selected.homeTownId, (snapshot.sources.get(selected.homeTownId) ?? 0) + 1);
      if (snapshot.occupied >= local!.maxVisitors) snapshot.reason = 'HOST_CAPACITY_EXCEEDED';
      else if (snapshot.reservations >= snapshot.limits.maxVisitReservations) snapshot.reason = 'HOST_RESERVATION_CAPACITY_EXCEEDED';
      lastSource = selected.homeTownId;
      if (policy.visitorQueueMode === 'SOURCE_ROUND_ROBIN') {
        const record = await ctx.db.query('federationResourcePolicy').unique();
        if (record) await ctx.db.patch(record._id, { visitorQueueLastSource: lastSource });
      }
    }
    // Identity-conflict cleanup consumes the same transaction work budget as a
    // successful grant, so neither path can scan the Outbox without a bound.
    grantsAvailable--;
    candidates.splice(candidates.findIndex(row => row._id === selected._id), 1);
    if (snapshot.reason) break;
  }
  return result;
}
