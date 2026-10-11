import { jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { serverTlsTrust } from './serverTlsTrust';
import { pinnedHttpsRequest } from './nodeNetworkRequest';
import { uploadArchiveObject } from './coldArchiveNode';

const originalCa = process.env.FEDERATION_EXTRA_CA_CERTS_PEM;
let directory: string, ca: string, privateKey: string;
let server: ReturnType<typeof createServer>, port: number;
let storedBody = '',
  acceptedRequests = 0;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ai-town-server-tls-trust-'));
  const path = (name: string) => join(directory, name);
  const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path('ca-key.pem'),
    '-out',
    path('ca.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=Synthetic test CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ]);
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path('server-key.pem'),
    '-out',
    path('server.csr'),
    '-subj',
    '/CN=town.example',
  ]);
  writeFileSync(
    path('server.ext'),
    'subjectAltName=DNS:town.example\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n',
  );
  openssl([
    'x509',
    '-req',
    '-in',
    path('server.csr'),
    '-CA',
    path('ca.pem'),
    '-CAkey',
    path('ca-key.pem'),
    '-CAcreateserial',
    '-out',
    path('server.pem'),
    '-days',
    '1',
    '-extfile',
    path('server.ext'),
  ]);
  ca = readFileSync(path('ca.pem'), 'utf8');
  privateKey = readFileSync(path('server-key.pem'), 'utf8');
  server = createServer(
    { key: privateKey, cert: readFileSync(path('server.pem')) },
    (incoming, response) => {
      acceptedRequests++;
      if (incoming.method === 'PUT') {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          storedBody = Buffer.concat(chunks).toString('utf8');
          response.end();
        });
      } else response.end(incoming.url === '/federation/v1/health' ? '{}' : storedBody);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as { port: number }).port;
}, 15000);

beforeEach(() => {
  delete process.env.FEDERATION_EXTRA_CA_CERTS_PEM;
  storedBody = '';
  acceptedRequests = 0;
});
afterEach(() => {
  if (originalCa === undefined) delete process.env.FEDERATION_EXTRA_CA_CERTS_PEM;
  else process.env.FEDERATION_EXTRA_CA_CERTS_PEM = originalCa;
});
afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('no extra CA leaves default Node trust unchanged; configured trust retains every default root', () => {
  expect(serverTlsTrust()).toEqual({});
  process.env.FEDERATION_EXTRA_CA_CERTS_PEM = ca;
  const configured = serverTlsTrust().ca as string[];
  expect(rootCertificates.every((root) => configured.includes(root))).toBe(true);
  expect(configured.at(-1)).toBe(ca.trim());
  process.env.FEDERATION_EXTRA_CA_CERTS_PEM = `${ca}\n${rootCertificates[0]}`;
  expect((serverTlsTrust().ca as string[]).length).toBe(rootCertificates.length + 2);
});

test('invalid PEM, private keys, trailing data and oversized bytes fail with fixed errors', () => {
  for (const invalid of [
    'not a certificate',
    ' ',
    privateKey,
    `${ca}unexpected data`,
    '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----',
  ]) {
    process.env.FEDERATION_EXTRA_CA_CERTS_PEM = invalid;
    expect(() => serverTlsTrust()).toThrow('TLS_INVALID_EXTRA_CA_CERTS');
  }
  process.env.FEDERATION_EXTRA_CA_CERTS_PEM = 'x'.repeat(65_537);
  expect(() => serverTlsTrust()).toThrow('TLS_EXTRA_CA_CERTS_TOO_LARGE');
  process.env.FEDERATION_EXTRA_CA_CERTS_PEM = '\u00e9'.repeat(32_769);
  expect(() => serverTlsTrust()).toThrow('TLS_EXTRA_CA_CERTS_TOO_LARGE');
});

// Test-only routing sends the policy-checked public address to our local listener.
// All production CA, certificate identity, Host and signature options stay intact.
function socketDependencies() {
  const checked: string[] = [];
  const lookup = jest.fn<any>().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  type LookupCallback = (
    error: NodeJS.ErrnoException | null,
    address: string,
    family: number,
  ) => void;
  type SocketLookup = (host: string, options: unknown, callback: LookupCallback) => void;
  const route = ((options: RequestOptions, callback?: (response: IncomingMessage) => void) =>
    request(
      {
        ...options,
        lookup: ((host: string, opts: unknown, done: LookupCallback) =>
          (options.lookup as SocketLookup)(host, opts, (error, address, family) => {
            checked.push(address);
            done(error, '127.0.0.1', family);
          })) as RequestOptions['lookup'],
      },
      callback,
    )) as typeof request;
  return { dependencies: { lookup, request: route }, checked, lookup };
}

test('both real HTTPS paths trust the configured CA and still reject SAN mismatch and unknown CA', async () => {
  const io = socketDependencies();
  const input = { endpoint: `https://town.example:${port}`, path: '/health', timeoutMs: 3000 };
  const archiveConfig = {
    name: 'synthetic',
    endpoint: input.endpoint,
    region: 'us-east-1',
    bucket: 'synthetic-bucket',
    prefix: 'test',
    accessKeyId: 'EXAMPLEACCESS',
    secretAccessKey: 'synthetic-secret-for-tests-only',
  };
  process.env.FEDERATION_EXTRA_CA_CERTS_PEM = ca;
  await expect(pinnedHttpsRequest(input, io.dependencies)).resolves.toEqual({
    status: 200,
    text: '{}',
  });
  const body = JSON.stringify({ synthetic: 'real TLS socket readback' });
  await expect(
    uploadArchiveObject(archiveConfig, 'synthetic-root', body, io.dependencies),
  ).resolves.toMatchObject({ bytes: Buffer.byteLength(body) });
  expect(acceptedRequests).toBe(3);
  await expect(
    pinnedHttpsRequest({ ...input, endpoint: `https://wrong.example:${port}` }, io.dependencies),
  ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  await expect(
    uploadArchiveObject(
      { ...archiveConfig, endpoint: `https://wrong.example:${port}` },
      'synthetic-root',
      body,
      io.dependencies,
    ),
  ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  process.env.FEDERATION_EXTRA_CA_CERTS_PEM = rootCertificates[0];
  await expect(pinnedHttpsRequest(input, io.dependencies)).rejects.toMatchObject({
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  });
  await expect(
    uploadArchiveObject(archiveConfig, 'synthetic-root', body, io.dependencies),
  ).rejects.toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
  delete process.env.FEDERATION_EXTRA_CA_CERTS_PEM;
  await expect(pinnedHttpsRequest(input, io.dependencies)).rejects.toMatchObject({
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  });
  expect(acceptedRequests).toBe(3);
  expect(io.checked).toEqual(Array(8).fill('8.8.8.8'));
  expect(io.lookup).toHaveBeenCalledTimes(8);
});
