// Only dedicated, pre-paired local labs. See federation-network-partition-smoke.md.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startNetworkPartitionGate } from './federation-network-partition-gate.mjs';

// Bound each HTTP request (including response body consumption), independently
// of scenario polling deadlines. Silence backend function logs at the SDK edge.
export const partitionClientOptions = {
  logger: false,
  fetch: (url, options = {}) => {
    const deadline = AbortSignal.timeout(30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    return globalThis.fetch(url, { ...options, signal });
  },
};

const check = (condition, code) => { if (!condition) throw new Error(code); };
const terminal = visit => ['COMPLETED', 'REJECTED'].includes(visit.state);
const SCENARIOS = ['one-way-denies-new-visit', 'two-way-lease-safe-return', 'late-signed-confirm-rejected'];
const root = fileURLToPath(new URL('../', import.meta.url));
function external(path) {
  check(isAbsolute(path ?? ''), 'ABSOLUTE_EXTERNAL_PATH_REQUIRED');
  const rel = relative(root, path);
  check(rel.startsWith('../') || isAbsolute(rel), 'PATH_MUST_BE_OUTSIDE_REPOSITORY');
}
function origin(value) {
  const url = new URL(value);
  check(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'LOOPBACK_ORIGIN_REQUIRED');
  return url;
}
export function validatePartitionConfig(config) {
  check(config?.dedicatedNetworkPartitionLab === true && /^[a-z0-9-]{1,40}$/.test(config.labId ?? '') &&
    config.towns?.length === 2, 'DEDICATED_PARTITION_LAB_REQUIRED');
  check(config.scenarios === undefined || Array.isArray(config.scenarios) && config.scenarios.length > 0 &&
    new Set(config.scenarios).size === config.scenarios.length && config.scenarios.every(value => SCENARIOS.includes(value)),
  'INVALID_SCENARIO_SELECTION');
  const ports = new Set(), ids = new Set();
  for (const [i, town] of config.towns.entries()) {
    const role = ['home', 'host'][i];
    check(town.role === role && town.containerName === `aitown-federation-network-partition-lab-${config.labId}-${role}` &&
      typeof town.townId === 'string' && town.townId && !ids.has(town.townId) &&
      typeof town.deploymentInstanceId === 'string' && town.deploymentInstanceId &&
      Number.isSafeInteger(town.deploymentEpoch) && town.deploymentEpoch >= 1 &&
      typeof town.adminKey === 'string' && town.adminKey && typeof town.adminToken === 'string' && town.adminToken,
    'INVALID_DEDICATED_TOWN');
    ids.add(town.townId);
    const gate = town.gate;
    check(gate && isAbsolute(gate.certPath ?? '') && isAbsolute(gate.keyPath ?? '') &&
      Number.isInteger(gate.listenPort) && gate.listenPort > 0 && gate.listenPort <= 65535 &&
      ['127.0.0.1', '0.0.0.0', '::1', '::'].includes(gate.bindHost ?? '127.0.0.1'), 'EXPLICIT_GATE_REQUIRED');
    const endpoint = new URL(gate.endpoint);
    check(endpoint.protocol === 'https:' && Number(endpoint.port) === gate.listenPort &&
      endpoint.pathname === '/federation/v1' && !endpoint.username && !endpoint.password &&
      !endpoint.search && !endpoint.hash, 'INVALID_GATE_ENDPOINT');
    for (const port of [origin(town.url).port, origin(gate.upstream).port, String(gate.listenPort)]) {
      check(!ports.has(port), 'LAB_PORTS_MUST_DIFFER'); ports.add(port);
    }
  }
  return config;
}
export function validatePartitionContainer(config, town, inspect) {
  check(inspect?.Name === `/${town.containerName}` && /^[a-f0-9]{64}$/.test(inspect.Id ?? '') &&
    inspect.State?.Running === true && inspect.HostConfig?.NetworkMode !== 'host' &&
    inspect.Config?.Labels?.['ai-town.federation-fault-lab'] === config.labId &&
    inspect.Config?.Labels?.['ai-town.federation-fault-role'] === town.role &&
    inspect.Config?.Labels?.['ai-town.federation-town-id'] === town.townId, 'DEDICATED_CONTAINER_MISMATCH');
  for (const mapping of [inspect.HostConfig?.PortBindings, inspect.NetworkSettings?.Ports]) {
    const bindings = Object.values(mapping ?? {}).flat().filter(Boolean);
    check([origin(town.url).port, origin(town.gate.upstream).port].every(port =>
      bindings.some(binding => binding.HostPort === port && ['127.0.0.1', '::1'].includes(binding.HostIp))) &&
      bindings.every(binding => ['127.0.0.1', '::1'].includes(binding.HostIp)), 'LOOPBACK_BINDINGS_REQUIRED');
  }
}
function identity(town, state) {
  check(state.identity?.townId === town.townId && state.identity.deploymentInstanceId === town.deploymentInstanceId &&
    state.identity.deploymentEpoch === town.deploymentEpoch, 'TOWN_IDENTITY_MISMATCH');
}
export async function runNetworkPartitionSmoke(config, ops, startGate = startNetworkPartitionGate) {
  validatePartitionConfig(config);
  check(typeof ops.persist === 'function', 'PERSISTENT_REPORT_REQUIRED');
  const [home, host] = config.towns, gates = [];
  for (const town of config.towns) validatePartitionContainer(config, town, await ops.inspect(town));
  const initial = await Promise.all(config.towns.map(town => ops.status(town)));
  for (const [i, state] of initial.entries()) {
    identity(config.towns[i], state);
    check(state.identity.mode === 'ACTIVE' && state.settings.enabled && state.settings.clock.healthy &&
      !state.settings.activeVisitsRemain && state.visits.every(terminal) && state.capacity.reserved === 0 &&
      state.resources.humans === 0 && state.settings.timePolicy.leaseMs <= 300_000, 'LAB_NOT_IDLE_AND_READY');
    check(state.peers.filter(peer => peer.trustState === 'TRUSTED').length === 1 &&
      state.peers.some(peer => peer.townId === config.towns[1-i].townId && peer.trustState === 'TRUSTED'), 'LAB_PEER_ISOLATION_REQUIRED');
    for (const record of [state.identity, initial[1-i].peers.find(peer => peer.townId === config.towns[i].townId)]) {
      check(record && [record.endpoint, ...(record.endpointCandidates ?? []).map(candidate => candidate.url)]
        .every(endpoint => endpoint === config.towns[i].gate.endpoint), 'FAULT_GATE_BYPASS_ENDPOINT');
    }
  }
  const residents = await ops.residents(home);
  const resident = residents.find(value => value.state === 'HOME_ACTIVE');
  check(resident && residents.every(value => value.state === 'HOME_ACTIVE'), 'IDLE_RESIDENT_REQUIRED');
  const hostWorldId = (await ops.defaultWorld(host)).worldId;
  check(hostWorldId, 'HOST_WORLD_REQUIRED');
  const beforeHost = await ops.world(host, hostWorldId);
  const beforeHome = await ops.world(home, resident.worldId);
  check(![beforeHome, beforeHost].some(world => world.players.some(player => player.remoteVisitor)) &&
    beforeHome.players.filter(player => player.id === resident.playerId).length === 1, 'INITIAL_PRESENCE_INVALID');
  const selected = config.scenarios ?? SCENARIOS;
  const report = { kind: 'network-partition', requestedScenarios: [...selected], startedAt: ops.now(), outcome: 'running', scenarios: [], cleanup: 'pending' };
  let visitId, startAttempted = false, failure, finishing = false;
  const save = () => ops.persist(report);
  const current = async () => {
    const states = await Promise.all(config.towns.map(town => ops.status(town)));
    states.forEach((state, i) => identity(config.towns[i], state));
    return states;
  };
  const wait = async (code, read, accept, timeout = 90_000) => {
    const end = ops.now() + timeout;
    while (ops.now() < end) {
      check(finishing || !ops.cancelled?.(), 'RUN_INTERRUPTED');
      const value = await read(); if (accept(value)) return value; await ops.pause(500); }
    throw new Error(code);
  };
  const presence = async () => {
    const worlds = await Promise.all([ops.world(home, resident.worldId), ops.world(host, hostWorldId)]);
    const homeBodies = worlds[0].players.filter(player => player.id === resident.playerId).length;
    const hostBodies = worlds[1].players.filter(player => player.remoteVisitor?.agentGlobalId === resident.agentGlobalId).length;
    check(homeBodies + hostBodies <= 1 && worlds[0].agents.filter(agent => agent.id === resident.agentId).length === 1 &&
      worlds[1].agents.length === beforeHost.agents.length, 'DUPLICATE_OR_CHANGED_PRESENCE');
    return { at: ops.now(), homeBodies, hostBodies };
  };
  const ledger = state => state.visits.find(visit => visit.visitId === visitId);
  const cleanupVisit = async () => {
    if (startAttempted && !visitId) {
      const state = await ops.status(home);
      const candidates = state.visits.filter(visit => visit.agentGlobalId === resident.agentGlobalId &&
        !initial[0].visits.some(old => old.visitId === visit.visitId));
      check(candidates.length <= 1, 'AMBIGUOUS_OWNED_VISIT'); visitId = candidates[0]?.visitId;
    }
    if (!visitId) return;
    await ops.returnVisit(home, visitId);
    await wait('VISIT_CLEANUP_TIMEOUT', async () => {
      const states = await current(), sample = await presence(), rs = await ops.residents(home);
      return states.every(state => ledger(state) && terminal(ledger(state))) && states[1].capacity.reserved === 0 &&
        sample.homeBodies === 1 && sample.hostBodies === 0 && rs.some(value => value.agentGlobalId === resident.agentGlobalId &&
          value.playerId === resident.playerId && value.agentId === resident.agentId && value.state === 'HOME_ACTIVE');
    }, Boolean, 1_300_000);
    visitId = undefined; startAttempted = false;
  };
  const ready = async () => {
    for (const gate of gates) gate.setMode('open');
    for (const [i, town] of config.towns.entries()) await ops.probe(town, config.towns[1-i].townId);
    await wait('MUTUAL_READINESS_TIMEOUT', current, states => states.every((state, i) => state.peers.some(peer =>
      peer.townId === config.towns[1-i].townId && peer.channelState === 'TRANSPORT_READY')));
  };
  const start = async () => {
    startAttempted = true;
    ({ visitId } = await ops.startVisit(home, { peerTownId: host.townId, worldId: resident.worldId, homePlayerId: resident.playerId }));
  };
  try {
    await save();
    for (const [i, town] of config.towns.entries()) gates.push(await startGate({ ...town.gate,
      fromTownId: config.towns[1-i].townId, toTownId: town.townId }));
    await ready();
    if (selected.includes('one-way-denies-new-visit')) {
      // Host -> Home ingress is cut; Home -> Host remains live.
      gates[0].setMode('blocked');
      const failedDirection = await ops.probe(host, home.townId);
      const workingDirection = await ops.probe(home, host.townId);
      check(failedDirection?.channelState === 'PAIRED_BUT_NOT_REACHABLE' &&
        ['TRANSPORT_READY', 'TRANSPORT_TESTING'].includes(workingDirection?.channelState), 'ONE_WAY_PROBE_EVIDENCE_MISSING');
      await wait('ONE_WAY_NOT_READY_TIMEOUT', current, states => states[0].peers.some(peer =>
        peer.townId === host.townId && peer.channelState !== 'TRANSPORT_READY'), initial[0].settings.timePolicy.probeFreshnessMs + 10_000);
      let rejected = false;
      try { await start(); } catch (error) {
        check(String(error?.message).includes('DIRECT_PEER_NOT_MUTUALLY_REACHABLE'), 'UNEXPECTED_START_REJECTION'); rejected = true;
      }
      check(rejected && gates[0].evidence.blocked > 0, 'ONE_WAY_START_NOT_REJECTED');
      const blockedSample = await presence();
      check(blockedSample.homeBodies === 1 && blockedSample.hostBodies === 0 &&
        (await current()).every((state, i) => state.visits.length === initial[i].visits.length), 'REJECTED_START_CHANGED_PRESENCE');
      startAttempted = false;
      report.scenarios.push({ scenario: 'one-way-denies-new-visit', failedDirection: failedDirection.channelState,
        workingDirection: workingDirection.channelState, sample: blockedSample }); await save();
    }

    if (selected.includes('two-way-lease-safe-return')) {
      await ready(); await start();
      await wait('ACTIVE_VISIT_TIMEOUT', async () => ({ states: await current(), sample: await presence() }),
        value => value.states.every(state => ledger(state)?.state === 'ACTIVE') && value.sample.hostBodies === 1 && value.sample.homeBodies === 0);
      gates.forEach(gate => gate.setMode('blocked'));
      // In-flight renewals may have committed immediately before the cut. Read the
      // latest issued lease after aborting sockets; never use the original expiry.
      await ops.returnVisit(home, visitId);
      let safeAfter = 0, expiry = 0, earlySamples = 0, firstReturned, firstHostCleaned;
      await wait('PARTITION_SAFE_RETURN_TIMEOUT', async () => {
        const states = await current(), sample = await presence(), homeVisit = ledger(states[0]);
        check(homeVisit && states.every(state => state.settings.clock.healthy), 'LEASE_OR_CLOCK_EVIDENCE_MISSING');
        expiry = Math.max(expiry, homeVisit.leaseExpiry);
        safeAfter = Math.max(safeAfter, homeVisit.returnSafety.safeAfter);
        check(homeVisit.returnSafety.condition !== 'SIGNED_CLEANUP', 'CLEANUP_ACK_CROSSED_PARTITION');
        if (sample.at < safeAfter) { check(sample.homeBodies === 0, 'HOME_RESUMED_BEFORE_SAFE_DEADLINE'); earlySamples++; }
        if (sample.hostBodies === 0 && !firstHostCleaned) firstHostCleaned = sample;
        if (sample.at >= expiry + 90_000) check(sample.hostBodies === 0, 'HOST_BODY_SURVIVED_LEASE_EXPIRY');
        if (sample.homeBodies === 1) firstReturned = sample;
        return sample.homeBodies === 1 && sample.hostBodies === 0;
      }, Boolean, 1_300_000);
      check(earlySamples > 0 && firstReturned.at >= safeAfter && gates.every(gate => gate.evidence.blocked > 0), 'PARTITION_EVIDENCE_INCOMPLETE');
      report.scenarios.push({ scenario: 'two-way-lease-safe-return', visitId, leaseExpiry: expiry, safeAfter,
        earlySamples, firstReturned, firstHostCleaned, evidenceScope: 'sequential-cross-town-samples' }); await save();
      await ready(); await cleanupVisit();
    }

    if (selected.includes('late-signed-confirm-rejected')) {
      await ready(); gates[1].setMode('hold-confirm'); await start();
      await wait('HELD_CONFIRM_TIMEOUT', () => Promise.resolve(gates[1].evidence.held), value => value?.visitId === visitId);
      const delayed = gates[1].evidence.held;
      gates[0].setMode('blocked');
      const issued = ledger((await current())[0]);
      check(issued && issued.leaseExpiry > ops.now() && issued.leaseExpiry - ops.now() <= 300_000, 'DELAYED_LEASE_INVALID');
      check(Number.isSafeInteger(delayed.expiresAt) && delayed.expiresAt > issued.leaseExpiry + 2000,
        'HELD_ENVELOPE_EXPIRES_BEFORE_LEASE_TEST');
      let noHostBodySamples = 0;
      await wait('DELAYED_LEASE_EXPIRY_TIMEOUT', async () => {
        const sample = await presence(); check(sample.hostBodies === 0, 'HELD_CONFIRM_CREATED_BODY'); noHostBodySamples++;
        return ops.now() >= issued.leaseExpiry + 2000;
      }, Boolean, 310_000);
      check(ops.now() < delayed.expiresAt, 'HELD_ENVELOPE_ALREADY_EXPIRED');
      const hostBeforeReplay = ledger((await current())[1]);
      check(hostBeforeReplay && hostBeforeReplay.leaseExpiry <= ops.now(), 'HOST_LEASE_NOT_EXPIRED');
      report.lateAuthorizationAttempt = { delivery: 'pending', visitId, messageId: delayed.messageId,
        leaseExpiry: issued.leaseExpiry, envelopeExpiresAt: delayed.expiresAt, hostStateBeforeReplay: hostBeforeReplay.state };
      await save();
      const refusal = await gates[1].deliverHeld();
      Object.assign(report.lateAuthorizationAttempt, { delivery: 'responded', status: refusal.status, reason: refusal.reason,
        responseFormat: refusal.responseFormat, responseBytes: refusal.responseBytes,
        receivedVisitId: refusal.visitId, receivedMessageId: refusal.messageId, deliveredAt: ops.now() });
      await save();
      check(refusal.status === 400 && refusal.reason === 'VISIT_LEASE_EXPIRED' && refusal.visitId === visitId &&
        refusal.messageId === delayed.messageId, 'LATE_AUTHORIZATION_NOT_REJECTED');
      const after = await presence(); check(after.hostBodies === 0, 'LATE_AUTHORIZATION_CREATED_BODY');
      report.scenarios.push({ scenario: 'late-signed-confirm-rejected', ...refusal, leaseExpiry: issued.leaseExpiry,
        envelopeExpiresAt: delayed.expiresAt, hostStateBeforeReplay: hostBeforeReplay.state,
        deliveredAt: ops.now(), noHostBodySamples, after }); await save();
      await ready(); await cleanupVisit();
    }
    report.outcome = 'passed';
  } catch (error) { failure = error; report.outcome = 'failed'; }
  finally {
    finishing = true;
    let cleanupFailed = false;
    for (const gate of gates) { try { gate.setMode('open'); } catch { cleanupFailed = true; } }
    try { await cleanupVisit(); } catch { cleanupFailed = true; }
    // Restore fresh probe state before closing owned ingress listeners. The lab's
    // normal dedicated ingress must be restarted separately before later use.
    if (gates.length === 2) {
      try { await ready(); } catch { cleanupFailed = true; }
    }
    for (const gate of gates) { try { await gate.close(); } catch { cleanupFailed = true; } }
    report.cleanup = cleanupFailed ? 'failed-inspect-dedicated-lab' : 'owned-visits-returned-gates-closed';
    report.finishedAt = ops.now();
    if (failure) report.reason = /^[A-Z_]{1,80}$/.test(failure?.message ?? '') ? failure.message : 'PRIVATE_OPERATION_FAILED';
    if (cleanupFailed) { report.outcome = 'failed'; failure = new Error('PARTITION_CLEANUP_FAILED'); }
    await save();
  }
  if (failure) throw failure;
  return report;
}
export async function readPartitionConfig(path) {
  external(path); external(await fs.realpath(path));
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.size <= 64 * 1024,
      'PRIVATE_CONFIG_MODE_OWNER_SIZE_REQUIRED');
    return validatePartitionConfig(JSON.parse(await handle.readFile('utf8')));
  } finally { await handle.close(); }
}
async function main() {
  let reportHandle, reportPersisted = false, cancelled = false;
  const interrupt = () => { cancelled = true; };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const config = await readPartitionConfig(process.env.FEDERATION_NETWORK_PARTITION_CONFIG);
    const reportPath = process.env.FEDERATION_FAULT_REPORT;
    external(reportPath); external(await fs.realpath(dirname(reportPath)));
    reportHandle = await fs.open(reportPath, 'wx', 0o600);
    const { ConvexHttpClient } = await import('convex/browser');
    const { api } = await import('../convex/_generated/api.js');
    const clients = new Map(config.towns.map(town => {
      const client = new ConvexHttpClient(town.url, partitionClientOptions); client.setAdminAuth(town.adminKey); return [town, client];
    }));
    const call = (town, kind, ref, args = {}) => clients.get(town)[kind](ref, { adminToken: town.adminToken, ...args });
    await runNetworkPartitionSmoke(config, {
      now: Date.now, cancelled: () => cancelled, pause: ms => new Promise(resolve => setTimeout(resolve, ms)),
      persist: async report => { const bytes = Buffer.from(JSON.stringify(report, null, 2));
        await reportHandle.write(bytes, 0, bytes.length, 0); await reportHandle.truncate(bytes.length); await reportHandle.sync(); reportPersisted = true; },
      inspect: async town => JSON.parse(execFileSync('docker', ['inspect', town.containerName],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0],
      status: town => call(town, 'query', api.federation.admin.status),
      residents: town => call(town, 'query', api.federation.runtime.listResidents),
      defaultWorld: town => clients.get(town).query(api.world.defaultWorldStatus, {}),
      world: async (town, worldId) => (await clients.get(town).query(api.world.worldState, { worldId })).world,
      probe: (town, peerTownId) => call(town, 'action', api.federation.transport.probe, { peerTownId }),
      startVisit: (town, args) => call(town, 'mutation', api.federation.ledger.startVisit, args),
      returnVisit: (town, visitId) => call(town, 'mutation', api.federation.ledger.returnVisit, { visitId }),
    });
    console.log(JSON.stringify({ code: 'NETWORK_PARTITION_PASSED', scenarios: config.scenarios ?? SCENARIOS }));
  } catch (error) {
    const reason = /^[A-Z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'PRIVATE_OPERATION_FAILED';
    if (reportHandle && !reportPersisted) {
      await reportHandle.writeFile(JSON.stringify({ kind: 'network-partition', outcome: 'failed', reason, cleanup: 'no-fault-started' }));
      await reportHandle.sync();
    }
    console.error(JSON.stringify({ code: 'NETWORK_PARTITION_FAILED', reason })); process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await reportHandle?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
