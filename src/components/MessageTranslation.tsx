import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { useLocale } from '../i18n';
import {
  appendTranslationIds,
  latestTranslationIds,
  needsChineseTranslation,
  nextHistoryTranslationIds,
  subscribedTranslationIds,
  translationBatches,
  unrequestedTranslationIds,
} from './messageTranslationPolicy';

type Translation = FunctionReturnType<typeof api.messageTranslations.list>[number];
type Message = { _id: Id<'messages'>; text: string };
type TranslationContextValue = {
  records: Map<Id<'messages'>, Translation>;
  selected: Set<Id<'messages'>>;
  errors: Map<Id<'messages'>, string>;
  retrying: Set<Id<'messages'>>;
  retry: (messageId: Id<'messages'>) => Promise<void>;
};
const TranslationContext = createContext<TranslationContextValue | null>(null);

// Keep each reactive subscription and request bounded, including explicitly loaded history.
function TranslationBatch({
  worldId,
  conversationId,
  messages,
  attempted,
  onRecords,
  onFailure,
}: {
  worldId: Id<'worlds'>;
  conversationId: string;
  messages: Message[];
  attempted: Map<Id<'messages'>, string>;
  onRecords: (records: Translation[]) => void;
  onFailure: (messages: Message[]) => void;
}) {
  const messageIds = useMemo(() => messages.map((message) => message._id), [messages]);
  const records = useQuery(api.messageTranslations.list, { worldId, conversationId, messageIds });
  const request = useMutation(api.messageTranslations.request);
  useEffect(() => {
    if (records === undefined) return;
    onRecords(records);
    const missing = unrequestedTranslationIds(messages, records, attempted);
    if (missing.length === 0) return;
    const missingSet = new Set(missing);
    const missingMessages = messages.filter((message) => missingSet.has(message._id));
    messages.forEach((message) => {
      if (missingSet.has(message._id)) attempted.set(message._id, message.text);
    });
    void request({ worldId, conversationId, messageIds: missing })
      .then((result) => {
        if (!result.queued) onFailure(missingMessages);
      })
      .catch(() => onFailure(missingMessages));
  }, [records, messages, worldId, conversationId, request, onRecords, onFailure, attempted]);
  return null;
}

export function MessageTranslations({
  worldId,
  conversationId,
  messages,
  children,
}: {
  worldId: Id<'worlds'>;
  conversationId: string;
  messages: Message[];
  children: ReactNode;
}) {
  const { locale, t } = useLocale();
  const request = useMutation(api.messageTranslations.request);
  const latestIds = useMemo(() => latestTranslationIds(messages, locale), [messages, locale]);
  const [selectedIds, setSelectedIds] = useState<Id<'messages'>[]>(latestIds);
  const [history, setHistory] = useState(new Set<Id<'messages'>>());
  const [records, setRecords] = useState(new Map<Id<'messages'>, Translation>());
  const [errors, setErrors] = useState(new Map<Id<'messages'>, string>());
  const [retrying, setRetrying] = useState(new Set<Id<'messages'>>());
  const attempted = useRef(new Map<Id<'messages'>, string>());
  const currentMessages = useMemo(
    () =>
      new Map(
        messages
          .filter((message) => needsChineseTranslation(message.text))
          .map((message) => [message._id, message]),
      ),
    [messages],
  );
  const activeIds = useMemo(
    () =>
      subscribedTranslationIds(
        [...currentMessages.values()],
        selectedIds,
        latestIds,
        history,
        records,
        retrying,
      ),
    [selectedIds, latestIds, currentMessages, history, records, retrying],
  );
  useEffect(() => {
    // Retain subscriptions for earlier live messages until their queued translations finish.
    if (
      activeIds.length !== selectedIds.length ||
      activeIds.some((id, index) => selectedIds[index] !== id)
    )
      setSelectedIds(activeIds);
  }, [activeIds, selectedIds]);
  const batches = useMemo(
    () => translationBatches(activeIds.map((id) => currentMessages.get(id)!)),
    [activeIds, currentMessages],
  );
  const selected = useMemo(() => new Set(activeIds), [activeIds]);
  const historyIds = useMemo(
    () =>
      nextHistoryTranslationIds(
        messages,
        appendTranslationIds(
          activeIds,
          [...records]
            .filter(
              ([id, record]) =>
                record.status === 'READY' && record.sourceText === currentMessages.get(id)?.text,
            )
            .map(([id]) => id),
        ),
      ),
    [messages, activeIds, records, currentMessages],
  );
  const onRecords = useCallback((updated: Translation[]) => {
    if (updated.length === 0) return;
    setRecords((previous) => {
      const changed = updated.some((record) => {
        const cached = previous.get(record.messageId);
        return (
          !cached ||
          cached.status !== record.status ||
          cached.sourceText !== record.sourceText ||
          cached.translatedText !== record.translatedText ||
          cached.errorCode !== record.errorCode ||
          cached.retryAt !== record.retryAt
        );
      });
      if (!changed) return previous;
      const next = new Map(previous);
      updated.forEach((record) => next.set(record.messageId, record));
      return next;
    });
  }, []);
  const onFailure = useCallback((failedMessages: Message[]) => {
    setErrors(
      (previous) =>
        new Map([
          ...previous,
          ...failedMessages.map((message) => [message._id, message.text] as const),
        ]),
    );
  }, []);
  const retry = useCallback(
    async (messageId: Id<'messages'>) => {
      const message = currentMessages.get(messageId);
      if (!message) return;
      attempted.current.set(messageId, message.text);
      setRetrying((previous) => new Set([...previous, messageId]));
      setErrors((previous) => {
        const next = new Map(previous);
        next.delete(messageId);
        return next;
      });
      try {
        const result = await request({ worldId, conversationId, messageIds: [messageId] });
        if (!result.queued) onFailure([message]);
      } catch {
        onFailure([message]);
      } finally {
        setRetrying((previous) => {
          const next = new Set(previous);
          next.delete(messageId);
          return next;
        });
      }
    },
    [request, worldId, conversationId, onFailure, currentMessages],
  );
  return (
    <TranslationContext.Provider value={{ records, selected, errors, retrying, retry }}>
      {locale === 'zh-CN' && (
        <>
          <p className="text-brown-700 text-sm mb-3">
            {t(
              'Chinese translations are generated by the current main Chat model. You can view the original message.',
            )}
          </p>
          {historyIds.length > 0 && (
            <button
              type="button"
              className="text-brown-700 underline mb-4"
              onClick={() => {
                setHistory((previous) => new Set([...previous, ...historyIds]));
                setSelectedIds(appendTranslationIds(activeIds, historyIds));
              }}
            >
              {t('Translate {count} earlier messages', { count: historyIds.length })}
            </button>
          )}
          {batches.map((batchMessages, index) => (
            <TranslationBatch
              key={index}
              worldId={worldId}
              conversationId={conversationId}
              messages={batchMessages}
              attempted={attempted.current}
              onRecords={onRecords}
              onFailure={onFailure}
            />
          ))}
        </>
      )}
      {children}
    </TranslationContext.Provider>
  );
}

export function MessageTranslation({ message }: { message: Message }) {
  const { locale, t } = useLocale();
  const translations = useContext(TranslationContext);
  const cachedRecord = translations?.records.get(message._id);
  const record = cachedRecord?.sourceText === message.text ? cachedRecord : undefined;
  const [now, setNow] = useState(Date.now);
  const retryAt = record?.status === 'FAILED' ? record.retryAt : undefined;
  useEffect(() => {
    if (!retryAt || retryAt <= Date.now()) return;
    const timeout = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(retryAt - Date.now(), 2_147_483_647),
    );
    return () => window.clearTimeout(timeout);
  }, [retryAt]);
  if (locale !== 'zh-CN' || !needsChineseTranslation(message.text) || !translations) {
    return <p className="bg-white -mx-3 -my-1">{message.text}</p>;
  }
  if (record?.status === 'READY' && record.translatedText) {
    return (
      <div className="bg-white -mx-3 -my-1">
        <p lang="zh-CN">{record.translatedText}</p>
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-brown-700">{t('View original message')}</summary>
          <p lang="en" className="mt-1">
            {message.text}
          </p>
        </details>
      </div>
    );
  }
  const failed = record
    ? record.status === 'FAILED'
    : translations.errors.get(message._id) === message.text;
  const terminalFailure = record?.status === 'FAILED' && retryAt === undefined;
  const retrying = translations.retrying.has(message._id);
  const coolingDown = !!retryAt && retryAt > Math.max(now, Date.now());
  return (
    <div className="bg-white -mx-3 -my-1">
      <p>{message.text}</p>
      {translations.selected.has(message._id) && (
        <p className="mt-2 text-sm text-brown-700" role={failed ? 'status' : undefined}>
          {failed
            ? t('Translation unavailable. Original message shown.')
            : t('Translating… Original message shown.')}
          {failed && !terminalFailure && (
            <>
              {' '}
              <button
                type="button"
                className="underline disabled:opacity-50"
                disabled={retrying || coolingDown}
                onClick={() => void translations.retry(message._id)}
              >
                {retrying ? t('Retrying translation…') : t('Retry translation')}
              </button>
              {coolingDown && (
                <>
                  {' '}
                  {t('Retry available at {time}', {
                    time: new Date(retryAt).toLocaleTimeString(locale),
                  })}
                </>
              )}
            </>
          )}
          {terminalFailure && <> {t('This message cannot be retried.')}</>}
        </p>
      )}
    </div>
  );
}
