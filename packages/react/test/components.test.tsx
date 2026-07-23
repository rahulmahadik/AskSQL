// @vitest-environment jsdom
/**
 * <AskSqlChat/> and its presentational parts under jsdom: empty state, the
 * ask -> SQL -> results flow, approval + edit + plan actions, Markdown
 * rendering, the connection picker, and standalone SqlBlock / ResultTable.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AskSqlBubble, AskSqlChat, ResultTable, SqlBlock } from '../src/components.js';
import type { ResultSet } from '@asksql/core';
import { chatOf, deferred, makeTransport, resultOf } from './helpers.js';

// Fill jsdom gaps the components rely on: object-URLs (CSV export), element
// scrolling (thread auto-scroll), and a writable clipboard (Copy).
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
  Element.prototype.scrollTo = vi.fn();
});

afterEach(cleanup);

describe('AskSqlChat', () => {
  it('shows the empty state before any question', () => {
    render(<AskSqlChat transport={makeTransport()} />);
    expect(screen.getByText(/Ask your database anything/i)).toBeTruthy();
  });

  it('renders suggestion chips and asks when one is picked', async () => {
    const user = userEvent.setup();
    const transport = makeTransport({ chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }) });
    render(<AskSqlChat transport={transport} suggestions={['top customers']} />);
    await user.click(screen.getByRole('button', { name: 'top customers' }));
    await waitFor(() => expect(screen.getByText('SELECT 1')).toBeTruthy());
  });

  it('ask flow renders role headers, SQL, and the result table', async () => {
    const user = userEvent.setup();
    const transport = makeTransport({
      chat: chatOf({ type: 'sql', sql: 'SELECT * FROM sales' }, { type: 'done' }),
      execute: async () => resultOf(),
    });
    render(<AskSqlChat transport={transport} />);

    await user.type(screen.getByRole('textbox', { name: /Ask a question/i }), 'sales by region');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText('SELECT * FROM sales')).toBeTruthy());
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('AskSQL')).toBeTruthy();
    expect(screen.getByText('sales by region')).toBeTruthy();
    // Result table cells + row count meta.
    expect(screen.getByText('EU')).toBeTruthy();
    expect(screen.getByText('250')).toBeTruthy();
    expect(screen.getByText(/2 rows/)).toBeTruthy();
  });

  it('renders explanation Markdown (bold, code, bullets)', async () => {
    const user = userEvent.setup();
    const transport = makeTransport({
      chat: chatOf(
        {
          type: 'sql',
          sql: 'SELECT 1',
          explanation: 'Explanation: counts **all** rows via `count(*)`\n- groups by region\n- orders by total',
        },
        { type: 'done' },
      ),
    });
    const { container } = render(<AskSqlChat transport={transport} />);
    await user.type(screen.getByRole('textbox', { name: /Ask a question/i }), 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(container.querySelector('.asksql-explain')).toBeTruthy());
    const explain = container.querySelector('.asksql-explain')!;
    expect(explain.querySelector('strong')?.textContent).toBe('all');
    expect(explain.querySelector('code')?.textContent).toBe('count(*)');
    expect(explain.querySelectorAll('.asksql-md-bullet').length).toBe(2);
    // The redundant leading "Explanation:" label is stripped.
    expect(explain.textContent).not.toMatch(/Explanation:/);
  });

  it('renders a fenced ```sql block as a code block, not literal backticks', async () => {
    const user = userEvent.setup();
    const transport = makeTransport({
      chat: chatOf(
        {
          type: 'sql',
          sql: 'SELECT 1',
          explanation: 'You could add it:\n```sql\nALTER TABLE t ADD COLUMN x int;\n```\nRead-only, nothing ran.',
        },
        { type: 'done' },
      ),
    });
    const { container } = render(<AskSqlChat transport={transport} />);
    await user.type(screen.getByRole('textbox', { name: /Ask a question/i }), 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(container.querySelector('.asksql-explain')).toBeTruthy());
    const explain = container.querySelector('.asksql-explain')!;
    const pre = explain.querySelector('pre.asksql-sqlcode');
    expect(pre).toBeTruthy();
    expect(pre!.textContent).toContain('ALTER TABLE t ADD COLUMN x int;');
    // The fence markers are consumed, never shown as literal backticks.
    expect(explain.textContent).not.toContain('```');
  });

  it('approval mode gates results behind a Run query button', async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => resultOf());
    const transport = makeTransport({ chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }), execute });
    render(<AskSqlChat transport={transport} requireApproval />);

    await user.type(screen.getByRole('textbox', { name: /Ask a question/i }), 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const runBtn = await screen.findByRole('button', { name: 'Run query' });
    expect(execute).not.toHaveBeenCalled();
    await user.click(runBtn);
    await waitFor(() => expect(screen.getByText(/2 rows/)).toBeTruthy());
  });

  it('keeps the textarea editable and shows Stop while streaming', async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const transport = makeTransport({
      chat: async function* () {
        yield { type: 'stage', stage: 'llm' } as const;
        await gate.promise;
        yield { type: 'sql', sql: 'SELECT 1' } as const;
        yield { type: 'done' } as const;
      },
    });
    render(<AskSqlChat transport={transport} />);
    const box = screen.getByRole('textbox', { name: /Ask a question/i }) as HTMLTextAreaElement;
    await user.type(box, 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const stop = await screen.findByRole('button', { name: 'Cancel' });
    expect(box.disabled).toBe(false);
    // Cancel path (Stop button) tears down the stream.
    await user.click(stop);
    gate.resolve();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull());
  });

  it('edits SQL and re-runs from the Edit action', async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => resultOf());
    const transport = makeTransport({ chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }), execute });
    render(<AskSqlChat transport={transport} />);
    await user.type(screen.getByRole('textbox', { name: /Ask a question/i }), 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('SELECT 1');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('textbox', { name: 'Edit SQL' });
    await user.clear(editor);
    await user.type(editor, 'SELECT 99');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(execute).toHaveBeenLastCalledWith('SELECT 99', expect.anything()));
  });

  it('fetches and shows a query plan', async () => {
    const user = userEvent.setup();
    const transport = makeTransport({
      chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }),
      execute: async (sql: string) =>
        sql.startsWith('EXPLAIN')
          ? resultOf({ columns: [{ name: 'p', kind: 'text' }], rows: [['Index Scan']], rowCount: 1 })
          : resultOf(),
    });
    render(<AskSqlChat transport={transport} requireApproval />);
    await user.type(screen.getByRole('textbox', { name: /Ask a question/i }), 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(await screen.findByRole('button', { name: 'Plan' }));
    await waitFor(() => expect(screen.getByText('Index Scan')).toBeTruthy());
    expect(screen.getByText('Query plan')).toBeTruthy();
  });

  it('surfaces a run error with a retry and applies a suggested fix', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const transport = makeTransport({
      chat: chatOf({ type: 'sql', sql: 'SELCT 1' }, { type: 'done' }),
      execute: async () => {
        attempt += 1;
        if (attempt === 1)
          throw { code: 'DB_QUERY_ERROR', userMessage: 'bad syntax', retryable: true, suggestedSql: 'SELECT 1' };
        return resultOf();
      },
    });
    render(<AskSqlChat transport={transport} />);
    await user.type(screen.getByRole('textbox', { name: /Ask a question/i }), 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect((await screen.findByRole('alert')).textContent).toContain('bad syntax');
    await user.click(screen.getByRole('button', { name: 'Apply suggested fix' }));
    await waitFor(() => expect(screen.getByText(/2 rows/)).toBeTruthy());
  });

  it('retries an LLM (ask-phase) failure by re-asking the question', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const transport = makeTransport({
      chat: () => {
        attempt += 1;
        return attempt === 1
          ? chatOf({ type: 'error', code: 'LLM_TIMEOUT', userMessage: 'model timed out', retryable: true })()
          : chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' })();
      },
    });
    render(<AskSqlChat transport={transport} />);
    await user.type(screen.getByRole('textbox', { name: /Ask a question/i }), 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect((await screen.findByRole('alert')).textContent).toContain('model timed out');
    // No SQL was generated, so Retry must re-run the ask phase (not the no-op run()).
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('SELECT 1')).toBeTruthy());
    expect(attempt).toBe(2);
  });

  it('hides the Plan button when the connection cannot EXPLAIN', async () => {
    const user = userEvent.setup();
    const caps = {
      supportsCancel: true,
      supportsExplain: false,
      supportsSchemas: true,
      readOnlySession: true,
      supportsMatViews: false,
      supportsTriggers: false,
      supportsRoutines: false,
    };
    const transport = makeTransport({
      connections: [{ id: 'o', name: 'Oracle', engine: 'oracle', capabilities: caps }],
      chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }),
    });
    render(<AskSqlChat transport={transport} requireApproval />);
    await user.type(screen.getByRole('textbox', { name: /Ask a question/i }), 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('SELECT 1');
    expect(screen.queryByRole('button', { name: 'Plan' })).toBeNull();
    // Other actions still render.
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it('shows the Plan button when the connection supports EXPLAIN', async () => {
    const user = userEvent.setup();
    const caps = {
      supportsCancel: true,
      supportsExplain: true,
      supportsSchemas: true,
      readOnlySession: true,
      supportsMatViews: false,
      supportsTriggers: false,
      supportsRoutines: false,
    };
    const transport = makeTransport({
      connections: [{ id: 'p', name: 'PG', engine: 'postgres', capabilities: caps }],
      chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }),
    });
    render(<AskSqlChat transport={transport} requireApproval />);
    await user.type(screen.getByRole('textbox', { name: /Ask a question/i }), 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('SELECT 1');
    expect(screen.getByRole('button', { name: 'Plan' })).toBeTruthy();
  });

  it('shows a connection picker when the sidecar exposes several', async () => {
    const user = userEvent.setup();
    const transport = makeTransport({
      connections: [
        { id: 'a', name: 'Prod', engine: 'postgres', database: 'app' },
        { id: 'b', name: 'Analytics', engine: 'duckdb' },
      ],
    });
    render(<AskSqlChat transport={transport} />);
    const picker = await screen.findByRole('combobox', { name: /Choose database/i });
    expect(screen.getByRole('option', { name: /Prod/ })).toBeTruthy();
    await user.selectOptions(picker, 'b');
    expect((picker as HTMLSelectElement).value).toBe('b');
  });

  it('submits on Enter (but Shift+Enter inserts a newline)', async () => {
    const user = userEvent.setup();
    const transport = makeTransport({ chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }) });
    render(<AskSqlChat transport={transport} />);
    const box = screen.getByRole('textbox', { name: /Ask a question/i });
    await user.type(box, 'first{Shift>}{Enter}{/Shift}second');
    expect((box as HTMLTextAreaElement).value).toContain('\n');
    await user.type(box, '{Enter}');
    await waitFor(() => expect(screen.getByText('SELECT 1')).toBeTruthy());
  });

  it('saves a query and flips the Save button label', async () => {
    const user = userEvent.setup();
    const transport = makeTransport({ chat: chatOf({ type: 'sql', sql: 'SELECT 1' }, { type: 'done' }) });
    render(<AskSqlChat transport={transport} requireApproval />);
    await user.type(screen.getByRole('textbox', { name: /Ask a question/i }), 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Saved' })).toBeTruthy();
  });

  it('warns when a row limit was auto-applied', async () => {
    const user = userEvent.setup();
    const transport = makeTransport({
      chat: chatOf({ type: 'sql', sql: 'SELECT 1', autoLimited: true }, { type: 'done' }),
    });
    render(<AskSqlChat transport={transport} requireApproval />);
    await user.type(screen.getByRole('textbox', { name: /Ask a question/i }), 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/row limit was added automatically/i)).toBeTruthy();
  });
});

describe('AskSqlBubble', () => {
  it('opens and closes the chat panel', async () => {
    const user = userEvent.setup();
    render(<AskSqlBubble transport={makeTransport()} title="Ask data" />);
    await user.click(screen.getByRole('button', { name: /Open database chat/i }));
    expect(screen.getByRole('dialog', { name: 'Ask data' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a modal dialog that traps focus and restores it on Escape', async () => {
    const user = userEvent.setup();
    render(<AskSqlBubble transport={makeTransport()} title="Ask data" />);
    const trigger = screen.getByRole('button', { name: /Open database chat/i });
    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Ask data' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Focus moved into the dialog on open.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // Escape closes the dialog and returns focus to the trigger.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Open database chat/i }));
  });

  it('anchors to the requested corner with a custom offset', () => {
    const { container } = render(
      <AskSqlBubble transport={makeTransport()} position="top-left" offset={{ x: 10, y: 20 }} icon="D" />,
    );
    const btn = container.querySelector('.asksql-bubble-btn') as HTMLElement;
    expect(btn.style.top).toBe('20px');
    expect(btn.style.left).toBe('10px');
    expect(btn.textContent).toBe('D');
  });

  it('renders only the first of multiple bubbles', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(
      <>
        <AskSqlBubble transport={makeTransport()} />
        <AskSqlBubble transport={makeTransport()} />
      </>,
    );
    expect(container.querySelectorAll('.asksql-bubble-btn')).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('SqlBlock', () => {
  it('copies SQL and flips the button label', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<SqlBlock sql="SELECT 1" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('SELECT 1');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });
});

describe('ResultTable', () => {
  it('renders columns, cells, a chart toggle, and exports CSV', async () => {
    const user = userEvent.setup();
    render(<ResultTable result={resultOf()} />);
    expect(screen.getByText('region')).toBeTruthy();
    expect(screen.getByText('NA')).toBeTruthy();
    // Numeric result is chartable -> a Chart toggle is offered.
    expect(screen.getByRole('button', { name: 'Chart' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('renders an empty state for zero rows', () => {
    const empty: ResultSet = { ...resultOf(), rows: [], rowCount: 0 };
    render(<ResultTable result={empty} />);
    expect(screen.getByText(/No rows matched/i)).toBeTruthy();
  });

  it('shows truncated + warnings meta', () => {
    const { container } = render(<ResultTable result={resultOf({ truncated: true, warnings: ['capped at 1k'] })} />);
    expect(screen.getByText(/truncated/)).toBeTruthy();
    expect(within(container).getByText('capped at 1k')).toBeTruthy();
  });
});
