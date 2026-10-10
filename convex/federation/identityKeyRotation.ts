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
  MutationCtx,
} from '../maintenanceFunctions';
import { Doc } from '../_generated/dataModel';
import { identity, peer } from './store';
import { assertNoIdentityConflict } from './identityConflict';
import { directRequest, readRequest } from './direct';
import { actionRef, mutationRef, queryRef } from './refs';
import {
  createIdentityKeys,
  digest,
  requireAdmin,
  sign,
  signPacket,
  verifyPacket,
  verifySignature,
} from './security';
import { PROTOCOL } from './protocol';
import {
  IDENTITY_KEY_PURPOSE,
  IdentityKeyCertificate,
  IdentityKeyDeclaration,
  validateKeyActivation,
  validateKeyCertificate,
  verifiedIdentityKeySuccessor,
} from './identityKeyRotationProof';

type Rotation = Doc<'federationIdentityKeyRotations'>;
type Exchange = Doc<'federationIdentityKeyExchanges'>;
const details = { operator: v.string(), reason: v.string() };
const rotationFor = (ctx: MutationCtx, rotationId: string) =>
  ctx.db
    .query('federationIdentityKeyRotations')
    .withIndex('rotation', (q) => q.eq('rotationId', rotationId))
    .unique();
const exchangeFor = (ctx: MutationCtx, peerTownId: string, direction: string, rotationId: string) =>
  ctx.db
    .query('federationIdentityKeyExchanges')
    .withIndex('exchange', (q) =>
      q.eq('peerTownId', peerTownId).eq('direction', direction).eq('rotationId', rotationId),
    )
    .unique();
const outboundFor = (ctx: MutationCtx, rotationId: string) =>
  ctx.db
    .query('federationIdentityKeyExchanges')
    .withIndex('rotation_direction', (q) =>
      q.eq('rotationId', rotationId).eq('direction', 'OUTBOUND'),
    )
    .collect();
function validateDetails(operator: string, reason: string) {
  if (!operator.trim() || operator.length > 100 || !reason.trim() || reason.length > 1000)
    throw new Error('IDENTITY_KEY_REVIEW_DETAILS_REQUIRED');
}
export async function assertIdentityKeyRotationIdle(ctx: MutationCtx) {
  if (
    await ctx.db
      .query('federationIdentityKeyRotations')
      .withIndex('state_expiry', (q) => q.eq('state', 'PREPARING'))
      .first()
  )
    throw new Error('IDENTITY_KEY_ROTATION_IN_PROGRESS');
  const exchanges = await ctx.db.query('federationIdentityKeyExchanges').collect();
  if (
    exchanges.some(
      (r) =>
        (r.direction === 'OUTBOUND' && ['PENDING_COMMIT', 'RUNNING_COMMIT'].includes(r.state)) ||
        (r.direction === 'INBOUND' &&
          ['PREPARED', 'CHALLENGING'].includes(r.state) &&
          r.expiresAt > Date.now()),
    )
  )
    throw new Error('IDENTITY_KEY_ROTATION_IN_PROGRESS');
}
async function assertCredentialsIdle(ctx: MutationCtx) {
  const rows = await ctx.db.query('federationCredentialRotations').collect();
  if (rows.some((r) => ['PENDING', 'COMMITTED'].includes(r.state) && r.overlapUntil > Date.now()))
    throw new Error('CREDENTIAL_ROTATION_IN_PROGRESS');
}
function controlBody(
  local: Doc<'federationIdentity'>,
  remote: Doc<'federationPeers'>,
  type: string,
) {
  return {
    protocol: PROTOCOL,
    type,
    fromTownId: local.townId,
    toTownId: remote.townId,
    senderDeploymentInstanceId: local.deploymentInstanceId,
    senderDeploymentEpoch: local.deploymentEpoch,
    recipientDeploymentInstanceId: remote.deploymentInstanceId,
    expectedRecipientDeploymentEpoch: remote.deploymentEpoch,
    credentialId: remote.credentialId,
    nonce: crypto.randomUUID(),
    sentAt: Date.now(),
    expiresAt: Date.now() + 30_000,
  };
}
function validateControl(b: any, local: Doc<'federationIdentity'>, remote: Doc<'federationPeers'>) {
  if (
    !b ||
    b.protocol !== PROTOCOL ||
    b.fromTownId !== remote.townId ||
    b.toTownId !== local.townId ||
    b.senderDeploymentInstanceId !== remote.deploymentInstanceId ||
    b.senderDeploymentEpoch !== remote.deploymentEpoch ||
    b.recipientDeploymentInstanceId !== local.deploymentInstanceId ||
    b.expectedRecipientDeploymentEpoch !== local.deploymentEpoch ||
    b.credentialId !== remote.credentialId ||
    typeof b.nonce !== 'string' ||
    !b.nonce ||
    b.nonce.length > 200 ||
    !Number.isSafeInteger(b.sentAt) ||
    b.sentAt < 0 ||
    b.sentAt > Date.now() + 30_000 ||
    !Number.isSafeInteger(b.expiresAt) ||
    b.expiresAt <= Date.now() ||
    b.expiresAt > Date.now() + 60_000 ||
    b.sentAt >= b.expiresAt
  )
    throw new Error('IDENTITY_KEY_ROTATION_FENCED');
}
async function activePeer(ctx: MutationCtx, townId: string) {
  const local = await identity(ctx),
    remote = await peer(ctx, townId);
  if (!local?.enabled || local.mode !== 'ACTIVE' || remote?.trustState !== 'TRUSTED')
    throw new Error('PEER_NOT_TRUSTED');
  await assertNoIdentityConflict(ctx);
  return { local, remote };
}
function assertPeerSnapshot(row: Exchange, remote: Doc<'federationPeers'>) {
  if (
    !remote ||
    remote.trustState !== 'TRUSTED' ||
    row.peerPublicKey !== remote.publicKey ||
    row.peerIdentityVersion !== (remote.identityVersion ?? 1) ||
    row.credentialId !== remote.credentialId ||
    row.peerDeploymentInstanceId !== remote.deploymentInstanceId ||
    row.peerDeploymentEpoch !== remote.deploymentEpoch
  )
    throw new Error('IDENTITY_KEY_ROTATION_FENCED');
}
async function resetSessions(ctx: MutationCtx, peerTownId?: string) {
  const rows = await ctx.db.query('transportSessions').collect();
  for (const row of rows.filter((r) => !peerTownId || r.peerTownId === peerTownId))
    await ctx.db.patch(row._id, {
      channelState: 'TRANSPORT_TESTING',
      inboundVerifiedAt: undefined,
      outboundVerifiedAt: undefined,
      lastReadyAt: undefined,
    });
}
async function saveHistory(
  ctx: MutationCtx,
  certificate: IdentityKeyCertificate,
  activation: any,
  role: string,
) {
  const b = await validateKeyActivation(certificate, activation);
  const old = await ctx.db
    .query('federationIdentityKeyHistory')
    .withIndex('rotation', (q) => q.eq('townId', b.townId).eq('rotationId', b.rotationId))
    .unique();
  if (old) {
    if (
      !old.verified ||
      (await digest(old.certificate)) !== (await digest(certificate)) ||
      (await digest(old.activation)) !== (await digest(activation))
    )
      throw new Error('IDENTITY_KEY_HISTORY_CONFLICT');
    return;
  }
  await ctx.db.insert('federationIdentityKeyHistory', {
    rotationId: b.rotationId,
    townId: b.townId,
    oldVersion: b.oldVersion,
    newVersion: b.newVersion,
    oldPublicKey: b.oldPublicKey,
    newPublicKey: b.newPublicKey,
    kind: 'SIGNED',
    role,
    certificate,
    activation,
    verified: true,
    acceptedAt: Date.now(),
    operator: b.operator,
    reason: b.reason,
  });
}
async function activateIfReady(ctx: MutationCtx, row: Rotation) {
  if (row.state !== 'PREPARING' || row.expiresAt <= Date.now()) return;
  const exchanges = await outboundFor(ctx, row.rotationId);
  if (exchanges.some((r) => r.state !== 'PREPARED')) return;
  const local = await identity(ctx),
    b = await validateKeyCertificate(row.certificate);
  if (
    !local?.enabled ||
    local.mode !== 'ACTIVE' ||
    local.townId !== b.townId ||
    local.publicKey !== b.oldPublicKey ||
    (local.identityVersion ?? 1) !== b.oldVersion ||
    local.deploymentInstanceId !== b.deploymentInstanceId ||
    local.deploymentEpoch !== b.deploymentEpoch ||
    !row.newPrivateEncrypted
  )
    throw new Error('IDENTITY_KEY_ROTATION_FENCED');
  await assertNoIdentityConflict(ctx);
  for (const exchange of exchanges)
    assertPeerSnapshot(exchange, (await peer(ctx, exchange.peerTownId))!);
  const body = {
    purpose: 'ai-town-identity-key-activation/1',
    rotationId: row.rotationId,
    certificateDigest: await digest(row.certificate),
    activatedAt: Date.now(),
  };
  const activation = {
    body,
    oldSignature: await sign(body, local.privateKeyEncrypted),
    newSignature: await sign(body, row.newPrivateEncrypted),
  };
  await saveHistory(ctx, row.certificate, activation, 'LOCAL');
  // No previous identity private key is retained. Its only remaining signatures
  // are immutable public certificates; ordinary traffic uses the new key now.
  await ctx.db.patch(local._id, {
    publicKey: b.newPublicKey,
    fingerprint: `sha256:${await digest(b.newPublicKey)}`,
    privateKeyEncrypted: row.newPrivateEncrypted,
    identityVersion: b.newVersion,
  });
  await ctx.db.patch(row._id, { state: 'COMMITTED', activation, newPrivateEncrypted: undefined });
  for (const exchange of exchanges)
    await ctx.db.patch(exchange._id, {
      state: 'PENDING_COMMIT',
      activation,
      packet: undefined,
      response: undefined,
      nextRetryAt: Date.now(),
    });
  await resetSessions(ctx);
  await ctx.scheduler.runAfter(0, actionRef('identityKeyRotation/distribute'), {
    rotationId: row.rotationId,
  });
}

export const start = action({
  args: { adminToken: v.string(), ...details, prepareTimeoutMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    validateDetails(args.operator, args.reason);
    const timeout = args.prepareTimeoutMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(timeout) || timeout < 60_000 || timeout > 30 * 60_000)
      throw new Error('INVALID_IDENTITY_KEY_PREPARE_TIMEOUT');
    const keys = await createIdentityKeys();
    const rotationId = await ctx.runMutation(mutationRef('identityKeyRotation/prepare'), {
      ...keys,
      operator: args.operator.trim(),
      reason: args.reason.trim(),
      prepareTimeoutMs: timeout,
    });
    await ctx.runAction(actionRef('identityKeyRotation/distribute'), { rotationId });
    return { rotationId };
  },
});
export const prepare = internalMutation({
  args: {
    publicKey: v.string(),
    privateKeyEncrypted: v.string(),
    fingerprint: v.string(),
    ...details,
    prepareTimeoutMs: v.number(),
  },
  handler: async (ctx, args) => {
    validateDetails(args.operator, args.reason);
    await assertIdentityKeyRotationIdle(ctx);
    await assertCredentialsIdle(ctx);
    await assertNoIdentityConflict(ctx);
    const local = await identity(ctx);
    if (!local?.enabled || local.mode !== 'ACTIVE') throw new Error('DEPLOYMENT_NOT_ACTIVE');
    const body: IdentityKeyDeclaration = {
      purpose: IDENTITY_KEY_PURPOSE,
      rotationId: crypto.randomUUID(),
      townId: local.townId,
      oldPublicKey: local.publicKey,
      newPublicKey: args.publicKey,
      oldVersion: local.identityVersion ?? 1,
      newVersion: (local.identityVersion ?? 1) + 1,
      deploymentInstanceId: local.deploymentInstanceId,
      deploymentEpoch: local.deploymentEpoch,
      issuedAt: Date.now(),
      activateBy: Date.now() + args.prepareTimeoutMs,
      operator: args.operator,
      reason: args.reason,
    };
    const certificate = {
      body,
      oldSignature: await sign(body, local.privateKeyEncrypted),
      newSignature: await sign(body, args.privateKeyEncrypted),
    };
    await validateKeyCertificate(certificate);
    const id = await ctx.db.insert('federationIdentityKeyRotations', {
      rotationId: body.rotationId,
      certificate,
      newPrivateEncrypted: args.privateKeyEncrypted,
      state: 'PREPARING',
      expiresAt: body.activateBy,
      operator: args.operator,
      reason: args.reason,
      createdAt: Date.now(),
    });
    for (const remote of (await ctx.db.query('federationPeers').collect()).filter(
      (r) => r.trustState === 'TRUSTED',
    ))
      await ctx.db.insert('federationIdentityKeyExchanges', {
        rotationId: body.rotationId,
        peerTownId: remote.townId,
        direction: 'OUTBOUND',
        state: 'PENDING_PREPARE',
        peerPublicKey: remote.publicKey,
        peerIdentityVersion: remote.identityVersion ?? 1,
        credentialId: remote.credentialId,
        peerDeploymentInstanceId: remote.deploymentInstanceId,
        peerDeploymentEpoch: remote.deploymentEpoch,
        localPublicKey: local.publicKey,
        certificate,
        expiresAt: body.activateBy,
        createdAt: Date.now(),
        attempts: 0,
        nextRetryAt: Date.now(),
      });
    await activateIfReady(ctx, (await ctx.db.get(id))!);
    await ctx.scheduler.runAfter(0, actionRef('identityKeyRotation/distribute'), {
      rotationId: body.rotationId,
    });
    return body.rotationId;
  },
});
export const claimDelivery = internalMutation({
  args: { rotationId: v.string(), peerTownId: v.string() },
  handler: async (ctx, args) => {
    const row = await rotationFor(ctx, args.rotationId),
      exchange = await exchangeFor(ctx, args.peerTownId, 'OUTBOUND', args.rotationId);
    if (
      !row ||
      !exchange ||
      !['PENDING_PREPARE', 'PENDING_COMMIT', 'RUNNING_PREPARE', 'RUNNING_COMMIT'].includes(
        exchange.state,
      ) ||
      (exchange.state.startsWith('RUNNING') && exchange.nextRetryAt > Date.now())
    )
      return null;
    const phase = row.state === 'COMMITTED' ? 'COMMIT' : 'PREPARE';
    if (phase === 'PREPARE' && (row.state !== 'PREPARING' || row.expiresAt <= Date.now()))
      return null;
    const { local, remote } = await activePeer(ctx, exchange.peerTownId);
    assertPeerSnapshot(exchange, remote);
    const c = row.certificate.body;
    if (
      local.townId !== c.townId ||
      local.publicKey !== (phase === 'COMMIT' ? c.newPublicKey : c.oldPublicKey) ||
      local.deploymentEpoch !== c.deploymentEpoch ||
      local.deploymentInstanceId !== c.deploymentInstanceId
    )
      throw new Error('IDENTITY_KEY_ROTATION_FENCED');
    const packet = await signPacket(
      {
        ...controlBody(local, remote, 'IDENTITY_KEY_OFFER'),
        phase,
        rotationId: row.rotationId,
        certificate: row.certificate,
        ...(phase === 'COMMIT' ? { activation: row.activation } : {}),
      },
      local.privateKeyEncrypted,
      remote.credentialEncrypted,
    );
    await ctx.db.patch(exchange._id, {
      state: `RUNNING_${phase}`,
      packet,
      attempts: exchange.attempts + 1,
      nextRetryAt: Date.now() + 60_000,
    });
    return {
      endpoint: remote.endpoint,
      packet,
      peerPublicKey: remote.publicKey,
      credentialEncrypted: remote.credentialEncrypted,
    };
  },
});
export const deliver = internalAction({
  args: { rotationId: v.string(), peerTownId: v.string() },
  handler: async (ctx, args) => {
    let packetDigest: string | undefined;
    try {
      const prepared = await ctx.runMutation(
        mutationRef('identityKeyRotation/claimDelivery'),
        args,
      );
      if (!prepared) return;
      packetDigest = await digest(prepared.packet.body);
      const response = await directRequest(prepared.endpoint, '/peers/identity-key', {
        operation: 'offer',
        packet: prepared.packet,
      });
      await ctx.runMutation(mutationRef('identityKeyRotation/acceptAck'), {
        ...args,
        response,
        packetDigest,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'IDENTITY_KEY_DELIVERY_FAILED';
      await ctx.runMutation(mutationRef('identityKeyRotation/deliveryFailed'), {
        ...args,
        ...(packetDigest ? { packetDigest } : {}),
        error: /^[A-Z][A-Z0-9_]+$/.test(message) ? message : 'IDENTITY_KEY_DELIVERY_FAILED',
      });
    }
  },
});
export const acceptAck = internalMutation({
  args: {
    rotationId: v.string(),
    peerTownId: v.string(),
    packetDigest: v.string(),
    response: v.any(),
  },
  handler: async (ctx, args) => {
    const row = await rotationFor(ctx, args.rotationId),
      exchange = await exchangeFor(ctx, args.peerTownId, 'OUTBOUND', args.rotationId);
    if (
      !row ||
      !exchange ||
      !exchange.state.startsWith('RUNNING') ||
      !exchange.packet ||
      (await digest(exchange.packet.body)) !== args.packetDigest
    )
      throw new Error('IDENTITY_KEY_ROTATION_FENCED');
    const { local, remote } = await activePeer(ctx, args.peerTownId);
    assertPeerSnapshot(exchange, remote);
    const b = args.response?.body,
      request = exchange.packet.body;
    validateControl(b, local, remote);
    if (
      !(await verifyPacket(args.response, remote.publicKey, remote.credentialEncrypted)) ||
      b.type !== 'IDENTITY_KEY_ACK' ||
      b.phase !== request.phase ||
      b.rotationId !== row.rotationId ||
      b.requestDigest !== args.packetDigest ||
      b.certificateDigest !== (await digest(row.certificate)) ||
      b.requestNonce !== request.nonce ||
      b.status !== (request.phase === 'COMMIT' ? 'COMMITTED' : 'PREPARED')
    )
      throw new Error('INVALID_IDENTITY_KEY_ACK');
    await ctx.db.patch(exchange._id, {
      state: request.phase === 'COMMIT' ? 'ACKED' : 'PREPARED',
      response: args.response,
      lastError: undefined,
    });
    await activateIfReady(ctx, row);
  },
});
export const deliveryFailed = internalMutation({
  args: {
    rotationId: v.string(),
    peerTownId: v.string(),
    error: v.string(),
    packetDigest: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await exchangeFor(ctx, args.peerTownId, 'OUTBOUND', args.rotationId);
    if (
      !row ||
      !['PENDING_PREPARE', 'PENDING_COMMIT', 'RUNNING_PREPARE', 'RUNNING_COMMIT'].includes(
        row.state,
      ) ||
      (args.packetDigest && (await digest(row.packet?.body)) !== args.packetDigest)
    )
      return;
    const state = row.state.endsWith('COMMIT') ? 'PENDING_COMMIT' : 'PENDING_PREPARE';
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
    await ctx.db.patch(row._id, { state, lastError: args.error, nextRetryAt: Date.now() + delay });
    await ctx.scheduler.runAfter(delay, actionRef('identityKeyRotation/deliver'), {
      rotationId: args.rotationId,
      peerTownId: args.peerTownId,
    });
  },
});
export const deliveryRows = internalQuery({
  args: { rotationId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('federationIdentityKeyExchanges')
      .withIndex('rotation_direction', (q) =>
        q.eq('rotationId', args.rotationId).eq('direction', 'OUTBOUND'),
      )
      .collect();
    return rows
      .filter((r) =>
        ['PENDING_PREPARE', 'PENDING_COMMIT', 'RUNNING_PREPARE', 'RUNNING_COMMIT'].includes(
          r.state,
        ),
      )
      .map((r) => ({ rotationId: r.rotationId, peerTownId: r.peerTownId }));
  },
});
export const distribute = internalAction({
  args: { rotationId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.runQuery(queryRef('identityKeyRotation/deliveryRows'), args);
    for (let i = 0; i < rows.length; i += 4)
      await Promise.all(
        rows
          .slice(i, i + 4)
          .map((row: any) => ctx.runAction(actionRef('identityKeyRotation/deliver'), row)),
      );
    const activated = await ctx.runQuery(queryRef('identityKeyRotation/operationState'), args);
    if (activated === 'COMMITTED') {
      const commits = await ctx.runQuery(queryRef('identityKeyRotation/deliveryRows'), args);
      for (let i = 0; i < commits.length; i += 4)
        await Promise.all(
          commits
            .slice(i, i + 4)
            .map((row: any) => ctx.runAction(actionRef('identityKeyRotation/deliver'), row)),
        );
    }
  },
});
export const operationState = internalQuery({
  args: { rotationId: v.string() },
  handler: async (ctx, args) =>
    (
      await ctx.db
        .query('federationIdentityKeyRotations')
        .withIndex('rotation', (q) => q.eq('rotationId', args.rotationId))
        .unique()
    )?.state ?? null,
});
export const historicalKeyAccepted = internalQuery({
  args: { townId: v.string(), oldPublicKey: v.string(), currentPublicKey: v.string() },
  handler: async (ctx, args) =>
    verifiedIdentityKeySuccessor(ctx, args.townId, args.oldPublicKey, args.currentPublicKey),
});

export const stageInbound = internalMutation({
  args: { packet: v.any() },
  handler: async (ctx, args) => {
    const p = args.packet,
      b = p?.body,
      c = await validateKeyCertificate(b?.certificate);
    const { local, remote } = await activePeer(ctx, b?.fromTownId);
    validateControl(b, local, remote);
    if (
      b.type !== 'IDENTITY_KEY_OFFER' ||
      b.rotationId !== c.rotationId ||
      !['PREPARE', 'COMMIT'].includes(b.phase) ||
      c.townId !== remote.townId ||
      c.deploymentInstanceId !== remote.deploymentInstanceId ||
      c.deploymentEpoch !== remote.deploymentEpoch
    )
      throw new Error('IDENTITY_KEY_ROTATION_FENCED');
    if (b.phase === 'PREPARE') {
      if (
        c.activateBy <= Date.now() ||
        remote.publicKey !== c.oldPublicKey ||
        (remote.identityVersion ?? 1) !== c.oldVersion
      )
        throw new Error('IDENTITY_KEY_ROTATION_FENCED');
      if (
        await ctx.db
          .query('federationIdentityKeyRotations')
          .withIndex('state_expiry', (q) => q.eq('state', 'PREPARING'))
          .first()
      )
        throw new Error('IDENTITY_KEY_ROTATION_COLLISION');
      await assertCredentialsIdle(ctx);
    } else {
      await validateKeyActivation(b.certificate, b.activation);
      if (
        (remote.publicKey !== c.oldPublicKey && remote.publicKey !== c.newPublicKey) ||
        (remote.identityVersion ?? 1) !==
          (remote.publicKey === c.oldPublicKey ? c.oldVersion : c.newVersion)
      )
        throw new Error('IDENTITY_KEY_ROTATION_FENCED');
      if (remote.publicKey === c.newPublicKey) {
        const accepted = await ctx.db
          .query('federationIdentityKeyHistory')
          .withIndex('rotation', (q) =>
            q.eq('townId', remote.townId).eq('rotationId', c.rotationId),
          )
          .unique();
        if (
          !accepted?.verified ||
          (await digest(accepted.certificate)) !== (await digest(b.certificate)) ||
          (await digest(accepted.activation)) !== (await digest(b.activation))
        )
          throw new Error('IDENTITY_KEY_HISTORY_CONFLICT');
      }
    }
    if (
      !(await verifyPacket(
        p,
        b.phase === 'PREPARE' ? c.oldPublicKey : c.newPublicKey,
        remote.credentialEncrypted,
      ))
    )
      throw new Error('IDENTITY_KEY_AUTH_FAILED');
    const old = await exchangeFor(ctx, remote.townId, 'INBOUND', c.rotationId),
      requestDigest = await digest(b);
    if (old && (await digest(old.certificate)) !== (await digest(b.certificate)))
      throw new Error('IDENTITY_KEY_HISTORY_CONFLICT');
    if (
      old?.response &&
      old.packet &&
      (await digest(old.packet.body)) === requestDigest &&
      ['PREPARED', 'ACKED'].includes(old.state)
    )
      return { response: old.response };
    const challenge = await signPacket(
      {
        ...controlBody(local, remote, 'IDENTITY_KEY_CHALLENGE'),
        rotationId: c.rotationId,
        phase: b.phase,
        offerDigest: requestDigest,
        publicKey: c.newPublicKey,
        certificateDigest: await digest(b.certificate),
      },
      local.privateKeyEncrypted,
      remote.credentialEncrypted,
    );
    const fields = {
      rotationId: c.rotationId,
      peerTownId: remote.townId,
      direction: 'INBOUND',
      state: 'CHALLENGING',
      peerPublicKey: remote.publicKey,
      peerIdentityVersion: remote.identityVersion ?? 1,
      credentialId: remote.credentialId,
      peerDeploymentInstanceId: remote.deploymentInstanceId,
      peerDeploymentEpoch: remote.deploymentEpoch,
      localPublicKey: local.publicKey,
      certificate: b.certificate,
      ...(b.activation ? { activation: b.activation } : {}),
      packet: p,
      challenge,
      response: undefined,
      proof: undefined,
      expiresAt: b.phase === 'PREPARE' ? c.activateBy : b.expiresAt,
      createdAt: old?.createdAt ?? Date.now(),
      attempts: (old?.attempts ?? 0) + 1,
      nextRetryAt: 0,
    };
    if (old) await ctx.db.patch(old._id, fields);
    else await ctx.db.insert('federationIdentityKeyExchanges', fields);
    return { endpoint: remote.endpoint, challenge };
  },
});
export const receiveOffer = internalAction({
  args: { packet: v.any() },
  handler: async (ctx, args) => {
    const staged = await ctx.runMutation(mutationRef('identityKeyRotation/stageInbound'), args);
    if (staged.response) return staged.response;
    const proof = await directRequest(staged.endpoint, '/peers/identity-key', {
      operation: 'challenge',
      packet: staged.challenge,
    });
    return ctx.runMutation(mutationRef('identityKeyRotation/finishInbound'), {
      ...args,
      challenge: staged.challenge,
      proof,
    });
  },
});
export const challengeProof = internalMutation({
  args: { packet: v.any() },
  handler: async (ctx, args) => {
    const p = args.packet,
      b = p?.body,
      { local, remote } = await activePeer(ctx, b?.fromTownId);
    validateControl(b, local, remote);
    if (
      b.type !== 'IDENTITY_KEY_CHALLENGE' ||
      !(await verifyPacket(p, remote.publicKey, remote.credentialEncrypted))
    )
      throw new Error('IDENTITY_KEY_AUTH_FAILED');
    const row = await rotationFor(ctx, b.rotationId),
      exchange = await exchangeFor(ctx, remote.townId, 'OUTBOUND', b.rotationId);
    if (
      !row ||
      !exchange?.packet ||
      b.offerDigest !== (await digest(exchange.packet.body)) ||
      b.phase !== exchange.packet.body.phase ||
      b.certificateDigest !== (await digest(row.certificate)) ||
      b.publicKey !== row.certificate.body.newPublicKey ||
      (b.phase === 'PREPARE'
        ? row.state !== 'PREPARING' || row.expiresAt <= Date.now()
        : row.state !== 'COMMITTED')
    )
      throw new Error('IDENTITY_KEY_CHALLENGE_FENCED');
    assertPeerSnapshot(exchange, remote);
    const encrypted = b.phase === 'PREPARE' ? row.newPrivateEncrypted : local.privateKeyEncrypted;
    if (
      !encrypted ||
      local.publicKey !==
        (b.phase === 'PREPARE'
          ? row.certificate.body.oldPublicKey
          : row.certificate.body.newPublicKey)
    )
      throw new Error('IDENTITY_KEY_CHALLENGE_FENCED');
    return signPacket(
      {
        ...controlBody(local, remote, 'IDENTITY_KEY_PROOF'),
        rotationId: b.rotationId,
        phase: b.phase,
        offerDigest: b.offerDigest,
        certificateDigest: b.certificateDigest,
        publicKey: b.publicKey,
        challengeNonce: b.nonce,
        challengeDigest: await digest(b),
      },
      encrypted,
      remote.credentialEncrypted,
    );
  },
});
export const respondChallenge = internalAction({
  args: { packet: v.any() },
  handler: async (ctx, args) =>
    ctx.runMutation(mutationRef('identityKeyRotation/challengeProof'), args),
});
export const finishInbound = internalMutation({
  args: { packet: v.any(), challenge: v.any(), proof: v.any() },
  handler: async (ctx, args) => {
    const b = args.packet?.body,
      c = await validateKeyCertificate(b?.certificate),
      { local, remote } = await activePeer(ctx, b.fromTownId);
    validateControl(b, local, remote);
    const row = await exchangeFor(ctx, remote.townId, 'INBOUND', c.rotationId);
    if (
      !row ||
      row.state !== 'CHALLENGING' ||
      row.localPublicKey !== local.publicKey ||
      (await digest(row.packet)) !== (await digest(args.packet)) ||
      (await digest(row.challenge)) !== (await digest(args.challenge))
    )
      throw new Error('IDENTITY_KEY_ROTATION_FENCED');
    assertPeerSnapshot(row, remote);
    const challenge = args.challenge?.body,
      proof = args.proof?.body;
    validateControl(proof, local, remote);
    if (
      challenge.expiresAt <= Date.now() ||
      !(await verifyPacket(args.challenge, local.publicKey, remote.credentialEncrypted)) ||
      !(await verifyPacket(args.proof, c.newPublicKey, remote.credentialEncrypted)) ||
      proof.type !== 'IDENTITY_KEY_PROOF' ||
      proof.rotationId !== c.rotationId ||
      proof.phase !== b.phase ||
      proof.offerDigest !== (await digest(b)) ||
      proof.certificateDigest !== (await digest(b.certificate)) ||
      proof.publicKey !== c.newPublicKey ||
      proof.challengeNonce !== challenge.nonce ||
      proof.challengeDigest !== (await digest(challenge))
    )
      throw new Error('IDENTITY_KEY_CHALLENGE_FAILED');
    if (b.phase === 'COMMIT') {
      await validateKeyActivation(b.certificate, b.activation);
      await saveHistory(ctx, b.certificate, b.activation, 'PEER');
      await ctx.db.patch(remote._id, {
        publicKey: c.newPublicKey,
        fingerprint: `sha256:${await digest(c.newPublicKey)}`,
        identityVersion: c.newVersion,
      });
      await resetSessions(ctx, remote.townId);
      await ctx.scheduler.runAfter(0, actionRef('transport/probeInternal'), {
        peerTownId: remote.townId,
      });
    } else if (c.activateBy <= Date.now()) throw new Error('IDENTITY_KEY_ROTATION_EXPIRED');
    const response = await signPacket(
      {
        ...controlBody(local, remote, 'IDENTITY_KEY_ACK'),
        rotationId: c.rotationId,
        phase: b.phase,
        status: b.phase === 'COMMIT' ? 'COMMITTED' : 'PREPARED',
        certificateDigest: await digest(b.certificate),
        requestDigest: await digest(b),
        requestNonce: b.nonce,
      },
      local.privateKeyEncrypted,
      remote.credentialEncrypted,
    );
    await ctx.db.patch(row._id, {
      state: b.phase === 'COMMIT' ? 'ACKED' : 'PREPARED',
      proof: args.proof,
      response,
    });
    return response;
  },
});

// Recovery deliberately has no old-key certificate. Both administrators must
// review the new fingerprint independently; archives never enter this path.
export const recoverLocalIdentity = action({
  args: { adminToken: v.string(), oldKeyUnavailable: v.boolean(), ...details },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    validateDetails(args.operator, args.reason);
    if (!args.oldKeyUnavailable)
      throw new Error('OLD_IDENTITY_KEY_UNAVAILABLE_ATTESTATION_REQUIRED');
    const keys = await createIdentityKeys();
    return ctx.runMutation(mutationRef('identityKeyRotation/recoverLocal'), {
      ...keys,
      operator: args.operator.trim(),
      reason: args.reason.trim(),
    });
  },
});
export const recoverLocal = internalMutation({
  args: {
    publicKey: v.string(),
    privateKeyEncrypted: v.string(),
    fingerprint: v.string(),
    ...details,
  },
  handler: async (ctx, args) => {
    await assertIdentityKeyRotationIdle(ctx);
    await assertCredentialsIdle(ctx);
    await assertNoIdentityConflict(ctx);
    const local = await identity(ctx);
    if (!local || !['ACTIVE', 'NEEDS_RECONCILIATION'].includes(local.mode))
      throw new Error('DEPLOYMENT_NOT_ACTIVE');
    if (
      (await ctx.db
        .query('visitLedger')
        .filter((q) =>
          q.and(...['COMPLETED', 'REJECTED', 'CANCELLED'].map((s) => q.neq(q.field('state'), s))),
        )
        .first()) ||
      (await ctx.db
        .query('visitReservations')
        .withIndex('active', (q) => q.eq('reservedSlot', true))
        .first()) ||
      (await ctx.db.query('worlds').collect()).some((w) => w.players.some((p) => p.remoteVisitor))
    )
      throw new Error('IDENTITY_RECOVERY_VISITS_NOT_DRAINED');
    const rotationId = crypto.randomUUID(),
      body = {
        purpose: 'ai-town-manual-identity-recovery/1',
        rotationId,
        townId: local.townId,
        oldPublicKey: local.publicKey,
        newPublicKey: args.publicKey,
        oldVersion: local.identityVersion ?? 1,
        newVersion: (local.identityVersion ?? 1) + 1,
        deploymentInstanceId: local.deploymentInstanceId,
        deploymentEpoch: local.deploymentEpoch,
        operator: args.operator,
        reason: args.reason,
        createdAt: Date.now(),
      };
    const certificate = { body, newSignature: await sign(body, args.privateKeyEncrypted) };
    if (
      !(await verifySignature(body, certificate.newSignature, args.publicKey)) ||
      args.fingerprint !== `sha256:${await digest(args.publicKey)}`
    )
      throw new Error('INVALID_RECOVERY_KEY');
    await ctx.db.insert('federationIdentityKeyRotations', {
      rotationId,
      certificate,
      state: 'RECOVERY',
      expiresAt: Date.now(),
      operator: args.operator,
      reason: args.reason,
      createdAt: Date.now(),
    });
    await ctx.db.insert('federationIdentityKeyHistory', {
      rotationId,
      townId: local.townId,
      oldVersion: body.oldVersion,
      newVersion: body.newVersion,
      oldPublicKey: local.publicKey,
      newPublicKey: args.publicKey,
      kind: 'MANUAL',
      role: 'LOCAL',
      certificate,
      activation: certificate,
      verified: true,
      acceptedAt: Date.now(),
      operator: args.operator,
      reason: args.reason,
    });
    await ctx.db.patch(local._id, {
      publicKey: args.publicKey,
      privateKeyEncrypted: args.privateKeyEncrypted,
      fingerprint: args.fingerprint,
      identityVersion: body.newVersion,
      enabled: false,
      allowIncomingPairRequests: false,
      mode: 'NEEDS_RECONCILIATION',
    });
    for (const remote of await ctx.db.query('federationPeers').collect())
      if (remote.trustState === 'TRUSTED')
        await ctx.db.patch(remote._id, { trustState: 'REAUTH_REQUIRED' });
    for (const row of await ctx.db.query('federationCredentialRotations').collect())
      await ctx.db.patch(row._id, {
        state: 'REVOKED',
        previousCredentialEncrypted: undefined,
        ephemeralPrivateEncrypted: undefined,
      });
    await resetSessions(ctx);
    return {
      rotationId,
      townId: local.townId,
      publicKey: args.publicKey,
      fingerprint: args.fingerprint,
      identityVersion: body.newVersion,
      reviewRequired: true,
    };
  },
});
export const reviewChallengeProof = internalMutation({
  args: { packet: v.any() },
  handler: async (ctx, args) => {
    const local = await identity(ctx),
      remote = await peer(ctx, args.packet?.body?.fromTownId),
      b = args.packet?.body;
    if (
      !local ||
      !remote ||
      !['ACTIVE', 'NEEDS_RECONCILIATION'].includes(local.mode) ||
      !['TRUSTED', 'REAUTH_REQUIRED', 'PAUSED'].includes(remote.trustState)
    )
      throw new Error('PEER_NOT_TRUSTED');
    await assertNoIdentityConflict(ctx);
    validateControl(b, local, remote);
    if (
      b.type !== 'IDENTITY_REVIEW_CHALLENGE' ||
      b.publicKey !== local.publicKey ||
      b.identityVersion !== (local.identityVersion ?? 1) ||
      b.fingerprint !== local.fingerprint ||
      !(await verifyPacket(args.packet, remote.publicKey, remote.credentialEncrypted))
    )
      throw new Error('IDENTITY_REVIEW_CHALLENGE_FAILED');
    return signPacket(
      {
        ...controlBody(local, remote, 'IDENTITY_REVIEW_PROOF'),
        publicKey: local.publicKey,
        fingerprint: local.fingerprint,
        identityVersion: local.identityVersion ?? 1,
        challengeNonce: b.nonce,
        challengeDigest: await digest(b),
      },
      local.privateKeyEncrypted,
      remote.credentialEncrypted,
    );
  },
});
export const respondReviewChallenge = internalAction({
  args: { packet: v.any() },
  handler: async (ctx, args) =>
    ctx.runMutation(mutationRef('identityKeyRotation/reviewChallengeProof'), args),
});
const reviewArgs = {
  peerTownId: v.string(),
  publicKey: v.string(),
  identityVersion: v.number(),
  independentFingerprint: v.string(),
  independentlyVerified: v.boolean(),
  ...details,
};
export const reviewPeerIdentity = action({
  args: { adminToken: v.string(), ...reviewArgs },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    validateDetails(args.operator, args.reason);
    if (
      !args.independentlyVerified ||
      args.independentFingerprint !== `sha256:${await digest(args.publicKey)}`
    )
      throw new Error('INDEPENDENT_IDENTITY_REVIEW_REQUIRED');
    const { identity: local, peer: remote } = await ctx.runQuery(queryRef('store/context'), {
      peerTownId: args.peerTownId,
    });
    if (
      !local ||
      !remote ||
      !['ACTIVE', 'NEEDS_RECONCILIATION'].includes(local.mode) ||
      !['TRUSTED', 'REAUTH_REQUIRED', 'PAUSED'].includes(remote.trustState)
    )
      throw new Error('PEER_NOT_TRUSTED');
    const challenge = await signPacket(
      {
        ...controlBody(local, remote, 'IDENTITY_REVIEW_CHALLENGE'),
        publicKey: args.publicKey,
        fingerprint: args.independentFingerprint,
        identityVersion: args.identityVersion,
      },
      local.privateKeyEncrypted,
      remote.credentialEncrypted,
    );
    const proof = await directRequest(remote.endpoint, '/peers/identity-key', {
      operation: 'review-challenge',
      packet: challenge,
    });
    const { adminToken: _admin, ...fields } = args;
    return ctx.runMutation(mutationRef('identityKeyRotation/commitReview'), {
      ...fields,
      challenge,
      proof,
      previousPublicKey: remote.publicKey,
    });
  },
});
export const commitReview = internalMutation({
  args: { ...reviewArgs, challenge: v.any(), proof: v.any(), previousPublicKey: v.string() },
  handler: async (ctx, args) => {
    validateDetails(args.operator, args.reason);
    await assertNoIdentityConflict(ctx);
    const local = await identity(ctx),
      remote = await peer(ctx, args.peerTownId);
    if (
      !local ||
      !remote ||
      !args.independentlyVerified ||
      !['TRUSTED', 'REAUTH_REQUIRED', 'PAUSED'].includes(remote.trustState) ||
      remote.publicKey !== args.previousPublicKey ||
      !Number.isSafeInteger(args.identityVersion) ||
      args.identityVersion < (remote.identityVersion ?? 1) ||
      (args.publicKey !== remote.publicKey &&
        args.identityVersion <= (remote.identityVersion ?? 1)) ||
      args.independentFingerprint !== `sha256:${await digest(args.publicKey)}`
    )
      throw new Error('INDEPENDENT_IDENTITY_REVIEW_REQUIRED');
    const p = args.proof?.body,
      challenge = args.challenge?.body;
    validateControl(p, local, remote);
    if (
      challenge.expiresAt <= Date.now() ||
      challenge.publicKey !== args.publicKey ||
      challenge.identityVersion !== args.identityVersion ||
      !(await verifyPacket(args.challenge, local.publicKey, remote.credentialEncrypted)) ||
      !(await verifyPacket(args.proof, args.publicKey, remote.credentialEncrypted)) ||
      p.type !== 'IDENTITY_REVIEW_PROOF' ||
      p.publicKey !== args.publicKey ||
      p.fingerprint !== args.independentFingerprint ||
      p.identityVersion !== args.identityVersion ||
      p.challengeNonce !== challenge.nonce ||
      p.challengeDigest !== (await digest(challenge))
    )
      throw new Error('IDENTITY_REVIEW_CHALLENGE_FAILED');
    const evidence = { body: p, signature: args.proof.signature },
      rotationId = `review:${crypto.randomUUID()}`;
    await ctx.db.insert('federationIdentityKeyHistory', {
      rotationId,
      townId: remote.townId,
      oldVersion: remote.identityVersion ?? 1,
      newVersion: args.identityVersion,
      oldPublicKey: remote.publicKey,
      newPublicKey: args.publicKey,
      kind: 'MANUAL',
      role: 'PEER',
      certificate: evidence,
      activation: evidence,
      verified: true,
      acceptedAt: Date.now(),
      operator: args.operator.trim(),
      reason: args.reason.trim(),
    });
    await ctx.db.patch(remote._id, {
      publicKey: args.publicKey,
      fingerprint: args.independentFingerprint,
      identityVersion: args.identityVersion,
      trustState: 'TRUSTED',
    });
    for (const row of await ctx.db
      .query('federationCredentialRotations')
      .withIndex('peer_state', (q) => q.eq('peerTownId', remote.townId))
      .collect())
      await ctx.db.patch(row._id, {
        state: 'REVOKED',
        previousCredentialEncrypted: undefined,
        ephemeralPrivateEncrypted: undefined,
      });
    await resetSessions(ctx, remote.townId);
    return {
      townId: remote.townId,
      identityVersion: args.identityVersion,
      fingerprint: args.independentFingerprint,
      reviewed: true,
    };
  },
});
export const finishRecovery = mutation({
  args: {
    adminToken: v.string(),
    rotationId: v.string(),
    enableFederation: v.boolean(),
    ...details,
  },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    validateDetails(args.operator, args.reason);
    await assertNoIdentityConflict(ctx);
    const row = await rotationFor(ctx, args.rotationId),
      local = await identity(ctx);
    if (
      !row ||
      row.state !== 'RECOVERY' ||
      !local ||
      local.mode !== 'NEEDS_RECONCILIATION' ||
      row.certificate.body.newPublicKey !== local.publicKey ||
      (await ctx.db.query('federationPeers').collect()).some(
        (p) => p.trustState === 'REAUTH_REQUIRED',
      )
    )
      throw new Error('IDENTITY_RECOVERY_PEER_REVIEW_REQUIRED');
    await ctx.db.patch(row._id, { state: 'RECOVERED' });
    await ctx.db.patch(local._id, { mode: 'ACTIVE', enabled: args.enableFederation });
    return { enabled: args.enableFederation, townId: local.townId };
  },
});

async function abortPrepared(ctx: MutationCtx, row: Rotation, state: string) {
  await ctx.db.patch(row._id, { state, newPrivateEncrypted: undefined });
  for (const exchange of await outboundFor(ctx, row.rotationId))
    await ctx.db.patch(exchange._id, { state: 'ABORTED', packet: undefined });
}
export const abort = mutation({
  args: { adminToken: v.string(), rotationId: v.string(), ...details },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    validateDetails(args.operator, args.reason);
    const row = await rotationFor(ctx, args.rotationId);
    if (!row || row.state !== 'PREPARING') throw new Error('IDENTITY_KEY_ALREADY_ACTIVATED');
    await abortPrepared(ctx, row, 'ABORTED');
    return { state: 'ABORTED' };
  },
});
export const retry = action({
  args: { adminToken: v.string(), rotationId: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    await ctx.runAction(actionRef('identityKeyRotation/distribute'), {
      rotationId: args.rotationId,
    });
  },
});
export async function maintainIdentityKeyRotations(ctx: MutationCtx) {
  const expired = await ctx.db
    .query('federationIdentityKeyRotations')
    .withIndex('state_expiry', (q) => q.eq('state', 'PREPARING').lte('expiresAt', Date.now()))
    .take(20);
  for (const row of expired) await abortPrepared(ctx, row, 'EXPIRED');
  const incoming = await ctx.db.query('federationIdentityKeyExchanges').collect();
  for (const row of incoming.filter(
    (r) =>
      r.direction === 'INBOUND' &&
      ['PREPARED', 'CHALLENGING'].includes(r.state) &&
      r.expiresAt <= Date.now(),
  ))
    await ctx.db.patch(row._id, { state: 'EXPIRED' });
  for (const state of ['PENDING_PREPARE', 'PENDING_COMMIT', 'RUNNING_PREPARE', 'RUNNING_COMMIT']) {
    const rows = await ctx.db
      .query('federationIdentityKeyExchanges')
      .withIndex('state_retry', (q) => q.eq('state', state).lte('nextRetryAt', Date.now()))
      .take(20);
    for (const row of rows.filter((r) => r.direction === 'OUTBOUND')) {
      await ctx.db.patch(row._id, {
        state: state.replace('RUNNING', 'PENDING'),
        nextRetryAt: Date.now() + 60_000,
      });
      await ctx.scheduler.runAfter(0, actionRef('identityKeyRotation/deliver'), {
        rotationId: row.rotationId,
        peerTownId: row.peerTownId,
      });
    }
  }
}
export const status = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const local = await identity(ctx),
      rotations = await ctx.db.query('federationIdentityKeyRotations').order('desc').take(50),
      exchanges = await ctx.db.query('federationIdentityKeyExchanges').order('desc').take(200);
    return {
      identityVersion: local?.identityVersion ?? 1,
      publicKey: local?.publicKey,
      fingerprint: local?.fingerprint,
      rotations: rotations.map(({ rotationId, state, expiresAt, operator, reason, createdAt }) => ({
        rotationId,
        state,
        expiresAt,
        operator,
        reason,
        createdAt,
      })),
      exchanges: exchanges.map(
        ({ rotationId, peerTownId, direction, state, attempts, nextRetryAt, lastError }) => ({
          rotationId,
          peerTownId,
          direction,
          state,
          attempts,
          nextRetryAt,
          lastError,
        }),
      ),
    };
  },
});

export function registerIdentityKeyRoutes(http: HttpRouter) {
  http.route({
    path: '/federation/v1/peers/identity-key',
    method: 'POST',
    handler: httpAction(async (ctx, request) => {
      try {
        const input = await readRequest(request);
        if (!['offer', 'challenge', 'review-challenge'].includes(input?.operation))
          throw new Error('INVALID_IDENTITY_KEY_OPERATION');
        const name =
          input.operation === 'offer'
            ? 'receiveOffer'
            : input.operation === 'challenge'
              ? 'respondChallenge'
              : 'respondReviewChallenge';
        const response = await ctx.runAction(actionRef(`identityKeyRotation/${name}`), {
          packet: input.packet,
        });
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'IDENTITY_KEY_ROTATION_REJECTED';
        return new Response(
          JSON.stringify({
            error: /^[A-Z][A-Z0-9_]+$/.test(message) ? message : 'IDENTITY_KEY_ROTATION_REJECTED',
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
