import { useLocale } from '../../i18n';
import { useState } from 'react';
import { useAction } from 'convex/react';
import { makeFunctionReference, type ApiFromModules, type FunctionReturnType } from 'convex/server';
import type * as files from '../../../convex/federation/coldHistoryFiles';
import type { Id } from '../../../convex/_generated/dataModel';
import { AdminButton, Field, TaskFeedback, downloadBundle, useAdminTask } from './AdminShared';
import { ColdHistoryChunkTransfer } from './ColdHistoryChunkTransfer';
type FilesApi = ApiFromModules<{ files: typeof files }>['files'];
const exportRef: FilesApi['exportFile'] = makeFunctionReference(
  'federation/coldHistoryFiles:exportFile',
);
const preflightRef: FilesApi['preflight'] = makeFunctionReference(
  'federation/coldHistoryFiles:preflight',
);
const importRef: FilesApi['importFile'] = makeFunctionReference(
  'federation/coldHistoryFiles:importFile',
);
export function ColdHistoryFileTransfer({
  owner,
  memoryId,
  hasArchive,
  version,
  chunkCount,
}: {
  owner: { adminToken: string; worldId: Id<'worlds'>; playerId: string; agentGlobalId?: string };
  memoryId: Id<'memories'>;
  hasArchive: boolean;
  version?: 1 | 2;
  chunkCount?: number;
}) {
  const { t } = useLocale();
  const args = { ...owner, memoryId },
    exportFile = useAction(exportRef),
    preflight = useAction(preflightRef),
    importFile = useAction(importRef),
    task = useAdminTask();
  const [fileJson, setFileJson] = useState(''),
    [filename, setFilename] = useState(''),
    [fingerprint, setFingerprint] = useState(''),
    [aliases, setAliases] = useState('[]'),
    [fingerprintConfirmed, setFingerprintConfirmed] = useState(false),
    [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [review, setReview] = useState<FunctionReturnType<FilesApi['preflight']>>();
  function changed() {
    setReview(undefined);
    setReviewConfirmed(false);
  }
  function inputArgs() {
    const authorAliases: unknown = JSON.parse(aliases);
    if (!Array.isArray(authorAliases)) throw new Error(t('Author mappings must be a JSON array.'));
    return {
      ...args,
      fileJson,
      expectedFingerprint: fingerprint.trim(),
      authorAliases: authorAliases as Array<{ sourceAuthor: string; targetAuthor: string }>,
    };
  }
  return (
    <>
      <details className="admin-disclosure">
        <summary>{t('Save or restore a single history file')}</summary>
        <p className="admin-muted">
          {t(
            'Keep this signed file alongside your town backup. Restore the resident and matching original messages first, then review the history file here. Imported files preserve source proof and never establish federation trust.',
          )}
        </p>
        {hasArchive && version !== 2 && (
          <AdminButton
            disabled={!!task.pending}
            onClick={() =>
              void task.run(
                t('Exporting signed history'),
                async () =>
                  downloadBundle(await exportFile(args), `ai-town-history-${memoryId}.json`),
                t('Signed history file downloaded.'),
              )
            }
          >
            {t('Download signed history file')}
          </AdminButton>
        )}
        <Field label={t('Signed history file')}>
          <input
            disabled={!!task.pending}
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              changed();
              setFileJson('');
              setFilename('');
              if (!file) return;
              void task.run(
                t('Reading history file'),
                async () => {
                  if (file.size > 2000000) throw new Error(t('History file exceeds 2 MB.'));
                  const text = await file.text();
                  JSON.parse(text);
                  setFileJson(text);
                  setFilename(file.name);
                },
                t('File loaded. Verify its source fingerprint before review.'),
              );
            }}
          />
        </Field>
        {filename && (
          <p className="admin-muted">
            {t('Selected: ')}
            {filename}
          </p>
        )}
        <Field
          label={t('Independently verified source fingerprint')}
          hint={t(
            'Use the fingerprint you verified with the source operator or saved with the original backup, including for an older signing key.',
          )}
        >
          <input
            disabled={!!task.pending}
            value={fingerprint}
            onChange={(event) => {
              setFingerprint(event.target.value);
              setFingerprintConfirmed(false);
              changed();
            }}
          />
        </Field>
        <label className="admin-check">
          <input
            disabled={!!task.pending}
            type="checkbox"
            checked={fingerprintConfirmed}
            onChange={(event) => {
              setFingerprintConfirmed(event.target.checked);
              changed();
            }}
          />
          {t('I verified this fingerprint independently.')}
        </label>
        <Field
          label={t('Explicit author mappings (JSON)')}
          hint={t(
            'For changed author IDs, enter [{"sourceAuthor":"old ID","targetAuthor":"restored ID"}]. Leave [] when IDs are unchanged. Mappings must be one-to-one and match the target original messages.',
          )}
        >
          <textarea
            disabled={!!task.pending}
            value={aliases}
            rows={3}
            onChange={(event) => {
              setAliases(event.target.value);
              changed();
            }}
          />
        </Field>
        <AdminButton
          disabled={!!task.pending || !fileJson || !fingerprint.trim() || !fingerprintConfirmed}
          onClick={() =>
            void task.run(
              t('Reviewing history restore'),
              async () => {
                setReview(await preflight(inputArgs()));
                setReviewConfirmed(false);
              },
              t(
                'Source signature and target originals verified. Review the destination before restoring.',
              ),
            )
          }
        >
          {t('Review history restore')}
        </AdminButton>
        {review && (
          <>
            <p>
              {t('Source town: ')}
              <code>{review.sourceTownId}</code>
            </p>
            <p>
              {t('Source: ')}
              <code>{review.sourceId}</code>
              {t(' · target: ')}
              <code>{review.targetSourceId}</code>
            </p>
            <p>
              {review.messages}
              {t(' messages · ')}
              {review.bytes}
              {t(' bytes · original source times retained')}
            </p>
            <p className="admin-muted">
              {t('Target memory: ')}
              <code>{review.targetMemoryId}</code>
            </p>
            <pre className="admin-report">{JSON.stringify(review.authorAliases, null, 2)}</pre>
            <label className="admin-check">
              <input
                type="checkbox"
                disabled={!!task.pending}
                checked={reviewConfirmed}
                onChange={(event) => setReviewConfirmed(event.target.checked)}
              />
              {t('I reviewed this destination and its author mappings.')}
            </label>
            <AdminButton
              disabled={!!task.pending || !reviewConfirmed || !fingerprintConfirmed}
              onClick={() =>
                void task.run(
                  t('Restoring private history file'),
                  async () => {
                    await importFile({ ...inputArgs(), confirmation: review.confirmation });
                    changed();
                  },
                  t(
                    'History file restored and verified. Hot data, model bindings and neighbor trust retained.',
                  ),
                )
              }
            >
              {t('Restore this verified history file')}
            </AdminButton>
          </>
        )}
        <TaskFeedback task={task} />
      </details>
      <ColdHistoryChunkTransfer
        owner={args}
        chunkCount={hasArchive && version === 2 ? chunkCount : undefined}
      />
    </>
  );
}
