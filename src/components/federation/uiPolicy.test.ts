import { translate } from '../../locale';
import { federationMessages } from '../../locales/federation';
import {
  adminErrorSummary,
  safeReturnSummary, eventProgressSummary,
  canResumeRestoredResident,
  canManageQueuedVisit,
  deadlineRemaining,
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
    expect(adminErrorSummary('Server Error: DNS_RESOLUTION_FAILED')).toContain('hostname could not be resolved');
    expect(adminErrorSummary('Server Error: TLS_VERIFY_FAILED')).toContain('certificate could not be verified');
    expect(adminErrorSummary('Server Error: CONNECTION_TIMEOUT')).toContain('timed out');
    expect(adminErrorSummary('Server Error: FEDERATION_HTTP_503')).toContain('HTTP 503');
    expect(adminErrorSummary('NO_BIDIRECTIONAL_PATH')).toContain('reverse route has not been verified');
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
    for (const state of ['REQUESTED', 'QUEUED', 'RESERVED', 'ACTIVE', 'RETURN_PENDING', 'REMOVING'])
      expect(isOpenVisit(state)).toBe(true);
    expect(isOpenVisit('COMPLETED')).toBe(false);
    expect(isOpenVisit('REJECTED')).toBe(false);
  });
  test('queued controls follow deadlines and pauses without preventing expired rejection', () => {
    const visit = { state: 'QUEUED', queueExpiresAt: 2000, queuePaused: false };
    expect(canManageQueuedVisit(visit, 'PROMOTE', 1999)).toBe(true);
    expect(canManageQueuedVisit(visit, 'PAUSE', 1999)).toBe(true);
    expect(canManageQueuedVisit(visit, 'RESUME', 1999)).toBe(false);
    expect(canManageQueuedVisit({ ...visit, queuePaused: true }, 'PROMOTE', 1999)).toBe(false);
    expect(canManageQueuedVisit({ ...visit, queuePaused: true }, 'RESUME', 1999)).toBe(true);
    expect(canManageQueuedVisit(visit, 'PROMOTE', 2000)).toBe(false);
    expect(canManageQueuedVisit(visit, 'REJECT', 2000)).toBe(true);
    expect(canManageQueuedVisit({ state: 'QUEUED' }, 'PROMOTE', 1000)).toBe(false);
    for (const state of ['RESERVED', 'ACTIVE', 'REJECTED', 'COMPLETED'])
      for (const operation of ['PAUSE', 'RESUME', 'REJECT', 'PROMOTE'] as const)
        expect(canManageQueuedVisit({ ...visit, state }, operation, 1000)).toBe(false);
  });
  test('waiting countdown reports exact expiry, remaining seconds and unavailable deadlines', () => {
    expect(deadlineRemaining(61000, 0)).toBe('1m 1s remaining');
    expect(deadlineRemaining(1001, 1000)).toBe('1s remaining');
    expect(deadlineRemaining(1000, 1000)).toBe('Expired');
    expect(deadlineRemaining(1000, 2000)).toBe('Expired');
    expect(deadlineRemaining(undefined, 0)).toBe('Not reported');
    expect(deadlineRemaining(NaN, 0)).toBe('Not reported');
  });
  test('explains queue refusal without presenting admission as guaranteed', () => {
    expect(adminErrorSummary('HOST_CAPACITY_EXCEEDED')).toContain('no visitor place');
    expect(adminErrorSummary('VISITOR_QUEUE_EXPIRED')).toContain('without departure');
    expect(adminErrorSummary('VISITOR_SOURCE_QUEUE_FULL')).toContain('source town');
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


test('clock uncertainty and history progress have explicit safe-return wording', () => {
  expect(safeReturnSummary('CLOCK_UNCERTAIN')).toContain('waiting longer cannot unlock');
  expect(safeReturnSummary('SIGNED_CLEANUP')).toContain('signed cleanup');
  expect(eventProgressSummary(71, 69, 'host')).toContain('2 event page(s)');
  expect(eventProgressSummary(69, 69, 'home')).toContain('cannot be reconstructed');
});

test('localized safety summaries retain countdown values and unknown evidence', () => {
  const t = (message: string, values?: Record<string, string | number>) =>
    translate('zh-CN', federationMessages, message, values);
  expect(deadlineRemaining(61000, 0, t)).toBe('剩余 1 分 1 秒');
  expect(deadlineRemaining(1000, 1000, t)).toBe('已过期');
  expect(deadlineRemaining(undefined, 0, t)).toBe('未报告');
  expect(safeReturnSummary('SIGNED_CLEANUP', t)).toBe('接待方签名清理已确认；已授权在家乡恢复。');
  expect(eventProgressSummary(71, 69, 'host', t)).toContain('还有 2 页事件等待确认');
  expect(adminErrorSummary('FEDERATION_HTTP_503', t)).toBe('远程 HTTPS 服务返回 HTTP 503。');
  expect(adminErrorSummary('HOST_CAPACITY_EXCEEDED', t)).toContain('可用访客名额');
  expect(adminErrorSummary('TOWN_TRAVEL_PRIVACY_BUSY', t)).toBe('旅行隐私检查或清理正在运行，请等待完成后再开始归档。');
  expect(adminErrorSummary('BACKUP_PRIVACY_REDACTED', t)).toBe('该归档包含已标记清除的内容，请使用清理完成后导出的备份。');
  expect(adminErrorSummary('BACKUP_PRIVACY_REWRITE_ACTIVE', t)).toBe('归档隐私清理正在重写文件，请等待完成后再下载。');
  expect(adminErrorSummary('BACKUP_CHECKPOINT_CHANGED', t)).toBe('读取期间归档发生了变化，请从当前断点重新下载。');
  expect(adminErrorSummary('LOCAL_ARCHIVE_PRIVATE_ROLLBACK_NOT_PORTABLE', t)).toBe('该本地归档包含私有回滚数据，无法作为可移植备份下载。');
  expect(adminErrorSummary('LOCAL_ARCHIVE_DIGEST_MISMATCH', t)).toBe('无法验证清理后的归档，请保留已保存的断点，检查归档后再重试。');
  expect(adminErrorSummary('Opaque evidence: town-id', t)).toBe('Opaque evidence: town-id');
  expect(safeReturnSummary('UNRECOGNIZED_EVIDENCE', t)).toBe('UNRECOGNIZED_EVIDENCE');
});
