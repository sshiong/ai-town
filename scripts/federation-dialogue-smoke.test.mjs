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

// Run the real configuration and fixed-binding preflight with local fixtures.
// Stop before resident selection and any travel, heartbeat or dialogue reads.
const preflightSource = source.slice(
  source.indexOf('  assert.equal(config.towns?.length'),
  source.indexOf('  const residentGlobalId ='),
);
const bindingSource = source.slice(
  source.indexOf('function modelSnapshot('),
  source.indexOf('async function probePair('),
);
const snapshot = vm.runInNewContext(`${bindingSource}\nmodelSnapshot`);

function snapshotFixture() {
  return {
    chatProfiles: [{ _id: 'chat', provider: 'ollama', model: 'qwen3.5:4b', url: 'http://localhost:11434' }],
    bindings: [{ _id: 'binding', chatProfileId: 'chat', agentGlobalId: 'agent', playerId: 'player', worldId: 'world' }],
    embeddingProfiles: [{ _id: 'profile', model: 'embedding', dimensions: 768, fingerprint: 'fingerprint' }],
    embeddingSpaces: [{
      _id: 'space', _creationTime: 1, createdAt: 1, profileId: 'profile',
      fingerprint: 'fingerprint', embeddingCertificateId: 'certificate', status: 'ACTIVE',
    }, {
      _id: 'inactive', profileId: 'profile', fingerprint: 'fingerprint', status: 'RETIRED',
    }],
    settings: { activeEmbeddingSpaceId: 'space', mainChatProfileId: 'chat' },
  };
}

test('model snapshot permits background embedding failure and validation progress updates', () => {
  const before = snapshotFixture();
  const after = structuredClone(before);
  Object.assign(before.embeddingSpaces[0], {
    validatedAt: 10, validationSampleCount: 1, failure: 'old failure',
    validationJobId: 'old-validation', coverageJobId: 'old-coverage',
  });
  Object.assign(after.embeddingSpaces[0], {
    validatedAt: 20, validationSampleCount: 2, failure: 'background catch-up failure',
    validationJobId: 'new-validation', coverageJobId: 'new-coverage',
  });
  assert.deepEqual(snapshot(after), snapshot(before));
});

test('model snapshot rejects binding, profile, embedding identity and route changes', () => {
  const before = snapshotFixture();
  const changes = [
    ['bindings', 0, 'chatProfileId', 'other-chat'],
    ['bindings', 0, 'agentGlobalId', 'other-agent'],
    ['bindings', 0, 'playerId', 'other-player'],
    ['bindings', 0, 'worldId', 'other-world'],
    ['chatProfiles', 0, 'model', 'qwen3.5:9b'],
    ['chatProfiles', 0, 'provider', 'custom'],
    ['chatProfiles', 0, 'url', 'http://other.example'],
    ['embeddingProfiles', 0, 'dimensions', 1024],
    ['embeddingProfiles', 0, 'model', 'other-model'],
    ['embeddingProfiles', 0, 'fingerprint', 'other-fingerprint'],
    ['embeddingSpaces', 0, '_id', 'other-space'],
    ['embeddingSpaces', 0, 'profileId', 'other-profile'],
    ['embeddingSpaces', 0, 'fingerprint', 'other-fingerprint'],
    ['embeddingSpaces', 0, 'embeddingCertificateId', 'other-certificate'],
    ['embeddingSpaces', 0, 'status', 'FAILED'],
    ['embeddingSpaces', 1, 'status', 'READY'],
  ];
  for (const [table, index, field, value] of changes) {
    const after = structuredClone(before);
    after[table][index][field] = value;
    assert.notDeepEqual(snapshot(after), snapshot(before), `${table}.${field} must remain fixed`);
  }
  for (const field of ['activeEmbeddingSpaceId', 'mainChatProfileId']) {
    const after = structuredClone(before);
    after.settings[field] = 'other-route';
    assert.notDeepEqual(snapshot(after), snapshot(before), `${field} must remain fixed`);
  }
});

async function preflight(configuredModels, actualModels = ['qwen3.5:4b', 'qwen3.5:4b']) {
  const fixtureTowns = configuredModels.map((model, index) => ({
    url: `http://town${index}.example`,
    adminKey: 'fake-key',
    adminToken: 'fake-token',
    ...(model !== null && typeof model === 'object' && !Array.isArray(model) ? model :
      model === undefined ? {} : { expectedChatModel: model }),
  }));
  const evidence = {};
  let clientsCreated = 0;
  const context = vm.createContext({
    assert,
    URL,
    config: { towns: fixtureTowns },
    towns: [],
    evidence,
    EXPECTED_CHAT_MODEL: 'qwen3.5:4b',
    REQUEST_TIMEOUT_MS: 30_000,
    process: { env: {} },
    integerEnvironment: (_name, fallback) => fallback,
    ConvexHttpClient: class {
      constructor() { clientsCreated++; }
      setAdminAuth() {}
    },
    status: async (town) => {
      const index = fixtureTowns.findIndex((t) => t.url === town.url);
      return {
        identity: { townId: `town${index}`, deploymentInstanceId: `instance${index}`, mode: 'ACTIVE' },
        settings: { enabled: true },
        visits: [],
        peers: [{ townId: `town${1 - index}`, trustState: 'TRUSTED' }],
      };
    },
    residents: async () => [{ agentGlobalId: 'agent', playerId: 'player', worldId: 'world' }],
    models: async (town) => ({
      chatProfiles: [{
        _id: 'chat', provider: 'ollama', url: 'http://localhost:11434',
        ...(typeof actualModels[fixtureTowns.findIndex((t) => t.url === town.url)] === 'object'
          ? actualModels[fixtureTowns.findIndex((t) => t.url === town.url)]
          : { model: actualModels[fixtureTowns.findIndex((t) => t.url === town.url)] }),
      }],
      bindings: [{
        _id: 'binding', agentGlobalId: 'agent', playerId: 'player',
        worldId: 'world', chatProfileId: 'chat',
      }],
      embeddingProfiles: [],
      embeddingSpaces: [{ _id: 'embedding', status: 'ACTIVE' }],
      settings: { activeEmbeddingSpaceId: 'embedding' },
    }),
  });
  const run = vm.runInContext(
    `${bindingSource}\n(async () => {\n${preflightSource}\n})`, context,
  );
  return { run, evidence, clientsCreated: () => clientsCreated };
}

test('preflight defaults both towns to the original 4b model', async () => {
  const s = await preflight([undefined, undefined]);
  await s.run();
  assert.deepEqual(Array.from(s.evidence.expectedChatModels), ['qwen3.5:4b', 'qwen3.5:4b']);
});

test('preflight accepts each town fixed to its configured 4b or 9b model', async () => {
  const s = await preflight(['qwen3.5:4b', 'qwen3.5:9b'], ['qwen3.5:4b', 'qwen3.5:9b']);
  await s.run();
  assert.deepEqual(Array.from(s.evidence.expectedChatModels), ['qwen3.5:4b', 'qwen3.5:9b']);
});

test('preflight rejects a fixed model that differs from its town expectation', async () => {
  for (const actual of [['qwen3.5:9b', 'qwen3.5:9b'], ['qwen3.5:4b', 'qwen3.5:4b']]) {
    const s = await preflight(['qwen3.5:4b', 'qwen3.5:9b'], actual);
    await assert.rejects(s.run(), /Dialogue requires the fixed chat model/);
  }
});

test('preflight rejects invalid model configuration before creating clients', async () => {
  for (const invalid of ['', '  ', null, 4, {}, [], 'x'.repeat(257)]) {
    for (const configured of [[invalid, undefined], [undefined, invalid]]) {
      const s = await preflight(configured.map((value) => value === undefined ? undefined : { expectedChatModel: value }));
      await assert.rejects(s.run(), /Town expectedChatModel must be a nonempty string/);
      assert.equal(s.clientsCreated(), 0);
    }
  }
});

const cloudExpectation = {
  expectedChatProvider: 'openai', expectedChatModel: 'cloud-model',
  expectedChatOrigin: 'https://api.example.com',
};
const cloudProfile = {
  provider: 'openai', model: 'cloud-model', url: 'https://api.example.com/private/token-path',
  apiKeyEnv: 'PRIVATE_KEY_NAME', apiKey: 'private-api-key',
};

test('preflight accepts explicit cloud provider and records only provider, model and origin', async () => {
  const s = await preflight([undefined, cloudExpectation], ['qwen3.5:4b', cloudProfile]);
  await s.run();
  assert.deepEqual(JSON.parse(JSON.stringify(s.evidence.chatBindings)), [
    [{ provider: 'ollama', model: 'qwen3.5:4b', origin: 'http://localhost:11434' }],
    [{ provider: 'openai', model: 'cloud-model', origin: 'https://api.example.com' }],
  ]);
  assert.doesNotMatch(JSON.stringify(s.evidence), /token-path|PRIVATE_KEY_NAME|private-api-key/);
});

test('preflight rejects provider, model and origin mismatches', async () => {
  for (const change of [{ provider: 'together' }, { model: 'other' },
    { url: 'https://other.example.com' }, { url: 'https://api.example.com:8443' },
    { url: 'http://api.example.com' }]) {
    const s = await preflight([undefined, cloudExpectation], ['qwen3.5:4b', { ...cloudProfile, ...change }]);
    await assert.rejects(s.run(), /Dialogue requires/);
  }
});

test('non-Ollama config requires explicit model and origin before creating clients', async () => {
  for (const missing of ['expectedChatModel', 'expectedChatOrigin']) {
    const config = { ...cloudExpectation };
    delete config[missing];
    const s = await preflight([config, undefined]);
    await assert.rejects(s.run(), /Non-Ollama requires explicit/);
    assert.equal(s.clientsCreated(), 0);
  }
});

test('preflight rejects invalid or non-origin expectations without exposing their contents', async () => {
  for (const origin of [null, 4, '', 'not-a-url', 'ftp://api.example.com',
    'https://user:secret@api.example.com', 'https://api.example.com/',
    'https://api.example.com/private-secret', 'https://api.example.com?secret=1',
    'https://api.example.com#secret', 'http://api.example.com', 'http://localhost:9999']) {
    const s = await preflight([{ ...cloudExpectation, expectedChatOrigin: origin }, undefined]);
    await assert.rejects(s.run(), (error) => {
      assert.doesNotMatch(error.message, /private-secret|user:secret|secret=1|#secret/);
      return /origin|Origin|HTTP|HTTPS/.test(error.message);
    });
    assert.equal(s.clientsCreated(), 0);
  }
});

test('custom HTTP requires an explicit loopback origin', async () => {
  for (const origin of ['http://localhost:9999', 'http://127.0.0.1:9999', 'http://[::1]:9999']) {
    const s = await preflight([{ ...cloudExpectation, expectedChatProvider: 'custom', expectedChatOrigin: origin }, undefined],
      [{ ...cloudProfile, provider: 'custom', url: origin }, 'qwen3.5:4b']);
    await s.run();
  }
  for (const origin of ['http://host.docker.internal:9999', 'http://192.168.1.1:9999', 'http://cloud.example']) {
    const s = await preflight([{ ...cloudExpectation, expectedChatProvider: 'custom', expectedChatOrigin: origin }, undefined]);
    await assert.rejects(s.run(), /custom HTTP requires explicit loopback/);
    assert.equal(s.clientsCreated(), 0);
  }
});

test('default still rejects remote Ollama, cloud provider and changed default model', async () => {
  for (const change of [{ url: 'https://remote.example.com' }, { provider: 'openai' }, { model: 'other' },
    { url: 'https://user:secret@localhost/private' }, { url: 'invalid-secret-url' }]) {
    const s = await preflight([undefined, undefined], [{ model: 'qwen3.5:4b', ...change }, 'qwen3.5:4b']);
    await assert.rejects(s.run(), (error) => {
      assert.doesNotMatch(error.message, /user:secret|invalid-secret-url/);
      return true;
    });
  }
});

test('unsupported providers reject before creating clients', async () => {
  for (const provider of [null, '', 'unknown', {}, 4]) {
    const s = await preflight([{ ...cloudExpectation, expectedChatProvider: provider }, undefined]);
    await assert.rejects(s.run(), /supported provider/);
    assert.equal(s.clientsCreated(), 0);
  }
});

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
