import { useLocale } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import {
  backupImportSupportsRetry,
  newBackupUploadAttemptKey,
  requiresStoppedSource,
} from './uiPolicy';
import { encryptBackupText, readBackupText, validBackupPassphrase } from './backupEncryption';
import { api } from '../../../convex/_generated/api';
import RecoveryPanel from './RecoveryPanel';
import ArchivePanel from './ArchivePanel';
import IdentityRecoveryPanel from './IdentityRecoveryPanel';
import MemoryCompressionPanel from './MemoryCompressionPanel';
import StoragePolicyPanel from './StoragePolicyPanel';
import MigrationPanel from './MigrationPanel';
import SelectiveExportPanel from './SelectiveExportPanel';
import SelectiveImportPanel from './SelectiveImportPanel';
import EmbeddingPanel, { VectorExportOption } from './EmbeddingPanel';
import { declaredBackupSource } from './embeddingUiPolicy';
import {
  AdminButton,
  downloadBundle,
  downloadJsonText,
  EmptyState,
  Field,
  TaskFeedback,
  formatTime,
  useAdminTask,
} from './AdminShared';

type ImportMode = 'restore' | 'migrate' | 'clone' | 'merge';
const modes: { value: ImportMode; label: string; description: string }[] = [
  {
    value: 'restore',
    label: 'Restore this town or original Home resident',
    description:
      'Requires this town identity, matching fingerprint and a stopped source deployment. Existing runtime authorizations are never restored.',
  },
  {
    value: 'migrate',
    label: 'Migrate this town',
    description:
      'Requires matching identity and confirmation that the source deployment has stopped. The new instance must pass recovery checks.',
  },
  {
    value: 'clone',
    label: 'Create a new town',
    description:
      'Requires an empty, uninitialized target. New identity keys prevent impersonating the source town.',
  },
  {
    value: 'merge',
    label: 'Merge as new residents',
    description:
      'Import into the selected world. Residents receive new global identities owned by this town.',
  },
];

export default function DataPanel({ adminToken }: { adminToken: string }) {
  const { t } = useLocale();
  const convex = useConvex();
  const task = useAdminTask();
  const archiveHeading = useRef<HTMLHeadingElement>(null);
  const world = useQuery(api.world.defaultWorldStatus);
  const residents = useQuery(api.federation.runtime.listResidents, { adminToken });
  const status = useQuery(api.federation.admin.status, { adminToken });
  const history = useQuery(api.federation.backup.history, { adminToken });
  const restored = useQuery(api.federation.backup.restoredResidents, { adminToken });
  const pendingWorldRecovery =
    restored?.some((resident) => resident.worldId === world?.worldId) ?? false;
  const [bundle, setBundle] = useState<unknown>();
  const [filename, setFilename] = useState('');
  const [mode, setMode] = useState<ImportMode>('merge');
  const [sourceStopped, setSourceStopped] = useState(false);
  const [targetEndpoint, setTargetEndpoint] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [operator, setOperator] = useState('');
  const [reason, setReason] = useState('');
  const [report, setReport] =
    useState<FunctionReturnType<typeof api.federation.backup.preflight>>();
  const [result, setResult] =
    useState<FunctionReturnType<typeof api.federation.backup.importBackup>>();
  const [importAttempt, setImportAttempt] = useState<{
    request: Omit<FunctionArgs<typeof api.federation.backup.importBackup>, 'adminToken'>;
    supportsRetry: boolean;
  }>();
  const [encryptDownloads, setEncryptDownloads] = useState(false);
  const [includeVectors, setIncludeVectors] = useState(false);
  const [exportOperator, setExportOperator] = useState('');
  const [exportReason, setExportReason] = useState('');
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportConfirmation, setExportConfirmation] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importFile, setImportFile] = useState<File>();
  const canDownload =
    !!exportOperator.trim() &&
    !!exportReason.trim() &&
    (!encryptDownloads ||
      (validBackupPassphrase(exportPassphrase) && exportPassphrase === exportConfirmation));
  function takeDownloadPassphrase() {
    if (!encryptDownloads) return undefined;
    if (!canDownload) throw new Error(t('Enter and confirm a strong backup passphrase.'));
    const secret = exportPassphrase;
    setExportPassphrase('');
    setExportConfirmation('');
    return secret;
  }
  async function saveSnapshot(value: unknown, name: string, secret?: string) {
    if (secret === undefined) return downloadBundle(value, name);
    downloadJsonText(
      await encryptBackupText(JSON.stringify(value), secret, 'snapshot', 5 * 1024 * 1024),
      name.replace(/\.json$/, '-encrypted.json'),
    );
  }
  async function loadBackup(file: File) {
    const secret = importPassphrase;
    setImportPassphrase('');
    const parsed: unknown = JSON.parse(
      await readBackupText(file, 5 * 1024 * 1024, 'snapshot', secret),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error(t('Choose an exported AI Town JSON object.'));
    setBundle(parsed);
    setFilename(file.name);
    setImportFile(undefined);
  }
  useEffect(() => {
    setReport(undefined);
    setAcknowledged(false);
  }, [world?.worldId, world?.status]);
  const targetPaused =
    !world || world.status === 'stoppedByDeveloper' || world.status === 'inactive';
  const args = {
    adminToken,
    bundleJson: bundle === undefined ? undefined : JSON.stringify(bundle),
    mode,
    targetWorldId: mode === 'merge' || mode === 'restore' ? world?.worldId : undefined,
    sourceStopped,
    targetEndpoint: mode === 'clone' ? targetEndpoint.trim() : undefined,
    residentRestore: report?.residentRestorePlan
      ? {
          expectedTargetDigest: report.residentRestorePlan.targetDigest,
          confirmOverwrite: acknowledged,
          operator: operator.trim(),
          reason: reason.trim(),
        }
      : undefined,
  };
  function invalidate() {
    setImportAttempt(undefined);
    setReport(undefined);
    setResult(undefined);
    setAcknowledged(false);
  }
  const declaredSource = declaredBackupSource(bundle);
  return (
    <section className="admin-panel">
      <h2>{t('Data & backups')}</h2>
      <p className="admin-muted">
        {t(
          'Back up readable memory, relationships, resident bindings and world data. Model keys, pairing secrets, private identity keys and live visit authorizations are excluded.',
        )}
      </p>
      <TaskFeedback task={task} />
      <h3>{t('Export')}</h3>
      <VectorExportOption
        checked={includeVectors}
        onChange={setIncludeVectors}
        disabled={!!task.pending}
      />
      <div className="admin-form">
        <Field label={t('Export operator')}>
          <input
            value={exportOperator}
            onChange={(e) => setExportOperator(e.target.value)}
            maxLength={200}
          />
        </Field>
        <Field label={t('Export reason')}>
          <input
            value={exportReason}
            onChange={(e) => setExportReason(e.target.value)}
            maxLength={1000}
          />
        </Field>
      </div>
      <p className="admin-muted">
        {t(
          'Successful snapshot generation records your declared operator, reason, scope and archive digest. The shared admin token authenticates access; the operator label is not a verified account identity.',
        )}
      </p>
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
        {t('Encrypt downloaded town and resident snapshots in this browser')}
      </label>
      {encryptDownloads && (
        <div className="admin-form">
          <Field
            label={t('Snapshot passphrase')}
            hint={t(
              'Use a unique strong passphrase (at least 12 characters, up to 1024 UTF-8 bytes). Keep it separately; lost passphrases cannot be recovered.',
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
          <Field label={t('Confirm snapshot passphrase')}>
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
          'Optional AES-256-GCM encryption protects downloaded private memories. The passphrase stays in browser memory and is cleared after each operation. The server still receives ordinary archive data for export and import validation; this option protects saved files.',
        )}
      </p>
      <div className="admin-toolbar">
        <AdminButton
          disabled={!!task.pending || !canDownload}
          onClick={() =>
            void task.run(
              t('Exporting town snapshot'),
              async () => {
                const secret = takeDownloadPassphrase();
                await saveSnapshot(
                  await convex.action(api.federation.backup.exportTown, {
                    adminToken,
                    includeVectors,
                    operator: exportOperator.trim(),
                    reason: exportReason.trim(),
                  }),
                  `ai-town-${Date.now()}.json`,
                  secret,
                );
              },
              t(
                'Town snapshot downloaded. Store it securely; resident memories may contain private information.',
              ),
            )
          }
        >
          {t('Download full town')}
        </AdminButton>
        <button
          type="button"
          className="admin-button button shadow-solid"
          onClick={() => {
            archiveHeading.current?.scrollIntoView({ block: 'start' });
            archiveHeading.current?.focus({ preventScroll: true });
          }}
        >
          <span>{t('Open chunked archives')}</span>
        </button>
      </div>
      {!residents?.length ? (
        <EmptyState>
          {t("Register residents in Travel to export an individual resident's story and memory.")}
        </EmptyState>
      ) : (
        <form
          className="admin-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            const resident = residents.find((r) => r.agentGlobalId === fields.get('resident'));
            if (!resident) return;
            void task.run(
              t('Exporting resident'),
              async () => {
                const secret = takeDownloadPassphrase();
                await saveSnapshot(
                  await convex.action(api.federation.backup.exportResident, {
                    adminToken,
                    includeVectors,
                    operator: exportOperator.trim(),
                    reason: exportReason.trim(),
                    worldId: resident.worldId,
                    playerId: resident.playerId,
                  }),
                  `ai-town-resident-${Date.now()}.json`,
                  secret,
                );
              },
              t('Resident snapshot downloaded.'),
            );
          }}
        >
          <Field label={t('Resident')}>
            <select name="resident">
              {residents.map((r) => (
                <option key={r.agentGlobalId} value={r.agentGlobalId}>
                  {r.name} · {r.playerId}
                </option>
              ))}
            </select>
          </Field>
          <AdminButton type="submit" disabled={!!task.pending || !canDownload}>
            {t('Download resident')}
          </AdminButton>
        </form>
      )}
      <p className="admin-muted">
        {t(
          'The single-file export has a 5 MiB / 500-record limit. For larger towns, use chunked archives below. Private identity recovery uses a separate encrypted package.',
        )}
      </p>
      <SelectiveExportPanel adminToken={adminToken} />
      <SelectiveImportPanel adminToken={adminToken} />
      <h3>{t('Import & recovery')}</h3>
      {mode !== 'clone' && (
        <>
          <p className="admin-muted">
            {t(
              'End active visits, then pause the target simulation before preflight or import. The server refuses to pause while visit cleanup is incomplete. Resume after recovery.',
            )}
          </p>
          <div className="admin-toolbar">
            <AdminButton
              disabled={!!task.pending || !world || world.status === 'stoppedByDeveloper'}
              onClick={() =>
                void task.run(
                  t('Pausing target simulation'),
                  () => convex.mutation(api.testing.stop, { adminToken }),
                  t('Target paused. Run preflight before importing.'),
                )
              }
            >
              {t('Pause target for import')}
            </AdminButton>
            <AdminButton
              disabled={
                !!task.pending ||
                !world ||
                world.status !== 'stoppedByDeveloper' ||
                !restored ||
                pendingWorldRecovery
              }
              onClick={() =>
                void task.run(
                  t('Resuming target simulation'),
                  () => convex.mutation(api.testing.resume, { adminToken }),
                  t('Target simulation resumed.'),
                )
              }
            >
              {t('Resume target simulation')}
            </AdminButton>
            <p className="admin-muted">
              {t('World state: ')}
              {world?.status ? t(world.status) : t('No default world')}
            </p>
            {pendingWorldRecovery && (
              <p className="admin-warning">
                {t(
                  'Reconcile this world’s restored travelers below before resuming the simulation.',
                )}
              </p>
            )}
          </div>
        </>
      )}
      <div className="admin-form">
        <Field
          label={t('Backup JSON file')}
          hint={t(
            'Choose a plain or browser-encrypted snapshot (up to 5 MiB before encryption, 500 records). For encrypted files, enter the passphrase below and retry loading. The server validates the decrypted archive.',
          )}
        >
          <input
            type="file"
            accept=".json,application/json"
            disabled={!!task.pending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              invalidate();
              setSourceStopped(false);
              setBundle(undefined);
              setFilename('');
              setImportFile(file);
              if (!file) return;
              void task.run(
                t('Reading backup'),
                () => loadBackup(file),
                t('File loaded. Run preflight to review its scope and conflicts.'),
              );
            }}
          />
        </Field>
        <Field
          label={t('Encrypted snapshot passphrase')}
          hint={t(
            'Only needed for encrypted files. Decryption happens in this browser before server preflight.',
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
        <Field label={t('Import mode')}>
          <select
            value={mode}
            disabled={!!task.pending}
            onChange={(event) => {
              setMode(event.target.value as ImportMode);
              setSourceStopped(false);
              invalidate();
            }}
          >
            {modes.map((item) => (
              <option key={item.value} value={item.value}>
                {t(item.label)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {importFile && (
        <div className="admin-toolbar">
          <AdminButton
            disabled={!!task.pending}
            onClick={() =>
              void task.run(
                t('Reading backup'),
                () => loadBackup(importFile),
                t('File loaded. Run preflight to review its scope and conflicts.'),
              )
            }
          >
            {t('Load selected backup')}
          </AdminButton>
        </div>
      )}
      <p className="admin-muted">
        {t(modes.find((item) => item.value === mode)?.description ?? '')}
      </p>
      {(mode === 'merge' || mode === 'restore') && (
        <p>
          {t('Target world: ')}
          <code>{world?.worldId ?? t('No default world exists')}</code>
        </p>
      )}
      {(mode === 'restore' || mode === 'migrate') && (
        <p className="admin-warning">
          {t(
            'The active target is backed up before import. Restore and migration require matching long-term identity. Do not activate two deployments with the same private key.',
          )}
          {encryptDownloads &&
            t(
              ' Enter the snapshot passphrase again above to encrypt the before-import safety download.',
            )}
        </p>
      )}
      {requiresStoppedSource(mode) && (
        <label className="admin-check">
          <input
            type="checkbox"
            checked={sourceStopped}
            disabled={!!task.pending}
            onChange={(event) => {
              setSourceStopped(event.target.checked);
              invalidate();
            }}
          />{' '}
          {t(
            'I have stopped the source deployment and prevented it from issuing new visit authorizations. Only this target will run the restored identity.',
          )}
        </label>
      )}
      {mode === 'clone' && status?.identity && (
        <p className="admin-error">
          {t(
            'This town already has an identity. Use a fresh deployment to create a new town from the backup.',
          )}
        </p>
      )}
      {mode === 'clone' && (
        <Field
          label={t("New town's HTTPS endpoint")}
          hint={t(
            "Use this new deployment's HTTP actions endpoint, not the source town's address.",
          )}
        >
          <input
            type="url"
            value={targetEndpoint}
            disabled={!!task.pending}
            onChange={(event) => {
              setTargetEndpoint(event.target.value);
              invalidate();
            }}
            placeholder="https://new-deployment.convex.site"
            required
          />
        </Field>
      )}
      {filename && (
        <p className="admin-muted">
          {t('Selected: ')}
          {filename}
        </p>
      )}
      {declaredSource && (
        <p className="admin-muted">
          {t('Declared source: ')}
          {declaredSource.townId}
          {t(' · signing-key fingerprint:')}
          <code>{declaredSource.fingerprint}</code>
          {t(' · optional vectors: ')}
          {declaredSource.includeVectors ? t('included') : t('omitted')}
          {t(
            '. The server verifies the signature; local trust and vector compatibility are checked separately after import.',
          )}
        </p>
      )}
      <div className="admin-toolbar">
        <AdminButton
          disabled={
            !!task.pending ||
            !!importAttempt ||
            !bundle ||
            (mode !== 'clone' && !targetPaused) ||
            (mode === 'merge' && !world) ||
            (requiresStoppedSource(mode) && !sourceStopped) ||
            (mode === 'clone' && (!!status?.identity || !targetEndpoint.trim()))
          }
          onClick={() =>
            void task.run(
              t('Validating backup and conflicts'),
              async () => {
                setReport(undefined);
                setResult(undefined);
                setAcknowledged(false);
                setReport(await convex.action(api.federation.backup.preflight, args));
              },
              t('Preflight complete. Review the report before importing.'),
            )
          }
        >
          {t('Run preflight')}
        </AdminButton>
      </div>
      {report && (
        <>
          <div className="admin-warning">
            <strong>
              {t('Preflight: ')}
              {report.valid ? t('VALID') : t('BLOCKED')}
            </strong>
            <p>
              {t('Mode: ')}
              {t(report.mode)}
              {t(' · scope: ')}
              {t(report.scope)}
              {t(' · vectors: ')}
              {t(report.vectorPolicy)}
            </p>
            {report.warnings.map((warning, i) => (
              <p key={i}>{warning}</p>
            ))}
            <pre className="admin-report">{JSON.stringify(report.counts, null, 2)}</pre>
            {report.residentRestorePlan && (
              <>
                <p>
                  {t('Restore resident: ')}
                  <code>{report.residentRestorePlan.agentGlobalId}</code>
                </p>
                <p>
                  {t('Fixed Chat model: ')}
                  {report.residentRestorePlan.model.model}
                  {t(' · credential:')}{' '}
                  {report.residentRestorePlan.model.credentialConfigured
                    ? t('configured')
                    : t('requires configuration')}
                </p>
                <p>
                  {t('Archived memories: ')}
                  {report.residentRestorePlan.memoryCount}
                  {t(
                    '. Newer memories and other residents are retained. The server stores a target snapshot before applying the restore.',
                  )}
                </p>
                <p>
                  {t('Target confirmation: ')}
                  <code>{report.residentRestorePlan.targetDigest}</code>
                </p>
              </>
            )}
          </div>
          <p className="admin-muted">
            {t(
              "Vectors require rebuilding in the target's verified space. Imported travel is historical; no visitor lease or remote task is reactivated.",
            )}
          </p>
          {report.residentRestorePlan && (
            <div className="admin-form">
              <Field label={t('Restore operator')}>
                <input
                  value={operator}
                  maxLength={120}
                  disabled={!!task.pending}
                  onChange={(event) => {
                    setOperator(event.target.value);
                    setImportAttempt(undefined);
                    setResult(undefined);
                    setAcknowledged(false);
                  }}
                />
              </Field>
              <Field label={t('Restore reason')}>
                <input
                  value={reason}
                  maxLength={1000}
                  disabled={!!task.pending}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setImportAttempt(undefined);
                    setResult(undefined);
                    setAcknowledged(false);
                  }}
                />
              </Field>
            </div>
          )}
          <label className="admin-check">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={!!task.pending}
              onChange={(event) => {
                setAcknowledged(event.target.checked);
                // Revoking confirmation starts a fresh operation after another review.
                if (!event.target.checked) {
                  setImportAttempt(undefined);
                  setResult(undefined);
                }
              }}
            />{' '}
            {report.residentRestorePlan
              ? t(
                  'I reviewed this target snapshot and authorize overwriting this resident’s archived records, persona and fixed Chat binding.',
                )
              : t('I reviewed the scope, identity requirements and conflict warnings.')}
          </label>
          <div className="admin-toolbar">
            <AdminButton
              danger
              disabled={
                !!task.pending ||
                !!importAttempt ||
                !report.valid ||
                !acknowledged ||
                (!!report.residentRestorePlan && (!operator.trim() || !reason.trim())) ||
                !!result ||
                ((mode === 'restore' || mode === 'migrate') &&
                  !report.residentRestorePlan &&
                  !canDownload) ||
                (mode !== 'clone' && !targetPaused) ||
                (requiresStoppedSource(mode) && !sourceStopped)
              }
              onClick={() =>
                void task.run(
                  t('Importing validated backup'),
                  async () => {
                    if ((mode === 'restore' || mode === 'migrate') && !report.residentRestorePlan) {
                      const secret = takeDownloadPassphrase();
                      await saveSnapshot(
                        await convex.action(api.federation.backup.exportTown, {
                          adminToken,
                          operator: exportOperator.trim(),
                          reason: exportReason.trim(),
                        }),
                        `ai-town-before-import-${Date.now()}.json`,
                        secret,
                      );
                    }
                    const { adminToken: _adminToken, ...request } = args;
                    const attempt = {
                      request: { ...request, uploadAttemptKey: newBackupUploadAttemptKey() },
                      supportsRetry: backupImportSupportsRetry(bundle),
                    };
                    // Keep the exact request before awaiting its ACK. Reactive world/identity
                    // updates can remove preflight after a committed import with a lost response.
                    setImportAttempt(attempt);
                    setResult(await convex.action(api.federation.backup.importBackup, {
                      ...attempt.request,
                      adminToken,
                    }));
                  },
                  t(
                    'Data import completed. Review the mapping and rebuild memory vectors before activation.',
                  ),
                )
              }
            >
              {t('Import validated package')}
            </AdminButton>
          </div>
        </>
      )}
      {importAttempt && (
        <>
          {!result && (
            <p className="admin-muted">
              {importAttempt.supportsRetry
                ? t(
                    'Retry sends the same import request. Its upload and publication can be recovered if the response was lost. Keep this panel open; retry state is held only in browser memory.',
                  )
                : t(
                    'This backup has no vector upload checkpoint. A lost response cannot be retried safely here; review import history and target data before starting another import.',
                  )}
            </p>
          )}
          <div className="admin-toolbar">
            {!result && importAttempt.supportsRetry && (
              <AdminButton
                danger
                disabled={!!task.pending}
                onClick={() =>
                  void task.run(
                    t('Importing validated backup'),
                    async () => {
                      setResult(await convex.action(api.federation.backup.importBackup, {
                        ...importAttempt.request,
                        adminToken,
                      }));
                    },
                    t(
                      'Data import completed. Review the mapping and rebuild memory vectors before activation.',
                    ),
                  )
                }
              >
                {t('Retry the same import')}
              </AdminButton>
            )}
            <AdminButton disabled={!!task.pending} onClick={invalidate}>
              {t('Start another import')}
            </AdminButton>
          </div>
        </>
      )}
      {result && (
        <div>
          <h3>{t('Import result')}</h3>
          <pre className="admin-report">{JSON.stringify(result, null, 2)}</pre>
          <p className="admin-muted">
            {t(
              'Use Models & memory to rebuild and validate the target index. Missing API keys must be configured on the server; bindings are not silently reassigned.',
            )}
          </p>
        </div>
      )}
      <RecoveryPanel adminToken={adminToken} />
      <details className="admin-disclosure">
        <summary>{t('Import history')}</summary>
        {!history?.length ? (
          <EmptyState>{t('No import operations recorded.')}</EmptyState>
        ) : (
          <ul className="admin-list">
            {history.map((item) => (
              <li key={item._id}>
                <div>
                  <strong>{t(item.mode)}</strong>
                  <code>{item.sourceTownId}</code>
                  <p className="admin-muted">
                    {t('Backup created: ')}
                    {formatTime(item.exportedAt)}
                    {t(' · imported:')} {formatTime(item.importedAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </details>
      <ArchivePanel adminToken={adminToken} headingRef={archiveHeading} />
      <EmbeddingPanel adminToken={adminToken} initialImportId={result?.importId} />
      <IdentityRecoveryPanel adminToken={adminToken} />
      <MigrationPanel adminToken={adminToken} />
      <StoragePolicyPanel adminToken={adminToken} />
      <MemoryCompressionPanel adminToken={adminToken} />
    </section>
  );
}
