import { v } from 'convex/values';
import type { HttpRouter } from 'convex/server';
import {
  action,
  httpAction,
  internalMutation,
  internalAction,
  internalQuery,
  mutation,
  query,
  MutationCtx,
  QueryCtx,
} from '../maintenanceFunctions';
import { Doc } from '../_generated/dataModel';
import { identity, peer, session } from './store';
import { actionRef, mutationRef, queryRef } from './refs';
import { beginReturn } from './ledger';
import { directRequest, readRequest } from './direct';
import { normalizeEndpoint, canonicalJson, PROTOCOL } from './protocol';
import {
  digest,
  ephemeralKeys,
  fromBase64,
  openSecret,
  randomSecret,
  requireAdmin,
  sealSecret,
  sign,
  toBase64,
  verifySignature,
} from './security';

const PURPOSE = 'ai-town-migration-handoff/1';
const TERMINAL = ['COMPLETED', 'REJECTED', 'CANCELLED'];
const packetArgs = { packet: v.any() };
type Target = {
  townId: string;
  publicKey: string;
  deploymentInstanceId: string;
  deploymentEpoch: number;
  endpoint: string;
};
type PublicPeer = Omit<
  Doc<'federationPeers'>,
  '_id' | '_creationTime' | 'credentialEncrypted' | 'credentialId' | 'verifiedHandoffId'
>;
export type Handoff = {
  purpose: typeof PURPOSE;
  handoffId: string;
  townId: string;
  publicKey: string;
  sourceDeploymentInstanceId: string;
  sourceDeploymentEpoch: number;
  target: Target;
  frozenAt: number;
  issuedAt: number;
  operator: string;
  authorityScope: 'ALL_FEDERATION_AUTHORITY_DRAINED';
  peers: PublicPeer[];
};
export type HandoffPacket = { body: Handoff; signature: string };
function boundedString(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function validTarget(t: Target) {
  if (
    !t ||
    !boundedString(t.townId) ||
    !boundedString(t.publicKey) ||
    !boundedString(t.deploymentInstanceId) ||
    !Number.isSafeInteger(t.deploymentEpoch) ||
    t.deploymentEpoch < 1 ||
    normalizeEndpoint(t.endpoint) !== t.endpoint
  )
    throw new Error('INVALID_MIGRATION_TARGET');
}
async function validateHandoff(packet: HandoffPacket, publicKey: string) {
  const b = packet?.body;
  if (
    !b ||
    Object.keys(packet).sort().join(',') !== 'body,signature' ||
    new TextEncoder().encode(JSON.stringify(packet)).length > 48_000 ||
    b.purpose !== PURPOSE ||
    !boundedString(b.handoffId) ||
    !boundedString(b.townId) ||
    b.publicKey !== publicKey ||
    !boundedString(b.sourceDeploymentInstanceId) ||
    !Number.isSafeInteger(b.sourceDeploymentEpoch) ||
    b.sourceDeploymentEpoch < 1 ||
    !boundedString(b.operator, 100) ||
    !Number.isFinite(b.frozenAt) ||
    !Number.isFinite(b.issuedAt) ||
    b.frozenAt < 0 ||
    b.issuedAt < b.frozenAt ||
    b.issuedAt > Date.now() + 60_000 ||
    b.authorityScope !== 'ALL_FEDERATION_AUTHORITY_DRAINED' ||
    !Array.isArray(b.peers) ||
    b.peers.length > 64
  )
    throw new Error('INVALID_MIGRATION_HANDOFF');
  validTarget(b.target);
  if (
    b.target.townId !== b.townId ||
    b.target.publicKey !== publicKey ||
    b.target.deploymentInstanceId === b.sourceDeploymentInstanceId ||
    b.target.deploymentEpoch <= b.sourceDeploymentEpoch ||
    !(await verifySignature(b, packet.signature, publicKey))
  )
    throw new Error('INVALID_MIGRATION_HANDOFF');
  const seen = new Set<string>();
  for (const p of b.peers) {
    validTarget(p);
    if (
      seen.has(p.townId) ||
      p.townId === b.townId ||
      !boundedString(p.townName, 80) ||
      p.fingerprint !== `sha256:${await digest(p.publicKey)}` ||
      !['TRUSTED', 'PAUSED', 'REVOKED'].includes(p.trustState) ||
      typeof p.inboundVisitsAllowed !== 'boolean' ||
      typeof p.outboundVisitsAllowed !== 'boolean' ||
      !Number.isFinite(p.pairedAt)
    )
      throw new Error('INVALID_MIGRATION_PEER');
    seen.add(p.townId);
  }
  return b;
}
async function record(ctx: QueryCtx | MutationCtx, handoffId: string) {
  return ctx.db
    .query('migrationHandoffRecords')
    .withIndex('handoffId', (q) => q.eq('handoffId', handoffId))
    .unique();
}
async function exchange(
  ctx: QueryCtx | MutationCtx,
  handoffId: string,
  peerTownId: string,
  direction: string,
) {
  return ctx.db
    .query('migrationPeerExchanges')
    .withIndex('exchange', (q) =>
      q.eq('handoffId', handoffId).eq('peerTownId', peerTownId).eq('direction', direction),
    )
    .unique();
}
async function resetSession(
  ctx: MutationCtx,
  local: Doc<'federationIdentity'>,
  remote: Doc<'federationPeers'>,
) {
  const existing = await session(ctx, remote.townId);
  const fields = {
    peerTownId: remote.townId,
    channelState: 'TRANSPORT_TESTING',
    transportType: 'DIRECT_HTTPS',
    localDeploymentEpoch: local.deploymentEpoch,
    verifiedPeerDeploymentEpoch: remote.deploymentEpoch,
    inboundVerifiedAt: undefined,
    outboundVerifiedAt: undefined,
    lastReadyAt: undefined,
    lastError: undefined,
  };
  if (existing) await ctx.db.patch(existing._id, fields);
  else await ctx.db.insert('transportSessions', fields);
}
async function assertDrained(ctx: MutationCtx) {
  if (
    (await ctx.db
      .query('visitLedger')
      .filter((q) => q.and(...TERMINAL.map((s) => q.neq(q.field('state'), s))))
      .first()) ||
    (await ctx.db
      .query('federationAgentRuntimes')
      .filter((q) => q.neq(q.field('state'), 'HOME_ACTIVE'))
      .first())
  )
    throw new Error('MIGRATION_VISITS_NOT_DRAINED');
  if (
    await ctx.db
      .query('visitReservations')
      .withIndex('active', (q) => q.eq('reservedSlot', true))
      .first()
  )
    throw new Error('MIGRATION_RESERVATIONS_NOT_DRAINED');
  const worlds = await ctx.db.query('worlds').collect();
  if (worlds.some((w) => w.players.some((p) => p.remoteVisitor)))
    throw new Error('MIGRATION_VISITOR_PRESENCE_NOT_DRAINED');
}

// Freezing is durable before any handoff is signed. Cleanup and local simulation remain available.
export const freezeSource = mutation({
  args: { adminToken: v.string(), operator: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    if (!args.operator.trim() || args.operator.length > 100)
      throw new Error('INVALID_MIGRATION_OPERATOR');
    const local = await identity(ctx);
    if (!local || !['ACTIVE', 'MIGRATING_OUT'].includes(local.mode))
      throw new Error('DEPLOYMENT_NOT_ACTIVE');
    if (local.mode === 'ACTIVE') {
      await ctx.db.patch(local._id, {
        mode: 'MIGRATING_OUT',
        enabled: false,
        allowIncomingPairRequests: false,
        migrationFrozenAt: Date.now(),
        migrationOperator: args.operator.trim(),
        activeHandoffId: undefined,
      });
      await ctx.db.insert('deploymentRecords', {
        townId: local.townId,
        deploymentInstanceId: local.deploymentInstanceId,
        deploymentEpoch: local.deploymentEpoch,
        mode: 'MIGRATING_OUT',
        createdAt: Date.now(),
      });
    }
    // Bound each drain transaction; callers repeat this operation while normal lease recovery runs.
    const active = await ctx.db
      .query('visitLedger')
      .filter((q) =>
        q.and(
          ...[...TERMINAL, 'RETURN_PENDING', 'REMOVING'].map((s) => q.neq(q.field('state'), s)),
        ),
      )
      .take(20);
    for (const visit of active) await beginReturn(ctx, visit, 'MIGRATION_SOURCE_FROZEN');
    return { mode: 'MIGRATING_OUT', draining: active.length, townId: local.townId };
  },
});
export const prepareTarget = action({
  args: { adminToken: v.string(), endpoint: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const local = await ctx.runMutation(mutationRef('migration/prepareTargetInternal'), {
      endpoint: normalizeEndpoint(args.endpoint),
    });
    const body = {
      purpose: 'ai-town-migration-target/1',
      townId: local.townId,
      publicKey: local.publicKey,
      deploymentInstanceId: local.deploymentInstanceId,
      deploymentEpoch: local.deploymentEpoch,
      endpoint: local.endpoint,
    };
    return { body, signature: await sign(body, local.privateKeyEncrypted) };
  },
});
export const prepareTargetInternal = internalMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const local = await identity(ctx);
    if (
      !local ||
      local.enabled ||
      !['ACTIVE', 'NEEDS_RECONCILIATION', 'MIGRATING_IN'].includes(local.mode) ||
      local.activeHandoffId
    )
      throw new Error('MIGRATION_TARGET_NOT_RECOVERED');
    await ctx.db.patch(local._id, {
      mode: 'MIGRATING_IN',
      enabled: false,
      allowIncomingPairRequests: false,
      endpoint: normalizeEndpoint(args.endpoint),
    });
    return { ...local, endpoint: normalizeEndpoint(args.endpoint) };
  },
});
export const signHandoff = mutation({
  args: { adminToken: v.string(), targetPacket: v.any() },
  handler: async (ctx, args): Promise<HandoffPacket> => {
    requireAdmin(args.adminToken);
    const local = await identity(ctx),
      t = args.targetPacket?.body;
    if (
      !local ||
      local.mode !== 'MIGRATING_OUT' ||
      !local.migrationFrozenAt ||
      !local.migrationOperator
    )
      throw new Error('MIGRATION_SOURCE_NOT_FROZEN');
    validTarget(t);
    if (
      t.purpose !== 'ai-town-migration-target/1' ||
      t.townId !== local.townId ||
      t.publicKey !== local.publicKey ||
      t.deploymentInstanceId === local.deploymentInstanceId ||
      t.deploymentEpoch <= local.deploymentEpoch ||
      !(await verifySignature(t, args.targetPacket.signature, local.publicKey))
    )
      throw new Error('INVALID_MIGRATION_TARGET');
    const target: Target = {
      townId: t.townId,
      publicKey: t.publicKey,
      deploymentInstanceId: t.deploymentInstanceId,
      deploymentEpoch: t.deploymentEpoch,
      endpoint: t.endpoint,
    };
    if (local.activeHandoffId) {
      const old = await record(ctx, local.activeHandoffId);
      if (!old || canonicalJson(old.body.target) !== canonicalJson(target))
        throw new Error('MIGRATION_ALREADY_ASSIGNED');
      return { body: old.body, signature: old.signature };
    }
    if (
      await ctx.db
        .query('engines')
        .filter((q) => q.eq(q.field('running'), true))
        .first()
    )
      throw new Error('STOP_SOURCE_ENGINE_BEFORE_HANDOFF');
    await assertDrained(ctx);
    const peers = await ctx.db.query('federationPeers').take(65);
    if (peers.length > 64) throw new Error('MIGRATION_PEER_LIMIT');
    const body: Handoff = {
      purpose: PURPOSE,
      handoffId: crypto.randomUUID(),
      townId: local.townId,
      publicKey: local.publicKey,
      sourceDeploymentInstanceId: local.deploymentInstanceId,
      sourceDeploymentEpoch: local.deploymentEpoch,
      target,
      frozenAt: local.migrationFrozenAt,
      issuedAt: Date.now(),
      operator: local.migrationOperator,
      authorityScope: 'ALL_FEDERATION_AUTHORITY_DRAINED',
      peers: peers.map(
        ({ _id, _creationTime, credentialEncrypted, credentialId, verifiedHandoffId, ...p }) => p,
      ),
    };
    const packet = { body, signature: await sign(body, local.privateKeyEncrypted) };
    await validateHandoff(packet, local.publicKey);
    await ctx.db.insert('migrationHandoffRecords', {
      handoffId: body.handoffId,
      townId: body.townId,
      ...packet,
      role: 'SOURCE',
      acceptedAt: Date.now(),
    });
    await ctx.db.patch(local._id, { activeHandoffId: body.handoffId });
    return packet;
  },
});
export const activateTarget = mutation({
  args: { adminToken: v.string(), ...packetArgs },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const local = await identity(ctx);
    if (!local) throw new Error('MIGRATION_TARGET_NOT_RECOVERED');
    const b = await validateHandoff(args.packet, local.publicKey);
    if (
      b.townId !== local.townId ||
      b.target.deploymentInstanceId !== local.deploymentInstanceId ||
      b.target.deploymentEpoch !== local.deploymentEpoch ||
      b.target.endpoint !== local.endpoint
    )
      throw new Error('MIGRATION_TARGET_MISMATCH');
    if (local.activeHandoffId === b.handoffId && local.mode === 'ACTIVE')
      return { townId: local.townId, deploymentEpoch: local.deploymentEpoch };
    if (local.mode !== 'MIGRATING_IN' || local.enabled || local.activeHandoffId)
      throw new Error('MIGRATION_TARGET_NOT_RECOVERED');
    await assertDrained(ctx);
    for (const p of b.peers) {
      const existing = await peer(ctx, p.townId);
      if (
        existing &&
        (existing.publicKey !== p.publicKey ||
          existing.deploymentEpoch !== p.deploymentEpoch ||
          existing.deploymentInstanceId !== p.deploymentInstanceId)
      )
        throw new Error('MIGRATION_PEER_IDENTITY_CONFLICT');
      const fields = {
        ...p,
        credentialId: `migration-pending:${b.handoffId}`,
        credentialEncrypted: await sealSecret(randomSecret()),
        trustState: p.trustState === 'TRUSTED' ? 'MIGRATION_PENDING' : p.trustState,
      };
      const id = existing ? existing._id : await ctx.db.insert('federationPeers', fields);
      if (existing) await ctx.db.patch(id, fields);
      await resetSession(ctx, local, (await ctx.db.get(id))!);
    }
    const old = await record(ctx, b.handoffId);
    if (old && (await digest(old.body)) !== (await digest(b)))
      throw new Error('MIGRATION_HANDOFF_CONFLICT');
    if (!old)
      await ctx.db.insert('migrationHandoffRecords', {
        handoffId: b.handoffId,
        townId: b.townId,
        ...args.packet,
        role: 'TARGET',
        acceptedAt: Date.now(),
      });
    await ctx.db.patch(local._id, {
      mode: 'ACTIVE',
      enabled: true,
      allowIncomingPairRequests: false,
      activeHandoffId: b.handoffId,
      migrationFrozenAt: undefined,
      migrationOperator: undefined,
    });
    await ctx.db.insert('deploymentRecords', {
      townId: local.townId,
      deploymentInstanceId: local.deploymentInstanceId,
      deploymentEpoch: local.deploymentEpoch,
      mode: 'ACTIVE',
      createdAt: Date.now(),
    });
    return { townId: local.townId, deploymentEpoch: local.deploymentEpoch };
  },
});

// Signed ephemeral keys negotiate a fresh credential, so private peer credentials need not be copied.
async function migrationCredential(
  privateEncrypted: string,
  remotePublic: JsonWebKey,
  transcript: unknown,
) {
  if (
    !remotePublic ||
    remotePublic.kty !== 'EC' ||
    remotePublic.crv !== 'P-256' ||
    remotePublic.d ||
    !boundedString(remotePublic.x) ||
    !boundedString(remotePublic.y)
  )
    throw new Error('INVALID_MIGRATION_EPHEMERAL_KEY');
  const local = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(await openSecret(privateEncrypted)),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const remote = await crypto.subtle.importKey(
    'jwk',
    remotePublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const material = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.deriveBits({ name: 'ECDH', public: remote }, local, 256),
    'HKDF',
    false,
    ['deriveBits'],
  );
  return toBase64(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: fromBase64(await digest(transcript)),
          info: new TextEncoder().encode('ai-town-migration/peer-credential/1'),
        },
        material,
        256,
      ),
    ),
  );
}
export const context = internalQuery({
  args: { peerTownId: v.string() },
  handler: async (ctx, args) => {
    const local = await identity(ctx);
    return {
      local,
      remote: await peer(ctx, args.peerTownId),
      handoff: local?.activeHandoffId ? await record(ctx, local.activeHandoffId) : null,
      exchange: local?.activeHandoffId
        ? await exchange(ctx, local.activeHandoffId, args.peerTownId, 'OUTBOUND')
        : null,
    };
  },
});
export const prepareExchange = internalMutation({
  args: { peerTownId: v.string(), request: v.any(), ephemeralPrivateEncrypted: v.string() },
  handler: async (ctx, args) => {
    const local = await identity(ctx),
      remote = await peer(ctx, args.peerTownId);
    if (
      !local ||
      local.mode !== 'ACTIVE' ||
      !local.activeHandoffId ||
      local.activeHandoffId !== args.request.body.handoff.body.handoffId ||
      !remote ||
      !['MIGRATION_PENDING', 'TRUSTED'].includes(remote.trustState)
    )
      throw new Error('MIGRATION_EXCHANGE_NOT_ALLOWED');
    const old = await exchange(ctx, local.activeHandoffId, remote.townId, 'OUTBOUND');
    if (old) return old;
    const id = await ctx.db.insert('migrationPeerExchanges', {
      handoffId: local.activeHandoffId,
      peerTownId: remote.townId,
      direction: 'OUTBOUND',
      request: args.request,
      ephemeralPrivateEncrypted: args.ephemeralPrivateEncrypted,
      state: 'PENDING',
      createdAt: Date.now(),
    });
    return (await ctx.db.get(id))!;
  },
});
export const receiveExchange = internalAction({
  args: packetArgs,
  handler: async (ctx, { packet }) => {
    const townId = packet?.body?.handoff?.body?.townId;
    if (!boundedString(townId)) throw new Error('INVALID_MIGRATION_EXCHANGE');
    const data = await ctx.runQuery(queryRef('store/context'), { peerTownId: townId });
    if (!data.identity || !data.peer || data.peer.trustState !== 'TRUSTED')
      throw new Error('PEER_NOT_TRUSTED');
    await validateHandoff(packet.body.handoff, data.peer.publicKey);
    if (!(await verifySignature(packet.body, packet.signature, data.peer.publicKey)))
      throw new Error('INVALID_MIGRATION_EXCHANGE');
    // Convex only permits randomized key generation in actions. The transaction
    // below rechecks the complete request and current fencing before committing.
    const keys = await ephemeralKeys();
    return ctx.runMutation(mutationRef('migration/acceptExchange'), {
      packet,
      ephemeralPublicKey: keys.publicKey,
      ephemeralPrivateEncrypted: keys.privateKeyEncrypted,
    });
  },
});
export const acceptExchange = internalMutation({
  args: { ...packetArgs, ephemeralPublicKey: v.any(), ephemeralPrivateEncrypted: v.string() },
  handler: async (ctx, { packet, ephemeralPublicKey, ephemeralPrivateEncrypted }) => {
    const request = packet?.body,
      b = request?.handoff?.body;
    if (
      !request ||
      request.purpose !== 'ai-town-migration-peer-request/1' ||
      !boundedString(request.nonce) ||
      !boundedString(request.credentialId) ||
      !Number.isFinite(request.createdAt) ||
      request.createdAt > Date.now() + 60_000 ||
      !b
    )
      throw new Error('INVALID_MIGRATION_EXCHANGE');
    const local = await identity(ctx),
      remote = await peer(ctx, b.townId);
    if (
      !local ||
      local.mode !== 'ACTIVE' ||
      !local.enabled ||
      !remote ||
      remote.trustState !== 'TRUSTED'
    )
      throw new Error('PEER_NOT_TRUSTED');
    await validateHandoff(request.handoff, remote.publicKey);
    if (
      request.toTownId !== local.townId ||
      request.recipientDeploymentInstanceId !== local.deploymentInstanceId ||
      request.recipientDeploymentEpoch !== local.deploymentEpoch ||
      !(await verifySignature(request, packet.signature, remote.publicKey))
    )
      throw new Error('INVALID_MIGRATION_EXCHANGE');
    const descriptor = b.peers.find((p: PublicPeer) => p.townId === local.townId);
    if (
      !descriptor ||
      descriptor.publicKey !== local.publicKey ||
      descriptor.deploymentInstanceId !== local.deploymentInstanceId ||
      descriptor.deploymentEpoch !== local.deploymentEpoch ||
      descriptor.trustState !== 'TRUSTED'
    )
      throw new Error('MIGRATION_PEER_NOT_AUTHORIZED');
    const old = await exchange(ctx, b.handoffId, local.townId, 'INBOUND');
    if (old) {
      if (
        (await digest(old.request)) !== (await digest(packet)) ||
        remote.verifiedHandoffId !== b.handoffId ||
        remote.deploymentInstanceId !== b.target.deploymentInstanceId ||
        remote.deploymentEpoch !== b.target.deploymentEpoch
      )
        throw new Error('MIGRATION_EXCHANGE_CONFLICT');
      return old.response;
    }
    if (
      remote.deploymentInstanceId !== b.sourceDeploymentInstanceId ||
      remote.deploymentEpoch !== b.sourceDeploymentEpoch ||
      b.target.deploymentEpoch <= remote.deploymentEpoch
    )
      throw new Error('MIGRATION_SOURCE_FENCED');
    // A peer must reconcile visitors from the old instance before accepting its successor.
    const visits = await ctx.db
      .query('visitLedger')
      .filter((q) =>
        q.and(
          q.or(
            q.eq(q.field('homeTownId'), remote.townId),
            q.eq(q.field('hostTownId'), remote.townId),
          ),
          ...TERMINAL.map((s) => q.neq(q.field('state'), s)),
        ),
      )
      .take(21);
    if (visits.length) throw new Error('MIGRATION_PEER_VISITS_NOT_DRAINED');
    const body = {
      purpose: 'ai-town-migration-peer-response/1',
      protocol: PROTOCOL,
      handoffId: b.handoffId,
      fromTownId: local.townId,
      toTownId: remote.townId,
      senderDeploymentInstanceId: local.deploymentInstanceId,
      senderDeploymentEpoch: local.deploymentEpoch,
      targetDeploymentInstanceId: b.target.deploymentInstanceId,
      targetDeploymentEpoch: b.target.deploymentEpoch,
      credentialId: request.credentialId,
      nonce: request.nonce,
      requestDigest: await digest(packet),
      ephemeralPublicKey,
    };
    const response = { body, signature: await sign(body, local.privateKeyEncrypted) };
    const credentialEncrypted = await sealSecret(
      await migrationCredential(ephemeralPrivateEncrypted, request.ephemeralPublicKey, {
        request: packet,
        response,
      }),
    );
    await ctx.db.patch(remote._id, {
      deploymentInstanceId: b.target.deploymentInstanceId,
      deploymentEpoch: b.target.deploymentEpoch,
      endpoint: b.target.endpoint,
      credentialId: request.credentialId,
      credentialEncrypted,
      verifiedHandoffId: b.handoffId,
    });
    const updated = (await ctx.db.get(remote._id))!;
    await resetSession(ctx, local, updated);
    const previous = await record(ctx, b.handoffId);
    if (previous && (await digest(previous.body)) !== (await digest(b)))
      throw new Error('MIGRATION_HANDOFF_CONFLICT');
    if (!previous)
      await ctx.db.insert('migrationHandoffRecords', {
        handoffId: b.handoffId,
        townId: b.townId,
        ...request.handoff,
        role: 'PEER',
        acceptedAt: Date.now(),
      });
    await ctx.db.insert('migrationPeerExchanges', {
      handoffId: b.handoffId,
      peerTownId: local.townId,
      direction: 'INBOUND',
      request: packet,
      response,
      state: 'ACCEPTED',
      createdAt: Date.now(),
    });
    // The target may not have received this response yet; periodic probing will retry safely.
    await ctx.scheduler.runAfter(500, actionRef('transport/probeInternal'), {
      peerTownId: remote.townId,
    });
    return response;
  },
});
export const finishExchange = internalMutation({
  args: {
    peerTownId: v.string(),
    response: v.any(),
    credentialEncrypted: v.string(),
    requestDigest: v.string(),
  },
  handler: async (ctx, args) => {
    const local = await identity(ctx),
      remote = await peer(ctx, args.peerTownId);
    if (
      !local ||
      local.mode !== 'ACTIVE' ||
      !local.activeHandoffId ||
      !remote ||
      !['MIGRATION_PENDING', 'TRUSTED'].includes(remote.trustState)
    )
      throw new Error('MIGRATION_EXCHANGE_NOT_ALLOWED');
    const e = await exchange(ctx, local.activeHandoffId, remote.townId, 'OUTBOUND');
    if (
      !e ||
      (await digest(e.request)) !== args.requestDigest ||
      args.response.body.requestDigest !== args.requestDigest ||
      args.response.body.senderDeploymentEpoch !== remote.deploymentEpoch ||
      args.response.body.senderDeploymentInstanceId !== remote.deploymentInstanceId ||
      !(await verifySignature(args.response.body, args.response.signature, remote.publicKey))
    )
      throw new Error('MIGRATION_EXCHANGE_CONFLICT');
    if (e.state === 'ACCEPTED') return;
    await ctx.db.patch(remote._id, {
      credentialId: e.request.body.credentialId,
      credentialEncrypted: args.credentialEncrypted,
      trustState: 'TRUSTED',
      verifiedHandoffId: local.activeHandoffId,
    });
    await ctx.db.patch(e._id, {
      response: args.response,
      state: 'ACCEPTED',
      ephemeralPrivateEncrypted: undefined,
    });
    await resetSession(ctx, local, (await ctx.db.get(remote._id))!);
  },
});
export const notifyPeer = action({
  args: { adminToken: v.string(), peerTownId: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const data = await ctx.runQuery(queryRef('migration/context'), { peerTownId: args.peerTownId });
    const { local, remote, handoff } = data;
    if (
      !local ||
      local.mode !== 'ACTIVE' ||
      !remote ||
      !handoff ||
      handoff.body.target.deploymentInstanceId !== local.deploymentInstanceId ||
      !['MIGRATION_PENDING', 'TRUSTED'].includes(remote.trustState)
    )
      throw new Error('MIGRATION_EXCHANGE_NOT_ALLOWED');
    let e = data.exchange;
    if (!e) {
      const keys = await ephemeralKeys();
      const body = {
        purpose: 'ai-town-migration-peer-request/1',
        toTownId: remote.townId,
        recipientDeploymentInstanceId: remote.deploymentInstanceId,
        recipientDeploymentEpoch: remote.deploymentEpoch,
        handoff: { body: handoff.body, signature: handoff.signature },
        credentialId: `migration:${crypto.randomUUID()}`,
        ephemeralPublicKey: keys.publicKey,
        nonce: crypto.randomUUID(),
        createdAt: Date.now(),
      };
      e = await ctx.runMutation(mutationRef('migration/prepareExchange'), {
        peerTownId: remote.townId,
        request: { body, signature: await sign(body, local.privateKeyEncrypted) },
        ephemeralPrivateEncrypted: keys.privateKeyEncrypted,
      });
    }
    if (e.state !== 'ACCEPTED') {
      const response = await directRequest(remote.endpoint, '/migration', e.request),
        b = response?.body;
      if (
        !b ||
        b.purpose !== 'ai-town-migration-peer-response/1' ||
        b.protocol !== PROTOCOL ||
        b.handoffId !== local.activeHandoffId ||
        b.fromTownId !== remote.townId ||
        b.toTownId !== local.townId ||
        b.senderDeploymentInstanceId !== remote.deploymentInstanceId ||
        b.senderDeploymentEpoch !== remote.deploymentEpoch ||
        b.targetDeploymentInstanceId !== local.deploymentInstanceId ||
        b.targetDeploymentEpoch !== local.deploymentEpoch ||
        b.credentialId !== e.request.body.credentialId ||
        b.nonce !== e.request.body.nonce ||
        b.requestDigest !== (await digest(e.request)) ||
        !(await verifySignature(b, response.signature, remote.publicKey)) ||
        !e.ephemeralPrivateEncrypted
      )
        throw new Error('INVALID_MIGRATION_RESPONSE');
      const credentialEncrypted = await sealSecret(
        await migrationCredential(e.ephemeralPrivateEncrypted, b.ephemeralPublicKey, {
          request: e.request,
          response,
        }),
      );
      await ctx.runMutation(mutationRef('migration/finishExchange'), {
        peerTownId: remote.townId,
        response,
        credentialEncrypted,
        requestDigest: await digest(e.request),
      });
    }
    return ctx.runAction(actionRef('transport/probeInternal'), { peerTownId: remote.townId });
  },
});
export const history = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    return ctx.db.query('migrationHandoffRecords').order('desc').take(50);
  },
});
export function registerMigrationRoutes(http: HttpRouter) {
  http.route({
    path: '/federation/v1/migration',
    method: 'POST',
    handler: httpAction(async (ctx, request) => {
      try {
        const response = await ctx.runAction(actionRef('migration/receiveExchange'), {
          packet: await readRequest(request),
        });
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'FEDERATION_REJECTED';
        return new Response(
          JSON.stringify({
            error: /^[A-Z][A-Z0-9_]+$/.test(reason) ? reason : 'FEDERATION_REJECTED',
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
