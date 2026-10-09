import { useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { Handoff } from '../../../convex/federation/migration';
import { api } from '../../../convex/_generated/api';
import {
  AdminButton,
  downloadBundle,
  EmptyState,
  Field,
  formatTime,
  TaskFeedback,
  useAdminTask,
} from './AdminShared';

export default function MigrationPanel({ adminToken }: { adminToken: string }) {
  const convex = useConvex();
  const task = useAdminTask();
  const status = useQuery(api.federation.admin.status, { adminToken });
  const history = useQuery(api.federation.migration.history, { adminToken });
  const [targetPacket, setTargetPacket] = useState<unknown>();
  const [handoff, setHandoff] = useState<unknown>();
  const local = status?.identity;
  const isDestination =
    history?.some(
      (record) =>
        record.role === 'TARGET' &&
        (record.body as Handoff | undefined)?.target?.deploymentInstanceId ===
          local?.deploymentInstanceId,
    ) ?? false;
  async function readPacket(file: File, setPacket: (packet: unknown) => void) {
    setPacket(undefined);
    await task.run(
      'Reading public migration proof',
      async () => {
        if (file.size > 64 * 1024) throw new Error('Migration proofs must be smaller than 64 KiB.');
        const parsed: unknown = JSON.parse(await file.text());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('Choose an exported migration proof JSON object.');
        setPacket(parsed);
      },
      'Proof loaded. The server verifies its signature when submitted.',
    );
  }
  return (
    <section className="admin-panel">
      <h2>Move this town to another server</h2>
      <p className="admin-muted">
        Recover the same town identity and a consistent archive on the destination first. A signed
        handoff transfers federation authority to its new deployment. Connected towns verify the
        handoff and establish fresh credentials before travel resumes.
      </p>
      <TaskFeedback task={task} />
      {!local ? (
        <EmptyState>Restore or initialize a town identity before preparing a move.</EmptyState>
      ) : (
        <>
          <h3>1. Freeze the original town</h3>
          <p className="admin-muted">
            Freezing permanently closes federation authority on this deployment. Existing visits are
            cleaned up; local simulation can continue. After cleanup, pause simulation and export
            the consistent archive and encrypted identity package above.
          </p>
          <form
            className="admin-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              void task.run(
                'Freezing the original deployment',
                async () => {
                  await convex.mutation(api.federation.migration.freezeSource, {
                    adminToken,
                    operator: String(fields.get('operator')).trim(),
                  });
                },
                'Source frozen. Repeat cleanup if visits remain, then pause simulation before signing the handoff.',
              );
            }}
          >
            <Field label="Operator name" hint="Recorded with the signed handoff.">
              <input name="operator" required maxLength={100} />
            </Field>
            <AdminButton
              type="submit"
              danger
              disabled={!!task.pending || !['ACTIVE', 'MIGRATING_OUT'].includes(local.mode)}
            >
              {local.mode === 'MIGRATING_OUT'
                ? 'Continue source cleanup'
                : 'Freeze source authority'}
            </AdminButton>
          </form>
          <h3>2. Prepare the restored destination</h3>
          <p className="admin-muted">
            On the destination, finish restoring the encrypted identity and town archive, and
            reconcile all restored travelers. Keep federation disabled while preparing this proof.
          </p>
          <form
            className="admin-inline-form"
            key={local.endpoint}
            onSubmit={(event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              void task.run(
                'Preparing the destination',
                async () => {
                  const packet = await convex.action(api.federation.migration.prepareTarget, {
                    adminToken,
                    endpoint: String(fields.get('endpoint')).trim(),
                  });
                  downloadBundle(packet, 'ai-town-migration-target.json');
                },
                'Public destination proof downloaded. Load it on the frozen source town.',
              );
            }}
          >
            <Field label="Destination HTTPS endpoint">
              <input
                name="endpoint"
                type="text"
                inputMode="url"
                defaultValue={local.endpoint}
                required
              />
            </Field>
            <AdminButton
              type="submit"
              disabled={
                !!task.pending ||
                status.settings.enabled ||
                !['ACTIVE', 'NEEDS_RECONCILIATION', 'MIGRATING_IN'].includes(local.mode)
              }
            >
              Download destination proof
            </AdminButton>
          </form>
          <h3>3. Sign on the source; activate on the destination</h3>
          <Field label="Destination proof (on the frozen source)">
            <input
              type="file"
              accept=".json,application/json"
              disabled={!!task.pending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readPacket(file, setTargetPacket);
              }}
            />
          </Field>
          <AdminButton
            disabled={!!task.pending || !targetPacket || local.mode !== 'MIGRATING_OUT'}
            onClick={() =>
              void task.run(
                'Signing the migration handoff',
                async () => {
                  const packet = await convex.mutation(api.federation.migration.signHandoff, {
                    adminToken,
                    targetPacket,
                  });
                  downloadBundle(packet, 'ai-town-migration-handoff.json');
                },
                'Public signed handoff downloaded. Load it on the recovered destination.',
              )
            }
          >
            Sign and download handoff
          </AdminButton>
          <Field label="Signed handoff (on the destination)">
            <input
              type="file"
              accept=".json,application/json"
              disabled={!!task.pending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readPacket(file, setHandoff);
              }}
            />
          </Field>
          <AdminButton
            disabled={
              !!task.pending || !handoff || !['MIGRATING_IN', 'ACTIVE'].includes(local.mode)
            }
            onClick={() =>
              void task.run(
                'Verifying and activating the destination',
                async () => {
                  await convex.mutation(api.federation.migration.activateTarget, {
                    adminToken,
                    packet: handoff,
                  });
                },
                'Destination authority verified. Reconnect each trusted town, then run its independent reverse probe.',
              )
            }
          >
            Verify handoff and activate destination
          </AdminButton>
          <h3>4. Reconnect trusted towns</h3>
          <ul className="admin-list">
            {status.peers
              .filter((p) => ['MIGRATION_PENDING', 'TRUSTED'].includes(p.trustState))
              .map((p) => (
                <li key={p.townId}>
                  <strong>{p.townName}</strong>{' '}
                  <span className="admin-badge">{p.channelState}</span>
                  <AdminButton
                    disabled={!!task.pending || local.mode !== 'ACTIVE' || !isDestination}
                    onClick={() =>
                      void task.run(
                        'Reconnecting the migrated town',
                        async () => {
                          await convex.action(api.federation.migration.notifyPeer, {
                            adminToken,
                            peerTownId: p.townId,
                          });
                        },
                        'Handoff verified and local probe completed. The other town must complete its own reverse probe.',
                      )
                    }
                  >
                    Verify migrated link
                  </AdminButton>
                </li>
              ))}
          </ul>
          <details className="admin-disclosure">
            <summary>Signed migration history</summary>
            {!history?.length ? (
              <EmptyState>No signed handoffs recorded.</EmptyState>
            ) : (
              <ul className="admin-list">
                {history.map((record) => (
                  <li key={record._id}>
                    <strong>{record.role}</strong>
                    <code>{record.handoffId}</code>
                    <p>{formatTime(record.acceptedAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </>
      )}
    </section>
  );
}
