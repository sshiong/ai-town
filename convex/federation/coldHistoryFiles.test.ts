import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { createIdentityKeys, digest } from './security';
import type { PortableHistory } from './coldHistoryFiles';
const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../federation/coldHistory.ts': () => import('./coldHistory'),
  '../federation/coldHistoryFiles.ts': () => import('./coldHistoryFiles'),
};
const token = 'portable-history-test-admin-token';
const action = (name: string) => makeFunctionReference<'action'>(`federation/${name}`);
const query = (name: string) => makeFunctionReference<'query'>(`federation/${name}`);
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(100000);
  process.env.FEDERATION_ADMIN_TOKEN = token;
  process.env.FEDERATION_KEY_ENCRYPTION_KEY = btoa('12345678901234567890123456789012');
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.FEDERATION_ADMIN_TOKEN;
  delete process.env.FEDERATION_KEY_ENCRYPTION_KEY;
});
type Kind = 'conversation' | 'travel';
async function resident(t: ReturnType<typeof convexTest>, town: string, kind: Kind) {
  return t.run(async (ctx) => {
    const worldId = await ctx.db.insert('worlds', {
      nextId: 100,
      players: [],
      agents: [],
      conversations: [],
    });
    const player = town === 'origin' ? 'p:0' : 'p:8',
      other = town === 'origin' ? 'p:1' : 'p:9',
      conversation = town === 'origin' ? 'c:1' : 'c:77',
      globalId = `${town}/ava`;
    const profile = await ctx.db.insert('chatProfiles', {
      name: 'Fixed model',
      provider: 'ollama',
      url: 'http://localhost:11434',
      model: 'qwen3.5:4b',
      stopWords: [],
      createdAt: 1,
    });
    await ctx.db.insert('residentModelBindings', {
      worldId,
      playerId: player,
      agentGlobalId: globalId,
      chatProfileId: profile,
      createdAt: 1,
      updatedAt: 1,
    });
    let memoryId;
    if (kind === 'conversation') {
      memoryId = await ctx.db.insert('memories', {
        worldId,
        playerId: player,
        agentGlobalId: globalId,
        description: 'Same retained red scarf conversation',
        importance: 5,
        lastAccess: 1,
        data: { type: 'conversation', conversationId: conversation, playerIds: [other] },
      });
      await ctx.db.insert('archivedConversations', {
        worldId,
        id: conversation,
        creator: player,
        created: 1,
        ended: 2,
        numMessages: 3,
        participants: [player, other],
      });
      for (let i = 0; i < 3; i++)
        await ctx.db.insert('messages', {
          worldId,
          conversationId: conversation,
          author: i % 2 ? other : player,
          text: `Original ${i} 原文`,
          messageUuid: `uuid-${i}`,
        });
    } else {
      const visitId = town === 'origin' ? 'original-visit' : 'restored-visit',
        transcriptId = `federation-conversation/${visitId}`;
      memoryId = await ctx.db.insert('memories', {
        worldId,
        playerId: player,
        agentGlobalId: globalId,
        description: 'Same confirmed journey',
        importance: 5,
        lastAccess: 1,
        data: {
          type: 'travel',
          eventId: 'end',
          visitId,
          hostTownId: 'foreign',
          occurredAt: 1,
          participants: [],
          federationConversationId: 'federation-conversation',
        },
      });
      await ctx.db.insert('homeTravelTranscripts', {
        worldId,
        playerId: player,
        agentGlobalId: globalId,
        transcriptId,
        visitId,
        hostTownId: 'foreign',
        federationConversationId: 'federation-conversation',
        endedAt: 2,
        participants: [],
        finalPageNumber: 0,
        receivedPageCount: 1,
        highestPageNumber: 0,
        totalMessageCount: 3,
        state: 'COMPLETE',
        summaryState: 'DONE',
      });
      await ctx.db.insert('homeTravelTranscriptPages', {
        agentGlobalId: globalId,
        transcriptId,
        pageNumber: 0,
        eventId: 'page',
        finalPage: true,
        memoryIds: [],
        messages: Array.from({ length: 3 }, (_, i) => ({
          messageId: `uuid-${i}`,
          text: `Original ${i} 原文`,
          author: i % 2 ? 'foreign/bob' : globalId,
          occurredAt: i + 1,
        })),
      });
    }
    return { adminToken: token, worldId, playerId: player, agentGlobalId: globalId, memoryId };
  });
}
async function town(name: string, kind: Kind) {
  const t = convexTest(schema, modules),
    keys = await createIdentityKeys();
  await t.run((ctx) =>
    ctx.db.insert('federationIdentity', {
      ...keys,
      townId: name,
      townName: name,
      deploymentInstanceId: `${name}-instance`,
      deploymentEpoch: 1,
      endpoint: `https://${name}.example/federation/v1`,
      enabled: true,
      allowIncomingPairRequests: false,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitors: 1,
      maxVisitDurationMs: 300000,
      mode: 'ACTIVE',
      createdAt: 1,
    }),
  );
  return { t, owner: await resident(t, name, kind) };
}
async function sourceFile(kind: Kind) {
  const src = await town('origin', kind);
  await src.t.action(action('coldHistory:archive'), src.owner);
  const file: PortableHistory = await src.t.action(
    action('coldHistoryFiles:exportFile'),
    src.owner,
  );
  return { ...src, file, fingerprint: `sha256:${await digest(file.publicKey)}` };
}
const aliases = (kind: Kind) =>
  kind === 'conversation'
    ? [
        { sourceAuthor: 'p:0', targetAuthor: 'p:8' },
        { sourceAuthor: 'p:1', targetAuthor: 'p:9' },
      ]
    : [{ sourceAuthor: 'origin/ava', targetAuthor: 'copy/ava' }];

test.each<Kind>(['conversation', 'travel'])(
  '%s portable file restores into an independent database with explicit author remapping and immutable source proof',
  async (kind) => {
    const src = await sourceFile(kind);
    jest.setSystemTime(200000);
    const dst = await town('copy', kind);
    const before = await dst.t.run(async (ctx) => ({
      identity: await ctx.db.query('federationIdentity').collect(),
      bindings: await ctx.db.query('residentModelBindings').collect(),
      profiles: await ctx.db.query('chatProfiles').collect(),
      messages: await ctx.db.query('messages').collect(),
      pages: await ctx.db.query('homeTravelTranscriptPages').collect(),
    }));
    const args = {
      ...dst.owner,
      fileJson: JSON.stringify(src.file),
      expectedFingerprint: src.fingerprint,
      authorAliases: aliases(kind),
    };
    const review = await dst.t.action(action('coldHistoryFiles:preflight'), args);
    expect(review.changesFederationTrust).toBe(false);
    expect(review.originalTimesRetained).toBe(true);
    const imported = await dst.t.action(action('coldHistoryFiles:importFile'), {
      ...args,
      confirmation: review.confirmation,
    });
    const discovered = await dst.t.query(query('coldHistory:discover'), dst.owner);
    expect(discovered.archiveId).toBe(imported.archiveId);
    const read = await dst.t.action(action('coldHistory:read'), {
      ...dst.owner,
      offset: 0,
      numItems: 25,
    });
    expect(
      read.page.map((m: any) => {
        const { targetAuthor, ...original } = m;
        return original;
      }),
    ).toEqual(src.file.payload.messages);
    expect(read.page[0].targetAuthor).toBe(kind === 'conversation' ? 'p:8' : 'copy/ava');
    const metadata = await dst.t.run((ctx) =>
      ctx.db.get(imported.archiveId as Id<'coldHistoryArchives'>),
    );
    expect(metadata!.signature).toBe(src.file.signature);
    expect(metadata!.manifest).toEqual(src.file.manifest);
    expect(metadata!.lookupKey).not.toBe(metadata!.sourceKey);
    expect(await dst.t.action(action('coldHistoryFiles:exportFile'), dst.owner)).toEqual(src.file);
    expect(
      await dst.t.run(async (ctx) => ({
        identity: await ctx.db.query('federationIdentity').collect(),
        bindings: await ctx.db.query('residentModelBindings').collect(),
        profiles: await ctx.db.query('chatProfiles').collect(),
        messages: await ctx.db.query('messages').collect(),
        pages: await ctx.db.query('homeTravelTranscriptPages').collect(),
      })),
    ).toEqual(before);
    const retry = await dst.t.action(action('coldHistoryFiles:importFile'), {
      ...args,
      confirmation: review.confirmation,
    });
    expect(retry.archiveId).toBe(imported.archiveId);
    expect((await dst.t.action(action('coldHistory:archive'), dst.owner)).archiveId).toBe(
      imported.archiveId,
    );
  },
);
test('two restored worlds can discover separate local indexes for the same signed original without a unique-index collision', async () => {
  const src = await sourceFile('conversation'),
    dst = await town('copy', 'conversation'),
    second = await resident(dst.t, 'second-copy', 'conversation');
  for (const owner of [dst.owner, second]) {
    const args = {
      ...owner,
      fileJson: JSON.stringify(src.file),
      expectedFingerprint: src.fingerprint,
      authorAliases: aliases('conversation'),
    };
    const p = await dst.t.action(action('coldHistoryFiles:preflight'), args);
    await dst.t.action(action('coldHistoryFiles:importFile'), {
      ...args,
      confirmation: p.confirmation,
    });
  }
  const one = await dst.t.query(query('coldHistory:discover'), dst.owner),
    two = await dst.t.query(query('coldHistory:discover'), second);
  expect(one.archiveId).not.toBe(two.archiveId);
  expect(
    (await dst.t.action(action('coldHistory:read'), { ...second, offset: 0, numItems: 25 })).page,
  ).toHaveLength(3);
});
test('fingerprint, integrity, owner and exact source matching failures never publish a file or alter original messages', async () => {
  const src = await sourceFile('conversation'),
    dst = await town('copy', 'conversation');
  const base = {
    ...dst.owner,
    fileJson: JSON.stringify(src.file),
    expectedFingerprint: src.fingerprint,
    authorAliases: aliases('conversation'),
  };
  await expect(
    dst.t.action(action('coldHistoryFiles:preflight'), { ...base, adminToken: 'wrong' }),
  ).rejects.toThrow('ADMIN_UNAUTHORIZED');
  await expect(
    dst.t.action(action('coldHistoryFiles:preflight'), { ...base, agentGlobalId: 'namesake' }),
  ).rejects.toThrow('SOCIAL_HISTORY_OWNER_MISMATCH');
  await expect(
    dst.t.action(action('coldHistoryFiles:preflight'), {
      ...base,
      expectedFingerprint: 'self-declared-is-not-accepted',
    }),
  ).rejects.toThrow('COLD_FILE_INDEPENDENT_FINGERPRINT_REQUIRED');
  await expect(
    dst.t.action(action('coldHistoryFiles:preflight'), { ...base, authorAliases: [] }),
  ).rejects.toThrow('COLD_FILE_TARGET_MESSAGES_MISMATCH');
  const tampered = structuredClone(src.file);
  tampered.signature = 'forged';
  await expect(
    dst.t.action(action('coldHistoryFiles:preflight'), {
      ...base,
      fileJson: JSON.stringify(tampered),
    }),
  ).rejects.toThrow('COLD_FILE_INTEGRITY_FAILED');
  await dst.t.run(async (ctx) => {
    const row = await ctx.db.query('messages').first();
    await ctx.db.patch(row!._id, { text: 'Different actual target text' });
  });
  await expect(dst.t.action(action('coldHistoryFiles:preflight'), base)).rejects.toThrow(
    'COLD_FILE_TARGET_MESSAGES_MISMATCH',
  );
  expect(await dst.t.run((ctx) => ctx.db.query('coldHistoryArchives').collect())).toHaveLength(0);
  expect(await dst.t.run((ctx) => ctx.db.query('messages').collect())).toHaveLength(3);
});
test('review confirmation binds the exact target memory, closing time and explicit one-to-one author map', async () => {
  const src = await sourceFile('conversation'),
    dst = await town('copy', 'conversation');
  const args = {
    ...dst.owner,
    fileJson: JSON.stringify(src.file),
    expectedFingerprint: src.fingerprint,
    authorAliases: aliases('conversation'),
  };
  const p = await dst.t.action(action('coldHistoryFiles:preflight'), args);
  await dst.t.run(async (ctx) => {
    const row = await ctx.db.query('archivedConversations').first();
    await ctx.db.patch(row!._id, { ended: 3 });
  });
  await expect(
    dst.t.action(action('coldHistoryFiles:importFile'), { ...args, confirmation: p.confirmation }),
  ).rejects.toThrow('COLD_FILE_TARGET_CHANGED_REVIEW_AGAIN');
  await expect(
    dst.t.action(action('coldHistoryFiles:preflight'), {
      ...args,
      authorAliases: [
        { sourceAuthor: 'p:0', targetAuthor: 'p:8' },
        { sourceAuthor: 'p:1', targetAuthor: 'p:8' },
      ],
    }),
  ).rejects.toThrow('COLD_FILE_AUTHOR_MAPPING_INVALID');
  expect(await dst.t.run((ctx) => ctx.db.query('coldHistoryArchives').collect())).toHaveLength(0);
});
test('travel owner alias is required independently of same-name or identical retained messages', async () => {
  const src = await sourceFile('travel'),
    dst = await town('copy', 'travel');
  await expect(
    dst.t.action(action('coldHistoryFiles:preflight'), {
      ...dst.owner,
      fileJson: JSON.stringify(src.file),
      expectedFingerprint: src.fingerprint,
      authorAliases: [],
    }),
  ).rejects.toThrow('COLD_FILE_OWNER_MAPPING_REQUIRED');
});
