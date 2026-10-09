// Run against two independently deployed towns with working resident model bindings.
// Configuration contains secrets: keep its JSON file outside Git and set permissions to 0600.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api.js';

const path = process.env.FEDERATION_TEST_CONFIG;
if (!path) throw new Error('Set FEDERATION_TEST_CONFIG to the private two-town JSON configuration');
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
const towns = config.towns.map((c) => {
  const client = new ConvexHttpClient(c.url);
  client.setAdminAuth(c.adminKey);
  return { ...c, client };
});
assert.equal(towns.length, 2);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, read, predicate, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await read();
    if (predicate(state)) return state;
    await pause(1000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const status = (t) => t.client.query(api.federation.admin.status, { adminToken: t.adminToken });
const residents = (t) =>
  t.client.query(api.federation.runtime.listResidents, { adminToken: t.adminToken });
const state = async (t, worldId) => (await t.client.query(api.world.worldState, { worldId })).world;
let identities = await Promise.all(towns.map(status));
assert.notEqual(identities[0].identity.townId, identities[1].identity.townId);
if (
  !identities[0].peers.some(
    (p) => p.townId === identities[1].identity.townId && p.trustState === 'TRUSTED',
  )
) {
  const [a, b] = towns;
  const { pairingSecret } = await a.client.action(api.federation.admin.generatePairingSecret, {
    adminToken: a.adminToken,
  });
  const offer = await a.client.action(api.federation.peers.requestPair, {
    adminToken: a.adminToken,
    endpoint: b.endpoint,
    pairingSecret,
  });
  await b.client.action(api.federation.peers.approvePair, {
    adminToken: b.adminToken,
    pairRequestId: offer.pairRequestId,
    pairingSecret,
  });
  await a.client.action(api.federation.peers.continuePair, {
    adminToken: a.adminToken,
    pairRequestId: offer.pairRequestId,
  });
}
for (let i = 0; i < 2; i++) {
  const home = towns[i],
    host = towns[1 - i];
  const hostId = identities[1 - i].identity.townId;
  await home.client.action(api.federation.transport.probe, {
    adminToken: home.adminToken,
    peerTownId: hostId,
  });
  await host.client.action(api.federation.transport.probe, {
    adminToken: host.adminToken,
    peerTownId: identities[i].identity.townId,
  });
  await waitFor(
    'mutual authenticated readiness',
    () => status(home),
    (s) => s.peers.some((p) => p.townId === hostId && p.channelState === 'TRANSPORT_READY'),
  );
  const resident = (await residents(home)).find((r) => r.state === 'HOME_ACTIVE');
  assert.ok(resident, 'Home needs an available resident');
  const hostWorld = await host.client.query(api.world.defaultWorldStatus, {});
  const originalHostAgentCount = (await state(host, hostWorld.worldId)).agents.length;
  const { visitId } = await home.client.mutation(api.federation.ledger.startVisit, {
    adminToken: home.adminToken,
    peerTownId: hostId,
    worldId: resident.worldId,
    homePlayerId: resident.playerId,
  });
  try {
    await waitFor(
      'active visit',
      () => status(home),
      (s) => s.visits.some((v) => v.visitId === visitId && v.state === 'ACTIVE'),
    );
    const homeWorld = await state(home, resident.worldId),
      destination = await state(host, hostWorld.worldId);
    assert.ok(!homeWorld.players.some((p) => p.id === resident.playerId));
    assert.equal(homeWorld.agents.filter((a) => a.id === resident.agentId).length, 1);
    assert.equal(destination.agents.length, originalHostAgentCount);
    assert.equal(destination.players.filter((p) => p.remoteVisitor?.visitId === visitId).length, 1);
    await waitFor(
      'Home decision committed at Host',
      () =>
        host.client.query(api.federation.transport.diagnostics, { adminToken: host.adminToken }),
      (d) =>
        d.actions.some(
          (action) => action.visitId === visitId && action.state === 'COMMITTED' && action.accepted,
        ),
    );
    await waitFor(
      'committed action receipt at Home',
      () =>
        home.client.query(api.federation.transport.diagnostics, { adminToken: home.adminToken }),
      (d) =>
        d.inbox.some(
          (item) =>
            item.visitId === visitId &&
            item.type === 'ACTION_RESULT' &&
            item.status === 'COMMITTED',
        ),
    );
    console.log(`Direction ${i + 1}: authenticated travel and remote decision verified`);
  } finally {
    await home.client.mutation(api.federation.ledger.returnVisit, {
      adminToken: home.adminToken,
      visitId,
    });
  }
  await waitFor(
    'safe return',
    () => residents(home),
    (rs) => rs.some((r) => r.agentGlobalId === resident.agentGlobalId && r.state === 'HOME_ACTIVE'),
  );
  assert.equal(
    (await state(home, resident.worldId)).players.filter((p) => p.id === resident.playerId).length,
    1,
  );
  assert.ok(
    !(await state(host, hostWorld.worldId)).players.some(
      (p) => p.remoteVisitor?.visitId === visitId,
    ),
  );
  console.log(`Direction ${i + 1}: original identity returned, destination presence removed`);
}
