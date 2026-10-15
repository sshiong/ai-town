import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { getFunctionName, makeFunctionReference } from 'convex/server';

// Execute actual handlers with isolated hook state; no DOM or browser acceptance is implied.
const compiled = ts.transpileModule(readFileSync(new URL('./SelectiveExportPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: any; props: Record<string, any> };
function panel(indices: number[], chunkCount = indices.length) {
  const state: any[] = [], calls: { name: string; args: any }[] = [];
  const downloads: { text: string; name: string }[] = [];
  let cursor = 0, work: Promise<unknown> = Promise.resolve(), lastError: unknown;
  let failingIndex: number | undefined;
  const job = { jobId: 'export-job', state: 'COMPLETE', phase: 'COMPLETE', chunkCount, selection: { scope: 'agents-selected', owners: [], categories: [], from: null, to: null } };
  const task = { pending: undefined, run: (_label: string, run: () => Promise<unknown>) => {
    lastError = undefined;
    work = run().catch(error => { lastError = error; });
    return work;
  } };
  const module = { exports: {} as { default: (props: any) => Element } };
  runInNewContext(compiled, { exports: module.exports, module, require: (name: string) => {
    if (name === 'react/jsx-runtime') return {
      jsx: (type: any, props: any) => ({ type, props }),
      jsxs: (type: any, props: any) => ({ type, props }), Fragment: 'Fragment',
    };
    if (name === 'react') return {
      useState: (initial: any) => { const index = cursor++; if (!(index in state)) state[index] = initial;
        return [state[index], (value: any) => { state[index] = value; }]; },
      useRef: (initial: any) => { const index = cursor++; return state[index] ??= { current: initial }; },
      useEffect: () => {},
    };
    if (name === '../../i18n') return { useLocale: () => ({ t: (message: string) => message }) };
    if (name === '../../../convex/_generated/api') return { api: { federation: { runtime: { listResidents: 'residents' } } } };
    if (name === 'convex/server') return { makeFunctionReference };
    if (name === 'convex/react') return {
      useQuery: (reference: any, args: any) => {
        if (reference === 'residents') return [];
        const name = getFunctionName(reference);
        if (name.endsWith(':listJobs')) return [job];
        return args === 'skip' ? undefined : job;
      },
      useConvex: () => ({ action: async (reference: any, args: any) => {
        const name = getFunctionName(reference).split(':')[1];
        calls.push({ name, args });
        if (name === 'getManifest') return { manifest: {
          format: indices.some(index => index > indices.length - 1) ? 'ai-town-local-sanitized-chunks' : 'ai-town-selective-chunks',
          chunks: indices.map(index => ({ index })),
        }, signature: '' };
        if (args.index === failingIndex) throw new Error('Chunk request failed');
        return `chunk ${args.index}`;
      } }),
    };
    if (name === './AdminShared') return {
      AdminButton: 'AdminButton', Field: 'Field', TaskFeedback: 'TaskFeedback', useAdminTask: () => task,
      downloadJsonText: (text: string, name: string) => { downloads.push({ text, name }); },
    };
    if (name === './archiveFiles') return { supportsArchiveDirectory: () => true };
    if (name === './backupEncryption') return { validBackupPassphrase: () => false };
    return { VectorExportOption: 'VectorExportOption' };
  } });
  function elements(value: any): Element[] {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(elements);
    if (typeof value !== 'object' || !value.props) return [];
    return [value, ...elements(value.props.children)];
  }
  function render() { cursor = 0; return elements(module.exports.default({ adminToken: 'synthetic-admin' })); }
  function text(value: any): string {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(text).join('');
    return typeof value === 'object' ? text(value.props?.children) : String(value);
  }
  function change(match: (element: Element) => boolean, target: any) {
    const element = render().find(match)!;
    expect(element).toBeDefined();
    element.props.onChange({ target });
  }
  function button() {
    return render().find(element => element.type === 'AdminButton' && text(element).startsWith('Download chunk '))!;
  }
  change(element => element.type === 'select' && element.props.value === '', { value: job.jobId });
  render().filter(element => element.props.type === 'checkbox').at(-1)!.props.onChange({ target: { checked: false } });
  render().filter(element => element.props.type === 'checkbox').at(-1)!.props.onChange({ target: { checked: true } });
  return { calls, downloads, button, label: () => text(button()), lastError: () => lastError,
    failChunk: (index?: number) => { failingIndex = index; },
    click: async (force = false) => {
      const element = button();
      if (!force) expect(element.props.disabled).toBeFalsy();
      element.props.onClick();
      await work;
    },
  };
}

test.each([{ indices: [0, 7] }, { indices: [0, 1] }])('sequential downloads use declared indices $indices and preserve the ordinal counter', async ({ indices }) => {
  const ui = panel(indices);
  expect(ui.label()).toBe('Download chunk 1 / 2');
  await ui.click();
  expect(ui.label()).toBe('Download chunk 2 / 2');
  await ui.click();
  expect(ui.lastError()).toBeUndefined();
  expect(ui.calls.map(call => [call.name, call.args.index])).toEqual([
    ['getManifest', undefined], ['getChunk', indices[0]], ['getManifest', undefined], ['getChunk', indices[1]],
  ]);
  expect(ui.downloads).toEqual(indices.map(index => ({ name: `export-job-chunk-${index}.json`, text: `chunk ${index}` })));
  expect(ui.label()).toBe('Download chunk 3 / 2');
  expect(ui.button().props.disabled).toBe(true);
  await ui.click(true);
  expect(String(ui.lastError())).toContain('All chunks have been downloaded.');
  expect(ui.calls).toHaveLength(4);
  expect(ui.downloads).toHaveLength(2);
});

test('a failed sparse chunk request preserves the ordinal for retry', async () => {
  const ui = panel([0, 7]);
  await ui.click();
  ui.failChunk(7);
  await ui.click();
  expect(String(ui.lastError())).toContain('Chunk request failed');
  expect(ui.label()).toBe('Download chunk 2 / 2');
  expect(ui.downloads).toHaveLength(1);
  ui.failChunk();
  await ui.click();
  expect(ui.lastError()).toBeUndefined();
  expect(ui.calls.filter(call => call.name === 'getChunk').map(call => call.args.index)).toEqual([0, 7, 7]);
  expect(ui.downloads[1]).toEqual({ name: 'export-job-chunk-7.json', text: 'chunk 7' });
  expect(ui.button().props.disabled).toBe(true);
});

test('manifest exhaustion fetches no nonexistent chunk when the job count is larger', async () => {
  const ui = panel([7], 2);
  await ui.click();
  await ui.click();
  expect(String(ui.lastError())).toContain('All chunks have been downloaded.');
  expect(ui.calls.map(call => call.name)).toEqual(['getManifest', 'getChunk', 'getManifest']);
  expect(ui.label()).toBe('Download chunk 2 / 2');
  expect(ui.downloads).toEqual([{ name: 'export-job-chunk-7.json', text: 'chunk 7' }]);
});
