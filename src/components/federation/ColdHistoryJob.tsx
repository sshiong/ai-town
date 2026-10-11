import { useEffect, useRef, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference, type ApiFromModules } from 'convex/server';
import type * as chunks from '../../../convex/federation/coldHistoryChunks';
import type { Id } from '../../../convex/_generated/dataModel';
import { AdminButton, TaskFeedback, useAdminTask } from './AdminShared';

type ChunkApi = ApiFromModules<{ chunks: typeof chunks }>['chunks'];
const statusRef: ChunkApi['status'] = makeFunctionReference('federation/coldHistoryChunks:status');
const advanceRef: ChunkApi['advance'] = makeFunctionReference('federation/coldHistoryChunks:advance');
const resumeRef: ChunkApi['resume'] = makeFunctionReference('federation/coldHistoryChunks:resume');
const cancelRef: ChunkApi['cancel'] = makeFunctionReference('federation/coldHistoryChunks:cancel');
export type ColdHistoryOwner = {
  adminToken: string; worldId: Id<'worlds'>; playerId: string;
  agentGlobalId?: string; memoryId: Id<'memories'>;
};

export function ColdHistoryJob({ owner, jobId }: { owner: ColdHistoryOwner; jobId: Id<'coldHistoryJobs'> }) {
  const convex = useConvex(), task = useAdminTask();
  const args = { ...owner, jobId }, job = useQuery(statusRef, args);
  const pauseRequested = useRef(false);
  const [advancing, setAdvancing] = useState(false);
  useEffect(() => () => { pauseRequested.current = true; }, []);
  async function advance() {
    pauseRequested.current = false;
    setAdvancing(true);
    try {
      while (!pauseRequested.current) {
        const next = await convex.action(advanceRef, args);
        if (['COMPLETE', 'FAILED', 'CANCELLED'].includes(next.state) || next.phase === 'IMPORT_STAGE') break;
      }
    } finally { setAdvancing(false); }
  }
  const finished = job && ['COMPLETE', 'CANCELLED'].includes(job.state);
  return (
    <section aria-label="History archive task">
      <h4>History archive task</h4>
      <p className="admin-muted">
        Disable federation and stop the town engine before processing. This task holds a
        maintenance lock until it completes or is cancelled. Pausing keeps the lock and checkpoint.
        Original messages and memories are retained.
      </p>
      {!job ? <p role="status">Loading history task…</p> : <>
        <p>{job.state} · {job.phase} · {job.count} messages · {job.chunkCount} parts · {job.verifiedChunks} verified parts</p>
        {job.error && <p className="admin-error" role="alert">{job.error}</p>}
        <div className="admin-toolbar">
          <AdminButton disabled={!!task.pending || finished || job.state === 'FAILED' || job.phase === 'IMPORT_STAGE'}
            onClick={() => void task.run('Processing history archive', advance, 'History checkpoint saved. Review task status.')}>
            Continue processing
          </AdminButton>
          <AdminButton disabled={!advancing} onClick={() => { pauseRequested.current = true; }}>Pause after this step</AdminButton>
          {job.state === 'FAILED' && <AdminButton disabled={!!task.pending}
            onClick={() => void task.run('Resuming failed history task', () => convex.mutation(resumeRef, args))}>
            Resume failed task
          </AdminButton>}
          <AdminButton disabled={!!task.pending || finished}
            onClick={() => void task.run('Cancelling history task', () => convex.mutation(cancelRef, args), 'Task cancelled. Maintenance lock released; original history retained.')}>
            Cancel unfinished task
          </AdminButton>
        </div>
      </>}
      <TaskFeedback task={task} />
    </section>
  );
}
