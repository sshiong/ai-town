// Only names configured on the server can become destinations. No archive or
// browser-supplied URL is ever interpreted as an outbound request target.
export type S3Configuration = {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};
export type S3Destination = Pick<
  S3Configuration,
  'name' | 'endpoint' | 'region' | 'bucket' | 'prefix'
>;
export function s3Configurations(raw = process.env.COLD_ARCHIVE_S3_CONFIG): S3Configuration[] {
  if (!raw) return [];
  try {
    const values: S3Configuration[] = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > 16) throw new Error();
    const names = new Set<string>();
    for (const c of values) {
      const url = new URL(c.endpoint);
      if (
        !/^[a-zA-Z0-9_-]{1,64}$/.test(c.name) ||
        names.has(c.name) ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        c.endpoint !== url.origin ||
        !/^[a-z0-9-]{1,64}$/.test(c.region) ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.bucket) ||
        c.bucket.includes('..') ||
        typeof c.prefix !== 'string' ||
        !/^[a-zA-Z0-9/_-]{0,200}$/.test(c.prefix) ||
        c.prefix.startsWith('/') ||
        c.prefix.endsWith('/') ||
        c.prefix.includes('//') ||
        typeof c.accessKeyId !== 'string' ||
        !/^[A-Za-z0-9]{1,128}$/.test(c.accessKeyId) ||
        typeof c.secretAccessKey !== 'string' ||
        c.secretAccessKey.length < 16 ||
        c.secretAccessKey.length > 1000 ||
        /[\r\n\u0000]/.test(c.secretAccessKey) ||
        (c.sessionToken !== undefined &&
          (typeof c.sessionToken !== 'string' ||
            !c.sessionToken ||
            c.sessionToken.length > 10000 ||
            /[\r\n\u0000]/.test(c.sessionToken)))
      )
        throw new Error();
      names.add(c.name);
    }
    return values;
  } catch {
    throw new Error('INVALID_COLD_ARCHIVE_SERVER_CONFIG');
  }
}
export function destination(c: S3Configuration): S3Destination {
  const { name, endpoint, region, bucket, prefix } = c;
  return { name, endpoint, region, bucket, prefix };
}
export function configuredS3(name: string) {
  const c = s3Configurations().find((value) => value.name === name);
  if (!c) throw new Error('COLD_ARCHIVE_CREDENTIALS_NOT_CONFIGURED');
  return c;
}
export function mirrorKey(prefix: string, scope: string, runId: string, index: number | 'root') {
  if (
    !/^[a-zA-Z0-9_-]+$/.test(scope) ||
    !/^[a-zA-Z0-9_-]+$/.test(runId) ||
    (index !== 'root' && (!Number.isSafeInteger(index) || index < 0))
  )
    throw new Error('INVALID_COLD_ARCHIVE_OBJECT');
  return `${prefix ? `${prefix}/` : ''}ai-town/${scope}/${runId}/${index === 'root' ? 'root' : `part-${index}`}.json`;
}
export async function rawSha256(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
export function safeArchiveError(error: unknown) {
  const value = error instanceof Error ? error.message : '';
  return /^(COLD_ARCHIVE_|INVALID_COLD_|ENDPOINT_|PRIVATE_ENDPOINT_|DNS_|TLS_|CONNECTION_|NETWORK_|S3_)[A-Z0-9_]+$/.test(
    value,
  )
    ? value
    : 'COLD_ARCHIVE_OPERATION_FAILED';
}
