import { useLocale } from '../../i18n';
import { useEffect, useRef, useState, type Ref } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { LargeChunk } from '../../../convex/federation/backupLargeHelpers';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import {
  encryptBackupText,
  readBackupText,
  validBackupPassphrase,
  type BackupFilePurpose,
} from './backupEncryption';
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
  loadLargeArchiveManifest,
  archivePrivacyPageNumber,
  confirmedLargeArchiveSigner,
  selectArchiveDirectory,
  supportsArchiveDirectory,
  writeArchiveText,
  type LoadedLargeArchiveManifest,
} from './archiveFiles';
import { VectorExportOption } from './EmbeddingPanel';
import ColdArchivePanel from './ColdArchivePanel';

const getPrivacyChunk = makeFunctionReference<
  'action',
  {
    adminToken: string;
    jobId: Id<'backupLargeJobs'>;
    pageNumber: number;
  },
  LargeChunk
>('federation/backupPrivacyChunks:getChunk');
const stagePrivacyChunk = makeFunctionReference<
  'action',
  {
    adminToken: string;
    jobId: Id<'backupLargeJobs'>;
    pageNumber: number;
    chunk: string;
  },
  void
>('federation/backupPrivacyChunks:stageChunk');

export default function ArchivePanel({ adminToken, headingRef }: {
  adminToken: string;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const { t } = useLocale();
  const convex = useConvex();
  const task = useAdminTask();
  const jobs = useQuery(api.federation.backupLarge.listJobs, { adminToken });
  const status = useQuery(api.federation.admin.status, { adminToken });
  const world = useQuery(api.world.defaultWorldStatus);
  const [jobId, setJobId] = useState<Id<'backupLargeJobs'>>();
  const job = useQuery(api.federation.backupLarge.status, jobId ? { adminToken, jobId } : 'skip');
  const [manifest, setManifest] = useState<LoadedLargeArchiveManifest>();
  const [expectedLocalProofFingerprint, setExpectedLocalProofFingerprint] = useState('');
  const [manifestName, setManifestName] = useState('');
  const [mode, setMode] = useState<'restore' | 'migrate' | 'clone'>('restore');
  const [endpoint, setEndpoint] = useState('');
  const [sourceStopped, setSourceStopped] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [privacyFiles, setPrivacyFiles] = useState<File[]>([]);
  const [privacyPageNumber, setPrivacyPageNumber] = useState(0);
  const [progress, setProgress] = useState<string>();
  const [chunkIndex, setChunkIndex] = useState(0);
  const pauseRequested = useRef(false);
  const [advancing, setAdvancing] = useState(false);
  const [encryptDownloads, setEncryptDownloads] = useState(false);
  const [includeVectors, setIncludeVectors] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportConfirmation, setExportConfirmation] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [operator, setOperator] = useState('');
  const [exportReason, setExportReason] = useState('');
  const [manifestFile, setManifestFile] = useState<File>();
  const canDownload =
    !encryptDownloads ||
    (validBackupPassphrase(exportPassphrase) && exportPassphrase === exportConfirmation);
  function takeExportPassphrase() {
    if (!encryptDownloads) return undefined;
    if (!canDownload) throw new Error(t('Enter and confirm a strong archive passphrase.'));
    const secret = exportPassphrase;
    setExportPassphrase('');
    setExportConfirmation('');
    return secret;
  }
  async function protectedPart(text: string, purpose: BackupFilePurpose, secret?: string) {
    return secret === undefined
      ? text
      : encryptBackupText(text, secret, purpose, purpose === 'manifest' ? 5_000_000 : 1024 * 1024);
  }
  async function loadManifest(file: File) {
    setExpectedLocalProofFingerprint('');
    const secret = importPassphrase;
    setImportPassphrase('');
    const value: unknown = JSON.parse(
      await readBackupText(file, 5_000_000, 'manifest', secret),
    );
    try {
      setManifest(await loadLargeArchiveManifest(value));
    } catch (error) {
      throw new Error(t(error instanceof Error ? error.message : 'The archive manifest metadata is invalid.'));
    }
    setManifestName(file.name);
    setManifestFile(undefined);
  }
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
        setProgress(
          t('{state} · {phase} · current phase progress: {count}', {
            state: t(next.state),
            phase: t(next.phase),
            count: next.processedChunks,
          }),
        );
        if (['COMPLETE', 'READY', 'FAILED', 'CANCELLED', 'STAGING'].includes(next.state)) break;
      }
    } finally {
      setAdvancing(false);
    }
  }
  return (
    <section aria-label={t('Chunked town archives')}>
      <h3 ref={headingRef} tabIndex={-1}>
        {t('Chunked archives for large towns')}
      </h3>
      <p className="admin-muted">
        {t(
          'Exports and imports run one bounded batch at a time with persistent checkpoints. The manifest and data chunks stay separate from the encrypted identity package. Disable federation admission and pause the target before starting maintenance.',
        )}
      </p>
      <TaskFeedback task={task} />
      <VectorExportOption
        checked={includeVectors}
        onChange={setIncludeVectors}
        disabled={!!task.pending || advancing}
      />
      <div className="admin-form">
        <Field
          label={t('Export operator')}
          hint={t('A declared label for the audit; access uses the shared administrator token.')}
        >
          <input
            value={operator}
            maxLength={200}
            disabled={!!task.pending}
            onChange={(event) => setOperator(event.target.value)}
          />
        </Field>
        <Field label={t('Export reason')}>
          <input
            value={exportReason}
            maxLength={1000}
            disabled={!!task.pending}
            onChange={(event) => setExportReason(event.target.value)}
          />
        </Field>
      </div>
      <label className="admin-check">
        <input
          type="checkbox"
          checked={encryptDownloads}
          disabled={!!task.pending}
          onChange={(event) => {
            setEncryptDownloads(event.target.checked);
            setExportPassphrase('');
            setExportConfirmation('');
          }}
        />{' '}
        {t('Encrypt downloaded manifest and each chunk in this browser')}
      </label>
      {encryptDownloads && (
        <div className="admin-form">
          <Field
            label={t('Archive passphrase')}
            hint={t(
              'Use the same strong passphrase for the manifest and every chunk; enter it again for separate downloads. At least 12 characters, up to 1024 UTF-8 bytes.',
            )}
          >
            <input
              type="password"
              autoComplete="new-password"
              maxLength={1024}
              value={exportPassphrase}
              disabled={!!task.pending}
              onChange={(event) => setExportPassphrase(event.target.value)}
            />
          </Field>
          <Field label={t('Confirm archive passphrase')}>
            <input
              type="password"
              autoComplete="new-password"
              maxLength={1024}
              value={exportConfirmation}
              disabled={!!task.pending}
              onChange={(event) => setExportConfirmation(event.target.value)}
            />
          </Field>
        </div>
      )}
      <p className="admin-muted">
        {t(
          'Each file is independently encrypted with AES-256-GCM while preserving its signed inner archive. Folder saving encrypts one part at a time. Passphrases stay in browser memory and are cleared after each operation. Keep them separately; lost passphrases cannot be recovered.',
        )}
      </p>
      {progress && (
        <p role="status" className="admin-muted">
          {progress}
        </p>
      )}
      {!maintenanceReady && (
        <p className="admin-warning">
          {t(
            'Close federation visits in Federation, finish active visits and pause the simulation before creating an archive or import task.',
          )}
        </p>
      )}
      <div className="admin-toolbar">
        <AdminButton
          disabled={
            !!task.pending ||
            !maintenanceReady ||
            !status?.identity ||
            !operator.trim() ||
            !exportReason.trim()
          }
          onClick={() =>
            void task.run(
              t('Starting consistent town snapshot'),
              async () => {
                const created = await convex.mutation(api.federation.backupLarge.startExport, {
                  adminToken,
                  includeVectors,
                  operator: operator.trim(),
                  reason: exportReason.trim(),
                });
                setJobId(created.jobId);
                setProgress(undefined);
              },
              t('Snapshot task created. Continue export to build its signed manifest and chunks.'),
            )
          }
        >
          {t('Create chunked snapshot')}
        </AdminButton>
      </div>
      <Field label={t('Archive task')}>
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
          <option value="">{t('Select a task')}</option>
          {jobs?.map((item) => (
            <option key={item.jobId} value={item.jobId}>
              {t(item.kind)} · {t(item.state)} · {item.jobId}
            </option>
          ))}
        </select>
      </Field>
      {jobs?.length === 0 && (
        <EmptyState>
          {t('No archive tasks. Create a snapshot or load an archive manifest below.')}
        </EmptyState>
      )}
      {job && (
        <>
          <dl className="admin-facts">
            <dt>{t('Task')}</dt>
            <dd>
              <code>{job.jobId}</code>
            </dd>
            <dt>{t('Source town')}</dt>
            <dd>
              <code>{job.sourceTownId}</code>
              <code>{job.sourceFingerprint}</code>
            </dd>
            <dt>{t('Last checkpoint')}</dt>
            <dd>{formatTime(job.updatedAt)}</dd>
            <dt>{t('Import mode')}</dt>
            <dd>{job.mode ? t(job.mode) : '—'}</dd>
            <dt>{t('State / phase')}</dt>
            <dd>
              {t(job.state)} · {t(job.phase)}
            </dd>
            <dt>{t('Current table')}</dt>
            <dd>{job.table ?? '—'}</dd>
            <dt>{t('Current phase progress')}</dt>
            <dd>{job.processedChunks}</dd>
            <dt>{t('Archive chunks')}</dt>
            <dd>
              {job.chunkCount}
              {t(' expected')}
              {job.kind === 'import' ? t(' · {count} uploaded', { count: job.uploadedChunks }) : ''}
            </dd>
            {(job.privacyChunkCount > 0 || job.uploadedPrivacyChunks > 0) && (
              <>
                <dt>{t('Independent privacy evidence pages')}</dt>
                <dd>
                  {t('{count} privacy pages expected · {uploaded} uploaded', {
                    count: job.privacyChunkCount,
                    uploaded: job.uploadedPrivacyChunks,
                  })}
                </dd>
              </>
            )}
            <dt>{t('Records')}</dt>
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
                !!task.pending ||
                ['COMPLETE', 'READY', 'FAILED', 'CANCELLED'].includes(job.state) ||
                (job.kind === 'import' &&
                  job.state === 'STAGING' &&
                  (job.uploadedChunks !== job.chunkCount ||
                    job.uploadedPrivacyChunks !== job.privacyChunkCount))
              }
              onClick={() =>
                void task.run(
                  t('Continuing {kind} batches', { kind: t(job.kind) }),
                  () => advance(job.kind),
                  t(
                    'Batch processing stopped at its next checkpoint. Review the actual task state.',
                  ),
                )
              }
            >
              {t('Continue ')}
              {t(job.kind)}
            </AdminButton>
            {advancing && (
              <AdminButton
                onClick={() => {
                  pauseRequested.current = true;
                }}
              >
                {t('Pause after current batch')}
              </AdminButton>
            )}
            <AdminButton
              disabled={!!task.pending || !job.canResume}
              onClick={() =>
                void task.run(
                  t('Resuming failed checkpoint'),
                  async () => {
                    await convex.mutation(api.federation.backupLarge.resume, {
                      adminToken,
                      jobId: job.jobId,
                    });
                  },
                  t('Checkpoint restored. Continue the task; committed rows are not duplicated.'),
                )
              }
            >
              {t('Retry checkpoint')}
            </AdminButton>
            <AdminButton
              danger
              disabled={
                !!task.pending || ['COMPLETE', 'CANCELLED', 'ROLLING_BACK'].includes(job.state)
              }
              onClick={() =>
                void task.run(
                  t('Cancelling archive task'),
                  async () => {
                    await convex.mutation(api.federation.backupLarge.cancel, {
                      adminToken,
                      jobId: job.jobId,
                    });
                  },
                  job.kind === 'import'
                    ? t(
                        'Rollback requested. Continue import batches until CANCELLED before resuming the target.',
                      )
                    : t('Export cancelled. The server released its maintenance checkpoint.'),
                )
              }
            >
              {job.kind === 'import' ? t('Cancel / roll back import') : t('Cancel export')}
            </AdminButton>
          </div>
          {job.kind === 'import' && job.state === 'READY' && (
            <>
              <p className="admin-warning">
                {t(
                  'All staged parts passed server preflight. Restore and migration replace the target town; cloning creates a new town on an empty target. The server keeps a rollback checkpoint; leave the target paused until completion or completed rollback.',
                )}
              </p>
              <label className="admin-check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={!!task.pending}
                  onChange={(event) => setReviewed(event.target.checked)}
                />{' '}
                {t('I reviewed the archive source, import mode and replacement scope.')}
              </label>
              <AdminButton
                danger
                disabled={!!task.pending || !reviewed || !maintenanceReady}
                onClick={() =>
                  void task.run(
                    t('Committing staged import'),
                    async () => {
                      await convex.mutation(api.federation.backupLarge.startApply, {
                        adminToken,
                        jobId: job.jobId,
                      });
                      setReviewed(false);
                    },
                    t(
                      'Apply started. Continue import batches through repair, commit and cleanup; only COMPLETE confirms success.',
                    ),
                  )
                }
              >
                {t('Apply validated archive')}
              </AdminButton>
            </>
          )}
          {job.kind === 'import' && job.state === 'COMPLETE' && (
            <p className="admin-muted">
              {t('Import complete. ')}
              <a href="#embedding-recovery">{t('Recover the imported memory index')}</a>
              {t(
                " from this town's recorded import. Optional vectors still require source trust, independent target verification and complete retrieval validation.",
              )}
            </p>
          )}
          {job.kind === 'export' && job.state === 'COMPLETE' && (
            <>
              <div className="admin-toolbar">
                <AdminButton
                  disabled={!!task.pending || !canDownload}
                  onClick={() =>
                    void task.run(
                      t('Downloading archive manifest'),
                      async () => {
                        const secret = takeExportPassphrase();
                        downloadJsonText(
                          await protectedPart(
                            JSON.stringify(
                              await convex.action(api.federation.backupLarge.getManifest, {
                                adminToken,
                                jobId: job.jobId,
                              }),
                            ),
                            'manifest',
                            secret,
                          ),
                          `ai-town-manifest-${job.jobId}.json`,
                        );
                      },
                      t('Archive manifest downloaded; also save every referenced chunk.'),
                    )
                  }
                >
                  {t('Download manifest')}
                </AdminButton>
                <AdminButton
                  disabled={!!task.pending || !canDownload || !supportsArchiveDirectory()}
                  onClick={() => {
                    void selectArchiveDirectory()
                      .then((directory) =>
                        task.run(
                          t('Saving archive folder'),
                          async () => {
                            const secret = takeExportPassphrase();
                            const header = await convex.action(
                              api.federation.backupLarge.getManifest,
                              { adminToken, jobId: job.jobId },
                            );
                            await writeArchiveText(
                              directory,
                              'manifest.json',
                              await protectedPart(JSON.stringify(header), 'manifest', secret),
                            );
                            for (let index = 0; index < job.chunkCount; index++) {
                              setProgress(
                                t('Saving chunk {index} / {count}', {
                                  index: index + 1,
                                  count: job.chunkCount,
                                }),
                              );
                              await writeArchiveText(
                                directory,
                                `chunk-${String(index).padStart(6, '0')}.json`,
                                await protectedPart(
                                  await convex.action(api.federation.backupLarge.getChunk, {
                                    adminToken,
                                    jobId: job.jobId,
                                    index,
                                  }),
                                  'chunk',
                                  secret,
                                ),
                              );
                            }
                            const loaded = await loadLargeArchiveManifest(header);
                            const privacyChunks =
                              loaded.archive.manifest.format === 'ai-town-local-sanitized-chunks'
                                ? (loaded.archive.manifest.privacyChunks ?? [])
                                : [];
                            for (const descriptor of privacyChunks) {
                              setProgress(
                                t('Saving privacy page {index} / {count}', {
                                  index: descriptor.index + 1,
                                  count: privacyChunks.length,
                                }),
                              );
                              const chunk = await convex.action(getPrivacyChunk, {
                                adminToken,
                                jobId: job.jobId,
                                pageNumber: descriptor.index,
                              });
                              await writeArchiveText(
                                directory,
                                `privacy-${String(descriptor.index).padStart(6, '0')}.json`,
                                await protectedPart(JSON.stringify(chunk), 'chunk', secret),
                              );
                            }
                          },
                          t('Manifest and every referenced chunk saved to the selected folder.'),
                        ),
                      )
                      .catch((error) =>
                        task.run(t('Selecting archive folder'), () => Promise.reject(error)),
                      );
                  }}
                >
                  {t('Save entire archive to folder')}
                </AdminButton>
              </div>
              <p className="admin-muted">
                {t(
                  'Folder saving writes one chunk at a time without loading the whole town into browser memory. Where folder access is unavailable, download each chunk separately.',
                )}
              </p>
              <div className="admin-inline-form">
                <Field label={t('Chunk index')}>
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
                    !canDownload ||
                    chunkIndex < 0 ||
                    chunkIndex >= job.chunkCount ||
                    !Number.isSafeInteger(chunkIndex)
                  }
                  onClick={() =>
                    void task.run(
                      t('Downloading archive chunk'),
                      async () => {
                        const secret = takeExportPassphrase();
                        downloadJsonText(
                          await protectedPart(
                            await convex.action(api.federation.backupLarge.getChunk, {
                              adminToken,
                              jobId: job.jobId,
                              index: chunkIndex,
                            }),
                            'chunk',
                            secret,
                          ),
                          `chunk-${String(chunkIndex).padStart(6, '0')}.json`,
                        );
                      },
                      t('Chunk downloaded. Preserve its filename and archive manifest.'),
                    )
                  }
                >
                  {t('Download selected chunk')}
                </AdminButton>
              </div>
              <div className="admin-inline-form">
                <Field
                  label={t('Privacy page index')}
                  hint={t(
                    'Privacy pages use their own zero-based index and are separate from town data chunks.',
                  )}
                >
                  <input
                    type="number"
                    min={0}
                    value={privacyPageNumber}
                    onChange={(event) => setPrivacyPageNumber(Number(event.target.value))}
                  />
                </Field>
                <AdminButton
                  disabled={
                    !!task.pending ||
                    !canDownload ||
                    privacyPageNumber < 0 ||
                    !Number.isSafeInteger(privacyPageNumber)
                  }
                  onClick={() =>
                    void task.run(
                      t('Downloading privacy evidence page'),
                      async () => {
                        const secret = takeExportPassphrase();
                        const loaded = await loadLargeArchiveManifest(
                          await convex.action(api.federation.backupLarge.getManifest, {
                            adminToken,
                            jobId: job.jobId,
                          }),
                        );
                        if (
                          loaded.archive.manifest.format !== 'ai-town-local-sanitized-chunks' ||
                          !loaded.archive.manifest.privacyChunks?.[privacyPageNumber]
                        )
                          throw new Error(
                            t('This archive has no privacy evidence page at the selected index.'),
                          );
                        const chunk = await convex.action(getPrivacyChunk, {
                          adminToken,
                          jobId: job.jobId,
                          pageNumber: privacyPageNumber,
                        });
                        downloadJsonText(
                          await protectedPart(JSON.stringify(chunk), 'chunk', secret),
                          `privacy-${String(privacyPageNumber).padStart(6, '0')}.json`,
                        );
                      },
                      t(
                        'Privacy page downloaded. Keep every referenced privacy page with the manifest.',
                      ),
                    )
                  }
                >
                  {t('Download selected privacy page')}
                </AdminButton>
              </div>
            </>
          )}
        </>
      )}
      <details className="admin-disclosure">
        <summary>{t('Stage a chunked archive for import')}</summary>
        <Field
          label={t('Town archive manifest')}
          hint={t(
            'Choose a plain or browser-encrypted RAW manifest, either original signed or locally sanitized with its local proof (up to 5 MB before encryption). Keep every referenced chunk.',
          )}
        >
          <input
            type="file"
            accept=".json,application/json"
            disabled={!!task.pending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              setManifest(undefined);
              setExpectedLocalProofFingerprint('');
              setManifestName('');
              setSourceStopped(false);
              setReviewed(false);
              setManifestFile(file);
              if (!file) return;
              void task.run(
                t('Reading town archive manifest'),
                () => loadManifest(file),
                t(
                  'Manifest loaded but unverified. The server authenticates its source evidence, current archive proof and structure when creating the import task.',
                ),
              );
            }}
          />
        </Field>
        <Field
          label={t('Encrypted archive passphrase')}
          hint={t(
            'Decryption happens in this browser. Enter the passphrase separately for loading the manifest and staging a batch of encrypted chunks; it is never sent to the server.',
          )}
        >
          <input
            type="password"
            autoComplete="off"
            maxLength={1024}
            value={importPassphrase}
            disabled={!!task.pending}
            onChange={(event) => setImportPassphrase(event.target.value)}
          />
        </Field>
        {manifestFile && (
          <div className="admin-toolbar">
            <AdminButton
              disabled={!!task.pending}
              onClick={() =>
                void task.run(
                  t('Reading town archive manifest'),
                  () => loadManifest(manifestFile),
                  t(
                    'Manifest loaded but unverified. Create a staging task to authenticate it on the server.',
                  ),
                )
              }
            >
              {t('Load selected manifest')}
            </AdminButton>
          </div>
        )}
        <div className="admin-form">
          <Field label={t('Chunked import mode')}>
            <select
              value={mode}
              disabled={!!task.pending}
              onChange={(event) => {
                setMode(event.target.value as typeof mode);
                setSourceStopped(false);
                setReviewed(false);
              }}
            >
              <option value="restore">{t('Restore this town')}</option>
              <option value="migrate">{t('Migrate this town')}</option>
              <option value="clone">{t('Create a new town')}</option>
            </select>
          </Field>
          {mode === 'clone' && (
            <Field label={t('New deployment HTTPS endpoint')}>
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
            {t('The source deployment is stopped and cannot issue or renew visit authorizations.')}
          </label>
        )}
        {manifestName && (
          <p className="admin-muted">
            {t('Manifest: ')}
            {manifestName} · {manifest?.archive.manifest.chunks.length}
            {t(' declared chunks · source declarations remain unverified until server validation.')}
          </p>
        )}
        {manifest && (
          <p className="admin-muted">
            {t('Declared source: ')}
            {String(manifest.source.source?.townId ?? t('missing'))}
            {t(' · signing-key fingerprint:')}
            <code>{String(manifest.source.source?.fingerprint ?? t('missing'))}</code>
            {t(' · optional vectors: ')}
            {manifest.source.includeVectors ? t('included') : t('omitted')}
            {t('. A valid signature does not grant trust in an unfamiliar key.')}
          </p>
        )}
        {manifest?.archive.manifest.format === 'ai-town-local-sanitized-chunks' &&
          'localProof' in manifest.archive && (
            <>
              <p className="admin-warning">
                {t(
                  manifest.archive.manifest.version === 2
                    ? 'This is a v2 locally sanitized RAW derivative. The original signature proves only the embedded source evidence. The local proof authenticates the current manifest and independent privacy pages containing cleared visits and memory and conversation deletion identifiers. Upload every privacy page before server preflight.'
                    : 'This is a v1 locally sanitized RAW derivative. The original source signature proves only the embedded source evidence; it does not sign these current chunk bytes. This import restores cleared visit markers; complete memory and conversation deletion evidence is not portable in v1.',
                )}
              </p>
              <p className="admin-muted">
                {t('Declared local signer town: ')}
                <code>{manifest.archive.localProof.townId}</code>
                {t(' · declared local signer fingerprint: ')}
                <code>{manifest.declaredLocalSignerFingerprint}</code>
              </p>
              <Field
                label={t('Trusted local signer fingerprint')}
                hint={t(
                  'Verify the local signer fingerprint through a trusted channel, then type it here. The displayed archive declaration is unverified and is never copied into this confirmation automatically.',
                )}
              >
                <input
                  value={expectedLocalProofFingerprint}
                  autoComplete="off"
                  maxLength={100}
                  disabled={!!task.pending}
                  onChange={(event) => setExpectedLocalProofFingerprint(event.target.value)}
                  placeholder="sha256:..."
                />
              </Field>
            </>
          )}
        <div className="admin-toolbar">
          <AdminButton
            disabled={
              !!task.pending ||
              !manifest ||
              !confirmedLargeArchiveSigner(manifest, expectedLocalProofFingerprint) ||
              !maintenanceReady ||
              (mode !== 'clone' && !sourceStopped) ||
              (mode === 'clone' &&
                (!endpoint.trim() || status?.identity !== null || world !== null)) ||
              (mode !== 'clone' && !status?.identity)
            }
            onClick={() =>
              void task.run(
                t('Creating verified staging task'),
                async () => {
                  if (
                    !manifest ||
                    !confirmedLargeArchiveSigner(manifest, expectedLocalProofFingerprint)
                  )
                    throw new Error(
                      t('Confirm the trusted local signer fingerprint before creating this import task.'),
                    );
                  const created = await convex.action(api.federation.backupLarge.createImport, {
                    adminToken,
                    manifest: manifest.archive.manifest,
                    signature: manifest.archive.signature,
                    ...('localProof' in manifest.archive
                      ? {
                          localProof: manifest.archive.localProof,
                          expectedLocalProofFingerprint: expectedLocalProofFingerprint.trim(),
                        }
                      : {}),
                    mode,
                    sourceStopped,
                    targetEndpoint: mode === 'clone' ? endpoint.trim() : undefined,
                  });
                  setJobId(created.jobId);
                  setReviewed(false);
                },
                t(
                  'Import staging task created. Upload every chunk, then continue server preflight before applying.',
                ),
              )
            }
          >
            {t('Create staging task')}
          </AdminButton>
        </div>
        <Field
          label={t('Archive data chunks')}
          hint={t(
            'Select plain or encrypted chunk JSON files (up to 1 MiB each before encryption). Parts are decrypted and staged one at a time; the server verifies each digest against the authenticated manifest.',
          )}
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
                t('Staging archive chunks'),
                async () => {
                  if (!jobId) return;
                  const secret = importPassphrase;
                  setImportPassphrase('');
                  for (let index = 0; index < files.length; index++) {
                    setProgress(
                      t('Staging {index} / {count}: {filename}', {
                        index: index + 1,
                        count: files.length,
                        filename: files[index].name,
                      }),
                    );
                    const chunk = await readBackupText(files[index], 1024 * 1024, 'chunk', secret);
                    await convex.action(api.federation.backupLarge.stageChunk, {
                      adminToken,
                      jobId,
                      chunk,
                    });
                  }
                  setFiles([]);
                },
                t(
                  'Selected chunks staged. Reuploading an identical part is idempotent; continue import to run complete preflight.',
                ),
              )
            }
          >
            {t('Stage selected chunks')}
          </AdminButton>
        </div>
        <Field
          label={t('Independent privacy evidence pages')}
          hint={t(
            'For v2 derivatives, select every plain or encrypted privacy page (up to 1 MiB each before encryption). Privacy pages have independent indices; uploading all town chunks alone does not complete server preflight.',
          )}
        >
          <input
            type="file"
            accept=".json,application/json"
            multiple
            disabled={!!task.pending}
            onChange={(event) => setPrivacyFiles(Array.from(event.target.files ?? []))}
          />
        </Field>
        <div className="admin-toolbar">
          <AdminButton
            disabled={
              !!task.pending ||
              !privacyFiles.length ||
              !jobId ||
              job?.kind !== 'import' ||
              job.state !== 'STAGING'
            }
            onClick={() =>
              void task.run(
                t('Staging privacy evidence pages'),
                async () => {
                  if (!jobId) return;
                  const secret = importPassphrase;
                  setImportPassphrase('');
                  for (let index = 0; index < privacyFiles.length; index++) {
                    setProgress(
                      t('Staging {index} / {count}: {filename}', {
                        index: index + 1,
                        count: privacyFiles.length,
                        filename: privacyFiles[index].name,
                      }),
                    );
                    const chunk = await readBackupText(
                      privacyFiles[index],
                      1024 * 1024,
                      'chunk',
                      secret,
                    );
                    await convex.action(stagePrivacyChunk, {
                      adminToken,
                      jobId,
                      pageNumber: archivePrivacyPageNumber(chunk),
                      chunk,
                    });
                  }
                  setPrivacyFiles([]);
                },
                t(
                  'Selected privacy pages staged. Upload every referenced data chunk and privacy page before continuing server preflight.',
                ),
              )
            }
          >
            {t('Stage selected privacy pages')}
          </AdminButton>
        </div>
      </details>
      <ColdArchivePanel adminToken={adminToken} />
    </section>
  );
}
