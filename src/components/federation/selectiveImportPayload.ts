import type { LocalArchiveProof } from '../../../convex/federation/travelPrivacyLocalChunkManifest';

/** Export wrappers contain presentation/evidence fields that strict import arguments must never forward. */
export function selectiveImportPayload(value: { manifest: unknown; signature: string; localProof?: LocalArchiveProof },
  trustedFingerprint: string) {
  return {
    manifest: value.manifest,
    signature: value.signature,
    ...(value.localProof ? { localProof: value.localProof, expectedLocalProofFingerprint: trustedFingerprint.trim() } : {}),
  };
}


/** Staging must include both independent file namespaces before server preflight can begin. */
export function selectiveStagingComplete(job: { uploadedChunks: number; chunkCount: number;
  uploadedPrivacyChunks?: number; privacyChunkCount?: number }) {
  return job.uploadedChunks === job.chunkCount && (job.uploadedPrivacyChunks ?? 0) === (job.privacyChunkCount ?? 0);
}
