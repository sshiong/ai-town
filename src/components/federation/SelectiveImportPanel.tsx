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
type SignedManifest = { manifest: SelectiveManifest; signature: string };
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
  { value: 'visitorPolicy', label: 'Visitor limits' },
  { value: 'mainChatProfile', label: 'Main Chat Profile (future residents)' },
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
  const convex = useConvex();
  const task = useAdminTask();
  const jobs = useQuery(listJobs, { adminToken });
  const targets = useQuery(importTargets, { adminToken });
  const residents = useQuery(api.federation.runtime.listResidents, { adminToken });
  const models = useQuery(api.models.profiles.list, { adminToken });
  const [manifestFile, setManifestFile] = useState<File>();
  const [signed, setSigned] = useState<SignedManifest>();
  const [files, setFiles] = useState<File[]>([]);
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
    ) as SignedManifest;
    if (
      !value?.manifest ||
      value.manifest.format !== 'ai-town-selective-archive' ||
      ![1, 2].includes(value.manifest.version) ||
      !Array.isArray(value.manifest.selection?.owners) ||
      !Array.isArray(value.manifest.chunks) ||
      typeof value.signature !== 'string'
    )
      throw new Error(
        'Choose a signed selective manifest. Full-town backups use the other import panel.',
      );
    setSigned(value);
    setOwners(
      value.manifest.selection.owners.map((o) => ({
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
      throw new Error('Select every chunk declared by this manifest, without duplicates.');
    const seen = new Set<number>(),
      externalIds = new Set<string>(),
      worlds = new Set<string>();
    const discoveredProfiles = new Map<string, Profile>(),
      referencedEdges = new Map<string, ExternalEdge>();
    const memoryOwners = new Map<string, string>();
    for (const [i, file] of files.entries()) {
      setProgress(`Inspecting file ${i + 1} / ${files.length}`);
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
        throw new Error('A chunk is duplicated or belongs to another manifest.');
      seen.add(chunk.index);
      for (const encoded of chunk.rows) {
        const envelope = decoded(encoded) as ArchiveEnvelope;
        if (envelope.kind === 'external-reference') {
          if (envelope.table === 'memories') externalIds.add(envelope.sourceId);
          continue;
        }
        if (envelope.kind !== 'record') throw new Error('Invalid selective archive record.');
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
      'Local inspection complete. The server will verify the signature, all chunk checksums and the complete reference closure before preflight.',
    );
  }
  async function create() {
    if (!signed || !mappingReady) throw new Error('Complete the explicit mappings first.');
    const result = await convex.action(action('createImport'), {
      adminToken,
      ...signed,
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
    if (!jobId || !files.length) throw new Error('Select the archive chunks to upload.');
    stop.current = false;
    try {
      for (const [i, file] of files.entries()) {
        if (stop.current) break;
        setProgress(`Uploading file ${i + 1} / ${files.length}`);
        const chunk = await readBackupText(file, 900_000, 'chunk', password);
        await convex.action(action('stageChunk'), { adminToken, jobId, chunk });
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
    <section aria-label="Selective data import">
      <h3>Selective data import</h3>
      <p className="admin-muted">
        Pause all target worlds, drain queued work, end visits and disable federation. Clone
        residents with new Home identities, merge selected history into proven local residents, or
        restore residents at their original Home. Raw memories remain available while local vectors
        rebuild.
      </p>
      <TaskFeedback task={task} />
      <Field label="Backup passphrase (encrypted manifest and chunks only)">
        <input
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={!!task.pending}
        />
      </Field>
      <p className="admin-muted">
        Decryption happens in this browser. The passphrase never goes to the server and is cleared
        after uploading. Re-enter it when resuming encrypted uploads.
      </p>
      <Field label="Signed selective manifest">
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
            'Reading selective manifest',
            loadManifest,
            'Manifest loaded. Review the signed scope and choose its chunks.',
          )
        }
      >
        Load manifest
      </AdminButton>
      {signed && (
        <>
          <p>
            Source: {signed.manifest.source.townName} · {signed.manifest.source.townId} · version{' '}
            {signed.manifest.version}
          </p>
          <p className="admin-muted">
            Signed scope: {signed.manifest.scope} · {signed.manifest.selection.owners.length} owners
            · {signed.manifest.selection.categories.join(', ')} · {signed.manifest.chunks.length}{' '}
            chunks. Range:{' '}
            {signed.manifest.selection.from === null
              ? 'start'
              : new Date(signed.manifest.selection.from).toISOString()}{' '}
            —{' '}
            {signed.manifest.selection.to === null
              ? 'end'
              : new Date(signed.manifest.selection.to).toISOString()}{' '}
            (exclusive).
          </p>
          {!transfer && (
            <p role="alert">
              Version 1 is a read-only archive. Export a version 2 selective transfer from the
              source before importing.
            </p>
          )}
        </>
      )}
      {(transfer || job?.phase === 'STAGING') && (
        <>
          <Field label="All selective archive chunks">
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
                  'Inspecting archive mappings',
                  inspectChunks,
                  'Review the source profiles and external references below.',
                )
              }
            >
              Inspect chunks locally
            </AdminButton>
          )}
        </>
      )}
      {progress && <p role="status">{progress}</p>}
      {inspected && !jobId && (
        <>
          <Field label="Import strategy">
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
              <option value="merge">Clone / limited merge</option>
              <option value="restore">Original Home restore</option>
            </select>
          </Field>
          {signed?.manifest.selection.owners.map((sourceOwner) => {
            const mapping = owners.find(
              (o) => o.sourceAgentGlobalId === sourceOwner.agentGlobalId,
            )!;
            return (
              <fieldset key={sourceOwner.agentGlobalId}>
                <legend>{sourceOwner.agentGlobalId}</legend>
                <Field label="Owner operation">
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
                    <option value="skip">Skip this owner</option>
                    {mode === 'restore' ? (
                      <option value="restore">Restore original Home resident</option>
                    ) : (
                      <>
                        {residentScope && (
                          <option value="clone">Clone as a new local resident</option>
                        )}
                        <option value="merge">
                          Merge history; keep target personality and Chat binding
                        </option>
                      </>
                    )}
                  </select>
                </Field>
                {mapping.operation !== 'skip' && (
                  <>
                    <Field label="Target world">
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
                        <option value="">Choose a stopped world</option>
                        {targets
                          ?.filter((w) => w.status === 'stoppedByDeveloper')
                          .map((w) => (
                            <option value={w.worldId} key={w.worldId}>
                              {w.isDefault ? 'Default · ' : ''}
                              {w.worldId}
                            </option>
                          ))}
                      </select>
                    </Field>
                    {mapping.operation !== 'clone' && (
                      <Field label="Proven target Home resident">
                        <select
                          disabled={!editable}
                          value={mapping.targetAgentGlobalId ?? ''}
                          onChange={(e) =>
                            updateOwner(sourceOwner.agentGlobalId, {
                              targetAgentGlobalId: e.target.value || undefined,
                            })
                          }
                        >
                          <option value="">Choose a resident</option>
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
              <legend>Explicit source Chat Profile mappings</legend>
              <p className="admin-muted">
                Clone and resident restore require a mapping. Drafts retain the source
                provider/model and require a new local API-key environment variable; no source
                credentials are copied. Limited merge keeps the target resident binding.
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
                      <option value="skip">Skip this profile</option>
                      <option value="draft">Create a credential-missing draft</option>
                      {models?.chatProfiles.map((target) => (
                        <option value={target._id} key={target._id}>
                          {target.name} · {target.model}
                          {target.credentialAvailable ? '' : ' · credentials missing'}
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
              <legend>External, skipped-owner or missing evidence</legend>
              <p className="admin-muted">
                Every edge needs an explicit policy. Mapping is accepted only when the existing
                target memory belongs to the mapped resident.
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
                        <option value="">Choose an edge policy</option>
                        <option value="skip-edge">Skip this evidence edge</option>
                        <option value="map">Map to an existing target memory</option>
                      </select>
                    </Field>
                    {mapping?.operation === 'map' && (
                      <Field label="Existing target memory ID">
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
              <legend>Configuration changes</legend>
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
                  {choice.label}
                </label>
              ))}
              {sourceWorlds.map((sourceId) => (
                <Field key={sourceId} label={`Import map for source world ${sourceId}`}>
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
                    <option value="">Skip this map</option>
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
              I confirm the source deployment has stopped. The server must also prove the same
              original Home identity.
            </label>
          )}
          <div className="admin-toolbar">
            <Field label="Operator">
              <input
                disabled={!editable}
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
                maxLength={200}
              />
            </Field>
            <Field label="Import reason">
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
                'Creating selective import',
                create,
                'Mappings saved. Upload chunks, then run the server preflight.',
              )
            }
          >
            Save import plan
          </AdminButton>
        </>
      )}
      <Field label="Selective import task">
        <select
          disabled={!!task.pending}
          value={jobId ?? ''}
          onChange={(e) => {
            setJobId(jobs?.find((j) => j.jobId === e.target.value)?.jobId);
            setReviewed(false);
          }}
        >
          <option value="">New import / choose a task</option>
          {jobs?.map((j) => (
            <option key={j.jobId} value={j.jobId}>
              {j.selection.scope} · {j.state} · {j.jobId}
            </option>
          ))}
        </select>
      </Field>
      {job && (
        <>
          <p role="status">
            {job.state} · {job.phase} · {job.uploadedChunks} / {job.chunkCount} uploaded chunks ·{' '}
            {job.recordCount} source records
          </p>
          {job.error && <p role="alert">{job.error}</p>}
          <details className="admin-disclosure">
            <summary>Saved mapping plan</summary>
            <pre className="admin-report">{JSON.stringify(job.options, null, 2)}</pre>
          </details>
          <p className="admin-muted">
            Source: {job.report.sourceTownId}. Raw bytes:{' '}
            {job.report.rawBytesEstimate.toLocaleString()}; planned memories:{' '}
            {job.report.plannedMemories}; estimated vector bytes:{' '}
            {job.report.vectorStorageBytesEstimate?.toLocaleString() ?? 'no writable space'};
            estimated embedding calls: {job.report.embeddingCallsEstimate ?? 'no writable space'}.
            Estimates exclude database overhead.
          </p>
          <p className="admin-muted">
            Created: {job.report.created}; replaced: {job.report.replaced}; skipped:{' '}
            {job.report.skipped}; skipped external edges: {job.report.externalEdgesSkipped}. Local
            index: {job.report.indexState} {job.report.indexError ?? ''}
          </p>
          {job.state === 'READY' && (
            <>
              <p>
                Every source chunk and reference has passed preflight. The target rollback snapshot
                is saved. Review the mappings before applying.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />{' '}
                I reviewed this saved plan and its target snapshot. Apply only these mapped owners
                and configuration changes.
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
                  'Uploading selective chunks',
                  upload,
                  'Upload checkpoint saved. Run preflight when every chunk is present.',
                )
              }
            >
              Upload selected chunks
            </AdminButton>
            <AdminButton
              disabled={
                !!task.pending ||
                ['READY', 'COMPLETE', 'FAILED', 'CANCELLED'].includes(job.state) ||
                (job.phase === 'STAGING' && job.uploadedChunks !== job.chunkCount)
              }
              onClick={() =>
                void task.run(
                  'Processing selective import pages',
                  run,
                  'Processing stopped at a saved checkpoint. Review the task state.',
                )
              }
            >
              Continue pages / preflight
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
              danger
              disabled={!!task.pending || job.state !== 'READY' || !reviewed}
              onClick={() =>
                void task.run(
                  'Applying reviewed selective plan',
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
                  'Application checkpoint saved. Review completion and local index status.',
                )
              }
            >
              Apply reviewed plan
            </AdminButton>
            <AdminButton
              disabled={!!task.pending || job.state !== 'FAILED'}
              onClick={() =>
                void task.run(
                  'Resuming selective import',
                  () => convex.mutation(mutation('resume'), { adminToken, jobId }),
                  'Ready to continue from the saved checkpoint.',
                )
              }
            >
              Resume failed task
            </AdminButton>
            <AdminButton
              danger
              disabled={!!task.pending || ['COMPLETE', 'CANCELLED'].includes(job.state)}
              onClick={() =>
                void task.run(
                  'Cancelling / rolling back selective import',
                  async () => {
                    await convex.mutation(mutation('cancel'), { adminToken, jobId });
                    await run();
                  },
                  'Cancellation checkpoint saved. Continue pages until CANCELLED to finish rollback.',
                )
              }
            >
              Cancel / roll back
            </AdminButton>
            <AdminButton
              disabled={
                !!task.pending || job.state !== 'COMPLETE' || job.report.indexState !== 'FAILED'
              }
              onClick={() =>
                void task.run(
                  'Retrying local memory index',
                  () => convex.mutation(mutation('retryIndex'), { adminToken, jobId }),
                  'Local index rebuild queued; raw imported text remains saved.',
                )
              }
            >
              Retry failed local index
            </AdminButton>
          </div>
          <p className="admin-muted">
            Active visits, pending Agent operations, queued conversations, memory jobs and leases
            are never replayed. Travel policies and transport facts are stored as provenance
            history; enabling federation remains a separate operation.
          </p>
        </>
      )}
    </section>
  );
}
