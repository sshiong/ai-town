import { useRef, useState, type ReactNode } from 'react';
import { useConvexConnectionState } from 'convex/react';
import { adminErrorSummary } from './uiPolicy';

export function AdminButton({
  children,
  disabled,
  onClick,
  type = 'button',
  danger = false,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  danger?: boolean;
}) {
  const connection = useConvexConnectionState();
  return (
    <button
      type={type}
      disabled={disabled || !connection.isWebSocketConnected}
      onClick={onClick}
      className={`admin-button button shadow-solid ${danger ? 'admin-button-danger' : ''}`}
    >
      <span>{children}</span>
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="admin-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="admin-empty">{children}</p>;
}

export function useAdminTask() {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const busy = useRef(false);
  async function run(label: string, work: () => Promise<unknown>, success = 'Saved.') {
    if (busy.current) return;
    busy.current = true;
    setPending(label);
    setError(undefined);
    setMessage(undefined);
    try {
      await work();
      setMessage(success);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The request failed. Please try again.');
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  }
  return { pending, error, message, run };
}

export function TaskFeedback({ task }: { task: ReturnType<typeof useAdminTask> }) {
  return (
    <div className="admin-feedback" aria-live="polite">
      {task.pending && <p role="status">{task.pending}…</p>}
      {task.error && (
        <>
          <p className="admin-error" role="alert">
            {adminErrorSummary(task.error)}
          </p>
          {adminErrorSummary(task.error) !== task.error && (
            <details className="admin-disclosure">
              <summary>Server error details</summary>
              <pre className="admin-report">{task.error}</pre>
            </details>
          )}
        </>
      )}
      {task.message && <p className="admin-success">{task.message}</p>}
    </div>
  );
}

export function formatTime(value?: number) {
  return value ? new Date(value).toLocaleString() : '—';
}

export function downloadBundle(value: unknown, filename: string) {
  downloadJsonText(JSON.stringify(value, null, 2), filename);
}

export function downloadJsonText(json: string, filename: string) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
