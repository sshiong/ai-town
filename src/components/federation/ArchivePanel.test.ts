import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { loadLargeArchiveManifest, confirmedLargeArchiveSigner } from './archiveFiles';
import { encryptBackupText, readBackupText } from './backupEncryption';
import { translate } from '../../locale';

// Execute actual handlers with isolated hook state; no DOM or browser acceptance is implied.
const compiled = ts.transpileModule(readFileSync(new URL('./ArchivePanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: any; props: Record<string, any> };
const raw = () => ({ manifest: { format: 'ai-town-chunks', version: 1, schemaVersion: 1, scope: 'town',
  exportId: 'source-export', exportedAt: 1, includeVectors: true, source: { townId: 'original-town',
    publicKey: 'original-public-key', fingerprint: 'sha256:original' },
  chunks: [{ index: 0, table: 'memories', count: 0, bytes: 40, digest: 'declared-digest' }] }, signature: 'original-signature' });
const derived = () => ({ signature: '', sourceSignatureValid: false,
  manifest: { format: 'ai-town-local-sanitized-chunks', version: 1, schemaVersion: 1, sourceSignatureValid: false,
    archiveId: 'derived-export', derivedAt: 2, clearedVisits: ['cleared-visit'],
    chunks: [{ ...raw().manifest.chunks[0], role: 'EXPORT', encoding: 'RAW' }],
    sourceEvidence: { manifest: raw().manifest, signature: 'original-signature', publicKey: 'original-public-key', digest: 'source-digest' } },
  localProof: { format: 'ai-town-local-archive-proof', version: 1, townId: 'local-signer-town',
    publicKey: 'local-signer-key', manifestDigest: 'current-digest', signature: 'local-signature' } });
function file(text: string, name = 'manifest.json') {
  return { name, size: new TextEncoder().encode(text).length, text: () => Promise.resolve(text) };
}
function panel() {
  const state: any[] = [], effects: any[][] = [], calls: { name: string; args: any }[] = [];
  let cursor = 0, effectCursor = 0, work: Promise<unknown> = Promise.resolve();
  let job: any;
  let lastError: unknown;
  const task = { pending: undefined, run: (_label: string, run: () => Promise<unknown>) => {
    work = run().catch(error => { lastError = error; }); return work;
  } };
  const api = { world: { defaultWorldStatus: 'world' }, federation: { admin: { status: 'admin' },
    backupLarge: { listJobs: 'jobs', status: 'job', createImport: 'createImport', stageChunk: 'stageChunk' } } };
  const module = { exports: {} as { default: (props: any) => Element } };
  runInNewContext(compiled, { exports: module.exports, module, require: (name: string) => {
    if (name === 'react/jsx-runtime') return { jsx: (type: any, props: any) => ({ type, props }),
      jsxs: (type: any, props: any) => ({ type, props }), Fragment: 'Fragment' };
    if (name === 'react') return {
      useState: (initial: any) => { const index = cursor++; if (!(index in state)) state[index] = initial;
        return [state[index], (value: any) => { state[index] = value; }]; },
      useRef: (initial: any) => { const index = cursor++; return state[index] ??= { current: initial }; },
      useEffect: (effect: () => void, deps: any[]) => { const index = effectCursor++;
        if (!effects[index] || deps.some((value, i) => !Object.is(value, effects[index][i]))) {
          effects[index] = deps; effect();
        } },
    };
    if (name === '../../i18n') return { useLocale: () => ({ t: (message: string, values?: Record<string, string | number>) => translate('en', {}, message, values) }) };
    if (name === '../../../convex/_generated/api') return { api };
    if (name === 'convex/react') return { useQuery: (name: string, args: any) => name === 'world' ?
      { worldId: 'target-world', status: 'stoppedByDeveloper' } : name === 'admin' ?
        { settings: { enabled: false }, identity: { townId: 'original-town' } } : name === 'job' ?
          args === 'skip' ? undefined : job : [],
    useConvex: () => ({ action: (name: string, args: any) => {
      calls.push({ name, args });
      if (name === 'createImport') { job = { jobId: 'staging-job', kind: 'import', state: 'STAGING', phase: 'STAGING',
        sourceTownId: 'original-town', chunkCount: 1, processedChunks: 0, uploadedChunks: 0 };
        return Promise.resolve({ jobId: 'staging-job' }); }
      return Promise.resolve({});
    } }) };
    if (name === './AdminShared') return { AdminButton: 'AdminButton', Field: 'Field', EmptyState: 'EmptyState',
      TaskFeedback: 'TaskFeedback', useAdminTask: () => task, formatTime: () => '', downloadJsonText: () => undefined };
    if (name === './archiveFiles') return { loadLargeArchiveManifest, confirmedLargeArchiveSigner,
      supportsArchiveDirectory: () => false };
    if (name === './backupEncryption') return { encryptBackupText, readBackupText, validBackupPassphrase: () => true };
    return { __esModule: true, default: name, VectorExportOption: 'VectorExportOption' };
  } });
  function elements(value: any): Element[] {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(elements);
    if (typeof value !== 'object' || !value.props) return [];
    return [value, ...elements(value.props.children)];
  }
  function render() { cursor = 0; effectCursor = 0;
    return elements(module.exports.default({ adminToken: 'synthetic-admin' })); }
  function button(label: string) { return render().find(element => element.type === 'AdminButton' && element.props.children === label)!; }
  function change(match: (element: Element) => boolean, target: any) {
    const element = render().find(match)!; expect(element).toBeDefined(); element.props.onChange({ target });
  }
  return { calls, button, render, lastError: () => lastError,
    load: async (input: ReturnType<typeof file>) => { change(element => element.props.type === 'file' && !element.props.multiple,
      { files: [input] }); await work; },
    change, click: async (label: string) => { const element = button(label); expect(element).toBeDefined();
      expect(element.props.disabled).toBeFalsy(); element.props.onClick(); await work; },
    password: (value: string) => change(element => element.props.type === 'password' && element.props.autoComplete === 'off', { value }),
    confirmSigner: (value: string) => change(element => element.props.maxLength === 100, { value }),
    selectChunks: (inputs: ReturnType<typeof file>[]) => change(element => element.props.type === 'file' && element.props.multiple, { files: inputs }),
  };
}
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));

test('derived UI never auto-confirms its declared signer and sends only the operator-confirmed pin with its proof', async () => {
  const ui = panel(), header = derived();
  await ui.load(file(JSON.stringify(header)));
  // Encryption checkbox precedes the source-stopped checkbox; locate the source via its final position.
  const checks = ui.render().filter(element => element.props.type === 'checkbox');
  checks.at(-1)!.props.onChange({ target: { checked: true } });
  const confirmation = ui.render().find(element => element.props.maxLength === 100)!;
  expect(confirmation.props.value).toBe('');
  expect(ui.button('Create staging task').props.disabled).toBe(true);
  const loaded = await loadLargeArchiveManifest(header);
  const declaredCodes = ui.render().filter(element => element.type === 'code').map(element => element.props.children);
  const declaredText = ui.render().filter(element => element.type === 'p').flatMap(element =>
    Array.isArray(element.props.children) ? element.props.children.filter(child => typeof child === 'string') : []);
  expect(declaredText).toContain('original-town');
  expect(declaredCodes).toEqual(expect.arrayContaining(['sha256:original',
    'local-signer-town', loaded.declaredLocalSignerFingerprint]));
  ui.confirmSigner('sha256:original');
  expect(ui.button('Create staging task').props.disabled).toBe(true);
  ui.confirmSigner(loaded.declaredLocalSignerFingerprint!);
  await ui.click('Create staging task');
  const request = ui.calls[0].args;
  expect(request.localProof).toEqual(header.localProof);
  expect(request.manifest.sourceEvidence.manifest.source.townId).toBe('original-town');
  expect(request.manifest.sourceSignatureValid).toBe(false);
  expect(request).not.toHaveProperty('sourceSignatureValid');
  expect(request.signature).toBe('');
  expect(request.expectedLocalProofFingerprint).toBe(loaded.declaredLocalSignerFingerprint);
  await ui.load(file(JSON.stringify(header), 'another-manifest.json'));
  expect(ui.render().find(element => element.props.maxLength === 100)!.props.value).toBe('');
  expect(ui.button('Create staging task').props.disabled).toBe(true);
});

test.each(['unknown metadata', 'original signature claim'])('the actual file handler rejects %s before exposing a staging RPC', async kind => {
  const ui = panel(), header = derived();
  if (kind === 'unknown metadata') Object.assign(header, { unsupportedMetadata: 'not forwarded' });
  else header.manifest.sourceSignatureValid = true;
  await ui.load(file(JSON.stringify(header)));
  expect(ui.lastError()).toBeDefined();
  expect(ui.button('Create staging task').props.disabled).toBe(true);
  expect(ui.render().find(element => element.props.maxLength === 100)).toBeUndefined();
  expect(ui.calls).toEqual([]);
});

test('original signed UI keeps its RPC contract without adding local proof or signer confirmation', async () => {
  const ui = panel(), header = raw();
  await ui.load(file(JSON.stringify(header)));
  ui.render().filter(element => element.props.type === 'checkbox').at(-1)!.props.onChange({ target: { checked: true } });
  expect(ui.render().find(element => element.props.maxLength === 100)).toBeUndefined();
  await ui.click('Create staging task');
  expect(ui.calls[0].args.signature).toBe(header.signature);
  expect(ui.calls[0].args.manifest).toEqual(header.manifest);
  expect(ui.calls[0].args).not.toHaveProperty('localProof');
  expect(ui.calls[0].args).not.toHaveProperty('expectedLocalProofFingerprint');
});

test('encrypted derived manifest and chunks still decrypt in the browser before staged RPCs', async () => {
  const ui = panel(), header = derived(), password = 'synthetic archive passphrase';
  const encrypted = await encryptBackupText(JSON.stringify(header), password, 'manifest', 5_000_000);
  await ui.load(file(encrypted));
  expect(ui.lastError()).toBeDefined();
  ui.password(password);
  await ui.click('Load selected manifest');
  expect(ui.render().find(element => element.props.type === 'password' && element.props.autoComplete === 'off')!.props.value).toBe('');
  ui.render().filter(element => element.props.type === 'checkbox').at(-1)!.props.onChange({ target: { checked: true } });
  ui.confirmSigner((await loadLargeArchiveManifest(header)).declaredLocalSignerFingerprint!);
  await ui.click('Create staging task');
  const chunkJson = '{"index":0,"table":"memories","rows":[],"privacyRewriteOperationId":"preserved-marker"}';
  ui.selectChunks([file(await encryptBackupText(chunkJson, password, 'chunk', 1024 * 1024), 'chunk-000000.json')]);
  ui.password(password);
  await ui.click('Stage selected chunks');
  expect(ui.calls.find(call => call.name === 'stageChunk')!.args.chunk).toBe(chunkJson);
  expect(ui.calls.every(call => !('passphrase' in call.args))).toBe(true);
  expect(ui.render().find(element => element.props.type === 'password' && element.props.autoComplete === 'off')!.props.value).toBe('');
});
