import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action, internalMutation, internalQuery, query, type ActionCtx, type DatabaseReader } from '../maintenanceFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { assertFederationAdmin } from '../federation/auth';
import { embeddingFingerprint, verifiedCompatible, validateVector } from './compatibility';
import { certificateEvidenceFields, observedEvidenceFields } from './embeddingCertificateSchema';
import { CERTIFICATE_FRESHNESS_MS, OLLAMA_TRUST_BOUNDARY, collectOllamaEvidence, observeOllamaEvidence, trustedOllamaProvider } from './ollamaEvidence';
import { audit } from './profiles';

const qref = (name: string) => makeFunctionReference<'query'>(`models/embeddingProvenance:${name}`);
const mref = (name: string) => makeFunctionReference<'mutation'>(`models/embeddingProvenance:${name}`);
export async function latestCertificate(db: DatabaseReader, profileId: Id<'embeddingProfiles'>) {
  // Imported historical proofs attest to generation only. They must never
  // supersede the most recent local serving verification, including its revocation.
  return db.query('embeddingCertificates').withIndex('profile', q => q.eq('profileId', profileId))
    .filter(q => q.eq(q.field('generationEvidenceId'), undefined)).order('desc').first();
}
export async function assertSpaceCertificate(db: DatabaseReader, spaceId: Id<'embeddingSpaces'>,
  expected?: Id<'embeddingCertificates'>, requireFresh = true): Promise<Doc<'embeddingCertificates'> | null> {
  const space = await db.get(spaceId);
  if (!space) throw new Error('EMBEDDING_SPACE_NOT_FOUND');
  if (!space.embeddingCertificateId) {
    if (expected) throw new Error('EMBEDDING_CERTIFICATE_FENCED');
    return null;
  }
  if (expected !== undefined && expected !== space.embeddingCertificateId) throw new Error('EMBEDDING_CERTIFICATE_FENCED');
  const certificate = await db.get(space.embeddingCertificateId), profile = await db.get(space.profileId);
  const trust = profile && trustedOllamaProvider(profile);
  if (!certificate || certificate.state !== 'ACTIVE' || !profile || profile.disabled ||
    certificate.profileId !== profile._id || certificate.profileFingerprint !== embeddingFingerprint(profile) ||
    !trust || trust.providerId !== certificate.providerId || trust.url !== certificate.providerUrl ||
    requireFresh && (certificate.checkedAt > Date.now() || Date.now() - certificate.checkedAt > CERTIFICATE_FRESHNESS_MS))
    throw new Error('EMBEDDING_CERTIFICATE_FENCED');
  return certificate;
}
export async function assertVectorCertificate(db: DatabaseReader, spaceId: Id<'embeddingSpaces'>,
  generationId?: Id<'embeddingCertificates'>) {
  const target = await assertSpaceCertificate(db, spaceId);
  if (!target) {
    if (generationId) throw new Error('EMBEDDING_CERTIFICATE_FENCED');
    return;
  }
  if (!generationId) throw new Error('EMBEDDING_GENERATION_EVIDENCE_MISSING');
  if (generationId === target._id) return;
  const source = await db.get(generationId), sourceProfile = source && await db.get(source.profileId);
  const targetProfile = await db.get(target.profileId);
  if (!source || !sourceProfile || !targetProfile || !verifiedCompatible(sourceProfile, targetProfile, { source, target }))
    throw new Error('EMBEDDING_GENERATION_EVIDENCE_MISMATCH');
}
export const spaceCertificate = internalQuery({
  args: { spaceId: v.id('embeddingSpaces') },
  handler: (ctx, args) => assertSpaceCertificate(ctx.db, args.spaceId, undefined, false),
});
export const recordCertificate = internalMutation({
  args: { profileId: v.id('embeddingProfiles'), evidence: v.object(certificateEvidenceFields) },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId), trust = profile && trustedOllamaProvider(profile);
    if (!profile || profile.disabled || !trust || trust.providerId !== args.evidence.providerId || trust.url !== args.evidence.providerUrl ||
      embeddingFingerprint(profile) !== args.evidence.profileFingerprint) throw new Error('EMBEDDING_PROFILE_CHANGED');
    validateVector(args.evidence.querySample, profile.dimensions); validateVector(args.evidence.documentSample, profile.dimensions);
    const now = Date.now();
    const id = await ctx.db.insert('embeddingCertificates', { profileId: profile._id, ...args.evidence,
      state: 'ACTIVE', verifiedAt: now, checkedAt: now, trustBoundary: OLLAMA_TRUST_BOUNDARY });
    await audit(ctx, 'VERIFY_EMBEDDING_PROVIDER', profile._id, id, OLLAMA_TRUST_BOUNDARY);
    return id;
  },
});
export const revokeCertificate = internalMutation({
  args: { embeddingCertificateId: v.id('embeddingCertificates'), reason: v.string() },
  handler: async (ctx, args) => {
    const certificate = await ctx.db.get(args.embeddingCertificateId);
    if (!certificate || certificate.state === 'REVOKED') return;
    await ctx.db.patch(certificate._id, { state: 'REVOKED', revokedAt: Date.now(), reason: args.reason.slice(0, 200) });
    await audit(ctx, 'REVOKE_EMBEDDING_PROVIDER', certificate.profileId, certificate._id, args.reason.slice(0, 200));
  },
});
export const refreshCertificate = internalMutation({
  args: { spaceId: v.id('embeddingSpaces'), embeddingCertificateId: v.id('embeddingCertificates'), evidence: v.object(observedEvidenceFields) },
  handler: async (ctx, args) => {
    const certificate = await assertSpaceCertificate(ctx.db, args.spaceId, args.embeddingCertificateId, false);
    if (!certificate || Object.keys(observedEvidenceFields).some(key => certificate[key as keyof typeof args.evidence] !== args.evidence[key as keyof typeof args.evidence]))
      throw new Error('EMBEDDING_PROVIDER_CHANGED');
    await ctx.db.patch(certificate._id, { checkedAt: Date.now() });
    return certificate._id;
  },
});
export async function guardEmbeddingRoute(ctx: ActionCtx, route: { space: Doc<'embeddingSpaces'>; profile: Doc<'embeddingProfiles'> }): Promise<Id<'embeddingCertificates'> | undefined> {
  if (!route.space.embeddingCertificateId) return undefined;
  const certificate: Doc<'embeddingCertificates'> | null = await ctx.runQuery(qref('spaceCertificate'), { spaceId: route.space._id });
  if (!certificate || certificate._id !== route.space.embeddingCertificateId) throw new Error('EMBEDDING_CERTIFICATE_FENCED');
  try {
    const observed = await observeOllamaEvidence(route.profile);
    return await ctx.runMutation(mref('refreshCertificate'), { spaceId: route.space._id, embeddingCertificateId: certificate._id, evidence: observed });
  } catch (error) {
    await ctx.runMutation(mref('revokeCertificate'), { embeddingCertificateId: certificate._id, reason: 'SERVING_METADATA_CHANGED_OR_UNAVAILABLE' });
    throw error;
  }
}
export const verifyProvider = action({
  args: { adminToken: v.string(), embeddingProfileId: v.id('embeddingProfiles') },
  handler: async (ctx, args): Promise<{ compatibility: 'UNKNOWN'; reason: string } | { compatibility: 'VERIFIED_PROVIDER'; embeddingCertificateId: Id<'embeddingCertificates'>; trustBoundary: string }> => {
    assertFederationAdmin(args.adminToken);
    const profile: Doc<'embeddingProfiles'> = await ctx.runQuery(makeFunctionReference<'query'>('models/embeddings:profileById'), { embeddingProfileId: args.embeddingProfileId });
    if (profile.disabled) throw new Error('EMBEDDING_PROFILE_DISABLED');
    if (!trustedOllamaProvider(profile)) return { compatibility: 'UNKNOWN', reason: 'NO_AUTHORIZED_PROVIDER_EVIDENCE' };
    const evidence = await collectOllamaEvidence(profile);
    const embeddingCertificateId = await ctx.runMutation(mref('recordCertificate'), { profileId: profile._id, evidence });
    // This attests to the provider, never retroactively to existing vectors.
    return { compatibility: 'VERIFIED_PROVIDER', embeddingCertificateId, trustBoundary: OLLAMA_TRUST_BOUNDARY };
  },
});
export const status = query({
  args: { adminToken: v.string(), embeddingProfileId: v.id('embeddingProfiles') },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    const profile = await ctx.db.get(args.embeddingProfileId);
    if (!profile) throw new Error('EMBEDDING_PROFILE_NOT_FOUND');
    const certificate = await latestCertificate(ctx.db, profile._id);
    return { authorizedProvider: trustedOllamaProvider(profile)?.providerId ?? null, certificate,
      trustBoundary: OLLAMA_TRUST_BOUNDARY, oldVectorsAutomaticallyCertified: false };
  },
});
