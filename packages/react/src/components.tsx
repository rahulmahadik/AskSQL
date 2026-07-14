/**
 * AskSQL React components. Presentational only - all state comes from
 * useAskSql. Every async state renders a spinner/skeleton; every list has
 * empty + error states; light/dark via CSS variables.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { ResultSet } from '@asksql/core';
import { formatCell, toCsv } from './format.js';
import { ensureStyles } from './styles.js';
import { useAskSql, type Turn } from './useAskSql.js';
import { ResultChart, isChartable } from './ResultChart.js';
import { useSavedQueries } from './saved.js';
import type { ConnectionSummary, Transport } from './client.js';

export interface AskSqlChatProps {
  readonly transport: Transport;
  readonly connectionId?: string;
  readonly theme?: 'light' | 'dark' | 'auto';
  /** Gate every query behind a Run button. Off by default (results auto-run). */
  readonly requireApproval?: boolean;
  readonly placeholder?: string;
  readonly suggestions?: readonly string[];
  /** CSP nonce for the injected stylesheet (strict-CSP pages). */
  readonly nonce?: string;
  /** Show a connection picker when the sidecar exposes more than one. */
  readonly showConnectionPicker?: boolean;
}

export function AskSqlChat(props: AskSqlChatProps): JSX.Element {
  useEffect(() => ensureStyles(undefined, props.nonce), [props.nonce]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [activeConn, setActiveConn] = useState<string | undefined>(props.connectionId);

  useEffect(() => {
      if (props.showConnectionPicker === false) return;
      let alive = true;
      props.transport
      .listConnections()
      .then((c) => {
          if (!alive) return;
          setConnections(c);
          if (!props.connectionId && c.length > 0) setActiveConn(c[0]!.id);
  })
.catch(() => {
    /* picker just stays hidden if listing fails */
  });
return () => {
  alive = false;
  };
  }, [props.transport, props.connectionId, props.showConnectionPicker]);

const { turns, busy, ask, run, editSql, planFor, cancel } = useAskSql({
    transport: props.transport,
    connectionId: activeConn ?? props.connectionId,
    requireApproval: props.requireApproval,
  });
const { save } = useSavedQueries();
  const [text, setText] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);
  const showPicker = (props.showConnectionPicker ?? true) && connections.length > 1;

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [turns]);

  const submit = () => {
    const q = text.trim();
    if (!q || busy) return;
    setText('');
    void ask(q);
  };

  const themeAttr = props.theme && props.theme !== 'auto' ? props.theme : undefined;

  return (
    <div className="asksql-root asksql-chat" {...(themeAttr ? { 'data-asksql-theme': themeAttr } : {})}>
    {showPicker && (
        <div className="asksql-picker">
        <label>
        Database{' '}
        <select value={activeConn} onChange={(e) => setActiveConn(e.target.value)} aria-label="Choose database connection">
        {connections.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.engine})</option>
    ))}
</select>
</label>
</div>
  )}
      <div className="asksql-thread" ref={threadRef}>
        {turns.length === 0 ? (
          <EmptyState suggestions={props.suggestions} onPick={(s) => { setText(''); void ask(s); }} />
        ) : (
        turns.map((t) => (
            <TurnView
            key={t.id}
            turn={t}
            onRun={() => void run(t.id)}
            onEdit={(sql) => editSql(t.id, sql)}
            onPlan={() => void planFor(t.id)}
            onSave={() => t.sql && save({ name: t.question.slice(0, 60), question: t.question, sql: t.sql, connectionId: activeConn })}
            busy={busy}
            requireApproval={props.requireApproval}
            />
        ))
        )}
      </div>
      <div className="asksql-input">
        <textarea
          value={text}
          placeholder={props.placeholder ?? 'Ask a question about your data...'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Ask a question about your data"
          disabled={busy}
        />
        {busy ? (
          <button className="asksql-btn" onClick={cancel} aria-label="Cancel">Stop</button>
        ) : (
          <button className="asksql-btn asksql-btn-primary" onClick={submit} disabled={!text.trim()} aria-label="Send">Ask</button>
        )}
      </div>
    </div>
  );
}

function EmptyState({ suggestions, onPick }: { suggestions?: readonly string[]; onPick: (s: string) => void }): JSX.Element {
  return (
    <div className="asksql-empty">
      <h3>Ask your database anything</h3>
      <p>Type a question in plain language. You'll see the SQL before it runs.</p>
      {suggestions && suggestions.length > 0 && (
        <div className="asksql-actions" style={{ justifyContent: 'center', marginTop: 12 }}>
          {suggestions.map((s) => (
            <button key={s} className="asksql-btn" onClick={() => onPick(s)}>{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function TurnView({ turn, onRun, onEdit, onPlan, onSave, busy, requireApproval }: { turn: Turn; onRun: () => void; onEdit: (sql: string) => void; onPlan: () => void; onSave: () => void; busy: boolean; requireApproval?: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <div className="asksql-turn">
      <div className="asksql-q">{turn.question}</div>
      <div className="asksql-a">
        {turn.phase === 'thinking' && (
          <div className="asksql-stage"><span className="asksql-spinner" />{stageLabel(turn.stage)}</div>
        )}
        {turn.sql && (
          <>
          {editing ? (
              <div className="asksql-sqlblock">
              <div className="asksql-sqlhead"><span>Edit SQL</span></div>
              <textarea
              className="asksql-sqledit"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              aria-label="Edit SQL"
              />
              <div className="asksql-actions" style={{ padding: 8 }}>
              <button className="asksql-btn asksql-btn-primary" onClick={() => { onEdit(draft); setEditing(false); }}>Save</button>
              <button className="asksql-btn" onClick={() => setEditing(false)}>Cancel</button>
              </div>
              </div>
          ) : (
            <SqlBlock sql={turn.sql} />
        )}
    {turn.explanation && !editing && <div className="asksql-explain">{turn.explanation}</div>}
            {turn.autoLimited && <div className="asksql-warn">A row limit was added automatically - export to get everything.</div>}
            {!editing && (turn.phase === 'sql_ready' || turn.phase === 'done' || turn.phase === 'error') && (
              <div className="asksql-actions">
                {turn.phase === 'sql_ready' && requireApproval && (
                  <button className="asksql-btn asksql-btn-primary" onClick={onRun} disabled={busy}>Run query</button>
                )}
                <button className="asksql-btn" onClick={() => { setDraft(turn.sql!); setEditing(true); }} disabled={busy}>Edit</button>
                <button className="asksql-btn" onClick={onPlan} disabled={busy || turn.planning}>{turn.planning ? 'Explaining...' : 'Plan'}</button>
                <button className="asksql-btn" onClick={() => { onSave(); setSaved(true); setTimeout(() => setSaved(false), 1200); }}>{saved ? 'Saved' : 'Save'}</button>
                </div>
        )}
    {turn.plan && (
        <div className="asksql-sqlblock">
        <div className="asksql-sqlhead"><span>Query plan</span></div>
        <pre className="asksql-sqlcode">{turn.plan}</pre>
              </div>
            )}
            {turn.phase === 'running' && (
              <div className="asksql-stage"><span className="asksql-spinner" />Running...</div>
            )}
          </>
        )}
        {turn.result && <ResultTable result={turn.result} />}
        {turn.error && (
          <div className="asksql-error" role="alert">
            {turn.error.userMessage}
            {turn.error.retryable && <> <button className="asksql-btn" style={{ marginLeft: 8 }} onClick={onRun} disabled={busy}>Retry</button></>}
            {turn.suggestedSql && (
              <div style={{ marginTop: 8 }}>
                <div className="asksql-meta" style={{ marginBottom: 4 }}>A corrected query is suggested:</div>
                <SqlBlock sql={turn.suggestedSql} />
                <button className="asksql-btn asksql-btn-primary" style={{ marginTop: 6 }} disabled={busy} onClick={() => onEdit(turn.suggestedSql!)}>Apply suggested fix</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function stageLabel(stage?: string): string {
  switch (stage) {
    case 'catalog': return 'Reading schema...';
    case 'prune': return 'Finding relevant tables...';
    case 'llm': return 'Writing SQL...';
    case 'repair': return 'Refining SQL...';
    case 'guard': return 'Checking safety...';
    case 'done': return 'Ready';
    default: return 'Thinking...';
  }
}

export function SqlBlock({ sql }: { sql: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="asksql-sqlblock">
      <div className="asksql-sqlhead">
        <span>SQL</span>
        <button
          className="asksql-btn"
          style={{ padding: '2px 8px', fontSize: 12 }}
          onClick={() => {
            void navigator.clipboard?.writeText(sql);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="asksql-sqlcode"><code>{sql}</code></pre>
    </div>
  );
}

export function ResultTable({ result }: { result: ResultSet }): JSX.Element {
  const csv = useMemo(() => toCsv(result.columns, result.rows), [result]);
  const chartable = useMemo(() => isChartable(result), [result]);
  const [view, setView] = useState<'table' | 'chart'>('table');
  const download = () => {
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'asksql-results.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (result.rowCount === 0) {
    return <div className="asksql-meta">No rows matched.</div>;
  }

  return (
    <div>
    {view === 'chart' && chartable ? (
        <ResultChart result={result} />
    ) : (
      <div className="asksql-tablewrap">
        <table className="asksql-table">
          <thead>
            <tr>
              {result.columns.map((c, i) => (
                <th key={`${c.name}-${i}`}>{c.name}<small>{c.kind}</small></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => {
                  const d = formatCell(cell, result.columns[ci]);
                  return <td key={ci} className={`asksql-cell-${d.kind}`} title={d.title}>{d.text}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
  )}
      <div className="asksql-meta">
        <span>{result.rowCount} row{result.rowCount === 1 ? '' : 's'}{result.truncated ? ' (truncated)' : ''}</span>
        <span>{result.durationMs} ms</span>
        {chartable && (
            <button className="asksql-btn" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setView((v) => (v === 'table' ? 'chart' : 'table'))}>
            {view === 'table' ? 'Chart' : 'Table'}
            </button>
  )}
        <button className="asksql-btn" style={{ padding: '2px 8px', fontSize: 12 }} onClick={download}>Export CSV</button>
        {result.warnings.map((w, i) => <span key={i} className="asksql-warn">{w}</span>)}
      </div>
    </div>
  );
}

export type BubblePosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface AskSqlBubbleProps extends AskSqlChatProps {
  readonly title?: string;
  readonly icon?: string;
  /** Which corner the bubble sits in. Default 'bottom-right'. */
  readonly position?: BubblePosition;
  /** Distance (px) from the chosen corner's edges. Default 24. */
  readonly offset?: number | { readonly x?: number; readonly y?: number };
  /** Stacking order, to sit above/below the host's own fixed elements. Default very high. */
  readonly zIndex?: number;
}

let bubbleMounted = false;

/** Compute corner-anchored inline styles for the button and the panel. */
function bubblePlacement(position: BubblePosition, offset: AskSqlBubbleProps['offset'], zIndex: number, buttonPx: number) {
  const x = typeof offset === 'number' ? offset : offset?.x ?? 24;
  const y = typeof offset === 'number' ? offset : offset?.y ?? 24;
  const [vert, horiz] = position.split('-') as ['top' | 'bottom', 'left' | 'right'];
  const btn: Record<string, string | number> = { position: 'fixed', zIndex, [vert]: y, [horiz]: x };
  // Panel opens from the same corner, offset past the button.
  const panel: Record<string, string | number> = { position: 'fixed', zIndex, [vert]: y + buttonPx + 12, [horiz]: x };
  return { btn, panel };
}

export function AskSqlBubble(props: AskSqlBubbleProps): JSX.Element | null {
  useEffect(() => ensureStyles(undefined, props.nonce), [props.nonce]);
  const [open, setOpen] = useState(false);
  const [duplicate, setDuplicate] = useState(false);

  useEffect(() => {
      // Single-instance guard.
    if (bubbleMounted) {
      setDuplicate(true);
      if (typeof console !== 'undefined') console.warn('[asksql] Multiple <AskSqlBubble/> mounted; only the first renders.');
      return;
    }
    bubbleMounted = true;
    return () => {
      bubbleMounted = false;
    };
  }, []);

  if (duplicate) return null;

  const themeAttr = props.theme && props.theme !== 'auto' ? props.theme : undefined;
  const { btn, panel } = bubblePlacement(props.position ?? 'bottom-right', props.offset, props.zIndex ?? 2147483000, 56);

  return (
    <div className="asksql-root" {...(themeAttr ? { 'data-asksql-theme': themeAttr } : {})}>
      {!open && (
          <button className="asksql-bubble-btn" style={btn} onClick={() => setOpen(true)} aria-label="Open database chat">
          {props.icon ?? '💬'}
        </button>
      )}
      {open && (
          <div className="asksql-bubble-panel" style={panel} role="dialog" aria-label={props.title ?? 'Database chat'}>
          <div className="asksql-bubble-head">
            <span>{props.title ?? 'Ask your database'}</span>
            <button onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <AskSqlChat {...props} />
          </div>
        </div>
      )}
    </div>
  );
}
