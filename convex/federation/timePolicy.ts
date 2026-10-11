import { v, Infer } from 'convex/values';
import { DatabaseReader, MutationCtx } from '../_generated/server';
import { Doc } from '../_generated/dataModel';

// All deployments must keep synchronized UTC within the protocol's 30 s bound.
// A stricter local acceptance window cannot reduce the two-clock return margin.
export const timePolicy = v.object({
  reservationMs: v.number(), leaseMs: v.number(), clockSkewMs: v.number(),
  probeFreshnessMs: v.number(), probeIntervalMs: v.number(), gapTimeoutMs: v.number(),
  returnMarginMs: v.number(), clockObservationGapMs: v.number(), requestTimeoutMs: v.number(),
});
export type TimePolicy = Infer<typeof timePolicy>;
export const CLOCK_DRAIN_STATES = ['REQUESTED', 'FREEZING', 'CONFIRMING', 'QUEUED', 'RESERVED',
  'CREATING', 'ACTIVE', 'REMOVING', 'RETURN_PENDING'];
export async function activeVisitsRemain(db: DatabaseReader) {
  for (const state of CLOCK_DRAIN_STATES) {
    if (await db.query('visitLedger').withIndex('state', q => q.eq('state', state)).first()) return true;
  }
  return false;
}
export function configuredTimePolicy(local?: { timePolicy?: TimePolicy; maxVisitDurationMs: number } | null): TimePolicy {
  return local?.timePolicy ?? { reservationMs: 30_000, leaseMs: local?.maxVisitDurationMs ?? 300_000,
    clockSkewMs: 30_000, probeFreshnessMs: 120_000, probeIntervalMs: 45_000,
    gapTimeoutMs: 30_000, returnMarginMs: 60_000, clockObservationGapMs: 120_000, requestTimeoutMs: 8_000 };
}
export function validateTimePolicy(policy: TimePolicy, maxTripMs: number) {
  const bounds: Record<keyof TimePolicy, [number, number]> = {
    reservationMs: [5_000, 120_000], leaseMs: [30_000, maxTripMs], clockSkewMs: [1_000, 30_000],
    probeFreshnessMs: [20_000, 300_000], probeIntervalMs: [10_000, 120_000],
    gapTimeoutMs: [5_000, 120_000], returnMarginMs: [60_000, 600_000],
    clockObservationGapMs: [30_000, 600_000], requestTimeoutMs: [1_000, 30_000],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = policy[key as keyof TimePolicy];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('INVALID_TIME_POLICY');
  }
  if (policy.probeIntervalMs >= policy.probeFreshnessMs || policy.requestTimeoutMs >= policy.reservationMs)
    throw new Error('INVALID_TIME_POLICY');
}
export function effectiveReturnMargin(policy: TimePolicy) {
  // Covers a single undetected forward jump within the observation gap plus
  // both UTC skew bounds. Correct UTC synchronization remains a prerequisite;
  // observing our own wall clock cannot prove a continuous drift bound.
  return Math.max(policy.returnMarginMs, 2 * policy.clockObservationGapMs + 60_000);
}
type ClockRecord = { observedAt: number; uncertain: boolean; reason?: string; returnClockConfirmedAt?: number };
export function clockHealth(record: ClockRecord | null, policy: TimePolicy, now = Date.now()) {
  const observationReason = record && now < record.observedAt ? 'CLOCK_MOVED_BACKWARDS'
    : record && now - record.observedAt > policy.clockObservationGapMs ? 'CLOCK_OBSERVATION_GAP' : undefined;
  const reason = observationReason ?? (record?.uncertain ? record.reason ?? 'CLOCK_UNCERTAIN' : undefined);
  return { healthy: !reason, reason, observedAt: record?.observedAt, observationReason,
    returnClockHealthy: !!record && !observationReason && (!record.uncertain || record.returnClockConfirmedAt !== undefined) };
}
export async function readClock(db: DatabaseReader, local?: Parameters<typeof configuredTimePolicy>[0], now = Date.now()) {
  const record = await db.query('federationClock').unique();
  if (!record && await activeVisitsRemain(db))
    return clockHealth({ observedAt: now, uncertain: true, reason: 'CLOCK_EVIDENCE_MISSING' }, configuredTimePolicy(local), now);
  return clockHealth(record, configuredTimePolicy(local), now);
}
export async function observeClock(ctx: MutationCtx, local?: Parameters<typeof configuredTimePolicy>[0], now = Date.now()) {
  const record = await ctx.db.query('federationClock').unique();
  const health = clockHealth(record, configuredTimePolicy(local), now);
  // A first observation cannot attest to the UTC history of surviving grants.
  // Keep legacy/recovered visits locked until explicit UTC confirmation.
  if (!record && await activeVisitsRemain(ctx.db)) {
    await ctx.db.insert('federationClock', { observedAt: now, uncertain: true, reason: 'CLOCK_EVIDENCE_MISSING' });
    return clockHealth({ observedAt: now, uncertain: true, reason: 'CLOCK_EVIDENCE_MISSING' }, configuredTimePolicy(local), now);
  }
  const fields = { observedAt: Math.max(record?.observedAt ?? now, now), uncertain: !health.healthy,
    ...(health.reason ? { reason: health.reason } : {}),
    ...(health.observationReason ? { returnClockConfirmedAt: undefined } : {}) };
  if (record) await ctx.db.patch(record._id, fields); else await ctx.db.insert('federationClock', fields);
  return health;
}
export async function assertClock(db: DatabaseReader, local?: Parameters<typeof configuredTimePolicy>[0]) {
  if (!(await readClock(db, local)).healthy) throw new Error('CLOCK_UNCERTAIN');
}
export function returnSafety(ledger: Pick<Doc<'visitLedger'>, 'leaseExpiry' | 'leaseSafetyMs' | 'cleanupConfirmed'>,
  clock: { healthy: boolean; returnClockHealthy?: boolean }, now = Date.now()) {
  const deadlineClockHealthy = clock.returnClockHealthy ?? clock.healthy;
  const safeAfter = ledger.leaseExpiry + (ledger.leaseSafetyMs ?? 60_000);
  return { safeAfter, allowed: !!ledger.cleanupConfirmed || deadlineClockHealthy && now >= safeAfter,
    condition: ledger.cleanupConfirmed ? 'SIGNED_CLEANUP' : !deadlineClockHealthy ? 'CLOCK_UNCERTAIN'
      : now >= safeAfter ? 'LEASE_AND_MARGIN_EXPIRED' : 'WAITING_FOR_LEASE_AND_MARGIN' };
}
export async function canResume(db: DatabaseReader, ledger: Parameters<typeof returnSafety>[0], now = Date.now()) {
  const local = await db.query('federationIdentity').unique();
  return returnSafety(ledger, await readClock(db, local, now), now).allowed;
}
