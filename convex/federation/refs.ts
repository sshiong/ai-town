import { makeFunctionReference } from 'convex/server';
function path(name: string) {
  const separator = name.lastIndexOf('/');
  if (separator < 1 || separator === name.length - 1) throw new Error('INVALID_FUNCTION_REFERENCE');
  return `federation/${name.slice(0, separator)}:${name.slice(separator + 1)}`;
}
export const queryRef = (name: string) => makeFunctionReference<'query'>(path(name));
export const mutationRef = (name: string) => makeFunctionReference<'mutation'>(path(name));
export const actionRef = (name: string) => makeFunctionReference<'action'>(path(name));
