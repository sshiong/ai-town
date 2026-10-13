import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { readBackupText, encryptBackupText } from './backupEncryption';
import { selectiveImportPayload, selectiveStagingComplete } from './selectiveImportPayload';

type Element = { type: any; props: Record<string, any> };
const compiled = ts.transpileModule(readFileSync(new URL('./SelectiveImportPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const file = (text: string) => ({ name: 'chunk.encrypted.json', size: new TextEncoder().encode(text).length,
  text: () => Promise.resolve(text) });
function resumedPanel(dataUploaded = 1) {
  const state: any[] = [], calls: { name: string; args: any }[] = [];
  let cursor = 0, work: Promise<unknown> = Promise.resolve(), error: unknown;
  const job = { jobId: 'saved-selective-job', state: 'STAGING', phase: 'STAGING',
    selection: { scope: 'agents-selected', owners: [], categories: [], from: null, to: null },
    options: { owners: [{ sourceAgentGlobalId: 'mapped-source', operation: 'merge', targetAgentGlobalId: 'saved-target' }],
      profiles: [{ sourceId: 'saved-source-profile', operation: 'map', targetId: 'saved-target-profile' }] },
    uploadedChunks: dataUploaded, chunkCount: 2, uploadedPrivacyChunks: 0, privacyChunkCount: 1,
    recordCount: 2, targetDigest: 'saved-snapshot', report: { sourceTownId: 'source-town', rawBytesEstimate: 2,
      plannedMemories: 1, created: 0, replaced: 0, skipped: 0, externalEdgesSkipped: 0, indexState: 'REBUILD_REQUIRED' } };
  const task = { pending: undefined, run: (_label: string, run: () => Promise<unknown>) => {
    work = run().catch(reason => { error = reason; }); return work;
  } };
  const module = { exports: {} as { default: (props: any) => Element } };
  runInNewContext(compiled, { exports: module.exports, module, require: (name: string) => {
    if (name === 'react/jsx-runtime') return { jsx: (type: any, props: any) => ({ type, props }),
      jsxs: (type: any, props: any) => ({ type, props }), Fragment: 'Fragment' };
    if (name === 'react') return { useState: (initial: any) => { const index = cursor++;
      if (!(index in state)) state[index] = initial; return [state[index], (value: any) => { state[index] = value; }]; },
      useRef: (initial: any) => { const index = cursor++; return state[index] ??= { current: initial }; }, useEffect: () => undefined };
    if (name === '../../i18n') return { useLocale: () => ({ t: (label: string) => label }) };
    if (name === 'convex/server') return { makeFunctionReference: (label: string) => label };
    if (name === 'convex/values') return { jsonToConvex: (value: any) => value };
    if (name === '../../../convex/_generated/api') return { api: { federation: { runtime: { listResidents: 'residents' } }, models: { profiles: { list: 'profiles' } } } };
    if (name === 'convex/react') return { useQuery: (label: string, args: any) => label.endsWith(':listJobs') ? [job] :
      label.endsWith(':status') ? args === 'skip' ? undefined : job : label === 'profiles' ? { chatProfiles: [] } : [],
      useConvex: () => ({ action: async (label: string, args: any) => {
        calls.push({ name: label, args });
        if (label.endsWith('backupSelectiveImport:stageChunk')) job.uploadedChunks = 2;
        if (label.endsWith('backupPrivacyChunks:stageChunk')) job.uploadedPrivacyChunks = 1;
        if (label.endsWith(':advanceImport')) { job.state = 'READY'; job.phase = 'READY'; }
        return job;
      } }) };
    if (name === './AdminShared') return { AdminButton: 'AdminButton', Field: 'Field', TaskFeedback: 'TaskFeedback', useAdminTask: () => task };
    if (name === './backupEncryption') return { readBackupText };
    if (name === './selectiveImportPayload') return { selectiveImportPayload, selectiveStagingComplete };
    return {};
  } });
  function elements(value: any): Element[] {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(elements);
    if (typeof value !== 'object' || !value.props) return [];
    return [value, ...elements(value.props.children)];
  }
  const render = () => { cursor = 0; return elements(module.exports.default({ adminToken: 'synthetic-admin' })); };
  const button = (label: string) => render().find(element => element.type === 'AdminButton' && element.props.children === label)!;
  function change(match: (element: Element) => boolean, target: any) {
    const element = render().find(match)!; expect(element).toBeDefined(); element.props.onChange({ target });
  }
  function selectFiles(label: string, inputs: ReturnType<typeof file>[]) {
    const field = render().find(element => element.type === 'Field' && element.props.label === label)!;
    expect(field).toBeDefined(); field.props.children.props.onChange({ target: { files: inputs } });
  }
  return { job, calls, render, button, error: () => error, selectFiles,
    resume: () => change(element => element.type === 'select' && element.props.children?.some?.((child: any) =>
      child?.props?.children === 'New import / choose a task'), { value: job.jobId }),
    password: (value: string) => change(element => element.props.type === 'password', { value }),
    click: async (label: string) => { const element = button(label); expect(element.props.disabled).toBeFalsy(); element.props.onClick(); await work; },
  };
}
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));

test.each([1, 2])('fresh UI resumes saved staging with %i data chunks uploaded and independent encrypted privacy files', async dataUploaded => {
  const ui = resumedPanel(dataUploaded), savedMappings = structuredClone(ui.job.options);
  ui.resume();
  expect(ui.button('Load manifest').props.disabled).toBe(true);
  expect(ui.button('Continue pages / preflight').props.disabled).toBe(true);
  const password = 'synthetic-privacy-passphrase';
  const privacy = JSON.stringify({ index: 0, table: 'travelPrivacyTombstones', rows: [] });
  ui.selectFiles('Privacy evidence chunk files', [file(await encryptBackupText(privacy, password, 'chunk', 900_000))]);
  if (dataUploaded === 1) ui.selectFiles('All selective archive chunks', [file(JSON.stringify({ index: 1, table: 'memories', rows: [] }))]);
  ui.password(password);
  await ui.click('Upload selected chunks');
  expect(ui.error()).toBeUndefined();
  expect(ui.calls.map(call => call.name)).toEqual(dataUploaded === 1 ?
    ['federation/backupSelectiveImport:stageChunk', 'federation/backupPrivacyChunks:stageChunk'] : ['federation/backupPrivacyChunks:stageChunk']);
  for (const call of ui.calls) expect(call.args.jobId).toBe('saved-selective-job');
  const privacyUpload = ui.calls.find(call => call.name.includes('backupPrivacyChunks'))!;
  expect(privacyUpload.args).toEqual({ adminToken: 'synthetic-admin', jobId: 'saved-selective-job', pageNumber: 0, chunk: privacy });
  expect(ui.job.options).toEqual(savedMappings);
  expect(ui.render().find(element => element.props.type === 'password')!.props.value).toBe('');
  expect(ui.button('Continue pages / preflight').props.disabled).toBe(false);
  await ui.click('Continue pages / preflight');
  expect(ui.calls.at(-1)!.args).toEqual({ adminToken: 'synthetic-admin', jobId: 'saved-selective-job' });
  expect(ui.calls.some(call => call.name.includes('createImport') || call.name.includes('getManifest'))).toBe(false);
});

test('privacy-only checkpoint keeps preflight disabled while saved data chunks are still missing', async () => {
  const ui = resumedPanel(1);
  ui.resume();
  ui.selectFiles('Privacy evidence chunk files', [file(JSON.stringify({ index: 0, table: 'travelPrivacyTombstones', rows: [] }))]);
  await ui.click('Upload selected chunks');
  expect(ui.error()).toBeUndefined();
  expect(ui.job.uploadedPrivacyChunks).toBe(1);
  expect(ui.job.uploadedChunks).toBe(1);
  expect(ui.button('Continue pages / preflight').props.disabled).toBe(true);
  expect(ui.calls).toHaveLength(1);
  expect(ui.calls[0].name).toBe('federation/backupPrivacyChunks:stageChunk');
  expect(ui.calls[0].args.jobId).toBe('saved-selective-job');
});
