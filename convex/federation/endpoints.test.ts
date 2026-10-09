import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { actionRef, mutationRef, queryRef } from './refs';
import { createIdentityKeys, randomSecret, sealSecret, signPacket } from './security';
import { PROTOCOL } from './protocol';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/store.ts': () => import('./store'),
  '../federation/endpoints.ts': () => import('./endpoints'),
  '../federation/identityConflict.ts': () => import('./identityConflict'),
  '../federation/transport.ts': () => import('./transport'),
  '../federation/admin.ts': () => import('./admin'),
  '../federation/peers.ts': () => import('./peers'),
  '../http.ts': async () => {
    const { httpRouter } = await import('convex/server');
    const { registerEndpointRoutes } = await import('./endpoints');
    const { registerFederationRoutes } = await import('./transport');
    const http = httpRouter();
    registerEndpointRoutes(http);
    registerFederationRoutes(http);
    return { default: http };
  },
};
const adminToken = 'endpoints-test-administrator-token';
let originalFetch: typeof fetch;
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] });
  originalFetch = globalThis.fetch;
  process.env.FEDERATION_ADMIN_TOKEN = adminToken;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = randomSecret();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
});
async function setup() {
  const a = convexTest(schema, modules),
    b = convexTest(schema, modules);
  const aKeys = await createIdentityKeys(),
    bKeys = await createIdentityKeys();
  const credentialEncrypted = await sealSecret(randomSecret());
  for (const [t, name, keys, remote, remoteKeys] of [
    [a, 'a', aKeys, 'b', bKeys],
    [b, 'b', bKeys, 'a', aKeys],
  ] as const)
    await t.run(async (ctx) => {
      await ctx.db.insert('federationIdentity', {
        ...keys,
        townId: name,
        townName: name,
        endpoint: `https://${name}.example/federation/v1`,
        deploymentInstanceId: `${name}-instance`,
        deploymentEpoch: 1,
        enabled: true,
        allowIncomingPairRequests: true,
        allowUnencryptedHttp: false,
        allowPublicHttp: false,
        mode: 'ACTIVE',
        maxVisitors: 2,
        maxVisitDurationMs: 300000,
        createdAt: Date.now(),
      });
      await ctx.db.insert('federationPeers', {
        townId: remote,
        townName: remote,
        publicKey: remoteKeys.publicKey,
        fingerprint: remoteKeys.fingerprint,
        endpoint: `https://${remote}.example/federation/v1`,
        deploymentInstanceId: `${remote}-instance`,
        deploymentEpoch: 1,
        credentialId: 'pair-a-b',
        credentialEncrypted,
        trustState: 'TRUSTED',
        inboundVisitsAllowed: true,
        outboundVisitsAllowed: true,
        pairedAt: Date.now(),
      });
      await ctx.db.insert('transportSessions', {
        peerTownId: remote,
        transportType: 'DIRECT_HTTPS',
        channelState: 'TRANSPORT_READY',
        localDeploymentEpoch: 1,
        verifiedPeerDeploymentEpoch: 1,
        inboundVerifiedAt: Date.now(),
        outboundVerifiedAt: Date.now(),
      });
    });
  const requested: string[] = [];
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (url, init) => {
    requested.push(String(url));
    const target = new URL(String(url)).hostname.startsWith('a') ? a : b;
    return target.fetch(new URL(String(url)).pathname, {
      method: init?.method,
      body: init?.body as string,
    });
  });
  return { a, b, aKeys, bKeys, credentialEncrypted, requested };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const details = {
  operator: 'Town owner',
  reason: 'Address changed with the same trusted identity',
};
async function change(s: Setup, endpoint = 'https://a-new.example') {
  return s.a.mutation(mutationRef('admin/updateLocalEndpoint'), {
    adminToken,
    endpoint,
    ...details,
  });
}
async function outbound(s: Setup) {
  return (await s.a.run((ctx) => ctx.db.query('federationEndpointUpdates').order('desc').first()))!;
}
async function update(s: Setup, overrides: Record<string, any> = {}) {
  return signPacket(
    {
      protocol: PROTOCOL,
      type: 'ENDPOINT_UPDATE',
      updateId: crypto.randomUUID(),
      fromTownId: 'a',
      toTownId: 'b',
      senderDeploymentInstanceId: 'a-instance',
      senderDeploymentEpoch: 1,
      recipientDeploymentInstanceId: 'b-instance',
      expectedRecipientDeploymentEpoch: 1,
      credentialId: 'pair-a-b',
      previousEndpoint: 'https://a.example/federation/v1',
      newEndpoint: 'https://a-new.example/federation/v1',
      sequence: 1,
      ...details,
      nonce: crypto.randomUUID(),
      sentAt: Date.now(),
      expiresAt: Date.now() + 60000,
      ...overrides,
    },
    s.aKeys.privateKeyEncrypted,
    s.credentialEncrypted,
  );
}
async function identities(s: Setup) {
  return {
    identity: await s.a.run((ctx) => ctx.db.query('federationIdentity').unique()),
    peer: await s.b.run((ctx) => ctx.db.query('federationPeers').unique()),
  };
}

test('signed address notification challenges the new route, preserves identity/credentials/leases and reprobes', async () => {
  const s = await setup(),
    before = await identities(s);
  const leaseId = await s.a.run((ctx) =>
    ctx.db.insert('visitLedger', {
      visitId: 'existing',
      agentGlobalId: 'a/agent:one',
      homeTownId: 'a',
      hostTownId: 'b',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 2,
      visitLeaseVersion: 1,
      leaseExpiry: Date.now() + 30000,
      fencingToken: 'existing-fence',
      state: 'ACTIVE',
      role: 'home',
      profile: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  const lease = await s.a.run((ctx) => ctx.db.get(leaseId));
  await change(s);
  const row = await outbound(s);
  await s.a.action(actionRef('endpoints/deliver'), { peerTownId: 'b', updateId: row.updateId });
  const after = await identities(s);
  expect(after.identity).toMatchObject({
    townId: before.identity!.townId,
    publicKey: before.identity!.publicKey,
    privateKeyEncrypted: before.identity!.privateKeyEncrypted,
    endpointSequence: 1,
    deploymentEpoch: 1,
  });
  expect(after.peer).toMatchObject({
    townId: before.peer!.townId,
    publicKey: before.peer!.publicKey,
    credentialEncrypted: before.peer!.credentialEncrypted,
    credentialId: before.peer!.credentialId,
    endpoint: 'https://a-new.example/federation/v1',
    endpointSequence: 1,
  });
  expect(await s.a.run((ctx) => ctx.db.get(leaseId))).toEqual(lease);
  expect((await outbound(s)).state).toBe('ACKED');
  expect(s.requested).toEqual([
    'https://b.example/federation/v1/peers/endpoints',
    'https://a-new.example/federation/v1/probe',
  ]);
  for (const t of [s.a, s.b]) {
    expect((await t.run((ctx) => ctx.db.query('transportSessions').unique()))?.channelState).toBe(
      'TRANSPORT_TESTING',
    );
    expect(await t.run((ctx) => ctx.db.query('federationAgentRuntimes').collect())).toEqual([]);
  }
  const history = await s.a.query(queryRef('endpoints/history'), { adminToken });
  expect(JSON.stringify(history)).not.toContain(before.identity!.privateKeyEncrypted);
  expect(JSON.stringify(history)).not.toContain(before.peer!.credentialEncrypted);
});

test('duplicate signed update returns its ACK without another challenge; shared nonce and lower sequence are rejected', async () => {
  const s = await setup();
  await change(s);
  const row = await outbound(s),
    prepared = await s.a.mutation(mutationRef('endpoints/prepareDelivery'), {
      peerTownId: 'b',
      updateId: row.updateId,
    });
  const packet = prepared!.packet;
  const response = await s.b.action(actionRef('endpoints/receiveUpdate'), { packet });
  const requestCount = s.requested.length;
  expect(await s.b.action(actionRef('endpoints/receiveUpdate'), { packet })).toEqual(response);
  expect(s.requested).toHaveLength(requestCount);
  await expect(
    s.b.action(actionRef('endpoints/receiveUpdate'), {
      packet: await update(s, { sequence: 2, nonce: packet.body.nonce }),
    }),
  ).rejects.toThrow('REPLAYED_NONCE');
  await expect(
    s.b.action(actionRef('endpoints/receiveUpdate'), {
      packet: await update(s, { newEndpoint: 'https://a-old.example/federation/v1' }),
    }),
  ).rejects.toThrow('STALE_ENDPOINT_SEQUENCE');
  await expect(
    s.b.action(actionRef('endpoints/receiveUpdate'), {
      packet: await update(s, { updateId: packet.body.updateId, sequence: 2 }),
    }),
  ).rejects.toThrow('ENDPOINT_UPDATE_ID_CONFLICT');
});

test('failed new-route proof retains the original peer address and records failure for signed retries', async () => {
  const s = await setup();
  await change(s);
  const packet = await update(s);
  globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('NETWORK_UNREACHABLE'));
  await expect(s.b.action(actionRef('endpoints/receiveUpdate'), { packet })).rejects.toThrow(
    'NETWORK_UNREACHABLE',
  );
  expect((await identities(s)).peer?.endpoint).toBe('https://a.example/federation/v1');
  expect((await s.b.run((ctx) => ctx.db.query('federationEndpointUpdates').unique()))?.state).toBe(
    'FAILED',
  );
  expect(
    (await s.b.run((ctx) => ctx.db.query('federationEndpointAudit').unique()))?.operation,
  ).toBe('VERIFICATION_FAILED');
  expect((await s.b.run((ctx) => ctx.db.query('transportSessions').unique()))?.channelState).toBe(
    'TRANSPORT_TESTING',
  );
});

test.each(['signature', 'mac'])(
  'forged update %s cannot alter trust or create a conflict',
  async (field) => {
    const s = await setup(),
      packet = await update(s);
    await expect(
      s.b.action(actionRef('endpoints/receiveUpdate'), {
        packet: { ...packet, [field]: 'forged' },
      }),
    ).rejects.toThrow('ENDPOINT_AUTH_FAILED');
    expect((await identities(s)).peer?.endpoint).toBe('https://a.example/federation/v1');
    expect(await s.b.run((ctx) => ctx.db.query('federationIdentityConflicts').collect())).toEqual(
      [],
    );
  },
);

test.each([
  [{ expiresAt: 1 }, 'INVALID_ENDPOINT_UPDATE'],
  [{ newEndpoint: 'http://a-new.example/federation/v1' }, 'HTTPS required'],
  [{ senderDeploymentEpoch: 2 }, 'SENDER_DEPLOYMENT_MISMATCH'],
  [{ expectedRecipientDeploymentEpoch: 2 }, 'RECIPIENT_DEPLOYMENT_MISMATCH'],
  [{ recipientDeploymentInstanceId: 'wrong-instance' }, 'RECIPIENT_DEPLOYMENT_MISMATCH'],
  [{ sequence: 1.5 }, 'INVALID_ENDPOINT_UPDATE'],
] as const)('invalid or fenced update %j never changes the peer', async (overrides, error) => {
  const s = await setup();
  await expect(
    s.b.action(actionRef('endpoints/receiveUpdate'), { packet: await update(s, overrides) }),
  ).rejects.toThrow(error);
  expect((await identities(s)).peer?.endpoint).toBe('https://a.example/federation/v1');
});

test('a signed conflicting endpoint deployment quarantines durably through HTTP and admin cannot bypass it', async () => {
  const s = await setup(),
    packet = await update(s, { senderDeploymentInstanceId: 'a-clone' });
  const response = await s.b.fetch('/federation/v1/peers/endpoints', {
    method: 'POST',
    body: JSON.stringify(packet),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'TOWN_CLONE_CONFLICT' });
  expect((await s.b.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'QUARANTINED',
  );
  const conflict = (await s.b.run((ctx) => ctx.db.query('federationIdentityConflicts').unique()))!;
  expect(conflict.source).toBe('ENDPOINT');
  expect(JSON.stringify(conflict)).not.toContain(packet.mac);
  await expect(
    s.b.action(actionRef('peers/updateEndpoint'), {
      adminToken,
      peerTownId: 'a',
      endpoint: 'https://a-new.example',
      ...details,
    }),
  ).rejects.toThrow('PEER_NOT_TRUSTED');
  await expect(
    s.b.mutation(mutationRef('admin/updateLocalEndpoint'), {
      adminToken,
      endpoint: 'https://b-new.example',
      ...details,
    }),
  ).rejects.toThrow('TOWN_CLONE_CONFLICT');
  expect((await identities(s)).peer?.endpoint).toBe('https://a.example/federation/v1');
});

test('manual recovery uses a fresh authenticated probe and refuses a replayed ACK or stale sequence', async () => {
  const s = await setup();
  await change(s);
  await s.b.action(actionRef('peers/updateEndpoint'), {
    adminToken,
    peerTownId: 'a',
    endpoint: 'https://a-new.example',
    ...details,
  });
  expect(s.requested).toEqual(['https://a-new.example/federation/v1/probe']);
  expect((await identities(s)).peer).toMatchObject({
    endpoint: 'https://a-new.example/federation/v1',
    endpointSequence: 1,
  });
  const oldProbeResponse = await s.a.fetch('/federation/v1/probe', {
    method: 'POST',
    body: JSON.stringify(
      await signPacket(
        {
          protocol: PROTOCOL,
          type: 'TRANSPORT_PROBE',
          messageId: 'old-message',
          fromTownId: 'b',
          toTownId: 'a',
          senderDeploymentInstanceId: 'b-instance',
          senderDeploymentEpoch: 1,
          expectedRecipientDeploymentEpoch: 1,
          credentialId: 'pair-a-b',
          sentAt: Date.now(),
          expiresAt: Date.now() + 30000,
          nonce: 'old-nonce',
          payload: { probeId: 'old-probe', nonce: 'old-nonce' },
        },
        s.bKeys.privateKeyEncrypted,
        s.credentialEncrypted,
      ),
    ),
  });
  const oldAck = await oldProbeResponse.json();
  globalThis.fetch = jest
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(oldAck)));
  await expect(
    s.b.action(actionRef('endpoints/verifyPeerEndpoint'), {
      adminToken,
      peerTownId: 'a',
      endpoint: 'https://a-old.example',
      ...details,
    }),
  ).rejects.toThrow('ENDPOINT_IDENTITY_UNVERIFIED');
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const request = JSON.parse(init!.body as string).body;
    return new Response(
      JSON.stringify(
        await signPacket(
          {
            ...oldAck.body,
            nonce: request.nonce,
            messageId: request.messageId,
            probeId: request.payload.probeId,
            endpoint: 'https://a-old.example/federation/v1',
            endpointSequence: 0,
          },
          s.aKeys.privateKeyEncrypted,
          s.credentialEncrypted,
        ),
      ),
    );
  });
  await expect(
    s.b.action(actionRef('endpoints/verifyPeerEndpoint'), {
      adminToken,
      peerTownId: 'a',
      endpoint: 'https://a-old.example',
      ...details,
    }),
  ).rejects.toThrow('STALE_ENDPOINT_SEQUENCE');
  expect((await identities(s)).peer?.endpointSequence).toBe(1);
});

test('local/peer route or credentials changing during the new-address challenge fence the commit', async () => {
  const s = await setup();
  await change(s);
  const realFetch = globalThis.fetch;
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const response = await realFetch(url, init);
    await s.b.run(async (ctx) => {
      const p = (await ctx.db.query('federationPeers').unique())!;
      await ctx.db.patch(p._id, { credentialId: 'rotated-pair' });
    });
    return response;
  });
  await expect(
    s.b.action(actionRef('endpoints/receiveUpdate'), { packet: await update(s) }),
  ).rejects.toThrow('ENDPOINT_AUTH_FAILED');
  expect((await identities(s)).peer?.endpoint).toBe('https://a.example/federation/v1');
});

test('new local address supersedes unfinished delivery and failures are durable/retryable without leaking proofs', async () => {
  const s = await setup();
  await change(s);
  const old = await outbound(s);
  await change(s, 'https://a-newer.example');
  expect(
    await s.a.mutation(mutationRef('endpoints/prepareDelivery'), {
      peerTownId: 'b',
      updateId: old.updateId,
    }),
  ).toBeNull();
  expect((await s.a.run((ctx) => ctx.db.get(old._id)))?.state).toBe('SUPERSEDED');
  const row = await outbound(s);
  globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('NETWORK_UNREACHABLE'));
  await s.a.action(actionRef('endpoints/deliver'), { peerTownId: 'b', updateId: row.updateId });
  const failed = await outbound(s);
  expect(failed.state).toBe('PENDING');
  expect(failed.attempts).toBe(1);
  expect(failed.nextRetryAt).toBeGreaterThan(Date.now());
  await s.a.action(actionRef('endpoints/retry'), {
    adminToken,
    peerTownId: 'b',
    updateId: row.updateId,
  });
  expect((await outbound(s)).attempts).toBe(2);
  await expect(
    s.a.action(actionRef('endpoints/retry'), {
      adminToken: 'wrong',
      peerTownId: 'b',
      updateId: row.updateId,
    }),
  ).rejects.toThrow('ADMIN_UNAUTHORIZED');
});

test('manual recovery and later signed delivery of the same sequence complete idempotently', async () => {
  const s = await setup();
  await change(s);
  await s.b.action(actionRef('endpoints/verifyPeerEndpoint'), {
    adminToken,
    peerTownId: 'a',
    endpoint: 'https://a-new.example',
    ...details,
  });
  const row = await outbound(s);
  await s.a.action(actionRef('endpoints/deliver'), { peerTownId: 'b', updateId: row.updateId });
  expect((await outbound(s)).state).toBe('ACKED');
  expect((await identities(s)).peer).toMatchObject({
    endpoint: 'https://a-new.example/federation/v1',
    endpointSequence: 1,
  });
});

test('a fresh higher notification fences an earlier in-flight challenge before it can commit', async () => {
  const s = await setup();
  await change(s);
  const earlier = await update(s),
    newer = await update(s, { sequence: 2, newEndpoint: 'https://a-newer.example/federation/v1' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const response = await realFetch(url, init);
    await s.b.mutation(mutationRef('endpoints/stageUpdate'), { packet: newer });
    return response;
  });
  await expect(
    s.b.action(actionRef('endpoints/receiveUpdate'), { packet: earlier }),
  ).rejects.toThrow('STALE_ENDPOINT_SEQUENCE');
  expect((await identities(s)).peer?.endpoint).toBe('https://a.example/federation/v1');
});

test('a claimed new route serving a valid trusted identity with another address cannot be saved', async () => {
  const s = await setup(); // a still advertises its old route despite reachable a-new.example.
  await expect(
    s.b.action(actionRef('endpoints/receiveUpdate'), { packet: await update(s) }),
  ).rejects.toThrow('ENDPOINT_SOURCE_CHANGED');
  await expect(
    s.b.action(actionRef('endpoints/verifyPeerEndpoint'), {
      adminToken,
      peerTownId: 'a',
      endpoint: 'https://a-new.example',
      ...details,
    }),
  ).rejects.toThrow('ENDPOINT_SOURCE_CHANGED');
  expect((await identities(s)).peer?.endpoint).toBe('https://a.example/federation/v1');
});

test('a forged acceptance response cannot finish delivery even after the peer verified the address', async () => {
  const s = await setup();
  await change(s);
  const realFetch = globalThis.fetch;
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const response = await realFetch(url, init);
    if (!String(url).endsWith('/peers/endpoints')) return response;
    const ack = await response.json();
    ack.body.requestDigest = 'forged-digest';
    return new Response(JSON.stringify(ack));
  });
  const row = await outbound(s);
  await s.a.action(actionRef('endpoints/deliver'), { peerTownId: 'b', updateId: row.updateId });
  expect(await outbound(s)).toMatchObject({
    state: 'PENDING',
    lastError: 'INVALID_ENDPOINT_UPDATE_ACK',
  });
});
