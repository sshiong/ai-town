import { useEffect, useRef, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type {
  SelectiveScope,
  Selection,
  SelectiveManifest,
} from '../../../convex/federation/backupSelectiveHelpers';
import { AdminButton, Field, TaskFeedback, downloadJsonText, useAdminTask } from './AdminShared';
import { selectArchiveDirectory, supportsArchiveDirectory, writeArchiveText } from './archiveFiles';
import { encryptBackupText, validBackupPassphrase } from './backupEncryption';

type JobArgs = { adminToken: string; jobId: Id<'backupLargeJobs'> };
type Job = {
  jobId: Id<'backupLargeJobs'>;
  state: string;
  phase: string;
  recordCount: number;
  chunkCount: number;
  bytes: number;
  selection: Selection;
  error?: string;
};
const status = makeFunctionReference<'query', JobArgs, Job>('federation/backupSelective:status');
const listJobs = makeFunctionReference<'query', { adminToken: string }, Job[]>(
  'federation/backupSelective:listJobs',
);
const mutation = (name: string) =>
  makeFunctionReference<'mutation'>(`federation/backupSelective:${name}`);
const advance = makeFunctionReference<'action', JobArgs, Job>(
  'federation/backupSelective:advanceExport',
);
const getManifest = makeFunctionReference<
  'action',
  JobArgs,
  { manifest: SelectiveManifest; signature: string }
>('federation/backupSelective:getManifest');
const getChunk = makeFunctionReference<'action', JobArgs & { index: number }, string>(
  'federation/backupSelective:getChunk',
);
function allowedCategories(scope: SelectiveScope): string[] {
  if (scope === 'config-only') return ['configuration'];
  if (scope === 'memories-only') return ['conversation', 'relationship', 'reflection', 'travel'];
  if (scope === 'history') return ['conversation', 'social', 'travel'];
  return ['conversation', 'relationship', 'reflection', 'travel', 'social'];
}
const scopes: { value: SelectiveScope; label: string }[] = [
  { value: 'agent-one', label: 'One resident (all pages)' },
  { value: 'agents-selected', label: 'Selected residents' },
  { value: 'config-only', label: 'Configuration only' },
  { value: 'memories-only', label: 'Raw memories' },
  { value: 'history', label: 'Conversations, social and travel history' },
];
export default function SelectiveExportPanel({ adminToken }: { adminToken: string }) {
  const convex = useConvex();
  const task = useAdminTask();
  const residents = useQuery(api.federation.runtime.listResidents, { adminToken });
  const jobs = useQuery(listJobs, { adminToken });
  const [scope, setScope] = useState<SelectiveScope>('agents-selected');
  const [selected, setSelected] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([...allowedCategories(scope)]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [publicPeers, setPublicPeers] = useState(false);
  const [operator, setOperator] = useState('');
  const [reason, setReason] = useState('');
  const [jobId, setJobId] = useState<Id<'backupLargeJobs'>>();
  const job = useQuery(status, jobId ? { adminToken, jobId } : 'skip');
  const [encrypted, setEncrypted] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [plaintextConfirmed, setPlaintextConfirmed] = useState(false);
  const [chunkIndex, setChunkIndex] = useState(0);
  const stop = useRef(false);
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );
  const downloadReady = encrypted
    ? validBackupPassphrase(passphrase) && passphrase === confirmation
    : plaintextConfirmed;
  function changeScope(value: SelectiveScope) {
    setScope(value);
    setCategories([...allowedCategories(value)]);
    if (value === 'agent-one') setSelected(selected.slice(0, 1));
  }
  async function create() {
    const fromMs = from ? Date.parse(from) : undefined;
    const toMs = to ? Date.parse(to) : undefined;
    if ((from && !Number.isFinite(fromMs)) || (to && !Number.isFinite(toMs)))
      throw new Error('Choose valid dates.');
    const result = await convex.mutation(mutation('startExport'), {
      adminToken,
      scope,
      agentGlobalIds: scope === 'config-only' ? [] : selected,
      categories,
      from: scope === 'config-only' ? undefined : fromMs,
      to: scope === 'config-only' ? undefined : toMs,
      includePublicPeers: scope === 'config-only' && publicPeers,
      operator: operator.trim(),
      reason: reason.trim(),
    });
    setJobId(result.jobId);
    setChunkIndex(0);
  }
  async function run() {
    if (!jobId) return;
    stop.current = false;
    while (!stop.current) {
      const result = await convex.action(advance, { adminToken, jobId });
      if (['COMPLETE', 'FAILED', 'CANCELLED'].includes(result.state)) break;
    }
  }
  async function download(kind: 'manifest' | 'chunk' | 'folder') {
    if (!jobId) return;
    let password = encrypted ? passphrase : '';
    setPassphrase('');
    setConfirmation('');
    try {
      const folder = kind === 'folder' ? await selectArchiveDirectory() : undefined;
      const manifest = await convex.action(getManifest, { adminToken, jobId });
      const write = async (text: string, filename: string, purpose: 'manifest' | 'chunk') => {
        const output = encrypted
          ? await encryptBackupText(
              text,
              password,
              purpose,
              purpose === 'manifest' ? 5_000_000 : 900_000,
            )
          : text;
        const name = `${jobId}-${filename}${encrypted ? '.encrypted.json' : '.json'}`;
        if (folder) await writeArchiveText(folder, name, output);
        else downloadJsonText(output, name);
      };
      if (kind !== 'chunk') await write(JSON.stringify(manifest), 'manifest', 'manifest');
      if (kind === 'folder') {
        for (const c of manifest.manifest.chunks)
          await write(
            await convex.action(getChunk, { adminToken, jobId, index: c.index }),
            `chunk-${c.index}`,
            'chunk',
          );
      } else if (kind === 'chunk') {
        if (chunkIndex >= manifest.manifest.chunks.length)
          throw new Error('All chunks have been downloaded.');
        await write(
          await convex.action(getChunk, { adminToken, jobId, index: chunkIndex }),
          `chunk-${chunkIndex}`,
          'chunk',
        );
        setChunkIndex(chunkIndex + 1);
      }
    } finally {
      password = '';
    }
  }
  return (
    <section aria-label="Selective data archives">
      <h3>Selective data archives</h3>
      <p className="admin-muted">
        Export one or more residents, configuration, memories or history without a 500-record cap.
        Pause all worlds, end visits and disable federation before starting. These signed archives
        are for reading and audit; use the snapshot formats for restore or merge.
      </p>
      <TaskFeedback task={task} />
      <Field label="Export scope">
        <select value={scope} onChange={(e) => changeScope(e.target.value as SelectiveScope)}>
          {scopes.map((s) => (
            <option value={s.value} key={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      {scope !== 'config-only' && (
        <fieldset>
          <legend>Resident owners</legend>
          {residents?.map((r) => (
            <label key={r.agentGlobalId}>
              <input
                type={scope === 'agent-one' ? 'radio' : 'checkbox'}
                name="selective-owner"
                checked={selected.includes(r.agentGlobalId)}
                onChange={(e) =>
                  setSelected(
                    scope === 'agent-one'
                      ? [r.agentGlobalId]
                      : e.target.checked
                        ? [...selected, r.agentGlobalId]
                        : selected.filter((id) => id !== r.agentGlobalId),
                  )
                }
              />{' '}
              {r.name} · {r.agentGlobalId}
            </label>
          ))}
        </fieldset>
      )}
      <fieldset>
        <legend>Categories</legend>
        {allowedCategories(scope).map((c) => (
          <label key={c}>
            <input
              type="checkbox"
              checked={categories.includes(c)}
              onChange={(e) =>
                setCategories(
                  e.target.checked ? [...categories, c] : categories.filter((value) => value !== c),
                )
              }
            />{' '}
            {c}
          </label>
        ))}
      </fieldset>
      {scope !== 'config-only' && (
        <div className="admin-toolbar">
          <Field label="From (inclusive, local time)">
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To (exclusive, local time)">
            <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      )}
      {scope === 'config-only' && (
        <label>
          <input
            type="checkbox"
            checked={publicPeers}
            onChange={(e) => setPublicPeers(e.target.checked)}
          />{' '}
          Include public peer addresses
        </label>
      )}
      <div className="admin-toolbar">
        <Field label="Operator">
          <input value={operator} onChange={(e) => setOperator(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Export reason">
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
        </Field>
      </div>
      <p className="admin-muted">
        The signed manifest fixes the selected owners, categories and time interval. Event
        timestamps take precedence over creation time. Same-owner evidence and public profile
        context may appear outside the interval as marked dependencies; other owners' private
        memories are excluded. Vectors are omitted.
      </p>
      <AdminButton
        disabled={
          !!task.pending ||
          !operator.trim() ||
          !reason.trim() ||
          !categories.length ||
          (scope !== 'config-only' && !selected.length)
        }
        onClick={() =>
          void task.run(
            'Creating selective archive',
            create,
            'Scope saved. Continue the export to process all pages.',
          )
        }
      >
        Create selective archive
      </AdminButton>
      <Field label="Selective archive task">
        <select
          value={jobId ?? ''}
          disabled={!!task.pending}
          onChange={(e) => {
            setJobId(jobs?.find((j) => j.jobId === e.target.value)?.jobId);
            setChunkIndex(0);
          }}
        >
          <option value="">Select a task</option>
          {jobs?.map((j) => (
            <option value={j.jobId} key={j.jobId}>
              {j.selection.scope} · {j.state} · {j.jobId}
            </option>
          ))}
        </select>
      </Field>
      {job && (
        <>
          <p role="status">
            {job.state} · {job.phase} · {job.recordCount} records · {job.chunkCount} chunks
          </p>
          <p className="admin-muted">
            Saved scope: {job.selection.scope} · {job.selection.owners.length} owners ·{' '}
            {job.selection.categories.join(', ')} ·{' '}
            {job.selection.from === null ? 'start' : new Date(job.selection.from).toISOString()} —{' '}
            {job.selection.to === null ? 'end' : new Date(job.selection.to).toISOString()}
          </p>
          {job.error && <p role="alert">{job.error}</p>}
          <div className="admin-toolbar">
            <AdminButton
              disabled={!!task.pending || job.state !== 'RUNNING'}
              onClick={() =>
                void task.run(
                  'Exporting bounded pages',
                  run,
                  'Processing stopped at a checkpoint. Review the task state.',
                )
              }
            >
              Continue all pages
            </AdminButton>
            {task.pending && (
              <AdminButton
                onClick={() => {
                  stop.current = true;
                }}
              >
                Stop after this page
              </AdminButton>
            )}
            <AdminButton
              disabled={!!task.pending || job.state !== 'FAILED'}
              onClick={() =>
                void task.run(
                  'Resuming archive',
                  () => convex.mutation(mutation('resume'), { adminToken, jobId }),
                  'Ready to continue from the saved checkpoint.',
                )
              }
            >
              Resume failed task
            </AdminButton>
            <AdminButton
              disabled={!!task.pending || ['COMPLETE', 'CANCELLED'].includes(job.state)}
              onClick={() =>
                void task.run(
                  'Cancelling archive',
                  () => convex.mutation(mutation('cancel'), { adminToken, jobId }),
                  'Archive cancelled; maintenance lock released.',
                )
              }
            >
              Cancel
            </AdminButton>
          </div>
        </>
      )}
      {job?.state === 'COMPLETE' && (
        <>
          <label>
            <input
              type="checkbox"
              checked={encrypted}
              onChange={(e) => {
                setEncrypted(e.target.checked);
                setPlaintextConfirmed(false);
              }}
            />{' '}
            Encrypt downloaded files
          </label>
          {encrypted ? (
            <div className="admin-toolbar">
              <Field label="Backup passphrase (12+ characters)">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </Field>
              <Field label="Confirm passphrase">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <label>
              <input
                type="checkbox"
                checked={plaintextConfirmed}
                onChange={(e) => setPlaintextConfirmed(e.target.checked)}
              />{' '}
              I understand this archive may contain private resident text.
            </label>
          )}
          <div className="admin-toolbar">
            <AdminButton
              disabled={!!task.pending || !downloadReady || !supportsArchiveDirectory()}
              onClick={() =>
                void task.run(
                  'Writing selective archive folder',
                  () => download('folder'),
                  'Manifest and every chunk saved.',
                )
              }
            >
              Save all files to folder
            </AdminButton>
            <AdminButton
              disabled={!!task.pending || !downloadReady}
              onClick={() =>
                void task.run(
                  'Downloading signed manifest',
                  () => download('manifest'),
                  'Manifest downloaded.',
                )
              }
            >
              Download manifest
            </AdminButton>
            <AdminButton
              disabled={!!task.pending || !downloadReady || chunkIndex >= job.chunkCount}
              onClick={() =>
                void task.run(
                  'Downloading archive chunk',
                  () => download('chunk'),
                  'Chunk downloaded. Keep all chunks with the manifest.',
                )
              }
            >
              Download chunk {chunkIndex + 1} / {job.chunkCount}
            </AdminButton>
          </div>
        </>
      )}
    </section>
  );
}
