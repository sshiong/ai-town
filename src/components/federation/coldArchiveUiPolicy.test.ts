import {
  canAdvanceColdMirror,
  canStartColdMirror,
  coldMirrorProgress,
} from './coldArchiveUiPolicy';

test('external copies require a selected verified archive, enabled verified destination and declared operator', () => {
  const target = { enabled: true, state: 'VERIFIED' };
  expect(canStartColdMirror(true, target, 'Operator', false)).toBe(true);
  expect(canStartColdMirror(false, target, 'Operator', false)).toBe(false);
  expect(canStartColdMirror(true, undefined, 'Operator', false)).toBe(false);
  expect(canStartColdMirror(true, { ...target, enabled: false }, 'Operator', false)).toBe(false);
  expect(canStartColdMirror(true, { ...target, state: 'UNVERIFIED' }, 'Operator', false)).toBe(
    false,
  );
  expect(canStartColdMirror(true, target, ' ', false)).toBe(false);
  expect(canStartColdMirror(true, target, 'a'.repeat(101), false)).toBe(false);
  expect(canStartColdMirror(true, target, 'Operator', true)).toBe(false);
});

test('uploading every data part does not claim completion before the signed root read-back', () => {
  const job = { state: 'RUNNING', nextIndex: 2, partCount: 2 };
  expect(coldMirrorProgress(job)).toEqual({
    verifiedParts: 2,
    totalParts: 3,
    rootNext: true,
    complete: false,
  });
  expect(coldMirrorProgress({ ...job, nextIndex: 3, state: 'COMPLETE' })).toEqual({
    verifiedParts: 3,
    totalParts: 3,
    rootNext: false,
    complete: true,
  });
  expect(coldMirrorProgress({ state: 'RUNNING', nextIndex: 0, partCount: 0 })).toEqual({
    verifiedParts: 0,
    totalParts: 1,
    rootNext: true,
    complete: false,
  });
});

test('failed checkpoints can retry while completed or cancelled tasks cannot upload again', () => {
  const job = { state: 'RUNNING', nextIndex: 1, partCount: 3 };
  expect(canAdvanceColdMirror(job, false)).toBe(true);
  expect(canAdvanceColdMirror({ ...job, state: 'FAILED' }, false)).toBe(true);
  for (const state of ['COMPLETE', 'CANCELLED'])
    expect(canAdvanceColdMirror({ ...job, state }, false)).toBe(false);
  expect(canAdvanceColdMirror(job, true)).toBe(false);
  expect(canAdvanceColdMirror(undefined, false)).toBe(false);
});
