export type EmbeddingEvidence = {
  provider: string;
  url: string;
  model: string;
  dimensions: number;
  immutableRevision?: string;
  weightsDigest?: string;
  preprocessingRevision: string;
  queryPrefix: string;
  documentPrefix: string;
  normalization: string;
};
export function embeddingFingerprint(profile: EmbeddingEvidence): string {
  return JSON.stringify([
    profile.provider,
    profile.url,
    profile.model,
    profile.dimensions,
    profile.immutableRevision ?? null,
    profile.weightsDigest ?? null,
    profile.preprocessingRevision,
    profile.queryPrefix,
    profile.documentPrefix,
    profile.normalization,
  ]);
}
export type VerifiedEmbeddingCertificate = {
  profileFingerprint: string; artifactDigest: string; pipelineFingerprint: string; providerId: string;
  dimensions: number; state: string; checkedAt: number; verifiedAt: number;
  querySample: number[]; documentSample: number[];
};
export function verifiedCompatible(a: EmbeddingEvidence, b: EmbeddingEvidence,
  certificates?: { source: VerifiedEmbeddingCertificate | null; target: VerifiedEmbeddingCertificate | null }, now = Date.now()): boolean {
  // Certificates must be read from the local system-owned table, never a form
  // or imported archive. A revoked serving route does not falsify historical
  // generation evidence, but the target must have fresh serving authority.
  const source = certificates?.source, target = certificates?.target;
  if (!source || !target || source.profileFingerprint !== embeddingFingerprint(a) ||
    target.profileFingerprint !== embeddingFingerprint(b) || target.state !== 'ACTIVE' ||
    target.checkedAt > now || now - target.checkedAt > 60_000 ||
    !source.verifiedAt || !target.verifiedAt || source.dimensions !== a.dimensions || target.dimensions !== b.dimensions ||
    source.artifactDigest !== target.artifactDigest || source.pipelineFingerprint !== target.pipelineFingerprint ||
    source.providerId !== target.providerId || source.dimensions !== target.dimensions) return false;
  try {
    for (const vector of [source.querySample, source.documentSample, target.querySample, target.documentSample]) validateVector(vector, a.dimensions);
    return cosineSimilarity(source.querySample, target.querySample) >= 0.99999 &&
      cosineSimilarity(source.documentSample, target.documentSample) >= 0.99999;
  } catch { return false; }
}
export function validateVector(vector: number[], dimensions: number) {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))
    throw new Error('INVALID_EMBEDDING_VECTOR');
  if (!vector.some((value) => value !== 0)) throw new Error('ZERO_EMBEDDING_VECTOR');
}
export function cosineSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length) throw new Error('EMBEDDING_DIMENSION_MISMATCH');
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}
