import { useLocale } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { makeFunctionReference, type ApiFromModules } from 'convex/server';
import type * as chunks from '../../../convex/federation/coldHistoryChunks';
import type { Id } from '../../../convex/_generated/dataModel';
import type { ColdHistoryOwner } from './ColdHistoryJob';
import { AdminButton, Field, TaskFeedback, downloadBundle, useAdminTask } from './AdminShared';
import {
  readArchiveJson,
  selectArchiveDirectory,
  supportsArchiveDirectory,
  writeArchivePart,
} from './archiveFiles';

type ChunkApi = ApiFromModules<{ chunks: typeof chunks }>['chunks'];
const headerRef: ChunkApi['exportHeader'] = makeFunctionReference(
  'federation/coldHistoryChunks:exportHeader',
);
const partRef: ChunkApi['exportPart'] = makeFunctionReference(
  'federation/coldHistoryChunks:exportPart',
);
const startRef: ChunkApi['startImport'] = makeFunctionReference(
  'federation/coldHistoryChunks:startImport',
);
const acceptRef: ChunkApi['acceptPart'] = makeFunctionReference(
  'federation/coldHistoryChunks:acceptPart',
);

export function ColdHistoryChunkTransfer({
  owner,
  chunkCount,
}: {
  owner: ColdHistoryOwner;
  chunkCount?: number;
}) {
  const { t } = useLocale();
  const convex = useConvex(),
    task = useAdminTask();
  const [partIndex, setPartIndex] = useState(0),
    [rootJson, setRootJson] = useState('');
  const [rootSummary, setRootSummary] = useState<{
    sourceTownId: string;
    count: number;
    chunkCount: number;
  }>();
  const [fingerprint, setFingerprint] = useState(''),
    [aliases, setAliases] = useState('[]');
  const [confirmed, setConfirmed] = useState(false),
    [files, setFiles] = useState<File[]>([]);
  const [jobId, setJobId] = useState<Id<'coldHistoryJobs'>>();
  const [progress, setProgress] = useState(''),
    [transferring, setTransferring] = useState(false);
  const pauseRequested = useRef(false);
  useEffect(
    () => () => {
      pauseRequested.current = true;
    },
    [],
  );
  const stem = `ai-town-history-${owner.memoryId}`;
  const partName = (index: number) => `${stem}-part-${String(index).padStart(6, '0')}.json`;
  function changed() {
    setConfirmed(false);
    setJobId(undefined);
  }
  async function transfer(work: () => Promise<void>) {
    pauseRequested.current = false;
    setTransferring(true);
    try {
      await work();
    } finally {
      setTransferring(false);
    }
  }
  return (
    <details className="admin-disclosure">
      <summary>{t('Save or restore multipart history')}</summary>
      <p className="admin-muted">
        {t(
          'Large histories use a signed manifest and separate signed parts. Keep every part with its manifest. Restore matching original messages first. Files contain private text; store them privately. A history file does not establish neighbor trust.',
        )}
      </p>
      {chunkCount !== undefined && (
        <>
          <p>
            {chunkCount}
            {t(' verified archive parts')}
          </p>
          <div className="admin-toolbar">
            <AdminButton
              disabled={!!task.pending}
              onClick={() =>
                void task.run(
                  t('Downloading history manifest'),
                  async () => {
                    downloadBundle(await convex.action(headerRef, owner), `${stem}-manifest.json`);
                  },
                  t('Manifest downloaded. Save all accompanying parts.'),
                )
              }
            >
              {t('Download manifest')}
            </AdminButton>
            {supportsArchiveDirectory() && (
              <AdminButton
                disabled={!!task.pending}
                onClick={() =>
                  void task.run(
                    t('Saving history folder'),
                    () =>
                      transfer(async () => {
                        const directory = await selectArchiveDirectory();
                        await writeArchivePart(
                          directory,
                          `${stem}-manifest.json`,
                          await convex.action(headerRef, owner),
                        );
                        for (
                          let index = 0;
                          index < chunkCount && !pauseRequested.current;
                          index++
                        ) {
                          await writeArchivePart(
                            directory,
                            partName(index),
                            await convex.action(partRef, { ...owner, index }),
                          );
                          setProgress(
                            t('Saved {index} / {count} parts', {
                              index: index + 1,
                              count: chunkCount,
                            }),
                          );
                        }
                      }),
                    t('Folder write stopped. Check the part count before moving this archive.'),
                  )
                }
              >
                {t('Save manifest and parts to folder')}
              </AdminButton>
            )}
          </div>
          <Field label={t('Part index (starts at zero)')}>
            <input
              type="number"
              min={0}
              max={Math.max(0, chunkCount - 1)}
              step={1}
              value={partIndex}
              disabled={!!task.pending}
              onChange={(event) => setPartIndex(Number(event.target.value))}
            />
          </Field>
          <AdminButton
            disabled={
              !!task.pending ||
              !Number.isSafeInteger(partIndex) ||
              partIndex < 0 ||
              partIndex >= chunkCount
            }
            onClick={() =>
              void task.run(
                t('Downloading history part'),
                async () => {
                  downloadBundle(
                    await convex.action(partRef, { ...owner, index: partIndex }),
                    partName(partIndex),
                  );
                },
                t('Signed history part downloaded.'),
              )
            }
          >
            {t('Download selected part')}
          </AdminButton>
        </>
      )}
      <Field label={t('Signed multipart manifest')}>
        <input
          type="file"
          accept="application/json,.json"
          disabled={!!task.pending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            changed();
            setRootJson('');
            setRootSummary(undefined);
            if (file)
              void task.run(
                t('Reading history manifest'),
                async () => {
                  const value = (await readArchiveJson(file, 20000)) as {
                    format?: unknown;
                    version?: unknown;
                    manifest?: { sourceTownId?: unknown; count?: unknown; chunkCount?: unknown };
                  };
                  if (value.format !== 'ai-town-cold-history-manifest' || value.version !== 2)
                    throw new Error(
                      t(
                        'Choose a multipart history manifest, not a data part or single-file archive.',
                      ),
                    );
                  const manifest = value.manifest;
                  if (
                    !manifest ||
                    typeof manifest.sourceTownId !== 'string' ||
                    manifest.sourceTownId.length > 200 ||
                    typeof manifest.count !== 'number' ||
                    !Number.isSafeInteger(manifest.count) ||
                    manifest.count < 1 ||
                    typeof manifest.chunkCount !== 'number' ||
                    !Number.isSafeInteger(manifest.chunkCount) ||
                    manifest.chunkCount < 1
                  )
                    throw new Error(
                      t(
                        'The manifest must describe a source town and positive message and part counts.',
                      ),
                    );
                  setRootSummary({
                    sourceTownId: manifest.sourceTownId,
                    count: manifest.count,
                    chunkCount: manifest.chunkCount,
                  });
                  setRootJson(JSON.stringify(value));
                },
                t('Manifest loaded; its signature will be verified by the backend.'),
              );
          }}
        />
      </Field>
      {rootSummary && (
        <p className="admin-muted">
          {t('Supplied manifest: ')}
          {rootSummary.sourceTownId} · {rootSummary.count}
          {t(' messages · ')}
          {rootSummary.chunkCount}
          {t(' required parts.')}{' '}
          {t('Backend signature verification is required before these details are trusted.')}
        </p>
      )}
      <Field label={t('Independently verified source fingerprint')}>
        <input
          value={fingerprint}
          disabled={!!task.pending}
          onChange={(event) => {
            setFingerprint(event.target.value);
            changed();
          }}
        />
      </Field>
      <Field
        label={t('Explicit author mappings (JSON)')}
        hint={t(
          'Use one-to-one sourceAuthor / targetAuthor mappings only where restored IDs differ. Leave [] when IDs match.',
        )}
      >
        <textarea
          rows={3}
          value={aliases}
          disabled={!!task.pending}
          onChange={(event) => {
            setAliases(event.target.value);
            changed();
          }}
        />
      </Field>
      <p className="admin-muted">
        {t('Destination resident: ')}
        {owner.playerId}
        {t(' · memory: ')}
        {owner.memoryId}
      </p>
      <label className="admin-check">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={!!task.pending}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {t(
          'I independently verified this fingerprint and reviewed this destination and author mappings.',
        )}
      </label>
      <AdminButton
        disabled={!!task.pending || !rootJson || !fingerprint.trim() || !confirmed}
        onClick={() =>
          void task.run(
            t('Starting staged history restore'),
            async () => {
              const authorAliases: unknown = JSON.parse(aliases);
              if (!Array.isArray(authorAliases))
                throw new Error(t('Author mappings must be a JSON array.'));
              const next = await convex.mutation(startRef, {
                ...owner,
                rootJson,
                expectedFingerprint: fingerprint.trim(),
                authorAliases: authorAliases as { sourceAuthor: string; targetAuthor: string }[],
              });
              if ('jobId' in next) setJobId(next.jobId);
              else setProgress(t('This history is already verified at the destination.'));
            },
            t(
              'Manifest checked. Upload every part, then continue verification in the history task above.',
            ),
          )
        }
      >
        {t('Start or reopen staged restore')}
      </AdminButton>
      <p className="admin-muted">
        {t(
          'Starting requires disabled federation, a stopped engine, and no active visits. The task holds a maintenance lock until completion or cancellation. No cold index is published until all signatures, part continuity, and matching target originals are verified.',
        )}
      </p>
      <Field label={t('Signed history parts')}>
        <input
          type="file"
          multiple
          accept="application/json,.json"
          disabled={!!task.pending}
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />
      </Field>
      <AdminButton
        disabled={!!task.pending || !jobId || !files.length}
        onClick={() =>
          void task.run(
            t('Uploading history parts'),
            () =>
              transfer(async () => {
                const selected = new Map<number, File>();
                for (const file of files) {
                  if (pauseRequested.current) return;
                  const value = (await readArchiveJson(file, 900000)) as {
                    format?: unknown;
                    descriptor?: { index?: unknown };
                  };
                  const index = value.descriptor?.index;
                  if (
                    value.format !== 'ai-town-cold-history-part' ||
                    typeof index !== 'number' ||
                    !Number.isSafeInteger(index) ||
                    index < 0
                  )
                    throw new Error(
                      t('Every selected file must be a signed multipart history part.'),
                    );
                  if (selected.has(index))
                    throw new Error(t('Two selected files use part index {index}.', { index }));
                  selected.set(index, file);
                }
                for (const [index, file] of [...selected.entries()].sort(([a], [b]) => a - b)) {
                  if (pauseRequested.current) break;
                  await convex.action(acceptRef, {
                    ...owner,
                    jobId: jobId!,
                    fileJson: await file.text(),
                  });
                  setProgress(
                    t('Part {index} accepted; {count} files selected', {
                      index,
                      count: selected.size,
                    }),
                  );
                }
              }),
            t('Upload stopped. Continue target verification after every part has been accepted.'),
          )
        }
      >
        {t('Upload selected parts in order')}
      </AdminButton>
      <AdminButton
        disabled={!transferring}
        onClick={() => {
          pauseRequested.current = true;
        }}
      >
        {t('Pause transfer after this part')}
      </AdminButton>
      <p className="admin-muted">
        {t(
          'After refresh, select the same manifest and reopen its restore task. Re-uploading accepted parts is safe.',
        )}
      </p>
      {progress && <p role="status">{progress}</p>}
      <TaskFeedback task={task} />
    </details>
  );
}
