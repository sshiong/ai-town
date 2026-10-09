export const DEFAULT_REPLY_TIMEOUT_MS = 25_000;
export const MAX_REPLY_TIMEOUT_MS = 120_000;

export function replyTimeoutMs(value?: number): number {
  const timeout = value ?? DEFAULT_REPLY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 5_000 || timeout > MAX_REPLY_TIMEOUT_MS) {
    throw new Error('INVALID_REPLY_TIMEOUT');
  }
  return timeout;
}
