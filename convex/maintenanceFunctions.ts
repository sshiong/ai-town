import {
  mutation as baseMutation,
  internalMutation as baseInternalMutation,
} from './_generated/server';
import { assertTownUnlocked } from './federation/maintenanceLock';
import type { MutationCtx } from './_generated/server';

export * from './_generated/server';

type Handler = (ctx: MutationCtx, args: any) => any;
function guard(definition: Handler | { handler: Handler; [key: string]: any }) {
  const handler = typeof definition === 'function' ? definition : definition.handler;
  const guarded: Handler = async (ctx, args) => {
    await assertTownUnlocked(ctx);
    return handler(ctx, args);
  };
  return typeof definition === 'function' ? guarded : { ...definition, handler: guarded };
}

// Retain Convex's validator inference and registration metadata for every caller.
export const mutation: typeof baseMutation = ((definition: Parameters<typeof guard>[0]) =>
  baseMutation(guard(definition))) as typeof baseMutation;
export const internalMutation: typeof baseInternalMutation = ((
  definition: Parameters<typeof guard>[0],
) => baseInternalMutation(guard(definition))) as typeof baseInternalMutation;
