import type { LocalArchiveProof, LocalSanitizedChunkManifest } from '../../../convex/federation/travelPrivacyLocalChunkManifest';
import { useLocale } from '../../i18n';
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
import { VectorExportOption } from './EmbeddingPanel';

type JobArgs = { adminToken: string; jobId: Id<'backupLargeJobs'> };
type Job = {
  jobId: Id<'backupLargeJobs'>;
  state: string;
  phase: string;
  recordCount: number;
  chunkCount: number;
  bytes: number;
  selection: Selection;
  coldHistoryFiles?: SelectiveManifest['coldHistoryFiles'] | null;
  error?: string;
  archivePrivacyState?: string | null;
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
  { manifest: SelectiveManifest | LocalSanitizedChunkManifest; signature: string; localProof?: LocalArchiveProof }
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
  const { t } = useLocale();
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
  const [includeVectors, setIncludeVectors] = useState(false);
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
    if (value === 'config-only' || value === 'history') setIncludeVectors(false);
    if (value === 'agent-one') setSelected(selected.slice(0, 1));
  }
  async function create() {
    const fromMs = from ? Date.parse(from) : undefined;
    const toMs = to ? Date.parse(to) : undefined;
    if ((from && !Number.isFinite(fromMs)) || (to && !Number.isFinite(toMs)))
      throw new Error(t('Choose valid dates.'));
    const result = await convex.mutation(mutation('startExport'), {
      adminToken,
      scope,
      agentGlobalIds: scope === 'config-only' ? [] : selected,
      categories,
      from: scope === 'config-only' ? undefined : fromMs,
      to: scope === 'config-only' ? undefined : toMs,
      includePublicPeers: scope === 'config-only' && publicPeers,
      includeVectors: scope !== 'config-only' && scope !== 'history' && includeVectors,
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
  async function download(kind: 'manifest' | 'chunk' | 'folder' | 'privacy') {
    if (!jobId) return;
    if (
      kind === 'chunk' &&
      (!Number.isInteger(chunkIndex) || chunkIndex < 0 || (job && chunkIndex >= job.chunkCount))
    )
      throw new Error(t('All chunks have been downloaded.'));
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
      if (kind === 'manifest' || kind === 'folder') await write(JSON.stringify(manifest), 'manifest', 'manifest');
      if (kind === 'folder') {
        for (const c of manifest.manifest.chunks)
          await write(
            await convex.action(getChunk, { adminToken, jobId, index: c.index }),
            `chunk-${c.index}`,
            'chunk',
          );
        if (manifest.manifest.format === 'ai-town-local-sanitized-chunks')
          for (const c of manifest.manifest.privacyChunks ?? [])
            await write(JSON.stringify(await convex.action(makeFunctionReference<'action'>('federation/backupPrivacyChunks:getChunk'),
              { adminToken, jobId, pageNumber: c.index })), `privacy-${c.index}`, 'chunk');
      } else if (kind === 'privacy' && manifest.manifest.format === 'ai-town-local-sanitized-chunks') {
        for (const c of manifest.manifest.privacyChunks ?? [])
          await write(JSON.stringify(await convex.action(makeFunctionReference<'action'>('federation/backupPrivacyChunks:getChunk'),
            { adminToken, jobId, pageNumber: c.index })), `privacy-${c.index}`, 'chunk');
      } else if (kind === 'chunk') {
        if (chunkIndex >= manifest.manifest.chunks.length)
          throw new Error(t('All chunks have been downloaded.'));
        const chunk = manifest.manifest.chunks[chunkIndex];
        await write(
          await convex.action(getChunk, { adminToken, jobId, index: chunk.index }),
          `chunk-${chunk.index}`,
          'chunk',
        );
        setChunkIndex(chunkIndex + 1);
      }
    } finally {
      password = '';
    }
  }
  return (
    <section aria-label={t('Selective data archives')}>
      <h3>{t('Selective data archives')}</h3>
      <p className="admin-muted">
        {t(
          'Export one or more residents, configuration, memories or history without a 500-record cap. Pause all worlds, end visits and disable federation before starting. These signed archives support selective import with explicit owner and model mappings. Older read-only archives remain available for audit.',
        )}
      </p>
      <TaskFeedback task={task} />
      {scope !== 'config-only' && scope !== 'history' && (
        <VectorExportOption
          checked={includeVectors}
          onChange={setIncludeVectors}
          disabled={!!task.pending}
        />
      )}
      <Field label={t('Export scope')}>
        <select value={scope} onChange={(e) => changeScope(e.target.value as SelectiveScope)}>
          {scopes.map((s) => (
            <option value={s.value} key={s.value}>
              {t(s.label)}
            </option>
          ))}
        </select>
      </Field>
      {scope !== 'config-only' && (
        <fieldset>
          <legend>{t('Resident owners')}</legend>
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
        <legend>{t('Categories')}</legend>
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
            {t(c)}
          </label>
        ))}
      </fieldset>
      {scope !== 'config-only' && (
        <div className="admin-toolbar">
          <Field label={t('From (inclusive, local time)')}>
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t('To (exclusive, local time)')}>
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
          {t('Include public peer addresses')}
        </label>
      )}
      <div className="admin-toolbar">
        <Field label={t('Operator')}>
          <input value={operator} onChange={(e) => setOperator(e.target.value)} maxLength={200} />
        </Field>
        <Field label={t('Export reason')}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
        </Field>
      </div>
      <p className="admin-muted">
        {t(
          "The signed manifest fixes the selected owners, categories and time interval. Event timestamps take precedence over creation time. Same-owner evidence and public profile context may appear outside the interval as marked dependencies; other owners' private memories are excluded. Vectors are omitted.",
        )}
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
            t('Creating selective archive'),
            create,
            t('Scope saved. Continue the export to process all pages.'),
          )
        }
      >
        {t('Create selective archive')}
      </AdminButton>
      <Field label={t('Selective archive task')}>
        <select
          value={jobId ?? ''}
          disabled={!!task.pending}
          onChange={(e) => {
            setJobId(jobs?.find((j) => j.jobId === e.target.value)?.jobId);
            setChunkIndex(0);
          }}
        >
          <option value="">{t('Select a task')}</option>
          {jobs?.map((j) => (
            <option value={j.jobId} key={j.jobId}>
              {t(j.selection.scope)} · {t(j.state)} · {j.jobId}
            </option>
          ))}
        </select>
      </Field>
      {job && (
        <>
          <p role="status">
            {t(job.state)} · {t(job.phase)} · {job.recordCount}
            {t(' records · ')}
            {job.chunkCount}
            {t(' chunks')}
          </p>
          <p className="admin-muted">
            {t('Saved scope: ')}
            {t(job.selection.scope)} · {job.selection.owners.length}
            {t(' owners ·')} {job.selection.categories.map((category) => t(category)).join(', ')} ·{' '}
            {job.selection.from === null ? 'start' : new Date(job.selection.from).toISOString()} —{' '}
            {job.selection.to === null ? 'end' : new Date(job.selection.to).toISOString()}
          </p>
          {job.coldHistoryFiles && (
            <div className="admin-hint" role="status">
              <p>
                {t('Signed cold history files: ')}
                {job.coldHistoryFiles.included}
                {t(' included.')}
              </p>
              {Object.values(job.coldHistoryFiles.excluded).some((count) => count > 0) && (
                <p>
                  {t('Cold copies excluded: ')}
                  {job.coldHistoryFiles.excluded.SOURCE_SCOPE_NOT_SELECTED}
                  {t(' outside the selected history categories; ')}
                  {job.coldHistoryFiles.excluded.CANONICAL_MEMORY_NOT_SELECTED}
                  {t(' without a selected memory; ')}
                  {job.coldHistoryFiles.excluded.SOURCE_SCOPE_INCOMPLETE}
                  {t(
                    ' with originals outside the selected range. The archive follows your chosen scope.',
                  )}
                </p>
              )}
            </div>
          )}
          {job.error && <p role="alert">{job.error}</p>}
          <div className="admin-toolbar">
            <AdminButton
              disabled={!!task.pending || job.state !== 'RUNNING'}
              onClick={() =>
                void task.run(
                  t('Exporting bounded pages'),
                  run,
                  t('Processing stopped at a checkpoint. Review the task state.'),
                )
              }
            >
              {t('Continue all pages')}
            </AdminButton>
            {task.pending && (
              <AdminButton
                onClick={() => {
                  stop.current = true;
                }}
              >
                {t('Stop after this page')}
              </AdminButton>
            )}
            <AdminButton
              disabled={!!task.pending || job.state !== 'FAILED'}
              onClick={() =>
                void task.run(
                  t('Resuming archive'),
                  () => convex.mutation(mutation('resume'), { adminToken, jobId }),
                  t('Ready to continue from the saved checkpoint.'),
                )
              }
            >
              {t('Resume failed task')}
            </AdminButton>
            <AdminButton
              disabled={!!task.pending || ['COMPLETE', 'CANCELLED'].includes(job.state)}
              onClick={() =>
                void task.run(
                  t('Cancelling archive'),
                  () => convex.mutation(mutation('cancel'), { adminToken, jobId }),
                  t('Archive cancelled; maintenance lock released.'),
                )
              }
            >
              {t('Cancel')}
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
            {t('Encrypt downloaded files')}
          </label>
          {encrypted ? (
            <div className="admin-toolbar">
              <Field label={t('Backup passphrase (12+ characters)')}>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </Field>
              <Field label={t('Confirm passphrase')}>
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
              {t('I understand this archive may contain private resident text.')}
            </label>
          )}
          <div className="admin-toolbar">
            <AdminButton
              disabled={!!task.pending || !downloadReady || !supportsArchiveDirectory()}
              onClick={() =>
                void task.run(
                  t('Writing selective archive folder'),
                  () => download('folder'),
                  t('Manifest and every chunk saved.'),
                )
              }
            >
              {t('Save all files to folder')}
            </AdminButton>
            <AdminButton
              disabled={!!task.pending || !downloadReady}
              onClick={() =>
                void task.run(
                  t('Downloading signed manifest'),
                  () => download('manifest'),
                  t('Manifest downloaded.'),
                )
              }
            >
              {t('Download manifest')}
            </AdminButton>
            {job.archivePrivacyState === 'LOCAL_SANITIZED' && <AdminButton disabled={!!task.pending || !downloadReady} onClick={() =>
              void task.run(t('Downloading privacy evidence chunks'), () => download('privacy'), t('Privacy evidence chunks downloaded.'))}>
              {t('Download privacy evidence chunks')}
            </AdminButton>}
            <AdminButton
              disabled={!!task.pending || !downloadReady || chunkIndex >= job.chunkCount}
              onClick={() =>
                void task.run(
                  t('Downloading archive chunk'),
                  () => download('chunk'),
                  t('Chunk downloaded. Keep all chunks with the manifest.'),
                )
              }
            >
              {t('Download chunk ')}
              {chunkIndex + 1} / {job.chunkCount}
            </AdminButton>
          </div>
        </>
      )}
    </section>
  );
}
