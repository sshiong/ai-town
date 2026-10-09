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
