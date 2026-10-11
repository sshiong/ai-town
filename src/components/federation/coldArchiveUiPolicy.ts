export type ColdMirrorJob = { state: string; nextIndex: number; partCount: number };

export function canStartColdMirror(
  archiveSelected: boolean,
  target: { enabled: boolean; state: string } | undefined,
  operator: string,
  pending: boolean,
) {
  return (
    archiveSelected &&
    !!target?.enabled &&
    target.state === 'VERIFIED' &&
    !!operator.trim() &&
    operator.length <= 100 &&
    !pending
  );
}
export function canAdvanceColdMirror(job: ColdMirrorJob | undefined, pending: boolean) {
  return !!job && ['RUNNING', 'FAILED'].includes(job.state) && !pending;
}
export function coldMirrorProgress(job: ColdMirrorJob) {
  return {
    verifiedParts: Math.min(job.nextIndex, job.partCount + 1),
    totalParts: job.partCount + 1,
    rootNext: job.nextIndex === job.partCount && job.state !== 'COMPLETE',
    complete: job.state === 'COMPLETE',
  };
}
