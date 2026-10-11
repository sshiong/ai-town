import { v } from 'convex/values';

export const observedEvidenceFields = {
  providerId: v.string(), providerUrl: v.string(), profileFingerprint: v.string(),
  artifactDigest: v.string(), metadataDigest: v.string(), pipelineFingerprint: v.string(),
  serviceVersion: v.string(), dimensions: v.number(),
};
export const certificateEvidenceFields = {
  ...observedEvidenceFields, querySample: v.array(v.float64()), documentSample: v.array(v.float64()),
};
