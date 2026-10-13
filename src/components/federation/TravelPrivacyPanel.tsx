import { useState } from 'react';
import { useMutation, useQuery, usePaginatedQuery } from 'convex/react';
import { makeFunctionReference, type PaginationOptions, type PaginationResult } from 'convex/server';
import type { Id } from '../../../convex/_generated/dataModel';
import { useLocale } from '../../i18n';
import { AdminButton, Field, TaskFeedback, formatTime, useAdminTask } from './AdminShared';

type HistorySource = { importId: Id<'backupImports'>; worldId: Id<'worlds'>; ownerGlobalId: string };
type HistoryChoice = { history: HistorySource; residentName: string; sourceTownId: string; importedAt: number };
const historyRef = makeFunctionReference<'query',
  { adminToken: string; visitId: string; paginationOpts: PaginationOptions }, PaginationResult<HistoryChoice>
>('federation/travelPrivacy:historicalCandidates');

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
  archiveError?: string;
  archiveCoverage?: {
    ordinaryBundles: 'CHECKING' | 'READY' | 'RUNNING' | 'COMPLETE';
    largeChunks: 'NOT_IMPLEMENTED' | 'CHECKING' | 'READY' | 'RUNNING' | 'COMPLETE';
    orphanObjects: 'NOT_VERIFIED';
  };
};
const inspectRef = makeFunctionReference<
  'mutation',
  { adminToken: string; visitId: string; scope: 'CACHE' | 'SENSITIVE'; history?: HistorySource },
  Id<'travelPrivacyJobs'>
>('federation/travelPrivacy:inspect');
const startRef = makeFunctionReference<
  'mutation',
  { adminToken: string; jobId: Id<'travelPrivacyJobs'> },
  Report
>('federation/travelPrivacy:start');
const retryRef = makeFunctionReference<
  'mutation',
  { adminToken: string; jobId: Id<'travelPrivacyJobs'> },
  Report
>('federation/travelPrivacy:retry');
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
  const [source, setSource] = useState('CURRENT'), [selectedHistory, setSelectedHistory] = useState('');
  const history = usePaginatedQuery(historyRef,
    source === 'IMPORTED' && visitId.trim() ? { adminToken, visitId: visitId.trim() } : 'skip',
    { initialNumItems: 5 });
  const choice = history.results.find(item => JSON.stringify(item.history) === selectedHistory);
  const inspect = useMutation(inspectRef),
    start = useMutation(startRef),
    retry = useMutation(retryRef);
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
          if (source === 'IMPORTED' && !choice) return;
          void task.run(
            'Checking travel privacy scope',
            async () => setJobId(await inspect({ adminToken, visitId: visitId.trim(), scope,
              ...(source === 'IMPORTED' && choice ? { history: choice.history } : {}) })),
            'Travel privacy preview started.',
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
              setSelectedHistory('');
            }}
          />
        </Field>
        <Field label={t('Travel record source')}>
          <select value={source} onChange={event => {
            setSource(event.target.value); setSelectedHistory(''); setJobId(undefined);
          }}>
            <option value="CURRENT">{t('Current local travel ledger')}</option>
            <option value="IMPORTED">{t('Imported backup history')}</option>
          </select>
        </Field>
        {source === 'IMPORTED' && (
          <>
            <Field label={t('Imported resident and archive')}>
              <select required value={selectedHistory} onChange={event => {
                setSelectedHistory(event.target.value); setJobId(undefined);
              }}>
                <option value="">{t('Select imported history')}</option>
                {history.results.map(item => <option key={JSON.stringify(item.history)} value={JSON.stringify(item.history)}>
                  {item.residentName} · {item.sourceTownId} · {formatTime(item.importedAt)}
                </option>)}
              </select>
            </Field>
            <p className="admin-muted">{t('Only safely ended backup history for a resident currently at home is selectable.')}</p>
            {history.status === 'CanLoadMore' && <AdminButton type="button" onClick={() => history.loadMore(5)}>
              {t('Load more import records')}
            </AdminButton>}
            {(history.status === 'LoadingFirstPage' || history.status === 'LoadingMore') && <p role="status">{t('Checking imported travel history…')}</p>}
            {history.status === 'Exhausted' && !history.results.length && <p className="admin-muted">{t('No safely completed imported travel was found.')}</p>}
          </>
        )}
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
          <AdminButton type="submit" disabled={!!task.pending || !visitId.trim() || (source === 'IMPORTED' && !choice)}>
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
          {report.archiveCoverage && (
            <>
              <p>{t('Ordinary backup files')}: {t({ CHECKING: 'Checking archive copies', READY: 'Archive cleanup prepared',
                RUNNING: 'Cleaning archive copies', COMPLETE: 'Archive cleanup complete' }[report.archiveCoverage.ordinaryBundles])}</p>
              <p>{t('Large chunk backup files')}: {t({ NOT_IMPLEMENTED: 'Large chunk archives are not yet covered.',
                CHECKING: 'Checking archive copies', READY: 'Archive cleanup prepared', RUNNING: 'Cleaning archive copies',
                COMPLETE: 'Archive cleanup complete' }[report.archiveCoverage.largeChunks])}</p>
              <p className="admin-muted">{t('Unreferenced storage objects have not been verified; this result does not certify removal of every local copy.')}</p>
            </>
          )}
          {report.archiveError && (
            <p role="alert">{t('Archive cleanup paused. Retry from its saved checkpoint; if validation still fails, inspect the archive before retrying.')}{' '}
              <code>{report.archiveError}</code>
            </p>
          )}
          {!!report.blockers.length && (
            <ul>
              {report.blockers.map((reason) => (
                <li key={reason}>{reason.startsWith('ARCHIVE_')
                  ? <>{t('Archive validation blocked clearing. No deletion has started. Check ownership, shared references and archive integrity before creating a new preview.')}{' '}<code>{reason}</code></>
                  : t(`privacy.${reason}`)}</li>
              ))}
            </ul>
          )}
          {report.state === 'READY' && (
            <AdminButton
              danger={report.scope === 'SENSITIVE'}
              disabled={!!task.pending}
              onClick={() =>
                void task.run(
                  'Clearing selected local travel data',
                  () => start({ adminToken, jobId: report.jobId }),
                  'Selected local travel clearing started.',
                )
              }
            >
              {t('Clear this previewed visit locally')}
            </AdminButton>
          )}
          {['INSPECTING', 'RUNNING'].includes(report.state) && (
            <>
              <p className="admin-muted">{t('Resume from the saved checkpoint if a scheduled step failed.')}</p>
              <AdminButton
                disabled={!!task.pending}
                onClick={() => void task.run(
                  'Retrying travel privacy work',
                  () => retry({ adminToken, jobId: report.jobId }),
                  'Travel privacy checkpoint requeued.',
                )}
              >
                {t('Retry pending travel privacy work')}
              </AdminButton>
            </>
          )}
        </div>
      )}
      <TaskFeedback task={task} />
    </details>
  );
}
