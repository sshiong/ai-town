import {
  appendTranslationIds,
  latestTranslationIds,
  needsChineseTranslation,
  nextHistoryTranslationIds,
  subscribedTranslationIds,
  translationBatches,
  unrequestedTranslationIds,
} from './messageTranslationPolicy';

const messages = Array.from({ length: 67 }, (_, index) => ({
  _id: `message-${index}`,
  text: `Hello ${index}`,
}));

describe('chat translation selection', () => {
  it('makes no English-mode requests and leaves Chinese and non-language messages alone', () => {
    expect(latestTranslationIds(messages, 'en')).toEqual([]);
    expect(needsChineseTranslation('Hello there!')).toBe(true);
    expect(needsChineseTranslation('你好')).toBe(false);
    expect(needsChineseTranslation('你好 Alice')).toBe(false);
    expect(needsChineseTranslation('😊 123')).toBe(false);
  });

  it('starts with a bounded latest window and allows the complete older history in explicit batches', () => {
    let selected = latestTranslationIds(messages, 'zh-CN');
    expect(selected).toEqual(messages.slice(-20).map((message) => message._id));
    let next = nextHistoryTranslationIds(messages, selected);
    const batchLengths: number[] = [];
    while (next.length > 0) {
      batchLengths.push(next.length);
      selected = appendTranslationIds(selected, next);
      next = nextHistoryTranslationIds(messages, selected);
    }
    expect(batchLengths).toEqual([20, 20, 7]);
    expect(new Set(selected).size).toBe(messages.length);
    expect(translationBatches(selected).map((batch) => batch.length)).toEqual([20, 20, 20, 7]);
  });

  it('adds new messages without losing pending earlier messages or re-requesting known failures', () => {
    const selected = latestTranslationIds(messages, 'zh-CN');
    const live = [...messages, { _id: 'new-message', text: 'A new arrival' }];
    const combined = appendTranslationIds(selected, latestTranslationIds(live, 'zh-CN'));
    expect(combined).toHaveLength(21);
    expect(combined).toContain(selected[0]);
    expect(combined).toContain('new-message');
    const known = [
      { messageId: 'ready', status: 'READY', sourceText: 'Hello' },
      { messageId: 'failed', status: 'FAILED', sourceText: 'Hello' },
      { messageId: 'queued', status: 'QUEUED', sourceText: 'Hello' },
    ];
    expect(
      unrequestedTranslationIds(
        ['ready', 'failed', 'queued', 'attempted', 'missing'].map((_id) => ({
          _id,
          text: 'Hello',
        })),
        known,
        new Map([['attempted', 'Hello']]),
      ),
    ).toEqual(['missing']);
  });

  it('requests a changed source once and does not reuse a translation of older text', () => {
    const updated = [{ _id: 'same-id', text: 'Updated original message' }];
    const cached = [{ messageId: 'same-id', sourceText: 'Original message', status: 'READY' }];
    const attempted = new Map([['same-id', 'Original message']]);
    expect(unrequestedTranslationIds(updated, cached, attempted)).toEqual(['same-id']);
    attempted.set('same-id', updated[0].text);
    expect(unrequestedTranslationIds(updated, cached, attempted)).toEqual([]);
  });

  it('retires completed automatic history while retaining live, pending, explicit and changed sources', () => {
    const cached = new Map(
      messages.map((message) => [message._id, { status: 'READY', sourceText: message.text }]),
    );
    const allIds = messages.map((message) => message._id);
    const latest = latestTranslationIds(messages, 'zh-CN');
    expect(
      subscribedTranslationIds(messages, allIds, latest, new Set(), cached, new Set()),
    ).toEqual(latest);
    cached.set(allIds[1], { status: 'QUEUED', sourceText: messages[1].text });
    cached.set(allIds[2], { status: 'FAILED', sourceText: messages[2].text });
    cached.set(allIds[3], { status: 'READY', sourceText: 'Earlier version' });
    const subscribed = subscribedTranslationIds(
      messages.slice(1),
      allIds,
      latest,
      new Set([allIds[4]]),
      cached,
      new Set([allIds[5]]),
    );
    expect(subscribed).toEqual([...allIds.slice(1, 6), ...latest]);
    // A retired record whose source changes re-enters even after it left selected IDs.
    expect(
      subscribedTranslationIds(messages, latest, latest, new Set(), cached, new Set()),
    ).toContain(allIds[3]);
  });
});
