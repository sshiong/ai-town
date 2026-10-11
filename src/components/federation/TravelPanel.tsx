import { useEffect, useState } from 'react';
import AutonomyPanel from './AutonomyPanel';
import SocialHistoryPanel from './SocialHistoryPanel';
import TravelAuditPanel from './TravelAuditPanel';
import VisitorQueuePanel from './VisitorQueuePanel';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference, type FunctionArgs, type FunctionReturnType } from 'convex/server';
import { adminErrorSummary, deadlineRemaining, isOpenVisit, isReadyDestination, safeReturnSummary, eventProgressSummary } from './uiPolicy';
import { api } from '../../../convex/_generated/api';
import {
  AdminButton,
  EmptyState,
  Field,
  TaskFeedback,
  formatTime,
  useAdminTask,
} from './AdminShared';

const startVisitRef = makeFunctionReference<'mutation',
  FunctionArgs<typeof api.federation.ledger.startVisit> & { allowQueue?: boolean },
  FunctionReturnType<typeof api.federation.ledger.startVisit>>('federation/ledger:startVisit');

export default function TravelPanel({ adminToken }: { adminToken: string }) {
  const convex = useConvex();
  const task = useAdminTask();
  const status = useQuery(api.federation.admin.status, { adminToken });
  const world = useQuery(api.world.defaultWorldStatus);
  const residents = useQuery(api.federation.runtime.listResidents, {
    adminToken,
    worldId: world?.worldId,
  });
  const presence = useQuery(
    api.federation.runtime.worldPresence,
    world ? { worldId: world.worldId } : 'skip',
  );
  const diagnostics = useQuery(api.federation.transport.diagnostics, { adminToken });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const destinations = status?.settings.clock.healthy ? status.peers.filter((peer) => isReadyDestination(peer, now)) : [];
  const available = residents?.filter((resident) => resident.state === 'HOME_ACTIVE') ?? [];
  const openVisits = status?.visits.filter((visit) => isOpenVisit(visit.state)) ?? [];
  return (
    <section className="admin-panel">
      <h2>Travel &amp; visitors</h2>
      <p className="admin-muted">
        The destination runs movement and conversations. Each visitor keeps their identity, model
        and private memory at home.
      </p>
      <TaskFeedback task={task} />
      {!status || !residents ? (
        <p role="status">Loading travel ledger…</p>
      ) : (
        <>
          <dl className="admin-facts">
            <dt>Local residents</dt>
            <dd>{residents.length}</dd>
            <dt>Host places in use</dt>
            <dd>
              {status.capacity.reserved} / {status.capacity.maxVisitors}{' '}
              <span className="admin-muted">including reservations and cleanup</span>
            </dd>
            <dt>Map visitors</dt>
            <dd>{presence?.visitors.length ?? '…'}</dd>
            <dt>Admission</dt>
            <dd>
              {status.settings.enabled && status.identity?.mode === 'ACTIVE'
                ? 'Open subject to peer policy and capacity'
                : 'Closed'}
            </dd>
          </dl>
          {!status.identity ? (
            <EmptyState>
              Create this town's identity in Federation before assigning permanent resident
              identities.
            </EmptyState>
          ) : (
            <AdminButton
              disabled={!!task.pending || !world}
              onClick={() =>
                void task.run(
                  'Registering resident identities',
                  () =>
                    convex.mutation(api.federation.runtime.initializeResidents, {
                      adminToken,
                      worldId: world?.worldId,
                    }),
                  'Resident identities and fixed model bindings are registered.',
                )
              }
            >
              Register existing residents
            </AdminButton>
          )}
          {!status.settings.clock.healthy && <p className="admin-warning" role="alert">
            Clock safety locked: {status.settings.clock.reason}. New visits, renewal and host actions are paused.
            Signed cleanup and committed history delivery remain available. Waiting longer cannot prove clock recovery.
            {status.settings.clock.returnClockHealthy && <> Verified UTC allows saved lease deadlines to drain existing visits; new travel remains locked.</>}
          </p>}
          <details className="admin-disclosure">
            <summary>Time policy &amp; clock recovery</summary>
            <p className="admin-muted">Both towns must use synchronized UTC within 30 seconds. Observing this server’s wall clock cannot prove a continuous drift bound. Every new trip saves the larger of the configured margin or twice the observation gap plus 60 seconds, and its maximum deadline. Probes show connectivity; they never renew a lease.</p>
            <form key={JSON.stringify(status.settings.timePolicy)} className="admin-form" onSubmit={event => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              const policy = Object.fromEntries(Object.keys(status.settings.timePolicy).map(key => [key, Number(fields.get(key))])) as typeof status.settings.timePolicy;
              void task.run('Saving time policy', () => convex.mutation(api.federation.admin.configureTimePolicy, { adminToken, policy }), 'Time policy saved. Existing trips retain their safety margin and deadline.');
            }}>
              {Object.entries(status.settings.timePolicy).map(([key, value]) => {
                const bounds: Record<string, [string, number, number]> = {
                  reservationMs: ['Reservation (ms)', 5000, 120000], leaseMs: ['Lease duration (ms)', 30000, status.settings.maxVisitDurationMs],
                  clockSkewMs: ['Accepted clock skew (ms)', 1000, 30000], probeFreshnessMs: ['Probe freshness (ms)', 20000, 300000],
                  probeIntervalMs: ['Probe interval (ms)', 10000, 120000], gapTimeoutMs: ['Stream gap timeout (ms)', 5000, 120000],
                  returnMarginMs: ['Return safety margin (ms)', 60000, 600000], clockObservationGapMs: ['Maximum clock observation gap (ms)', 30000, 600000],
                  requestTimeoutMs: ['Transport request timeout (ms)', 1000, 30000],
                };
                const [label, min, max] = bounds[key];
                return <Field key={key} label={`${label} · ${min}–${max}`}><input type="number" name={key} min={min} max={max} step="1" defaultValue={value} required /></Field>;
              })}
              <div className="admin-form-actions"><AdminButton type="submit" disabled={!!task.pending}>Save time policy</AdminButton></div>
            </form>
            {!status.settings.clock.healthy && <form className="admin-form" onSubmit={event => {
              event.preventDefault();
              void task.run('Confirming clock recovery', () => convex.mutation(api.federation.admin.confirmClockRecovery, { adminToken, synchronizedUtcConfirmed: new FormData(event.currentTarget).get('utc') === 'on' }), 'Clock safety unlocked after operator confirmation.');
            }}>
              <label className="admin-check"><input type="checkbox" name="utc" required /> I verified synchronized UTC on this server.</label>
              <AdminButton type="button" disabled={!!task.pending} onClick={event => {
                const form = event.currentTarget.closest('form');
                if (!form?.reportValidity()) return;
                void task.run('Confirming UTC for return deadlines', () => convex.mutation(api.federation.admin.confirmReturnClock, { adminToken, synchronizedUtcConfirmed: new FormData(form).get('utc') === 'on' }), 'UTC confirmed for saved return deadlines. Admission stays locked until all visits end.');
              }}>Verify UTC for existing return deadlines</AdminButton>
              <AdminButton type="submit" disabled={!!task.pending || status.settings.activeVisitsRemain}>Confirm clock recovery after all visits end</AdminButton>
            </form>}
          </details>
          <h3>Send a resident on a visit</h3>
          {!world && (
            <EmptyState>No default world exists. Initialize the local simulation first.</EmptyState>
          )}
          {!destinations.length && (
            <EmptyState>
              No town is ready for travel. Approve pairing, allow outgoing visits and run a
              successful two-way probe in Federation. This version requires both endpoints to be
              directly reachable.
            </EmptyState>
          )}
          {!available.length && (
            <EmptyState>
              No registered resident is currently at home. Register residents above or wait for
              active travel to finish.
            </EmptyState>
          )}
          <form
            className="admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              const resident = available.find((r) => r.playerId === fields.get('resident'));
              const destination = destinations.find((p) => p.townId === fields.get('destination'));
              if (!resident || !destination || !world) return;
              void task.run(
                'Requesting visit',
                () =>
                  convex.mutation(startVisitRef, {
                    adminToken,
                    peerTownId: destination.townId,
                    worldId: world.worldId,
                    homePlayerId: resident.playerId,
                    allowQueue: fields.get('allowQueue') === 'on',
                  }),
                'Visit requested. Check the ledger for admission or waiting confirmation. Waiting never guarantees departure.',
              );
            }}
          >
            <Field label="Resident">
              <select name="resident" required disabled={!available.length}>
                {available.length ? (
                  available.map((r) => (
                    <option key={r.agentGlobalId} value={r.playerId}>
                      {r.name}
                    </option>
                  ))
                ) : (
                  <option value="">No resident available</option>
                )}
              </select>
            </Field>
            <Field label="Destination">
              <select name="destination" required disabled={!destinations.length}>
                {destinations.length ? (
                  destinations.map((p) => (
                    <option key={p.townId} value={p.townId}>
                      {p.townName} · {p.transportType}
                    </option>
                  ))
                ) : (
                  <option value="">No ready destination</option>
                )}
              </select>
            </Field>
            <label className="admin-check admin-form-actions">
              <input name="allowQueue" type="checkbox" defaultChecked={false} disabled={!!task.pending} />
              Allow waiting if the destination cannot admit this resident yet
            </label>
            <p className="admin-muted admin-form-actions">
              Waiting requires the host to enable its queue. Queue time consumes the existing travel
              authorization; the resident stays on the home map until admission is confirmed.
            </p>
            <div className="admin-form-actions">
              <AdminButton
                type="submit"
                disabled={
                  !!task.pending ||
                  !world ||
                  !available.length ||
                  !destinations.length ||
                  !status.settings.enabled ||
                  status.identity?.mode !== 'ACTIVE'
                }
              >
                Request visit
              </AdminButton>
            </div>
          </form>
          <h3>Residents away from home</h3>
          {!presence?.travelers.length && (
            <EmptyState>
              Everyone is at home. Travelers stay in this list while their local map presence is
              suspended.
            </EmptyState>
          )}
          <ul className="admin-list">
            {presence?.travelers.map((resident) => (
              <li key={resident.agentGlobalId}>
                <div>
                  <strong>{resident.name}</strong>{' '}
                  <span className="admin-badge">{resident.state}</span>
                  <code>{resident.agentGlobalId}</code>
                  <p>
                    Destination:{' '}
                    {status.peers.find((p) => p.townId === resident.hostTownId)?.townName ??
                      resident.hostTownId ??
                      'Preparing'}
                  </p>
                  <p className="admin-muted">Lease expires: {formatTime(resident.leaseExpiry)}</p>
                  {resident.lastError && <p className="admin-error">{resident.lastError}</p>}
                </div>
              </li>
            ))}
          </ul>
          <h3>Visitors on this map</h3>
          {!presence?.visitors.length && (
            <EmptyState>No external visitors are on the map.</EmptyState>
          )}
          <ul className="admin-list">
            {presence?.visitors.map((visitor) => (
              <li key={visitor.visitId}>
                <div>
                  <strong>{visitor.name}</strong>{' '}
                  <span className="admin-badge">From {visitor.homeTownName}</span>
                  <code>{visitor.agentGlobalId}</code>
                  <p className="admin-muted">Lease expires: {formatTime(visitor.leaseExpiry)}</p>
                  {visitor.pendingTurn && (
                    <p>
                      Home is thinking · reply deadline {formatTime(visitor.pendingTurn.deadline)}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <VisitorQueuePanel adminToken={adminToken} />
          <h3>Visit ledger</h3>
          {!status.visits.length && (
            <EmptyState>New visits and their confirmed outcomes will appear here.</EmptyState>
          )}
          <p className="admin-muted">
            Return waits for confirmed host cleanup or lease expiry plus the safety margin. Late
            model replies and stale turns are rejected before chat is committed.
          </p>
          <ul className="admin-list">
            {status.visits.map((visit) => (
              <li key={visit.visitId}>
                <div>
                  <strong>{visit.role === 'home' ? 'Outgoing' : 'Incoming'}</strong>{' '}
                  <span className="admin-badge">{visit.state}</span>
                  {visit.state === 'QUEUED' && (
                    <p>
                      {visit.role === 'home' ? 'Waiting at the destination; still at home.' : 'Waiting before admission; no map visitor.'}
                    </p>
                  )}
                  <code>{visit.visitId}</code>
                  <code>{visit.agentGlobalId}</code>
                  <p className="admin-muted">
                    Lease: {formatTime(visit.leaseExpiry)} · authority {visit.agentAuthorityEpoch} ·
                    lease version {visit.visitLeaseVersion}
                  </p>
                  {visit.state === 'QUEUED' && (
                    <>
                      <p>Queue deadline: {formatTime(visit.queueExpiresAt)} · {deadlineRemaining(visit.queueExpiresAt, now)}</p>
                      <p className="admin-muted">
                        Travel authorization: {deadlineRemaining(visit.leaseExpiry, now)}.
                        Waiting uses this time; departure does not restart it.
                      </p>
                      {visit.queuePaused && <p className="admin-warning">The host paused this request. Its deadlines still apply.</p>}
                      {visit.queueReason && <p className="admin-muted">{adminErrorSummary(visit.queueReason)}</p>}
                    </>
                  )}
                  <p className={visit.communicationState === 'SUSPECT_HOST' ? 'admin-warning' : 'admin-muted'}>
                    Connection: {visit.communicationState === 'SUSPECT_HOST' ? 'Confirming peer status; connectivity loss does not prove cleanup.' : 'Confirmed'}
                    {visit.lastVerifiedAt && <> · last two-way verification {formatTime(visit.lastVerifiedAt)}</>}
                  </p>
                  <p>{safeReturnSummary(visit.returnSafety.condition)}</p>
                  <p className="admin-muted">Safe after: {formatTime(visit.returnSafety.safeAfter)} · saved margin {visit.leaseSafetyMs / 1000}s{visit.tripDeadline && <> · trip deadline {formatTime(visit.tripDeadline)}</>}</p>
                  <p className="admin-muted">{eventProgressSummary(visit.lastDurableEventSeq, visit.lastAckedEventSeq, visit.role)}</p>
                  {visit.lastError && <p className="admin-error">{visit.lastError}</p>}
                </div>
                <div className="admin-toolbar">
                  {visit.role === 'home' && (
                    <AdminButton
                      disabled={
                        !!task.pending ||
                        visit.state !== 'ACTIVE' ||
                        !status.settings.enabled ||
                        status.identity?.mode !== 'ACTIVE' ||
                        !destinations.some((p) => p.townId === visit.hostTownId)
                      }
                      onClick={() =>
                        void task.run(
                          'Requesting lease renewal',
                          () =>
                            convex.mutation(api.federation.ledger.renewVisit, {
                              adminToken,
                              visitId: visit.visitId,
                            }),
                          'Renewal sent. The home ledger records the maximum issued lease; check delivery confirmation below.',
                        )
                      }
                    >
                      Renew lease
                    </AdminButton>
                  )}
                  <AdminButton
                    danger
                    disabled={
                      !!task.pending ||
                      !openVisits.some((v) => v.visitId === visit.visitId) ||
                      ['RETURN_PENDING', 'REMOVING'].includes(visit.state)
                    }
                    onClick={() =>
                      void task.run(
                        visit.state === 'QUEUED' ? 'Cancelling waiting request' : 'Requesting safe return',
                        () =>
                          convex.mutation(api.federation.ledger.returnVisit, {
                            adminToken,
                            visitId: visit.visitId,
                          }),
                        visit.state === 'QUEUED'
                          ? 'Cancellation requested. The ledger will confirm that waiting ended and the resident can travel again.'
                          : 'Return requested. The ledger will confirm cleanup and safe resumption at home.',
                      )
                    }
                  >
                    {visit.state === 'QUEUED' ? 'Cancel waiting request' : 'End / return safely'}
                  </AdminButton>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <AutonomyPanel adminToken={adminToken} />
      <SocialHistoryPanel adminToken={adminToken} />
      <TravelAuditPanel adminToken={adminToken} />
      <details className="admin-disclosure">
        <summary>Delivery &amp; recovery diagnostics</summary>
        <p className="admin-muted">
          Unacknowledged messages remain queued. Missing sequence numbers require replay or
          reconciliation; an expired decision is never shown as an executed action.
        </p>
        <AdminButton
          disabled={!!task.pending}
          onClick={() =>
            void task.run(
              'Retrying delivery and recovery',
              () => convex.action(api.federation.transport.retry, { adminToken }),
              'Delivery and reconciliation worker completed. Review errors below.',
            )
          }
        >
          Retry delivery / reconcile
        </AdminButton>
        {diagnostics ? (
          <>
            <h3>Outbox</h3>
            {!diagnostics.outbox.length && <EmptyState>No queued messages.</EmptyState>}
            <ul className="admin-list">
              {diagnostics.outbox.map((message) => (
                <li key={message.messageId}>
                  <div>
                    <strong>{message.type}</strong>{' '}
                    <span className="admin-badge">
                      {message.failedAt ? 'STOPPED' : message.ackedAt ? 'ACKNOWLEDGED' : 'WAITING'}
                    </span>
                    <code>{message.messageId}</code>
                    <p className="admin-muted">
                      Attempts {message.attempts} ·{' '}
                      {message.failedAt
                        ? `stopped ${formatTime(message.failedAt)}`
                        : message.ackedAt
                          ? `acknowledged ${formatTime(message.ackedAt)}`
                          : `retry ${formatTime(message.nextRetryAt)}`}
                    </p>
                    {message.lastError && <p className="admin-error">{message.lastError}</p>}
                  </div>
                </li>
              ))}
            </ul>
            <h3>Inbox &amp; stream cursors</h3>
            <pre className="admin-report">
              {JSON.stringify({ inbox: diagnostics.inbox, streams: diagnostics.streams }, null, 2)}
            </pre>
          </>
        ) : (
          <p role="status">Loading delivery diagnostics…</p>
        )}
      </details>
    </section>
  );
}
