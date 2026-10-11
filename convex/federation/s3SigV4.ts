'use node';
import { createHash, createHmac } from 'node:crypto';
import type { S3Configuration } from './coldArchivePolicy';
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export function s3Path(bucket: string, key?: string) {
  return `/${encode(bucket)}${key ? `/${key.split('/').map(encode).join('/')}` : ''}`;
}
export function signS3Request(
  c: S3Configuration,
  method: 'GET' | 'PUT',
  key?: string,
  body = '',
  query = '',
  now = new Date(),
) {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, ''),
    day = date.slice(0, 8);
  const path = s3Path(c.bucket, key),
    payloadHash = sha256(body);
  const headers: Record<string, string> = {
    host: new URL(c.endpoint).host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': date,
  };
  if (c.sessionToken) headers['x-amz-security-token'] = c.sessionToken;
  const names = Object.keys(headers).sort(),
    signedHeaders = names.join(';');
  const canonicalHeaders = names
    .map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join(
    '\n',
  );
  const credentialScope = `${day}/${c.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const hmac = (secret: string | Buffer, value: string) =>
    createHmac('sha256', secret).update(value).digest();
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, day), c.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    path: `${path}${query ? `?${query}` : ''}`,
    headers,
    canonicalRequest,
    stringToSign,
    signature,
  };
}
