import { useState } from 'react';
import { useConvex } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import { AdminButton, Field, TaskFeedback, formatTime, useAdminTask } from './AdminShared';

type HostResources = FunctionReturnType<typeof api.federation.admin.status>['resources']['hostResources'];

export default function HostResourcePanel({ adminToken, resources }: {
  adminToken: string;
  resources: HostResources;
}) {
  const convex = useConvex();
  const task = useAdminTask();
  const [enabled, setEnabled] = useState(!!resources.thresholds);
  const labels: Record<string, string> = {
    AVAILABLE: 'Fresh measurement',
    UNAVAILABLE: 'No measurement',
    STALE: 'Measurement expired',
    DEPLOYMENT_MISMATCH: 'Measurement belongs to another deployment',
  };
  return (
    <section aria-label="Host resource protection">
      <h3>Host resource protection</h3>
      <p className="admin-muted">
        Measurements come from the machine running the trusted collector. Run it on the host
        you want to protect. They describe that host's operating system, including other processes.
      </p>
      <dl className="admin-facts">
        <dt>Measurement</dt><dd>{labels[resources.status] ?? resources.status}</dd>
        <dt>CPU</dt><dd>{resources.cpu === null ? 'Unavailable' : `${resources.cpu.toFixed(1)}%`}</dd>
        <dt>Memory</dt><dd>{resources.memory === null ? 'Unavailable' :
          `${resources.memory.usedPercent.toFixed(1)}% · ${(resources.memory.usedBytes / 1024 ** 3).toFixed(2)} / ${(resources.memory.totalBytes / 1024 ** 3).toFixed(2)} GiB`}</dd>
        <dt>Measured at</dt><dd>{formatTime(resources.measuredAt ?? undefined)}</dd>
        <dt>Sample interval</dt><dd>{resources.sampleIntervalMs === null ? 'Unavailable' : `${resources.sampleIntervalMs / 1000}s`}</dd>
        <dt>Protection</dt><dd>{resources.thresholds ? 'Enabled' : 'Disabled'}</dd>
      </dl>
      {resources.reasons.length > 0 && (
        <p className="admin-muted">Admission checks: {resources.reasons.join(', ')}</p>
      )}
      <TaskFeedback task={task} />
      <form className="admin-form" onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        void task.run('Saving host protection', () => convex.mutation(
          api.federation.resourceMonitoring.configureHostResources, {
            adminToken,
            thresholds: enabled ? {
              maxCpuPercent: Number(fields.get('cpu')),
              maxMemoryPercent: Number(fields.get('memory')),
              maxSampleAgeMs: Number(fields.get('age')) * 1000,
            } : null,
          },
        ));
      }}>
        <label className="admin-form-actions">
          <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
          {' '}Protect new visitor admissions using host measurements
        </label>
        <Field label="CPU threshold (%)">
          <input name="cpu" type="number" min={0.1} max={100} step={0.1}
            defaultValue={resources.thresholds?.maxCpuPercent ?? 90} required disabled={!enabled} />
        </Field>
        <Field label="Memory threshold (%)">
          <input name="memory" type="number" min={0.1} max={100} step={0.1}
            defaultValue={resources.thresholds?.maxMemoryPercent ?? 90} required disabled={!enabled} />
        </Field>
        <Field label="Maximum sample age (seconds)">
          <input name="age" type="number" min={5} max={120} step={0.001}
            defaultValue={(resources.thresholds?.maxSampleAgeMs ?? 30000) / 1000} required disabled={!enabled} />
        </Field>
        <p className="admin-muted admin-form-actions">
          Enabled protection pauses new admissions when a threshold is reached or a trusted sample
          is missing, expired, or from another deployment. Existing visitors can still return and
          be cleaned up. Configure a collector before enabling protection.
        </p>
        <div className="admin-form-actions">
          <AdminButton type="submit" disabled={!!task.pending}>Save host protection</AdminButton>
        </div>
      </form>
    </section>
  );
}
