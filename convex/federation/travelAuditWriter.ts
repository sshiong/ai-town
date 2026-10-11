import type { MutationCtx } from '../_generated/server';

const tables = ['visitLedger', 'visitReservations', 'federationOutbox', 'federationInbox', 'federationPendingActions', 'federationPresenceJobs', 'federationDecisionJobs', 'federationTranscriptJobs'] as const;
const reasons = new Set([
  'ADMIN_RETURN', 'ADMIN_QUEUE_REJECTED', 'AGENT_ALREADY_PRESENT', 'CLOCK_UNCERTAIN',
  'CONFIRM_TIMEOUT', 'DIRECT_DELIVERY_FAILED', 'EMPTY_DECISION', 'EXPIRED', 'FAILED',
  'HOST_CAPACITY_EXCEEDED', 'HOST_CAPACITY_SAMPLE_LIMIT', 'HOST_MAINTENANCE',
  'HOST_REJECTED', 'HOST_RESERVATION_CAPACITY_EXCEEDED', 'HOST_RESOURCE_DEGRADED',
  'HOST_SOURCE_QUOTA_EXCEEDED', 'HOST_VISITOR_QUEUE_PENDING', 'INVALID_STALE_SEQUENCE',
  'LEASE_EXPIRED', 'OBSOLETE', 'OUTBOX_CAPACITY_EXCEEDED', 'OUTBOX_HISTORY_UNAVAILABLE',
  'OUTBOX_MESSAGE_EXPIRED', 'PEER_NOT_FOUND', 'PEER_RETURN', 'RESERVATION_EXPIRED', 'RESIDENT_VISITS_DENIED',
  'STALE_TURN', 'STALE_VISIT', 'STREAM_RESYNC', 'TOWN_CLONE_CONFLICT', 'TRANSCRIPT_OUTBOX_MISSING',
  'TRAVEL_AUTHORIZATION_CHANGED', 'VISITOR_QUEUE_EXPIRED', 'VISITS_NOT_ALLOWED',
]);
function code(value: unknown) {
  if (typeof value !== 'string') return undefined;
  // Never mine arbitrary uppercase fragments from provider errors or peer text.
  const candidate = value.match(/^(?:Error: )?([A-Z][A-Z0-9_]{2,80})(?=:|$)/)?.[1];
  return candidate && (reasons.has(candidate) || /^FEDERATION_HTTP_[1-5][0-9]{2}$/.test(candidate))
    ? candidate : 'UNCLASSIFIED_FAILURE';
}
const summaryFields = [
  'state', 'messageId', 'actionId', 'messageType', 'peerTownId', 'attempts', 'reason',
  'role', 'agentGlobalId', 'homeTownId', 'hostTownId', 'leaseExpiry', 'communicationState',
  'cleanupConfirmed', 'lastDurableEventSeq', 'lastAckedEventSeq', 'ackedAt', 'failedAt',
  'processedAt', 'reservedSlot', 'expiresAt', 'accepted', 'receiptPending', 'committedAck',
  'queuePaused', 'queueReason', 'queueExpiresAt', 'agentAuthorityEpoch', 'visitLeaseVersion',
  'kind', 'eventId', 'pageNumber',
] as const;
/** Apply the same field boundary to retained/imported audit rows before returning them. */
export function sanitizeTravelAuditSummary(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(summaryFields.flatMap(key => {
    const item = value[key];
    if (!['string', 'number', 'boolean'].includes(typeof item)) return [];
    return [[key, key === 'reason' || key === 'queueReason' ? code(item) : item]];
  }));
}
function summary(row: any) {
  if (!row) return undefined;
  const envelope = row.envelope;
  const base = { state: row.state ?? row.status,
    messageId: row.messageId ?? row.pendingMessageId, actionId: row.actionId, messageType: envelope?.type,
    peerTownId: row.toTownId ?? row.fromTownId,
    attempts: row.attempts, reason: code(row.lastError ?? row.error ?? (row.result?.kind === 'error' ? row.result.message : undefined)),
    role: row.role, agentGlobalId: row.agentGlobalId,
    homeTownId: row.homeTownId, hostTownId: row.hostTownId,
    leaseExpiry: row.leaseExpiry, communicationState: row.communicationState,
    cleanupConfirmed: row.cleanupConfirmed, lastDurableEventSeq: row.lastDurableEventSeq,
    lastAckedEventSeq: row.lastAckedEventSeq, ackedAt: row.ackedAt, failedAt: row.failedAt,
    processedAt: row.processedAt, reservedSlot: row.reservedSlot, expiresAt: row.expiresAt,
    accepted: row.result ? row.result.kind === 'ok' : undefined,
    receiptPending: row.receiptPending, committedAck: row.committedAck,
    queuePaused: row.queuePaused, queueReason: code(row.queueReason), queueExpiresAt: row.queueExpiresAt,
    agentAuthorityEpoch: row.agentAuthorityEpoch, visitLeaseVersion: row.visitLeaseVersion,
    kind: row.kind, eventId: row.eventId, pageNumber: row.pageNumber,
  };
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));
}
/** Capture only operational metadata, in the same transaction as the state change. */
export function withTravelAudit(ctx: MutationCtx): MutationCtx {
  const db = ctx.db;
  const wrapped = new Proxy(db, { get(target, property) {
    const method = Reflect.get(target, property);
    if (!['insert', 'patch', 'replace', 'delete'].includes(String(property)))
      return typeof method === 'function' ? method.bind(target) : method;
    return async (...args: any[]) => {
      const table = property === 'insert' ? args[0] : tables.find(name => db.normalizeId(name, args[0]));
      if (!(tables as readonly string[]).includes(table)) return method.apply(target, args);
      const before = property === 'insert' ? null : await (db.get as any)(args[0]);
      const result = await method.apply(target, args);
      const after = property === 'delete' ? null : await (db.get as any)(property === 'insert' ? result : args[0]);
      const row = after ?? before;
      const visitId = row?.visitId ?? row?.envelope?.visitId;
      const previous = summary(before), next = summary(after);
      if (visitId && JSON.stringify(previous) !== JSON.stringify(next)) {
        await db.insert('federationTravelAudit', { visitId, source: table, at: Date.now(),
          operation: property === 'delete' ? 'REMOVED' : property === 'insert' ? 'CREATED' : 'UPDATED',
          previous, next });
      }
      return result;
    };
  } });
  return { ...ctx, db: wrapped };
}
