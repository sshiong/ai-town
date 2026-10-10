// Observe real NPC dialogue in two dedicated, independently deployed towns.
// FEDERATION_TEST_CONFIG uses the same external 0600 JSON as federation-smoke.mjs.
// Optional: FEDERATION_DIALOGUE_REPORT (external 0600 evidence), FEDERATION_DIALOGUE_HOME_INDEX (0/1),
// FEDERATION_DIALOGUE_TIMEOUT_MS (whole dialogue phase), FEDERATION_DIALOGUE_ATTEMPTS.
// This harness only controls travel lifecycle and world heartbeats. It never sends
// dialogue, invitations, movement, generated actions, or fabricated transport ACKs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { api } from '../convex/_generated/api.js';

const EXPECTED_CHAT_MODEL = 'qwen3.5:4b';
const POLL_MS = 3000;
const REQUEST_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 180_000;
const tableData = makeFunctionReference('_system/cli/tableData');
const repository = path.resolve(import.meta.dirname, '..');
const evidence = {
  startedAt: Date.now(),
  requirement: 'one natural NPC conversation with at least two utterances from each participant',
  expectedChatModel: EXPECTED_CHAT_MODEL,
  attempts: [],
  passed: false,
};
let towns = [];
let reportPath;

function integerEnvironment(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${name}`);
  return value;
}
function externalPath(filename, label) {
  const resolved = path.resolve(filename);
  const relative = path.relative(repository, resolved);
  assert.ok(
    relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    `${label} must be outside Git`,
  );
  return resolved;
}
function safeError(error) {
  let result = String(error instanceof Error ? error.message : error);
  for (const town of towns) {
    for (const secret of [town.adminKey, town.adminToken]) {
      if (secret) result = result.split(secret).join('[redacted]');
    }
  }
  return result.slice(0, 1500);
}
function writeEvidence() {
  if (!reportPath) return;
  // O_NOFOLLOW refuses a pre-existing symlink; fchmod also fixes existing file modes.
  const fd = fs.openSync(
    reportPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const auth = (town) => ({ adminToken: town.adminToken });
const status = (town) => town.client.query(api.federation.admin.status, auth(town));
const residents = (town) => town.client.query(api.federation.runtime.listResidents, auth(town));
const models = (town) => town.client.query(api.models.profiles.list, auth(town));
const world = async (town, worldId) =>
  (await town.client.query(api.world.worldState, { worldId })).world;
async function waitFor(label, read, accept, timeout = SETTLE_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (accept(value)) return value;
    await pause(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}
async function readTable(town, table) {
  const rows = [];
  let cursor = null;
  const deadline = Date.now() + 90_000;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    assert.ok(Date.now() < deadline, `Timed out reading evidence table ${table}`);
    // The same read-only system query used by the installed Convex data CLI.
    const result = await town.client.query(tableData, {
      table,
      order: 'desc',
      paginationOpts: { cursor, numItems: 100 },
    });
    rows.push(...result.page);
    if (result.isDone) return rows;
    assert.notEqual(result.continueCursor, cursor, 'Table pagination did not advance');
    cursor = result.continueCursor;
  }
  throw new Error(`Evidence table ${table} exceeds the bounded 10000-row scan`);
}
function modelSnapshot(value) {
  const stable = (rows) => [...rows].sort((a, b) => a._id.localeCompare(b._id));
  return {
    chatProfiles: stable(value.chatProfiles),
    bindings: stable(value.bindings),
    embeddingProfiles: stable(value.embeddingProfiles),
    embeddingSpaces: stable(value.embeddingSpaces),
    settings: value.settings,
  };
}
function assertFixedBindings(snapshot, residentRows) {
  for (const resident of residentRows) {
    const binding = snapshot.bindings.find(
      (b) =>
        b.agentGlobalId === resident.agentGlobalId &&
        b.playerId === resident.playerId &&
        b.worldId === resident.worldId,
    );
    assert.ok(binding, 'Every resident needs its original fixed model binding');
    const profile = snapshot.chatProfiles.find((p) => p._id === binding.chatProfileId);
    assert.ok(profile, 'Bound resident chat profile must exist');
    assert.equal(profile.provider, 'ollama', 'Dialogue requires actual local Ollama');
    assert.equal(profile.model, EXPECTED_CHAT_MODEL, 'Dialogue requires the fixed chat model');
    assert.ok(
      [
        'localhost',
        '127.0.0.1',
        '::1',
        '[::1]',
        'host.docker.internal',
        'gateway.docker.internal',
      ].includes(new URL(profile.url).hostname),
      'Ollama chat binding must point to the local machine',
    );
  }
  const active = snapshot.embeddingSpaces.find(
    (s) => s._id === snapshot.settings?.activeEmbeddingSpaceId,
  );
  assert.ok(active && active.status === 'ACTIVE', 'An existing active embedding space is required');
}
async function probePair(identities) {
  for (let index = 0; index < 2; index++) {
    await towns[index].client.action(api.federation.transport.probe, {
      ...auth(towns[index]),
      peerTownId: identities[1 - index].townId,
    });
  }
  for (let index = 0; index < 2; index++) {
    await waitFor(
      'mutual authenticated readiness',
      () => status(towns[index]),
      (s) =>
        s.peers.some(
          (p) =>
            p.townId === identities[1 - index].townId &&
            p.trustState === 'TRUSTED' &&
            p.channelState === 'TRANSPORT_READY',
        ),
      90_000,
    );
  }
}
function messageFields(message) {
  return {
    messageId: message.messageUuid,
    text: message.text,
    author: message.author,
    occurredAt: message._creationTime,
  };
}
function sufficient(conversation, visitorId) {
  const other = conversation.participants.find((id) => id !== visitorId);
  return (
    other &&
    conversation.messages.filter((m) => m.author === visitorId).length >= 2 &&
    conversation.messages.filter((m) => m.author === other).length >= 2
  );
}
async function observeDialogue(home, host, resident, hostWorldId, identities, attempt, deadline) {
  const conversations = new Map();
  let visitorId;
  let lastProbeAt = Date.now();
  while (Date.now() < deadline) {
    const [destination, homeStatus] = await Promise.all([world(host, hostWorldId), status(home)]);
    const visitor = destination.players.find((p) => p.remoteVisitor?.visitId === attempt.visitId);
    if (visitor) {
      visitorId ??= visitor.id;
      assert.equal(visitor.id, visitorId, 'Host visitor body identity changed');
      assert.equal(visitor.remoteVisitor.agentGlobalId, resident.agentGlobalId);
    }
    attempt.visitorPlayerId = visitorId;
    if (visitorId) {
      const previous = await host.client.query(api.world.previousConversation, {
        worldId: hostWorldId,
        playerId: visitorId,
      });
      const candidates = destination.conversations.filter((c) =>
        c.participants.some((member) => member.playerId === visitorId),
      );
      if (previous)
        candidates.push({
          ...previous,
          participants: previous.participants.map((playerId) => ({ playerId })),
        });
      for (const candidate of candidates) {
        const participantIds = candidate.participants.map((p) => p.playerId);
        const otherId = participantIds.find((id) => id !== visitorId);
        // A human or another remote visitor cannot satisfy the Host-resident proof.
        if (
          participantIds.length !== 2 ||
          !attempt.hostResidents.some((r) => r.playerId === otherId)
        )
          continue;
        const rows = await host.client.query(api.messages.listMessages, {
          worldId: hostWorldId,
          conversationId: candidate.id,
        });
        assert.ok(
          rows.every((m) => m.text.trim() && participantIds.includes(m.author)),
          'Persisted dialogue contains an invalid utterance',
        );
        conversations.set(candidate.id, {
          conversationId: candidate.id,
          participants: participantIds,
          messages: rows.map(messageFields),
        });
      }
      attempt.conversations = [...conversations.values()];
      writeEvidence();
      const target = [...conversations.values()].find((c) => sufficient(c, visitorId));
      if (target) return target;
    }
    const ledger = homeStatus.visits.find((v) => v.visitId === attempt.visitId);
    assert.ok(ledger, 'Home visit ledger disappeared');
    if (ledger.state !== 'ACTIVE') {
      throw new Error(`Natural dialogue ended before two utterances each (visit ${ledger.state})`);
    }
    if (Date.now() - lastProbeAt >= 60_000 || ledger.leaseExpiry - Date.now() < 60_000) {
      await probePair(identities);
      lastProbeAt = Date.now();
    }
    if (ledger.leaseExpiry - Date.now() < 60_000) {
      assert.ok(
        homeStatus.settings.maxVisitDurationMs >= 90_000,
        'Visit duration is too short for bounded natural dialogue',
      );
      await home.client.mutation(api.federation.ledger.renewVisit, {
        ...auth(home),
        visitId: attempt.visitId,
      });
    }
    await pause(POLL_MS);
  }
  throw new Error('Natural NPC dialogue deadline elapsed without two utterances each');
}
async function cleanupVisit(home, host, resident, hostWorldId, attempt) {
  await home.client.mutation(api.federation.ledger.returnVisit, {
    ...auth(home),
    visitId: attempt.visitId,
  });
  await waitFor(
    'original resident and authenticated Host cleanup',
    async () => {
      const [rs, homeWorld, hostWorld, hs, ds] = await Promise.all([
        residents(home),
        world(home, resident.worldId),
        world(host, hostWorldId),
        status(home),
        status(host),
      ]);
      return { rs, homeWorld, hostWorld, hs, ds };
    },
    ({ rs, homeWorld, hostWorld, hs, ds }) =>
      rs.some(
        (r) =>
          r.agentGlobalId === resident.agentGlobalId &&
          r.playerId === resident.playerId &&
          r.agentId === resident.agentId &&
          r.state === 'HOME_ACTIVE' &&
          !r.visitId,
      ) &&
      homeWorld.players.filter((p) => p.id === resident.playerId).length === 1 &&
      homeWorld.agents.filter((a) => a.id === resident.agentId).length === 1 &&
      !hostWorld.players.some((p) => p.remoteVisitor?.visitId === attempt.visitId) &&
      hs.visits.some((v) => v.visitId === attempt.visitId && v.state === 'COMPLETED') &&
      ds.visits.some((v) => v.visitId === attempt.visitId && v.state === 'COMPLETED'),
  );
  attempt.returnVerifiedAt = Date.now();
  attempt.sameResidentReturned = true;
}
async function verifyTranscript(home, host, resident, hostWorldId, attempt, conversation) {
  const transcript = await waitFor(
    'complete Home transcript and DONE summary',
    async () =>
      (await readTable(home, 'homeTravelTranscripts')).find(
        (t) =>
          t.visitId === attempt.visitId &&
          t.agentGlobalId === resident.agentGlobalId &&
          t.federationConversationId.endsWith(`/${conversation.conversationId}`),
      ),
    (t) => t?.state === 'COMPLETE' && t.summaryState === 'DONE' && !!t.summaryMemoryId,
  );
  const [pages, hostRows, memories, jobs, actions, decisions] = await Promise.all([
    readTable(home, 'homeTravelTranscriptPages'),
    host.client.query(api.messages.listMessages, {
      worldId: hostWorldId,
      conversationId: conversation.conversationId,
    }),
    readTable(home, 'memories'),
    readTable(host, 'federationTranscriptJobs'),
    readTable(host, 'federationPendingActions'),
    readTable(home, 'federationDecisionJobs'),
  ]);
  const orderedPages = pages
    .filter(
      (p) =>
        p.transcriptId === transcript.transcriptId && p.agentGlobalId === resident.agentGlobalId,
    )
    .sort((a, b) => a.pageNumber - b.pageNumber);
  assert.equal(orderedPages.length, transcript.finalPageNumber + 1);
  assert.ok(
    orderedPages.every(
      (p, index) => p.pageNumber === index && p.finalPage === (index === orderedPages.length - 1),
    ),
    'Transcript pages must be contiguous and final',
  );
  const homeMessages = orderedPages
    .flatMap((p) => p.messages)
    .map((m) => ({
      messageId: m.messageId,
      text: m.text,
      author: m.author,
      occurredAt: m.occurredAt,
    }));
  const hostMessages = hostRows.map(messageFields);
  const visitorMessages = hostMessages.filter((m) => m.author === attempt.visitorPlayerId);
  const committedSayActions = actions.filter(
    (a) =>
      a.visitId === attempt.visitId &&
      a.state === 'COMMITTED' &&
      a.result?.kind === 'ok' &&
      a.action?.type === 'say',
  );
  for (const message of visitorMessages) {
    const action = committedSayActions.find(
      (a) => a.action.text === message.text && message.messageId === a.actionId,
    );
    assert.ok(
      action &&
        decisions.some(
          (d) =>
            d.visitId === attempt.visitId &&
            d.eventId === action.basedOnEventId &&
            d.state === 'COMMITTED',
        ),
      'Every visitor utterance must come from a real committed Home decision and Host action',
    );
  }
  assert.deepEqual(
    homeMessages,
    hostMessages,
    'Home raw transcript must exactly equal persisted Host dialogue',
  );
  assert.equal(transcript.totalMessageCount, hostMessages.length);
  assert.ok(sufficient({ ...conversation, messages: hostMessages }, attempt.visitorPlayerId));
  const summary = memories.find((m) => m._id === transcript.summaryMemoryId);
  assert.ok(
    summary?.description.trim() &&
      summary.agentGlobalId === resident.agentGlobalId &&
      summary.worldId === resident.worldId &&
      summary.playerId === resident.playerId,
    'DONE summary must reference the same resident durable memory',
  );
  const job = jobs.find((j) => j.transcriptId === transcript.transcriptId);
  assert.ok(job, 'Host must have a durable final-transcript delivery job');
  await waitFor(
    'authenticated transcript delivery acknowledgment',
    async () =>
      (await readTable(host, 'federationTranscriptJobs')).find(
        (j) => j.transcriptId === transcript.transcriptId,
      ),
    (j) => j?.state === 'DELIVERED',
  );
  attempt.proof = {
    transcriptId: transcript.transcriptId,
    conversationId: conversation.conversationId,
    participants: transcript.participants,
    hostMessages,
    homeMessages,
    visitorUtterances: hostMessages.filter((m) => m.author === attempt.visitorPlayerId).length,
    hostUtterances: hostMessages.filter((m) => m.author !== attempt.visitorPlayerId).length,
    rawTranscriptIdentical: true,
    transcriptState: transcript.state,
    summaryState: transcript.summaryState,
    summaryMemoryId: summary._id,
    summary: summary.description,
    authenticatedDelivery: true,
    committedVisitorActionIds: committedSayActions
      .filter((a) => visitorMessages.some((m) => m.messageId === a.actionId))
      .map((a) => a.actionId),
  };
}
async function main() {
  assert.ok(
    process.env.FEDERATION_TEST_CONFIG,
    'Set FEDERATION_TEST_CONFIG to private two-town JSON',
  );
  const configPath = externalPath(process.env.FEDERATION_TEST_CONFIG, 'Configuration');
  const stat = fs.lstatSync(configPath);
  assert.ok(
    stat.isFile() && (stat.mode & 0o777) === 0o600,
    'Configuration must be a regular 0600 file',
  );
  reportPath = externalPath(
    process.env.FEDERATION_DIALOGUE_REPORT ??
      path.join(path.dirname(configPath), 'federation-dialogue-proof.json'),
    'Evidence',
  );
  assert.notEqual(reportPath, configPath, 'Evidence must not overwrite credentials');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error('Cannot parse private federation configuration');
  }
  assert.equal(config.towns?.length, 2, 'Exactly two deployed towns are required');
  towns = config.towns.map((town) => {
    assert.ok(
      typeof town.adminKey === 'string' &&
        town.adminKey &&
        typeof town.adminToken === 'string' &&
        town.adminToken,
      'Town authentication is required',
    );
    const client = new ConvexHttpClient(town.url, {
      logger: false,
      fetch: (url, options) =>
        fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    });
    client.setAdminAuth(town.adminKey);
    return { ...town, client };
  });
  const homeIndex = integerEnvironment('FEDERATION_DIALOGUE_HOME_INDEX', 0, 0, 1);
  const timeout = integerEnvironment('FEDERATION_DIALOGUE_TIMEOUT_MS', 600_000, 60_000, 1_800_000);
  const maxAttempts = integerEnvironment('FEDERATION_DIALOGUE_ATTEMPTS', 3, 1, 5);
  const [home, host] = [towns[homeIndex], towns[1 - homeIndex]];
  const initial = await Promise.all(towns.map(status));
  const identities = initial.map((s) => s.identity);
  assert.ok(identities.every(Boolean), 'Both towns must be initialized');
  assert.notEqual(
    new URL(towns[0].url).origin,
    new URL(towns[1].url).origin,
    'Deployments must be independent',
  );
  assert.notEqual(identities[0].townId, identities[1].townId);
  assert.notEqual(identities[0].deploymentInstanceId, identities[1].deploymentInstanceId);
  for (let index = 0; index < 2; index++) {
    assert.ok(initial[index].settings.enabled && identities[index].mode === 'ACTIVE');
    assert.ok(
      !initial[index].visits.some((v) => !['COMPLETED', 'REJECTED'].includes(v.state)),
      'End existing visits before running this dedicated smoke test',
    );
    assert.ok(
      initial[index].peers.some(
        (p) => p.townId === identities[1 - index].townId && p.trustState === 'TRUSTED',
      ),
      'Pair both towns before running dialogue proof',
    );
  }
  evidence.towns = identities.map(({ townId, deploymentInstanceId, deploymentEpoch }) => ({
    townId,
    deploymentInstanceId,
    deploymentEpoch,
  }));
  evidence.homeTownIndex = homeIndex;
  const residentLists = await Promise.all(towns.map(residents));
  const originalModels = (await Promise.all(towns.map(models))).map(modelSnapshot);
  originalModels.forEach((snapshot, index) => assertFixedBindings(snapshot, residentLists[index]));
  evidence.fixedBindings = originalModels.map((s) =>
    s.bindings.map(({ agentGlobalId, playerId, chatProfileId }) => ({
      agentGlobalId,
      playerId,
      chatProfileId,
    })),
  );
  evidence.activeEmbeddingSpaceIds = originalModels.map((s) => s.settings.activeEmbeddingSpaceId);
  const resident = residentLists[homeIndex].find((r) => r.state === 'HOME_ACTIVE');
  assert.ok(resident, 'Home needs an original available NPC resident');
  const hostStatus = await host.client.query(api.world.defaultWorldStatus, {});
  assert.ok(hostStatus?.worldId, 'Host needs an existing default world');
  const hostWorldId = hostStatus.worldId;
  const originalHostAgentIds = (await world(host, hostWorldId)).agents.map((a) => a.id).sort();
  const hostResidents = residentLists[1 - homeIndex].filter(
    (r) => r.worldId === hostWorldId && r.state === 'HOME_ACTIVE',
  );
  assert.ok(hostResidents.length, 'Host needs an available original NPC resident');
  evidence.resident = {
    agentGlobalId: resident.agentGlobalId,
    agentId: resident.agentId,
    playerId: resident.playerId,
    worldId: resident.worldId,
  };
  try {
    const deadline = Date.now() + timeout;
    for (let index = 0; index < maxAttempts && Date.now() < deadline; index++) {
      await probePair(identities);
      await Promise.all([
        home.client.mutation(api.world.heartbeatWorld, { worldId: resident.worldId }),
        host.client.mutation(api.world.heartbeatWorld, { worldId: hostWorldId }),
      ]);
      const attempt = {
        number: index + 1,
        startedAt: Date.now(),
        hostResidents: hostResidents.map(({ playerId, agentGlobalId }) => ({
          playerId,
          agentGlobalId,
        })),
        conversations: [],
      };
      evidence.attempts.push(attempt);
      let conversation;
      try {
        const visit = await home.client.mutation(api.federation.ledger.startVisit, {
          ...auth(home),
          peerTownId: identities[1 - homeIndex].townId,
          worldId: resident.worldId,
          homePlayerId: resident.playerId,
        });
        attempt.visitId = visit.visitId;
        await waitFor(
          'active natural visitor',
          () => status(home),
          (s) => s.visits.some((v) => v.visitId === visit.visitId && v.state === 'ACTIVE'),
          90_000,
        );
        assert.ok(
          !(await world(home, resident.worldId)).players.some((p) => p.id === resident.playerId),
          'Home body must be absent while visitor is active',
        );
        console.log(`Attempt ${index + 1}: observing model-driven NPC dialogue`);
        conversation = await observeDialogue(
          home,
          host,
          resident,
          hostWorldId,
          identities,
          attempt,
          deadline,
        );
      } catch (error) {
        attempt.failure = safeError(error);
        console.log(`Attempt ${index + 1}: ${attempt.failure}`);
      } finally {
        // A timed-out response can still have committed startVisit on the server.
        // No visits existed at preflight, so this resident's visit belongs to this attempt.
        if (!attempt.visitId) {
          attempt.visitId = (await residents(home)).find(
            (r) => r.agentGlobalId === resident.agentGlobalId,
          )?.visitId;
        }
        if (attempt.visitId) await cleanupVisit(home, host, resident, hostWorldId, attempt);
        attempt.finishedAt = Date.now();
        writeEvidence();
      }
      if (conversation) {
        await verifyTranscript(home, host, resident, hostWorldId, attempt, conversation);
        evidence.passed = true;
        break;
      }
    }
    assert.ok(evidence.passed, 'No natural NPC conversation satisfied two real utterances each');
  } finally {
    const after = (await Promise.all(towns.map(models))).map(modelSnapshot);
    assert.deepEqual(
      after,
      originalModels,
      'Original chat bindings and embedding configuration must remain unchanged',
    );
    assert.deepEqual(
      (await world(host, hostWorldId)).agents.map((a) => a.id).sort(),
      originalHostAgentIds,
      'Host must retain only its original NPC agents',
    );
    evidence.fixedBindingsPreserved = true;
    evidence.embeddingConfigurationPreserved = true;
  }
}

try {
  await main();
  console.log(
    'Passed: natural multi-turn NPC dialogue, identical durable transcript, DONE summary, and same resident returned',
  );
} catch (error) {
  evidence.passed = false;
  evidence.failure = safeError(error);
  console.error(`Dialogue proof failed: ${evidence.failure}`);
  process.exitCode = 1;
} finally {
  evidence.finishedAt = Date.now();
  try {
    writeEvidence();
  } catch (error) {
    console.error(`Cannot persist private dialogue evidence: ${safeError(error)}`);
    process.exitCode = 1;
  }
}
