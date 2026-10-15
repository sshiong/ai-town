// Destructive acceptance runner for explicitly labelled, dedicated local Docker labs.
// See configuration contract in validateLabConfig. Never target an existing user town.
// Provision and pair the two dedicated towns beforehand, with Home advertised at
// gate.endpoint (HTTPS /federation/v1), including every Home endpoint candidate.
// Run the gate separately during pairing, then close it so this runner can bind
// the same dedicated port. Host must trust the gate certificate's CA already.
// Neither pairing, TLS trust, Docker labels, settings nor model bindings are changed.
// Both API and Home HTTP-action ports must be published on host loopback only.
// Docker labels: ai-town.federation-fault-lab=<labId>,
// ai-town.federation-fault-role=home|host, ai-town.federation-town-id=<townId>.
// Run: FEDERATION_VISIT_ACTIVE_FAULT_CONFIG=/absolute/external/config.json node
// scripts/federation-visit-active-fault-smoke.mjs
// Optional FEDERATION_FAULT_REPORT must be a new absolute filename (0600).
// Diagnostics expose only the newest 100 inbox/outbox rows: use quiet dedicated
// towns. Missing evidence times out; the runner never substitutes ledger state.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startVisitActiveFaultGate } from './federation-visit-active-fault-gate.mjs';

const TERMINAL = new Set(['COMPLETED', 'REJECTED']);
const requireCondition = (condition, code) => { if (!condition) throw new Error(code); };
function localUrl(value, protocol = 'http:') {
  const url = new URL(value);
  requireCondition(url.protocol === protocol && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    !url.username && !url.password && url.port && url.pathname === '/' && !url.search && !url.hash, 'LOCAL_ORIGIN_REQUIRED');
  return url;
}
export function validateLabConfig(config) {
  requireCondition(config?.dedicatedVisitActiveFaultLab === true &&
    /^[a-z0-9-]{1,40}$/.test(config.labId ?? '') && Array.isArray(config.towns) && config.towns.length === 2,
  'DEDICATED_LAB_REQUIRED');
  requireCondition(config.towns[0].role === 'home' && config.towns[1].role === 'host', 'HOME_HOST_ORDER_REQUIRED');
  const ids = new Set(), names = new Set(), ports = new Set();
  for (const town of config.towns) {
    requireCondition(typeof town.townId === 'string' && town.townId.length > 0 &&
      typeof town.deploymentInstanceId === 'string' && town.deploymentInstanceId.length > 0 &&
      Number.isSafeInteger(town.deploymentEpoch) && town.deploymentEpoch >= 1 &&
      typeof town.adminKey === 'string' && town.adminKey.length > 0 &&
      typeof town.adminToken === 'string' && town.adminToken.length > 0 &&
      town.containerName === `aitown-federation-visit-active-lab-${config.labId}-${town.role}`,
    'LAB_TOWN_CONFIG_INVALID');
    const url = localUrl(town.url);
    requireCondition(!ids.has(town.townId) && !names.has(town.containerName) && !ports.has(url.port), 'LAB_TOWNS_MUST_DIFFER');
    ids.add(town.townId); names.add(town.containerName); ports.add(url.port);
  }
  const gate = config.gate;
  requireCondition(gate && isAbsolute(gate.certPath ?? '') && isAbsolute(gate.keyPath ?? '') &&
    Number.isInteger(gate.listenPort) && gate.listenPort > 0 && gate.listenPort <= 65535 &&
    (!gate.bindHost || ['127.0.0.1', '0.0.0.0', '::1', '::'].includes(gate.bindHost)), 'LAB_GATE_CONFIG_INVALID');
  const upstream = localUrl(gate.upstream);
  const endpoint = new URL(gate.endpoint);
  requireCondition(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password &&
    !endpoint.search && !endpoint.hash && endpoint.pathname === '/federation/v1' &&
    Number(endpoint.port) === gate.listenPort && !ports.has(String(gate.listenPort)) &&
    !ports.has(upstream.port), 'LAB_GATE_ROUTE_INVALID');
  return config;
}
export function validateContainer(config, town, inspect, pinnedId) {
  requireCondition(inspect && inspect.Name === `/${town.containerName}` &&
    /^[a-f0-9]{64}$/.test(inspect.Id ?? '') && (!pinnedId || inspect.Id === pinnedId) &&
    inspect.HostConfig?.NetworkMode !== 'host' &&
    inspect.Config?.Labels?.['ai-town.federation-fault-lab'] === config.labId &&
    inspect.Config?.Labels?.['ai-town.federation-fault-role'] === town.role &&
    inspect.Config?.Labels?.['ai-town.federation-town-id'] === town.townId,
  'DEDICATED_CONTAINER_MISMATCH');
  const published = Object.values(inspect.NetworkSettings?.Ports ?? {}).flat().filter(Boolean);
  const ports = [localUrl(town.url).port];
  if (town.role === 'home') ports.push(localUrl(config.gate.upstream).port);
  requireCondition(ports.every(port => published.some(binding => binding.HostPort === port &&
    ['127.0.0.1', '::1'].includes(binding.HostIp))), 'LOCAL_CONTAINER_PORT_MISMATCH');
  return inspect.Id;
}
function assertIdentity(town, state) {
  requireCondition(state.identity?.townId === town.townId &&
    state.identity.deploymentInstanceId === town.deploymentInstanceId &&
    state.identity.deploymentEpoch === town.deploymentEpoch, 'TOWN_IDENTITY_MISMATCH');
}
function assertInitial(config, states, residents) {
  for (let i = 0; i < 2; i++) {
    const state = states[i], town = config.towns[i], other = config.towns[1 - i];
    assertIdentity(town, state);
    requireCondition(state.identity.mode === 'ACTIVE' && state.settings.enabled && state.settings.clock.healthy &&
      state.settings.timePolicy.leaseMs >= 180_000 && !state.settings.activeVisitsRemain &&
      state.visits.every(visit => TERMINAL.has(visit.state)) && state.capacity.reserved === 0 &&
      residents[i].every(resident => resident.state === 'HOME_ACTIVE'), 'LAB_NOT_IDLE_AND_READY');
    requireCondition(state.peers.some(peer => peer.townId === other.townId && peer.trustState === 'TRUSTED') &&
      state.peers.every(peer => peer.trustState !== 'TRUSTED' || peer.townId === other.townId), 'LAB_PEER_ISOLATION_REQUIRED');
  }
  const homeEndpoint = config.gate.endpoint;
  for (const record of [states[0].identity, states[1].peers.find(peer => peer.townId === config.towns[0].townId)]) {
    const endpoints = [record.endpoint, ...(record.endpointCandidates ?? []).map(candidate => candidate.url)];
    requireCondition(endpoints.every(endpoint => endpoint === homeEndpoint), 'FAULT_GATE_BYPASS_ENDPOINT');
  }
}
export async function runVisitActiveFaultSmoke(config, ops, startGate = startVisitActiveFaultGate) {
  validateLabConfig(config);
  const [home, host] = config.towns;
  const pins = [];
  for (const town of config.towns) {
    const inspect = await ops.inspect(town);
    pins.push(validateContainer(config, town, inspect));
    requireCondition(inspect.State?.Running === true, 'LAB_CONTAINER_NOT_RUNNING');
  }
  const states = await Promise.all(config.towns.map(town => ops.status(town)));
  const residents = await Promise.all(config.towns.map(town => ops.residents(town)));
  assertInitial(config, states, residents);
  const resident = residents[0].find(value => value.state === 'HOME_ACTIVE');
  requireCondition(resident, 'LAB_HOME_RESIDENT_REQUIRED');
  const hostWorldId = (await ops.defaultWorld(host)).worldId;
  requireCondition(hostWorldId, 'LAB_HOST_WORLD_REQUIRED');
  const homeBefore = await ops.world(home, resident.worldId), hostBefore = await ops.world(host, hostWorldId);
  requireCondition(homeBefore.players.filter(player => player.id === resident.playerId).length === 1 &&
    homeBefore.agents.filter(agent => agent.id === resident.agentId).length === 1 &&
    ![homeBefore, hostBefore].some(world => world.players.some(player => player.remoteVisitor)), 'LAB_INITIAL_PRESENCE_INVALID');
  let gate, visitId, startAttempted = false, restartAttempted = false, failed = false;
  const checkpoints = [];
  const waitFor = async (code, read, accept, timeout = 90_000) => {
    const until = ops.now() + timeout;
    while (ops.now() < until) {
      const value = await read();
      if (accept(value)) return value;
      await ops.pause(500);
    }
    throw new Error(code);
  };
  const visitIn = state => state.visits.find(visit => visit.visitId === visitId);
  const sample = async label => {
    const homeWorld = await ops.world(home, resident.worldId), hostWorld = await ops.world(host, hostWorldId);
    const homeBodies = homeWorld.players.filter(player => player.id === resident.playerId);
    const hostBodies = hostWorld.players.filter(player => player.remoteVisitor?.agentGlobalId === resident.agentGlobalId);
    requireCondition(homeBodies.length + hostBodies.length <= 1 &&
      homeWorld.agents.filter(agent => agent.id === resident.agentId).length === 1 &&
      hostWorld.agents.length === hostBefore.agents.length &&
      hostBodies.every(player => player.remoteVisitor.visitId === visitId), 'DUPLICATE_OR_CHANGED_PRESENCE');
    const checkpoint = { label, at: ops.now(), homeBodies: homeBodies.length, hostBodies: hostBodies.length,
      hostPlayerId: hostBodies[0]?.id };
    checkpoints.push(checkpoint);
    return checkpoint;
  };
  const guardedDocker = async operation => {
    validateContainer(config, host, await ops.inspect(host), pins[1]);
    await ops.docker(host, operation, pins[1]);
  };
  const backendReady = () => waitFor('HOST_RESTART_TIMEOUT', async () => {
    try { const state = await ops.status(host); assertIdentity(host, state); return state; }
    catch (error) { if (error.message === 'TOWN_IDENTITY_MISMATCH') throw error; return null; }
  }, Boolean, 60_000);
  const returned = () => waitFor('RETURN_CLEANUP_TIMEOUT', async () => {
    const current = await Promise.all(config.towns.map(town => ops.status(town)));
    const rs = await ops.residents(home);
    const snapshot = await sample('return-poll');
    return visitIn(current[0])?.state === 'COMPLETED' && visitIn(current[1])?.state === 'COMPLETED' &&
      current[1].capacity.reserved === 0 && snapshot.homeBodies === 1 && snapshot.hostBodies === 0 &&
      rs.some(value => value.agentGlobalId === resident.agentGlobalId && value.playerId === resident.playerId &&
        value.agentId === resident.agentId && value.state === 'HOME_ACTIVE');
  }, Boolean, 180_000);
  try {
    gate = await startGate({ ...config.gate, homeTownId: home.townId, hostTownId: host.townId });
    for (const town of config.towns) await ops.probe(town, config.towns.find(other => other !== town).townId);
    await waitFor('MUTUAL_READINESS_TIMEOUT', async () => Promise.all(config.towns.map(town => ops.status(town))),
      values => values.every((value, i) => value.peers.some(peer => peer.townId === config.towns[1 - i].townId && peer.channelState === 'TRANSPORT_READY')));
    gate.arm();
    startAttempted = true;
    ({ visitId } = await ops.startVisit(home, { peerTownId: host.townId, worldId: resident.worldId, homePlayerId: resident.playerId }));
    const dropped = await waitFor('VISIT_ACTIVE_DROP_TIMEOUT', () => Promise.resolve(gate.events.find(event => event.visitId === visitId)), Boolean);
    await waitFor('CREATED_WITHOUT_CONFIRMATION_TIMEOUT', async () => {
      const [homeState, hostState] = await Promise.all(config.towns.map(town => ops.status(town)));
      const snapshot = await sample('created-confirmation-dropped');
      const [homeTransport, hostTransport] = await Promise.all(config.towns.map(town => ops.diagnostics(town)));
      return visitIn(homeState)?.state === 'CONFIRMING' && visitIn(hostState)?.state === 'ACTIVE' &&
        snapshot.homeBodies === 0 && snapshot.hostBodies === 1 &&
        !homeTransport.inbox.some(message => message.messageId === dropped.messageId) &&
        hostTransport.outbox.some(message => message.messageId === dropped.messageId && message.type === 'VISIT_ACTIVE' && !message.ackedAt && !message.failedAt);
    }, Boolean);
    const created = await sample('before-host-kill');
    restartAttempted = true;
    await guardedDocker('kill');
    const whileDead = await ops.world(home, resident.worldId);
    requireCondition(!whileDead.players.some(player => player.id === resident.playerId), 'HOME_RESUMED_WHILE_HOST_DOWN');
    await guardedDocker('start');
    await backendReady();
    const restarted = await sample('host-restarted-gate-still-armed');
    requireCondition(restarted.hostBodies === 1 && restarted.homeBodies === 0 &&
      restarted.hostPlayerId === created.hostPlayerId && visitIn(await ops.status(home))?.state === 'CONFIRMING', 'RESTART_PRESENCE_CHANGED');
    const priorDrops = gate.events.length;
    await waitFor('PERSISTED_MESSAGE_RETRY_TIMEOUT', async () => {
      await sample('retry-with-gate-armed');
      return gate.events.slice(priorDrops).some(event => event.messageId === dropped.messageId);
    }, Boolean);
    gate.release();
    await waitFor('RELEASED_MESSAGE_ACK_TIMEOUT', async () => {
      const snapshot = await sample('released-retry');
      const [homeTransport, hostTransport] = await Promise.all(config.towns.map(town => ops.diagnostics(town)));
      return snapshot.hostBodies === 1 && snapshot.hostPlayerId === created.hostPlayerId &&
        visitIn(await ops.status(home))?.state === 'ACTIVE' &&
        homeTransport.inbox.some(message => message.messageId === dropped.messageId && message.status === 'COMMITTED') &&
        hostTransport.outbox.some(message => message.messageId === dropped.messageId && message.ackedAt);
    }, Boolean);
    await ops.returnVisit(home, visitId);
    await returned();
    return { scenario: 'host-created-visit-active-lost-host-restart', verifiedAt: ops.now(),
      visitId, messageId: dropped.messageId, originalPlayerId: resident.playerId,
      originalAgentId: resident.agentId, originalAgentGlobalId: resident.agentGlobalId,
      drops: gate.events, checkpoints, evidenceScope: 'sequential-cross-town-samples' };
  } catch (error) { failed = true; throw error; }
  finally {
    gate?.release();
    let cleanupFailed = false;
    try {
      if (restartAttempted) { await guardedDocker('start'); await backendReady(); }
    } catch { cleanupFailed = true; }
    try {
      // A failed mutation response may hide a committed start. Recover only the
      // original resident's single new visit, never another resident's travel.
      if (startAttempted && !visitId) {
        const current = await ops.status(home);
        const candidates = current.visits.filter(value => value.agentGlobalId === resident.agentGlobalId &&
          !states[0].visits.some(old => old.visitId === value.visitId));
        requireCondition(candidates.length <= 1, 'AMBIGUOUS_STARTED_VISIT');
        visitId = candidates[0]?.visitId;
      }
      if (visitId) { await ops.returnVisit(home, visitId); await returned(); }
    } catch { cleanupFailed = true; }
    try { await gate?.close(); } catch { cleanupFailed = true; }
    if (cleanupFailed) throw new Error(failed ? 'SCENARIO_AND_CLEANUP_FAILED' : 'LAB_CLEANUP_FAILED');
  }
}

export async function readPrivateConfig(path) {
  requireCondition(isAbsolute(path ?? ''), 'ABSOLUTE_PRIVATE_CONFIG_REQUIRED');
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const rel = relative(repoRoot, await fs.realpath(path));
  requireCondition(rel.startsWith('../') || isAbsolute(rel), 'CONFIG_MUST_BE_OUTSIDE_REPOSITORY');
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    requireCondition(stat.isFile() && (stat.mode & 0o777) === 0o600 &&
      stat.uid === process.getuid() && stat.size <= 64 * 1024, 'PRIVATE_CONFIG_MODE_OWNER_OR_SIZE_INVALID');
    return validateLabConfig(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}
async function main() {
  try {
    const config = await readPrivateConfig(process.env.FEDERATION_VISIT_ACTIVE_FAULT_CONFIG);
    const { ConvexHttpClient } = await import('convex/browser');
    const { api } = await import('../convex/_generated/api.js');
    const clients = new Map(config.towns.map(town => {
      const client = new ConvexHttpClient(town.url); client.setAdminAuth(town.adminKey);
      return [town, client];
    }));
    const call = (town, kind, ref, args = {}) => clients.get(town)[kind](ref, { adminToken: town.adminToken, ...args });
    const ops = {
      now: Date.now, pause: ms => new Promise(resolve => setTimeout(resolve, ms)),
      inspect: async town => JSON.parse(execFileSync('docker', ['inspect', town.containerName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0],
      docker: async (_town, operation, id) => { execFileSync('docker', [operation, id], { stdio: 'pipe' }); },
      status: town => call(town, 'query', api.federation.admin.status),
      residents: town => call(town, 'query', api.federation.runtime.listResidents),
      diagnostics: town => call(town, 'query', api.federation.transport.diagnostics),
      defaultWorld: town => clients.get(town).query(api.world.defaultWorldStatus, {}),
      world: async (town, worldId) => (await clients.get(town).query(api.world.worldState, { worldId })).world,
      probe: (town, peerTownId) => call(town, 'action', api.federation.transport.probe, { peerTownId }),
      startVisit: (town, args) => call(town, 'mutation', api.federation.ledger.startVisit, args),
      returnVisit: (town, visitId) => call(town, 'mutation', api.federation.ledger.returnVisit, { visitId }),
    };
    const report = await runVisitActiveFaultSmoke(config, ops);
    if (process.env.FEDERATION_FAULT_REPORT) {
      const path = process.env.FEDERATION_FAULT_REPORT;
      requireCondition(isAbsolute(path), 'ABSOLUTE_REPORT_PATH_REQUIRED');
      await fs.writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
    }
    console.log(JSON.stringify({ code: 'VISIT_ACTIVE_FAULT_PASSED', visitId: report.visitId, messageId: report.messageId }));
  } catch (error) {
    // Do not print client/Docker errors: they may contain credentials or private state.
    const reason = /^[A-Z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'PRIVATE_OPERATION_FAILED';
    console.error(JSON.stringify({ code: 'VISIT_ACTIVE_FAULT_FAILED', reason, cleanup: 'inspect dedicated lab before reuse' }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
