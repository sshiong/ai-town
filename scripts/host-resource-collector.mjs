// Run this on the machine hosting the Town services. It measures that OS host,
// not a remote Convex cloud worker or an isolated container's quota.
import os from 'node:os';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

export function cpuSnapshot(cpus = os.cpus()) {
  if (!cpus.length) throw new Error('CPU_MEASUREMENT_UNAVAILABLE');
  return cpus.map(({ times }) => ({
    idle: times.idle, total: times.user + times.nice + times.sys + times.idle + times.irq,
  }));
}

export function cpuUsagePercent(before, after) {
  if (before.length !== after.length || !before.length) throw new Error('CPU_TOPOLOGY_CHANGED');
  let idle = 0, total = 0;
  for (let index = 0; index < before.length; index++) {
    const idleDelta = after[index].idle - before[index].idle;
    const totalDelta = after[index].total - before[index].total;
    if (!Number.isFinite(idleDelta) || !Number.isFinite(totalDelta) ||
        idleDelta < 0 || totalDelta <= 0 || idleDelta > totalDelta)
      throw new Error('INVALID_CPU_COUNTER_DELTA');
    idle += idleDelta;
    total += totalDelta;
  }
  return 100 * (total - idle) / total;
}

export function memoryReading(totalBytes, availableBytes) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !Number.isSafeInteger(availableBytes) ||
      availableBytes < 0 || availableBytes > totalBytes) throw new Error('MEMORY_MEASUREMENT_UNAVAILABLE');
  return { memoryTotalBytes: totalBytes, memoryUsedBytes: totalBytes - availableBytes };
}

export async function hostMemory() {
  if (process.platform === 'linux') {
    // MemAvailable includes reclaimable caches; MemFree alone overstates pressure.
    const info = await fs.readFile('/proc/meminfo', 'utf8');
    const total = /^MemTotal:\s+(\d+)\s+kB$/m.exec(info);
    const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info);
    if (!total || !available) throw new Error('MEMORY_MEASUREMENT_UNAVAILABLE');
    return memoryReading(Number(total[1]) * 1024, Number(available[1]) * 1024);
  }
  // Node's OS free memory counter is the explicitly defined non-Linux measure.
  return memoryReading(os.totalmem(), os.freemem());
}

export async function collectHostResources(intervalMs = 5000) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000)
    throw new Error('INVALID_SAMPLE_INTERVAL');
  const before = cpuSnapshot(), sampleStartedAt = Date.now();
  await pause(intervalMs);
  const after = cpuSnapshot(), memory = await hostMemory(), measuredAt = Date.now();
  if (measuredAt - sampleStartedAt < 1000 || measuredAt - sampleStartedAt > 60000)
    throw new Error('INVALID_SAMPLE_CLOCK_INTERVAL');
  return {
    scope: 'OS_HOST', sampleStartedAt, measuredAt,
    cpuPercent: cpuUsagePercent(before, after), ...memory,
  };
}

export function reportConfiguration(env = process.env) {
  const url = new URL(env.CONVEX_URL ?? '');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    throw new Error('RESOURCE_REPORT_REQUIRES_HTTPS_OR_LOOPBACK');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('INVALID_RESOURCE_REPORT_URL');
  const deploymentEpoch = Number(env.FEDERATION_DEPLOYMENT_EPOCH);
  if (!env.FEDERATION_TOWN_ID || !env.FEDERATION_DEPLOYMENT_INSTANCE_ID ||
      !Number.isSafeInteger(deploymentEpoch) || deploymentEpoch < 1 ||
      !env.FEDERATION_RESOURCE_REPORT_TOKEN || env.FEDERATION_RESOURCE_REPORT_TOKEN.length < 32)
    throw new Error('RESOURCE_REPORT_CONFIGURATION_REQUIRED');
  return {
    client: new ConvexHttpClient(url.origin, {
      logger: false,
      fetch: (input, options) => fetch(input, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(10000),
      }),
    }),
    credentials: {
      reportToken: env.FEDERATION_RESOURCE_REPORT_TOKEN, townId: env.FEDERATION_TOWN_ID,
      deploymentInstanceId: env.FEDERATION_DEPLOYMENT_INSTANCE_ID, deploymentEpoch,
    },
  };
}

async function main() {
  const flags = process.argv.slice(2);
  if (flags.some(flag => !['--once', '--report'].includes(flag))) throw new Error('UNKNOWN_COLLECTOR_OPTION');
  const reporting = flags.includes('--report') ? reportConfiguration() : null;
  const once = flags.includes('--once') || !reporting;
  do {
    try {
      const sample = await collectHostResources();
      if (reporting) {
        await reporting.client.mutation(makeFunctionReference('federation/resourceMonitoring:reportHostResources'),
          { ...sample, ...reporting.credentials });
        process.stdout.write('Host resource sample accepted.\n');
      } else process.stdout.write(`${JSON.stringify(sample)}\n`);
    } catch {
      // Client errors may include RPC arguments. Never log them or credentials.
      process.stderr.write('Host resource collection or authenticated report failed.\n');
      if (once) process.exitCode = 1;
      else await pause(5000);
    }
  } while (!once);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Host resource collector configuration is invalid.\n');
    process.exitCode = 1;
  });
}
