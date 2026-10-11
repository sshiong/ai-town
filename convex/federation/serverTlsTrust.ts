'use node';

import { X509Certificate } from 'node:crypto';
import { createSecureContext, rootCertificates, type ConnectionOptions } from 'node:tls';

/** Additional trust is server configuration only. It never changes certificate
 * identity checks or the destination address policy. */
export function serverTlsTrust(): Pick<ConnectionOptions, 'ca'> {
  const pem = process.env.FEDERATION_EXTRA_CA_CERTS_PEM;
  if (!pem) return {};
  if (Buffer.byteLength(pem) > 65_536) throw new Error('TLS_EXTRA_CA_CERTS_TOO_LARGE');
  try {
    const certificates = pem.match(
      /-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g,
    );
    if (
      !certificates?.length ||
      pem
        .replace(
          /-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g,
          '',
        )
        .trim()
    )
      throw new Error();
    for (const certificate of certificates) new X509Certificate(certificate);
    createSecureContext({ ca: certificates });
    return { ca: [...rootCertificates, ...certificates] };
  } catch {
    // OpenSSL errors can contain configuration details; expose only a fixed code.
    throw new Error('TLS_INVALID_EXTRA_CA_CERTS');
  }
}
