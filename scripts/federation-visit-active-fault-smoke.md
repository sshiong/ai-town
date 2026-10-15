# VISIT_ACTIVE loss and Host restart acceptance

This destructive runner is only for two newly provisioned, dedicated local
Docker test towns. It is **not directly runnable against existing M/N towns**.
It does not provision containers, pair towns, change TLS trust, configure town
settings, change model bindings, or attach to the production TLS proxy.

The real network scenario drops Host's signed `VISIT_ACTIVE` HTTP request before
Home receives it, after Host's actual visitor has committed. Home must remain
`CONFIRMING`. The runner kills and restarts Host, requires another drop of the
same persisted message ID, releases the gate, waits for that message's committed
inbox and acknowledged outbox, then normally returns the original resident.
Dropping only an HTTP `MESSAGE_ACK` response is a different scenario.

## Dedicated lab prerequisites

- Container names must be exactly
  `aitown-federation-visit-active-lab-<labId>-home` and
  `aitown-federation-visit-active-lab-<labId>-host`.
- Each container needs labels `ai-town.federation-fault-lab=<labId>`,
  `ai-town.federation-fault-role=home|host`, and
  `ai-town.federation-town-id=<actual-townId>`.
- Both containers must already be running. API ports, and Home's HTTP-action
  port used by the gate upstream, must be published on `127.0.0.1` or `::1`.
  The runner verifies their Docker bindings and pins the immutable container IDs.
  Host networking is rejected.
- Towns must be enabled, have healthy clocks, be in `ACTIVE` deployment mode,
  and have an effective `settings.timePolicy.leaseMs` of at least 180,000 ms.
  The ordinary 300,000 ms lease provides more restart/retry time.
- No visits/reservations or traveling residents may exist at startup. At least
  one Home resident must already be initialized. The two towns must trust each
  other and have no additional trusted peers. Keep this isolated lab quiet and
  disable independently initiated travel before running.
- Home's advertised endpoint and **all** Home endpoint candidates stored both
  locally and at Host must equal `gate.endpoint`. No alternate route may bypass
  the gate. Host's own HTTPS endpoint must already work independently.
- Host's federation network runtime must already trust the certificate authority
  signing the gate certificate; its SAN must match the advertised hostname.
  For Docker access through `host.docker.internal`, bind the gate to `0.0.0.0`
  explicitly and use a dedicated port. Restrict access to this lab listener.

## External configuration

Store this JSON **outside the repository**, owned by the current user, with
permissions exactly `0600`. Symbolic-link configuration files are rejected.
Replace the placeholders with the dedicated lab's real values; do not commit
keys, tokens, certificates, private configuration or acceptance reports.

```json
{
  "dedicatedVisitActiveFaultLab": true,
  "labId": "acceptance",
  "towns": [
    {
      "role": "home",
      "townId": "REPLACE_HOME_TOWN_ID",
      "deploymentInstanceId": "REPLACE_HOME_INSTANCE_ID",
      "deploymentEpoch": 1,
      "containerName": "aitown-federation-visit-active-lab-acceptance-home",
      "url": "http://127.0.0.1:3500",
      "adminKey": "REPLACE_HOME_ADMIN_KEY",
      "adminToken": "REPLACE_HOME_ADMIN_TOKEN"
    },
    {
      "role": "host",
      "townId": "REPLACE_HOST_TOWN_ID",
      "deploymentInstanceId": "REPLACE_HOST_INSTANCE_ID",
      "deploymentEpoch": 1,
      "containerName": "aitown-federation-visit-active-lab-acceptance-host",
      "url": "http://127.0.0.1:3502",
      "adminKey": "REPLACE_HOST_ADMIN_KEY",
      "adminToken": "REPLACE_HOST_ADMIN_TOKEN"
    }
  ],
  "gate": {
    "certPath": "/absolute/external/lab/cert.pem",
    "keyPath": "/absolute/external/lab/key.pem",
    "listenPort": 3504,
    "bindHost": "0.0.0.0",
    "upstream": "http://127.0.0.1:3501",
    "endpoint": "https://host.docker.internal:3504/federation/v1"
  }
}
```

`url` is the Convex API origin; `gate.upstream` is Home's distinct HTTP-action
origin. The gate runs in the host Node process. The example ports are reserved
only for a newly created lab; choose unused ports and configure Docker and town
endpoints consistently. `labId` allows lowercase letters, digits and hyphens,
up to 40 characters. Town array order must be Home then Host.

## Pairing and execution

Use Node 20+ from the repository root. Set the external config path:

```sh
export FEDERATION_VISIT_ACTIVE_FAULT_CONFIG=/absolute/external/lab/config.json
```

For first-time setup, temporarily start the same gate without arming drops:

```sh
node --input-type=module <<'JS'
import { readPrivateConfig } from './scripts/federation-visit-active-fault-smoke.mjs';
import { startVisitActiveFaultGate } from './scripts/federation-visit-active-fault-gate.mjs';
const config = await readPrivateConfig(process.env.FEDERATION_VISIT_ACTIVE_FAULT_CONFIG);
const gate = await startVisitActiveFaultGate({
  ...config.gate, homeTownId: config.towns[0].townId, hostTownId: config.towns[1].townId,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => gate.close());
JS
```

Pair the dedicated towns through their normal authenticated setup while this
listener runs. Verify mutual transport readiness, then stop the temporary gate
with Ctrl-C. The runner must take over that exact address and port; an existing
listener causes it to fail before starting a visit.

```sh
export FEDERATION_FAULT_REPORT=/absolute/external/lab/new-acceptance-report.json
node scripts/federation-visit-active-fault-smoke.mjs
```

The optional report path must not already exist. Success prints
`VISIT_ACTIVE_FAULT_PASSED` with the actual visit/message IDs. The report retains
drop metadata and presence checkpoints, never packets or credentials. Failure
prints a sanitized reason. `finally` releases the gate, attempts to restart only
the pinned dedicated Host when necessary, returns only this run's visit, waits
for cleanup and closes the gate. Inspect the dedicated lab after a failed run;
forced termination of the runner/host machine cannot guarantee `finally` runs.

The runner makes no settings or binding changes to restore. Closing the gate
leaves the dedicated Home endpoint without a listener, as it was before the run;
restart the unarmed temporary gate when continuing normal lab use.

## Validation and evidence limits

```sh
node --test scripts/federation-visit-active-fault-smoke.test.mjs
node --test scripts/federation-visit-active-fault-gate.test.mjs
```

The runner tests use a deterministic orchestration simulation; the gate tests
use real TLS sockets. Neither constitutes a real two-town acceptance run.
Only running the destructive runner against the dedicated Docker lab establishes
that result. `diagnostics` exposes only the latest 100 inbox/outbox rows; a quiet
lab is required to retain the exact-message evidence, otherwise the runner times
out. Cross-town world reads are sequential samples, not an atomic global proof.
The gate does not independently verify signatures; it drops selected raw bytes,
while forwarded traffic is authenticated by the actual federation backends.
