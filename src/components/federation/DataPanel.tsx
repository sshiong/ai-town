import { useEffect, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { readBackupFile, requiresStoppedSource } from './uiPolicy';
import { api } from '../../../convex/_generated/api';
import RecoveryPanel from './RecoveryPanel';
import {
  AdminButton,
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
    label: 'Restore this town',
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

export function downloadBundle(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
  const [report, setReport] =
    useState<FunctionReturnType<typeof api.federation.backup.preflight>>();
  const [result, setResult] =
    useState<FunctionReturnType<typeof api.federation.backup.importBackup>>();
  useEffect(() => {
    setReport(undefined);
    setAcknowledged(false);
  }, [world?.worldId, world?.status]);
  const targetPaused =
    !world || world.status === 'stoppedByDeveloper' || world.status === 'inactive';
  const args = {
    adminToken,
    bundle,
    mode,
    targetWorldId: mode === 'merge' ? world?.worldId : undefined,
    sourceStopped,
    targetEndpoint: mode === 'clone' ? targetEndpoint.trim() : undefined,
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
      <div className="admin-toolbar">
        <AdminButton
          disabled={!!task.pending}
          onClick={() =>
            void task.run(
              'Exporting town snapshot',
              async () =>
                downloadBundle(
                  await convex.action(api.federation.backup.exportTown, { adminToken }),
                  `ai-town-${Date.now()}.json`,
                ),
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
              async () =>
                downloadBundle(
                  await convex.action(api.federation.backup.exportResident, {
                    adminToken,
                    worldId: resident.worldId,
                    playerId: resident.playerId,
                  }),
                  `ai-town-resident-${Date.now()}.json`,
                ),
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
          <AdminButton type="submit" disabled={!!task.pending}>
            Download resident
          </AdminButton>
        </form>
      )}
      <p className="admin-warning">
        This ordinary data snapshot cannot restore trusted identity credentials. Encrypted identity
        key packages are not available in this build. Keep the server's identity encryption secret
        separately; copying the same identity into two active instances risks a clone conflict.
      </p>
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
          hint="Choose an exported AI Town package, up to 5 MiB and the server transaction limit of 500 records. The server validates its digest and structure before import."
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
              if (!file) return;
              void task.run(
                'Reading backup',
                async () => {
                  const parsed = await readBackupFile(file);
                  setBundle(parsed);
                  setFilename(file.name);
                },
                'File loaded. Run preflight to review its scope and conflicts.',
              );
            }}
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
      <p className="admin-muted">{modes.find((item) => item.value === mode)?.description}</p>
      {mode === 'merge' && (
        <p>
          Target world: <code>{world?.worldId ?? 'No default world exists'}</code>
        </p>
      )}
      {(mode === 'restore' || mode === 'migrate') && (
        <p className="admin-warning">
          The active target is backed up before import. Restore and migration require matching
          long-term identity. Do not activate two deployments with the same private key.
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
          </div>
          <p className="admin-muted">
            Vectors require rebuilding in the target's verified space. Imported travel is
            historical; no visitor lease or remote task is reactivated.
          </p>
          <label className="admin-check">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={!!task.pending}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />{' '}
            I reviewed the scope, identity requirements and conflict warnings.
          </label>
          <div className="admin-toolbar">
            <AdminButton
              danger
              disabled={
                !!task.pending ||
                !report.valid ||
                !acknowledged ||
                !!result ||
                (mode !== 'clone' && !targetPaused) ||
                (requiresStoppedSource(mode) && !sourceStopped)
              }
              onClick={() =>
                void task.run(
                  'Importing validated backup',
                  async () => {
                    if (mode === 'restore' || mode === 'migrate')
                      downloadBundle(
                        await convex.action(api.federation.backup.exportTown, { adminToken }),
                        `ai-town-before-import-${Date.now()}.json`,
                      );
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
      <h3>Long-term retention</h3>
      <p className="admin-muted">
        Canonical memory and relationships are retained. Embedding vectors and caches are derived
        data. Delivery records are cleaned only after acknowledgement and safe completion. Storage
        usage and archive budget controls are not exposed by this build.
      </p>
    </section>
  );
}
