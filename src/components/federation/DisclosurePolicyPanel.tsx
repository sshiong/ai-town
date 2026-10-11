import { useLocale } from '../../i18n';
import { useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { AdminButton, EmptyState, Field, TaskFeedback, formatTime, useAdminTask } from './AdminShared';

type Level = 'PUBLIC' | 'FRIEND_TOWNS' | 'WHITELIST';
type Policy = { agentGlobalId: string; level: Level; allowedTownIds: string[]; updatedAt: number };
const statusRef = makeFunctionReference<'query', { adminToken: string }, { policies: Policy[]; defaultLevel: string }>('federation/disclosurePolicy:status');
const setRef = makeFunctionReference<'mutation', {
  adminToken: string; agentGlobalId: string; level: Level; allowedTownIds: string[]; operator: string; reason: string;
}, unknown>('federation/disclosurePolicy:set');

export default function DisclosurePolicyPanel({ adminToken }: { adminToken: string }) {
  const { t } = useLocale();
  const convex = useConvex(), task = useAdminTask();
  const status = useQuery(statusRef, adminToken ? { adminToken } : 'skip');
  const [agentGlobalId, setAgentGlobalId] = useState('');
  const [level, setLevel] = useState<Level>('PUBLIC');
  const [towns, setTowns] = useState('');
  const busy = !adminToken || !!task.pending;
  return <section aria-label={t("Visitor profile disclosure")}>
    <h3>{t("Visitor profile disclosure")}</h3>
    <p className="admin-muted">{t("Choose which destinations receive a local resident's public introduction on their next visit. Name, appearance and Home town remain visible. Private memories and model credentials stay at Home. Existing visits keep the profile sent at departure.")}</p>
    <TaskFeedback task={task} />
    {!adminToken ? <EmptyState>{t("Administrator access is required to manage profile disclosure.")}</EmptyState> : <>
      <form className="admin-form" onSubmit={event => {
        event.preventDefault(); const fields = new FormData(event.currentTarget);
        void task.run(t("Saving profile disclosure"), () => convex.mutation(setRef, {
          adminToken, agentGlobalId, level, allowedTownIds: towns.split(/[\s,]+/).filter(Boolean),
          operator: String(fields.get('operator')).trim(), reason: String(fields.get('reason')).trim(),
        }), t("Profile disclosure saved for future visits."));
      }}>
        <Field label={t("Local resident global ID")} hint={t("Use the exact Home town ID /agent: resident ID.")}>
          <input value={agentGlobalId} onChange={event => setAgentGlobalId(event.target.value)} required maxLength={300} disabled={busy} placeholder="town-id/agent:resident-id" />
        </Field>
        <Field label={t("Share public introduction with")}>
          <select value={level} onChange={event => setLevel(event.target.value as Level)} disabled={busy}>
            <option value="PUBLIC">{t("All permitted destinations")}</option>
            <option value="FRIEND_TOWNS">{t("Trusted friend towns")}</option>
            <option value="WHITELIST">{t("Only listed towns")}</option>
          </select>
        </Field>
        {level === 'WHITELIST' && <Field label={t("Town ID whitelist")} hint={t("Separate exact Town IDs with commas or spaces. An empty list hides the introduction everywhere.")}>
          <textarea value={towns} onChange={event => setTowns(event.target.value)} maxLength={20100} disabled={busy} />
        </Field>}
        <Field label={t("Operator label")}><input name="operator" required maxLength={100} disabled={busy} /></Field>
        <Field label={t("Private review reason")}><input name="reason" required maxLength={1000} disabled={busy} /></Field>
        <div className="admin-form-actions"><AdminButton type="submit" disabled={busy}>{t("Save profile disclosure")}</AdminButton></div>
      </form>
      {!status ? <p role="status">{t("Loading profile disclosure...")}</p> : !status.policies.length ?
        <EmptyState>{t("Residents share their public introduction with all permitted destinations until a policy is set.")}</EmptyState> :
        <ul className="admin-list">{status.policies.map(policy => <li key={policy.agentGlobalId}>
          <div style={{ minWidth: 0, width: '100%' }}><code>{policy.agentGlobalId}</code>
            <p>{policy.level === 'WHITELIST' ? t("Introduction shared with {count} listed towns", { count: policy.allowedTownIds.length }) : policy.level === 'FRIEND_TOWNS' ? t("Introduction shared with trusted friend towns") : t("Introduction shared with all permitted destinations")}</p>
            <p className="admin-muted">{t("Updated")} {formatTime(policy.updatedAt)}</p>
            <AdminButton disabled={busy} onClick={() => { setAgentGlobalId(policy.agentGlobalId); setLevel(policy.level); setTowns(policy.allowedTownIds.join(', ')); }}>{t("Edit disclosure")}</AdminButton>
          </div>
        </li>)}</ul>}
    </>}
  </section>;
}
