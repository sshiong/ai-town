import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { translate } from '../locale';
import { coreMessages } from '../locales/core';

type Element = { type: any; props: Record<string, any> };
function compile(path: string) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace('import.meta.env.VITE_SHOW_DEBUG_UI', 'false'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
const gameCode = compile('./Game.tsx'), hookCode = compile('../hooks/serverGame.ts');
const jsx = { jsx: (type: any, props: any) => ({ type, props }),
  jsxs: (type: any, props: any) => ({ type, props }), Fragment: 'Fragment' };

test.each(['en', 'zh-CN'] as const)('maintenance hides an incomplete world and skips every map query in %s', language => {
  const status = { worldId: 'partial-world', engineId: 'partial-engine', maintenance: true };
  const calls: { name: string; args: any }[] = [];
  const api = { world: { defaultWorldStatus: 'status', worldState: 'worldState', gameDescriptions: 'gameDescriptions' },
    federation: { runtime: { worldPresence: 'presence' } } };
  const react = { useState: () => [undefined, () => {}], useRef: () => ({ current: null }),
    useMemo: (run: () => any) => run() };
  const query = (name: string, args: any) => {
    calls.push({ name, args });
    if (name === 'status') return status;
    if (args !== 'skip') throw new Error('Incomplete world queried');
    return undefined;
  };
  function require(name: string): any {
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'react') return react;
    if (name === 'convex/react') return { useQuery: query, useConvex: () => ({}) };
    if (name.endsWith('/_generated/api')) return { api };
    if (name === '../i18n') return { useLocale: () => ({ t: (message: string) => translate(language, coreMessages, message) }) };
    if (name === 'usehooks-ts') return { useElementSize: () => [null, {}] };
    if (name === '../hooks/serverGame.ts') {
      const module = { exports: {} };
      runInNewContext(hookCode, { module, exports: module.exports, require });
      return module.exports;
    }
    if (name === '../hooks/useWorldHeartbeat.ts') return { useWorldHeartbeat: () => {} };
    if (name === '../hooks/useHistoricalTime.ts') return { useHistoricalTime: () => ({}) };
    return { default: name };
  }
  const module = { exports: {} as { default: () => Element } };
  runInNewContext(gameCode, { module, exports: module.exports, require });
  const view = module.exports.default();
  expect(view.props.role).toBe('status');
  expect(view.props.children).toContain(language === 'en' ? 'Town maintenance' : '小镇维护');
  expect(calls.filter(call => call.name !== 'status')).toEqual([
    { name: 'presence', args: 'skip' }, { name: 'worldState', args: 'skip' },
    { name: 'gameDescriptions', args: 'skip' }, { name: 'worldState', args: 'skip' },
  ]);
});

test('the game error boundary leaves town administration outside its subtree', () => {
  const module = { exports: {} as { default: () => Element } };
  runInNewContext(compile('../App.tsx'), { module, exports: module.exports, require: (name: string) => {
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'react') return { useState: () => [false, () => {}] };
    if (name === './i18n') return { useLocale: () => ({ t: (message: string) => message }) };
    if (name === './components/ConvexClientProvider.tsx') return { TownErrorBoundary: 'TownErrorBoundary' };
    return { __esModule: true, default: name };
  } });
  function elements(value: any): Element[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!value?.props) return [];
    return [value, ...elements(value.props.children)];
  }
  const tree = elements(module.exports.default());
  const boundary = tree.find(element => element.type === 'TownErrorBoundary' &&
    elements(element).some(child => child.type === './components/Game.tsx'))!;
  expect(elements(boundary).some(element => element.type === './components/Game.tsx')).toBe(true);
  expect(elements(boundary).some(element => element.type === './components/federation/FederationManager.tsx')).toBe(false);
  expect(tree.some(element => element.type === './components/federation/FederationManager.tsx')).toBe(true);
});

test('interaction controls skip the incomplete world and user query during maintenance', () => {
  const worldIds: unknown[] = [], queries: { name: string; args: any }[] = [];
  const api = { world: { defaultWorldStatus: 'status', userStatus: 'user', joinWorld: 'join', leaveWorld: 'leave' } };
  const module = { exports: {} as { default: () => Element } };
  runInNewContext(compile('./buttons/InteractButton.tsx'), { module, exports: module.exports, require: (name: string) => {
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'react') return { useCallback: (callback: any) => callback };
    if (name === '../../i18n') return { useLocale: () => ({ t: (message: string) => message }) };
    if (name === '../../../convex/_generated/api') return { api };
    if (name === '../../hooks/serverGame') return { useServerGame: (worldId: unknown) => { worldIds.push(worldId); } };
    if (name === 'convex/react') return { useConvex: () => ({}), useMutation: () => () => { throw new Error('Maintenance interaction attempted'); },
      useQuery: (name: string, args: any) => {
        queries.push({ name, args });
        if (name === 'status') return { worldId: 'partial-world', maintenance: true };
        if (args !== 'skip') throw new Error('Incomplete world queried');
      } };
    return { __esModule: true, default: name };
  } });
  module.exports.default().props.onClick();
  expect(worldIds).toEqual([undefined]);
  expect(queries).toContainEqual({ name: 'user', args: 'skip' });
});
