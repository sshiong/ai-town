export const privacyCacheRevisionKey = 'travelPrivacyEmbeddingCache';

import type { DatabaseReader } from '../_generated/server';

export async function privacyTombstone(db: DatabaseReader, key: string) {
  return db
    .query('travelPrivacyTombstones')
    .withIndex('key', (q) => q.eq('key', key))
    .unique();
}
export async function isTravelRedacted(db: DatabaseReader, visitId: string) {
  return !!(await privacyTombstone(db, `visit:${visitId}`));
}
export async function assertMemoryNotRedacted(db: DatabaseReader, memoryId: string) {
  if (await privacyTombstone(db, `memory:${memoryId}`)) throw new Error('TRAVEL_PRIVACY_REDACTED');
}
export async function assertConversationNotRedacted(
  db: DatabaseReader,
  worldId: string,
  conversationId: string,
) {
  if (await privacyTombstone(db, `conversation:${worldId}:${conversationId}`))
    throw new Error('TRAVEL_PRIVACY_REDACTED');
}
export function privatePayloadSummary(payload: any) {
  const result: Record<string, string | number | boolean> = { privacyRedacted: true };
  for (const key of [
    'actionId',
    'eventId',
    'messageId',
    'federationConversationId',
    'accepted',
    'occurredAt',
    'pageNumber',
    'finalPage',
  ]) {
    const value = payload?.[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
  }
  return result;
}
export async function privacyTextHash(text: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hashKey(hash);
}
export function hashKey(hash: ArrayBuffer) {
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
