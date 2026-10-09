import { v } from 'convex/values';
import {
  internalMutation,
  mutation,
  query,
  ActionCtx,
  MutationCtx,
  QueryCtx,
} from '../maintenanceFunctions';
import { identity, peer } from './store';
import { digest, requireAdmin, verifyPacket, verifySignature } from './security';
import { FederationMessage, PROTOCOL, validateEnvelope } from './protocol';
import { mutationRef } from './refs';
import type { Handoff } from './migration';

const source = v.union(
  v.literal('HEALTH'),
  v.literal('PAIR'),
  v.literal('MESSAGE'),
  v.literal('ACK'),
  v.literal('ENDPOINT'),
);
type Source = 'HEALTH' | 'PAIR' | 'MESSAGE' | 'ACK' | 'ENDPOINT';
type SignedEvidence = { body: Record<string, unknown>; signature: string; mac?: string };
const TERMINAL_VISITS = ['COMPLETED', 'REJECTED', 'CANCELLED'];

/** This is an admission guard, never a guard for local simulation or lease cleanup. */
export async function assertNoIdentityConflict(ctx: QueryCtx | MutationCtx, _peerTownId?: string) {
  const local = await identity(ctx);
  const open = await ctx.db
    .query('federationIdentityConflicts')
    .withIndex('state', (q) => q.eq('state', 'OPEN'))
    .first();
  if (local?.mode === 'QUARANTINED' || open) throw new Error('TOWN_CLONE_CONFLICT');
}

function signedEvidence(value: unknown): SignedEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const packet = value as Record<string, unknown>;
  if (
    !packet.body ||
    typeof packet.body !== 'object' ||
    Array.isArray(packet.body) ||
    typeof packet.signature !== 'string'
  )
    return null;
  return {
    body: packet.body as Record<string, unknown>,
    signature: packet.signature,
    ...(typeof packet.mac === 'string' ? { mac: packet.mac } : {}),
  };
}

function claim(packet: SignedEvidence, kind: Source, localTownId: string) {
  const b = packet?.body;
  if (
    !b ||
    typeof packet.signature !== 'string' ||
    new TextEncoder().encode(JSON.stringify({ body: b, signature: packet.signature })).length >
      64_000 ||
    b.protocol !== PROTOCOL ||
    typeof b.expiresAt !== 'number' ||
    !Number.isFinite(b.expiresAt) ||
    b.expiresAt <= Date.now() ||
    b.expiresAt > Date.now() + 10 * 60_000
  )
    return null;
  if (kind === 'MESSAGE') validateEnvelope(b as FederationMessage);
  if (
    b.sentAt !== undefined &&
    (typeof b.sentAt !== 'number' ||
      !Number.isFinite(b.sentAt) ||
      b.sentAt < 0 ||
      b.sentAt > Date.now() + 30_000 ||
      b.sentAt >= b.expiresAt)
  )
    return null;
  if (
    kind === 'ACK' &&
    (typeof b.type !== 'string' || !['TRANSPORT_PROBE_ACK', 'MESSAGE_ACK'].includes(b.type))
  )
    return null;
  if (kind === 'ENDPOINT' && !['ENDPOINT_UPDATE', 'ENDPOINT_UPDATE_ACK'].includes(String(b.type))) return null;
  const transport = kind === 'MESSAGE' || kind === 'ACK' || kind === 'ENDPOINT';
  if (transport && b.toTownId !== localTownId) return null;
  if (kind === 'HEALTH' && b.expiresAt > Date.now() + 60_000) return null;
  if (kind === 'PAIR' && b.targetTownId !== undefined && b.targetTownId !== localTownId)
    return null;
  const townId = transport ? b.fromTownId : b.townId;
  const instance = transport ? b.senderDeploymentInstanceId : b.deploymentInstanceId;
  const epoch = transport ? b.senderDeploymentEpoch : b.deploymentEpoch;
  if (
    typeof townId !== 'string' ||
    !townId ||
    townId.length > 200 ||
    typeof instance !== 'string' ||
    !instance ||
    instance.length > 200 ||
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1
  )
    return null;
  return {
    townId,
    instance,
    epoch,
    issuedAt: typeof b.sentAt === 'number' ? b.sentAt : undefined,
  };
}

async function recognizedHandoff(
  ctx: MutationCtx,
  known: {
    townId: string;
    publicKey: string;
    deploymentInstanceId: string;
    deploymentEpoch: number;
    mode?: string;
    activeHandoffId?: string;
  },
  observed: NonNullable<ReturnType<typeof claim>>,
) {
  // A verified handoff accounts for old data issued before source authority was frozen.
  // New signed traffic from the retired source is evidence of conflicting authority.
  // Legacy health/ACK data lacks signed issuance time: reject its retired identity,
  // but do not infer newly issued authority merely by subtracting a TTL from expiry.
  const records = await ctx.db
    .query('migrationHandoffRecords')
    .withIndex('townId', (q) => q.eq('townId', known.townId))
    .collect();
  const handoffs: Handoff[] = [];
  for (const record of records) {
    const b = record.body as Handoff | undefined;
    if (
      b?.purpose === 'ai-town-migration-handoff/1' &&
      b.townId === known.townId &&
      b.publicKey === known.publicKey &&
      typeof b.sourceDeploymentInstanceId === 'string' &&
      Number.isSafeInteger(b.sourceDeploymentEpoch) &&
      b.sourceDeploymentEpoch > 0 &&
      b.target?.townId === known.townId &&
      b.target.publicKey === known.publicKey &&
      typeof b.target.deploymentInstanceId === 'string' &&
      b.target.deploymentInstanceId !== b.sourceDeploymentInstanceId &&
      Number.isSafeInteger(b.target.deploymentEpoch) &&
      b.target.deploymentEpoch > b.sourceDeploymentEpoch &&
      b.authorityScope === 'ALL_FEDERATION_AUTHORITY_DRAINED' &&
      Number.isFinite(b.frozenAt) &&
      b.frozenAt >= 0 &&
      Number.isFinite(b.issuedAt) &&
      b.issuedAt >= b.frozenAt &&
      b.issuedAt <= record.acceptedAt + 60_000 &&
      (await verifySignature(b, record.signature, known.publicKey))
    ) {
      handoffs.push(b);
      // The frozen source also knows its own authorized successor. Discovering
      // that target does not turn a completed handoff into an alleged clone.
      if (
        known.mode === 'MIGRATING_OUT' &&
        record.role === 'SOURCE' &&
        known.activeHandoffId === record.handoffId &&
        b.handoffId === record.handoffId &&
        b.sourceDeploymentInstanceId === known.deploymentInstanceId &&
        b.sourceDeploymentEpoch === known.deploymentEpoch &&
        b.target.deploymentInstanceId === observed.instance &&
        b.target.deploymentEpoch === observed.epoch
      )
        return 'HANDOFF_TARGET';
    }
  }
  // Follow the accepted chain so delayed data from an earlier migration is also fenced safely.
  const frontier = [{ instance: observed.instance, epoch: observed.epoch }];
  const seen = new Set<string>();
  while (frontier.length) {
    const current = frontier.pop()!;
    const key = `${current.instance}:${current.epoch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const b of handoffs) {
      if (
        b.sourceDeploymentInstanceId !== current.instance ||
        b.sourceDeploymentEpoch !== current.epoch ||
        (current.instance === observed.instance &&
          current.epoch === observed.epoch &&
          observed.issuedAt !== undefined &&
          observed.issuedAt > b.frozenAt)
      )
        continue;
      if (
        b.target.deploymentInstanceId === known.deploymentInstanceId &&
        b.target.deploymentEpoch === known.deploymentEpoch
      )
        return 'RETIRED_SOURCE';
      frontier.push({ instance: b.target.deploymentInstanceId, epoch: b.target.deploymentEpoch });
    }
  }
  return undefined;
}

export const observe = internalMutation({
  args: { packet: v.any(), source },
  handler: async (ctx, args) => {
    const local = await identity(ctx);
    if (!local) return { disposition: 'UNVERIFIED' };
    const packet = signedEvidence(args.packet as unknown);
    if (!packet) return { disposition: 'UNVERIFIED' };
    const observed = claim(packet, args.source, local.townId);
    if (!observed) return { disposition: 'UNVERIFIED' };
    const known = observed.townId === local.townId ? local : await peer(ctx, observed.townId);
    // A stranger's self-signed key or an unsigned claim can never freeze this town.
    if (!known || !(await verifySignature(packet.body, packet.signature, known.publicKey)))
      return { disposition: 'UNVERIFIED' };
    if (['MESSAGE', 'ACK', 'ENDPOINT'].includes(args.source)) {
      if (
        !('credentialEncrypted' in known) ||
        typeof packet.mac !== 'string' ||
        packet.body.credentialId !== known.credentialId ||
        !(await verifyPacket(
          { ...packet, mac: packet.mac },
          known.publicKey,
          known.credentialEncrypted,
        ))
      )
        return { disposition: 'UNVERIFIED' };
    } else if (
      packet.body.publicKey !== known.publicKey ||
      packet.body.fingerprint !== known.fingerprint
    )
      return { disposition: 'UNVERIFIED' };
    if (observed.instance === known.deploymentInstanceId)
      return { disposition: observed.epoch === known.deploymentEpoch ? 'MATCH' : 'EPOCH_MISMATCH' };
    const handoff = await recognizedHandoff(ctx, known, observed);
    if (handoff) return { disposition: handoff };
    const evidence = { body: packet.body, signature: packet.signature };
    const conflictKey = await digest({
      townId: known.townId,
      publicKey: known.publicKey,
      knownInstance: known.deploymentInstanceId,
      knownEpoch: known.deploymentEpoch,
      observedInstance: observed.instance,
      observedEpoch: observed.epoch,
    });
    const previous = await ctx.db
      .query('federationIdentityConflicts')
      .withIndex('conflictKey', (q) => q.eq('conflictKey', conflictKey))
      .order('desc')
      .first();
    const evidenceDigest = await digest(evidence);
    // Replaying evidence already reviewed cannot repeatedly quarantine an administrator.
    if (
      previous?.state === 'RESOLVED' &&
      (previous.evidenceDigest === evidenceDigest ||
        observed.issuedAt === undefined ||
        observed.issuedAt <= (previous.resolvedAt ?? 0))
    )
      return { disposition: 'RESOLVED_EVIDENCE', conflictId: previous._id };
    let conflictId = previous?._id;
    if (!previous || previous.state === 'RESOLVED') {
      const fields = {
        conflictKey,
        townId: known.townId,
        publicKey: known.publicKey,
        knownDeploymentInstanceId: known.deploymentInstanceId,
        knownDeploymentEpoch: known.deploymentEpoch,
        observedDeploymentInstanceId: observed.instance,
        observedDeploymentEpoch: observed.epoch,
        source: args.source,
        evidence,
        evidenceDigest,
        state: 'OPEN',
        detectedAt: Date.now(),
        resolvedAt: undefined,
        resolution: undefined,
      };
      // Reviewed signed evidence is immutable; a new observation gets a new case.
      conflictId = await ctx.db.insert('federationIdentityConflicts', fields);
      await ctx.db.insert('federationIdentityConflictAudit', {
        operation: 'DETECTED',
        conflictId,
        townId: known.townId,
        reason: 'TOWN_CLONE_CONFLICT',
        createdAt: Date.now(),
      });
    }
    if (local.mode !== 'QUARANTINED')
      await ctx.db.patch(local._id, {
        mode: 'QUARANTINED',
        quarantinePreviousMode: local.mode,
      });
    // Credentials and ledgers remain available solely for the existing cleanup rules.
    const connections = await ctx.db.query('transportSessions').collect();
    for (const connection of connections)
      await ctx.db.patch(connection._id, {
        channelState: 'TRANSPORT_TESTING',
        inboundVerifiedAt: undefined,
        outboundVerifiedAt: undefined,
        lastError: 'TOWN_CLONE_CONFLICT',
      });
    return { disposition: 'CONFLICT', conflictId };
  },
});

/** Commit evidence separately before rejecting a business transaction (Convex rolls back throws). */
export async function observeSignedIdentity(
  ctx: Pick<ActionCtx, 'runMutation'>,
  packet: unknown,
  kind: Source,
) {
  const result = (await ctx.runMutation(mutationRef('identityConflict/observe'), {
    packet,
    source: kind,
  })) as { disposition: string };
  if (result.disposition === 'CONFLICT') throw new Error('TOWN_CLONE_CONFLICT');
}

export const status = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const local = await identity(ctx);
    const open = await ctx.db
      .query('federationIdentityConflicts')
      .withIndex('state', (q) => q.eq('state', 'OPEN'))
      .order('desc')
      .take(101);
    const resolved = await ctx.db
      .query('federationIdentityConflicts')
      .withIndex('state', (q) => q.eq('state', 'RESOLVED'))
      .order('desc')
      .take(50);
    return {
      quarantined: local?.mode === 'QUARANTINED',
      previousMode: local?.quarantinePreviousMode,
      // Open cases remain reachable even when a long resolved history fills the page.
      conflicts: [...open.slice(0, 100), ...resolved],
      openConflictsTruncated: open.length > 100,
      audit: await ctx.db.query('federationIdentityConflictAudit').order('desc').take(100),
    };
  },
});

export const resolve = mutation({
  args: {
    adminToken: v.string(),
    conflictId: v.id('federationIdentityConflicts'),
    decision: v.union(v.literal('RETAIN_KNOWN'), v.literal('REVOKE_PEER')),
    operator: v.string(),
    reason: v.string(),
    sourceStopped: v.boolean(),
  },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    if (!args.sourceStopped) throw new Error('CONFLICTING_SOURCE_STOP_REQUIRED');
    if (
      !args.operator.trim() ||
      args.operator.length > 100 ||
      !args.reason.trim() ||
      args.reason.length > 1000
    )
      throw new Error('CONFLICT_REVIEW_DETAILS_REQUIRED');
    const conflict = await ctx.db.get(args.conflictId),
      local = await identity(ctx);
    if (!conflict || conflict.state !== 'OPEN' || !local)
      throw new Error('OPEN_CONFLICT_NOT_FOUND');
    if (conflict.townId === local.townId && args.decision !== 'RETAIN_KNOWN')
      throw new Error('LOCAL_IDENTITY_REQUIRES_RETAIN_KNOWN');
    const active = await ctx.db
      .query('visitLedger')
      .filter((q) =>
        q.and(
          q.or(
            q.eq(q.field('homeTownId'), conflict.townId),
            q.eq(q.field('hostTownId'), conflict.townId),
          ),
          ...TERMINAL_VISITS.map((state) => q.neq(q.field('state'), state)),
        ),
      )
      .first();
    if (active) throw new Error('CONFLICT_VISITS_NOT_DRAINED');
    const peers =
      conflict.townId === local.townId
        ? await ctx.db.query('federationPeers').collect()
        : [await peer(ctx, conflict.townId)];
    for (const remote of peers)
      if (remote)
        await ctx.db.patch(remote._id, {
          trustState: 'REVOKED',
          inboundVisitsAllowed: false,
          outboundVisitsAllowed: false,
          credentialId: `conflict-review:${conflict._id}`,
          credentialEncrypted: '',
        });
    await ctx.db.patch(conflict._id, {
      state: 'RESOLVED',
      resolvedAt: Date.now(),
      resolution: args.decision,
    });
    await ctx.db.insert('federationIdentityConflictAudit', {
      operation: 'RESOLVED',
      conflictId: conflict._id,
      townId: conflict.townId,
      operator: args.operator.trim(),
      reason: args.reason.trim(),
      decision: args.decision,
      createdAt: Date.now(),
    });
    const remaining = await ctx.db
      .query('federationIdentityConflicts')
      .withIndex('state', (q) => q.eq('state', 'OPEN'))
      .first();
    if (!remaining && local.mode === 'QUARANTINED') {
      await ctx.db.patch(local._id, {
        mode: local.quarantinePreviousMode ?? 'NEEDS_RECONCILIATION',
        quarantinePreviousMode: undefined,
        enabled: false,
        allowIncomingPairRequests: false,
      });
      await ctx.db.insert('federationIdentityConflictAudit', {
        operation: 'RELEASED',
        townId: local.townId,
        operator: args.operator.trim(),
        reason: args.reason.trim(),
        createdAt: Date.now(),
      });
    }
    return { released: !remaining, federationEnabled: false, repairRequired: true };
  },
});
