'use node';

import { lookup } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { assertDestinationAddresses, privateNetworkAllowlist } from './networkPolicy';
import {
  configuredS3,
  mirrorKey,
  safeArchiveError,
  type S3Configuration,
} from './coldArchivePolicy';
import { sha256, signS3Request } from './s3SigV4';
import { serverTlsTrust } from './serverTlsTrust';

const MAX_BYTES = 2_000_000;
type Dependencies = { lookup: typeof lookup; request: typeof request };

// Bind a resumable upload to the exact server configuration, including credential
// rotation. This digest is internal metadata; credentials never enter the database.
export const archiveEnvironmentBinding = (config: S3Configuration) =>
  sha256(
    JSON.stringify([
      config.name,
      config.endpoint,
      config.region,
      config.bucket,
      config.prefix,
      config.accessKeyId,
      config.secretAccessKey,
      config.sessionToken ?? null,
    ]),
  );

/** One signed request with checked DNS answers and a pinned socket. Credentials
 * come only from the server environment; neither URLs nor headers are public inputs. */
export async function signedArchiveRequest(
  config: S3Configuration,
  method: 'GET' | 'PUT',
  key: string,
  body = '',
  deps: Dependencies = { lookup, request },
) {
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('COLD_ARCHIVE_OBJECT_TOO_LARGE');
  const url = new URL(config.endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const signed = signS3Request(config, method, key, body);
  let active: ReturnType<typeof request> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const operation = (async () => {
    const answers = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await deps.lookup(host, { all: true, verbatim: true });
    if (expired) throw new Error('CONNECTION_TIMEOUT');
    assertDestinationAddresses(
      answers.map((answer) => answer.address),
      privateNetworkAllowlist(process.env.FEDERATION_PRIVATE_NETWORK_ALLOWLIST),
    );
    const pinned = answers[0];
    return new Promise<Buffer>((resolve, reject) => {
      const options: RequestOptions = {
        hostname: host,
        port: url.port || 443,
        path: signed.path,
        method,
        headers: {
          ...signed.headers,
          ...(method === 'PUT'
            ? { 'content-length': Buffer.byteLength(body), 'content-type': 'application/json' }
            : {}),
        },
        agent: false,
        family: pinned.family,
        rejectUnauthorized: true,
        ...serverTlsTrust(),
        ...(isIP(host) ? {} : { servername: host }),
        lookup: ((_host: string, _options: unknown, callback: any) =>
          callback(null, pinned.address, pinned.family)) as RequestOptions['lookup'],
      };
      active = deps.request(options, (response) => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          reject(new Error(`S3_HTTP_${response.statusCode ?? 0}`));
          return;
        }
        if (Number(response.headers['content-length']) > MAX_BYTES) {
          response.destroy();
          reject(new Error('COLD_ARCHIVE_OBJECT_TOO_LARGE'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            reject(new Error('COLD_ARCHIVE_OBJECT_TOO_LARGE'));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('NETWORK_UNREACHABLE')));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });
      active.on('error', reject);
      active.end(method === 'PUT' ? body : undefined);
    });
  })();
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('CONNECTION_TIMEOUT'));
          active?.destroy();
        }, 30_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function uploadArchiveObject(
  config: S3Configuration,
  key: string,
  body: string,
  deps?: Dependencies,
) {
  await signedArchiveRequest(config, 'PUT', key, body, deps);
  const retrieved = await signedArchiveRequest(config, 'GET', key, '', deps);
  if (!retrieved.equals(Buffer.from(body))) throw new Error('COLD_ARCHIVE_READBACK_MISMATCH');
  return { key, sha256: sha256(retrieved), bytes: retrieved.length };
}

export const putVerified = internalAction({
  args: {
    name: v.string(),
    environmentBinding: v.string(),
    scope: v.string(),
    runId: v.string(),
    index: v.union(v.number(), v.literal('root')),
    body: v.string(),
  },
  handler: async (_ctx, args) => {
    try {
      const config = configuredS3(args.name);
      if (archiveEnvironmentBinding(config) !== args.environmentBinding)
        throw new Error('COLD_ARCHIVE_ENVIRONMENT_CHANGED');
      const key = mirrorKey(config.prefix, args.scope, args.runId, args.index);
      const result = await uploadArchiveObject(config, key, args.body);
      if (archiveEnvironmentBinding(configuredS3(args.name)) !== args.environmentBinding)
        throw new Error('COLD_ARCHIVE_ENVIRONMENT_CHANGED');
      return { ok: true as const, ...result };
    } catch (error) {
      return { ok: false as const, error: safeArchiveError(error) };
    }
  },
});
