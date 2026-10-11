import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './maintenanceFunctions';
import type { Id } from './_generated/dataModel';

// Keep the canonical writer independent of the translation service and model adapters.
export async function scheduleNewMessageTranslation(ctx: MutationCtx, messageId: Id<'messages'>) {
  const message = await ctx.db.get(messageId);
  if (!message?.worldId) return;
  const enabled = await ctx.db
    .query('messageTranslationPreferences')
    .withIndex('world_language', (q) =>
      q.eq('worldId', message.worldId!).eq('targetLanguage', 'zh-CN'),
    )
    .unique();
  if (enabled)
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('messageTranslations:enqueueNewMessage'),
      { messageId },
    );
}
