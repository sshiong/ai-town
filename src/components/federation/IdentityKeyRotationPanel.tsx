import { useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import {
  AdminButton,
  EmptyState,
  Field,
  TaskFeedback,
  formatTime,
  useAdminTask,
} from './AdminShared';

type Rotation = {
  rotationId: string;
  state: string;
  expiresAt: number;
  operator: string;
  reason: string;
  createdAt: number;
};
type Exchange = {
  rotationId: string;
  peerTownId: string;
  direction: string;
  state: string;
  attempts: number;
  nextRetryAt: number;
  lastError?: string;
};
type Status = {
  identityVersion: number;
  publicKey: string;
  fingerprint: string;
  rotations: Rotation[];
  exchanges: Exchange[];
};
const statusRef = makeFunctionReference<'query', { adminToken: string }, Status>(
  'federation/identityKeyRotation:status',
);
const actionRef = (name: string) =>
  makeFunctionReference<'action'>(`federation/identityKeyRotation:${name}`);
const mutationRef = (name: string) =>
  makeFunctionReference<'mutation'>(`federation/identityKeyRotation:${name}`);

export default function IdentityKeyRotationPanel({
  adminToken,
  peers,
}: {
  adminToken: string;
  peers: { townId: string; townName: string }[];
}) {
  const convex = useConvex();
  const task = useAdminTask();
  const data = useQuery(statusRef, { adminToken });
  const [operator, setOperator] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(10);
  const [oldKeyUnavailable, setOldKeyUnavailable] = useState(false);
  const [peerTownId, setPeerTownId] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [identityVersion, setIdentityVersion] = useState(1);
  const [independentFingerprint, setIndependentFingerprint] = useState('');
  const [independentlyVerified, setIndependentlyVerified] = useState(false);
  const [finishReviewed, setFinishReviewed] = useState(false);
  const [enableFederation, setEnableFederation] = useState(false);
  const audit = { adminToken, operator: operator.trim(), reason: reason.trim() };
  const canAct = !!operator.trim() && operator.length <= 100 && !!reason.trim() && reason.length <= 1000 && !task.pending;
  const run = (label: string, fn: () => Promise<unknown>, success: string) =>
    void task.run(label, fn, success);
  return (
    <section aria-label="Town identity key rotation">
      <h3>Town identity key rotation</h3>
      <p>
        Rotate this town’s signing key while keeping its town and resident identities. Every trusted
        neighbor must prove the new key before activation. After activation, delivery continues
        until each neighbor confirms.
      </p>
      {data && (
        <p className="admin-muted">
          Identity version {data.identityVersion}
          <br />
          Verified fingerprint: <code>{data.fingerprint}</code>
          <br />
          Public signing key: <code>{data.publicKey}</code>
        </p>
      )}
      <div className="admin-inline-form">
        <Field label="Identity operation operator">
          <input maxLength={100} value={operator} onChange={(e) => setOperator(e.target.value)} />
        </Field>
        <Field label="Identity operation reason">
          <input maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Preparation timeout (minutes)">
          <input
            type="number"
            min={1}
            max={30}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </Field>
      </div>
      <p className="admin-muted">
        Operator names are administrator declarations recorded for audit, not independently verified
        accounts.
      </p>
      <AdminButton
        disabled={!canAct || !Number.isInteger(minutes) || minutes < 1 || minutes > 30}
        onClick={() =>
          run(
            'Preparing identity key rotation',
            () =>
              convex.action(actionRef('start'), { ...audit, prepareTimeoutMs: minutes * 60000 }),
            'Preparation recorded. Review neighbor confirmations below.',
          )
        }
      >
        Prepare new signing key
      </AdminButton>
      {!data?.rotations.length ? (
        <EmptyState>No identity key operations recorded.</EmptyState>
      ) : (
        <ul className="admin-list">
          {data.rotations.map((rotation) => {
            const exchanges = data.exchanges.filter(
              (item) => item.rotationId === rotation.rotationId,
            );
            const confirmed = exchanges.every((item) => item.state === 'ACKED');
            return (
              <li key={rotation.rotationId}>
                <strong>
                  {rotation.state}
                  {rotation.state === 'COMMITTED'
                    ? confirmed
                      ? ' · all neighbors confirmed'
                      : ' · awaiting neighbor confirmation'
                    : ''}
                </strong>
                <code>{rotation.rotationId}</code>
                <p className="admin-muted">Preparation expires: {formatTime(rotation.expiresAt)}</p>
                {exchanges.map((item) => (
                  <p key={`${item.peerTownId}:${item.direction}`} className="admin-muted">
                    {peers.find((peer) => peer.townId === item.peerTownId)?.townName ??
                      item.peerTownId}{' '}
                    · {item.direction} · {item.state} · attempts {item.attempts}
                    {item.lastError ? ` · ${item.lastError}` : ''}
                  </p>
                ))}
                <div className="admin-toolbar">
                  {['PREPARING', 'COMMITTED'].includes(rotation.state) && (
                    <AdminButton
                      disabled={!!task.pending}
                      onClick={() =>
                        run(
                          'Retrying identity key delivery',
                          () =>
                            convex.action(actionRef('retry'), {
                              adminToken,
                              rotationId: rotation.rotationId,
                            }),
                          'Delivery retried. Check each neighbor’s status.',
                        )
                      }
                    >
                      Retry key delivery
                    </AdminButton>
                  )}
                  {rotation.state === 'PREPARING' && (
                    <AdminButton
                      danger
                      disabled={!canAct}
                      onClick={() =>
                        run(
                          'Cancelling key preparation',
                          () =>
                            convex.mutation(mutationRef('abort'), {
                              ...audit,
                              rotationId: rotation.rotationId,
                            }),
                          'Preparation cancelled before activation.',
                        )
                      }
                    >
                      Cancel preparation
                    </AdminButton>
                  )}
                  {rotation.state === 'RECOVERY' && (
                    <AdminButton
                      disabled={!canAct || !finishReviewed}
                      onClick={() =>
                        run(
                          'Finishing reviewed identity recovery',
                          () =>
                            convex.mutation(mutationRef('finishRecovery'), {
                              ...audit,
                              rotationId: rotation.rotationId,
                              enableFederation,
                            }),
                          'Recovery finalized with the selected federation admission setting.',
                        )
                      }
                    >
                      Finish reviewed recovery
                    </AdminButton>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <details className="admin-disclosure">
        <summary>Recover when the old signing key is unavailable</summary>
        <p>
          This stops federation admission and requires independent neighbor review. End visits and
          drain queued work first. Historical backups do not establish live trust.
        </p>
        <label className="admin-check">
          <input
            type="checkbox"
            checked={oldKeyUnavailable}
            onChange={(e) => setOldKeyUnavailable(e.target.checked)}
          />{' '}
          I confirmed that the old signing key is unavailable and reviewed this recovery.
        </label>
        <AdminButton
          danger
          disabled={!canAct || !oldKeyUnavailable}
          onClick={() =>
            run(
              'Creating reviewed recovery identity',
              () =>
                convex.action(actionRef('recoverLocalIdentity'), {
                  ...audit,
                  oldKeyUnavailable: true,
                }),
              'Recovery key created. Share its fingerprint through an independent channel and complete neighbor review.',
            )
          }
        >
          Create recovery signing key
        </AdminButton>
        <label className="admin-check">
          <input
            type="checkbox"
            checked={finishReviewed}
            onChange={(e) => setFinishReviewed(e.target.checked)}
          />{' '}
          I reviewed all neighbor identity confirmations before finishing recovery.
        </label>
        <label className="admin-check">
          <input
            type="checkbox"
            checked={enableFederation}
            onChange={(e) => setEnableFederation(e.target.checked)}
          />{' '}
          Enable federation admission when recovery finishes.
        </label>
      </details>
      <details className="admin-disclosure">
        <summary>Independently review a neighbor’s recovery key</summary>
        <p>
          Verify the claimed fingerprint through a separate channel before confirming. The server
          also challenges the neighbor to prove it holds the new private key.
        </p>
        <div className="admin-inline-form">
          <Field label="Recovery neighbor">
            <select
              value={peerTownId}
              onChange={(e) => {
                setPeerTownId(e.target.value);
                setIndependentlyVerified(false);
              }}
            >
              <option value="">Choose a neighbor</option>
              {peers.map((peer) => (
                <option key={peer.townId} value={peer.townId}>
                  {peer.townName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Neighbor new public key">
            <input
              value={publicKey}
              onChange={(e) => {
                setPublicKey(e.target.value);
                setIndependentlyVerified(false);
              }}
            />
          </Field>
          <Field label="Neighbor identity version">
            <input
              type="number"
              min={1}
              value={identityVersion}
              onChange={(e) => {
                setIdentityVersion(Number(e.target.value));
                setIndependentlyVerified(false);
              }}
            />
          </Field>
          <Field label="Independently verified fingerprint">
            <input
              value={independentFingerprint}
              onChange={(e) => {
                setIndependentFingerprint(e.target.value);
                setIndependentlyVerified(false);
              }}
            />
          </Field>
        </div>
        <label className="admin-check">
          <input
            type="checkbox"
            checked={independentlyVerified}
            onChange={(e) => setIndependentlyVerified(e.target.checked)}
          />{' '}
          I verified this exact public key fingerprint through an independent channel.
        </label>
        <AdminButton
          danger
          disabled={
            !canAct ||
            !peerTownId ||
            !publicKey.trim() ||
            !independentFingerprint.trim() ||
            !Number.isSafeInteger(identityVersion) ||
            identityVersion < 1 ||
            !independentlyVerified
          }
          onClick={() =>
            run(
              'Reviewing neighbor recovery key',
              () =>
                convex.action(actionRef('reviewPeerIdentity'), {
                  ...audit,
                  peerTownId,
                  publicKey: publicKey.trim(),
                  identityVersion,
                  independentFingerprint: independentFingerprint.trim(),
                  independentlyVerified: true,
                }),
              'Neighbor key challenge and independent review completed.',
            )
          }
        >
          Confirm reviewed neighbor key
        </AdminButton>
      </details>
      <TaskFeedback task={task} />
    </section>
  );
}
