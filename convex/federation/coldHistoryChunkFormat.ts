import type { Payload } from './coldHistory';
import { digest, verifySignature } from './security';

export const COLD_CHUNK_TARGET_BYTES = 220_000;
export const COLD_CHUNK_MAX_BYTES = 480_000;
export const COLD_CHUNK_MAX_MESSAGES = 100;
export const EMPTY_COLD_CHAIN = 'sha256:empty-cold-history-v2';
export type ChunkManifest = {
  format: 'ai-town-cold-history';
  version: 2;
  schemaVersion: 1;
  sourceTownId: string;
  sourceKey: string;
  kind: 'conversation' | 'travel';
  sourceId: string;
  snapshotId: string;
  exportedAt: number;
  chunkCount: number;
  count: number;
  bytes: number;
  digest: string;
};
export type ChunkPayload = {
  format: 'ai-town-cold-history-chunk';
  version: 2;
  sourceKey: string;
  snapshotId: string;
  index: number;
  start: number;
  sourcePageNumber?: number;
  messages: Payload['messages'];
};
export type ColdChunkDescriptor = {
  index: number;
  start: number;
  count: number;
  bytes: number;
  digest: string;
  previousDigest: string;
  chainDigest: string;
};
export type PortableColdPart = {
  format: 'ai-town-cold-history-part';
  version: 2;
  manifest: ChunkManifest;
  publicKey: string;
  signature: string;
  descriptor: ColdChunkDescriptor;
  chunkSignature: string;
  payload: ChunkPayload;
};
export type PortableColdRoot = {
  format: 'ai-town-cold-history-manifest';
  version: 2;
  manifest: ChunkManifest;
  publicKey: string;
  signature: string;
};
export const coldBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
export function coldExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key));
}
export function validateColdMessages(messages: unknown, kind: 'conversation' | 'travel') {
  if (!Array.isArray(messages) || !messages.length) throw new Error('COLD_FILE_MESSAGE_INVALID');
  const ids = new Set<string>();
  for (const m of messages) {
    if (!coldExactKeys(m, ['messageId', 'text', 'authorPlayerId', 'authorGlobalId', 'occurredAt']) ||
        typeof m.messageId !== 'string' || !m.messageId || m.messageId.length > 500 || ids.has(m.messageId) ||
        typeof m.text !== 'string' || !Number.isFinite(m.occurredAt) || (m.occurredAt as number) < 0 ||
        (kind === 'conversation' && (typeof m.authorPlayerId !== 'string' || !/^p:\d+$/.test(m.authorPlayerId) || m.authorGlobalId !== undefined)) ||
        (kind === 'travel' && (typeof m.authorGlobalId !== 'string' || !m.authorGlobalId || m.authorGlobalId.length > 1000 || m.authorPlayerId !== undefined)))
      throw new Error('COLD_FILE_MESSAGE_INVALID');
    ids.add(m.messageId);
  }
}
export function validateColdSourceKey(m: { sourceKey: string; sourceId: string; kind: string }) {
  let key: unknown;
  try { key = JSON.parse(m.sourceKey); } catch { throw new Error('COLD_FILE_SOURCE_SCOPE_INVALID'); }
  if (!Array.isArray(key) || key[0] !== m.kind || typeof key[1] !== 'string' ||
      (m.kind === 'conversation' && (![3, 5].includes(key.length) || key[2] !== m.sourceId)) ||
      (m.kind === 'travel' && (![4, 6].includes(key.length) || typeof key[2] !== 'string' || key[3] !== m.sourceId)))
    throw new Error('COLD_FILE_SOURCE_SCOPE_INVALID');
}
export function chunkCertificate(sourceKey: string, snapshotId: string, descriptor: ColdChunkDescriptor) {
  return { format: 'ai-town-cold-history-chunk-certificate', version: 2, sourceKey, snapshotId, descriptor };
}
export async function describeColdChunk(payload: ChunkPayload, previousDigest: string): Promise<ColdChunkDescriptor> {
  const fields = { index: payload.index, start: payload.start, count: payload.messages.length,
    bytes: coldBytes(payload), digest: await digest(payload), previousDigest };
  return { ...fields, chainDigest: await digest(fields) };
}
export async function validateChunkRoot(manifest: ChunkManifest, signature: string, publicKey: string) {
  if (!coldExactKeys(manifest, ['format', 'version', 'schemaVersion', 'sourceTownId', 'sourceKey', 'kind', 'sourceId', 'snapshotId', 'exportedAt', 'chunkCount', 'count', 'bytes', 'digest']) ||
      manifest.format !== 'ai-town-cold-history' || manifest.version !== 2 || manifest.schemaVersion !== 1 ||
      !['conversation', 'travel'].includes(manifest.kind) || typeof manifest.sourceTownId !== 'string' || !manifest.sourceTownId ||
      typeof manifest.sourceId !== 'string' || !manifest.sourceId || typeof manifest.sourceKey !== 'string' || manifest.sourceKey.length > 2000 ||
      typeof manifest.snapshotId !== 'string' || !manifest.snapshotId || manifest.snapshotId.length > 100 || !Number.isFinite(manifest.exportedAt) || manifest.exportedAt < 0 ||
      !Number.isSafeInteger(manifest.chunkCount) || manifest.chunkCount < 1 || !Number.isSafeInteger(manifest.count) || manifest.count < manifest.chunkCount ||
      manifest.count > manifest.chunkCount * COLD_CHUNK_MAX_MESSAGES ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > manifest.chunkCount * COLD_CHUNK_MAX_BYTES || typeof manifest.digest !== 'string')
    throw new Error('COLD_FILE_MANIFEST_INVALID');
  validateColdSourceKey(manifest);
  if (typeof publicKey !== 'string' || typeof signature !== 'string' || !(await verifySignature(manifest, signature, publicKey)))
    throw new Error('COLD_FILE_INTEGRITY_FAILED');
}
export async function validateColdPart(part: PortableColdPart, expectedFingerprint: string) {
  if (coldBytes(part) > COLD_CHUNK_MAX_BYTES + 20_000) throw new Error('COLD_FILE_SIZE_LIMIT');
  if (!coldExactKeys(part, ['format', 'version', 'manifest', 'publicKey', 'signature', 'descriptor', 'chunkSignature', 'payload']) ||
      part.format !== 'ai-town-cold-history-part' || part.version !== 2)
    throw new Error('UNSUPPORTED_COLD_FILE');
  await validateChunkRoot(part.manifest, part.signature, part.publicKey);
  if (expectedFingerprint !== `sha256:${await digest(part.publicKey)}`) throw new Error('COLD_FILE_INDEPENDENT_FINGERPRINT_REQUIRED');
  const p = part.payload, d = part.descriptor, m = part.manifest;
  if (!coldExactKeys(p, ['format', 'version', 'sourceKey', 'snapshotId', 'index', 'start', 'sourcePageNumber', 'messages']) ||
      p.format !== 'ai-town-cold-history-chunk' || p.version !== 2 || p.sourceKey !== m.sourceKey || p.snapshotId !== m.snapshotId ||
      !coldExactKeys(d, ['index', 'start', 'count', 'bytes', 'digest', 'previousDigest', 'chainDigest']) ||
      !Number.isSafeInteger(d.index) || d.index < 0 || d.index >= m.chunkCount || p.index !== d.index ||
      !Number.isSafeInteger(d.start) || d.start < 0 || p.start !== d.start ||
      !Number.isSafeInteger(d.count) || d.count < 1 || d.count > COLD_CHUNK_MAX_MESSAGES || d.start + d.count > m.count ||
      !Number.isSafeInteger(d.bytes) || d.bytes < 1 || d.bytes > COLD_CHUNK_MAX_BYTES ||
      !Array.isArray(p.messages) || p.messages.length !== d.count ||
      (m.kind === 'travel' && (!Number.isSafeInteger(p.sourcePageNumber) || p.sourcePageNumber! < 0)) ||
      (m.kind === 'conversation' && p.sourcePageNumber !== undefined) ||
      typeof d.previousDigest !== 'string' || typeof d.digest !== 'string' || typeof d.chainDigest !== 'string')
    throw new Error('COLD_FILE_MANIFEST_INVALID');
  validateColdMessages(p.messages, m.kind);
  const actual = await describeColdChunk(p, d.previousDigest);
  if ((await digest(actual)) !== (await digest(d)) ||
      !(await verifySignature(chunkCertificate(m.sourceKey, m.snapshotId, d), part.chunkSignature, part.publicKey)))
    throw new Error('COLD_FILE_INTEGRITY_FAILED');
  return part;
}
export async function validateColdParts(parts: PortableColdPart[], expectedFingerprint: string) {
  if (!Array.isArray(parts) || !parts.length) throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
  const first = parts[0], m = first.manifest;
  let chain = EMPTY_COLD_CHAIN, count = 0, bytes = 0;
  const ids = new Set<string>();
  if (parts.length !== m.chunkCount) throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
  for (const [index, part] of parts.entries()) {
    await validateColdPart(part, expectedFingerprint);
    if ((await digest(part.manifest)) !== (await digest(m)) || part.publicKey !== first.publicKey || part.signature !== first.signature ||
        part.descriptor.index !== index || part.descriptor.start !== count || part.descriptor.previousDigest !== chain)
      throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
    for (const message of part.payload.messages) {
      if (ids.has(message.messageId)) throw new Error('COLD_HISTORY_EMPTY_OR_DUPLICATE_MESSAGES');
      ids.add(message.messageId);
    }
    count += part.descriptor.count; bytes += part.descriptor.bytes; chain = part.descriptor.chainDigest;
  }
  if (count !== m.count || bytes !== m.bytes || chain !== m.digest) throw new Error('COLD_HISTORY_INCOMPLETE_CHUNKS');
  return parts;
}
