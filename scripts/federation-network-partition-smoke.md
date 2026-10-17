# Dedicated real network partition acceptance

`federation-network-partition-smoke.mjs` drives two **dedicated, disposable** local
Convex towns through their real APIs and HTTPS ingress. It never changes Docker
networks, kills containers, modifies settings/model bindings, or targets a default
backend. Docker is used only for `inspect`. Do not point it at user M/N.

The runner covers:

1. Cut Host -> Home ingress, keep Home -> Host open, run actual authenticated
   probes, wait out Home's prior readiness freshness window, then require
   `DIRECT_PEER_NOT_MUTUALLY_REACHABLE` for a new visit and unchanged presence.
2. Create a real ACTIVE visitor, cut both ingresses (including existing sockets),
   request return through Home's separate admin API, and poll both worlds.
   Home must stay absent until the **latest persisted** `returnSafety.safeAfter`;
   Host's body must disappear after expiry; original player/agent identity returns.
   This is lease expiry safety with both backends alive, not a crash test.
3. Hold the original signed Home -> Host `VISIT_CONFIRM` bytes in memory and drop
   its retries. Keep Host -> Home cut so no cleanup ACK can shorten the exercise.
   After the original lease expires, deliver the captured bytes directly to the
   same fixed Host HTTP-action upstream. Require its captured envelope expiry to
   remain after the lease test, record the Host ledger state before replay, and
   require actual HTTP 400 with
   `VISIT_LEASE_EXPIRED`, and no Host body. A generic 400, MESSAGE_EXPIRED, success
   ACK or ledger-only observation does not pass this scenario.

A passing report contains separate cross-town samples, not an atomic distributed
snapshot. It does not claim all late actions, malicious peers, arbitrary NAT,
clock drift or long-term availability were tested.

## Provisioning contract

Create two new labs and initialize/pair them beforehand through normal APIs. Use
synchronized UTC on host/backends (same Docker host is recommended). Provide at
least one Home resident, running engines, federation enabled, healthy clock, no
humans/visitors/active visits, capacity available and no other trusted peers.
Keep autonomous travel disabled and the labs otherwise quiet. Use a lease at most
300,000 ms so the captured 10-minute signed envelope remains valid when the lease
expires. The runner reads the actual configured freshness and safe-return times;
it does not reduce them. Every SDK RPC has its own 30-second fetch deadline,
and SDK function logging is disabled to keep private server diagnostics out of
console output. With default policy this can take over 15 minutes.

Names must be `aitown-federation-network-partition-lab-<labId>-home` and `...-host`.
Both containers require labels:

- `ai-town.federation-fault-lab=<labId>`
- `ai-town.federation-fault-role=home` or `host`
- `ai-town.federation-town-id=<actual initialized townId>`

API and HTTP-action ports must both be published to loopback only, without any
other public port binding. Container host networking is refused. Every local and
peer advertised endpoint/candidate must be the corresponding explicit HTTPS gate
endpoint, with no bypass route. Each backend must already trust that gate's CA
and allow its precise destination under the normal federation network policy.

Use the existing `federation-tls-proxy.mjs` on the two intended gate ports while
pairing. Stop that **dedicated** proxy before running this script so it can own
the same listeners; do not stop a user gateway. Config and CA/key files belong
outside Git. All six API/action/gate ports must differ. Example shape (replace
all identity/credential/path values with the dedicated lab's actual values):

```json
{
  "dedicatedNetworkPartitionLab": true,
  "labId": "acceptance",
  "towns": [
    {
      "role": "home",
      "containerName": "aitown-federation-network-partition-lab-acceptance-home",
      "townId": "actual-home-town-id",
      "deploymentInstanceId": "actual-home-instance-id",
      "deploymentEpoch": 1,
      "url": "http://127.0.0.1:3540",
      "adminKey": "private-home-admin-key",
      "adminToken": "private-home-admin-token",
      "gate": {
        "upstream": "http://127.0.0.1:3541",
        "endpoint": "https://host.docker.internal:3544/federation/v1",
        "listenPort": 3544,
        "bindHost": "0.0.0.0",
        "certPath": "/absolute/private/lab-cert.pem",
        "keyPath": "/absolute/private/lab-key.pem"
      }
    },
    {
      "role": "host",
      "containerName": "aitown-federation-network-partition-lab-acceptance-host",
      "townId": "actual-host-town-id",
      "deploymentInstanceId": "actual-host-instance-id",
      "deploymentEpoch": 1,
      "url": "http://127.0.0.1:3542",
      "adminKey": "private-host-admin-key",
      "adminToken": "private-host-admin-token",
      "gate": {
        "upstream": "http://127.0.0.1:3543",
        "endpoint": "https://host.docker.internal:3545/federation/v1",
        "listenPort": 3545,
        "bindHost": "0.0.0.0",
        "certPath": "/absolute/private/lab-cert.pem",
        "keyPath": "/absolute/private/lab-key.pem"
      }
    }
  ]
}
```

Set the config to mode 0600, owned by the current user, no symlink, <=64 KiB.
The report must be a **new absolute filename outside the repository**, with an
existing external parent directory. No report path means no run.

```sh
FEDERATION_NETWORK_PARTITION_CONFIG=/absolute/private/network-lab.json \
FEDERATION_FAULT_REPORT=/absolute/private/network-result.json \
node scripts/federation-network-partition-smoke.mjs
```

Reports are mode 0600, synced at checkpoints and finally, and contain only IDs,
times, counts and protocol codes. No packet bodies, signatures, private keys,
credentials, model replies or unrelated world state are persisted. No data hashes
are calculated. The captured envelope expiry and pre-replay Host ledger state
are retained as metadata. The late packet is bounded to 64 KiB, remains in memory only and
is discarded/zeroed on replay or gate shutdown.

Exceptions and SIGINT/SIGTERM enter `finally`: release both directions, return
only the runner's own resident visit (including a start whose response was lost),
wait for original identity/body and Host capacity cleanup, refresh probes, then
close owned listeners. A cleanup error fails the report and requires inspection
of the dedicated labs; it is never reported as success. An external SIGKILL or
host crash cannot execute finally. The runner closes its temporary gateways; if
reusing the labs, restart their normal dedicated ingress before expecting Ready.
After acceptance delete only this run's exact disposable containers/volumes,
network and private temporary data after checking references; retain the compact
sanitized result. The runner does not delete provisioning resources it did not
create and never runs Docker prune.

## Safe local verification

```sh
node --check scripts/federation-network-partition-gate.mjs
node --check scripts/federation-network-partition-smoke.mjs
node --test scripts/federation-network-partition-smoke.test.mjs
```

These deterministic tests do not start sockets, Docker or real towns. They verify
configuration guards, fault orchestration, dynamic deadlines, rejected late
responses, valid envelope lifetime, terminal Host ledger metadata, per-RPC
deadlines/log suppression, lost start responses, interrupts and cleanup/report
failures. Passing
them is not evidence that the three real partition scenarios have run.


The current product path signs outbox envelopes for 10 minutes (`queue.ts`).
`transport.acceptMessage` validates the envelope, then calls
`ledger.assertVisitAuthority` before stream disposition and lifecycle dispatch.
That authority function checks the lease even when the Host ledger has already
become COMPLETED after reservation cleanup. Thus a held first delivery with a
still-valid envelope can reach VISIT_LEASE_EXPIRED after Host reconciliation.
The runner does not count MESSAGE_EXPIRED or a generic terminal-state response
as proof of that guard; either fails this specific lease scenario. This call-path
review and deterministic orchestration coverage are not a real deployment test.
