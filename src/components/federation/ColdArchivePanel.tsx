import { useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference, type ApiFromModules } from 'convex/server';
import type * as cold from '../../../convex/federation/coldArchive';
import type { Id } from '../../../convex/_generated/dataModel';
import { useLocale } from '../../i18n';
import {
  AdminButton,
  EmptyState,
  Field,
  TaskFeedback,
  formatTime,
  useAdminTask,
} from './AdminShared';
import {
  canAdvanceColdMirror,
  canStartColdMirror,
  coldMirrorProgress,
} from './coldArchiveUiPolicy';

type ColdApi = ApiFromModules<{ cold: typeof cold }>['cold'];
const statusRef: ColdApi['status'] = makeFunctionReference('federation/coldArchive:status');
const archivesRef: ColdApi['archives'] = makeFunctionReference('federation/coldArchive:archives');
const configureRef: ColdApi['configure'] = makeFunctionReference(
  'federation/coldArchive:configure',
);
const verifyRef: ColdApi['verify'] = makeFunctionReference('federation/coldArchive:verify');
const startRef: ColdApi['start'] = makeFunctionReference('federation/coldArchive:start');
const advanceRef: ColdApi['advance'] = makeFunctionReference('federation/coldArchive:advance');
const cancelRef: ColdApi['cancel'] = makeFunctionReference('federation/coldArchive:cancel');

export default function ColdArchivePanel({ adminToken }: { adminToken: string }) {
  const { t } = useLocale(),
    convex = useConvex(),
    task = useAdminTask();
  const [name, setName] = useState(''),
    [operator, setOperator] = useState('');
  const [archiveId, setArchiveId] = useState<Id<'coldHistoryArchives'>>();
  const [jobId, setJobId] = useState<Id<'coldArchiveMirrorJobs'>>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const archivePage = useQuery(archivesRef, { adminToken, cursor });
  const status = useQuery(statusRef, { adminToken, ...(archiveId ? { archiveId } : {}) });
  const configuration = status?.configured.find((target) => target.name === name);
  const target = status?.destinations.find((target) => target.name === name);
  const archive = archivePage?.page.find((item) => item.archiveId === archiveId);
  const jobs =
    archiveId && target
      ? (status?.jobs.filter((job) => job.destinationId === target._id) ?? [])
      : [];
  const job = jobs.find((item) => item.jobId === jobId) ?? (!jobId ? jobs[0] : undefined);
  const progress = job ? coldMirrorProgress(job) : undefined;
  const pending = !!task.pending;
  const operatorValid = !!operator.trim() && operator.length <= 100;

  function changePage(next: string | null) {
    setCursor(next);
    setArchiveId(undefined);
    setJobId(undefined);
  }
  return (
    <section className="admin-section" aria-label={t('External cold storage')}>
      <h3>{t('External cold storage')}</h3>
      <p className="admin-muted">
        {t(
          'Copy verified cold history to a server-configured S3 destination. Credentials and destination URLs are configured only on the server.',
        )}
      </p>
      <TaskFeedback task={task} />
      {!status || !archivePage ? (
        <EmptyState>{t('Loading cold storage destinations and archives…')}</EmptyState>
      ) : (
        <>
          {!status.configured.length && (
            <EmptyState>
              {t(
                'No external destination is configured. Ask the server administrator to configure COLD_ARCHIVE_S3_CONFIG, then return here.',
              )}
            </EmptyState>
          )}
          <div className="admin-form">
            <Field label={t('Server-configured destination')}>
              <select
                value={name}
                disabled={pending || !status.configured.length}
                onChange={(event) => {
                  setName(event.target.value);
                  setJobId(undefined);
                }}
              >
                <option value="">{t('Choose a destination')}</option>
                {status.configured.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} · {item.bucket}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t('Cold storage operator')}
              hint={t('Declared audit label, up to 100 characters.')}
            >
              <input
                value={operator}
                maxLength={100}
                disabled={pending}
                onChange={(event) => setOperator(event.target.value)}
              />
            </Field>
          </div>
          {configuration && (
            <>
              <dl className="admin-facts">
                <dt>{t('Destination')}</dt>
                <dd>{configuration.name}</dd>
                <dt>{t('Bucket / region')}</dt>
                <dd>
                  {configuration.bucket} · {configuration.region}
                </dd>
                <dt>{t('Destination verification')}</dt>
                <dd>{target?.enabled ? t(target.state) : t('Not enabled')}</dd>
              </dl>
              <p className="admin-muted">
                {t(
                  'Applying the server configuration enables this destination and resets its verification. Verify upload and read-back before creating a copy.',
                )}
              </p>
              <div className="admin-toolbar">
                <AdminButton
                  disabled={pending || !operatorValid}
                  onClick={() =>
                    void task.run(
                      t('Applying cold storage destination'),
                      () =>
                        convex.mutation(configureRef, {
                          adminToken,
                          name: configuration.name,
                          enabled: true,
                          operator: operator.trim(),
                        }),
                      t('Destination enabled. Verify upload and read-back next.'),
                    )
                  }
                >
                  {t('Apply server configuration')}
                </AdminButton>
                <AdminButton
                  disabled={pending || !target?.enabled}
                  onClick={() =>
                    void task.run(
                      t('Verifying destination upload and read-back'),
                      async () => {
                        if (target)
                          await convex.action(verifyRef, { adminToken, destinationId: target._id });
                      },
                      t('Destination upload and read-back verified.'),
                    )
                  }
                >
                  {t('Verify destination')}
                </AdminButton>
                <AdminButton
                  danger
                  disabled={pending || !target?.enabled || !operatorValid}
                  onClick={() =>
                    void task.run(
                      t('Disabling cold storage destination'),
                      () =>
                        convex.mutation(configureRef, {
                          adminToken,
                          name: configuration.name,
                          enabled: false,
                          operator: operator.trim(),
                        }),
                      t(
                        'Destination disabled. Local originals and uploaded remote objects remain.',
                      ),
                    )
                  }
                >
                  {t('Disable destination')}
                </AdminButton>
              </div>
            </>
          )}
          <Field label={t('Verified cold history archive')}>
            <select
              value={archiveId ?? ''}
              disabled={pending || !archivePage.page.length}
              onChange={(event) => {
                setArchiveId(
                  archivePage.page.find((item) => item.archiveId === event.target.value)?.archiveId,
                );
                setJobId(undefined);
              }}
            >
              <option value="">{t('Choose verified cold history')}</option>
              {archivePage.page.map((item) => (
                <option key={item.archiveId} value={item.archiveId}>
                  {t('{kind} · {date} · {count} messages', {
                    kind: t(item.kind),
                    date: formatTime(item.createdAt),
                    count: typeof item.count === 'number' ? item.count : '—',
                  })}
                </option>
              ))}
            </select>
          </Field>
          {!archivePage.page.length && (
            <EmptyState>
              {t(
                'No verified cold history on this page. Create and verify a cold archive from a resident’s conversation or travel memory, or check the next page.',
              )}
            </EmptyState>
          )}
          <div className="admin-toolbar">
            <AdminButton
              disabled={pending || !previous.length}
              onClick={() => {
                changePage(previous[previous.length - 1]);
                setPrevious(previous.slice(0, -1));
              }}
            >
              {t('Previous archives')}
            </AdminButton>
            <AdminButton
              disabled={pending || archivePage.isDone}
              onClick={() => {
                setPrevious([...previous, cursor]);
                changePage(archivePage.continueCursor);
              }}
            >
              {t('Next archives')}
            </AdminButton>
          </div>
          <p className="admin-muted">
            {t(
              'Each click uploads one part and verifies its read-back. The signed archive root is uploaded last. Local originals remain available throughout.',
            )}
          </p>
          <div className="admin-toolbar">
            <AdminButton
              disabled={
                !configuration ||
                !canStartColdMirror(!!archive, target, operator, pending) ||
                jobs.some((item) => item.state === 'RUNNING')
              }
              onClick={() =>
                void task.run(
                  t('Creating external archive copy'),
                  async () => {
                    if (!archive || !target) return;
                    setJobId(
                      await convex.mutation(startRef, {
                        adminToken,
                        archiveId: archive.archiveId,
                        destinationId: target._id,
                        operator: operator.trim(),
                      }),
                    );
                  },
                  t('Copy task created. Upload and verify its next part to continue.'),
                )
              }
            >
              {t('Create external archive copy')}
            </AdminButton>
          </div>
          {!!jobs.length && (
            <Field label={t('External copy task')}>
              <select
                value={job?.jobId ?? ''}
                disabled={pending}
                onChange={(event) =>
                  setJobId(jobs.find((item) => item.jobId === event.target.value)?.jobId)
                }
              >
                {jobs.map((item) => (
                  <option key={item.jobId} value={item.jobId}>
                    {t('{state} · {date}', {
                      state: t(item.state),
                      date: formatTime(item.updatedAt),
                    })}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {job && progress && (
            <>
              <p className="admin-muted" role="status">
                {t('{state} · {verified} / {total} parts verified, including the archive root', {
                  state: t(job.state),
                  verified: progress.verifiedParts,
                  total: progress.totalParts,
                })}
              </p>
              {progress.complete && (
                <p className="admin-success">
                  {t(
                    'External copy complete. Every part and the signed archive root passed read-back verification. Local originals remain.',
                  )}
                </p>
              )}
              {job.error && (
                <p className="admin-error" role="alert">
                  {t(
                    'External copy stopped ({code}). Retry the same checkpoint after resolving the server configuration or connection issue.',
                    { code: job.error },
                  )}
                </p>
              )}
              <div className="admin-toolbar">
                <AdminButton
                  disabled={
                    !configuration ||
                    !canAdvanceColdMirror(job, pending) ||
                    !target?.enabled ||
                    target.state !== 'VERIFIED'
                  }
                  onClick={() =>
                    void task.run(
                      t('Uploading and verifying one archive part'),
                      () => convex.action(advanceRef, { adminToken, jobId: job.jobId }),
                      t('One checkpoint processed. Review the task state before continuing.'),
                    )
                  }
                >
                  {job.state === 'FAILED'
                    ? t('Retry current part')
                    : progress.rootNext
                      ? t('Upload and verify archive root')
                      : t('Upload and verify next part')}
                </AdminButton>
                <AdminButton
                  danger
                  disabled={pending || !canAdvanceColdMirror(job, false)}
                  onClick={() =>
                    void task.run(
                      t('Cancelling external archive copy'),
                      () => convex.mutation(cancelRef, { adminToken, jobId: job.jobId }),
                      t(
                        'Copy cancelled. Local originals and already-uploaded remote objects remain.',
                      ),
                    )
                  }
                >
                  {t('Cancel external copy')}
                </AdminButton>
              </div>
            </>
          )}
          <p className="admin-muted">
            {t(
              'Failed parts can be retried from the saved checkpoint. Cancellation stops future uploads and does not delete already-uploaded remote objects or local originals.',
            )}
          </p>
        </>
      )}
    </section>
  );
}
