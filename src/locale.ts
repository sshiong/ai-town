export type Locale = 'en' | 'zh-CN';
export const localeStorageKey = 'ai-town-language';
export function resolveLocale(value: unknown): Locale {
  return value === 'zh-CN' ? 'zh-CN' : 'en';
}
export function translate(
  locale: Locale,
  messages: Record<string, string>,
  message: string,
  values: Record<string, string | number> = {},
): string {
  const text = locale === 'zh-CN' ? (messages[message] ?? message) : message;
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : placeholder,
  );
}
