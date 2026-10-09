import { useEffect, useRef, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { FunctionReturnType } from 'convex/server';
import {
  AdminButton,
  EmptyState,
  Field,
  TaskFeedback,
  downloadJsonText,
  useAdminTask,
  formatTime,
} from './AdminShared';
import {
  readArchiveJson,
  selectArchiveDirectory,
  supportsArchiveDirectory,
  writeArchivePart,
  writeArchiveText,
} from './archiveFiles';

type ArchiveManifest = FunctionReturnType<typeof api.federation.backupLarge.getManifest>;
export default function ArchivePanel({ adminToken }: { adminToken: string }) {
  const convex = useConvex();
  const task = useAdminTask();
  const jobs = useQuery(api.federation.backupLarge.listJobs, { adminToken });
  const status = useQuery(api.federation.admin.status, { adminToken });
  const world = useQuery(api.world.defaultWorldStatus);
  const [jobId, setJobId] = useState<Id<'backupLargeJobs'>>();
  const job = useQuery(api.federation.backupLarge.status, jobId ? { adminToken, jobId } : 'skip');
  const [manifest, setManifest] = useState<ArchiveManifest>();
  const [manifestName, setManifestName] = useState('');
  const [mode, setMode] = useState<'restore' | 'migrate' | 'clone'>('restore');
  const [endpoint, setEndpoint] = useState('');
  const [sourceStopped, setSourceStopped] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<string>();
  const [chunkIndex, setChunkIndex] = useState(0);
  const pauseRequested = useRef(false);
  const [advancing, setAdvancing] = useState(false);
  useEffect(
    () => () => {
      pauseRequested.current = true;
    },
    [],
  );
  const maintenanceReady =
    status !== undefined &&
    world !== undefined &&
    !status.settings.enabled &&
    (!world || world.status !== 'running');
  async function advance(kind: 'export' | 'import') {
    if (!jobId) return;
    pauseRequested.current = false;
    setAdvancing(true);
    try {
      while (!pauseRequested.current) {
        const next =
          kind === 'export'
            ? await convex.action(api.federation.backupLarge.advanceExport, { adminToken, jobId })
            : await convex.action(api.federation.backupLarge.advanceImport, { adminToken, jobId });
        setProgress(`${next.state} · ${next.phase} · ${next.processedChunks} chunks processed`);
        if (['COMPLETE', 'READY', 'FAILED', 'CANCELLED', 'STAGING'].includes(next.state)) break;
      }
    } finally {
      setAdvancing(false);
    }
  }
  return (
    <section aria-label="Chunked town archives">
      <h3>Chunked archives for large towns</h3>
      <p className="admin-muted">
        Exports and imports run one bounded batch at a time with persistent checkpoints. The
        manifest and data chunks stay separate from the encrypted identity package. Disable
        federation admission and pause the target before starting maintenance.
      </p>
      <TaskFeedback task={task} />
      {progress && (
        <p role="status" className="admin-muted">
          {progress}
        </p>
      )}
      {!maintenanceReady && (
        <p className="admin-warning">
          Close federation visits in Federation, finish active visits and pause the simulation
          before creating an archive or import task.
        </p>
      )}
      <div className="admin-toolbar">
        <AdminButton
          disabled={!!task.pending || !maintenanceReady || !status?.identity}
          onClick={() =>
            void task.run(
              'Starting consistent town snapshot',
              async () => {
                const created = await convex.mutation(api.federation.backupLarge.startExport, {
                  adminToken,
                });
                setJobId(created.jobId);
                setProgress(undefined);
              },
              'Snapshot task created. Continue export to build its signed manifest and chunks.',
            )
          }
        >
          Create chunked snapshot
        </AdminButton>
      </div>
      <Field label="Archive task">
        <select
          value={jobId ?? ''}
          disabled={!!task.pending}
          onChange={(event) => {
            const selected = jobs?.find((item) => item.jobId === event.target.value);
            setJobId(selected?.jobId);
            setReviewed(false);
            setProgress(undefined);
          }}
        >
          <option value="">Select a task</option>
          {jobs?.map((item) => (
            <option key={item.jobId} value={item.jobId}>
              {item.kind} · {item.state} · {item.jobId}
            </option>
          ))}
        </select>
      </Field>
      {jobs?.length === 0 && (
        <EmptyState>
          No archive tasks. Create a snapshot or load an archive manifest below.
        </EmptyState>
      )}
      {job && (
        <>
          <dl className="admin-facts">
            <dt>Task</dt>
            <dd>
              <code>{job.jobId}</code>
            </dd>
            <dt>Source town</dt>
            <dd>
              <code>{job.sourceTownId}</code>
              <code>{job.sourceFingerprint}</code>
            </dd>
            <dt>Last checkpoint</dt>
            <dd>{formatTime(job.updatedAt)}</dd>
            <dt>Import mode</dt>
            <dd>{job.mode ?? '—'}</dd>
            <dt>State / phase</dt>
            <dd>
              {job.state} · {job.phase}
            </dd>
            <dt>Current table</dt>
            <dd>{job.table ?? '—'}</dd>
            <dt>Chunks</dt>
            <dd>
              {job.processedChunks} processed · {job.chunkCount} expected
              {job.kind === 'import' ? ` · ${job.uploadedChunks} uploaded` : ''}
            </dd>
            <dt>Records</dt>
            <dd>{job.recordCount}</dd>
          </dl>
          {job.error && (
            <p className="admin-error" role="alert">
              {job.error}
            </p>
          )}
          <div className="admin-toolbar">
            <AdminButton
              disabled={
                !!task.pending || ['COMPLETE', 'READY', 'FAILED', 'CANCELLED'].includes(job.state)
              }
              onClick={() =>
                void task.run(
                  `Continuing ${job.kind} batches`,
                  () => advance(job.kind),
                  'Batch processing stopped at its next checkpoint. Review the actual task state.',
                )
              }
            >
              Continue {job.kind}
            </AdminButton>
            {advancing && (
              <AdminButton
                onClick={() => {
                  pauseRequested.current = true;
                }}
              >
                Pause after current batch
              </AdminButton>
            )}
            <AdminButton
              disabled={!!task.pending || !job.canResume}
              onClick={() =>
                void task.run(
                  'Resuming failed checkpoint',
                  async () => {
                    await convex.mutation(api.federation.backupLarge.resume, {
                      adminToken,
                      jobId: job.jobId,
                    });
                  },
                  'Checkpoint restored. Continue the task; committed rows are not duplicated.',
                )
              }
            >
              Retry checkpoint
            </AdminButton>
            <AdminButton
              danger
              disabled={
                !!task.pending || ['COMPLETE', 'CANCELLED', 'ROLLING_BACK'].includes(job.state)
              }
              onClick={() =>
                void task.run(
                  'Cancelling archive task',
                  async () => {
                    await convex.mutation(api.federation.backupLarge.cancel, {
                      adminToken,
                      jobId: job.jobId,
                    });
                  },
                  job.kind === 'import'
                    ? 'Rollback requested. Continue import batches until CANCELLED before resuming the target.'
                    : 'Export cancelled. The server released its maintenance checkpoint.',
                )
              }
            >
              {job.kind === 'import' ? 'Cancel / roll back import' : 'Cancel export'}
            </AdminButton>
          </div>
          {job.kind === 'import' && job.state === 'READY' && (
            <>
              <p className="admin-warning">
                All staged parts passed server preflight. Restore and migration replace the target
                town; cloning creates a new town on an empty target. The server keeps a rollback
                checkpoint; leave the target paused until completion or completed rollback.
              </p>
              <label className="admin-check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={!!task.pending}
                  onChange={(event) => setReviewed(event.target.checked)}
                />{' '}
                I reviewed the archive source, import mode and replacement scope.
              </label>
              <AdminButton
                danger
                disabled={!!task.pending || !reviewed || !maintenanceReady}
                onClick={() =>
                  void task.run(
                    'Committing staged import',
                    async () => {
                      await convex.mutation(api.federation.backupLarge.startApply, {
                        adminToken,
                        jobId: job.jobId,
                      });
                      setReviewed(false);
                    },
                    'Apply started. Continue import batches through repair, commit and cleanup; only COMPLETE confirms success.',
                  )
                }
              >
                Apply validated archive
              </AdminButton>
            </>
          )}
          {job.kind === 'export' && job.state === 'COMPLETE' && (
            <>
              <div className="admin-toolbar">
                <AdminButton
                  disabled={!!task.pending}
                  onClick={() =>
                    void task.run(
                      'Downloading signed manifest',
                      async () =>
                        downloadJsonText(
                          JSON.stringify(
                            await convex.action(api.federation.backupLarge.getManifest, {
                              adminToken,
                              jobId: job.jobId,
                            }),
                          ),
                          `ai-town-manifest-${job.jobId}.json`,
                        ),
                      'Signed manifest downloaded; also save every referenced chunk.',
                    )
                  }
                >
                  Download manifest
                </AdminButton>
                <AdminButton
                  disabled={!!task.pending || !supportsArchiveDirectory()}
                  onClick={() => {
                    void selectArchiveDirectory()
                      .then((directory) =>
                        task.run(
                          'Saving archive folder',
                          async () => {
                            const header = await convex.action(
                              api.federation.backupLarge.getManifest,
                              { adminToken, jobId: job.jobId },
                            );
                            await writeArchivePart(directory, 'manifest.json', header);
                            for (let index = 0; index < job.chunkCount; index++) {
                              setProgress(`Saving chunk ${index + 1} / ${job.chunkCount}`);
                              await writeArchiveText(
                                directory,
                                `chunk-${String(index).padStart(6, '0')}.json`,
                                await convex.action(api.federation.backupLarge.getChunk, {
                                  adminToken,
                                  jobId: job.jobId,
                                  index,
                                }),
                              );
                            }
                          },
                          'Manifest and every referenced chunk saved to the selected folder.',
                        ),
                      )
                      .catch((error) =>
                        task.run('Selecting archive folder', () => Promise.reject(error)),
                      );
                  }}
                >
                  Save entire archive to folder
                </AdminButton>
              </div>
              <p className="admin-muted">
                Folder saving writes one chunk at a time without loading the whole town into browser
                memory. Where folder access is unavailable, download each chunk separately.
              </p>
              <div className="admin-inline-form">
                <Field label="Chunk index">
                  <input
                    type="number"
                    min={0}
                    max={Math.max(0, job.chunkCount - 1)}
                    value={chunkIndex}
                    onChange={(event) => setChunkIndex(Number(event.target.value))}
                  />
                </Field>
                <AdminButton
                  disabled={
                    !!task.pending ||
                    chunkIndex < 0 ||
                    chunkIndex >= job.chunkCount ||
                    !Number.isSafeInteger(chunkIndex)
                  }
                  onClick={() =>
                    void task.run(
                      'Downloading archive chunk',
                      async () =>
                        downloadJsonText(
                          await convex.action(api.federation.backupLarge.getChunk, {
                            adminToken,
                            jobId: job.jobId,
                            index: chunkIndex,
                          }),
                          `chunk-${String(chunkIndex).padStart(6, '0')}.json`,
                        ),
                      'Chunk downloaded. Preserve its filename and signed manifest.',
                    )
                  }
                >
                  Download selected chunk
                </AdminButton>
              </div>
            </>
          )}
        </>
      )}
      <details className="admin-disclosure">
        <summary>Stage a chunked archive for import</summary>
        <Field
          label="Signed archive manifest"
          hint="Choose the signed manifest JSON, up to 5 MB. Keep every referenced chunk alongside it."
        >
          <input
            type="file"
            accept=".json,application/json"
            disabled={!!task.pending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              setManifest(undefined);
              setManifestName('');
              setSourceStopped(false);
              setReviewed(false);
              if (!file) return;
              void task.run(
                'Reading signed manifest',
                async () => {
                  const value = (await readArchiveJson(file, 5_000_000)) as ArchiveManifest;
                  if (
                    !value.manifest ||
                    !Array.isArray(value.manifest.chunks) ||
                    typeof value.signature !== 'string'
                  )
                    throw new Error(
                      'Choose the signed manifest file, not an individual data chunk.',
                    );
                  setManifest(value);
                  setManifestName(file.name);
                },
                'Manifest loaded but unverified. The server verifies its signature and archive structure when creating the import task.',
              );
            }}
          />
        </Field>
        <div className="admin-form">
          <Field label="Chunked import mode">
            <select
              value={mode}
              disabled={!!task.pending}
              onChange={(event) => {
                setMode(event.target.value as typeof mode);
                setSourceStopped(false);
                setReviewed(false);
              }}
            >
              <option value="restore">Restore this town</option>
              <option value="migrate">Migrate this town</option>
              <option value="clone">Create a new town</option>
            </select>
          </Field>
          {mode === 'clone' && (
            <Field label="New deployment HTTPS endpoint">
              <input
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
              />
            </Field>
          )}
        </div>
        {mode !== 'clone' && (
          <label className="admin-check">
            <input
              type="checkbox"
              checked={sourceStopped}
              disabled={!!task.pending}
              onChange={(event) => setSourceStopped(event.target.checked)}
            />{' '}
            The source deployment is stopped and cannot issue or renew visit authorizations.
          </label>
        )}
        {manifestName && (
          <p className="admin-muted">
            Manifest: {manifestName} · {manifest?.manifest.chunks.length} declared chunks · source
            declarations remain unverified until server validation.
          </p>
        )}
        <div className="admin-toolbar">
          <AdminButton
            disabled={
              !!task.pending ||
              !manifest ||
              !maintenanceReady ||
              (mode !== 'clone' && !sourceStopped) ||
              (mode === 'clone' &&
                (!endpoint.trim() || status?.identity !== null || world !== null)) ||
              (mode !== 'clone' && !status?.identity)
            }
            onClick={() =>
              void task.run(
                'Creating verified staging task',
                async () => {
                  if (!manifest) return;
                  const created = await convex.action(api.federation.backupLarge.createImport, {
                    adminToken,
                    manifest: manifest.manifest,
                    signature: manifest.signature,
                    mode,
                    sourceStopped,
                    targetEndpoint: mode === 'clone' ? endpoint.trim() : undefined,
                  });
                  setJobId(created.jobId);
                  setReviewed(false);
                },
                'Import staging task created. Upload every chunk, then continue server preflight before applying.',
              )
            }
          >
            Create staging task
          </AdminButton>
        </div>
        <Field
          label="Archive data chunks"
          hint="Select chunk JSON files only, up to 1 MiB each. Parts are read and staged one at a time; the server verifies each digest against the signed manifest."
        >
          <input
            type="file"
            accept=".json,application/json"
            multiple
            disabled={!!task.pending}
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
        </Field>
        <div className="admin-toolbar">
          <AdminButton
            disabled={
              !!task.pending ||
              !files.length ||
              !jobId ||
              job?.kind !== 'import' ||
              job.state !== 'STAGING'
            }
            onClick={() =>
              void task.run(
                'Staging archive chunks',
                async () => {
                  if (!jobId) return;
                  for (let index = 0; index < files.length; index++) {
                    setProgress(`Staging ${index + 1} / ${files.length}: ${files[index].name}`);
                    const chunk = await readArchiveJson(files[index], 1024 * 1024);
                    await convex.action(api.federation.backupLarge.stageChunk, {
                      adminToken,
                      jobId,
                      chunk: JSON.stringify(chunk),
                    });
                  }
                  setFiles([]);
                },
                'Selected chunks staged. Reuploading an identical part is idempotent; continue import to run complete preflight.',
              )
            }
          >
            Stage selected chunks
          </AdminButton>
        </div>
      </details>
    </section>
  );
}
