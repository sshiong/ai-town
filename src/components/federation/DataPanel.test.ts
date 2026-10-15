import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { backupImportSupportsRetry, newBackupUploadAttemptKey } from './uiPolicy';
import { translate } from '../../locale';
import { federationMessages } from '../../locales/federation';
import { dataMessages } from '../../locales/data';

// Exercise the real panel's handlers and hook state without adding a DOM/test-renderer dependency.
const compiled = ts.transpileModule(readFileSync(new URL('./DataPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: any; props: Record<string, any> };
function panel() {
  const state: any[] = [], effects: any[][] = [], calls: { name: string; args: any }[] = [];
  const archiveNavigation: { action: string; options: any }[] = [];
  const archiveHeading = {
    scrollIntoView: (options: any) => archiveNavigation.push({ action: 'scroll', options }),
    focus: (options: any) => archiveNavigation.push({ action: 'focus', options }),
  };
  let cursor = 0, effectCursor = 0, work: Promise<unknown> = Promise.resolve();
  let world: any = { worldId: 'target-world', status: 'stoppedByDeveloper' };
  let identity: any;
  let failImport = true;
  let failExport = false;
  let language: 'en' | 'zh-CN' = 'en';
  const report: any = { valid: true, mode: 'merge', scope: 'town', counts: {}, warnings: [], vectorPolicy: 'REBUILD' };
  const task = { pending: undefined, run: (_label: string, run: () => Promise<unknown>) => {
    work = run().catch(() => undefined);
    return work;
  } };
  const shared = { AdminButton: 'AdminButton', Field: 'Field', TaskFeedback: 'TaskFeedback',
    EmptyState: 'EmptyState', useAdminTask: () => task, formatTime: () => '',
    downloadBundle: () => undefined, downloadJsonText: () => undefined };
  const api = { world: { defaultWorldStatus: 'world' }, testing: {}, federation: {
    runtime: { listResidents: 'residents' }, admin: { status: 'status' },
    backup: { preflight: 'preflight', importBackup: 'importBackup', history: 'history', restoredResidents: 'restored', exportTown: 'exportTown' },
  } };
  const module = { exports: {} as { default: (props: any) => Element } };
  runInNewContext(compiled, { exports: module.exports, module, crypto: webcrypto,
    require: (name: string) => {
      if (name === 'react/jsx-runtime') return { jsx: (type: any, props: any) => ({ type, props }),
        jsxs: (type: any, props: any) => ({ type, props }), Fragment: 'Fragment' };
      if (name === 'react') return {
        useRef: (initial: any) => {
          const index = cursor++;
          if (!(index in state)) state[index] = { current: initial };
          return state[index];
        },
        useState: (initial: any) => {
          const index = cursor++;
          if (!(index in state)) state[index] = initial;
          return [state[index], (value: any) => { state[index] = value; }];
        },
        useEffect: (effect: () => void, deps: any[]) => {
          const index = effectCursor++;
          if (!effects[index] || deps.some((value, i) => !Object.is(value, effects[index][i]))) {
            effects[index] = deps;
            effect();
          }
        },
      };
      if (name === '../../i18n') return { useLocale: () => ({
        t: (message: string) => translate(language, { ...dataMessages, ...federationMessages }, message),
      }) };
      if (name === 'convex/react') return {
        useQuery: (name: string) => name === 'world' ? world : name === 'status' ? { identity } : [],
        useConvex: () => ({ action: async (name: string, args: any) => {
          calls.push({ name, args });
          if (name === 'preflight') return report;
          if (name === 'exportTown' && failExport) throw new Error('SAFETY_EXPORT_FAILED');
          if (name === 'importBackup') {
            if (failImport) throw new Error('RESPONSE_ACK_LOST');
            return { mode: args.mode, mapping: {}, worldIds: [], rebuildRequired: true };
          }
          return {};
        } }),
      };
      if (name === '../../../convex/_generated/api') return { api };
      if (name === './uiPolicy') return { requiresStoppedSource: (mode: string) => ['restore', 'migrate'].includes(mode),
        backupImportSupportsRetry, newBackupUploadAttemptKey };
      if (name === './embeddingUiPolicy') return { declaredBackupSource: () => null };
      if (name === './backupEncryption') return { validBackupPassphrase: () => true,
        readBackupText: (file: any) => file.text() };
      if (name === './AdminShared') return shared;
      return { __esModule: true, default: name, VectorExportOption: 'VectorExportOption' };
    },
  });
  function elements(value: any): Element[] {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(elements);
    if (typeof value !== 'object' || !value.props) return [];
    return [value, ...elements(value.props.children)];
  }
  function render() {
    cursor = 0; effectCursor = 0;
    module.exports.default({ adminToken: 'test-admin-token' });
    cursor = 0; effectCursor = 0;
    const tree = elements(module.exports.default({ adminToken: 'test-admin-token' }));
    tree.find(element => element.type === './ArchivePanel')!.props.headingRef.current = archiveHeading;
    return tree;
  }
  function button(label: string) {
    return render().find(element => (element.type === 'AdminButton' && element.props.children === label) ||
      (element.type === 'button' && element.props.children?.props.children === label));
  }
  async function click(label: string) {
    const target = button(label);
    expect(target).toBeDefined();
    expect(target!.props.disabled).toBeFalsy();
    target!.props.onClick();
    await work;
  }
  function change(match: (element: Element) => boolean, value: any) {
    const target = render().find(match);
    expect(target).toBeDefined();
    target!.props.onChange({ target: value });
  }
  return { calls, archiveNavigation, button, click, change,
    load: async (vectors = true) => {
      change(element => element.props.type === 'file', { files: [{ name: 'backup.json',
        text: async () => JSON.stringify({ manifest: { includeVectors: vectors }, sections: { modelMemoryVectors: vectors ? ['vector'] : [] } }) }] });
      await work;
    },
    confirm: () => {
      const target = render().filter(element => element.props.type === 'checkbox').at(-1)!;
      target.props.onChange({ target: { checked: true } });
    },
    unconfirm: () => {
      const target = render().filter(element => element.props.type === 'checkbox').at(-1)!;
      target.props.onChange({ target: { checked: false } });
    },
    setWorld: (value: any) => { world = value; }, setIdentity: (value: any) => { identity = value; },
    residentRestore: () => { report.residentRestorePlan = { targetDigest: 'reviewed-digest',
      agentGlobalId: 'home/resident', model: { model: 'fixed-model', credentialConfigured: true }, memoryCount: 1 }; },
    succeed: () => { failImport = false; }, setLanguage: () => { language = 'zh-CN'; },
    failSafetyExport: () => { failExport = true; },
  };
}

beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));

test('chunked archive shortcut works without export fields and scrolls before focusing the existing heading', async () => {
  const ui = panel();
  expect(ui.button('Download full town')!.props.disabled).toBe(true);
  await ui.click('Open chunked archives');
  expect(ui.archiveNavigation).toEqual([
    { action: 'scroll', options: { block: 'start' } },
    { action: 'focus', options: { preventScroll: true } },
  ]);
  expect(ui.calls).toEqual([]);
  ui.setLanguage();
  expect(ui.button('打开分块归档')!.props.type).toBe('button');
});

test('ordinary import retries preserve exact bytes, target, mode and key after world updates and lost ACK', async () => {
  const ui = panel();
  await ui.load();
  await ui.click('Run preflight');
  ui.confirm();
  await ui.click('Import validated package');
  const first = ui.calls.find(call => call.name === 'importBackup')!.args;
  expect(first.uploadAttemptKey).toMatch(/^[0-9a-f]{32}$/);
  ui.setWorld({ worldId: 'new-reactive-world', status: 'inactive' });
  await ui.click('Retry the same import');
  expect(ui.calls.filter(call => call.name === 'importBackup').map(call => call.args)).toEqual([first, first]);
  expect(ui.button('Run preflight')!.props.disabled).toBe(true);
  ui.setLanguage();
  ui.succeed();
  await ui.click('重试同一次导入');
  expect(ui.calls.filter(call => call.name === 'importBackup')[2].args).toEqual(first);
  expect(ui.button('重试同一次导入')).toBeUndefined();
});

test('clone retry remains available after publication creates target identity and world', async () => {
  const ui = panel();
  ui.setWorld(undefined);
  await ui.load();
  ui.change(element => element.type === 'select' && element.props.value === 'merge', { value: 'clone' });
  ui.change(element => element.props.type === 'url', { value: 'https://clone.example' });
  await ui.click('Run preflight');
  ui.confirm();
  await ui.click('Import validated package');
  const first = ui.calls.find(call => call.name === 'importBackup')!.args;
  ui.setWorld({ worldId: 'cloned-world', status: 'stoppedByDeveloper' });
  ui.setIdentity({ townId: 'new-town' });
  ui.succeed();
  await ui.click('Retry the same import');
  expect(ui.calls.filter(call => call.name === 'importBackup')[1].args).toEqual(first);
  expect(first.targetWorldId).toBeUndefined();
});

test('explicit new import and mode/file changes replace the retry key', async () => {
  const ui = panel();
  await ui.load();
  await ui.click('Run preflight');
  ui.confirm();
  await ui.click('Import validated package');
  const firstKey = ui.calls.find(call => call.name === 'importBackup')!.args.uploadAttemptKey;
  await ui.click('Start another import');
  expect(ui.button('Retry the same import')).toBeUndefined();
  await ui.click('Run preflight');
  ui.confirm();
  await ui.click('Import validated package');
  const secondKey = ui.calls.filter(call => call.name === 'importBackup')[1].args.uploadAttemptKey;
  expect(secondKey).not.toBe(firstKey);
  ui.change(element => element.type === 'select' && element.props.value === 'merge', { value: 'clone' });
  expect(ui.button('Retry the same import')).toBeUndefined();
  await ui.load();
  expect(ui.button('Retry the same import')).toBeUndefined();
});

test('ordinary backups without actual vector rows never offer an idempotent retry', async () => {
  const ui = panel();
  await ui.load(false);
  await ui.click('Run preflight');
  ui.confirm();
  await ui.click('Import validated package');
  expect(ui.button('Retry the same import')).toBeUndefined();
  expect(ui.button('Start another import')).toBeDefined();
  for (const bundle of [undefined, null, [], {}, { manifest: { includeVectors: true } },
    { manifest: { includeVectors: true }, sections: { modelMemoryVectors: [] } },
    { manifest: { includeVectors: false }, sections: { modelMemoryVectors: ['row'] } }])
    expect(backupImportSupportsRetry(bundle)).toBe(false);
});

test('changing a clone endpoint discards the saved request instead of sending it under the old key', async () => {
  const ui = panel();
  ui.setWorld(undefined);
  await ui.load();
  ui.change(element => element.type === 'select' && element.props.value === 'merge', { value: 'clone' });
  ui.change(element => element.props.type === 'url', { value: 'https://first.example' });
  await ui.click('Run preflight');
  ui.confirm();
  await ui.click('Import validated package');
  ui.change(element => element.props.type === 'url', { value: 'https://second.example' });
  expect(ui.button('Retry the same import')).toBeUndefined();
  await ui.click('Run preflight');
  ui.confirm();
  await ui.click('Import validated package');
  const [first, second] = ui.calls.filter(call => call.name === 'importBackup');
  expect(second.args.targetEndpoint).toBe('https://second.example');
  expect(second.args.uploadAttemptKey).not.toBe(first.args.uploadAttemptKey);
});

test.each(['operator', 'reason', 'confirmation'])('changing resident restore %s requires a fresh attempt', async field => {
  const ui = panel();
  ui.residentRestore();
  await ui.load();
  ui.change(element => element.type === 'select' && element.props.value === 'merge', { value: 'restore' });
  ui.confirm(); // Source-stopped checkbox precedes preflight.
  await ui.click('Run preflight');
  ui.change(element => element.props.maxLength === 120, { value: 'restore-operator' });
  ui.change(element => element.props.maxLength === 1000 && element.props.disabled === false, { value: 'restore-reason' });
  ui.confirm();
  await ui.click('Import validated package');
  if (field === 'confirmation') {
    ui.unconfirm();
  } else {
    ui.change(element => field === 'operator' ? element.props.maxLength === 120 :
      element.props.maxLength === 1000 && element.props.disabled === false, { value: `changed-${field}` });
  }
  expect(ui.button('Retry the same import')).toBeUndefined();
  expect(ui.button('Import validated package')!.props.disabled).toBe(true);
  ui.confirm();
  await ui.click('Import validated package');
  const [first, second] = ui.calls.filter(call => call.name === 'importBackup');
  expect(second.args.uploadAttemptKey).not.toBe(first.args.uploadAttemptKey);
  expect(first.args.residentRestore.expectedTargetDigest).toBe('reviewed-digest');
});

test('revoking source-stopped confirmation removes the saved attempt and preflight', async () => {
  const ui = panel();
  ui.residentRestore();
  await ui.load();
  ui.change(element => element.type === 'select' && element.props.value === 'merge', { value: 'restore' });
  ui.confirm();
  await ui.click('Run preflight');
  ui.change(element => element.props.maxLength === 120, { value: 'restore-operator' });
  ui.change(element => element.props.maxLength === 1000 && element.props.disabled === false, { value: 'restore-reason' });
  ui.confirm();
  await ui.click('Import validated package');
  // The source checkbox is the first checked checkbox (download encryption is unchecked).
  ui.change(element => element.props.type === 'checkbox' && element.props.checked === true, { checked: false });
  expect(ui.button('Retry the same import')).toBeUndefined();
  expect(ui.button('Import validated package')).toBeUndefined();
  expect(ui.button('Run preflight')!.props.disabled).toBe(true);
});

test.each([false, true])('same-town safety export failure=%s creates no premature retry and is never repeated by retry', async fails => {
  const ui = panel();
  await ui.load();
  ui.change(element => element.type === 'select' && element.props.value === 'merge', { value: 'restore' });
  ui.confirm();
  await ui.click('Run preflight');
  ui.change(element => element.props.maxLength === 200, { value: 'export-operator' });
  ui.change(element => element.props.maxLength === 1000 && element.props.disabled === undefined, { value: 'safety-export-reason' });
  ui.confirm();
  if (fails) ui.failSafetyExport();
  await ui.click('Import validated package');
  if (fails) {
    expect(ui.calls.filter(call => call.name === 'importBackup')).toHaveLength(0);
    expect(ui.button('Retry the same import')).toBeUndefined();
    expect(ui.button('Import validated package')!.props.disabled).toBeFalsy();
  } else {
    await ui.click('Retry the same import');
    expect(ui.calls.filter(call => call.name === 'exportTown')).toHaveLength(1);
    const imports = ui.calls.filter(call => call.name === 'importBackup');
    expect(imports).toHaveLength(2);
    expect(imports[1].args).toEqual(imports[0].args);
  }
});
