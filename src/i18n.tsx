import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { localeStorageKey, resolveLocale, translate, type Locale } from './locale';
import { coreMessages } from './locales/core';
import { dataMessages } from './locales/data';
import { federationMessages } from './locales/federation';
import { gameModelMessages } from './locales/gameModels';

const messages = { ...coreMessages, ...dataMessages, ...federationMessages, ...gameModelMessages };
function initialLocale(): Locale {
  try {
    return resolveLocale(localStorage.getItem(localeStorageKey));
  } catch {
    // Language switching remains available when browser storage is disabled.
    return 'en';
  }
}
const LocaleContext = createContext<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (message: string, values?: Record<string, string | number>) => string;
}>({
  locale: 'en',
  setLocale: () => {},
  t: (message, values) => translate('en', {}, message, values),
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState(initialLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = locale === 'zh-CN' ? 'AI 小镇' : 'AI Town';
  }, [locale]);
  useEffect(() => {
    function changed(event: StorageEvent) {
      if (event.key === localeStorageKey || event.key === null)
        updateLocale(resolveLocale(event.newValue));
    }
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  function setLocale(next: Locale) {
    const safe = resolveLocale(next);
    updateLocale(safe);
    try {
      localStorage.setItem(localeStorageKey, safe);
    } catch {
      // Apply in memory even if persistence is unavailable.
    }
  }
  return (
    <LocaleContext.Provider
      value={{
        locale,
        setLocale,
        t: (message, values) => translate(locale, messages, message, values),
      }}
    >
      {children}
    </LocaleContext.Provider>
  );
}
export function useLocale() {
  return useContext(LocaleContext);
}

export function LanguageSetting() {
  const { locale, setLocale, t } = useLocale();
  return (
    <label className="admin-field">
      <span>{t('Language')}</span>
      <select value={locale} onChange={(event) => setLocale(resolveLocale(event.target.value))}>
        <option value="en" lang="en">
          English
        </option>
        <option value="zh-CN" lang="zh-CN">
          简体中文
        </option>
      </select>
      <small>{t('Language changes apply immediately and are saved in this browser.')}</small>
    </label>
  );
}
