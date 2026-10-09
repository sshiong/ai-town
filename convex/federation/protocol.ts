export const PROTOCOL = 'ai-town-federation/1';
export const MESSAGE_MAX_BYTES = 64 * 1024;
export const CLOCK_SKEW_MS = 30_000;
export const PROBE_TTL_MS = 120_000;
export const GAP_WINDOW = 16;
export const GAP_TIMEOUT_MS = 30_000;
export const LEASE_SAFETY_MS = 60_000;
export type FederationMessage = {
  protocol: string; messageId: string; fromTownId: string; toTownId: string;
  senderDeploymentInstanceId: string; senderDeploymentEpoch: number;
  expectedRecipientDeploymentEpoch: number; type: string; payload: Record<string, any>;
  sentAt: number; expiresAt: number; nonce: string; credentialId: string;
  visitId?: string; agentGlobalId?: string; agentAuthorityEpoch?: number; visitLeaseVersion?: number;
  streamId?: string; sequence?: number; pairSessionId?: string;
};
export type SignedPacket<T = FederationMessage> = { body: T; signature: string; mac: string };
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('INVALID_JSON_VALUE');
}
export function normalizeEndpoint(input: string): string {
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  if (url.protocol !== 'https:') throw new Error('HTTP_AUTH_LIBRARY_UNAVAILABLE: HTTPS required');
  if (url.username || url.password || url.search || url.hash) throw new Error('INVALID_ENDPOINT');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]' || /^169\.254\./.test(host) || host.startsWith('[::ffff:7f') || host.startsWith('[::ffff:127.') || host === '0.0.0.0') throw new Error('ENDPOINT_NOT_ALLOWED');
  if (!['', '/', '/federation/v1', '/federation/v1/'].includes(url.pathname)) throw new Error('INVALID_ENDPOINT_PATH');
  return `${url.origin}/federation/v1`;
}
export function validateEnvelope(message: FederationMessage, now = Date.now()): void {
  if (!message || message.protocol !== PROTOCOL || ['messageId', 'fromTownId', 'toTownId', 'nonce', 'credentialId', 'senderDeploymentInstanceId', 'type'].some(field => typeof (message as any)[field] !== 'string' || !(message as any)[field] || (message as any)[field].length > 200)) throw new Error('INVALID_ENVELOPE');
  if (['visitId', 'agentGlobalId', 'streamId', 'pairSessionId'].some(field => (message as any)[field] !== undefined && (typeof (message as any)[field] !== 'string' || !(message as any)[field] || (message as any)[field].length > 300))) throw new Error('INVALID_ENVELOPE');
  if (!Number.isSafeInteger(message.senderDeploymentEpoch) || message.senderDeploymentEpoch < 1 || !Number.isSafeInteger(message.expectedRecipientDeploymentEpoch) || message.expectedRecipientDeploymentEpoch < 1) throw new Error('INVALID_DEPLOYMENT_EPOCH');
  if (!Number.isFinite(message.sentAt) || !Number.isFinite(message.expiresAt) || message.sentAt > now + CLOCK_SKEW_MS || message.expiresAt <= now || message.expiresAt > now + 10 * 60_000) throw new Error('MESSAGE_EXPIRED');
  if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) throw new Error('INVALID_PAYLOAD');
  if (new TextEncoder().encode(canonicalJson(message)).byteLength > MESSAGE_MAX_BYTES) throw new Error('MESSAGE_TOO_LARGE');
  if (message.type === 'TRANSPORT_PROBE') {
    if (message.visitId !== undefined || message.agentGlobalId !== undefined || message.agentAuthorityEpoch !== undefined || message.visitLeaseVersion !== undefined || message.streamId !== undefined || message.sequence !== undefined) throw new Error('PROBE_MUST_NOT_HAVE_VISIT');
    if (Object.keys(message.payload).some((key) => !['probeId', 'nonce'].includes(key)) || (typeof message.payload.probeId !== 'string' || !message.payload.probeId || message.payload.probeId.length > 200) || message.payload.nonce !== message.nonce) throw new Error('INVALID_PROBE_PAYLOAD');
  } else {
    if (['STREAM_NACK', 'SESSION_RESYNC'].includes(message.type)) {
      if (!message.visitId || !message.agentGlobalId || !Number.isSafeInteger(message.agentAuthorityEpoch) || message.agentAuthorityEpoch! < 1 || !Number.isSafeInteger(message.visitLeaseVersion) || message.visitLeaseVersion! < 1 || message.sequence !== undefined || message.streamId !== undefined) throw new Error('INVALID_CONTROL_ENVELOPE');
      return;
    }
    if (!message.visitId || !message.agentGlobalId || !Number.isSafeInteger(message.agentAuthorityEpoch) || message.agentAuthorityEpoch! < 1 || !Number.isSafeInteger(message.visitLeaseVersion) || message.visitLeaseVersion! < 1 || !message.streamId || !Number.isSafeInteger(message.sequence) || message.sequence! < 1) throw new Error('INVALID_VISIT_ENVELOPE');
  }
}
export function streamKey(message: FederationMessage, peerTownId: string): string {
  return canonicalJson([peerTownId, message.visitId ?? message.pairSessionId, message.streamId, message.fromTownId, message.senderDeploymentEpoch]);
}
export function sequenceDisposition(sequence: number, expected: number): 'commit' | 'stale' | 'buffer' | 'resync' {
  if (sequence === expected) return 'commit';
  if (sequence < expected) return 'stale';
  return sequence - expected <= GAP_WINDOW ? 'buffer' : 'resync';
}
