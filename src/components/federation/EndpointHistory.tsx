import { useLocale } from '../../i18n';
import { useConvex, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { AdminButton, EmptyState, TaskFeedback, formatTime, useAdminTask } from './AdminShared';

export default function EndpointHistory({ adminToken }: { adminToken: string }) {
  const { t } = useLocale();
  const convex = useConvex();
  const task = useAdminTask();
  const history = useQuery(api.federation.endpoints.history, { adminToken });
  return (
    <details>
      <summary>{t("Signed address updates")} {history && t("· sequence {sequence}", { sequence: history.sequence })}</summary>
      <p className="admin-muted">
        {t("Connected towns verify each new address with an authenticated challenge. Failed delivery retries automatically; use the peer address form if its previous route is unavailable.")}
      </p>
      <TaskFeedback task={task} />
      {!history ? (
        <p role="status">{t("Loading address updates...")}</p>
      ) : (
        <>
          {!history.updates.length && <EmptyState>{t("No address updates yet.")}</EmptyState>}
          <ul className="admin-list">
            {history.updates.map((update) => (
              <li key={`${update.direction}:${update.peerTownId}:${update.updateId}`}>
                <strong>{update.peerTownId}</strong>{' '}
                <span className="admin-badge">
                  {update.direction} · {update.state}
                </span>
                <p>
                  {update.previousEndpoint} → {update.newEndpoint}
                </p>
                <p className="admin-muted">
                  {t("Sequence")} {update.sequence} {t("· attempts")} {update.attempts}
                </p>
                {update.lastError && <p className="admin-error">{update.lastError}</p>}
                {update.direction === 'OUTBOUND' &&
                  ['PENDING', 'RUNNING'].includes(update.state) && (
                    <AdminButton
                      disabled={!!task.pending}
                      onClick={() =>
                        void task.run(t("Retrying signed address update"), async () => {
                          await convex.action(api.federation.endpoints.retry, {
                            adminToken,
                            peerTownId: update.peerTownId,
                            updateId: update.updateId,
                          });
                        })
                      }
                    >
                      {t("Retry delivery")}
                    </AdminButton>
                  )}
              </li>
            ))}
          </ul>
          <details>
            <summary>{t("Address audit history")}</summary>
            <ul className="admin-list">
              {history.audit.map((entry) => (
                <li key={entry._id}>
                  <strong>{entry.operation}</strong> · {formatTime(entry.createdAt)}
                  <p>
                    {entry.operator}: {entry.reason}
                  </p>
                  <p>{entry.newEndpoint}</p>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </details>
  );
}
