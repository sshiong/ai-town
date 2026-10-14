import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { GameId } from '../../convex/aiTown/ids';
import { useLocale } from '../i18n';
import { needsChineseTranslation } from './messageTranslationPolicy';

export function PlayerTextTranslation({
  worldId,
  playerId,
  field,
  text,
}: {
  worldId: Id<'worlds'>;
  playerId: GameId<'players'>;
  field: 'description' | 'activity';
  text: string;
}) {
  const { locale, t } = useLocale();
  const enabled = locale === 'zh-CN' && needsChineseTranslation(text);
  const args = { worldId, playerId, field };
  const cached = useQuery(api.playerTextTranslations.get, enabled ? args : 'skip');
  const request = useMutation(api.playerTextTranslations.request);
  const record = cached?.sourceText === text ? cached : null;
  const key = JSON.stringify([worldId, playerId, field, text]);
  const attempted = useRef<string>();
  const [failedKey, setFailedKey] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const [now, setNow] = useState(Date.now);
  const retryAt = record?.retryAt;
  useEffect(() => {
    if (!retryAt || retryAt <= Date.now()) return;
    const timeout = window.setTimeout(() => setNow(Date.now()), retryAt - Date.now());
    return () => window.clearTimeout(timeout);
  }, [retryAt]);
  useEffect(() => {
    if (!enabled || cached === undefined || record || attempted.current === key) return;
    attempted.current = key;
    void request({ worldId, playerId, field })
      .then((result) => {
        if (!result.queued) setFailedKey(key);
      })
      .catch(() => setFailedKey(key));
  }, [enabled, cached, record, key, request, worldId, playerId, field]);
  if (!enabled) return <>{text}</>;
  if (record?.status === 'READY' && record.translatedText)
    return (
      <>
        <span lang="zh-CN">{record.translatedText}</span>
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer">{t('View original text')}</summary>
          <span lang="en">{text}</span>
        </details>
      </>
    );
  const failed = record?.status === 'FAILED' || failedKey === key;
  const coolingDown = !!retryAt && retryAt > Math.max(now, Date.now());
  const retryAllowed = !record || retryAt !== undefined;
  return (
    <>
      <span>{text}</span>
      <span className="block mt-2 text-sm" role="status">
        {failed
          ? t('Translation unavailable. Original text shown.')
          : t('Translating… Original text shown.')}
        {failed && retryAllowed && (
          <>
            {' '}
            <button
              type="button"
              className="underline disabled:opacity-50"
              disabled={retrying || coolingDown}
              onClick={() => {
                setRetrying(true);
                setFailedKey(undefined);
                void request({ worldId, playerId, field })
                  .then((result) => {
                    if (!result.queued) setFailedKey(key);
                  })
                  .catch(() => setFailedKey(key))
                  .finally(() => setRetrying(false));
              }}
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
      </span>
    </>
  );
}
