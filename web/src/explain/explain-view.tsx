import { useEffect, useState, type ReactNode } from 'react';
import { call } from '../bridge';
import { copyFailed, copyText } from '../results/copy';
import { NoticeLine, type Notice } from '../results/result-grid';
import { errorText } from '../shell/errors';
import { editorPosition } from '../tabs/tab-store';
import type { ExplainResult, ExplainTable, ParameterValue } from '../wire';

/** Graph KQL tabs always read beta (spec 6.11); Explain's URLs are relative to it. */
const GRAPH_BASE = 'https://graph.microsoft.com/beta/';

/** What to explain: the text Run would send, its parameters, and where that text begins in the editor. */
export interface ExplainRequest {
  kql: string;
  parameters: ParameterValue[];
  origin: { line: number; column: number };
}

const count = (n: number) => n.toLocaleString('en-US');

type Answer = { state: 'loading' } | { state: 'done'; result: ExplainResult } | { state: 'failed'; message: string };

/**
 * Explain (spec 6.8, mockup Explain): what a Graph query would ask Graph for, without sending anything. Per table, the URL
 * (copyable), the `$select` and `$filter`, the conditions sent to Graph and those run locally with why, the columns read one
 * object at a time, the permissions with the table's docs, and the limits. Or the query's error, at its place in the editor, or
 * the refusal.
 */
export function ExplainView({ request, onOpenRaw }: { request: ExplainRequest; onOpenRaw?: (url: string) => void }) {
  // The request is compared by what it holds, so a new object with the same query doesn't explain again.
  const sent = JSON.stringify({ source: 'graph', kql: request.kql, parameters: request.parameters });
  // The answer to the request `for`; until the current request's arrives, Explain is loading.
  const [answered, setAnswered] = useState<{ for: string; answer: Answer } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const answer: Answer = answered?.for === sent ? answered.answer : { state: 'loading' };

  useEffect(() => {
    let current = true;
    const settle = (a: Answer) => current && setAnswered({ for: sent, answer: a });
    call<ExplainResult>('query.explain', JSON.parse(sent) as unknown).then(
      (result) => settle({ state: 'done', result }),
      (e: unknown) => settle({ state: 'failed', message: `The query couldn’t be explained: ${errorText(e)}` }),
    );
    return () => {
      current = false;
    };
  }, [sent]);

  const copy = (text: string, what: string) =>
    copyText(text).then(
      () => setNotice({ tone: 'ok', text: `Copied ${what}.` }),
      (e: unknown) => setNotice({ tone: 'bad', text: copyFailed(e) }),
    );

  if (answer.state === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="faint text-[12px]">Explaining…</span>
      </div>
    );
  }
  if (answer.state === 'failed') {
    return <Problem>{answer.message}</Problem>;
  }

  const { result } = answer;
  let problem: string | null = null;
  if (result.error) {
    // A parameter that is missing or doesn't fit has no position (line 0).
    const at = result.error.line > 0 ? editorPosition(request.origin, result.error) : null;
    problem = at ? `Line ${at.line}, column ${at.column}: ${result.error.message}` : result.error.message;
  } else if (result.refusal) {
    problem = result.refusal;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {problem !== null ? (
          <Problem>{problem}</Problem>
        ) : result.tables.length === 0 ? (
          <span className="muted">The query reads no Graph tables: it runs on the local engine alone, and nothing is sent to Graph.</span>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(420px,1fr))] gap-4">
            {result.tables.map((table, i) => (
              <TablePlan key={`${table.table}-${i}`} table={table} onCopy={copy} onOpenRaw={onOpenRaw} />
            ))}
          </div>
        )}
      </div>
      <footer className="border-t border-line px-4 py-2 text-[12px] text-muted">
        Limits: {count(result.limits.objectsPerTable)} objects per table · {count(result.limits.fetchBudgetMb)} MB fetch budget ·{' '}
        {count(result.limits.perObjectReadsPerTable)} per-object reads per table
      </footer>
      {notice && <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />}
    </div>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <div className="m-4 rounded-lg bg-bad-soft px-3 py-2 text-[12.5px] text-bad" role="alert">
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="text-[12px] font-semibold text-muted">{label}</span>
      {children}
    </div>
  );
}

function None({ children }: { children: ReactNode }) {
  return <span className="faint text-[12px]">{children}</span>;
}

interface TablePlanProps {
  table: ExplainTable;
  onCopy: (text: string, what: string) => void;
  onOpenRaw?: (url: string) => void;
}

function TablePlan({ table, onCopy, onOpenRaw }: TablePlanProps) {
  return (
    <section className="card flex min-w-0 flex-col gap-3 p-4" aria-label={table.table}>
      <b className="text-[14px]">
        <span className="mono">{table.table}</span> <span className="muted font-normal">· what the query will ask Graph for</span>
      </b>
      <Field label="Request">
        <span className="codeblock whitespace-pre-wrap break-all">{`GET /beta/${table.url}`}</span>
        <div className="flex gap-2">
          <button type="button" className="btn" onClick={() => onCopy(GRAPH_BASE + table.url, 'the URL')}>
            Copy the URL
          </button>
          {onOpenRaw && (
            <button type="button" className="btn" onClick={() => onOpenRaw(table.url)}>
              Open in a raw request tab
            </button>
          )}
        </div>
      </Field>
      <Field label={`Columns ($select) · ${table.select.length}`}>
        <ul aria-label="$select" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {table.select.map((column) => (
            <li key={column} className="chip mono">
              {column}
            </li>
          ))}
        </ul>
      </Field>
      <Field label="$filter">{table.filter ? <span className="codeblock whitespace-pre-wrap">{table.filter}</span> : <None>None: every object is read.</None>}</Field>
      <Field label="Sent to Graph">
        {table.pushed.length > 0 ? (
          <ul aria-label="Sent to Graph" className="m-0 flex list-none flex-col gap-1 p-0">
            {table.pushed.map((condition) => (
              <li key={condition} className="mono text-[12px]">
                {condition}
              </li>
            ))}
          </ul>
        ) : (
          <None>No condition: Graph returns every object.</None>
        )}
      </Field>
      <Field label="Runs locally">
        {table.local.length > 0 ? (
          <ul aria-label="Runs locally" className="m-0 flex list-none flex-col gap-2 p-0">
            {table.local.map((l) => (
              <li key={l.condition} className="flex flex-col gap-0.5">
                <span className="mono text-[12px]">{l.condition}</span>
                <span className="muted text-[12px]">{l.reason}</span>
              </li>
            ))}
          </ul>
        ) : (
          <None>Nothing: every condition is sent to Graph.</None>
        )}
      </Field>
      <Field label="Read one object at a time">
        {table.perObject.length > 0 ? (
          <ul aria-label="Read one object at a time" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {table.perObject.map((column) => (
              <li key={column} className="flex items-center gap-1.5">
                <span className="mono">{column}</span> <span className="tag warn">per object</span>
              </li>
            ))}
          </ul>
        ) : (
          <None>None.</None>
        )}
      </Field>
      <Field label="Permissions this uses">
        <span className="mono text-[12px]">{table.permissions.join(', ')}</span>
        <span className="flex items-center gap-2 text-[12px]">
          <span className="muted">Graph docs:</span>
          <span className="mono min-w-0 break-all select-text">{table.docsUrl}</span>
          <button type="button" className="btn ghost" onClick={() => onCopy(table.docsUrl, 'the docs link')}>
            Copy
          </button>
        </span>
      </Field>
    </section>
  );
}
