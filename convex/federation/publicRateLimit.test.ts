import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { mutationRef } from './refs';
import { publicLimitKeys } from './publicRateLimit';
import { createIdentityKeys, randomSecret } from './security';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/publicRateLimit.ts': () => import('./publicRateLimit'),
  '../federation/store.ts': () => import('./store'),
  '../http.ts': async () => {
    const { httpRouter } = await import('convex/server');
    const { registerPairingRoutes } = await import('./peers');
    const http = httpRouter(); registerPairingRoutes(http);
    return { default: http };
  },
};
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1_800_000_000_000); });
afterEach(() => jest.useRealTimers());

test('source and prefix limits use trusted Convex metadata and health has its own budget', async () => {
  const t = convexTest(schema, modules);
  const source = t.withRequestMetadata({ ip: '8.8.8.1' });
  for (let i = 0; i < 15; i++) expect((await source.mutation(mutationRef('publicRateLimit/consume'), { scope: 'PAIR_SOURCE' })).allowed).toBe(true);
  expect(await source.mutation(mutationRef('publicRateLimit/consume'), { scope: 'PAIR_SOURCE' })).toMatchObject({ allowed: false, retryAfter: 60 });
  expect((await source.mutation(mutationRef('publicRateLimit/consume'), { scope: 'HEALTH' })).allowed).toBe(true);
  const sibling = t.withRequestMetadata({ ip: '8.8.8.2' });
  for (let i = 0; i < 15; i++) expect((await sibling.mutation(mutationRef('publicRateLimit/consume'), { scope: 'PAIR_SOURCE' })).allowed).toBe(true);
  expect((await t.withRequestMetadata({ ip: '8.8.8.3' }).mutation(mutationRef('publicRateLimit/consume'), { scope: 'PAIR_SOURCE' })).allowed).toBe(false);
  expect((await t.withRequestMetadata({ ip: '8.8.9.3' }).mutation(mutationRef('publicRateLimit/consume'), { scope: 'PAIR_SOURCE' })).allowed).toBe(true);
  jest.advanceTimersByTime(60_000);
  expect((await source.mutation(mutationRef('publicRateLimit/consume'), { scope: 'PAIR_SOURCE' })).allowed).toBe(true);
  expect((await t.run(ctx => ctx.db.query('federationPublicRateLimits').collect())).length).toBeLessThan(8);
});

test('town claims and account budgets remain bounded even if source IP changes', async () => {
  const t = convexTest(schema, modules);
  for (let i = 0; i < 4; i++) expect((await t.withRequestMetadata({ ip: `8.8.9.${i}` }).mutation(mutationRef('publicRateLimit/consume'), { scope: 'PAIR_TOWN', claim: 'town:one' })).allowed).toBe(true);
  expect((await t.withRequestMetadata({ ip: '8.8.10.1' }).mutation(mutationRef('publicRateLimit/consume'), { scope: 'PAIR_TOWN', claim: 'town:one' })).allowed).toBe(false);
  for (let i = 0; i < 10; i++) expect((await t.mutation(mutationRef('publicRateLimit/consume'), { scope: 'PAIR_ACCOUNT', claim: 'account:one' })).allowed).toBe(true);
  expect((await t.mutation(mutationRef('publicRateLimit/consume'), { scope: 'PAIR_ACCOUNT', claim: 'account:one' })).allowed).toBe(false);
  expect(publicLimitKeys('PAIR_SOURCE', null).map(item => item.key)).toContain('PAIR_SOURCE:source:unknown');
});

test('malformed public pairing requests consume trusted source budget before parsing and ignore forwarded claims', async () => {
  const t = convexTest(schema, modules);
  const source = t.withRequestMetadata({ ip: '8.8.8.1' });
  for (let i = 0; i < 15; i++) {
    const response = await source.fetch('/federation/v1/pair', { method: 'POST', body: '{',
      headers: { 'X-Forwarded-For': `8.8.9.${i + 1}`, 'X-Real-IP': `8.8.10.${i + 1}` } });
    expect(response.status).toBe(400);
  }
  const limited = await source.fetch('/federation/v1/pair', { method: 'POST', body: '{',
    headers: { 'X-Forwarded-For': '9.9.9.9' } });
  expect(limited.status).toBe(429);
  expect(limited.headers.get('Retry-After')).toBe('60');
  expect(await limited.json()).toEqual({ error: 'RATE_LIMITED' });
  expect((await t.withRequestMetadata({ ip: '8.8.9.1' }).fetch('/federation/v1/pair', { method: 'POST', body: '{' })).status).toBe(400);
  expect(await t.run(ctx => ctx.db.query('pairRequests').collect())).toEqual([]);
});

test('public health strips locator hints, limits the actual HTTP route, and retains a separate pairing budget', async () => {
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = randomSecret();
  const t = convexTest(schema, modules), keys = await createIdentityKeys();
  await t.run(ctx => ctx.db.insert('federationIdentity', { ...keys, townId: 'home', townName: 'Home',
    deploymentInstanceId: 'instance', deploymentEpoch: 1, endpoint: 'https://home.example/federation/v1',
    endpointCandidates: [{ url: 'https://home.example/federation/v1', priority: 10 }, { url: 'https://192.168.4.9/federation/v1', priority: 20 }],
    enabled: true, allowIncomingPairRequests: true, allowUnencryptedHttp: false, allowPublicHttp: false,
    maxVisitors: 8, maxVisitDurationMs: 60_000, mode: 'ACTIVE', createdAt: Date.now() }));
  const source = t.withRequestMetadata({ ip: '8.8.8.1' });
  const first = await source.fetch('/federation/v1/health');
  expect(first.status).toBe(200);
  const discovery = await first.json();
  expect(discovery.body).toMatchObject({ townId: 'home', publicKey: keys.publicKey, deploymentEpoch: 1 });
  expect(discovery.body.endpoint).toBeUndefined();
  expect(discovery.body.endpointCandidates).toBeUndefined();
  for (let i = 1; i < 60; i++) expect((await source.fetch('/federation/v1/health')).status).toBe(200);
  expect((await source.fetch('/federation/v1/health', { headers: { 'X-Forwarded-For': '9.9.9.9' } })).status).toBe(429);
  expect((await t.withRequestMetadata({ ip: '8.8.9.1' }).fetch('/federation/v1/health')).status).toBe(200);
  expect((await source.fetch('/federation/v1/pair', { method: 'POST', body: '{' })).status).toBe(400);
});

test('counter capacity fails closed and stale cleanup restores admission without storing source addresses', async () => {
  const t = convexTest(schema, modules), source = t.withRequestMetadata({ ip: '8.8.8.1' });
  const now = Date.now(), windowStart = Math.floor(now / 60_000) * 60_000;
  await t.run(async ctx => {
    for (let i = 0; i < 4095; i++) await ctx.db.insert('federationPublicRateLimits', {
      key: `test-bucket-${i}`, windowStart, count: 1, expiresAt: windowStart + 60_000,
    });
  });
  expect((await source.mutation(mutationRef('publicRateLimit/consume'), { scope: 'HEALTH' })).allowed).toBe(false);
  expect(await t.run(ctx => ctx.db.query('federationPublicRateLimits').collect())).toHaveLength(4095);
  jest.advanceTimersByTime(60_000);
  expect((await source.mutation(mutationRef('publicRateLimit/consume'), { scope: 'HEALTH' })).allowed).toBe(true);
  const rows = await t.run(ctx => ctx.db.query('federationPublicRateLimits').collect());
  expect(rows.length).toBeLessThanOrEqual(4096);
  expect(rows.some(row => row.key.includes('8.8.8.1'))).toBe(false);
});
