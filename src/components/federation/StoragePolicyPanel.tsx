import { useLocale } from '../../i18n';
import { useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import { AdminButton, Field, TaskFeedback, formatTime, useAdminTask } from './AdminShared';

type StorageStatus = FunctionReturnType<typeof api.federation.storagePolicy.status>;
const MIB = 1024 * 1024;
const DAY = 86400000;
const categories = [
  ['canonicalMemory', 'Canonical memory', 'hotMemoryBytes'],
  ['history', 'History & relationships', 'historyBytes'],
  ['vectors', 'Derived vectors', 'vectorBytes'],
  ['cache', 'Embedding cache', 'cacheBytes'],
  ['operational', 'Delivery & runtime', 'operationalBytes'],
] as const;
function bytes(value: number) {
  return value < MIB ? `${(value / 1024).toFixed(1)} KiB` : `${(value / MIB).toFixed(1)} MiB`;
}

function PolicyForm({ adminToken, status }: { adminToken: string; status: StorageStatus }) {
  const { t } = useLocale();
  const convex = useConvex();
  const task = useAdminTask();
  const [policy, setPolicy] = useState(status.policy);
  return (
    <details className="admin-disclosure">
      <summary>{t('Configure storage budgets and retention')}</summary>
      <TaskFeedback task={task} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(
            t('Saving storage policy'),
            () =>
              convex.mutation(api.federation.storagePolicy.configure, {
                adminToken,
                hotMemoryBytes: policy.hotMemoryBytes,
                historyBytes: policy.historyBytes,
                vectorBytes: policy.vectorBytes,
                cacheBytes: policy.cacheBytes,
                operationalBytes: policy.operationalBytes,
                warningRatio: policy.warningRatio,
                messageRetentionMs: policy.messageRetentionMs,
                runtimeRetentionMs: policy.runtimeRetentionMs,
                cacheRetentionMs: policy.cacheRetentionMs,
                pauseNonessentialOnLimit: policy.pauseNonessentialOnLimit,
                coldArchiveLocation: policy.coldArchiveLocation?.trim() || undefined,
                backupIntervalHours: policy.backupIntervalHours,
                vectorRebuildBatchSize: policy.vectorRebuildBatchSize,
              }),
            t('Storage policy saved. Usage measurement is refreshing in bounded batches.'),
          );
        }}
      >
        <div className="admin-form">
          {categories.map(([, label, field]) => (
            <Field key={field} label={t('{label} budget (MiB)', { label: t(label) })}>
              <input
                type="number"
                required
                min={1 / MIB}
                max={1e15 / MIB}
                step="any"
                value={policy[field] / MIB}
                disabled={!!task.pending}
                onChange={(event) =>
                  setPolicy({ ...policy, [field]: Math.round(Number(event.target.value) * MIB) })
                }
              />
            </Field>
          ))}
          <Field label={t('Warning threshold (%)')}>
            <input
              type="number"
              required
              min={50}
              max={99}
              step={1}
              value={Math.round(policy.warningRatio * 100)}
              disabled={!!task.pending}
              onChange={(event) =>
                setPolicy({ ...policy, warningRatio: Number(event.target.value) / 100 })
              }
            />
          </Field>
          {(['messageRetentionMs', 'runtimeRetentionMs', 'cacheRetentionMs'] as const).map(
            (field) => (
              <Field
                key={field}
                label={t('{label} retention (days)', {
                  label: {
                    messageRetentionMs: t('Completed delivery'),
                    runtimeRetentionMs: t('Completed runtime'),
                    cacheRetentionMs: t('Embedding cache'),
                  }[field],
                })}
              >
                <input
                  type="number"
                  required
                  min={1}
                  max={365}
                  step={1}
                  value={policy[field] / DAY}
                  disabled={!!task.pending}
                  onChange={(event) =>
                    setPolicy({ ...policy, [field]: Number(event.target.value) * DAY })
                  }
                />
              </Field>
            ),
          )}
          <Field label={t('Backup reminder interval (hours)')}>
            <input
              type="number"
              required
              min={1}
              max={8760}
              step={1}
              value={policy.backupIntervalHours}
              disabled={!!task.pending}
              onChange={(event) =>
                setPolicy({ ...policy, backupIntervalHours: Number(event.target.value) })
              }
            />
          </Field>
          <Field label={t('Vector rebuild batch size')}>
            <input
              type="number"
              required
              min={1}
              max={100}
              step={1}
              value={policy.vectorRebuildBatchSize}
              disabled={!!task.pending}
              onChange={(event) =>
                setPolicy({ ...policy, vectorRebuildBatchSize: Number(event.target.value) })
              }
            />
          </Field>
          <Field
            label={t('Cold archive location')}
            hint={t(
              'A reference to where you keep verified archives. This does not upload files or start automatic backups.',
            )}
          >
            <input
              maxLength={1000}
              value={policy.coldArchiveLocation ?? ''}
              disabled={!!task.pending}
              onChange={(event) =>
                setPolicy({ ...policy, coldArchiveLocation: event.target.value })
              }
            />
          </Field>
        </div>
        <label className="admin-check">
          <input
            type="checkbox"
            checked={policy.pauseNonessentialOnLimit}
            disabled={!!task.pending}
            onChange={(event) =>
              setPolicy({ ...policy, pauseNonessentialOnLimit: event.target.checked })
            }
          />{' '}
          {t('Pause cache writes and vector rebuilds when a storage budget is exceeded.')}
        </label>
        <div className="admin-toolbar">
          <AdminButton type="submit" disabled={!!task.pending}>
            {t('Save storage policy')}
          </AdminButton>
        </div>
      </form>
    </details>
  );
}

export default function StoragePolicyPanel({ adminToken }: { adminToken: string }) {
  const { t } = useLocale();
  const convex = useConvex();
  const task = useAdminTask();
  const status = useQuery(api.federation.storagePolicy.status, { adminToken });
  const [cleanupReviewed, setCleanupReviewed] = useState(false);
  return (
    <section aria-label={t('Storage budgets and retention')}>
      <h3>{t('Storage budgets & retention')}</h3>
      <p className="admin-muted">
        {t(
          'Canonical memories, history and relationships are retained. Cleanup removes eligible expired caches and completed runtime records, preserving travel action and event facts before compacting them.',
        )}
      </p>
      <TaskFeedback task={task} />
      {!status ? (
        <p role="status">{t('Loading storage policy…')}</p>
      ) : (
        <>
          <dl className="admin-facts">
            <dt>{t('Last measurement')}</dt>
            <dd>
              {formatTime(status.usage.measuredAt ?? undefined)} · {t(status.usage.scanState)}
            </dd>
            <dt>{t('Cache writes')}</dt>
            <dd>
              {status.nonessential.cacheWritesPaused ? t('Paused by budget policy') : t('Allowed')}
            </dd>
            <dt>{t('Vector rebuilds')}</dt>
            <dd>
              {status.nonessential.vectorRebuildPaused
                ? t('Paused by budget policy')
                : t('Allowed')}
            </dd>
            <dt>{t('Last verified backup')}</dt>
            <dd>
              {formatTime(status.backup.lastVerifiedBackupAt ?? undefined)} ·{' '}
              {status.backup.due ? t('Backup due') : t('Within reminder interval')}
            </dd>
          </dl>
          <p className="admin-muted">
            {t(
              'Measurements estimate stored record bytes; they are not provider billing totals. Backups require an explicit archive export and download.',
            )}
          </p>
          <ul className="admin-list">
            {categories.map(([category, label, field]) => {
              const group = status.usage.groups.find(
                (item: { category: string }) => item.category === category,
              );
              const alert = status.alerts.find((item) => item.category === category);
              return (
                <li key={category}>
                  <div>
                    <strong>{t(label)}</strong>
                    <p className="admin-muted">
                      {group?.records ?? 0}
                      {t(' records · ')}
                      {bytes(group?.bytes ?? 0)} / {bytes(status.policy[field])}
                    </p>
                  </div>
                  <span className="admin-badge">
                    {status.usage.measuredAt === null
                      ? t('Not measured')
                      : alert?.level
                        ? t(alert.level)
                        : t('Within budget')}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="admin-toolbar">
            <AdminButton
              disabled={!!task.pending || status.usage.scanState === 'RUNNING'}
              onClick={() =>
                void task.run(
                  t('Starting storage measurement'),
                  () => convex.mutation(api.federation.storagePolicy.refresh, { adminToken }),
                  t('Usage scan started. Results update after all bounded batches finish.'),
                )
              }
            >
              {t('Refresh usage')}
            </AdminButton>
          </div>
          {status.cleanup && (
            <p role="status" className="admin-muted">
              {t('Cleanup: ')}
              {t(status.cleanup.state)} · {status.cleanup.table ?? t('Finished')} ·{' '}
              {status.cleanup.deletedRows}
              {t(' rows removed · ')}
              {status.cleanup.compactedActions}
              {t(' action facts and ')}
              {status.cleanup.compactedEvents}
              {t(' event facts preserved')}
            </p>
          )}
          <details className="admin-disclosure">
            <summary>{t('Clean eligible derived and completed data')}</summary>
            <p className="admin-muted">
              {t(
                'Active visits, unacknowledged deliveries and pending receipts are retained. This cleanup does not prune canonical memory, messages, relationships or verified town archives.',
              )}
            </p>
            <label className="admin-check">
              <input
                type="checkbox"
                checked={cleanupReviewed}
                disabled={!!task.pending}
                onChange={(event) => setCleanupReviewed(event.target.checked)}
              />{' '}
              {t('I reviewed the configured retention periods.')}
            </label>
            <div className="admin-toolbar">
              <AdminButton
                danger
                disabled={!!task.pending || !cleanupReviewed || status.cleanup?.state === 'RUNNING'}
                onClick={() =>
                  void task.run(
                    t('Starting retained-data cleanup'),
                    async () => {
                      await convex.mutation(api.federation.storagePolicy.cleanupNow, {
                        adminToken,
                      });
                      setCleanupReviewed(false);
                    },
                    t('Cleanup started in bounded batches. Review its server status above.'),
                  )
                }
              >
                {t('Run eligible cleanup')}
              </AdminButton>
            </div>
          </details>
          <PolicyForm adminToken={adminToken} status={status} />
        </>
      )}
    </section>
  );
}
