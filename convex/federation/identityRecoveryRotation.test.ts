import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { actionRef, mutationRef, queryRef } from './refs';
import {
  createIdentityKeys,
  fromBase64,
  randomSecret,
  sealSecret,
  sign,
  toBase64,
} from './security';
import { canonicalJson } from './protocol';
import type { IdentityRecoveryPackage } from './identityRecovery';
import { verifiedIdentityKeySuccessor } from './identityKeyRotationProof';
import type { Id } from '../_generated/dataModel';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/store.ts': () => import('./store'),
  '../federation/admin.ts': () => import('./admin'),
  '../federation/transport.ts': () => import('./transport'),
  '../federation/ledger.ts': () => import('./ledger'),
  '../federation/runtime.ts': () => import('./runtime'),
  '../federation/peers.ts': () => import('./peers'),
  '../federation/identityConflict.ts': () => import('./identityConflict'),
  '../federation/identityRecovery.ts': () => import('./identityRecovery'),
  '../federation/identityKeyRotation.ts': () => import('./identityKeyRotation'),
  '../federation/peerCredentialRotation.ts': () => import('./peerCredentialRotation'),
  '../federation/migration.ts': () => import('./migration'),
  '../federation/backup.ts': () => import('./backup'),
  '../federation/backupLarge.ts': () => import('./backupLarge'),
  '../federation/backupExportAudit.ts': () => import('./backupExportAudit'),
  '../federation/coldBackup.ts': () => import('./coldBackup'),
  '../federation/coldHistory.ts': () => import('./coldHistory'),
  '../federation/coldHistoryFiles.ts': () => import('./coldHistoryFiles'),
  '../http.ts': async () => {
    const { httpRouter } = await import('convex/server');
    const { registerIdentityKeyRoutes } = await import('./identityKeyRotation');
    const { registerCredentialRotationRoutes } = await import('./peerCredentialRotation');
    const { registerFederationRoutes } = await import('./transport');
    const { registerPairingRoutes } = await import('./peers');
    const { registerMigrationRoutes } = await import('./migration');
    const http = httpRouter();
    registerIdentityKeyRoutes(http);
    registerCredentialRotationRoutes(http);
    registerFederationRoutes(http);
    registerPairingRoutes(http);
    registerMigrationRoutes(http);
    return { default: http };
  },
};
type Town = ReturnType<typeof convexTest<typeof schema.tables>>;
const adminToken = 'identity-recovery-rotation-test-admin';
const passphrase = 'independent signed recovery regression';
const review = {
  operator: 'Recovery administrator',
  reason: 'Verify restored identity continuity',
};
const targetEndpoint = 'https://target-a.example/federation/v1';
const local = (t: Town) => t.run((ctx) => ctx.db.query('federationIdentity').unique());
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
jest.setTimeout(60000);

async function withoutRecoveryVersion(pack: IdentityRecoveryPackage, privateKeyEncrypted: string) {
  const encode = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw',
    encode.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: fromBase64(pack.header.salt),
      iterations: pack.header.iterations,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const options = {
    name: 'AES-GCM',
    iv: fromBase64(pack.header.nonce),
    additionalData: encode.encode(canonicalJson(pack.header)),
  };
  const secret = JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(options, key, fromBase64(pack.ciphertext)),
    ),
  );
  delete secret.identityVersion;
  const ciphertext = toBase64(
    new Uint8Array(
      await crypto.subtle.encrypt(options, key, encode.encode(JSON.stringify(secret))),
    ),
  );
  const body = { header: pack.header, ciphertext };
  return { ...body, signature: await sign(body, privateKeyEncrypted) };
}

async function setup(legacyEncrypted = false) {
  const source = convexTest(schema, modules),
    neighbor = convexTest(schema, modules),
    target = convexTest(schema, modules),
    sourceKeys = await createIdentityKeys(),
    neighborKeys = await createIdentityKeys(),
    credentialEncrypted = await sealSecret(randomSecret());
  for (const [t, townId, keys, instance] of [
    [source, 'town:a', sourceKeys, 'source-a'],
    [neighbor, 'town:b', neighborKeys, 'peer-b'],
  ] as const)
    await t.run((ctx) =>
      ctx.db.insert('federationIdentity', {
        ...keys,
        townId,
        townName: townId,
        deploymentInstanceId: instance,
        deploymentEpoch: 1,
        endpoint: `https://${instance}.example/federation/v1`,
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
  for (const [t, townId, keys, instance] of [
    [source, 'town:b', neighborKeys, 'peer-b'],
    [neighbor, 'town:a', sourceKeys, 'source-a'],
  ] as const)
    await t.run((ctx) =>
      ctx.db.insert('federationPeers', {
        townId,
        townName: townId,
        publicKey: keys.publicKey,
        fingerprint: keys.fingerprint,
        deploymentInstanceId: instance,
        deploymentEpoch: 1,
        endpoint: `https://${instance}.example/federation/v1`,
        credentialId: 'initial-credential',
        credentialEncrypted,
        trustState: 'TRUSTED',
        inboundVisitsAllowed: true,
        outboundVisitsAllowed: true,
        pairedAt: Date.now(),
      }),
    );
  globalThis.fetch = ((url: any, init: any) => {
    const parsed = new URL(String(url));
    const t =
      parsed.hostname === 'peer-b.example'
        ? neighbor
        : parsed.hostname === 'target-a.example'
          ? target
          : source;
    return t.fetch(parsed.pathname, {
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body,
    });
  }) as typeof fetch;
  await source.action(actionRef('identityKeyRotation/start'), { adminToken, ...review });
  expect((await local(source))?.identityVersion).toBe(2);
  expect(
    (await neighbor.run((ctx) => ctx.db.query('federationPeers').unique()))?.identityVersion,
  ).toBe(2);
  let encrypted = await source.action(actionRef('identityRecovery/exportEncryptedIdentity'), {
    adminToken,
    passphrase,
  });
  if (legacyEncrypted)
    encrypted = await withoutRecoveryVersion(encrypted, (await local(source))!.privateKeyEncrypted);
  await target.action(actionRef('identityRecovery/restoreEncryptedIdentity'), {
    adminToken,
    passphrase,
    package: encrypted,
    sourceStopped: true,
    endpoint: targetEndpoint,
  });
  return { source, neighbor, target, sourceOriginalPublicKey: sourceKeys.publicKey };
}

async function cannotEnable(t: Town, identityVersion = 2) {
  const restored = (await local(t))!;
  expect(restored).toMatchObject({ identityVersion, mode: 'MIGRATING_IN', enabled: false });
  await expect(
    t.mutation(mutationRef('admin/configure'), {
      adminToken,
      enabled: true,
      allowIncomingPairRequests: true,
      maxVisitors: 1,
      maxVisitDurationMs: 300000,
    }),
  ).rejects.toThrow('DEPLOYMENT_NOT_ACTIVE');
  expect(await local(t)).toEqual(restored);
}

async function drive(
  t: Town,
  jobId: Id<'backupLargeJobs'>,
  kind: 'export' | 'import',
  until: string,
) {
  for (let i = 0; i < 300; i++) {
    const state = await t.query(queryRef('backupLarge/status'), { adminToken, jobId });
    if (state.state === until || state.phase === until) return;
    if (state.state === 'FAILED') throw new Error(state.error);
    await t.action(
      actionRef(kind === 'export' ? 'backupLarge/advanceExport' : 'backupLarge/advanceImport'),
      { adminToken, jobId },
    );
  }
  throw new Error('RECOVERY_REGRESSION_CHECKPOINT_TIMEOUT');
}

test.each(['identity', 'ordinary', 'chunked', 'legacy-identity'] as const)(
  '%s recovery preserves version 2, requires formal handoff and accepts the next normal version 3 rotation',
  async (path) => {
    const s = await setup(path === 'legacy-identity');
    await cannotEnable(s.target, path === 'legacy-identity' ? 1 : 2);
    if (path === 'ordinary' || path === 'chunked') {
      await s.source.mutation(mutationRef('admin/configure'), {
        adminToken,
        enabled: false,
        allowIncomingPairRequests: false,
        maxVisitors: 1,
        maxVisitDurationMs: 300000,
      });
      // Model an old destination whose public/private key matches but whose version metadata is absent.
      // The ordinary archive must repair this too, independently of the encrypted recovery fix.
      await s.target.run(async (ctx) => {
        const restored = (await ctx.db.query('federationIdentity').unique())!;
        await ctx.db.patch(restored._id, { identityVersion: undefined });
      });
      if (path === 'ordinary') {
        const bundle = await s.source.action(actionRef('backup/exportTown'), { adminToken });
        await s.target.action(actionRef('backup/importBackup'), {
          adminToken,
          bundle,
          mode: 'restore',
          sourceStopped: true,
        });
      } else {
        const exported = await s.source.mutation(mutationRef('backupLarge/startExport'), {
          adminToken,
        });
        await drive(s.source, exported.jobId, 'export', 'COMPLETE');
        const archive = await s.source.action(actionRef('backupLarge/getManifest'), {
          adminToken,
          jobId: exported.jobId,
        });
        const imported = await s.target.action(actionRef('backupLarge/createImport'), {
          adminToken,
          ...archive,
          mode: 'restore',
          sourceStopped: true,
        });
        for (const entry of archive.manifest.chunks) {
          const chunk = await s.source.action(actionRef('backupLarge/getChunk'), {
            adminToken,
            jobId: exported.jobId,
            index: entry.index,
          });
          await s.target.action(actionRef('backupLarge/stageChunk'), {
            adminToken,
            jobId: imported.jobId,
            chunk,
          });
        }
        await drive(s.target, imported.jobId, 'import', 'READY');
        await s.target.mutation(mutationRef('backupLarge/startApply'), {
          adminToken,
          jobId: imported.jobId,
        });
        await drive(s.target, imported.jobId, 'import', 'COMPLETE');
      }
      await cannotEnable(s.target);
    }
    await s.source.mutation(mutationRef('migration/freezeSource'), {
      adminToken,
      operator: review.operator,
    });
    const targetPacket = await s.target.action(actionRef('migration/prepareTarget'), {
      adminToken,
      endpoint: targetEndpoint,
    });
    const packet = await s.source.mutation(mutationRef('migration/signHandoff'), {
      adminToken,
      targetPacket,
    });
    expect(packet.body.identityVersion).toBe(2);
    await s.target.mutation(mutationRef('migration/activateTarget'), { adminToken, packet });
    expect((await local(s.target))?.identityVersion).toBe(2);
    await s.target.action(actionRef('migration/notifyPeer'), { adminToken, peerTownId: 'town:b' });
    expect((await local(s.target))?.mode).toBe('ACTIVE');
    const neighborBefore = (await s.neighbor.run((ctx) =>
      ctx.db.query('federationPeers').unique(),
    ))!;
    expect(neighborBefore).toMatchObject({
      identityVersion: 2,
      deploymentInstanceId: (await local(s.target))!.deploymentInstanceId,
    });
    await s.target.action(actionRef('identityKeyRotation/start'), { adminToken, ...review });
    const final = (await local(s.target))!;
    const neighborAfter = (await s.neighbor.run((ctx) =>
      ctx.db.query('federationPeers').unique(),
    ))!;
    expect(final.identityVersion).toBe(3);
    expect(neighborAfter).toMatchObject({
      identityVersion: 3,
      publicKey: final.publicKey,
      trustState: 'TRUSTED',
    });
    expect(final.publicKey).not.toBe(neighborBefore.publicKey);
    expect(neighborAfter.credentialId).toBe(neighborBefore.credentialId);
    expect(
      await s.neighbor.run((ctx) =>
        verifiedIdentityKeySuccessor(ctx, 'town:a', s.sourceOriginalPublicKey, final.publicKey, {
          oldVersion: 1,
          currentVersion: 3,
        }),
      ),
    ).toBe(true);
    expect(
      await s.neighbor.run((ctx) =>
        verifiedIdentityKeySuccessor(ctx, 'town:a', s.sourceOriginalPublicKey, final.publicKey, {
          oldVersion: 2,
          currentVersion: 3,
        }),
      ),
    ).toBe(false);
    const rotations = await s.target.run((ctx) =>
      ctx.db.query('federationIdentityKeyRotations').collect(),
    );
    expect(rotations[rotations.length - 1]).toMatchObject({
      state: 'COMMITTED',
      certificate: { body: { oldVersion: 2, newVersion: 3 } },
    });
  },
);

test('a signed legacy handoff cannot lower known version 2, and the neighbor rejects its own mismatching signed version', async () => {
  const s = await setup();
  await s.source.mutation(mutationRef('migration/freezeSource'), {
    adminToken,
    operator: review.operator,
  });
  const targetPacket = await s.target.action(actionRef('migration/prepareTarget'), {
    adminToken,
    endpoint: targetEndpoint,
  });
  const packet = await s.source.mutation(mutationRef('migration/signHandoff'), {
    adminToken,
    targetPacket,
  });
  const body = { ...packet.body };
  delete body.identityVersion;
  const legacy = {
    body,
    signature: await sign(body, (await local(s.source))!.privateKeyEncrypted),
  };
  const before = await local(s.target);
  await expect(
    s.target.mutation(mutationRef('migration/activateTarget'), {
      adminToken,
      packet: legacy,
    }),
  ).rejects.toThrow('MIGRATION_IDENTITY_VERSION_MISMATCH');
  expect(await local(s.target)).toEqual(before);
  await s.target.mutation(mutationRef('migration/activateTarget'), { adminToken, packet });
  const neighborBefore = await s.neighbor.run((ctx) => ctx.db.query('federationPeers').unique());
  const routed = globalThis.fetch;
  let remoteError: string | undefined;
  globalThis.fetch = (async (url: any, init: any) => {
    if (new URL(String(url)).pathname !== '/federation/v1/migration') return routed(url, init);
    const request = JSON.parse(init.body);
    request.body.handoff = legacy;
    request.signature = await sign(request.body, (await local(s.target))!.privateKeyEncrypted);
    const response = await routed(url, { ...init, body: JSON.stringify(request) });
    remoteError = (await response.clone().json()).error;
    return response;
  }) as typeof fetch;
  await expect(
    s.target.action(actionRef('migration/notifyPeer'), {
      adminToken,
      peerTownId: 'town:b',
    }),
  ).rejects.toThrow('FEDERATION_HTTP_400');
  expect(remoteError).toBe('MIGRATION_IDENTITY_VERSION_MISMATCH');
  expect(await s.neighbor.run((ctx) => ctx.db.query('federationPeers').unique())).toEqual(
    neighborBefore,
  );
  expect(await s.neighbor.run((ctx) => ctx.db.query('migrationPeerExchanges').first())).toBeNull();
});

test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects a signed handoff with malformed identity version %s before activation',
  async (identityVersion) => {
    const s = await setup();
    await s.source.mutation(mutationRef('migration/freezeSource'), {
      adminToken,
      operator: review.operator,
    });
    const targetPacket = await s.target.action(actionRef('migration/prepareTarget'), {
      adminToken,
      endpoint: targetEndpoint,
    });
    const packet = await s.source.mutation(mutationRef('migration/signHandoff'), {
      adminToken,
      targetPacket,
    });
    const body = { ...packet.body, identityVersion };
    const invalid = {
      body,
      signature: await sign(body, (await local(s.source))!.privateKeyEncrypted),
    };
    const before = await local(s.target);
    await expect(
      s.target.mutation(mutationRef('migration/activateTarget'), {
        adminToken,
        packet: invalid,
      }),
    ).rejects.toThrow('INVALID_MIGRATION_HANDOFF');
    expect(await local(s.target)).toEqual(before);
  },
);
