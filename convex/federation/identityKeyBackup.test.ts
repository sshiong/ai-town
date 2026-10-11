import { dataTables, restoredAutonomyFields } from './backupHelpers';
import { largeTables } from './backupLargeHelpers';
import { validateSourceRow } from './backupLargeHelpers';

test('ordinary and chunked exports contain public identity history, excluding private rotation state', () => {
  for (const tables of [dataTables, largeTables]) {
    expect(tables).toContain('federationIdentityKeyHistory');
    expect(tables).not.toContain('federationIdentityKeyRotations');
    expect(tables).not.toContain('federationIdentityKeyExchanges');
    expect(tables).not.toContain('federationCredentialRotations');
  }
});

test('chunked identity preflight accepts legacy versions and rejects malformed versions before any writes', () => {
  const row = {
    _id: 'source-identity',
    _creationTime: 1,
    townId: 'town:source',
    townName: 'Source',
    publicKey: 'public',
    fingerprint: 'fingerprint',
    deploymentInstanceId: 'source-instance',
    deploymentEpoch: 1,
    endpoint: 'https://source.example/federation/v1',
    enabled: false,
    allowIncomingPairRequests: false,
    allowUnencryptedHttp: false,
    allowPublicHttp: false,
    maxVisitors: 1,
    maxVisitDurationMs: 300000,
    mode: 'ACTIVE',
    createdAt: 1,
  };
  expect(() => validateSourceRow('federationIdentity', row)).not.toThrow();
  expect(() =>
    validateSourceRow('federationIdentity', { ...row, identityVersion: 2 }),
  ).not.toThrow();
  for (const identityVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => validateSourceRow('federationIdentity', { ...row, identityVersion })).toThrow(
      'INVALID_IDENTITY_VERSION',
    );
});

test('imported signed and manual identity histories remain immutable provenance without live trust', () => {
  for (const kind of ['SIGNED', 'MANUAL']) {
    const certificate = {
      body: { townId: 'source-town', newVersion: 2 },
      oldSignature: 'old',
      newSignature: 'new',
    };
    const activation = {
      body: { rotationId: 'rotation' },
      oldSignature: 'old',
      newSignature: 'new',
    };
    const row = { townId: 'source-town', kind, verified: true, certificate, activation };
    expect(restoredAutonomyFields('federationIdentityKeyHistory', row)).toEqual({
      ...row,
      verified: false,
    });
    expect(row.verified).toBe(true);
  }
});
