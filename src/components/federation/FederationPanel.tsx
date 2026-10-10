import { useRef, useState, type FormEvent } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import ConflictPanel from './ConflictPanel';
import EndpointHistory from './EndpointHistory';
import CredentialRotationPanel from './CredentialRotationPanel';
import IdentityKeyRotationPanel from './IdentityKeyRotationPanel';
import {
  AdminButton,
  EmptyState,
  Field,
  TaskFeedback,
  formatTime,
  useAdminTask,
} from './AdminShared';

type Status = FunctionReturnType<typeof api.federation.admin.status>;

export default function FederationPanel({ adminToken }: { adminToken: string }) {
  const convex = useConvex();
  const task = useAdminTask();
  const data: Status | undefined = useQuery(api.federation.admin.status, { adminToken });
  const [pairingSecret, setPairingSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [pairEndpoint, setPairEndpoint] = useState('');
  const connectionForm = useRef<HTMLDetailsElement>(null);
  async function refresh() {
    await convex.query(api.federation.admin.status, { adminToken });
  }
  async function initialize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    await task.run('Creating town identity', async () => {
      await convex.action(api.federation.admin.initialize, {
        adminToken,
        townName: String(fields.get('townName')).trim(),
        endpoint: String(fields.get('endpoint')).trim(),
        maxVisitors: Number(fields.get('maxVisitors')),
      });
      await refresh();
    });
  }
  return (
    <section className="admin-panel">
      <h2>Town federation</h2>
      <p className="admin-muted">
        Direct HTTPS · Both towns must be able to request each other's endpoint. Pairing approval
        proves identity; independent two-way probes enable travel.
      </p>
      <TaskFeedback task={task} />
      {!data && <p role="status">Loading federation state…</p>}
      <AdminButton
        disabled={!!task.pending}
        onClick={() => void task.run('Refreshing', refresh, '')}
      >
        Refresh
      </AdminButton>
      {data &&
        (!data.identity ? (
          <form className="admin-form" onSubmit={(event) => void initialize(event)}>
            <h3 className="admin-form-actions">Create this town's identity</h3>
            <Field label="Town name">
              <input name="townName" required maxLength={80} />
            </Field>
            <Field
              label="Public HTTPS endpoint"
              hint="Use the Convex HTTP actions site URL, accessible from the other town."
            >
              <input
                name="endpoint"
                type="text"
                inputMode="url"
                required
                placeholder="https://your-deployment.convex.site"
              />
            </Field>
            <Field label="Maximum visitors">
              <input name="maxVisitors" type="number" min={0} max={100} defaultValue={5} required />
            </Field>
            <div className="admin-form-actions">
              <AdminButton type="submit" disabled={!!task.pending}>
                Initialize federation
              </AdminButton>
            </div>
          </form>
        ) : (
          <>
            <dl className="admin-facts">
              <dt>Town ID</dt>
              <dd>
                <code>{data.identity.townId}</code>
              </dd>
              <dt>Deployment</dt>
              <dd>
                {data.identity.mode} · epoch {data.identity.deploymentEpoch}
                <code>{data.identity.deploymentInstanceId}</code>
              </dd>
              <dt>Verified key fingerprint</dt>
              <dd>
                <code>{data.identity.fingerprint}</code>
              </dd>
            </dl>
            <form
              className="admin-inline-form"
              key={data.identity.endpoint}
              onSubmit={(event) => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                void task.run(
                  'Updating this town endpoint',
                  async () => {
                    await convex.mutation(api.federation.admin.updateLocalEndpoint, {
                      adminToken,
                      endpoint: String(fields.get('endpoint')).trim(),
                      operator: String(fields.get('operator')).trim(),
                      reason: String(fields.get('reason')).trim(),
                    });
                    await refresh();
                  },
                  'Address saved; signed updates are queued for connected towns. Travel resumes after fresh two-way probes.',
                );
              }}
            >
              <Field
                label="This town's HTTPS endpoint"
                hint="Changing the address preserves the stable Town ID and keys. Both sides must verify the new route before travel resumes."
              >
                <input
                  name="endpoint"
                  defaultValue={data.identity.endpoint}
                  required
                  type="text"
                  inputMode="url"
                />
              </Field>
              <Field label="Operator">
                <input name="operator" required maxLength={100} />
              </Field>
              <Field label="Address change reason">
                <input name="reason" required maxLength={1000} />
              </Field>
              <AdminButton type="submit" disabled={!!task.pending || data.identity.mode !== 'ACTIVE'}>
                Update town address
              </AdminButton>
            </form>
            <EndpointHistory adminToken={adminToken} />
            <h3>Admission &amp; safety</h3>
            <form
              className="admin-form"
              key={JSON.stringify(data.settings)}
              onSubmit={(event) => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                void task.run('Saving admission policy', async () => {
                  await convex.mutation(api.federation.admin.configure, {
                    adminToken,
                    enabled: fields.get('enabled') === 'on',
                    allowIncomingPairRequests: fields.get('incoming') === 'on',
                    maxVisitors: Number(fields.get('maxVisitors')),
                    maxVisitDurationMs: Number(fields.get('duration')) * 60000,
                    replyTimeoutMs: Number(fields.get('replyTimeout')) * 1000,
                  });
                  await refresh();
                });
              }}
            >
              <label className="admin-check">
                <input name="enabled" type="checkbox" defaultChecked={data.settings.enabled} />{' '}
                Enable federation visits
              </label>
              <label className="admin-check">
                <input
                  name="incoming"
                  type="checkbox"
                  defaultChecked={data.settings.allowIncomingPairRequests}
                />{' '}
                Accept new pairing requests
              </label>
              <Field label="Maximum visitors">
                <input
                  name="maxVisitors"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={data.settings.maxVisitors}
                  required
                />
              </Field>
              <Field label="Maximum visit (minutes)">
                <input
                  name="duration"
                  type="number"
                  min={1}
                  max={30}
                  defaultValue={data.settings.maxVisitDurationMs / 60000}
                  required
                />
              </Field>
              <Field
                label="Host decision wait (seconds)"
                hint="Allow 5–120 seconds for a visiting resident's model reply. Expired decisions are discarded; visit leases still apply."
              >
                <input
                  name="replyTimeout"
                  type="number"
                  min={5}
                  max={120}
                  step={1}
                  defaultValue={(data.settings.replyTimeoutMs ?? 25000) / 1000}
                  required
                />
              </Field>
              <div className="admin-form-actions">
                <AdminButton type="submit" disabled={!!task.pending}>
                  Save policy
                </AdminButton>
              </div>
            </form>
            {data.resources && (
              <>
                <h3>Town capacity</h3>
                <p className="admin-muted">
                  Admission: <strong>{data.resources.admissionState}</strong> ·{' '}
                  {data.resources.residents} residents · {data.resources.humans} people ·{' '}
                  {data.resources.reservations} reservations. Model requests:{' '}
                  {data.resources.runningLocalLLM} running, {data.resources.pendingLocalLLM} queued.{' '}
                  Pending visitor decisions: {data.resources.pendingDecisions}.
                </p>
                <form
                  className="admin-form"
                  key={JSON.stringify(data.resources.limits)}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const fields = new FormData(event.currentTarget);
                    void task.run('Saving town capacity', async () => {
                      await convex.mutation(api.federation.admin.configureResources, {
                        adminToken,
                        limits: {
                          maxResidentAgents: Number(fields.get('maxResidentAgents')),
                          maxHumanPlayers: Number(fields.get('maxHumanPlayers')),
                          maxVisitReservations: Number(fields.get('maxVisitReservations')),
                          maxConcurrentLocalLLM: Number(fields.get('maxConcurrentLocalLLM')),
                          maxPendingDecisions: Number(fields.get('maxPendingDecisions')),
                          maxPendingLocalLLM: Number(fields.get('maxPendingLocalLLM')),
                        },
                      });
                      await refresh();
                    });
                  }}
                >
                  {(
                    [
                      [
                        'maxResidentAgents',
                        'Resident limit',
                        'Includes residents currently traveling.',
                      ],
                      [
                        'maxHumanPlayers',
                        'People limit',
                        'Limits new human players across this town.',
                      ],
                      [
                        'maxVisitReservations',
                        'Reservation limit',
                        'Limits visits reserved before arrival.',
                      ],
                      [
                        'maxConcurrentLocalLLM',
                        'Concurrent model requests',
                        'Shared by resident conversations, visiting brains and memory work.',
                      ],
                      [
                        'maxPendingDecisions',
                        'Pending visitor decisions',
                        'Limits outstanding remote decision turns.',
                      ],
                      [
                        'maxPendingLocalLLM',
                        'Queued model requests',
                        'Requests wait in order for up to 30 seconds within their overall deadline.',
                      ],
                    ] as const
                  ).map(([key, label, hint]) => (
                    <Field key={key} label={label} hint={hint}>
                      <input
                        name={key}
                        type="number"
                        min={0}
                        max={key === 'maxConcurrentLocalLLM' ? 32 : 1000}
                        step={1}
                        defaultValue={data.resources.limits[key]}
                        required
                      />
                    </Field>
                  ))}
                  <div className="admin-form-actions">
                    <AdminButton type="submit" disabled={!!task.pending}>
                      Save capacity
                    </AdminButton>
                  </div>
                </form>
                <p className="admin-muted">
                  Reducing limits preserves existing residents and work. Zero pauses new admissions
                  or requests for that budget. CPU and memory measurements are unavailable.
                </p>
                <form
                  className="admin-inline-form"
                  key={String(data.resources.maxVisitorsPerSourceTown)}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const fields = new FormData(event.currentTarget);
                    const raw = String(fields.get('sourceQuota')).trim();
                    void task.run('Saving source visitor quota', async () => {
                      await convex.mutation(
                        api.federation.resourceMonitoring.configureSourceQuota,
                        {
                          adminToken,
                          maxVisitorsPerSourceTown: raw === '' ? null : Number(raw),
                        },
                      );
                      await refresh();
                    });
                  }}
                >
                  <Field
                    label="Visitor slots per source town"
                    hint="Leave blank to use only the total town limit. This cap counts reservations and visitors awaiting physical cleanup; it preserves existing visits and is not a waiting queue."
                  >
                    <input
                      name="sourceQuota"
                      type="number"
                      min={0}
                      max={1000}
                      step={1}
                      defaultValue={data.resources.maxVisitorsPerSourceTown ?? ''}
                    />
                  </Field>
                  <AdminButton type="submit" disabled={!!task.pending}>
                    Save source quota
                  </AdminButton>
                </form>
                <form
                  className="admin-inline-form"
                  key={`event-rate-${data.resources.maxRemoteEventsPerSecond}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const raw = String(new FormData(event.currentTarget).get('eventRate')).trim();
                    void task.run('Saving remote event rate', async () => {
                      await convex.mutation(api.federation.resourceMonitoring.configureRemoteEventRate, {
                        adminToken, maxRemoteEventsPerSecond: raw === '' ? null : Number(raw),
                      });
                      await refresh();
                    });
                  }}
                >
                  <Field
                    label="Remote work events per second"
                    hint="Leave blank for unlimited. A shared token bucket permits a burst of up to this limit and refills each second. Zero pauses new visit requests and immediate runtime events. Retries reuse their receipts; lease renewals, return, cleanup, history and stream recovery remain available."
                  >
                    <input name="eventRate" type="number" min={0} max={1000} step={1}
                      defaultValue={data.resources.maxRemoteEventsPerSecond ?? ''} />
                  </Field>
                  <AdminButton type="submit" disabled={!!task.pending}>Save event rate</AdminButton>
                </form>
                {data.resources.sourceOccupancy.length > 0 && (
                  <ul className="admin-list">
                    {data.resources.sourceOccupancy.map((source) => (
                      <li key={source.townId}>
                        <code>{source.townId}</code> · {source.occupied} occupied visitor slots
                      </li>
                    ))}
                  </ul>
                )}
                <h3>Measured workload</h3>
                <p className="admin-muted">
                  Window: {formatTime(data.resources.measurements.windowStartedAt)} to{' '}
                  {formatTime(data.resources.measurements.measuredAt)}. Values update when server
                  state changes or you refresh. CPU and memory: unavailable.
                </p>
                <dl className="admin-facts">
                  <dt>Authenticated inbound events</dt>
                  <dd>
                    {data.resources.measurements.inboundEvents} unique events ·{' '}
                    {data.resources.measurements.inboundEventsPerSecond.toFixed(3)}/second. Includes
                    buffered and rejected sequences; retries are counted once. Probes are excluded.
                  </dd>
                  {(
                    [
                      ['Model queue wait', data.resources.measurements.chatQueue],
                      ['Model call duration', data.resources.measurements.chatProvider],
                      ['Successful remote decision', data.resources.measurements.decision],
                      [
                        'Failed / expired remote decision',
                        data.resources.measurements.failedDecision,
                      ],
                    ] as const
                  ).map(([label, metric]) => (
                    <div key={label} style={{ display: 'contents' }}>
                      <dt>{label}</dt>
                      <dd>
                        {metric.meanMs === null
                          ? 'No measured completions'
                          : `${metric.meanMs.toFixed(0)} ms mean · ${metric.p95Ms?.toFixed(0)} ms P95`}{' '}
                        · {metric.durationCount} measured · {metric.sampleCount} P95 samples
                        {metric.sampled ? ' (recent samples per bucket; truncated)' : ''}
                      </dd>
                    </div>
                  ))}
                  <dt>Model outcomes</dt>
                  <dd>
                    {data.resources.measurements.chatSucceeded} succeeded ·{' '}
                    {data.resources.measurements.chatFailed} failed ·{' '}
                    {data.resources.measurements.chatAbandoned} abandoned permits reclaimed
                  </dd>
                </dl>
                <p className="admin-muted">
                  Model duration includes provider retries. Remote decision duration runs from
                  receipt of the observation job to its terminal result, including memory retrieval,
                  queue wait and model calls. Abandoned work has no fabricated completion time.
                </p>
                <details className="admin-disclosure">
                  <summary>Recent capacity policy audit</summary>
                  {!data.resources.audit.length && (
                    <p className="admin-muted">No capacity policy changes recorded.</p>
                  )}
                  <ul className="admin-list">
                    {data.resources.audit.map((entry) => (
                      <li key={entry._id}>
                        {formatTime(entry.createdAt)} · {entry.operation}
                        <pre className="admin-report">
                          {JSON.stringify({ previous: entry.previous, next: entry.next }, null, 2)}
                        </pre>
                      </li>
                    ))}
                  </ul>
                </details>
              </>
            )}
            <p className="admin-warning">
              Unencrypted HTTP is disabled (DISABLED). The required authentication library is
              unavailable in this build. HTTP-SIGNED-PLAINTEXT would expose chat, observations and
              metadata to eavesdropping; it provides no confidentiality.
            </p>
            <h3>Connected towns</h3>
            {!data.peers.length && (
              <EmptyState>
                Add a town below, approve the request on both ends, then run a two-way transport
                probe.
              </EmptyState>
            )}
            <ul className="admin-list">
              {data.peers.map((peer) => (
                <li key={peer.townId}>
                  <div className="admin-peer">
                    <strong>{peer.townName}</strong>{' '}
                    <span className="admin-badge">{peer.trustState}</span>{' '}
                    <span className="admin-badge">{peer.channelState}</span>
                    <code>{peer.townId}</code>
                    <code>{peer.fingerprint}</code>
                    <p>{peer.endpoint}</p>
                    <p className="admin-muted">
                      {peer.transportType} ·{' '}
                      {peer.channelState === 'TRANSPORT_READY'
                        ? 'Both directions verified'
                        : 'Travel blocked until both directions are verified'}
                    </p>
                    {peer.lastError && <p className="admin-error">{peer.lastError}</p>}
                    <div className="admin-toolbar">
                      <AdminButton
                        disabled={!!task.pending || peer.trustState !== 'TRUSTED'}
                        onClick={() =>
                          void task.run(
                            'Testing both directions',
                            async () => {
                              await convex.action(api.federation.transport.probe, {
                                adminToken,
                                peerTownId: peer.townId,
                              });
                              await refresh();
                            },
                            'Probe finished. Check the transport state above.',
                          )
                        }
                      >
                        Probe transport
                      </AdminButton>
                    </div>
                    <form
                      className="admin-inline-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const fields = new FormData(event.currentTarget);
                        void task.run(
                          'Verifying new endpoint',
                          async () => {
                            await convex.action(api.federation.peers.updateEndpoint, {
                              adminToken,
                              peerTownId: peer.townId,
                              endpoint: String(fields.get('endpoint')).trim(),
                              operator: String(fields.get('operator')).trim(),
                              reason: String(fields.get('reason')).trim(),
                            });
                            await refresh();
                          },
                          'Endpoint verified. Run new probes before travel.',
                        );
                      }}
                    >
                      <Field label="Update endpoint">
                        <input
                          name="endpoint"
                          type="text"
                          inputMode="url"
                          defaultValue={peer.endpoint}
                          required
                        />
                      </Field>
                      <Field label="Operator">
                        <input name="operator" required maxLength={100} />
                      </Field>
                      <Field label="Verification reason">
                        <input name="reason" required maxLength={1000} />
                      </Field>
                      <AdminButton type="submit" disabled={!!task.pending || peer.trustState !== 'TRUSTED' || data.identity?.mode !== 'ACTIVE'}>
                        Verify &amp; update
                      </AdminButton>
                    </form>
                    <form
                      className="admin-inline-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const fields = new FormData(event.currentTarget);
                        const state = String(fields.get('trustState'));
                        if (state !== 'TRUSTED' && state !== 'PAUSED' && state !== 'REVOKED')
                          return;
                        void task.run('Saving peer permissions', async () => {
                          await convex.mutation(api.federation.peers.setPolicy, {
                            adminToken,
                            peerTownId: peer.townId,
                            inboundVisitsAllowed: fields.get('inbound') === 'on',
                            outboundVisitsAllowed: fields.get('outbound') === 'on',
                            trustState: state,
                          });
                          await refresh();
                        });
                      }}
                    >
                      <label className="admin-check">
                        <input
                          name="inbound"
                          type="checkbox"
                          defaultChecked={peer.inboundVisitsAllowed}
                        />{' '}
                        Incoming visits
                      </label>
                      <label className="admin-check">
                        <input
                          name="outbound"
                          type="checkbox"
                          defaultChecked={peer.outboundVisitsAllowed}
                        />{' '}
                        Outgoing visits
                      </label>
                      <Field label="Trust policy">
                        <select name="trustState" defaultValue={peer.trustState}>
                          <option>TRUSTED</option>
                          <option>PAUSED</option>
                          <option>REVOKED</option>
                        </select>
                      </Field>
                      <AdminButton type="submit" disabled={!!task.pending}>
                        Save permissions
                      </AdminButton>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
            <h3>
              Pairing requests{' '}
              {data.unreadPairRequests > 0 && (
                <span className="admin-badge" role="status">
                  {data.unreadPairRequests > 1000 ? '1000+' : data.unreadPairRequests} unread
                </span>
              )}
            </h3>
            {!data.pairRequests.length && (
              <EmptyState>
                No pairing requests. A request never grants visitor admission by itself.
              </EmptyState>
            )}
            <ul className="admin-list">
              {data.pairRequests.map((request) => (
                <li key={request.pairRequestId}>
                  <div className="admin-peer">
                    <strong>{request.claimedTownName ?? request.endpoint}</strong>{' '}
                    <span className="admin-badge">
                      {request.direction} · {request.state}
                    </span>
                    {request.unread && <span className="admin-badge">Unread request</span>}
                    <code>{request.pairRequestId}</code>
                    <p>{request.endpoint}</p>
                    <p className={request.identityVerified ? 'admin-muted' : 'admin-warning'}>
                      {request.identityVerified
                        ? 'Identity verified by pairing.'
                        : 'Self-reported identity — not yet verified. The name, Town ID, fingerprint and address are claims until both towns complete authentication.'}
                    </p>
                    <code>Claimed Town ID: {request.claimedTownId}</code>
                    <code>Claimed fingerprint: {request.fingerprint}</code>
                    <p className="admin-muted">
                      Protocol: {request.protocol ?? 'Unknown'} ·{' '}
                      {request.endpoint.startsWith('https:') ? 'HTTPS' : 'HTTP'}
                    </p>
                    <p className="admin-muted">Requested: {formatTime(request.requestedAt)}</p>
                    <p className="admin-muted">Expires: {formatTime(request.expiresAt)}</p>
                    {request.unread && (
                      <AdminButton
                        disabled={!!task.pending}
                        onClick={() =>
                          void task.run(
                            'Marking request read',
                            async () => {
                              await convex.mutation(api.federation.peers.markPairRead, {
                                adminToken,
                                pairRequestId: request.pairRequestId,
                              });
                              await refresh();
                            },
                            '',
                          )
                        }
                      >
                        Mark read
                      </AdminButton>
                    )}
                    {request.state === 'PENDING_APPROVAL' && (
                      <p role="status">
                        {request.direction === 'OUTBOUND'
                          ? 'Waiting for the other administrator to approve. No trust or visitor access has been granted.'
                          : 'A town requests a connection. Accepting requires the secret independently agreed with its administrator.'}
                      </p>
                    )}
                    {request.state === 'PENDING_BOTH_CONFIRM' && (
                      <p role="status">
                        Waiting for both towns to confirm their identity and communication
                        credential. Travel is unavailable.{' '}
                        {request.direction === 'OUTBOUND' &&
                          'Continue to reconcile: the other town may already have received confirmation.'}
                      </p>
                    )}
                    {request.state === 'CANCEL_PENDING' && (
                      <p role="status">
                        Cancelled locally; awaiting the other town's acknowledgement. Local
                        authentication is blocked. Retry cancellation if the connection was
                        interrupted; the remote request also expires at the time above.
                      </p>
                    )}
                    {request.state === 'CANCELLED' && (
                      <p role="status">This request was cancelled. It cannot establish trust.</p>
                    )}
                    {request.state === 'REJECTED' && (
                      <p role="status">
                        {request.direction === 'OUTBOUND'
                          ? 'The other administrator rejected this request.'
                          : 'You rejected this request.'}{' '}
                        History is retained; a new request is allowed after the cooldown.
                      </p>
                    )}
                    {request.state === 'AUTH_FAILED' && (
                      <p role="status">
                        Pairing secret or identity verification failed. No connection was
                        established. Agree on a secret through a trusted channel before submitting a
                        new request.
                      </p>
                    )}
                    {request.direction === 'INBOUND' && request.state === 'PENDING_APPROVAL' && (
                      <form
                        className="admin-inline-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const fields = new FormData(event.currentTarget);
                          void task.run('Approving and authenticating', async () => {
                            await convex.action(api.federation.peers.approvePair, {
                              adminToken,
                              pairRequestId: request.pairRequestId,
                              pairingSecret: String(fields.get('secret')).trim(),
                            });
                            await refresh();
                          });
                        }}
                      >
                        <Field
                          label="Shared high-entropy pairing secret"
                          hint="Enter the secret previously agreed through a trusted channel. The request does not supply a trusted secret."
                        >
                          <input name="secret" type="password" autoComplete="off" required />
                        </Field>
                        <AdminButton type="submit" disabled={!!task.pending}>
                          Approve &amp; verify
                        </AdminButton>
                        <AdminButton
                          danger
                          disabled={!!task.pending}
                          onClick={() =>
                            void task.run('Rejecting request', async () => {
                              await convex.mutation(api.federation.peers.rejectPair, {
                                adminToken,
                                pairRequestId: request.pairRequestId,
                              });
                              await refresh();
                            })
                          }
                        >
                          Reject
                        </AdminButton>
                      </form>
                    )}
                    {request.direction === 'OUTBOUND' &&
                      ['PENDING_APPROVAL', 'PENDING_BOTH_CONFIRM'].includes(request.state) && (
                        <AdminButton
                          disabled={!!task.pending}
                          onClick={() =>
                            void task.run('Checking pairing approval', async () => {
                              await convex.action(api.federation.peers.continuePair, {
                                adminToken,
                                pairRequestId: request.pairRequestId,
                              });
                              await refresh();
                            })
                          }
                        >
                          Check / continue pairing
                        </AdminButton>
                      )}
                    {((request.direction === 'OUTBOUND' &&
                      ['PENDING_APPROVAL', 'CANCEL_PENDING'].includes(request.state)) ||
                      (request.direction === 'INBOUND' &&
                        ['PENDING_APPROVAL', 'PENDING_BOTH_CONFIRM', 'AUTH_FAILED'].includes(
                          request.state,
                        ))) && (
                      <AdminButton
                        danger
                        disabled={!!task.pending}
                        onClick={() =>
                          void task.run(
                            'Cancelling pairing request',
                            async () => {
                              await convex.action(api.federation.peers.cancelPair, {
                                adminToken,
                                pairRequestId: request.pairRequestId,
                              });
                              await refresh();
                            },
                            'Pairing request closed. Its recorded result is shown above.',
                          )
                        }
                      >
                        {request.state === 'CANCEL_PENDING'
                          ? 'Retry cancellation'
                          : 'Cancel request'}
                      </AdminButton>
                    )}
                    {request.direction === 'OUTBOUND' &&
                      ['REJECTED', 'EXPIRED', 'AUTH_FAILED', 'CANCELLED'].includes(
                        request.state,
                      ) && (
                        <>
                          <p className="admin-muted">
                            New request available after {formatTime(request.retryAfter)}. Refresh
                            after the cooldown.
                          </p>
                          <AdminButton
                            disabled={!!task.pending || request.retryAfter > Date.now()}
                            onClick={() => {
                              setPairEndpoint(request.endpoint);
                              setPairingSecret('');
                              if (connectionForm.current) {
                                connectionForm.current.open = true;
                                connectionForm.current.scrollIntoView({
                                  behavior: 'smooth',
                                  block: 'nearest',
                                });
                              }
                            }}
                          >
                            Prepare new request
                          </AdminButton>
                        </>
                      )}
                  </div>
                </li>
              ))}
            </ul>
            <details className="admin-disclosure" ref={connectionForm}>
              <summary>Request a connection</summary>
              <p className="admin-muted">
                Share the same generated secret with the other administrator through a trusted
                channel. It is used for authentication and never sent as plaintext to the peer.
              </p>
              <AdminButton
                disabled={!!task.pending}
                onClick={() =>
                  void task.run(
                    'Generating pairing secret',
                    async () => {
                      const result = await convex.action(
                        api.federation.admin.generatePairingSecret,
                        { adminToken },
                      );
                      setPairingSecret(result.pairingSecret);
                    },
                    'Secret generated. Copy it securely; it is only shown in this form.',
                  )
                }
              >
                Generate secret
              </AdminButton>
              <form
                className="admin-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void task.run(
                    'Sending pairing request',
                    async () => {
                      await convex.action(api.federation.peers.requestPair, {
                        adminToken,
                        endpoint: pairEndpoint.trim(),
                        pairingSecret,
                      });
                      setPairingSecret('');
                      await refresh();
                    },
                    'Request sent. Wait for the other administrator to approve, then continue pairing.',
                  );
                }}
              >
                <Field label="Other town's HTTPS endpoint">
                  <input
                    name="endpoint"
                    value={pairEndpoint}
                    onChange={(event) => setPairEndpoint(event.target.value)}
                    type="text"
                    inputMode="url"
                    required
                    placeholder="https://other-town.convex.site"
                  />
                </Field>
                <Field label="Shared pairing secret">
                  <input
                    value={pairingSecret}
                    onChange={(event) => setPairingSecret(event.target.value)}
                    autoComplete="off"
                    required
                    type={showSecret ? 'text' : 'password'}
                  />
                </Field>
                <label className="admin-check">
                  <input
                    type="checkbox"
                    checked={showSecret}
                    onChange={(event) => setShowSecret(event.target.checked)}
                  />{' '}
                  Show generated secret to copy securely
                </label>
                <div className="admin-form-actions">
                  <AdminButton type="submit" disabled={!!task.pending}>
                    Send pairing request
                  </AdminButton>
                </div>
              </form>
            </details>
            <ConflictPanel adminToken={adminToken} />
            <CredentialRotationPanel adminToken={adminToken} peers={data.peers} />
            <IdentityKeyRotationPanel adminToken={adminToken} peers={data.peers} />
          </>
        ))}
    </section>
  );
}
