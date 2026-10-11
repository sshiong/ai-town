import { useLocale } from '../../i18n';
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

type Peer = { townId: string; townName: string; trustState: string };
export default function CredentialRotationPanel({
  adminToken,
  peers,
}: {
  adminToken: string;
  peers: Peer[];
}) {
  const { t } = useLocale();
  const convex = useConvex();
  const task = useAdminTask();
  const records = useQuery(api.federation.peerCredentialRotation.status, { adminToken });
  const [selected, setSelected] = useState('');
  const [minutes, setMinutes] = useState(15);
  const trusted = peers.filter((p) => p.trustState === 'TRUSTED');
  const peerTownId = trusted.some((p) => p.townId === selected) ? selected : trusted[0]?.townId;
  return (
    <section aria-label={t("Neighbor authentication rotation")}>
      <h3>{t("Neighbor authentication rotation")}</h3>
      <p>
        {t("Replace a trusted neighbor's shared authentication credential. The previous credential remains valid only during the selected overlap period, so messages in transit can complete. Town identity, resident identity and visit leases stay the same.")}
      </p>
      {!trusted.length ? (
        <EmptyState>{t("Pair with a trusted neighbor before rotating authentication.")}</EmptyState>
      ) : (
        <form
          className="admin-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!peerTownId) return;
            void task.run(
              t("Requesting authentication rotation"),
              () =>
                convex.action(api.federation.peerCredentialRotation.start, {
                  adminToken,
                  peerTownId,
                  overlapMs: minutes * 60_000,
                }),
              t("Rotation request processed. Check its recorded status below. Pending requests retry automatically."),
            );
          }}
        >
          <Field label={t("Neighbor")}>
            <select value={peerTownId} onChange={(e) => setSelected(e.target.value)}>
              {trusted.map((p) => (
                <option key={p.townId} value={p.townId}>
                  {p.townName} · {p.townId}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={t("Credential overlap (minutes)")}
            hint={t("10–30 minutes. Expired old credentials cannot authenticate new messages.")}
          >
            <input
              type="number"
              min={10}
              max={30}
              step={1}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              required
            />
          </Field>
          <AdminButton
            type="submit"
            disabled={!!task.pending || !Number.isInteger(minutes) || minutes < 10 || minutes > 30}
          >
            {t("Rotate neighbor authentication")}
          </AdminButton>
        </form>
      )}
      <TaskFeedback task={task} />
      {!records?.length ? (
        <EmptyState>{t("No recorded authentication rotations.")}</EmptyState>
      ) : (
        <ul className="admin-list">
          {records.map((r) => (
            <li key={`${r.peerTownId}:${r.direction}:${r.rotationId}`}>
              <div className="admin-peer">
                <strong>
                  {peers.find((p) => p.townId === r.peerTownId)?.townName ?? r.peerTownId}
                </strong>
                <span className="admin-badge">
                  {r.direction} · {r.state}
                </span>
                <code>{r.rotationId}</code>
                <p>
                  {t("Previous credential expires:")} {formatTime(r.overlapUntil)} {t("· delivery attempts:")}{' '}
                  {r.attempts}
                </p>
                {r.lastError && <p className="admin-error">{r.lastError}</p>}
                {r.state === 'PENDING' && r.direction === 'OUTBOUND' && (
                  <AdminButton
                    disabled={!!task.pending}
                    onClick={() =>
                      void task.run(
                        t("Retrying authentication rotation"),
                        () =>
                          convex.action(api.federation.peerCredentialRotation.retry, {
                            adminToken,
                            peerTownId: r.peerTownId,
                            rotationId: r.rotationId,
                          }),
                        t("Retry processed. Check the recorded status."),
                      )
                    }
                  >
                    {t("Retry delivery")}
                  </AdminButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
