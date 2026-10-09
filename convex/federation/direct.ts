import { MESSAGE_MAX_BYTES, normalizeEndpoint } from './protocol';
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
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function directRequest(endpoint: string, path: string, body?: unknown): Promise<any> {
  const base = normalizeEndpoint(endpoint);
  if (!['/health', '/pair', '/probe', '/messages', '/migration'].includes(path)) throw new Error('INVALID_FEDERATION_PATH');
  const data = body === undefined ? undefined : JSON.stringify(body);
  if (data && new TextEncoder().encode(data).byteLength > MESSAGE_MAX_BYTES) throw new Error('MESSAGE_TOO_LARGE');
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: data, redirect: 'error', signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`FEDERATION_HTTP_${response.status}`); }
    return await boundedJson(response.body, response.headers.get('content-length'));
  } finally { clearTimeout(timeout); }
}
export async function readRequest(request: Request): Promise<any> {
  return boundedJson(request.body, request.headers.get('content-length'));
}
