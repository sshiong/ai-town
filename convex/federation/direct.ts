import { MESSAGE_MAX_BYTES, normalizeEndpoint, normalizeEndpointCandidates, EndpointCandidate, endpointGeneration, PROTOCOL, FederationMessage } from './protocol';
import type { Doc } from '../_generated/dataModel';
import type { ActionCtx } from '../maintenanceFunctions';
import { actionRef, queryRef } from './refs';
import { signPacket, verifyPacket } from './security';
import { observeSignedIdentity } from './identityConflict';
import { configuredTimePolicy } from './timePolicy';
export function connectionError(error: unknown, timedOut = false): string {
  if (timedOut) return 'CONNECTION_TIMEOUT';
  const codes: string[] = [];
  let cause: any = error;
  for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause) {
    if (typeof cause.code === 'string') codes.push(cause.code);
    if (typeof cause.message === 'string') codes.push(cause.message);
  }
  if (codes.some(code => /ENOTFOUND|EAI_AGAIN|EAI_FAIL/.test(code))) return 'DNS_RESOLUTION_FAILED';
  if (codes.some(code => /CERT_|CERTIFICATE|TLS_|SSL_|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO/.test(code))) return 'TLS_VERIFY_FAILED';
  if (codes.some(code => /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(code))) return 'CONNECTION_TIMEOUT';
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'NETWORK_UNREACHABLE';
}
export async function requestCandidates<T>(record: { endpoint: string; endpointCandidates?: EndpointCandidate[] }, request: (endpoint: string) => Promise<T>): Promise<{ value: T; endpoint: string }> {
  let lastError: unknown;
  for (const candidate of normalizeEndpointCandidates(record.endpoint, record.endpointCandidates)) {
    try { return { value: await request(candidate.url), endpoint: candidate.url }; }
    catch (error) {
      lastError = error;
      // Retry only transport failures. Authentication, fencing, input and HTTP
      // protocol rejection cannot be repaired by silently selecting another host.
      if (!['DNS_RESOLUTION_FAILED', 'TLS_VERIFY_FAILED', 'CONNECTION_TIMEOUT', 'NETWORK_UNREACHABLE', 'FEDERATION_HTTP_502', 'FEDERATION_HTTP_503', 'FEDERATION_HTTP_504'].includes(connectionError(error))) throw error;
    }
  }
  throw lastError;
}
export function sameEndpointContext(local: Doc<'federationIdentity'>, remote: Doc<'federationPeers'>, current: { identity: Doc<'federationIdentity'> | null; peer: Doc<'federationPeers'> | null }) {
  const a = current.identity, b = current.peer;
  return !!a && !!b && a.townId === local.townId && a.publicKey === local.publicKey && a.mode === local.mode &&
    a.deploymentInstanceId === local.deploymentInstanceId && a.deploymentEpoch === local.deploymentEpoch &&
    endpointGeneration(a) === endpointGeneration(local) && a.endpoint === local.endpoint &&
    b.townId === remote.townId && b.publicKey === remote.publicKey && b.trustState === remote.trustState &&
    b.deploymentInstanceId === remote.deploymentInstanceId && b.deploymentEpoch === remote.deploymentEpoch &&
    b.credentialId === remote.credentialId && endpointGeneration(b) === endpointGeneration(remote) && b.endpoint === remote.endpoint;
}
export function endpointContextKey(local: Doc<'federationIdentity'>, remote: Doc<'federationPeers'>) {
  return JSON.stringify([local.townId, local.publicKey, local.mode, local.deploymentInstanceId, local.deploymentEpoch, local.endpoint, endpointGeneration(local),
    remote.townId, remote.publicKey, remote.trustState, remote.deploymentInstanceId, remote.deploymentEpoch, remote.endpoint, endpointGeneration(remote), remote.credentialId]);
}
// Rotation/migration control protocols perform their own signed successor-key
// challenges. An old-key transport probe cannot replace those proofs.
export async function directControlRequest(ctx: Pick<ActionCtx, 'runQuery' | 'runAction'>, local: Doc<'federationIdentity'>, remote: Doc<'federationPeers'>, path: string, body: unknown) {
  return requestCandidates(remote, async endpoint => {
    const current = await ctx.runQuery(queryRef('store/context'), { peerTownId: remote.townId });
    if (!sameEndpointContext(local, remote, current)) throw new Error('ENDPOINT_UPDATE_CONTEXT_CHANGED');
    return directRequest(ctx, endpoint, path, body, configuredTimePolicy(local).requestTimeoutMs);
  });
}
// An alternate route is challenged before delivering business/control packets.
// These outbound checks never substitute for the independent inbound probe.
export async function directPeerRequest(ctx: Pick<ActionCtx, 'runQuery' | 'runMutation' | 'runAction'>, local: Doc<'federationIdentity'>, remote: Doc<'federationPeers'>, path: string, body: unknown) {
  const assertCurrent = async () => {
    const current = await ctx.runQuery(queryRef('store/context'), { peerTownId: remote.townId });
    if (!sameEndpointContext(local, remote, current)) throw new Error('ENDPOINT_UPDATE_CONTEXT_CHANGED');
  };
  return requestCandidates(remote, async endpoint => {
    await assertCurrent();
    if (path !== '/probe' && endpoint !== remote.endpoint) {
      const nonce = crypto.randomUUID();
      const probe: FederationMessage = { protocol: PROTOCOL, type: 'TRANSPORT_PROBE', messageId: crypto.randomUUID(),
        fromTownId: local.townId, toTownId: remote.townId, senderDeploymentInstanceId: local.deploymentInstanceId,
        senderDeploymentEpoch: local.deploymentEpoch, expectedRecipientDeploymentEpoch: remote.deploymentEpoch,
        credentialId: remote.credentialId, sentAt: Date.now(), expiresAt: Date.now() + 30_000, nonce,
        payload: { probeId: crypto.randomUUID(), nonce } };
      const ack = await directRequest(ctx, endpoint, '/probe', await signPacket(probe, local.privateKeyEncrypted, remote.credentialEncrypted), configuredTimePolicy(local).requestTimeoutMs);
      await observeSignedIdentity(ctx, ack, 'ACK');
      const b = ack?.body;
      if (!b || !await verifyPacket(ack, remote.publicKey, remote.credentialEncrypted) || b.protocol !== PROTOCOL || b.type !== 'TRANSPORT_PROBE_ACK' ||
        b.fromTownId !== remote.townId || b.toTownId !== local.townId || b.senderDeploymentInstanceId !== remote.deploymentInstanceId ||
        b.senderDeploymentEpoch !== remote.deploymentEpoch || b.expectedRecipientDeploymentEpoch !== local.deploymentEpoch ||
        b.credentialId !== remote.credentialId || b.messageId !== probe.messageId || b.probeId !== probe.payload.probeId ||
        b.nonce !== nonce || !Number.isFinite(b.expiresAt) || b.expiresAt <= Date.now() || b.expiresAt > probe.expiresAt)
        throw new Error('ENDPOINT_IDENTITY_UNVERIFIED');
      await assertCurrent();
    }
    const value = await directRequest(ctx, endpoint, path, body, configuredTimePolicy(local).requestTimeoutMs);
    await assertCurrent();
    return value;
  });
}
async function boundedJson(body: ReadableStream<Uint8Array> | null, contentLength: string | null): Promise<any> {
  if (Number(contentLength) > MESSAGE_MAX_BYTES) throw new Error('MESSAGE_TOO_LARGE');
  if (!body) throw new Error('EMPTY_MESSAGE');
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MESSAGE_MAX_BYTES) { await reader.cancel(); throw new Error('MESSAGE_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('INVALID_REMOTE_RESPONSE'); }
}
export async function directRequest(ctx: Pick<ActionCtx, 'runAction'>, endpoint: string, path: string, body?: unknown, timeoutMs = 8000): Promise<any> {
  const base = normalizeEndpoint(endpoint);
  if (!['/health', '/pair', '/probe', '/messages', '/migration', '/peers/endpoints', '/peers/rotate-auth', '/peers/identity-key'].includes(path)) throw new Error('INVALID_FEDERATION_PATH');
  const data = body === undefined ? undefined : JSON.stringify(body);
  if (data && new TextEncoder().encode(data).byteLength > MESSAGE_MAX_BYTES) throw new Error('MESSAGE_TOO_LARGE');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new Error('INVALID_REQUEST_TIMEOUT');
  const response = await ctx.runAction(actionRef('nodeNetworkRequest/send'), { endpoint: base, path, ...(data === undefined ? {} : { data }), timeoutMs });
  if (!response.ok) throw new Error(response.error);
  if (response.status < 200 || response.status >= 300) throw new Error(`FEDERATION_HTTP_${response.status}`);
  if (new TextEncoder().encode(response.text).byteLength > MESSAGE_MAX_BYTES) throw new Error('MESSAGE_TOO_LARGE');
  try { return JSON.parse(response.text); }
  catch { throw new Error('INVALID_REMOTE_RESPONSE'); }
}
export async function readRequest(request: Request): Promise<any> {
  return boundedJson(request.body, request.headers.get('content-length'));
}
