import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  archiveEnvironmentBinding,
  signedArchiveRequest,
  uploadArchiveObject,
} from './coldArchiveNode';
import { mirrorKey, s3Configurations, safeArchiveError } from './coldArchivePolicy';
import { sha256, signS3Request } from './s3SigV4';

const config = {
  name: 'synthetic',
  endpoint: 'https://storage.example:9443',
  region: 'us-east-1',
  bucket: 'synthetic-bucket',
  prefix: 'private',
  accessKeyId: 'EXAMPLEACCESS',
  secretAccessKey: 'synthetic-secret-for-tests-only',
};
afterEach(() => {
  delete process.env.FEDERATION_PRIVATE_NETWORK_ALLOWLIST;
  jest.useRealTimers();
});

function socket(status = 200, body = '{}') {
  let options: any;
  const request = jest.fn<any>().mockImplementation((input: any, callback: any) => {
    options = input;
    const outgoing = new EventEmitter() as any;
    outgoing.destroy = jest.fn();
    outgoing.end = () => {
      const response = new PassThrough() as any;
      response.statusCode = status;
      response.headers = {};
      callback(response);
      if (!response.destroyed) response.end(body);
    };
    return outgoing;
  });
  return { request, options: () => options };
}

test('server configuration rejects URL credentials, traversal and malformed secrets', () => {
  expect(s3Configurations(JSON.stringify([config]))).toEqual([config]);
  for (const patch of [
    { endpoint: 'http://storage.example' },
    { endpoint: 'https://user:password@storage.example' },
    { endpoint: 'https://storage.example/path' },
    { prefix: '../outside' },
    { secretAccessKey: 'short' },
  ])
    expect(() => s3Configurations(JSON.stringify([{ ...config, ...patch }]))).toThrow(
      'INVALID_COLD_ARCHIVE_SERVER_CONFIG',
    );
  expect(() => s3Configurations(JSON.stringify([config, config]))).toThrow(
    'INVALID_COLD_ARCHIVE_SERVER_CONFIG',
  );
  expect(() => mirrorKey('private', '../unsafe', 'run', 0)).toThrow('INVALID_COLD_ARCHIVE_OBJECT');
  expect(() => mirrorKey('private', 'scope', 'run', -1)).toThrow('INVALID_COLD_ARCHIVE_OBJECT');
  expect(safeArchiveError(new Error('provider echoed secret text'))).toBe(
    'COLD_ARCHIVE_OPERATION_FAILED',
  );
});

test('signed archive requests pin checked DNS and preserve TLS identity and exact payload hash', async () => {
  const io = socket(),
    lookup = jest.fn<any>().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  const key = mirrorKey(config.prefix, 'scope', 'run', 0),
    body = '{"synthetic":true}';
  await expect(
    signedArchiveRequest(config, 'PUT', key, body, { lookup, request: io.request } as any),
  ).resolves.toEqual(Buffer.from('{}'));
  expect(io.options()).toMatchObject({
    hostname: 'storage.example',
    servername: 'storage.example',
    port: '9443',
    method: 'PUT',
    path: '/synthetic-bucket/private/ai-town/scope/run/part-0.json',
    agent: false,
    rejectUnauthorized: true,
  });
  expect(io.options().headers['x-amz-content-sha256']).toBe(sha256(body));
  expect(io.options().headers.authorization).toContain(
    'SignedHeaders=host;x-amz-content-sha256;x-amz-date',
  );
  const done = jest.fn();
  io.options().lookup('storage.example', {}, done);
  expect(done).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  const denied = jest.fn<any>().mockResolvedValue([
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  await expect(
    signedArchiveRequest(config, 'GET', key, '', { lookup: denied, request: io.request } as any),
  ).rejects.toThrow('ENDPOINT_NOT_ALLOWED');
  expect(io.request).toHaveBeenCalledTimes(1);
});

test('signed archive response size, redirects and expired DNS never bypass policy', async () => {
  const lookup = jest.fn<any>().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  for (const [io, reason] of [
    [socket(302), 'S3_HTTP_302'],
    [socket(200, 'a'.repeat(2_000_001)), 'COLD_ARCHIVE_OBJECT_TOO_LARGE'],
  ] as const)
    await expect(
      signedArchiveRequest(config, 'GET', 'key', '', { lookup, request: io.request } as any),
    ).rejects.toThrow(reason);
  const untouched = socket();
  await expect(
    signedArchiveRequest(config, 'PUT', 'key', 'a'.repeat(2_000_001), {
      lookup,
      request: untouched.request,
    } as any),
  ).rejects.toThrow('COLD_ARCHIVE_OBJECT_TOO_LARGE');
  expect(untouched.request).not.toHaveBeenCalled();
  jest.useFakeTimers();
  let resolve: (value: any) => void = () => {};
  const stalled = jest.fn<any>().mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = expect(
    signedArchiveRequest(config, 'GET', 'key', '', {
      lookup: stalled,
      request: untouched.request,
    } as any),
  ).rejects.toThrow('CONNECTION_TIMEOUT');
  await jest.advanceTimersByTimeAsync(30_000);
  await pending;
  resolve([{ address: '8.8.8.8', family: 4 }]);
  await Promise.resolve();
  expect(untouched.request).not.toHaveBeenCalled();
});

test('signature changes with exact body, object key and session credentials', () => {
  const at = new Date('2026-10-11T00:00:00Z');
  const base = signS3Request(config, 'PUT', 'part-0', '{}', '', at);
  expect(signS3Request(config, 'PUT', 'part-0', '{}', '', at).signature).toBe(base.signature);
  expect(signS3Request(config, 'PUT', 'part-1', '{}', '', at).signature).not.toBe(base.signature);
  expect(signS3Request(config, 'PUT', 'part-0', '{ }', '', at).signature).not.toBe(base.signature);
  const session = signS3Request(
    { ...config, sessionToken: 'synthetic-session' },
    'PUT',
    'part-0',
    '{}',
    '',
    at,
  );
  expect(session.headers.authorization).toContain('x-amz-security-token');
  expect(session.signature).not.toBe(base.signature);
  expect(archiveEnvironmentBinding(config)).toBe(archiveEnvironmentBinding({ ...config }));
  for (const patch of [
    { endpoint: 'https://other.example' },
    { prefix: 'other' },
    { secretAccessKey: 'rotated-synthetic-secret' },
    { sessionToken: 'new-session' },
  ])
    expect(archiveEnvironmentBinding({ ...config, ...patch })).not.toBe(
      archiveEnvironmentBinding(config),
    );
});

test('an uploaded object is accepted only after exact readback, including Unicode bytes', async () => {
  const body = JSON.stringify({ synthetic: '合成归档' });
  const lookup = jest.fn<any>().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  const valid = socket(200, body);
  await expect(
    uploadArchiveObject(config, 'part-0', body, { lookup, request: valid.request } as any),
  ).resolves.toMatchObject({ sha256: sha256(body), bytes: Buffer.byteLength(body) });
  expect(valid.request).toHaveBeenCalledTimes(2);
  const corrupt = socket(200, JSON.stringify({ synthetic: 'changed' }));
  await expect(
    uploadArchiveObject(config, 'part-0', body, { lookup, request: corrupt.request } as any),
  ).rejects.toThrow('COLD_ARCHIVE_READBACK_MISMATCH');
});
