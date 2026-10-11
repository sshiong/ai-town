import { coreMessages } from './locales/core';
import { dataMessages } from './locales/data';
import { federationMessages } from './locales/federation';
import { gameModelMessages } from './locales/gameModels';
import { resolveLocale, translate } from './locale';

describe('interface language', () => {
  const messages = { 'Hello {name}': '你好，{name}', 'Count {count}': '数量 {count}' };
  it('keeps English as the default and rejects corrupt preferences', () => {
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale('zh')).toBe('en');
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
  });
  it('switches both ways and preserves untranslated technical details', () => {
    expect(translate('zh-CN', messages, 'Hello {name}', { name: 'Alice' })).toBe('你好，Alice');
    expect(translate('en', messages, 'Hello {name}', { name: 'Alice' })).toBe('Hello Alice');
    expect(translate('zh-CN', messages, 'SERVER_DETAIL')).toBe('SERVER_DETAIL');
  });
  it('interpolates zero literally, preserves missing values and never evaluates markup', () => {
    expect(translate('zh-CN', messages, 'Count {count}', { count: 0 })).toBe('数量 0');
    expect(translate('zh-CN', messages, 'Hello {name}')).toBe('你好，{name}');
    expect(translate('zh-CN', messages, 'Hello {name}', { name: '<script>$&</script>' })).toBe(
      '你好，<script>$&</script>',
    );
  });
});

describe('Chinese translation catalog', () => {
  it('preserves every interpolation parameter in every translated message', () => {
    function parameters(message: string) {
      return Array.from(new Set(message.match(/\{[A-Za-z][A-Za-z0-9_]*\}/g) ?? [])).sort();
    }
    for (const catalog of [coreMessages, dataMessages, federationMessages, gameModelMessages]) {
      for (const [english, chinese] of Object.entries(catalog)) {
        expect({ message: english, parameters: parameters(chinese) }).toEqual({ message: english, parameters: parameters(english) });
        expect(chinese.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
