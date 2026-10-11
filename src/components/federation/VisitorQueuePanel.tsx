import { useLocale } from '../../i18n';
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
  const { t } = useLocale();
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
      PAUSE: t("Waiting request paused. Its original expiry still applies."),
      RESUME: t("Waiting request resumed. Fairness and admission checks still apply."),
      REJECT: t("Waiting request rejected. Home will reconcile the cancelled request."),
      PROMOTE: t("Admission check completed. Review the latest queue and visit ledger for the result."),
    };
    void task.run(
      operation === 'PROMOTE' ? t("Checking waiting admission") : t("Updating waiting request"),
      () => convex.mutation(manageRef, { adminToken, visitId: visit.visitId, operation }),
      feedback[operation],
    );
  }
  return (
    <section aria-label={configurationOnly ? t("Visitor waiting policy") : t("Incoming visitor waiting queue")}>
      <h3>{configurationOnly ? t("Visitor waiting policy") : t("Incoming visitor waiting queue")}</h3>
      <p className="admin-muted">
        {t("Waiting visitors stay at home until admission is confirmed. Waiting uses their existing travel authorization time; it creates no map visitor or reservation.")}
      </p>
      <TaskFeedback task={task} />
      {!adminToken ? (
        <EmptyState>{t("Administrator access is required to view or manage waiting requests.")}</EmptyState>
      ) : !summary ? (
        <p role="status">{t("Loading visitor waiting policy…")}</p>
      ) : (
        <>
          <p>
            <strong>{summary.enabled ? t("Waiting enabled") : t("Waiting disabled")}</strong>{' '}
            · {summary.waiting} / {summary.maxQueuedVisits} {t("waiting ·")} {summary.paused} {t("paused")}
          </p>
          <p className="admin-muted">
            {summary.visitorQueueMode === 'FIFO' ? t("Oldest eligible request first") : t("Source towns take turns; oldest eligible request within each source")}
            {' '}{t("· waiting limit")} {summary.visitQueueTtlMs / 1000}{t("s")}
            {' '}{t("· source waiting cap")} {summary.maxQueuedVisitsPerSourceTown ?? t("No separate cap")}
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
                void task.run(t("Saving visitor waiting policy"), () => convex.mutation(configureRef, {
                  adminToken, enabled: fields.get('enabled') === 'on',
                  maxQueuedVisits: Number(fields.get('maximum')),
                  visitQueueTtlMs: Number(fields.get('seconds')) * 1000,
                  mode, maxQueuedVisitsPerSourceTown: sourceCap === '' ? null : Number(sourceCap),
                }), t("Visitor waiting policy saved. Existing waiting deadlines do not restart."));
              }}
            >
              <label className="admin-check admin-form-actions">
                <input name="enabled" type="checkbox" defaultChecked={summary.enabled} disabled={busy} />
                {t("Accept requests that explicitly allow waiting")}
              </label>
              <Field label={t("Maximum waiting requests (1–1000)")}>
                <input name="maximum" type="number" min={1} max={1000} step={1}
                  defaultValue={summary.maxQueuedVisits} required disabled={busy} />
              </Field>
              <Field label={t("Maximum queue wait (seconds, 1–3600)")}
                hint={t("The earlier of this deadline and the travel authorization expiry applies. Pausing does not extend either deadline.")}>
                <input name="seconds" type="number" min={1} max={3600} step={0.001}
                  defaultValue={summary.visitQueueTtlMs / 1000} required disabled={busy} />
              </Field>
              <Field label={t("Waiting order")}>
                <select name="mode" defaultValue={summary.visitorQueueMode} disabled={busy}>
                  <option value="SOURCE_ROUND_ROBIN">{t("Source towns take turns")}</option>
                  <option value="FIFO">{t("Oldest eligible request first")}</option>
                </select>
              </Field>
              <Field label={t("Waiting requests per source town (0–1000)")}
                hint={t("Leave blank for no separate source waiting cap. Zero blocks new waiting requests from every source; this is separate from visitor slots.")}>
                <input name="sourceCap" type="number" min={0} max={1000} step={1}
                  defaultValue={summary.maxQueuedVisitsPerSourceTown ?? ''} disabled={busy} />
              </Field>
              <p className="admin-muted admin-form-actions">
                {t("Turning waiting off ends the")} {summary.waiting} {t("current waiting request(s) and informs their home towns. Lowering a cap preserves existing requests under their original deadlines. Reserved and active visits keep their normal return path.")}
              </p>
              <div className="admin-form-actions">
                <AdminButton type="submit" disabled={busy}>{t("Save waiting policy")}</AdminButton>
              </div>
            </form>
          )}
        </>
      )}
      {!configurationOnly && adminToken && (
        <>
          <p className="admin-muted">
            {t("Pause, resume and reject apply to the selected request. Check admission advances the fair queue and may admit another eligible request first. Trust and resource limits still apply; admission is never guaranteed.")}
          </p>
          {waiting === undefined ? <p role="status">{t("Loading waiting requests…")}</p> : !waiting.length ? (
            <EmptyState>{t("No incoming requests are waiting. A trusted traveler must allow waiting, and this host must enable it.")}</EmptyState>
          ) : (
            <ul className="admin-list">
              {waiting.map(visit => (
                <li key={visit.visitId}>
                  <div style={{ minWidth: 0, width: '100%' }}>
                    <strong>{visit.profile.name ?? t("Waiting visitor")}</strong>{' '}
                    <span className="admin-badge">{visit.queuePaused ? 'PAUSED' : visit.state}</span>
                    <code>{visit.visitId}</code>
                    <p>{t("From")} {status?.peers.find(p => p.townId === visit.homeTownId)?.townName ?? visit.homeTownId}</p>
                    <p className="admin-muted">{t("Waiting since")} {formatTime(visit.queuedAt)}</p>
                    <p>{t("Queue expiry:")} {formatTime(visit.queueExpiresAt)} · {deadlineRemaining(visit.queueExpiresAt, now, t)}</p>
                    {visit.queueReason && <p className="admin-muted">{adminErrorSummary(visit.queueReason, t)}</p>}
                    {visit.queuePaused && <p className="admin-warning">{t("Paused by the host. The waiting deadline continues.")}</p>}
                    <div className="admin-toolbar">
                      <AdminButton disabled={busy || !summary?.enabled || !admissionEnabled || !canManageQueuedVisit(visit, 'PROMOTE', now)}
                        onClick={() => manage(visit, 'PROMOTE')}>{t("Check admission")}</AdminButton>
                      <AdminButton disabled={busy || !canManageQueuedVisit(visit, visit.queuePaused ? 'RESUME' : 'PAUSE', now)}
                        onClick={() => manage(visit, visit.queuePaused ? 'RESUME' : 'PAUSE')}>
                        {visit.queuePaused ? t("Resume waiting") : t("Pause waiting")}
                      </AdminButton>
                      <AdminButton danger disabled={busy || !canManageQueuedVisit(visit, 'REJECT', now)}
                        onClick={() => manage(visit, 'REJECT')}>{t("Reject request")}</AdminButton>
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
