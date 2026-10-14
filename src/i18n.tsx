import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const choices: { value: Locale; label: string }[] = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
  ];
  const selected = choices.findIndex(choice => choice.value === locale);
  function choose(index: number) {
    setLocale(choices[index].value);
    setOpen(false);
    trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <div className="admin-field">
      <span id={`${id}-label`}>{t('Language')}</span>
      <div className="language-picker" ref={container}>
        <button ref={trigger} type="button" className="language-trigger" role="combobox"
          aria-labelledby={`${id}-label`} aria-haspopup="listbox" aria-expanded={open}
          aria-controls={open ? `${id}-options` : undefined}
          aria-activedescendant={open ? `${id}-option-${active}` : undefined}
          onClick={() => { setActive(selected); setOpen(value => !value); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setActive(open ? (active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length : selected);
              setOpen(true);
            } else if (open && (event.key === 'Home' || event.key === 'End')) {
              event.preventDefault(); setActive(event.key === 'Home' ? 0 : choices.length - 1);
            } else if (open && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault(); choose(active);
            } else if (open && event.key === 'Escape') {
              event.preventDefault(); event.stopPropagation(); setOpen(false);
            } else if (event.key === 'Tab') setOpen(false);
          }}>
          <span lang={locale}>{choices[selected].label}</span><span aria-hidden="true">▾</span>
        </button>
        {open && <div id={`${id}-options`} role="listbox" aria-labelledby={`${id}-label`} className="language-options">
          {choices.map((choice, index) => <button key={choice.value} type="button" role="option"
            id={`${id}-option-${index}`} aria-selected={selected === index} tabIndex={-1}
            className={`language-option${active === index ? ' is-active' : ''}`} lang={choice.value}
            onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
            {choice.label}<span aria-hidden="true">{selected === index ? '✓' : ''}</span>
          </button>)}
        </div>}
      </div>
      <small>{t('Language changes apply immediately and are saved in this browser.')}</small>
    </div>
  );
}
