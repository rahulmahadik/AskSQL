/**
 * AskSQL React components. Presentational only - all state comes from
 * useAskSql. Every async state renders a spinner/skeleton; every list has
 * empty + error states; light/dark via CSS variables.
 */

import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ResultSet } from '@asksql/core';
import { formatCell, toCsv } from './format.js';
import { ensureStyles } from './styles.js';
import { useAskSql, type Turn } from './useAskSql.js';
import { ResultChart, isChartable } from './ResultChart.js';
import { useSavedQueries } from './saved.js';
import type { ConnectionSummary, Transport } from './client.js';

/** Split one line into **bold** / `code` / plain runs. Text-only, no dangerouslySetInnerHTML. */
function inlineMarkdown(line: string): JSX.Element[] {
  const re = /\*\*(.+?)\*\*|(?<!\w)__(.+?)__(?!\w)|`([^`]+)`/gsu;
  const out: JSX.Element[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push(<span key={key++}>{line.slice(last, m.index)}</span>);
    if (m[3] !== undefined) out.push(<code key={key++}>{m[3]}</code>);
    else out.push(<strong key={key++}>{m[1] ?? m[2]}</strong>);
    last = re.lastIndex;
  }
  if (last < line.length) out.push(<span key={key++}>{line.slice(last)}</span>);
  return out;
}

/** Render explanation markdown: drop a redundant leading "Explanation:", bullets for "- "/"* " lines, ```fenced``` blocks as code. */
function Markdown({ text, className }: { text: string; className?: string }): JSX.Element {
  const body = text.replace(/^\s*(\*\*|__)?\s*Explanation\s*(\*\*|__)?\s*:\s*/iu, '');
  const lines = body.split('\n');
  const blocks: JSX.Element[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    // Fenced code block (```sql ... ```): render as a code block, not literal backticks.
    if (/^\s*```/u.test(lines[i]!)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/u.test(lines[i]!)) code.push(lines[i++]!);
      i++; // skip the closing fence
      blocks.push(
        <pre key={key++} className="asksql-sqlcode">
          {code.join('\n')}
        </pre>,
      );
      continue;
    }
    const line = lines[i++]!;
    const bullet = /^\s*[-*]\s+/u.test(line);
    blocks.push(
      <div key={key++} className={bullet ? 'asksql-md-bullet' : undefined}>
        {inlineMarkdown(bullet ? line.replace(/^\s*[-*]\s+/u, '') : line)}
      </div>,
    );
  }
  return <div className={className}>{blocks}</div>;
}

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
  /** Answer questions that aren't a data query in plain language from the schema. Off by default. */
  readonly answerSchemaQuestions?: boolean;
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
    answerSchemaQuestions: props.answerSchemaQuestions,
  });
  const { save } = useSavedQueries();
  const [text, setText] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);
  const showPicker = (props.showConnectionPicker ?? true) && connections.length > 1;
  // Gate EXPLAIN on the active connection's capability; unknown (no report) -> allow.
  const activeCaps = connections.find((c) => c.id === (activeConn ?? props.connectionId))?.capabilities;
  const canPlan = activeCaps?.supportsExplain ?? true;

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
            <select
              value={activeConn}
              onChange={(e) => setActiveConn(e.target.value)}
              aria-label="Choose database connection"
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({[c.engine, c.database].filter(Boolean).join(' · ')})
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="asksql-thread" ref={threadRef}>
        {turns.length === 0 ? (
          <EmptyState
            suggestions={props.suggestions}
            onPick={(s) => {
              setText('');
              void ask(s);
            }}
          />
        ) : (
          turns.map((t) => (
            <TurnView
              key={t.id}
              turn={t}
              onRun={() => void run(t.id)}
              onRetry={() => (t.sql ? void run(t.id) : void ask(t.question))}
              onEdit={(sql) => editSql(t.id, sql)}
              onPlan={() => void planFor(t.id)}
              onSave={() =>
                t.sql &&
                save({ name: t.question.slice(0, 60), question: t.question, sql: t.sql, connectionId: activeConn })
              }
              busy={busy}
              canPlan={canPlan}
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
        />
        {busy ? (
          <button className="asksql-btn" onClick={cancel} aria-label="Cancel">
            Stop
          </button>
        ) : (
          <button className="asksql-btn asksql-btn-primary" onClick={submit} disabled={!text.trim()} aria-label="Send">
            Ask
          </button>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  suggestions,
  onPick,
}: {
  suggestions?: readonly string[];
  onPick: (s: string) => void;
}): JSX.Element {
  return (
    <div className="asksql-empty">
      <h3>Ask your database anything</h3>
      <p>Type a question in plain language. You'll see the SQL before it runs.</p>
      {suggestions && suggestions.length > 0 && (
        <div className="asksql-actions" style={{ justifyContent: 'center', marginTop: 12 }}>
          {suggestions.map((s) => (
            <button key={s} className="asksql-btn" onClick={() => onPick(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TurnView({
  turn,
  onRun,
  onRetry,
  onEdit,
  onPlan,
  onSave,
  busy,
  canPlan,
  requireApproval,
}: {
  turn: Turn;
  onRun: () => void;
  onRetry: () => void;
  onEdit: (sql: string) => void;
  onPlan: () => void;
  onSave: () => void;
  busy: boolean;
  canPlan: boolean;
  requireApproval?: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <div className="asksql-turn">
      <div className="asksql-role">You</div>
      <div className="asksql-q">{turn.question}</div>
      <div className="asksql-role asksql-role-assistant">AskSQL</div>
      <div className="asksql-a">
        {turn.phase === 'thinking' && (
          <div className="asksql-stage">
            <span className="asksql-spinner" />
            {stageLabel(turn.stage)}
          </div>
        )}
        {turn.sql && (
          <>
            {editing ? (
              <div className="asksql-sqlblock">
                <div className="asksql-sqlhead">
                  <span>Edit SQL</span>
                </div>
                <textarea
                  className="asksql-sqledit"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  aria-label="Edit SQL"
                />
                <div className="asksql-actions" style={{ padding: 8 }}>
                  <button
                    className="asksql-btn asksql-btn-primary"
                    onClick={() => {
                      onEdit(draft);
                      setEditing(false);
                    }}
                  >
                    Save
                  </button>
                  <button className="asksql-btn" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <SqlBlock sql={turn.sql} />
            )}
            {turn.explanation && !editing && <Markdown className="asksql-explain" text={turn.explanation} />}
            {turn.autoLimited && (
              <div className="asksql-warn">A row limit was added automatically - export to get everything.</div>
            )}
            {!editing &&
              (turn.phase === 'sql_ready' ||
                turn.phase === 'done' ||
                turn.phase === 'error' ||
                turn.phase === 'stopped') && (
              <div className="asksql-actions">
                {turn.phase === 'sql_ready' && requireApproval && (
                  <button className="asksql-btn asksql-btn-primary" onClick={onRun} disabled={busy}>
                    Run query
                  </button>
                )}
                <button
                  className="asksql-btn"
                  onClick={() => {
                    setDraft(turn.sql!);
                    setEditing(true);
                  }}
                  disabled={busy}
                >
                  Edit
                </button>
                {canPlan && (
                  <button className="asksql-btn" onClick={onPlan} disabled={busy || turn.planning}>
                    {turn.planning ? 'Explaining...' : 'Plan'}
                  </button>
                )}
                <button
                  className="asksql-btn"
                  onClick={() => {
                    onSave();
                    setSaved(true);
                    setTimeout(() => setSaved(false), 1200);
                  }}
                >
                  {saved ? 'Saved' : 'Save'}
                </button>
              </div>
            )}
            {turn.plan && (
              <div className="asksql-sqlblock">
                <div className="asksql-sqlhead">
                  <span>Query plan</span>
                </div>
                <pre className="asksql-sqlcode">{turn.plan}</pre>
              </div>
            )}
            {turn.phase === 'running' && (
              <div className="asksql-stage">
                <span className="asksql-spinner" />
                Running...
              </div>
            )}
          </>
        )}
        {turn.result && <ResultTable result={turn.result} />}
        {turn.schemaAnswer && (
          <>
            <Markdown className="asksql-explain" text={turn.schemaAnswer.answer} />
            {turn.schemaAnswer.unknownReferences.length > 0 && (
              <div className="asksql-warn">
                {turn.schemaAnswer.isSchemaChange
                  ? `Proposed names not in your current schema: ${turn.schemaAnswer.unknownReferences.join(', ')}. AskSQL is read-only and ran nothing.`
                  : `Heads up: this mentioned names not in your schema (${turn.schemaAnswer.unknownReferences.join(', ')}), so treat those with caution.`}
              </div>
            )}
            <div className="asksql-note">
              Generated from your schema by the model - no query was run, so treat it as guidance.
            </div>
          </>
        )}
        {turn.error && (
          <div className="asksql-error" role="alert">
            {turn.error.userMessage}
            {turn.error.retryable && (
              <>
                {' '}
                <button className="asksql-btn" style={{ marginLeft: 8 }} onClick={onRetry} disabled={busy}>
                  Retry
                </button>
              </>
            )}
            {turn.suggestedSql && (
              <div style={{ marginTop: 8 }}>
                <div className="asksql-meta" style={{ marginBottom: 4 }}>
                  A corrected query is suggested:
                </div>
                <SqlBlock sql={turn.suggestedSql} />
                <button
                  className="asksql-btn asksql-btn-primary"
                  style={{ marginTop: 6 }}
                  disabled={busy}
                  onClick={() => onEdit(turn.suggestedSql!)}
                >
                  Apply suggested fix
                </button>
              </div>
            )}
          </div>
        )}
        {turn.phase === 'stopped' && <div className="asksql-note">Stopped.</div>}
      </div>
    </div>
  );
}

function stageLabel(stage?: string): string {
  switch (stage) {
    case 'catalog':
      return 'Reading schema...';
    case 'prune':
      return 'Finding relevant tables...';
    case 'llm':
      return 'Writing SQL...';
    case 'repair':
      return 'Refining SQL...';
    case 'guard':
      return 'Checking safety...';
    case 'done':
      return 'Ready';
    default:
      return 'Thinking...';
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
      <pre className="asksql-sqlcode">
        <code>{sql}</code>
      </pre>
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
                  <th key={`${c.name}-${i}`}>
                    {c.name}
                    <small>{c.kind}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => {
                    const d = formatCell(cell, result.columns[ci]);
                    return (
                      <td key={ci} className={`asksql-cell-${d.kind}`} title={d.title}>
                        {d.text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="asksql-meta">
        <span>
          {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
          {result.truncated ? ' (truncated)' : ''}
        </span>
        <span>{result.durationMs} ms</span>
        {chartable && (
          <button
            className="asksql-btn"
            style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={() => setView((v) => (v === 'table' ? 'chart' : 'table'))}
          >
            {view === 'table' ? 'Chart' : 'Table'}
          </button>
        )}
        <button className="asksql-btn" style={{ padding: '2px 8px', fontSize: 12 }} onClick={download}>
          Export CSV
        </button>
        {result.warnings.map((w, i) => (
          <span key={i} className="asksql-warn">
            {w}
          </span>
        ))}
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
function bubblePlacement(
  position: BubblePosition,
  offset: AskSqlBubbleProps['offset'],
  zIndex: number,
  buttonPx: number,
) {
  const x = typeof offset === 'number' ? offset : (offset?.x ?? 24);
  const y = typeof offset === 'number' ? offset : (offset?.y ?? 24);
  const [vert, horiz] = position.split('-') as ['top' | 'bottom', 'left' | 'right'];
  const btn: Record<string, string | number> = { position: 'fixed', zIndex, [vert]: y, [horiz]: x };
  // Panel opens from the same corner, offset past the button.
  const panel: Record<string, string | number> = { position: 'fixed', zIndex, [vert]: y + buttonPx + 12, [horiz]: x };
  return { btn, panel };
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function AskSqlBubble(props: AskSqlBubbleProps): JSX.Element | null {
  useEffect(() => ensureStyles(undefined, props.nonce), [props.nonce]);
  const [open, setOpen] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    // Single-instance guard.
    if (bubbleMounted) {
      setDuplicate(true);
      if (typeof console !== 'undefined')
        console.warn('[asksql] Multiple <AskSqlBubble/> mounted; only the first renders.');
      return;
    }
    bubbleMounted = true;
    return () => {
      bubbleMounted = false;
    };
  }, []);

  // Move focus into the dialog on open; restore it to the trigger on close.
  useEffect(() => {
    if (open) panelRef.current?.focus();
    else if (wasOpen.current) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // Trap Tab within the dialog and close on Escape.
  const onPanelKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.hasAttribute('disabled'),
    );
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (duplicate) return null;

  const themeAttr = props.theme && props.theme !== 'auto' ? props.theme : undefined;
  const { btn, panel } = bubblePlacement(
    props.position ?? 'bottom-right',
    props.offset,
    props.zIndex ?? 2147483000,
    56,
  );

  return (
    <div className="asksql-root" {...(themeAttr ? { 'data-asksql-theme': themeAttr } : {})}>
      {!open && (
        <button
          ref={triggerRef}
          className="asksql-bubble-btn"
          style={btn}
          onClick={() => setOpen(true)}
          aria-label="Open database chat"
        >
          {props.icon ?? '💬'}
        </button>
      )}
      {open && (
        <div
          ref={panelRef}
          className="asksql-bubble-panel"
          style={panel}
          role="dialog"
          aria-modal="true"
          aria-label={props.title ?? 'Database chat'}
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
        >
          <div className="asksql-bubble-head">
            <span>{props.title ?? 'Ask your database'}</span>
            <button onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <AskSqlChat {...props} />
          </div>
        </div>
      )}
    </div>
  );
}
