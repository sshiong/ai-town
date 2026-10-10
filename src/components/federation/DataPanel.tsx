import { useEffect, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { requiresStoppedSource } from './uiPolicy';
import { encryptBackupText, readBackupText, validBackupPassphrase } from './backupEncryption';
import { api } from '../../../convex/_generated/api';
import RecoveryPanel from './RecoveryPanel';
import ArchivePanel from './ArchivePanel';
import IdentityRecoveryPanel from './IdentityRecoveryPanel';
import StoragePolicyPanel from './StoragePolicyPanel';
import MigrationPanel from './MigrationPanel';
import SelectiveExportPanel from './SelectiveExportPanel';
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
  const convex = useConvex();
  const task = useAdminTask();
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
  const [encryptDownloads, setEncryptDownloads] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportConfirmation, setExportConfirmation] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importFile, setImportFile] = useState<File>();
  const canDownload =
    !encryptDownloads ||
    (validBackupPassphrase(exportPassphrase) && exportPassphrase === exportConfirmation);
  function takeDownloadPassphrase() {
    if (!encryptDownloads) return undefined;
    if (!canDownload) throw new Error('Enter and confirm a strong backup passphrase.');
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
      throw new Error('Choose an exported AI Town JSON object.');
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
    setReport(undefined);
    setResult(undefined);
    setAcknowledged(false);
  }
  return (
    <section className="admin-panel">
      <h2>Data &amp; backups</h2>
      <p className="admin-muted">
        Back up readable memory, relationships, resident bindings and world data. Model keys,
        pairing secrets, private identity keys and live visit authorizations are excluded.
      </p>
      <TaskFeedback task={task} />
      <h3>Export</h3>
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
        Encrypt downloaded town and resident snapshots in this browser
      </label>
      {encryptDownloads && (
        <div className="admin-form">
          <Field
            label="Snapshot passphrase"
            hint="Use a unique strong passphrase (at least 12 characters, up to 1024 UTF-8 bytes). Keep it separately; lost passphrases cannot be recovered."
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
          <Field label="Confirm snapshot passphrase">
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
        Optional AES-256-GCM encryption protects downloaded private memories. The passphrase stays
        in browser memory and is cleared after each operation. The server still receives ordinary
        archive data for export and import validation; this option protects saved files.
      </p>
      <div className="admin-toolbar">
        <AdminButton
          disabled={!!task.pending || !canDownload}
          onClick={() =>
            void task.run(
              'Exporting town snapshot',
              async () => {
                const secret = takeDownloadPassphrase();
                await saveSnapshot(
                  await convex.action(api.federation.backup.exportTown, { adminToken }),
                  `ai-town-${Date.now()}.json`,
                  secret,
                );
              },
              'Town snapshot downloaded. Store it securely; resident memories may contain private information.',
            )
          }
        >
          Download full town
        </AdminButton>
      </div>
      {!residents?.length ? (
        <EmptyState>
          Register residents in Travel to export an individual resident's story and memory.
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
              'Exporting resident',
              async () => {
                const secret = takeDownloadPassphrase();
                await saveSnapshot(
                  await convex.action(api.federation.backup.exportResident, {
                    adminToken,
                    worldId: resident.worldId,
                    playerId: resident.playerId,
                  }),
                  `ai-town-resident-${Date.now()}.json`,
                  secret,
                );
              },
              'Resident snapshot downloaded.',
            );
          }}
        >
          <Field label="Resident">
            <select name="resident">
              {residents.map((r) => (
                <option key={r.agentGlobalId} value={r.agentGlobalId}>
                  {r.name} · {r.playerId}
                </option>
              ))}
            </select>
          </Field>
          <AdminButton type="submit" disabled={!!task.pending || !canDownload}>
            Download resident
          </AdminButton>
        </form>
      )}
      <p className="admin-muted">
        The single-file export has a 5 MiB / 500-record limit. For larger towns, use chunked
        archives below. Private identity recovery uses a separate encrypted package.
      </p>
      <SelectiveExportPanel adminToken={adminToken} />
      <h3>Import &amp; recovery</h3>
      {mode !== 'clone' && (
        <>
          <p className="admin-muted">
            End active visits, then pause the target simulation before preflight or import. The
            server refuses to pause while visit cleanup is incomplete. Resume after recovery.
          </p>
          <div className="admin-toolbar">
            <AdminButton
              disabled={!!task.pending || !world || world.status === 'stoppedByDeveloper'}
              onClick={() =>
                void task.run(
                  'Pausing target simulation',
                  () => convex.mutation(api.testing.stop, { adminToken }),
                  'Target paused. Run preflight before importing.',
                )
              }
            >
              Pause target for import
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
                  'Resuming target simulation',
                  () => convex.mutation(api.testing.resume, { adminToken }),
                  'Target simulation resumed.',
                )
              }
            >
              Resume target simulation
            </AdminButton>
            <p className="admin-muted">World state: {world?.status ?? 'No default world'}</p>
            {pendingWorldRecovery && (
              <p className="admin-warning">
                Reconcile this world’s restored travelers below before resuming the simulation.
              </p>
            )}
          </div>
        </>
      )}
      <div className="admin-form">
        <Field
          label="Backup JSON file"
          hint="Choose a plain or browser-encrypted snapshot (up to 5 MiB before encryption, 500 records). For encrypted files, enter the passphrase below and retry loading. The server validates the decrypted archive."
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
                'Reading backup',
                () => loadBackup(file),
                'File loaded. Run preflight to review its scope and conflicts.',
              );
            }}
          />
        </Field>
        <Field
          label="Encrypted snapshot passphrase"
          hint="Only needed for encrypted files. Decryption happens in this browser before server preflight."
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
        <Field label="Import mode">
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
                {item.label}
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
                'Reading backup',
                () => loadBackup(importFile),
                'File loaded. Run preflight to review its scope and conflicts.',
              )
            }
          >
            Load selected backup
          </AdminButton>
        </div>
      )}
      <p className="admin-muted">{modes.find((item) => item.value === mode)?.description}</p>
      {(mode === 'merge' || mode === 'restore') && (
        <p>
          Target world: <code>{world?.worldId ?? 'No default world exists'}</code>
        </p>
      )}
      {(mode === 'restore' || mode === 'migrate') && (
        <p className="admin-warning">
          The active target is backed up before import. Restore and migration require matching
          long-term identity. Do not activate two deployments with the same private key.
          {encryptDownloads &&
            ' Enter the snapshot passphrase again above to encrypt the before-import safety download.'}
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
          I have stopped the source deployment and prevented it from issuing new visit
          authorizations. Only this target will run the restored identity.
        </label>
      )}
      {mode === 'clone' && status?.identity && (
        <p className="admin-error">
          This town already has an identity. Use a fresh deployment to create a new town from the
          backup.
        </p>
      )}
      {mode === 'clone' && (
        <Field
          label="New town's HTTPS endpoint"
          hint="Use this new deployment's HTTP actions endpoint, not the source town's address."
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
      {filename && <p className="admin-muted">Selected: {filename}</p>}
      <div className="admin-toolbar">
        <AdminButton
          disabled={
            !!task.pending ||
            !bundle ||
            (mode !== 'clone' && !targetPaused) ||
            (mode === 'merge' && !world) ||
            (requiresStoppedSource(mode) && !sourceStopped) ||
            (mode === 'clone' && (!!status?.identity || !targetEndpoint.trim()))
          }
          onClick={() =>
            void task.run(
              'Validating backup and conflicts',
              async () => {
                setReport(undefined);
                setResult(undefined);
                setAcknowledged(false);
                setReport(await convex.action(api.federation.backup.preflight, args));
              },
              'Preflight complete. Review the report before importing.',
            )
          }
        >
          Run preflight
        </AdminButton>
      </div>
      {report && (
        <>
          <div className="admin-warning">
            <strong>Preflight: {report.valid ? 'VALID' : 'BLOCKED'}</strong>
            <p>
              Mode: {report.mode} · scope: {report.scope} · vectors: {report.vectorPolicy}
            </p>
            {report.warnings.map((warning, i) => (
              <p key={i}>{warning}</p>
            ))}
            <pre className="admin-report">{JSON.stringify(report.counts, null, 2)}</pre>
            {report.residentRestorePlan && (
              <>
                <p>
                  Restore resident: <code>{report.residentRestorePlan.agentGlobalId}</code>
                </p>
                <p>
                  Fixed Chat model: {report.residentRestorePlan.model.model} · credential:{' '}
                  {report.residentRestorePlan.model.credentialConfigured
                    ? 'configured'
                    : 'requires configuration'}
                </p>
                <p>
                  Archived memories: {report.residentRestorePlan.memoryCount}. Newer memories and
                  other residents are retained. The server stores a target snapshot before applying
                  the restore.
                </p>
                <p>
                  Target confirmation: <code>{report.residentRestorePlan.targetDigest}</code>
                </p>
              </>
            )}
          </div>
          <p className="admin-muted">
            Vectors require rebuilding in the target's verified space. Imported travel is
            historical; no visitor lease or remote task is reactivated.
          </p>
          {report.residentRestorePlan && (
            <div className="admin-form">
              <Field label="Restore operator">
                <input
                  value={operator}
                  maxLength={120}
                  disabled={!!task.pending}
                  onChange={(event) => {
                    setOperator(event.target.value);
                    setAcknowledged(false);
                  }}
                />
              </Field>
              <Field label="Restore reason">
                <input
                  value={reason}
                  maxLength={1000}
                  disabled={!!task.pending}
                  onChange={(event) => {
                    setReason(event.target.value);
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
              onChange={(event) => setAcknowledged(event.target.checked)}
            />{' '}
            {report.residentRestorePlan
              ? 'I reviewed this target snapshot and authorize overwriting this resident’s archived records, persona and fixed Chat binding.'
              : 'I reviewed the scope, identity requirements and conflict warnings.'}
          </label>
          <div className="admin-toolbar">
            <AdminButton
              danger
              disabled={
                !!task.pending ||
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
                  'Importing validated backup',
                  async () => {
                    if ((mode === 'restore' || mode === 'migrate') && !report.residentRestorePlan) {
                      const secret = takeDownloadPassphrase();
                      await saveSnapshot(
                        await convex.action(api.federation.backup.exportTown, { adminToken }),
                        `ai-town-before-import-${Date.now()}.json`,
                        secret,
                      );
                    }
                    setResult(await convex.action(api.federation.backup.importBackup, args));
                  },
                  'Data import completed. Review the mapping and rebuild memory vectors before activation.',
                )
              }
            >
              Import validated package
            </AdminButton>
          </div>
        </>
      )}
      {result && (
        <div>
          <h3>Import result</h3>
          <pre className="admin-report">{JSON.stringify(result, null, 2)}</pre>
          <p className="admin-muted">
            Use Models &amp; memory to rebuild and validate the target index. Missing API keys must
            be configured on the server; bindings are not silently reassigned.
          </p>
        </div>
      )}
      <RecoveryPanel adminToken={adminToken} />
      <details className="admin-disclosure">
        <summary>Import history</summary>
        {!history?.length ? (
          <EmptyState>No import operations recorded.</EmptyState>
        ) : (
          <ul className="admin-list">
            {history.map((item) => (
              <li key={item._id}>
                <div>
                  <strong>{item.mode}</strong>
                  <code>{item.sourceTownId}</code>
                  <p className="admin-muted">
                    Backup created: {formatTime(item.exportedAt)} · imported:{' '}
                    {formatTime(item.importedAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </details>
      <ArchivePanel adminToken={adminToken} />
      <IdentityRecoveryPanel adminToken={adminToken} />
      <MigrationPanel adminToken={adminToken} />
      <StoragePolicyPanel adminToken={adminToken} />
    </section>
  );
}
