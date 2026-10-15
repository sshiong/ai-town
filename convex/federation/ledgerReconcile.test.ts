import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { mutationRef } from './refs';
import { reconcile } from './ledger';
import { configuredTimePolicy } from './timePolicy';

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/ledger.ts': () => import('./ledger'),
};
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('empty state workers never read or write shared clock evidence', async () => {
  const t = convexTest(schema, modules), start = Date.now();
  await t.run(ctx => ctx.db.insert('federationClock', { observedAt: start, uncertain: false }));
  jest.setSystemTime(start + configuredTimePolicy().clockObservationGapMs + 1);
  for (const state of ['REQUESTED', 'FREEZING', 'CONFIRMING', 'QUEUED', 'RESERVED', 'CREATING', 'ACTIVE', 'REMOVING', 'RETURN_PENDING']) {
    await t.run(async ctx => {
      const query = jest.spyOn(ctx.db, 'query'), patch = jest.spyOn(ctx.db, 'patch');
      expect(await (reconcile as any)._handler(ctx, { state, cursor: null })).toEqual({ processed: 0, continuations: 0 });
      expect(query.mock.calls.some(([table]) => table === 'federationClock')).toBe(false);
      expect(patch).not.toHaveBeenCalled();
      query.mockRestore(); patch.mockRestore();
    });
  }
  expect(await t.run(ctx => ctx.db.query('federationClock').unique())).toMatchObject({ observedAt: start, uncertain: false });
  expect(await t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())).toEqual([]);
});

test('empty root reconciliation still observes clock and schedules its state workers', async () => {
  const t = convexTest(schema, modules), start = Date.now();
  await t.run(ctx => ctx.db.insert('federationClock', { observedAt: start, uncertain: false }));
  jest.setSystemTime(start + configuredTimePolicy().clockObservationGapMs + 1);
  expect(await t.mutation(mutationRef('ledger/reconcile'), {})).toEqual({ processed: 0, continuations: 8 });
  expect(await t.run(ctx => ctx.db.query('federationClock').unique())).toMatchObject({ uncertain: true, reason: 'CLOCK_OBSERVATION_GAP' });
  expect(await t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())).toHaveLength(8);
});

test.each(['backward', 'gap'])('a populated state worker still locks a %s clock anomaly and revokes return confirmation', async kind => {
  const t = convexTest(schema, modules), start = Date.now();
  await t.run(async ctx => {
    await ctx.db.insert('federationClock', { observedAt: start, uncertain: true, reason: 'CLOCK_RECOVERY_DRAINING', returnClockConfirmedAt: start });
    await ctx.db.insert('visitLedger', { visitId: 'pending', agentGlobalId: 'home/agent:pending',
      homeTownId: 'home', hostTownId: 'host', homeDeploymentEpoch: 1, hostDeploymentEpoch: 1,
      agentAuthorityEpoch: 1, visitLeaseVersion: 1, leaseExpiry: start - 1000000,
      fencingToken: 'fixture-fencing-token', state: 'RETURN_PENDING', role: 'home', profile: {},
      createdAt: start, updatedAt: start });
  });
  jest.setSystemTime(kind === 'backward' ? start - 1 : start + configuredTimePolicy().clockObservationGapMs + 1);
  expect(await t.mutation(mutationRef('ledger/reconcile'), { state: 'RETURN_PENDING', cursor: null })).toEqual({ processed: 1, continuations: 0 });
  const clock = (await t.run(ctx => ctx.db.query('federationClock').unique()))!;
  expect(clock).toMatchObject({ uncertain: true, reason: kind === 'backward' ? 'CLOCK_MOVED_BACKWARDS' : 'CLOCK_OBSERVATION_GAP' });
  expect(clock.returnClockConfirmedAt).toBeUndefined();
  expect(await t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())).toEqual([]);
});

test('safe-return reconciliation skips terminal history and continues every active page', async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    for (let index = 0; index < 3051; index++) await ctx.db.insert('visitLedger', {
      visitId: `visit-${index}`, agentGlobalId: `home/agent:${index}`,
      homeTownId: 'home', hostTownId: 'host', homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1, agentAuthorityEpoch: 1, visitLeaseVersion: 1,
      leaseExpiry: Date.now() - 100000, fencingToken: 'fixture-fencing-token',
      state: index < 3000 ? 'COMPLETED' : 'RETURN_PENDING', role: 'home',
      profile: { name: 'Resident', description: 'Preserved travel history' },
      cleanupConfirmed: true, createdAt: Date.now(), updatedAt: Date.now(),
    });
  });
  expect(await t.mutation(mutationRef('ledger/reconcile'), {})).toEqual({ processed: 20, continuations: 9 });
  const handled = new Set<string>();
  for (let page = 0; page < 2; page++) {
    const continuation = await t.run(async ctx =>
      (await ctx.db.system.query('_scheduled_functions').collect()).find(row =>
        row.name === 'federation/ledger:reconcile' &&
        (row.args[0] as { state: string }).state === 'RETURN_PENDING' && !handled.has(row._id)),
    );
    expect(continuation).toBeDefined();
    handled.add(continuation!._id);
    const result = await t.mutation(mutationRef('ledger/reconcile'), continuation!.args[0]);
    expect(result).toEqual({ processed: page === 0 ? 20 : 11, continuations: page === 0 ? 1 : 0 });
  }
  const scheduled = await t.run(ctx => ctx.db.system.query('_scheduled_functions').collect());
  const resumes = scheduled.filter(row => row.name === 'federation/runtime:resumeHome');
  expect(resumes).toHaveLength(51);
  expect(new Set(resumes.map(row => (row.args[0] as { visitId: string }).visitId)).size).toBe(51);
  expect(await t.run(ctx => ctx.db.query('visitLedger').withIndex('state', q => q.eq('state', 'COMPLETED')).collect())).toHaveLength(3000);
});

test('reconciliation rejects terminal-state and unbound cursor continuations', async () => {
  const t = convexTest(schema, modules);
  await expect(t.mutation(mutationRef('ledger/reconcile'), { state: 'COMPLETED' })).rejects.toThrow('INVALID_RECONCILE_STATE');
  await expect(t.mutation(mutationRef('ledger/reconcile'), { cursor: 'unbound' })).rejects.toThrow('INVALID_RECONCILE_CURSOR');
});

test('continuation does not skip visits when the preceding page changes its indexed state', async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    for (let index = 0; index < 41; index++) await ctx.db.insert('visitLedger', {
      visitId: `queued-${index}`, agentGlobalId: `home/agent:${index}`,
      homeTownId: 'home', hostTownId: 'host', homeDeploymentEpoch: 1,
      hostDeploymentEpoch: 1, agentAuthorityEpoch: 1, visitLeaseVersion: 1,
      leaseExpiry: Date.now() - 100000, queueExpiresAt: Date.now() - 1000,
      fencingToken: 'fixture-fencing-token', state: 'QUEUED', role: 'home',
      profile: {}, cleanupConfirmed: true, createdAt: Date.now(), updatedAt: Date.now(),
    });
  });
  let args: Record<string, unknown> = { state: 'QUEUED', cursor: null };
  const handled = new Set<string>();
  for (const size of [20, 20, 1]) {
    expect(await t.mutation(mutationRef('ledger/reconcile'), args)).toEqual({ processed: size, continuations: size === 20 ? 1 : 0 });
    const next = await t.run(async ctx =>
      (await ctx.db.system.query('_scheduled_functions').collect()).find(row =>
        row.name === 'federation/ledger:reconcile' && !handled.has(row._id)),
    );
    if (next) { handled.add(next._id); args = next.args[0] as Record<string, unknown>; }
  }
  expect(await t.run(ctx => ctx.db.query('visitLedger').withIndex('state', q => q.eq('state', 'QUEUED')).collect())).toEqual([]);
  expect(await t.run(ctx => ctx.db.query('visitLedger').withIndex('state', q => q.eq('state', 'RETURN_PENDING')).collect())).toHaveLength(41);
});
