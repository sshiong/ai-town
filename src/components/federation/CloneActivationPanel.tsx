import { useRef, useState, type FormEvent } from 'react';
import { useConvex } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import { useLocale } from '../../i18n';
import { AdminButton, Field, useAdminTask } from './AdminShared';

type Status = FunctionReturnType<typeof api.federation.admin.status>;

export default function CloneActivationPanel({
  adminToken,
  status,
  task,
  refresh,
}: {
  adminToken: string;
  status: Status;
  task: ReturnType<typeof useAdminTask>;
  refresh: () => Promise<void>;
}) {
  const { t } = useLocale();
  const convex = useConvex();
  const [operator, setOperator] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const submitting = useRef(false);
  const activation = status.cloneActivation;
  if (status.identity?.mode !== 'DISABLED' || !activation?.importId) return null;

  const canActivate = activation.eligible && !!activation.townId &&
    !!activation.deploymentInstanceId && activation.deploymentEpoch !== null &&
    confirmed && !!operator.trim() && operator.trim().length <= 100 &&
    !!reason.trim() && reason.trim().length <= 500 && !task.pending;

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canActivate || submitting.current) return;
    submitting.current = true;
    try {
      await task.run(t('Activating independent cloned town'), async () => {
        await convex.mutation(api.federation.admin.activateIndependentClone, {
          adminToken,
          importId: activation.importId!,
          expectedTownId: activation.townId!,
          expectedDeploymentInstanceId: activation.deploymentInstanceId!,
          expectedDeploymentEpoch: activation.deploymentEpoch!,
          operator: operator.trim(),
          reason: reason.trim(),
        });
        await refresh();
      }, t('Independent cloned town activated. Visits and new pairing requests remain disabled. Enable them separately in Admission & safety.'));
    } finally {
      submitting.current = false;
    }
  }

  return (
    <form className="admin-form" onSubmit={(event) => void activate(event)}>
      <h3>{t('Activate independent cloned town')}</h3>
      <p>{t('This clone has its own Town ID and signing key. Trust from the source town is not inherited. Pair every peer again through manual approval.')}</p>
      <dl className="admin-facts">
        <dt>{t('Source town ID')}</dt>
        <dd><code>{activation.sourceTownId ?? '—'}</code></dd>
        <dt>{t('Clone activation eligibility')}</dt>
        <dd role="status">{activation.eligible
          ? t('Eligible for independent clone activation.')
          : t('Clone activation is blocked: {reason}', { reason: t(activation.reason ?? 'Unknown') })}</dd>
      </dl>
      <Field label={t('Operator')}>
        <input name="operator" required maxLength={100} value={operator}
          onChange={(event) => setOperator(event.target.value)} disabled={!!task.pending} />
      </Field>
      <Field label={t('Activation reason')}>
        <input name="reason" required maxLength={500} value={reason}
          onChange={(event) => setReason(event.target.value)} disabled={!!task.pending} />
      </Field>
      <label className="admin-check">
        <input name="confirmIndependentClone" type="checkbox" checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)} disabled={!!task.pending} />{' '}
        {t('I confirm this is an independent new town and every previous peer must be paired again.')}
      </label>
      <div className="admin-form-actions">
        <AdminButton type="submit" disabled={!canActivate}>
          {t('Activate independent cloned town')}
        </AdminButton>
      </div>
    </form>
  );
}
