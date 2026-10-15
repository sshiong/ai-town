import { encryptedBackupFileLimit } from './backupEncryption';

export const MAX_ARCHIVE_BUNDLE_BYTES = 64 * 1024 * 1024;
const maxChunks = 20_000;
const maxChunkIndex = 2 * maxChunks;
const encoder = new TextEncoder();
const invalid = 'The archive bundle metadata is invalid or unsupported.';
const oversized = 'The archive bundle exceeds 64 MiB. Use the manifest and separate chunks instead.';
const partOversized = 'An archive bundle part exceeds its supported size limit.';
const mismatch = 'The archive bundle parts do not match the manifest.';

type BundlePart = { index: number; text: string };
export type ArchiveBundle = {
  format: 'ai-town-archive-bundle';
  version: 1;
  manifest: string;
  chunks: BundlePart[];
  privacyChunks: BundlePart[];
};

function record(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)))
    throw new Error(invalid);
  return value as Record<string, unknown>;
}

function partText(value: unknown, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || !value.length) throw new Error(invalid);
  if (encoder.encode(value).length > encryptedBackupFileLimit(maxBytes)) throw new Error(partOversized);
}

function part(value: unknown, previous: number, privacy: boolean): BundlePart {
  const entry = record(value, ['index', 'text']);
  if (!Number.isSafeInteger(entry.index) || Number(entry.index) < 0 ||
    Number(entry.index) >= (privacy ? maxChunks : maxChunkIndex) ||
    (privacy ? entry.index !== previous + 1 : Number(entry.index) <= previous)) throw new Error(invalid);
  partText(entry.text, 1024 * 1024);
  return entry as BundlePart;
}

function validate(value: unknown): ArchiveBundle {
  const bundle = record(value, ['format', 'version', 'manifest', 'chunks', 'privacyChunks']);
  if (bundle.format !== 'ai-town-archive-bundle' || bundle.version !== 1 ||
    !Array.isArray(bundle.chunks) || !Array.isArray(bundle.privacyChunks) ||
    bundle.chunks.length > maxChunks || bundle.privacyChunks.length > maxChunks) throw new Error(invalid);
  partText(bundle.manifest, 5_000_000);
  for (const [entries, privacy] of [[bundle.chunks, false], [bundle.privacyChunks, true]] as const) {
    let previous = -1;
    for (const entry of entries) previous = part(entry, previous, privacy).index;
  }
  return bundle as ArchiveBundle;
}

/** The container preserves each original plain or encrypted part verbatim. It authenticates no content. */
export function decodeArchiveBundle(text: string): ArchiveBundle {
  if (encoder.encode(text).length > MAX_ARCHIVE_BUNDLE_BYTES) throw new Error(oversized);
  return validate(JSON.parse(text));
}

export async function readArchiveBundle(file: Pick<File, 'size' | 'text'>): Promise<ArchiveBundle> {
  if (!Number.isSafeInteger(file.size) || file.size < 1) throw new Error(invalid);
  if (file.size > MAX_ARCHIVE_BUNDLE_BYTES) throw new Error(oversized);
  return decodeArchiveBundle(await file.text());
}

export function encodeArchiveBundle(bundle: ArchiveBundle): string {
  validate(bundle);
  const text = JSON.stringify(bundle);
  if (encoder.encode(text).length > MAX_ARCHIVE_BUNDLE_BYTES) throw new Error(oversized);
  return text;
}

/** Call after the existing manifest loader, and retain all existing server validation. */
export function assertArchiveBundleParts(bundle: ArchiveBundle, descriptors: {
  chunks: readonly { index: number }[];
  privacyChunks?: readonly { index: number }[];
}) {
  for (const [parts, expected] of [
    [bundle.chunks, descriptors.chunks], [bundle.privacyChunks, descriptors.privacyChunks ?? []],
  ] as const) {
    if (parts.length !== expected.length || parts.some((entry, i) => entry.index !== expected[i].index))
      throw new Error(mismatch);
  }
}

/** Account for JSON escaping on every append, before fetching another remote part. */
export function createArchiveBundleBuilder(manifest: string) {
  const bundle: ArchiveBundle = { format: 'ai-town-archive-bundle', version: 1, manifest, chunks: [], privacyChunks: [] };
  let bytes = encoder.encode(encodeArchiveBundle(bundle)).length;
  function append(index: number, text: string, privacy: boolean) {
    const entries = privacy ? bundle.privacyChunks : bundle.chunks;
    if (entries.length >= maxChunks) throw new Error(invalid);
    const entry = part({ index, text }, entries.at(-1)?.index ?? -1, privacy);
    const added = encoder.encode(JSON.stringify(entry)).length + (entries.length ? 1 : 0);
    if (bytes + added > MAX_ARCHIVE_BUNDLE_BYTES) throw new Error(oversized);
    entries.push(entry);
    bytes += added;
  }
  return {
    addChunk: (index: number, text: string) => append(index, text, false),
    addPrivacyChunk: (index: number, text: string) => append(index, text, true),
    encode: () => JSON.stringify(bundle),
  };
}
