import { v } from 'convex/values';
import { mutation } from '../maintenanceFunctions';
import { assertFederationAdmin } from '../federation/auth';
import { audit, settings } from './profiles';

const fields = { adminToken: v.string(), profileId: v.union(v.id('chatProfiles'), v.id('embeddingProfiles')), reason: v.string() };
export const setEnabled = mutation({
  args: { ...fields, enabled: v.boolean(), affectedBindingIds: v.array(v.id('residentModelBindings')) },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    if (!args.reason.trim() || args.reason.length > 1000) throw new Error('AUDIT_REASON_REQUIRED');
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error('MODEL_PROFILE_NOT_FOUND');
    const config = await settings(ctx);
    if (!args.enabled) {
      if (config?.mainChatProfileId === profile._id) throw new Error('CHANGE_MAIN_BEFORE_DISABLING_PROFILE');
      if ('stopWords' in profile) {
        const bindings = (await ctx.db.query('residentModelBindings').collect()).filter(row => row.chatProfileId === profile._id);
        if (bindings.map(row => row._id).sort().join() !== [...args.affectedBindingIds].sort().join())
          throw new Error('REVIEW_AFFECTED_RESIDENTS_AGAIN');
      } else {
        const spaces = (await ctx.db.query('embeddingSpaces').collect()).filter(row => row.profileId === profile._id);
        if (spaces.some(space => space._id === config?.activeEmbeddingSpaceId || space.status === 'ACTIVE' || space.status === 'BUILDING'))
          throw new Error('EMBEDDING_PROFILE_ACTIVE_OR_BUILDING');
      }
    }
    await ctx.db.patch(profile._id, { disabled: !args.enabled });
    await audit(ctx, args.enabled ? 'ENABLE_MODEL_PROFILE' : 'DISABLE_MODEL_PROFILE', profile._id,
      args.enabled ? 'ENABLED' : 'DISABLED', args.reason, profile.disabled ? 'DISABLED' : 'ENABLED');
  },
});
export const remove = mutation({
  args: fields,
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    if (!args.reason.trim() || args.reason.length > 1000) throw new Error('AUDIT_REASON_REQUIRED');
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error('MODEL_PROFILE_NOT_FOUND');
    if ((await settings(ctx))?.mainChatProfileId === profile._id) throw new Error('CHANGE_MAIN_BEFORE_DELETING_PROFILE');
    if ('stopWords' in profile) {
      if ((await ctx.db.query('residentModelBindings').collect()).some(row => row.chatProfileId === profile._id))
        throw new Error('CHAT_PROFILE_REFERENCED_BY_RESIDENTS');
    } else if ((await ctx.db.query('embeddingSpaces').collect()).some(row => row.profileId === profile._id))
      throw new Error('EMBEDDING_PROFILE_REFERENCED_BY_SPACES');
    // Ongoing provider requests retain their captured configuration. Deletion
    // cannot route their private context to another supplier.
    await ctx.db.delete(profile._id);
    await audit(ctx, 'DELETE_MODEL_PROFILE', profile._id, 'DELETED', args.reason, profile.name);
  },
});
