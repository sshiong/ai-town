export function isReadyDestination(
  peer: {
    trustState: string;
    channelState: string;
    outboundVisitsAllowed: boolean;
    readinessExpiresAt: number;
  },
  now = Date.now(),
) {
  return (
    peer.trustState === 'TRUSTED' &&
    peer.channelState === 'TRANSPORT_READY' &&
    peer.outboundVisitsAllowed &&
    peer.readinessExpiresAt > now
  );
}

export function isOpenVisit(state: string) {
  return !['COMPLETED', 'REJECTED'].includes(state);
}

export type QueuedVisitOperation = 'PAUSE' | 'RESUME' | 'REJECT' | 'PROMOTE';

export function canManageQueuedVisit(
  visit: { state: string; queuePaused?: boolean; queueExpiresAt?: number },
  operation: QueuedVisitOperation,
  now: number,
) {
  if (visit.state !== 'QUEUED') return false;
  if (operation === 'REJECT') return true;
  if (!Number.isFinite(visit.queueExpiresAt) || visit.queueExpiresAt! <= now) return false;
  return operation === 'RESUME' ? visit.queuePaused === true : !visit.queuePaused;
}

export function deadlineRemaining(expiresAt: number | undefined, now: number) {
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) return 'Not reported';
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (seconds === 0) return 'Expired';
  if (seconds < 60) return `${seconds}s remaining`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s remaining`;
}

export function requiresStoppedSource(mode: string) {
  return mode === 'restore' || mode === 'migrate';
}

export function canResumeRestoredResident(
  resident: { safeAfter: number | null; engineStopped: boolean; reason: string | null },
  now: number,
) {
  return (
    resident.engineStopped &&
    resident.safeAfter !== null &&
    resident.safeAfter <= now &&
    (resident.reason === null ||
      resident.reason === 'OLD_HOST_LEASE_STILL_VALID' ||
      resident.reason === 'STOP_TARGET_ENGINE_FIRST')
  );
}

export function adminErrorSummary(message: string) {
  const explanations: Record<string, string> = {
    INVALID_CREDENTIAL_OVERLAP: 'Choose a credential overlap between 10 and 30 whole minutes.',
    CREDENTIAL_ROTATION_IN_PROGRESS: 'A credential rotation is already pending or its overlap period is still active. Wait before rotating again.',
    CREDENTIAL_ROTATION_EXPIRED: 'The rotation window expired before both sides confirmed. Check the neighbor and pair again if connectivity has been lost.',
    CREDENTIAL_ROTATION_FENCED: 'The neighbor identity or deployment changed during rotation. Verify its current identity before retrying.',
    RESIDENT_CAPACITY_EXCEEDED:
      'The resident limit has been reached. Increase capacity before adding another resident.',
    HUMAN_CAPACITY_EXCEEDED: 'The town has reached its limit for human players.',
    LOCAL_LLM_PAUSED:
      'New model requests are paused. Increase the concurrent request limit to resume them.',
    LOCAL_LLM_QUEUE_FULL:
      'The model request queue is full. Wait for current requests to finish or increase the queue limit.',
    LOCAL_LLM_QUEUE_TIMEOUT: 'This model request could not start within the queue wait limit.',
    CHAT_REQUEST_DEADLINE: 'The model request exceeded its overall deadline.',
    DECISION_QUEUE_FULL: 'The pending visitor decision limit has been reached.',
    VISITOR_QUEUE_DISABLED: 'This host is not accepting new waiting requests. Existing visits keep their normal return path.',
    VISITOR_QUEUE_FULL: 'The visitor waiting queue is full. Try a new visit after this request finishes.',
    VISITOR_SOURCE_QUEUE_FULL: 'This source town has reached its waiting limit.',
    VISITOR_NOT_QUEUED: 'This request is no longer waiting. Review its latest ledger state.',
    VISITOR_QUEUE_EXPIRED: 'The waiting deadline has passed. The request will finish without departure.',
    INVALID_VISITOR_QUEUE_POLICY: 'Use 1–1000 waiting requests, a 1–3600 second deadline, and a blank or 0–1000 source waiting cap.',
    HOST_VISITOR_QUEUE_PENDING: 'Earlier waiting requests are considered first. Admission follows the host queue order.',
    ADMIN_QUEUE_REJECTED: 'The host administrator rejected this waiting request.',
    HOST_QUEUE_DISABLED: 'The host disabled waiting. This request is ending without departure.',
    VISITOR_QUEUE_DEPLOYMENT_FENCED: 'A town deployment changed while this request waited. Start a new visit after verifying the connection.',
    VISITOR_QUEUE_PEER_REVOKED: 'The source connection was revoked. The waiting request is ending.',
    HOST_CAPACITY_EXCEEDED: 'The host has no visitor place available yet.',
    HOST_RESERVATION_CAPACITY_EXCEEDED: 'The host has no reservation available yet.',
    HOST_SOURCE_QUOTA_EXCEEDED: 'This source town has reached the host visitor quota.',
    HOST_RESOURCE_DEGRADED: 'The host has paused new admission while its resources recover.',
    ADMIN_UNAUTHORIZED: "Administrator access was rejected. Check this deployment's admin token.",
    DRAIN_TARGET_WORK_BEFORE_RESIDENT_RESTORE:
      'Wait for model requests and resident operations to finish, and drain the target input queue before restoring this resident.',
    RESIDENT_RESTORE_TARGET_CHANGED:
      'The target changed after preflight. Run preflight again and review the new snapshot before confirming.',
    RESIDENT_RESTORE_CONFIRMATION_REQUIRED:
      'Review the resident snapshot, enter an operator and reason, and explicitly authorize this restore.',
    STOP_TARGET_ENGINE_FIRST: 'Pause the target simulation before running import preflight.',
    END_VISITS_BEFORE_STOPPING:
      'End active visits and wait for cleanup before pausing the simulation.',
    SOURCE_DEPLOYMENT_MUST_BE_STOPPED:
      'Stop the source deployment before restoring or migrating its identity.',
    RESTORE_SOURCE_STOP_REQUIRED:
      'Stop the source deployment and confirm it cannot issue visit authorizations before restoring this identity.',
    MIGRATION_SOURCE_STOP_REQUIRED: 'Stop the source deployment before migrating this identity.',
    OLD_HOST_LEASE_STILL_VALID:
      'The previous host may still act under its lease. Wait until the displayed safe return time.',
    RECOVERY_LEASE_STILL_VALID:
      'The previous host lease is still valid. Wait until the safe recovery time before returning this resident.',
    DIRECT_PEER_NOT_MUTUALLY_REACHABLE:
      'Travel is blocked. Both towns must pass a fresh two-way transport probe.',
    FEDERATION_DISABLED: 'Federation visits are closed or this deployment is not active.',
    MODEL_CREDENTIAL_MISSING:
      'The model credential is missing on the server. Configure the referenced environment variable.',
    BACKUP_MAINTENANCE_LOCKED:
      'A checkpointed archive task is holding the town maintenance lock. Finish it or cancel and complete rollback before changing town data.',
    DISABLE_FEDERATION_BEFORE_BACKUP:
      'Close federation visits before starting a consistent archive.',
    RESUME_BACKUP_JOB_FIRST: 'Retry the failed checkpoint before continuing this archive task.',
    IDENTITY_RECOVERY_REQUIRES_EMPTY_DESTINATION:
      'Identity restoration requires a fresh deployment without town data, peers or resident bindings.',
    RECOVERY_SOURCE_STOP_REQUIRED:
      'Stop the old source deployment and confirm it cannot issue authorizations before restoring its identity.',
    RECOVERY_PASSPHRASE_LENGTH:
      'Use a passphrase of at least 12 characters and no more than 1024 UTF-8 bytes.',
    RECOVERY_DECRYPTION_FAILED:
      'The recovery package could not be decrypted. Check the passphrase and use an intact encrypted export.',
    BACKUP_SIZE_LIMIT:
      'This backup exceeds the single-file size limit. Use chunked archives for a full town, or export one resident.',
    BACKUP_ATOMIC_RECORD_LIMIT:
      'This backup exceeds the 500-record single-file limit. Use chunked archives for the full town.',
  };
  const code = Object.keys(explanations).find((code) => message.includes(code));
  return code ? explanations[code] : message;
}

export async function readBackupFile(file: Pick<File, 'size' | 'text'>): Promise<unknown> {
  if (file.size > 5 * 1024 * 1024) throw new Error('Backup exceeds the 5 MiB browser limit.');
  const parsed: unknown = JSON.parse(await file.text());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Choose an exported AI Town JSON object.');
  return parsed;
}
