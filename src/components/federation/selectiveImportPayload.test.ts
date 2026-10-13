import { selectiveImportPayload, selectiveStagingComplete } from './selectiveImportPayload';
import type { LocalArchiveProof } from '../../../convex/federation/travelPrivacyLocalChunkManifest';

const proof: LocalArchiveProof = { format: 'ai-town-local-archive-proof', version: 1, townId: 'local-town',
  publicKey: 'local-key', manifestDigest: 'current-digest', signature: 'local-signature' };

test('real derived export wrapper yields only strict import authentication arguments', () => {
  const manifest = { format: 'ai-town-local-sanitized-chunks', version: 2, sourceSignatureValid: false,
    privacyChunks: [{ index: 0, table: 'travelPrivacyTombstones' }], sourceEvidence: { signature: 'original-source-signature' } };
  const exported = { manifest, signature: '', localProof: proof, sourceSignatureValid: false,
    arbitraryFutureExportField: 'never-forward-this' };
  expect(selectiveImportPayload(exported, '  sha256:trusted-local-key  ')).toEqual({ manifest, signature: '',
    localProof: proof, expectedLocalProofFingerprint: 'sha256:trusted-local-key' });
  expect(Object.keys(selectiveImportPayload(exported, 'sha256:trusted-local-key')).sort())
    .toEqual(['expectedLocalProofFingerprint', 'localProof', 'manifest', 'signature']);
});

test('original selective imports omit local proof fields and keep the original signature', () => {
  const manifest = { format: 'ai-town-selective-archive', version: 2 };
  expect(selectiveImportPayload({ manifest, signature: 'source-signature', ignored: 'extra' } as
    { manifest: unknown; signature: string }, 'sha256:stale-ui-value')).toEqual({ manifest, signature: 'source-signature' });
});


test('preflight remains closed until both data and privacy namespaces are complete', () => {
  expect(selectiveStagingComplete({ uploadedChunks: 1, chunkCount: 2, uploadedPrivacyChunks: 2, privacyChunkCount: 2 })).toBe(false);
  expect(selectiveStagingComplete({ uploadedChunks: 2, chunkCount: 2, uploadedPrivacyChunks: 1, privacyChunkCount: 2 })).toBe(false);
  expect(selectiveStagingComplete({ uploadedChunks: 2, chunkCount: 2, uploadedPrivacyChunks: 2, privacyChunkCount: 2 })).toBe(true);
  expect(selectiveStagingComplete({ uploadedChunks: 2, chunkCount: 2 })).toBe(true);
});
