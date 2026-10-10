import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

export const LOCAL_CHAT_SOURCE = 'local';
// A caller supplies only a durable job ID, never its own claimed source label.
export async function chatSource(ctx: MutationCtx, decisionJobId?: Id<'federationDecisionJobs'>) {
  if (!decisionJobId) return LOCAL_CHAT_SOURCE;
  const job = await ctx.db.get(decisionJobId);
  const ledger =
    job &&
    (await ctx.db
      .query('visitLedger')
      .withIndex('visitId', (q) => q.eq('visitId', job.visitId))
      .unique());
  const runtime =
    ledger &&
    (await ctx.db
      .query('federationAgentRuntimes')
      .withIndex('globalId', (q) => q.eq('agentGlobalId', ledger.agentGlobalId))
      .unique());
  const remote =
    ledger &&
    (await ctx.db
      .query('federationPeers')
      .withIndex('townId', (q) => q.eq('townId', ledger.hostTownId))
      .unique());
  const local = await ctx.db.query('federationIdentity').unique();
  if (
    !job ||
    job.state !== 'RUNNING' ||
    job.deadline <= Date.now() ||
    !ledger ||
    ledger.role !== 'home' ||
    ledger.state !== 'ACTIVE' ||
    ledger.leaseExpiry <= Date.now() ||
    !runtime ||
    runtime.state !== 'TRAVELING' ||
    runtime.visitId !== job.visitId ||
    runtime.activeDecisionId !== job.eventId ||
    runtime.agentAuthorityEpoch !== ledger.agentAuthorityEpoch ||
    !local ||
    ledger.homeTownId !== local.townId ||
    runtime.homeTownId !== local.townId ||
    !remote ||
    remote.trustState !== 'TRUSTED'
  )
    throw new Error('CHAT_SOURCE_AUTHORITY_EXPIRED');
  return `host:${ledger.hostTownId}`;
}

export async function sourceQueueLimit(ctx: MutationCtx, maxPending: number) {
  const trusted = await ctx.db
    .query('federationPeers')
    .filter((q) => q.eq(q.field('trustState'), 'TRUSTED'))
    .take(1001);
  return Math.max(1, Math.ceil(maxPending / (trusted.length + 1)));
}

export async function recordChatSourceGrant(ctx: MutationCtx, source: string) {
  const cursor = await ctx.db
    .query('federationChatScheduling')
    .withIndex('key', (q) => q.eq('key', 'local'))
    .unique();
  const fields = { lastSource: source, updatedAt: Date.now() };
  if (cursor) await ctx.db.patch(cursor._id, fields);
  else await ctx.db.insert('federationChatScheduling', { key: 'local', ...fields });
}

/** Round-robin between authenticated sources; exact FIFO inside each source. */
export async function nextChatRequest(ctx: MutationCtx, pending: Doc<'federationLlmRequests'>[]) {
  if (!pending.length) return undefined;
  const cursor = await ctx.db
    .query('federationChatScheduling')
    .withIndex('key', (q) => q.eq('key', 'local'))
    .unique();
  const sources = [...new Set(pending.map((row) => row.sourceKey ?? LOCAL_CHAT_SOURCE))].sort();
  const source = sources.find((key) => key > (cursor?.lastSource ?? '')) ?? sources[0];
  // pending comes from state_created index; keep its order for equal timestamps.
  return pending.find((row) => (row.sourceKey ?? LOCAL_CHAT_SOURCE) === source);
}
