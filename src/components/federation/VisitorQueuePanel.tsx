import { useEffect, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import { AdminButton, EmptyState, Field, TaskFeedback, formatTime, useAdminTask } from './AdminShared';
import { adminErrorSummary, canManageQueuedVisit, deadlineRemaining, type QueuedVisitOperation } from './uiPolicy';

type QueueSummary = {
  enabled: boolean;
  maxQueuedVisits: number;
  visitQueueTtlMs: number;
  visitorQueueMode: 'FIFO' | 'SOURCE_ROUND_ROBIN';
  maxQueuedVisitsPerSourceTown: number | null;
  waiting: number;
  paused: number;
};
type WaitingVisit = {
  visitId: string;
  homeTownId: string;
  profile: { name?: string };
  state: string;
  queuedAt?: number;
  queueExpiresAt?: number;
  queueReason?: string;
  queuePaused?: boolean;
};
const waitingRef = makeFunctionReference<'query', { adminToken: string }, WaitingVisit[]>(
  'federation/ledger:waitingVisits',
);
const manageRef = makeFunctionReference<'mutation', {
  adminToken: string; visitId: string; operation: QueuedVisitOperation;
}, unknown>('federation/ledger:manageQueuedVisit');
const configureRef = makeFunctionReference<'mutation', {
  adminToken: string; enabled: boolean; maxQueuedVisits: number; visitQueueTtlMs: number;
  mode: 'FIFO' | 'SOURCE_ROUND_ROBIN'; maxQueuedVisitsPerSourceTown: number | null;
}, unknown>('federation/resourceMonitoring:configureVisitorQueue');

export default function VisitorQueuePanel({ adminToken, configurationOnly = false }: {
  adminToken: string;
  configurationOnly?: boolean;
}) {
  const convex = useConvex();
  const task = useAdminTask();
  const status = useQuery(api.federation.admin.status, adminToken ? { adminToken } : 'skip');
  const waiting = useQuery(waitingRef, adminToken && !configurationOnly ? { adminToken } : 'skip');
  const summary = (status?.resources as (NonNullable<typeof status>['resources'] & {
    visitorQueue?: QueueSummary;
  }) | undefined)?.visitorQueue;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const busy = !adminToken || !!task.pending;
  const admissionEnabled = status?.settings.enabled && status.identity?.mode === 'ACTIVE';
  function manage(visit: WaitingVisit, operation: QueuedVisitOperation) {
    const feedback: Record<QueuedVisitOperation, string> = {
      PAUSE: 'Waiting request paused. Its original expiry still applies.',
      RESUME: 'Waiting request resumed. Fairness and admission checks still apply.',
      REJECT: 'Waiting request rejected. Home will reconcile the cancelled request.',
      PROMOTE: 'Admission check completed. Review the latest queue and visit ledger for the result.',
    };
    void task.run(
      operation === 'PROMOTE' ? 'Checking waiting admission' : 'Updating waiting request',
      () => convex.mutation(manageRef, { adminToken, visitId: visit.visitId, operation }),
      feedback[operation],
    );
  }
  return (
    <section aria-label={configurationOnly ? 'Visitor waiting policy' : 'Incoming visitor waiting queue'}>
      <h3>{configurationOnly ? 'Visitor waiting policy' : 'Incoming visitor waiting queue'}</h3>
      <p className="admin-muted">
        Waiting visitors stay at home until admission is confirmed. Waiting uses their existing
        travel authorization time; it creates no map visitor or reservation.
      </p>
      <TaskFeedback task={task} />
      {!adminToken ? (
        <EmptyState>Administrator access is required to view or manage waiting requests.</EmptyState>
      ) : !summary ? (
        <p role="status">Loading visitor waiting policy…</p>
      ) : (
        <>
          <p>
            <strong>{summary.enabled ? 'Waiting enabled' : 'Waiting disabled'}</strong>{' '}
            · {summary.waiting} / {summary.maxQueuedVisits} waiting · {summary.paused} paused
          </p>
          <p className="admin-muted">
            {summary.visitorQueueMode === 'FIFO' ? 'Oldest eligible request first' : 'Source towns take turns; oldest eligible request within each source'}
            {' '}· waiting limit {summary.visitQueueTtlMs / 1000}s
            {' '}· source waiting cap {summary.maxQueuedVisitsPerSourceTown ?? 'No separate cap'}
          </p>
          {configurationOnly && (
            <form
              className="admin-form"
              key={JSON.stringify([summary.enabled, summary.maxQueuedVisits, summary.visitQueueTtlMs,
                summary.visitorQueueMode, summary.maxQueuedVisitsPerSourceTown])}
              onSubmit={event => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                const sourceCap = String(fields.get('sourceCap')).trim();
                const mode = fields.get('mode');
                if (mode !== 'FIFO' && mode !== 'SOURCE_ROUND_ROBIN') return;
                void task.run('Saving visitor waiting policy', () => convex.mutation(configureRef, {
                  adminToken, enabled: fields.get('enabled') === 'on',
                  maxQueuedVisits: Number(fields.get('maximum')),
                  visitQueueTtlMs: Number(fields.get('seconds')) * 1000,
                  mode, maxQueuedVisitsPerSourceTown: sourceCap === '' ? null : Number(sourceCap),
                }), 'Visitor waiting policy saved. Existing waiting deadlines do not restart.');
              }}
            >
              <label className="admin-check admin-form-actions">
                <input name="enabled" type="checkbox" defaultChecked={summary.enabled} disabled={busy} />
                Accept requests that explicitly allow waiting
              </label>
              <Field label="Maximum waiting requests (1–1000)">
                <input name="maximum" type="number" min={1} max={1000} step={1}
                  defaultValue={summary.maxQueuedVisits} required disabled={busy} />
              </Field>
              <Field label="Maximum queue wait (seconds, 1–3600)"
                hint="The earlier of this deadline and the travel authorization expiry applies. Pausing does not extend either deadline.">
                <input name="seconds" type="number" min={1} max={3600} step={0.001}
                  defaultValue={summary.visitQueueTtlMs / 1000} required disabled={busy} />
              </Field>
              <Field label="Waiting order">
                <select name="mode" defaultValue={summary.visitorQueueMode} disabled={busy}>
                  <option value="SOURCE_ROUND_ROBIN">Source towns take turns</option>
                  <option value="FIFO">Oldest eligible request first</option>
                </select>
              </Field>
              <Field label="Waiting requests per source town (0–1000)"
                hint="Leave blank for no separate source waiting cap. Zero blocks new waiting requests from every source; this is separate from visitor slots.">
                <input name="sourceCap" type="number" min={0} max={1000} step={1}
                  defaultValue={summary.maxQueuedVisitsPerSourceTown ?? ''} disabled={busy} />
              </Field>
              <p className="admin-muted admin-form-actions">
                Turning waiting off ends the {summary.waiting} current waiting request(s) and informs their home towns.
                Lowering a cap preserves existing requests under their original deadlines.
                Reserved and active visits keep their normal return path.
              </p>
              <div className="admin-form-actions">
                <AdminButton type="submit" disabled={busy}>Save waiting policy</AdminButton>
              </div>
            </form>
          )}
        </>
      )}
      {!configurationOnly && adminToken && (
        <>
          <p className="admin-muted">
            Pause, resume and reject apply to the selected request. Check admission advances the
            fair queue and may admit another eligible request first. Trust and resource limits
            still apply; admission is never guaranteed.
          </p>
          {waiting === undefined ? <p role="status">Loading waiting requests…</p> : !waiting.length ? (
            <EmptyState>No incoming requests are waiting. A trusted traveler must allow waiting, and this host must enable it.</EmptyState>
          ) : (
            <ul className="admin-list">
              {waiting.map(visit => (
                <li key={visit.visitId}>
                  <div style={{ minWidth: 0, width: '100%' }}>
                    <strong>{visit.profile.name ?? 'Waiting visitor'}</strong>{' '}
                    <span className="admin-badge">{visit.queuePaused ? 'PAUSED' : visit.state}</span>
                    <code>{visit.visitId}</code>
                    <p>From {status?.peers.find(p => p.townId === visit.homeTownId)?.townName ?? visit.homeTownId}</p>
                    <p className="admin-muted">Waiting since {formatTime(visit.queuedAt)}</p>
                    <p>Queue expiry: {formatTime(visit.queueExpiresAt)} · {deadlineRemaining(visit.queueExpiresAt, now)}</p>
                    {visit.queueReason && <p className="admin-muted">{adminErrorSummary(visit.queueReason)}</p>}
                    {visit.queuePaused && <p className="admin-warning">Paused by the host. The waiting deadline continues.</p>}
                    <div className="admin-toolbar">
                      <AdminButton disabled={busy || !summary?.enabled || !admissionEnabled || !canManageQueuedVisit(visit, 'PROMOTE', now)}
                        onClick={() => manage(visit, 'PROMOTE')}>Check admission</AdminButton>
                      <AdminButton disabled={busy || !canManageQueuedVisit(visit, visit.queuePaused ? 'RESUME' : 'PAUSE', now)}
                        onClick={() => manage(visit, visit.queuePaused ? 'RESUME' : 'PAUSE')}>
                        {visit.queuePaused ? 'Resume waiting' : 'Pause waiting'}
                      </AdminButton>
                      <AdminButton danger disabled={busy || !canManageQueuedVisit(visit, 'REJECT', now)}
                        onClick={() => manage(visit, 'REJECT')}>Reject request</AdminButton>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
