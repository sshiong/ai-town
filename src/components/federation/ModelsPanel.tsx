import { useState, type FormEvent } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { AdminButton, EmptyState, Field, TaskFeedback, useAdminTask } from './AdminShared';

type Profiles = FunctionReturnType<typeof api.models.profiles.list>;
const providers = ['openai', 'together', 'ollama', 'custom'] as const;

export default function ModelsPanel({ adminToken }: { adminToken: string }) {
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
    await task.run('Saving profile', async () => {
      if (kind === 'chat') await convex.mutation(api.models.profiles.saveChatProfile, connection);
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
      <h2>Models &amp; resident bindings</h2>
      <p className="admin-muted">
        Chat and Embedding use independent providers. Test a Chat connection successfully before
        selecting main. The first successfully tested profile becomes main automatically. Changing
        main only affects new residents; existing bindings remain fixed. A failed main profile
        pauses new resident creation until it passes a test or you select another validated main.
      </p>
      <TaskFeedback task={task} />
      {!data && <p role="status">Loading model profiles…</p>}
      <div className="admin-toolbar">
        <AdminButton
          disabled={!!task.pending}
          onClick={() => void task.run('Refreshing', refresh, '')}
        >
          Refresh
        </AdminButton>
      </div>
      {data && (
        <>
          <h3>Chat profiles</h3>
          {!data.chatProfiles.length && (
            <EmptyState>Add a Chat profile to choose the model for new residents.</EmptyState>
          )}
          <ul className="admin-list">
            {data.chatProfiles.map((profile) => (
              <li key={profile._id}>
                <div>
                  <strong>{profile.name}</strong>{' '}
                  {profile.disabled && <span className="admin-badge">disabled</span>}
                  {data.settings?.mainChatProfileId === profile._id && (
                    <span className="admin-badge">main</span>
                  )}
                  <p className="admin-muted">
                    {profile.provider} · {profile.model}
                  </p>
                  <code>{profile.url}</code>
                  <p className="admin-muted">
                    {profile.credentialAvailable
                      ? 'Server credential available'
                      : `Credential missing: ${profile.apiKeyEnv ?? 'provider configuration'}`}
                  </p>
                  <ProfileManagement adminToken={adminToken} profile={profile}
                    affected={data.affectedResidents.filter(binding => binding.chatProfileId === profile._id)}
                    protectedReason={data.settings?.mainChatProfileId === profile._id ? 'Select another validated main before disabling or deleting this profile.' : undefined} />
                </div>
                <div className="admin-toolbar">
                  <AdminButton
                    disabled={!!task.pending || !profile.credentialAvailable || profile.disabled}
                    onClick={() =>
                      void task.run(
                        'Testing Chat connection',
                        async () => {
                          try {
                            return await convex.action(api.models.profiles.probeChat, { adminToken, chatProfileId: profile._id });
                          } finally {
                            await refresh();
                          }
                        },
                        'Chat provider returned a real response. This diagnostic may use provider credits.',
                      )
                    }
                  >
                    Test connection
                  </AdminButton>
                  <AdminButton
                    disabled={!!task.pending || profile.disabled || data.settings?.mainChatProfileId === profile._id || data.audits.find(a => a.subject === profile._id && ['PROBE_CHAT_SUCCESS', 'PROBE_CHAT_FAILED'].includes(a.operation))?.operation !== 'PROBE_CHAT_SUCCESS'}
                    onClick={() =>
                      void task.run(
                        'Changing main',
                        async () => {
                          await convex.mutation(api.models.profiles.setMain, {
                            adminToken,
                            chatProfileId: profile._id,
                          });
                          await refresh();
                        },
                        'Main saved. Existing residents keep their bindings.',
                      )
                    }
                  >
                    Set main
                  </AdminButton>
                </div>
              </li>
            ))}
          </ul>
          <h3>Resident models</h3>
          {!data.bindings.length && (
            <EmptyState>
              Resident bindings appear once residents have an assigned Chat profile.
            </EmptyState>
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
                    'Saving resident binding',
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
                    'Resident binding saved for the next new thinking request.',
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
                <Field label="Current / next model">
                  <select name="chatProfileId" defaultValue={binding.chatProfileId}>
                    {data.chatProfiles.map((p) => (
                      <option key={p._id} value={p._id} disabled={p.disabled}>
                        {p.name} · {p.model}{p.disabled ? ' (disabled)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Audit reason">
                  <input
                    name="reason"
                    required
                    maxLength={1000}
                    placeholder="Why change this resident's model?"
                  />
                </Field>
                <AdminButton type="submit" disabled={!!task.pending}>
                  Save binding
                </AdminButton>
              </form>
            ))}
          </div>
          <h3>Embedding profiles</h3>
          {!data.embeddingProfiles.length && (
            <EmptyState>
              Add an Embedding profile to build a verified memory index. Travel does not require
              matching vector models across towns.
            </EmptyState>
          )}
          <ul className="admin-list">
            {data.embeddingProfiles.map((profile) => (
              <li key={profile._id}>
                <div>
                  <strong>{profile.name}</strong>
                  {profile.disabled && <span className="admin-badge">disabled</span>}
                  <p>
                    {profile.model} · {profile.dimensions} dimensions
                  </p>
                  <code>{profile.fingerprint}</code>
                  <p className="admin-muted">
                    Fixed revision: {profile.immutableRevision ?? 'unverified'} ·{' '}
                    {profile.credentialAvailable
                      ? 'Server credential available'
                      : 'Server credential missing'}
                  </p>
                  <div className="admin-toolbar">
                    <AdminButton
                      disabled={!!task.pending || profile.disabled || !profile.credentialAvailable}
                      onClick={() =>
                        void task.run(
                          'Testing Embedding connection',
                          () =>
                            convex.action(api.models.embeddings.probeEmbedding, {
                              adminToken,
                              embeddingProfileId: profile._id,
                            }),
                          'Embedding provider returned a vector with verified dimensions.',
                        )
                      }
                    >
                      Test connection
                    </AdminButton>
                    <AdminButton
                      disabled={!!task.pending || profile.disabled}
                      onClick={() =>
                        void task.run(
                          'Checking vector compatibility',
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
                      Review switch
                    </AdminButton>
                    <AdminButton
                      disabled={
                        !!task.pending ||
                        profile.disabled ||
                        reviewedProfile !== profile._id ||
                        !profile.credentialAvailable
                      }
                      onClick={() =>
                        void task.run(
                          'Starting vector rebuild',
                          async () => {
                            await convex.action(api.models.embeddings.startRebuild, {
                              adminToken,
                              targetProfileId: profile._id,
                            });
                            await refresh();
                          },
                          'Rebuild scheduled. The old index remains available until validation and activation.',
                        )
                      }
                    >
                      Build new index
                    </AdminButton>
                  </div>
                  <ProfileManagement adminToken={adminToken} profile={profile} affected={[]}
                    protectedReason={data.embeddingSpaces.some(space => space.profileId === profile._id &&
                      (space.status === 'ACTIVE' || space.status === 'BUILDING' || space._id === data.settings?.activeEmbeddingSpaceId))
                      ? 'Activate another validated index and finish pending builds before disabling this profile.' : undefined}
                    embeddingReferences={data.embeddingSpaces.filter(space => space.profileId === profile._id).length} />
                </div>
              </li>
            ))}
          </ul>
          {plan && (
            <div className="admin-warning">
              <strong>{plan.compatibility}</strong>
              {planProgress?.failure && <p className="admin-error">{planProgress.failure}. Review switch to resume.</p>}
              <p>
                Target profile:{' '}
                {data.embeddingProfiles.find((p) => p._id === reviewedProfile)?.name}
              </p>
              <p>Current space: {plan.sourceFingerprint ?? 'none'}</p>
              <p>Target space: {plan.targetFingerprint}</p>
              <p>
                Affected memories: {plan.affectedMemories}{plan.planningComplete ? '.' : ' scanned; planning in progress.'}{' '}
                {plan.canReuse
                  ? 'Compatibility verified.'
                  : 'Old vectors cannot be reused; rebuild required.'}
              </p>
            </div>
          )}
          <p className="admin-muted">
            Matching dimensions alone do not prove compatibility. Keep the old index while building;
            validate coverage and sample retrieval before activation.
          </p>
          <ul className="admin-list">
            {data.embeddingSpaces.map((space) => (
              <li key={space._id}>
                <div>
                  <strong>
                    {data.embeddingProfiles.find((p) => p._id === space.profileId)?.name ??
                      space.profileId}
                  </strong>{' '}
                  <span className="admin-badge">{space.status}</span>
                  <code>{space.fingerprint}</code>
                  <EmbeddingScanProgress adminToken={adminToken} jobId={space.validationJobId ?? space.coverageJobId} />
                  {space.failure && <p className="admin-error">{space.failure}</p>}
                  <div className="admin-toolbar">
                    <AdminButton disabled={!!task.pending} onClick={() => void task.run('Rebuilding missing or stale vectors', async () => {
                      await convex.mutation(api.models.embeddings.resumeRebuild, { adminToken, spaceId: space._id });
                    }, 'Catch-up started from retained source text; existing query routing remains available.')}>
                      Rebuild / catch up
                    </AdminButton>
                    <AdminButton
                      disabled={!!task.pending || !['READY', 'RETIRED', 'BUILDING'].includes(space.status)}
                      onClick={() =>
                        void task.run('Validating coverage and retrieval', async () => {
                          await convex.action(api.models.embeddings.validateSpace, {
                            adminToken,
                            spaceId: space._id,
                          });
                          await refresh();
                        }, 'Validation started; progress is saved and activation stays disabled until every page passes.')
                      }
                    >
                      Validate / resume
                    </AdminButton>
                    <AdminButton
                      disabled={!!task.pending || space.status !== 'READY' || !space.validatedAt}
                      onClick={() =>
                        void task.run('Activating vector space', async () => {
                          await convex.mutation(api.models.embeddings.activateSpace, {
                            adminToken,
                            spaceId: space._id,
                          });
                          await refresh();
                        })
                      }
                    >
                      Activate validated index
                    </AdminButton>
                    <AdminButton
                      disabled={!!task.pending || space.status !== 'RETIRED' || !space.validatedAt}
                      onClick={() =>
                        void task.run('Rolling back vector space', async () => {
                          await convex.mutation(api.models.embeddings.rollback, {
                            adminToken,
                            spaceId: space._id,
                          });
                          await refresh();
                        })
                      }
                    >
                      Roll back
                    </AdminButton>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <ModelUsageManagement adminToken={adminToken} data={data} usage={usage} />
          <details className="admin-disclosure">
            <summary>Model audit history</summary>
            <ul className="admin-list">
              {data.audits.map((audit) => (
                <li key={audit._id}>
                  <div>
                    <strong>{audit.operation}</strong>
                    <p className="admin-muted">{audit.actor ?? 'Legacy actor unavailable'} · {new Date(audit.at).toLocaleString()}</p>
                    <p>{audit.reason}</p>
                    <code>
                      {audit.subject} · {audit.previous ?? 'none'} → {audit.next}
                    </code>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      <details className="admin-disclosure">
        <summary>Add a model profile</summary>
        <div className="admin-tabs" aria-label="Profile kind">
          <button type="button" aria-pressed={kind === 'chat'} onClick={() => setKind('chat')}>
            Chat / reasoning
          </button>
          <button
            type="button"
            aria-pressed={kind === 'embedding'}
            onClick={() => setKind('embedding')}
          >
            Embedding
          </button>
        </div>
        <form className="admin-form" onSubmit={(event) => void save(event)}>
          <Field label="Profile name">
            <input name="name" required maxLength={120} />
          </Field>
          <Field label="Provider">
            <select name="provider">
              {providers.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field
            label="API base URL"
            hint="Use an OpenAI-compatible base URL (usually /v1), or the Ollama server base URL."
          >
            <input name="url" required type="url" placeholder="https://provider.example/v1" />
          </Field>
          <Field label="Model ID">
            <input name="model" required maxLength={256} />
          </Field>
          <Field
            label="API key environment variable"
            hint="Set the secret on the server. Enter only its variable name here."
          >
            <input
              name="apiKeyEnv"
              placeholder="MY_PROVIDER_API_KEY"
              pattern="[A-Z][A-Z0-9_]{0,127}"
            />
          </Field>
          {kind === 'embedding' && (
            <>
              <Field label="Dimensions">
                <input name="dimensions" type="number" min={1} max={16384} required />
              </Field>
              <Field label="Immutable model revision">
                <input name="immutableRevision" />
              </Field>
              <Field label="Weights digest / compatibility evidence">
                <input name="weightsDigest" />
              </Field>
              <Field label="Preprocessing revision">
                <input name="preprocessingRevision" defaultValue="newline-to-space-v1" required />
              </Field>
              <Field label="Query prefix">
                <input name="queryPrefix" />
              </Field>
              <Field label="Document prefix">
                <input name="documentPrefix" />
              </Field>
              <Field label="Normalization">
                <input name="normalization" defaultValue="none" required />
              </Field>
            </>
          )}
          <div className="admin-form-actions">
            <AdminButton type="submit" disabled={!!task.pending}>
              Save {kind} profile
            </AdminButton>
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
  const convex = useConvex(), task = useAdminTask();
  const canDelete = !protectedReason && !affected.length && !embeddingReferences;
  return <details className="admin-disclosure">
    <summary>Availability &amp; request quota</summary>
    {protectedReason && <p className="admin-muted">{protectedReason}</p>}
    {affected.length > 0 && <>
      <p>Disabling pauses new model calls for these residents. Their current bindings stay fixed.</p>
      <ul>{affected.map(binding => <li key={binding._id}>{binding.name} · <code>{binding.agentGlobalId ?? `${binding.worldId}/${binding.playerId}`}</code></li>)}</ul>
      <p className="admin-muted">Move each binding explicitly before deleting this profile.</p>
    </>}
    {embeddingReferences > 0 && <p className="admin-muted">{embeddingReferences} retained vector spaces reference this profile. Deletion is blocked to preserve their indexes and rollback history.</p>}
    <TaskFeedback task={task} />
    <form className="admin-form" key={`${profile.disabled}/${protectedReason}/${embeddingReferences}/${affected.map(binding => binding._id).sort().join()}`} onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      const action = String(fields.get('operation'));
      void task.run('Updating model profile', async () => {
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
      <Field label="Availability action">
        <select name="operation">
          <option value={profile.disabled ? 'ENABLE' : 'DISABLE'} disabled={!profile.disabled && !!protectedReason}>
            {profile.disabled ? 'Enable profile' : 'Disable profile'}
          </option>
          <option value="DELETE" disabled={!canDelete}>Delete unreferenced profile</option>
        </select>
      </Field>
      <Field label="Audit reason"><input name="reason" required maxLength={1000} /></Field>
      <label className="admin-form-actions"><input type="checkbox" required /> I reviewed the affected residents and references.</label>
      <AdminButton type="submit" disabled={!!task.pending || (!profile.disabled && !!protectedReason)}>Apply reviewed action</AdminButton>
    </form>
    <form className="admin-form" key={String(profile.dailyRequestLimit)} onSubmit={event => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      void task.run('Saving profile request quota', () => convex.mutation(api.models.usage.configureProfileQuota, {
        adminToken, profileId: profile._id, maxRequestsPerDay: quotaValue(fields, 'limit'), reason: String(fields.get('reason')).trim(),
      }));
    }}>
      <Field label="Logical requests per UTC day" hint="Blank is unlimited; zero pauses new provider requests. Connection probes share this quota.">
        <input name="limit" type="number" min={0} max={1000000} step={1} defaultValue={profile.dailyRequestLimit ?? ''} />
      </Field>
      <Field label="Audit reason"><input name="reason" required maxLength={1000} /></Field>
      <AdminButton type="submit" disabled={!!task.pending}>Save profile quota</AdminButton>
    </form>
  </details>;
}

function ModelUsageManagement({ adminToken, data, usage }: {
  adminToken: string; data: Profiles; usage?: FunctionReturnType<typeof api.models.usage.summary>;
}) {
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
    <summary>Daily model usage, errors &amp; quotas</summary>
    <p className="admin-muted">Each logical request reserves one daily slot, including transport retries.
      Cached embeddings consume no provider quota. Token totals include only usage reported by the provider;
      missing reports and retry usage remain unknown. These counters do not estimate cost.</p>
    <TaskFeedback task={task} />
    {!usage && <p role="status">Loading model usage…</p>}
    {usage && <>
      <p>UTC day: {new Date(usage.day).toISOString().slice(0, 10)}{usage.countsAreLowerBounds ? ' · Counts are lower bounds' : ''}</p>
      {!usage.buckets.length ? <EmptyState>Model request statistics appear after the first provider call.</EmptyState> : <div className="admin-table-scroll"><table>
        <thead><tr><th>Scope</th><th>Requests</th><th>Success</th><th>Failed</th><th>Blocked</th><th>Error rate</th><th>Reported tokens</th><th>Unknown usage calls</th><th>Retries</th><th>Unfinished</th></tr></thead>
        <tbody>{usage.buckets.map(row => <tr key={row._id}>
          <td>{row.kind} · {row.dimension} · {row.dimension === 'PROFILE' ? profileName(row.key) : row.dimension === 'RESIDENT' ? residentName(row.key) : providers.get(`${row.kind}/${row.key}`)?.name ?? row.key}</td>
          <td>{row.started}</td><td>{row.succeeded}</td><td>{row.failed}</td><td>{row.denied}</td>
          <td>{row.errorRate === null ? 'Unavailable' : `${(row.errorRate * 100).toFixed(1)}%`}</td>
          <td>{row.totalTokens === null ? 'Unknown' : row.totalTokens}</td><td>{row.unknownTokenCalls}</td><td>{row.retries}</td><td>{row.unfinished}</td>
        </tr>)}</tbody>
      </table></div>}
      {usage.failures.length > 0 && <><h4>Recent model failures</h4><ul className="admin-list">
        {usage.failures.map(failure => <li key={failure._id}>{failure.kind} · {profileName(failure.profileId)} · {failure.residentKey ? residentName(failure.residentKey) : 'Administrator diagnostic'} · {failure.errorCode}</li>)}
      </ul></>}
    </>}
    <h4>Provider request quotas</h4>
    {[...providers.values()].map(provider => {
      const quota = usage?.providerQuotas.find(row => row.kind === provider.kind && row.providerKey === provider.key);
      return <form className="admin-form" key={`${provider.kind}/${provider.key}/${quota?.maxRequestsPerDay}`} onSubmit={event => {
        event.preventDefault(); const fields = new FormData(event.currentTarget);
        void task.run('Saving provider quota', () => convex.mutation(api.models.usage.configureProviderQuota, {
          adminToken, kind: provider.kind, providerKey: provider.key,
          maxRequestsPerDay: quotaValue(fields, 'limit'), reason: String(fields.get('reason')).trim(),
        }));
      }}>
        <strong>{provider.kind} · {provider.name}</strong>
        <Field label="Requests per UTC day" hint="Applies across profiles on this provider endpoint. Blank is unlimited; zero pauses requests.">
          <input name="limit" type="number" min={0} max={1000000} step={1} defaultValue={quota?.maxRequestsPerDay ?? ''} />
        </Field>
        <Field label="Audit reason"><input name="reason" required maxLength={1000} /></Field>
        <AdminButton type="submit" disabled={!!task.pending}>Save provider quota</AdminButton>
      </form>;
    })}
    <h4>Resident request quotas</h4>
    {data.affectedResidents.map(binding => <form className="admin-form" key={`${binding._id}/${JSON.stringify(binding.requestQuotas)}`} onSubmit={event => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      void task.run('Saving resident quotas', () => convex.mutation(api.models.usage.configureResidentQuota, {
        adminToken, bindingId: binding._id as Id<'residentModelBindings'>,
        quotas: { chat: quotaValue(fields, 'chat'), embedding: quotaValue(fields, 'embedding') }, reason: String(fields.get('reason')).trim(),
      }));
    }}>
      <strong>{binding.name}</strong>
      <Field label="Chat requests per UTC day"><input name="chat" type="number" min={0} max={1000000} step={1} defaultValue={binding.requestQuotas?.chat ?? ''} /></Field>
      <Field label="Embedding requests per UTC day" hint="Blank is unlimited; zero pauses provider requests, retaining cached retrieval and raw memories."><input name="embedding" type="number" min={0} max={1000000} step={1} defaultValue={binding.requestQuotas?.embedding ?? ''} /></Field>
      <Field label="Audit reason"><input name="reason" required maxLength={1000} /></Field>
      <AdminButton type="submit" disabled={!!task.pending}>Save resident quotas</AdminButton>
    </form>)}
  </details>;
}

function EmbeddingScanProgress({ adminToken, jobId }: { adminToken: string; jobId?: Id<'embeddingScanJobs'> }) {
  const progress = useQuery(api.models.embeddings.scanProgress, jobId ? { adminToken, jobId } : 'skip');
  if (!progress) return null;
  return <p className="admin-muted">{progress.kind}: {progress.phase}; checked {progress.memoryCount} memories, {progress.vectorCount} vectors, {progress.sampleCount} retrieval samples.
    {progress.restarts > 0 && ` Source changed; restarted ${progress.restarts} times.`}
    {progress.phase === 'FAILED' && ' Resume validation after completing the missing vectors or correcting the failure.'}
  </p>;
}
