import { jest } from '@jest/globals';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../schema';
import { withTravelAudit } from './travelAuditWriter';
import { travelTransitions } from '../../src/components/travelEffects';

const modules = { '../_generated/server.ts': () => import('../_generated/server'), '../federation/travelAudit.ts': () => import('./travelAudit'),
  '../federation/transport.ts': () => import('./transport'), '../federation/ledger.ts': () => import('./ledger'), '../federation/runtime.ts': () => import('./runtime'),
  '../federation/transcripts.ts': () => import('./transcripts') };
const history = makeFunctionReference<'query'>('federation/travelAudit:history');
type AuditPage = { page: Array<{ at: number; next: { messageId: string } }>; isDone: boolean; continueCursor: string };
const adminToken = 'test-admin-token-24-characters';
beforeEach(() => { jest.useFakeTimers(); process.env.FEDERATION_ADMIN_TOKEN = adminToken; });
afterEach(() => jest.useRealTimers());

test('registered delivery, queue and transcript mutations capture real operations without secret error fragments', async () => {
  const t = convexTest(schema, modules);
  const jobId = await t.run(async ctx => {
    await ctx.db.insert('federationOutbox', { messageId: 'actual', toTownId: 'host', envelope: { visitId: 'queued', type: 'VISIT_RESERVE', payload: { privateMemory: 'PRIVATE ORIGINAL' } }, attempts: 0, nextRetryAt: 1 });
    await ctx.db.insert('visitLedger', { visitId: 'queued', agentGlobalId: 'agent', homeTownId: 'home', hostTownId: 'host',
      homeDeploymentEpoch: 1, hostDeploymentEpoch: 1, agentAuthorityEpoch: 1, visitLeaseVersion: 1, leaseExpiry: Date.now() + 10000,
      fencingToken: 'SECRET TOKEN', state: 'QUEUED', role: 'host', profile: { privateMemory: 'PRIVATE ORIGINAL' }, createdAt: 1, updatedAt: 1 });
    const worldId = await ctx.db.insert('worlds', { nextId: 0, players: [], agents: [], conversations: [] });
    return ctx.db.insert('federationTranscriptJobs', { transcriptId: 'transcript', visitId: 'queued', worldId, conversationId: 'c:1',
      federationConversationId: 'federation-conversation', endedAt: 1, participants: [{ privateMemory: 'PRIVATE ORIGINAL' }],
      pageNumber: 0, state: 'WAITING_ACK', pendingMessageId: 'missing-transcript-message', createdAt: 1 });
  });
  await t.mutation(makeFunctionReference<'mutation'>('federation/transport:markDelivery'), { messageId: 'actual', status: 'FAILED', error: 'SECRET_KEY: PRIVATE ORIGINAL' });
  await t.mutation(makeFunctionReference<'mutation'>('federation/ledger:manageQueuedVisit'), { adminToken, visitId: 'queued', operation: 'PAUSE' });
  await t.mutation(makeFunctionReference<'mutation'>('federation/transcripts:flushJob'), { jobId });
  const result = await t.query(history, { adminToken, visitId: 'queued', cursor: null });
  expect(result.page).toHaveLength(3);
  expect(result.page).toEqual(expect.arrayContaining([expect.objectContaining({ next: expect.objectContaining({ attempts: 1, reason: 'UNCLASSIFIED_FAILURE' }) }),
    expect.objectContaining({ next: expect.objectContaining({ queuePaused: true }) }),
    expect.objectContaining({ source: 'federationTranscriptJobs', next: expect.objectContaining({ reason: 'TRANSCRIPT_OUTBOX_MISSING' }) })]));
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE ORIGINAL|SECRET_KEY|SECRET TOKEN|privateMemory|payload|profile|fencingToken/);
});

test('retained action history has real visit/time indexes and excludes action and result text', async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    const engineId = await ctx.db.insert('engines', { generationNumber: 0, running: false });
    const inputId = await ctx.db.insert('inputs', { engineId, number: 0, name: 'federationAction', args: {}, received: 1 });
    for (let i = 0; i < 61; i++) await ctx.db.insert('federationPendingActions', { actionId: `action-${i}`, visitId: i % 2 ? 'other' : 'wanted',
      turnId: 'turn', basedOnEventId: 'event', agentAuthorityEpoch: 1, visitLeaseVersion: 1, inputId, state: 'COMMITTED', createdAt: i,
      action: { text: 'PRIVATE ACTION' }, result: { kind: 'error', message: 'PRIVATE RESULT' }, receiptPending: false });
  });
  const found: number[] = []; let cursor: string | null = null;
  do {
    const page: AuditPage = await t.query(history, { adminToken, source: 'ACTIONS', visitId: 'wanted', from: 10, to: 50, cursor, numItems: 7 });
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE ACTION|PRIVATE RESULT|turnId|basedOnEventId/);
    found.push(...page.page.map((row: any) => row.at));
    if (page.isDone) break;
    cursor = page.continueCursor;
  } while (found.length < 50);
  expect(found).toEqual(Array.from({ length: 21 }, (_, i) => 50 - i * 2));
  const allVisits = await t.query(history, { adminToken, source: 'ACTIONS', from: 10, to: 20, cursor: null });
  expect(allVisits.page).toHaveLength(11);
});

test('retained audit summaries cannot return imported arbitrary payload fields', async () => {
  const t = convexTest(schema, modules);
  await t.run(ctx => ctx.db.insert('federationTravelAudit', { visitId: 'imported', source: 'visitLedger', operation: 'UPDATED', at: 1,
    previous: { state: 'ACTIVE', privateMemory: 'PRIVATE ORIGINAL' }, next: { state: 'COMPLETED', reason: 'SECRET_KEY: PRIVATE ORIGINAL', payload: { apiKey: 'SECRET' } } }));
  const result = await t.query(history, { adminToken, cursor: null });
  expect(result.page[0].next).toEqual({ state: 'COMPLETED', reason: 'UNCLASSIFIED_FAILURE' });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE ORIGINAL|SECRET_KEY|payload|privateMemory|apiKey/);
});

test('public traveling presence retains resident identity without returning private provider errors', async () => {
  const t = convexTest(schema, modules);
  const worldId = await t.run(async ctx => {
    const worldId = await ctx.db.insert('worlds', { nextId: 2, players: [], agents: [{ id: 'a:1', playerId: 'p:0', travelVisitId: 'abroad' }], conversations: [] });
    await ctx.db.insert('playerDescriptions', { worldId, playerId: 'p:0', name: 'Resident', character: 'f1', description: 'Public resident introduction' });
    await ctx.db.insert('federationAgentRuntimes', { worldId, playerId: 'p:0', agentId: 'a:1', agentGlobalId: 'home/resident', homeTownId: 'home',
      state: 'TRAVELING', visitId: 'abroad', agentAuthorityEpoch: 1, updatedAt: 1, lastError: 'Provider error with PRIVATE MEMORY and SECRET KEY' });
    return worldId;
  });
  const presence = await t.query(makeFunctionReference<'query'>('federation/runtime:worldPresence'), { worldId });
  expect(presence.travelers[0]).toMatchObject({ playerId: 'p:0', name: 'Resident', state: 'TRAVELING', lastError: 'TRAVEL_OPERATION_FAILED' });
  expect(presence.visitors).toEqual([]);
  expect(JSON.stringify(presence)).not.toMatch(/PRIVATE MEMORY|SECRET KEY/);
});

test('travel state writes save atomic sanitized transitions, retries, failures and ACKs', async () => {
  const t = convexTest(schema, modules);
  await t.run(async raw => {
    const ctx = withTravelAudit(raw);
    const id = await ctx.db.insert('federationOutbox', { messageId: 'message', toTownId: 'host', envelope: { visitId: 'visit', type: 'DECISION', payload: { privateMemory: 'PRIVATE ORIGINAL', apiKey: 'SECRET KEY' } }, attempts: 0, nextRetryAt: 1 });
    await ctx.db.patch(id, { attempts: 1, lastError: 'FEDERATION_HTTP_503: PRIVATE ORIGINAL', nextRetryAt: 2 });
    await ctx.db.patch(id, { ackedAt: 3 });
    await ctx.db.patch(id, { nextRetryAt: 4 }); // scheduling alone is not a transition
    const slot = await ctx.db.insert('visitReservations', { visitId: 'visit', hostTownId: 'host', expiresAt: 20, reservedSlot: true });
    await ctx.db.patch(slot, { reservedSlot: false });
  });
  const result = await t.query(history, { adminToken, visitId: 'visit', cursor: null });
  expect(result.page).toHaveLength(5);
  const serialized = JSON.stringify(result);
  expect(serialized).toContain('FEDERATION_HTTP_503');
  expect(serialized).toContain('ackedAt');
  expect(serialized).not.toContain('PRIVATE ORIGINAL');
  expect(serialized).not.toContain('SECRET KEY');
  expect(serialized).not.toContain('payload');
  const before = await t.run(ctx => ctx.db.query('federationTravelAudit').collect());
  await expect(t.run(async raw => {
    await withTravelAudit(raw).db.insert('visitReservations', { visitId: 'rolled-back', hostTownId: 'host', expiresAt: 20, reservedSlot: true });
    throw new Error('ROLL_BACK');
  })).rejects.toThrow('ROLL_BACK');
  expect(await t.run(ctx => ctx.db.query('federationTravelAudit').collect())).toEqual(before);
});

test('more than 100 retained events paginate by visit/time with admin auth and exact complete coverage', async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    for (let i = 0; i < 311; i++) await ctx.db.insert('federationTravelAudit', { visitId: i % 2 ? 'other' : 'wanted', source: 'visitLedger', operation: 'UPDATED', at: i, next: { state: 'ACTIVE' } });
    for (let i = 0; i < 121; i++) await ctx.db.insert('federationOutbox', { messageId: `old-${i}`, toTownId: 'host', envelope: { type: 'OBSERVATION', visitId: 'legacy', payload: { text: 'PRIVATE ORIGINAL' } }, attempts: 1, nextRetryAt: i });
  });
  await expect(t.query(history, { adminToken: 'invalid', cursor: null })).rejects.toThrow('FEDERATION_ADMIN_UNAUTHORIZED');
  await expect(t.query(history, { adminToken, cursor: null, numItems: 51 })).rejects.toThrow('INVALID_AUDIT_PAGE_SIZE');
  await expect(t.query(history, { adminToken, cursor: null, from: 3, to: 2 })).rejects.toThrow('INVALID_AUDIT_TIME_RANGE');
  const found: number[] = []; let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page: AuditPage = await t.query(history, { adminToken, visitId: 'wanted', from: 20, to: 300, cursor, numItems: 17 });
    found.push(...page.page.map((row: any) => row.at));
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  expect(found).toEqual(Array.from({ length: 141 }, (_, i) => 300 - i * 2));
  const legacy: string[] = []; cursor = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page: AuditPage = await t.query(history, { adminToken, visitId: 'legacy', source: 'DELIVERY', cursor, numItems: 17 });
    expect(JSON.stringify(page)).not.toContain('PRIVATE ORIGINAL');
    legacy.push(...page.page.map((row: any) => row.next.messageId));
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  expect(new Set(legacy).size).toBe(121);
});

test('pixel effects reflect travel presence only and never keep a duplicate player', () => {
  const host = { id: 'visitor', x: 4, y: 5, visitId: 'trip' };
  expect(travelTransitions(undefined, [host], new Set(), new Set(), 0)).toEqual([]);
  expect(travelTransitions([], [host], new Set(), new Set(), 1)).toMatchObject([{ kind: 'arrival', x: 4, y: 5 }]);
  expect(travelTransitions([host], [], new Set(), new Set(), 2)).toMatchObject([{ kind: 'departure', x: 4, y: 5 }]);
  expect(travelTransitions([host], [host], new Set(), new Set(), 3)).toEqual([]);
  const local = { id: 'resident', x: 2, y: 3 };
  expect(travelTransitions([local], [], new Set(['resident']), new Set(), 4)[0].kind).toBe('departure');
  expect(travelTransitions([], [local], new Set(), new Set(['resident']), 5)[0].kind).toBe('arrival');
  expect(travelTransitions([local], [], new Set(), new Set(), 6)).toEqual([]); // disconnect/removal is not a travel fact
  expect(travelTransitions([], [local], new Set(), new Set(), 7)).toEqual([]); // new resident is not a visitor
});
