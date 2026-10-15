# Federation TLS proxy

This dependency-free Node.js 20+ process terminates HTTPS for fixed local HTTP
backends. It can serve both federation endpoints in one detached container.
Federation clients must keep HTTPS certificate verification enabled and trust the
operator's certificate authority. This proxy does not change client network policy
or provide authentication; the backend still validates federation signatures.

Create an external JSON file, outside the repository, containing file paths rather
than certificate or private-key contents. Paths are resolved inside the container:

```json
{
  "certPath": "/run/federation/cert.pem",
  "keyPath": "/run/federation/key.pem",
  "routes": [
    { "listenPort": 3432, "upstream": "http://host.docker.internal:3423" },
    { "listenPort": 3434, "upstream": "http://host.docker.internal:3425" }
  ]
}
```

Keep the JSON, certificate chain, and private key in an operator-controlled
directory with restricted permissions. Set `FEDERATION_TLS_PROXY_CONFIG` to the
JSON path. Each route optionally accepts `bindHost` (default `0.0.0.0`); ports must
be unique integers from 1 to 65535. Upstreams must be HTTP origins with hostname
`localhost`, `127.0.0.1`, `[::1]`, or `host.docker.internal`; credentials, paths,
query strings, and fragments are rejected. These are fixed deployment trust
decisions, never client-selected destinations. Container loopback points to the
container itself; use `host.docker.internal` for host backends. Keep the backend
ports private to the host/container network. The client-facing service only
accepts TLS 1.2+ and never falls back to plaintext.

From the repository root, set `FEDERATION_TLS_DIRECTORY` to the absolute external
directory containing `proxy.json`, `cert.pem`, and `key.pem`, then run:

```sh
docker run --detach --name federation-tls-proxy \
  --restart unless-stopped \
  --publish 3432:3432 --publish 3434:3434 \
  --add-host host.docker.internal:host-gateway \
  --mount "type=bind,src=$PWD/scripts/federation-tls-proxy.mjs,dst=/app/proxy.mjs,readonly" \
  --mount "type=bind,src=$FEDERATION_TLS_DIRECTORY,dst=/run/federation,readonly" \
  --env FEDERATION_TLS_PROXY_CONFIG=/run/federation/proxy.json \
  node:20-alpine node /app/proxy.mjs
```

Docker Desktop provides `host.docker.internal`; the explicit host mapping also
supports Linux Docker. Publish to a specific host interface if necessary. Use a
certificate whose SAN matches the HTTPS hostname/IP advertised by each town.
Pin the runtime image to an approved digest when required by deployment policy.
The container survives terminal closure and restarts after process/daemon failure;
`unless-stopped` preserves an explicit operator stop. Enable Docker daemon startup
after a host reboot as part of the host's own service setup.

```sh
docker logs --tail 20 federation-tls-proxy
docker stop --time 10 federation-tls-proxy
docker start federation-tls-proxy
```

SIGTERM/SIGINT stop accepting connections and allow active requests five seconds
to finish, then destroy remaining sockets. Restart the container after config or
certificate changes; they are loaded only at startup. A failed bind closes already
opened listeners and exits nonzero. Logs contain only listener ports and status
codes (`LISTENING`, HTTP status, or `START_FAILED`), without request paths, bodies,
headers, certificates, or key material.

The proxy streams request/response bytes, rewrites `Host` for the fixed upstream,
removes hop-by-hop headers and client-supplied forwarding headers, and rebuilds
`X-Forwarded-Proto: https` and `X-Forwarded-For` from the TLS connection. It does
not follow backend redirects or rewrite their `Location` headers. WebSocket and
CONNECT tunnels are unsupported. Requests have a 30-second total deadline;
unreachable upstreams return 502 and deadline expiry returns 504 before response
headers (otherwise the incomplete response is closed).

Run the socket tests locally (OpenSSL is needed only to create temporary test
certificates, which are deleted afterward):

```sh
node --test scripts/federation-tls-proxy.test.mjs
```
