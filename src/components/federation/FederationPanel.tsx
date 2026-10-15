import { useLocale } from '../../i18n';
import { useRef, useState, type FormEvent } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import ConflictPanel from './ConflictPanel';
import EndpointHistory from './EndpointHistory';
import CredentialRotationPanel from './CredentialRotationPanel';
import IdentityKeyRotationPanel from './IdentityKeyRotationPanel';
import VisitorQueuePanel from './VisitorQueuePanel';
import ResidentPolicyPanel from './ResidentPolicyPanel';
import HostResourcePanel from './HostResourcePanel';
import CloneActivationPanel from './CloneActivationPanel';
import { adminErrorSummary } from './uiPolicy';
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
  const { t } = useLocale();
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
    await task.run(t("Creating town identity"), async () => {
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
      <h2>{t("Town federation")}</h2>
      <p className="admin-muted">
        {t("Direct HTTPS · Both towns must be able to request each other's endpoint. Pairing approval proves identity; independent two-way probes enable travel.")}
      </p>
      <TaskFeedback task={task} />
      {!data && <p role="status">{t("Loading federation state…")}</p>}
      <AdminButton
        disabled={!!task.pending}
        onClick={() => void task.run(t("Refreshing"), refresh, '')}
      >
        {t("Refresh")}
      </AdminButton>
      {data &&
        (!data.identity ? (
          <form className="admin-form" onSubmit={(event) => void initialize(event)}>
            <h3 className="admin-form-actions">{t("Create this town's identity")}</h3>
            <Field label={t("Town name")}>
              <input name="townName" required maxLength={80} />
            </Field>
            <Field
              label={t("Public HTTPS endpoint")}
              hint={t("Use the Convex HTTP actions site URL, accessible from the other town.")}
            >
              <input
                name="endpoint"
                type="text"
                inputMode="url"
                required
                placeholder="https://your-deployment.convex.site"
              />
            </Field>
            <Field label={t("Maximum visitors")}>
              <input name="maxVisitors" type="number" min={0} max={100} defaultValue={5} required />
            </Field>
            <div className="admin-form-actions">
              <AdminButton type="submit" disabled={!!task.pending}>
                {t("Initialize federation")}
              </AdminButton>
            </div>
          </form>
        ) : (
          <>
            <dl className="admin-facts">
              <dt>{t("Town ID")}</dt>
              <dd>
                <code>{data.identity.townId}</code>
              </dd>
              <dt>{t("Deployment")}</dt>
              <dd>
                {data.identity.mode} {t("· epoch")} {data.identity.deploymentEpoch}
                <code>{data.identity.deploymentInstanceId}</code>
              </dd>
              <dt>{t("Verified key fingerprint")}</dt>
              <dd>
                <code>{data.identity.fingerprint}</code>
              </dd>
            </dl>
            <CloneActivationPanel
              key={`${data.identity.townId}:${data.identity.deploymentInstanceId}:${data.identity.deploymentEpoch}`}
              adminToken={adminToken} status={data} task={task} refresh={refresh}
            />
            <form
              className="admin-inline-form"
              key={`${data.identity.endpoint}:${data.identity.endpointGeneration}`}
              onSubmit={(event) => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                void task.run(
                  t("Updating this town endpoint"),
                  async () => {
                    await convex.mutation(api.federation.admin.updateLocalEndpoint, {
                      adminToken,
                      endpoint: String(fields.get('endpoint')).trim(),
                      endpointCandidates: [
                        { url: String(fields.get('endpoint')).trim(), priority: Number(fields.get('primaryPriority')) },
                        ...String(fields.get('backupEndpoints')).split('\n').map(line => line.trim()).filter(Boolean).map(line => {
                          const [priority, ...url] = line.split(/\s+/);
                          return { priority: Number(priority), url: url.join(' ') };
                        }),
                      ],
                      operator: String(fields.get('operator')).trim(),
                      reason: String(fields.get('reason')).trim(),
                    });
                    await refresh();
                  },
                  t("Address saved; signed updates are queued for connected towns. Travel resumes after fresh two-way probes."),
                );
              }}
            >
              <Field
                label={t("This town's HTTPS endpoint")}
                hint={t("Changing the address preserves the stable Town ID and keys. Both sides must verify the new route before travel resumes.")}
              >
                <input
                  name="endpoint"
                  defaultValue={data.identity.endpoint}
                  required
                  type="text"
                  inputMode="url"
                />
              </Field>
              <Field label={t("Primary address priority")} hint={t("Lower numbers are tried first. The primary address must have the highest priority.")}>
                <input name="primaryPriority" type="number" min={0} max={1000} step={1} required
                  defaultValue={data.identity.endpointCandidates?.find(candidate => candidate.url === data.identity!.endpoint)?.priority ?? 10} />
              </Field>
              <Field label={t("Backup HTTPS addresses")} hint={t("Up to three backups, one per line: priority followed by HTTPS URL (for example: 20 https://backup.example.com). Each route must prove the same trusted identity; travel still requires both directions.")}>
                <textarea name="backupEndpoints" rows={3} maxLength={6000}
                  defaultValue={(data.identity.endpointCandidates ?? []).filter(candidate => candidate.url !== data.identity!.endpoint).map(candidate => `${candidate.priority} ${candidate.url}`).join('\n')} />
              </Field>
              <Field label={t("Operator")}>
                <input name="operator" required maxLength={100} />
              </Field>
              <Field label={t("Address change reason")}>
                <input name="reason" required maxLength={1000} />
              </Field>
              <AdminButton type="submit" disabled={!!task.pending || data.identity.mode !== 'ACTIVE'}>
                {t("Update town address")}
              </AdminButton>
            </form>
            <EndpointHistory adminToken={adminToken} />
            <h3>{t("Admission & safety")}</h3>
            <form
              className="admin-form"
              key={JSON.stringify(data.settings)}
              onSubmit={(event) => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                void task.run(t("Saving admission policy"), async () => {
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
                {t("Enable federation visits")}
              </label>
              <label className="admin-check">
                <input
                  name="incoming"
                  type="checkbox"
                  defaultChecked={data.settings.allowIncomingPairRequests}
                />{' '}
                {t("Accept new pairing requests")}
              </label>
              <Field label={t("Maximum visitors")}>
                <input
                  name="maxVisitors"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={data.settings.maxVisitors}
                  required
                />
              </Field>
              <Field label={t("Maximum visit (minutes)")}>
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
                label={t("Host decision wait (seconds)")}
                hint={t("Allow 5–120 seconds for a visiting resident's model reply. Expired decisions are discarded; visit leases still apply.")}
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
                  {t("Save policy")}
                </AdminButton>
              </div>
            </form>
            {data.resources && (
              <>
                <VisitorQueuePanel adminToken={adminToken} configurationOnly />
                <ResidentPolicyPanel adminToken={adminToken} />
                <h3>{t("Town capacity")}</h3>
                <p className="admin-muted">
                  {t("Admission:")} <strong>{data.resources.admissionState}</strong> ·{' '}
                  {data.resources.residents} {t("residents ·")} {data.resources.humans} {t("people ·")}{' '}
                  {data.resources.reservations} {t("reservations. Model requests:")}{' '}
                  {data.resources.runningLocalLLM} {t("running,")} {data.resources.pendingLocalLLM} {t("queued.")}{' '}
                  {t("Pending visitor decisions:")} {data.resources.pendingDecisions}.
                </p>
                <form
                  className="admin-form"
                  key={JSON.stringify(data.resources.limits)}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const fields = new FormData(event.currentTarget);
                    void task.run(t("Saving town capacity"), async () => {
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
                        t("Resident limit"),
                        t("Includes residents currently traveling."),
                      ],
                      [
                        'maxHumanPlayers',
                        t("People limit"),
                        t("Limits new human players across this town."),
                      ],
                      [
                        'maxVisitReservations',
                        t("Reservation limit"),
                        t("Limits visits reserved before arrival."),
                      ],
                      [
                        'maxConcurrentLocalLLM',
                        t("Concurrent model requests"),
                        t("Shared by resident conversations, visiting brains and memory work."),
                      ],
                      [
                        'maxPendingDecisions',
                        t("Pending visitor decisions"),
                        t("Limits outstanding remote decision turns."),
                      ],
                      [
                        'maxPendingLocalLLM',
                        t("Queued model requests"),
                        t("Requests wait in order for up to 30 seconds within their overall deadline."),
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
                      {t("Save capacity")}
                    </AdminButton>
                  </div>
                </form>
                <p className="admin-muted">
                  {t("Reducing limits preserves existing residents and work. Zero pauses new admissions or requests for that budget.")}
                </p>
                <form
                  className="admin-inline-form"
                  key={String(data.resources.maxVisitorsPerSourceTown)}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const fields = new FormData(event.currentTarget);
                    const raw = String(fields.get('sourceQuota')).trim();
                    void task.run(t("Saving source visitor quota"), async () => {
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
                    label={t("Visitor slots per source town")}
                    hint={t("Leave blank to use only the total town limit. This cap counts reservations and visitors awaiting physical cleanup; it preserves existing visits and is not a waiting queue.")}
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
                    {t("Save source quota")}
                  </AdminButton>
                </form>
                <form
                  className="admin-inline-form"
                  key={`event-rate-${data.resources.maxRemoteEventsPerSecond}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const raw = String(new FormData(event.currentTarget).get('eventRate')).trim();
                    void task.run(t("Saving remote event rate"), async () => {
                      await convex.mutation(api.federation.resourceMonitoring.configureRemoteEventRate, {
                        adminToken, maxRemoteEventsPerSecond: raw === '' ? null : Number(raw),
                      });
                      await refresh();
                    });
                  }}
                >
                  <Field
                    label={t("Remote work events per second")}
                    hint={t("Leave blank for unlimited. A shared token bucket permits a burst of up to this limit and refills each second. Zero pauses new visit requests and immediate runtime events. Retries reuse their receipts; lease renewals, return, cleanup, history and stream recovery remain available.")}
                  >
                    <input name="eventRate" type="number" min={0} max={1000} step={1}
                      defaultValue={data.resources.maxRemoteEventsPerSecond ?? ''} />
                  </Field>
                  <AdminButton type="submit" disabled={!!task.pending}>{t("Save event rate")}</AdminButton>
                </form>
                {data.resources.sourceOccupancy.length > 0 && (
                  <ul className="admin-list">
                    {data.resources.sourceOccupancy.map((source) => (
                      <li key={source.townId}>
                        <code>{source.townId}</code> · {source.occupied} {t("occupied visitor slots")}
                      </li>
                    ))}
                  </ul>
                )}
                <HostResourcePanel adminToken={adminToken} resources={data.resources.hostResources}
                  key={`host-resources-${JSON.stringify(data.resources.hostResources.thresholds)}`} />
                <h3>{t("Measured workload")}</h3>
                <p className="admin-muted">
                  {t("Window:")} {formatTime(data.resources.measurements.windowStartedAt)} {t("to")}{' '}
                  {formatTime(data.resources.measurements.measuredAt)}{t(". Values update when server state changes or you refresh.")}
                </p>
                <dl className="admin-facts">
                  <dt>{t("Authenticated inbound events")}</dt>
                  <dd>
                    {data.resources.measurements.inboundEvents} {t("unique events ·")}{' '}
                    {data.resources.measurements.inboundEventsPerSecond.toFixed(3)}{t("/second. Includes buffered and rejected sequences; retries are counted once. Probes are excluded.")}
                  </dd>
                  {(
                    [
                      [t("Model queue wait"), data.resources.measurements.chatQueue],
                      [t("Model call duration"), data.resources.measurements.chatProvider],
                      [t("Successful remote decision"), data.resources.measurements.decision],
                      [
                        t("Failed / expired remote decision"),
                        data.resources.measurements.failedDecision,
                      ],
                    ] as const
                  ).map(([label, metric]) => (
                    <div key={label} style={{ display: 'contents' }}>
                      <dt>{label}</dt>
                      <dd>
                        {metric.meanMs === null
                          ? t("No measured completions")
                          : t("{mean} ms mean · {p95} ms P95", { mean: metric.meanMs.toFixed(0), p95: metric.p95Ms?.toFixed(0) ?? "" })}{' '}
                        · {metric.durationCount} {t("measured ·")} {metric.sampleCount} {t("P95 samples")}
                        {metric.sampled ? t(" (recent samples per bucket; truncated)") : ''}
                      </dd>
                    </div>
                  ))}
                  <dt>{t("Model outcomes")}</dt>
                  <dd>
                    {data.resources.measurements.chatSucceeded} {t("succeeded ·")}{' '}
                    {data.resources.measurements.chatFailed} {t("failed ·")}{' '}
                    {data.resources.measurements.chatAbandoned} {t("abandoned permits reclaimed")}
                  </dd>
                </dl>
                <p className="admin-muted">
                  {t("Model duration includes provider retries. Remote decision duration runs from receipt of the observation job to its terminal result, including memory retrieval, queue wait and model calls. Abandoned work has no fabricated completion time.")}
                </p>
                <details className="admin-disclosure">
                  <summary>{t("Recent capacity policy audit")}</summary>
                  {!data.resources.audit.length && (
                    <p className="admin-muted">{t("No capacity policy changes recorded.")}</p>
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
              {t("Unencrypted HTTP is disabled (DISABLED). The required authentication library is unavailable in this build. HTTP-SIGNED-PLAINTEXT would expose chat, observations and metadata to eavesdropping; it provides no confidentiality.")}
            </p>
            <h3>{t("Connected towns")}</h3>
            {!data.peers.length && (
              <EmptyState>
                {t("Add a town below, approve the request on both ends, then run a two-way transport probe.")}
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
                    {(peer.endpointCandidates?.length ?? 0) > 1 && <ul className="admin-muted">
                      {peer.endpointCandidates!.map(candidate => <li key={candidate.url}>{t("Priority")} {candidate.priority} · {candidate.url}</li>)}
                    </ul>}
                    {peer.outboundEndpoint && <p className="admin-muted">{t("Verified outbound route:")} {peer.outboundEndpoint}</p>}
                    <p className="admin-muted">
                      {peer.transportType} ·{' '}
                      {peer.channelState === 'TRANSPORT_READY'
                        ? t("Both directions verified")
                        : t("Travel blocked until both directions are verified")}
                    </p>
                    {peer.lastError && <p className="admin-error">{adminErrorSummary(peer.lastError, t)} <code>{peer.lastError}</code></p>}
                    <div className="admin-toolbar">
                      <AdminButton
                        disabled={!!task.pending || peer.trustState !== 'TRUSTED'}
                        onClick={() =>
                          void task.run(
                            t("Testing both directions"),
                            async () => {
                              await convex.action(api.federation.transport.probe, {
                                adminToken,
                                peerTownId: peer.townId,
                              });
                              await refresh();
                            },
                            t("Probe finished. Check the transport state above."),
                          )
                        }
                      >
                        {t("Probe transport")}
                      </AdminButton>
                    </div>
                    <form
                      className="admin-inline-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const fields = new FormData(event.currentTarget);
                        void task.run(
                          t("Verifying new endpoint"),
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
                          t("Endpoint verified. Run new probes before travel."),
                        );
                      }}
                    >
                      <Field label={t("Update endpoint")}>
                        <input
                          name="endpoint"
                          type="text"
                          inputMode="url"
                          defaultValue={peer.endpoint}
                          required
                        />
                      </Field>
                      <Field label={t("Operator")}>
                        <input name="operator" required maxLength={100} />
                      </Field>
                      <Field label={t("Verification reason")}>
                        <input name="reason" required maxLength={1000} />
                      </Field>
                      <AdminButton type="submit" disabled={!!task.pending || peer.trustState !== 'TRUSTED' || data.identity?.mode !== 'ACTIVE'}>
                        {t("Verify & update")}
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
                        void task.run(t("Saving peer permissions"), async () => {
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
                        {t("Incoming visits")}
                      </label>
                      <label className="admin-check">
                        <input
                          name="outbound"
                          type="checkbox"
                          defaultChecked={peer.outboundVisitsAllowed}
                        />{' '}
                        {t("Outgoing visits")}
                      </label>
                      <Field label={t("Trust policy")}>
                        <select name="trustState" defaultValue={peer.trustState}>
                          <option value="TRUSTED">{t("TRUSTED")}</option>
                          <option value="PAUSED">{t("PAUSED")}</option>
                          <option value="REVOKED">{t("REVOKED")}</option>
                        </select>
                      </Field>
                      <AdminButton type="submit" disabled={!!task.pending}>
                        {t("Save permissions")}
                      </AdminButton>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
            <h3>
              {t("Pairing requests")}{' '}
              {data.unreadPairRequests > 0 && (
                <span className="admin-badge" role="status">
                  {data.unreadPairRequests > 1000 ? '1000+' : data.unreadPairRequests} {t("unread")}
                </span>
              )}
            </h3>
            {!data.pairRequests.length && (
              <EmptyState>
                {t("No pairing requests. A request never grants visitor admission by itself.")}
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
                    {request.unread && <span className="admin-badge">{t("Unread request")}</span>}
                    <code>{request.pairRequestId}</code>
                    <p>{request.endpoint}</p>
                    <p className={request.identityVerified ? 'admin-muted' : 'admin-warning'}>
                      {request.identityVerified
                        ? t("Identity verified by pairing.")
                        : t("Self-reported identity — not yet verified. The name, Town ID, fingerprint and address are claims until both towns complete authentication.")}
                    </p>
                    <code>{t("Claimed Town ID:")} {request.claimedTownId}</code>
                    <code>{t("Claimed fingerprint:")} {request.fingerprint}</code>
                    <p className="admin-muted">
                      {t("Protocol:")} {request.protocol ?? t("Unknown")} ·{' '}
                      {request.endpoint.startsWith('https:') ? 'HTTPS' : 'HTTP'}
                    </p>
                    <p className="admin-muted">{t("Requested:")} {formatTime(request.requestedAt)}</p>
                    <p className="admin-muted">{t("Expires:")} {formatTime(request.expiresAt)}</p>
                    {request.unread && (
                      <AdminButton
                        disabled={!!task.pending}
                        onClick={() =>
                          void task.run(
                            t("Marking request read"),
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
                        {t("Mark read")}
                      </AdminButton>
                    )}
                    {request.state === 'PENDING_APPROVAL' && (
                      <p role="status">
                        {request.direction === 'OUTBOUND'
                          ? t("Waiting for the other administrator to approve. No trust or visitor access has been granted.")
                          : t("A town requests a connection. Accepting requires the secret independently agreed with its administrator.")}
                      </p>
                    )}
                    {request.state === 'PENDING_BOTH_CONFIRM' && (
                      <p role="status">
                        {t("Waiting for both towns to confirm their identity and communication credential. Travel is unavailable.")}{' '}
                        {request.direction === 'OUTBOUND' &&
                          t("Continue to reconcile: the other town may already have received confirmation.")}
                      </p>
                    )}
                    {request.state === 'CANCEL_PENDING' && (
                      <p role="status">
                        {t("Cancelled locally; awaiting the other town's acknowledgement. Local authentication is blocked. Retry cancellation if the connection was interrupted; the remote request also expires at the time above.")}
                      </p>
                    )}
                    {request.state === 'CANCELLED' && (
                      <p role="status">{t("This request was cancelled. It cannot establish trust.")}</p>
                    )}
                    {request.state === 'REJECTED' && (
                      <p role="status">
                        {request.direction === 'OUTBOUND'
                          ? t("The other administrator rejected this request.")
                          : t("You rejected this request.")}{' '}
                        {t("History is retained; a new request is allowed after the cooldown.")}
                      </p>
                    )}
                    {request.state === 'AUTH_FAILED' && (
                      <p role="status">
                        {t("Pairing secret or identity verification failed. No connection was established. Agree on a secret through a trusted channel before submitting a new request.")}
                      </p>
                    )}
                    {request.direction === 'INBOUND' && request.state === 'PENDING_APPROVAL' && (
                      <form
                        className="admin-inline-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const fields = new FormData(event.currentTarget);
                          void task.run(t("Approving and authenticating"), async () => {
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
                          label={t("Shared high-entropy pairing secret")}
                          hint={t("Enter the secret previously agreed through a trusted channel. The request does not supply a trusted secret.")}
                        >
                          <input name="secret" type="password" autoComplete="off" required />
                        </Field>
                        <AdminButton type="submit" disabled={!!task.pending}>
                          {t("Approve & verify")}
                        </AdminButton>
                        <AdminButton
                          danger
                          disabled={!!task.pending}
                          onClick={() =>
                            void task.run(t("Rejecting request"), async () => {
                              await convex.mutation(api.federation.peers.rejectPair, {
                                adminToken,
                                pairRequestId: request.pairRequestId,
                              });
                              await refresh();
                            })
                          }
                        >
                          {t("Reject")}
                        </AdminButton>
                      </form>
                    )}
                    {request.direction === 'OUTBOUND' &&
                      ['PENDING_APPROVAL', 'PENDING_BOTH_CONFIRM'].includes(request.state) && (
                        <AdminButton
                          disabled={!!task.pending}
                          onClick={() =>
                            void task.run(t("Checking pairing approval"), async () => {
                              await convex.action(api.federation.peers.continuePair, {
                                adminToken,
                                pairRequestId: request.pairRequestId,
                              });
                              await refresh();
                            })
                          }
                        >
                          {t("Check / continue pairing")}
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
                            t("Cancelling pairing request"),
                            async () => {
                              await convex.action(api.federation.peers.cancelPair, {
                                adminToken,
                                pairRequestId: request.pairRequestId,
                              });
                              await refresh();
                            },
                            t("Pairing request closed. Its recorded result is shown above."),
                          )
                        }
                      >
                        {request.state === 'CANCEL_PENDING'
                          ? t("Retry cancellation")
                          : t("Cancel request")}
                      </AdminButton>
                    )}
                    {request.direction === 'OUTBOUND' &&
                      ['REJECTED', 'EXPIRED', 'AUTH_FAILED', 'CANCELLED'].includes(
                        request.state,
                      ) && (
                        <>
                          <p className="admin-muted">
                            {t("New request available after")} {formatTime(request.retryAfter)}{t(". Refresh after the cooldown.")}
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
                            {t("Prepare new request")}
                          </AdminButton>
                        </>
                      )}
                  </div>
                </li>
              ))}
            </ul>
            <details className="admin-disclosure" ref={connectionForm}>
              <summary>{t("Request a connection")}</summary>
              <p className="admin-muted">
                {t("Share the same generated secret with the other administrator through a trusted channel. It is used for authentication and never sent as plaintext to the peer.")}
              </p>
              <AdminButton
                disabled={!!task.pending}
                onClick={() =>
                  void task.run(
                    t("Generating pairing secret"),
                    async () => {
                      const result = await convex.action(
                        api.federation.admin.generatePairingSecret,
                        { adminToken },
                      );
                      setPairingSecret(result.pairingSecret);
                    },
                    t("Secret generated. Copy it securely; it is only shown in this form."),
                  )
                }
              >
                {t("Generate secret")}
              </AdminButton>
              <form
                className="admin-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void task.run(
                    t("Sending pairing request"),
                    async () => {
                      await convex.action(api.federation.peers.requestPair, {
                        adminToken,
                        endpoint: pairEndpoint.trim(),
                        pairingSecret,
                      });
                      setPairingSecret('');
                      await refresh();
                    },
                    t("Request sent. Wait for the other administrator to approve, then continue pairing."),
                  );
                }}
              >
                <Field label={t("Other town's HTTPS endpoint")}>
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
                <Field label={t("Shared pairing secret")}>
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
                  {t("Show generated secret to copy securely")}
                </label>
                <div className="admin-form-actions">
                  <AdminButton type="submit" disabled={!!task.pending}>
                    {t("Send pairing request")}
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
