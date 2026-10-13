import { selectiveImportPayload } from './selectiveImportPayload';
import type { LocalArchiveProof, LocalSanitizedChunkManifest } from '../../../convex/federation/travelPrivacyLocalChunkManifest';
import { useLocale } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { jsonToConvex } from 'convex/values';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { LargeChunk } from '../../../convex/federation/backupLargeHelpers';
import type {
  ArchiveEnvelope,
  SelectiveManifest,
} from '../../../convex/federation/backupSelectiveHelpers';
import type {
  Options,
  OwnerMapping,
  ProfileMapping,
  ExternalMapping,
} from '../../../convex/federation/backupSelectiveImportHelpers';
import { AdminButton, Field, TaskFeedback, useAdminTask } from './AdminShared';
import { readBackupText } from './backupEncryption';

type JobArgs = { adminToken: string; jobId: Id<'backupLargeJobs'> };
type Job = {
  jobId: Id<'backupLargeJobs'>;
  state: string;
  phase: string;
  error?: string;
  selection: SelectiveManifest['selection'];
  options: Options;
  uploadedChunks: number;
  chunkCount: number;
  recordCount: number;
  planDigest?: string;
  targetDigest: string;
  report: {
    created: number;
    replaced: number;
    skipped: number;
    externalEdgesSkipped: number;
    rebuildCount: number;
    plannedMemories: number;
    indexState: string;
    indexError?: string;
    rawBytesEstimate: number;
    vectorStorageBytesEstimate: number | null;
    embeddingCallsEstimate: number | null;
    sourceTownId: string;
  };
};
type SignedManifest = { manifest: SelectiveManifest; signature: string; localProof?: LocalArchiveProof };
type PortableManifest = { manifest: SelectiveManifest | LocalSanitizedChunkManifest; signature: string; localProof?: LocalArchiveProof };
type Profile = { sourceId: string; name: string; model: string };
type ExternalEdge = {
  sourceId: string;
  sourceAgentGlobalId: string;
  referencedOwnerGlobalId?: string;
};
type Targets = { worldId: Id<'worlds'>; status: string; isDefault: boolean }[];
const status = makeFunctionReference<'query', JobArgs, Job>(
  'federation/backupSelectiveImport:status',
);
const listJobs = makeFunctionReference<'query', { adminToken: string }, Job[]>(
  'federation/backupSelectiveImport:listJobs',
);
const importTargets = makeFunctionReference<'query', { adminToken: string }, Targets>(
  'federation/backupSelectiveImport:importTargets',
);
const mutation = (name: string) =>
  makeFunctionReference<'mutation'>(`federation/backupSelectiveImport:${name}`);
const action = (name: string) =>
  makeFunctionReference<'action'>(`federation/backupSelectiveImport:${name}`);
const edgeKey = (edge: ExternalEdge) => JSON.stringify([edge.sourceId, edge.sourceAgentGlobalId]);
const configurationChoices: { value: Options['configuration'][number]; label: string }[] = [
  { value: 'storagePolicies', label: 'Storage policy' },
  { value: 'federationResourcePolicy', label: 'Reception and source quotas' },
  { value: 'federationResidentPolicy', label: 'Merge denied resident IDs (keep exact identities)' },
  { value: 'visitorPolicy', label: 'Visitor limits' },
  { value: 'mainChatProfile', label: 'Main Chat Profile (future residents)' },
  {
    value: 'modelProviderQuotas',
    label: 'Provider daily request quotas (usage is not transferred)',
  },
  { value: 'embeddingProfiles', label: 'Embedding drafts (no active space switch)' },
];

function decoded(encoded: unknown): Record<string, any> {
  return jsonToConvex(
    typeof encoded === 'string'
      ? JSON.parse(encoded)
      : (encoded as Parameters<typeof jsonToConvex>[0]),
  ) as Record<string, any>;
}

export default function SelectiveImportPanel({ adminToken }: { adminToken: string }) {
  const { t } = useLocale();
  const convex = useConvex();
  const task = useAdminTask();
  const jobs = useQuery(listJobs, { adminToken });
  const targets = useQuery(importTargets, { adminToken });
  const residents = useQuery(api.federation.runtime.listResidents, { adminToken });
  const models = useQuery(api.models.profiles.list, { adminToken });
  const [manifestFile, setManifestFile] = useState<File>();
  const [signed, setSigned] = useState<SignedManifest>();
  const [files, setFiles] = useState<File[]>([]);
  const [privacyFiles, setPrivacyFiles] = useState<File[]>([]);
  const [portable, setPortable] = useState<PortableManifest>();
  const [trustedFingerprint, setTrustedFingerprint] = useState('');
  const [inspected, setInspected] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [sourceWorlds, setSourceWorlds] = useState<string[]>([]);
  const [edges, setEdges] = useState<ExternalEdge[]>([]);
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<Options['mode']>('merge');
  const [owners, setOwners] = useState<OwnerMapping[]>([]);
  const [profileMappings, setProfileMappings] = useState<ProfileMapping[]>([]);
  const [edgeMappings, setEdgeMappings] = useState<ExternalMapping[]>([]);
  const [configuration, setConfiguration] = useState<Options['configuration']>([]);
  const [worldMappings, setWorldMappings] = useState<Options['worlds']>([]);
  const [sourceStopped, setSourceStopped] = useState(false);
  const [operator, setOperator] = useState('');
  const [reason, setReason] = useState('');
  const [jobId, setJobId] = useState<Id<'backupLargeJobs'>>();
  const job = useQuery(status, jobId ? { adminToken, jobId } : 'skip');
  const [reviewed, setReviewed] = useState(false);
  const [progress, setProgress] = useState('');
  const stop = useRef(false);
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );
  useEffect(() => {
    setReviewed(false);
  }, [jobId, job?.planDigest, job?.targetDigest]);
  const editable = !jobId && !task.pending;
  const transfer = signed?.manifest.version === 2 && signed.manifest.usage === 'selective-transfer';
  const residentScope = signed && ['agent-one', 'agents-selected'].includes(signed.manifest.scope);
  const configScope = signed?.manifest.scope === 'config-only';
  const activeEdges = edges.filter(
    (edge) =>
      owners.some(
        (o) => o.sourceAgentGlobalId === edge.sourceAgentGlobalId && o.operation !== 'skip',
      ) &&
      (!edge.referencedOwnerGlobalId ||
        owners.some(
          (o) => o.sourceAgentGlobalId === edge.referencedOwnerGlobalId && o.operation === 'skip',
        )),
  );
  const mappingReady =
    inspected &&
    transfer &&
    (!signed?.localProof || !!trustedFingerprint.trim()) &&
    owners.every(
      (o) =>
        o.operation === 'skip' ||
        (!!o.targetWorldId && (o.operation === 'clone' || !!o.targetAgentGlobalId)),
    ) &&
    activeEdges.every((edge) =>
      edgeMappings.some(
        (m) => edgeKey(m) === edgeKey(edge) && (m.operation === 'skip-edge' || !!m.targetId),
      ),
    ) &&
    owners
      .filter((o) => o.operation === 'clone' || o.operation === 'restore')
      .every((o) => {
        const sourceOwner = signed?.manifest.selection.owners.find(
          (source) => source.agentGlobalId === o.sourceAgentGlobalId,
        );
        return (
          sourceOwner &&
          profileMappings.some(
            (p) => p.sourceId === sourceOwner.chatProfileId && p.operation !== 'skip',
          )
        );
      }) &&
    (!configScope ||
      configuration.length > 0 ||
      worldMappings.some((w) => w.importMap) ||
      profileMappings.some((p) => p.operation !== 'skip')) &&
    (configScope || owners.some((o) => o.operation !== 'skip')) &&
    (mode !== 'restore' || sourceStopped);

  async function loadManifest() {
    if (!manifestFile) return;
    setSigned(undefined);
    setInspected(false);
    setJobId(undefined);
    const value = JSON.parse(
      await readBackupText(manifestFile, 5_000_000, 'manifest', password),
    ) as PortableManifest;
    const derived = value?.manifest?.format === 'ai-town-local-sanitized-chunks' ? value.manifest : undefined;
    const source = derived?.sourceEvidence?.manifest;
    const current = derived && source?.format === 'ai-town-selective-archive'
      ? { ...source, chunks: derived.chunks } : value?.manifest;
    if (
      !value?.manifest ||
      current?.format !== 'ai-town-selective-archive' ||
      ![1, 2].includes(current.version) ||
      !Array.isArray(current.selection?.owners) ||
      !Array.isArray(current.chunks) ||
      (derived && (!value.localProof || value.signature !== '')) ||
      typeof value.signature !== 'string'
    )
      throw new Error(
        t('Choose a signed selective manifest. Full-town backups use the other import panel.'),
      );
    setPortable(value);
    setTrustedFingerprint('');
    setPrivacyFiles([]);
    setSigned({ ...value, manifest: current as SelectiveManifest });
    setOwners(
      (current as SelectiveManifest).selection.owners.map((o) => ({
        sourceAgentGlobalId: o.agentGlobalId,
        operation: 'skip',
      })),
    );
    setProfiles([]);
    setEdges([]);
    setSourceWorlds([]);
    setFiles([]);
    setProfileMappings([]);
    setEdgeMappings([]);
    setWorldMappings([]);
    setConfiguration([]);
    setMode('merge');
    setSourceStopped(false);
    setManifestFile(undefined);
  }
  async function inspectChunks() {
    if (!signed) return;
    setInspected(false);
    if (files.length !== signed.manifest.chunks.length)
      throw new Error(t('Select every chunk declared by this manifest, without duplicates.'));
    const seen = new Set<number>(),
      externalIds = new Set<string>(),
      worlds = new Set<string>();
    const discoveredProfiles = new Map<string, Profile>(),
      referencedEdges = new Map<string, ExternalEdge>();
    const memoryOwners = new Map<string, string>();
    for (const [i, file] of files.entries()) {
      setProgress(t('Inspecting file {index} / {count}', { index: i + 1, count: files.length }));
      const chunk = JSON.parse(
        await readBackupText(file, 900_000, 'chunk', password),
      ) as LargeChunk;
      const descriptor = signed.manifest.chunks[chunk.index];
      if (
        !descriptor ||
        descriptor.table !== chunk.table ||
        !Array.isArray(chunk.rows) ||
        seen.has(chunk.index)
      )
        throw new Error(t('A chunk is duplicated or belongs to another manifest.'));
      seen.add(chunk.index);
      for (const encoded of chunk.rows) {
        const envelope = decoded(encoded) as ArchiveEnvelope;
        if (envelope.kind === 'external-reference') {
          if (envelope.table === 'memories') externalIds.add(envelope.sourceId);
          continue;
        }
        if (envelope.kind !== 'record') throw new Error(t('Invalid selective archive record.'));
        const row = decoded(envelope.record);
        if (chunk.table === 'chatProfiles')
          discoveredProfiles.set(row._id, { sourceId: row._id, name: row.name, model: row.model });
        if (chunk.table === 'worlds') worlds.add(row._id);
        const owner = signed.manifest.selection.owners.find((o) =>
          row.agentGlobalId
            ? row.agentGlobalId === o.agentGlobalId
            : row.worldId === o.worldId && row.playerId === o.playerId,
        );
        if (chunk.table === 'memories' && owner) memoryOwners.set(row._id, owner.agentGlobalId);
        if (owner)
          for (const ref of envelope.references.filter((ref) => ref.table === 'memories')) {
            const edge = { sourceId: ref.id, sourceAgentGlobalId: owner.agentGlobalId };
            referencedEdges.set(edgeKey(edge), edge);
          }
      }
    }
    setProfiles([...discoveredProfiles.values()]);
    setProfileMappings(
      [...discoveredProfiles.keys()].map((sourceId) => ({ sourceId, operation: 'skip' })),
    );
    setEdges(
      [...referencedEdges.values()]
        .filter((edge) => externalIds.has(edge.sourceId) || memoryOwners.has(edge.sourceId))
        .map((edge) => ({ ...edge, referencedOwnerGlobalId: memoryOwners.get(edge.sourceId) })),
    );
    setEdgeMappings([]);
    setSourceWorlds([...worlds]);
    setInspected(true);
    setProgress(
      t(
        'Local inspection complete. The server will verify the signature, all chunk checksums and the complete reference closure before preflight.',
      ),
    );
  }
  async function create() {
    if (!signed || !mappingReady) throw new Error(t('Complete the explicit mappings first.'));
    const result = await convex.action(action('createImport'), {
      adminToken,
      ...selectiveImportPayload(portable ?? signed, trustedFingerprint),
      mode,
      owners,
      profiles: profileMappings,
      externalReferences: edgeMappings.filter((m) =>
        activeEdges.some((edge) => edgeKey(edge) === edgeKey(m)),
      ),
      configuration,
      worlds: worldMappings.filter((w) => w.importMap),
      sourceStopped,
      operator: operator.trim(),
      reason: reason.trim(),
    });
    setJobId(result.jobId);
  }
  async function upload() {
    if (!jobId || !files.length) throw new Error(t('Select the archive chunks to upload.'));
    stop.current = false;
    try {
      for (const [i, file] of files.entries()) {
        if (stop.current) break;
        setProgress(t('Uploading file {index} / {count}', { index: i + 1, count: files.length }));
        const chunk = await readBackupText(file, 900_000, 'chunk', password);
        await convex.action(action('stageChunk'), { adminToken, jobId, chunk });
      }
      for (const file of privacyFiles) {
        if (stop.current) break;
        const chunk = await readBackupText(file, 900_000, 'chunk', password);
        const page = JSON.parse(chunk) as LargeChunk;
        await convex.action(makeFunctionReference<'action'>('federation/backupPrivacyChunks:stageChunk'),
          { adminToken, jobId, pageNumber: page.index, chunk });
      }
    } finally {
      setPassword('');
    }
  }
  async function run() {
    if (!jobId) return;
    stop.current = false;
    while (!stop.current) {
      const result = (await convex.action(action('advanceImport'), { adminToken, jobId })) as Job;
      if (['READY', 'COMPLETE', 'FAILED', 'CANCELLED'].includes(result.state)) break;
    }
  }
  function updateOwner(sourceId: string, patch: Partial<OwnerMapping>) {
    setOwners(owners.map((o) => (o.sourceAgentGlobalId === sourceId ? { ...o, ...patch } : o)));
  }
  return (
    <section aria-label={t('Selective data import')}>
      <h3>{t('Selective data import')}</h3>
      <p className="admin-muted">
        {t(
          'Pause all target worlds, drain queued work, end visits and disable federation. Clone residents with new Home identities, merge selected history into proven local residents, or restore residents at their original Home. Raw memories remain available while local vectors rebuild.',
        )}
      </p>
      <TaskFeedback task={task} />
      <Field label={t('Backup passphrase (encrypted manifest and chunks only)')}>
        <input
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={!!task.pending}
        />
      </Field>
      <p className="admin-muted">
        {t(
          'Decryption happens in this browser. The passphrase never goes to the server and is cleared after uploading. Re-enter it when resuming encrypted uploads.',
        )}
      </p>
      <Field label={t('Signed selective manifest')}>
        <input
          type="file"
          accept=".json,application/json"
          disabled={!!task.pending}
          onChange={(e) => setManifestFile(e.target.files?.[0])}
        />
      </Field>
      <AdminButton
        disabled={!!task.pending || !manifestFile}
        onClick={() =>
          void task.run(
            t('Reading selective manifest'),
            loadManifest,
            t('Manifest loaded. Review the signed scope and choose its chunks.'),
          )
        }
      >
        {t('Load manifest')}
      </AdminButton>
      {signed && (
        <>
          {signed.localProof && <>
            <p className="admin-muted">{t('This is a locally sanitized selective archive. The original source signature authenticates evidence only; the local proof authenticates the current files.')}</p>
            <Field label={t('Trusted local signer fingerprint')}>
              <input disabled={!editable} value={trustedFingerprint} onChange={e => setTrustedFingerprint(e.target.value)} placeholder="sha256:…" />
            </Field>
            <p className="admin-muted">{t('Enter the fingerprint verified through the local identity or a trusted channel. It is not filled from the uploaded archive.')}</p>
            <Field label={t('Privacy evidence chunk files')}>
              <input type="file" multiple accept=".json" disabled={!!task.pending} onChange={e => setPrivacyFiles(Array.from(e.target.files ?? []))} />
            </Field>
            <p>{t('Upload all privacy evidence chunks before preflight.')}</p>
          </>}
          <p>
            {t('Source: ')}
            {signed.manifest.source.townName} · {signed.manifest.source.townId}
            {t(' · version')} {signed.manifest.version}
          </p>
          <p className="admin-muted">
            {t('Signing-key fingerprint: ')}
            <code>{String(signed.manifest.source.fingerprint ?? t('missing'))}</code>
            {t(' · optional vectors: ')}
            {signed.manifest.includeVectors ? t('included') : t('omitted')}
            {t(
              '. Compare this key with the local identity or trusted peer before import; its archive signature alone cannot grant trust.',
            )}
          </p>
          <p className="admin-muted">
            {t('Signed scope: ')}
            {t(signed.manifest.scope)} · {signed.manifest.selection.owners.length}
            {t(' owners · ')}
            {signed.manifest.selection.categories.map((category) => t(category)).join(', ')} ·{' '}
            {signed.manifest.chunks.length} {t('chunks. Range:')}{' '}
            {signed.manifest.selection.from === null
              ? 'start'
              : new Date(signed.manifest.selection.from).toISOString()}{' '}
            —{' '}
            {signed.manifest.selection.to === null
              ? 'end'
              : new Date(signed.manifest.selection.to).toISOString()}{' '}
            {t('(exclusive).')}
          </p>
          {!transfer && (
            <p role="alert">
              {t(
                'Version 1 is a read-only archive. Export a version 2 selective transfer from the source before importing.',
              )}
            </p>
          )}
        </>
      )}
      {(transfer || job?.phase === 'STAGING') && (
        <>
          <Field label={t('All selective archive chunks')}>
            <input
              type="file"
              multiple
              accept=".json,application/json"
              disabled={!!task.pending}
              onChange={(e) => {
                setFiles(Array.from(e.target.files ?? []));
                setInspected(false);
              }}
            />
          </Field>
          {signed && !jobId && (
            <AdminButton
              disabled={!!task.pending || !files.length}
              onClick={() =>
                void task.run(
                  t('Inspecting archive mappings'),
                  inspectChunks,
                  t('Review the source profiles and external references below.'),
                )
              }
            >
              {t('Inspect chunks locally')}
            </AdminButton>
          )}
        </>
      )}
      {progress && <p role="status">{progress}</p>}
      {inspected && !jobId && (
        <>
          <Field label={t('Import strategy')}>
            <select
              value={mode}
              disabled={!editable}
              onChange={(e) => {
                setMode(e.target.value as Options['mode']);
                setOwners(
                  owners.map((o) => ({
                    sourceAgentGlobalId: o.sourceAgentGlobalId,
                    operation: 'skip',
                  })),
                );
              }}
            >
              <option value="merge">{t('Clone / limited merge')}</option>
              <option value="restore">{t('Original Home restore')}</option>
            </select>
          </Field>
          {signed?.manifest.selection.owners.map((sourceOwner) => {
            const mapping = owners.find(
              (o) => o.sourceAgentGlobalId === sourceOwner.agentGlobalId,
            )!;
            return (
              <fieldset key={sourceOwner.agentGlobalId}>
                <legend>{sourceOwner.agentGlobalId}</legend>
                <Field label={t('Owner operation')}>
                  <select
                    disabled={!editable}
                    value={mapping.operation}
                    onChange={(e) =>
                      updateOwner(sourceOwner.agentGlobalId, {
                        operation: e.target.value as OwnerMapping['operation'],
                        targetWorldId: undefined,
                        targetAgentGlobalId: undefined,
                      })
                    }
                  >
                    <option value="skip">{t('Skip this owner')}</option>
                    {mode === 'restore' ? (
                      <option value="restore">{t('Restore original Home resident')}</option>
                    ) : (
                      <>
                        {residentScope && (
                          <option value="clone">{t('Clone as a new local resident')}</option>
                        )}
                        <option value="merge">
                          {t('Merge history; keep target personality and Chat binding')}
                        </option>
                      </>
                    )}
                  </select>
                </Field>
                {mapping.operation !== 'skip' && (
                  <>
                    <Field label={t('Target world')}>
                      <select
                        disabled={!editable}
                        value={mapping.targetWorldId ?? ''}
                        onChange={(e) =>
                          updateOwner(sourceOwner.agentGlobalId, {
                            targetWorldId: (e.target.value as Id<'worlds'>) || undefined,
                            targetAgentGlobalId: undefined,
                          })
                        }
                      >
                        <option value="">{t('Choose a stopped world')}</option>
                        {targets
                          ?.filter((w) => w.status === 'stoppedByDeveloper')
                          .map((w) => (
                            <option value={w.worldId} key={w.worldId}>
                              {w.isDefault ? t('Default · ') : ''}
                              {w.worldId}
                            </option>
                          ))}
                      </select>
                    </Field>
                    {mapping.operation !== 'clone' && (
                      <Field label={t('Proven target Home resident')}>
                        <select
                          disabled={!editable}
                          value={mapping.targetAgentGlobalId ?? ''}
                          onChange={(e) =>
                            updateOwner(sourceOwner.agentGlobalId, {
                              targetAgentGlobalId: e.target.value || undefined,
                            })
                          }
                        >
                          <option value="">{t('Choose a resident')}</option>
                          {residents
                            ?.filter(
                              (r) =>
                                r.worldId === mapping.targetWorldId &&
                                (mode !== 'restore' ||
                                  r.agentGlobalId === sourceOwner.agentGlobalId),
                            )
                            .map((r) => (
                              <option key={r.agentGlobalId} value={r.agentGlobalId}>
                                {r.name} · {r.agentGlobalId}
                              </option>
                            ))}
                        </select>
                      </Field>
                    )}
                  </>
                )}
              </fieldset>
            );
          })}
          {!!profiles.length && (
            <fieldset>
              <legend>{t('Explicit source Chat Profile mappings')}</legend>
              <p className="admin-muted">
                {t(
                  'Clone and resident restore require a mapping. Drafts retain the source provider/model and require a new local API-key environment variable; no source credentials are copied. Limited merge keeps the target resident binding.',
                )}
              </p>
              {profiles.map((p) => {
                const mapping = profileMappings.find((m) => m.sourceId === p.sourceId)!;
                return (
                  <Field key={p.sourceId} label={`${p.name} · ${p.model} · ${p.sourceId}`}>
                    <select
                      disabled={!editable}
                      value={mapping.operation === 'map' ? mapping.targetId : mapping.operation}
                      onChange={(e) =>
                        setProfileMappings(
                          profileMappings.map((m) =>
                            m.sourceId !== p.sourceId
                              ? m
                              : e.target.value === 'skip' || e.target.value === 'draft'
                                ? { sourceId: p.sourceId, operation: e.target.value }
                                : {
                                    sourceId: p.sourceId,
                                    operation: 'map',
                                    targetId: e.target.value as Id<'chatProfiles'>,
                                  },
                          ),
                        )
                      }
                    >
                      <option value="skip">{t('Skip this profile')}</option>
                      <option value="draft">{t('Create a credential-missing draft')}</option>
                      {models?.chatProfiles.map((target) => (
                        <option value={target._id} key={target._id}>
                          {target.name} · {target.model}
                          {target.credentialAvailable ? '' : t(' · credentials missing')}
                        </option>
                      ))}
                    </select>
                  </Field>
                );
              })}
            </fieldset>
          )}
          {!!activeEdges.length && (
            <fieldset>
              <legend>{t('External, skipped-owner or missing evidence')}</legend>
              <p className="admin-muted">
                {t(
                  'Every edge needs an explicit policy. Mapping is accepted only when the existing target memory belongs to the mapped resident.',
                )}
              </p>
              {activeEdges.map((edge) => {
                const mapping = edgeMappings.find((m) => edgeKey(m) === edgeKey(edge));
                return (
                  <div key={edgeKey(edge)}>
                    <Field label={`${edge.sourceAgentGlobalId} → ${edge.sourceId}`}>
                      <select
                        disabled={!editable}
                        value={mapping?.operation ?? ''}
                        onChange={(e) =>
                          setEdgeMappings([
                            ...edgeMappings.filter((m) => edgeKey(m) !== edgeKey(edge)),
                            ...(e.target.value
                              ? [
                                  {
                                    sourceId: edge.sourceId,
                                    sourceAgentGlobalId: edge.sourceAgentGlobalId,
                                    operation: e.target.value as ExternalMapping['operation'],
                                  },
                                ]
                              : []),
                          ])
                        }
                      >
                        <option value="">{t('Choose an edge policy')}</option>
                        <option value="skip-edge">{t('Skip this evidence edge')}</option>
                        <option value="map">{t('Map to an existing target memory')}</option>
                      </select>
                    </Field>
                    {mapping?.operation === 'map' && (
                      <Field label={t('Existing target memory ID')}>
                        <input
                          disabled={!editable}
                          value={mapping.targetId ?? ''}
                          onChange={(e) =>
                            setEdgeMappings(
                              edgeMappings.map((m) =>
                                edgeKey(m) === edgeKey(edge)
                                  ? {
                                      ...m,
                                      targetId: (e.target.value as Id<'memories'>) || undefined,
                                    }
                                  : m,
                              ),
                            )
                          }
                        />
                      </Field>
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}
          {configScope && (
            <fieldset>
              <legend>{t('Configuration changes')}</legend>
              {configurationChoices.map((choice) => (
                <label key={choice.value}>
                  <input
                    type="checkbox"
                    disabled={!editable}
                    checked={configuration.includes(choice.value)}
                    onChange={(e) =>
                      setConfiguration(
                        e.target.checked
                          ? [...configuration, choice.value]
                          : configuration.filter((c) => c !== choice.value),
                      )
                    }
                  />{' '}
                  {t(choice.label)}
                </label>
              ))}
              {sourceWorlds.map((sourceId) => (
                <Field
                  key={sourceId}
                  label={t('Import map for source world {sourceId}', { sourceId })}
                >
                  <select
                    disabled={!editable}
                    value={worldMappings.find((w) => w.sourceId === sourceId)?.targetId ?? ''}
                    onChange={(e) =>
                      setWorldMappings([
                        ...worldMappings.filter((w) => w.sourceId !== sourceId),
                        ...(e.target.value
                          ? [
                              {
                                sourceId,
                                targetId: e.target.value as Id<'worlds'>,
                                importMap: true,
                              },
                            ]
                          : []),
                      ])
                    }
                  >
                    <option value="">{t('Skip this map')}</option>
                    {targets
                      ?.filter((w) => w.status === 'stoppedByDeveloper')
                      .map((w) => (
                        <option value={w.worldId} key={w.worldId}>
                          {w.worldId}
                        </option>
                      ))}
                  </select>
                </Field>
              ))}
            </fieldset>
          )}
          {mode === 'restore' && (
            <label>
              <input
                type="checkbox"
                disabled={!editable}
                checked={sourceStopped}
                onChange={(e) => setSourceStopped(e.target.checked)}
              />{' '}
              {t(
                'I confirm the source deployment has stopped. The server must also prove the same original Home identity.',
              )}
            </label>
          )}
          <div className="admin-toolbar">
            <Field label={t('Operator')}>
              <input
                disabled={!editable}
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
                maxLength={200}
              />
            </Field>
            <Field label={t('Import reason')}>
              <input
                disabled={!editable}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={1000}
              />
            </Field>
          </div>
          <AdminButton
            disabled={!editable || !mappingReady || !operator.trim() || !reason.trim()}
            onClick={() =>
              void task.run(
                t('Creating selective import'),
                create,
                t('Mappings saved. Upload chunks, then run the server preflight.'),
              )
            }
          >
            {t('Save import plan')}
          </AdminButton>
        </>
      )}
      <Field label={t('Selective import task')}>
        <select
          disabled={!!task.pending}
          value={jobId ?? ''}
          onChange={(e) => {
            setJobId(jobs?.find((j) => j.jobId === e.target.value)?.jobId);
            setReviewed(false);
          }}
        >
          <option value="">{t('New import / choose a task')}</option>
          {jobs?.map((j) => (
            <option key={j.jobId} value={j.jobId}>
              {t(j.selection.scope)} · {t(j.state)} · {j.jobId}
            </option>
          ))}
        </select>
      </Field>
      {job && (
        <>
          <p role="status">
            {t(job.state)} · {t(job.phase)} · {job.uploadedChunks} / {job.chunkCount}
            {t(' uploaded chunks ·')} {job.recordCount}
            {t(' source records')}
          </p>
          {job.error && <p role="alert">{job.error}</p>}
          <details className="admin-disclosure">
            <summary>{t('Saved mapping plan')}</summary>
            <pre className="admin-report">{JSON.stringify(job.options, null, 2)}</pre>
          </details>
          <p className="admin-muted">
            {t('Source: ')}
            {job.report.sourceTownId}
            {t('. Raw bytes:')} {job.report.rawBytesEstimate.toLocaleString()}
            {t('; planned memories:')} {job.report.plannedMemories}
            {t('; estimated vector bytes:')}{' '}
            {job.report.vectorStorageBytesEstimate?.toLocaleString() ?? t('no writable space')}
            {t('; estimated embedding calls: ')}
            {job.report.embeddingCallsEstimate ?? t('no writable space')}
            {t('. Estimates exclude database overhead.')}
          </p>
          <p className="admin-muted">
            {t('Created: ')}
            {job.report.created}
            {t('; replaced: ')}
            {job.report.replaced}
            {t('; skipped:')} {job.report.skipped}
            {t('; skipped external edges: ')}
            {job.report.externalEdgesSkipped}
            {t('. Local index: ')}
            {t(job.report.indexState)} {job.report.indexError ?? ''}
          </p>
          {job.state === 'COMPLETE' && (
            <p className="admin-muted">
              <a href="#embedding-recovery">{t('Recover this imported memory index')}</a>
              {t(
                ' from the completed import history below. Optional archived vectors never activate a local index automatically.',
              )}
            </p>
          )}
          {job.state === 'READY' && (
            <>
              <p>
                {t(
                  'Every source chunk and reference has passed preflight. The target rollback snapshot is saved. Review the mappings before applying.',
                )}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />{' '}
                {t(
                  'I reviewed this saved plan and its target snapshot. Apply only these mapped owners and configuration changes.',
                )}
              </label>
            </>
          )}
          <div className="admin-toolbar">
            <AdminButton
              disabled={
                !!task.pending || job.phase !== 'STAGING' || !files.length || job.state === 'FAILED'
              }
              onClick={() =>
                void task.run(
                  t('Uploading selective chunks'),
                  upload,
                  t('Upload checkpoint saved. Run preflight when every chunk is present.'),
                )
              }
            >
              {t('Upload selected chunks')}
            </AdminButton>
            <AdminButton
              disabled={
                !!task.pending ||
                ['READY', 'COMPLETE', 'FAILED', 'CANCELLED'].includes(job.state) ||
                (job.phase === 'STAGING' && job.uploadedChunks !== job.chunkCount)
              }
              onClick={() =>
                void task.run(
                  t('Processing selective import pages'),
                  run,
                  t('Processing stopped at a saved checkpoint. Review the task state.'),
                )
              }
            >
              {t('Continue pages / preflight')}
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
              danger
              disabled={!!task.pending || job.state !== 'READY' || !reviewed}
              onClick={() =>
                void task.run(
                  t('Applying reviewed selective plan'),
                  async () => {
                    await convex.mutation(mutation('startApply'), {
                      adminToken,
                      jobId,
                      expectedPlanDigest: job.planDigest,
                      expectedTargetDigest: job.targetDigest,
                      confirmChanges: reviewed,
                    });
                    await run();
                  },
                  t('Application checkpoint saved. Review completion and local index status.'),
                )
              }
            >
              {t('Apply reviewed plan')}
            </AdminButton>
            <AdminButton
              disabled={!!task.pending || job.state !== 'FAILED'}
              onClick={() =>
                void task.run(
                  t('Resuming selective import'),
                  () => convex.mutation(mutation('resume'), { adminToken, jobId }),
                  t('Ready to continue from the saved checkpoint.'),
                )
              }
            >
              {t('Resume failed task')}
            </AdminButton>
            <AdminButton
              danger
              disabled={!!task.pending || ['COMPLETE', 'CANCELLED'].includes(job.state)}
              onClick={() =>
                void task.run(
                  t('Cancelling / rolling back selective import'),
                  async () => {
                    await convex.mutation(mutation('cancel'), { adminToken, jobId });
                    await run();
                  },
                  t(
                    'Cancellation checkpoint saved. Continue pages until CANCELLED to finish rollback.',
                  ),
                )
              }
            >
              {t('Cancel / roll back')}
            </AdminButton>
            <AdminButton
              disabled={
                !!task.pending || job.state !== 'COMPLETE' || job.report.indexState !== 'FAILED'
              }
              onClick={() =>
                void task.run(
                  t('Retrying local memory index'),
                  () => convex.mutation(mutation('retryIndex'), { adminToken, jobId }),
                  t('Local index rebuild queued; raw imported text remains saved.'),
                )
              }
            >
              {t('Retry failed local index')}
            </AdminButton>
          </div>
          <p className="admin-muted">
            {t(
              'Active visits, pending Agent operations, queued conversations, memory jobs and leases are never replayed. Travel policies and transport facts are stored as provenance history; enabling federation remains a separate operation.',
            )}
          </p>
        </>
      )}
    </section>
  );
}
