import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const MAX_DENIED_RESIDENTS = 1000;

export function validateResidentGlobalId(agentGlobalId: unknown) {
  if (typeof agentGlobalId !== 'string' || agentGlobalId.length > 300 ||
    !/^[^\s/]+\/agent:[^\s/]+$/.test(agentGlobalId)) throw new Error('INVALID_RESIDENT_GLOBAL_ID');
}

export function validateResidentPolicyPortable(table: string, fields: Record<string, any>) {
  if (!['federationResidentPolicy', 'federationResidentPolicyAudit'].includes(table)) return;
  validateResidentGlobalId(fields.agentGlobalId);
  if (!Number.isSafeInteger(fields.createdAt) || fields.createdAt < 0 ||
    table === 'federationResidentPolicy' && (!Number.isSafeInteger(fields.updatedAt) || fields.updatedAt < fields.createdAt))
    throw new Error('INVALID_RESIDENT_POLICY_TIMESTAMP');
  if (table === 'federationResidentPolicyAudit' &&
    (typeof fields.operator !== 'string' || !fields.operator.trim() || fields.operator.length > 100 ||
      typeof fields.reason !== 'string' || !fields.reason.trim() || fields.reason.length > 1000))
    throw new Error('RESIDENT_POLICY_REVIEW_DETAILS_REQUIRED');
}

export const residentPolicyTables = {
  federationResidentPolicy: defineTable({
    agentGlobalId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('agentGlobalId', ['agentGlobalId']),
  federationResidentPolicyAudit: defineTable({
    agentGlobalId: v.string(),
    operation: v.union(v.literal('DENY'), v.literal('ALLOW')),
    previousDenied: v.boolean(),
    denied: v.boolean(),
    operator: v.string(),
    authenticatedBy: v.literal('FEDERATION_ADMIN_TOKEN'),
    reason: v.string(),
    createdAt: v.number(),
  }),
};
