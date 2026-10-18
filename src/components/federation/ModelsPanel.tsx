import { useLocale } from '../../i18n';
import { useState, type FormEvent } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { AdminButton, EmptyState, Field, TaskFeedback, useAdminTask } from './AdminShared';
import { EmbeddingProviderEvidence } from './EmbeddingPanel';
import { makeFunctionReference } from 'convex/server';

type Profiles = FunctionReturnType<typeof api.models.profiles.list>;
const providers = ['openai', 'together', 'ollama', 'custom'] as const;
const startCompatibleReuse = makeFunctionReference<'action', { adminToken: string; targetProfileId: Id<'embeddingProfiles'> }, Id<'embeddingSpaces'>>(
  'models/embeddings:startCompatibleReuse');

export default function ModelsPanel({ adminToken }: { adminToken: string }) {
  const { t } = useLocale();
  const convex = useConvex();
  const task = useAdminTask();
  const data: Profiles | undefined = useQuery(api.models.profiles.list, { adminToken });
  const usage = useQuery(api.models.usage.summary, { adminToken });
  const [kind, setKind] = useState<'chat' | 'embedding'>('chat');
  const [planJobId, setPlanJobId] = useState<Id<'embeddingScanJobs'>>();
  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const descriptions = useQuery(
    api.world.gameDescriptions,
    worldStatus ? { worldId: worldStatus.worldId } : 'skip',
  );
  const residents = useQuery(api.federation.runtime.listResidents, { adminToken });
  const [reviewedProfile, setReviewedProfile] = useState<Id<'embeddingProfiles'>>();
  const plan = useQuery(api.models.embeddings.planSwitch, reviewedProfile ? { adminToken, targetProfileId: reviewedProfile } : 'skip');
  const planProgress = useQuery(api.models.embeddings.scanProgress, planJobId ? { adminToken, jobId: planJobId } : 'skip');
  async function refresh() {
    await convex.query(api.models.profiles.list, { adminToken });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const provider = providers.find((p) => p === fields.get('provider'));
    if (!provider) return;
    const connection = {
      adminToken,
      name: String(fields.get('name')).trim(),
      provider,
      url: String(fields.get('url')).trim(),
      model: String(fields.get('model')).trim(),
      apiKeyEnv: String(fields.get('apiKeyEnv')).trim() || undefined,
    };
    await task.run(t("Saving profile"), async () => {
      if (kind === 'chat') {
        const thinking = fields.get('enableThinking');
        await convex.mutation(api.models.profiles.saveChatProfile, {
          ...connection,
          ...(thinking === 'true' || thinking === 'false' ? { enableThinking: thinking === 'true' } : {}),
        });
      }
      else
        await convex.mutation(api.models.embeddings.saveEmbeddingProfile, {
          ...connection,
          dimensions: Number(fields.get('dimensions')),
          immutableRevision: String(fields.get('immutableRevision')).trim() || undefined,
          weightsDigest: String(fields.get('weightsDigest')).trim() || undefined,
          preprocessingRevision: String(fields.get('preprocessingRevision')).trim() || 'newline-to-space-v1',
          queryPrefix: String(fields.get('queryPrefix') ?? ''),
          documentPrefix: String(fields.get('documentPrefix') ?? ''),
          normalization: String(fields.get('normalization')).trim() || 'none',
        });
      form.reset();
      await refresh();
    });
  }
  return (
    <section className="admin-panel">
      <h2>{t("Models & resident bindings")}</h2>
      <p className="admin-muted">
        {t("Chat and Embedding use independent providers. Test a Chat connection successfully before selecting main. The first successfully tested profile becomes main automatically. Changing main only affects new residents; existing bindings remain fixed. A failed main profile pauses new resident creation until it passes a test or you select another validated main.")}</p>
      <TaskFeedback task={task} />
      {!data && <p role="status">{t("Loading model profiles…")}</p>}
      <div className="admin-toolbar">
        <AdminButton
          disabled={!!task.pending}
          onClick={() => void task.run(t("Refreshing"), refresh, '')}
        >
          {t("Refresh")}</AdminButton>
      </div>
      {data && (
        <>
          <h3>{t("Chat profiles")}</h3>
          {!data.chatProfiles.length && (
            <EmptyState>{t("Add a Chat profile to choose the model for new residents.")}</EmptyState>
          )}
          <ul className="admin-list">
            {data.chatProfiles.map((profile) => (
              <li key={profile._id}>
                <div>
                  <strong>{profile.name}</strong>{' '}
                  {profile.disabled && <span className="admin-badge">{t("disabled")}</span>}
                  {data.settings?.mainChatProfileId === profile._id && (
                    <span className="admin-badge">{t("main")}</span>
                  )}
                  <p className="admin-muted">
                    {profile.provider} · {profile.model}
                    {profile.enableThinking !== undefined && <> · {t(profile.enableThinking ? 'Thinking enabled' : 'Thinking disabled')}</>}
                  </p>
                  <code>{profile.url}</code>
                  <p className="admin-muted">
                    {profile.credentialAvailable
                      ? t("Server credential available")
                      : t("Credential missing: {credential}", { credential: profile.apiKeyEnv ?? t("provider configuration") })}
                  </p>
                  <ProfileManagement adminToken={adminToken} profile={profile}
                    affected={data.affectedResidents.filter(binding => binding.chatProfileId === profile._id)}
                    protectedReason={data.settings?.mainChatProfileId === profile._id ? t("Select another validated main before disabling or deleting this profile.") : undefined} />
                </div>
                <div className="admin-toolbar">
                  <AdminButton
                    disabled={!!task.pending || !profile.credentialAvailable || profile.disabled}
                    onClick={() =>
                      void task.run(
                        t("Testing Chat connection"),
                        async () => {
                          try {
                            return await convex.action(api.models.profiles.probeChat, { adminToken, chatProfileId: profile._id });
                          } finally {
                            await refresh();
                          }
                        },
                        t("Chat provider returned a real response. This diagnostic may use provider credits."),
                      )
                    }
                  >
                    {t("Test connection")}</AdminButton>
                  <AdminButton
                    disabled={!!task.pending || profile.disabled || data.settings?.mainChatProfileId === profile._id || data.audits.find(a => a.subject === profile._id && ['PROBE_CHAT_SUCCESS', 'PROBE_CHAT_FAILED'].includes(a.operation))?.operation !== 'PROBE_CHAT_SUCCESS'}
                    onClick={() =>
                      void task.run(
                        t("Changing main"),
                        async () => {
                          await convex.mutation(api.models.profiles.setMain, {
                            adminToken,
                            chatProfileId: profile._id,
                          });
                          await refresh();
                        },
                        t("Main saved. Existing residents keep their bindings."),
                      )
                    }
                  >
                    {t("Set main")}</AdminButton>
                </div>
              </li>
            ))}
          </ul>
          <h3>{t("Resident models")}</h3>
          {!data.bindings.length && (
            <EmptyState>
              {t("Resident bindings appear once residents have an assigned Chat profile.")}</EmptyState>
          )}
          <div className="admin-residents">
            {data.bindings.map((binding) => (
              <form
                key={`${binding._id}:${binding.chatProfileId}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  const fields = new FormData(event.currentTarget);
                  const profile = data.chatProfiles.find(
                    (p) => p._id === fields.get('chatProfileId'),
                  );
                  if (!profile) return;
                  void task.run(
                    t("Saving resident binding"),
                    async () => {
                      await convex.mutation(api.models.profiles.setResidentChat, {
                        adminToken,
                        worldId: binding.worldId,
                        playerId: binding.playerId,
                        chatProfileId: profile._id,
                        reason: String(fields.get('reason')).trim(),
                      });
                      await refresh();
                    },
                    t("Resident binding saved for the next new thinking request."),
                  );
                }}
              >
                <strong>
                  {residents?.find(
                    (r) => r.worldId === binding.worldId && r.playerId === binding.playerId,
                  )?.name ??
                    descriptions?.playerDescriptions.find((p) => p.playerId === binding.playerId)
                      ?.name ??
                    binding.playerId}
                </strong>
                <Field label={t("Current / next model")}>
                  <select name="chatProfileId" defaultValue={binding.chatProfileId}>
                    {data.chatProfiles.map((p) => (
                      <option key={p._id} value={p._id} disabled={p.disabled}>
                        {p.name} · {p.model}{p.disabled ? t(" (disabled)") : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("Audit reason")}>
                  <input
                    name="reason"
                    required
                    maxLength={1000}
                    placeholder={t("Why change this resident's model?")}
                  />
                </Field>
                <AdminButton type="submit" disabled={!!task.pending}>
                  {t("Save binding")}</AdminButton>
              </form>
            ))}
          </div>
          <h3>{t("Embedding profiles")}</h3>
          {!data.embeddingProfiles.length && (
            <EmptyState>
              {t("Add an Embedding profile to build a verified memory index. Travel does not require matching vector models across towns.")}</EmptyState>
          )}
          <ul className="admin-list">
            {data.embeddingProfiles.map((profile) => (
              <li key={profile._id}>
                <div>
                  <strong>{profile.name}</strong>
                  {profile.disabled && <span className="admin-badge">{t("disabled")}</span>}
                  <p>
                    {profile.model} · {t("{count} dimensions", { count: profile.dimensions })}</p>
                  <code>{profile.fingerprint}</code>
                  <p className="admin-muted">
                    {t("Fixed revision: {revision}", { revision: profile.immutableRevision ?? t("unverified") })} ·{' '}
                    {profile.credentialAvailable
                      ? t("Server credential available")
                      : t("Server credential missing")}
                  </p>
                  <EmbeddingProviderEvidence adminToken={adminToken} profile={profile} />
                  <div className="admin-toolbar">
                    <AdminButton
                      disabled={!!task.pending || profile.disabled || !profile.credentialAvailable}
                      onClick={() =>
                        void task.run(
                          t("Testing Embedding connection"),
                          () =>
                            convex.action(api.models.embeddings.probeEmbedding, {
                              adminToken,
                              embeddingProfileId: profile._id,
                            }),
                          t("Embedding provider returned a vector with verified dimensions."),
                        )
                      }
                    >
                      {t("Test connection")}</AdminButton>
                    <AdminButton
                      disabled={!!task.pending || profile.disabled}
                      onClick={() =>
                        void task.run(
                          t("Checking vector compatibility"),
                          async () => {
                            setPlanJobId(
                              await convex.mutation(api.models.embeddings.startSwitchPlan, {
                                adminToken,
                                targetProfileId: profile._id,
                              }),
                            );
                            setReviewedProfile(profile._id);
                          },
                          '',
                        )
                      }
                    >
                      {t("Review switch")}</AdminButton>
                    <AdminButton
                      disabled={
                        !!task.pending ||
                        profile.disabled ||
                        reviewedProfile !== profile._id ||
                        !profile.credentialAvailable
                      }
                      onClick={() =>
                        void task.run(
                          t("Starting vector rebuild"),
                          async () => {
                            await convex.action(api.models.embeddings.startRebuild, {
                              adminToken,
                              targetProfileId: profile._id,
                            });
                            await refresh();
                          },
                          t("Rebuild scheduled. The old index remains available until validation and activation."),
                        )
                      }
                    >
                      {t("Build new index")}</AdminButton>
                  </div>
                  <ProfileManagement adminToken={adminToken} profile={profile} affected={[]}
                    protectedReason={data.embeddingSpaces.some(space => space.profileId === profile._id &&
                      (space.status === 'ACTIVE' || space.status === 'BUILDING' || space._id === data.settings?.activeEmbeddingSpaceId))
                      ? t("Activate another validated index and finish pending builds before disabling this profile.") : undefined}
                    embeddingReferences={data.embeddingSpaces.filter(space => space.profileId === profile._id).length} />
                </div>
              </li>
            ))}
          </ul>
          {plan && (
            <div className="admin-warning">
              <strong>{t(plan.compatibility)}</strong>
              {planProgress?.failure && <p className="admin-error">{planProgress.failure}{t(". Review switch to resume.")}</p>}
              <p>
                {t("Target profile:")}{' '}
                {data.embeddingProfiles.find((p) => p._id === reviewedProfile)?.name}
              </p>
              <p>{t("Current space: {space}", { space: plan.sourceFingerprint ?? t("none") })}</p>
              <p>{t("Target space: {space}", { space: plan.targetFingerprint })}</p>
              <p>
                {plan.planningComplete ? t("Affected memories: {count}.", { count: plan.affectedMemories }) : t("Affected memories: {count} scanned; planning in progress.", { count: plan.affectedMemories })}{' '}
                {plan.canReuse
                  ? t("Compatibility verified.")
                  : t("Old vectors cannot be reused; rebuild required.")}
              </p>
              {plan.canReuse && reviewedProfile && <AdminButton disabled={!!task.pending || !plan.planningComplete}
                onClick={() => void task.run(t("Rechecking provider identity and copying compatible vectors"), async () => {
                  await convex.action(startCompatibleReuse, { adminToken, targetProfileId: reviewedProfile });
                  await refresh();
                }, t("Compatible vectors are copying into a separate space. Validate coverage and live retrieval before activation."))}>
                {t("Reuse verified compatible vectors")}</AdminButton>}
            </div>
          )}
          <p className="admin-muted">
            {t("Matching dimensions alone do not prove compatibility. Keep the old index while building; validate coverage and sample retrieval before activation.")}</p>
          <ul className="admin-list">
            {data.embeddingSpaces.map((space) => (
              <li key={space._id}>
                <div>
                  <strong>
                    {data.embeddingProfiles.find((p) => p._id === space.profileId)?.name ??
                      space.profileId}
                  </strong>{' '}
                  <span className="admin-badge">{t(space.status)}</span>
                  <code>{space.fingerprint}</code>
                  <EmbeddingScanProgress adminToken={adminToken} jobId={space.validationJobId ?? space.coverageJobId} />
                  {space.failure && <p className="admin-error">{space.failure}</p>}
                  <div className="admin-toolbar">
                    <AdminButton disabled={!!task.pending} onClick={() => void task.run(t("Rebuilding missing or stale vectors"), async () => {
                      await convex.mutation(api.models.embeddings.resumeRebuild, { adminToken, spaceId: space._id });
                    }, t("Catch-up started from retained source text; existing query routing remains available."))}>
                      {t("Rebuild / catch up")}</AdminButton>
                    <AdminButton
                      disabled={!!task.pending || !['READY', 'RETIRED', 'BUILDING'].includes(space.status)}
                      onClick={() =>
                        void task.run(t("Validating coverage and retrieval"), async () => {
                          await convex.action(api.models.embeddings.validateSpace, {
                            adminToken,
                            spaceId: space._id,
                          });
                          await refresh();
                        }, t("Validation started; progress is saved and activation stays disabled until every page passes."))
                      }
                    >
                      {t("Validate / resume")}</AdminButton>
                    <AdminButton
                      disabled={!!task.pending || space.status !== 'READY' || !space.validatedAt}
                      onClick={() =>
                        void task.run(t("Activating vector space"), async () => {
                          await convex.mutation(api.models.embeddings.activateSpace, {
                            adminToken,
                            spaceId: space._id,
                          });
                          await refresh();
                        })
                      }
                    >
                      {t("Activate validated index")}</AdminButton>
                    <AdminButton
                      disabled={!!task.pending || space.status !== 'RETIRED' || !space.validatedAt}
                      onClick={() =>
                        void task.run(t("Rolling back vector space"), async () => {
                          await convex.mutation(api.models.embeddings.rollback, {
                            adminToken,
                            spaceId: space._id,
                          });
                          await refresh();
                        })
                      }
                    >
                      {t("Roll back")}</AdminButton>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <ModelUsageManagement adminToken={adminToken} data={data} usage={usage} />
          <details className="admin-disclosure">
            <summary>{t("Model audit history")}</summary>
            <ul className="admin-list">
              {data.audits.map((audit) => (
                <li key={audit._id}>
                  <div>
                    <strong>{audit.operation}</strong>
                    <p className="admin-muted">{audit.actor ?? t("Legacy actor unavailable")} · {new Date(audit.at).toLocaleString()}</p>
                    <p>{audit.reason}</p>
                    <code>
                      {audit.subject} · {audit.previous ?? t("none")} → {audit.next}
                    </code>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      <details className="admin-disclosure">
        <summary>{t("Add a model profile")}</summary>
        <div className="admin-tabs" aria-label={t("Profile kind")}>
          <button type="button" aria-pressed={kind === 'chat'} onClick={() => setKind('chat')}>
            {t("Chat / reasoning")}</button>
          <button
            type="button"
            aria-pressed={kind === 'embedding'}
            onClick={() => setKind('embedding')}
          >
            {t("Embedding")}</button>
        </div>
        <form className="admin-form" onSubmit={(event) => void save(event)}>
          <Field label={t("Profile name")}>
            <input name="name" required maxLength={120} />
          </Field>
          <Field label={t("Provider")}>
            <select name="provider">
              {providers.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field
            label={t("API base URL")}
            hint={t("Use an OpenAI-compatible base URL (usually /v1), or the Ollama server base URL.")}
          >
            <input name="url" required type="url" placeholder="https://provider.example/v1" />
          </Field>
          <Field label={t("Model ID")}>
            <input name="model" required maxLength={256} />
          </Field>
          <Field
            label={t("API key environment variable")}
            hint={t("Set the secret on the server. Enter only its variable name here.")}
          >
            <input
              name="apiKeyEnv"
              placeholder="MY_PROVIDER_API_KEY"
              pattern="[A-Z][A-Z0-9_]{0,127}"
            />
          </Field>
          {kind === 'chat' && (
            <Field label={t('Thinking mode')} hint={t('Leave the provider default unless this model supports enable_thinking. For SiliconFlow DeepSeek, disable thinking to request direct replies.')} >
              <select name="enableThinking" defaultValue="">
                <option value="">{t('Provider default')}</option>
                <option value="true">{t('Thinking enabled')}</option>
                <option value="false">{t('Thinking disabled')}</option>
              </select>
            </Field>
          )}
          {kind === 'embedding' && (
            <>
              <Field label={t("Dimensions")}>
                <input name="dimensions" type="number" min={1} max={16384} required />
              </Field>
              <Field label={t("Immutable model revision")}>
                <input name="immutableRevision" />
              </Field>
              <Field label={t("Weights digest / compatibility evidence")}>
                <input name="weightsDigest" />
              </Field>
              <Field label={t("Preprocessing revision")}>
                <input name="preprocessingRevision" defaultValue="newline-to-space-v1" required />
              </Field>
              <Field label={t("Query prefix")}>
                <input name="queryPrefix" />
              </Field>
              <Field label={t("Document prefix")}>
                <input name="documentPrefix" />
              </Field>
              <Field label={t("Normalization")}>
                <input name="normalization" defaultValue="none" required />
              </Field>
            </>
          )}
          <div className="admin-form-actions">
            <AdminButton type="submit" disabled={!!task.pending}>
              {t("Save {kind} profile", { kind: t(kind === "chat" ? "Chat" : "Embedding") })}</AdminButton>
          </div>
        </form>
      </details>
    </section>
  );
}

function quotaValue(fields: FormData, name: string) {
  const text = String(fields.get(name) ?? '').trim();
  return text ? Number(text) : null;
}
type ManagedProfile = Profiles['chatProfiles'][number] | Profiles['embeddingProfiles'][number];
function ProfileManagement({ adminToken, profile, affected, protectedReason, embeddingReferences = 0 }: {
  adminToken: string; profile: ManagedProfile; affected: Profiles['affectedResidents'];
  protectedReason?: string; embeddingReferences?: number;
}) {
  const { t } = useLocale();
  const convex = useConvex(), task = useAdminTask();
  const canDelete = !protectedReason && !affected.length && !embeddingReferences;
  return <details className="admin-disclosure">
    <summary>{t("Availability & request quota")}</summary>
    {protectedReason && <p className="admin-muted">{protectedReason}</p>}
    {affected.length > 0 && <>
      <p>{t("Disabling pauses new model calls for these residents. Their current bindings stay fixed.")}</p>
      <ul>{affected.map(binding => <li key={binding._id}>{binding.name} · <code>{binding.agentGlobalId ?? `${binding.worldId}/${binding.playerId}`}</code></li>)}</ul>
      <p className="admin-muted">{t("Move each binding explicitly before deleting this profile.")}</p>
    </>}
    {embeddingReferences > 0 && <p className="admin-muted">{t("{count} retained vector spaces reference this profile. Deletion is blocked to preserve their indexes and rollback history.", { count: embeddingReferences })}</p>}
    <TaskFeedback task={task} />
    <form className="admin-form" key={`${profile.disabled}/${protectedReason}/${embeddingReferences}/${affected.map(binding => binding._id).sort().join()}`} onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      const action = String(fields.get('operation'));
      void task.run(t("Updating model profile"), async () => {
        const reason = String(fields.get('reason')).trim();
        if (action === 'DELETE') await convex.mutation(api.models.profileLifecycle.remove, {
          adminToken, profileId: profile._id, reason,
        });
        else await convex.mutation(api.models.profileLifecycle.setEnabled, {
          adminToken, profileId: profile._id, enabled: action === 'ENABLE', reason,
          affectedBindingIds: affected.map(binding => binding._id),
        });
      });
    }}>
      <Field label={t("Availability action")}>
        <select name="operation">
          <option value={profile.disabled ? 'ENABLE' : 'DISABLE'} disabled={!profile.disabled && !!protectedReason}>
            {profile.disabled ? t("Enable profile") : t("Disable profile")}
          </option>
          <option value="DELETE" disabled={!canDelete}>{t("Delete unreferenced profile")}</option>
        </select>
      </Field>
      <Field label={t("Audit reason")}><input name="reason" required maxLength={1000} /></Field>
      <label className="admin-form-actions"><input type="checkbox" required /> {t("I reviewed the affected residents and references.")}</label>
      <AdminButton type="submit" disabled={!!task.pending || (!profile.disabled && !!protectedReason)}>{t("Apply reviewed action")}</AdminButton>
    </form>
    <form className="admin-form" key={String(profile.dailyRequestLimit)} onSubmit={event => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      void task.run(t("Saving profile request quota"), () => convex.mutation(api.models.usage.configureProfileQuota, {
        adminToken, profileId: profile._id, maxRequestsPerDay: quotaValue(fields, 'limit'), reason: String(fields.get('reason')).trim(),
      }));
    }}>
      <Field label={t("Logical requests per UTC day")} hint={t("Blank is unlimited; zero pauses new provider requests. Connection probes share this quota.")}>
        <input name="limit" type="number" min={0} max={1000000} step={1} defaultValue={profile.dailyRequestLimit ?? ''} />
      </Field>
      <Field label={t("Audit reason")}><input name="reason" required maxLength={1000} /></Field>
      <AdminButton type="submit" disabled={!!task.pending}>{t("Save profile quota")}</AdminButton>
    </form>
  </details>;
}

function ModelUsageManagement({ adminToken, data, usage }: {
  adminToken: string; data: Profiles; usage?: FunctionReturnType<typeof api.models.usage.summary>;
}) {
  const { t } = useLocale();
  const convex = useConvex(), task = useAdminTask();
  const providers = new Map<string, { kind: 'CHAT' | 'EMBEDDING'; key: string; name: string }>();
  for (const [kind, profiles] of [['CHAT', data.chatProfiles], ['EMBEDDING', data.embeddingProfiles]] as const)
    for (const profile of profiles) {
      const key = JSON.stringify([profile.provider, profile.url]);
      providers.set(`${kind}/${key}`, { kind, key, name: `${profile.provider} · ${profile.url}` });
    }
  const profileName = (id: string) => [...data.chatProfiles, ...data.embeddingProfiles].find(profile => profile._id === id)?.name ?? id;
  const residentName = (key: string) => data.affectedResidents.find(binding => `${binding.worldId}/${binding.playerId}` === key)?.name ?? key;
  return <details className="admin-disclosure">
    <summary>{t("Daily model usage, errors & quotas")}</summary>
    <p className="admin-muted">{t("Each logical request reserves one daily slot, including transport retries. Cached embeddings consume no provider quota. Token totals include only usage reported by the provider; missing reports and retry usage remain unknown. These counters do not estimate cost.")}</p>
    <TaskFeedback task={task} />
    {!usage && <p role="status">{t("Loading model usage…")}</p>}
    {usage && <>
      <p>{t("UTC day: {day}", { day: new Date(usage.day).toISOString().slice(0, 10) })}{usage.countsAreLowerBounds ? t(" · Counts are lower bounds") : ''}</p>
      {!usage.buckets.length ? <EmptyState>{t("Model request statistics appear after the first provider call.")}</EmptyState> : <div className="admin-table-scroll"><table>
        <thead><tr><th>{t("Scope")}</th><th>{t("Requests")}</th><th>{t("Success")}</th><th>{t("Failed")}</th><th>{t("Blocked")}</th><th>{t("Error rate")}</th><th>{t("Reported tokens")}</th><th>{t("Unknown usage calls")}</th><th>{t("Retries")}</th><th>{t("Unfinished")}</th></tr></thead>
        <tbody>{usage.buckets.map(row => <tr key={row._id}>
          <td>{t(row.kind)} · {t(row.dimension)} · {row.dimension === 'PROFILE' ? profileName(row.key) : row.dimension === 'RESIDENT' ? residentName(row.key) : providers.get(`${row.kind}/${row.key}`)?.name ?? row.key}</td>
          <td>{row.started}</td><td>{row.succeeded}</td><td>{row.failed}</td><td>{row.denied}</td>
          <td>{row.errorRate === null ? t("Unavailable") : `${(row.errorRate * 100).toFixed(1)}%`}</td>
          <td>{row.totalTokens === null ? t("Unknown") : row.totalTokens}</td><td>{row.unknownTokenCalls}</td><td>{row.retries}</td><td>{row.unfinished}</td>
        </tr>)}</tbody>
      </table></div>}
      {usage.failures.length > 0 && <><h4>{t("Recent model failures")}</h4><ul className="admin-list">
        {usage.failures.map(failure => <li key={failure._id}>{t(failure.kind)} · {profileName(failure.profileId)} · {failure.residentKey ? residentName(failure.residentKey) : t("Administrator diagnostic")} · {failure.errorCode}</li>)}
      </ul></>}
    </>}
    <h4>{t("Provider request quotas")}</h4>
    {[...providers.values()].map(provider => {
      const quota = usage?.providerQuotas.find(row => row.kind === provider.kind && row.providerKey === provider.key);
      return <form className="admin-form" key={`${provider.kind}/${provider.key}/${quota?.maxRequestsPerDay}`} onSubmit={event => {
        event.preventDefault(); const fields = new FormData(event.currentTarget);
        void task.run(t("Saving provider quota"), () => convex.mutation(api.models.usage.configureProviderQuota, {
          adminToken, kind: provider.kind, providerKey: provider.key,
          maxRequestsPerDay: quotaValue(fields, 'limit'), reason: String(fields.get('reason')).trim(),
        }));
      }}>
        <strong>{t(provider.kind)} · {provider.name}</strong>
        <Field label={t("Requests per UTC day")} hint={t("Applies across profiles on this provider endpoint. Blank is unlimited; zero pauses requests.")}>
          <input name="limit" type="number" min={0} max={1000000} step={1} defaultValue={quota?.maxRequestsPerDay ?? ''} />
        </Field>
        <Field label={t("Audit reason")}><input name="reason" required maxLength={1000} /></Field>
        <AdminButton type="submit" disabled={!!task.pending}>{t("Save provider quota")}</AdminButton>
      </form>;
    })}
    <h4>{t("Resident request quotas")}</h4>
    {data.affectedResidents.map(binding => <form className="admin-form" key={`${binding._id}/${JSON.stringify(binding.requestQuotas)}`} onSubmit={event => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      void task.run(t("Saving resident quotas"), () => convex.mutation(api.models.usage.configureResidentQuota, {
        adminToken, bindingId: binding._id as Id<'residentModelBindings'>,
        quotas: { chat: quotaValue(fields, 'chat'), embedding: quotaValue(fields, 'embedding') }, reason: String(fields.get('reason')).trim(),
      }));
    }}>
      <strong>{binding.name}</strong>
      <Field label={t("Chat requests per UTC day")}><input name="chat" type="number" min={0} max={1000000} step={1} defaultValue={binding.requestQuotas?.chat ?? ''} /></Field>
      <Field label={t("Embedding requests per UTC day")} hint={t("Blank is unlimited; zero pauses provider requests, retaining cached retrieval and raw memories.")}><input name="embedding" type="number" min={0} max={1000000} step={1} defaultValue={binding.requestQuotas?.embedding ?? ''} /></Field>
      <Field label={t("Audit reason")}><input name="reason" required maxLength={1000} /></Field>
      <AdminButton type="submit" disabled={!!task.pending}>{t("Save resident quotas")}</AdminButton>
    </form>)}
  </details>;
}

function EmbeddingScanProgress({ adminToken, jobId }: { adminToken: string; jobId?: Id<'embeddingScanJobs'> }) {
  const { t } = useLocale();
  const progress = useQuery(api.models.embeddings.scanProgress, jobId ? { adminToken, jobId } : 'skip');
  if (!progress) return null;
  return <p className="admin-muted">{t("{kind}: {phase}; checked {memories} memories, {vectors} vectors, {samples} retrieval samples.", { kind: t(progress.kind), phase: t(progress.phase), memories: progress.memoryCount, vectors: progress.vectorCount, samples: progress.sampleCount })}
    {progress.restarts > 0 && t(" Source changed; restarted {count} times.", { count: progress.restarts })}
    {progress.phase === 'FAILED' && t(" Resume validation after completing the missing vectors or correcting the failure.")}
  </p>;
}
