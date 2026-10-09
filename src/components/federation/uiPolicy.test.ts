import {
  adminErrorSummary,
  canResumeRestoredResident,
  isOpenVisit,
  isReadyDestination,
  readBackupFile,
  requiresStoppedSource,
} from './uiPolicy';
import { jest } from '@jest/globals';

describe('federation UI operation gates', () => {
  test('restored travel unlocks after the safety deadline despite the cached lease-time reason', () => {
    const resident = { safeAfter: 2000, engineStopped: true, reason: 'OLD_HOST_LEASE_STILL_VALID' };
    expect(canResumeRestoredResident(resident, 1999)).toBe(false);
    expect(canResumeRestoredResident(resident, 2000)).toBe(true);
    expect(canResumeRestoredResident({ ...resident, engineStopped: false }, 3000)).toBe(false);
    expect(canResumeRestoredResident({ ...resident, safeAfter: null }, 3000)).toBe(false);
    expect(
      canResumeRestoredResident({ ...resident, reason: 'RESTORE_EVIDENCE_MISSING' }, 3000),
    ).toBe(false);
  });
  test('requires an explicitly stopped source for both same-identity import modes', () => {
    expect(requiresStoppedSource('restore')).toBe(true);
    expect(requiresStoppedSource('migrate')).toBe(true);
    expect(requiresStoppedSource('merge')).toBe(false);
    expect(requiresStoppedSource('clone')).toBe(false);
  });
  test('explains known server refusal while retaining unknown errors', () => {
    expect(adminErrorSummary('Server Error: STOP_TARGET_ENGINE_FIRST')).toContain(
      'Pause the target',
    );
    expect(adminErrorSummary('provider unavailable')).toBe('provider unavailable');
  });
  test.each(['TRANSPORT_TESTING', 'PAIRED_BUT_NOT_REACHABLE', 'TRANSPORT_DEGRADED'])(
    'blocks travel to a trusted town with %s',
    (channelState) => {
      expect(
        isReadyDestination({
          trustState: 'TRUSTED',
          channelState,
          outboundVisitsAllowed: true,
          readinessExpiresAt: Date.now() + 1000,
        }),
      ).toBe(false);
    },
  );
  test('requires trust, both transport directions and explicit outgoing permission', () => {
    const ready = {
      trustState: 'TRUSTED',
      channelState: 'TRANSPORT_READY',
      outboundVisitsAllowed: true,
      readinessExpiresAt: Date.now() + 1000,
    };
    expect(isReadyDestination(ready)).toBe(true);
    expect(isReadyDestination({ ...ready, trustState: 'PAUSED' })).toBe(false);
    expect(isReadyDestination({ ...ready, outboundVisitsAllowed: false })).toBe(false);
    expect(isReadyDestination({ ...ready, readinessExpiresAt: 1000 }, 1000)).toBe(false);
    expect(isReadyDestination({ ...ready, readinessExpiresAt: 0 }, 1000)).toBe(false);
  });
  test('includes reservations and cleanup in occupied capacity, but releases completed/rejected visits', () => {
    for (const state of ['REQUESTED', 'RESERVED', 'ACTIVE', 'RETURN_PENDING', 'REMOVING'])
      expect(isOpenVisit(state)).toBe(true);
    expect(isOpenVisit('COMPLETED')).toBe(false);
    expect(isOpenVisit('REJECTED')).toBe(false);
  });
  test('rejects an oversized package before reading it', async () => {
    const text = jest.fn(() => Promise.resolve('{}'));
    await expect(readBackupFile({ size: 5 * 1024 * 1024 + 1, text })).rejects.toThrow('5 MiB');
    expect(text).not.toHaveBeenCalled();
  });
  test.each(['null', '[]', '"data"', '{invalid'])(
    'rejects malformed/non-object JSON: %s',
    async (value) => {
      await expect(
        readBackupFile({ size: value.length, text: () => Promise.resolve(value) }),
      ).rejects.toThrow();
    },
  );
  test('passes the unmodified object to authoritative server preflight', async () => {
    await expect(
      readBackupFile({ size: 12, text: () => Promise.resolve('{"digest":"x"}') }),
    ).resolves.toEqual({ digest: 'x' });
  });
});
