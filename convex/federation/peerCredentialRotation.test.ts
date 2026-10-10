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
  signPacket,
  verifyPacket,
} from './security';
import { FederationMessage, PROTOCOL } from './protocol';
import { MAX_OVERLAP_MS, MIN_OVERLAP_MS } from './peerCredentialRotation';
import { createBundle, dataTables, snapshotTables, validateBundle } from './backupHelpers';
import { largeTables } from './backupLargeHelpers';
import { credentialForPeer, renewedCredentialIdForPeer } from './credentials';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/store.ts': () => import('./store'),
  '../federation/transport.ts': () => import('./transport'),
  '../federation/peerCredentialRotation.ts': () => import('./peerCredentialRotation'),
  '../federation/peers.ts': () => import('./peers'),
  '../federation/identityConflict.ts': () => import('./identityConflict'),
  '../federation/ledger.ts': () => import('./ledger'),
  '../http.ts': async () => {
    const { httpRouter } = await import('convex/server');
    const { registerCredentialRotationRoutes } = await import('./peerCredentialRotation');
    const { registerFederationRoutes } = await import('./transport');
    const http = httpRouter();
    registerCredentialRotationRoutes(http);
    registerFederationRoutes(http);
    return { default: http };
  },
};
const adminToken = 'credential-rotation-test-administrator';
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

test('rotation authentication state is excluded from backup tables and cannot be imported as a town data section', async () => {
  const table = 'federationCredentialRotations';
  expect([...dataTables, ...snapshotTables, ...largeTables]).not.toContain(table);
  const bundle = await createBundle('a', 'town', {
    [table]: [{ rotationId: 'replayed', state: 'COMMITTED' }],
  });
  await expect(validateBundle(bundle)).rejects.toThrow('INVALID_BACKUP_SECTION');
});
async function setup() {
  const a = convexTest(schema, modules),
    b = convexTest(schema, modules);
  const aKeys = await createIdentityKeys(),
    bKeys = await createIdentityKeys();
  const oldCredentialEncrypted = await sealSecret(randomSecret());
  for (const [t, name, keys, remote, remoteKeys] of [
    [a, 'a', aKeys, 'b', bKeys],
    [b, 'b', bKeys, 'a', aKeys],
  ] as const) {
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
        maxVisitors: 2,
        maxVisitDurationMs: 300000,
        mode: 'ACTIVE',
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
        credentialId: 'old-a-b',
        credentialEncrypted: oldCredentialEncrypted,
        trustState: 'TRUSTED',
        inboundVisitsAllowed: true,
        outboundVisitsAllowed: true,
        pairedAt: Date.now(),
      });
    });
  }
  const wire: any[] = [];
  const normalFetch = (async (url: any, init: any) => {
    wire.push(JSON.parse(init.body));
    const target = String(url).includes('a.example') ? a : b;
    return target.fetch(new URL(String(url)).pathname, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
  }) as typeof fetch;
  globalThis.fetch = normalFetch;
  return { a, b, aKeys, bKeys, oldCredentialEncrypted, wire, normalFetch };
}
const remote = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query('federationPeers').unique());
async function restart(t: ReturnType<typeof convexTest>) {
  const tables = [
    'federationIdentity',
    'federationPeers',
    'federationCredentialRotations',
  ] as const;
  const snapshots = await t.run((ctx) =>
    Promise.all(tables.map((table) => ctx.db.query(table).collect())),
  );
  const restarted = convexTest(schema, modules);
  await restarted.run(async (ctx) => {
    for (let i = 0; i < tables.length; i++)
      for (const { _id, _creationTime, ...record } of snapshots[i])
        await ctx.db.insert(tables[i], record as any);
  });
  return restarted;
}
function probe(credentialId = 'old-a-b'): FederationMessage {
  const nonce = crypto.randomUUID();
  return {
    protocol: PROTOCOL,
    type: 'TRANSPORT_PROBE',
    fromTownId: 'a',
    toTownId: 'b',
    senderDeploymentInstanceId: 'a-instance',
    senderDeploymentEpoch: 1,
    expectedRecipientDeploymentEpoch: 1,
    credentialId,
    messageId: crypto.randomUUID(),
    nonce,
    sentAt: Date.now(),
    expiresAt: Date.now() + 30000,
    payload: { nonce, probeId: crypto.randomUUID() },
  };
}
async function offer(s: Awaited<ReturnType<typeof setup>>, direction = 'a') {
  const keys = await ephemeralKeys(),
    rotationId = crypto.randomUUID(),
    sentAt = Date.now();
  const b = {
    protocol: PROTOCOL,
    type: 'PEER_AUTH_ROTATE',
    rotationId,
    credentialId: 'old-a-b',
    newCredentialId: `rotation:${rotationId}`,
    fromTownId: direction,
    toTownId: direction === 'a' ? 'b' : 'a',
    senderDeploymentInstanceId: `${direction}-instance`,
    senderDeploymentEpoch: 1,
    recipientDeploymentInstanceId: `${direction === 'a' ? 'b' : 'a'}-instance`,
    expectedRecipientDeploymentEpoch: 1,
    ephemeralPublicKey: keys.publicKey,
    nonce: crypto.randomUUID(),
    sentAt,
    expiresAt: sentAt + MIN_OVERLAP_MS,
  };
  return {
    packet: await signPacket(
      b,
      (direction === 'a' ? s.aKeys : s.bKeys).privateKeyEncrypted,
      s.oldCredentialEncrypted,
    ),
    requestDigest: await digest(b),
    ephemeralPrivateEncrypted: keys.privateKeyEncrypted,
  };
}

test('authenticated ECDH rotation keeps both Town identities and accepts current and bounded previous probes', async () => {
  const s = await setup();
  const before = await s.a.run((ctx) => ctx.db.query('federationIdentity').unique());
  const result = await s.a.action(actionRef('peerCredentialRotation/start'), {
    adminToken,
    peerTownId: 'b',
    overlapMs: MIN_OVERLAP_MS,
  });
  expect(result.state).toBe('COMMITTED');
  const aPeer = (await remote(s.a))!,
    bPeer = (await remote(s.b))!;
  expect(aPeer.credentialId).toBe(bPeer.credentialId);
  expect(await openSecret(aPeer.credentialEncrypted)).toBe(
    await openSecret(bPeer.credentialEncrypted),
  );
  expect(await openSecret(aPeer.credentialEncrypted)).not.toBe(
    await openSecret(s.oldCredentialEncrypted),
  );
  expect(await s.a.run((ctx) => ctx.db.query('federationIdentity').unique())).toEqual(before);
  for (const [id, encrypted] of [
    ['old-a-b', s.oldCredentialEncrypted],
    [aPeer.credentialId, aPeer.credentialEncrypted],
  ]) {
    const packet = await signPacket(probe(id), s.aKeys.privateKeyEncrypted, encrypted);
    const ack = await s.b.action(actionRef('transport/receiveProbe'), { packet });
    expect(ack.body.credentialId).toBe(id);
    expect(await verifyPacket(ack, s.bKeys.publicKey, encrypted)).toBe(true);
  }
  const history = await s.a.query(queryRef('peerCredentialRotation/status'), { adminToken });
  expect(JSON.stringify(history)).not.toMatch(
    /Encrypted|ephemeralPublicKey|signature|credentialProof/,
  );
  expect(await s.a.run((ctx) => ctx.db.query('visitLedger').collect())).toEqual([]);
});

test('lost rotation ACK retries after both restarts using the durable offer and exact responder proof', async () => {
  const s = await setup();
  let savedResponse: string | undefined;
  globalThis.fetch = (async (url: any, init: any) => {
    const response = await s.normalFetch(url, init);
    savedResponse = await response.text();
    throw new Error('LOST_ACK');
  }) as typeof fetch;
  const result = await s.a.action(actionRef('peerCredentialRotation/start'), {
    adminToken,
    peerTownId: 'b',
  });
  expect(result.state).toBe('PENDING');
  expect((await remote(s.a))!.credentialId).toBe('old-a-b');
  const committedB = (await remote(s.b))!.credentialEncrypted;
  s.a = await restart(s.a);
  s.b = await restart(s.b);
  globalThis.fetch = (async (url: any, init: any) => {
    s.wire.push(JSON.parse(init.body));
    const response = await s.b.fetch(new URL(String(url)).pathname, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    expect(await response.clone().text()).toBe(savedResponse);
    return response;
  }) as typeof fetch;
  expect(
    (
      await s.a.action(actionRef('peerCredentialRotation/retry'), {
        adminToken,
        peerTownId: 'b',
        rotationId: result.rotationId,
      })
    ).state,
  ).toBe('COMMITTED');
  expect((await remote(s.b))!.credentialEncrypted).toBe(committedB);
  expect(await openSecret((await remote(s.a))!.credentialEncrypted)).toBe(
    await openSecret(committedB),
  );
  expect(s.wire[0]).toEqual(s.wire[1]);
  const inbound = await s.b.run((ctx) => ctx.db.query('federationCredentialRotations').collect());
  expect(inbound).toHaveLength(1);
});

test('a lost ACK is recovered by the persisted scheduled retry without an administrator call', async () => {
  const s = await setup();
  globalThis.fetch = (async (url: any, init: any) => {
    await s.normalFetch(url, init);
    throw new Error('LOST_ACK');
  }) as typeof fetch;
  expect(
    (await s.a.action(actionRef('peerCredentialRotation/start'), { adminToken, peerTownId: 'b' }))
      .state,
  ).toBe('PENDING');
  const scheduled = await s.a.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
  expect(scheduled.some((row) => row.scheduledTime === Date.now() + 2000)).toBe(true);
  globalThis.fetch = s.normalFetch;
  jest.advanceTimersByTime(2000);
  await s.a.finishInProgressScheduledFunctions();
  expect((await remote(s.a))!.credentialId).toBe((await remote(s.b))!.credentialId);
  expect(
    (await s.a.run((ctx) => ctx.db.query('federationCredentialRotations').unique()))?.state,
  ).toBe('COMMITTED');
});

test('maintenance recovers a due persisted offer after both restarts even when its original scheduler is absent', async () => {
  const s = await setup();
  globalThis.fetch = (async (url: any, init: any) => {
    await s.normalFetch(url, init);
    throw new Error('LOST_ACK');
  }) as typeof fetch;
  expect(
    (
      await s.a.action(actionRef('peerCredentialRotation/start'), {
        adminToken,
        peerTownId: 'b',
      })
    ).state,
  ).toBe('PENDING');
  s.a = await restart(s.a);
  s.b = await restart(s.b);
  expect(await s.a.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).toEqual([]);
  globalThis.fetch = (async (url: any, init: any) => {
    const target = String(url).includes('a.example') ? s.a : s.b;
    return target.fetch(new URL(String(url)).pathname, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
  }) as typeof fetch;
  jest.setSystemTime(Date.now() + 2001);
  await s.a.mutation(mutationRef('transport/maintenance'), {});
  await s.a.mutation(mutationRef('transport/maintenance'), {});
  const scheduled = await s.a.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
  expect(scheduled).toHaveLength(1);
  jest.advanceTimersByTime(0);
  await s.a.finishInProgressScheduledFunctions();
  expect((await remote(s.a))!.credentialId).toBe((await remote(s.b))!.credentialId);
  expect(
    (await s.a.run((ctx) => ctx.db.query('federationCredentialRotations').unique()))?.state,
  ).toBe('COMMITTED');
});

test('rotation accepts a responder clock within the existing 30-second protocol skew', async () => {
  const s = await setup(),
    senderTime = Date.now();
  globalThis.fetch = (async (url: any, init: any) => {
    jest.setSystemTime(senderTime - 20_000);
    try {
      return await s.normalFetch(url, init);
    } finally {
      jest.setSystemTime(senderTime);
    }
  }) as typeof fetch;
  expect(
    (
      await s.a.action(actionRef('peerCredentialRotation/start'), {
        adminToken,
        peerTownId: 'b',
      })
    ).state,
  ).toBe('COMMITTED');
});

test('a forged ACK or missing new-key possession proof cannot activate the initiator', async () => {
  for (const field of ['mac', 'credentialProof']) {
    const s = await setup();
    globalThis.fetch = (async (url: any, init: any) => {
      const response = await s.normalFetch(url, init),
        packet = await response.json();
      packet[field] = 'forged';
      return new Response(JSON.stringify(packet));
    }) as typeof fetch;
    const result = await s.a.action(actionRef('peerCredentialRotation/start'), {
      adminToken,
      peerTownId: 'b',
    });
    expect(result.state).toBe('PENDING');
    expect((await remote(s.a))!.credentialId).toBe('old-a-b');
    globalThis.fetch = s.normalFetch;
    expect(
      (
        await s.a.action(actionRef('peerCredentialRotation/retry'), {
          adminToken,
          peerTownId: 'b',
          rotationId: result.rotationId,
        })
      ).state,
    ).toBe('COMMITTED');
  }
});

test('tampered packets, private ECDH material, excessive windows and replay conflicts never rotate credentials', async () => {
  const s = await setup(),
    o = await offer(s);
  await expect(
    s.a.action(actionRef('peerCredentialRotation/start'), {
      adminToken: 'invalid',
      peerTownId: 'b',
    }),
  ).rejects.toThrow('ADMIN_UNAUTHORIZED');
  for (const overlapMs of [MIN_OVERLAP_MS - 1, MAX_OVERLAP_MS + 1, NaN])
    await expect(
      s.a.action(actionRef('peerCredentialRotation/start'), {
        adminToken,
        peerTownId: 'b',
        overlapMs,
      }),
    ).rejects.toThrow('INVALID_CREDENTIAL_OVERLAP');
  await expect(
    s.b.action(actionRef('peerCredentialRotation/receive'), {
      packet: { ...o.packet, mac: 'forged' },
    }),
  ).rejects.toThrow('CREDENTIAL_ROTATION_AUTH_FAILED');
  await expect(
    s.b.action(actionRef('peerCredentialRotation/receive'), {
      packet: {
        ...o.packet,
        body: {
          ...o.packet.body,
          ephemeralPublicKey: { ...o.packet.body.ephemeralPublicKey, d: 'private' },
        },
      },
    }),
  ).rejects.toThrow('INVALID_CREDENTIAL_ROTATION');
  expect((await remote(s.b))!.credentialId).toBe('old-a-b');
  const accepted = await s.b.action(actionRef('peerCredentialRotation/receive'), {
    packet: o.packet,
  });
  expect(accepted.body.newCredentialId).toBe(o.packet.body.newCredentialId);
  const conflicting = await signPacket(
    { ...o.packet.body, nonce: 'changed' },
    s.aKeys.privateKeyEncrypted,
    s.oldCredentialEncrypted,
  );
  await expect(
    s.b.action(actionRef('peerCredentialRotation/receive'), { packet: conflicting }),
  ).rejects.toThrow('CREDENTIAL_ROTATION_CONFLICT');
  const second = await offer(s);
  await expect(
    s.b.action(actionRef('peerCredentialRotation/receive'), { packet: second.packet }),
  ).rejects.toThrow('CREDENTIAL_ROTATION_FENCED');
});

test('expired old credentials are rejected before maintenance, removed afterward, and revoke prevents renewal', async () => {
  const s = await setup();
  await s.a.action(actionRef('peerCredentialRotation/start'), {
    adminToken,
    peerTownId: 'b',
    overlapMs: MIN_OVERLAP_MS,
  });
  const rotated = (await remote(s.a))!;
  jest.setSystemTime(Date.now() + MIN_OVERLAP_MS);
  await expect(
    s.b.action(actionRef('transport/receiveProbe'), {
      packet: await signPacket(probe(), s.aKeys.privateKeyEncrypted, s.oldCredentialEncrypted),
    }),
  ).rejects.toThrow('MESSAGE_AUTH_FAILED');
  await s.b.action(actionRef('transport/receiveProbe'), {
    packet: await signPacket(
      probe(rotated.credentialId),
      s.aKeys.privateKeyEncrypted,
      rotated.credentialEncrypted,
    ),
  });
  await s.b.mutation(mutationRef('transport/maintenance'), {});
  expect(
    (await s.b.run((ctx) => ctx.db.query('federationCredentialRotations').unique()))
      ?.previousCredentialEncrypted,
  ).toBeUndefined();
  await s.a.mutation(mutationRef('peers/setPolicy'), {
    adminToken,
    peerTownId: 'b',
    inboundVisitsAllowed: false,
    outboundVisitsAllowed: false,
    trustState: 'REVOKED',
  });
  const row = await s.a.run((ctx) => ctx.db.query('federationCredentialRotations').unique());
  expect(row?.state).toBe('REVOKED');
  expect(row?.previousCredentialEncrypted).toBeUndefined();
  await expect(
    s.a.action(actionRef('peerCredentialRotation/start'), { adminToken, peerTownId: 'b' }),
  ).rejects.toThrow('PEER_NOT_TRUSTED');
});

test('concurrent administrator rotations converge on the smaller Town and do not overwrite a committed key', async () => {
  const s = await setup(),
    aOffer = await offer(s),
    bOffer = await offer(s, 'b');
  await s.a.mutation(mutationRef('peerCredentialRotation/storeOffer'), aOffer);
  await s.b.mutation(mutationRef('peerCredentialRotation/storeOffer'), bOffer);
  await expect(
    s.a.action(actionRef('peerCredentialRotation/receive'), { packet: bOffer.packet }),
  ).rejects.toThrow('CREDENTIAL_ROTATION_COLLISION');
  expect(
    (
      await s.a.action(actionRef('peerCredentialRotation/deliver'), {
        peerTownId: 'b',
        rotationId: aOffer.packet.body.rotationId,
      })
    ).state,
  ).toBe('COMMITTED');
  expect(
    (
      await s.b.action(actionRef('peerCredentialRotation/deliver'), {
        peerTownId: 'a',
        rotationId: bOffer.packet.body.rotationId,
      })
    ).state,
  ).toBe('SUPERSEDED');
  expect((await remote(s.a))!.credentialId).toBe((await remote(s.b))!.credentialId);
  expect(await openSecret((await remote(s.a))!.credentialEncrypted)).toBe(
    await openSecret((await remote(s.b))!.credentialEncrypted),
  );
});

test('deployment or re-pairing changes during an ACK fence activation instead of overwriting current credentials', async () => {
  const s = await setup();
  globalThis.fetch = (async (url: any, init: any) => {
    const response = await s.normalFetch(url, init);
    await s.a.run(async (ctx) => {
      const p = (await ctx.db.query('federationPeers').unique())!;
      await ctx.db.patch(p._id, {
        credentialId: 'repaired',
        credentialEncrypted: await sealSecret(randomSecret()),
      });
    });
    return response;
  }) as typeof fetch;
  const result = await s.a.action(actionRef('peerCredentialRotation/start'), {
    adminToken,
    peerTownId: 'b',
  });
  expect(result.state).toBe('PENDING');
  expect(result.error).toBe('CREDENTIAL_ROTATION_FENCED');
  expect((await remote(s.a))!.credentialId).toBe('repaired');
  jest.setSystemTime(Date.now() + 15 * 60_000);
  await s.a.action(actionRef('peerCredentialRotation/retry'), {
    adminToken,
    peerTownId: 'b',
    rotationId: result.rotationId,
  });
  const row = await s.a.run((ctx) => ctx.db.query('federationCredentialRotations').unique());
  expect(row?.state).toBe('EXPIRED');
  expect(row?.ephemeralPrivateEncrypted).toBeUndefined();
});

test('a changed deployment or identity key fences a pending rotation before any network request', async () => {
  for (const side of ['local', 'remote'])
    for (const change of ['epoch', 'instance', 'publicKey']) {
      const s = await setup(),
        o = await offer(s);
      await s.a.mutation(mutationRef('peerCredentialRotation/storeOffer'), o);
      await s.a.run(async (ctx) => {
        const record =
          side === 'local'
            ? (await ctx.db.query('federationIdentity').unique())!
            : (await ctx.db.query('federationPeers').unique())!;
        await ctx.db.patch(
          record._id,
          change === 'epoch'
            ? { deploymentEpoch: 2 }
            : change === 'instance'
              ? { deploymentInstanceId: 'replacement-instance' }
              : { publicKey: (await createIdentityKeys()).publicKey },
        );
      });
      const result = await s.a.action(actionRef('peerCredentialRotation/deliver'), {
        peerTownId: 'b',
        rotationId: o.packet.body.rotationId,
      });
      expect(result.state).toBe('PENDING');
      expect(result.error).toBe('CREDENTIAL_ROTATION_FENCED');
      expect(s.wire).toEqual([]);
      expect((await remote(s.a))!.credentialId).toBe('old-a-b');
      expect((await remote(s.b))!.credentialId).toBe('old-a-b');
    }
});

test('a responder identity change between signing and commit rejects the rotation atomically', async () => {
  const s = await setup(),
    o = await offer(s);
  const response = await s.b.action(actionRef('peerCredentialRotation/receive'), {
    packet: o.packet,
  });
  const credentialEncrypted = (await remote(s.b))!.credentialEncrypted;
  await s.b.run(async (ctx) => {
    const rotation = (await ctx.db.query('federationCredentialRotations').unique())!;
    await ctx.db.delete(rotation._id);
    const p = (await ctx.db.query('federationPeers').unique())!;
    await ctx.db.patch(p._id, {
      credentialId: 'old-a-b',
      credentialEncrypted: s.oldCredentialEncrypted,
    });
    const local = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(local._id, await createIdentityKeys());
  });
  await expect(
    s.b.mutation(mutationRef('peerCredentialRotation/accept'), {
      packet: o.packet,
      requestDigest: o.requestDigest,
      response,
      credentialEncrypted,
    }),
  ).rejects.toThrow('CREDENTIAL_ROTATION_FENCED');
  expect((await remote(s.b))!.credentialId).toBe('old-a-b');
  expect(await s.b.run((ctx) => ctx.db.query('federationCredentialRotations').collect())).toEqual(
    [],
  );
});

test('renewal follows only committed credentials to the current key and fences deployment, identity, pause and re-pair changes', async () => {
  const s = await setup();
  await s.a.action(actionRef('peerCredentialRotation/start'), {
    adminToken,
    peerTownId: 'b',
    overlapMs: MIN_OVERLAP_MS,
  });
  const firstCredentialId = (await remote(s.a))!.credentialId;
  jest.setSystemTime(Date.now() + MIN_OVERLAP_MS + 1);
  await s.a.action(actionRef('peerCredentialRotation/start'), {
    adminToken,
    peerTownId: 'b',
    overlapMs: MIN_OVERLAP_MS,
  });
  const current = (await remote(s.a))!;
  expect(current.credentialId).not.toBe(firstCredentialId);
  const lookup = () =>
    s.a.run(async (ctx) => {
      const p = (await ctx.db.query('federationPeers').unique())!;
      return renewedCredentialIdForPeer(ctx, p, 'old-a-b');
    });
  expect(await lookup()).toBe(current.credentialId);
  for (const patch of [
    { deploymentEpoch: 2 },
    { deploymentInstanceId: 'replacement' },
    { publicKey: (await createIdentityKeys()).publicKey },
    { trustState: 'PAUSED' },
    { credentialId: 'repaired-without-a-rotation-chain' },
  ]) {
    await s.a.run((ctx) => ctx.db.patch(current._id, patch));
    // Convex serializes a function's top-level undefined result as null.
    expect(await lookup()).toBeNull();
    await s.a.run((ctx) =>
      ctx.db.patch(current._id, {
        deploymentEpoch: current.deploymentEpoch,
        deploymentInstanceId: current.deploymentInstanceId,
        publicKey: current.publicKey,
        trustState: current.trustState,
        credentialId: current.credentialId,
      }),
    );
  }
  await s.a.run(async (ctx) => {
    const p = (await ctx.db.query('federationPeers').unique())!;
    await ctx.db.patch(p._id, { trustState: 'PAUSED' });
    expect(
      await credentialForPeer(ctx, { ...p, trustState: 'PAUSED' }, firstCredentialId),
    ).toBeUndefined();
  });
});

test('revocation and re-pairing remove secrets and renewal permission from all peer rotations beyond one maintenance batch', async () => {
  for (const operation of ['revoke', 're-pair']) {
    const s = await setup();
    await s.a.action(actionRef('peerCredentialRotation/start'), { adminToken, peerTownId: 'b' });
    await s.a.run(async (ctx) => {
      const { _id, _creationTime, ...rotation } = (await ctx.db
        .query('federationCredentialRotations')
        .unique())!;
      for (let i = 0; i < 101; i++)
        await ctx.db.insert('federationCredentialRotations', {
          ...rotation,
          rotationId: `historic-${i}`,
          oldCredentialId: `historic-old-${i}`,
          newCredentialId: `historic-new-${i}`,
        });
      if (operation === 're-pair')
        await ctx.db.insert('pairRequests', {
          pairRequestId: 're-pair',
          direction: 'OUTBOUND',
          state: 'PENDING_BOTH_CONFIRM',
          request: {},
          endpoint: 'https://b.example/federation/v1',
          requestedAt: Date.now(),
          expiresAt: Date.now() + 30_000,
          attempts: 0,
        });
    });
    if (operation === 'revoke')
      await s.a.mutation(mutationRef('peers/setPolicy'), {
        adminToken,
        peerTownId: 'b',
        inboundVisitsAllowed: false,
        outboundVisitsAllowed: false,
        trustState: 'REVOKED',
      });
    else {
      const p = (await remote(s.a))!;
      await s.a.mutation(mutationRef('peers/finalizePair'), {
        pairRequestId: 're-pair',
        remote: p,
        credentialEncrypted: await sealSecret(randomSecret()),
      });
    }
    const rows = await s.a.run((ctx) => ctx.db.query('federationCredentialRotations').collect());
    expect(rows).toHaveLength(102);
    expect(
      rows.every(
        (row) =>
          row.state === 'REVOKED' &&
          !row.previousCredentialEncrypted &&
          !row.ephemeralPrivateEncrypted,
      ),
    ).toBe(true);
    expect(
      await s.a.run(async (ctx) =>
        renewedCredentialIdForPeer(
          ctx,
          (await ctx.db.query('federationPeers').unique())!,
          'old-a-b',
        ),
      ),
    ).toBeNull();
  }
});

test('an authenticated peer cannot recycle a prior outbound rotation ID into a different credential', async () => {
  const s = await setup();
  const first = await s.a.action(actionRef('peerCredentialRotation/start'), {
    adminToken,
    peerTownId: 'b',
    overlapMs: MIN_OVERLAP_MS,
  });
  jest.setSystemTime(Date.now() + MIN_OVERLAP_MS + 1);
  await s.a.action(actionRef('peerCredentialRotation/start'), {
    adminToken,
    peerTownId: 'b',
    overlapMs: MIN_OVERLAP_MS,
  });
  jest.setSystemTime(Date.now() + MIN_OVERLAP_MS + 1);
  const o = await offer(s, 'b'),
    current = (await remote(s.b))!;
  const body = {
    ...o.packet.body,
    rotationId: first.rotationId,
    newCredentialId: `rotation:${first.rotationId}`,
    credentialId: current.credentialId,
  };
  await expect(
    s.a.action(actionRef('peerCredentialRotation/receive'), {
      packet: await signPacket(body, s.bKeys.privateKeyEncrypted, current.credentialEncrypted),
    }),
  ).rejects.toThrow('CREDENTIAL_ROTATION_CONFLICT');
  expect((await remote(s.a))!.credentialId).toBe(current.credentialId);
  expect(
    await s.a.run((ctx) => ctx.db.query('federationCredentialRotations').collect()),
  ).toHaveLength(2);
});

test('durable history with a lost ACK reauthenticates after overlap, keeps sequence and nonce, and rejects changed payload or visit authority', async () => {
  const s = await setup();
  const endedAt = Date.now();
  const worldId = await s.b.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 1,
      players: [],
      agents: [],
      conversations: [],
    });
    const chatProfileId = await ctx.db.insert('chatProfiles', {
      name: 'History model',
      provider: 'custom',
      url: 'https://model.example',
      model: 'model',
      stopWords: [],
      createdAt: 1,
    });
    await ctx.db.insert('residentModelBindings', {
      worldId,
      playerId: 'p:0',
      agentGlobalId: 'b/ava',
      chatProfileId,
      createdAt: 1,
      updatedAt: 1,
    });
    return worldId;
  });
  for (const [t, role] of [
    [s.a, 'host'],
    [s.b, 'home'],
  ] as const)
    await t.run(async (ctx) => {
      await ctx.db.insert('visitLedger', {
        visitId: 'visit',
        agentGlobalId: 'b/ava',
        homeTownId: 'b',
        hostTownId: 'a',
        homeDeploymentEpoch: 1,
        hostDeploymentEpoch: 1,
        agentAuthorityEpoch: 2,
        visitLeaseVersion: 3,
        leaseExpiry: endedAt - 1,
        fencingToken: 'fence',
        state: 'COMPLETED',
        role,
        ...(role === 'home' ? { worldId, homePlayerId: 'p:0' } : {}),
        profile: {},
        createdAt: 1,
        updatedAt: 1,
      });
    });
  const payload = {
    eventId: 'page-0',
    transcriptId: 'a/conversation',
    federationConversationId: 'a/world/c:1',
    endedAt,
    pageNumber: 0,
    finalPage: false,
    participants: [
      { playerId: 'p:visitor', agentGlobalId: 'b/ava', name: 'Ava', homeTownId: 'b' },
      { playerId: 'p:host', agentGlobalId: 'a/bea', name: 'Bea', homeTownId: 'a' },
    ],
    messages: [
      {
        messageId: 'history-message',
        text: 'I remember this visit.',
        author: 'p:visitor',
        occurredAt: endedAt,
      },
    ],
  };
  const message: FederationMessage = {
    ...probe(),
    type: 'CONVERSATION_ENDED',
    visitId: 'visit',
    agentGlobalId: 'b/ava',
    agentAuthorityEpoch: 2,
    visitLeaseVersion: 1,
    streamId: 'host-history',
    sequence: 1,
    payload,
  };
  await s.a.run(async (ctx) => {
    await ctx.db.insert('federationOutbox', {
      messageId: message.messageId,
      toTownId: 'b',
      envelope: message,
      attempts: 0,
      nextRetryAt: Date.now(),
    });
  });
  globalThis.fetch = (async (url: any, init: any) => {
    await s.normalFetch(url, init);
    throw new Error('LOST_MESSAGE_ACK');
  }) as typeof fetch;
  await s.a.action(actionRef('transport/deliver'), { messageId: message.messageId });
  expect(await s.b.run((ctx) => ctx.db.query('homeTravelTranscriptPages').collect())).toHaveLength(
    1,
  );
  globalThis.fetch = s.normalFetch;
  await s.a.action(actionRef('peerCredentialRotation/start'), {
    adminToken,
    peerTownId: 'b',
    overlapMs: MIN_OVERLAP_MS,
  });
  const overlapAck = await s.b.action(actionRef('transport/receiveMessage'), {
    packet: await signPacket(message, s.aKeys.privateKeyEncrypted, s.oldCredentialEncrypted),
  });
  expect(overlapAck.body.credentialId).toBe('old-a-b');
  expect(await verifyPacket(overlapAck, s.bKeys.publicKey, s.oldCredentialEncrypted)).toBe(true);
  jest.setSystemTime(Date.now() + MIN_OVERLAP_MS + 1);
  await s.a.mutation(mutationRef('transport/maintenance'), {});
  await s.b.mutation(mutationRef('transport/maintenance'), {});
  // Historical delivery renews its TTL first, then reauthenticates using the new key.
  await s.a.action(actionRef('transport/deliver'), { messageId: message.messageId });
  await s.a.action(actionRef('transport/deliver'), { messageId: message.messageId });
  const item = await s.a.run((ctx) => ctx.db.query('federationOutbox').unique());
  expect(item?.ackedAt).toBeDefined();
  const packet = s.wire.at(-1)!;
  expect(packet.body.credentialId).toBe((await remote(s.a))!.credentialId);
  for (const key of ['messageId', 'nonce', 'sequence', 'agentAuthorityEpoch', 'visitLeaseVersion'])
    expect(packet.body[key]).toBe((message as any)[key]);
  expect(await s.b.run((ctx) => ctx.db.query('homeTravelTranscriptPages').collect())).toHaveLength(
    1,
  );
  const current = (await remote(s.a))!;
  const tampered = {
    ...packet.body,
    payload: { ...payload, messages: [{ ...payload.messages[0], text: 'Changed history' }] },
  };
  await expect(
    s.b.action(actionRef('transport/receiveMessage'), {
      packet: await signPacket(tampered, s.aKeys.privateKeyEncrypted, current.credentialEncrypted),
    }),
  ).rejects.toThrow('MESSAGE_ID_CONFLICT');
  for (const patch of [
    { nonce: crypto.randomUUID() },
    { sequence: 2 },
    { agentAuthorityEpoch: 99 },
    { visitLeaseVersion: 99 },
  ]) {
    await expect(
      s.b.action(actionRef('transport/receiveMessage'), {
        packet: await signPacket(
          { ...packet.body, ...patch },
          s.aKeys.privateKeyEncrypted,
          current.credentialEncrypted,
        ),
      }),
    ).rejects.toThrow('MESSAGE_ID_CONFLICT');
  }
  const stale = {
    ...packet.body,
    messageId: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
    agentAuthorityEpoch: 99,
  };
  await expect(
    s.b.action(actionRef('transport/receiveMessage'), {
      packet: await signPacket(stale, s.aKeys.privateKeyEncrypted, current.credentialEncrypted),
    }),
  ).rejects.toThrow('STALE_AGENT_AUTHORITY');
});
