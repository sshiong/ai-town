import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { Game } from '../aiTown/game';
import { captureEndedConversation } from './transcripts';
import { messageDigest } from './transport';
import { FederationMessage } from './protocol';
import { createIdentityKeys, randomSecret, sealSecret } from './security';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/transcripts.ts': () => import('./transcripts'),
  '../federation/transport.ts': () => import('./transport'),
};
const flush = makeFunctionReference<'mutation'>('federation/transcripts:flushJob');
const delivery = makeFunctionReference<'mutation'>('federation/transport:markDelivery');
beforeAll(() =>
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }),
);
beforeEach(() => {
  jest.useFakeTimers();
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = randomSecret();
});
afterEach(() => jest.useRealTimers());

async function setup(texts = ['Hello']) {
  const t = convexTest(schema, modules);
  const keys = await createIdentityKeys(),
    credentialEncrypted = await sealSecret(randomSecret());
  const ids = await t.run(async (ctx) => {
    const player = {
      id: 'p:1',
      lastInput: 1,
      position: { x: 1, y: 1 },
      facing: { dx: 1, dy: 0 },
      speed: 0,
    };
    const conversation = {
      id: 'c:3',
      creator: 'p:1',
      created: 1,
      numMessages: texts.length,
      participants: [
        { playerId: 'p:1', invited: 1, status: { kind: 'participating' as const, started: 1 } },
        { playerId: 'p:2', invited: 1, status: { kind: 'participating' as const, started: 1 } },
      ],
    };
    const worldId = await ctx.db.insert('worlds', {
      nextId: 4,
      players: [
        { ...player, human: 'local-human' },
        {
          ...player,
          id: 'p:2',
          remoteVisitor: {
            visitId: 'visit',
            agentGlobalId: 'home/ava',
            homeTownId: 'home',
            homeTownName: 'Home',
            agentAuthorityEpoch: 2,
            visitLeaseVersion: 1,
            leaseExpiry: Date.now() - 1,
            lastObservationAt: 1,
          },
        },
      ],
      agents: [],
      conversations: [conversation],
    });
    await ctx.db.insert('playerDescriptions', {
      worldId,
      playerId: 'p:1',
      name: 'Bea',
      character: 'f1',
      description: 'Host human',
    });
    await ctx.db.insert('playerDescriptions', {
      worldId,
      playerId: 'p:2',
      name: 'Ava',
      character: 'f2',
      description: 'Visitor',
    });
    await ctx.db.insert('federationIdentity', {
      ...keys,
      townId: 'host',
      townName: 'Host',
      endpoint: 'https://host.example/federation/v1',
      deploymentInstanceId: 'host-instance',
      deploymentEpoch: 1,
      enabled: true,
      allowIncomingPairRequests: true,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 8,
      maxVisitDurationMs: 300000,
      mode: 'ACTIVE',
      createdAt: 1,
    });
    await ctx.db.insert('federationPeers', {
      publicKey: keys.publicKey,
      fingerprint: keys.fingerprint,
      townId: 'home',
      townName: 'Home',
      endpoint: 'https://home.example/federation/v1',
      deploymentInstanceId: 'home-instance',
      deploymentEpoch: 1,
      credentialId: 'credential',
      credentialEncrypted,
      trustState: 'TRUSTED',
      inboundVisitsAllowed: true,
      outboundVisitsAllowed: true,
      pairedAt: 1,
    } as never);
    await ctx.db.insert('visitLedger', {
      visitId: 'visit',
      agentGlobalId: 'home/ava',
      homeTownId: 'home',
      hostTownId: 'host',
      homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 2,
      visitLeaseVersion: 2,
      leaseExpiry: Date.now() - 1,
      fencingToken: 'fence',
      state: 'COMPLETED',
      role: 'host',
      worldId,
      hostPlayerId: 'p:2',
      profile: {},
      createdAt: 1,
      updatedAt: 1,
    });
    for (let i = 0; i < texts.length; i++)
      await ctx.db.insert('messages', {
        worldId,
        conversationId: 'c:3',
        author: i % 2 ? 'p:2' : 'p:1',
        messageUuid: `m-${i}`,
        text: texts[i],
      });
    return { worldId };
  });
  const capture = () =>
    t.run(async (ctx) => {
      const world = (await ctx.db.get(ids.worldId))!;
      await Game.saveDiff(ctx, ids.worldId, {
        world: { ...world, conversations: [], historicalLocations: [] },
        agentOperations: [],
      });
      return (await ctx.db.query('federationTranscriptJobs').unique())!._id;
    });
  return { t, ...ids, capture };
}

test('the real Game archive transaction captures a durable final job even with a full Outbox', async () => {
  const { t, worldId, capture } = await setup();
  await t.run(async (ctx) => {
    for (let i = 0; i < 900; i++)
      await ctx.db.insert('federationOutbox', {
        messageId: `full-${i}`,
        toTownId: 'home',
        envelope: {},
        attempts: 0,
        nextRetryAt: 0,
      });
  });
  const jobId = await capture();
  expect((await t.run((ctx) => ctx.db.get(worldId)))?.conversations).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query('archivedConversations').collect())).toHaveLength(1);
  await t.mutation(flush, { jobId });
  const job = await t.run((ctx) => ctx.db.get(jobId));
  expect(job).toMatchObject({
    state: 'PENDING',
    pageNumber: 0,
    lastError: 'OUTBOX_CAPACITY_EXCEEDED',
  });
  expect(job?.pendingMessages?.[0].text).toBe('Hello');
  expect(await t.run((ctx) => ctx.db.query('messageStreamCursors').collect())).toEqual([]);
  await t.run(async (ctx) => {
    const world = (await ctx.db.get(worldId))!;
    // Repeated archival attempts cannot create a second job for this visit/conversation.
    await captureEndedConversation(
      ctx,
      worldId,
      world,
      {
        id: 'c:3',
        creator: 'p:1',
        created: 1,
        numMessages: 1,
        participants: [
          { playerId: 'p:1', invited: 1, status: { kind: 'participating', started: 1 } },
          { playerId: 'p:2', invited: 1, status: { kind: 'participating', started: 1 } },
        ],
      },
      Date.now(),
    );
  });
  expect(await t.run((ctx) => ctx.db.query('federationTranscriptJobs').collect())).toHaveLength(1);
});

test('bounded UTF8 pages preserve all ordered messages and require every committed ACK before completion', async () => {
  const texts = [
    ...Array.from({ length: 25 }, (_, i) => `Message ${i}`),
    '星'.repeat(12000),
    '月'.repeat(12000),
    'Final tail',
  ];
  const { t, capture } = await setup(texts),
    jobId = await capture();
  const pages: any[] = [];
  const streams = new Set<string>();
  for (let i = 0; i < 50; i++) {
    await t.mutation(flush, { jobId });
    let job = (await t.run((ctx) => ctx.db.get(jobId)))!;
    if (job.state === 'DELIVERED') break;
    if (job.state !== 'WAITING_ACK') continue;
    const item = await t.run((ctx) =>
      ctx.db
        .query('federationOutbox')
        .withIndex('messageId', (q) => q.eq('messageId', job.pendingMessageId!))
        .unique(),
    );
    const page = item!.envelope.payload;
    expect(item!.envelope.sequence).toBe(1);
    if (!pages.some((p) => p.pageNumber === page.pageNumber)) {
      expect(streams.has(item!.envelope.streamId)).toBe(false);
      streams.add(item!.envelope.streamId);
    }
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThan(60000);
    expect(page.messages.length).toBeLessThanOrEqual(12);
    if (!pages.some((p) => p.pageNumber === page.pageNumber)) pages.push(page);
    await t.mutation(flush, { jobId });
    expect((await t.run((ctx) => ctx.db.get(jobId)))?.pageNumber).toBe(job.pageNumber);
    await t.mutation(delivery, { messageId: item!.messageId, status: 'COMMITTED' });
    jest.setSystemTime(Date.now() + 11000);
    await t.mutation(flush, { jobId });
  }
  expect((await t.run((ctx) => ctx.db.get(jobId)))?.state).toBe('DELIVERED');
  expect(pages.flatMap((p) => p.messages.map((m: any) => m.text))).toEqual(texts);
  expect(pages.map((p) => p.pageNumber)).toEqual(pages.map((_, i) => i));
  expect(pages.filter((p) => p.finalPage)).toHaveLength(1);
  expect(pages.at(-1).finalPage).toBe(true);
});

test('an unacknowledged historical envelope renews transport TTL without altering its identity, payload or sequence', async () => {
  const { t, capture } = await setup(),
    jobId = await capture();
  await t.mutation(flush, { jobId });
  const before = (await t.run((ctx) => ctx.db.query('federationOutbox').unique()))!;
  jest.setSystemTime(Date.now() + 11 * 60000);
  await t.mutation(delivery, { messageId: before.messageId, status: 'EXPIRED' });
  const after = (await t.run((ctx) => ctx.db.query('federationOutbox').unique()))!;
  expect(after.ackedAt).toBeUndefined();
  expect(after.envelope.expiresAt).toBeGreaterThan(Date.now());
  expect(after.envelope).toMatchObject({
    messageId: before.messageId,
    sequence: before.envelope.sequence,
    nonce: before.envelope.nonce,
    payload: before.envelope.payload,
  });
  expect(await messageDigest(after.envelope as FederationMessage)).toBe(
    await messageDigest(before.envelope as FederationMessage),
  );
  expect((await t.run((ctx) => ctx.db.query('visitLedger').unique()))?.state).toBe('COMPLETED');
  expect((await t.run((ctx) => ctx.db.get(jobId)))?.state).toBe('WAITING_ACK');
});
