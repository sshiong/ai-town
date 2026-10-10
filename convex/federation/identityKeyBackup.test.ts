import { dataTables, restoredAutonomyFields } from './backupHelpers';
import { largeTables } from './backupLargeHelpers';

test('ordinary and chunked exports contain public identity history, excluding private rotation state', () => {
  for (const tables of [dataTables, largeTables]) {
    expect(tables).toContain('federationIdentityKeyHistory');
    expect(tables).not.toContain('federationIdentityKeyRotations');
    expect(tables).not.toContain('federationIdentityKeyExchanges');
    expect(tables).not.toContain('federationCredentialRotations');
  }
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
