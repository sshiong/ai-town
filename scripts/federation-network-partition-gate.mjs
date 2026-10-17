// Dedicated test ingress only. No remote controls; raw signed packets stay in memory.
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { MESSAGE_MAX_BYTES } from './federation-visit-active-fault-gate.mjs';

export async function startNetworkPartitionGate(config) {
  const target = new URL(config.upstream);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
      target.username || target.password || target.pathname !== '/' || target.search || target.hash ||
      !Number.isInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535 ||
      !['127.0.0.1', '0.0.0.0', '::1', '::'].includes(config.bindHost ?? '127.0.0.1') ||
      ![config.fromTownId, config.toTownId].every(value => typeof value === 'string' && value.length > 0) ||
      config.fromTownId === config.toTownId) throw new Error('INVALID_PARTITION_GATE');
  const [cert, key] = await Promise.all([readFile(config.certPath), readFile(config.keyPath)]);
  const sockets = new Set(), requests = new Set();
  let mode = 'open', held, closing;
  const counts = { blocked: 0, held: 0 };
  const forward = (bytes, path, method, incomingHeaders, receive) => {
    // Never let client headers nominate another upstream or leak forwarding claims.
    const blocked = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailer', 'transfer-encoding', 'upgrade', 'forwarded', 'x-real-ip',
      ...(incomingHeaders.connection ?? '').split(',').map(value => value.trim().toLowerCase())]);
    const headers = Object.fromEntries(Object.entries(incomingHeaders).filter(([name]) =>
      !blocked.has(name) && !name.startsWith('x-forwarded-')));
    headers.host = target.host;
    headers['content-length'] = bytes.length;
    const request = http.request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port,
      method, path, headers, agent: false }, receive);
    requests.add(request);
    request.on('close', () => requests.delete(request));
    request.setTimeout(30_000, () => request.destroy(new Error('UPSTREAM_TIMEOUT')));
    request.end(bytes);
    return request;
  };
  const server = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, (req, res) => {
    if (closing || mode === 'blocked') { counts.blocked++; res.destroy(); return; }
    if (req.method !== 'POST' || !['/federation/v1/probe', '/federation/v1/messages'].includes(req.url)) {
      res.writeHead(404).end(); return;
    }
    let size = 0;
    const chunks = [];
    req.on('error', () => {}); // Peer disconnect is the injected fault, not a process error.
    req.on('data', bytes => {
      size += bytes.length;
      if (size > MESSAGE_MAX_BYTES) { chunks.length = 0; res.writeHead(413).end(); req.destroy(); }
      else chunks.push(bytes);
    });
    req.on('end', () => {
      if (size > MESSAGE_MAX_BYTES || res.destroyed) return;
      const bytes = Buffer.concat(chunks);
      let body;
      try { body = JSON.parse(bytes.toString('utf8')).body; } catch { /* Preserve malformed bytes for the real handler. */ }
      if (mode === 'hold-confirm' && req.url === '/federation/v1/messages' &&
          body?.type === 'VISIT_CONFIRM' && body.fromTownId === config.fromTownId && body.toTownId === config.toTownId) {
        if (!held && typeof body.visitId === 'string' && typeof body.messageId === 'string')
          held = { bytes, headers: { ...req.headers }, visitId: body.visitId, messageId: body.messageId, expiresAt: body.expiresAt };
        counts.held++;
        res.destroy(); return;
      }
      const request = forward(bytes, req.url, req.method, req.headers, response => {
        res.writeHead(response.statusCode, { 'content-type': 'application/json' });
        response.on('error', () => res.destroy()); response.pipe(res);
      });
      request.on('error', () => res.destroy());
      res.on('close', () => request.destroy());
    });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  const close = () => {
    if (closing) return closing;
    held?.bytes.fill(0); held = undefined; mode = 'open';
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
    closing = new Promise(resolve => server.close(resolve));
    return closing;
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.listenPort, config.bindHost ?? '127.0.0.1', () => {
        server.removeListener('error', reject); resolve();
      });
    });
  } catch (error) { await close(); throw error; }
  return {
    setMode(value) {
      if (closing || !['open', 'blocked', 'hold-confirm'].includes(value)) throw new Error('INVALID_GATE_MODE');
      mode = value;
      if (value === 'blocked') {
        // Abort already established work so a partition has a definite boundary.
        for (const request of requests) request.destroy();
        for (const socket of sockets) socket.destroy();
      }
    },
    get evidence() { return { ...counts, held: held ? { visitId: held.visitId, messageId: held.messageId, expiresAt: held.expiresAt } : null }; },
    async deliverHeld() {
      if (!held || closing) throw new Error('HELD_CONFIRM_REQUIRED');
      const packet = held; held = undefined;
      try {
        return await new Promise((resolve, reject) => {
          const request = forward(packet.bytes, '/federation/v1/messages', 'POST', packet.headers, response => {
            let size = 0; const chunks = [];
            response.on('data', bytes => {
              size += bytes.length;
              if (size > MESSAGE_MAX_BYTES) response.destroy(new Error('RESPONSE_TOO_LARGE'));
              else chunks.push(bytes);
            });
            response.on('error', reject);
            response.on('end', () => {
              let error;
              try { error = JSON.parse(Buffer.concat(chunks).toString('utf8')).error; } catch { /* No arbitrary body is retained. */ }
              resolve({ status: response.statusCode, reason: /^[A-Z_]{1,80}$/.test(error ?? '') ? error : 'UNEXPECTED_RESPONSE',
                visitId: packet.visitId, messageId: packet.messageId });
            });
          });
          request.on('error', reject);
        });
      } finally { packet.bytes.fill(0); }
    },
    close,
  };
}
