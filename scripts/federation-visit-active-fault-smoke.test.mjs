// Deterministic orchestration tests only. These do not run Docker or two towns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrivateConfig, runVisitActiveFaultSmoke, validateLabConfig, validateContainer } from './federation-visit-active-fault-smoke.mjs';

function configuration() {
  return { dedicatedVisitActiveFaultLab: true, labId: 'acceptance',
    towns: ['home', 'host'].map((role, index) => ({ role, townId: role,
      deploymentInstanceId: `instance-${role}`, deploymentEpoch: 1,
      containerName: `aitown-federation-visit-active-lab-acceptance-${role}`,
      url: `http://127.0.0.1:${3500 + index * 2}`, adminKey: 'fixture-key', adminToken: 'fixture-token' })),
    gate: { certPath: '/lab/cert.pem', keyPath: '/lab/key.pem', listenPort: 3504,
      upstream: 'http://127.0.0.1:3501', endpoint: 'https://host.docker.internal:3504/federation/v1' } };
}
function inspect(config, town) {
  return { Id: (town.role === 'home' ? 'a' : 'b').repeat(64), Name: `/${town.containerName}`,
    State: { Running: true }, HostConfig: { NetworkMode: 'bridge' },
    Config: { Labels: { 'ai-town.federation-fault-lab': config.labId,
      'ai-town.federation-fault-role': town.role, 'ai-town.federation-town-id': town.townId } },
    NetworkSettings: { Ports: { '3210/tcp': [{ HostIp: '127.0.0.1', HostPort: new URL(town.url).port }],
      ...(town.role === 'home' ? { '3211/tcp': [{ HostIp: '127.0.0.1', HostPort: '3501' }] } : {}) } } };
}
function simulation() {
  const config = configuration(), calls = [], resident = { state: 'HOME_ACTIVE', agentGlobalId: 'home/alice',
    playerId: 'p:1', agentId: 'a:1', worldId: 'home-world' };
  let phase = 'idle', time = 0, retryPending = false, closed = false;
  const event = { visitId: 'visit', messageId: 'active-message', type: 'VISIT_ACTIVE',
    fromTownId: 'host', toTownId: 'home', forwarded: false, timestamp: 0 };
  const gate = { events: [], arm() { calls.push('arm'); }, release() {
    calls.push('release'); if (phase === 'created') phase = 'active';
  }, async close() { calls.push('close'); closed = true; } };
  const state = town => ({ identity: { townId: town.townId,
    deploymentInstanceId: town.deploymentInstanceId, deploymentEpoch: 1, mode: 'ACTIVE',
    endpoint: town.role === 'home' ? config.gate.endpoint : 'https://localhost:3505/federation/v1' },
  settings: { enabled: true, clock: { healthy: true }, timePolicy: { leaseMs: 300_000 }, activeVisitsRemain: !['idle', 'returned'].includes(phase) },
  capacity: { reserved: town.role === 'host' && !['idle', 'returned'].includes(phase) ? 1 : 0 },
  peers: [{ townId: town.role === 'home' ? 'host' : 'home', trustState: 'TRUSTED',
    endpoint: town.role === 'host' ? config.gate.endpoint : 'https://localhost:3505/federation/v1', channelState: 'TRANSPORT_READY' }],
  visits: phase === 'idle' ? [] : [{ visitId: 'visit', agentGlobalId: resident.agentGlobalId,
    state: phase === 'returned' ? 'COMPLETED' : town.role === 'home' && phase === 'created' ? 'CONFIRMING' : 'ACTIVE' }],
  });
  const ops = {
    now: () => time,
    pause: async ms => { time += ms; if (retryPending) { gate.events.push({ ...event, timestamp: time }); retryPending = false; } },
    inspect: async town => inspect(config, town),
    docker: async (_town, operation, id) => { calls.push(`${operation}:${id}`); if (operation === 'start') retryPending = true; },
    status: async town => state(town),
    residents: async town => town.role === 'home' ? [{ ...resident, state: ['idle', 'returned'].includes(phase) ? 'HOME_ACTIVE' : 'TRAVELING' }] : [],
    defaultWorld: async () => ({ worldId: 'host-world' }),
    world: async town => town.role === 'home' ? {
      players: ['idle', 'returned'].includes(phase) ? [{ id: resident.playerId }] : [], agents: [{ id: resident.agentId }],
    } : { players: ['created', 'active'].includes(phase) ? [{ id: 'p:9', remoteVisitor: {
      visitId: 'visit', agentGlobalId: resident.agentGlobalId } }] : [], agents: [] },
    diagnostics: async town => town.role === 'home' ? { inbox: phase === 'active' ? [{ messageId: event.messageId, status: 'COMMITTED' }] : [], outbox: [] }
      : { inbox: [], outbox: [{ messageId: event.messageId, type: 'VISIT_ACTIVE', ...(phase === 'active' ? { ackedAt: 100 } : {}) }] },
    probe: async town => { calls.push(`probe:${town.role}`); },
    startVisit: async () => { calls.push('startVisit'); phase = 'created'; gate.events.push(event); return { visitId: 'visit' }; },
    returnVisit: async () => { calls.push('returnVisit'); phase = 'returned'; },
  };
  return { config, ops, calls, gate, state, get closed() { return closed; },
    startGate: async () => { calls.push('startGate'); return gate; } };
}

test('rejects user N and missing dedicated authorization before any operation', async () => {
  for (const change of [c => { c.dedicatedVisitActiveFaultLab = false; },
    c => { c.towns[1].containerName = 'aitown-federation-n'; },
    c => { c.towns[1].url = 'http://example.com:3420'; }]) {
    const c = configuration(); change(c);
    await assert.rejects(runVisitActiveFaultSmoke(c, new Proxy({}, { get() { throw new Error('MUST_NOT_CALL_OPS'); } })));
  }
});

test('Docker guards require pinned container, dedicated labels and loopback API/action ports', () => {
  const c = configuration(), town = c.towns[0];
  for (const change of [i => { delete i.Config.Labels['ai-town.federation-fault-lab']; },
    i => { i.NetworkSettings.Ports['3211/tcp'][0].HostIp = '0.0.0.0'; },
    i => { i.HostConfig.NetworkMode = 'host'; }, i => { i.Id = 'c'.repeat(64); }]) {
    const i = inspect(c, town); change(i);
    assert.throws(() => validateContainer(c, town, i, 'a'.repeat(64)));
  }
});

test('active visits, additional trusted peers and alternate Home routes block before gate or mutations', async () => {
  for (const change of [s => { s.settings.activeVisitsRemain = true; },
    s => { s.peers.push({ townId: 'user-N', trustState: 'TRUSTED' }); },
    s => { s.identity.endpointCandidates = [{ url: 'https://localhost:9999/federation/v1' }]; }]) {
    const f = simulation(), original = f.ops.status;
    f.ops.status = async town => { const s = await original(town); if (town.role === 'home') change(s); return s; };
    await assert.rejects(runVisitActiveFaultSmoke(f.config, f.ops, f.startGate));
    assert.deepEqual(f.calls, []);
  }
});

test('deterministic lifecycle requires post-restart same-message retry and restores owned visit', async () => {
  const f = simulation();
  const report = await runVisitActiveFaultSmoke(f.config, f.ops, f.startGate);
  assert.equal(report.messageId, 'active-message');
  assert.equal(report.drops.length, 2);
  assert.ok(report.checkpoints.every(p => p.homeBodies + p.hostBodies <= 1));
  assert.equal(report.checkpoints.at(-1).homeBodies, 1);
  assert.ok(f.calls.indexOf(`kill:${'b'.repeat(64)}`) > f.calls.indexOf('startVisit'));
  assert.equal(f.calls.filter(call => call === 'returnVisit').length, 2);
  assert.equal(f.closed, true);
  assert.ok(!JSON.stringify(report).includes('fixture-key'));
});

test('failed Host restart still attempts pinned restart, return and gate cleanup', async () => {
  const f = simulation(), original = f.ops.docker;
  let starts = 0;
  f.ops.docker = async (...args) => {
    if (args[1] === 'start' && ++starts === 1) throw new Error('SIMULATED_RESTART_FAILURE');
    await original(...args);
  };
  await assert.rejects(runVisitActiveFaultSmoke(f.config, f.ops, f.startGate), /SIMULATED_RESTART_FAILURE/);
  assert.equal(starts, 2);
  assert.ok(f.calls.includes('returnVisit'));
  assert.equal(f.closed, true);
});

test('container identity change refuses kill and refuses cleanup control of replacement', async () => {
  const f = simulation(), original = f.ops.inspect;
  let hostReads = 0;
  f.ops.inspect = async town => {
    const value = await original(town);
    if (town.role === 'host' && ++hostReads > 1) value.Id = 'c'.repeat(64);
    return value;
  };
  await assert.rejects(runVisitActiveFaultSmoke(f.config, f.ops, f.startGate), /SCENARIO_AND_CLEANUP_FAILED/);
  assert.ok(!f.calls.some(call => call.startsWith('kill:') || call.startsWith('start:')));
  assert.equal(f.closed, true);
});

test('missing exact transport evidence times out before any Docker fault', async () => {
  const f = simulation(), original = f.ops.diagnostics;
  f.ops.diagnostics = async town => {
    const value = await original(town);
    if (town.role === 'host') value.outbox = [];
    return value;
  };
  await assert.rejects(runVisitActiveFaultSmoke(f.config, f.ops, f.startGate), /CREATED_WITHOUT_CONFIRMATION_TIMEOUT/);
  assert.ok(!f.calls.some(call => call.startsWith('kill:')));
  assert.ok(f.calls.includes('returnVisit'));
  assert.equal(f.closed, true);
});

test('a committed start with lost mutation response is identified and returned in cleanup', async () => {
  const f = simulation(), original = f.ops.startVisit;
  f.ops.startVisit = async (...args) => { await original(...args); throw new Error('LOST_MUTATION_RESPONSE'); };
  await assert.rejects(runVisitActiveFaultSmoke(f.config, f.ops, f.startGate), /LOST_MUTATION_RESPONSE/);
  assert.ok(f.calls.includes('returnVisit'));
  assert.ok(!f.calls.some(call => call.startsWith('kill:')));
  assert.equal(f.closed, true);
});

test('initial deployment identity mismatch is rejected without mutations', async () => {
  const f = simulation(), original = f.ops.status;
  f.ops.status = async town => {
    const value = await original(town);
    if (town.role === 'host') value.identity.deploymentInstanceId = 'wrong-instance';
    return value;
  };
  await assert.rejects(runVisitActiveFaultSmoke(f.config, f.ops, f.startGate), /TOWN_IDENTITY_MISMATCH/);
  assert.deepEqual(f.calls, []);
});

test('private config requires 0600, local owner and rejects symbolic links', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'fault-smoke-config-'));
  try {
    const path = join(dir, 'config.json'), link = join(dir, 'link.json');
    await fs.writeFile(path, JSON.stringify(configuration()), { mode: 0o600 });
    assert.equal((await readPrivateConfig(path)).labId, 'acceptance');
    await fs.chmod(path, 0o644);
    await assert.rejects(readPrivateConfig(path), /PRIVATE_CONFIG/);
    await fs.chmod(path, 0o600); await fs.symlink(path, link);
    await assert.rejects(readPrivateConfig(link));
    assert.doesNotThrow(() => validateLabConfig(configuration()));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
