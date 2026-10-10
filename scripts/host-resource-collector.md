The host resource collector samples real OS CPU counters over five seconds and memory bytes. Run it on the OS machine that hosts the Town services. `OS_HOST` means that machine; it does not measure a remote Convex cloud worker, a container CPU quota, or the collector process alone. CPU is busy time divided by total elapsed processor time. Linux memory usage is `MemTotal - MemAvailable`; other platforms use Node's `totalmem - freemem` OS counters. Cache accounting differs across operating systems, so determine thresholds with actual deployment measurements.

Read one sample without contacting or changing a Town:

```sh
node scripts/host-resource-collector.mjs --once
```

Authenticated reporting is opt-in. Configure a dedicated random `FEDERATION_RESOURCE_REPORT_TOKEN` of at least 32 characters in the Convex backend and the collector environment, distinct from the administrator token. Supply `CONVEX_URL`, `FEDERATION_TOWN_ID`, `FEDERATION_DEPLOYMENT_INSTANCE_ID`, and `FEDERATION_DEPLOYMENT_EPOCH` to the collector using your service's secret manager. Do not put secrets in shell arguments or source control. The collector accepts HTTPS or loopback HTTP. Keep collector and backend clocks synchronized; future-dated, replayed, out-of-order, older-than-30-second, or different-deployment readings are rejected. Restart the collector with the current identity after deployment failover or migration.

```sh
node scripts/host-resource-collector.mjs --report
```

Enable CPU and memory admission protection in the federation administrator panel or through `federation/resourceMonitoring:configureHostResources` with the administrator credential and `thresholds: { maxCpuPercent, maxMemoryPercent, maxSampleAgeMs }`. Percentages must be greater than zero and at most 100; sample age is 5–120 seconds. Thresholds equal to measured usage pause admissions. A missing, expired, or wrong-deployment sample also pauses new visitors and queue promotions while protection is enabled. Existing residents, visitors and safe lease/return traffic retain their behavior. `thresholds: null` explicitly disables hardware admission protection for compatibility with deployments without a co-located collector. Unavailable values remain `null` and are never presented as measured zero.

Samples are ephemeral and excluded from Town/resident backup exports. Resource threshold policy and audit records remain in backups. Restored deployment identities must receive fresh matching samples before hardware protection permits admission.

Local verification (2026-10-11): 114 tests across resource monitoring, resources, signed capacity, and visitor queue passed; five collector tests passed. Real OS samples were reported to the local B backend using a separate collector credential. Independent Ed25519 verification confirmed the public capacity packet carried the actual CPU and memory readings. CPU and memory thresholds each produced `DEGRADED`; a real incoming A-to-B visit was rejected with `HOST_RESOURCE_DEGRADED`. Unauthorized credentials, replayed samples, and wrong deployment reports were rejected. Expired readings became null and paused admission. Test thresholds were restored; A/B original residents remained at home. This proves the local OS-host collector path, not remote cloud-worker or container-quota measurements.
