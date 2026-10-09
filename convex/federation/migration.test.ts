import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { actionRef, mutationRef, queryRef } from './refs';
import {
  createIdentityKeys,
  digest,
  ephemeralKeys,
  openSecret,
  randomSecret,
  sealSecret,
  sign,
  signPacket,
} from './security';
import { PROTOCOL } from './protocol';
import { homeResumed } from './ledger';
import { enqueueMessage } from './queue';
import { decodeRow, validateBundle } from './backupHelpers';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/store.ts': () => import('./store'),
  '../federation/transport.ts': () => import('./transport'),
  '../federation/ledger.ts': () => import('./ledger'),
  '../federation/runtime.ts': () => import('./runtime'),
  '../federation/peers.ts': () => import('./peers'),
  '../federation/admin.ts': () => import('./admin'),
  '../federation/migration.ts': () => import('./migration'),
  '../federation/identityRecovery.ts': () => import('./identityRecovery'),
  '../federation/backup.ts': () => import('./backup'),
  '../http.ts': async () => {
    const { httpRouter } = await import('convex/server');
    const { registerFederationRoutes } = await import('./transport');
    const { registerPairingRoutes } = await import('./peers');
    const { registerMigrationRoutes } = await import('./migration');
    const http = httpRouter();
    registerFederationRoutes(http);
    registerPairingRoutes(http);
    registerMigrationRoutes(http);
    return { default: http };
  },
};
const adminToken = 'federation-test-admin-token-32-bytes';
const passphrase = 'migration-independent-private-archive-passphrase';
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
    b = convexTest(schema, modules),
    a2 = convexTest(schema, modules);
  const keysA = await createIdentityKeys(),
    keysB = await createIdentityKeys(),
    credentialEncrypted = await sealSecret(randomSecret());
  for (const [t, townId, keys, instance] of [
    [a, 'town:a', keysA, 'source-a'],
    [b, 'town:b', keysB, 'peer-b'],
  ] as const) {
    await t.run((ctx) =>
      ctx.db.insert('federationIdentity', {
        ...keys,
        townId,
        townName: townId,
        endpoint: `https://${townId === 'town:a' ? 'source-a' : 'peer-b'}.example/federation/v1`,
        deploymentInstanceId: instance,
        deploymentEpoch: 1,
        enabled: true,
        allowIncomingPairRequests: true,
        allowUnencryptedHttp: false,
        allowPublicHttp: false,
        maxVisitors: 1,
        maxVisitDurationMs: 300000,
        mode: 'ACTIVE',
        createdAt: Date.now(),
      }),
    );
  }
  for (const [t, townId, keys, instance] of [
    [a, 'town:b', keysB, 'peer-b'],
    [b, 'town:a', keysA, 'source-a'],
  ] as const) {
    await t.run(async (ctx) => {
      await ctx.db.insert('federationPeers', {
        townId,
        townName: townId,
        publicKey: keys.publicKey,
        fingerprint: keys.fingerprint,
        deploymentInstanceId: instance,
        deploymentEpoch: 1,
        endpoint: `https://${instance}.example/federation/v1`,
        credentialId: 'old-credential',
        credentialEncrypted,
        trustState: 'TRUSTED',
        inboundVisitsAllowed: true,
        outboundVisitsAllowed: false,
        pairedAt: Date.now(),
      });
      await ctx.db.insert('transportSessions', {
        peerTownId: townId,
        channelState: 'TRANSPORT_READY',
        transportType: 'DIRECT_HTTPS',
        localDeploymentEpoch: 1,
        verifiedPeerDeploymentEpoch: 1,
        outboundVerifiedAt: Date.now(),
        inboundVerifiedAt: Date.now(),
      });
    });
  }
  const encrypted = await a.action(actionRef('identityRecovery/exportEncryptedIdentity'), {
    adminToken,
    passphrase,
  });
  const recovered = await a2.action(actionRef('identityRecovery/restoreEncryptedIdentity'), {
    adminToken,
    passphrase,
    package: encrypted,
    sourceStopped: true,
    endpoint: 'https://target-a.example/federation/v1',
  });
  globalThis.fetch = ((url: any, init: any) => {
    const hostname = new URL(String(url)).hostname;
    const target = hostname === 'peer-b.example' ? b : hostname === 'target-a.example' ? a2 : a;
    return target.fetch(new URL(String(url)).pathname, {
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body,
    });
  }) as typeof fetch;
  return { a, a2, b, keysA, keysB, credentialEncrypted, recovered };
}
async function handoff(s: Awaited<ReturnType<typeof setup>>) {
  await s.a.mutation(mutationRef('migration/freezeSource'), {
    adminToken,
    operator: 'migration-admin',
  });
  const targetPacket = await s.a2.action(actionRef('migration/prepareTarget'), {
    adminToken,
    endpoint: 'https://target-a.example/federation/v1',
  });
  const packet = await s.a.mutation(mutationRef('migration/signHandoff'), {
    adminToken,
    targetPacket,
  });
  return { packet, targetPacket };
}
function oldProbe(overrides = {}) {
  const nonce = crypto.randomUUID();
  return {
    protocol: PROTOCOL,
    type: 'TRANSPORT_PROBE',
    messageId: crypto.randomUUID(),
    fromTownId: 'town:a',
    toTownId: 'town:b',
    senderDeploymentInstanceId: 'source-a',
    senderDeploymentEpoch: 1,
    expectedRecipientDeploymentEpoch: 1,
    credentialId: 'old-credential',
    sentAt: Date.now(),
    expiresAt: Date.now() + 30000,
    nonce,
    payload: { probeId: crypto.randomUUID(), nonce },
    ...overrides,
  };
}

test('signed handoff preserves Town identity, rotates peer credentials, fences old deployment and requires independent probes', async () => {
  const s = await setup(),
    { packet, targetPacket } = await handoff(s);
  expect(
    await s.a.mutation(mutationRef('migration/signHandoff'), { adminToken, targetPacket }),
  ).toEqual(packet);
  await s.a2.mutation(mutationRef('migration/activateTarget'), { adminToken, packet });
  expect(
    await s.a2.action(actionRef('migration/notifyPeer'), { adminToken, peerTownId: 'town:b' }),
  ).toEqual({ channelState: 'TRANSPORT_TESTING' });
  const bPeer = (await s.b.run((ctx) => ctx.db.query('federationPeers').unique()))!;
  const targetPeer = (await s.a2.run((ctx) => ctx.db.query('federationPeers').unique()))!;
  expect(bPeer.deploymentInstanceId).toBe(s.recovered.deploymentInstanceId);
  expect(bPeer.deploymentEpoch).toBe(2);
  expect(bPeer.publicKey).toBe(s.keysA.publicKey);
  expect(bPeer.credentialId).not.toBe('old-credential');
  expect(await openSecret(bPeer.credentialEncrypted)).toBe(
    await openSecret(targetPeer.credentialEncrypted),
  );
  expect(targetPeer.outboundVisitsAllowed).toBe(false);
  expect((await s.a2.run((ctx) => ctx.db.query('transportSessions').unique()))?.channelState).toBe(
    'TRANSPORT_TESTING',
  );
  await expect(
    s.b.action(actionRef('transport/receiveProbe'), {
      packet: await signPacket(oldProbe(), s.keysA.privateKeyEncrypted, s.credentialEncrypted),
    }),
  ).rejects.toThrow('MESSAGE_AUTH_FAILED');
  await expect(
    s.b.mutation(mutationRef('transport/acceptProbe'), {
      message: oldProbe({ credentialId: bPeer.credentialId }),
    }),
  ).rejects.toThrow('SENDER_DEPLOYMENT_MISMATCH');
  expect(await s.b.action(actionRef('transport/probeInternal'), { peerTownId: 'town:a' })).toEqual({
    channelState: 'TRANSPORT_READY',
  });
  for (const t of [s.a2, s.b]) {
    expect((await t.run((ctx) => ctx.db.query('transportSessions').unique()))?.channelState).toBe(
      'TRANSPORT_READY',
    );
    expect(await t.run((ctx) => ctx.db.query('visitLedger').collect())).toEqual([]);
  }
  expect((await s.a.fetch('/federation/v1/health')).status).toBe(503);
  const sourceIdentity = (await s.a.run((ctx) => ctx.db.query('federationIdentity').unique()))!;
  expect(sourceIdentity.mode).toBe('MIGRATING_OUT');
  expect(sourceIdentity.privateKeyEncrypted).toBe(s.keysA.privateKeyEncrypted);
  await expect(
    s.a.mutation(mutationRef('admin/configure'), {
      adminToken,
      enabled: true,
      allowIncomingPairRequests: true,
      maxVisitors: 1,
      maxVisitDurationMs: 300000,
    }),
  ).rejects.toThrow('DEPLOYMENT_NOT_ACTIVE');
  expect(
    (await s.b.run((ctx) => ctx.db.query('migrationHandoffRecords').unique()))?.signature,
  ).toBe(packet.signature);
  const archive = await s.a.query(queryRef('backup/getTown'), { adminToken });
  expect(archive.sections.migrationHandoffRecords.map(decodeRow)[0].body).toEqual(packet.body);
  expect(JSON.stringify(archive)).not.toMatch(
    /privateKeyEncrypted|credentialEncrypted|ephemeralPrivate/,
  );
  // Existing signed v1 archives predate the additive history section.
  delete archive.sections.migrationHandoffRecords;
  delete archive.manifest.sections.migrationHandoffRecords;
  archive.signature = await sign(archive.manifest, s.keysA.privateKeyEncrypted);
  await expect(validateBundle(archive)).resolves.toBe(archive);
});

test('sourceStopped disaster recovery flag never supplies formal handoff authority', async () => {
  const s = await setup();
  await s.a2.action(actionRef('migration/prepareTarget'), {
    adminToken,
    endpoint: 'https://target-a.example/federation/v1',
  });
  await expect(
    s.a2.mutation(mutationRef('migration/activateTarget'), {
      adminToken,
      packet: { sourceStopped: true },
    }),
  ).rejects.toThrow('INVALID_MIGRATION_HANDOFF');
  expect((await s.a2.run((ctx) => ctx.db.query('federationIdentity').unique()))?.enabled).toBe(
    false,
  );
  expect((await s.b.run((ctx) => ctx.db.query('federationPeers').unique()))?.deploymentEpoch).toBe(
    1,
  );
});

test('freeze drains visits before signing and refuses new authority while existing cleanup remains usable', async () => {
  const s = await setup();
  await s.a.run((ctx) =>
    ctx.db.insert('visitLedger', {
      visitId: 'old-visit',
      agentGlobalId: 'town:a/agent:1',
      homeTownId: 'town:a',
      hostTownId: 'town:b',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      leaseExpiry: Date.now() - 61000,
      fencingToken: 'fencing-secret-of-old-visit',
      state: 'ACTIVE',
      role: 'home',
      profile: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await s.a.mutation(mutationRef('migration/freezeSource'), {
    adminToken,
    operator: 'migration-admin',
  });
  expect((await s.a.run((ctx) => ctx.db.query('visitLedger').unique()))?.state).toBe(
    'RETURN_PENDING',
  );
  expect((await s.a.run((ctx) => ctx.db.query('federationOutbox').unique()))?.envelope.type).toBe(
    'VISIT_RETURN',
  );
  await expect(
    s.a.run((ctx) =>
      enqueueMessage(ctx, {
        peerTownId: 'town:b',
        type: 'VISIT_RENEW',
        visitId: 'old-visit',
        payload: {},
      }),
    ),
  ).rejects.toThrow('DEPLOYMENT_NOT_ACTIVE');
  const targetPacket = await s.a2.action(actionRef('migration/prepareTarget'), {
    adminToken,
    endpoint: 'https://target-a.example/federation/v1',
  });
  await expect(
    s.a.mutation(mutationRef('migration/signHandoff'), { adminToken, targetPacket }),
  ).rejects.toThrow('MIGRATION_VISITS_NOT_DRAINED');
  await s.a.run((ctx) => homeResumed(ctx, 'old-visit'));
  expect(
    (await s.a.mutation(mutationRef('migration/signHandoff'), { adminToken, targetPacket })).body
      .authorityScope,
  ).toBe('ALL_FEDERATION_AUTHORITY_DRAINED');
});

test('tampered handoffs and mismatching target instances cannot activate or move peer fencing', async () => {
  const s = await setup(),
    { packet } = await handoff(s);
  const tampered = { ...packet, body: { ...packet.body, operator: 'attacker' } };
  await expect(
    s.a2.mutation(mutationRef('migration/activateTarget'), { adminToken, packet: tampered }),
  ).rejects.toThrow('INVALID_MIGRATION_HANDOFF');
  const body = {
    ...packet.body,
    target: { ...packet.body.target, deploymentInstanceId: 'another-target' },
  };
  await expect(
    s.a2.mutation(mutationRef('migration/activateTarget'), {
      adminToken,
      packet: { body, signature: await sign(body, s.keysA.privateKeyEncrypted) },
    }),
  ).rejects.toThrow('MIGRATION_TARGET_MISMATCH');
  const rollback = { ...packet.body, target: { ...packet.body.target, deploymentEpoch: 1 } };
  await expect(
    s.a2.mutation(mutationRef('migration/activateTarget'), {
      adminToken,
      packet: { body: rollback, signature: await sign(rollback, s.keysA.privateKeyEncrypted) },
    }),
  ).rejects.toThrow('INVALID_MIGRATION_HANDOFF');
  expect((await s.b.run((ctx) => ctx.db.query('federationPeers').unique()))?.deploymentEpoch).toBe(
    1,
  );
});

test('signing waits for the source engine pause and activation waits for every restored runtime reconciliation', async () => {
  const s = await setup();
  const engineId = await s.a.run((ctx) =>
    ctx.db.insert('engines', { running: true, generationNumber: 1 }),
  );
  await s.a.mutation(mutationRef('migration/freezeSource'), {
    adminToken,
    operator: 'migration-admin',
  });
  const targetPacket = await s.a2.action(actionRef('migration/prepareTarget'), {
    adminToken,
    endpoint: 'https://target-a.example/federation/v1',
  });
  await expect(
    s.a.mutation(mutationRef('migration/signHandoff'), { adminToken, targetPacket }),
  ).rejects.toThrow('STOP_SOURCE_ENGINE_BEFORE_HANDOFF');
  expect(await s.a.run((ctx) => ctx.db.query('migrationHandoffRecords').collect())).toEqual([]);
  await s.a.run((ctx) => ctx.db.patch(engineId, { running: false, generationNumber: 2 }));
  const packet = await s.a.mutation(mutationRef('migration/signHandoff'), {
    adminToken,
    targetPacket,
  });
  const runtimeId = await s.a2.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 2,
      players: [],
      agents: [],
      conversations: [],
    });
    return ctx.db.insert('federationAgentRuntimes', {
      worldId,
      playerId: 'p:1',
      agentId: 'a:1',
      agentGlobalId: 'town:a/agent:1',
      homeTownId: 'town:a',
      state: 'NEEDS_RECONCILIATION',
      visitId: 'old-visit',
      agentAuthorityEpoch: 2,
      updatedAt: Date.now(),
    });
  });
  await expect(
    s.a2.mutation(mutationRef('migration/activateTarget'), { adminToken, packet }),
  ).rejects.toThrow('MIGRATION_VISITS_NOT_DRAINED');
  expect((await s.a2.run((ctx) => ctx.db.query('federationIdentity').unique()))?.mode).toBe(
    'MIGRATING_IN',
  );
  expect(await s.a2.run((ctx) => ctx.db.query('federationPeers').collect())).toEqual([]);
  await s.a2.run((ctx) =>
    ctx.db.patch(runtimeId, { state: 'HOME_ACTIVE', visitId: undefined, agentAuthorityEpoch: 3 }),
  );
  await s.a2.mutation(mutationRef('migration/activateTarget'), { adminToken, packet });
  expect(
    await s.a2.mutation(mutationRef('migration/activateTarget'), { adminToken, packet }),
  ).toEqual({ townId: 'town:a', deploymentEpoch: 2 });
  expect(await s.a2.run((ctx) => ctx.db.query('migrationHandoffRecords').collect())).toHaveLength(
    1,
  );
  expect((await s.a2.run((ctx) => ctx.db.get(runtimeId)))?.agentGlobalId).toBe('town:a/agent:1');
});

test('lost peer acceptance response resumes the durable exchange without another credential or epoch', async () => {
  const s = await setup(),
    { packet } = await handoff(s);
  await s.a2.mutation(mutationRef('migration/activateTarget'), { adminToken, packet });
  const routed = globalThis.fetch;
  let lost = false;
  globalThis.fetch = (async (url: any, init: any) => {
    const response = await routed(url, init);
    if (String(url).endsWith('/migration') && !lost) {
      lost = true;
      throw new Error('RESPONSE_LOST_AFTER_COMMIT');
    }
    return response;
  }) as typeof fetch;
  await expect(
    s.a2.action(actionRef('migration/notifyPeer'), { adminToken, peerTownId: 'town:b' }),
  ).rejects.toThrow('RESPONSE_LOST_AFTER_COMMIT');
  const accepted = (await s.b.run((ctx) => ctx.db.query('federationPeers').unique()))!;
  expect(accepted.deploymentEpoch).toBe(2);
  expect((await s.a2.run((ctx) => ctx.db.query('migrationPeerExchanges').unique()))?.state).toBe(
    'PENDING',
  );
  await s.a2.action(actionRef('migration/notifyPeer'), { adminToken, peerTownId: 'town:b' });
  expect(
    (await s.b.run((ctx) => ctx.db.query('federationPeers').unique()))?.credentialEncrypted,
  ).toBe(accepted.credentialEncrypted);
  expect(await s.b.run((ctx) => ctx.db.query('migrationPeerExchanges').collect())).toHaveLength(1);
  const e = (await s.a2.run((ctx) => ctx.db.query('migrationPeerExchanges').unique()))!;
  expect(e.state).toBe('ACCEPTED');
  expect(e.ephemeralPrivateEncrypted).toBeUndefined();
  const changedBody = { ...e.request.body, nonce: 'replacement-nonce' };
  await expect(
    s.b.action(actionRef('migration/receiveExchange'), {
      packet: {
        body: changedBody,
        signature: await sign(changedBody, s.keysA.privateKeyEncrypted),
      },
    }),
  ).rejects.toThrow('MIGRATION_EXCHANGE_CONFLICT');
});

test('successive formal migrations retain signed history and peers never accept the previous handoff again', async () => {
  const s = await setup(),
    first = await handoff(s);
  await s.a2.mutation(mutationRef('migration/activateTarget'), {
    adminToken,
    packet: first.packet,
  });
  await s.a2.action(actionRef('migration/notifyPeer'), { adminToken, peerTownId: 'town:b' });
  const firstExchange = (await s.a2.run((ctx) => ctx.db.query('migrationPeerExchanges').unique()))!;
  const a3 = convexTest(schema, modules);
  const encrypted = await s.a2.action(actionRef('identityRecovery/exportEncryptedIdentity'), {
    adminToken,
    passphrase,
  });
  await a3.action(actionRef('identityRecovery/restoreEncryptedIdentity'), {
    adminToken,
    passphrase,
    package: encrypted,
    sourceStopped: true,
    endpoint: 'https://target-a3.example/federation/v1',
  });
  await s.a2.mutation(mutationRef('migration/freezeSource'), {
    adminToken,
    operator: 'second-migration-admin',
  });
  const targetPacket = await a3.action(actionRef('migration/prepareTarget'), {
    adminToken,
    endpoint: 'https://target-a3.example/federation/v1',
  });
  const second = await s.a2.mutation(mutationRef('migration/signHandoff'), {
    adminToken,
    targetPacket,
  });
  expect(second.body.sourceDeploymentEpoch).toBe(2);
  expect(second.body.target.deploymentEpoch).toBe(3);
  await a3.mutation(mutationRef('migration/activateTarget'), { adminToken, packet: second });
  const routed = globalThis.fetch;
  globalThis.fetch = ((url: any, init: any) =>
    new URL(String(url)).hostname === 'target-a3.example'
      ? a3.fetch(new URL(String(url)).pathname, {
          method: init?.method ?? 'GET',
          headers: init?.headers,
          body: init?.body,
        })
      : routed(url, init)) as typeof fetch;
  await a3.action(actionRef('migration/notifyPeer'), { adminToken, peerTownId: 'town:b' });
  expect((await s.b.run((ctx) => ctx.db.query('federationPeers').unique()))?.deploymentEpoch).toBe(
    3,
  );
  expect(await s.a2.run((ctx) => ctx.db.query('migrationHandoffRecords').collect())).toHaveLength(
    2,
  );
  expect(await s.b.run((ctx) => ctx.db.query('migrationHandoffRecords').collect())).toHaveLength(2);
  await expect(
    s.b.action(actionRef('migration/receiveExchange'), { packet: firstExchange.request }),
  ).rejects.toThrow('MIGRATION_EXCHANGE_CONFLICT');
  expect((await s.b.run((ctx) => ctx.db.query('federationPeers').unique()))?.deploymentEpoch).toBe(
    3,
  );
});

test('peer requires old visits reconciled and rejects unsigned successor assertions without partial writes', async () => {
  const s = await setup(),
    { packet } = await handoff(s);
  await s.a2.mutation(mutationRef('migration/activateTarget'), { adminToken, packet });
  const visitId = await s.b.run((ctx) =>
    ctx.db.insert('visitLedger', {
      visitId: 'peer-old-visit',
      agentGlobalId: 'town:a/agent:1',
      homeTownId: 'town:a',
      hostTownId: 'town:b',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 1,
      visitLeaseVersion: 1,
      leaseExpiry: Date.now() + 60000,
      fencingToken: 'old-token',
      state: 'ACTIVE',
      role: 'host',
      profile: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await expect(
    s.a2.action(actionRef('migration/notifyPeer'), { adminToken, peerTownId: 'town:b' }),
  ).rejects.toThrow('FEDERATION_HTTP_400');
  expect((await s.b.run((ctx) => ctx.db.query('federationPeers').unique()))?.deploymentEpoch).toBe(
    1,
  );
  const e = (await s.a2.run((ctx) => ctx.db.query('migrationPeerExchanges').unique()))!;
  const forged = { ...e.request, signature: 'unsigned' };
  await expect(
    s.b.action(actionRef('migration/receiveExchange'), { packet: forged }),
  ).rejects.toThrow('INVALID_MIGRATION_EXCHANGE');
  await s.b.run((ctx) => ctx.db.patch(visitId, { state: 'COMPLETED', cleanupConfirmed: true }));
  await s.a2.action(actionRef('migration/notifyPeer'), { adminToken, peerTownId: 'town:b' });
  expect((await s.b.run((ctx) => ctx.db.query('federationPeers').unique()))?.deploymentEpoch).toBe(
    2,
  );
  expect(await digest(e.request)).toBe(
    (await s.b.run((ctx) => ctx.db.query('migrationPeerExchanges').unique()))?.response.body
      .requestDigest,
  );
});

test('the acceptance mutation commits action-generated ECDH material with randomized key generation disabled', async () => {
  const s = await setup(),
    { packet } = await handoff(s);
  await s.a2.mutation(mutationRef('migration/activateTarget'), { adminToken, packet });
  globalThis.fetch = (async () => {
    throw new Error('HOLD_REQUEST_FOR_TRANSACTION_TEST');
  }) as typeof fetch;
  await expect(
    s.a2.action(actionRef('migration/notifyPeer'), { adminToken, peerTownId: 'town:b' }),
  ).rejects.toThrow('HOLD_REQUEST_FOR_TRANSACTION_TEST');
  const e = (await s.a2.run((ctx) => ctx.db.query('migrationPeerExchanges').unique()))!;
  const keys = await ephemeralKeys();
  const randomizedKeys = jest.spyOn(crypto.subtle, 'generateKey').mockImplementation(() => {
    throw new Error('CRYPTOGRAPHIC_RANDOMNESS_FORBIDDEN_IN_MUTATION');
  });
  try {
    const args = {
      packet: e.request,
      ephemeralPublicKey: keys.publicKey,
      ephemeralPrivateEncrypted: keys.privateKeyEncrypted,
    };
    const response = await s.b.mutation(mutationRef('migration/acceptExchange'), args);
    expect(response.body.ephemeralPublicKey).toEqual(keys.publicKey);
    expect(await s.b.mutation(mutationRef('migration/acceptExchange'), args)).toEqual(response);
    expect(randomizedKeys).not.toHaveBeenCalled();
    expect(
      (await s.b.run((ctx) => ctx.db.query('federationPeers').unique()))?.deploymentEpoch,
    ).toBe(2);
    expect(await s.b.run((ctx) => ctx.db.query('migrationPeerExchanges').collect())).toHaveLength(
      1,
    );
  } finally {
    randomizedKeys.mockRestore();
  }
});

test('action-generated ECDH material cannot bypass a peer fencing change before the acceptance transaction', async () => {
  const s = await setup(),
    { packet } = await handoff(s);
  await s.a2.mutation(mutationRef('migration/activateTarget'), { adminToken, packet });
  globalThis.fetch = (async () => {
    throw new Error('HOLD_REQUEST_FOR_FENCING_TEST');
  }) as typeof fetch;
  await expect(
    s.a2.action(actionRef('migration/notifyPeer'), { adminToken, peerTownId: 'town:b' }),
  ).rejects.toThrow('HOLD_REQUEST_FOR_FENCING_TEST');
  const e = (await s.a2.run((ctx) => ctx.db.query('migrationPeerExchanges').unique()))!;
  const keys = await ephemeralKeys();
  await s.b.run(async (ctx) => {
    const p = (await ctx.db.query('federationPeers').unique())!;
    await ctx.db.patch(p._id, {
      deploymentEpoch: 99,
      deploymentInstanceId: 'concurrent-successor',
    });
  });
  await expect(
    s.b.mutation(mutationRef('migration/acceptExchange'), {
      packet: e.request,
      ephemeralPublicKey: keys.publicKey,
      ephemeralPrivateEncrypted: keys.privateKeyEncrypted,
    }),
  ).rejects.toThrow('MIGRATION_SOURCE_FENCED');
  expect((await s.b.run((ctx) => ctx.db.query('federationPeers').unique()))?.deploymentEpoch).toBe(
    99,
  );
  expect(await s.b.run((ctx) => ctx.db.query('migrationPeerExchanges').collect())).toEqual([]);
  expect(await s.b.run((ctx) => ctx.db.query('migrationHandoffRecords').collect())).toEqual([]);
});
