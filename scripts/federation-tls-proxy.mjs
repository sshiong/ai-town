import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection'];

export function validateConfiguration(config) {
  if (!config || typeof config.certPath !== 'string' || !config.certPath ||
      typeof config.keyPath !== 'string' || !config.keyPath ||
      !Array.isArray(config.routes) || !config.routes.length) throw new Error('INVALID_CONFIG');
  const ports = new Set();
  return config.routes.map((route) => {
    if (!route || !Number.isInteger(route.listenPort) || route.listenPort < 1 || route.listenPort > 65535 ||
        ports.has(route.listenPort) || (route.bindHost !== undefined &&
        (typeof route.bindHost !== 'string' || !route.bindHost))) throw new Error('INVALID_ROUTE');
    ports.add(route.listenPort);
    let upstream;
    try { upstream = new URL(route.upstream); } catch { throw new Error('INVALID_UPSTREAM'); }
    if (upstream.protocol !== 'http:' || upstream.username || upstream.password ||
        upstream.pathname !== '/' || upstream.search || upstream.hash ||
        !['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(upstream.hostname)) {
      throw new Error('INVALID_UPSTREAM');
    }
    return { ...route, upstream };
  });
}

function endToEndHeaders(headers) {
  const blocked = new Set([...HOP_HEADERS,
    ...(headers.connection || '').split(',').map((name) => name.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name)));
}

// Configuration and certificates belong to the operator; never include them in logs.
export async function startProxy(config, { log = (entry) => console.log(JSON.stringify(entry)),
  requestTimeoutMs = 30_000, shutdownTimeoutMs = 5_000 } = {}) {
  const routes = validateConfiguration(config);
  const [cert, key] = await Promise.all([readFile(config.certPath), readFile(config.keyPath)]);
  const servers = [];
  const sockets = new Set();
  let closing;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      const deadline = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, shutdownTimeoutMs);
      deadline.unref();
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      clearTimeout(deadline);
    })();
    return closing;
  };
  try {
    for (const route of routes) {
      const server = https.createServer({ cert, key, minVersion: 'TLSv1.2', handshakeTimeout: 15_000 }, (req, res) => {
        res.on('finish', () => log({ port: route.listenPort, code: res.statusCode }));
        // Only origin-form targets are accepted; client input never selects an upstream.
        if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
          res.writeHead(400).end();
          return;
        }
        const headers = endToEndHeaders(req.headers);
        for (const name of Object.keys(headers)) {
          if (name === 'forwarded' || name.startsWith('x-forwarded-')) delete headers[name];
        }
        headers.host = route.upstream.host;
        headers['x-forwarded-proto'] = 'https';
        headers['x-forwarded-for'] = req.socket.remoteAddress;
        // Never restore a header removed by a client's Connection token.
        const upstream = http.request({ hostname: route.upstream.hostname.replace(/^\[|\]$/g, ''),
          port: route.upstream.port || 80, method: req.method, path: req.url,
          headers, agent: false }, (response) => {
          res.writeHead(response.statusCode, endToEndHeaders(response.headers));
          response.on('error', () => res.destroy());
          response.on('aborted', () => res.destroy());
          response.pipe(res);
        });
        const deadline = setTimeout(() => {
          if (!res.headersSent) res.writeHead(504).end();
          else res.destroy();
          upstream.destroy();
        }, requestTimeoutMs);
        deadline.unref();
        res.on('close', () => { clearTimeout(deadline); upstream.destroy(); });
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502).end();
          else res.destroy();
        });
        req.on('aborted', () => upstream.destroy());
        req.on('error', () => upstream.destroy());
        req.pipe(upstream);
      });
      servers.push(server);
      server.headersTimeout = 15_000;
      server.requestTimeout = requestTimeoutMs;
      server.keepAliveTimeout = 5_000;
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      server.on('upgrade', (_req, socket) => socket.destroy());
      server.on('connect', (_req, socket) => socket.destroy());
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(route.listenPort, route.bindHost || '0.0.0.0', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      log({ port: route.listenPort, code: 'LISTENING' });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { servers, close };
}

async function main() {
  try {
    if (!process.env.FEDERATION_TLS_PROXY_CONFIG) throw new Error('CONFIG_REQUIRED');
    const config = JSON.parse(await readFile(process.env.FEDERATION_TLS_PROXY_CONFIG, 'utf8'));
    const proxy = await startProxy(config);
    const stop = () => { proxy.close().then(() => { process.exitCode = 0; }); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch {
    console.error(JSON.stringify({ code: 'START_FAILED' }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
