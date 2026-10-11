import { useLocale } from '../../i18n';
import { useState } from 'react';
import { ColdHistoryFileTransfer } from './ColdHistoryFileTransfer';
import { ColdHistoryJob } from './ColdHistoryJob';
import { useAction, useQuery } from 'convex/react';
import { makeFunctionReference, type ApiFromModules, type FunctionReturnType } from 'convex/server';
import type * as cold from '../../../convex/federation/coldHistory';
import type { Id } from '../../../convex/_generated/dataModel';
import { AdminButton, TaskFeedback, formatTime, useAdminTask } from './AdminShared';
type ColdApi = ApiFromModules<{ cold: typeof cold }>['cold'];
const discover: ColdApi['discover'] = makeFunctionReference('federation/coldHistory:discover');
const archive: ColdApi['archive'] = makeFunctionReference('federation/coldHistory:archive');
const read: ColdApi['read'] = makeFunctionReference('federation/coldHistory:read');
export function ColdHistorySource({
  owner,
  memoryId,
}: {
  owner: { adminToken: string; worldId: Id<'worlds'>; playerId: string; agentGlobalId?: string };
  memoryId: Id<'memories'>;
}) {
  const { t } = useLocale();
  const args = { ...owner, memoryId };
  const status = useQuery(discover, args),
    publish = useAction(archive),
    load = useAction(read),
    task = useAdminTask();
  const [page, setPage] = useState<FunctionReturnType<ColdApi['read']>>();
  async function show(offset: number) {
    await task.run(
      t('Reading verified archive'),
      async () => {
        setPage(await load({ ...args, offset, numItems: 12 }));
      },
      t('Archive verified and read.'),
    );
  }
  return (
    <section className="admin-section" aria-label={t('Cold history source')}>
      <h4>{t('Private history archive')}</h4>
      <p className="admin-muted">
        {t(
          'A signed copy in private file storage. Original hot messages, memories and citations stay available.',
        )}
      </p>
      {status === undefined ? (
        <p role="status">{t('Checking archive…')}</p>
      ) : status?.state === 'UNAVAILABLE' ? (
        <p className="admin-muted">
          {t(
            'Archive requires a completed conversation and, for travel, a completed Home summary.',
          )}
        </p>
      ) : (
        <>
          {status?.state === 'VERIFIED' ? (
            <>
              <p>
                {t('Verified archive · ')}
                {status.count}
                {t(' messages · ')}
                {status.bytes}
                {t(' bytes ·')} {formatTime(status.verifiedAt)}
              </p>
              <AdminButton disabled={!!task.pending} onClick={() => void show(0)}>
                {t('Read original messages from archive')}
              </AdminButton>
            </>
          ) : status?.jobId ? (
            <ColdHistoryJob owner={args} jobId={status.jobId} />
          ) : (
            <AdminButton
              disabled={!!task.pending}
              onClick={() =>
                void task.run(
                  t('Verifying private archive'),
                  () => publish(args),
                  t(
                    'Archive request saved. Review verification status below; hot records retained.',
                  ),
                )
              }
            >
              {status?.state === 'PENDING'
                ? t('Retry archive verification')
                : t('Create verified private archive')}
            </AdminButton>
          )}
        </>
      )}
      <TaskFeedback task={task} />
      {status !== undefined && status?.state !== 'UNAVAILABLE' && (
        <ColdHistoryFileTransfer
          owner={owner}
          memoryId={memoryId}
          hasArchive={status?.state === 'VERIFIED'}
          version={status?.version}
          chunkCount={status?.chunkCount}
        />
      )}
      {page && (
        <>
          <p className="admin-muted">
            {t('Reading from private file storage · source town ')}
            {page.sourceTownId}
          </p>
          <ul className="admin-list">
            {page.page.map((m) => (
              <li key={m.messageId}>
                <div>
                  <code>{m.messageId}</code>
                  <pre className="admin-report">{m.text}</pre>
                  <p className="admin-muted">
                    {m.authorGlobalId ?? m.authorPlayerId} · {formatTime(m.occurredAt)}
                  </p>
                  {'targetAuthor' in m && (
                    <p className="admin-muted">
                      {t('Restored author: ')}
                      {m.targetAuthor}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="admin-toolbar">
            <AdminButton disabled={!!task.pending} onClick={() => void show(0)}>
              {t('First archive page')}
            </AdminButton>
            <AdminButton
              disabled={page.isDone || !!task.pending}
              onClick={() => void show(page.nextOffset)}
            >
              {t('Next archive page')}
            </AdminButton>
          </div>
        </>
      )}
    </section>
  );
}
