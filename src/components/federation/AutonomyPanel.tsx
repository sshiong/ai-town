import { useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference, type FunctionArgs, type FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import {
  AdminButton,
  EmptyState,
  Field,
  TaskFeedback,
  formatTime,
  useAdminTask,
} from './AdminShared';

const configureRef = makeFunctionReference<'mutation',
  FunctionArgs<typeof api.federation.autonomy.configure> & { allowQueue?: boolean },
  FunctionReturnType<typeof api.federation.autonomy.configure>>('federation/autonomy:configure');

export default function AutonomyPanel({ adminToken }: { adminToken: string }) {
  const convex = useConvex();
  const task = useAdminTask();
  const [selected, setSelected] = useState('');
  const world = useQuery(api.world.defaultWorldStatus);
  const residents = useQuery(api.federation.runtime.listResidents, {
    adminToken,
    worldId: world?.worldId,
  });
  const status = useQuery(api.federation.admin.status, { adminToken });
  const data = useQuery(api.federation.autonomy.list, { adminToken, worldId: world?.worldId });
  const resident = residents?.find((r) => r.agentGlobalId === selected) ?? residents?.[0];
  const policy = data?.policies.find((p) => p.agentGlobalId === resident?.agentGlobalId);
  const peers =
    status?.peers.filter((p) => p.trustState === 'TRUSTED' && p.outboundVisitsAllowed) ?? [];
  return (
    <section className="admin-panel" aria-label="Autonomous travel">
      <h2>Autonomous travel</h2>
      <p className="admin-muted">
        Off by default. Authorize each resident explicitly: their existing idle decision process can
        choose a trusted destination or stay, using their personality, memories and fixed model.
        Current conversations finish before considering travel.
      </p>
      <TaskFeedback task={task} />
      {!data || !residents ? (
        <p role="status">Loading travel authorizations…</p>
      ) : !resident ? (
        <EmptyState>Register resident identities before authorizing autonomous travel.</EmptyState>
      ) : (
        <>
          <Field label="Resident authorization">
            <select value={resident.agentGlobalId} onChange={(e) => setSelected(e.target.value)}>
              {residents.map((r) => (
                <option key={r.agentGlobalId} value={r.agentGlobalId}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <p className="admin-muted">
            Current authorization: {policy?.enabled ? 'Enabled' : 'Disabled'}
            {policy?.enabled && ` · next eligible decision ${formatTime(policy.nextDecisionAt)}`}.
          </p>
          <form
            className="admin-form"
            key={`${resident.agentGlobalId}/${policy?.revision ?? 0}`}
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              void task.run(
                'Saving autonomous travel authorization',
                () =>
                  convex.mutation(configureRef, {
                    adminToken,
                    agentGlobalId: resident.agentGlobalId,
                    enabled: values.get('enabled') === 'on',
                    allowQueue: values.get('allowQueue') === 'on',
                    allowedPeerTownIds: values.getAll('destination').map(String),
                    decisionIntervalMs: Number(values.get('interval')) * 60_000,
                    dailyRequestLimit: Number(values.get('limit')),
                    operator: String(values.get('operator') ?? ''),
                    reason: String(values.get('reason') ?? ''),
                  }),
                'Authorization saved. Only an actual model choice can request a visit; readiness and quotas are checked again when it commits.',
              );
            }}
          >
            <label className="admin-check">
              <input type="checkbox" name="enabled" defaultChecked={policy?.enabled ?? false} />
              Allow this resident to consider autonomous travel
            </label>
            <label className="admin-check">
              <input type="checkbox" name="allowQueue" defaultChecked={policy?.allowQueue ?? false} disabled={!!task.pending} />
              Allow this resident to wait for admission during autonomous travel
            </label>
            <fieldset>
              <legend>Authorized destinations</legend>
              {!peers.length && (
                <p className="admin-muted">No trusted peer allows outgoing visits.</p>
              )}
              {peers.map((p) => (
                <label className="admin-check" key={p.townId}>
                  <input
                    type="checkbox"
                    name="destination"
                    value={p.townId}
                    defaultChecked={policy?.allowedPeerTownIds.includes(p.townId) ?? false}
                  />
                  {p.townName}
                </label>
              ))}
            </fieldset>
            <Field label="Minimum decision interval (minutes)">
              <input
                type="number"
                name="interval"
                min={1}
                max={10080}
                step={1}
                required
                defaultValue={(policy?.decisionIntervalMs ?? 900000) / 60000}
              />
            </Field>
            <Field label="Maximum visit requests in the last 24 hours">
              <input
                type="number"
                name="limit"
                min={1}
                max={24}
                step={1}
                required
                defaultValue={policy?.dailyRequestLimit ?? 2}
              />
            </Field>
            <p className="admin-muted">
              The request quota includes manual requests and refused requests. Offline or revoked
              destinations are never selected. Waiting consumes the existing travel authorization
              and does not trigger another model decision. Saving an authorization change cancels
              autonomous requests that have not departed, including waiting requests. Manual
              requests and visits already underway retain their normal return path.
            </p>
            <Field label="Operator">
              <input name="operator" maxLength={120} required />
            </Field>
            <Field label="Authorization reason">
              <textarea name="reason" maxLength={1000} required />
            </Field>
            <AdminButton type="submit" disabled={!!task.pending}>
              Save resident authorization
            </AdminButton>
          </form>
        </>
      )}
      {!!data?.decisions.length && (
        <>
          <h3>Model travel decisions</h3>
          <ul className="admin-list">
            {data.decisions.map((d) => (
              <li key={d._id}>
                <div>
                  <strong>
                    {residents?.find((r) => r.agentGlobalId === d.agentGlobalId)?.name ??
                      d.playerId}
                  </strong>{' '}
                  <span className="admin-badge">{d.state}</span>
                  <p className="admin-muted">
                    {formatTime(d.createdAt)}
                    {d.destinationTownId &&
                      ` · ${status?.peers.find((p) => p.townId === d.destinationTownId)?.townName ?? d.destinationTownId}`}
                  </p>
                  {d.reason && <p>{d.reason}</p>}
                  {d.error && <p className="admin-error">{d.error}</p>}
                  {d.visitId && <code>{d.visitId}</code>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
