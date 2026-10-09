import { useState, type FormEvent } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
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
                    });
                    await refresh();
                  },
                  'Address updated; town identity is unchanged. Ask connected administrators to verify the new endpoint, then run fresh two-way probes.',
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
              <AdminButton type="submit" disabled={!!task.pending}>
                Update town address
              </AdminButton>
            </form>
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
                      <AdminButton type="submit" disabled={!!task.pending}>
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
            <h3>Pairing requests</h3>
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
                    <code>{request.pairRequestId}</code>
                    <p>{request.endpoint}</p>
                    <code>Claimed fingerprint: {request.fingerprint}</code>
                    <p className="admin-muted">Expires: {formatTime(request.expiresAt)}</p>
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
                        <Field label="Shared high-entropy pairing secret">
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
                      !['TRUSTED', 'REJECTED', 'EXPIRED', 'FAILED'].includes(request.state) && (
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
                  </div>
                </li>
              ))}
            </ul>
            <details className="admin-disclosure">
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
                  const fields = new FormData(event.currentTarget);
                  void task.run(
                    'Sending pairing request',
                    async () => {
                      await convex.action(api.federation.peers.requestPair, {
                        adminToken,
                        endpoint: String(fields.get('endpoint')).trim(),
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
          </>
        ))}
    </section>
  );
}
