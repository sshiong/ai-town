import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { actionRef, mutationRef, queryRef } from './refs';
import { createIdentityKeys, digest, randomSecret, sealSecret, signPacket } from './security';
import { FederationMessage, PROTOCOL, streamKey } from './protocol';
import { homeFrozen, hostCreated, hostRemoved, homeResumed } from './ledger';
import { enqueueMessage } from './queue';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/store.ts': () => import('./store'),
  '../federation/transport.ts': () => import('./transport'),
  '../federation/ledger.ts': () => import('./ledger'),
  '../federation/runtime.ts': () => import('./runtime'),
  '../federation/peers.ts': () => import('./peers'),
  '../federation/admin.ts': () => import('./admin'),
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
async function town(townId: string, keys: Awaited<ReturnType<typeof createIdentityKeys>>) {
  const t = convexTest(schema, modules);
  await t.run(async ctx => { await ctx.db.insert('federationIdentity', { ...keys, townId, townName: townId, endpoint: `https://${townId}.example/federation/v1`, deploymentInstanceId: `${townId}-instance`, deploymentEpoch: 1,
    enabled: true, allowIncomingPairRequests: true, allowUnencryptedHttp: false, allowPublicHttp: false, maxVisitors: 1, maxVisitDurationMs: 300000, mode: 'ACTIVE', createdAt: Date.now() }); });
  return { t, townId, keys };
}
async function setup() {
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = randomSecret();
  const [keysA, keysB] = await Promise.all([createIdentityKeys(), createIdentityKeys()]);
  const a = await town('town-a', keysA), b = await town('town-b', keysB), credentialEncrypted = await sealSecret(randomSecret());
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

test('visit saga reserves, freezes Home, confirms Host exactly once, then cleans before return', async () => {
  const { a, b } = await setup(); await markReady(b, a);
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
  // This test-only fetch adapter uses real TLS and trusts only the generated CA.
  // Production directRequest continues using the platform's verified fetch.
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
    expect((await a.t.run(ctx => ctx.db.query('transportSessions').unique()))?.lastError).toBeUndefined();
    expect(probeResult).toEqual({ channelState: 'TRANSPORT_TESTING' });
    expect(await b.t.action(actionRef('transport/probeInternal'), { peerTownId: a.townId })).toEqual({ channelState: 'TRANSPORT_READY' });
    expect((await a.t.run(ctx => ctx.db.query('transportSessions').unique()))?.channelState).toBe('TRANSPORT_READY');
    globalThis.fetch = tlsFetch();
    await expect(directRequest(endpoints[0], '/probe', {})).rejects.toThrow();
    await expect(directRequest(endpoints[0].replace('https:', 'http:'), '/probe', {})).rejects.toThrow('HTTPS required');
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
