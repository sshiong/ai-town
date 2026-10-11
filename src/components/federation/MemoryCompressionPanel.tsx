import { useLocale } from '../../i18n';
import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import type { GameId } from '../../../convex/aiTown/ids';
import {
  AdminButton,
  EmptyState,
  Field,
  formatTime,
  TaskFeedback,
  useAdminTask,
} from './AdminShared';

type Resident = { worldId: Id<'worlds'>; playerId: GameId<'players'>; agentGlobalId?: string };
type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type Report = {
  jobs: Doc<'memoryCompressionJobs'>[];
  summaries: Page<Doc<'memorySummaryProvenance'>>;
  corrections: Doc<'memorySourceCorrections'>[];
};
type Detail = {
  metadata: Doc<'memorySummaryProvenance'>;
  summary: Doc<'memories'> | null;
  current: boolean;
  sources: Array<{
    reference: Doc<'memoryCompressionJobs'>['sources'][number];
    original: Doc<'memories'>;
    correction: Doc<'memorySourceCorrections'> | null;
    current: boolean;
  }>;
};
const listRef = makeFunctionReference<
  'query',
  { adminToken: string; cursor: string | null },
  Page<Resident>
>('agent/memoryCompression:residents');
const statusRef = makeFunctionReference<
  'query',
  Resident & { adminToken: string; cursor: string | null },
  Report
>('agent/memoryCompression:status');
const detailRef = makeFunctionReference<
  'query',
  { adminToken: string; summaryMemoryId: Id<'memories'> },
  Detail | null
>('agent/memoryCompression:provenance');
const startRef = makeFunctionReference<
  'mutation',
  Resident & { adminToken: string },
  Id<'memoryCompressionJobs'>
>('agent/memoryCompression:start');
const cancelRef = makeFunctionReference<
  'mutation',
  { adminToken: string; jobId: Id<'memoryCompressionJobs'> },
  null
>('agent/memoryCompression:cancel');
const correctRef = makeFunctionReference<
  'mutation',
  Resident & {
    adminToken: string;
    sourceMemoryId: Id<'memories'>;
    expectedPreviousId?: Id<'memorySourceCorrections'>;
    evidenceMemoryIds: Id<'memories'>[];
    text: string;
    operator: string;
  },
  Id<'memorySourceCorrections'>
>('agent/memoryCompression:appendCorrection');

export default function MemoryCompressionPanel({ adminToken }: { adminToken: string }) {
  const { t } = useLocale();
  const task = useAdminTask();
  const [residentCursor, setResidentCursor] = useState<string | null>(null);
  const [owner, setOwner] = useState<Resident>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [summaryMemoryId, setSummaryMemoryId] = useState<Id<'memories'>>();
  const [sourceMemoryId, setSourceMemoryId] = useState<Id<'memories'>>();
  const [text, setText] = useState('');
  const [operator, setOperator] = useState('');
  const residents = useQuery(listRef, { adminToken, cursor: residentCursor });
  const report = useQuery(
    statusRef,
    owner ? { adminToken, worldId: owner.worldId, playerId: owner.playerId, cursor } : 'skip',
  );
  const detail = useQuery(detailRef, summaryMemoryId ? { adminToken, summaryMemoryId } : 'skip');
  const start = useMutation(startRef);
  const cancel = useMutation(cancelRef);
  const correct = useMutation(correctRef);
  const selectedSource = detail?.sources.find((source) => source.original._id === sourceMemoryId);
  return (
    <section aria-label={t('Memory compression and provenance')}>
      <h3>{t('Long-term memory reflections')}</h3>
      <p className="admin-muted">
        {t(
          'Batch reflections retain every original memory. Source IDs, confidence estimates and reported corrections remain traceable. A reflection is subjective; its confidence is a model estimate, never verified fact. Cold archives remain in private Convex storage.',
        )}
      </p>
      <TaskFeedback task={task} />
      <Field label={t('Resident')}>
        <select
          value={owner ? `${owner.worldId}/${owner.playerId}` : ''}
          onChange={(event) => {
            const selected = residents?.page.find(
              (resident) => `${resident.worldId}/${resident.playerId}` === event.target.value,
            );
            setOwner(selected);
            setCursor(null);
            setSummaryMemoryId(undefined);
            setSourceMemoryId(undefined);
          }}
        >
          <option value="">{t('Select a resident')}</option>
          {residents?.page.map((resident) => (
            <option
              key={`${resident.worldId}/${resident.playerId}`}
              value={`${resident.worldId}/${resident.playerId}`}
            >
              {resident.agentGlobalId ?? `${resident.worldId}/${resident.playerId}`}
            </option>
          ))}
        </select>
      </Field>
      <div className="admin-actions">
        {residentCursor && (
          <AdminButton onClick={() => setResidentCursor(null)}>
            {t('First resident page')}
          </AdminButton>
        )}
        {residents && !residents.isDone && (
          <AdminButton onClick={() => setResidentCursor(residents.continueCursor)}>
            {t('Next residents')}
          </AdminButton>
        )}
        <AdminButton
          disabled={!owner || !!task.pending}
          onClick={() =>
            owner &&
            void task.run(
              t('Starting batch reflections'),
              () => start({ adminToken, worldId: owner.worldId, playerId: owner.playerId }),
              t('Batch job started; originals retained.'),
            )
          }
        >
          {t('Start batch reflections')}
        </AdminButton>
      </div>
      {report && (
        <>
          <ul className="admin-list">
            {report.jobs.map((job) => (
              <li key={job._id}>
                <strong>
                  {t(job.kind)} · {t(job.state)}
                </strong>
                <p>
                  {job.sourcesCompleted}
                  {t(' sources · ')}
                  {job.batchesCompleted}
                  {t(' batches · ')}
                  {formatTime(job.updatedAt)}
                  {job.errorCode && ` · ${job.errorCode}`}
                </p>
                {!['DONE', 'CANCELLED', 'FAILED'].includes(job.state) && (
                  <AdminButton
                    disabled={!!task.pending}
                    onClick={() =>
                      void task.run(
                        t('Cancelling memory job'),
                        () => cancel({ adminToken, jobId: job._id }),
                        t('Job cancelled; originals retained.'),
                      )
                    }
                  >
                    {t('Cancel job')}
                  </AdminButton>
                )}
              </li>
            ))}
          </ul>
          {!report.summaries.page.length && (
            <EmptyState>{t('No batch reflection provenance yet.')}</EmptyState>
          )}
          <ul className="admin-list">
            {report.summaries.page.map((summary) => (
              <li key={summary._id}>
                <p>
                  {summary.sources.length}
                  {t(' sources · ')}
                  {formatTime(summary.firstSourceAt)} – {formatTime(summary.lastSourceAt)}
                  {t(' · confidence ')}
                  {summary.confidence === undefined
                    ? t('unknown (model estimate unavailable)')
                    : t('{confidence} (model estimate)', { confidence: summary.confidence })}
                </p>
                <AdminButton
                  onClick={() => {
                    setSummaryMemoryId(summary.summaryMemoryId);
                    setSourceMemoryId(undefined);
                  }}
                >
                  {t('Inspect source evidence')}
                </AdminButton>
              </li>
            ))}
          </ul>
          <div className="admin-actions">
            {cursor && (
              <AdminButton onClick={() => setCursor(null)}>{t('Latest summaries')}</AdminButton>
            )}
            {!report.summaries.isDone && (
              <AdminButton onClick={() => setCursor(report.summaries.continueCursor)}>
                {t('Older summaries')}
              </AdminButton>
            )}
          </div>
        </>
      )}
      {detail && (
        <details className="admin-disclosure" open>
          <summary>
            {t('Subjective reflection · ')}
            {detail.current
              ? t('current sources')
              : t('source corrected or changed; excluded from recall')}
          </summary>
          <p>{detail.summary?.description}</p>
          <ul className="admin-list">
            {detail.sources.map((source) => (
              <li key={source.reference.memoryId}>
                <strong>{source.reference.sourceKey}</strong>
                <p>{source.original.description}</p>
                {source.correction && (
                  <p>
                    {t('Reported correction ({verification}): ', {
                      verification: t(source.correction.verification),
                    })}
                    {source.correction.text}
                  </p>
                )}
                <AdminButton
                  onClick={() => {
                    setSourceMemoryId(source.original._id);
                    setText('');
                  }}
                >
                  {t('Append reported correction')}
                </AdminButton>
              </li>
            ))}
          </ul>
          {selectedSource && owner && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void task.run(
                  t('Appending source correction'),
                  () =>
                    correct({
                      adminToken,
                      worldId: owner.worldId,
                      playerId: owner.playerId,
                      sourceMemoryId: selectedSource.original._id,
                      expectedPreviousId: selectedSource.correction?._id,
                      evidenceMemoryIds: [],
                      text,
                      operator,
                    }),
                  t(
                    'Correction appended. Original text retained; older derived summaries are excluded from recall.',
                  ),
                );
              }}
            >
              <Field
                label={t('Reported correction')}
                hint={t('Appended as an administrator report, not a verified replacement fact.')}
              >
                <textarea
                  required
                  maxLength={4000}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </Field>
              <Field label={t('Operator label')}>
                <input
                  required
                  maxLength={100}
                  value={operator}
                  onChange={(event) => setOperator(event.target.value)}
                />
              </Field>
              <AdminButton
                type="submit"
                disabled={!!task.pending || !text.trim() || !operator.trim()}
              >
                {t('Append correction')}
              </AdminButton>
            </form>
          )}
        </details>
      )}
    </section>
  );
}
