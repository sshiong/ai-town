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
