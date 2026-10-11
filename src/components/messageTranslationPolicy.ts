import type { Locale } from '../locale';

export const translationBatchSize = 20;

export function needsChineseTranslation(text: string): boolean {
  return /[A-Za-z]/.test(text) && !/[\u3400-\u9fff]/.test(text);
}

export function latestTranslationIds<T extends { _id: string; text: string }>(
  messages: T[],
  locale: Locale,
): T['_id'][] {
  if (locale !== 'zh-CN') return [];
  return messages
    .filter((message) => needsChineseTranslation(message.text))
    .slice(-translationBatchSize)
    .map((message) => message._id);
}

export function appendTranslationIds<T extends string>(selected: T[], added: T[]): T[] {
  return [...new Set([...selected, ...added])];
}

export function subscribedTranslationIds<T extends { _id: string; text: string }>(
  messages: T[],
  selected: T['_id'][],
  latest: T['_id'][],
  history: ReadonlySet<T['_id']>,
  records: ReadonlyMap<T['_id'], { status: string; sourceText?: string }>,
  retrying: ReadonlySet<T['_id']>,
): T['_id'][] {
  const sources = new Map(messages.map((message) => [message._id, message.text]));
  const latestSet = new Set(latest);
  const changed = [...records]
    .filter(([id, record]) => sources.has(id) && sources.get(id) !== record.sourceText)
    .map(([id]) => id);
  return appendTranslationIds(appendTranslationIds(selected, latest), changed).filter((id) => {
    if (!sources.has(id)) return false;
    if (latestSet.has(id) || history.has(id) || retrying.has(id)) return true;
    const record = records.get(id);
    return record?.status !== 'READY' || record.sourceText !== sources.get(id);
  });
}

export function nextHistoryTranslationIds<T extends { _id: string; text: string }>(
  messages: T[],
  selected: T['_id'][],
): T['_id'][] {
  const selectedSet = new Set(selected);
  return messages
    .filter((message) => needsChineseTranslation(message.text) && !selectedSet.has(message._id))
    .slice(-translationBatchSize)
    .map((message) => message._id);
}

export function translationBatches<T>(ids: T[]): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < ids.length; start += translationBatchSize) {
    batches.push(ids.slice(start, start + translationBatchSize));
  }
  return batches;
}

export function unrequestedTranslationIds<T extends { _id: string; text: string }>(
  messages: T[],
  existing: { messageId: T['_id']; sourceText?: string }[],
  attempted: Map<T['_id'], string>,
): T['_id'][] {
  const existingSources = new Map(existing.map((record) => [record.messageId, record.sourceText]));
  return messages
    .filter(
      (message) =>
        existingSources.get(message._id) !== message.text &&
        attempted.get(message._id) !== message.text,
    )
    .map((message) => message._id);
}
