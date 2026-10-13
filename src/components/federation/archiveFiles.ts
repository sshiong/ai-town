import type { LargeManifest } from '../../../convex/federation/backupLargeHelpers';
import type { LocalArchiveProof, LocalSanitizedChunkManifest } from '../../../convex/federation/travelPrivacyLocalChunkManifest';

type SignedRawArchive = { manifest: LargeManifest; signature: string };
type DerivedRawArchive = { manifest: LocalSanitizedChunkManifest; signature: ''; sourceSignatureValid: false; localProof: LocalArchiveProof };
export type LoadedLargeArchiveManifest = {
  archive: SignedRawArchive | DerivedRawArchive;
  source: LargeManifest;
  declaredLocalSignerFingerprint?: string;
};
const metadataError = 'The archive manifest contains unsupported metadata.';
const invalidMetadata = 'The archive manifest metadata is invalid.';
function archiveRecord(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(invalidMetadata);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new Error(metadataError);
  return record;
}
function rawSourceManifest(value: unknown) {
  const manifest = archiveRecord(value, ['format', 'version', 'schemaVersion', 'scope', 'exportId', 'source',
    'exportedAt', 'includeVectors', 'chunks']);
  if (manifest.format !== 'ai-town-chunks') throw new Error('This import panel supports RAW town archives only.');
  if (manifest.version !== 1 || manifest.schemaVersion !== 1 || manifest.scope !== 'town' ||
    typeof manifest.exportId !== 'string' || typeof manifest.exportedAt !== 'number' ||
    !Number.isFinite(manifest.exportedAt) || !Array.isArray(manifest.chunks) ||
    (manifest.includeVectors !== undefined && typeof manifest.includeVectors !== 'boolean')) throw new Error(invalidMetadata);
  const source = archiveRecord(manifest.source, ['_id', '_creationTime', 'timePolicy', 'identityVersion', 'townId', 'townName',
    'publicKey', 'fingerprint', 'deploymentInstanceId', 'deploymentEpoch', 'endpoint', 'enabled', 'allowIncomingPairRequests',
    'allowUnencryptedHttp', 'allowPublicHttp', 'maxVisitors', 'maxVisitDurationMs', 'replyTimeoutMs', 'resourceLimits', 'mode',
    'createdAt', 'migrationFrozenAt', 'migrationOperator', 'activeHandoffId', 'quarantinePreviousMode', 'endpointSequence',
    'endpointCandidates', 'endpointGeneration']);
  if (typeof source.townId !== 'string' || typeof source.publicKey !== 'string' || typeof source.fingerprint !== 'string')
    throw new Error(invalidMetadata);
  for (const [name, fields] of Object.entries({
    timePolicy: ['reservationMs', 'leaseMs', 'clockSkewMs', 'probeFreshnessMs', 'probeIntervalMs', 'gapTimeoutMs',
      'returnMarginMs', 'clockObservationGapMs', 'requestTimeoutMs'],
    resourceLimits: ['maxResidentAgents', 'maxHumanPlayers', 'maxVisitReservations', 'maxConcurrentLocalLLM',
      'maxPendingDecisions', 'maxPendingLocalLLM'],
  })) if (source[name] !== undefined) archiveRecord(source[name], fields);
  if (source.endpointCandidates !== undefined) {
    if (!Array.isArray(source.endpointCandidates)) throw new Error(invalidMetadata);
    for (const endpoint of source.endpointCandidates) archiveRecord(endpoint, ['url', 'priority']);
  }
  for (const chunk of manifest.chunks) archiveRecord(chunk, ['index', 'table', 'count', 'bytes', 'digest']);
  return value as LargeManifest;
}

/** Shape and display checks only; signatures, descriptors and references are authenticated by the server. */
export async function loadLargeArchiveManifest(value: unknown): Promise<LoadedLargeArchiveManifest> {
  const header = archiveRecord(value, ['manifest', 'signature', 'sourceSignatureValid', 'localProof']);
  if (typeof header.signature !== 'string') throw new Error(invalidMetadata);
  const format = (header.manifest as { format?: unknown } | undefined)?.format;
  if (format === 'ai-town-chunks') {
    if (header.localProof !== undefined || header.sourceSignatureValid !== undefined) throw new Error(metadataError);
    const source = rawSourceManifest(header.manifest);
    return { archive: value as SignedRawArchive, source };
  }
  if (format !== 'ai-town-local-sanitized-chunks') throw new Error('This import panel supports RAW town archives only.');
  const local = archiveRecord(header.manifest, ['format', 'version', 'schemaVersion', 'sourceSignatureValid', 'archiveId',
    'derivedAt', 'chunks', 'clearedVisits', 'sourceEvidence']);
  if (header.sourceSignatureValid !== false || local.sourceSignatureValid !== false || header.signature !== '')
    throw new Error('A derived archive cannot claim that its current bytes have the original source signature.');
  if (local.version !== 1 || local.schemaVersion !== 1 || typeof local.archiveId !== 'string' ||
    typeof local.derivedAt !== 'number' || !Number.isFinite(local.derivedAt) || !Array.isArray(local.chunks) ||
    !Array.isArray(local.clearedVisits) || !local.clearedVisits.length ||
    local.clearedVisits.some(visit => typeof visit !== 'string' || !visit)) throw new Error(invalidMetadata);
  for (const chunk of local.chunks) {
    const descriptor = archiveRecord(chunk, ['index', 'table', 'count', 'bytes', 'digest', 'role', 'encoding']);
    if (descriptor.role === 'OLD') throw new Error('Private rollback chunks cannot be imported as a portable town archive.');
    if (descriptor.encoding !== 'RAW' || !['SOURCE', 'EXPORT'].includes(String(descriptor.role)))
      throw new Error('This import panel supports RAW town archives only.');
  }
  const evidence = archiveRecord(local.sourceEvidence, ['manifest', 'manifestStorageId', 'digest', 'signature', 'publicKey']);
  if (typeof evidence.digest !== 'string' || typeof evidence.signature !== 'string' || typeof evidence.publicKey !== 'string' ||
    (evidence.manifestStorageId !== undefined && typeof evidence.manifestStorageId !== 'string')) throw new Error(invalidMetadata);
  const source = rawSourceManifest(evidence.manifest);
  const proof = archiveRecord(header.localProof, ['format', 'version', 'townId', 'publicKey', 'manifestDigest', 'signature']);
  if (proof.format !== 'ai-town-local-archive-proof' || proof.version !== 1 || typeof proof.townId !== 'string' ||
    typeof proof.publicKey !== 'string' || !proof.publicKey || typeof proof.manifestDigest !== 'string' ||
    typeof proof.signature !== 'string') throw new Error(invalidMetadata);
  if (!globalThis.crypto?.subtle) throw new Error('A secure browser context is required to display the local signer fingerprint.');
  // Matches backend digest(publicKey), whose canonical representation is the JSON string.
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(proof.publicKey))));
  const fingerprint = `sha256:${btoa(String.fromCharCode(...bytes))}`;
  return { archive: value as DerivedRawArchive, source, declaredLocalSignerFingerprint: fingerprint };
}

export function confirmedLargeArchiveSigner(loaded: LoadedLargeArchiveManifest | undefined, confirmation: string) {
  return !!loaded && (!loaded.declaredLocalSignerFingerprint || confirmation.trim() === loaded.declaredLocalSignerFingerprint);
}

export async function readArchiveJson(
  file: Pick<File, 'size' | 'text'>,
  maxBytes: number,
): Promise<unknown> {
  if (file.size > maxBytes)
    throw new Error('The selected file exceeds the supported size for this archive part.');
  const value: unknown = JSON.parse(await file.text());
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Choose an exported JSON object.');
  return value;
}

type ArchiveWritable = {
  write: (text: string) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
};
export type ArchiveDirectory = {
  getFileHandle: (
    name: string,
    options: { create: boolean },
  ) => Promise<{ createWritable: () => Promise<ArchiveWritable> }>;
};
type DirectoryWindow = Window & {
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<ArchiveDirectory>;
};
export function supportsArchiveDirectory() {
  return typeof (window as DirectoryWindow).showDirectoryPicker === 'function';
}
export async function selectArchiveDirectory() {
  const picker = (window as DirectoryWindow).showDirectoryPicker;
  if (!picker)
    throw new Error(
      'Folder downloads are unavailable in this browser. Download the manifest and chunks separately.',
    );
  return picker.call(window, { mode: 'readwrite' });
}
export async function writeArchivePart(
  directory: ArchiveDirectory,
  filename: string,
  value: unknown,
) {
  return writeArchiveText(directory, filename, JSON.stringify(value));
}

export async function writeArchiveText(
  directory: ArchiveDirectory,
  filename: string,
  json: string,
) {
  const handle = await directory.getFileHandle(filename, { create: true });
  const stream = await handle.createWritable();
  try {
    await stream.write(json);
    await stream.close();
  } catch (error) {
    try {
      await stream.abort();
    } catch {
      // Preserve the original write failure even if the failed stream cannot be aborted.
    }
    throw error;
  }
}

export function validRecoveryPassphrase(value: string) {
  return value.length >= 12 && new TextEncoder().encode(value).length <= 1024;
}
