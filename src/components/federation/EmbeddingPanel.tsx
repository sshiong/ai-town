import { useLocale } from '../../i18n';
import { useEffect, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import { AdminButton, EmptyState, Field, TaskFeedback, formatTime, useAdminTask } from './AdminShared';
import { canActivateEmbeddingSpace, vectorRecoveryReason } from './embeddingUiPolicy';

type AdminArgs = { adminToken: string };
type Profile = { _id: Id<'embeddingProfiles'>; name: string; disabled?: boolean; credentialAvailable: boolean };
type Evidence = { authorizedProvider: string | null; certificate: Doc<'embeddingCertificates'> | null;
  trustBoundary: string; oldVectorsAutomaticallyCertified: boolean };
type Verified = { compatibility: 'UNKNOWN'; reason: string } | { compatibility: 'VERIFIED_PROVIDER';
  embeddingCertificateId: Id<'embeddingCertificates'>; trustBoundary: string };
type Prepared = { vectorPolicy: 'REBUILD'; reason: string } | { vectorPolicy: 'PENDING_VALIDATION';
  jobId: Id<'embeddingRestoreJobs'>; spaceId: Id<'embeddingSpaces'> };
const providerStatus = makeFunctionReference<'query', AdminArgs & { embeddingProfileId: Id<'embeddingProfiles'> }, Evidence>(
  'models/embeddingProvenance:status');
const verifyProvider = makeFunctionReference<'action', AdminArgs & { embeddingProfileId: Id<'embeddingProfiles'> }, Verified>(
  'models/embeddingProvenance:verifyProvider');
const prepareReuse = makeFunctionReference<'action', AdminArgs & { importId: Id<'backupImports'>;
  targetProfileId: Id<'embeddingProfiles'> }, Prepared>('federation/backupVectorRestore:prepareVectorReuse');
const restoreStatus = makeFunctionReference<'query', AdminArgs & { jobId: Id<'embeddingRestoreJobs'> }, Doc<'embeddingRestoreJobs'> | null>(
  'federation/backupVectorRestore:status');

export function VectorExportOption({ checked, onChange, disabled = false }: {
  checked: boolean; onChange: (value: boolean) => void; disabled?: boolean;
}) {
  const { t } = useLocale();
  return <>
    <label className="admin-check"><input type="checkbox" checked={checked} disabled={disabled}
      onChange={event => onChange(event.target.checked)} />{' '}{t("Include proven vectors from the active index")}</label>
    <p className="admin-muted">{t("Off by default. Raw memories are always retained. This optional snapshot includes generation evidence, increases archive size and is reusable only after source trust and an independent local provider check. Unproven vectors, retired spaces and caches are omitted.")}</p>
  </>;
}

export function EmbeddingProviderEvidence({ adminToken, profile }: { adminToken: string; profile: Profile }) {
  const { t } = useLocale();
  const convex = useConvex(), task = useAdminTask();
  const evidence = useQuery(providerStatus, { adminToken, embeddingProfileId: profile._id });
  const [assessment, setAssessment] = useState<Verified>();
  return <details className="admin-disclosure">
    <summary>{t("Provider identity & generation evidence")}</summary>
    <TaskFeedback task={task} />
    <p className="admin-muted">{t("Connection tests, matching dimensions and a declared revision do not prove vector compatibility. Only server-authorized Ollama deployments can establish reuse evidence. Credentials stay on the server.")}</p>
    {evidence && <>
      <p>{t("Authorized provider: {provider}", { provider: evidence.authorizedProvider ?? t("none; compatibility remains UNKNOWN") })}.</p>
      {evidence.certificate && <>
        <p>{t("Latest evidence:")} <strong>{t(evidence.certificate.state)}</strong> {t("· verified {verified} · checked {checked}.", { verified: formatTime(evidence.certificate.verifiedAt), checked: formatTime(evidence.certificate.checkedAt) })}</p>
        <Field label={t("Verified weights digest")}><code>{evidence.certificate.artifactDigest}</code></Field>
        <Field label={t("Processing pipeline")}><code>{evidence.certificate.pipelineFingerprint}</code></Field>
        {evidence.certificate.reason && <p className="admin-muted">{evidence.certificate.reason}</p>}
      </>}
      <p className="admin-muted">{t(evidence.trustBoundary)} {t("Existing vectors are never retroactively certified. Portable historical evidence grants no live serving authority.")}</p>
    </>}
    <AdminButton disabled={!!task.pending || profile.disabled || !profile.credentialAvailable}
      onClick={() => void task.run(t("Independently verifying provider weights and query/document pipelines"), async () => {
        setAssessment(await convex.action(verifyProvider, { adminToken, embeddingProfileId: profile._id }));
      }, '')}>{t("Verify provider identity")}</AdminButton>
    {assessment?.compatibility === 'UNKNOWN' && <p className="admin-warning">{localizedRecoveryReason(assessment.reason, t)}</p>}
    {assessment?.compatibility === 'VERIFIED_PROVIDER' && evidence?.certificate?._id === assessment.embeddingCertificateId &&
      evidence.certificate.state === 'ACTIVE' && evidence.authorizedProvider === evidence.certificate.providerId && <p role="status" className="admin-success">
      {t("Provider verified. This certificate covers new generation; reuse still requires matching original generation evidence and retrieval validation.")}</p>}
  </details>;
}

export default function EmbeddingPanel({ adminToken, initialImportId }: { adminToken: string; initialImportId?: Id<'backupImports'> }) {
  const { t } = useLocale();
  const convex = useConvex(), task = useAdminTask();
  const profiles = useQuery(api.models.profiles.list, { adminToken });
  const imports = useQuery(api.federation.backup.history, { adminToken });
  const [importId, setImportId] = useState<Id<'backupImports'> | undefined>(initialImportId);
  const [targetProfileId, setTargetProfileId] = useState<Id<'embeddingProfiles'>>();
  const [sourceReviewed, setSourceReviewed] = useState(false);
  const [prepared, setPrepared] = useState<Prepared>();
  const [jobId, setJobId] = useState<Id<'embeddingRestoreJobs'>>();
  const [savedJobId, setSavedJobId] = useState('');
  const [rebuiltSpaceId, setRebuiltSpaceId] = useState<Id<'embeddingSpaces'>>();
  const restore = useQuery(restoreStatus, jobId ? { adminToken, jobId } : 'skip');
  const spaceId = rebuiltSpaceId ?? restore?.spaceId;
  const space = profiles?.embeddingSpaces.find(item => item._id === spaceId);
  const validation = useQuery(api.models.embeddings.scanProgress,
    space?.validationJobId ? { adminToken, jobId: space.validationJobId } : 'skip');
  const coverage = useQuery(api.models.embeddings.scanProgress,
    space?.coverageJobId ? { adminToken, jobId: space.coverageJobId } : 'skip');
  const target = profiles?.embeddingProfiles.find(item => item._id === targetProfileId);
  const activeRestore = restore?.spaceId === spaceId ? restore : undefined;
  const failed = activeRestore?.state === 'REBUILD_REQUIRED' || coverage?.phase === 'FAILED' || validation?.phase === 'FAILED' || !!space?.failure;
  const canActivate = canActivateEmbeddingSpace(space, validation, activeRestore?.state);
  function clearAttempt() { setPrepared(undefined); setJobId(undefined); setRebuiltSpaceId(undefined); setSourceReviewed(false); }
  useEffect(() => {
    if (initialImportId) { setImportId(initialImportId); clearAttempt(); }
  }, [initialImportId]);
  return <section id="embedding-recovery" aria-label={t("Embedding recovery")}>
    <h3>{t("Recover an imported memory index")}</h3>
    <p className="admin-muted">{t("Choose a completed import and a local target profile. Raw memories survive failed reuse. The active index remains in service until you explicitly activate a fully validated replacement.")}</p>
    <TaskFeedback task={task} />
    <div className="admin-form">
      <Field label={t("Completed import")} hint={t("Includes ordinary, chunked and selective imports; the server rechecks completion.")}>
        <select value={importId ?? ''} disabled={!!task.pending} onChange={event => {
          setImportId(imports?.find(item => item._id === event.target.value)?._id); clearAttempt();
        }}><option value="">{t("Choose an import")}</option>
          {importId && !imports?.some(item => item._id === importId) && <option value={importId}>{t("Saved import · {id}", { id: importId })}</option>}
          {imports?.map(item => <option key={item._id} value={item._id}>{item.sourceTownId} · {t(item.mode)} · {formatTime(item.importedAt)}</option>)}
        </select>
      </Field>
      <Field label={t("Local target Embedding profile")}>
        <select value={targetProfileId ?? ''} disabled={!!task.pending} onChange={event => {
          setTargetProfileId(profiles?.embeddingProfiles.find(item => item._id === event.target.value)?._id); clearAttempt();
        }}><option value="">{t("Choose a target")}</option>{profiles?.embeddingProfiles.map(profile =>
          <option key={profile._id} value={profile._id} disabled={profile.disabled}>{profile.name} · {profile.model}{profile.disabled ? t(" (disabled)") : ''}</option>)}
        </select>
      </Field>
    </div>
    {!imports?.length && <EmptyState>{t("Complete a data import to try its optional signed vector snapshot. You can rebuild retained text without a snapshot.")}</EmptyState>}
    {target && <>
      {!target.credentialAvailable && <p className="admin-warning">{t("The target profile's server credential is missing. Configure its referenced credential on this server before recovery; imported archives do not restore API keys.")}</p>}
      <EmbeddingProviderEvidence adminToken={adminToken} profile={target} />
    </>}
    <label className="admin-check"><input type="checkbox" checked={sourceReviewed} disabled={!!task.pending || !!jobId}
      onChange={event => setSourceReviewed(event.target.checked)} />{' '}{t("I reviewed the source town and signing-key fingerprint against my local identity or trusted peer.")}</label>
    <p className="admin-muted">{t("A valid archive signature proves its signing key, not trust in that key. The key must already have been trusted locally at import. This acknowledgment cannot grant trust or override the server. Target credentials must be configured locally; archive declarations never replace local verification.")}</p>
    <div className="admin-toolbar">
      <AdminButton disabled={!!task.pending || !importId || !target || target.disabled || !target.credentialAvailable || !sourceReviewed || !!jobId}
        onClick={() => void task.run(t("Checking source trust and independently verifying the target provider"), async () => {
          if (!importId || !targetProfileId) return;
          const result = await convex.action(prepareReuse, { adminToken, importId, targetProfileId });
          setPrepared(result);
          if (result.vectorPolicy === 'PENDING_VALIDATION') { setJobId(result.jobId); setSavedJobId(result.jobId); }
        }, '')}>{t("Try verified vector reuse")}</AdminButton>
      <AdminButton disabled={!!task.pending || !target || target.disabled || !target.credentialAvailable || activeRestore?.state === 'COPYING'}
        onClick={() => void task.run(t("Rebuilding vectors from retained text"), async () => {
          if (!targetProfileId) return;
          setRebuiltSpaceId(await convex.action(api.models.embeddings.startRebuild, { adminToken, targetProfileId }));
        }, t("Rebuild scheduled in a separate space. Validate coverage and live retrieval before activation."))}>
        {failed || prepared?.vectorPolicy === 'REBUILD' ? t("Rebuild after failed reuse") : t("Rebuild from raw memories")}
      </AdminButton>
    </div>
    {prepared?.vectorPolicy === 'REBUILD' && <p className="admin-warning" role="status">{localizedRecoveryReason(prepared.reason, t)}</p>}
    {restore && <>
      <p role="status">{t("Vector task")} <code>{restore._id}</code> {t("· {state} · copied {copied} · skipped {skipped}.", { state: t(restore.state), copied: restore.copied, skipped: restore.skipped })}</p>
      <p className="admin-muted">{t("Source trust and target identity passed before copying. Copying is not retrieval validation. Keep this task ID to recover progress after reopening the panel.")}</p>
      {restore.reason && <p className="admin-warning">{localizedRecoveryReason(restore.reason, t)}</p>}
    </>}
    {space && <>
      <p>{t("Target space")} <code>{space._id}</code> · {t(space.status)}{!space.validatedAt && t(" · awaiting complete retrieval validation")}.</p>
      {coverage && <p role="status">{t("Coverage: {phase} · {memories} memories · {vectors} vectors.", { phase: t(coverage.phase), memories: coverage.memoryCount, vectors: coverage.vectorCount })}</p>}
      {validation && <p role="status">{t("Live retrieval validation: {phase} · {samples} query samples.", { phase: t(validation.phase), samples: validation.sampleCount })}</p>}
      <p className="admin-muted">{t("Activation rechecks the saved validation against current memory and vector revisions. If retained text changed, rebuild and validate again; the old active index remains selected.")}</p>
      {(space.failure || coverage?.failure || validation?.failure) && <p className="admin-warning">
        {localizedRecoveryReason(space.failure ?? coverage?.failure ?? validation?.failure ?? 'VALIDATION_FAILED', t)}</p>}
      <div className="admin-toolbar">
        <AdminButton disabled={!!task.pending || failed || activeRestore?.state === 'COPYING' || coverage?.phase !== 'DONE' ||
          (!!validation && !['DONE', 'FAILED'].includes(validation.phase)) || space.status === 'ACTIVE'}
          onClick={() => void task.run(t("Validating all owners, coverage and live query retrieval"), async () => {
            await convex.action(api.models.embeddings.validateSpace, { adminToken, spaceId: space._id });
          }, t("Validation started. Activation stays disabled until coverage and live query samples pass."))}>
          {t("Validate coverage & live retrieval")}</AdminButton>
        <AdminButton disabled={!!task.pending || !canActivate}
          onClick={() => void task.run(t("Activating the validated index"), async () => {
            await convex.mutation(api.models.embeddings.activateSpace, { adminToken, spaceId: space._id });
          }, t("Validated index activated. The old space remains available for rollback in Models & memory."))}>
          {t("Activate validated index")}</AdminButton>
      </div>
    </>}
    <details className="admin-disclosure"><summary>{t("Recover a saved vector task")}</summary>
      <Field label={t("Vector task ID")}><input value={savedJobId} maxLength={200} disabled={!!task.pending}
        onChange={event => setSavedJobId(event.target.value)} /></Field>
      <AdminButton disabled={!!task.pending || !savedJobId.trim()} onClick={() => void task.run(t("Loading saved vector task"), async () => {
        const found = await convex.query(restoreStatus, { adminToken, jobId: savedJobId.trim() as Id<'embeddingRestoreJobs'> });
        if (!found) throw new Error(t("Vector task not found. Check its saved ID."));
        setJobId(found._id); setImportId(found.importId); setTargetProfileId(found.targetProfileId); setRebuiltSpaceId(undefined); setPrepared(undefined);
      }, '')}>{t("Load saved task")}</AdminButton>
    </details>
  </section>;
}

function localizedRecoveryReason(reason: string, t: ReturnType<typeof useLocale>['t']) {
  const message = vectorRecoveryReason(reason);
  const fallback = `Vector recovery requires attention (${reason}). Rebuild from retained text and validate before activation.`;
  return message === fallback
    ? t('Vector recovery requires attention ({reason}). Rebuild from retained text and validate before activation.', { reason })
    : t(message);
}
