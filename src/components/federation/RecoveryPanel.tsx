import { useEffect, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { AdminButton, EmptyState, TaskFeedback, formatTime, useAdminTask } from './AdminShared';
import { adminErrorSummary, canResumeRestoredResident } from './uiPolicy';

export default function RecoveryPanel({ adminToken }: { adminToken: string }) {
  const convex = useConvex();
  const task = useAdminTask();
  const pending = useQuery(api.federation.backup.restoredResidents, { adminToken });
  const residents = useQuery(api.federation.runtime.listResidents, { adminToken });
  const [sourceStopped, setSourceStopped] = useState(false);
  const pendingIdentitySet = pending
    ?.map((resident) => resident.agentGlobalId)
    .sort()
    .join('|');
  useEffect(() => setSourceStopped(false), [pendingIdentitySet]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <section aria-label="Restored traveler reconciliation">
      <h3>Restored travelers awaiting reconciliation</h3>
      <p className="admin-muted">
        Imported travel is historical evidence. These residents stay suspended until the old source
        cannot renew their host lease, the safe return time has passed, and their target world is
        paused. Recovery restores the original resident identity without replaying old visits or
        remote actions.
      </p>
      <TaskFeedback task={task} />
      {!pending ? (
        <p role="status">Loading restored travelers…</p>
      ) : !pending.length ? (
        <EmptyState>No restored travelers need reconciliation.</EmptyState>
      ) : (
        <>
          <label className="admin-check">
            <input
              type="checkbox"
              checked={sourceStopped}
              disabled={!!task.pending}
              onChange={(event) => setSourceStopped(event.target.checked)}
            />{' '}
            I confirm the old source deployment is stopped and cannot renew leases. This target is
            the only deployment using this identity.
          </label>
          <ul className="admin-list">
            {pending.map((resident) => (
              <li key={resident.agentGlobalId}>
                <div className="admin-peer">
                  <strong>
                    {residents?.find((r) => r.agentGlobalId === resident.agentGlobalId)?.name ??
                      resident.playerId}
                  </strong>{' '}
                  <span className="admin-badge">NEEDS_RECONCILIATION</span>
                  <code>{resident.agentGlobalId}</code>
                  <code>World: {resident.worldId}</code>
                  <code>Previous visit: {resident.visitId ?? 'No visit evidence'}</code>
                  <p>
                    Safe return after:{' '}
                    {resident.safeAfter === null
                      ? 'Unavailable — inspect recovery evidence'
                      : formatTime(resident.safeAfter)}
                  </p>
                  {resident.safeAfter !== null && resident.safeAfter > now && (
                    <p className="admin-muted">
                      Safety wait remaining: {Math.ceil((resident.safeAfter - now) / 1000)} seconds.
                      The old source may have issued a newer lease after this snapshot.
                    </p>
                  )}
                  {!canResumeRestoredResident(resident, now) && (
                    <p className="admin-warning">
                      {!resident.engineStopped &&
                      resident.safeAfter !== null &&
                      resident.safeAfter <= now
                        ? 'Pause this resident’s target world before reconciliation.'
                        : adminErrorSummary(
                            resident.reason ?? 'Recovery evidence requires administrator review.',
                          )}
                    </p>
                  )}
                  <div className="admin-toolbar">
                    <AdminButton
                      disabled={
                        !!task.pending ||
                        !sourceStopped ||
                        !canResumeRestoredResident(resident, now)
                      }
                      onClick={() =>
                        void task.run(
                          'Reconciling and restoring resident',
                          async () => {
                            await convex.mutation(api.federation.backup.reconcileRestoredResident, {
                              adminToken,
                              agentGlobalId: resident.agentGlobalId,
                              sourceStopped,
                            });
                            setSourceStopped(false);
                          },
                          'Resident safely restored at home with the same identity and model binding. Resume the target simulation after all recovery checks complete.',
                        )
                      }
                    >
                      Reconcile &amp; return home
                    </AdminButton>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
