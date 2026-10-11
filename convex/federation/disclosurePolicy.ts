import { v } from 'convex/values';
import { mutation, query } from '../maintenanceFunctions';
import type { DatabaseReader } from '../_generated/server';
import { requireAdmin } from './security';
import { validateResidentGlobalId } from './residentPolicySchema';
import { disclosureLevel, validateDisclosurePolicy, MAX_DISCLOSURE_POLICIES } from './disclosurePolicySchema';

export type DisclosureLevel = 'PUBLIC' | 'FRIEND_TOWNS' | 'WHITELIST';
export type DisclosurePolicy = { level: DisclosureLevel; allowedTownIds: string[] };
type PublicPersona = { name: string; character: string; description: string };

export function disclosedVisitorProfile(persona: PublicPersona, homeTownName: string,
  host: { townId: string; trustState: string }, policy: DisclosurePolicy = { level: 'PUBLIC', allowedTownIds: [] }) {
  const disclose = policy.level === 'PUBLIC' || policy.level === 'FRIEND_TOWNS' && host.trustState === 'TRUSTED' ||
    policy.level === 'WHITELIST' && policy.allowedTownIds.includes(host.townId);
  // Only the public persona fields are eligible. Memory, model credentials,
  // system prompts and administrator notes are never copied to the Host.
  return { name: persona.name, character: persona.character, description: disclose ? persona.description : '', homeTownName };
}

export async function residentVisitorProfile(db: DatabaseReader, agentGlobalId: string, persona: PublicPersona,
  homeTownName: string, host: { townId: string; trustState: string }) {
  const policy = await db.query('federationDisclosurePolicy').withIndex('agentGlobalId', q => q.eq('agentGlobalId', agentGlobalId)).unique();
  return disclosedVisitorProfile(persona, homeTownName, host, policy ?? undefined);
}

export const status = query({ args: { adminToken: v.string() }, handler: async (ctx, args) => {
  requireAdmin(args.adminToken);
  return { policies: await ctx.db.query('federationDisclosurePolicy').take(MAX_DISCLOSURE_POLICIES), defaultLevel: 'PUBLIC' };
} });

export const set = mutation({ args: { adminToken: v.string(), agentGlobalId: v.string(), level: disclosureLevel,
  allowedTownIds: v.array(v.string()), operator: v.string(), reason: v.string() }, handler: async (ctx, args) => {
  requireAdmin(args.adminToken); validateResidentGlobalId(args.agentGlobalId);
  validateDisclosurePolicy(args);
  if (!args.operator.trim() || args.operator.length > 100 || !args.reason.trim() || args.reason.length > 1000) throw new Error('DISCLOSURE_REVIEW_DETAILS_REQUIRED');
  const local = await ctx.db.query('federationIdentity').unique();
  if (!local || !args.agentGlobalId.startsWith(`${local.townId}/agent:`)) throw new Error('RESIDENT_NOT_LOCAL');
  const previous = await ctx.db.query('federationDisclosurePolicy').withIndex('agentGlobalId', q => q.eq('agentGlobalId', args.agentGlobalId)).unique();
  const fields = { level: args.level, allowedTownIds: args.allowedTownIds, updatedAt: Date.now() };
  if (previous) await ctx.db.patch(previous._id, fields);
  else {
    if ((await ctx.db.query('federationDisclosurePolicy').take(MAX_DISCLOSURE_POLICIES)).length >= MAX_DISCLOSURE_POLICIES) throw new Error('DISCLOSURE_POLICY_CAPACITY_EXCEEDED');
    await ctx.db.insert('federationDisclosurePolicy', { agentGlobalId: args.agentGlobalId, ...fields });
  }
  await ctx.db.insert('federationDisclosureAudit', { agentGlobalId: args.agentGlobalId,
    previous: previous ? { level: previous.level, allowedTownIds: previous.allowedTownIds } : { level: 'PUBLIC', allowedTownIds: [] },
    next: { level: args.level, allowedTownIds: args.allowedTownIds }, operator: args.operator.trim(), reason: args.reason.trim(), createdAt: Date.now() });
  return fields;
} });
