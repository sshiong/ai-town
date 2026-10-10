import { useState, type FormEvent } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import { AdminButton, EmptyState, Field, TaskFeedback, useAdminTask } from './AdminShared';

type Profiles = FunctionReturnType<typeof api.models.profiles.list>;
const providers = ['openai', 'together', 'ollama', 'custom'] as const;

export default function ModelsPanel({ adminToken }: { adminToken: string }) {
  const convex = useConvex();
  const task = useAdminTask();
  const data: Profiles | undefined = useQuery(api.models.profiles.list, { adminToken });
  const [kind, setKind] = useState<'chat' | 'embedding'>('chat');
  const [plan, setPlan] = useState<FunctionReturnType<typeof api.models.embeddings.planSwitch>>();
  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const descriptions = useQuery(
    api.world.gameDescriptions,
    worldStatus ? { worldId: worldStatus.worldId } : 'skip',
  );
  const residents = useQuery(api.federation.runtime.listResidents, { adminToken });
  const [reviewedProfile, setReviewedProfile] = useState<string>();
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
          preprocessingRevision: String(fields.get('preprocessingRevision')).trim() || 'v1',
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
                </div>
                <div className="admin-toolbar">
                  <AdminButton
                    disabled={!!task.pending || !profile.credentialAvailable}
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
                    disabled={!!task.pending || data.settings?.mainChatProfileId === profile._id || data.audits.find(a => a.subject === profile._id && ['PROBE_CHAT_SUCCESS', 'PROBE_CHAT_FAILED'].includes(a.operation))?.operation !== 'PROBE_CHAT_SUCCESS'}
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
                      <option key={p._id} value={p._id}>
                        {p.name} · {p.model}
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
                      disabled={!!task.pending || !profile.credentialAvailable}
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
                      disabled={!!task.pending}
                      onClick={() =>
                        void task.run(
                          'Checking vector compatibility',
                          async () => {
                            setPlan(
                              await convex.query(api.models.embeddings.planSwitch, {
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
                </div>
              </li>
            ))}
          </ul>
          {plan && (
            <div className="admin-warning">
              <strong>{plan.compatibility}</strong>
              <p>
                Target profile:{' '}
                {data.embeddingProfiles.find((p) => p._id === reviewedProfile)?.name}
              </p>
              <p>Current space: {plan.sourceFingerprint ?? 'none'}</p>
              <p>Target space: {plan.targetFingerprint}</p>
              <p>
                Affected memories: {plan.affectedMemories}.{' '}
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
                  {space.failure && <p className="admin-error">{space.failure}</p>}
                  <div className="admin-toolbar">
                    <AdminButton
                      disabled={!!task.pending || space.status !== 'READY'}
                      onClick={() =>
                        void task.run('Validating coverage and retrieval', async () => {
                          await convex.action(api.models.embeddings.validateSpace, {
                            adminToken,
                            spaceId: space._id,
                          });
                          await refresh();
                        })
                      }
                    >
                      Validate
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
                      disabled={!!task.pending || space.status !== 'RETIRED'}
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
          <details className="admin-disclosure">
            <summary>Model audit history</summary>
            <ul className="admin-list">
              {data.audits.map((audit) => (
                <li key={audit._id}>
                  <div>
                    <strong>{audit.operation}</strong>
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
                <input name="dimensions" type="number" min={1} max={65536} required />
              </Field>
              <Field label="Immutable model revision">
                <input name="immutableRevision" />
              </Field>
              <Field label="Weights digest / compatibility evidence">
                <input name="weightsDigest" />
              </Field>
              <Field label="Preprocessing revision">
                <input name="preprocessingRevision" defaultValue="v1" required />
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
