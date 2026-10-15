import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the component's real submit handler with isolated React hook state.
const compiled = ts.transpileModule(readFileSync(new URL('./CloneActivationPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: any; props: Record<string, any> };

function panel() {
  const states: any[] = [], calls: any[] = [];
  let cursor = 0, reply: Promise<unknown> = Promise.resolve({ activated: true });
  let work: Promise<unknown> = Promise.resolve(), error: unknown, success = '', refreshes = 0;
  const status = { identity: { mode: 'DISABLED' }, cloneActivation: {
    eligible: true, reason: null as string | null, importId: 'clone-receipt', sourceTownId: 'source-town',
    townId: 'independent-town', deploymentInstanceId: 'independent-deployment', deploymentEpoch: 1,
    activatedAt: null,
  } };
  const task = { pending: undefined as string | undefined,
    run: (label: string, run: () => Promise<unknown>, message: string) => {
      task.pending = label;
      work = run().then(() => { success = message; }).catch(reason => { error = reason; })
        .finally(() => { task.pending = undefined; });
      return work;
    } };
  const module = { exports: {} as { default: (props: any) => Element | null } };
  runInNewContext(compiled, { exports: module.exports, module, require: (name: string) => {
    if (name === 'react/jsx-runtime') return {
      jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }),
    };
    if (name === 'react') return {
      useState: (initial: any) => { const index = cursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (value: any) => { states[index] = value; }]; },
      useRef: (initial: any) => { const index = cursor++; return states[index] ??= { current: initial }; },
    };
    if (name === '../../i18n') return { useLocale: () => ({ t: (label: string, values: any) =>
      label.replace('{reason}', values?.reason ?? '') }) };
    if (name === '../../../convex/_generated/api') return {
      api: { federation: { admin: { activateIndependentClone: 'activateIndependentClone' } } },
    };
    if (name === 'convex/react') return { useConvex: () => ({ mutation: (name: string, args: any) => {
      calls.push({ name, args }); return reply;
    } }) };
    if (name === './AdminShared') return { AdminButton: 'AdminButton', Field: 'Field' };
    throw new Error(`Unexpected import: ${name}`);
  } });
  function elements(value: any): Element[] {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(elements);
    return typeof value === 'object' && value.props ? [value, ...elements(value.props.children)] : [];
  }
  const render = () => { cursor = 0; return elements(module.exports.default({ adminToken: 'synthetic-admin',
    status, task, refresh: async () => { refreshes++; } })); };
  const change = (name: string, value: string | boolean) => render().find(element =>
    element.type === 'input' && element.props.name === name)!.props.onChange({ target: { value, checked: value } });
  const submit = () => render().find(element => element.type === 'form')!.props.onSubmit({ preventDefault() {} });
  return { status, task, calls, render, change, submit, wait: () => work,
    button: () => render().find(element => element.type === 'AdminButton')!,
    ready: () => { change('operator', '  Administrator  '); change('reason', '  Independent clone restored  ');
      change('confirmIndependentClone', true); },
    reply: (value: Promise<unknown>) => { reply = value; },
    error: () => error, success: () => success, refreshes: () => refreshes,
  };
}

test.each(['ACTIVE', 'MIGRATING_IN', 'NEEDS_RECONCILIATION', 'QUARANTINED', 'MIGRATING_OUT'])(
  'activation is absent for %s identities', mode => {
    const ui = panel(); ui.status.identity.mode = mode; expect(ui.render()).toEqual([]);
  },
);

test('disabled towns require a server clone receipt and show eligibility blockers', async () => {
  const ui = panel();
  ui.status.cloneActivation.importId = null as any;
  expect(ui.render()).toEqual([]);
  ui.status.cloneActivation.importId = 'clone-receipt';
  ui.status.cloneActivation.eligible = false;
  ui.status.cloneActivation.reason = 'CLONE_ACTIVE_MIGRATION';
  ui.ready();
  expect(ui.render().find(element => element.props.role === 'status')!.props.children)
    .toBe('Clone activation is blocked: CLONE_ACTIVE_MIGRATION');
  expect(ui.button().props.disabled).toBe(true);
  ui.submit(); await ui.wait(); expect(ui.calls).toEqual([]);
});

test('submit enforces audit inputs, confirmation and pending even when invoked directly', async () => {
  const ui = panel();
  ui.submit();
  ui.change('operator', 'Administrator'); ui.change('reason', 'Restored clone'); ui.submit();
  expect(ui.button().props.disabled).toBe(true);
  ui.change('confirmIndependentClone', true);
  ui.task.pending = 'Another operation'; ui.submit();
  expect(ui.calls).toEqual([]);
  ui.task.pending = undefined;
  ui.change('reason', ' '.repeat(5)); ui.submit();
  await ui.wait(); expect(ui.calls).toEqual([]);
});

test('activation submits the server fences once and preserves disabled admission in its success message', async () => {
  const ui = panel(); ui.ready();
  let resolve!: () => void;
  ui.reply(new Promise<void>(done => { resolve = done; }));
  const handler = ui.render().find(element => element.type === 'form')!.props.onSubmit;
  handler({ preventDefault() {} }); handler({ preventDefault() {} });
  expect(ui.button().props.disabled).toBe(true);
  expect(ui.calls).toEqual([{ name: 'activateIndependentClone', args: {
    adminToken: 'synthetic-admin', importId: 'clone-receipt', expectedTownId: 'independent-town',
    expectedDeploymentInstanceId: 'independent-deployment', expectedDeploymentEpoch: 1,
    operator: 'Administrator', reason: 'Independent clone restored',
  } }]);
  resolve(); await ui.wait();
  expect(ui.refreshes()).toBe(1);
  expect(ui.success()).toBe('Independent cloned town activated. Visits and new pairing requests remain disabled. Enable them separately in Admission & safety.');
});

test('server refusal preserves inputs and confirmation for a deliberate retry', async () => {
  const ui = panel(); ui.ready();
  ui.reply(Promise.reject(new Error('CLONE_ACTIVATION_FENCE_MISMATCH')));
  ui.submit(); await ui.wait();
  expect(String(ui.error())).toContain('CLONE_ACTIVATION_FENCE_MISMATCH');
  expect(ui.refreshes()).toBe(0); expect(ui.success()).toBe('');
  expect(ui.button().props.disabled).toBe(false);
  ui.reply(Promise.resolve({ activated: true })); ui.submit(); await ui.wait();
  expect(ui.calls).toHaveLength(2); expect(ui.refreshes()).toBe(1);
});
