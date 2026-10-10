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
  return (
    <div className="admin-toolbar">
      <AdminButton disabled={cursor === null} onClick={() => setCursor(null)}>
        First page
      </AdminButton>
      <AdminButton disabled={done || !next} onClick={() => setCursor(next)}>
        Older records
      </AdminButton>
    </div>
  );
}

function RawSource({ owner, memory }: { owner: Owner; memory: Memory }) {
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
        <h4>Retained conversation messages</h4>
        <code>{memory.data.conversationId}</code>
        {conversation === undefined ? (
          <p role="status">Loading source...</p>
        ) : (
          <>
            {conversation.status !== 'AVAILABLE' && (
              <p className="admin-muted">Source: {conversation.status}</p>
            )}
            <ul className="admin-list">
              {conversation.page.map((message) => (
                <li key={message.messageId}>
                  <div>
                    <code>{message.messageId}</code>
                    <pre className="admin-report">{message.text}</pre>
                    <p className="admin-muted">
                      Author presence {message.authorPlayerId} · {formatTime(message.occurredAt)}
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
      <h4>Committed Home transcript</h4>
      {transcript === undefined ? (
        <p role="status">Loading transcript...</p>
      ) : (
        <>
          <p className="admin-muted">Source: {transcript.status}</p>
          {transcript.transcript && (
            <>
              <code>{transcript.transcript.transcriptId}</code>
              <p className="admin-muted">
                {transcript.transcript.state} · {transcript.transcript.receivedPageCount} received
                pages · {transcript.transcript.totalMessageCount} committed messages · summary{' '}
                {transcript.transcript.summaryState}
              </p>
              <ul className="admin-list">
                {transcript.transcript.participants.map((p) => (
                  <li key={p.agentGlobalId}>
                    <div>
                      <strong>{p.name}</strong>
                      <code>{p.agentGlobalId}</code>
                      <p className="admin-muted">
                        Home: {p.homeTownId} · presence: {p.playerId}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              <p>
                Page {pageNumber + 1} /{' '}
                {(transcript.transcript.finalPageNumber ??
                  transcript.transcript.highestPageNumber) + 1}
                {transcript.transcript.finalPageNumber === undefined &&
                  ' received so far (final page pending)'}
              </p>
              {transcript.status === 'MISSING_PAGE' && (
                <p className="admin-error">
                  This page has not been retained or received. Other pages remain accessible.
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
                  Previous page
                </AdminButton>
                <AdminButton
                  disabled={
                    pageNumber >=
                    (transcript.transcript.finalPageNumber ??
                      transcript.transcript.highestPageNumber)
                  }
                  onClick={() => setPageNumber(pageNumber + 1)}
                >
                  Next page
                </AdminButton>
              </div>
            </>
          )}
          {!transcript.transcript && memory.data.type === 'travel' && memory.data.messageText && (
            <>
              <p>Retained committed message:</p>
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
          This is a subjective reflection. The cited events below are its sources.
        </p>
      )}
      {result === undefined ? (
        <p role="status">Loading citations...</p>
      ) : (
        <>
          {result.status !== 'AVAILABLE' && <p className="admin-error">{result.status}</p>}
          {!result.page.length && result.status === 'AVAILABLE' && (
            <p className="admin-muted">No cited memory IDs were recorded.</p>
          )}
          <ul className="admin-list">
            {result.page.map((source) => (
              <li key={source.memoryId}>
                <div>
                  <code>{source.memoryId}</code>
                  {!source.memory ? (
                    <p className="admin-error">Source: {source.status}</p>
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
  const [open, setOpen] = useState(false);
  return (
    <details className="admin-disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Evidence &amp; original messages</summary>
      {open && <Evidence owner={owner} memory={memory} />}
    </details>
  );
}

function ResidentHistory({ owner }: { owner: Owner }) {
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
      <h3>Relationships from this resident's perspective</h3>
      <p className="admin-muted">
        Edges preserve recorded encounters and citations. No affinity or trust score is inferred.
      </p>
      {relationships === undefined ? (
        <p role="status">Loading relationships...</p>
      ) : (
        <>
          {!relationships.page.length && (
            <EmptyState>No relationship edges on this page.</EmptyState>
          )}
          <ul className="admin-list">
            {relationships.page.map((memory) => (
              <li key={memory.memoryId}>
                <div>
                  {memory.data.type === 'relationship' && (
                    <>
                      <strong>
                        {memory.data.agentGlobalId ?? `Local presence ${memory.data.playerId}`}
                      </strong>
                      <p className="admin-muted">
                        Home: {memory.data.homeTownId ?? 'Not recorded'} · recorded encounters:{' '}
                        {memory.data.encounterCount ?? 'Not recorded'}
                      </p>
                      <p className="admin-muted">
                        First: {formatTime(memory.data.firstMetAt)} · latest:{' '}
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
      <h3>Canonical memory history</h3>
      <p className="admin-muted">
        Records with verified world ownership appear here. Legacy records without a world ID need
        ownership repair before inspection.
      </p>
      <div className="admin-form">
        <Field
          label="Find retained text"
          hint="Search scans each page of world-scoped retained history; continue through older pages for earlier matches."
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
          label="Participant global ID"
          hint="Use the exact global ID to distinguish residents who share a name."
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
        <Field label="Memory type">
          <select
            value={kind}
            onChange={(event) => {
              setCursor(null);
              setKind(event.target.value as typeof kind);
            }}
          >
            <option value="">All types</option>
            {['relationship', 'conversation', 'travel', 'reflection'].map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </Field>
      </div>
      {history === undefined ? (
        <p role="status">Loading retained history...</p>
      ) : (
        <>
          {!history.page.length && (
            <EmptyState>
              No matches among the {history.scanned} records scanned on this page.
              {!history.isDone && ' Older records remain.'}
            </EmptyState>
          )}
          <ul className="admin-list">
            {history.page.map((memory) => (
              <li key={memory.memoryId}>
                <div>
                  <strong>{memory.data.type}</strong>
                  <p>{memory.description}</p>
                  <p className="admin-muted">
                    Recorded {formatTime(memory.recordedAt)}
                    {memory.data.type === 'travel' &&
                      ` · occurred ${formatTime(memory.data.occurredAt)} · at ${memory.data.hostTownId}`}
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
  const [selected, setSelected] = useState('');
  const residents = useQuery(api.federation.runtime.listResidents, { adminToken });
  const residentKey = (r: { worldId: Id<'worlds'>; playerId: string }) =>
    `${r.worldId}/${r.playerId}`;
  const resident = residents?.find((r) => residentKey(r) === selected) ?? residents?.[0];
  return (
    <section className="admin-panel" aria-label="Relationships and retained history">
      <h2>Relationships &amp; retained history</h2>
      <p className="admin-muted">
        Private Home records for the selected resident. Identity, evidence and original messages
        stay linked across visits.
      </p>
      {residents === undefined ? (
        <p role="status">Loading residents...</p>
      ) : !resident ? (
        <EmptyState>Register resident identities to inspect their retained history.</EmptyState>
      ) : (
        <>
          <Field label="Resident">
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
            World {resident.worldId} · presence {resident.playerId}
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
