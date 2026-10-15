// Dedicated local federation labs only. This is not part of the production TLS proxy.
// Controls are in-process; there is no HTTP control or packet injection interface.
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';

// Keep aligned with convex/federation/protocol.ts MESSAGE_MAX_BYTES. Node 20
// cannot import that TypeScript module without a loader.
export const MESSAGE_MAX_BYTES = 64 * 1024;
const MESSAGE_PATH = '/federation/v1/messages';
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function headersFor(headers) {
  const blocked = new Set([...HOP_HEADERS,
    ...(headers.connection || '').split(',').map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name)));
}

export async function startVisitActiveFaultGate({ certPath, keyPath, listenPort,
  upstream, homeTownId, hostTownId, bindHost = '127.0.0.1',
  requestTimeoutMs = 30_000, shutdownTimeoutMs = 1000 }) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash ||
      !['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(target.hostname))
    throw new Error('LOCAL_UPSTREAM_REQUIRED');
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535 ||
      typeof bindHost !== 'string' || !bindHost ||
      ![homeTownId, hostTownId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 1000) ||
      homeTownId === hostTownId || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000 ||
      !Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 5000)
    throw new Error('INVALID_FAULT_GATE_CONFIG');
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  const sockets = new Set(), activeUpstreams = new Set(), events = [];
  let armed = false, lockedVisitId, closing;
  const server = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, (req, res) => {
    let outbound;
    const deadline = setTimeout(() => {
      outbound?.destroy();
      if (!res.headersSent) res.writeHead(504).end();
      else res.destroy();
      req.destroy();
    }, requestTimeoutMs);
    deadline.unref();
    const cleanup = () => { clearTimeout(deadline); outbound?.destroy(); };
    res.on('close', cleanup);
    req.on('aborted', cleanup);
    req.on('error', cleanup);
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400).end();
      return;
    }
    const forward = (bytes) => {
      if (res.destroyed || req.aborted) return;
      const headers = headersFor(req.headers);
      headers.host = target.host;
      outbound = http.request({ hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || 80, method: req.method, path: req.url, headers, agent: false }, response => {
        res.writeHead(response.statusCode, headersFor(response.headers));
        response.on('error', () => res.destroy());
        response.on('aborted', () => res.destroy());
        response.pipe(res);
      });
      activeUpstreams.add(outbound);
      outbound.on('close', () => activeUpstreams.delete(outbound));
      outbound.on('error', () => {
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
      if (bytes === undefined) req.pipe(outbound);
      else outbound.end(bytes);
    };
    if (req.method !== 'POST' || req.url !== MESSAGE_PATH) { forward(); return; }
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MESSAGE_MAX_BYTES) {
        chunks.length = 0;
        res.writeHead(413, { connection: 'close' }).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MESSAGE_MAX_BYTES || res.destroyed) return;
      const bytes = Buffer.concat(chunks);
      let body;
      try { body = JSON.parse(bytes.toString('utf8'))?.body; } catch { /* Forward malformed bytes unchanged. */ }
      if (armed && body?.type === 'VISIT_ACTIVE' && body.fromTownId === hostTownId &&
          body.toTownId === homeTownId && typeof body.visitId === 'string' &&
          body.visitId.length > 0 && body.visitId.length <= 1000 &&
          typeof body.messageId === 'string' && body.messageId.length > 0 && body.messageId.length <= 1000 &&
          (lockedVisitId === undefined || body.visitId === lockedVisitId)) {
        lockedVisitId = body.visitId;
        // Metadata only: never retain envelopes, signatures, credentials or payloads.
        // Bound retained evidence even if a lab leaves the gate armed indefinitely.
        if (events.length === 1000) events.shift();
        events.push(Object.freeze({ type: body.type, visitId: body.visitId, messageId: body.messageId,
          fromTownId: body.fromTownId, toTownId: body.toTownId, timestamp: Date.now(), forwarded: false }));
        res.destroy();
        return;
      }
      forward(bytes);
    });
  });
  server.headersTimeout = Math.min(requestTimeoutMs, 15_000);
  server.requestTimeout = requestTimeoutMs;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  const close = () => {
    if (closing) return closing;
    armed = false;
    closing = new Promise(resolve => {
      const deadline = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        for (const request of activeUpstreams) request.destroy();
      }, shutdownTimeoutMs);
      deadline.unref();
      server.close(() => { clearTimeout(deadline); resolve(); });
    });
    return closing;
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, bindHost, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) { await close(); throw error; }
  return {
    server,
    arm() {
      if (closing) throw new Error('FAULT_GATE_CLOSED');
      if (armed) throw new Error('FAULT_GATE_ALREADY_ARMED');
      lockedVisitId = undefined;
      armed = true;
    },
    release() { armed = false; },
    get events() { return events.slice(); },
    close,
  };
}
