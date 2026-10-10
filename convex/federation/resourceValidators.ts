import { Infer, v } from 'convex/values';

export const hostResourceThresholds = v.object({
  maxCpuPercent: v.number(),
  maxMemoryPercent: v.number(),
  maxSampleAgeMs: v.number(),
});
export function validateHostResourceThresholds(value: Infer<typeof hostResourceThresholds>) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 ||
      !Number.isFinite(value.maxCpuPercent) || value.maxCpuPercent <= 0 || value.maxCpuPercent > 100 ||
      !Number.isFinite(value.maxMemoryPercent) || value.maxMemoryPercent <= 0 || value.maxMemoryPercent > 100 ||
      !Number.isSafeInteger(value.maxSampleAgeMs) || value.maxSampleAgeMs < 5000 || value.maxSampleAgeMs > 120000)
    throw new Error('INVALID_HOST_RESOURCE_THRESHOLDS');
}

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
