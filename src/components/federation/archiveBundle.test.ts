import { jest } from '@jest/globals';
import {
  MAX_ARCHIVE_BUNDLE_BYTES, assertArchiveBundleParts, createArchiveBundleBuilder,
  decodeArchiveBundle, encodeArchiveBundle, readArchiveBundle,
} from './archiveBundle';
import { encryptedBackupFileLimit } from './backupEncryption';

const sample = () => ({ format: 'ai-town-archive-bundle' as const, version: 1 as const,
  manifest: '{ "manifest": {"format":"ai-town-chunks"}, "signature":"synthetic" }\n',
  chunks: [{ index: 0, text: '{ "index":0,"table":"worlds","rows":["quoted\\\"", "\\u4e16"] }\n' }],
  privacyChunks: [] as { index: number; text: string }[] });

describe('portable archive bundle', () => {
  test.each(['ai-town-chunks', 'ai-town-selective-archive', 'ai-town-local-sanitized-chunks'])(
    'keeps all original %s manifest and chunk text unchanged', format => {
      const bundle = sample(); bundle.manifest = ` {"manifest":{"format":"${format}"},"signature":"synthetic"}\n`;
      expect(decodeArchiveBundle(encodeArchiveBundle(bundle))).toEqual(bundle);
    },
  );

  test('preserves opaque encrypted parts without decrypting or rewriting their envelopes', () => {
    const bundle = sample();
    bundle.manifest = ' {"format":"ai-town-encrypted-backup","purpose":"manifest","ciphertext":"synthetic"}\n';
    bundle.chunks[0].text = ' {"format":"ai-town-encrypted-backup","purpose":"chunk","ciphertext":"synthetic"}\n';
    expect(decodeArchiveBundle(encodeArchiveBundle(bundle))).toEqual(bundle);
  });

  test('limits both independent chunk namespaces to the existing descriptor budget', () => {
    const bundle = sample();
    bundle.chunks = Array.from({ length: 20_001 }, (_, index) => ({ index, text: '{}' }));
    expect(() => encodeArchiveBundle(bundle)).toThrow('metadata');
    bundle.chunks = [];
    bundle.privacyChunks = Array.from({ length: 20_001 }, (_, index) => ({ index, text: '{}' }));
    expect(() => encodeArchiveBundle(bundle)).toThrow('metadata');
  });

  test('uses UTF-8 bytes for individual part limits', () => {
    const bundle = sample();
    bundle.chunks[0].text = String.fromCodePoint(0x1f600).repeat(400_000);
    expect(bundle.chunks[0].text.length).toBeLessThan(1024 * 1024);
    expect(() => encodeArchiveBundle(bundle)).toThrow('part exceeds');
  });

  test('preserves independent privacy pages and sparse derived chunk indices', () => {
    const builder = createArchiveBundleBuilder(sample().manifest);
    builder.addChunk(3, sample().chunks[0].text);
    builder.addChunk(20_000, '{"index":20000,"rows":[]}');
    builder.addPrivacyChunk(0, '{"index":0,"table":"travelPrivacyTombstones","rows":[]}');
    const bundle = decodeArchiveBundle(builder.encode());
    expect(bundle.chunks.map(entry => entry.index)).toEqual([3, 20_000]);
    expect(() => assertArchiveBundleParts(bundle, { chunks: [{ index: 3 }, { index: 20_000 }],
      privacyChunks: [{ index: 0 }] })).not.toThrow();
  });

  test.each(['root', 'part', 'missing root', 'missing part', 'version', 'format', 'manifest',
    'empty manifest', 'text', 'empty text', 'negative', 'fraction', 'unsafe', 'limit', 'array',
    'duplicate', 'unordered', 'privacy gap', 'privacy duplicate'])(
    'rejects malformed metadata: %s', kind => {
      const bundle: any = sample();
      if (kind === 'root') bundle.credentials = 'synthetic';
      if (kind === 'part') bundle.chunks[0].digest = 'synthetic';
      if (kind === 'missing root') delete bundle.privacyChunks;
      if (kind === 'missing part') delete bundle.chunks[0].text;
      if (kind === 'version') bundle.version = 2;
      if (kind === 'format') bundle.format = 'unknown';
      if (kind === 'manifest') bundle.manifest = {};
      if (kind === 'empty manifest') bundle.manifest = '';
      if (kind === 'text') bundle.chunks[0].text = {};
      if (kind === 'empty text') bundle.chunks[0].text = '';
      if (kind === 'negative') bundle.chunks[0].index = -1;
      if (kind === 'fraction') bundle.chunks[0].index = 0.5;
      if (kind === 'unsafe') bundle.chunks[0].index = Number.MAX_SAFE_INTEGER + 1;
      if (kind === 'limit') bundle.chunks[0].index = 40_000;
      if (kind === 'array') bundle.chunks = {};
      if (kind === 'duplicate') bundle.chunks.push({ ...bundle.chunks[0] });
      if (kind === 'unordered') bundle.chunks = [{ index: 1, text: '{}' }, { index: 0, text: '{}' }];
      if (kind === 'privacy gap') bundle.privacyChunks = [{ index: 1, text: '{}' }];
      if (kind === 'privacy duplicate') bundle.privacyChunks = [{ index: 0, text: '{}' }, { index: 0, text: '{}' }];
      expect(() => decodeArchiveBundle(JSON.stringify(bundle))).toThrow('metadata');
    },
  );

  test.each(['missing', 'extra', 'wrong index', 'privacy missing', 'privacy extra'])(
    'rejects bundle and manifest mismatch: %s', kind => {
      const bundle = sample();
      const expected = { chunks: [{ index: 0 }], privacyChunks: [] as { index: number }[] };
      if (kind === 'missing') expected.chunks.push({ index: 1 });
      if (kind === 'extra') expected.chunks = [];
      if (kind === 'wrong index') expected.chunks[0].index = 1;
      if (kind === 'privacy missing') expected.privacyChunks.push({ index: 0 });
      if (kind === 'privacy extra') bundle.privacyChunks.push({ index: 0, text: '{}' });
      expect(() => assertArchiveBundleParts(bundle, expected)).toThrow('match');
    },
  );

  test('checks both the claimed file size and actual UTF-8 bytes', async () => {
    const text = jest.fn(async () => '{}');
    await expect(readArchiveBundle({ size: MAX_ARCHIVE_BUNDLE_BYTES + 1, text })).rejects.toThrow('64 MiB');
    expect(text).not.toHaveBeenCalled();
    await expect(readArchiveBundle({ size: 2, text: async () => 'x'.repeat(MAX_ARCHIVE_BUNDLE_BYTES + 1) }))
      .rejects.toThrow('64 MiB');
    await expect(readArchiveBundle({ size: 2, text: async () => JSON.stringify(sample()) })).resolves.toEqual(sample());
  });

  test('bounds manifest and chunk parts independently before any decryption', () => {
    const bundle = sample();
    bundle.manifest = 'x'.repeat(encryptedBackupFileLimit(5_000_000) + 1);
    expect(() => decodeArchiveBundle(JSON.stringify(bundle))).toThrow('part exceeds');
    bundle.manifest = '{}';
    bundle.chunks[0].text = 'x'.repeat(encryptedBackupFileLimit(1024 * 1024) + 1);
    expect(() => encodeArchiveBundle(bundle)).toThrow('part exceeds');
  });

  test('counts escaped JSON bytes incrementally and leaves the accepted bundle intact on overflow', () => {
    const builder = createArchiveBundleBuilder('{}');
    // Each newline becomes two bytes in outer JSON, so plaintext character counts are insufficient.
    const chunk = '\n'.repeat(1024 * 1024);
    let accepted = 0;
    expect(() => {
      for (let index = 0; index < 100; index++) {
        builder.addChunk(index, chunk);
        accepted++;
      }
    }).toThrow('64 MiB');
    const encoded = builder.encode();
    const bytes = new TextEncoder().encode(encoded).length;
    expect(bytes).toBeLessThanOrEqual(MAX_ARCHIVE_BUNDLE_BYTES);
    expect(bytes + new TextEncoder().encode(JSON.stringify({ index: accepted, text: chunk })).length + 1)
      .toBeGreaterThan(MAX_ARCHIVE_BUNDLE_BYTES);
    expect(decodeArchiveBundle(encoded).chunks).toHaveLength(accepted);
  });

  test('builder rejects duplicate indices, privacy gaps and oversized individual parts immediately', () => {
    const builder = createArchiveBundleBuilder('{}');
    builder.addChunk(2, '{}');
    expect(() => builder.addChunk(2, '{}')).toThrow('metadata');
    expect(() => builder.addPrivacyChunk(1, '{}')).toThrow('metadata');
    expect(() => builder.addChunk(3, 'x'.repeat(encryptedBackupFileLimit(1024 * 1024) + 1))).toThrow('part exceeds');
  });
});
