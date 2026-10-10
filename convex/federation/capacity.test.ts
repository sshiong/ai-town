import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { createIdentityKeys, randomSecret, verifySignature } from './security';
import { DEFAULT_RESOURCE_LIMITS } from './resources';
import { queryRef } from './refs';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/capacity.ts': () => import('./capacity'),
  '../http.ts': async () => {
    const { httpRouter } = await import('convex/server');
    const { registerCapacityRoutes } = await import('./capacity');
    const http = httpRouter();
    registerCapacityRoutes(http);
    return { default: http };
  },
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_000_000);
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = randomSecret();
});
afterEach(() => jest.useRealTimers());
async function setup(name = 'host') {
  const t = convexTest(schema, modules),
    keys = await createIdentityKeys();
  const identityId = await t.run((ctx) =>
    ctx.db.insert('federationIdentity', {
      ...keys,
      townId: name,
      townName: name,
      endpoint: 'https://private-network.example/federation/v1',
      deploymentInstanceId: `${name}:instance`,
      deploymentEpoch: 7,
      enabled: true,
      allowIncomingPairRequests: false,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 8,
      maxVisitDurationMs: 300000,
      mode: 'ACTIVE',
      createdAt: Date.now(),
      resourceLimits: DEFAULT_RESOURCE_LIMITS,
    }),
  );
  return { t, keys, identityId };
}
async function reserve(
  t: Awaited<ReturnType<typeof setup>>['t'],
  state: string,
  expiresAt: number,
  role: 'host' | 'home' = 'host',
) {
  await t.run(async (ctx) => {
    const visitId = crypto.randomUUID();
    await ctx.db.insert('visitReservations', {
      visitId,
      hostTownId: 'host',
      expiresAt,
      reservedSlot: true,
    });
    await ctx.db.insert('visitLedger', {
      visitId,
      agentGlobalId: 'secret-source/private-agent',
      homeTownId: 'secret-source',
      hostTownId: 'host',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 7,
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      leaseExpiry: expiresAt,
      fencingToken: 'private-fencing-token',
      role,
      state,
      profile: {
        name: 'Private resident',
        personality: 'Private personality',
        provider: 'private-model',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}
test('public capacity is signed, explicitly advisory and read-only, with null unavailable host measurements', async () => {
  const { t, keys } = await setup();
  await reserve(t, 'ACTIVE', Date.now() + 50000);
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  const response = await t.fetch('/federation/v1/capabilities');
  const packet = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await verifySignature(packet.body, packet.signature, keys.publicKey)).toBe(true);
  expect(packet.body).toMatchObject({
    kind: 'CAPABILITIES',
    deploymentEpoch: 7,
    sentAt: Date.now(),
    expiresAt: Date.now() + 30000,
    admission: {
      state: 'OPEN',
      reasons: [],
      indicationOnly: true,
      visitorQueue: 'REJECT_AND_RETRY',
      authorization: 'TRUST_POLICY_AND_ATOMIC_RESERVATION_REQUIRED',
    },
    capacity: {
      occupiedVisitorsAndReservations: 1,
      remainingVisitorSlots: 7,
      reservations: 0,
      cpu: null,
      memory: null,
      hostMeasurements: 'UNAVAILABLE',
      countsAreLowerBounds: false,
    },
  });
  const serialized = JSON.stringify(packet);
  for (const secret of [
    'privateKeyEncrypted',
    keys.privateKeyEncrypted,
    'secret-source',
    'private-agent',
    'Private resident',
    'Private personality',
    'private-model',
    'private-fencing-token',
    'private-network.example',
    'sourceOccupancy',
    'resourceLimits',
    'leases',
    'observations',
  ])
    expect(serialized).not.toContain(secret);
  expect(
    await verifySignature(
      { ...packet.body, capacity: { ...packet.body.capacity, cpu: 0 } },
      packet.signature,
      keys.publicKey,
    ),
  ).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  await t.run(async (ctx) => {
    expect(await ctx.db.query('federationOutbox').collect()).toHaveLength(0);
    expect(await ctx.db.query('federationLlmRequests').collect()).toHaveLength(0);
    expect(await ctx.db.query('federationResourceMetrics').collect()).toHaveLength(0);
    expect(await ctx.db.query('visitReservations').collect()).toHaveLength(1);
  });
});
test('live reservations and unfinished Host cleanup consume slots; expired finished and Home ledger rows do not', async () => {
  const { t, identityId } = await setup();
  await t.run((ctx) => ctx.db.patch(identityId, { maxVisitors: 3 }));
  await reserve(t, 'RESERVED', Date.now() + 50000);
  await reserve(t, 'ACTIVE', Date.now() - 1);
  await reserve(t, 'REMOVING', Date.now() - 1);
  await reserve(t, 'ENDED', Date.now() - 1);
  await reserve(t, 'ACTIVE', Date.now() - 1, 'home');
  const snapshot = await t.query(queryRef('capacity/signingSnapshot'), {});
  expect(snapshot.body).toMatchObject({
    admission: { state: 'FULL', reasons: ['VISITOR_CAPACITY'] },
    capacity: { occupiedVisitorsAndReservations: 3, reservations: 1, remainingVisitorSlots: 0 },
  });
});
test('closed and degraded capacity state gives policy reasons, without claiming CPU or RAM thresholds were measured', async () => {
  const { t, identityId } = await setup();
  await t.run((ctx) =>
    ctx.db.patch(identityId, {
      enabled: false,
      mode: 'STANDBY',
      resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, maxConcurrentLocalLLM: 0 },
    }),
  );
  let body = (await t.query(queryRef('capacity/signingSnapshot'), {})).body;
  expect(body.admission.state).toBe('CLOSED');
  expect(body.admission.reasons).toEqual([
    'FEDERATION_DISABLED',
    'DEPLOYMENT_NOT_ACTIVE',
    'LOCAL_LLM_PAUSED',
  ]);
  await t.run((ctx) => ctx.db.patch(identityId, { enabled: true, mode: 'ACTIVE' }));
  body = (await t.query(queryRef('capacity/signingSnapshot'), {})).body;
  expect(body.admission).toMatchObject({ state: 'DEGRADED', reasons: ['LOCAL_LLM_PAUSED'] });
  expect(body.capacity.cpu).toBeNull();
  expect(body.capacity.memory).toBeNull();
});
test.each([3, 10])(
  '%i isolated synthetic node snapshots carry verifiable node identity and independently explain capacity',
  async (nodes) => {
    // This is an in-memory fixture test, not a real multi-node pressure run.
    for (let i = 0; i < nodes; i++) {
      const { t, keys, identityId } = await setup(`node:${i}`);
      await t.run((ctx) => ctx.db.patch(identityId, { maxVisitors: i % 2 === 0 ? 0 : 8 }));
      const packet = await (await t.fetch('/federation/v1/capabilities')).json();
      expect(packet.body.townId).toBe(`node:${i}`);
      expect(await verifySignature(packet.body, packet.signature, keys.publicKey)).toBe(true);
      expect(packet.body.admission.state).toBe(i % 2 === 0 ? 'FULL' : 'OPEN');
      expect(packet.body.admission.reasons).toEqual(i % 2 === 0 ? ['VISITOR_CAPACITY'] : []);
      expect(packet.body.capacity.cpu).toBeNull();
    }
  },
);
test('unconfigured identity returns a generic unavailable response without diagnostics', async () => {
  const t = convexTest(schema, modules);
  const response = await t.fetch('/federation/v1/capabilities');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'FEDERATION_UNAVAILABLE' });
});
test('bounded count truncation is explicit and does not advertise a fabricated remaining slot count', async () => {
  const { t } = await setup();
  await t.run(async (ctx) => {
    for (let i = 0; i < 1001; i++)
      await ctx.db.insert('visitReservations', {
        visitId: `expired:${i}`,
        hostTownId: 'host',
        expiresAt: Date.now() - 1,
        reservedSlot: true,
      });
  });
  const body = (await t.query(queryRef('capacity/signingSnapshot'), {})).body;
  expect(body.capacity).toMatchObject({ countsAreLowerBounds: true, remainingVisitorSlots: null });
  expect(body.admission).toMatchObject({ state: 'DEGRADED', reasons: ['CAPACITY_SAMPLE_LIMIT'] });
});


test('public queue capability exposes signed aggregate counts without waiting identities or fencing', async () => {
  const { t, keys } = await setup();
  await t.run(async ctx => {
    await ctx.db.insert('federationResourcePolicy', {
      maxVisitorsPerSourceTown: null, visitorQueueEnabled: true, maxQueuedVisits: 50,
      visitQueueTtlMs: 120000, visitorQueueMode: 'SOURCE_ROUND_ROBIN', maxQueuedVisitsPerSourceTown: 4,
    });
    for (const paused of [false, true]) await ctx.db.insert('visitLedger', {
      visitId: crypto.randomUUID(), agentGlobalId: 'secret-source/private-agent', homeTownId: 'secret-source',
      hostTownId: 'host', homeDeploymentEpoch: 1, hostDeploymentEpoch: 7, agentAuthorityEpoch: 1,
      visitLeaseVersion: 1, leaseExpiry: Date.now() + 120000, fencingToken: 'private-fencing-token',
      role: 'host', state: 'QUEUED', profile: { name: 'Private waiting name' },
      createdAt: Date.now(), updatedAt: Date.now(), queuedAt: Date.now(),
      queueExpiresAt: Date.now() + 60000, queuePaused: paused,
    });
  });
  const response = await t.fetch('/federation/v1/capabilities');
  expect(response.status).toBe(200);
  const signed = await response.json();
  expect(await verifySignature(signed.body, signed.signature, keys.publicKey)).toBe(true);
  expect(signed.body.admission).toMatchObject({ visitorQueue: 'BOUNDED_DURABLE_QUEUE', visitorQueueProtocolVersion: 1 });
  expect(signed.body.capacity).toMatchObject({ waitingVisits: 2, pausedWaitingVisits: 1, occupiedVisitorsAndReservations: 0 });
  const text = JSON.stringify(signed);
  for (const secret of ['secret-source', 'private-agent', 'private-fencing-token', 'Private waiting name'])
    expect(text).not.toContain(secret);
});
