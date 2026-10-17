// Deterministic contract/orchestration tests. No Docker, sockets or town mutations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runNetworkPartitionSmoke, validatePartitionConfig, validatePartitionContainer, partitionClientOptions } from './federation-network-partition-smoke.mjs';

function fixture() {
  const config = { dedicatedNetworkPartitionLab: true, labId: 'acceptance', towns: ['home', 'host'].map((role, i) => ({
    role, townId: role, deploymentInstanceId: `instance-${role}`, deploymentEpoch: 1,
    containerName: `aitown-federation-network-partition-lab-acceptance-${role}`,
    adminKey: 'secret-key', adminToken: 'secret-token', url: `http://127.0.0.1:${3540 + 2*i}`,
    gate: { upstream: `http://127.0.0.1:${3541 + 2*i}`, certPath: '/lab/cert', keyPath: '/lab/key',
      endpoint: `https://lab.example:${3544+i}/federation/v1`, listenPort: 3544+i },
  })) };
  let time = 1000, visit, phase = 'idle', starts = 0, saved = [], blockedSince;
  const resident = { playerId: 'p:1', agentId: 'a:1', agentGlobalId: 'home/alice', worldId: 'world-home', state: 'HOME_ACTIVE' };
  const gates = ['home', 'host'].map(() => ({ mode: 'open', closed: false, blocked: 0, held: null,
    setMode(mode) { this.mode = mode; if (mode === 'blocked') { this.blocked++; blockedSince = time; } },
    get evidence() { return { blocked: this.blocked, held: this.held }; },
    async deliverHeld() { const held = this.held; this.held = null;
      return { ...held, status: 400, reason: 'VISIT_LEASE_EXPIRED' }; },
    async close() { this.closed = true; this.held = null; },
  }));
  const inspect = town => {
    const bindings = { '3210/tcp': [{ HostIp: '127.0.0.1', HostPort: new URL(town.url).port }],
      '3211/tcp': [{ HostIp: '127.0.0.1', HostPort: new URL(town.gate.upstream).port }] };
    return { Name: `/${town.containerName}`, Id: (town.role === 'home' ? 'a' : 'b').repeat(64),
      State: { Running: true }, HostConfig: { NetworkMode: 'bridge', PortBindings: bindings },
      NetworkSettings: { Ports: bindings }, Config: { Labels: {
        'ai-town.federation-fault-lab': config.labId, 'ai-town.federation-fault-role': town.role,
        'ai-town.federation-town-id': town.townId,
      } } };
  };
  const returned = () => phase === 'returned' || (phase === 'partition' && time >= visit.safeAfter);
  const state = town => {
    const index = town.role === 'home' ? 0 : 1, other = config.towns[1-index];
    return { identity: { ...town, mode: 'ACTIVE', endpoint: town.gate.endpoint },
      settings: { enabled: true, clock: { healthy: true }, activeVisitsRemain: !!visit && !returned(),
        timePolicy: { leaseMs: 3000, probeFreshnessMs: 1000 } }, resources: { humans: 0 },
      capacity: { reserved: visit && !returned() ? 1 : 0 },
      peers: [{ townId: other.townId, endpoint: other.gate.endpoint, trustState: 'TRUSTED',
        channelState: gates[0].mode === 'blocked' && time >= blockedSince + 1000 ? 'TRANSPORT_TESTING' : 'TRANSPORT_READY' }],
      visits: visit ? [{ ...visit, state: returned() ? 'COMPLETED' : phase === 'held' ? (index ? 'RESERVED' : 'CONFIRMING') : 'ACTIVE',
        returnSafety: { safeAfter: visit.safeAfter, condition: 'WAITING_FOR_LEASE_AND_MARGIN' } }] : [],
    };
  };
  let gateIndex = 0;
  const ops = {
    now: () => time, pause: async ms => { time += ms; }, inspect: async town => inspect(town), status: async town => state(town),
    persist: async report => { saved.push(structuredClone(report)); },
    residents: async () => [{ ...resident, state: !visit || returned() ? 'HOME_ACTIVE' : 'TRAVELING' }],
    defaultWorld: async () => ({ worldId: 'world-host' }),
    world: async town => town.role === 'home' ? { players: !visit || returned() ? [{ id: resident.playerId }] : [], agents: [{ id: resident.agentId }] }
      : { players: visit && phase !== 'held' && !returned() ? [{ id: 'p:9', remoteVisitor: { agentGlobalId: resident.agentGlobalId } }] : [], agents: [] },
    probe: async town => ({ channelState: town.role === 'host' && gates[0].mode === 'blocked'
      ? 'PAIRED_BUT_NOT_REACHABLE' : 'TRANSPORT_READY' }),
    startVisit: async () => {
      if (gates[0].mode === 'blocked') throw new Error('backend: DIRECT_PEER_NOT_MUTUALLY_REACHABLE');
      starts++; visit = { visitId: `visit-${starts}`, agentGlobalId: resident.agentGlobalId, leaseExpiry: time+3000, safeAfter: time+5000 };
      phase = gates[1].mode === 'hold-confirm' ? 'held' : 'active';
      if (phase === 'held') gates[1].held = { visitId: visit.visitId, messageId: 'signed-confirm', expiresAt: time + 600_000 };
      return { visitId: visit.visitId };
    },
    returnVisit: async () => { phase = gates.every(gate => gate.mode === 'blocked') ? 'partition' : 'returned'; },
  };
  return { config, ops, gates, inspect, state, startGate: async () => gates[gateIndex++], get saved() { return saved; } };
}

test('no implicit targets, production containers, credentials omissions or overlapping ports', async () => {
  for (const change of [c => { delete c.dedicatedNetworkPartitionLab; }, c => { c.towns[1].containerName = 'aitown-N'; },
    c => { c.towns[1].url = 'https://production.example'; }, c => { c.towns[1].gate.listenPort = 3544; },
    c => { delete c.towns[0].adminToken; }]) {
    const f = fixture(); change(f.config);
    await assert.rejects(runNetworkPartitionSmoke(f.config, new Proxy({}, { get() { throw new Error('MUST_NOT_TOUCH_ENV'); } })));
  }
});

test('requires exact lab labels and both live and persisted loopback bindings', () => {
  const f = fixture(), town = f.config.towns[0];
  validatePartitionConfig(f.config);
  for (const change of [i => { delete i.Config.Labels['ai-town.federation-town-id']; },
    i => { i.HostConfig.PortBindings['3211/tcp'][0].HostIp = '0.0.0.0'; },
    i => { i.NetworkSettings.Ports = {}; }, i => { i.State.Running = false; }, i => { i.HostConfig.NetworkMode = 'host'; }]) {
    const value = structuredClone(f.inspect(town)); change(value);
    assert.throws(() => validatePartitionContainer(f.config, town, value));
  }
});

test('three scenarios use dynamic safe deadline, exact signed confirmation rejection and persisted cleanup', async () => {
  const f = fixture(), result = await runNetworkPartitionSmoke(f.config, f.ops, f.startGate);
  assert.equal(result.outcome, 'passed'); assert.equal(result.scenarios.length, 3);
  const partition = result.scenarios[1];
  assert.ok(partition.earlySamples > 0); assert.ok(partition.firstReturned.at >= partition.safeAfter);
  assert.equal(result.scenarios[2].reason, 'VISIT_LEASE_EXPIRED');
  assert.equal(result.cleanup, 'owned-visits-returned-gates-closed');
  assert.ok(f.gates.every(gate => gate.closed && gate.mode === 'open'));
  assert.equal(f.saved.at(-1).outcome, 'passed');
  assert.ok(!JSON.stringify(f.saved).includes('secret'));
});

test('alternate routes, user humans or additional trusted peers stop before starting ingress', async () => {
  for (const change of [s => { s.identity.endpointCandidates = [{ url: 'https://bypass.example/federation/v1' }]; },
    s => { s.resources.humans = 1; }, s => { s.peers.push({ townId: 'N', trustState: 'TRUSTED' }); }]) {
    const f = fixture(); f.ops.status = async town => { const s = f.state(town); change(s); return s; };
    let started = false;
    await assert.rejects(runNetworkPartitionSmoke(f.config, f.ops, async () => { started = true; }));
    assert.equal(started, false);
  }
});

test('late response with HTTP success cannot pass and still releases faults and records failed result', async () => {
  const f = fixture(); f.gates[1].deliverHeld = async () => ({ status: 200, reason: 'VISIT_LEASE_EXPIRED' });
  await assert.rejects(runNetworkPartitionSmoke(f.config, f.ops, f.startGate), /LATE_AUTHORIZATION_NOT_REJECTED/);
  assert.ok(f.gates.every(gate => gate.closed));
  assert.equal(f.saved.at(-1).outcome, 'failed'); assert.equal(f.saved.at(-1).cleanup, 'owned-visits-returned-gates-closed');
});

test('committed start with lost response recovers only original resident owned visit', async () => {
  const f = fixture(), start = f.ops.startVisit;
  f.ops.startVisit = async (...args) => { await start(...args); throw new Error('SIMULATED_LOST_RESPONSE'); };
  await assert.rejects(runNetworkPartitionSmoke(f.config, f.ops, f.startGate), /SIMULATED_LOST_RESPONSE/);
  assert.ok(f.gates.every(gate => gate.closed));
  assert.equal(f.saved.at(-1).cleanup, 'owned-visits-returned-gates-closed');
});

test('interrupt runs cleanup; cleanup errors are recorded rather than silently treated as success', async () => {
  const f = fixture(); f.ops.cancelled = () => true;
  await assert.rejects(runNetworkPartitionSmoke(f.config, f.ops, f.startGate), /RUN_INTERRUPTED/);
  assert.ok(f.gates.every(gate => gate.closed));
  const failed = fixture(); failed.gates[0].close = async () => { throw new Error('CLOSE_FAILED'); };
  await assert.rejects(runNetworkPartitionSmoke(failed.config, failed.ops, failed.startGate), /PARTITION_CLEANUP_FAILED/);
  assert.equal(failed.saved.at(-1).cleanup, 'failed-inspect-dedicated-lab');
});

test('a failed open direction is not accepted as one-way reachability', async () => {
  const f = fixture(), probe = f.ops.probe;
  let calls = 0;
  f.ops.probe = async (...args) => ++calls === 4 ? { channelState: 'PAIRED_BUT_NOT_REACHABLE' } : probe(...args);
  await assert.rejects(runNetworkPartitionSmoke(f.config, f.ops, f.startGate), /ONE_WAY_PROBE_EVIDENCE_MISSING/);
  assert.ok(f.gates.every(gate => gate.closed));
});

test('early Home resumption fails before the dynamic lease safety deadline', async () => {
  const f = fixture(), world = f.ops.world;
  f.ops.world = async town => {
    const value = await world(town);
    if (town.role === 'home' && f.gates.every(gate => gate.mode === 'blocked')) value.players = [{ id: 'p:1' }];
    if (town.role === 'host' && f.gates.every(gate => gate.mode === 'blocked')) value.players = [];
    return value;
  };
  await assert.rejects(runNetworkPartitionSmoke(f.config, f.ops, f.startGate), /HOME_RESUMED_BEFORE_SAFE_DEADLINE/);
  assert.equal(f.saved.at(-1).outcome, 'failed');
  assert.ok(f.gates.every(gate => gate.closed));
});


test('SDK options suppress logs and bound every fetch while preserving caller cancellation', async () => {
  assert.equal(partitionClientOptions.logger, false);
  const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout;
  const requests = [], deadlines = [];
  AbortSignal.timeout = ms => { deadlines.push(ms); return originalTimeout(ms); };
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true }; };
  try {
    await partitionClientOptions.fetch('http://127.0.0.1/test', { method: 'POST', body: 'private-input' });
    const cancellation = AbortSignal.abort();
    await partitionClientOptions.fetch('http://127.0.0.1/test', { signal: cancellation });
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.body, 'private-input');
    assert.ok(requests[0].options.signal instanceof AbortSignal);
    assert.equal(requests[0].options.signal.aborted, false);
    assert.equal(requests[1].options.signal.aborted, true);
    assert.deepEqual(deadlines, [30_000, 30_000]);
  } finally { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; }
});

test('expired envelope rejection cannot be reported as a passing lease guard', async () => {
  const f = fixture();
  f.gates[1].deliverHeld = async () => ({ status: 400, reason: 'MESSAGE_EXPIRED', visitId: 'visit-2', messageId: 'signed-confirm' });
  await assert.rejects(runNetworkPartitionSmoke(f.config, f.ops, f.startGate), /LATE_AUTHORIZATION_NOT_REJECTED/);
  assert.equal(f.saved.at(-1).outcome, 'failed');
  assert.equal(f.saved.at(-1).scenarios.length, 2);
});

test('an envelope without a valid expiry window fails before replay', async () => {
  const f = fixture(), start = f.ops.startVisit;
  f.ops.startVisit = async (...args) => {
    const value = await start(...args);
    if (f.gates[1].held) f.gates[1].held.expiresAt = f.ops.now() + 1000;
    return value;
  };
  let replayed = false;
  f.gates[1].deliverHeld = async () => { replayed = true; };
  await assert.rejects(runNetworkPartitionSmoke(f.config, f.ops, f.startGate), /HELD_ENVELOPE_EXPIRES_BEFORE_LEASE_TEST/);
  assert.equal(replayed, false); assert.ok(f.gates.every(gate => gate.closed));
});


test('Host terminal ledger remains eligible for replay verification and is recorded explicitly', async () => {
  const f = fixture(), status = f.ops.status;
  f.ops.status = async town => {
    const state = await status(town);
    if (town.role === 'host' && f.gates[1].mode === 'hold-confirm' && state.visits[0]?.leaseExpiry <= f.ops.now())
      state.visits[0].state = 'COMPLETED';
    return state;
  };
  const report = await runNetworkPartitionSmoke(f.config, f.ops, f.startGate);
  assert.equal(report.scenarios[2].hostStateBeforeReplay, 'COMPLETED');
  assert.ok(report.scenarios[2].envelopeExpiresAt > report.scenarios[2].deliveredAt);
  assert.equal(report.scenarios[2].reason, 'VISIT_LEASE_EXPIRED');
});
