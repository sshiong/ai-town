import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { mutationRef } from './refs';
import { disclosedVisitorProfile, residentVisitorProfile } from './disclosurePolicy';
import { validateDisclosurePolicyPortable } from './disclosurePolicySchema';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const modules = { '../_generated/server.ts': () => import('../_generated/server'), '../federation/disclosurePolicy.ts': () => import('./disclosurePolicy'),
  '../federation/ledger.ts': () => import('./ledger'), '../federation/transport.ts': () => import('./transport') };
beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.useRealTimers(); delete process.env.FEDERATION_ADMIN_TOKEN; });
const persona = { name: 'Alice', character: 'f1', description: 'Public introduction', privateMemory: 'do not send', modelApiKey: 'do not send' };
const trusted = { townId: 'host:friend', trustState: 'TRUSTED' };

test('only eligible public profile fields cross the disclosure boundary', () => {
  const publicProfile = disclosedVisitorProfile(persona, 'Home', trusted);
  expect(publicProfile).toEqual({ name: 'Alice', character: 'f1', description: 'Public introduction', homeTownName: 'Home' });
  expect(disclosedVisitorProfile(persona, 'Home', trusted, { level: 'FRIEND_TOWNS', allowedTownIds: [] })).toEqual(publicProfile);
  expect(disclosedVisitorProfile(persona, 'Home', { ...trusted, trustState: 'PAUSED' }, { level: 'FRIEND_TOWNS', allowedTownIds: [] }).description).toBe('');
  expect(disclosedVisitorProfile(persona, 'Home', trusted, { level: 'WHITELIST', allowedTownIds: [] }).description).toBe('');
  expect(disclosedVisitorProfile(persona, 'Home', trusted, { level: 'WHITELIST', allowedTownIds: ['host:friend'] })).toEqual(publicProfile);
});

test('saved Home policy is applied to the actual outbound profile and administrator access is required', async () => {
  process.env.FEDERATION_ADMIN_TOKEN = 'disclosure-test-administrator-token';
  const t = convexTest(schema, modules);
  await t.run(ctx => ctx.db.insert('federationIdentity', { townId: 'home', townName: 'Home', publicKey: 'public', privateKeyEncrypted: 'private', fingerprint: 'fp',
    deploymentInstanceId: 'instance', deploymentEpoch: 1, endpoint: 'https://home.example/federation/v1', enabled: true, allowIncomingPairRequests: true,
    allowUnencryptedHttp: false, allowPublicHttp: false, maxVisitors: 8, maxVisitDurationMs: 60_000, mode: 'ACTIVE', createdAt: Date.now() }));
  const args = { adminToken: 'disclosure-test-administrator-token', agentGlobalId: 'home/agent:a', level: 'WHITELIST', allowedTownIds: [], operator: 'Admin', reason: 'Resident privacy choice' };
  await expect(t.mutation(mutationRef('disclosurePolicy/set'), { ...args, adminToken: 'wrong' })).rejects.toThrow();
  await t.mutation(mutationRef('disclosurePolicy/set'), args);
  expect(await t.run(ctx => residentVisitorProfile(ctx.db, 'home/agent:a', persona, 'Home', trusted))).toMatchObject({ description: '', name: 'Alice' });
  expect((await t.run(ctx => ctx.db.query('federationDisclosureAudit').collect()))).toHaveLength(1);
  await expect(t.mutation(mutationRef('disclosurePolicy/set'), { ...args, agentGlobalId: 'other/agent:a' })).rejects.toThrow('RESIDENT_NOT_LOCAL');
});

test('portable disclosure policies reject duplicate/oversized whitelist, invalid IDs and audit notes', () => {
  const fields = { agentGlobalId: 'home/agent:a', level: 'WHITELIST', allowedTownIds: ['host:friend'], updatedAt: 1 };
  expect(() => validateDisclosurePolicyPortable('federationDisclosurePolicy', fields)).not.toThrow();
  expect(() => validateDisclosurePolicyPortable('federationDisclosurePolicy', { ...fields, allowedTownIds: ['host:friend', 'host:friend'] })).toThrow();
  expect(() => validateDisclosurePolicyPortable('federationDisclosurePolicy', { ...fields, allowedTownIds: ['host/invalid'] })).toThrow();
  expect(() => validateDisclosurePolicyPortable('federationDisclosurePolicy', { ...fields, allowedTownIds: Array(101).fill('host') })).toThrow();
  expect(() => validateDisclosurePolicyPortable('federationDisclosurePolicy', { ...fields, updatedAt: -1 })).toThrow();
  const policy = { level: fields.level, allowedTownIds: fields.allowedTownIds };
  expect(() => validateDisclosurePolicyPortable('federationDisclosureAudit', { agentGlobalId: 'home/agent:a', previous: policy, next: policy, createdAt: 1, operator: '', reason: 'test' })).toThrow('DISCLOSURE_REVIEW_DETAILS_REQUIRED');
  expect(() => validateDisclosurePolicyPortable('federationDisclosureAudit', { agentGlobalId: 'home/agent:a', previous: { ...policy, apiKey: 'not-a-policy-field' }, next: policy, createdAt: 1, operator: 'Admin', reason: 'test' })).toThrow('INVALID_DISCLOSURE_AUDIT');
});

test.each([
  { policy: undefined, description: 'Public introduction' },
  { policy: { level: 'FRIEND_TOWNS' as const, allowedTownIds: [] }, description: 'Public introduction' },
  { policy: { level: 'WHITELIST' as const, allowedTownIds: [] }, description: '' },
  { policy: { level: 'WHITELIST' as const, allowedTownIds: ['host:friend'] }, description: 'Public introduction' },
])('new travel reservation persists and queues only the authorized profile: $policy', async ({ policy, description }) => {
  process.env.FEDERATION_ADMIN_TOKEN = 'disclosure-test-administrator-token';
  const t = convexTest(schema, modules);
  const worldId = await t.run(async ctx => {
    await ctx.db.insert('federationIdentity', { townId: 'home', townName: 'Home', publicKey: 'public', privateKeyEncrypted: 'private', fingerprint: 'fp',
      deploymentInstanceId: 'instance', deploymentEpoch: 1, endpoint: 'https://home.example/federation/v1', enabled: true, allowIncomingPairRequests: true,
      allowUnencryptedHttp: false, allowPublicHttp: false, maxVisitors: 8, maxVisitDurationMs: 60_000, mode: 'ACTIVE', createdAt: Date.now() });
    await ctx.db.insert('federationPeers', { ...trusted, townName: 'Friend', publicKey: 'peer-public', fingerprint: 'peer-fp',
      deploymentInstanceId: 'host-instance', deploymentEpoch: 1, endpoint: 'https://host.example/federation/v1', credentialId: 'peer-credential',
      credentialEncrypted: 'private-credential', inboundVisitsAllowed: true, outboundVisitsAllowed: true, pairedAt: Date.now() });
    await ctx.db.insert('transportSessions', { peerTownId: trusted.townId, transportType: 'DIRECT_HTTPS', channelState: 'TRANSPORT_READY',
      localDeploymentEpoch: 1, verifiedPeerDeploymentEpoch: 1, inboundVerifiedAt: Date.now(), outboundVerifiedAt: Date.now() });
    const worldId = await ctx.db.insert('worlds', { nextId: 2, players: [{ id: 'p:0', lastInput: Date.now(), position: { x: 1, y: 1 }, facing: { dx: 1, dy: 0 }, speed: 0 }],
      agents: [{ id: 'a:1', playerId: 'p:0' }], conversations: [] });
    await ctx.db.insert('playerDescriptions', { worldId, playerId: 'p:0', name: persona.name, character: persona.character, description: persona.description });
    await ctx.db.insert('agentDescriptions', { worldId, agentId: 'a:1', identity: 'Private resident identity', plan: 'Private resident plan' });
    const profileId = await ctx.db.insert('chatProfiles', { name: 'Private model binding', provider: 'custom', url: 'https://model.example/v1',
      model: 'private-model-name', stopWords: [], createdAt: Date.now() });
    await ctx.db.insert('residentModelBindings', { worldId, playerId: 'p:0', agentGlobalId: 'home/agent:a', chatProfileId: profileId,
      createdAt: Date.now(), updatedAt: Date.now() });
    if (policy) await ctx.db.insert('federationDisclosurePolicy', { agentGlobalId: 'home/agent:a', ...policy, updatedAt: Date.now() });
    return worldId;
  });
  const result = await t.mutation(mutationRef('ledger/startVisit'), { adminToken: 'disclosure-test-administrator-token',
    peerTownId: trusted.townId, worldId, homePlayerId: 'p:0' });
  const ledger = await t.run(ctx => ctx.db.query('visitLedger').unique());
  const queued = await t.run(ctx => ctx.db.query('federationOutbox').unique());
  const expected = { name: 'Alice', character: 'f1', description, homeTownName: 'Home' };
  expect(ledger).toMatchObject({ visitId: result.visitId, state: 'REQUESTED', profile: expected });
  expect(queued?.envelope).toMatchObject({ type: 'VISIT_RESERVE', payload: { profile: expected } });
  expect(ledger?.profile).toEqual(expected);
  expect(queued?.envelope.payload.profile).toEqual(expected);
  expect((await t.run(ctx => ctx.db.query('playerDescriptions').unique()))?.description).toBe(persona.description);
});
