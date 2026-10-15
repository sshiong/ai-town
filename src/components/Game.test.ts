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

function playerDetailsView(token: string | undefined, state: 'waiting' | 'approaching' | 'participating' | 'invited', language: 'en' | 'zh-CN' = 'en') {
  const human = { id: 'p:1', human: 'test-human' }, npc = { id: 'p:0' };
  const humanStatus = state === 'invited' ? { kind: 'invited' }
    : state === 'participating' ? { kind: 'participating', started: 1 } : { kind: 'walkingOver' };
  const npcStatus = state === 'waiting' ? { kind: 'invited' }
    : state === 'participating' ? { kind: 'participating', started: 1 } : { kind: 'walkingOver' };
  const conversation = { id: 'c:2', participants: new Map([[human.id, { status: humanStatus }], [npc.id, { status: npcStatus }]]) };
  const inputs: { name: string; args: any }[] = [];
  const module = { exports: {} as { default: (props: any) => Element } };
  const game = { world: { players: new Map([[npc.id, npc], [human.id, human]]),
    playerConversation: () => conversation }, playerDescriptions: new Map([[npc.id, { name: 'Resident' }]]) };
  const code = ts.transpileModule(readFileSync(new URL('./PlayerDetails.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (name === 'react/jsx-runtime') return jsx;
    if (name === '../i18n') return { useLocale: () => ({ t: (message: string) => translate(language, gameModelMessages, message) }) };
    if (name === '../../convex/_generated/api') return { api: { world: { userStatus: 'user', previousConversation: 'previous' } } };
    if (name === 'convex/react') return { useQuery: (query: string) => query === 'user' ? token : null };
    if (name === '../hooks/sendInput') return { useSendInput: (_engine: string, input: string) => async (args: any) => { inputs.push({ name: input, args }); } };
    if (name === '../toasts') return { toastOnError: (promise: Promise<unknown>) => promise };
    return { __esModule: true, default: name };
  } });
  const view = module.exports.default({ worldId: 'world', engineId: 'engine', game, playerId: npc.id,
    setSelectedElement: () => {}, scrollViewRef: { current: null } });
  function elements(value: any): Element[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!value?.props) return [];
    return [value, ...elements(value.props.children)];
  }
  return { inputs, tree: elements(view) };
}

import { gameModelMessages } from '../locales/gameModels';

test.each(['waiting', 'approaching'] as const)('pending %s conversation can be cancelled through the normal human input', async state => {
  const { tree, inputs } = playerDetailsView('test-human', state);
  const cancel = tree.find(e => e.type === 'button' && e.props.children?.props.children === 'Cancel conversation');
  expect(cancel).toBeDefined();
  await cancel!.props.onClick();
  expect(inputs).toEqual([{ name: 'leaveConversation', args: { playerId: 'p:1', conversationId: 'c:2' } }]);
});

test('pending cancellation is translated and does not replace accepting or leaving an active conversation', () => {
  const { tree } = playerDetailsView('test-human', 'approaching', 'zh-CN');
  expect(tree.some(e => e.type === 'button' && e.props.children?.props.children === '取消交谈')).toBe(true);
  for (const state of ['participating', 'invited'] as const) {
    const view = playerDetailsView('test-human', state);
    expect(view.tree.some(e => e.type === 'button' && e.props.children?.props.children === 'Cancel conversation')).toBe(false);
  }
});

test('a loading human identity cannot select an NPC as the current player or show its conversation controls', () => {
  const { tree } = playerDetailsView(undefined, 'approaching');
  expect(tree.some(e => e.type === 'button' && e.props.children?.props.children === 'Cancel conversation')).toBe(false);
  expect(tree.some(e => e.type === 'i' && e.props.children === 'This is you!')).toBe(false);
});

test.each([undefined, 'test-human'])('interaction toggle waits for a matching human identity (status=%s)', token => {
  const api = { world: { defaultWorldStatus: 'status', userStatus: 'user', joinWorld: 'join', leaveWorld: 'leave' } };
  const players = new Map<string, any>([['p:0', { id: 'p:0' }], ['p:1', { id: 'p:1', human: 'test-human' }]]);
  const module = { exports: {} as { default: () => Element } };
  const code = ts.transpileModule(readFileSync(new URL('./buttons/InteractButton.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'react') return { useCallback: (callback: any) => callback };
    if (name === '../../i18n') return { useLocale: () => ({ t: (message: string) => message }) };
    if (name === '../../../convex/_generated/api') return { api };
    if (name === '../../hooks/serverGame') return { useServerGame: () => ({ world: { players } }) };
    if (name === 'convex/react') return { useConvex: () => ({}), useMutation: () => () => {},
      useQuery: (query: string) => query === 'status' ? { worldId: 'world' } : token };
    return { __esModule: true, default: name };
  } });
  expect(module.exports.default().props.children).toBe(token ? 'Leave' : 'Interact');
});
