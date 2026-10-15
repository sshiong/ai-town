import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(
  readFileSync(new URL('./main.tsx', import.meta.url), 'utf8').replaceAll('import.meta.hot', 'hot'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
).outputText;

function entry() {
  const root = { render: jest.fn() };
  const createRoot = jest.fn(() => root);
  const container = {};
  function execute(hot?: { data: Record<string, unknown>; accept: () => void }) {
    runInNewContext(code, {
      exports: {}, hot,
      document: { getElementById: () => container },
      require: (name: string) => {
        if (name === 'react/jsx-runtime') return { jsx: (type: unknown, props: unknown) => ({ type, props }) };
        if (name === 'react') return { default: { lazy: () => 'Home', StrictMode: 'StrictMode', Suspense: 'Suspense' } };
        if (name === 'react-dom/client') return { default: { createRoot } };
        if (name === './i18n') return { LocaleProvider: 'LocaleProvider' };
        return { default: name };
      },
    });
  }
  return { execute, root, createRoot, container };
}

test('entry hot updates render through one existing root instead of claiming the DOM again', () => {
  const { execute, root, createRoot, container } = entry();
  const hot = { data: {} as Record<string, unknown>, accept: jest.fn() };
  execute(hot);
  execute(hot);
  execute(hot);
  expect(createRoot).toHaveBeenCalledTimes(1);
  expect(createRoot).toHaveBeenCalledWith(container);
  expect(root.render).toHaveBeenCalledTimes(3);
  expect(hot.accept).toHaveBeenCalledTimes(3);
  expect(hot.data.root).toBe(root);
});

test('production entry creates and renders its root without an HMR runtime', () => {
  const { execute, root, createRoot } = entry();
  execute();
  expect(createRoot).toHaveBeenCalledTimes(1);
  expect(root.render).toHaveBeenCalledTimes(1);
});
