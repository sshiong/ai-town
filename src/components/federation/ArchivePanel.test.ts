import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { loadLargeArchiveManifest, confirmedLargeArchiveSigner, archivePrivacyPageNumber, writeArchiveText } from './archiveFiles';
import { encryptBackupText, readBackupText } from './backupEncryption';
import { translate } from '../../locale';
import { dataMessages } from '../../locales/data';
import { makeFunctionReference, getFunctionName } from 'convex/server';
import * as archiveBundle from './archiveBundle';

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
  const cleanups: (() => void)[] = [];
  let cursor = 0, effectCursor = 0, work: Promise<unknown> = Promise.resolve();
  let job: any;
  let nextProgress: any;
  let language: 'en' | 'zh-CN' = 'en';
  let lastError: unknown;
  const replies = new Map<string, unknown>();
  const downloads: { text: string; name: string }[] = [];
  const folderFiles = new Map<string, string>();
  const folderAttempts: string[] = [];
  const successes: string[] = [];
  let failingFilename: string | undefined;
  let observeFolderWrite: (() => void) | undefined;
  const directory = { getFileHandle: async (name: string) => {
    folderAttempts.push(name);
    return { createWritable: async () => {
      let content: string;
      return {
        write: async (text: string) => {
          observeFolderWrite?.();
          if (name === failingFilename) throw new Error('Folder write failed');
          content = text;
        },
        close: async () => { folderFiles.set(name, content); },
        abort: async () => {},
      };
    } };
  } };
  const task = { pending: undefined, run: (_label: string, run: () => Promise<unknown>, success = 'Saved.') => {
    lastError = undefined;
    work = run().then(() => { successes.push(success); }).catch(error => { lastError = error; }); return work;
  } };
  const api = { world: { defaultWorldStatus: 'world' }, federation: { admin: { status: 'admin' },
    backupLarge: { getManifest: 'getManifest', getChunk: 'getChunk', listJobs: 'jobs', status: 'job', createImport: 'createImport', stageChunk: 'stageChunk', advanceImport: 'advanceImport' } } };
  const module = { exports: {} as { default: (props: any) => Element } };
  runInNewContext(compiled, { File: class {
    name: string; size: number; content: string;
    constructor(parts: string[], name: string) { this.name = name; this.content = parts.join('');
      this.size = new TextEncoder().encode(this.content).length; }
    text() { return Promise.resolve(this.content); }
  }, exports: module.exports, module, require: (name: string) => {
    if (name === 'react/jsx-runtime') return { jsx: (type: any, props: any) => ({ type, props }),
      jsxs: (type: any, props: any) => ({ type, props }), Fragment: 'Fragment' };
    if (name === 'react') return {
      useState: (initial: any) => { const index = cursor++; if (!(index in state)) state[index] = initial;
        return [state[index], (value: any) => { state[index] = value; }]; },
      useRef: (initial: any) => { const index = cursor++; return state[index] ??= { current: initial }; },
      useEffect: (effect: () => void | (() => void), deps: any[]) => { const index = effectCursor++;
        if (!effects[index] || deps.some((value, i) => !Object.is(value, effects[index][i]))) {
          effects[index] = deps; const cleanup = effect(); if (cleanup) cleanups[index] = cleanup;
        } },
    };
    if (name === '../../i18n') return { useLocale: () => ({ t: (message: string, values?: Record<string, string | number>) => translate(language, dataMessages, message, values) }) };
    if (name === '../../../convex/_generated/api') return { api };
    if (name === 'convex/server') return { makeFunctionReference };
    if (name === 'convex/react') return { useQuery: (name: string, args: any) => name === 'world' ?
      { worldId: 'target-world', status: 'stoppedByDeveloper' } : name === 'admin' ?
        { settings: { enabled: false }, identity: { townId: 'original-town' } } : name === 'job' ?
          args === 'skip' ? undefined : job : name === 'jobs' && job ? [job] : [],
    useConvex: () => ({ action: (reference: any, args: any) => {
      const name = typeof reference === 'string' ? reference : getFunctionName(reference);
      calls.push({ name, args });
      if (replies.has(name)) {
        const reply = replies.get(name);
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(
          typeof reply === 'function' ? reply(args) : reply,
        );
      }
      if (name === 'advanceImport') return Promise.resolve(nextProgress);
      if (name === 'createImport') { job = { jobId: 'staging-job', kind: 'import', state: 'STAGING', phase: 'STAGING',
        sourceTownId: 'original-town', chunkCount: 1, processedChunks: 0, uploadedChunks: 0 };
        return Promise.resolve({ jobId: 'staging-job' }); }
      return Promise.resolve({});
    } }) };
    if (name === './AdminShared') return { AdminButton: 'AdminButton', Field: 'Field', EmptyState: 'EmptyState',
      TaskFeedback: 'TaskFeedback', useAdminTask: () => task, formatTime: () => '', downloadJsonText: (text: string, name: string) => downloads.push({ text, name }) };
    if (name === './archiveBundle') return archiveBundle;
    if (name === './archiveFiles') return { loadLargeArchiveManifest, confirmedLargeArchiveSigner, archivePrivacyPageNumber,
      supportsArchiveDirectory: () => true, selectArchiveDirectory: () => Promise.resolve(directory), writeArchiveText };
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
  function text(value: any): string {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map(text).join('');
    if (typeof value === 'object') return text(value.props?.children);
    return String(value);
  }
  function button(label: string) { return render().find(element => element.type === 'AdminButton' && text(element.props.children) === label)!; }
  function change(match: (element: Element) => boolean, target: any) {
    const element = render().find(match)!; expect(element).toBeDefined(); element.props.onChange({ target });
  }
  return { calls, downloads, folderFiles, folderAttempts, successes,
    failFolderWrite: (name?: string) => { failingFilename = name; },
    observeFolderWrite: (observe: () => void) => { observeFolderWrite = observe; },
    unmount: () => cleanups.forEach(cleanup => cleanup()), respond: (name: string, reply: unknown) => replies.set(name, reply), button, render, text, lastError: () => lastError,
    selectJob: (value: any) => {
      job = value;
      change(element => element.type === 'select' && element.props.value === '', { value: job.jobId });
    },
    nextProgress: (value: any) => { nextProgress = value; },
    setLanguage: () => { language = 'zh-CN'; },
    load: async (input: ReturnType<typeof file>) => { change(element => element.props.type === 'file' && !element.props.multiple,
      { files: [input] }); await work; },
    loadBundle: async (input: ReturnType<typeof file>) => {
      const inputs = render().filter(element => element.props.type === 'file' && !element.props.multiple);
      inputs[1].props.onChange({ target: { files: [input] } }); await work;
    },
    change, click: async (label: string) => { const element = button(label); expect(element).toBeDefined();
      expect(element.props.disabled).toBeFalsy(); element.props.onClick(); await Promise.resolve(); await work; },
    password: (value: string) => change(element => element.props.type === 'password' && element.props.autoComplete === 'off', { value }),
    confirmSigner: (value: string) => change(element => element.props.maxLength === 100, { value }),
    selectChunks: (inputs: ReturnType<typeof file>[]) => change(element => element.props.type === 'file' && element.props.multiple, { files: inputs }),
  };
}
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));

test.each(['VALIDATING', 'EXPORTING', 'ALLOCATE', 'DERIVED_PRIVACY'])('archive %s progress keeps the phase counter separate from chunk totals', phase => {
  const ui = panel();
  ui.selectJob({ jobId: 'progress-job', kind: 'import', state: 'VALIDATING', phase,
    chunkCount: 784, uploadedChunks: 784, processedChunks: 4060, recordCount: 24000 });
  function fact(label: string) {
    const elements = ui.render(), index = elements.findIndex(element => element.type === 'dt' && ui.text(element) === label);
    expect(index).toBeGreaterThan(-1);
    return ui.text(elements[index + 1]);
  }
  expect(fact('Current phase progress')).toBe('4060');
  expect(fact('Archive chunks')).toBe('784 expected · 784 uploaded');
  expect(ui.render().some(element => element.type === 'dt' && ui.text(element) === 'Chunks')).toBe(false);
  ui.setLanguage();
  expect(fact('当前阶段进度')).toBe('4060');
  expect(fact('归档分块')).not.toContain('4060');
});

test('batch progress message never labels a validation record count as chunks', async () => {
  const ui = panel();
  ui.selectJob({ jobId: 'progress-job', kind: 'import', state: 'VALIDATING', phase: 'VALIDATING',
    chunkCount: 784, uploadedChunks: 784, processedChunks: 4040 });
  ui.nextProgress({ state: 'READY', phase: 'READY', processedChunks: 4060 });
  await ui.click('Continue import');
  expect(ui.render().filter(element => element.type === 'p').map(ui.text)).toContain('READY · READY · current phase progress: 4060');
  expect(ui.render().filter(element => element.type === 'p').map(ui.text).some(value => value.includes('4060 chunks'))).toBe(false);
});

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


function bundleText(header: unknown, chunks = [{ index: 0, text: '{"index":0,"table":"memories","rows":[]}' }], privacyChunks: { index: number; text: string }[] = []) {
  return JSON.stringify({ format: 'ai-town-archive-bundle', version: 1, manifest: JSON.stringify(header), chunks, privacyChunks });
}
function completeExport(ui: ReturnType<typeof panel>) {
  ui.selectJob({ jobId: 'export-job', kind: 'export', state: 'COMPLETE', phase: 'COMPLETE', chunkCount: 1, processedChunks: 1 });
}

function sparseArchive() {
  const header = derived();
  return { ...header, manifest: { ...header.manifest, version: 2,
    chunks: [header.manifest.chunks[0], { ...header.manifest.chunks[0], index: 7 }],
    privacyChunks: [{ index: 0, table: 'travelPrivacyTombstones', count: 1, bytes: 100, digest: 'privacy-digest' }],
    privacyCount: 1, privacyChainDigest: 'privacy-chain' } };
}

test.each([false, true])('folder download preserves sparse chunk names, privacy namespace and original bytes (encrypted: %s)', async encrypted => {
  const ui = panel(), header = sparseArchive(), password = 'synthetic archive passphrase';
  const chunk = (index: number) => `{ "index": ${index}, "table": "memories", "rows": [] }`;
  const privacy = { index: 0, table: 'travelPrivacyTombstones', rows: [] };
  ui.respond('getManifest', header);
  ui.respond('getChunk', ({ index }: { index: number }) => chunk(index));
  ui.respond('federation/backupPrivacyChunks:getChunk', privacy);
  ui.selectJob({ jobId: 'export-job', kind: 'export', state: 'COMPLETE', phase: 'COMPLETE', chunkCount: 2 });
  if (encrypted) {
    ui.render().filter(element => element.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } });
    for (const input of ui.render().filter(element => element.props.autoComplete === 'new-password'))
      input.props.onChange({ target: { value: password } });
  }
  const progress: string[] = [];
  ui.observeFolderWrite(() => { progress.push(...ui.render().filter(element => element.type === 'p').map(ui.text)); });
  await ui.click('Save entire archive to folder');
  expect(ui.lastError()).toBeUndefined();
  expect(ui.calls.map(call => [call.name, call.args.index ?? call.args.pageNumber])).toEqual([
    ['getManifest', undefined], ['getChunk', 0], ['getChunk', 7], ['federation/backupPrivacyChunks:getChunk', 0],
  ]);
  expect([...ui.folderFiles.keys()]).toEqual(['manifest.json', 'chunk-000000.json', 'chunk-000007.json', 'privacy-000000.json']);
  const expected = [JSON.stringify(header), chunk(0), chunk(7), JSON.stringify(privacy)];
  for (const [index, text] of [...ui.folderFiles.values()].entries()) {
    if (encrypted) {
      const purpose = index === 0 ? 'manifest' : 'chunk';
      expect(JSON.parse(text)).toMatchObject({ cipher: 'AES-256-GCM', purpose });
      expect(await readBackupText(file(text), index === 0 ? 5_000_000 : 1024 * 1024, purpose, password)).toBe(expected[index]);
    } else expect(text).toBe(expected[index]);
  }
  expect(progress).toEqual(expect.arrayContaining(['Saving chunk 1 / 2', 'Saving chunk 2 / 2', 'Saving privacy page 1 / 1']));
  expect(ui.successes).toEqual(['Manifest and every referenced chunk saved to the selected folder.']);
  expect(ui.downloads).toHaveLength(0);
});

test('folder download retains consecutive snapshot chunks and the signed manifest', async () => {
  const ui = panel(), header = raw();
  header.manifest.chunks.push({ ...header.manifest.chunks[0], index: 1 });
  ui.respond('getManifest', header);
  ui.respond('getChunk', ({ index }: { index: number }) => `snapshot chunk ${index}`);
  completeExport(ui);
  await ui.click('Save entire archive to folder');
  expect(ui.calls.filter(call => call.name === 'getChunk').map(call => call.args.index)).toEqual([0, 1]);
  expect([...ui.folderFiles.entries()]).toEqual([
    ['manifest.json', JSON.stringify(header)], ['chunk-000000.json', 'snapshot chunk 0'], ['chunk-000001.json', 'snapshot chunk 1'],
  ]);
  expect(ui.lastError()).toBeUndefined();
});

test('folder download rejects an invalid manifest before creating files or fetching parts', async () => {
  const ui = panel();
  ui.respond('getManifest', { ...sparseArchive(), unsupportedMetadata: true });
  completeExport(ui);
  await ui.click('Save entire archive to folder');
  expect(ui.lastError()).toBeDefined();
  expect(ui.calls.map(call => call.name)).toEqual(['getManifest']);
  expect(ui.folderAttempts).toEqual([]);
  expect(ui.successes).toEqual([]);
});

test.each(['RPC', 'write'])('a folder %s failure reports no success and permits a complete retry', async failure => {
  const ui = panel();
  ui.respond('getManifest', sparseArchive());
  ui.respond('getChunk', ({ index }: { index: number }) => {
    if (failure === 'RPC' && index === 7) throw new Error('Chunk request failed');
    return `chunk ${index}`;
  });
  ui.respond('federation/backupPrivacyChunks:getChunk', { index: 0, table: 'travelPrivacyTombstones', rows: [] });
  if (failure === 'write') ui.failFolderWrite('chunk-000007.json');
  completeExport(ui);
  await ui.click('Save entire archive to folder');
  expect(ui.lastError()).toBeDefined();
  expect(ui.successes).toEqual([]);
  expect([...ui.folderFiles.keys()]).toEqual(['manifest.json', 'chunk-000000.json']);
  expect(ui.button('Save entire archive to folder').props.disabled).toBeFalsy();
  ui.respond('getChunk', ({ index }: { index: number }) => `chunk ${index}`);
  ui.failFolderWrite();
  await ui.click('Save entire archive to folder');
  expect(ui.lastError()).toBeUndefined();
  expect([...ui.folderFiles.keys()]).toEqual(['manifest.json', 'chunk-000000.json', 'chunk-000007.json', 'privacy-000000.json']);
  expect(ui.successes).toEqual(['Manifest and every referenced chunk saved to the selected folder.']);
});

test.each([0, 7])('selected chunk download accepts declared sparse index %s', async index => {
  const ui = panel(), chunk = `original chunk ${index}`;
  ui.respond('getManifest', sparseArchive());
  ui.respond('getChunk', chunk);
  ui.selectJob({ jobId: 'export-job', kind: 'export', state: 'COMPLETE', phase: 'COMPLETE', chunkCount: 2 });
  ui.change(element => element.props.type === 'number' && element.props.max === 39999, { value: String(index) });
  await ui.click('Download selected chunk');
  expect(ui.calls.map(call => call.name)).toEqual(['getManifest', 'getChunk']);
  expect(ui.calls[1].args.index).toBe(index);
  expect(ui.downloads).toEqual([{ name: `chunk-${String(index).padStart(6, '0')}.json`, text: chunk }]);
  expect(ui.lastError()).toBeUndefined();
});

test('selected chunk download rejects an undeclared sparse index without fetching a chunk', async () => {
  const ui = panel();
  ui.respond('getManifest', sparseArchive());
  completeExport(ui);
  ui.change(element => element.props.type === 'number' && element.props.max === 39999, { value: '1' });
  await ui.click('Download selected chunk');
  expect(String(ui.lastError())).toContain('This archive has no chunk at the selected index.');
  expect(ui.calls.map(call => call.name)).toEqual(['getManifest']);
  expect(ui.downloads).toEqual([]);
  expect(ui.successes).toEqual([]);
});

test('single-file download fetches all declared parts before downloading once', async () => {
  const ui = panel(), header = derived();
  header.manifest.chunks[0].index = 7;
  ui.respond('getManifest', header);
  const chunk = '{"index":7,"table":"memories","rows":[]}';
  ui.respond('getChunk', chunk);
  completeExport(ui);
  await ui.click('Download entire archive as one file');
  expect(ui.calls.map(call => call.name)).toEqual(['getManifest', 'getChunk']);
  expect(ui.calls[1].args.index).toBe(7);
  expect(ui.downloads).toHaveLength(1);
  const bundle = archiveBundle.decodeArchiveBundle(ui.downloads[0].text);
  expect(bundle.manifest).toBe(JSON.stringify(header));
  expect(bundle.chunks).toEqual([{ index: 7, text: chunk }]);
});

test('a failed chunk fetch downloads no partial bundle and preserves separate download actions', async () => {
  const ui = panel();
  ui.respond('getManifest', raw());
  ui.respond('getChunk', new Error('Chunk request failed'));
  completeExport(ui);
  await ui.click('Download entire archive as one file');
  expect(ui.lastError()).toBeDefined();
  expect(ui.downloads).toHaveLength(0);
  expect(ui.button('Download manifest')).toBeDefined();
  expect(ui.button('Download selected chunk')).toBeDefined();
});

test('a loaded bundle preselects files but retains source confirmation and server staging', async () => {
  const ui = panel(), chunk = '{"index":0,"table":"memories","rows":[]}';
  await ui.loadBundle(file(bundleText(raw(), [{ index: 0, text: chunk }]), 'bundle.json'));
  expect(ui.lastError()).toBeUndefined();
  expect(ui.calls).toHaveLength(0);
  expect(ui.button('Create staging task').props.disabled).toBe(true);
  ui.render().filter(element => element.props.type === 'checkbox').at(-1)!.props.onChange({ target: { checked: true } });
  await ui.click('Create staging task');
  await ui.click('Stage selected chunks');
  expect(ui.calls.find(call => call.name === 'stageChunk')!.args.chunk).toBe(chunk);
});

test('missing bundle chunks clear an earlier valid manifest and files', async () => {
  const ui = panel();
  await ui.loadBundle(file(bundleText(raw())));
  await ui.loadBundle(file(bundleText(raw(), [])));
  expect(ui.lastError()).toBeDefined();
  expect(ui.button('Create staging task').props.disabled).toBe(true);
  expect(ui.button('Stage selected chunks').props.disabled).toBe(true);
  expect(ui.calls).toHaveLength(0);
});

test('switching from a bundle to an ordinary manifest clears preselected bundle parts', async () => {
  const ui = panel();
  await ui.loadBundle(file(bundleText(raw())));
  await ui.load(file(JSON.stringify(raw())));
  ui.render().filter(element => element.props.type === 'checkbox').at(-1)!.props.onChange({ target: { checked: true } });
  await ui.click('Create staging task');
  expect(ui.button('Stage selected chunks').props.disabled).toBe(true);
});


test('v2 bundle downloads and preselects independent privacy pages without confirming its signer', async () => {
  const ui = panel();
  const header = derived();
  const v2 = { ...header, manifest: { ...header.manifest, version: 2,
    privacyChunks: [{ index: 0, table: 'travelPrivacyTombstones', count: 1, bytes: 100, digest: 'privacy-digest' }],
    privacyCount: 1, privacyChainDigest: 'privacy-chain' } };
  const chunk = '{"index":0,"table":"memories","rows":[]}';
  const page = { index: 0, table: 'travelPrivacyTombstones', rows: [] };
  ui.respond('getManifest', v2);
  ui.respond('getChunk', chunk);
  ui.respond('federation/backupPrivacyChunks:getChunk', page);
  completeExport(ui);
  await ui.click('Download entire archive as one file');
  expect(ui.lastError()).toBeUndefined();
  expect(ui.calls.map(call => call.name)).toEqual(['getManifest', 'getChunk', 'federation/backupPrivacyChunks:getChunk']);
  await ui.loadBundle(file(ui.downloads[0].text));
  expect(ui.render().find(element => element.props.maxLength === 100)!.props.value).toBe('');
  ui.render().filter(element => element.props.type === 'checkbox').at(-1)!.props.onChange({ target: { checked: true } });
  ui.confirmSigner((await loadLargeArchiveManifest(v2)).declaredLocalSignerFingerprint!);
  await ui.click('Create staging task');
  await ui.click('Stage selected privacy pages');
  expect(ui.calls.find(call => call.name === 'federation/backupPrivacyChunks:stageChunk')!.args).toMatchObject({ pageNumber: 0, chunk: JSON.stringify(page) });
});

test('encrypted bundle manifest and parts require separate browser passphrase entries', async () => {
  const ui = panel(), password = 'synthetic archive passphrase';
  const chunk = '{"index":0,"table":"memories","rows":[]}';
  const manifest = await encryptBackupText(JSON.stringify(raw()), password, 'manifest', 5_000_000);
  const encryptedChunk = await encryptBackupText(chunk, password, 'chunk', 1024 * 1024);
  const bundled = JSON.stringify({ format: 'ai-town-archive-bundle', version: 1, manifest,
    chunks: [{ index: 0, text: encryptedChunk }], privacyChunks: [] });
  await ui.loadBundle(file(bundled));
  expect(ui.button('Create staging task').props.disabled).toBe(true);
  ui.password(password);
  await ui.click('Load selected bundle');
  expect(ui.render().find(element => element.props.type === 'password' && element.props.autoComplete === 'off')!.props.value).toBe('');
  ui.render().filter(element => element.props.type === 'checkbox').at(-1)!.props.onChange({ target: { checked: true } });
  await ui.click('Create staging task');
  await ui.click('Stage selected chunks');
  expect(ui.calls.find(call => call.name === 'stageChunk')).toBeUndefined();
  ui.password(password);
  await ui.click('Stage selected chunks');
  expect(ui.calls.find(call => call.name === 'stageChunk')!.args.chunk).toBe(chunk);
  expect(ui.calls.every(call => !('passphrase' in call.args))).toBe(true);
});


test('loading a bundle clears an old staging job until the operator explicitly selects a task', async () => {
  const ui = panel();
  const oldJob = { jobId: 'old-import', kind: 'import', state: 'STAGING', phase: 'STAGING', chunkCount: 1, uploadedChunks: 0 };
  ui.selectJob(oldJob);
  await ui.loadBundle(file(bundleText(raw())));
  expect(ui.button('Stage selected chunks').props.disabled).toBe(true);
  expect(ui.calls).toHaveLength(0);
  ui.selectJob(oldJob);
  await ui.click('Stage selected chunks');
  expect(ui.calls.find(call => call.name === 'stageChunk')!.args.jobId).toBe('old-import');
});

test('an oversized bundle fails before reading the file and clears an earlier selection', async () => {
  const ui = panel();
  await ui.loadBundle(file(bundleText(raw())));
  let reads = 0;
  await ui.loadBundle({ name: 'too-large.json', size: archiveBundle.MAX_ARCHIVE_BUNDLE_BYTES + 1,
    text: () => { reads++; return Promise.resolve(''); } });
  expect(reads).toBe(0);
  expect(ui.lastError()).toBeDefined();
  expect(ui.button('Create staging task').props.disabled).toBe(true);
  expect(ui.button('Stage selected chunks').props.disabled).toBe(true);
});


test.each([false, true])('unmount during a bundle chunk request stops further fetches and download (last part: %s)', async lastPart => {
  const ui = panel(), header = raw();
  if (!lastPart) header.manifest.chunks.push({ ...header.manifest.chunks[0], index: 1 });
  ui.respond('getManifest', header);
  let requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  let finish!: (value: string) => void;
  const delayed = new Promise<string>(resolve => { finish = resolve; });
  ui.respond('getChunk', () => { requested(); return delayed; });
  completeExport(ui);
  const pending = ui.click('Download entire archive as one file');
  await started;
  ui.unmount();
  finish('{"index":0,"table":"memories","rows":[]}');
  await pending;
  expect(ui.calls.map(call => call.name)).toEqual(['getManifest', 'getChunk']);
  expect(ui.downloads).toHaveLength(0);
});
