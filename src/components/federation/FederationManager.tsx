import { useState } from 'react';
import ReactModal from 'react-modal';
import { useConvex, useConvexConnectionState } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import FederationPanel from './FederationPanel';
import ModelsPanel from './ModelsPanel';
import TravelPanel from './TravelPanel';
import DataPanel from './DataPanel';
import { AdminButton, Field, TaskFeedback, useAdminTask } from './AdminShared';
import { TownErrorBoundary } from '../ConvexClientProvider';

const storageKey = 'ai-town-federation-admin';
function storedToken() {
  try {
    return sessionStorage.getItem(storageKey) ?? '';
  } catch {
    return '';
  }
}

export default function FederationManager({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const convex = useConvex();
  const task = useAdminTask();
  const connection = useConvexConnectionState();
  const [inputToken, setInputToken] = useState(storedToken);
  const [adminToken, setAdminToken] = useState('');
  const [remember, setRemember] = useState(false);
  const [tab, setTab] = useState('town');
  function lock() {
    setAdminToken('');
    setInputToken('');
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Storage may be disabled. */
    }
  }
  return (
    <ReactModal
      isOpen={isOpen}
      onRequestClose={onClose}
      contentLabel="Town administration"
      className="federation-modal font-body"
      overlayClassName="federation-overlay"
      ariaHideApp={false}
      shouldCloseOnOverlayClick={false}
    >
      <header className="admin-header">
        <div>
          <p className="admin-eyebrow">AI Town · Direct federation</p>
          <h1 className="font-display">Town administration</h1>
        </div>
        <button
          type="button"
          className="admin-close"
          aria-label="Close town administration"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {!adminToken ? (
        <section className="admin-panel admin-unlock">
          <h2>Administrator access</h2>
          <p>
            Enter the token configured as FEDERATION_ADMIN_TOKEN on this server. Town simulation
            continues independently of this panel.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void task.run(
                'Checking administrator access',
                async () => {
                  await convex.query(api.federation.admin.status, { adminToken: inputToken });
                  if (remember) {
                    try {
                      sessionStorage.setItem(storageKey, inputToken);
                    } catch {
                      throw new Error(
                        'Session storage is unavailable. Uncheck remember and try again.',
                      );
                    }
                  } else {
                    try {
                      sessionStorage.removeItem(storageKey);
                    } catch {
                      /* No persisted token. */
                    }
                  }
                  setAdminToken(inputToken);
                },
                '',
              );
            }}
          >
            <Field label="Admin token">
              <input
                type="password"
                value={inputToken}
                onChange={(event) => setInputToken(event.target.value)}
                autoComplete="off"
                required
              />
            </Field>
            <label className="admin-check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />{' '}
              Remember in this browser tab's session
            </label>
            <p className="admin-muted">
              By default, the token stays in memory. Close this tab or lock the panel to clear
              access.
            </p>
            {!connection.isWebSocketConnected && (
              <p role="status" className="admin-warning">
                The town server is not connected. Access checks will become available after
                reconnection.
              </p>
            )}
            <AdminButton
              type="submit"
              disabled={!!task.pending || !connection.isWebSocketConnected}
            >
              Open administration
            </AdminButton>
          </form>
          <TaskFeedback task={task} />
        </section>
      ) : (
        <>
          <nav className="admin-tabs" aria-label="Administration sections">
            {[
              ['town', 'Federation'],
              ['travel', 'Travel & visitors'],
              ['models', 'Models & memory'],
              ['data', 'Data & backups'],
            ].map(([id, name]) => (
              <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
                {name}
              </button>
            ))}
            <button type="button" onClick={lock}>
              Lock
            </button>
          </nav>
          {!connection.isWebSocketConnected && (
            <p className="admin-warning" role="status">
              Connection interrupted. Displayed values may be stale; operations wait for the server.
            </p>
          )}
          <TownErrorBoundary key={tab}>
            {tab === 'town' && <FederationPanel adminToken={adminToken} />}
            {tab === 'travel' && <TravelPanel adminToken={adminToken} />}
            {tab === 'models' && <ModelsPanel adminToken={adminToken} />}
            {tab === 'data' && <DataPanel adminToken={adminToken} />}
          </TownErrorBoundary>
        </>
      )}
    </ReactModal>
  );
}
