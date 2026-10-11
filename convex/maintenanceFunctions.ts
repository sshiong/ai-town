import {
  mutation as baseMutation,
  internalMutation as baseInternalMutation,
} from './_generated/server';
import { withEmbeddingRevision } from './models/embeddingDataRevision';
import { assertTownUnlocked } from './federation/maintenanceLock';
import type { MutationCtx } from './_generated/server';

export * from './_generated/server';

type Handler = (ctx: MutationCtx, args: any) => any;
function guard(definition: Handler | { handler: Handler; [key: string]: any }) {
  const handler = typeof definition === 'function' ? definition : definition.handler;
  const guarded: Handler = async (ctx, args) => {
    await assertTownUnlocked(ctx);
    return handler(withEmbeddingRevision(ctx), args);
  };
  return typeof definition === 'function' ? guarded : { ...definition, handler: guarded };
}

// Retain Convex's validator inference and registration metadata for every caller.
export const mutation: typeof baseMutation = ((definition: Parameters<typeof guard>[0]) =>
  baseMutation(guard(definition))) as typeof baseMutation;
export const internalMutation: typeof baseInternalMutation = ((
  definition: Parameters<typeof guard>[0],
) => baseInternalMutation(guard(definition))) as typeof baseInternalMutation;

function tracked(definition: Handler | { handler: Handler; [key: string]: any }) {
  const handler = typeof definition === 'function' ? definition : definition.handler;
  const wrapped: Handler = (ctx, args) => handler(withEmbeddingRevision(ctx), args);
  return typeof definition === 'function' ? wrapped : { ...definition, handler: wrapped };
}
// Maintenance jobs own their locks and therefore bypass only the lock guard, not the data fence.
export const trackedMutation: typeof baseMutation = ((definition: Parameters<typeof tracked>[0]) =>
  baseMutation(tracked(definition))) as typeof baseMutation;
export const trackedInternalMutation: typeof baseInternalMutation = ((definition: Parameters<typeof tracked>[0]) =>
  baseInternalMutation(tracked(definition))) as typeof baseInternalMutation;
