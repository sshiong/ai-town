import type { MutationCtx, QueryCtx } from '../_generated/server';
import { digest, fromBase64, verifySignature } from './security';

export const IDENTITY_KEY_PURPOSE = 'ai-town-identity-key-rotation/1';
export type IdentityKeyDeclaration = {
  purpose: typeof IDENTITY_KEY_PURPOSE;
  rotationId: string;
  townId: string;
  oldPublicKey: string;
  newPublicKey: string;
  oldVersion: number;
  newVersion: number;
  deploymentInstanceId: string;
  deploymentEpoch: number;
  issuedAt: number;
  activateBy: number;
  operator: string;
  reason: string;
};
export type IdentityKeyCertificate = {
  body: IdentityKeyDeclaration;
  oldSignature: string;
  newSignature: string;
};
export type IdentityKeyActivation = {
  body: {
    purpose: 'ai-town-identity-key-activation/1';
    rotationId: string;
    certificateDigest: string;
    activatedAt: number;
  };
  oldSignature: string;
  newSignature: string;
};
const bounded = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
export async function validateKeyCertificate(value: IdentityKeyCertificate) {
  const b = value?.body;
  if (
    !b ||
    b.purpose !== IDENTITY_KEY_PURPOSE ||
    !bounded(b.rotationId) ||
    !bounded(b.townId) ||
    !bounded(b.deploymentInstanceId) ||
    !bounded(b.operator, 100) ||
    !bounded(b.reason, 1000) ||
    !bounded(b.oldPublicKey) ||
    !bounded(b.newPublicKey) ||
    b.oldPublicKey === b.newPublicKey ||
    !Number.isSafeInteger(b.oldVersion) ||
    b.oldVersion < 1 ||
    !Number.isSafeInteger(b.newVersion) ||
    b.newVersion !== b.oldVersion + 1 ||
    !Number.isSafeInteger(b.deploymentEpoch) ||
    b.deploymentEpoch < 1 ||
    !Number.isSafeInteger(b.issuedAt) ||
    b.issuedAt < 0 ||
    b.issuedAt > Date.now() + 30_000 ||
    !Number.isSafeInteger(b.activateBy) ||
    b.activateBy - b.issuedAt < 60_000 ||
    b.activateBy - b.issuedAt > 30 * 60_000 ||
    typeof value.oldSignature !== 'string' ||
    typeof value.newSignature !== 'string'
  )
    throw new Error('INVALID_IDENTITY_KEY_CERTIFICATE');
  try {
    if (fromBase64(b.oldPublicKey).length !== 32 || fromBase64(b.newPublicKey).length !== 32)
      throw new Error('INVALID_IDENTITY_KEY_CERTIFICATE');
  } catch {
    throw new Error('INVALID_IDENTITY_KEY_CERTIFICATE');
  }
  if (
    !(await verifySignature(b, value.oldSignature, b.oldPublicKey)) ||
    !(await verifySignature(b, value.newSignature, b.newPublicKey))
  )
    throw new Error('INVALID_IDENTITY_KEY_CERTIFICATE');
  return b;
}
export async function validateKeyActivation(
  certificate: IdentityKeyCertificate,
  activation: IdentityKeyActivation,
) {
  const b = await validateKeyCertificate(certificate),
    a = activation?.body;
  if (
    !a ||
    a.purpose !== 'ai-town-identity-key-activation/1' ||
    a.rotationId !== b.rotationId ||
    a.certificateDigest !== (await digest(certificate)) ||
    !Number.isSafeInteger(a.activatedAt) ||
    a.activatedAt < b.issuedAt ||
    a.activatedAt > b.activateBy ||
    a.activatedAt > Date.now() + 30_000 ||
    !(await verifySignature(a, activation.oldSignature, b.oldPublicKey)) ||
    !(await verifySignature(a, activation.newSignature, b.newPublicKey))
  )
    throw new Error('INVALID_IDENTITY_KEY_ACTIVATION');
  return b;
}

// Only immutable historical evidence may use this path. Normal packet
// authentication continues to verify the one current peer identity key.
export async function verifiedIdentityKeySuccessor(
  ctx: QueryCtx | MutationCtx,
  townId: string,
  oldPublicKey: string,
  currentPublicKey: string,
) {
  if (oldPublicKey === currentPublicKey) return true;
  const records = await ctx.db
    .query('federationIdentityKeyHistory')
    .withIndex('town_version', (q) => q.eq('townId', townId))
    .collect();
  const seen = new Set<string>();
  let key = oldPublicKey;
  while (key !== currentPublicKey) {
    if (seen.has(key)) return false;
    seen.add(key);
    const candidates = records.filter(
      (r) => r.verified && r.kind === 'SIGNED' && r.oldPublicKey === key,
    );
    if (candidates.length !== 1) return false;
    const row = candidates[0];
    try {
      const b = await validateKeyActivation(row.certificate, row.activation);
      if (
        b.townId !== townId ||
        b.oldPublicKey !== key ||
        b.newPublicKey !== row.newPublicKey ||
        b.oldVersion !== row.oldVersion ||
        b.newVersion !== row.newVersion ||
        b.rotationId !== row.rotationId
      )
        return false;
      key = b.newPublicKey;
    } catch {
      return false;
    }
  }
  return true;
}
