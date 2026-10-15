import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Load only the observer: importing the executable would read private config and
// start real travel. All clocks, reads, probes and mutations below are local fakes.
const source = fs.readFileSync(new URL('./federation-dialogue-smoke.mjs', import.meta.url), 'utf8');
const observerSource = source.slice(
  source.indexOf('function sufficient('),
  source.indexOf('async function cleanupVisit('),
);

function scenario({
  tripDeadline = 130_000,
  leaseExpiry = 130_000,
  leaseMs = 30_000,
  deadline = 200_000,
  legacy = false,
  probeMs = 0,
  messages = [],
} = {}) {
  let now = 100_000;
  const renewals = [];
  const pauses = [];
  const ledger = {
    visitId: 'visit',
    state: 'ACTIVE',
    leaseExpiry,
    ...(legacy ? {} : { tripDeadline }),
  };
  const attempt = { visitId: 'visit', hostResidents: [{ playerId: 'resident' }] };
  const context = vm.createContext({
    assert,
    Date: { now: () => now },
    POLL_MS: 3000,
    api: {
      world: { previousConversation: 'previous' },
      messages: { listMessages: 'messages' },
      federation: { ledger: { renewVisit: 'renew' } },
    },
    world: async () => ({
      players: [{ id: 'visitor', remoteVisitor: { visitId: 'visit', agentGlobalId: 'agent' } }],
      conversations: [
        { id: 'conversation', participants: [{ playerId: 'visitor' }, { playerId: 'resident' }] },
      ],
    }),
    status: async () => ({
      visits: [{ ...ledger }],
      settings: {
        maxVisitDurationMs: 300_000,
        timePolicy: { leaseMs },
      },
    }),
    messageFields: (message) => message,
    writeEvidence: () => {},
    auth: () => ({}),
    probePair: async () => {
      now += probeMs;
    },
    pause: async (ms) => {
      pauses.push(ms);
      now += ms;
    },
  });
  const observe = vm.runInContext(`${observerSource}\nobserveDialogue`, context);
  const home = {
    client: {
      mutation: async () => {
        const expiry = Math.min(now + leaseMs, tripDeadline);
        assert.ok(expiry > ledger.leaseExpiry, 'renewal must actually extend the lease');
        assert.ok(now < ledger.leaseExpiry, 'expired leases must not be renewed');
        renewals.push(expiry);
        ledger.leaseExpiry = expiry;
      },
    },
  };
  const host = { client: { query: async (name) => (name === 'previous' ? null : messages) } };
  return {
    run: () => observe(home, host, { agentGlobalId: 'agent' }, 'world', [], attempt, deadline),
    renewals,
    pauses,
    now: () => now,
  };
}

test('a lease already at the trip cap is observed to the cap without renewal', async () => {
  const s = scenario();
  await assert.rejects(s.run(), /trip deadline elapsed without two utterances each/);
  assert.deepEqual(s.renewals, []);
  assert.equal(s.now(), 130_000);
});

test('a renewable lease extends once to the trip cap, then ends at that cap', async () => {
  const s = scenario({ leaseExpiry: 115_000 });
  await assert.rejects(s.run(), /trip deadline elapsed/);
  assert.deepEqual(s.renewals, [130_000]);
  assert.equal(s.now(), 130_000);
});

test('a legacy status without tripDeadline ends at its granted lease', async () => {
  const s = scenario({ legacy: true, leaseExpiry: 110_000 });
  await assert.rejects(s.run(), /legacy lease elapsed/);
  assert.deepEqual(s.renewals, []);
  assert.equal(s.now(), 110_000);
  assert.equal(s.pauses.at(-1), 1000);
});

test('whole dialogue deadline remains bounded before the trip cap', async () => {
  const s = scenario({ deadline: 110_000 });
  await assert.rejects(s.run(), /dialogue deadline elapsed/);
  assert.equal(s.now(), 110_000);
  assert.deepEqual(s.renewals, []);
});

test('a probe that crosses the trip cap cannot trigger a stale renewal', async () => {
  const s = scenario({ leaseExpiry: 115_000, probeMs: 30_000 });
  await assert.rejects(s.run(), /trip deadline elapsed/);
  assert.deepEqual(s.renewals, []);
});

test('two real messages from each participant still satisfy the observer', async () => {
  const messages = ['visitor', 'resident', 'visitor', 'resident'].map((author) => ({
    author,
    text: 'hello',
  }));
  const s = scenario({ messages });
  const result = await s.run();
  assert.equal(result.messages.length, 4);
  assert.deepEqual(s.renewals, []);
});

test('three visitor messages and one resident message do not satisfy the observer', async () => {
  const messages = ['visitor', 'resident', 'visitor', 'visitor'].map((author) => ({
    author,
    text: 'hello',
  }));
  const s = scenario({ messages });
  await assert.rejects(s.run(), /trip deadline elapsed/);
});
