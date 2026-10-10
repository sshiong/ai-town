import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuSnapshot, cpuUsagePercent, memoryReading, reportConfiguration } from './host-resource-collector.mjs';
import { makeFunctionReference } from 'convex/server';

test('CPU is measured from elapsed counters across all processors, not load average', () => {
  const before = [{ idle: 100, total: 200 }, { idle: 100, total: 200 }];
  const after = [{ idle: 150, total: 300 }, { idle: 125, total: 300 }];
  assert.equal(cpuUsagePercent(before, after), 62.5);
  assert.deepEqual(cpuSnapshot([{ times: { user: 10, nice: 2, sys: 3, idle: 20, irq: 1 } }]),
    [{ idle: 20, total: 36 }]);
});
test('CPU topology changes and invalid counters cannot generate a healthy reading', () => {
  assert.throws(() => cpuSnapshot([]), /CPU_MEASUREMENT_UNAVAILABLE/);
  assert.throws(() => cpuUsagePercent([{ idle: 1, total: 2 }], []), /CPU_TOPOLOGY_CHANGED/);
  for (const after of [{ idle: 1, total: 2 }, { idle: 0, total: 3 }, { idle: 5, total: 3 }, { idle: 2, total: NaN }])
    assert.throws(() => cpuUsagePercent([{ idle: 1, total: 2 }], [after]), /INVALID_CPU_COUNTER_DELTA/);
});
test('memory uses actual available bytes and never substitutes zero for a failed read', () => {
  assert.deepEqual(memoryReading(1000, 250), { memoryTotalBytes: 1000, memoryUsedBytes: 750 });
  for (const [total, available] of [[0, 0], [1000, -1], [1000, 1001], [NaN, 0], [1000, NaN]])
    assert.throws(() => memoryReading(total, available), /MEMORY_MEASUREMENT_UNAVAILABLE/);
});

const configuration = {
  CONVEX_URL: 'http://127.0.0.1:3210', FEDERATION_TOWN_ID: 'fixture-town',
  FEDERATION_DEPLOYMENT_INSTANCE_ID: 'fixture-instance', FEDERATION_DEPLOYMENT_EPOCH: '1',
  FEDERATION_RESOURCE_REPORT_TOKEN: 'fixture-collector-credential-32characters',
};
test('reporting requires HTTPS or loopback and current deployment configuration', () => {
  for (const CONVEX_URL of ['http://public.example', 'http://192.168.1.1'])
    assert.throws(() => reportConfiguration({ ...configuration, CONVEX_URL }), /REQUIRES_HTTPS_OR_LOOPBACK/);
  for (const CONVEX_URL of ['https://user:password@example.com', 'https://example.com/path', 'https://example.com?key=1'])
    assert.throws(() => reportConfiguration({ ...configuration, CONVEX_URL }), /INVALID_RESOURCE_REPORT_URL/);
  for (const patch of [{ FEDERATION_TOWN_ID: '' }, { FEDERATION_DEPLOYMENT_EPOCH: '0' },
    { FEDERATION_DEPLOYMENT_INSTANCE_ID: '' }, { FEDERATION_RESOURCE_REPORT_TOKEN: 'short' }])
    assert.throws(() => reportConfiguration({ ...configuration, ...patch }), /RESOURCE_REPORT_CONFIGURATION_REQUIRED/);
});
test('report RPC normalizes URL and sets a bounded no-redirect transport', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ status: 'success', value: null }));
  };
  try {
    const report = reportConfiguration(configuration);
    await report.client.mutation(makeFunctionReference('federation/resourceMonitoring:reportHostResources'),
      { ...report.credentials, cpuPercent: 10 });
    assert.equal(request.url, 'http://127.0.0.1:3210/api/mutation');
    assert.equal(request.options.redirect, 'error');
    assert.ok(request.options.signal instanceof AbortSignal);
    assert.equal(JSON.parse(request.options.body).path, 'federation/resourceMonitoring:reportHostResources');
  } finally { globalThis.fetch = originalFetch; }
});
