import { useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import {
  AdminButton,
  EmptyState,
  Field,
  TaskFeedback,
  formatTime,
  useAdminTask,
} from './AdminShared';

export default function ConflictPanel({ adminToken }: { adminToken: string }) {
  const convex = useConvex();
  const status = useQuery(api.federation.identityConflict.status, { adminToken });
  const town = useQuery(api.federation.admin.status, { adminToken });
  const task = useAdminTask();
  const [selected, setSelected] = useState('');
  const [operator, setOperator] = useState('');
  const [reason, setReason] = useState('');
  const [sourceStopped, setSourceStopped] = useState(false);
  const [decision, setDecision] = useState<'RETAIN_KNOWN' | 'REVOKE_PEER'>('RETAIN_KNOWN');
  const open = status?.conflicts.filter((c) => c.state === 'OPEN') ?? [];
  const conflict = open.find((c) => c._id === selected) ?? open[0];
  const localConflict = conflict?.townId === town?.identity?.townId;
  return (
    <section className="admin-panel" aria-label="Identity conflicts">
      <h2>Identity conflicts</h2>
      <p className="admin-muted">
        A valid signature from a known identity using another deployment instance pauses new
        federation authorizations. Local residents continue their activities; existing visits retain
        their safe return and cleanup paths.
      </p>
      <TaskFeedback task={task} />
      {!status ? (
        <p role="status">Checking identity evidence…</p>
      ) : (
        <>
          {status.quarantined && (
            <p className="admin-error" role="alert">
              This town is quarantined. Resolve every verified conflict after draining visits.
              Federation stays disabled after release; reconnect affected peers and run both probes
              before enabling it.
            </p>
          )}
          {!open.length ? (
            <EmptyState>No unresolved verified identity conflicts.</EmptyState>
          ) : (
            <>
              <Field label="Verified conflict">
                <select
                  value={conflict?._id ?? ''}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setSourceStopped(false);
                  }}
                >
                  {open.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.townId} · {formatTime(c.detectedAt)}
                    </option>
                  ))}
                </select>
              </Field>
              {conflict && (
                <dl className="admin-facts">
                  <dt>Known instance</dt>
                  <dd>
                    <code>{conflict.knownDeploymentInstanceId}</code> · epoch{' '}
                    {conflict.knownDeploymentEpoch}
                  </dd>
                  <dt>Observed instance</dt>
                  <dd>
                    <code>{conflict.observedDeploymentInstanceId}</code> · epoch{' '}
                    {conflict.observedDeploymentEpoch}
                  </dd>
                  <dt>Evidence</dt>
                  <dd>
                    {conflict.source} · {formatTime(conflict.detectedAt)}
                  </dd>
                </dl>
              )}
              <Field label="Operator">
                <input
                  value={operator}
                  maxLength={120}
                  onChange={(e) => setOperator(e.target.value)}
                />
              </Field>
              <Field label="Resolution reason">
                <textarea
                  value={reason}
                  maxLength={1000}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <Field label="Identity decision">
                <select
                  value={localConflict ? 'RETAIN_KNOWN' : decision}
                  onChange={(e) => setDecision(e.target.value as typeof decision)}
                  disabled={localConflict}
                >
                  <option value="RETAIN_KNOWN">
                    Retain the known identity after stopping the conflicting source
                  </option>
                  <option value="REVOKE_PEER">
                    Revoke this peer and require a new verified pairing
                  </option>
                </select>
              </Field>
              <label className="admin-check">
                <input
                  type="checkbox"
                  checked={sourceStopped}
                  onChange={(e) => setSourceStopped(e.target.checked)}
                />
                I have stopped the conflicting source and drained affected visits.
              </label>
              <AdminButton
                disabled={
                  !!task.pending ||
                  !conflict ||
                  !operator.trim() ||
                  !reason.trim() ||
                  !sourceStopped
                }
                onClick={() =>
                  void task.run('Resolving verified identity conflict', async () => {
                    if (!conflict) return;
                    const result = await convex.mutation(api.federation.identityConflict.resolve, {
                      adminToken,
                      conflictId: conflict._id,
                      operator,
                      reason,
                      sourceStopped: true,
                      decision: localConflict ? 'RETAIN_KNOWN' : decision,
                    });
                    setSourceStopped(false);
                    return result.released
                      ? 'Isolation released. Federation remains disabled; repair trust and probe before enabling.'
                      : 'Resolution recorded. Other verified conflicts still require review.';
                  })
                }
              >
                Record resolution
              </AdminButton>
            </>
          )}
          {!!status.conflicts.length && (
            <details>
              <summary>Verified evidence and resolution history</summary>
              <pre className="admin-report">
                {JSON.stringify({ conflicts: status.conflicts, audit: status.audit }, null, 2)}
              </pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}
