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
/** The sentence the engine appends to a proposed write. */
const READ_ONLY_LINE_MARKER = 'AskSQL is read-only';

function Markdown({
  text,
  className,
  renderCode,
}: {
  text: string;
  className?: string;
  /** Renders a fenced block; returning null drops the fence. Defaults to a plain code <pre>. */
  renderCode?: (code: string) => JSX.Element | null;
}): JSX.Element {
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
      const fence = code.join('\n');
      const rendered = renderCode ? renderCode(fence) : <pre className="asksql-sqlcode">{fence}</pre>;
      // Wrapped so the key stays on this block whatever the renderer returns.
      if (rendered !== null) blocks.push(<div key={key}>{rendered}</div>);
      key++;
      continue;
    }
    const line = lines[i++]!;
    // An empty <div> collapses, so a blank line carries its own gap.
    if (line.trim() === '') {
      blocks.push(<div key={key++} className="asksql-md-blank" />);
      continue;
    }
    const bullet = /^\s*[-*]\s+/u.test(line);
    blocks.push(
      <div key={key++} className={bullet ? 'asksql-md-bullet' : undefined}>
        {inlineMarkdown(bullet ? line.replace(/^\s*[-*]\s+/u, '') : line)}
      </div>,
    );
  }
  return <div className={className}>{blocks}</div>;
}

/** Copies to the clipboard, acking only once the write resolved. A function `text` is built on click. */
function CopyButton({ text, className }: { text: string | (() => string); className?: string }): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const settle = (next: 'copied' | 'failed') => {
    setState(next);
    setTimeout(() => setState('idle'), 1200);
  };
  return (
    <button
      className={className ? `asksql-btn ${className}` : 'asksql-btn'}
      style={{ padding: '2px 8px', fontSize: 12 }}
      onClick={() => {
        // navigator.clipboard is absent in an insecure context, and writeText can reject.
        let write: Promise<void> | undefined;
        try {
          write = navigator.clipboard?.writeText(typeof text === 'function' ? text() : text);
        } catch {
          write = undefined;
        }
        if (!write) {
          settle('failed');
          return;
        }
        write.then(
          () => settle('copied'),
          () => settle('failed'),
        );
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
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
  /** Where to inject the stylesheet. Pass the shadow root when rendering into one; defaults to the document. */
  readonly styleRoot?: Document | ShadowRoot;
  /** Show a connection picker when the sidecar exposes more than one. */
  readonly showConnectionPicker?: boolean;
  /** Answer questions that aren't a data query in plain language from the schema. Off by default. */
  readonly answerSchemaQuestions?: boolean;
  /** Row cap sent with every query, so it applies to a sidecar as well as an in-page engine. */
  readonly maxRows?: number;
  /** Where the SQL block renders relative to results (default 'before'). Forced to 'before' when `requireApproval` is on - a query can't be approved unseen. */
  readonly sqlDisplayPlacement?: 'before' | 'after';
  /**
   * Asked automatically whenever this changes to a new non-empty value, such as
   * a question seeded by a browser extension's "ask about selection". The same
   * value twice in a row asks once; the transcript is preserved either way.
   */
  readonly initialQuestion?: string;
  /** Called when initialQuestion is actually asked, so the host can clear its state (enabling the same text to seed again later). */
  readonly onInitialQuestionConsumed?: () => void;
}

export function AskSqlChat(props: AskSqlChatProps): JSX.Element {
  useEffect(() => ensureStyles(props.styleRoot, props.nonce), [props.styleRoot, props.nonce]);
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

  const { turns, busy, ask, run, editSql, planFor, cancel, reset } = useAskSql({
    transport: props.transport,
    connectionId: activeConn ?? props.connectionId,
    requireApproval: props.requireApproval,
    answerSchemaQuestions: props.answerSchemaQuestions,
    maxRows: props.maxRows,
  });
  const [text, setText] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);
  const showPicker = (props.showConnectionPicker ?? true) && connections.length > 1;
  // Gate EXPLAIN on the active connection's capability; unknown (no report) -> allow.
  const activeCaps = connections.find((c) => c.id === (activeConn ?? props.connectionId))?.capabilities;
  const canPlan = activeCaps?.supportsExplain ?? true;

  // A turn is patched many times per question; only a new turn always follows.
  const lastTurnId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const newest = turns[turns.length - 1]?.id;
    const isNewTurn = newest !== lastTurnId.current;
    lastTurnId.current = newest;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (isNewTurn || nearBottom) el.scrollTo({ top: el.scrollHeight });
  }, [turns]);

  // A turn's SQL was written for the schema of the connection that produced it, and Run/Explain
  // send it to whichever connection is selected now. Switching databases discards the transcript.
  const boundConn = useRef<string | undefined>(activeConn ?? props.connectionId);
  useEffect(() => {
    const current = activeConn ?? props.connectionId;
    const previous = boundConn.current;
    boundConn.current = current;
    // Undefined until the picker resolves; only a switch between two real connections resets.
    if (previous !== undefined && current !== undefined && previous !== current) reset();
  }, [activeConn, props.connectionId, reset]);

  const lastAskedInitial = useRef<string | undefined>(undefined);
  useEffect(() => {
    const q = props.initialQuestion?.trim();
    if (!q) {
      // Host cleared it: forget the last value so the same text can seed again.
      lastAskedInitial.current = undefined;
      return;
    }
    if (q === lastAskedInitial.current) return;
    // Mid-stream: leave it unrecorded - the busy flip re-runs this effect when the stream ends.
    if (busy) return;
    lastAskedInitial.current = q;
    void ask(q);
    props.onInitialQuestionConsumed?.();
  }, [props.initialQuestion, busy]);

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
      <div className="asksql-thread" ref={threadRef} role="log" aria-live="polite" aria-busy={busy}>
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
              busy={busy}
              canPlan={canPlan}
              requireApproval={props.requireApproval}
              sqlDisplayPlacement={props.sqlDisplayPlacement}
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
            Cancel
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
  busy,
  canPlan,
  requireApproval,
  sqlDisplayPlacement,
}: {
  turn: Turn;
  onRun: () => void;
  onRetry: () => void;
  onEdit: (sql: string) => void;
  onPlan: () => void;
  busy: boolean;
  canPlan: boolean;
  requireApproval?: boolean;
  sqlDisplayPlacement?: 'before' | 'after';
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const placement = requireApproval ? 'before' : (sqlDisplayPlacement ?? 'before');

  // A correction replaces the rejected query; two statements under one question read as two answers.
  const sqlSection = turn.sql && !turn.suggestedSql && (
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
      {turn.explanation && !editing && (
        <div className="asksql-prose">
          <Markdown className="asksql-explain" text={turn.explanation} />
          <CopyButton className="asksql-prose-copy" text={turn.explanation} />
        </div>
      )}
      {turn.autoLimited && (
        <div className="asksql-warn">
          A row limit was applied automatically. Raise the row cap in settings if you need more; an export writes the
          rows shown here.
        </div>
      )}
      {!editing &&
        (turn.phase === 'sql_ready' || turn.phase === 'done' || turn.phase === 'error' || turn.phase === 'stopped') && (
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
          </div>
        )}
      {turn.plan && (
        <div className="asksql-sqlblock">
          <div className="asksql-sqlhead">
            <span>Query plan</span>
            <CopyButton text={turn.plan} />
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
  );

  const resultSection = turn.result && <ResultTable result={turn.result} />;

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
        {/* Never Markdown: mid-stream output has unbalanced fences and reasoning blocks. */}
        {turn.streamText && <pre className="asksql-stream">{turn.streamText}</pre>}
        {placement === 'after' ? (
          <>
            {resultSection}
            {sqlSection}
          </>
        ) : (
          <>
            {sqlSection}
            {resultSection}
          </>
        )}
        {turn.schemaAnswer && (
          <>
            <div className="asksql-prose">
              <Markdown
                className="asksql-explain"
                text={turn.schemaAnswer.answer}
                // The proposal is already rendered above as the turn's SqlBlock.
                renderCode={(code) =>
                  code.trim() === turn.schemaAnswer!.proposedSql?.trim() ? null : <SqlBlock sql={code} />
                }
              />
              <CopyButton className="asksql-prose-copy" text={turn.schemaAnswer.answer} />
            </div>
            {turn.schemaAnswer.unknownReferences.length > 0 && (
              <div className="asksql-warn">
                {turn.schemaAnswer.isSchemaChange
                  ? `Proposed names not in your current schema: ${turn.schemaAnswer.unknownReferences.join(', ')}.`
                  : `Heads up: this mentioned names not in your schema (${turn.schemaAnswer.unknownReferences.join(', ')}), so treat those with caution.`}
              </div>
            )}
            {!turn.schemaAnswer.answer.includes(READ_ONLY_LINE_MARKER) && (
              <div className="asksql-note">
                Generated from your schema by the model - no query was run, so treat it as guidance.
              </div>
            )}
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
                  Corrected to match your schema:
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
        {turn.phase === 'stopped' && <div className="asksql-note">Cancelled.</div>}
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
    case 'prompt':
      return 'Building the prompt...';
    case 'llm':
      return 'Writing SQL...';
    case 'extract':
      return 'Reading the reply...';
    case 'repair':
      return 'Correcting the SQL...';
    case 'guard':
      return 'Checking safety...';
    case 'execute':
      return 'Running the query...';
    case 'schema_answer':
      return 'Answering from your schema...';
    case 'done':
      return 'Done';
    default:
      return 'Thinking...';
  }
}

export function SqlBlock({ sql }: { sql: string }): JSX.Element {
  return (
    <div className="asksql-sqlblock">
      <div className="asksql-sqlhead">
        <span>SQL</span>
        <CopyButton text={sql} />
      </div>
      <pre className="asksql-sqlcode">
        <code>{sql}</code>
      </pre>
    </div>
  );
}

export function ResultTable({ result }: { result: ResultSet }): JSX.Element {
  const chartable = useMemo(() => isChartable(result), [result]);
  const [view, setView] = useState<'table' | 'chart'>('table');
  const [exportState, setExportState] = useState<'idle' | 'done' | 'failed'>('idle');
  const download = () => {
    try {
      // Built on click only: rendering the whole result set to CSV up front charges every
      // answer for an export most users never ask for.
      const blob = new Blob([toCsv(result.columns, result.rows)], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'asksql-results.csv';
      a.click();
      // Revoked on a later tick: the browser has not read the blob yet when the click returns.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setExportState('done');
    } catch {
      setExportState('failed');
    }
    setTimeout(() => setExportState('idle'), 1600);
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
                      // A cell wider than the column is clipped, so the full value lives in the tooltip.
                      <td key={ci} className={`asksql-cell-${d.kind}`} title={d.title ?? d.text}>
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
        <CopyButton text={() => toCsv(result.columns, result.rows)} />
        <button className="asksql-btn" style={{ padding: '2px 8px', fontSize: 12 }} onClick={download}>
          {exportState === 'done' ? 'Exported' : exportState === 'failed' ? 'Export failed' : 'Export CSV'}
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
  useEffect(() => ensureStyles(props.styleRoot, props.nonce), [props.styleRoot, props.nonce]);
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
    // Inside a shadow root document.activeElement is the host; the root tracks the real one.
    const active = (panelRef.current.getRootNode() as Document | ShadowRoot).activeElement;
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
