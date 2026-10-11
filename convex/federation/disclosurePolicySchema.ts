import { v } from 'convex/values';
import { validateResidentGlobalId } from './residentPolicySchema';

export const disclosureLevel = v.union(v.literal('PUBLIC'), v.literal('FRIEND_TOWNS'), v.literal('WHITELIST'));

export function validateDisclosurePolicy(fields: Record<string, any>) {
  if (!['PUBLIC', 'FRIEND_TOWNS', 'WHITELIST'].includes(fields.level) || !Array.isArray(fields.allowedTownIds) ||
    fields.allowedTownIds.length > 100 || new Set(fields.allowedTownIds).size !== fields.allowedTownIds.length ||
    fields.allowedTownIds.some((townId: unknown) => typeof townId !== 'string' || !townId || townId.length > 200 || /\s|\//.test(townId)))
    throw new Error('INVALID_DISCLOSURE_TOWN_WHITELIST');
}

export function validateDisclosurePolicyPortable(table: string, fields: Record<string, any>) {
  if (!['federationDisclosurePolicy', 'federationDisclosureAudit'].includes(table)) return;
  validateResidentGlobalId(fields.agentGlobalId);
  if (table === 'federationDisclosurePolicy') {
    validateDisclosurePolicy(fields);
    if (!Number.isSafeInteger(fields.updatedAt) || fields.updatedAt < 0) throw new Error('INVALID_DISCLOSURE_TIMESTAMP');
  } else {
    if (!fields.previous || !fields.next || [fields.previous, fields.next].some(policy =>
      typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key => !['level', 'allowedTownIds'].includes(key))))
      throw new Error('INVALID_DISCLOSURE_AUDIT');
    validateDisclosurePolicy(fields.previous); validateDisclosurePolicy(fields.next);
    if (!Number.isSafeInteger(fields.createdAt) || fields.createdAt < 0) throw new Error('INVALID_DISCLOSURE_TIMESTAMP');
    if (typeof fields.operator !== 'string' || !fields.operator.trim() || fields.operator.length > 100 ||
      typeof fields.reason !== 'string' || !fields.reason.trim() || fields.reason.length > 1000) throw new Error('DISCLOSURE_REVIEW_DETAILS_REQUIRED');
  }
}

export const MAX_DISCLOSURE_POLICIES = 1000;
