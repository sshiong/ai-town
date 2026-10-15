import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { identity } from './store';
import { decodeRow } from './backupHelpers';
import { townMaintenanceLock } from './maintenanceLock';
import { activeVisitsRemain } from './timePolicy';

type Context = QueryCtx | MutationCtx;

// backupImports is local operation history, excluded from portable archives.
// For legacy clones, require the original completion evidence and the exact
// deployment created by that operation; a caller's manifest cannot grant this.
async function provesClone(ctx: Context, receipt: Doc<'backupImports'>, local: Doc<'federationIdentity'>) {
  if (receipt.mode !== 'clone' || receipt.sourceTownId === local.townId) return false;
  const records = await ctx.db.query('deploymentRecords').withIndex('townId', q => q.eq('townId', local.townId)).take(101);
  if (records.length > 100) return false;
  const matching = records.filter(r => r.mode === 'clone' && r.deploymentInstanceId === local.deploymentInstanceId &&
    r.deploymentEpoch === local.deploymentEpoch && r.createdAt >= local.createdAt && r.createdAt <= receipt.importedAt);
  if (matching.length !== 1) return false;
  const proof = receipt.cloneDeployment;
  if (proof) return proof.townId === local.townId && proof.publicKey === local.publicKey &&
    proof.fingerprint === local.fingerprint && proof.deploymentInstanceId === local.deploymentInstanceId &&
    proof.deploymentEpoch === local.deploymentEpoch && !!proof.sourcePublicKey && !!proof.sourceFingerprint &&
    proof.sourcePublicKey !== local.publicKey && proof.sourceFingerprint !== local.fingerprint;
  if (receipt.runtimeSnapshot?.largeJobId) {
    const id = ctx.db.normalizeId('backupLargeJobs', receipt.runtimeSnapshot.largeJobId);
    const job = id && await ctx.db.get(id);
    return !!job && job.kind === 'import' && job.mode === 'clone' && job.state === 'COMPLETE' &&
      job.phase === 'COMPLETE' && job.metadata?.importId === receipt._id && job.newTownId === local.townId &&
      job.source?.townId === receipt.sourceTownId && !!job.source?.publicKey && !!job.source?.fingerprint &&
      job.source.publicKey !== local.publicKey && job.source.fingerprint !== local.fingerprint &&
      job.keys?.publicKey === local.publicKey && job.keys?.fingerprint === local.fingerprint &&
      matching[0].createdAt === local.createdAt && receipt.importedAt === local.createdAt;
  }
  // Older ordinary clones have no explicit target binding. They can only be
  // identified unambiguously while their one original deployment still exists.
  const clones = await ctx.db.query('backupImports').withIndex('mode', q => q.eq('mode', 'clone')).take(2);
  if (clones.length !== 1 || clones[0]._id !== receipt._id || local.deploymentEpoch !== 1 ||
    !Array.isArray(receipt.runtimeSnapshot?.federationIdentity) || receipt.runtimeSnapshot.federationIdentity.length !== 1)
    return false;
  const source = decodeRow(receipt.runtimeSnapshot.federationIdentity[0]);
  return source.townId === receipt.sourceTownId && !!source.publicKey && !!source.fingerprint &&
    source.publicKey !== local.publicKey && source.fingerprint !== local.fingerprint;
}

// Called only after provesClone accepted local completion evidence.
export async function cloneDeploymentBinding(ctx: Context, receipt: Doc<'backupImports'>, local: Doc<'federationIdentity'>) {
  if (receipt.cloneDeployment) return receipt.cloneDeployment;
  const jobId = receipt.runtimeSnapshot?.largeJobId;
  const source = jobId
    ? (await ctx.db.get(ctx.db.normalizeId('backupLargeJobs', jobId)!))!.source
    : decodeRow(receipt.runtimeSnapshot.federationIdentity[0]);
  return { townId: local.townId, publicKey: local.publicKey, fingerprint: local.fingerprint,
    deploymentInstanceId: local.deploymentInstanceId, deploymentEpoch: local.deploymentEpoch,
    sourcePublicKey: source.publicKey as string, sourceFingerprint: source.fingerprint as string };
}

export async function independentCloneStatus(ctx: Context) {
  const local = await identity(ctx);
  const result = {
    eligible: false, reason: null as string | null,
    importId: null as Doc<'backupImports'>['_id'] | null,
    sourceTownId: null as string | null,
    townId: local?.townId ?? null,
    deploymentInstanceId: local?.deploymentInstanceId ?? null,
    deploymentEpoch: local?.deploymentEpoch ?? null,
    activatedAt: null as number | null,
  };
  const blocked = (reason: string) => ({ ...result, reason });
  if (!local) return blocked('INITIALIZE_IDENTITY_FIRST');
  if (local.mode !== 'DISABLED') return blocked('CLONE_DEPLOYMENT_NOT_DISABLED');
  // A deployment can only originate from one completed clone. Do not guess if
  // local history is ambiguous or belongs to an earlier deployment.
  const receipts = await ctx.db.query('backupImports').withIndex('mode', q => q.eq('mode', 'clone')).take(11);
  if (receipts.length > 10) return blocked('CLONE_COMPLETION_HISTORY_LIMIT');
  const candidates = [];
  for (const receipt of receipts) if (await provesClone(ctx, receipt, local)) candidates.push(receipt);
  if (candidates.length !== 1) return blocked('CLONE_COMPLETION_PROOF_REQUIRED');
  const receipt = candidates[0];
  result.importId = receipt._id;
  result.sourceTownId = receipt.sourceTownId;
  result.activatedAt = receipt.cloneActivation?.activatedAt ?? null;
  if (receipt.cloneActivation) return blocked('CLONE_ACTIVATION_NO_LONGER_CURRENT');
  if (local.enabled || local.allowIncomingPairRequests) return blocked('CLONE_ADMISSION_MUST_BE_CLOSED');
  const lock = await townMaintenanceLock(ctx);
  if (lock) return blocked(lock);
  for (const state of ['INSPECTING', 'RUNNING'])
    if (await ctx.db.query('travelPrivacyJobs').withIndex('state', q => q.eq('state', state)).first())
      return blocked('TOWN_TRAVEL_PRIVACY_BUSY');
  if (await ctx.db.query('backupLargeJobs').withIndex('state', q => q.lt('state', 'CANCELLED')).first() ||
    await ctx.db.query('backupLargeJobs').withIndex('state', q => q.gt('state', 'CANCELLED').lt('state', 'COMPLETE')).first() ||
    await ctx.db.query('backupLargeJobs').withIndex('state', q => q.gt('state', 'COMPLETE')).first())
    return blocked('CLONE_BACKUP_JOB_NOT_COMPLETE');
  if (await ctx.db.query('federationIdentityConflicts').withIndex('state', q => q.eq('state', 'OPEN')).first())
    return blocked('TOWN_CLONE_CONFLICT');
  if (local.activeHandoffId || local.migrationFrozenAt || local.migrationOperator || local.quarantinePreviousMode)
    return blocked('CLONE_OLD_AUTHORITY_REMAINS');
  const visits = await activeVisitsRemain(ctx.db);
  const reservation = await ctx.db.query('visitReservations').withIndex('active', q => q.eq('reservedSlot', true)).first();
  if (visits || reservation) return blocked('CLONE_ACTIVE_TRAVEL_REMAINS');
  const worlds = await ctx.db.query('worlds').take(101);
  if (worlds.length > 100) return blocked('CLONE_SAFETY_CHECK_LIMIT');
  if (worlds.some(w => w.players.some(p => p.remoteVisitor) || w.agents.some(a => a.travelVisitId || a.suspendedPlayer)))
    return blocked('CLONE_ACTIVE_TRAVEL_REMAINS');
  const runtimes = await ctx.db.query('federationAgentRuntimes').take(1001);
  if (runtimes.length > 1000) return blocked('CLONE_SAFETY_CHECK_LIMIT');
  if (runtimes.some(r => r.homeTownId !== local.townId || !r.agentGlobalId.startsWith(`${local.townId}/`) ||
    r.state !== 'HOME_ACTIVE' || r.visitId || r.activeDecisionId)) return blocked('CLONE_OLD_AUTHORITY_REMAINS');
  const peers = await ctx.db.query('federationPeers').take(101);
  if (peers.length > 100) return blocked('CLONE_SAFETY_CHECK_LIMIT');
  if (peers.some(p => p.trustState !== 'UNTRUSTED' || p.credentialId || p.credentialEncrypted ||
    p.inboundVisitsAllowed || p.outboundVisitsAllowed)) return blocked('CLONE_PEER_TRUST_REMAINS');
  for (const table of ['transportSessions', 'pairRequests', 'migrationPeerExchanges', 'federationCredentialRotations',
    'federationIdentityKeyRotations', 'federationIdentityKeyExchanges', 'federationInbox', 'federationOutbox',
    'federationDecisionJobs', 'federationPresenceJobs', 'federationTurns', 'federationPendingActions'] as const)
    if (await ctx.db.query(table).first()) return blocked('CLONE_OLD_AUTHORITY_REMAINS');
  if (await ctx.db.query('federationIdentityKeyHistory').filter(q => q.eq(q.field('verified'), true)).first())
    return blocked('CLONE_OLD_AUTHORITY_REMAINS');
  return { ...result, eligible: true };
}
