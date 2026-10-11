"use node";

import { lookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { MESSAGE_MAX_BYTES, normalizeEndpoint } from './protocol';
import { assertDestinationAddresses, privateNetworkAllowlist } from './networkPolicy';
import { serverTlsTrust } from './serverTlsTrust';

type Input = { endpoint: string; path: string; data?: string; timeoutMs: number };
type Dependencies = { lookup: typeof lookup; request: typeof httpsRequest };
const paths = ['/health', '/pair', '/probe', '/messages', '/migration', '/peers/endpoints', '/peers/rotate-auth', '/peers/identity-key'];

/** Resolve every time, validate all answers, then connect to exactly one checked
 * address. No second system DNS lookup, redirect, proxy, or pooled socket is used.
 * The original host remains the Host header and TLS certificate identity. */
export async function pinnedHttpsRequest(input: Input, deps: Dependencies = { lookup, request: httpsRequest }) {
  const endpoint = normalizeEndpoint(input.endpoint), url = new URL(`${endpoint}${input.path}`);
  if (!paths.includes(input.path)) throw new Error('INVALID_FEDERATION_PATH');
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 30000) throw new Error('INVALID_REQUEST_TIMEOUT');
  if (input.data !== undefined && Buffer.byteLength(input.data) > MESSAGE_MAX_BYTES) throw new Error('MESSAGE_TOO_LARGE');
  const allowlist = privateNetworkAllowlist(process.env.FEDERATION_PRIVATE_NETWORK_ALLOWLIST);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: ReturnType<typeof httpsRequest> | undefined;
  let expired = false;
  const operation = (async () => {
    const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await deps.lookup(host, { all: true, verbatim: true });
    if (expired) throw new Error('CONNECTION_TIMEOUT');
    assertDestinationAddresses(answers.map(answer => answer.address), allowlist);
    const pinned = answers[0];
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
      const options: RequestOptions = {
        hostname: host, port: url.port || 443, path: url.pathname, method: input.data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(input.data === undefined ? {} : { 'Content-Length': Buffer.byteLength(input.data) }) },
        agent: false, family: pinned.family, rejectUnauthorized: true, ...(isIP(host) ? {} : { servername: host }),
        ...serverTlsTrust(),
        lookup: ((_hostname: string, _options: unknown, callback: any) => callback(null, pinned.address, pinned.family)) as RequestOptions['lookup'],
      };
      active = deps.request(options, response => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) { response.resume(); response.destroy(); resolve({ status, text: '' }); return; }
        if (Number(response.headers['content-length']) > MESSAGE_MAX_BYTES) { response.destroy(); reject(new Error('MESSAGE_TOO_LARGE')); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MESSAGE_MAX_BYTES) { reject(new Error('MESSAGE_TOO_LARGE')); response.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('NETWORK_UNREACHABLE')));
        response.on('end', () => resolve({ status, text: Buffer.concat(chunks).toString('utf8') }));
      });
      active.on('error', reject);
      active.end(input.data);
    });
  })();
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('CONNECTION_TIMEOUT')); active?.destroy(); }, input.timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export const send = internalAction({
  args: { endpoint: v.string(), path: v.string(), data: v.optional(v.string()), timeoutMs: v.number() },
  handler: async (_ctx, args) => {
    try { return { ok: true as const, ...await pinnedHttpsRequest(args) }; }
    catch (error) {
      // Only structured codes cross runtimes; raw failures can include network
      // addresses or remote response details and must not be exposed publicly.
      const reason = error instanceof Error ? error.message : '';
      const code = (error as { code?: string })?.code;
      const safe = /^[A-Z][A-Z0-9_]+$/.test(reason) ? reason :
        /ENOTFOUND|EAI_AGAIN|EAI_FAIL/.test(code ?? '') ? 'DNS_RESOLUTION_FAILED' :
        /CERT_|CERTIFICATE|TLS_|SSL_|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO/.test(code ?? '') ? 'TLS_VERIFY_FAILED' :
        /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(code ?? '') ? 'CONNECTION_TIMEOUT' : 'NETWORK_UNREACHABLE';
      return { ok: false as const, error: safe };
    }
  },
});
