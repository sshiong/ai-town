import { canActivateEmbeddingSpace, declaredBackupSource, vectorRecoveryReason } from './embeddingUiPolicy';
import { translate } from '../../locale';
import { gameModelMessages } from '../../locales/gameModels';

test('activation requires the exact completed live validation, not copying, coverage or an archive compatibility claim', () => {
  const space = { _id: 'target', status: 'READY', validatedAt: 1000, validationJobId: 'live-validation' };
  const validation = { _id: 'live-validation', spaceId: 'target', kind: 'VALIDATION', phase: 'DONE' };
  expect(canActivateEmbeddingSpace(space, validation, 'PENDING_VALIDATION')).toBe(true);
  for (const state of ['COPYING', 'REBUILD_REQUIRED', 'VERIFIED_COMPATIBLE'])
    expect(canActivateEmbeddingSpace(space, validation, state)).toBe(false);
  expect(canActivateEmbeddingSpace({ ...space, status: 'BUILDING' }, validation)).toBe(false);
  expect(canActivateEmbeddingSpace({ ...space, validatedAt: undefined }, validation)).toBe(false);
  expect(canActivateEmbeddingSpace(space, { ...validation, kind: 'COVERAGE' })).toBe(false);
  expect(canActivateEmbeddingSpace(space, { ...validation, phase: 'SAMPLES' })).toBe(false);
  expect(canActivateEmbeddingSpace(space, { ...validation, _id: 'previous-validation' })).toBe(false);
  expect(canActivateEmbeddingSpace(space, { ...validation, spaceId: 'other-resident-space' })).toBe(false);
  expect(canActivateEmbeddingSpace({ ...space, failure: 'SOURCE_CHANGED' }, validation)).toBe(false);
});

test('legacy and current archive source previews remain declarations and default vector export to off', () => {
  const source = { townId: 'source', fingerprint: 'sha256:key' };
  expect(declaredBackupSource({ manifest: {}, sections: { federationIdentity: [source] } })).toEqual({
    ...source, includeVectors: false });
  expect(declaredBackupSource({ manifest: { includeVectors: true }, sections: { federationIdentity: [JSON.stringify(source)] } }))
    .toEqual({ ...source, includeVectors: true });
  expect(declaredBackupSource({ manifest: {}, sections: { federationIdentity: ['malformed'] } })).toBeNull();
});

test('failed trust and unknown providers explain the actual boundary and rebuilding retained text', () => {
  expect(vectorRecoveryReason('SOURCE_KEY_WAS_NOT_LOCALLY_TRUSTED_AT_IMPORT')).toContain('cannot grant itself trust');
  expect(vectorRecoveryReason('NO_AUTHORIZED_PROVIDER_EVIDENCE')).toContain('server-authorized');
  expect(vectorRecoveryReason('VECTOR_MODEL_EVIDENCE_INCOMPATIBLE')).toContain('independently verified');
  expect(vectorRecoveryReason('EMBEDDING_COVERAGE_INCOMPLETE')).toContain('missing vectors');
  expect(vectorRecoveryReason('UNKNOWN_FAILURE')).toContain('validate before activation');
});

test('archive privacy and version fences explain rebuilding in both interface languages', () => {
  for (const reason of ['VECTOR_ARCHIVE_PRIVACY_REDACTED', 'VECTOR_ARCHIVE_REVISION_CHANGED']) {
    const message = vectorRecoveryReason(reason);
    expect(message).toContain('Rebuild');
    expect(translate('zh-CN', gameModelMessages, message)).toContain('重建');
    expect(translate('zh-CN', gameModelMessages, message)).not.toContain(reason);
    expect(translate('en', gameModelMessages, message)).toBe(message);
  }
});
