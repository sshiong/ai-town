import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startVisitActiveFaultGate, MESSAGE_MAX_BYTES } from './federation-visit-active-fault-gate.mjs';

let directory, certPath, keyPath, ca;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'visit-active-gate-'));
  certPath = join(directory, 'cert.pem'); keyPath = join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  ca = await readFile(certPath);
});
after(async () => { await rm(directory, { recursive: true, force: true }); });
const options = upstream => ({ certPath, keyPath, listenPort: 0, upstream,
  homeTownId: 'home', hostTownId: 'host', shutdownTimeoutMs: 30 });
async function fixture(extra = {}, handler) {
  const seen = [];
  const backend = http.createServer(handler || ((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, bytes: Buffer.concat(chunks) });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(' { "body": { "type": "MESSAGE_ACK" }, "signature": "original" }\n');
    });
  }));
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const gate = await startVisitActiveFaultGate({ ...options(`http://127.0.0.1:${backend.address().port}`), ...extra });
  return { gate, seen, async close() {
    await gate.close(); backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve));
  } };
}
function request(gate, bytes, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', servername: 'localhost',
      port: gate.server.address().port, ca, agent: false, method: 'POST',
      path: '/federation/v1/messages', ...extra }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(bytes);
  });
}
const packet = (fields = {}) => Buffer.from(JSON.stringify({ body: {
  type: 'VISIT_ACTIVE', fromTownId: 'host', toTownId: 'home', visitId: 'visit-1',
  messageId: 'message-1', payload: { privateText: 'must-not-be-retained' }, ...fields,
}, signature: 'unaltered-signature' }, null, 2) + '\n');

test('real TLS forwarding preserves request and response bytes, including malformed JSON', async () => {
  const f = await fixture();
  try {
    f.gate.arm();
    const cases = [Buffer.from(' { invalid JSON\n'), packet({ type: 'VISIT_RESERVED' })];
    for (const bytes of cases) {
      const response = await request(f.gate, bytes);
      assert.equal(response.status, 201);
      assert.equal(response.bytes.toString(), ' { "body": { "type": "MESSAGE_ACK" }, "signature": "original" }\n');
    }
    assert.deepEqual(f.seen.map(row => row.bytes), cases);
    assert.deepEqual(f.gate.events, []);
  } finally { await f.close(); }
});

test('arm drops only the first matching visit and its retries until release, retaining metadata only', async () => {
  const f = await fixture();
  try {
    await request(f.gate, packet());
    f.gate.arm();
    assert.throws(() => f.gate.arm(), /ALREADY_ARMED/);
    await assert.rejects(request(f.gate, packet()));
    await assert.rejects(request(f.gate, packet({ messageId: 'retry-message' })));
    assert.equal(f.seen.length, 1);
    const allowed = [packet({ visitId: 'visit-2' }), packet({ fromTownId: 'stranger' }),
      packet({ toTownId: 'stranger' }), packet({ type: 'VISIT_CONFIRM' }), packet({ messageId: undefined })];
    for (const bytes of allowed) await request(f.gate, bytes);
    await request(f.gate, packet(), { path: '/federation/v1/messages?query=1' });
    await request(f.gate, packet(), { method: 'PUT' });
    assert.equal(f.seen.length, 8);
    assert.equal(f.gate.events.length, 2);
    assert.deepEqual(Object.keys(f.gate.events[0]).sort(),
      ['type', 'visitId', 'messageId', 'fromTownId', 'toTownId', 'timestamp', 'forwarded'].sort());
    assert.ok(!JSON.stringify(f.gate.events).includes('must-not-be-retained'));
    const evidence = f.gate.events; evidence.length = 0;
    assert.equal(f.gate.events.length, 2);
    f.gate.release();
    await request(f.gate, packet());
    assert.equal(f.seen.length, 9);
    f.gate.arm();
    await assert.rejects(request(f.gate, packet({ visitId: 'visit-2' })));
    assert.equal(f.gate.events.at(-1).visitId, 'visit-2');
  } finally { await f.close(); }
});

test('protocol size limit rejects excess without forwarding or capturing; exact limit passes', async () => {
  const f = await fixture();
  try {
    f.gate.arm();
    const bytes = Buffer.alloc(MESSAGE_MAX_BYTES, ' ');
    await request(f.gate, bytes);
    assert.deepEqual(f.seen[0].bytes, bytes);
    // A closed socket is also a valid bounded rejection; no backend request escapes.
    const result = await request(f.gate, Buffer.alloc(MESSAGE_MAX_BYTES + 1, ' ')).catch(() => null);
    if (result) assert.equal(result.status, 413);
    assert.equal(f.seen.length, 1); assert.deepEqual(f.gate.events, []);
    const protocol = await readFile(new URL('../convex/federation/protocol.ts', import.meta.url), 'utf8');
    assert.match(protocol, /export const MESSAGE_MAX_BYTES = 64 \* 1024;/);
  } finally { await f.close(); }
});

test('configuration rejects remote upstreams and bind failure leaves existing listener intact', async () => {
  for (const upstream of ['http://example.com', 'https://127.0.0.1', 'http://user:pass@localhost', 'http://localhost/path'])
    await assert.rejects(startVisitActiveFaultGate(options(upstream)), /LOCAL_UPSTREAM_REQUIRED/);
  const f = await fixture();
  try {
    await assert.rejects(startVisitActiveFaultGate({ ...options('http://127.0.0.1:1'),
      listenPort: f.gate.server.address().port }), { code: 'EADDRINUSE' });
    assert.equal((await request(f.gate, Buffer.from('{}'))).status, 201);
  } finally { await f.close(); }
});

test('close is idempotent and cleans up a live upstream request', async () => {
  let accepted;
  const arrived = new Promise(resolve => { accepted = resolve; });
  const f = await fixture({}, () => accepted());
  const pending = request(f.gate, Buffer.from('{}')).catch(() => null);
  await arrived;
  const first = f.gate.close();
  assert.equal(first, f.gate.close());
  await first; await pending;
  assert.throws(() => f.gate.arm(), /CLOSED/);
  await f.close();
});

test('request deadline closes stalled upstream work', { timeout: 2000 }, async () => {
  let closed;
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  const f = await fixture({ requestTimeoutMs: 40 }, req => {
    req.socket.once('close', closed);
  });
  try {
    const result = await request(f.gate, Buffer.from('{}')).catch(() => null);
    if (result) assert.equal(result.status, 504);
    await upstreamClosed;
  } finally { await f.close(); }
});

test('client disconnect closes the corresponding upstream', { timeout: 2000 }, async () => {
  let accepted, closed;
  const arrived = new Promise(resolve => { accepted = resolve; });
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  const f = await fixture({}, req => {
    req.socket.once('close', closed);
    accepted();
  });
  try {
    const req = https.request({ hostname: '127.0.0.1', servername: 'localhost',
      port: f.gate.server.address().port, ca, agent: false, method: 'POST',
      path: '/federation/v1/messages' });
    req.on('error', () => {});
    req.end('{}');
    await arrived;
    req.destroy();
    await upstreamClosed;
    assert.deepEqual(f.gate.events, []);
  } finally { await f.close(); }
});
