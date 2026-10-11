import { useState, type FormEvent } from 'react';
import { useQuery } from 'convex/react';
import { makeFunctionReference, type ApiFromModules } from 'convex/server';
import type * as travelAudit from '../../../convex/federation/travelAudit';
import { AdminButton, EmptyState, Field, formatTime } from './AdminShared';

const historyQuery: ApiFromModules<{ travelAudit: typeof travelAudit }>['travelAudit']['history'] = makeFunctionReference('federation/travelAudit:history');
type Filter = { visitId?: string; from?: number; to?: number; source: 'AUDIT' | 'DELIVERY' | 'RECEIPTS' | 'VISITS' | 'ACTIONS' };
export default function TravelAuditPanel({ adminToken }: { adminToken: string }) {
  const [filter, setFilter] = useState<Filter>({ source: 'AUDIT' });
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const result = useQuery(historyQuery, { adminToken, ...filter, cursor, numItems: 25 });
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const from = fields.get('from') ? new Date(String(fields.get('from'))).getTime() : undefined;
    const to = fields.get('to') ? new Date(String(fields.get('to'))).getTime() : undefined;
    if ((from !== undefined && (!Number.isSafeInteger(from) || from < 0)) || (to !== undefined && (!Number.isSafeInteger(to) || to < 0)) || (from ?? 0) > (to ?? Infinity)) {
      setError('Choose a valid time range with the end after the start.'); return;
    }
    setError(''); setCursor(null);
    setFilter({ visitId: String(fields.get('visitId')).trim() || undefined, from, to, source: String(fields.get('source')) as Filter['source'] });
  }
  return <details className="admin-disclosure">
    <summary>Travel audit history</summary>
    <p className="admin-muted">Browse saved reservations, arrivals, departures, delivery retries and action results. State transitions are recorded after this upgrade. Retained deliveries, receipts and visit records include older history; missing old transitions cannot be reconstructed.</p>
    <form className="admin-form" onSubmit={apply}>
      <Field label="Visit ID (optional)"><input name="visitId" maxLength={256} placeholder="All visits" /></Field>
      <Field label="From (local time)"><input name="from" type="datetime-local" /></Field>
      <Field label="Through (local time)"><input name="to" type="datetime-local" /></Field>
      <Field label="History source"><select name="source" defaultValue="AUDIT"><option value="AUDIT">State transitions</option><option value="DELIVERY">Retained outgoing deliveries</option><option value="RECEIPTS">Retained incoming receipts</option><option value="VISITS">Retained visits</option><option value="ACTIONS">Retained action results</option></select></Field>
      <AdminButton type="submit">Find records</AdminButton>
    </form>
    {error && <p className="admin-error" role="alert">{error}</p>}
    {result === undefined ? <p role="status">Loading travel history…</p> : <>
      {!result.page.length && <EmptyState>No saved records match this visit and time range.</EmptyState>}
      <ol className="admin-list">{result.page.map((entry: any) => <li key={entry._id}><div>
        <strong>{entry.source} · {entry.operation}</strong><p>{formatTime(entry.at)} · <code>{entry.visitId ?? 'No visit ID'}</code></p>
        {entry.previous?.state && <p>Previous: {entry.previous.state}</p>}
        <dl className="admin-summary">{Object.entries(entry.next ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
      </div></li>)}</ol>
      <div className="admin-toolbar"><AdminButton disabled={cursor === null} onClick={() => setCursor(null)}>Newest page</AdminButton><AdminButton disabled={result.isDone} onClick={() => setCursor(result.continueCursor)}>Older records</AdminButton></div>
      <p className="admin-muted">{result.isDone ? 'End of matching saved history.' : 'More saved records are available.'}</p>
    </>}
  </details>;
}
