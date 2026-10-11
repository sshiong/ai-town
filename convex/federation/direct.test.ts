import { jest } from '@jest/globals';
import { connectionError, directRequest, requestCandidates } from './direct';
import { normalizeEndpointCandidates, validateEndpointRecord } from './protocol';
import { validateSourceRow } from './backupLargeHelpers';

const primary = 'https://primary.example/federation/v1';
const backup = 'https://backup.example/federation/v1';
const candidates = { endpoint: primary, endpointCandidates: [{ url: primary, priority: 10 }, { url: backup, priority: 20 }] };
test('candidate bounds, normalized uniqueness, explicit priority and HTTPS policy are enforced', () => {
  expect(normalizeEndpointCandidates(primary)).toEqual([{ url: primary, priority: 10 }]);
  expect(normalizeEndpointCandidates(primary, [...candidates.endpointCandidates].reverse())).toEqual(candidates.endpointCandidates);
  expect(() => normalizeEndpointCandidates(primary, Array.from({ length: 5 }, (_, priority) => ({ url: `https://route-${priority}.example`, priority })))).toThrow('INVALID_ENDPOINT_CANDIDATES');
  expect(() => normalizeEndpointCandidates(primary, [{ url: primary, priority: 10 }, { url: 'https://primary.example', priority: 20 }])).toThrow('DUPLICATE_ENDPOINT_CANDIDATE');
  expect(() => normalizeEndpointCandidates(primary, [{ url: primary, priority: 20 }, { url: backup, priority: 10 }])).toThrow('PRIMARY_ENDPOINT_PRIORITY_REQUIRED');
  expect(() => normalizeEndpointCandidates(primary, [{ url: primary, priority: 10 }, { url: 'http://192.168.1.20', priority: 20 }])).toThrow('HTTPS required');
});

test('portable route metadata rejects inconsistent primary and invalid generations before import', () => {
  expect(() => validateEndpointRecord(candidates)).not.toThrow();
  expect(() => validateEndpointRecord({ ...candidates, endpoint: backup })).toThrow('PRIMARY_ENDPOINT_PRIORITY_REQUIRED');
  expect(() => validateEndpointRecord({ ...candidates, endpointGeneration: Number.MAX_SAFE_INTEGER })).toThrow('INVALID_ENDPOINT_GENERATION');
  expect(() => validateSourceRow('federationPeers', {
    _id: 'peer:portable', _creationTime: 1, townId: 'portable', townName: 'portable', publicKey: 'key', fingerprint: 'fingerprint',
    deploymentInstanceId: 'portable-instance', deploymentEpoch: 1, ...candidates, credentialId: '', credentialEncrypted: '', trustState: 'UNTRUSTED',
    inboundVisitsAllowed: false, outboundVisitsAllowed: false, pairedAt: 1, endpointGeneration: -1,
  })).toThrow('INVALID_ENDPOINT_GENERATION');
});

test('DNS, TLS, timeouts, HTTP status and opaque network errors retain distinct diagnoses', async () => {
  expect(connectionError(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }))).toBe('DNS_RESOLUTION_FAILED');
  expect(connectionError(new TypeError('fetch failed', { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }))).toBe('TLS_VERIFY_FAILED');
  expect(connectionError(new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } }))).toBe('CONNECTION_TIMEOUT');
  expect(connectionError(new TypeError('fetch failed'))).toBe('NETWORK_UNREACHABLE');
  const ctx = { runAction: jest.fn<any>().mockResolvedValue({ ok: true, status: 503, text: '' }) };
  await expect(directRequest(ctx as any, primary, '/health')).rejects.toThrow('FEDERATION_HTTP_503');
  ctx.runAction.mockResolvedValue({ ok: true, status: 200, text: 'not JSON' });
  await expect(directRequest(ctx as any, primary, '/health')).rejects.toThrow('INVALID_REMOTE_RESPONSE');
});

test('all requests cross the Node boundary with a bounded timeout and structured failures', async () => {
  const ctx = { runAction: jest.fn<any>().mockResolvedValue({ ok: false, error: 'CONNECTION_TIMEOUT' }) };
  await expect(directRequest(ctx as any, primary, '/health', undefined, 1000)).rejects.toThrow('CONNECTION_TIMEOUT');
  expect(ctx.runAction.mock.calls[0][1]).toEqual({ endpoint: primary, path: '/health', timeoutMs: 1000 });
  await expect(directRequest(ctx as any, primary, '/health', undefined, 999)).rejects.toThrow('INVALID_REQUEST_TIMEOUT');
});

test('only transport failures retry candidates; identity, fencing and protocol failures stop', async () => {
  for (const code of ['DNS_RESOLUTION_FAILED', 'TLS_VERIFY_FAILED', 'CONNECTION_TIMEOUT', 'NETWORK_UNREACHABLE', 'FEDERATION_HTTP_503']) {
    const request = jest.fn<(endpoint: string) => Promise<string>>().mockRejectedValueOnce(new Error(code)).mockResolvedValue('same-town');
    await expect(requestCandidates(candidates, request)).resolves.toEqual({ value: 'same-town', endpoint: backup });
    expect(request.mock.calls.map(call => call[0])).toEqual([primary, backup]);
  }
  for (const code of ['ENDPOINT_IDENTITY_UNVERIFIED', 'TOWN_ID_CONFLICT', 'PEER_NOT_TRUSTED', 'ENDPOINT_UPDATE_CONTEXT_CHANGED', 'FEDERATION_HTTP_400', 'INVALID_REMOTE_RESPONSE']) {
    const request = jest.fn<(endpoint: string) => Promise<string>>().mockRejectedValue(new Error(code));
    await expect(requestCandidates(candidates, request)).rejects.toThrow(code);
    expect(request).toHaveBeenCalledTimes(1);
  }
});
