import { jest } from '@jest/globals';
import { createHash, webcrypto } from 'node:crypto';
import {
  readArchiveJson,
  validRecoveryPassphrase,
  writeArchivePart,
  writeArchiveText,
  loadLargeArchiveManifest,
  confirmedLargeArchiveSigner,
} from './archiveFiles';

describe('archive file safety', () => {
  test('rejects an oversized part before reading its content', async () => {
    const text = jest.fn(async () => '{}');
    await expect(readArchiveJson({ size: 65537, text }, 65536)).rejects.toThrow('size');
    expect(text).not.toHaveBeenCalled();
  });
  test.each(['[]', 'null', '"archive"', '{invalid'])(
    'rejects invalid archive object %s',
    async (value) => {
      await expect(
        readArchiveJson({ size: value.length, text: async () => value }, 65536),
      ).rejects.toThrow();
    },
  );
  test('preserves the unverified object for server authentication', async () => {
    await expect(
      readArchiveJson({ size: 18, text: async () => '{"signature":"x"}' }, 65536),
    ).resolves.toEqual({ signature: 'x' });
  });
  test('checks both the character minimum and UTF-8 byte maximum', () => {
    expect(validRecoveryPassphrase('12345678901')).toBe(false);
    expect(validRecoveryPassphrase('123456789012')).toBe(true);
    expect(validRecoveryPassphrase('x'.repeat(1024))).toBe(true);
    expect(validRecoveryPassphrase('x'.repeat(1025))).toBe(false);
    expect(validRecoveryPassphrase('备'.repeat(342))).toBe(false);
    expect(validRecoveryPassphrase('备'.repeat(341))).toBe(true);
  });
  test('writes encoded chunk JSON as an object file without double encoding', async () => {
    const json = '{"rows":[{"$bytes":"AA==","$float":"x"}]}';
    const stream = {
      write: jest.fn(async (_value: string) => {}),
      close: jest.fn(async () => {}),
      abort: jest.fn(async () => {}),
    };
    const directory = { getFileHandle: async () => ({ createWritable: async () => stream }) };
    await writeArchiveText(directory, 'chunk-000001.json', json);
    expect(stream.write).toHaveBeenCalledWith(json);
    expect(stream.close).toHaveBeenCalledTimes(1);
  });
  test('aborts a failed folder write and propagates the original error', async () => {
    const error = new Error('disk full');
    const stream = {
      write: jest.fn(async () => {
        throw error;
      }),
      close: jest.fn(async () => {}),
      abort: jest.fn(async () => {
        throw new Error('stream unavailable');
      }),
    };
    const directory = {
      getFileHandle: jest.fn(async () => ({ createWritable: async () => stream })),
    };
    await expect(writeArchivePart(directory, 'chunk-000001.json', { index: 1 })).rejects.toBe(
      error,
    );
    expect(stream.abort).toHaveBeenCalledTimes(1);
    expect(stream.close).not.toHaveBeenCalled();
  });
});

function rawManifest() {
  return { format: 'ai-town-chunks', version: 1, schemaVersion: 1, scope: 'town', exportId: 'source-export',
    exportedAt: 1, source: { townId: 'source-town', publicKey: 'original-public-key', fingerprint: 'sha256:original' },
    includeVectors: false, chunks: [{ index: 0, table: 'worlds', count: 0, bytes: 40, digest: 'unverified-chunk-digest' }] };
}
function derivedManifest() {
  return { signature: '', sourceSignatureValid: false,
    manifest: { format: 'ai-town-local-sanitized-chunks', version: 1, schemaVersion: 1, sourceSignatureValid: false,
      archiveId: 'derivative-export', derivedAt: 2, clearedVisits: ['selected-visit'],
      chunks: [{ ...rawManifest().chunks[0], role: 'EXPORT', encoding: 'RAW' }],
      sourceEvidence: { manifest: rawManifest(), signature: 'original-signature', publicKey: 'original-public-key',
        digest: 'unverified-original-digest', manifestStorageId: 'foreign-source-id' } },
    localProof: { format: 'ai-town-local-archive-proof', version: 1, townId: 'local-signer-town',
      publicKey: 'local-signer-key', manifestDigest: 'unverified-current-digest', signature: 'local-signature' } };
}
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));

describe('RAW manifest UI shape and signer confirmation', () => {
  test('keeps an original signed archive unchanged and does not request a local signer confirmation', async () => {
    const header = { manifest: rawManifest(), signature: 'unverified-original-signature' };
    const loaded = await loadLargeArchiveManifest(header);
    expect(loaded.archive).toBe(header);
    expect(loaded.source).toBe(header.manifest);
    expect(loaded.declaredLocalSignerFingerprint).toBeUndefined();
    expect(confirmedLargeArchiveSigner(loaded, '')).toBe(true);
    expect(confirmedLargeArchiveSigner(undefined, '')).toBe(false);
  });
  test('separates source identity from local signer and computes the backend-compatible declared fingerprint', async () => {
    const header = derivedManifest(), loaded = await loadLargeArchiveManifest(header);
    const expected = `sha256:${createHash('sha256').update(JSON.stringify(header.localProof.publicKey)).digest('base64')}`;
    expect(loaded.archive).toBe(header);
    expect(loaded.source.source.townId).toBe('source-town');
    expect(loaded.source.source.publicKey).toBe('original-public-key');
    expect(loaded.declaredLocalSignerFingerprint).toBe(expected);
    expect(confirmedLargeArchiveSigner(loaded, '')).toBe(false);
    expect(confirmedLargeArchiveSigner(loaded, 'sha256:original')).toBe(false);
    expect(confirmedLargeArchiveSigner(loaded, expected)).toBe(true);
    expect(confirmedLargeArchiveSigner(loaded, ` ${expected} `)).toBe(true);
    // Shape acceptance is not authentication: these signatures are deliberately invalid.
    expect(header.localProof.signature).toBe('local-signature');
  });
  test.each(['header', 'manifest', 'evidence', 'proof', 'source', 'descriptor'])('rejects unknown %s metadata before sending it', async where => {
    const header = derivedManifest();
    const target = where === 'header' ? header : where === 'manifest' ? header.manifest : where === 'evidence' ?
      header.manifest.sourceEvidence : where === 'proof' ? header.localProof : where === 'source' ?
        header.manifest.sourceEvidence.manifest.source : header.manifest.chunks[0];
    Object.assign(target, { unsupportedMetadata: 'unverified' });
    await expect(loadLargeArchiveManifest(header)).rejects.toThrow('unsupported metadata');
  });
  test.each(['header flag', 'manifest flag', 'source signature'])('rejects a derived archive claiming original signature authority through %s', async where => {
    const header = derivedManifest();
    if (where === 'header flag') header.sourceSignatureValid = true;
    if (where === 'manifest flag') header.manifest.sourceSignatureValid = true;
    if (where === 'source signature') header.signature = 'original-signature';
    await expect(loadLargeArchiveManifest(header)).rejects.toThrow('original source signature');
  });
  test.each(['OLD', 'SELECTIVE'])('does not expose %s chunks as RAW portable import', async kind => {
    const header = derivedManifest();
    if (kind === 'OLD') header.manifest.chunks[0].role = 'OLD';
    else header.manifest.chunks[0].encoding = 'SELECTIVE';
    await expect(loadLargeArchiveManifest(header)).rejects.toThrow(kind === 'OLD' ? 'Private rollback' : 'RAW town archives only');
  });
  test('requires the local proof and rejects a SELECTIVE original source', async () => {
    const header = derivedManifest();
    await expect(loadLargeArchiveManifest({ ...header, localProof: undefined })).rejects.toThrow('metadata is invalid');
    header.manifest.sourceEvidence.manifest.format = 'ai-town-selective-archive';
    await expect(loadLargeArchiveManifest(header)).rejects.toThrow('RAW town archives only');
  });
});
