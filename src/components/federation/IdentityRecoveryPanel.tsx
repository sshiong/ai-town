import { useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { readArchiveJson, validRecoveryPassphrase } from './archiveFiles';
import { api } from '../../../convex/_generated/api';
import {
  AdminButton,
  Field,
  TaskFeedback,
  downloadBundle,
  formatTime,
  useAdminTask,
} from './AdminShared';

export default function IdentityRecoveryPanel({ adminToken }: { adminToken: string }) {
  const convex = useConvex();
  const task = useAdminTask();
  const status = useQuery(api.federation.admin.status, { adminToken });
  const history = useQuery(api.federation.identityRecovery.history, { adminToken });
  const world = useQuery(api.world.defaultWorldStatus);
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [encryptedPackage, setEncryptedPackage] = useState<unknown>();
  const [filename, setFilename] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [sourceStopped, setSourceStopped] = useState(false);
  const [cloneRiskAccepted, setCloneRiskAccepted] = useState(false);
  const [result, setResult] = useState<unknown>();
  const emptyTarget = status?.identity === null && world === null;
  return (
    <section aria-label="Encrypted identity disaster recovery">
      <h3>Encrypted identity disaster recovery</h3>
      <p className="admin-warning">
        This separate package contains the town's long-term private identity. Restoring it while the
        old source still runs can create two deployments with the same identity. Stop the source
        before restoration and keep the encrypted file and its passphrase separately.
      </p>
      <p className="admin-muted">
        Ordinary town archives never contain this private key. Peer credentials and model API keys
        are not restored by this workflow. Passphrases stay in this form only and are cleared after
        each request; they are not saved in browser storage.
      </p>
      <TaskFeedback task={task} />
      <details className="admin-disclosure">
        <summary>Export encrypted identity package</summary>
        {!status?.identity && (
          <p className="admin-muted">
            Initialize the town identity before exporting its recovery package.
          </p>
        )}
        <form
          className="admin-form"
          onSubmit={(event) => {
            event.preventDefault();
            void task.run(
              'Encrypting identity recovery package',
              async () => {
                if (!validRecoveryPassphrase(passphrase))
                  throw new Error('Use at least 12 characters and no more than 1024 UTF-8 bytes.');
                if (passphrase !== confirmation) throw new Error('The passphrases do not match.');
                const secret = passphrase;
                setPassphrase('');
                setConfirmation('');
                downloadBundle(
                  await convex.action(api.federation.identityRecovery.exportEncryptedIdentity, {
                    adminToken,
                    passphrase: secret,
                  }),
                  `ai-town-identity-encrypted-${Date.now()}.json`,
                );
              },
              'Encrypted identity package downloaded. Preserve it separately from the ordinary archive and keep its passphrase offline.',
            );
          }}
        >
          <Field
            label="Identity backup passphrase"
            hint="Use at least 12 characters, up to 1024 UTF-8 bytes. Losing it makes this package unrecoverable."
          >
            <input
              type="password"
              minLength={12}
              maxLength={1024}
              required
              autoComplete="new-password"
              value={passphrase}
              disabled={!!task.pending}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </Field>
          <Field label="Confirm identity backup passphrase">
            <input
              type="password"
              minLength={12}
              maxLength={1024}
              required
              autoComplete="new-password"
              value={confirmation}
              disabled={!!task.pending}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Field>
          <div className="admin-form-actions">
            <AdminButton
              type="submit"
              disabled={
                !!task.pending ||
                !status?.identity ||
                !validRecoveryPassphrase(passphrase) ||
                passphrase !== confirmation
              }
            >
              Download encrypted identity
            </AdminButton>
          </div>
        </form>
      </details>
      <details className="admin-disclosure">
        <summary>Restore identity on an empty deployment</summary>
        {!emptyTarget && (
          <p className="admin-warning">
            Identity restoration requires an empty deployment with no identity or world. This server
            already has town data, or its state has not finished loading.
          </p>
        )}
        <form
          className="admin-form"
          onSubmit={(event) => {
            event.preventDefault();
            void task.run(
              'Decrypting and verifying identity recovery package',
              async () => {
                if (!validRecoveryPassphrase(restorePassphrase))
                  throw new Error('Use at least 12 characters and no more than 1024 UTF-8 bytes.');
                const secret = restorePassphrase;
                setRestorePassphrase('');
                setResult(
                  await convex.action(api.federation.identityRecovery.restoreEncryptedIdentity, {
                    adminToken,
                    passphrase: secret,
                    package: encryptedPackage,
                    sourceStopped: true,
                    endpoint: endpoint.trim(),
                  }),
                );
                setEncryptedPackage(undefined);
                setSourceStopped(false);
                setCloneRiskAccepted(false);
              },
              'The server decrypted and restored this town identity. Federation stays disabled and peers must be paired again. Import the ordinary town archive separately.',
            );
          }}
        >
          <Field
            label="Encrypted identity JSON file"
            hint="Select an encrypted identity package up to 64 KiB. Loading it does not verify or decrypt its contents."
          >
            <input
              type="file"
              accept=".json,application/json"
              disabled={!!task.pending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                setEncryptedPackage(undefined);
                setFilename('');
                setResult(undefined);
                setRestorePassphrase('');
                setSourceStopped(false);
                setCloneRiskAccepted(false);
                if (!file) return;
                void task.run(
                  'Reading encrypted identity package',
                  async () => {
                    const value = await readArchiveJson(file, 64 * 1024);
                    setEncryptedPackage(value);
                    setFilename(file.name);
                  },
                  'File loaded as unverified ciphertext. Only the server can decrypt and authenticate it with the correct passphrase.',
                );
              }}
            />
          </Field>
          <Field label="Identity recovery passphrase">
            <input
              type="password"
              minLength={12}
              maxLength={1024}
              required
              autoComplete="off"
              value={restorePassphrase}
              disabled={!!task.pending}
              onChange={(event) => setRestorePassphrase(event.target.value)}
            />
          </Field>
          <Field label="Recovered deployment's HTTPS endpoint">
            <input
              type="url"
              required
              value={endpoint}
              disabled={!!task.pending}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://recovered-deployment.convex.site"
            />
          </Field>
          <div className="admin-form-actions">
            {filename && (
              <p className="admin-muted">Selected: {filename} · UNVERIFIED CIPHERTEXT</p>
            )}
            <label className="admin-check">
              <input
                type="checkbox"
                checked={sourceStopped}
                disabled={!!task.pending}
                onChange={(event) => setSourceStopped(event.target.checked)}
              />{' '}
              The old source deployment is stopped and cannot issue or renew authorizations.
            </label>
            <label className="admin-check">
              <input
                type="checkbox"
                checked={cloneRiskAccepted}
                disabled={!!task.pending}
                onChange={(event) => setCloneRiskAccepted(event.target.checked)}
              />{' '}
              I understand that restoring this identity to another active deployment can create a
              clone conflict.
            </label>
            <AdminButton
              type="submit"
              danger
              disabled={
                !!task.pending ||
                !emptyTarget ||
                !encryptedPackage ||
                !validRecoveryPassphrase(restorePassphrase) ||
                !endpoint.trim() ||
                !sourceStopped ||
                !cloneRiskAccepted
              }
            >
              Decrypt &amp; restore identity
            </AdminButton>
          </div>
        </form>
        {result !== undefined && (
          <>
            <h3>Verified server recovery result</h3>
            <pre className="admin-report">{JSON.stringify(result, null, 2)}</pre>
          </>
        )}
      </details>
      <details className="admin-disclosure">
        <summary>Identity recovery audit history</summary>
        {!history?.length ? (
          <p className="admin-muted">No identity export or restoration operations recorded.</p>
        ) : (
          <ul className="admin-list">
            {history.map((item) => (
              <li key={item._id}>
                <div>
                  <strong>{item.operation}</strong>
                  <code>{item.townId}</code>
                  <p className="admin-muted">
                    {formatTime(item.createdAt)} · source epoch {item.sourceDeploymentEpoch}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
