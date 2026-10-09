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
    ADMIN_UNAUTHORIZED: "Administrator access was rejected. Check this deployment's admin token.",
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
    BACKUP_SIZE_LIMIT:
      'This backup exceeds the server size limit. Export a smaller resident package.',
    BACKUP_ATOMIC_RECORD_LIMIT:
      'This backup exceeds the 500-record transaction limit. Export a smaller resident package.',
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
