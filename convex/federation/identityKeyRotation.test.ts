import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { actionRef, mutationRef, queryRef } from './refs';
import {
  createIdentityKeys,
  digest,
  randomSecret,
  sealSecret,
  sign,
  signPacket,
  verifyPacket,
} from './security';
import { PROTOCOL } from './protocol';
import { renewedCredentialIdForPeer } from './credentials';
import { verifiedIdentityKeySuccessor } from './identityKeyRotationProof';
import { maintainIdentityKeyRotations } from './identityKeyRotation';

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
  '../federation/identityKeyRotation.ts': () => import('./identityKeyRotation'),
  '../federation/peerCredentialRotation.ts': () => import('./peerCredentialRotation'),
  '../federation/peers.ts': () => import('./peers'),
  '../federation/identityConflict.ts': () => import('./identityConflict'),
  '../federation/ledger.ts': () => import('./ledger'),
  '../federation/migration.ts': () => import('./migration'),
  '../http.ts': async () => {
    const { httpRouter } = await import('convex/server');
    const { registerIdentityKeyRoutes } = await import('./identityKeyRotation');
    const { registerCredentialRotationRoutes } = await import('./peerCredentialRotation');
    const { registerFederationRoutes } = await import('./transport');
    const { registerPairingRoutes } = await import('./peers');
    const http = httpRouter();
    registerIdentityKeyRoutes(http);
    registerCredentialRotationRoutes(http);
    registerFederationRoutes(http);
    registerPairingRoutes(http);
    return { default: http };
  },
};
const adminToken = 'identity-key-rotation-test-administrator';
const review = { operator: 'Test administrator', reason: 'Scheduled identity key rotation' };
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
type Town = ReturnType<typeof convexTest<typeof schema.tables>>;
const local = (t: Town) => t.run((ctx) => ctx.db.query('federationIdentity').unique());
const remote = (t: Town, townId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('federationPeers')
      .withIndex('townId', (q) => q.eq('townId', townId))
      .unique(),
  );
async function setup(count = 2) {
  const names = ['a', 'b', 'c'].slice(0, count),
    towns: Record<string, Town> = {},
    keys: Record<string, Awaited<ReturnType<typeof createIdentityKeys>>> = {};
  for (const name of names) {
    towns[name] = convexTest(schema, modules);
    keys[name] = await createIdentityKeys();
  }
  const secrets: Record<string, string> = {};
  for (const name of names)
    for (const other of names.filter((n) => n > name))
      secrets[`${name}-${other}`] = await sealSecret(randomSecret());
  for (const name of names)
    await towns[name].run(async (ctx) => {
      await ctx.db.insert('federationIdentity', {
        ...keys[name],
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
      for (const other of names.filter((n) => n !== name)) {
        const pair = [name, other].sort().join('-');
        await ctx.db.insert('federationPeers', {
          townId: other,
          townName: other,
          publicKey: keys[other].publicKey,
          fingerprint: keys[other].fingerprint,
          endpoint: `https://${other}.example/federation/v1`,
          deploymentInstanceId: `${other}-instance`,
          deploymentEpoch: 1,
          credentialId: `credential:${pair}`,
          credentialEncrypted: secrets[pair],
          trustState: 'TRUSTED',
          inboundVisitsAllowed: true,
          outboundVisitsAllowed: true,
          pairedAt: Date.now(),
        });
      }
    });
  const wire: { url: string; input: any; error?: string }[] = [];
  const normalFetch = (async (url: any, init: any) => {
    const parsed = new URL(String(url));
    const wireEntry: { url: string; input: any; error?: string } = { url: String(url), input: JSON.parse(init.body) };
    wire.push(wireEntry);
    const response = await towns[parsed.hostname.split('.')[0]].fetch(parsed.pathname, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    if (!response.ok) wireEntry.error = (await response.clone().json()).error;
    return response;
  }) as typeof fetch;
  globalThis.fetch = normalFetch;
  return { towns, keys, secrets, wire, normalFetch };
}
async function restart(t: Town) {
  // Stop the old test runtime's timers before constructing the restarted backend.
  // Persisted operation rows are recovered by the new maintenance worker.
  await t.finishInProgressScheduledFunctions();
  await t.run(async ctx => {
    for (const scheduled of await ctx.db.system.query('_scheduled_functions').collect())
      if (scheduled.state.kind === 'pending') await ctx.scheduler.cancel(scheduled._id);
  });
  const tables = [
    'federationIdentity',
    'federationPeers',
    'federationIdentityKeyRotations',
    'federationIdentityKeyExchanges',
    'federationIdentityKeyHistory',
    'federationCredentialRotations',
    'transportSessions',
  ] as const;
  const rows = await t.run((ctx) =>
      Promise.all(tables.map((table) => ctx.db.query(table).collect())),
    ),
    next = convexTest(schema, modules);
  await next.run(async (ctx) => {
    for (let i = 0; i < tables.length; i++)
      for (const { _id, _creationTime, ...fields } of rows[i])
        await ctx.db.insert(tables[i], fields as any);
  });
  return next;
}
const start = (t: Town) =>
  t.action(actionRef('identityKeyRotation/start'), { adminToken, ...review });
async function probePacket(s: Awaited<ReturnType<typeof setup>>, encryptedPrivate: string) {
  const nonce = crypto.randomUUID(),
    p = (await remote(s.towns.a, 'b'))!;
  return signPacket(
    {
      protocol: PROTOCOL,
      type: 'TRANSPORT_PROBE',
      fromTownId: 'a',
      toTownId: 'b',
      senderDeploymentInstanceId: 'a-instance',
      senderDeploymentEpoch: 1,
      expectedRecipientDeploymentEpoch: 1,
      credentialId: p.credentialId,
      messageId: crypto.randomUUID(),
      nonce,
      sentAt: Date.now(),
      expiresAt: Date.now() + 30_000,
      payload: { nonce, probeId: crypto.randomUUID() },
    },
    encryptedPrivate,
    p.credentialEncrypted,
  );
}

test('three-town authenticated old-to-new chain challenges each new key, preserves identity and credentials, and immediately stops ordinary old signatures', async () => {
  const s = await setup(3),
    before = (await local(s.towns.a))!;
  await start(s.towns.a);
  const after = (await local(s.towns.a))!;
  expect(after.publicKey).not.toBe(before.publicKey);
  expect(after.identityVersion).toBe(2);
  for (const field of [
    'townId',
    'deploymentInstanceId',
    'deploymentEpoch',
    'endpoint',
    'enabled',
    'mode',
  ])
    expect((after as any)[field]).toEqual((before as any)[field]);
  for (const name of ['b', 'c']) {
    const p = (await remote(s.towns[name], 'a'))!;
    expect(p.publicKey).toBe(after.publicKey);
    expect(p.identityVersion).toBe(2);
    expect(p.trustState).toBe('TRUSTED');
    expect(p.credentialEncrypted).toBe(s.secrets[`a-${name}`]);
    expect(
      await s.towns[name].run((ctx) =>
        verifiedIdentityKeySuccessor(ctx, 'a', before.publicKey, after.publicKey),
      ),
    ).toBe(true);
  }
  const rows = await s.towns.a.run((ctx) =>
    ctx.db.query('federationIdentityKeyRotations').collect(),
  );
  expect(rows[0].state).toBe('COMMITTED');
  expect(rows[0].newPrivateEncrypted).toBeUndefined();
  expect(
    (await s.towns.a.run((ctx) => ctx.db.query('federationIdentityKeyExchanges').collect())).every(
      (r) => r.state === 'ACKED',
    ),
  ).toBe(true);
  await expect(
    s.towns.b.action(actionRef('transport/receiveProbe'), {
      packet: await probePacket(s, s.keys.a.privateKeyEncrypted),
    }),
  ).rejects.toThrow('MESSAGE_AUTH_FAILED');
  const ack = await s.towns.b.action(actionRef('transport/receiveProbe'), {
    packet: await probePacket(s, after.privateKeyEncrypted),
  });
  expect(await verifyPacket(ack, s.keys.b.publicKey, s.secrets['a-b'])).toBe(true);
  const history = await s.towns.a.run((ctx) =>
    ctx.db.query('federationIdentityKeyHistory').collect(),
  );
  expect(JSON.stringify(history)).not.toMatch(/Encrypted|"mac"/);
  expect(
    JSON.stringify(await s.towns.a.query(queryRef('identityKeyRotation/status'), { adminToken })),
  ).not.toMatch(/Encrypted|Signature|certificate|"mac"/);
});

test('an unreachable neighbor cannot partly replace identities; expiry removes the staged private key and leaves every trusted key intact', async () => {
  const s = await setup(3);
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('c.example')) throw new Error('UNREACHABLE');
    return s.normalFetch(url, init);
  }) as typeof fetch;
  const result = await start(s.towns.a);
  expect((await local(s.towns.a))!.publicKey).toBe(s.keys.a.publicKey);
  expect((await remote(s.towns.b, 'a'))!.publicKey).toBe(s.keys.a.publicKey);
  expect(
    (await s.towns.a.run((ctx) => ctx.db.query('federationIdentityKeyRotations').unique()))?.state,
  ).toBe('PREPARING');
  await expect(
    s.towns.a.action(actionRef('peerCredentialRotation/start'), { adminToken, peerTownId: 'b' }),
  ).rejects.toThrow('IDENTITY_KEY_ROTATION_IN_PROGRESS');
  jest.setSystemTime(Date.now() + 10 * 60_000 + 1);
  await s.towns.a.mutation(mutationRef('transport/maintenance'), {});
  await s.towns.b.mutation(mutationRef('transport/maintenance'), {});
  const row = (await s.towns.a.run((ctx) =>
    ctx.db.query('federationIdentityKeyRotations').unique(),
  ))!;
  expect(row.rotationId).toBe(result.rotationId);
  expect(row.state).toBe('EXPIRED');
  expect(row.newPrivateEncrypted).toBeUndefined();
  expect((await local(s.towns.a))!.publicKey).toBe(s.keys.a.publicKey);
  expect(
    await s.towns.a.run((ctx) => ctx.db.query('federationIdentityKeyHistory').collect()),
  ).toEqual([]);
});

test('identity maintenance drains every expired inbound batch without reading terminal history or changing outbound and unexpired trust', async () => {
  const s = await setup(), t = s.towns.a, now = Date.now();
  const beforeLocal = await local(t), beforePeer = await remote(t, 'b');
  const exchange = {
    peerTownId: 'b', peerPublicKey: s.keys.b.publicKey, peerIdentityVersion: 1,
    credentialId: 'credential:a-b', peerDeploymentInstanceId: 'b-instance',
    peerDeploymentEpoch: 1, localPublicKey: s.keys.a.publicKey, certificate: { audit: true },
    createdAt: now, attempts: 0, nextRetryAt: now + 60_000,
  };
  await t.run(async ctx => {
    for (let i = 0; i < 3000; i++) await ctx.db.insert('federationIdentityKeyExchanges', {
      ...exchange, rotationId: `terminal-${i}`, direction: i % 2 ? 'INBOUND' : 'OUTBOUND',
      state: ['ACKED', 'ABORTED', 'EXPIRED'][i % 3], expiresAt: now - 120_000,
    });
    for (const state of ['PREPARED', 'CHALLENGING']) {
      for (let i = 0; i < 45; i++) await ctx.db.insert('federationIdentityKeyExchanges', {
        ...exchange, rotationId: `${state}-${i}`, direction: 'INBOUND', state,
        // Include exactly the deadline; expiry remains inclusive.
        expiresAt: i === 44 ? now : now - 1000,
      });
      await ctx.db.insert('federationIdentityKeyExchanges', {
        ...exchange, rotationId: `future-${state}`, direction: 'INBOUND', state,
        expiresAt: now + 1,
      });
      await ctx.db.insert('federationIdentityKeyExchanges', {
        ...exchange, rotationId: `outbound-${state}`, direction: 'OUTBOUND', state,
        expiresAt: now - 1000,
      });
    }
  });
  const terminalBefore = await t.run(async ctx =>
    (await ctx.db.query('federationIdentityKeyExchanges').collect()).filter(row =>
      row.rotationId.startsWith('terminal-')),
  );
  for (const remaining of [25, 5, 0]) {
    await t.run(async ctx => {
      // convex-test does not enforce production read limits. Fail explicitly
      // if maintenance falls back to scanning the accumulated exchange table.
      const db = new Proxy(ctx.db, {
        get(target, property) {
          if (property !== 'query') return Reflect.get(target, property);
          return (table: Parameters<typeof ctx.db.query>[0]) => {
            const query = target.query(table);
            if (table !== 'federationIdentityKeyExchanges') return query;
            return new Proxy(query, {
              get(target, property) {
                if (property === 'collect') return () => { throw new Error('UNBOUNDED_IDENTITY_HISTORY_READ'); };
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          };
        },
      });
      await maintainIdentityKeyRotations({ ...ctx, db });
    });
    for (const state of ['PREPARED', 'CHALLENGING']) expect(await t.run(ctx => ctx.db
      .query('federationIdentityKeyExchanges')
      .withIndex('direction_state_expiry', q => q.eq('direction', 'INBOUND').eq('state', state)
        .lte('expiresAt', now)).collect())).toHaveLength(remaining);
  }
  const after = await t.run(ctx => ctx.db.query('federationIdentityKeyExchanges').collect());
  expect(after.filter(row => row.rotationId.startsWith('terminal-'))).toEqual(terminalBefore);
  expect(after.filter(row => row.rotationId.startsWith('PREPARED-') || row.rotationId.startsWith('CHALLENGING-')))
    .toHaveLength(90);
  expect(after.filter(row => row.rotationId.startsWith('PREPARED-') || row.rotationId.startsWith('CHALLENGING-'))
    .every(row => row.state === 'EXPIRED')).toBe(true);
  for (const state of ['PREPARED', 'CHALLENGING']) {
    expect(after.find(row => row.rotationId === `future-${state}`)?.state).toBe(state);
    expect(after.find(row => row.rotationId === `outbound-${state}`)?.state).toBe(state);
  }
  expect(await local(t)).toEqual(beforeLocal);
  expect(await remote(t, 'b')).toEqual(beforePeer);
  expect(await t.run(ctx => ctx.db.query('federationIdentityKeyHistory').collect())).toEqual([]);
});

test('expiring a staged identity still aborts every outbound peer exchange beyond the maintenance batch size', async () => {
  const s = await setup(), t = s.towns.a, now = Date.now();
  const beforeLocal = await local(t), beforePeer = await remote(t, 'b');
  await t.run(async ctx => {
    await ctx.db.insert('federationIdentityKeyRotations', {
      rotationId: 'expired-staged-key', certificate: { audit: true }, newPrivateEncrypted: 'staged-key',
      state: 'PREPARING', expiresAt: now, ...review, createdAt: now,
    });
    for (let i = 0; i < 23; i++) await ctx.db.insert('federationIdentityKeyExchanges', {
      rotationId: 'expired-staged-key', peerTownId: `peer-${i}`, direction: 'OUTBOUND',
      state: i % 2 ? 'PREPARED' : 'PENDING_PREPARE', peerPublicKey: 'fixture-public-key',
      peerIdentityVersion: 1, credentialId: `credential-${i}`, peerDeploymentInstanceId: `instance-${i}`,
      peerDeploymentEpoch: 1, localPublicKey: s.keys.a.publicKey, certificate: { audit: true },
      packet: { staged: true }, expiresAt: now, createdAt: now, attempts: 0, nextRetryAt: now,
    });
  });
  await t.mutation(mutationRef('transport/maintenance'), {});
  const rotation = await t.run(ctx => ctx.db.query('federationIdentityKeyRotations').unique());
  expect(rotation?.state).toBe('EXPIRED');
  expect(rotation?.newPrivateEncrypted).toBeUndefined();
  const exchanges = await t.run(ctx => ctx.db.query('federationIdentityKeyExchanges').collect());
  expect(exchanges).toHaveLength(23);
  expect(exchanges.every(row => row.state === 'ABORTED' && row.packet === undefined)).toBe(true);
  expect(await local(t)).toEqual(beforeLocal);
  expect(await remote(t, 'b')).toEqual(beforePeer);
  expect(await t.run(ctx => ctx.db.query('federationIdentityKeyHistory').collect())).toEqual([]);
  expect(await t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())).toEqual([]);
});

test('a committed key and lost commit ACK survive both restarts and recover from the maintenance index without replaying trust or extending a deadline', async () => {
  const s = await setup();
  globalThis.fetch = (async (url: any, init: any) => {
    const response = await s.normalFetch(url, init),
      input = JSON.parse(init.body);
    if (input.operation === 'offer' && input.packet.body.phase === 'COMMIT')
      throw new Error('LOST_COMMIT_ACK');
    return response;
  }) as typeof fetch;
  const result = await start(s.towns.a),
    committed = (await local(s.towns.a))!;
  expect((await remote(s.towns.b, 'a'))!.publicKey).toBe(committed.publicKey);
  s.towns.a = await restart(s.towns.a);
  s.towns.b = await restart(s.towns.b);
  globalThis.fetch = s.normalFetch;
  s.wire.length = 0;
  jest.setSystemTime(Date.now() + 65_000);
  await s.towns.a.mutation(mutationRef('transport/maintenance'), {});
  jest.advanceTimersByTime(0);
  await s.towns.a.finishInProgressScheduledFunctions();
  const state = await s.towns.a.query(queryRef('identityKeyRotation/status'), { adminToken });
  expect(state.rotations[0].rotationId).toBe(result.rotationId);
  expect(state.rotations[0].state).toBe('COMMITTED');
  expect(s.wire.filter(row => row.error).map(row => ({path: new URL(row.url).pathname, operation: row.input.operation, error: row.error}))).toEqual([]);
  expect(state.exchanges[0].lastError).toBeUndefined();
  expect(state.exchanges[0].state).toBe('ACKED');
  expect((await local(s.towns.a))!.publicKey).toBe(committed.publicKey);
  expect(
    await s.towns.b.run((ctx) => ctx.db.query('federationIdentityKeyHistory').collect()),
  ).toHaveLength(1);
  await expect(
    s.towns.a.mutation(mutationRef('identityKeyRotation/abort'), {
      adminToken,
      rotationId: result.rotationId,
      ...review,
    }),
  ).rejects.toThrow('IDENTITY_KEY_ALREADY_ACTIVATED');
});

test('forged old/new signatures, fresh-key proof and activation can never replace a trusted peer key', async () => {
  for (const target of ['oldSignature', 'newSignature', 'proof', 'activation']) {
    const s = await setup();
    globalThis.fetch = (async (url: any, init: any) => {
      const input = JSON.parse(init.body);
      if (input.operation === 'offer' && ['oldSignature', 'newSignature'].includes(target)) {
        input.packet.body.certificate[target] = 'forged';
        return s.normalFetch(url, { ...init, body: JSON.stringify(input) });
      }
      if (
        input.operation === 'offer' &&
        input.packet.body.phase === 'COMMIT' &&
        target === 'activation'
      ) {
        input.packet.body.activation.oldSignature = 'forged';
        return s.normalFetch(url, { ...init, body: JSON.stringify(input) });
      }
      const response = await s.normalFetch(url, init);
      if (input.operation === 'challenge' && target === 'proof') {
        const packet = await response.json();
        packet.signature = 'forged';
        return new Response(JSON.stringify(packet));
      }
      return response;
    }) as typeof fetch;
    await start(s.towns.a);
    expect((await remote(s.towns.b, 'a'))!.publicKey).toBe(s.keys.a.publicKey);
    if (target !== 'activation')
      expect((await local(s.towns.a))!.publicKey).toBe(s.keys.a.publicKey);
    expect(
      await s.towns.b.run((ctx) => ctx.db.query('federationIdentityKeyHistory').collect()),
    ).toEqual([]);
  }
});

test('verified signed identity chains preserve historical credential renewal, while an imported or altered public chain grants nothing', async () => {
  const s = await setup();
  await s.towns.a.action(actionRef('peerCredentialRotation/start'), {
    adminToken,
    peerTownId: 'b',
    overlapMs: 600_000,
  });
  jest.setSystemTime(Date.now() + 600_001);
  await start(s.towns.a);
  expect(
    await s.towns.a.run(async (ctx) =>
      renewedCredentialIdForPeer(
        ctx,
        (await ctx.db.query('federationPeers').unique())!,
        'credential:a-b',
      ),
    ),
  ).toBe((await remote(s.towns.a, 'b'))!.credentialId);
  expect(
    await s.towns.b.run(async (ctx) =>
      renewedCredentialIdForPeer(
        ctx,
        (await ctx.db.query('federationPeers').unique())!,
        'credential:a-b',
      ),
    ),
  ).toBe((await remote(s.towns.b, 'a'))!.credentialId);
  const history = (await s.towns.a.run((ctx) =>
    ctx.db.query('federationIdentityKeyHistory').unique(),
  ))!;
  await s.towns.a.run((ctx) => ctx.db.patch(history._id, { verified: false }));
  expect(
    await s.towns.a.run(async (ctx) =>
      renewedCredentialIdForPeer(
        ctx,
        (await ctx.db.query('federationPeers').unique())!,
        'credential:a-b',
      ),
    ),
  ).toBeNull();
  await s.towns.a.run((ctx) =>
    ctx.db.patch(history._id, {
      verified: true,
      activation: { ...history.activation, oldSignature: 'forged' },
    }),
  );
  expect(
    await s.towns.a.run((ctx) =>
      verifiedIdentityKeySuccessor(ctx, 'a', s.keys.a.publicKey, (history as any).newPublicKey),
    ),
  ).toBe(false);
});

test('lost old private keys require two administrators independent review and a live new-key challenge before the same town can re-enable federation', async () => {
  const s = await setup();
  await s.towns.a.run(async (ctx) => {
    const row = (await ctx.db.query('federationIdentity').unique())!;
    await ctx.db.patch(row._id, { privateKeyEncrypted: 'lost' });
  });
  await expect(start(s.towns.a)).rejects.toThrow('INVALID_ENCRYPTED_SECRET');
  const recovered = await s.towns.a.action(actionRef('identityKeyRotation/recoverLocalIdentity'), {
    adminToken,
    oldKeyUnavailable: true,
    ...review,
  });
  expect(recovered.townId).toBe('a');
  expect((await local(s.towns.a))!.enabled).toBe(false);
  expect((await remote(s.towns.a, 'b'))!.trustState).toBe('REAUTH_REQUIRED');
  const args = {
    adminToken,
    peerTownId: 'a',
    publicKey: recovered.publicKey,
    identityVersion: recovered.identityVersion,
    independentFingerprint: recovered.fingerprint,
    independentlyVerified: true,
    ...review,
  };
  await expect(
    s.towns.b.action(actionRef('identityKeyRotation/reviewPeerIdentity'), {
      ...args,
      independentlyVerified: false,
    }),
  ).rejects.toThrow('INDEPENDENT_IDENTITY_REVIEW_REQUIRED');
  await expect(
    s.towns.b.action(actionRef('identityKeyRotation/reviewPeerIdentity'), {
      ...args,
      independentFingerprint: 'wrong',
    }),
  ).rejects.toThrow('INDEPENDENT_IDENTITY_REVIEW_REQUIRED');
  await s.towns.b.action(actionRef('identityKeyRotation/reviewPeerIdentity'), args);
  await expect(
    s.towns.a.mutation(mutationRef('identityKeyRotation/finishRecovery'), {
      adminToken,
      rotationId: recovered.rotationId,
      enableFederation: true,
      ...review,
    }),
  ).rejects.toThrow('IDENTITY_RECOVERY_PEER_REVIEW_REQUIRED');
  await s.towns.a.action(actionRef('identityKeyRotation/reviewPeerIdentity'), {
    adminToken,
    peerTownId: 'b',
    publicKey: s.keys.b.publicKey,
    identityVersion: 1,
    independentFingerprint: s.keys.b.fingerprint,
    independentlyVerified: true,
    ...review,
  });
  await s.towns.a.mutation(mutationRef('identityKeyRotation/finishRecovery'), {
    adminToken,
    rotationId: recovered.rotationId,
    enableFederation: true,
    ...review,
  });
  expect((await local(s.towns.a))!.townId).toBe('a');
  expect((await local(s.towns.a))!.enabled).toBe(true);
  expect((await remote(s.towns.b, 'a'))!.trustState).toBe('TRUSTED');
  expect(
    await s.towns.b.run((ctx) =>
      verifiedIdentityKeySuccessor(ctx, 'a', s.keys.a.publicKey, recovered.publicKey),
    ),
  ).toBe(false);
  await s.towns.b.action(actionRef('transport/receiveProbe'), {
    packet: await probePacket(s, (await local(s.towns.a))!.privateKeyEncrypted),
  });
});

test('successor-key prepare and commit use the trusted backup without requiring an obsolete-key transport probe', async () => {
  const s = await setup();
  const before = (await local(s.towns.a))!;
  await s.towns.a.run(async ctx => {
    const p = (await ctx.db.query('federationPeers').first())!;
    await ctx.db.patch(p._id, { endpointCandidates: [{ url: p.endpoint, priority: 10 }, { url: 'https://b-backup.example/federation/v1', priority: 20 }] });
  });
  const backupOperations: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).startsWith('https://b.example/')) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    if (String(url).startsWith('https://b-backup.example/')) backupOperations.push(JSON.parse(init.body).packet.body.phase);
    return s.normalFetch(String(url).replace('b-backup.example', 'b.example'), init);
  }) as typeof fetch;
  await start(s.towns.a);
  const after = (await local(s.towns.a))!;
  expect(after.publicKey).not.toBe(before.publicKey);
  expect((await remote(s.towns.b, 'a'))!.publicKey).toBe(after.publicKey);
  expect(backupOperations).toEqual(['PREPARE', 'COMMIT']);
});
