import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AskSqlError } from '@asksql/core';
import { resetVscodeMock, setInspect, setConfig, commands, window, workspace, env, lm, Uri } from './vscode-mock.js';
import { ChatViewProvider } from '../src/chatView.js';
import { UserFacingError } from '../src/errors.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake WebviewView that records posted messages and exposes the message sink. */
function fakeView() {
  const posted: Record<string, unknown>[] = [];
  let handler: ((m: Record<string, unknown>) => void) | undefined;
  let visHandler: (() => void) | undefined;
  let dispHandler: (() => void) | undefined;
  const webview = {
    options: {} as unknown,
    cspSource: 'vscode-resource:',
    html: '',
    asWebviewUri: (u: Uri) => u,
    onDidReceiveMessage: (h: (m: Record<string, unknown>) => void) => {
      handler = h;
      return { dispose() {} };
    },
    postMessage: (m: Record<string, unknown>) => {
      posted.push(m);
      return Promise.resolve(true);
    },
  };
  const view = {
    webview,
    visible: true,
    onDidChangeVisibility: (h: () => void) => {
      visHandler = h;
      return { dispose() {} };
    },
    onDidDispose: (h: () => void) => {
      dispHandler = h;
      return { dispose() {} };
    },
  };
  return {
    view: view as never,
    posted,
    send: (m: Record<string, unknown>) => handler!(m),
    fireVisibility: () => visHandler!(),
    fireDispose: () => dispHandler!(),
  };
}

function fakeCtx(saved?: string) {
  return {
    extensionUri: Uri.file('/ext'),
    globalState: { get: vi.fn(() => saved), update: vi.fn(async () => {}) },
    secrets: { get: vi.fn(async () => undefined), store: vi.fn(), delete: vi.fn() },
  } as never;
}

const catalog = {
  tables: [
    {
      name: 'orders',
      schema: 'public',
      kind: 'table' as const,
      columns: [
        { name: 'id', dbType: 'int', nullable: false },
        { name: 'total', dbType: 'numeric', nullable: true },
      ],
      primaryKey: ['id'],
      foreignKeys: [{ columns: ['total'], refTable: 'money' }],
    },
  ],
};

/** A fake EngineManager exposing only the surface ChatViewProvider uses. */
function fakeEngines(over: Record<string, unknown> = {}) {
  return {
    isMongo: vi.fn(() => false),
    catalogFor: vi.fn(async () => catalog),
    failureFor: vi.fn(() => undefined),
    explain: vi.fn(async () => ({ columns: [{ name: 'plan' }], rows: [['seq scan']], rowCount: 1 })),
    forConfiguredModel: vi.fn(),
    forChatModel: vi.fn(),
    forConfiguredModelMongo: vi.fn(),
    forChatModelMongo: vi.fn(),
    ...over,
  } as never;
}

/** An answering engine whose ask() returns a scripted answer. */
function answeringEngine(answer: Record<string, unknown>) {
  return {
    ask: vi.fn(async (_q: string, opts: { onEvent?: (e: unknown) => void }) => {
      opts.onEvent?.({ type: 'stage', stage: 'llm' });
      opts.onEvent?.({ type: 'warning', message: 'schema narrowed' });
      return answer;
    }),
  };
}

const oneRowResult = {
  columns: [{ name: 'n' }],
  rows: [[1]],
  rowCount: 1,
  durationMs: 5,
  truncated: false,
  warnings: [],
};

const pgConn = { id: 'db1', name: 'DB One', engine: 'postgres', database: 'app' };

beforeEach(() => {
  resetVscodeMock();
  setInspect('connections', { global: [pgConn] });
});

describe('constructor model choice restore', () => {
  it('restores a vscode chat-model choice', () => {
    const p = new ChatViewProvider(fakeCtx('vscode:copilot-1'), fakeEngines());
    expect((p as unknown as { choice: { kind: string; id: string } }).choice).toEqual({
      kind: 'vscode',
      id: 'copilot-1',
    });
  });

  it('defaults to the configured provider', () => {
    const p = new ChatViewProvider(fakeCtx(undefined), fakeEngines());
    expect((p as unknown as { choice: { kind: string } }).choice.kind).toBe('configured');
  });
});

describe('resolveWebviewView', () => {
  it('sets html, locks resource roots, and pushes state on ready', () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted, send } = fakeView();
    p.resolveWebviewView(view);
    expect(view.webview.html).toContain('<title>AskSQL</title>');
    expect(view.webview.options).toMatchObject({ enableScripts: true });
    send({ type: 'ready' });
    expect(posted.some((m) => m.type === 'state')).toBe(true);
  });

  it('pushes state again when the view becomes visible', () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted, fireVisibility } = fakeView();
    p.resolveWebviewView(view);
    posted.length = 0;
    fireVisibility();
    expect(posted.some((m) => m.type === 'state')).toBe(true);
  });

  it('forgets the view on dispose', () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted, fireDispose } = fakeView();
    p.resolveWebviewView(view);
    fireDispose();
    posted.length = 0;
    p.refresh();
    // With the view gone, post() targets nothing.
    expect(posted.length).toBe(0);
  });
});

describe('pushState connection labels', () => {
  it('disambiguates two same-name/database connections with a host discriminator', () => {
    setInspect('connections', {
      global: [
        { id: 'a', name: 'DB', engine: 'postgres', database: 'app', host: 'h1', port: 5432 },
        { id: 'b', name: 'DB', engine: 'postgres', database: 'app', host: 'h2', port: 5432 },
      ],
    });
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted, send } = fakeView();
    p.resolveWebviewView(view);
    send({ type: 'ready' });
    const state = posted.find((m) => m.type === 'state') as { connections: { label: string }[] };
    const labels = state.connections.map((c) => c.label);
    expect(labels[0]).toContain('h1:5432');
    expect(labels[1]).toContain('h2:5432');
  });

  it('disambiguates same db+host with different users by the user', () => {
    setInspect('connections', {
      global: [
        { id: 'a', name: 'DB', engine: 'postgres', database: 'app', host: 'h1', port: 5432, user: 'alice' },
        { id: 'b', name: 'DB', engine: 'postgres', database: 'app', host: 'h1', port: 5432, user: 'bob' },
      ],
    });
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted, send } = fakeView();
    p.resolveWebviewView(view);
    send({ type: 'ready' });
    const state = posted.find((m) => m.type === 'state') as { connections: { label: string }[] };
    const labels = state.connections.map((c) => c.label);
    expect(labels[0]).toContain('alice');
    expect(labels[1]).toContain('bob');
    expect(labels[0]).not.toBe(labels[1]);
  });

  it('keeps labels unique via the id when every other field is identical', () => {
    setInspect('connections', {
      global: [
        { id: 'a', name: 'DB', engine: 'postgres', database: 'app', host: 'h1', port: 5432, user: 'same' },
        { id: 'b', name: 'DB', engine: 'postgres', database: 'app', host: 'h1', port: 5432, user: 'same' },
      ],
    });
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted, send } = fakeView();
    p.resolveWebviewView(view);
    send({ type: 'ready' });
    const state = posted.find((m) => m.type === 'state') as { connections: { label: string }[] };
    const labels = state.connections.map((c) => c.label);
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]).toContain('a');
    expect(labels[1]).toContain('b');
  });
});

describe('ask - catalog answered questions', () => {
  it('answers "what tables are here" from the schema without a model', async () => {
    const engines = fakeEngines();
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('what tables are in this database?');
    const result = posted.find((m) => m.type === 'result') as { columns: string[]; note: string };
    expect(result.columns).toEqual(['table', 'type', 'columns']);
    expect(result.note).toMatch(/read from the schema/);
    expect((engines as { forConfiguredModel: ReturnType<typeof vi.fn> }).forConfiguredModel).not.toHaveBeenCalled();
  });

  it('describes a named table from the catalog', async () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('describe orders');
    const result = posted.find((m) => m.type === 'result') as { columns: string[]; rows: unknown[][] };
    expect(result.columns).toEqual(['column', 'type', 'nullable', 'key']);
    expect(result.rows[0]).toEqual(['id', 'int', 'no', 'PK']);
    expect(result.rows[1]).toEqual(['total', 'numeric', 'yes', 'FK']);
  });

  it('reports a missing table with the list of real ones', async () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('describe customers');
    const err = posted.find((m) => m.type === 'error') as { message: string };
    expect(err.message).toMatch(/No table named "customers"/);
    expect(err.message).toContain('orders');
  });

  it('reports no tables for a list question on an empty schema', async () => {
    const engines = fakeEngines({ catalogFor: vi.fn(async () => ({ tables: [] })) });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('list tables');
    expect((posted.find((m) => m.type === 'error') as { message: string }).message).toMatch(/No tables/);
  });
});

describe('ask - connection guards', () => {
  it('errors and offers Add Connection when none are configured', async () => {
    setInspect('connections', { global: [] });
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('anything');
    expect(posted.some((m) => m.action === 'asksql.addConnection')).toBe(true);
    expect(posted.some((m) => m.type === 'turnEnd')).toBe(true);
  });

  it('errors on a stale connection id', async () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('anything', 'gone');
    expect((posted.find((m) => m.type === 'error') as { message: string }).message).toMatch(/no longer available/);
  });

  it('ignores an empty question', async () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('   ');
    expect(posted.length).toBe(0);
  });
});

describe('ask - model path', () => {
  it('posts SQL then a result for an ordinary question', async () => {
    const answer = {
      sql: 'select 1',
      explanation: 'counts',
      guard: { autoLimited: false },
      run: vi.fn(async () => oneRowResult),
    };
    const engines = fakeEngines({ forConfiguredModel: vi.fn(async () => answeringEngine(answer)) });
    setConfig({ requireApproval: false, sqlDisplay: 'after' });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('how many orders');
    const sql = posted.find((m) => m.type === 'sql') as { sql: string; placement: string; needsApproval: boolean };
    expect(sql.sql).toBe('select 1');
    expect(sql.placement).toBe('after');
    expect(sql.needsApproval).toBe(false);
    const result = posted.find((m) => m.type === 'result') as { rowCount: number; warnings: string[] };
    expect(result.rowCount).toBe(1);
    expect(result.warnings).toContain('schema narrowed');
    expect(answer.run).toHaveBeenCalled();
  });

  it('falls back to a schema answer when SQL fails and the setting is on', async () => {
    const engine = {
      ask: vi.fn(async () => {
        throw new AskSqlError('LLM_BAD_OUTPUT', { userMessage: "couldn't build a query" });
      }),
      explainSchema: vi.fn(async () => ({
        answer: 'The orders table links to customers via customer_id.',
        tables: ['orders', 'customers'],
        grounded: true,
        unknownReferences: [],
      })),
    };
    const engines = fakeEngines({ forConfiguredModel: vi.fn(async () => engine) });
    setConfig({ answerSchemaQuestions: true });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('how are the tables related?');
    const sa = posted.find((m) => m.type === 'schemaAnswer') as { answer: string; grounded: boolean };
    expect(sa).toBeTruthy();
    expect(sa.answer).toContain('customer_id');
    expect(sa.grounded).toBe(true);
    expect(engine.explainSchema).toHaveBeenCalled();
    expect(posted.find((m) => m.type === 'error')).toBeUndefined();
  });

  it('does not fall back when the setting is off - the error surfaces', async () => {
    const engine = {
      ask: vi.fn(async () => {
        throw new AskSqlError('LLM_BAD_OUTPUT', { userMessage: "couldn't build a query" });
      }),
      explainSchema: vi.fn(),
    };
    const engines = fakeEngines({ forConfiguredModel: vi.fn(async () => engine) });
    setConfig({ answerSchemaQuestions: false });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('how are the tables related?');
    expect(engine.explainSchema).not.toHaveBeenCalled();
    expect(posted.find((m) => m.type === 'schemaAnswer')).toBeUndefined();
    expect(posted.find((m) => m.type === 'error')).toBeTruthy();
  });

  it('schema fallback ignores requireApproval - a prose answer needs no Run click', async () => {
    const engine = {
      ask: vi.fn(async () => {
        throw new AskSqlError('LLM_BAD_OUTPUT', { userMessage: "couldn't build a query" });
      }),
      explainSchema: vi.fn(async () => ({
        answer: 'orders links to customers via customer_id.',
        tables: ['orders'],
        grounded: true,
        unknownReferences: [],
      })),
    };
    const engines = fakeEngines({ forConfiguredModel: vi.fn(async () => engine) });
    setConfig({ answerSchemaQuestions: true, requireApproval: true });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('how are the tables related?');
    expect(posted.find((m) => m.type === 'schemaAnswer')).toBeTruthy();
    // No SQL/approval prompt: there is no query to approve.
    expect(posted.find((m) => m.type === 'sql')).toBeUndefined();
  });

  it('does not fall back for a data question that produced SQL', async () => {
    const explainSchema = vi.fn();
    const answer = {
      sql: 'select 1',
      explanation: 'counts',
      guard: { autoLimited: false },
      run: vi.fn(async () => oneRowResult),
    };
    const engine = { ...answeringEngine(answer), explainSchema };
    const engines = fakeEngines({ forConfiguredModel: vi.fn(async () => engine) });
    setConfig({ answerSchemaQuestions: true, requireApproval: false, sqlDisplay: 'after' });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('how many orders');
    expect(posted.find((m) => m.type === 'result')).toBeTruthy();
    expect(explainSchema).not.toHaveBeenCalled();
    expect(posted.find((m) => m.type === 'schemaAnswer')).toBeUndefined();
  });

  it('does not fall back on a database error - only unbuildable-SQL triggers the schema answer', async () => {
    const explainSchema = vi.fn();
    const engine = {
      ask: vi.fn(async () => {
        throw new AskSqlError('DB_QUERY_ERROR', { userMessage: 'the query failed' });
      }),
      explainSchema,
    };
    const engines = fakeEngines({ forConfiguredModel: vi.fn(async () => engine) });
    setConfig({ answerSchemaQuestions: true });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('how are the tables related?');
    expect(explainSchema).not.toHaveBeenCalled();
    expect(posted.find((m) => m.type === 'schemaAnswer')).toBeUndefined();
    expect(posted.find((m) => m.type === 'error')).toBeTruthy();
  });

  it('waits for inline approval before running when requireApproval is on', async () => {
    const answer = {
      sql: 'select 1',
      explanation: '',
      guard: { autoLimited: false },
      run: vi.fn(async () => oneRowResult),
    };
    const engines = fakeEngines({ forConfiguredModel: vi.fn(async () => answeringEngine(answer)) });
    setConfig({ requireApproval: true });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted, send } = fakeView();
    p.resolveWebviewView(view);
    const done = (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('how many orders');
    await tick();
    const sql = posted.find((m) => m.type === 'sql') as {
      needsApproval: boolean;
      placement: string;
      approvalId: string;
    };
    expect(sql.needsApproval).toBe(true);
    expect(sql.placement).toBe('before');
    send({ type: 'approve', approvalId: sql.approvalId, ok: true });
    await done;
    expect(answer.run).toHaveBeenCalled();
    expect(posted.some((m) => m.type === 'result')).toBe(true);
  });

  it('does not run when approval is declined', async () => {
    const answer = {
      sql: 'select 1',
      explanation: '',
      guard: { autoLimited: false },
      run: vi.fn(async () => oneRowResult),
    };
    const engines = fakeEngines({ forConfiguredModel: vi.fn(async () => answeringEngine(answer)) });
    setConfig({ requireApproval: true });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted, send } = fakeView();
    p.resolveWebviewView(view);
    const done = (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('q');
    await tick();
    const sql = posted.find((m) => m.type === 'sql') as { approvalId: string };
    send({ type: 'approve', approvalId: sql.approvalId, ok: false });
    await done;
    expect(answer.run).not.toHaveBeenCalled();
    expect(posted.some((m) => m.type === 'notRun')).toBe(true);
  });

  it('routes a MongoDB connection through the mongo adapter', async () => {
    setInspect('connections', { global: [{ id: 'mo', name: 'M', engine: 'mongodb', database: 'shop' }] });
    const mongo = {
      ask: vi.fn(async () => ({
        pipelineJson: '[{"$match":{}}]',
        explanation: 'agg',
        collection: 'orders',
        autoLimited: false,
        loweredLimit: undefined,
        warnings: [],
        repairs: 0,
      })),
      execute: vi.fn(async () => oneRowResult),
    };
    const engines = fakeEngines({
      isMongo: vi.fn(() => true),
      forConfiguredModelMongo: vi.fn(async () => mongo),
    });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('orders per day', 'mo');
    const sql = posted.find((m) => m.type === 'sql') as { sql: string };
    expect(sql.sql).toBe('[{"$match":{}}]');
    expect(mongo.execute).toHaveBeenCalled();
  });

  it('surfaces a recorded build failure instead of a generic error', async () => {
    const engines = fakeEngines({
      forConfiguredModel: vi.fn(async () => {
        throw new Error('unknown connection');
      }),
      failureFor: vi.fn(() => new UserFacingError('bad sqlite path')),
    });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('q');
    expect((posted.find((m) => m.type === 'error') as { message: string }).message).toBe('bad sqlite path');
  });

  it('attaches a setup action and guard flag for an AskSqlError', async () => {
    const engines = fakeEngines({
      forConfiguredModel: vi.fn(async () => ({
        ask: vi.fn(async () => {
          throw new AskSqlError('LLM_AUTH', { userMessage: 'Bad key.' });
        }),
      })),
    });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('q');
    const err = posted.find((m) => m.type === 'error') as { message: string; action?: string };
    expect(err.message).toBe('Bad key.');
    expect(err.action).toBe('asksql.setApiKey');
  });
});

describe('result store actions', () => {
  async function askProducing(res: Record<string, unknown>) {
    const answer = {
      sql: 'select 1',
      explanation: '',
      guard: { autoLimited: false },
      run: vi.fn(async () => res),
    };
    const engines = fakeEngines({ forConfiguredModel: vi.fn(async () => answeringEngine(answer)) });
    setConfig({ requireApproval: false });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const view = fakeView();
    p.resolveWebviewView(view.view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('q');
    const result = view.posted.find((m) => m.type === 'result') as { resultId: string };
    return { p, ...view, resultId: result.resultId };
  }

  it('copies a stored result as TSV and acks', async () => {
    const { posted, send, resultId } = await askProducing(oneRowResult);
    send({ type: 'copy', resultId });
    await tick();
    expect(env.clipboard.writeText).toHaveBeenCalled();
    expect(posted.some((m) => m.type === 'copied' && m.resultId === resultId)).toBe(true);
  });

  it('exports a stored result via the export command', async () => {
    const { send, resultId } = await askProducing(oneRowResult);
    send({ type: 'exportCsv', resultId });
    expect(commands.executeCommand).toHaveBeenCalledWith('asksql.exportCsv', expect.objectContaining({ rowCount: 1 }));
  });

  it('reports an error when copying to the clipboard fails', async () => {
    const { posted, send } = await askProducing(oneRowResult);
    env.clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    send({ type: 'copy', resultId: (posted.find((m) => m.type === 'result') as { resultId: string }).resultId });
    await tick();
    expect(posted.some((m) => m.type === 'error' && /Could not copy/.test(String(m.message)))).toBe(true);
  });

  it('opens a stored result as JSON, stringifying bigint and non-finite numbers', async () => {
    const res = {
      columns: [{ name: 'big' }, { name: 'inf' }],
      rows: [[10n, Infinity]],
      rowCount: 1,
      durationMs: 1,
      truncated: false,
      warnings: [],
    };
    const { send, resultId } = await askProducing(res);
    send({ type: 'openResult', resultId });
    await tick();
    const doc = workspace.openTextDocument.mock.calls.at(-1)![0] as { content: string; language: string };
    expect(doc.language).toBe('json');
    expect(doc.content).toContain('"10"');
    expect(doc.content).toContain('"Infinity"');
  });
});

describe('chat-model (vscode) routing', () => {
  it('resolves the picked VS Code chat model and answers through it', async () => {
    lm.selectChatModels.mockResolvedValue([{ id: 'copilot-1', name: 'Copilot', vendor: 'gh' }]);
    const answer = {
      sql: 'select 1',
      explanation: '',
      guard: { autoLimited: false },
      run: vi.fn(async () => oneRowResult),
    };
    const forChatModel = vi.fn(async () => answeringEngine(answer));
    const engines = fakeEngines({ forChatModel });
    setConfig({ requireApproval: false });
    const p = new ChatViewProvider(fakeCtx('vscode:copilot-1'), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('q');
    expect(forChatModel).toHaveBeenCalled();
    expect(posted.some((m) => m.type === 'result')).toBe(true);
  });

  it('errors when the picked chat model is no longer available', async () => {
    lm.selectChatModels.mockResolvedValue([]);
    const p = new ChatViewProvider(fakeCtx('vscode:gone'), fakeEngines());
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('q');
    expect((posted.find((m) => m.type === 'error') as { message: string }).message).toMatch(/no longer available/);
  });
});

describe('message routing', () => {
  it('opens SQL via the allowlisted command', () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, send } = fakeView();
    p.resolveWebviewView(view);
    send({ type: 'openSql', sql: 'select 1' });
    expect(commands.executeCommand).toHaveBeenCalledWith('asksql.openSqlInEditor', 'select 1');
  });

  it('runs an allowlisted command but ignores others', () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, send } = fakeView();
    p.resolveWebviewView(view);
    send({ type: 'command', id: 'asksql.selectProvider' });
    expect(commands.executeCommand).toHaveBeenCalledWith('asksql.selectProvider');
    (commands.executeCommand as ReturnType<typeof vi.fn>).mockClear();
    send({ type: 'command', id: 'workbench.action.evil' });
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it('reports a gone result for export/copy/open of an unknown id', () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted, send } = fakeView();
    p.resolveWebviewView(view);
    send({ type: 'exportCsv', resultId: 'nope' });
    send({ type: 'copy', resultId: 'nope' });
    send({ type: 'openResult', resultId: 'nope' });
    const gone = posted.filter((m) => m.type === 'error' && /no longer kept/.test(String(m.message)));
    expect(gone.length).toBe(3);
  });

  it('stop aborts a live turn once', async () => {
    let resolveRun: (v: unknown) => void = () => {};
    const answer = {
      sql: 'select 1',
      explanation: '',
      guard: { autoLimited: false },
      run: vi.fn(() => new Promise((r) => (resolveRun = r))),
    };
    const engines = fakeEngines({ forConfiguredModel: vi.fn(async () => answeringEngine(answer)) });
    setConfig({ requireApproval: false });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted, send } = fakeView();
    p.resolveWebviewView(view);
    const done = (p as unknown as { ask: (t: string, c?: string) => Promise<void> }).ask('q');
    await tick();
    send({ type: 'stop' });
    expect(posted.some((m) => m.type === 'cancelled')).toBe(true);
    resolveRun(oneRowResult);
    await done;
  });
});

describe('plan', () => {
  it('posts a plan from the database', async () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { plan: (s: string, c?: string, i?: string) => Promise<void> }).plan(
      'select 1',
      'db1',
      'p1',
    );
    const plan = posted.find((m) => m.type === 'plan') as { columns: string[]; planId: string };
    expect(plan.columns).toEqual(['plan']);
    expect(plan.planId).toBe('p1');
  });

  it('posts an error when explain throws', async () => {
    const engines = fakeEngines({
      explain: vi.fn(async () => {
        throw new UserFacingError('no plan here');
      }),
    });
    const p = new ChatViewProvider(fakeCtx(), engines);
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await (p as unknown as { plan: (s: string, c?: string, i?: string) => Promise<void> }).plan('select 1', 'db1');
    expect((posted.find((m) => m.type === 'error') as { message: string }).message).toBe('no plan here');
  });
});

describe('clear / prefill / focus', () => {
  it('clear posts a clear message and empties history/results', () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    p.clear();
    expect(posted.some((m) => m.type === 'clear')).toBe(true);
  });

  it('prefill focuses and posts the text', () => {
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    p.prefill('SELECT 1');
    expect(posted.some((m) => m.type === 'prefill' && m.text === 'SELECT 1')).toBe(true);
    expect(commands.executeCommand).toHaveBeenCalledWith('asksql.chat.focus');
  });
});

describe('pickModel', () => {
  it('saves a chosen provider model and switches to configured', async () => {
    setConfig({ provider: 'ollama', model: '' });
    const globalState = { get: vi.fn(() => undefined), update: vi.fn(async () => {}) };
    const ctx = {
      extensionUri: Uri.file('/ext'),
      globalState,
      secrets: { get: vi.fn(async () => undefined) },
    } as never;
    const p = new ChatViewProvider(ctx, fakeEngines());
    const { view } = fakeView();
    p.resolveWebviewView(view);
    // providerModels lists one model; pick it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen' }] }) })),
    );
    window.showQuickPick.mockResolvedValueOnce({ label: 'qwen', pick: { kind: 'provider', model: 'qwen' } });
    await p.pickModel();
    expect(globalState.update).toHaveBeenCalledWith('asksql.modelChoice', 'configured');
    vi.unstubAllGlobals();
  });

  it('opens provider setup when the change item is chosen', async () => {
    setConfig({ provider: 'ollama', model: '' });
    lm.selectChatModels.mockResolvedValue([]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ models: [] }) })),
    );
    const p = new ChatViewProvider(fakeCtx(), fakeEngines());
    const { view } = fakeView();
    p.resolveWebviewView(view);
    window.showQuickPick.mockResolvedValueOnce({ label: 'Change', pick: { kind: 'change' } });
    await p.pickModel();
    expect(commands.executeCommand).toHaveBeenCalledWith('asksql.selectProvider');
    vi.unstubAllGlobals();
  });
});
