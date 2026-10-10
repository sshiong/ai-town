import { v } from 'convex/values';

// Schema evaluation must not load runtime functions or scheduler dependencies.
export const resourceLimits = v.object({
  maxResidentAgents: v.number(),
  maxHumanPlayers: v.number(),
  maxVisitReservations: v.number(),
  maxConcurrentLocalLLM: v.number(),
  maxPendingDecisions: v.number(),
  maxPendingLocalLLM: v.number(),
});

export const resourceMetricKind = v.union(
  v.literal('CHAT_QUEUE'),
  v.literal('CHAT_PROVIDER'),
  v.literal('CHAT_SUCCESS'),
  v.literal('CHAT_FAILURE'),
  v.literal('CHAT_ABANDONED'),
  v.literal('INBOUND_EVENT'),
  v.literal('DECISION_SUCCESS'),
  v.literal('DECISION_FAILURE'),
);
