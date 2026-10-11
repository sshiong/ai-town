import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { actionRef, mutationRef, queryRef } from './refs';
import { createIdentityKeys, digest, randomSecret, sealSecret, sign, signPacket } from './security';
import { FederationMessage, PROTOCOL, streamKey } from './protocol';
import { homeFrozen, hostCreated, hostRemoved, homeResumed } from './ledger';
import { enqueueMessage } from './queue';
import { resourceMeasurements } from './resourceMonitoring';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  // Protocol integration tests replace the Node socket boundary with the existing
  // in-memory HTTP router. Production uses DNS-pinned HTTPS, tested separately.
  '../federation/nodeNetworkRequest.ts': async () => {
    const { internalAction } = await import('../_generated/server');
    const { connectionError } = await import('./direct');
    return { send: internalAction(async (_ctx, args: any) => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), args.timeoutMs);
      try {
        const response = await fetch(`${args.endpoint}${args.path}`, { method: args.data === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json' }, body: args.data, redirect: 'error', signal: controller.signal });
        return { ok: true, status: response.status, text: await response.text() };
      } catch (error) { return { ok: false, error: connectionError(error, controller.signal.aborted) }; }
      finally { clearTimeout(timer); }
    }) };
  },
  '../federation/publicRateLimit.ts': () => import('./publicRateLimit'),
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/store.ts': () => import('./store'),
  '../federation/transport.ts': () => import('./transport'),
  '../federation/ledger.ts': () => import('./ledger'),
  '../federation/runtime.ts': () => import('./runtime'),
  '../federation/peers.ts': () => import('./peers'),
  '../federation/admin.ts': () => import('./admin'),
  '../federation/identityConflict.ts': () => import('./identityConflict'),
  '../http.ts': async () => {
    const { httpRouter } = await import('convex/server');
    const { registerPairingRoutes } = await import('./peers');
    const { registerFederationRoutes } = await import('./transport');
    const http = httpRouter(); registerPairingRoutes(http); registerFederationRoutes(http);
    return { default: http };
  },
};
const adminToken = 'federation-test-admin-token-32-bytes';
type Town = Awaited<ReturnType<typeof town>>;
type ReadLimits = { documentsRead?: number; bytesRead?: number };
async function town(townId: string, keys: Awaited<ReturnType<typeof createIdentityKeys>>, readLimits?: ReadLimits) {
  const t = convexTest({ schema, modules, transactionLimits: readLimits ?? false });
  // Normal protocol fixtures include the UTC observation preceding their grants.
  await t.run(ctx => ctx.db.insert('federationClock', { observedAt: Date.now(), uncertain: false }));
  await t.run(async ctx => { await ctx.db.insert('federationIdentity', { ...keys, townId, townName: townId, endpoint: `https://${townId}.example/federation/v1`, deploymentInstanceId: `${townId}-instance`, deploymentEpoch: 1,
    enabled: true, allowIncomingPairRequests: true, allowUnencryptedHttp: false, allowPublicHttp: false, maxVisitors: 1, maxVisitDurationMs: 300000, mode: 'ACTIVE', createdAt: Date.now() }); });
  return { t, townId, keys };
}
async function setup(readLimits?: ReadLimits) {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = randomSecret();
  const [keysA, keysB] = await Promise.all([createIdentityKeys(), createIdentityKeys()]);
  const a = await town('town-a', keysA, readLimits), b = await town('town-b', keysB, readLimits), credentialEncrypted = await sealSecret(randomSecret());
  for (const [local, remote] of [[a, b], [b, a]]) await local.t.run(async ctx => {
    await ctx.db.insert('federationPeers', { townId: remote.townId, townName: remote.townId, publicKey: remote.keys.publicKey, fingerprint: remote.keys.fingerprint, deploymentInstanceId: `${remote.townId}-instance`, deploymentEpoch: 1,
      endpoint: `https://${remote.townId}.example/federation/v1`, credentialId: 'credential-ab', credentialEncrypted, trustState: 'TRUSTED', inboundVisitsAllowed: true, outboundVisitsAllowed: true, pairedAt: Date.now() });
  });
  return { a, b, credentialEncrypted };
}
function message(from: Town, to: Town, type: string, overrides: Partial<FederationMessage> = {}): FederationMessage {
  const nonce = crypto.randomUUID();
  return { protocol: PROTOCOL, messageId: crypto.randomUUID(), fromTownId: from.townId, toTownId: to.townId, senderDeploymentInstanceId: `${from.townId}-instance`, senderDeploymentEpoch: 1,
    expectedRecipientDeploymentEpoch: 1, type, sentAt: Date.now(), expiresAt: Date.now() + 300000, nonce, credentialId: 'credential-ab',
    payload: type === 'TRANSPORT_PROBE' ? { probeId: crypto.randomUUID(), nonce } : { fencingToken: 'test-fencing-token-32bytes' }, ...overrides };
}
async function accept(to: Town, msg: FederationMessage) {
  return to.t.mutation(mutationRef('transport/acceptMessage'), { message: msg, payloadDigest: await digest(msg) });
}
async function markReady(local: Town, remote: Town) {
  await local.t.run(async ctx => { await ctx.db.insert('transportSessions', { peerTownId: remote.townId, channelState: 'TRANSPORT_READY', transportType: 'DIRECT_HTTPS', localDeploymentEpoch: 1, verifiedPeerDeploymentEpoch: 1, outboundVerifiedAt: Date.now(), inboundVerifiedAt: Date.now() }); });
}
async function seedVisit(local: Town, remote: Town, role: 'home' | 'host', state = 'ACTIVE', visitId = 'visit-1') {
  await local.t.run(async ctx => { await ctx.db.insert('visitLedger', { visitId, agentGlobalId: 'town-a/agent:test', homeTownId: 'town-a', hostTownId: 'town-b', homeDeploymentEpoch: 1, hostDeploymentEpoch: 1,
    agentAuthorityEpoch: 2, visitLeaseVersion: 1, leaseExpiry: Date.now() + 300000, fencingToken: 'test-fencing-token-32bytes', state, role,
    profile: { name: 'Alice', character: 'f1', description: 'Resident', homeTownName: 'Town A' }, createdAt: Date.now(), updatedAt: Date.now() }); });
}
function visitMessage(from: Town, to: Town, type: string, sequence: number, streamId = 'lease-control', overrides: Partial<FederationMessage> = {}) {
  return message(from, to, type, { visitId: 'visit-1', agentGlobalId: 'town-a/agent:test', agentAuthorityEpoch: 2, visitLeaseVersion: 1, streamId, sequence, ...overrides });
}
let originalFetch: typeof fetch;
beforeEach(() => { jest.useFakeTimers({ doNotFake: ['nextTick'] }); originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; jest.useRealTimers(); });

test('independent signed probes make empty towns ready only after both directions', async () => {
  const { a, b, credentialEncrypted } = await setup();
  globalThis.fetch = (async (url: any, init: any) => {
    const target = String(url).includes('town-a.example') ? a : b;
    const result = await target.t.action(actionRef('transport/receiveProbe'), { packet: JSON.parse(init.body) });
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  expect(await a.t.action(actionRef('transport/probeInternal'), { peerTownId: b.townId })).toEqual({ channelState: 'TRANSPORT_TESTING' });
  expect((await a.t.run(ctx => ctx.db.query('transportSessions').unique()))?.channelState).toBe('TRANSPORT_TESTING');
  expect((await b.t.run(ctx => ctx.db.query('transportSessions').unique()))?.channelState).toBe('TRANSPORT_TESTING');
  expect(await b.t.action(actionRef('transport/probeInternal'), { peerTownId: a.townId })).toEqual({ channelState: 'TRANSPORT_READY' });
  expect((await a.t.run(ctx => ctx.db.query('transportSessions').unique()))?.channelState).toBe('TRANSPORT_READY');
  for (const local of [a, b]) expect(await local.t.run(ctx => ctx.db.query('visitLedger').collect())).toEqual([]);
  const probe = message(a, b, 'TRANSPORT_PROBE');
  const packet = await signPacket(probe, a.keys.privateKeyEncrypted, credentialEncrypted);
  await b.t.action(actionRef('transport/receiveProbe'), { packet });
  await expect(b.t.action(actionRef('transport/receiveProbe'), { packet })).rejects.toThrow('REPLAYED_NONCE');
  const forged = { ...probe, messageId: crypto.randomUUID(), nonce: crypto.randomUUID(), payload: { ...probe.payload, action: { type: 'say', text: 'bad' } } };
  await expect(b.t.action(actionRef('transport/receiveProbe'), { packet: await signPacket(forged, a.keys.privateKeyEncrypted, credentialEncrypted) })).rejects.toThrow('INVALID_PROBE_PAYLOAD');
});

test('one-way failure never grants ready and HTTPS errors never fall back to HTTP', async () => {
  const { a, b } = await setup(); const urls: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    urls.push(String(url));
    if (String(url).includes('town-a.example')) throw new Error('CERTIFICATE_OR_NETWORK_FAILURE');
    return new Response(JSON.stringify(await b.t.action(actionRef('transport/receiveProbe'), { packet: JSON.parse(init.body) })));
  }) as typeof fetch;
  await a.t.action(actionRef('transport/probeInternal'), { peerTownId: b.townId });
  expect(await b.t.action(actionRef('transport/probeInternal'), { peerTownId: a.townId })).toEqual({ channelState: 'PAIRED_BUT_NOT_REACHABLE' });
  expect(urls.every(url => url.startsWith('https://'))).toBe(true);
  expect((await a.t.run(ctx => ctx.db.query('transportSessions').unique()))?.channelState).toBe('TRANSPORT_TESTING');
});

test('four epochs are independent and authentication rejects forged packets before Inbox', async () => {
  const { a, b, credentialEncrypted } = await setup(); await seedVisit(b, a, 'host');
  for (const [field, error] of [['senderDeploymentEpoch', 'SENDER_DEPLOYMENT_MISMATCH'], ['expectedRecipientDeploymentEpoch', 'RECIPIENT_DEPLOYMENT_MISMATCH'], ['agentAuthorityEpoch', 'STALE_AGENT_AUTHORITY'], ['visitLeaseVersion', 'STALE_VISIT_LEASE']] as const) {
    await expect(accept(b, visitMessage(a, b, 'VISIT_CONFIRM', 1, 'lease-control', { [field]: 99 }))).rejects.toThrow(error);
  }
  const packet = await signPacket(visitMessage(a, b, 'VISIT_CONFIRM', 1), a.keys.privateKeyEncrypted, credentialEncrypted);
  packet.mac = 'forged';
  await expect(b.t.action(actionRef('transport/receiveMessage'), { packet })).rejects.toThrow('MESSAGE_AUTH_FAILED');
  expect(await b.t.run(ctx => ctx.db.query('federationInbox').collect())).toEqual([]);
  expect((await b.t.run(ctx => resourceMeasurements(ctx.db))).inboundEvents).toBe(0);
});

test('authenticated Inbox metrics count unique accepted events once across signed retries and conflicts', async () => {
  const { a, b, credentialEncrypted } = await setup();
  await seedVisit(b, a, 'host');
  const msg = visitMessage(a, b, 'VISIT_CONFIRM', 1);
  const packet = await signPacket(msg, a.keys.privateKeyEncrypted, credentialEncrypted);
  expect((await b.t.action(actionRef('transport/receiveMessage'), { packet })).body.status).toBe('COMMITTED');
  expect((await b.t.action(actionRef('transport/receiveMessage'), { packet })).body.status).toBe('COMMITTED');
  const conflict = await signPacket({ ...msg, payload: { ...msg.payload, extra: true } }, a.keys.privateKeyEncrypted, credentialEncrypted);
  await expect(b.t.action(actionRef('transport/receiveMessage'), { packet: conflict })).rejects.toThrow('MESSAGE_ID_CONFLICT');
  const forged = await signPacket({ ...msg, messageId: crypto.randomUUID(), nonce: crypto.randomUUID() }, a.keys.privateKeyEncrypted, credentialEncrypted);
  forged.mac = 'forged';
  await expect(b.t.action(actionRef('transport/receiveMessage'), { packet: forged })).rejects.toThrow('MESSAGE_AUTH_FAILED');
  expect(await b.t.run(ctx => ctx.db.query('federationInbox').collect())).toHaveLength(1);
  expect((await b.t.run(ctx => resourceMeasurements(ctx.db))).inboundEvents).toBe(1);
});

test('reservation capacity is atomic, retries are idempotent, and trust without ready refuses travel', async () => {
  const { a, b } = await setup();
  const reserve = (id: string, globalId: string) => visitMessage(a, b, 'VISIT_RESERVE', 1, 'lease-control', { visitId: id, agentGlobalId: globalId, payload: { fencingToken: 'test-fencing-token-32bytes', leaseExpiry: Date.now() + 250000,
    profile: { name: 'Alice', character: 'f1', description: 'Resident', homeTownName: 'Town A' } } });
  await accept(b, reserve('not-ready', 'town-a/agent:not-ready'));
  expect((await b.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('REJECTED');
  await markReady(b, a);
  const first = reserve('first', 'town-a/agent:first');
  const second = reserve('second', 'town-a/agent:second');
  const results = await Promise.all([accept(b, first), accept(b, second)]);
  expect(results.map(r => r.status)).toEqual(['COMMITTED', 'COMMITTED']);
  const ledgers = await b.t.run(ctx => ctx.db.query('visitLedger').collect());
  expect(ledgers.filter(l => l.state === 'RESERVED')).toHaveLength(1);
  expect(ledgers.filter(l => l.lastError === 'HOST_CAPACITY_EXCEEDED')).toHaveLength(1);
  expect(await accept(b, first)).toEqual(results[0]);
  expect(await b.t.run(ctx => ctx.db.query('visitReservations').collect())).toHaveLength(1);
  expect(await b.t.run(ctx => ctx.db.query('federationInbox').collect())).toHaveLength(3);
});

test('rate refusal writes no nonce, Inbox or stream cursor; identical signed message retries succeed after refill', async () => {
  const { a, b, credentialEncrypted } = await setup();
  await b.t.run(ctx => ctx.db.insert('federationResourcePolicy', {
    maxVisitorsPerSourceTown: null, maxRemoteEventsPerSecond: 1,
  }));
  const reserve = (id: string) => visitMessage(a, b, 'VISIT_RESERVE', 1, 'lease-control', {
    visitId: id, agentGlobalId: `town-a/agent:${id}`, payload: {
      fencingToken: 'test-fencing-token-32bytes', leaseExpiry: Date.now() + 250000,
      profile: { name: 'Alice', character: 'f1', description: 'Resident', homeTownName: 'Town A' },
    },
  });
  const first = await signPacket(reserve('first-rate'), a.keys.privateKeyEncrypted, credentialEncrypted);
  const pending = await signPacket(reserve('pending-rate'), a.keys.privateKeyEncrypted, credentialEncrypted);
  expect((await b.t.action(actionRef('transport/receiveMessage'), { packet: first })).body.status).toBe('COMMITTED');
  expect((await b.t.action(actionRef('transport/receiveMessage'), { packet: first })).body.status).toBe('COMMITTED');
  await expect(b.t.action(actionRef('transport/receiveMessage'), { packet: pending })).rejects.toThrow('REMOTE_EVENT_RATE_EXCEEDED');
  const httpRefusal = await b.t.fetch('/federation/v1/messages', {
    method: 'POST', body: JSON.stringify(pending),
  });
  expect(httpRefusal.status).toBe(429);
  expect(httpRefusal.headers.get('Retry-After')).toBe('1');
  expect(await httpRefusal.json()).toEqual({ error: 'REMOTE_EVENT_RATE_EXCEEDED' });
  expect(await b.t.run(ctx => ctx.db.query('federationInbox').collect())).toHaveLength(1);
  expect(await b.t.run(ctx => ctx.db.query('federationReplayNonces').collect())).toHaveLength(1);
  const cursors = await b.t.run(ctx => ctx.db.query('messageStreamCursors').collect());
  expect(cursors).toHaveLength(2); // Inbound request and its outbound rejection receipt.
  expect(cursors.every(cursor => cursor.visitIdOrPairSessionId === 'first-rate')).toBe(true);
  jest.setSystemTime(Date.now() + 1000);
  expect((await b.t.action(actionRef('transport/receiveMessage'), { packet: pending })).body.status).toBe('COMMITTED');
  expect((await b.t.run(ctx => resourceMeasurements(ctx.db))).inboundEvents).toBe(2);
});

test('visit saga reserves, freezes Home, confirms Host exactly once, then cleans before return', async () => {
  const { a, b } = await setup(); await markReady(b, a); await markReady(a, b);
  await seedVisit(a, b, 'home', 'REQUESTED');
  const reserve = visitMessage(a, b, 'VISIT_RESERVE', 1, 'lease-control', { payload: { fencingToken: 'test-fencing-token-32bytes', leaseExpiry: Date.now() + 250000,
    profile: { name: 'Alice', character: 'f1', description: 'Resident', homeTownName: 'Town A' } } });
  // Both sides persist the same bounded Home-issued lease.
  await a.t.run(async ctx => { const l = (await ctx.db.query('visitLedger').unique())!; await ctx.db.patch(l._id, { leaseExpiry: reserve.payload.leaseExpiry }); });
  await a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'VISIT_RESERVE', visitId: 'visit-1', payload: reserve.payload }));
  const sentReserve = (await a.t.run(ctx => ctx.db.query('federationOutbox').unique()))!.envelope;
  await accept(b, sentReserve);
  const reserved = (await b.t.run(ctx => ctx.db.query('federationOutbox').unique()))!.envelope;
  await accept(a, reserved);
  expect((await a.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('FREEZING');
  await a.t.run(ctx => homeFrozen(ctx, 'visit-1'));
  const confirm = (await a.t.run(ctx => ctx.db.query('federationOutbox').collect())).find(o => o.envelope.type === 'VISIT_CONFIRM')!.envelope;
  await accept(b, confirm); await accept(b, confirm);
  expect((await b.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('CREATING');
  await b.t.run(ctx => hostCreated(ctx, 'visit-1', 'p:9'));
  await b.t.run(ctx => hostCreated(ctx, 'visit-1', 'p:9'));
  const active = (await b.t.run(ctx => ctx.db.query('federationOutbox').collect())).find(o => o.envelope.type === 'VISIT_ACTIVE')!.envelope;
  await accept(a, active);
  expect((await a.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('ACTIVE');
  await a.t.mutation(mutationRef('ledger/returnVisit'), { adminToken, visitId: 'visit-1' });
  await expect(a.t.run(ctx => homeResumed(ctx, 'visit-1'))).rejects.toThrow('HOST_LEASE_STILL_VALID');
  const returning = (await a.t.run(ctx => ctx.db.query('federationOutbox').collect())).find(o => o.envelope.type === 'VISIT_RETURN')!.envelope;
  await accept(b, returning);
  expect((await b.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('REMOVING');
  await b.t.run(ctx => hostRemoved(ctx, 'visit-1'));
  const cleaned = (await b.t.run(ctx => ctx.db.query('federationOutbox').collect())).find(o => o.envelope.type === 'VISIT_CLEANED')!.envelope;
  await accept(a, cleaned); await a.t.run(ctx => homeResumed(ctx, 'visit-1'));
  expect((await a.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('COMPLETED');
  expect((await b.t.run(ctx => ctx.db.query('visitReservations').unique()))?.reservedSlot).toBe(false);
});

test('directions and streams each start at one; gap buffers, NACK replays durable Outbox, drain commits once', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home', 'CONFIRMING'); await seedVisit(b, a, 'host');
  const first = visitMessage(a, b, 'VISIT_CONFIRM', 1);
  const second = visitMessage(a, b, 'VISIT_CONFIRM', 2);
  // Persist original outgoing messages, including one already acknowledged.
  for (const msg of [first, second]) await a.t.run(async ctx => { await ctx.db.insert('federationOutbox', { messageId: msg.messageId, toTownId: b.townId, envelope: msg, attempts: 1, nextRetryAt: Date.now() + 60000, ackedAt: Date.now() }); });
  expect((await accept(b, second)).status).toBe('BUFFERED');
  const nack = (await b.t.run(ctx => ctx.db.query('federationOutbox').unique()))!.envelope;
  expect(nack.type).toBe('STREAM_NACK');
  await accept(a, nack);
  expect((await a.t.run(ctx => ctx.db.query('federationOutbox').withIndex('messageId', q => q.eq('messageId', first.messageId)).unique()))?.ackedAt).toBeUndefined();
  expect((await accept(b, first)).status).toBe('COMMITTED');
  await b.t.mutation(mutationRef('transport/drainStream'), { streamKey: streamKey(first, a.townId) });
  expect((await accept(b, second)).status).toBe('COMMITTED');
  expect((await b.t.run(ctx => ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', streamKey(first, a.townId))).unique()))?.nextExpectedSequence).toBe(3);
  const opposite = visitMessage(b, a, 'VISIT_ACTIVE', 1, 'host-results', { payload: { fencingToken: 'test-fencing-token-32bytes', hostPlayerId: 'p:9' } });
  expect((await accept(a, opposite)).status).toBe('COMMITTED');
  const independent = visitMessage(a, b, 'VISIT_CONFIRM', 1, 'home-actions');
  expect((await accept(b, independent)).status).toBe('COMMITTED');
  expect((await b.t.run(ctx => ctx.db.query('messageStreamCursors').collect())).filter(c => c.direction === 'inbound')).toHaveLength(2);
});

test('missing durable history requires resync and never skips into executing active messages', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home'); await seedVisit(b, a, 'host');
  const late = visitMessage(a, b, 'VISIT_CONFIRM', 2);
  await accept(b, late);
  const nack = (await b.t.run(ctx => ctx.db.query('federationOutbox').unique()))!.envelope;
  await accept(a, nack);
  expect((await a.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('RETURN_PENDING');
  const resync = (await a.t.run(ctx => ctx.db.query('federationOutbox').collect())).find(o => o.envelope.type === 'SESSION_RESYNC')!.envelope;
  await accept(b, resync);
  expect((await b.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('REMOVING');
  expect((await b.t.run(ctx => ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', streamKey(late, a.townId))).unique()))?.nextExpectedSequence).toBe(1);
});

test('network partition waits through full lease safety margin; revoked peers still permit cleanup', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home');
  await a.t.run(async ctx => { const l = (await ctx.db.query('visitLedger').unique())!; await ctx.db.patch(l._id, { leaseExpiry: Date.now() + 1000 }); const p = (await ctx.db.query('federationPeers').unique())!; await ctx.db.patch(p._id, { trustState: 'REVOKED' }); });
  await a.t.mutation(mutationRef('ledger/returnVisit'), { adminToken, visitId: 'visit-1' });
  jest.setSystemTime(Date.now() + 1001);
  await a.t.mutation(mutationRef('ledger/reconcile'), {});
  await expect(a.t.run(ctx => homeResumed(ctx, 'visit-1'))).rejects.toThrow('HOST_LEASE_STILL_VALID');
  jest.setSystemTime(Date.now() + 60000);
  await a.t.mutation(mutationRef('ledger/reconcile'), {});
  await a.t.run(ctx => homeResumed(ctx, 'visit-1'));
  expect((await a.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('COMPLETED');
});

test('durable delivery distinguishes authenticated commit from HTTP 200 and retries lost ACK', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home', 'CONFIRMING'); await seedVisit(b, a, 'host');
  const id = await a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'VISIT_CONFIRM', visitId: 'visit-1', payload: { fencingToken: 'test-fencing-token-32bytes' } }));
  globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'COMMITTED' }), { status: 200 })) as typeof fetch;
  await a.t.action(actionRef('transport/deliver'), { messageId: id });
  expect((await a.t.run(ctx => ctx.db.query('federationOutbox').unique()))?.ackedAt).toBeUndefined();
  let lost = true;
  globalThis.fetch = (async (_url: any, init: any) => {
    const result = await b.t.action(actionRef('transport/receiveMessage'), { packet: JSON.parse(init.body) });
    if (lost) { lost = false; throw new Error('ACK_LOST'); }
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  await a.t.action(actionRef('transport/deliver'), { messageId: id });
  await a.t.action(actionRef('transport/deliver'), { messageId: id });
  expect((await a.t.run(ctx => ctx.db.query('federationOutbox').unique()))?.ackedAt).toBeDefined();
  expect(await b.t.run(ctx => ctx.db.query('federationInbox').collect())).toHaveLength(1);
});

test('real TLS sockets carry signed independent probes and reject an untrusted certificate', async () => {
  jest.useRealTimers();
  const { createServer, request } = await import('node:https');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const childProcess = await import('node:child_process');
  const { directRequest } = await import('./direct');
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'ai-town-tls-test-'));
  const keyPath = nodePath.join(dir, 'key.pem'), certPath = nodePath.join(dir, 'cert.pem');
  childProcess.execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=town-a.example', '-addext', 'subjectAltName=DNS:town-a.example,DNS:town-b.example'], { stdio: 'ignore' });
  const key = readFileSync(keyPath), cert = readFileSync(certPath);
  const { a, b } = await setup();
  // This protocol test's Node-action substitute uses real TLS and its test CA.
  // Production uses DNS-pinned Node HTTPS; networkPolicy.test covers that boundary.
  const tlsFetch = (trustedCA?: Buffer) => (async (url: any, init: any) => new Promise<Response>((resolve, reject) => {
    const req = request(String(url), { method: init?.method, headers: init?.headers, ca: trustedCA, signal: init?.signal, lookup: (_hostname: string, options: any, callback: any) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4) }, response => {
      const chunks: Buffer[] = [];
      response.on('data', data => chunks.push(Buffer.from(data)));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers as Record<string, string> })));
    });
    req.on('error', reject); req.end(init?.body);
  })) as typeof fetch;
  const serverFor = (target: Town) => createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', data => chunks.push(Buffer.from(data)));
    req.on('end', async () => {
      try {
        const response = await target.t.action(actionRef('transport/receiveProbe'), { packet: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'REJECTED' })); }
    });
  });
  const serverA = serverFor(a), serverB = serverFor(b);
  const listen = (server: ReturnType<typeof createServer>) => new Promise<number>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  try {
    const ports = await Promise.all([listen(serverA), listen(serverB)]);
    const endpoints = ports.map((port, index) => `https://${[a, b][index].townId}.example:${port}/federation/v1`);
    for (const [index, local] of [a, b].entries()) await local.t.run(async ctx => {
      const p = (await ctx.db.query('federationPeers').unique())!, i = (await ctx.db.query('federationIdentity').unique())!;
      await ctx.db.patch(p._id, { endpoint: endpoints[1 - index] }); await ctx.db.patch(i._id, { endpoint: endpoints[index] });
    });
    globalThis.fetch = tlsFetch(cert);
    const probeResult = await a.t.action(actionRef('transport/probeInternal'), { peerTownId: b.townId });
    expect((await a.t.run(ctx => ctx.db.query('transportSessions').unique()))?.lastError).toBe('NO_BIDIRECTIONAL_PATH');
    expect(probeResult).toEqual({ channelState: 'TRANSPORT_TESTING' });
    expect(await b.t.action(actionRef('transport/probeInternal'), { peerTownId: a.townId })).toEqual({ channelState: 'TRANSPORT_READY' });
    expect((await a.t.run(ctx => ctx.db.query('transportSessions').unique()))?.channelState).toBe('TRANSPORT_READY');
    globalThis.fetch = tlsFetch();
    const networkCtx = { runAction: (reference: any, args: any) => a.t.action(reference, args) };
    await expect(directRequest(networkCtx as any, endpoints[0], '/probe', {})).rejects.toThrow('TLS_VERIFY_FAILED');
    await expect(directRequest(networkCtx as any, endpoints[0].replace('https:', 'http:'), '/probe', {})).rejects.toThrow('HTTPS required');
  } finally {
    await Promise.all([serverA, serverB].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('endpoint changes fence an in-flight probe result and prevent stale readiness', async () => {
  const { a, b } = await setup();
  globalThis.fetch = (async (_url: any, init: any) => {
    const response = await b.t.action(actionRef('transport/receiveProbe'), { packet: JSON.parse(init.body) });
    await a.t.run(async ctx => { const p = (await ctx.db.query('federationPeers').unique())!; await ctx.db.patch(p._id, { endpoint: 'https://new-b.example/federation/v1' }); });
    return new Response(JSON.stringify(response));
  }) as typeof fetch;
  expect(await a.t.action(actionRef('transport/probeInternal'), { peerTownId: b.townId })).toEqual({ channelState: 'TRANSPORT_TESTING' });
  expect(await a.t.run(ctx => ctx.db.query('transportSessions').collect())).toEqual([]);
});

test('gap timeout marks resync without advancing cursor and the queue rejects stale or conflicting retries', async () => {
  const { a, b } = await setup(); await seedVisit(b, a, 'host');
  const gap = visitMessage(a, b, 'VISIT_CONFIRM', 2);
  await accept(b, gap);
  jest.setSystemTime(Date.now() + 30001);
  await b.t.mutation(mutationRef('transport/maintenance'), {});
  const cursor = await b.t.run(ctx => ctx.db.query('messageStreamCursors').unique());
  expect(cursor?.resyncState).toBe('RESYNC_REQUIRED'); expect(cursor?.nextExpectedSequence).toBe(1);
  const inbox = await b.t.run(ctx => ctx.db.query('federationInbox').unique()); expect(inbox?.status).toBe('BUFFERED');
  await expect(accept(b, { ...gap, payload: { ...gap.payload, reason: 'changed' } })).rejects.toThrow('MESSAGE_ID_CONFLICT');
});

test('renewal persists the maximum granted expiry and fences old lease messages', async () => {
  const { a, b } = await setup(); await markReady(a, b); await seedVisit(a, b, 'home'); await seedVisit(b, a, 'host');
  for (const local of [a, b]) await local.t.run(async ctx => { const l = (await ctx.db.query('visitLedger').unique())!; await ctx.db.patch(l._id, { leaseExpiry: Date.now() + 10000 }); });
  const renewed = await a.t.mutation(mutationRef('ledger/renewVisit'), { adminToken, visitId: 'visit-1' });
  expect(renewed.visitLeaseVersion).toBe(2);
  expect((await a.t.run(ctx => ctx.db.query('visitLedger').unique()))?.leaseExpiry).toBe(renewed.leaseExpiry);
  const envelope = (await a.t.run(ctx => ctx.db.query('federationOutbox').unique()))!.envelope;
  await accept(b, envelope);
  expect((await b.t.run(ctx => ctx.db.query('visitLedger').unique()))?.visitLeaseVersion).toBe(2);
  const old = visitMessage(a, b, 'VISIT_CONFIRM', 2);
  await expect(accept(b, old)).rejects.toThrow('STALE_VISIT_LEASE');
  // An already committed retry still returns its original ACK after a renewal.
  expect((await accept(b, envelope)).status).toBe('COMMITTED');
});

test('actual pairing HTTP handlers require manual approval and prove independently entered PSK before trust', async () => {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken; process.env.FEDERATION_KEY_ENCRYPTION_KEY = randomSecret();
  const a = await town('town-a', await createIdentityKeys()), b = await town('town-b', await createIdentityKeys());
  const secret = randomSecret();
  const wire: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    wire.push(init?.body ?? ''); const target = String(url).includes('town-a.example') ? a : b;
    return target.t.fetch(new URL(String(url)).pathname, { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body });
  }) as typeof fetch;
  const result = await a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: secret });
  expect(result.state).toBe('PENDING_APPROVAL');
  expect(await a.t.run(ctx => ctx.db.query('federationPeers').collect())).toEqual([]);
  expect(await b.t.run(ctx => ctx.db.query('federationPeers').collect())).toEqual([]);
  expect(wire.some(body => body.includes(secret))).toBe(false);
  expect((await a.t.action(actionRef('peers/continuePair'), { adminToken, pairRequestId: result.pairRequestId })).state).toBe('PENDING_APPROVAL');
  await b.t.action(actionRef('peers/approvePair'), { adminToken, pairRequestId: result.pairRequestId, pairingSecret: secret }).catch(error => { throw new Error(`approve: ${error.message}`); });
  expect((await a.t.action(actionRef('peers/continuePair'), { adminToken, pairRequestId: result.pairRequestId }).catch(error => { throw new Error(`continue: ${error.message}`); })).state).toBe('TRUSTED');
  const { openSecret } = await import('./security');
  const peerA = (await a.t.run(ctx => ctx.db.query('federationPeers').unique()))!, peerB = (await b.t.run(ctx => ctx.db.query('federationPeers').unique()))!;
  expect(await openSecret(peerA.credentialEncrypted)).toBe(await openSecret(peerB.credentialEncrypted));
  expect(await openSecret(peerA.credentialEncrypted)).not.toBe(secret);
  const health = await b.t.fetch('/federation/v1/health'); const discovery = await health.json();
  expect(discovery.body.publicKey).toBe(b.keys.publicKey);
  expect(discovery.body.privateKeyEncrypted).toBeUndefined(); expect(discovery.body.credentialEncrypted).toBeUndefined();
  const prior = await b.t.run(ctx => ctx.db.query('transportSessions').unique());
  // Replaying a valid transcript-bound confirmation is idempotent and does not
  // reset a healthy transport session or rotate the established credential.
  const confirmationWire = wire.map(body => { try { return JSON.parse(body); } catch { return null; } }).find(body => body?.operation === 'confirm');
  expect((await b.t.fetch('/federation/v1/pair', { method: 'POST', body: JSON.stringify(confirmationWire) })).status).toBe(200);
  expect(await b.t.run(ctx => ctx.db.query('transportSessions').unique())).toEqual(prior);
});

test('pair approval with a different local secret cannot create trust', async () => {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken; process.env.FEDERATION_KEY_ENCRYPTION_KEY = randomSecret();
  const a = await town('town-a', await createIdentityKeys()), b = await town('town-b', await createIdentityKeys());
  globalThis.fetch = (async (url: any, init: any) => (String(url).includes('town-a.example') ? a : b).t.fetch(new URL(String(url)).pathname, { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body })) as typeof fetch;
  const pair = await a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: randomSecret() });
  await expect(b.t.action(actionRef('peers/approvePair'), { adminToken, pairRequestId: pair.pairRequestId, pairingSecret: randomSecret() })).rejects.toThrow('AUTH_FAILED');
  expect((await b.t.run(ctx => ctx.db.query('pairRequests').unique()))?.state).toBe('AUTH_FAILED');
  expect(await b.t.run(ctx => ctx.db.query('federationPeers').collect())).toEqual([]);
});

async function freshPairingTowns() {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = randomSecret();
  const towns = { a: await town('town-a', await createIdentityKeys()), b: await town('town-b', await createIdentityKeys()) };
  globalThis.fetch = (async (url: any, init: any) => {
    const target = String(url).includes('town-a.example') ? towns.a : towns.b;
    return target.t.fetch(new URL(String(url)).pathname, { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body });
  }) as typeof fetch;
  return towns;
}

// Recreate the complete test runtime from persisted documents. No closures,
// action state or scheduler state survives; pairing must use its stored keys.
async function restartPairingTown(local: Town) {
  const tables = ['federationIdentity', 'pairRequests', 'federationPeers', 'transportSessions', 'federationReplayNonces'] as const;
  const snapshots = await local.t.run(async ctx => Promise.all(tables.map(table => ctx.db.query(table).collect())));
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    for (let index = 0; index < tables.length; index++) {
      for (const { _id, _creationTime, ...record } of snapshots[index]) await ctx.db.insert(tables[index], record as any);
    }
  });
  return { ...local, t };
}

test('inbound unread notifications persist through restart and reads never approve or expose secrets', async () => {
  const towns = await freshPairingTowns();
  const pair = await towns.a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: randomSecret() });
  towns.b = await restartPairingTown(towns.b);
  const status = await towns.b.t.query(queryRef('admin/status'), { adminToken });
  expect(status.unreadPairRequests).toBe(1);
  expect(status.pairRequests[0]).toMatchObject({ pairRequestId: pair.pairRequestId, unread: true, identityVerified: false, claimedTownId: towns.a.townId, protocol: PROTOCOL });
  expect(JSON.stringify(status)).not.toMatch(/secretEncrypted|privateKeyEncrypted|ephemeralPrivateEncrypted|credentialEncrypted|"proof"/);
  await expect(towns.b.t.mutation(mutationRef('peers/markPairRead'), { adminToken: 'incorrect', pairRequestId: pair.pairRequestId })).rejects.toThrow();
  await towns.b.t.mutation(mutationRef('peers/markPairRead'), { adminToken, pairRequestId: pair.pairRequestId });
  towns.b = await restartPairingTown(towns.b);
  expect((await towns.b.t.query(queryRef('admin/status'), { adminToken })).unreadPairRequests).toBe(0);
  expect((await towns.b.t.run(ctx => ctx.db.query('pairRequests').unique()))?.state).toBe('PENDING_APPROVAL');
  expect(await towns.b.t.run(ctx => ctx.db.query('federationPeers').collect())).toEqual([]);
  const outbound = await towns.a.t.query(queryRef('admin/status'), { adminToken });
  expect(outbound.pairRequests[0]).toMatchObject({ claimedTownId: towns.b.townId, claimedTownName: towns.b.townId, fingerprint: towns.b.keys.fingerprint, unread: false, identityVerified: false });
});

test('rejection remains queryable across both restarts, retries cool down and create a new unread request ID', async () => {
  const towns = await freshPairingTowns(), secret = randomSecret();
  const old = await towns.a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: secret });
  await towns.b.t.mutation(mutationRef('peers/rejectPair'), { adminToken, pairRequestId: old.pairRequestId });
  towns.a = await restartPairingTown(towns.a); towns.b = await restartPairingTown(towns.b);
  expect((await towns.a.t.action(actionRef('peers/continuePair'), { adminToken, pairRequestId: old.pairRequestId })).state).toBe('REJECTED');
  await expect(towns.a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: secret })).rejects.toThrow('PAIR_RATE_LIMITED');
  jest.setSystemTime(Date.now() + 60_001);
  const next = await towns.a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: secret });
  expect(next.pairRequestId).not.toBe(old.pairRequestId);
  const records = await towns.b.t.run(ctx => ctx.db.query('pairRequests').collect());
  expect(records).toHaveLength(2);
  expect(records.find(p => p.pairRequestId === old.pairRequestId)?.state).toBe('REJECTED');
  expect((await towns.b.t.query(queryRef('admin/status'), { adminToken })).unreadPairRequests).toBe(1);
  await towns.b.t.action(actionRef('peers/approvePair'), { adminToken, pairRequestId: next.pairRequestId, pairingSecret: secret });
  expect((await towns.a.t.action(actionRef('peers/continuePair'), { adminToken, pairRequestId: next.pairRequestId })).state).toBe('TRUSTED');
  for (const local of [towns.a, towns.b]) expect(await local.t.run(ctx => ctx.db.query('federationPeers').collect())).toHaveLength(1);
});

test('outbound cancellation survives a lost acknowledgement, cannot be resurrected and retries idempotently after restart', async () => {
  const towns = await freshPairingTowns(), secret = randomSecret();
  const pair = await towns.a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: secret });
  const directFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const result = await directFetch(url, init);
    if (init?.body && JSON.parse(init.body).operation === 'cancel') throw new Error('lost cancel acknowledgement');
    return result;
  }) as typeof fetch;
  await expect(towns.a.t.action(actionRef('peers/cancelPair'), { adminToken, pairRequestId: pair.pairRequestId })).rejects.toThrow('NETWORK_UNREACHABLE');
  const local = (await towns.a.t.run(ctx => ctx.db.query('pairRequests').unique()))!;
  expect(local.state).toBe('CANCEL_PENDING');
  expect(local.secretEncrypted).toBeUndefined(); expect(local.ephemeralPrivateEncrypted).toBeUndefined();
  expect((await towns.b.t.run(ctx => ctx.db.query('pairRequests').unique()))?.state).toBe('CANCELLED');
  await towns.a.t.mutation(mutationRef('peers/updatePairState'), { pairRequestId: pair.pairRequestId, state: 'PENDING_APPROVAL' });
  await expect(towns.a.t.action(actionRef('peers/continuePair'), { adminToken, pairRequestId: pair.pairRequestId })).rejects.toThrow('PAIR_NOT_PENDING');
  await expect(towns.b.t.action(actionRef('peers/approvePair'), { adminToken, pairRequestId: pair.pairRequestId, pairingSecret: secret })).rejects.toThrow('PAIR_NOT_PENDING');
  towns.a = await restartPairingTown(towns.a); towns.b = await restartPairingTown(towns.b); globalThis.fetch = directFetch;
  expect((await towns.a.t.action(actionRef('peers/cancelPair'), { adminToken, pairRequestId: pair.pairRequestId })).state).toBe('CANCELLED');
  expect((await towns.a.t.action(actionRef('peers/cancelPair'), { adminToken, pairRequestId: pair.pairRequestId })).state).toBe('CANCELLED');
  for (const town of [towns.a, towns.b]) expect(await town.t.run(ctx => ctx.db.query('federationPeers').collect())).toEqual([]);
});

test('local inbound cancellation erases an approved credential and the initiator learns the terminal result', async () => {
  const towns = await freshPairingTowns(), secret = randomSecret();
  const pair = await towns.a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: secret });
  await towns.b.t.action(actionRef('peers/approvePair'), { adminToken, pairRequestId: pair.pairRequestId, pairingSecret: secret });
  await expect(towns.b.t.action(actionRef('peers/cancelPair'), { adminToken: 'incorrect', pairRequestId: pair.pairRequestId })).rejects.toThrow();
  expect((await towns.b.t.action(actionRef('peers/cancelPair'), { adminToken, pairRequestId: pair.pairRequestId })).state).toBe('CANCELLED');
  const record = (await towns.b.t.run(ctx => ctx.db.query('pairRequests').unique()))!;
  expect(record.credentialEncrypted).toBeUndefined();
  towns.b = await restartPairingTown(towns.b);
  expect((await towns.a.t.action(actionRef('peers/continuePair'), { adminToken, pairRequestId: pair.pairRequestId })).state).toBe('CANCELLED');
  await expect(towns.b.t.mutation(mutationRef('peers/finalizePair'), { pairRequestId: pair.pairRequestId, remote: {}, credentialEncrypted: 'invalid' })).rejects.toThrow('PAIR_NOT_CONFIRMABLE');
  for (const town of [towns.a, towns.b]) expect(await town.t.run(ctx => ctx.db.query('federationPeers').collect())).toEqual([]);
});

test('cancel controls require the bound requester signature and fresh nonce, and cannot revoke trusted pairing', async () => {
  const towns = await freshPairingTowns(), secret = randomSecret();
  const pair = await towns.a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: secret });
  const body = { pairRequestId: pair.pairRequestId, townId: towns.a.townId, nonce: crypto.randomUUID(), expiresAt: Date.now() + 30_000 };
  const send = (signature: string) => towns.b.t.fetch('/federation/v1/pair', { method: 'POST', body: JSON.stringify({ operation: 'cancel', body, signature }) });
  expect((await send(await sign(body, towns.b.keys.privateKeyEncrypted))).status).toBe(400);
  expect((await towns.b.t.run(ctx => ctx.db.query('pairRequests').unique()))?.state).toBe('PENDING_APPROVAL');
  const signature = await sign(body, towns.a.keys.privateKeyEncrypted);
  expect((await send(signature)).status).toBe(200);
  expect(await (await send(signature)).json()).toMatchObject({ error: 'REPLAYED_NONCE' });
  jest.setSystemTime(Date.now() + 60_001);
  const next = await towns.a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: secret });
  await towns.b.t.action(actionRef('peers/approvePair'), { adminToken, pairRequestId: next.pairRequestId, pairingSecret: secret });
  await towns.a.t.action(actionRef('peers/continuePair'), { adminToken, pairRequestId: next.pairRequestId });
  for (const local of [towns.a, towns.b]) await expect(local.t.action(actionRef('peers/cancelPair'), { adminToken, pairRequestId: next.pairRequestId })).rejects.toThrow('PAIR_NOT_CANCELLABLE');
});

test('both-confirm waiting and a lost final response recover from persisted records after both towns restart', async () => {
  const towns = await freshPairingTowns(), secret = randomSecret();
  const pair = await towns.a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: secret });
  await towns.b.t.action(actionRef('peers/approvePair'), { adminToken, pairRequestId: pair.pairRequestId, pairingSecret: secret });
  towns.a = await restartPairingTown(towns.a); towns.b = await restartPairingTown(towns.b);
  expect((await towns.b.t.query(queryRef('admin/status'), { adminToken })).pairRequests[0].state).toBe('PENDING_BOTH_CONFIRM');
  expect(await towns.b.t.run(ctx => ctx.db.query('federationPeers').collect())).toEqual([]);
  const directFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const result = await directFetch(url, init);
    if (init?.body && JSON.parse(init.body).operation === 'confirm') throw new Error('lost final acknowledgement');
    return result;
  }) as typeof fetch;
  await expect(towns.a.t.action(actionRef('peers/continuePair'), { adminToken, pairRequestId: pair.pairRequestId })).rejects.toThrow('NETWORK_UNREACHABLE');
  expect((await towns.a.t.run(ctx => ctx.db.query('pairRequests').unique()))?.state).toBe('PENDING_BOTH_CONFIRM');
  expect((await towns.b.t.run(ctx => ctx.db.query('pairRequests').unique()))?.state).toBe('TRUSTED');
  await expect(towns.a.t.action(actionRef('peers/cancelPair'), { adminToken, pairRequestId: pair.pairRequestId })).rejects.toThrow('PAIR_NOT_CANCELLABLE');
  towns.a = await restartPairingTown(towns.a); towns.b = await restartPairingTown(towns.b); globalThis.fetch = directFetch;
  expect((await towns.a.t.action(actionRef('peers/continuePair'), { adminToken, pairRequestId: pair.pairRequestId })).state).toBe('TRUSTED');
  for (const local of [towns.a, towns.b]) expect(await local.t.run(ctx => ctx.db.query('federationPeers').collect())).toHaveLength(1);
});

test('cancellation wins over a delayed approved status and prevents any late confirmation from being sent', async () => {
  const towns = await freshPairingTowns(), secret = randomSecret();
  const pair = await towns.a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: secret });
  await towns.b.t.action(actionRef('peers/approvePair'), { adminToken, pairRequestId: pair.pairRequestId, pairingSecret: secret });
  const directFetch = globalThis.fetch;
  let releaseStatus!: () => void, statusArrived!: () => void;
  const blocked = new Promise<void>(resolve => { releaseStatus = resolve; });
  const arrived = new Promise<void>(resolve => { statusArrived = resolve; });
  let confirmations = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const operation = init?.body ? JSON.parse(init.body).operation : undefined;
    if (operation === 'confirm') confirmations++;
    const result = await directFetch(url, init);
    if (operation === 'status') { statusArrived(); await blocked; }
    return result;
  }) as typeof fetch;
  const continuing = towns.a.t.action(actionRef('peers/continuePair'), { adminToken, pairRequestId: pair.pairRequestId });
  await arrived;
  await towns.a.t.action(actionRef('peers/cancelPair'), { adminToken, pairRequestId: pair.pairRequestId });
  const failure = expect(continuing).rejects.toThrow('PAIR_NOT_CONFIRMABLE');
  releaseStatus(); await failure;
  expect(confirmations).toBe(0);
  for (const local of [towns.a, towns.b]) {
    expect((await local.t.run(ctx => ctx.db.query('pairRequests').unique()))?.state).toBe('CANCELLED');
    expect(await local.t.run(ctx => ctx.db.query('federationPeers').collect())).toEqual([]);
  }
});

test('once an outbound final confirmation is claimed stale approval cannot reopen cancellation', async () => {
  const towns = await freshPairingTowns();
  const pair = await towns.a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: randomSecret() });
  await towns.a.t.mutation(mutationRef('peers/beginConfirmation'), { pairRequestId: pair.pairRequestId });
  await towns.a.t.mutation(mutationRef('peers/updatePairState'), { pairRequestId: pair.pairRequestId, state: 'PENDING_APPROVAL' });
  expect((await towns.a.t.run(ctx => ctx.db.query('pairRequests').unique()))?.state).toBe('PENDING_BOTH_CONFIRM');
  await expect(towns.a.t.action(actionRef('peers/cancelPair'), { adminToken, pairRequestId: pair.pairRequestId })).rejects.toThrow('PAIR_NOT_CANCELLABLE');
});

test('an unreachable cancelled request can close locally after its shared deadline without recreating credentials', async () => {
  const towns = await freshPairingTowns();
  const pair = await towns.a.t.action(actionRef('peers/requestPair'), { adminToken, endpoint: 'https://town-b.example', pairingSecret: randomSecret() });
  globalThis.fetch = (async () => { throw new Error('offline peer'); }) as typeof fetch;
  await expect(towns.a.t.action(actionRef('peers/cancelPair'), { adminToken, pairRequestId: pair.pairRequestId })).rejects.toThrow('NETWORK_UNREACHABLE');
  jest.setSystemTime(Date.now() + 600_001);
  expect((await towns.a.t.action(actionRef('peers/cancelPair'), { adminToken, pairRequestId: pair.pairRequestId })).state).toBe('CANCELLED');
  const local = (await towns.a.t.run(ctx => ctx.db.query('pairRequests').unique()))!;
  expect(local.secretEncrypted).toBeUndefined(); expect(local.ephemeralPrivateEncrypted).toBeUndefined();
  await expect(towns.b.t.mutation(mutationRef('peers/finalizePair'), { pairRequestId: pair.pairRequestId, remote: {}, credentialEncrypted: 'invalid' })).rejects.toThrow('PAIR_NOT_CONFIRMABLE');
});

test('resync retries a ledger snapshot after cleanup and resets only the terminated stream', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home'); await seedVisit(b, a, 'host');
  const gap = visitMessage(b, a, 'VISIT_ACTIVE', 18, 'host-results', { payload: { fencingToken: 'test-fencing-token-32bytes', hostPlayerId: 'p:9' } });
  expect((await accept(a, gap)).status).toBe('RESYNC_REQUIRED');
  const request = (await a.t.run(ctx => ctx.db.query('federationOutbox').collect())).find(o => o.envelope.type === 'SESSION_RESYNC')!.envelope;
  await accept(b, request);
  expect((await b.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('REMOVING');
  await b.t.run(ctx => hostRemoved(ctx, 'visit-1'));
  jest.setSystemTime(Date.now() + 30001);
  await a.t.mutation(mutationRef('transport/maintenance'), {});
  const requests = (await a.t.run(ctx => ctx.db.query('federationOutbox').collect())).filter(o => o.envelope.type === 'SESSION_RESYNC');
  expect(requests).toHaveLength(2);
  await accept(b, requests[1].envelope);
  const snapshots = (await b.t.run(ctx => ctx.db.query('federationOutbox').collect())).filter(o => o.envelope.type === 'SESSION_RESYNC');
  await accept(a, snapshots[1].envelope);
  const cursor = await a.t.run(ctx => ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', streamKey(gap, b.townId))).unique());
  expect(cursor?.resyncState).toBe('ABORTED');
  expect((await a.t.run(ctx => ctx.db.query('visitLedger').unique()))?.cleanupConfirmed).toBe(true);
  expect((await a.t.run(ctx => ctx.db.query('federationInbox').withIndex('messageId', q => q.eq('messageId', gap.messageId)).unique()))?.status).toBe('DISCARDED');
});

test('expired Host leases still occupy a physical slot until removal is confirmed', async () => {
  const { a, b } = await setup(); await markReady(b, a); await seedVisit(b, a, 'host');
  await b.t.run(async ctx => {
    const l = (await ctx.db.query('visitLedger').unique())!;
    await ctx.db.patch(l._id, { leaseExpiry: Date.now() - 1, state: 'REMOVING' });
    await ctx.db.insert('visitReservations', { visitId: 'visit-1', hostTownId: b.townId, reservedSlot: true, expiresAt: Date.now() - 1 });
  });
  const reserve = visitMessage(a, b, 'VISIT_RESERVE', 1, 'lease-control', { visitId: 'visit-new', agentGlobalId: 'town-a/agent:new', payload: { fencingToken: 'test-fencing-token-32bytes', leaseExpiry: Date.now() + 250000, profile: { name: 'Alice', character: 'f1', description: 'Resident', homeTownName: 'Town A' } } });
  await accept(b, reserve);
  expect((await b.t.run(ctx => ctx.db.query('visitLedger').withIndex('visitId', q => q.eq('visitId', 'visit-new')).unique()))?.lastError).toBe('HOST_CAPACITY_EXCEEDED');
});

test('full Outbox cannot roll back local termination or increment an unsent stream sequence', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home');
  await a.t.run(async ctx => {
    for (let index = 0; index < 1000; index++) await ctx.db.insert('federationOutbox', { messageId: `full-${index}`, toTownId: b.townId, envelope: { type: 'OBSERVATION' }, attempts: 0, nextRetryAt: Date.now() + 60000 });
  });
  await a.t.mutation(mutationRef('ledger/returnVisit'), { adminToken, visitId: 'visit-1' });
  const ledger = await a.t.run(ctx => ctx.db.query('visitLedger').unique());
  expect(ledger?.state).toBe('RETURN_PENDING'); expect(ledger?.lastError).toBe('OUTBOX_CAPACITY_EXCEEDED');
  expect(await a.t.run(ctx => ctx.db.query('messageStreamCursors').collect())).toEqual([]);
  await expect(a.t.run(ctx => homeResumed(ctx, 'visit-1'))).rejects.toThrow('HOST_LEASE_STILL_VALID');
});

test('a local endpoint change also fences an in-flight probe response', async () => {
  const { a, b } = await setup();
  globalThis.fetch = (async (_url: any, init: any) => {
    const response = await b.t.action(actionRef('transport/receiveProbe'), { packet: JSON.parse(init.body) });
    await a.t.mutation(mutationRef('admin/updateLocalEndpoint'), { adminToken, endpoint: 'https://new-a.example' });
    return new Response(JSON.stringify(response));
  }) as typeof fetch;
  expect(await a.t.action(actionRef('transport/probeInternal'), { peerTownId: b.townId })).toEqual({ channelState: 'TRANSPORT_TESTING' });
  expect(await a.t.run(ctx => ctx.db.query('transportSessions').collect())).toEqual([]);
});

test.each(['OBSERVATION', 'DECISION', 'ACTION_RESULT'])(
  'terminal visit %s stops without a fake ACK, provider call, or channel degradation', async (type) => {
    const { a, b } = await setup();
    await seedVisit(a, b, 'home', 'COMPLETED'); await markReady(a, b);
    const id = await a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type, visitId: 'visit-1', payload: {} }));
    const fetchMock = jest.fn<typeof fetch>(); globalThis.fetch = fetchMock;
    await a.t.action(actionRef('transport/deliver'), { messageId: id });
    await a.t.action(actionRef('transport/deliver'), { messageId: id });
    const item = (await a.t.run(ctx => ctx.db.query('federationOutbox').unique()))!;
    expect(item.failedAt).toBeDefined(); expect(item.ackedAt).toBeUndefined();
    expect(item.lastError).toBe('OUTBOX_VISIT_TERMINATED'); expect(item.attempts).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await a.t.query(queryRef('transport/pendingDeliveries'), {})).toEqual([]);
    expect((await a.t.run(ctx => ctx.db.query('transportSessions').unique()))?.channelState).toBe('TRANSPORT_READY');
    expect((await a.t.run(ctx => ctx.db.query('messageStreamCursors').unique()))?.lastAckedSequence).toBe(0);
  },
);

test.each(['lease', 'authority', 'leaseVersion'])(
  'runtime message with obsolete %s is audited and never sent', async (fence) => {
    const { a, b } = await setup(); await seedVisit(a, b, 'home'); await markReady(a, b);
    const id = await a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'DECISION', visitId: 'visit-1', payload: {} }));
    await a.t.run(async ctx => {
      const ledger = (await ctx.db.query('visitLedger').unique())!;
      await ctx.db.patch(ledger._id, fence === 'lease' ? { leaseExpiry: Date.now() - 1 }
        : fence === 'authority' ? { agentAuthorityEpoch: 3 } : { visitLeaseVersion: 2 });
    });
    const fetchMock = jest.fn<typeof fetch>(); globalThis.fetch = fetchMock;
    await a.t.action(actionRef('transport/deliver'), { messageId: id });
    const item = (await a.t.run(ctx => ctx.db.query('federationOutbox').unique()))!;
    expect(item.failedAt).toBeDefined(); expect(item.ackedAt).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await a.t.run(ctx => ctx.db.query('transportSessions').unique()))?.channelState).toBe('TRANSPORT_READY');
  },
);

test.each(['http', 'network'])(
  'active valid runtime %s failures retain retry and degrade the channel', async (failure) => {
    const { a, b } = await setup(); await seedVisit(a, b, 'home'); await markReady(a, b);
    const id = await a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'ACTION_RESULT', visitId: 'visit-1', payload: {} }));
    const fetchMock = jest.fn<typeof fetch>().mockImplementation(() => failure === 'http'
      ? Promise.resolve(new Response('{"error":"VISIT_NOT_ACTIVE"}', { status: 400 }))
      : Promise.reject(new Error('NETWORK_UNREACHABLE')));
    globalThis.fetch = fetchMock;
    await a.t.action(actionRef('transport/deliver'), { messageId: id });
    const item = (await a.t.run(ctx => ctx.db.query('federationOutbox').unique()))!;
    expect(item.failedAt).toBeUndefined(); expect(item.ackedAt).toBeUndefined();
    expect(item.lastError).toBe(failure === 'http' ? 'FEDERATION_HTTP_400' : 'NETWORK_UNREACHABLE');
    expect((await a.t.run(ctx => ctx.db.query('transportSessions').unique()))?.channelState).toBe('TRANSPORT_DEGRADED');
    await jest.advanceTimersByTimeAsync(1001);
    expect(await a.t.query(queryRef('transport/pendingDeliveries'), {})).toContain(id);
  },
);

test.each(['VISIT_RETURN', 'VISIT_CLEANED', 'CONVERSATION_ENDED'])(
  'terminal visits retain reliable retries of %s', async (type) => {
    const { a, b } = await setup(); await seedVisit(a, b, 'home', 'COMPLETED'); await markReady(a, b);
    const id = await a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type, visitId: 'visit-1', payload: {} }));
    const fetchMock = jest.fn<typeof fetch>().mockRejectedValue(new Error('NETWORK_UNREACHABLE'));
    globalThis.fetch = fetchMock;
    await a.t.action(actionRef('transport/deliver'), { messageId: id });
    const item = (await a.t.run(ctx => ctx.db.query('federationOutbox').unique()))!;
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(item.failedAt).toBeUndefined();
    expect(item.ackedAt).toBeUndefined(); expect(item.lastError).toBe('NETWORK_UNREACHABLE');
  },
);

test('a visit ending during a failed in-flight request is rechecked before degrading its channel', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home'); await markReady(a, b);
  const id = await a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'ACTION_RESULT', visitId: 'visit-1', payload: {} }));
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async () => {
    await a.t.run(async ctx => { const ledger = (await ctx.db.query('visitLedger').unique())!; await ctx.db.patch(ledger._id, { state: 'COMPLETED' }); });
    return new Response('{}', { status: 400 });
  });
  await a.t.action(actionRef('transport/deliver'), { messageId: id });
  const item = (await a.t.run(ctx => ctx.db.query('federationOutbox').unique()))!;
  expect(item.failedAt).toBeDefined(); expect(item.ackedAt).toBeUndefined();
  expect(item.lastError).toBe('OUTBOX_VISIT_TERMINATED:FEDERATION_HTTP_400');
  expect((await a.t.run(ctx => ctx.db.query('transportSessions').unique()))?.channelState).toBe('TRANSPORT_READY');
});

test.each(['EXPIRED', 'STALE_SEQUENCE'])(
  '%s stops retry with failedAt and preserves active visit return recovery without faking ACK', async (status) => {
    const { a, b } = await setup(); await seedVisit(a, b, 'home');
    const id = await a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'DECISION', visitId: 'visit-1', payload: {} }));
    await a.t.mutation(mutationRef('transport/markDelivery'), { messageId: id, status });
    const item = (await a.t.run(ctx => ctx.db.query('federationOutbox').withIndex('messageId', q => q.eq('messageId', id)).unique()))!;
    expect(item.failedAt).toBeDefined(); expect(item.ackedAt).toBeUndefined(); expect(item.lastError).toBe(status);
    expect(await a.t.query(queryRef('transport/pendingDeliveries'), {})).not.toContain(id);
    expect((await a.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('RETURN_PENDING');
    expect((await a.t.run(ctx => ctx.db.query('federationOutbox').collect())).some(o => o.envelope.type === 'VISIT_RETURN')).toBe(true);
  },
);

test('a NACK for failed durable runtime history preserves failure audit and requests resync', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home');
  const id = await a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'DECISION', visitId: 'visit-1', payload: {} }));
  await a.t.run(async ctx => {
    const item = (await ctx.db.query('federationOutbox').unique())!;
    await ctx.db.patch(item._id, { failedAt: Date.now(), lastError: 'EXPIRED' });
  });
  await accept(a, message(b, a, 'STREAM_NACK', {
    visitId: 'visit-1', agentGlobalId: 'town-a/agent:test', agentAuthorityEpoch: 2, visitLeaseVersion: 1,
    payload: { streamId: 'home-actions', expectedSequence: 1, receivedSequence: 2 },
  }));
  const rows = await a.t.run(ctx => ctx.db.query('federationOutbox').collect());
  expect(rows.find(o => o.messageId === id)?.failedAt).toBeDefined();
  expect(rows.some(o => o.envelope.type === 'SESSION_RESYNC')).toBe(true);
  expect((await a.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('RETURN_PENDING');
});

test('failed audit rows no longer consume pending Outbox capacity', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home');
  await a.t.run(async ctx => {
    for (let index = 0; index < 900; index++) await ctx.db.insert('federationOutbox', {
      messageId: `failed-${index}`, toTownId: b.townId, envelope: { type: 'DECISION' },
      attempts: 1, nextRetryAt: Date.now(), failedAt: Date.now(), lastError: 'OUTBOX_VISIT_TERMINATED',
    });
  });
  await expect(a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'DECISION', visitId: 'visit-1', payload: {} }))).resolves.toEqual(expect.any(String));
  expect(await a.t.query(queryRef('transport/pendingDeliveries'), {})).toHaveLength(1);
});

test('backup delivery challenges the trusted identity and reuses the event ID after a lost primary ACK', async () => {
  const { a, b } = await setup();
  await seedVisit(a, b, 'home', 'CONFIRMING'); await seedVisit(b, a, 'host');
  const primary = 'https://town-b.example/federation/v1', backup = 'https://town-b-backup.example/federation/v1';
  await a.t.run(async ctx => {
    const remote = (await ctx.db.query('federationPeers').first())!;
    await ctx.db.patch(remote._id, { endpointCandidates: [{ url: primary, priority: 10 }, { url: backup, priority: 20 }], endpointGeneration: 3 });
  });
  const id = await a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'VISIT_CONFIRM', visitId: 'visit-1', payload: { fencingToken: 'test-fencing-token-32bytes' } }));
  const attempts: { url: string; messageId: string; type: string }[] = [];
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const packet = JSON.parse(init!.body as string);
    attempts.push({ url: String(url), messageId: packet.body.messageId, type: packet.body.type });
    const result = await b.t.action(actionRef(String(url).endsWith('/probe') ? 'transport/receiveProbe' : 'transport/receiveMessage'), { packet });
    if (String(url) === `${primary}/messages`) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return new Response(JSON.stringify(result));
  });
  await a.t.action(actionRef('transport/deliver'), { messageId: id });
  expect(attempts.map(attempt => attempt.url)).toEqual([`${primary}/messages`, `${backup}/probe`, `${backup}/messages`]);
  expect(attempts.filter(attempt => attempt.type === 'VISIT_CONFIRM').map(attempt => attempt.messageId)).toEqual([id, id]);
  expect((await a.t.run(ctx => ctx.db.query('federationOutbox').first()))?.ackedAt).toBeDefined();
  expect(await b.t.run(ctx => ctx.db.query('federationInbox').collect())).toHaveLength(1);
  expect((await a.t.run(ctx => ctx.db.query('federationPeers').first()))?.endpointGeneration).toBe(3);
});

test('clock lock accepts expired signed cleanup only under the original identity and authority fences', async () => {
  const { a, b, credentialEncrypted } = await setup();
  await seedVisit(a, b, 'home', 'RETURN_PENDING');
  await a.t.run(async ctx => {
    const clock = (await ctx.db.query('federationClock').unique())!;
    await ctx.db.patch(clock._id, { observedAt: Date.now(), uncertain: true, reason: 'CLOCK_MOVED_BACKWARDS' });
  });
  const cleaned = visitMessage(b, a, 'VISIT_CLEANED', 1, 'lease-control', { sentAt: Date.now() - 100000, expiresAt: Date.now() - 50000 });
  const packet = await signPacket(cleaned, b.keys.privateKeyEncrypted, credentialEncrypted);
  const forged = { ...packet, mac: 'forged' };
  await expect(a.t.action(actionRef('transport/receiveMessage'), { packet: forged })).rejects.toThrow('MESSAGE_AUTH_FAILED');
  for (const [field, error] of [['senderDeploymentEpoch', 'SENDER_DEPLOYMENT_MISMATCH'], ['expectedRecipientDeploymentEpoch', 'RECIPIENT_DEPLOYMENT_MISMATCH'], ['agentAuthorityEpoch', 'STALE_AGENT_AUTHORITY'], ['visitLeaseVersion', 'STALE_VISIT_LEASE']] as const) {
    await expect(accept(a, { ...cleaned, [field]: 99 })).rejects.toThrow(error);
  }
  const ack = await a.t.action(actionRef('transport/receiveMessage'), { packet });
  expect(ack.body.status).toBe('COMMITTED');
  expect((await a.t.run(ctx => ctx.db.query('visitLedger').unique()))?.cleanupConfirmed).toBe(true);
  expect((await a.t.action(actionRef('transport/receiveMessage'), { packet })).body.status).toBe('COMMITTED');
  expect(await a.t.run(ctx => ctx.db.query('federationInbox').collect())).toHaveLength(1);
  const changed = await signPacket({ ...cleaned, payload: { ...cleaned.payload, reason: 'changed' } }, b.keys.privateKeyEncrypted, credentialEncrypted);
  await expect(a.t.action(actionRef('transport/receiveMessage'), { packet: changed })).rejects.toThrow('MESSAGE_ID_CONFLICT');
  const action = visitMessage(b, a, 'DECISION', 1, 'home-actions', { sentAt: cleaned.sentAt, expiresAt: cleaned.expiresAt });
  await expect(a.t.action(actionRef('transport/receiveMessage'), { packet: await signPacket(action, b.keys.privateKeyEncrypted, credentialEncrypted) })).rejects.toThrow('MESSAGE_EXPIRED');
});

test('durable history progress distinguishes an issued page from confirmed remote commitment', async () => {
  const { a, b } = await setup(); await seedVisit(b, a, 'host', 'COMPLETED');
  const id = await b.t.run(ctx => enqueueMessage(ctx, { peerTownId: a.townId, type: 'CONVERSATION_ENDED', visitId: 'visit-1', payload: {} }));
  let ledger = (await b.t.run(ctx => ctx.db.query('visitLedger').unique()))!;
  expect(ledger.lastDurableEventSeq).toBe(1); expect(ledger.lastAckedEventSeq).toBeUndefined();
  await b.t.mutation(mutationRef('transport/markDelivery'), { messageId: id, status: 'BUFFERED' });
  expect((await b.t.run(ctx => ctx.db.query('visitLedger').unique()))?.lastAckedEventSeq).toBeUndefined();
  await b.t.mutation(mutationRef('transport/markDelivery'), { messageId: id, status: 'COMMITTED' });
  ledger = (await b.t.run(ctx => ctx.db.query('visitLedger').unique()))!;
  expect(ledger.lastDurableEventSeq).toBe(1); expect(ledger.lastAckedEventSeq).toBe(1);
});

test('an alternate host with an invalid identity proof receives no business message and does not trigger further fallback', async () => {
  const { a, b } = await setup();
  await seedVisit(a, b, 'home', 'CONFIRMING'); await seedVisit(b, a, 'host');
  const primary = 'https://town-b.example/federation/v1', backup = 'https://town-b-backup.example/federation/v1', third = 'https://town-b-third.example/federation/v1';
  await a.t.run(async ctx => {
    const remote = (await ctx.db.query('federationPeers').first())!;
    await ctx.db.patch(remote._id, { endpointCandidates: [{ url: primary, priority: 10 }, { url: backup, priority: 20 }, { url: third, priority: 30 }] });
  });
  const id = await a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'VISIT_CONFIRM', visitId: 'visit-1', payload: { fencingToken: 'test-fencing-token-32bytes' } }));
  const urls: string[] = [];
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (url, init) => {
    urls.push(String(url));
    if (String(url) === `${primary}/messages`) throw new TypeError('fetch failed');
    const ack = await b.t.action(actionRef('transport/receiveProbe'), { packet: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ...ack, signature: await sign(ack.body, a.keys.privateKeyEncrypted) }));
  });
  await a.t.action(actionRef('transport/deliver'), { messageId: id });
  expect(urls).toEqual([`${primary}/messages`, `${backup}/probe`]);
  const outbox = (await a.t.run(ctx => ctx.db.query('federationOutbox').first()))!;
  expect(outbox.ackedAt).toBeUndefined(); expect(outbox.lastError).toBe('ENDPOINT_IDENTITY_UNVERIFIED');
  expect(await b.t.run(ctx => ctx.db.query('federationInbox').collect())).toHaveLength(0);
});

test('maintenance stays within read limits and its scheduled pages reach the final session', async () => {
  const { a } = await setup({ documentsRead: 1200 });
  await a.t.run(async ctx => {
    for (let index = 0; index < 1800; index++) {
      await ctx.db.insert('transportSessions', { peerTownId: `historical-peer-${index}`, channelState: 'TRANSPORT_READY', transportType: 'DIRECT_HTTPS', localDeploymentEpoch: 1, verifiedPeerDeploymentEpoch: 1, outboundVerifiedAt: 1, inboundVerifiedAt: 1 });
      await ctx.db.insert('messageStreamCursors', { streamKey: `historical-stream-${index}`, peerTownId: 'historical-peer', visitIdOrPairSessionId: `historical-visit-${index}`, streamId: 'host-results', senderTownId: 'historical-peer', senderDeploymentEpoch: 1, direction: 'inbound', nextExpectedSequence: 1, nextOutgoingSequence: 1, lastAckedSequence: 0, resyncState: 'ABORTED' });
    }
  });
  await expect(a.t.run(ctx => ctx.db.query('transportSessions').collect())).rejects.toThrow('Scanned too many documents');
  await expect(a.t.run(ctx => ctx.db.query('messageStreamCursors').collect())).rejects.toThrow('Scanned too many documents');
  await a.t.mutation(mutationRef('transport/maintenance'), {});
  expect((await a.t.run(ctx => ctx.db.query('transportSessions').withIndex('peerTownId', q => q.eq('peerTownId', 'historical-peer-1799')).unique()))?.channelState).toBe('TRANSPORT_READY');
  await a.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect((await a.t.run(ctx => ctx.db.query('transportSessions').withIndex('peerTownId', q => q.eq('peerTownId', 'historical-peer-1799')).unique()))?.channelState).toBe('TRANSPORT_TESTING');
  let cursor: string | null = null, maintained = 0;
  do {
    const page = await a.t.run(ctx => ctx.db.query('transportSessions').paginate({ cursor, numItems: 500 }));
    expect(page.page.every(connection => connection.channelState === 'TRANSPORT_TESTING')).toBe(true);
    maintained += page.page.length; cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  expect(maintained).toBe(1800);
}, 30000);

test('resync snapshots use the current deployment stream and preserve the latest 100 committed IDs under read limits', async () => {
  const { a, b } = await setup({ documentsRead: 1200, bytesRead: 256 * 1024 }); await seedVisit(a, b, 'home');
  await a.t.run(async ctx => {
    for (let index = 0; index < 1500; index++) {
      await ctx.db.insert('messageStreamCursors', { streamKey: `historical-${index}`, peerTownId: b.townId, visitIdOrPairSessionId: `old-${index}`, streamId: 'host-results', senderTownId: a.townId, senderDeploymentEpoch: 1, direction: 'outbound', nextExpectedSequence: 1, nextOutgoingSequence: 99, lastAckedSequence: 0, resyncState: 'OK' });
      await ctx.db.insert('federationInbox', { messageId: `historical-${index}`, fromTownId: b.townId, payloadDigest: 'historical', envelope: { visitId: `old-${index}` }, status: 'COMMITTED', receivedAt: Date.now() });
    }
    for (const epoch of [0, 1]) await ctx.db.insert('messageStreamCursors', { streamKey: streamKey(visitMessage(a, b, 'ACTION_RESULT', 1, 'host-results', { senderDeploymentEpoch: epoch }), b.townId), peerTownId: b.townId, visitIdOrPairSessionId: 'visit-1', streamId: 'host-results', senderTownId: a.townId, senderDeploymentEpoch: epoch, direction: 'outbound', nextExpectedSequence: 1, nextOutgoingSequence: epoch === 1 ? 42 : 99, lastAckedSequence: 0, resyncState: 'OK' });
    for (let index = 0; index < 170; index++) await ctx.db.insert('federationInbox', { messageId: `visit-committed-${index}`, fromTownId: b.townId, payloadDigest: 'committed', envelope: { visitId: 'visit-1' }, status: 'COMMITTED', receivedAt: Date.now() });
    for (let index = 0; index < 120; index++) await ctx.db.insert('federationInbox', { messageId: `visit-rejected-${index}`, fromTownId: b.townId, payloadDigest: 'rejected', envelope: { visitId: 'visit-1' }, status: 'REJECTED', receivedAt: Date.now() });
  });
  const expected = (await a.t.run(ctx => ctx.db.query('federationInbox').withIndex('visit', q => q.eq('envelope.visitId', 'visit-1')).collect())).filter(row => row.status === 'COMMITTED').slice(-100).map(row => row.messageId);
  await accept(a, visitMessage(b, a, 'SESSION_RESYNC', 1, 'host-results', { sequence: undefined, streamId: undefined, payload: { mode: 'request', streamId: 'host-results' } }));
  const response = (await a.t.run(ctx => ctx.db.query('federationOutbox').withIndex('visit', q => q.eq('envelope.visitId', 'visit-1')).collect())).find(row => row.envelope.type === 'SESSION_RESYNC')!;
  expect(response.envelope.payload.nextOutgoingSequence).toBe(42);
  expect(response.envelope.payload.committedMessageIds).toEqual(expected);
  expect(expected).toHaveLength(100);
});

test('old deployment snapshots cannot abort a current stream and safe snapshots leave other epochs and streams untouched', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home');
  await a.t.run(async ctx => {
    const remote = (await ctx.db.query('federationPeers').unique())!, ledger = (await ctx.db.query('visitLedger').unique())!;
    await ctx.db.patch(remote._id, { deploymentEpoch: 2 }); await ctx.db.patch(ledger._id, { hostDeploymentEpoch: 2 });
  });
  const current = visitMessage(b, a, 'VISIT_ACTIVE', 18, 'host-results', { senderDeploymentEpoch: 2, payload: { fencingToken: 'test-fencing-token-32bytes', hostPlayerId: 'p:9' } });
  await accept(a, current);
  const old = { ...current, messageId: 'old-epoch-buffered', senderDeploymentEpoch: 1 };
  const other = { ...current, messageId: 'other-stream-buffered', streamId: 'host-history' };
  for (const msg of [old, other]) await a.t.run(async ctx => {
    await ctx.db.insert('messageStreamCursors', { streamKey: streamKey(msg, b.townId), peerTownId: b.townId, visitIdOrPairSessionId: msg.visitId!, streamId: msg.streamId!, senderTownId: b.townId, senderDeploymentEpoch: msg.senderDeploymentEpoch, direction: 'inbound', nextExpectedSequence: 1, nextOutgoingSequence: 1, lastAckedSequence: 0, resyncState: 'OK', gapSince: Date.now() });
    await ctx.db.insert('federationInbox', { messageId: msg.messageId, fromTownId: b.townId, payloadDigest: await digest(msg), envelope: msg, status: 'BUFFERED', receivedAt: Date.now() });
  });
  const snapshot = visitMessage(b, a, 'SESSION_RESYNC', 1, 'host-results', { sequence: undefined, streamId: undefined, senderDeploymentEpoch: 2, payload: { mode: 'snapshot', streamId: 'host-results', state: 'COMPLETED', role: 'host', cleanupConfirmed: true, agentAuthorityEpoch: 2, visitLeaseVersion: 1, nextOutgoingSequence: 42, committedMessageIds: [] } });
  await expect(accept(a, { ...snapshot, senderDeploymentEpoch: 1 })).rejects.toThrow('SENDER_DEPLOYMENT_MISMATCH');
  expect((await a.t.run(ctx => ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', streamKey(current, b.townId))).unique()))?.resyncState).toBe('RESYNC_REQUIRED');
  await accept(a, snapshot);
  const cursor = await a.t.run(ctx => ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', streamKey(current, b.townId))).unique());
  expect(cursor?.resyncState).toBe('ABORTED'); expect(cursor?.nextExpectedSequence).toBe(42);
  expect((await a.t.run(ctx => ctx.db.query('federationInbox').withIndex('messageId', q => q.eq('messageId', current.messageId)).unique()))?.status).toBe('DISCARDED');
  for (const msg of [old, other]) {
    expect((await a.t.run(ctx => ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', streamKey(msg, b.townId))).unique()))?.resyncState).toBe('OK');
    expect((await a.t.run(ctx => ctx.db.query('federationInbox').withIndex('messageId', q => q.eq('messageId', msg.messageId)).unique()))?.status).toBe('BUFFERED');
  }
});

test('NACK replay reads only its authenticated epoch range despite large retained Outbox history', async () => {
  const { a, b } = await setup({ documentsRead: 1200, bytesRead: 256 * 1024 }); await seedVisit(a, b, 'home');
  const messages = [1, 2].map(sequence => visitMessage(a, b, 'DECISION', sequence, 'home-actions'));
  await a.t.run(async ctx => {
    for (let index = 0; index < 1500; index++) await ctx.db.insert('federationOutbox', { messageId: `old-${index}`, toTownId: b.townId, envelope: { visitId: 'visit-1', streamId: 'home-actions', senderDeploymentEpoch: 0, sequence: 1, expiresAt: Date.now() + 300000 }, attempts: 1, nextRetryAt: Date.now(), ackedAt: Date.now() });
    for (const envelope of messages) await ctx.db.insert('federationOutbox', { messageId: envelope.messageId, toTownId: b.townId, envelope, attempts: 1, nextRetryAt: Date.now() + 60000, ackedAt: Date.now() });
  });
  await accept(a, visitMessage(b, a, 'STREAM_NACK', 1, 'home-actions', { sequence: undefined, streamId: undefined, payload: { streamId: 'home-actions', expectedSequence: 1, receivedSequence: 3 } }));
  for (const envelope of messages) {
    const row = await a.t.run(ctx => ctx.db.query('federationOutbox').withIndex('messageId', q => q.eq('messageId', envelope.messageId)).unique());
    expect(row?.ackedAt).toBeUndefined(); expect(row?.nextRetryAt).toBe(Date.now());
  }
  expect((await a.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('ACTIVE');
  expect((await a.t.run(ctx => ctx.db.query('federationOutbox').withIndex('messageId', q => q.eq('messageId', 'old-1499')).unique()))?.ackedAt).toBeDefined();
});

test('duplicate NACK sequence rows never substitute for missing durable history', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home');
  await a.t.run(async ctx => {
    for (let index = 0; index < 2; index++) {
      const envelope = visitMessage(a, b, 'DECISION', 1, 'home-actions');
      await ctx.db.insert('federationOutbox', { messageId: envelope.messageId, toTownId: b.townId, envelope, attempts: 1, nextRetryAt: Date.now() + 60000, ackedAt: Date.now() });
    }
  });
  await accept(a, visitMessage(b, a, 'STREAM_NACK', 1, 'home-actions', { sequence: undefined, streamId: undefined, payload: { streamId: 'home-actions', expectedSequence: 1, receivedSequence: 3 } }));
  expect((await a.t.run(ctx => ctx.db.query('visitLedger').unique()))?.state).toBe('RETURN_PENDING');
  expect((await a.t.run(ctx => ctx.db.query('federationOutbox').withIndex('visit', q => q.eq('envelope.visitId', 'visit-1')).collect())).some(row => row.envelope.type === 'SESSION_RESYNC')).toBe(true);
});

test('timed-out streams recover in separate transactions and full Outbox retains the safe retry fence', async () => {
  const { a, b } = await setup({ documentsRead: 3000 });
  for (let index = 0; index < 4; index++) await seedVisit(a, b, 'home', 'ACTIVE', `gap-visit-${index}`);
  await a.t.run(async ctx => {
    for (let index = 0; index < 700; index++) await ctx.db.insert('federationOutbox', { messageId: `pending-${index}`, toTownId: b.townId, envelope: { type: 'OBSERVATION' }, attempts: 0, nextRetryAt: Date.now() + 60000 });
    for (let index = 0; index < 1500; index++) await ctx.db.insert('messageStreamCursors', { streamKey: `past-${index}`, peerTownId: b.townId, visitIdOrPairSessionId: `past-${index}`, streamId: 'host-results', senderTownId: b.townId, senderDeploymentEpoch: 1, direction: 'inbound', nextExpectedSequence: 1, nextOutgoingSequence: 1, lastAckedSequence: 0, resyncState: 'ABORTED' });
    for (let index = 0; index < 4; index++) {
      const msg = visitMessage(b, a, 'VISIT_ACTIVE', 2, 'host-results', { messageId: `gap-message-${index}`, visitId: `gap-visit-${index}` });
      await ctx.db.insert('messageStreamCursors', { streamKey: streamKey(msg, b.townId), peerTownId: b.townId, visitIdOrPairSessionId: msg.visitId!, streamId: msg.streamId!, senderTownId: b.townId, senderDeploymentEpoch: 1, direction: 'inbound', nextExpectedSequence: 1, nextOutgoingSequence: 1, lastAckedSequence: 0, resyncState: 'OK', gapSince: Date.now() - 30001 });
      await ctx.db.insert('federationInbox', { messageId: msg.messageId, fromTownId: b.townId, payloadDigest: await digest(msg), envelope: msg, status: 'BUFFERED', receivedAt: Date.now() + index });
    }
  });
  await a.t.mutation(mutationRef('transport/maintenance'), {});
  const recoveryJobs = (await a.t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())).filter(job => job.name.endsWith(':retryStreamGap'));
  expect(recoveryJobs).toHaveLength(3);
  for (const job of recoveryJobs) await a.t.mutation(mutationRef('transport/retryStreamGap'), job.args[0]);
  for (let index = 0; index < 4; index++) {
    const ledger = await a.t.run(ctx => ctx.db.query('visitLedger').withIndex('visitId', q => q.eq('visitId', `gap-visit-${index}`)).unique());
    expect(ledger?.state).toBe('RETURN_PENDING'); expect(ledger?.cleanupConfirmed).toBeUndefined();
    const cursor = await a.t.run(ctx => ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', streamKey(visitMessage(b, a, 'VISIT_ACTIVE', 2, 'host-results', { visitId: `gap-visit-${index}` }), b.townId))).unique());
    expect(cursor?.resyncState).toBe('RESYNC_REQUIRED'); expect(cursor?.nextExpectedSequence).toBe(1); expect(cursor?.gapSince).toBe(Date.now());
  }
  await a.t.run(async ctx => {
    for (let index = 708; index < 1000; index++) await ctx.db.insert('federationOutbox', { messageId: `full-${index}`, toTownId: b.townId, envelope: { type: 'OBSERVATION' }, attempts: 0, nextRetryAt: Date.now() + 60000 });
  });
  jest.setSystemTime(Date.now() + 30001);
  await a.t.mutation(mutationRef('transport/retryStreamGap'), { messageId: 'gap-message-0' });
  const key = streamKey(visitMessage(b, a, 'VISIT_ACTIVE', 2, 'host-results', { visitId: 'gap-visit-0' }), b.townId);
  const cursor = await a.t.run(ctx => ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', key)).unique());
  expect(cursor?.resyncState).toBe('RESYNC_REQUIRED'); expect(cursor?.nextExpectedSequence).toBe(1);
  expect((await a.t.run(ctx => ctx.db.query('federationInbox').withIndex('messageId', q => q.eq('messageId', 'gap-message-0')).unique()))?.status).toBe('BUFFERED');
  await a.t.run(async ctx => {
    for (const messageId of ['pending-0', 'pending-1']) {
      const row = (await ctx.db.query('federationOutbox').withIndex('messageId', q => q.eq('messageId', messageId)).unique())!;
      await ctx.db.patch(row._id, { failedAt: Date.now() });
    }
  });
  jest.setSystemTime(Date.now() + 30001);
  await a.t.mutation(mutationRef('transport/retryStreamGap'), { messageId: 'gap-message-0' });
  expect((await a.t.run(ctx => ctx.db.query('federationOutbox').withIndex('visit', q => q.eq('envelope.visitId', 'gap-visit-0')).collect())).filter(row => row.envelope.type === 'SESSION_RESYNC')).toHaveLength(2);
});

test('priority delivery crosses the ordinary first page and selects the oldest due priority globally', async () => {
  const { a, b } = await setup({ documentsRead: 1200 });
  const priorityTypes = ['VISIT_RETURN', 'VISIT_CLEANED', 'VISIT_REJECT', 'VISIT_RENEW', 'CONVERSATION_ENDED', 'SESSION_RESYNC', 'STREAM_NACK'];
  await a.t.run(async ctx => {
    for (let index = 0; index < 1500; index++) await ctx.db.insert('federationOutbox', { messageId: `audit-${index}`, toTownId: b.townId, envelope: { type: 'VISIT_CLEANED' }, attempts: 1, nextRetryAt: Date.now() - 100000, ackedAt: Date.now() });
    for (let index = 0; index < 100; index++) await ctx.db.insert('federationOutbox', { messageId: `ordinary-${index}`, toTownId: b.townId, envelope: { type: 'OBSERVATION' }, attempts: 0, nextRetryAt: Date.now() - 60000 + index });
    for (const type of priorityTypes) await ctx.db.insert('federationOutbox', { messageId: type, toTownId: b.townId, envelope: { type }, attempts: 0, nextRetryAt: Date.now() - 1 });
    await ctx.db.insert('federationOutbox', { messageId: 'failed-priority', toTownId: b.townId, envelope: { type: 'VISIT_RETURN' }, attempts: 1, nextRetryAt: Date.now() - 90000, failedAt: Date.now() });
    await ctx.db.insert('federationOutbox', { messageId: 'future-priority', toTownId: b.townId, envelope: { type: 'VISIT_RETURN' }, attempts: 0, nextRetryAt: Date.now() + 1 });
  });
  const selected = await a.t.query(queryRef('transport/pendingDeliveries'), {});
  expect(selected).toHaveLength(20); expect(new Set(selected).size).toBe(20);
  expect(new Set(selected.slice(0, 7))).toEqual(new Set(priorityTypes));
  expect(selected.slice(7)).toEqual(Array.from({ length: 13 }, (_, index) => `ordinary-${index}`));
  expect(selected).not.toContain('failed-priority'); expect(selected).not.toContain('future-priority');
  await a.t.run(async ctx => {
    for (let index = 0; index < 25; index++) await ctx.db.insert('federationOutbox', { messageId: `earliest-renew-${index}`, toTownId: b.townId, envelope: { type: 'VISIT_RENEW' }, attempts: 0, nextRetryAt: Date.now() - 30000 + index });
  });
  expect(await a.t.query(queryRef('transport/pendingDeliveries'), {})).toEqual(Array.from({ length: 20 }, (_, index) => `earliest-renew-${index}`));
});

test('lease renewal and durable history retain capacity headroom while total capacity remains enforced', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home');
  await a.t.run(async ctx => {
    for (let index = 0; index < 900; index++) await ctx.db.insert('federationOutbox', { messageId: `ordinary-${index}`, toTownId: b.townId, envelope: { type: 'OBSERVATION' }, attempts: 0, nextRetryAt: Date.now() + 60000 });
  });
  await expect(a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'OBSERVATION', visitId: 'visit-1', payload: {} }))).rejects.toThrow('OUTBOX_CAPACITY_EXCEEDED');
  for (const type of ['VISIT_RENEW', 'CONVERSATION_ENDED']) await expect(a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type, visitId: 'visit-1', payload: {} }))).resolves.toEqual(expect.any(String));
  await a.t.run(async ctx => {
    for (let index = 902; index < 1000; index++) await ctx.db.insert('federationOutbox', { messageId: `ordinary-${index}`, toTownId: b.townId, envelope: { type: 'OBSERVATION' }, attempts: 0, nextRetryAt: Date.now() + 60000 });
  });
  for (const type of ['VISIT_RENEW', 'CONVERSATION_ENDED', 'VISIT_RETURN']) await expect(a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type, visitId: 'visit-1', payload: {} }))).rejects.toThrow('OUTBOX_CAPACITY_EXCEEDED');
});

test('renewal headroom retains clock, authority and inactive deployment gates while cleanup remains available', async () => {
  const { a, b } = await setup(); await seedVisit(a, b, 'home');
  await expect(a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'VISIT_RENEW', payload: {} }))).rejects.toThrow('VISIT_AUTHORITY_REQUIRED');
  await a.t.run(async ctx => {
    const clock = (await ctx.db.query('federationClock').unique())!;
    await ctx.db.patch(clock._id, { uncertain: true, reason: 'CLOCK_MOVED_BACKWARDS' });
  });
  await expect(a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'VISIT_RENEW', visitId: 'visit-1', payload: {} }))).rejects.toThrow('CLOCK_UNCERTAIN');
  await a.t.run(async ctx => {
    const clock = (await ctx.db.query('federationClock').unique())!, local = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(clock._id, { uncertain: false, reason: undefined }); await ctx.db.patch(local._id, { mode: 'FROZEN' });
  });
  await expect(a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'VISIT_RENEW', visitId: 'visit-1', payload: {} }))).rejects.toThrow('DEPLOYMENT_NOT_ACTIVE');
  await expect(a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'CONVERSATION_ENDED', visitId: 'visit-1', payload: {} }))).rejects.toThrow('DEPLOYMENT_NOT_ACTIVE');
  await expect(a.t.run(ctx => enqueueMessage(ctx, { peerTownId: b.townId, type: 'VISIT_RETURN', visitId: 'visit-1', payload: {} }))).resolves.toEqual(expect.any(String));
});

test('privacy tombstones commit late history without retaining bodies and drain authenticated sequences', async () => {
  const { a, b, credentialEncrypted } = await setup();
  await seedVisit(a, b, 'home', 'COMPLETED');
  await a.t.run(async ctx => {
    const ledger = await ctx.db.query('visitLedger').unique();
    await ctx.db.patch(ledger!._id, { leaseExpiry: Date.now() - 120000, cleanupConfirmed: true });
    await ctx.db.insert('travelPrivacyTombstones', { key: 'visit:visit-1', visitId: 'visit-1', createdAt: Date.now() });
  });
  const history = (sequence: number) => visitMessage(b, a, 'CONVERSATION_ENDED', sequence, 'historical', {
    payload: { eventId: `privacy-page-${sequence}`, text: 'private-history-body', messages: [{ text: 'private-history-body' }] },
  });
  const second = history(2), first = history(1);
  const secondPacket = await signPacket(second, b.keys.privateKeyEncrypted, credentialEncrypted);
  expect((await a.t.action(actionRef('transport/receiveMessage'), { packet: secondPacket })).body.status).toBe('BUFFERED');
  expect((await a.t.action(actionRef('transport/receiveMessage'), { packet: await signPacket(first, b.keys.privateKeyEncrypted, credentialEncrypted) })).body.status).toBe('COMMITTED');
  await a.t.mutation(mutationRef('transport/drainStream'), { streamKey: streamKey(first, b.townId) });
  expect((await a.t.action(actionRef('transport/receiveMessage'), { packet: secondPacket })).body.status).toBe('COMMITTED');
  const rows = await a.t.run(ctx => ctx.db.query('federationInbox').collect());
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.status === 'COMMITTED' && row.envelope.payload.privacyRedacted)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('private-history-body');
  expect(rows.find(row => row.messageId === second.messageId)?.payloadDigest).toBe(await (await import('./transport')).messageDigest(second));
  expect(await a.t.run(ctx => ctx.db.query('homeTravelTranscripts').collect())).toHaveLength(0);
  expect((await a.t.run(ctx => ctx.db.query('messageStreamCursors').withIndex('streamKey', q => q.eq('streamKey', streamKey(first, b.townId))).unique()))?.nextExpectedSequence).toBe(3);
  const forged = await signPacket({ ...first, payload: { text: 'conflicting-body' } }, b.keys.privateKeyEncrypted, credentialEncrypted);
  await expect(a.t.action(actionRef('transport/receiveMessage'), { packet: forged })).rejects.toThrow('MESSAGE_ID_CONFLICT');
});

test('privacy erasure preserves lifecycle fencing and stream control dispatch', async () => {
  const { a, b } = await setup(); await seedVisit(b, a, 'host', 'COMPLETED');
  await b.t.run(ctx => ctx.db.insert('travelPrivacyTombstones', { key: 'visit:visit-1', visitId: 'visit-1', createdAt: Date.now() }));
  const returned = visitMessage(a, b, 'VISIT_RETURN', 1);
  expect((await accept(b, returned)).status).toBe('COMMITTED');
  const row = await b.t.run(ctx => ctx.db.query('federationInbox').withIndex('messageId', q => q.eq('messageId', returned.messageId)).unique());
  expect(row?.envelope.payload.fencingToken).toBe('test-fencing-token-32bytes');
  const request = visitMessage(a, b, 'SESSION_RESYNC', 1, 'stream-control', { sequence: undefined, streamId: undefined, payload: { mode: 'request', streamId: 'lease-control' } });
  expect((await accept(b, request)).status).toBe('COMMITTED');
  const snapshot = await b.t.run(ctx => ctx.db.query('federationOutbox').withIndex('visit', q => q.eq('envelope.visitId', 'visit-1')).collect());
  expect(snapshot.some(item => item.envelope.type === 'SESSION_RESYNC' && item.envelope.payload.mode === 'snapshot')).toBe(true);
});
