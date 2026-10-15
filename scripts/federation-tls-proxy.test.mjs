import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startProxy, validateConfiguration } from './federation-tls-proxy.mjs';

let directory, certPath, keyPath, ca;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'federation-tls-proxy-'));
  certPath = join(directory, 'cert.pem');
  keyPath = join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  ca = await readFile(certPath);
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function stop(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await stop(server);
  return port;
}
const configuration = (routes) => ({ certPath, keyPath, routes });
const route = (listenPort, upstreamPort) => ({ listenPort,
  bindHost: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}` });
function request(port, options = {}, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', servername: 'localhost', port, ca,
      agent: false, ...options }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('configuration rejects duplicate/invalid ports and non-local or credentialed upstreams', () => {
  const valid = route(3432, 3423);
  for (const listenPort of [0, -1, 65536, 3.5, '3432']) {
    assert.throws(() => validateConfiguration(configuration([{ ...valid, listenPort }])));
  }
  assert.throws(() => validateConfiguration(configuration([valid, valid])));
  for (const upstream of ['https://localhost', 'http://example.com', 'http://user:secret@localhost',
    'http://localhost/path', 'http://localhost?url=x', 'http://localhost#x', 'bad']) {
    assert.throws(() => validateConfiguration(configuration([{ ...valid, upstream }])));
  }
  for (const upstream of ['http://localhost:3423', 'http://[::1]:3423', 'http://host.docker.internal:3423']) {
    assert.equal(validateConfiguration(configuration([{ ...valid, upstream }])).length, 1);
  }
});

test('two TLS listeners preserve signed body/path/status and rebuild hop-by-hop headers', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ headers: req.headers, path: req.url, body: Buffer.concat(chunks).toString() });
      res.writeHead(201, { connection: 'close, x-private', 'x-private': 'secret',
        'x-signature': 'signed-response', 'content-type': 'text/plain' });
      res.end('accepted');
    });
  });
  const upstreamPort = await listen(upstream);
  const ports = [await freePort(), await freePort()];
  const logs = [];
  const proxy = await startProxy(configuration(ports.map((port) => route(port, upstreamPort))),
    { log: (entry) => logs.push(entry) });
  try {
    for (const port of ports) {
      const result = await request(port, { path: '/federation/v1/message?a=%2F', method: 'POST',
        headers: { host: 'untrusted.example', connection: 'close, x-private', 'x-private': 'secret',
          'x-signature': 'signed-request', forwarded: 'for=spoof', 'x-forwarded-for': 'spoof',
          'x-forwarded-proto': 'http', 'content-length': '13' } }, '{"message":1}');
      assert.equal(result.status, 201);
      assert.equal(result.body, 'accepted');
      assert.equal(result.headers['x-private'], undefined);
      assert.equal(result.headers['x-signature'], 'signed-response');
    }
    assert.equal(seen.length, 2);
    for (const entry of seen) {
      assert.equal(entry.path, '/federation/v1/message?a=%2F');
      assert.equal(entry.body, '{"message":1}');
      assert.equal(entry.headers.host, `127.0.0.1:${upstreamPort}`);
      assert.equal(entry.headers['x-signature'], 'signed-request');
      assert.equal(entry.headers['x-private'], undefined);
      assert.equal(entry.headers.forwarded, undefined);
      assert.equal(entry.headers['x-forwarded-proto'], 'https');
      assert.equal(entry.headers['x-forwarded-for'], '127.0.0.1');
    }
    assert.deepEqual(logs.map(({ code }) => code), ['LISTENING', 'LISTENING', 201, 201]);
    assert.ok(logs.every((entry) => Object.keys(entry).sort().join(',') === 'code,port'));
    assert.equal((await request(ports[0], { path: 'http://localhost/escape' })).status, 400);
    assert.equal((await request(ports[0], { path: '//localhost/escape' })).status, 400);
    await assert.rejects(request(ports[0], { ca: undefined }), /self.signed/i);
  } finally { await proxy.close(); await stop(upstream); }
});

test('startup bind failure closes previously opened listeners', async () => {
  const occupied = net.createServer();
  const occupiedPort = await listen(occupied);
  const firstPort = await freePort();
  try {
    await assert.rejects(startProxy(configuration([route(firstPort, 3423), route(occupiedPort, 3425)]),
      { log: () => {} }), { code: 'EADDRINUSE' });
    const replacement = net.createServer();
    await new Promise((resolve, reject) => {
      replacement.once('error', reject);
      replacement.listen(firstPort, '127.0.0.1', resolve);
    });
    await stop(replacement);
  } finally { await stop(occupied); }
});

test('unreachable upstream returns 502; bounded request timeout returns 504 and closes upstream', async () => {
  const missingPort = await freePort();
  const tlsPort = await freePort();
  let proxy = await startProxy(configuration([route(tlsPort, missingPort)]), { log: () => {} });
  try { assert.equal((await request(tlsPort)).status, 502); } finally { await proxy.close(); }
  let closed;
  const upstreamClosed = new Promise((resolve) => { closed = resolve; });
  const upstream = http.createServer((req) => req.on('close', closed));
  const upstreamPort = await listen(upstream);
  proxy = await startProxy(configuration([route(tlsPort, upstreamPort)]),
    { log: () => {}, requestTimeoutMs: 100 });
  try {
    assert.equal((await request(tlsPort)).status, 504);
    await upstreamClosed;
  } finally { await proxy.close(); await stop(upstream); }
});

test('client disconnect cancels upstream and graceful close is idempotent', async () => {
  let began, ended;
  const started = new Promise((resolve) => { began = resolve; });
  const cancelled = new Promise((resolve) => { ended = resolve; });
  const upstream = http.createServer((req, res) => {
    res.writeHead(200);
    res.write('partial');
    began();
    req.on('close', ended);
  });
  const upstreamPort = await listen(upstream);
  const tlsPort = await freePort();
  const proxy = await startProxy(configuration([route(tlsPort, upstreamPort)]), { log: () => {} });
  try {
    const req = https.get({ hostname: '127.0.0.1', servername: 'localhost', port: tlsPort, ca,
      agent: false }, (res) => { res.on('error', () => {}); res.destroy(); });
    req.on('error', () => {});
    await started;
    await cancelled;
    assert.equal(proxy.close(), proxy.close());
    await proxy.close();
    await assert.rejects(request(tlsPort), { code: 'ECONNREFUSED' });
  } finally { await proxy.close(); await stop(upstream); }
});

test('graceful close bounds an active response', { timeout: 3000 }, async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200);
    res.write('partial');
  });
  const upstreamPort = await listen(upstream);
  const tlsPort = await freePort();
  const proxy = await startProxy(configuration([route(tlsPort, upstreamPort)]),
    { log: () => {}, shutdownTimeoutMs: 50 });
  const req = https.get({ hostname: '127.0.0.1', servername: 'localhost', port: tlsPort,
    ca, agent: false });
  req.on('error', () => {});
  try {
    const [res] = await once(req, 'response');
    res.on('error', () => {});
    res.resume();
    const closed = new Promise((resolve) => res.once('close', resolve));
    await proxy.close();
    await closed;
  } finally { req.destroy(); await proxy.close(); await stop(upstream); }
});

test('CLI reads an external config, exits cleanly on SIGTERM, and fails closed without config',
  { timeout: 5000 }, async () => {
    const script = fileURLToPath(new URL('./federation-tls-proxy.mjs', import.meta.url));
    const tlsPort = await freePort();
    const configPath = join(directory, 'proxy.json');
    await writeFile(configPath, JSON.stringify(configuration([route(tlsPort, 3423)])));
    const child = spawn(process.execPath, [script], { env: { ...process.env,
      FEDERATION_TLS_PROXY_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      const [output] = await once(child.stdout, 'data');
      assert.equal(JSON.parse(output.toString()).code, 'LISTENING');
      child.kill('SIGTERM');
      assert.deepEqual(await exited, [0, null]);
      await assert.rejects(request(tlsPort), { code: 'ECONNREFUSED' });
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
    const failed = spawn(process.execPath, [script], { env: { ...process.env,
      FEDERATION_TLS_PROXY_CONFIG: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorLog = '';
    failed.stderr.on('data', (chunk) => { errorLog += chunk; });
    assert.deepEqual(await once(failed, 'exit'), [1, null]);
    assert.deepEqual(JSON.parse(errorLog), { code: 'START_FAILED' });
  });
