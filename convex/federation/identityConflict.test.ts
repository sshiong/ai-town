import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { actionRef, mutationRef, queryRef } from './refs';
import { createIdentityKeys, randomSecret, sealSecret, sign, signPacket } from './security';
import { PROTOCOL } from './protocol';
import { assertNoIdentityConflict } from './identityConflict';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/store.ts': () => import('./store'),
  '../federation/identityConflict.ts': () => import('./identityConflict'),
  '../federation/transport.ts': () => import('./transport'),
  '../federation/ledger.ts': () => import('./ledger'),
  '../federation/runtime.ts': () => import('./runtime'),
  '../federation/admin.ts': () => import('./admin'),
  '../federation/peers.ts': () => import('./peers'),
  '../federation/migration.ts': () => import('./migration'),
  '../http.ts': async () => {
    const { httpRouter } = await import('convex/server');
    const { registerPairingRoutes } = await import('./peers');
    const { registerFederationRoutes } = await import('./transport');
    const http = httpRouter();
    registerPairingRoutes(http);
    registerFederationRoutes(http);
    return { default: http };
  },
};
const adminToken = 'identity-conflict-test-admin-token-long';
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
  const t = convexTest(schema, modules),
    localKeys = await createIdentityKeys(),
    remoteKeys = await createIdentityKeys(),
    credentialEncrypted = await sealSecret(randomSecret());
  await t.run(async (ctx) => {
    await ctx.db.insert('federationIdentity', {
      ...localKeys,
      townId: 'town:local',
      townName: 'Local',
      deploymentInstanceId: 'local-instance',
      deploymentEpoch: 1,
      endpoint: 'https://local.example/federation/v1',
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
      townId: 'town:remote',
      townName: 'Remote',
      publicKey: remoteKeys.publicKey,
      fingerprint: remoteKeys.fingerprint,
      deploymentInstanceId: 'remote-instance',
      deploymentEpoch: 1,
      endpoint: 'https://remote.example/federation/v1',
      credentialId: 'credential-local-remote',
      credentialEncrypted,
      trustState: 'TRUSTED',
      inboundVisitsAllowed: true,
      outboundVisitsAllowed: true,
      pairedAt: Date.now(),
    });
    await ctx.db.insert('transportSessions', {
      peerTownId: 'town:remote',
      transportType: 'DIRECT_HTTPS',
      channelState: 'TRANSPORT_READY',
      localDeploymentEpoch: 1,
      verifiedPeerDeploymentEpoch: 1,
      outboundVerifiedAt: Date.now(),
      inboundVerifiedAt: Date.now(),
    });
  });
  return { t, localKeys, remoteKeys, credentialEncrypted };
}
type Setup = Awaited<ReturnType<typeof setup>>;
function probe(overrides: Record<string, any> = {}) {
  const nonce = crypto.randomUUID();
  return {
    protocol: PROTOCOL,
    type: 'TRANSPORT_PROBE',
    messageId: crypto.randomUUID(),
    fromTownId: 'town:remote',
    toTownId: 'town:local',
    senderDeploymentInstanceId: 'clone-instance',
    senderDeploymentEpoch: 1,
    expectedRecipientDeploymentEpoch: 1,
    credentialId: 'credential-local-remote',
    sentAt: Date.now(),
    expiresAt: Date.now() + 30000,
    nonce,
    payload: { probeId: crypto.randomUUID(), nonce },
    ...overrides,
  };
}
async function signedProbe(s: Setup, overrides: Record<string, any> = {}) {
  return signPacket(probe(overrides), s.remoteKeys.privateKeyEncrypted, s.credentialEncrypted);
}
async function quarantined(s: Setup) {
  const packet = await signedProbe(s);
  await expect(s.t.action(actionRef('transport/receiveProbe'), { packet })).rejects.toThrow(
    'TOWN_CLONE_CONFLICT',
  );
  return packet;
}
function health(townId: string, keys: Setup['localKeys'], instance: string, epoch = 1) {
  return {
    protocol: PROTOCOL,
    townId,
    townName: townId,
    publicKey: keys.publicKey,
    fingerprint: keys.fingerprint,
    deploymentInstanceId: instance,
    deploymentEpoch: epoch,
    endpoint: 'https://clone.example/federation/v1',
    sentAt: Date.now(),
    expiresAt: Date.now() + 30000,
  };
}
async function observeHealth(
  s: Setup,
  body: Omit<ReturnType<typeof health>, 'sentAt'> & { sentAt?: number },
  keys = s.remoteKeys,
) {
  return s.t.mutation(mutationRef('identityConflict/observe'), {
    source: 'HEALTH',
    packet: { body, signature: await sign(body, keys.privateKeyEncrypted) },
  });
}

test('a genuinely signed clone is durably quarantined before HTTP rejection without visit side effects', async () => {
  const s = await setup(),
    packet = await signedProbe(s);
  for (let i = 0; i < 2; i++) {
    const response = await s.t.fetch('/federation/v1/probe', {
      method: 'POST',
      body: JSON.stringify(packet),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'TOWN_CLONE_CONFLICT' });
  }
  const local = await s.t.run((ctx) => ctx.db.query('federationIdentity').unique());
  expect(local?.mode).toBe('QUARANTINED');
  expect(local?.quarantinePreviousMode).toBe('ACTIVE');
  const conflicts = await s.t.run((ctx) => ctx.db.query('federationIdentityConflicts').collect());
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({
    state: 'OPEN',
    knownDeploymentInstanceId: 'remote-instance',
    observedDeploymentInstanceId: 'clone-instance',
    knownDeploymentEpoch: 1,
    observedDeploymentEpoch: 1,
  });
  expect(conflicts[0].evidence).toEqual({ body: packet.body, signature: packet.signature });
  expect(JSON.stringify(conflicts)).not.toContain(packet.mac);
  expect(
    await s.t.run((ctx) => ctx.db.query('federationIdentityConflictAudit').collect()),
  ).toHaveLength(1);
  expect(await s.t.run((ctx) => ctx.db.query('visitLedger').collect())).toEqual([]);
  expect(await s.t.run((ctx) => ctx.db.query('federationInbox').collect())).toEqual([]);
  expect((await s.t.run((ctx) => ctx.db.query('transportSessions').unique()))?.channelState).toBe(
    'TRANSPORT_TESTING',
  );
  // Quarantine does not install the global maintenance lock or alter local world data.
  expect(await s.t.run((ctx) => ctx.db.query('backupMaintenanceLocks').collect())).toEqual([]);
  await s.t.mutation(mutationRef('admin/configureResources'), {
    adminToken,
    limits: (await s.t.query(queryRef('admin/status'), { adminToken })).resources.limits,
  });
  await expect(s.t.run((ctx) => assertNoIdentityConflict(ctx, 'town:remote'))).rejects.toThrow(
    'TOWN_CLONE_CONFLICT',
  );
});

test('unsigned, unknown-key, wrong-MAC, malformed and expired claims cannot quarantine a town', async () => {
  const s = await setup(),
    valid = await signedProbe(s),
    stranger = await createIdentityKeys();
  for (const packet of [
    { ...valid, signature: 'forged' },
    { ...valid, mac: 'forged' },
    await signPacket(probe(), stranger.privateKeyEncrypted, s.credentialEncrypted),
  ]) {
    await expect(s.t.action(actionRef('transport/receiveProbe'), { packet })).rejects.toThrow(
      'MESSAGE_AUTH_FAILED',
    );
  }
  expect(
    (await observeHealth(s, health('town:remote', stranger, 'clone-instance'), stranger))
      .disposition,
  ).toBe('UNVERIFIED');
  expect(
    (await observeHealth(s, health('town:unknown', stranger, 'clone-instance'), stranger))
      .disposition,
  ).toBe('UNVERIFIED');
  expect(
    (
      await observeHealth(s, {
        ...health('town:remote', s.remoteKeys, 'clone-instance'),
        expiresAt: Date.now() - 1,
      })
    ).disposition,
  ).toBe('UNVERIFIED');
  expect(
    (
      await observeHealth(s, {
        ...health('town:remote', s.remoteKeys, 'clone-instance'),
        deploymentEpoch: 1.5,
      })
    ).disposition,
  ).toBe('UNVERIFIED');
  expect((await s.t.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'ACTIVE',
  );
  expect(await s.t.run((ctx) => ctx.db.query('federationIdentityConflicts').collect())).toEqual([]);
});

test('a signed local identity clone discovered during pairing freezes new pairing persistently', async () => {
  const s = await setup(),
    body = health('town:local', s.localKeys, 'local-clone');
  const signature = await sign(body, s.localKeys.privateKeyEncrypted);
  globalThis.fetch = jest
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ body, signature })));
  await expect(
    s.t.action(actionRef('peers/requestPair'), {
      adminToken,
      endpoint: 'https://clone.example',
      pairingSecret: randomSecret(),
    }),
  ).rejects.toThrow('TOWN_CLONE_CONFLICT');
  expect((await s.t.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'QUARANTINED',
  );
  expect(await s.t.run((ctx) => ctx.db.query('pairRequests').collect())).toEqual([]);
  const conflict = (await s.t.run((ctx) => ctx.db.query('federationIdentityConflicts').unique()))!;
  expect(conflict.townId).toBe('town:local');
});

test('a self-signed impostor of the local Town is rejected without freezing local authority', async () => {
  const s = await setup(),
    stranger = await createIdentityKeys(),
    body = health('town:local', stranger, 'impostor');
  globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        body,
        signature: await sign(body, stranger.privateKeyEncrypted),
      }),
    ),
  );
  await expect(
    s.t.action(actionRef('peers/requestPair'), {
      adminToken,
      endpoint: 'https://impostor.example',
      pairingSecret: randomSecret(),
    }),
  ).rejects.toThrow('TOWN_ID_CONFLICT');
  expect((await s.t.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'ACTIVE',
  );
});

test('same-instance epoch mismatches are fenced without pretending to prove another instance', async () => {
  const s = await setup();
  const packet = await signedProbe(s, {
    senderDeploymentInstanceId: 'remote-instance',
    senderDeploymentEpoch: 99,
  });
  await expect(s.t.action(actionRef('transport/receiveProbe'), { packet })).rejects.toThrow(
    'SENDER_DEPLOYMENT_MISMATCH',
  );
  expect((await s.t.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'ACTIVE',
  );
});

test('a conflicting signed deployment in an outbound probe ACK is evidence too', async () => {
  const s = await setup();
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const request = JSON.parse(init!.body as string).body;
    const body = {
      protocol: PROTOCOL,
      type: 'TRANSPORT_PROBE_ACK',
      fromTownId: 'town:remote',
      toTownId: 'town:local',
      senderDeploymentInstanceId: 'clone-instance',
      senderDeploymentEpoch: 1,
      expectedRecipientDeploymentEpoch: 1,
      credentialId: request.credentialId,
      probeId: request.payload.probeId,
      nonce: request.nonce,
      messageId: request.messageId,
      expiresAt: Date.now() + 30000,
    };
    return new Response(
      JSON.stringify(
        await signPacket(body, s.remoteKeys.privateKeyEncrypted, s.credentialEncrypted),
      ),
    );
  });
  await s.t.action(actionRef('transport/probeInternal'), { peerTownId: 'town:remote' });
  expect((await s.t.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'QUARANTINED',
  );
  expect(
    (await s.t.run((ctx) => ctx.db.query('federationIdentityConflicts').unique()))?.source,
  ).toBe('ACK');
});

async function seedHandoff(
  s: Setup,
  sourceInstance: string,
  sourceEpoch: number,
  targetInstance: string,
  targetEpoch: number,
  frozenAt: number,
  tamper = false,
) {
  const body = {
    purpose: 'ai-town-migration-handoff/1',
    handoffId: `${sourceInstance}-${targetInstance}`,
    townId: 'town:remote',
    publicKey: s.remoteKeys.publicKey,
    sourceDeploymentInstanceId: sourceInstance,
    sourceDeploymentEpoch: sourceEpoch,
    target: {
      townId: 'town:remote',
      publicKey: s.remoteKeys.publicKey,
      deploymentInstanceId: targetInstance,
      deploymentEpoch: targetEpoch,
      endpoint: 'https://remote.example/federation/v1',
    },
    frozenAt,
    issuedAt: frozenAt,
    operator: 'Migration operator',
    authorityScope: 'ALL_FEDERATION_AUTHORITY_DRAINED',
    peers: [],
  };
  const signature = await sign(body, s.remoteKeys.privateKeyEncrypted);
  await s.t.run((ctx) =>
    ctx.db.insert('migrationHandoffRecords', {
      handoffId: body.handoffId,
      townId: body.townId,
      body: tamper ? { ...body, operator: 'Tampered' } : body,
      signature,
      role: 'PEER',
      acceptedAt: Date.now(),
    }),
  );
}

test('verified migration chains fence frozen-source data while newly signed retired-source traffic quarantines', async () => {
  const s = await setup(),
    frozenAt = Date.now();
  await seedHandoff(s, 'remote-instance', 1, 'successor', 2, frozenAt);
  await seedHandoff(s, 'successor', 2, 'current-instance', 3, frozenAt);
  await s.t.run(async (ctx) => {
    const p = (await ctx.db.query('federationPeers').unique())!;
    await ctx.db.patch(p._id, { deploymentInstanceId: 'current-instance', deploymentEpoch: 3 });
  });
  const old = await signedProbe(s, {
    senderDeploymentInstanceId: 'remote-instance',
    sentAt: frozenAt,
  });
  await expect(s.t.action(actionRef('transport/receiveProbe'), { packet: old })).rejects.toThrow(
    'SENDER_DEPLOYMENT_MISMATCH',
  );
  expect((await s.t.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'ACTIVE',
  );
  const higher = await observeHealth(
    s,
    health('town:remote', s.remoteKeys, 'unknown-successor', 99),
  );
  expect(higher.disposition).toBe('CONFLICT');
  // A higher epoch alone is no handoff. A retired source signing after its freeze is also a conflict.
  const s2 = await setup();
  await seedHandoff(s2, 'remote-instance', 1, 'successor', 2, frozenAt);
  await s2.t.run(async (ctx) => {
    const p = (await ctx.db.query('federationPeers').unique())!;
    await ctx.db.patch(p._id, { deploymentInstanceId: 'successor', deploymentEpoch: 2 });
  });
  jest.setSystemTime(frozenAt + 1000);
  await expect(
    s2.t.action(actionRef('transport/receiveProbe'), {
      packet: await signedProbe(s2, {
        senderDeploymentInstanceId: 'remote-instance',
      }),
    }),
  ).rejects.toThrow('TOWN_CLONE_CONFLICT');
});

test('tampered handoff history never exempts signed conflicting traffic', async () => {
  const s = await setup();
  await seedHandoff(s, 'clone-instance', 1, 'remote-instance', 2, Date.now(), true);
  await s.t.run(async (ctx) => {
    const p = (await ctx.db.query('federationPeers').unique())!;
    await ctx.db.patch(p._id, { deploymentEpoch: 2 });
  });
  await quarantined(s);
});

test('retired legacy discovery lacks evidence of new issuance while explicit post-freeze signed time proves conflict', async () => {
  const s = await setup(),
    frozenAt = Date.now();
  await seedHandoff(s, 'remote-instance', 1, 'successor', 2, frozenAt);
  await s.t.run(async (ctx) => {
    const p = (await ctx.db.query('federationPeers').unique())!;
    await ctx.db.patch(p._id, { deploymentInstanceId: 'successor', deploymentEpoch: 2 });
  });
  jest.setSystemTime(frozenAt + 1000);
  const legacy: Omit<ReturnType<typeof health>, 'sentAt'> & { sentAt?: number } = health(
    'town:remote',
    s.remoteKeys,
    'remote-instance',
  );
  delete legacy.sentAt;
  expect(await observeHealth(s, legacy)).toEqual({ disposition: 'RETIRED_SOURCE' });
  expect((await s.t.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'ACTIVE',
  );
  expect(
    (await observeHealth(s, health('town:remote', s.remoteKeys, 'remote-instance'))).disposition,
  ).toBe('CONFLICT');
});

test('the frozen source recognizes its explicitly authorized migration target without a clone allegation', async () => {
  const s = await setup(),
    frozenAt = Date.now();
  const body = {
    purpose: 'ai-town-migration-handoff/1',
    handoffId: 'local-to-successor',
    townId: 'town:local',
    publicKey: s.localKeys.publicKey,
    sourceDeploymentInstanceId: 'local-instance',
    sourceDeploymentEpoch: 1,
    target: {
      townId: 'town:local',
      publicKey: s.localKeys.publicKey,
      deploymentInstanceId: 'successor',
      deploymentEpoch: 2,
      endpoint: 'https://successor.example/federation/v1',
    },
    frozenAt,
    issuedAt: frozenAt,
    operator: 'Owner',
    authorityScope: 'ALL_FEDERATION_AUTHORITY_DRAINED',
    peers: [],
  };
  const signature = await sign(body, s.localKeys.privateKeyEncrypted);
  await s.t.run(async (ctx) => {
    const local = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(local._id, { mode: 'MIGRATING_OUT', activeHandoffId: body.handoffId });
    await ctx.db.insert('migrationHandoffRecords', {
      handoffId: body.handoffId,
      townId: body.townId,
      body,
      signature,
      role: 'SOURCE',
      acceptedAt: Date.now(),
    });
  });
  expect(
    await observeHealth(s, health('town:local', s.localKeys, 'successor', 2), s.localKeys),
  ).toEqual({ disposition: 'HANDOFF_TARGET' });
  expect((await s.t.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'MIGRATING_OUT',
  );
  expect(await s.t.run((ctx) => ctx.db.query('federationIdentityConflicts').collect())).toEqual([]);
});

test('quarantine cannot be bypassed through initialization, settings, peer policy or migration activation', async () => {
  const s = await setup();
  await quarantined(s);
  await s.t.action(actionRef('admin/initialize'), {
    adminToken,
    townName: 'Replacement',
    endpoint: 'https://replacement.example',
  });
  expect((await s.t.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'QUARANTINED',
  );
  await expect(
    s.t.mutation(mutationRef('admin/configure'), {
      adminToken,
      enabled: true,
      allowIncomingPairRequests: true,
      maxVisitors: 2,
      maxVisitDurationMs: 300000,
    }),
  ).rejects.toThrow('DEPLOYMENT_NOT_ACTIVE');
  await expect(
    s.t.mutation(mutationRef('peers/setPolicy'), {
      adminToken,
      peerTownId: 'town:remote',
      trustState: 'TRUSTED',
      inboundVisitsAllowed: true,
      outboundVisitsAllowed: true,
    }),
  ).rejects.toThrow('TOWN_CLONE_CONFLICT');
  await expect(s.t.action(actionRef('migration/prepareTarget'), { adminToken })).rejects.toThrow();
});

test('manual review is authenticated, requires stopped source and drained visits, and cannot reopen old credentials', async () => {
  const s = await setup(),
    packet = await quarantined(s);
  const conflict = (await s.t.run((ctx) => ctx.db.query('federationIdentityConflicts').unique()))!;
  const args = {
    adminToken,
    conflictId: conflict._id,
    operator: 'Town owner',
    reason: 'Conflicting instance stopped; retain the known deployment and repair credentials',
    sourceStopped: true,
    decision: 'RETAIN_KNOWN' as const,
  };
  await expect(
    s.t.mutation(mutationRef('identityConflict/resolve'), { ...args, adminToken: 'bad' }),
  ).rejects.toThrow('ADMIN_UNAUTHORIZED');
  await expect(
    s.t.mutation(mutationRef('identityConflict/resolve'), { ...args, sourceStopped: false }),
  ).rejects.toThrow('CONFLICTING_SOURCE_STOP_REQUIRED');
  await expect(
    s.t.mutation(mutationRef('identityConflict/resolve'), { ...args, reason: '' }),
  ).rejects.toThrow('CONFLICT_REVIEW_DETAILS_REQUIRED');
  const visitId = await s.t.run((ctx) =>
    ctx.db.insert('visitLedger', {
      visitId: 'active-visit',
      agentGlobalId: 'town:local/agent:1',
      homeTownId: 'town:local',
      hostTownId: 'town:remote',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      leaseExpiry: Date.now() + 30000,
      fencingToken: 'fence',
      state: 'ACTIVE',
      role: 'home',
      profile: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await expect(s.t.mutation(mutationRef('identityConflict/resolve'), args)).rejects.toThrow(
    'CONFLICT_VISITS_NOT_DRAINED',
  );
  // Existing lease cleanup remains admissible while new authorizations are stopped.
  await s.t.mutation(mutationRef('ledger/returnVisit'), { adminToken, visitId: 'active-visit' });
  expect((await s.t.run((ctx) => ctx.db.get(visitId)))?.state).toBe('RETURN_PENDING');
  expect((await s.t.run((ctx) => ctx.db.query('federationOutbox').unique()))?.envelope.type).toBe(
    'VISIT_RETURN',
  );
  await s.t.run((ctx) => ctx.db.patch(visitId, { state: 'COMPLETED', cleanupConfirmed: true }));
  expect(await s.t.mutation(mutationRef('identityConflict/resolve'), args)).toEqual({
    released: true,
    federationEnabled: false,
    repairRequired: true,
  });
  const local = await s.t.run((ctx) => ctx.db.query('federationIdentity').unique());
  expect(local).toMatchObject({ mode: 'ACTIVE', enabled: false, allowIncomingPairRequests: false });
  const remote = (await s.t.run((ctx) => ctx.db.query('federationPeers').unique()))!;
  expect(remote).toMatchObject({
    trustState: 'REVOKED',
    inboundVisitsAllowed: false,
    outboundVisitsAllowed: false,
    credentialEncrypted: '',
  });
  expect(remote.credentialId).not.toBe(packet.body.credentialId);
  await expect(
    s.t.mutation(mutationRef('peers/setPolicy'), {
      adminToken,
      peerTownId: 'town:remote',
      trustState: 'TRUSTED',
      inboundVisitsAllowed: true,
      outboundVisitsAllowed: true,
    }),
  ).rejects.toThrow('REPAIR_REQUIRED');
  expect(
    (await s.t.query(queryRef('identityConflict/status'), { adminToken })).audit.map(
      (a: any) => a.operation,
    ),
  ).toEqual(['RELEASED', 'RESOLVED', 'DETECTED']);
});

test('every conflict needs review; replayed reviewed health evidence cannot freeze a repaired town again', async () => {
  const s = await setup(),
    body = health('town:remote', s.remoteKeys, 'first-clone');
  const packet = { body, signature: await sign(body, s.remoteKeys.privateKeyEncrypted) };
  await s.t.mutation(mutationRef('identityConflict/observe'), { source: 'HEALTH', packet });
  await observeHealth(s, health('town:remote', s.remoteKeys, 'second-clone'));
  const conflicts = await s.t.run((ctx) => ctx.db.query('federationIdentityConflicts').collect());
  const args = {
    adminToken,
    operator: 'Owner',
    reason: 'Verified both sources stopped',
    sourceStopped: true,
    decision: 'REVOKE_PEER' as const,
  };
  expect(
    (
      await s.t.mutation(mutationRef('identityConflict/resolve'), {
        ...args,
        conflictId: conflicts[0]._id,
      })
    ).released,
  ).toBe(false);
  expect((await s.t.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'QUARANTINED',
  );
  expect(
    (
      await s.t.mutation(mutationRef('identityConflict/resolve'), {
        ...args,
        conflictId: conflicts[1]._id,
      })
    ).released,
  ).toBe(true);
  expect(
    (await s.t.mutation(mutationRef('identityConflict/observe'), { source: 'HEALTH', packet }))
      .disposition,
  ).toBe('RESOLVED_EVIDENCE');
  expect((await s.t.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'ACTIVE',
  );
  jest.setSystemTime(Date.now() + 1000);
  expect(
    (await observeHealth(s, health('town:remote', s.remoteKeys, 'first-clone'))).disposition,
  ).toBe('CONFLICT');
  expect((await s.t.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'QUARANTINED',
  );
});
