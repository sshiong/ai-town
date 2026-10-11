import type { EmbeddingEvidence } from './compatibility';
import { embeddingFingerprint, validateVector } from './compatibility';
import type { EmbeddingConfig } from '../util/llm';

export const CERTIFICATE_FRESHNESS_MS = 60_000;
export const OLLAMA_TRUST_BOUNDARY = 'The authorized provider reports accurate metadata and its administrator does not replace model tags during requests, including changing and restoring a tag between checks.';
export type TrustedOllamaProvider = { providerId: string; url: string; trustedModelManagement: true };
export type ObservedOllamaEvidence = {
  providerId: string; providerUrl: string; profileFingerprint: string;
  artifactDigest: string; metadataDigest: string; pipelineFingerprint: string;
  serviceVersion: string; dimensions: number;
};
export function trustedOllamaProvider(profile: Pick<EmbeddingEvidence, 'provider' | 'url'>): TrustedOllamaProvider | null {
  if (profile.provider !== 'ollama') return null;
  const raw = process.env.EMBEDDING_TRUSTED_OLLAMA_PROVIDERS;
  if (!raw) return null;
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { throw new Error('INVALID_EMBEDDING_PROVIDER_TRUST_CONFIGURATION'); }
  if (!Array.isArray(entries) || entries.length > 32) throw new Error('INVALID_EMBEDDING_PROVIDER_TRUST_CONFIGURATION');
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.providerId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(entry.providerId) ||
      typeof entry.url !== 'string' || entry.trustedModelManagement !== true)
      throw new Error('INVALID_EMBEDDING_PROVIDER_TRUST_CONFIGURATION');
    const url = new URL(entry.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      entry.url.endsWith('/') || seen.has(entry.url)) throw new Error('INVALID_EMBEDDING_PROVIDER_TRUST_CONFIGURATION');
    seen.add(entry.url);
  }
  return entries.find(entry => entry.url === profile.url) ?? null;
}
export async function evidenceDigest(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function pipelineFingerprint(profile: EmbeddingEvidence, serviceVersion: string, metadataDigest: string) {
  // This adapter deliberately preserves the existing API and preprocessing.
  // A future /api/embed adapter, truncation change or runtime upgrade creates a new pipeline.
  return JSON.stringify(['ollama-api-embeddings-v1', serviceVersion, metadataDigest,
    profile.preprocessingRevision, profile.queryPrefix, profile.documentPrefix, profile.normalization,
    profile.dimensions, 'cosine', 'modelMemoryVectors-exact-v1']);
}
export function evidenceConfig(profile: EmbeddingEvidence & { apiKeyEnv?: string }): EmbeddingConfig {
  if (profile.preprocessingRevision !== 'newline-to-space-v1' || profile.normalization !== 'none')
    throw new Error('UNSUPPORTED_EMBEDDING_PIPELINE');
  const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  if (profile.apiKeyEnv && !apiKey) throw new Error('MODEL_CREDENTIAL_MISSING');
  return { provider: 'ollama', url: profile.url, embeddingModel: profile.model,
    dimensions: profile.dimensions, queryPrefix: profile.queryPrefix, documentPrefix: profile.documentPrefix, apiKey };
}
async function metadataRequest(config: EmbeddingConfig, path: string, body?: unknown): Promise<any> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(config.url + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error('EMBEDDING_PROVIDER_METADATA_UNAVAILABLE');
    const text = await response.text();
    if (text.length > 262144) throw new Error('EMBEDDING_PROVIDER_METADATA_BUDGET');
    return JSON.parse(text);
  } catch { throw new Error('EMBEDDING_PROVIDER_METADATA_UNAVAILABLE'); }
  finally { clearTimeout(timer); }
}
export async function observeOllamaEvidence(profile: EmbeddingEvidence & { apiKeyEnv?: string }): Promise<ObservedOllamaEvidence> {
  const trust = trustedOllamaProvider(profile);
  if (!trust) throw new Error('EMBEDDING_PROVIDER_NOT_AUTHORIZED_FOR_COMPATIBILITY');
  const config = evidenceConfig(profile);
  const results = await Promise.allSettled([metadataRequest(config, '/api/tags'),
    metadataRequest(config, '/api/show', { model: profile.model }), metadataRequest(config, '/api/version'), metadataRequest(config, '/api/ps')]);
  if (results.some(result => result.status !== 'fulfilled')) throw new Error('EMBEDDING_PROVIDER_METADATA_UNAVAILABLE');
  const [tags, shown, version, running] = results.map(result => (result as PromiseFulfilledResult<any>).value);
  const model = tags.models?.find((row: any) => row.name === profile.model || row.model === profile.model);
  const dimensionValues = Object.entries(shown.model_info ?? {}).filter(([key]) => key.endsWith('.embedding_length')).map(([, value]) => value);
  if (!model || !/^[a-f0-9]{64}$/.test(model.digest ?? '') || typeof version.version !== 'string' || !version.version ||
    dimensionValues.length !== 1 || dimensionValues[0] !== profile.dimensions || !shown.capabilities?.includes('embedding'))
    throw new Error('EMBEDDING_PROVIDER_IDENTITY_UNVERIFIED');
  const loaded = running.models?.find((row: any) => row.name === profile.model || row.model === profile.model);
  if (loaded && loaded.digest !== model.digest) throw new Error('EMBEDDING_PROVIDER_RUNNING_DIGEST_MISMATCH');
  const metadataDigest = await evidenceDigest([shown.model_info, shown.details, shown.parameters ?? null,
    shown.template ?? null, shown.system ?? null]);
  return { providerId: trust.providerId, providerUrl: trust.url, profileFingerprint: embeddingFingerprint(profile),
    artifactDigest: model.digest, metadataDigest, serviceVersion: version.version, dimensions: profile.dimensions,
    pipelineFingerprint: pipelineFingerprint(profile, version.version, metadataDigest) };
}
export async function collectOllamaEvidence(profile: EmbeddingEvidence & { apiKeyEnv?: string }) {
  const before = await observeOllamaEvidence(profile);
  const text = 'Embedding space verification: a resident remembers a shared conversation.\nA different resident remembers another place.';
  const querySample = await fetchCertifiedOllamaEmbedding(profile, text, 'query');
  const documentSample = await fetchCertifiedOllamaEmbedding(profile, text, 'document');
  const after = await observeOllamaEvidence(profile);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('EMBEDDING_PROVIDER_CHANGED_DURING_VERIFICATION');
  return { ...after, querySample, documentSample };
}
export async function fetchCertifiedOllamaEmbedding(profile: EmbeddingEvidence & { apiKeyEnv?: string }, text: string, inputMode: 'query' | 'document') {
  const config = evidenceConfig(profile), prefix = inputMode === 'query' ? profile.queryPrefix : profile.documentPrefix;
  // Never pull or replace a missing model while operating a certified space.
  const result = await metadataRequest(config, '/api/embeddings', { model: profile.model, prompt: prefix + text.replace(/\n/g, ' ') });
  if (!Array.isArray(result.embedding)) throw new Error('INVALID_EMBEDDING_VECTOR');
  validateVector(result.embedding, profile.dimensions);
  return result.embedding as number[];
}
