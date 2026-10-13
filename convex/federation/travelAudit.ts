import { v } from 'convex/values';
import { query } from '../maintenanceFunctions';
import { assertFederationAdmin } from './auth';
import { sanitizeTravelAuditSummary } from './travelAuditWriter';
import type { RemoteAction } from './decision';
import type { Doc } from '../_generated/dataModel';

const actionTypes: Record<RemoteAction['type'], true> = {
  say: true, moveTo: true, inviteToTalk: true, acceptInvite: true,
  rejectInvite: true, leaveConversation: true, leaveTown: true, wait: true,
};
function actionSummary(row: Doc<'federationPendingActions'>) {
  const actionType = typeof row.action?.type === 'string' && Object.hasOwn(actionTypes, row.action.type)
    ? row.action.type as RemoteAction['type'] : undefined;
  const target = actionType === 'moveTo' ? row.action.destination : undefined;
  // Retained/imported actions are untrusted. Project only legal integer coordinates,
  // never the action object, text, observation or arbitrary result fields.
  const destination = target && !Array.isArray(target) &&
    Number.isSafeInteger(target.x) && Number.isSafeInteger(target.y)
    ? { x: target.x as number, y: target.y as number } : undefined;
  return { actionId: row.actionId, actionType, destination, turnId: row.turnId,
    basedOnEventId: row.basedOnEventId, agentAuthorityEpoch: row.agentAuthorityEpoch,
    visitLeaseVersion: row.visitLeaseVersion, state: row.state,
    accepted: row.result ? row.result.kind === 'ok' : undefined, receiptPending: row.receiptPending };
}

export const history = query({
  args: { adminToken: v.string(), visitId: v.optional(v.string()), from: v.optional(v.number()), to: v.optional(v.number()),
    cursor: v.union(v.string(), v.null()), numItems: v.optional(v.number()),
    source: v.optional(v.union(v.literal('AUDIT'), v.literal('DELIVERY'), v.literal('RECEIPTS'), v.literal('VISITS'), v.literal('ACTIONS'))) },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    const count = args.numItems ?? 25;
    if (!Number.isSafeInteger(count) || count < 1 || count > 50) throw new Error('INVALID_AUDIT_PAGE_SIZE');
    if (args.visitId !== undefined && (!args.visitId.trim() || args.visitId.length > 256)) throw new Error('INVALID_VISIT_ID');
    const from = args.from ?? 0, to = args.to ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new Error('INVALID_AUDIT_TIME_RANGE');
    const source = args.source ?? 'AUDIT';
    const table = source === 'AUDIT' ? 'federationTravelAudit' : source === 'DELIVERY' ? 'federationOutbox' : source === 'RECEIPTS' ? 'federationInbox' : source === 'ACTIONS' ? 'federationPendingActions' : 'visitLedger';
    const time = source === 'AUDIT' ? 'at' : source === 'DELIVERY' ? '_creationTime' : source === 'RECEIPTS' ? 'receivedAt' : 'createdAt';
    const visitField = source === 'DELIVERY' || source === 'RECEIPTS' ? 'envelope.visitId' : 'visitId';
    // Each category has its own indexed cursor. No union scan or full-history collect.
    const indexed = (ctx.db.query(table) as any).withIndex(args.visitId ? (source === 'AUDIT' ? 'visit_time' : source === 'DELIVERY' ? 'visit' : 'audit_visit_time') : (source === 'AUDIT' ? 'time' : source === 'DELIVERY' ? 'by_creation_time' : 'audit_time'), (q: any) => {
      const range = args.visitId ? q.eq(visitField, args.visitId) : q;
      return range.gte(time, from).lte(time, to);
    });
    const page = await indexed.order('desc').paginate({ cursor: args.cursor, numItems: count, maximumBytesRead: 256000 });
    return { ...page, page: page.page.map((row: any) => {
      if (source === 'AUDIT') return { _id: row._id, at: row.at, visitId: row.visitId, source: row.source,
        operation: row.operation, previous: sanitizeTravelAuditSummary(row.previous), next: sanitizeTravelAuditSummary(row.next) };
      const base = { _id: row._id, at: row[time], visitId: row.visitId ?? row.envelope?.visitId, source, operation: 'RETAINED_RECORD' };
      // Existing records provide retained delivery/visit facts; they cannot reconstruct old transitions.
      return { ...base, next: source === 'VISITS' ? { state: row.state, role: row.role, homeTownId: row.homeTownId, hostTownId: row.hostTownId,
        communicationState: row.communicationState, leaseExpiry: row.leaseExpiry, cleanupConfirmed: row.cleanupConfirmed }
        : source === 'ACTIONS' ? actionSummary(row)
        : { messageId: row.messageId, messageType: row.envelope?.type, state: row.status,
          peerTownId: row.toTownId ?? row.fromTownId, attempts: row.attempts, ackedAt: row.ackedAt, failedAt: row.failedAt, processedAt: row.processedAt } };
    }) };
  },
});
