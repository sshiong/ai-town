import { useLocale } from '../../i18n';
import { useState } from 'react';
import { ColdHistorySource } from './ColdHistorySource';
import { useQuery } from 'convex/react';
import { makeFunctionReference, type ApiFromModules } from 'convex/server';
import type * as social from '../../../convex/agent/social';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import { api } from '../../../convex/_generated/api';
import { AdminButton, EmptyState, Field, formatTime } from './AdminShared';

type SocialApi = ApiFromModules<{ social: typeof social }>['social'];

// Typed references also work before local API declarations have been regenerated.
const historyQuery: SocialApi['history'] = makeFunctionReference('agent/social:history');
const relationshipsQuery: SocialApi['relationships'] = makeFunctionReference(
  'agent/social:relationships',
);
const evidenceQuery: SocialApi['evidence'] = makeFunctionReference('agent/social:evidence');
const conversationQuery: SocialApi['conversationSource'] = makeFunctionReference(
  'agent/social:conversationSource',
);
const transcriptQuery: SocialApi['transcriptSource'] = makeFunctionReference(
  'agent/social:transcriptSource',
);
type Owner = {
  adminToken: string;
  worldId: Id<'worlds'>;
  playerId: string;
  agentGlobalId?: string;
};
type Memory = {
  memoryId: Id<'memories'>;
  recordedAt: number;
  description: string;
  importance: number;
  data: Doc<'memories'>['data'];
};

function Pager({
  cursor,
  setCursor,
  done,
  next,
}: {
  cursor: string | null;
  setCursor: (cursor: string | null) => void;
  done: boolean;
  next: string | null;
}) {
  const { t } = useLocale();
  return (
    <div className="admin-toolbar">
      <AdminButton disabled={cursor === null} onClick={() => setCursor(null)}>
        {t("First page")}
      </AdminButton>
      <AdminButton disabled={done || !next} onClick={() => setCursor(next)}>
        {t("Older records")}
      </AdminButton>
    </div>
  );
}

function RawSource({ owner, memory }: { owner: Owner; memory: Memory }) {
  const { t } = useLocale();
  const [cursor, setCursor] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(
    memory.data.type === 'travel' ? (memory.data.transcriptPageNumber ?? 0) : 0,
  );
  const conversation = useQuery(
    conversationQuery,
    memory.data.type === 'conversation'
      ? { ...owner, memoryId: memory.memoryId, cursor, numItems: 12 }
      : 'skip',
  );
  const transcript = useQuery(
    transcriptQuery,
    memory.data.type === 'travel' ? { ...owner, memoryId: memory.memoryId, pageNumber } : 'skip',
  );
  if (memory.data.type !== 'conversation' && memory.data.type !== 'travel') return null;
  if (memory.data.type === 'conversation')
    return (
      <div>
        <h4>{t("Retained conversation messages")}</h4>
        <code>{memory.data.conversationId}</code>
        {conversation === undefined ? (
          <p role="status">{t("Loading source...")}</p>
        ) : (
          <>
            {conversation.status !== 'AVAILABLE' && (
              <p className="admin-muted">{t("Source:")} {conversation.status}</p>
            )}
            <ul className="admin-list">
              {conversation.page.map((message) => (
                <li key={message.messageId}>
                  <div>
                    <code>{message.messageId}</code>
                    <pre className="admin-report">{message.text}</pre>
                    <p className="admin-muted">
                      {t("Author presence")} {message.authorPlayerId} · {formatTime(message.occurredAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <Pager
              cursor={cursor}
              setCursor={setCursor}
              done={conversation.isDone}
              next={conversation.continueCursor}
            />
          </>
        )}
      </div>
    );
  return (
    <div>
      <h4>{t("Committed Home transcript")}</h4>
      {transcript === undefined ? (
        <p role="status">{t("Loading transcript...")}</p>
      ) : (
        <>
          <p className="admin-muted">{t("Source:")} {transcript.status}</p>
          {transcript.transcript && (
            <>
              <code>{transcript.transcript.transcriptId}</code>
              <p className="admin-muted">
                {transcript.transcript.state} · {transcript.transcript.receivedPageCount} {t("received pages ·")} {transcript.transcript.totalMessageCount} {t("committed messages · summary")}{' '}
                {transcript.transcript.summaryState}
              </p>
              <ul className="admin-list">
                {transcript.transcript.participants.map((p) => (
                  <li key={p.agentGlobalId}>
                    <div>
                      <strong>{p.name}</strong>
                      <code>{p.agentGlobalId}</code>
                      <p className="admin-muted">
                        {t("Home:")} {p.homeTownId} {t("· presence:")} {p.playerId}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              <p>
                {t("Page")} {pageNumber + 1} /{' '}
                {(transcript.transcript.finalPageNumber ??
                  transcript.transcript.highestPageNumber) + 1}
                {transcript.transcript.finalPageNumber === undefined &&
                  t(" received so far (final page pending)")}
              </p>
              {transcript.status === 'MISSING_PAGE' && (
                <p className="admin-error">
                  {t("This page has not been retained or received. Other pages remain accessible.")}
                </p>
              )}
              {transcript.page && (
                <>
                  <code>{transcript.page.eventId}</code>
                  <ul className="admin-list">
                    {transcript.page.messages.map((message, index) => (
                      <li key={message.messageId}>
                        <div>
                          <code>{message.messageId}</code>
                          <pre className="admin-report">{message.text}</pre>
                          <p className="admin-muted">
                            {transcript.transcript?.participants.find(
                              (p) => p.playerId === message.author,
                            )?.agentGlobalId ?? message.author}
                            {' · '}
                            {formatTime(message.occurredAt)}
                          </p>
                          <code>{transcript.page?.memoryIds[index]}</code>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="admin-toolbar">
                <AdminButton
                  disabled={pageNumber === 0}
                  onClick={() => setPageNumber(pageNumber - 1)}
                >
                  {t("Previous page")}
                </AdminButton>
                <AdminButton
                  disabled={
                    pageNumber >=
                    (transcript.transcript.finalPageNumber ??
                      transcript.transcript.highestPageNumber)
                  }
                  onClick={() => setPageNumber(pageNumber + 1)}
                >
                  {t("Next page")}
                </AdminButton>
              </div>
            </>
          )}
          {!transcript.transcript && memory.data.type === 'travel' && memory.data.messageText && (
            <>
              <p>{t("Retained committed message:")}</p>
              <pre className="admin-report">{memory.data.messageText}</pre>
              <code>{memory.data.messageId}</code>
              <code>{memory.data.authorGlobalId}</code>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Evidence({ owner, memory }: { owner: Owner; memory: Memory }) {
  const { t } = useLocale();
  const [cursor, setCursor] = useState<string | null>(null);
  const result = useQuery(evidenceQuery, {
    ...owner,
    memoryId: memory.memoryId,
    cursor,
    numItems: 10,
  });
  return (
    <>
      {memory.data.type === 'reflection' && (
        <p className="admin-muted">
          {t("This is a subjective reflection. The cited events below are its sources.")}
        </p>
      )}
      {result === undefined ? (
        <p role="status">{t("Loading citations...")}</p>
      ) : (
        <>
          {result.status !== 'AVAILABLE' && <p className="admin-error">{result.status}</p>}
          {!result.page.length && result.status === 'AVAILABLE' && (
            <p className="admin-muted">{t("No cited memory IDs were recorded.")}</p>
          )}
          <ul className="admin-list">
            {result.page.map((source) => (
              <li key={source.memoryId}>
                <div>
                  <code>{source.memoryId}</code>
                  {!source.memory ? (
                    <p className="admin-error">{t("Source:")} {source.status}</p>
                  ) : (
                    <>
                      <p>{source.memory.description}</p>
                      <p className="admin-muted">
                        {source.memory.data.type} · {formatTime(source.memory.recordedAt)}
                      </p>
                      <SourceDisclosure owner={owner} memory={source.memory} />
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <Pager
            cursor={cursor}
            setCursor={setCursor}
            done={result.isDone}
            next={result.continueCursor}
          />
        </>
      )}
      <RawSource owner={owner} memory={memory} />
      {(memory.data.type === 'conversation' ||
        (memory.data.type === 'travel' && memory.data.federationConversationId)) && (
        <ColdHistorySource key={memory.memoryId} owner={owner} memoryId={memory.memoryId} />
      )}
    </>
  );
}

function SourceDisclosure({ owner, memory }: { owner: Owner; memory: Memory }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <details className="admin-disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t("Evidence & original messages")}</summary>
      {open && <Evidence owner={owner} memory={memory} />}
    </details>
  );
}

function ResidentHistory({ owner }: { owner: Owner }) {
  const { t } = useLocale();
  const [relationshipCursor, setRelationshipCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [participant, setParticipant] = useState('');
  const [kind, setKind] = useState<Memory['data']['type'] | ''>('');
  const relationships = useQuery(relationshipsQuery, {
    ...owner,
    cursor: relationshipCursor,
    numItems: 10,
  });
  const history = useQuery(historyQuery, {
    ...owner,
    cursor,
    numItems: 20,
    text,
    participantGlobalId: participant || undefined,
    kind: kind || undefined,
  });
  return (
    <>
      <h3>{t("Relationships from this resident's perspective")}</h3>
      <p className="admin-muted">
        {t("Edges preserve recorded encounters and citations. No affinity or trust score is inferred.")}
      </p>
      {relationships === undefined ? (
        <p role="status">{t("Loading relationships...")}</p>
      ) : (
        <>
          {!relationships.page.length && (
            <EmptyState>{t("No relationship edges on this page.")}</EmptyState>
          )}
          <ul className="admin-list">
            {relationships.page.map((memory) => (
              <li key={memory.memoryId}>
                <div>
                  {memory.data.type === 'relationship' && (
                    <>
                      <strong>
                        {memory.data.agentGlobalId ?? t("Local presence {playerId}", { playerId: String(memory.data.playerId) })}
                      </strong>
                      <p className="admin-muted">
                        {t("Home:")} {memory.data.homeTownId ?? t("Not recorded")} {t("· recorded encounters:")}{' '}
                        {memory.data.encounterCount ?? t("Not recorded")}
                      </p>
                      <p className="admin-muted">
                        {t("First:")} {formatTime(memory.data.firstMetAt)} {t("· latest:")}{' '}
                        {formatTime(memory.data.lastMetAt)}
                      </p>
                    </>
                  )}
                  <p>{memory.description}</p>
                  <code>{memory.memoryId}</code>
                  <SourceDisclosure owner={owner} memory={memory} />
                </div>
              </li>
            ))}
          </ul>
          <Pager
            cursor={relationshipCursor}
            setCursor={setRelationshipCursor}
            done={relationships.isDone}
            next={relationships.continueCursor}
          />
        </>
      )}
      <h3>{t("Canonical memory history")}</h3>
      <p className="admin-muted">
        {t("Records with verified world ownership appear here. Legacy records without a world ID need ownership repair before inspection.")}
      </p>
      <div className="admin-form">
        <Field
          label={t("Find retained text")}
          hint={t("Search scans each page of world-scoped retained history; continue through older pages for earlier matches.")}
        >
          <input
            value={text}
            maxLength={200}
            onChange={(event) => {
              setCursor(null);
              setText(event.target.value);
            }}
          />
        </Field>
        <Field
          label={t("Participant global ID")}
          hint={t("Use the exact global ID to distinguish residents who share a name.")}
        >
          <input
            value={participant}
            maxLength={300}
            onChange={(event) => {
              setCursor(null);
              setParticipant(event.target.value);
            }}
          />
        </Field>
        <Field label={t("Memory type")}>
          <select
            value={kind}
            onChange={(event) => {
              setCursor(null);
              setKind(event.target.value as typeof kind);
            }}
          >
            <option value="">{t("All types")}</option>
            {['relationship', 'conversation', 'travel', 'reflection'].map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </Field>
      </div>
      {history === undefined ? (
        <p role="status">{t("Loading retained history...")}</p>
      ) : (
        <>
          {!history.page.length && (
            <EmptyState>
              {t("No matches among the")} {history.scanned} {t("records scanned on this page.")}
              {!history.isDone && t(" Older records remain.")}
            </EmptyState>
          )}
          <ul className="admin-list">
            {history.page.map((memory) => (
              <li key={memory.memoryId}>
                <div>
                  <strong>{memory.data.type}</strong>
                  <p>{memory.description}</p>
                  <p className="admin-muted">
                    {t("Recorded")} {formatTime(memory.recordedAt)}
                    {memory.data.type === 'travel' &&
                      t(" · occurred {time} · at {townId}", { time: formatTime(memory.data.occurredAt), townId: memory.data.hostTownId })}
                  </p>
                  <code>{memory.memoryId}</code>
                  <SourceDisclosure owner={owner} memory={memory} />
                </div>
              </li>
            ))}
          </ul>
          <Pager
            cursor={cursor}
            setCursor={setCursor}
            done={history.isDone}
            next={history.continueCursor}
          />
        </>
      )}
    </>
  );
}

export default function SocialHistoryPanel({ adminToken }: { adminToken: string }) {
  const { t } = useLocale();
  const [selected, setSelected] = useState('');
  const residents = useQuery(api.federation.runtime.listResidents, { adminToken });
  const residentKey = (r: { worldId: Id<'worlds'>; playerId: string }) =>
    `${r.worldId}/${r.playerId}`;
  const resident = residents?.find((r) => residentKey(r) === selected) ?? residents?.[0];
  return (
    <section className="admin-panel" aria-label={t("Relationships and retained history")}>
      <h2>{t("Relationships & retained history")}</h2>
      <p className="admin-muted">
        {t("Private Home records for the selected resident. Identity, evidence and original messages stay linked across visits.")}
      </p>
      {residents === undefined ? (
        <p role="status">{t("Loading residents...")}</p>
      ) : !resident ? (
        <EmptyState>{t("Register resident identities to inspect their retained history.")}</EmptyState>
      ) : (
        <>
          <Field label={t("Resident")}>
            <select
              value={residentKey(resident)}
              onChange={(event) => setSelected(event.target.value)}
            >
              {residents.map((r) => (
                <option key={residentKey(r)} value={residentKey(r)}>
                  {r.name} · {r.agentGlobalId}
                </option>
              ))}
            </select>
          </Field>
          <code>{resident.agentGlobalId}</code>
          <p className="admin-muted">
            {t("World")} {resident.worldId} {t("· presence")} {resident.playerId}
          </p>
          <ResidentHistory
            key={`${residentKey(resident)}/${resident.agentGlobalId}`}
            owner={{
              adminToken,
              worldId: resident.worldId,
              playerId: resident.playerId,
              agentGlobalId: resident.agentGlobalId,
            }}
          />
        </>
      )}
    </section>
  );
}
