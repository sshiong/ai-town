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
export function verifiedCompatible(a: EmbeddingEvidence, b: EmbeddingEvidence): boolean {
  // Names, dimensions and approximate sample similarity are never compatibility evidence.
  return (
    !!a.immutableRevision &&
    !!b.immutableRevision &&
    !!a.weightsDigest &&
    /^[a-f0-9]{64}$/i.test(a.weightsDigest) &&
    a.weightsDigest === b.weightsDigest &&
    a.immutableRevision === b.immutableRevision &&
    a.dimensions === b.dimensions &&
    a.preprocessingRevision === b.preprocessingRevision &&
    a.queryPrefix === b.queryPrefix &&
    a.documentPrefix === b.documentPrefix &&
    a.normalization === b.normalization
  );
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
