import { useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { AdminButton, EmptyState, Field, TaskFeedback, formatTime, useAdminTask } from './AdminShared';

type PolicyStatus = {
  maximum: number;
  denied: { agentGlobalId: string; updatedAt: number }[];
  audit: {
    _id: string; agentGlobalId: string; operation: 'DENY' | 'ALLOW';
    operator: string; reason: string; createdAt: number;
  }[];
};
const statusRef = makeFunctionReference<'query', { adminToken: string }, PolicyStatus>(
  'federation/residentPolicy:status',
);
const setRef = makeFunctionReference<'mutation', {
  adminToken: string; agentGlobalId: string; denied: boolean; operator: string; reason: string;
}, unknown>('federation/residentPolicy:set');

export default function ResidentPolicyPanel({ adminToken }: { adminToken: string }) {
  const convex = useConvex();
  const task = useAdminTask();
  const status = useQuery(statusRef, adminToken ? { adminToken } : 'skip');
  const [agentGlobalId, setAgentGlobalId] = useState('');
  const [operation, setOperation] = useState('DENY');
  const busy = !adminToken || !!task.pending;
  return (
    <section aria-label="Resident admission policy">
      <h3>Resident admission policy</h3>
      <p className="admin-muted">
        Deny new visits by a resident's global ID. Waiting requests are rejected at the next
        admission check. Reserved and active visits keep their existing lease and return path.
      </p>
      <TaskFeedback task={task} />
      {!adminToken ? <EmptyState>Administrator access is required to manage resident admission.</EmptyState> : (
        <>
          <form className="admin-form" onSubmit={event => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            void task.run('Saving resident admission policy', () => convex.mutation(setRef, {
              adminToken, agentGlobalId, denied: operation === 'DENY',
              operator: String(fields.get('operator')).trim(), reason: String(fields.get('reason')).trim(),
            }), operation === 'DENY' ? 'Resident denied for new visits.' : 'Resident restriction removed. Normal admission checks still apply.');
          }}>
            <Field label="Resident global ID" hint="Use the exact Home town ID /agent: resident ID, without spaces. Names are not identities.">
              <input value={agentGlobalId} onChange={event => setAgentGlobalId(event.target.value)}
                required maxLength={300} disabled={busy} placeholder="town-id/agent:resident-id" />
            </Field>
            <Field label="New visits">
              <select value={operation} onChange={event => setOperation(event.target.value)} disabled={busy}>
                <option value="DENY">Deny this resident</option>
                <option value="ALLOW">Remove resident restriction</option>
              </select>
            </Field>
            <Field label="Operator label" hint="A label supplied by the administrator. Access is authenticated by the local administrator token.">
              <input name="operator" required maxLength={100} disabled={busy} />
            </Field>
            <Field label="Private review reason" hint="Visible only in administrator audit history. Other towns receive a general refusal code.">
              <input name="reason" required maxLength={1000} disabled={busy} />
            </Field>
            <div className="admin-form-actions">
              <AdminButton type="submit" danger={operation === 'DENY'} disabled={busy}>Save resident policy</AdminButton>
            </div>
          </form>
          {!status ? <p role="status">Loading resident policy...</p> : (
            <>
              <p>{status.denied.length} / {status.maximum} residents denied new visits</p>
              {!status.denied.length ? <EmptyState>No resident restrictions. Trusted visitors follow the town's normal admission rules.</EmptyState> : (
                <ul className="admin-list">
                  {status.denied.map(row => (
                    <li key={row.agentGlobalId}>
                      <div style={{ minWidth: 0, width: '100%' }}>
                        <code>{row.agentGlobalId}</code>
                        <p className="admin-muted">Updated {formatTime(row.updatedAt)}</p>
                        <AdminButton disabled={busy} onClick={() => {
                          setAgentGlobalId(row.agentGlobalId); setOperation('ALLOW');
                        }}>Select for removal</AdminButton>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <details className="admin-disclosure">
                <summary>Resident policy audit · latest 100 operations</summary>
                {!status.audit.length ? <EmptyState>No resident policy operations yet.</EmptyState> : (
                  <ul className="admin-list">
                    {status.audit.map(row => (
                      <li key={row._id}>
                        <div style={{ minWidth: 0, width: '100%' }}>
                          <strong>{row.operation}</strong> · {formatTime(row.createdAt)}
                          <code>{row.agentGlobalId}</code>
                          <p>{row.operator}: {row.reason}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
