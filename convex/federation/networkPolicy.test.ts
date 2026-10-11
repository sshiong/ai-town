import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { addressPolicy, assertDestinationAddresses, parseAddress, privateNetworkAllowlist, sourceNetworkKeys } from './networkPolicy';
import { pinnedHttpsRequest } from './nodeNetworkRequest';

afterEach(() => { delete process.env.FEDERATION_PRIVATE_NETWORK_ALLOWLIST; jest.useRealTimers(); });

test('dangerous destinations, IP aliases, metadata and IPv6 transition routes cannot be authorized', () => {
  for (const address of ['127.2.3.4', '0.3.4.5', '169.254.169.254', '::1', '::', 'fe80::1', 'ff02::1',
    '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2002:7f00:1::', '100.100.100.200', 'fd00:ec2::254',
    '2001:2::1', '2001:10::1', '2001:db8::1', '3fff:fff::1', 'fd20:ce::254']) {
    expect(addressPolicy(address)).toBe('forbidden');
    expect(() => assertDestinationAddresses([address], ['10.0.0.0/8', '100.64.0.0/10', 'fc00::/7'])).toThrow('ENDPOINT_NOT_ALLOWED');
  }
  for (const invalid of ['127.0.0.1/32', '169.254.0.0/16', '0.0.0.0/0', '8.8.8.8/32', '10.0.0.0/7', 'fc00::/6'])
    expect(() => privateNetworkAllowlist(invalid)).toThrow('INVALID_PRIVATE_NETWORK_ALLOWLIST');
});

test('LAN, CGNAT VPN and IPv6 ULA require explicit narrow authorization without blocking public hosts', () => {
  const allowed = privateNetworkAllowlist('192.168.4.0/24,100.100.0.0/16,fd12:3456::/48');
  expect(() => assertDestinationAddresses(['192.168.4.9', '100.100.1.2', 'fd12:3456::9', '8.8.8.8', '2606:4700::1111'], allowed)).not.toThrow();
  expect(() => assertDestinationAddresses(['192.168.5.9'], allowed)).toThrow('PRIVATE_ENDPOINT_NOT_AUTHORIZED');
  expect(() => assertDestinationAddresses(['8.8.8.8', '127.0.0.1'], allowed)).toThrow('ENDPOINT_NOT_ALLOWED');
  expect(sourceNetworkKeys('::ffff:8.8.8.8')).toEqual(sourceNetworkKeys('8.8.8.8'));
  expect(sourceNetworkKeys('2001:4860::1')[1]).toEqual(sourceNetworkKeys('2001:4860::ff')[1]);
  expect(parseAddress('010.0.0.1')).toBeUndefined();
});

function fakeRequest(status = 200, body = '{}') {
  let options: any;
  const request = jest.fn<any>().mockImplementation((input: any, callback: any) => {
    options = input;
    const outgoing = new EventEmitter() as any;
    outgoing.destroy = jest.fn();
    outgoing.end = () => {
      const response = new PassThrough() as any;
      response.statusCode = status; response.headers = {};
      callback(response);
      if (!response.destroyed) response.end(body);
    };
    return outgoing;
  });
  return { request, options: () => options };
}

test('DNS is checked on each request and the TLS socket lookup uses only the checked answer', async () => {
  const socket = fakeRequest();
  const lookup = jest.fn<any>().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  const input = { endpoint: 'https://town.example:9443', path: '/health', timeoutMs: 1000 };
  await expect(pinnedHttpsRequest(input, { lookup, request: socket.request } as any)).resolves.toEqual({ status: 200, text: '{}' });
  expect(socket.options()).toMatchObject({ hostname: 'town.example', servername: 'town.example', port: '9443', rejectUnauthorized: true, agent: false, family: 4 });
  const callback = jest.fn(); socket.options().lookup('town.example', {}, callback);
  expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  await expect(pinnedHttpsRequest(input, { lookup, request: socket.request } as any)).rejects.toThrow('ENDPOINT_NOT_ALLOWED');
  expect(socket.request).toHaveBeenCalledTimes(1);
});

test('explicit IPv6 VPN literal keeps IPv6 TLS identity and skips DNS; redirects and oversized replies stop', async () => {
  process.env.FEDERATION_PRIVATE_NETWORK_ALLOWLIST = 'fd12:3456::/48';
  const socket = fakeRequest(302), lookup = jest.fn<any>();
  await expect(pinnedHttpsRequest({ endpoint: 'https://[fd12:3456::9]:9443', path: '/health', timeoutMs: 1000 }, { lookup, request: socket.request } as any))
    .resolves.toEqual({ status: 302, text: '' });
  expect(lookup).not.toHaveBeenCalled();
  expect(socket.options()).toMatchObject({ hostname: 'fd12:3456::9', rejectUnauthorized: true, family: 6 });
  expect(socket.options().servername).toBeUndefined();
  const oversized = fakeRequest(200, 'a'.repeat(65537));
  await expect(pinnedHttpsRequest({ endpoint: 'https://8.8.8.8', path: '/health', timeoutMs: 1000 }, { lookup, request: oversized.request } as any))
    .rejects.toThrow('MESSAGE_TOO_LARGE');
});

test('DNS timeout never connects after the resolver eventually returns', async () => {
  jest.useFakeTimers();
  let resolve: (value: any) => void = () => {};
  const lookup = jest.fn<any>().mockImplementation(() => new Promise(done => { resolve = done; }));
  const socket = fakeRequest();
  const pending = expect(pinnedHttpsRequest({ endpoint: 'https://town.example', path: '/health', timeoutMs: 1000 }, { lookup, request: socket.request } as any))
    .rejects.toThrow('CONNECTION_TIMEOUT');
  await jest.advanceTimersByTimeAsync(1000); await pending;
  resolve([{ address: '8.8.8.8', family: 4 }]); await Promise.resolve();
  expect(socket.request).not.toHaveBeenCalled();
});

test('slow response bodies share the original request deadline and destroy the active request', async () => {
  jest.useFakeTimers();
  const outgoing = new EventEmitter() as any;
  outgoing.end = jest.fn(); outgoing.destroy = jest.fn();
  let respond: (response: any) => void = () => {};
  const request = jest.fn<any>().mockImplementation((_options: any, callback: any) => { respond = callback; return outgoing; });
  const lookup = jest.fn<any>().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  const pending = expect(pinnedHttpsRequest({ endpoint: 'https://town.example', path: '/health', timeoutMs: 1000 }, { lookup, request } as any))
    .rejects.toThrow('CONNECTION_TIMEOUT');
  await jest.advanceTimersByTimeAsync(900);
  const response = new PassThrough() as any;
  response.statusCode = 200; response.headers = {};
  respond(response); response.write('{');
  await jest.advanceTimersByTimeAsync(100); await pending;
  expect(outgoing.destroy).toHaveBeenCalledTimes(1);
  response.end('}');
});

test('the pinned request preserves hostname TLS verification over a real socket with test-only local routing', async () => {
  const { createServer, request } = await import('node:https');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const childProcess = await import('node:child_process');
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'ai-town-pinned-tls-test-'));
  const keyPath = nodePath.join(dir, 'key.pem'), certPath = nodePath.join(dir, 'cert.pem');
  let server: ReturnType<typeof createServer> | undefined;
  try {
    childProcess.execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=town.example', '-addext', 'subjectAltName=DNS:town.example'], { stdio: 'ignore' });
    const cert = readFileSync(certPath);
    const received: { host?: string; servername: string | false; path?: string }[] = [];
    let redirect = false;
    server = createServer({ key: readFileSync(keyPath), cert }, (req, response) => {
      received.push({ host: req.headers.host, servername: (req.socket as import('node:tls').TLSSocket & { servername: string | false }).servername, path: req.url });
      response.writeHead(redirect ? 302 : 200, { 'Content-Type': 'application/json', ...(redirect ? { Location: 'https://another.example' } : {}) });
      response.end('{}');
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    const checked: string[] = [], lookup = jest.fn<any>().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    // Only the test client maps the checked address to a local listener and
    // adds its ephemeral CA. Production retains the checked address and system CA.
    const localRoutingRequest = (ca?: Buffer) => ((options: any, callback: any) => request({ ...options, ca,
      lookup: (host: string, opts: unknown, done: any) => options.lookup(host, opts, (error: Error | null, address: string, family: number) => {
        checked.push(address); done(error, '127.0.0.1', family);
      }),
    }, callback)) as typeof request;
    const input = { endpoint: `https://town.example:${port}`, path: '/health', timeoutMs: 3000 };
    await expect(pinnedHttpsRequest(input, { lookup, request: localRoutingRequest(cert) })).resolves.toEqual({ status: 200, text: '{}' });
    expect(received).toEqual([{ host: `town.example:${port}`, servername: 'town.example', path: '/federation/v1/health' }]);
    await expect(pinnedHttpsRequest({ ...input, endpoint: `https://wrong.example:${port}` }, { lookup, request: localRoutingRequest(cert) }))
      .rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    await expect(pinnedHttpsRequest(input, { lookup, request: localRoutingRequest() })).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(received).toHaveLength(1);
    redirect = true;
    await expect(pinnedHttpsRequest(input, { lookup, request: localRoutingRequest(cert) })).resolves.toEqual({ status: 302, text: '' });
    expect(received).toHaveLength(2);
    expect(checked).toEqual(Array(4).fill('8.8.8.8'));
    expect(lookup).toHaveBeenCalledTimes(4);
  } finally {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
