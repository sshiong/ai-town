import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../convex/_generated/dataModel';
import { useLocale } from '../../i18n';
import { AdminButton, Field, TaskFeedback, useAdminTask } from './AdminShared';

type Report = {
  jobId: Id<'travelPrivacyJobs'>;
  visitId: string;
  scope: 'CACHE' | 'SENSITIVE';
  state: string;
  phase: string;
  counts: Record<string, number>;
  blockers: string[];
  externalCopies: number;
  processedRows: number;
};
const inspectRef = makeFunctionReference<
  'mutation',
  { adminToken: string; visitId: string; scope: 'CACHE' | 'SENSITIVE' },
  Id<'travelPrivacyJobs'>
>('federation/travelPrivacy:inspect');
const startRef = makeFunctionReference<
  'mutation',
  { adminToken: string; jobId: Id<'travelPrivacyJobs'> },
  Report
>('federation/travelPrivacy:start');
const statusRef = makeFunctionReference<
  'query',
  { adminToken: string; jobId: Id<'travelPrivacyJobs'> },
  Report | null
>('federation/travelPrivacy:status');
export default function TravelPrivacyPanel({ adminToken }: { adminToken: string }) {
  const { t } = useLocale(),
    task = useAdminTask();
  const [visitId, setVisitId] = useState(''),
    [scope, setScope] = useState<'CACHE' | 'SENSITIVE'>('CACHE');
  const [jobId, setJobId] = useState<Id<'travelPrivacyJobs'>>();
  const inspect = useMutation(inspectRef),
    start = useMutation(startRef);
  const report = useQuery(statusRef, jobId ? { adminToken, jobId } : 'skip');
  return (
    <details className="admin-disclosure">
      <summary>{t('Clear local travel data')}</summary>
      <p className="admin-muted">
        {t(
          'Select one completed visit. Preview checks ownership and shared sources before clearing. Safety records and replay protection remain.',
        )}
      </p>
      <form
        className="admin-form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(
            t('Checking travel privacy scope'),
            async () => setJobId(await inspect({ adminToken, visitId: visitId.trim(), scope })),
            t('Travel privacy preview started.'),
          );
        }}
      >
        <Field label={t('Visit ID')}>
          <input
            required
            value={visitId}
            onChange={(event) => {
              setVisitId(event.target.value);
              setJobId(undefined);
            }}
          />
        </Field>
        <Field label={t('Clear scope')}>
          <select
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as typeof scope);
              setJobId(undefined);
            }}
          >
            <option value="CACHE">{t('Travel runtime caches only')}</option>
            <option value="SENSITIVE">
              {t('Sensitive messages, trip memories and derived copies')}
            </option>
          </select>
        </Field>
        <p className="admin-muted">
          {scope === 'CACHE'
            ? t('Cache clearing preserves long-term trip facts and original memories.')
            : t(
                'Sensitive clearing permanently removes this visit’s original trip memories, exclusive derived reflections, local messages, vectors and dedicated cold archives. Shared conversations or mixed memories block this scope; other visits remain unchanged.',
              )}
        </p>
        {scope === 'SENSITIVE' && (
          <p className="admin-muted">
            {t(
              'All embedding caches in this town will also be cleared because cached context vectors have no visit ownership. Other original memories and their indexed vectors remain; future requests regenerate caches and may incur model costs.',
            )}
          </p>
        )}
        <p className="admin-muted">
          {t(
            'Previously exported files and external archive copies cannot be recalled here. The preview reports known external mirrors. A selection over 1,000 items is blocked without deletion.',
          )}
        </p>
        <div className="admin-form-actions">
          <AdminButton type="submit" disabled={!!task.pending || !visitId.trim()}>
            {t('Preview clear scope')}
          </AdminButton>
        </div>
      </form>
      {report && (
        <div className="admin-card">
          <p>
            {t('State')}: {t(report.state)} · {t('Scope')}:{' '}
            {t(
              report.scope === 'CACHE'
                ? 'Travel runtime caches only'
                : 'Sensitive messages, trip memories and derived copies',
            )}
          </p>
          <p>
            {t('Selected copies')}:{' '}
            {Object.entries(report.counts)
              .map(([key, value]) => `${t(key)}: ${value}`)
              .join(' · ')}
          </p>
          <p>
            {t('Known external mirrors')}: {report.externalCopies} · {t('Cleared rows')}:{' '}
            {report.processedRows}
          </p>
          {!!report.blockers.length && (
            <ul>
              {report.blockers.map((reason) => (
                <li key={reason}>{t(`privacy.${reason}`)}</li>
              ))}
            </ul>
          )}
          {report.state === 'READY' && (
            <AdminButton
              danger={report.scope === 'SENSITIVE'}
              disabled={!!task.pending}
              onClick={() =>
                void task.run(
                  t('Clearing selected local travel data'),
                  () => start({ adminToken, jobId: report.jobId }),
                  t('Selected local travel clearing started.'),
                )
              }
            >
              {t('Clear this previewed visit locally')}
            </AdminButton>
          )}
        </div>
      )}
      <TaskFeedback task={task} />
    </details>
  );
}
