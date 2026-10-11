import type { DatabaseReader } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import type { EmbeddingEvidence, VerifiedEmbeddingCertificate } from '../models/compatibility';
import { embeddingFingerprint, validateVector } from '../models/compatibility';
import { memorySourceDigest } from '../models/embeddingDataRevision';
import { pipelineFingerprint } from '../models/ollamaEvidence';
import { digest } from './security';

export type PortableGenerationEvidence = {
  version: 1; profile: EmbeddingEvidence;
  certificate: VerifiedEmbeddingCertificate & {
    providerUrl: string; metadataDigest: string; serviceVersion: string;
  };
};
export function vectorFields(row: Record<string, any>) {
  const { generationEvidenceId: _, generationEvidence: __, embeddingCertificateId: ___, ...fields } = row;
  return fields;
}
export async function validateGenerationEvidence(row: Record<string, any>) {
  const proof = row.generationEvidence as PortableGenerationEvidence;
  if (!proof || proof.version !== 1 || !proof.profile || !proof.certificate ||
    row.generationEvidenceId !== await digest(proof) ||
    proof.certificate.profileFingerprint !== embeddingFingerprint(proof.profile) ||
    proof.certificate.pipelineFingerprint !== await pipelineFingerprint(proof.profile, proof.certificate.serviceVersion, proof.certificate.metadataDigest) ||
    !/^[a-f0-9]{64}$/.test(proof.certificate.artifactDigest) ||
    !Number.isFinite(proof.certificate.verifiedAt) || proof.certificate.verifiedAt <= 0 ||
    typeof proof.certificate.providerId !== 'string' || !proof.certificate.providerId ||
    typeof proof.certificate.providerUrl !== 'string' || proof.certificate.providerUrl !== proof.profile.url ||
    typeof proof.certificate.serviceVersion !== 'string' || !proof.certificate.serviceVersion ||
    !/^[a-f0-9]{64}$/.test(proof.certificate.metadataDigest) ||
    !/^[a-f0-9]{64}$/.test(row.sourceDigest) ||
    proof.certificate.state !== 'REVOKED' || proof.certificate.checkedAt !== 0 ||
    proof.profile.provider !== 'ollama' || proof.profile.preprocessingRevision !== 'newline-to-space-v1' ||
    proof.profile.normalization !== 'none' || typeof proof.profile.model !== 'string' || !proof.profile.model ||
    typeof proof.profile.queryPrefix !== 'string' || typeof proof.profile.documentPrefix !== 'string' ||
    proof.certificate.dimensions !== proof.profile.dimensions ||
    !Number.isSafeInteger(proof.profile.dimensions) || proof.profile.dimensions < 1 || proof.profile.dimensions > 16384)
    throw new Error('INVALID_PORTABLE_GENERATION_EVIDENCE');
  validateVector(row.embedding, proof.profile.dimensions);
  validateVector(proof.certificate.querySample, proof.profile.dimensions);
  validateVector(proof.certificate.documentSample, proof.profile.dimensions);
  return proof;
}
export async function validateVectorSource(row: Record<string, any>, memory: Record<string, any> | null,
  expectedDigest?: string) {
  if (!memory || row.memoryId !== memory._id || row.worldId !== memory.worldId ||
    row.playerId !== memory.playerId || row.agentGlobalId !== memory.agentGlobalId ||
    row.sourceDigest !== (expectedDigest ?? await memorySourceDigest(memory as never)))
    throw new Error('VECTOR_SOURCE_OWNER_OR_TEXT_CHANGED');
}
export async function portableVector(db: DatabaseReader, vector: Doc<'modelMemoryVectors'>, activeOnly = false) {
  if (activeOnly) {
    const settings = await db.query('modelSettings').withIndex('key', q => q.eq('key', 'town')).unique();
    if (settings?.activeEmbeddingSpaceId !== vector.spaceId) return null;
  }
  if (!vector.embeddingCertificateId) return null;
  const certificate = await db.get(vector.embeddingCertificateId);
  const profile = certificate && await db.get(certificate.profileId);
  const memory = await db.get(vector.memoryId);
  if (!certificate || !profile || !memory || !certificate.verifiedAt ||
    certificate.profileFingerprint !== embeddingFingerprint(profile) ||
    vector.worldId !== memory.worldId || vector.playerId !== memory.playerId || vector.agentGlobalId !== memory.agentGlobalId ||
    vector.sourceDigest !== await memorySourceDigest(memory)) return null;
  const { provider, url, model, dimensions, immutableRevision, weightsDigest,
    preprocessingRevision, queryPrefix, documentPrefix, normalization } = profile;
  const generationEvidence: PortableGenerationEvidence = { version: 1,
    profile: { provider, url, model, dimensions, preprocessingRevision, queryPrefix, documentPrefix, normalization,
      ...(immutableRevision ? { immutableRevision } : {}), ...(weightsDigest ? { weightsDigest } : {}) },
    certificate: { profileFingerprint: certificate.profileFingerprint, artifactDigest: certificate.artifactDigest,
      pipelineFingerprint: certificate.pipelineFingerprint, providerId: certificate.providerId, dimensions: certificate.dimensions,
      providerUrl: certificate.providerUrl, metadataDigest: certificate.metadataDigest, serviceVersion: certificate.serviceVersion,
      state: 'REVOKED', checkedAt: 0, verifiedAt: certificate.verifiedAt,
      querySample: certificate.querySample, documentSample: certificate.documentSample } };
  const portable = { ...vectorFields(vector), generationEvidenceId: await digest(generationEvidence), generationEvidence };
  await validateGenerationEvidence(portable);
  return portable;
}
export async function trustedVectorSource(db: DatabaseReader, source: { townId: string; publicKey: string; fingerprint: string }) {
  if (source.fingerprint !== `sha256:${await digest(source.publicKey)}`) return false;
  const local = await db.query('federationIdentity').unique();
  if (local?.townId === source.townId && local.publicKey === source.publicKey && local.fingerprint === source.fingerprint) return true;
  const peer = await db.query('federationPeers').filter(q => q.eq(q.field('townId'), source.townId)).unique();
  return peer?.trustState === 'TRUSTED' && peer.publicKey === source.publicKey && peer.fingerprint === source.fingerprint;
}
