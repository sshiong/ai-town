import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { clockHealth, effectiveReturnMargin, configuredTimePolicy, observeClock, readClock, returnSafety, validateTimePolicy, canResume } from './timePolicy';
import { mutationRef } from './refs';
import { validateEnvelope, PROTOCOL } from './protocol';
import { ready } from './store';

const modules = { '../_generated/server.ts': () => import('../_generated/server'), '../federation/admin.ts': () => import('./admin') };
const token = 'time-policy-test-admin-token-32bytes';
beforeEach(() => { jest.useFakeTimers(); process.env.FEDERATION_ADMIN_TOKEN = token; });
afterEach(() => jest.useRealTimers());

test('time policy bounds protect UTC skew and the two-clock return margin', () => {
  const policy = configuredTimePolicy();
  expect(() => validateTimePolicy(policy, 300000)).not.toThrow();
  expect(effectiveReturnMargin(policy)).toBe(300000);
  expect(effectiveReturnMargin({ ...policy, returnMarginMs: 600000 })).toBe(600000);
  for (const invalid of [{ clockSkewMs: 30001 }, { returnMarginMs: 59999 }, { leaseMs: 300001 },
    { reservationMs: 4999 }, { probeIntervalMs: policy.probeFreshnessMs }, { requestTimeoutMs: policy.reservationMs }, { gapTimeoutMs: NaN }]) {
    expect(() => validateTimePolicy({ ...policy, ...invalid }, 300000)).toThrow('INVALID_TIME_POLICY');
  }
  const connection = { channelState: 'TRANSPORT_READY', inboundVerifiedAt: Date.now() - 30000, outboundVerifiedAt: Date.now() - 30000 } as any;
  expect(ready(connection)).toBe(true);
  expect(ready(connection, Date.now(), { ...policy, probeFreshnessMs: 20000, probeIntervalMs: 10000 })).toBe(false);
});

test.each(['backward', 'gap'])('a %s clock anomaly remains persistently locked after normal observations', async kind => {
  const t = convexTest(schema, modules), start = Date.now(), policy = configuredTimePolicy();
  await t.run(ctx => observeClock(ctx, null, start));
  const abnormal = kind === 'backward' ? start - 1 : start + policy.clockObservationGapMs + 1;
  expect((await t.run(ctx => observeClock(ctx, null, abnormal))).healthy).toBe(false);
  expect((await t.run(ctx => observeClock(ctx, null, start + policy.clockObservationGapMs + 2))).healthy).toBe(false);
  expect((await t.run(ctx => readClock(ctx.db, null, start + 1000000))).healthy).toBe(false);
  expect((await t.run(ctx => ctx.db.query('federationClock').unique()))?.uncertain).toBe(true);
  expect(clockHealth({ observedAt: start, uncertain: true }, policy, start).healthy).toBe(false);
});

test('identical clock observations avoid writes but every newer timestamp remains the backwards baseline', async () => {
  const t = convexTest(schema, modules), start = Date.now();
  await t.run(ctx => observeClock(ctx, null, start));
  for (const [now, expectedWrites, healthy] of [[start, 0, true], [start + 1, 1, true],
    [start, 1, false], [start, 0, false]] as const) {
    await t.run(async ctx => {
      const patch = jest.spyOn(ctx.db, 'patch');
      expect((await observeClock(ctx, null, now)).healthy).toBe(healthy);
      expect(patch).toHaveBeenCalledTimes(expectedWrites);
      patch.mockRestore();
    });
  }
  expect(await t.run(ctx => ctx.db.query('federationClock').unique())).toMatchObject({
    observedAt: start + 1, uncertain: true, reason: 'CLOCK_MOVED_BACKWARDS',
  });
});

test('repeated observations retain UTC return confirmation until a new anomaly revokes it exactly once', async () => {
  const t = convexTest(schema, modules), start = Date.now();
  await t.mutation(mutationRef('admin/confirmReturnClock'), { adminToken: token, synchronizedUtcConfirmed: true });
  for (const [now, expectedWrites, confirmed] of [[start, 0, true], [start + 1, 1, true],
    [start, 1, false], [start, 0, false]] as const) {
    await t.run(async ctx => {
      const patch = jest.spyOn(ctx.db, 'patch');
      await observeClock(ctx, null, now);
      expect(patch).toHaveBeenCalledTimes(expectedWrites);
      patch.mockRestore();
    });
    const record = (await t.run(ctx => ctx.db.query('federationClock').unique()))!;
    expect(record.uncertain).toBe(true);
    expect(record.returnClockConfirmedAt).toBe(confirmed ? start : undefined);
  }
});

test('return uses the saved trip margin and signed cleanup alone bypasses an unsafe clock', () => {
  const ledger = { leaseExpiry: 10000, leaseSafetyMs: 180000 };
  expect(returnSafety(ledger, { healthy: true }, 189999).allowed).toBe(false);
  expect(returnSafety(ledger, { healthy: true }, 190000)).toMatchObject({ allowed: true, safeAfter: 190000 });
  expect(returnSafety(ledger, { healthy: false }, 9999999)).toMatchObject({ allowed: false, condition: 'CLOCK_UNCERTAIN' });
  expect(returnSafety({ ...ledger, cleanupConfirmed: true }, { healthy: false }, 1)).toMatchObject({ allowed: true, condition: 'SIGNED_CLEANUP' });
});

test('a missing clock record cannot prove a surviving legacy grant expired, including after maintenance observes time', async () => {
  const t = convexTest(schema, modules), now = Date.now();
  const id = await t.run(ctx => ctx.db.insert('visitLedger', {
    visitId: 'legacy-no-clock', agentGlobalId: 'home/agent:a', homeTownId: 'home', hostTownId: 'host',
    homeDeploymentEpoch: 1, hostDeploymentEpoch: 1, agentAuthorityEpoch: 1, visitLeaseVersion: 1,
    leaseExpiry: now - 1000000, fencingToken: 'legacy-fence', state: 'RETURN_PENDING', role: 'home',
    profile: {}, createdAt: now - 1000000, updatedAt: now,
  }));
  const ledger = (await t.run(ctx => ctx.db.get(id)))!;
  expect(clockHealth(null, configuredTimePolicy(), now).returnClockHealthy).toBe(false);
  expect(await t.run(ctx => readClock(ctx.db))).toMatchObject({ healthy: false, returnClockHealthy: false, reason: 'CLOCK_EVIDENCE_MISSING' });
  expect(await t.run(ctx => canResume(ctx.db, ledger))).toBe(false);
  expect(await t.run(ctx => canResume(ctx.db, { ...ledger, cleanupConfirmed: true }))).toBe(true);
  expect(await t.run(ctx => observeClock(ctx))).toMatchObject({ healthy: false, returnClockHealthy: false, reason: 'CLOCK_EVIDENCE_MISSING' });
  expect(await t.run(ctx => canResume(ctx.db, ledger))).toBe(false);
  await expect(t.mutation(mutationRef('admin/confirmReturnClock'), { adminToken: token, synchronizedUtcConfirmed: false })).rejects.toThrow('CONFIRM_SYNCHRONIZED_UTC_FIRST');
  await t.mutation(mutationRef('admin/confirmReturnClock'), { adminToken: token, synchronizedUtcConfirmed: true });
  expect(await t.run(ctx => canResume(ctx.db, ledger))).toBe(true);
  expect((await t.run(ctx => readClock(ctx.db))).healthy).toBe(false);
});

test('administrator clock recovery requires explicit UTC confirmation and no surviving visit', async () => {
  const t = convexTest(schema, modules);
  const id = await t.run(async ctx => {
    await ctx.db.insert('federationClock', { observedAt: Date.now(), uncertain: true, reason: 'CLOCK_MOVED_BACKWARDS' });
    return ctx.db.insert('visitLedger', { visitId: 'locked-trip', agentGlobalId: 'home/agent:a', homeTownId: 'home', hostTownId: 'host',
      homeDeploymentEpoch: 1, hostDeploymentEpoch: 1, agentAuthorityEpoch: 1, visitLeaseVersion: 1,
      leaseExpiry: Date.now() - 1000000, fencingToken: 'clock-test-fence', state: 'RETURN_PENDING', role: 'home',
      profile: {}, createdAt: Date.now(), updatedAt: Date.now() });
  });
  await expect(t.mutation(mutationRef('admin/confirmClockRecovery'), { adminToken: token, synchronizedUtcConfirmed: false })).rejects.toThrow('CONFIRM_SYNCHRONIZED_UTC_FIRST');
  await expect(t.mutation(mutationRef('admin/confirmClockRecovery'), { adminToken: token, synchronizedUtcConfirmed: true })).rejects.toThrow('END_ALL_VISITS_BEFORE_CLOCK_RECOVERY');
  expect((await t.run(ctx => readClock(ctx.db))).healthy).toBe(false);
  await t.run(ctx => ctx.db.patch(id, { state: 'COMPLETED', cleanupConfirmed: true }));
  await t.mutation(mutationRef('admin/confirmClockRecovery'), { adminToken: token, synchronizedUtcConfirmed: true });
  expect((await t.run(ctx => readClock(ctx.db))).healthy).toBe(true);
  expect((await t.run(ctx => ctx.db.query('federationResourceAudit').unique()))?.operation).toBe('CLOCK_RECOVERY_CONFIRMED');
});

test('clock recovery envelope exemption never permits an expired action or an unbounded timestamp', () => {
  const envelope = { protocol: PROTOCOL, messageId: 'message', fromTownId: 'home', toTownId: 'host', senderDeploymentInstanceId: 'instance',
    senderDeploymentEpoch: 1, expectedRecipientDeploymentEpoch: 1, type: 'VISIT_CLEANED', payload: {}, sentAt: 1000, expiresAt: 2000,
    nonce: 'nonce', credentialId: 'credential', visitId: 'visit', agentGlobalId: 'agent', agentAuthorityEpoch: 1, visitLeaseVersion: 1, streamId: 'lease-control', sequence: 1 };
  expect(() => validateEnvelope(envelope, 3000)).toThrow('MESSAGE_EXPIRED');
  expect(() => validateEnvelope(envelope, 3000, configuredTimePolicy(), true)).not.toThrow();
  expect(() => validateEnvelope({ ...envelope, type: 'DECISION' }, 3000, configuredTimePolicy(), true)).toThrow('MESSAGE_EXPIRED');
  expect(() => validateEnvelope({ ...envelope, expiresAt: 1000000 }, 3000, configuredTimePolicy(), true)).toThrow('MESSAGE_EXPIRED');
});


test.each(['backward', 'gap'])('a new %s anomaly revokes UTC return-only confirmation without unlocking admission', async kind => {
  const t = convexTest(schema, modules), startedAt = Date.now();
  await t.mutation(mutationRef('admin/confirmReturnClock'), { adminToken: token, synchronizedUtcConfirmed: true });
  expect(await t.run(ctx => readClock(ctx.db))).toMatchObject({ healthy: false, returnClockHealthy: true });
  const abnormal = kind === 'backward' ? startedAt - 1 : startedAt + configuredTimePolicy().clockObservationGapMs + 1;
  await t.run(ctx => observeClock(ctx, null, abnormal));
  expect(await t.run(ctx => readClock(ctx.db, null, startedAt + configuredTimePolicy().clockObservationGapMs + 2))).toMatchObject({ healthy: false, returnClockHealthy: false });
  expect((await t.run(ctx => ctx.db.query('federationClock').unique()))?.returnClockConfirmedAt).toBeUndefined();
});
