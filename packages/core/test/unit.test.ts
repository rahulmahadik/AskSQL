/**
 * Core unit tests: SQL extraction, catalog pruning/formatting, error
 * taxonomy wire-safety, and LLM error classification.
 */
import { describe, expect, it } from 'vitest';
import { extractSql, extractImpossible } from '../src/extract.js';
import { AskSqlError } from '../src/errors.js';
import { classifyLlmError } from '../src/llm.js';
import { formatCatalogForPrompt, pruneCatalog, estimateTokens } from '../src/catalog.js';
import { classifyColumnKind } from '../src/coltype.js';
import type { SchemaCatalog, TableInfo } from '../src/types.js';

describe('extractSql', () => {
  it('fenced sql block', () => {
    const r = extractSql('Here you go:\n```sql\nSELECT 1\n```\nThat returns one.');
    expect(r?.sql).toBe('SELECT 1');
    expect(r?.explanation).toMatch(/returns one/i);
  });
  it('unlabeled fence', () => {
    expect(extractSql('```\nSELECT * FROM t\n```')?.sql).toBe('SELECT * FROM t');
  });
  it('whole message is SQL', () => {
    expect(extractSql('SELECT count(*) FROM users')?.source).toBe('whole');
  });
  it('inline SELECT among prose', () => {
    const r = extractSql('The query is:\nSELECT a FROM b\n\nEnjoy.');
    expect(r?.sql).toContain('SELECT a FROM b');
  });
  it('picks the query fence, not a result fence', () => {
    const r = extractSql('Result:\n```\nid | name\n```\nQuery:\n```sql\nSELECT id,name FROM t\n```');
    expect(r?.sql).toBe('SELECT id,name FROM t');
  });
  it('no sql -> null', () => {
    expect(extractSql("I can't help with that.")).toBeNull();
  });
  it('keeps a long description complete (no blind character cap)', () => {
    const longText = 'This query does the following thing in detail. '.repeat(120); // ~5600 chars
    const r = extractSql(`\`\`\`sql\nSELECT 1\n\`\`\`\n${longText}`);
    expect(r?.explanation.length).toBeGreaterThan(3000);
    expect(r?.explanation.endsWith('detail.')).toBe(true); // not cut mid-word
  });
  it('IMPOSSIBLE sentinel', () => {
    expect(extractImpossible('IMPOSSIBLE: there is no revenue column')).toMatch(/revenue/);
    expect(extractImpossible('SELECT 1')).toBeNull();
  });
});

describe('AskSqlError wire-safety', () => {
  it('toJSON omits detail/cause/stack', () => {
    const err = new AskSqlError('DB_AUTH', { detail: 'password=hunter2 host=internal.db', cause: new Error('boom') });
    const json = err.toJSON();
    expect(json).toEqual({ code: 'DB_AUTH', userMessage: expect.any(String), retryable: false });
    expect(JSON.stringify(json)).not.toMatch(/hunter2|internal\.db/);
  });
  it('retryable defaults by code', () => {
    expect(new AskSqlError('DB_TIMEOUT').retryable).toBe(true);
    expect(new AskSqlError('GUARD_BLOCKED').retryable).toBe(false);
  });
  it('from() preserves an existing AskSqlError', () => {
    const orig = new AskSqlError('LLM_AUTH');
    expect(AskSqlError.from(orig, 'DB_QUERY_ERROR')).toBe(orig);
  });
});

describe('classifyLlmError', () => {
  const mk = (o: object) => o;
  it('401 -> LLM_AUTH, not retryable', () => {
    const e = classifyLlmError(mk({ statusCode: 401, message: 'unauthorized' }), false);
    expect(e.code).toBe('LLM_AUTH');
    expect(e.retryable).toBe(false);
  });
  it('429 -> LLM_RATE_LIMIT retryable', () => {
    const e = classifyLlmError(mk({ statusCode: 429 }), false);
    expect(e.code).toBe('LLM_RATE_LIMIT');
    expect(e.retryable).toBe(true);
  });
  it('400 context -> LLM_CONTEXT_OVERFLOW', () => {
    const e = classifyLlmError(mk({ statusCode: 400, message: 'maximum context length exceeded' }), false);
    expect(e.code).toBe('LLM_CONTEXT_OVERFLOW');
  });
  it('500 -> LLM_UNAVAILABLE retryable', () => {
    expect(classifyLlmError(mk({ statusCode: 503 }), false).retryable).toBe(true);
  });
  it('ECONNREFUSED -> LLM_UNREACHABLE', () => {
    expect(classifyLlmError(mk({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }), false).code).toBe(
      'LLM_UNREACHABLE',
    );
  });
  it('caller abort -> CANCELLED', () => {
    expect(classifyLlmError(mk({ name: 'AbortError' }), true).code).toBe('CANCELLED');
  });
});

describe('column kind classification', () => {
  it('maps common types', () => {
    expect(classifyColumnKind('bigint')).toBe('bigint');
    expect(classifyColumnKind('numeric(12,2)')).toBe('decimal');
    expect(classifyColumnKind('integer')).toBe('number');
    expect(classifyColumnKind('timestamp with time zone')).toBe('timestamp');
    expect(classifyColumnKind('jsonb')).toBe('json');
    expect(classifyColumnKind('bytea')).toBe('binary');
    expect(classifyColumnKind('character varying(255)')).toBe('text');
    // MySQL BOOLEAN surrogate; tinyint(10) must NOT be treated as boolean.
    expect(classifyColumnKind('tinyint(1)')).toBe('boolean');
    expect(classifyColumnKind('tinyint(1) unsigned')).toBe('boolean');
    expect(classifyColumnKind('tinyint(10)')).toBe('number');
    // An unrecognized type never throws; it degrades to 'unknown'.
    expect(classifyColumnKind('geometry')).toBe('unknown');
  });
});

// --- catalog helpers ---
function tbl(name: string, cols: string[], fks: TableInfo['foreignKeys'] = []): TableInfo {
  return {
    name,
    kind: 'table',
    columns: cols.map((c) => ({ name: c, dbType: 'text', nullable: true })),
    primaryKey: ['id'],
    foreignKeys: fks,
    uniques: [],
    checks: [],
    indexes: [],
    source: 'db',
  };
}
function cat(tables: TableInfo[]): SchemaCatalog {
  return {
    engine: 'postgres',
    schemas: ['public'],
    tables,
    enums: [],
    sequences: [],
    triggers: [],
    routines: [],
    warnings: [],
    fetchedAt: 'now',
  };
}

describe('pruneCatalog', () => {
  it('keeps everything when under budget', () => {
    const c = cat([tbl('users', ['id', 'name']), tbl('orders', ['id', 'user_id'])]);
    const r = pruneCatalog(c, 'how many orders', c.tables[0] ? {} : {});
    expect(r.strategy).toBe('none');
    expect(r.catalog.tables).toHaveLength(2);
  });

  it('selects relevant tables + FK closure', () => {
    const many: TableInfo[] = [];
    for (let i = 0; i < 60; i++) many.push(tbl(`noise_${i}`, ['id', 'x']));
    many.push(tbl('customers', ['id', 'email']));
    many.push(
      tbl('orders', ['id', 'customer_id'], [{ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }]),
    );
    const r = pruneCatalog(cat(many), 'total revenue per customer from orders', { maxTables: 10 });
    const names = r.catalog.tables.map((t) => t.name);
    expect(names).toContain('orders');
    expect(names).toContain('customers'); // pulled in by FK closure
    expect(r.catalog.tables.length).toBeLessThanOrEqual(10);
  });

  it('follows a 2-hop FK chain from a single matched seed', () => {
    const many: TableInfo[] = [];
    for (let i = 0; i < 60; i++) many.push(tbl(`noise_${i}`, ['id', 'x']));
    // invoices -> orders -> customers: only "invoices" matches the question.
    many.push(tbl('customers', ['id', 'email']));
    many.push(
      tbl('orders', ['id', 'customer_id'], [{ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }]),
    );
    many.push(tbl('invoices', ['id', 'order_id'], [{ columns: ['order_id'], refTable: 'orders', refColumns: ['id'] }]));
    const r = pruneCatalog(cat(many), 'list invoices', { maxTables: 10 });
    const names = r.catalog.tables.map((t) => t.name);
    expect(names).toContain('invoices'); // seed
    expect(names).toContain('orders'); // 1 hop
    expect(names).toContain('customers'); // 2 hops
  });

  it('scores a whole-word column token over an incidental substring', () => {
    const many: TableInfo[] = [];
    for (let i = 0; i < 60; i++) many.push(tbl(`noise_${i}`, ['id', 'x']));
    // "price" is a real column token here, only an incidental substring elsewhere.
    many.push(tbl('products', ['id', 'unit_price_cents']));
    many.push(tbl('enterprises', ['id', 'name'])); // contains "price" as a substring
    const r = pruneCatalog(cat(many), 'average price', { maxTables: 5 });
    const names = r.catalog.tables.map((t) => t.name);
    expect(names).toContain('products');
  });
});

describe('formatCatalogForPrompt', () => {
  it('renders FK relationships and enum values', () => {
    const c: SchemaCatalog = {
      ...cat([
        {
          ...tbl(
            'orders',
            ['id', 'status', 'customer_id'],
            [{ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }],
          ),
          columns: [
            { name: 'id', dbType: 'bigint', nullable: false },
            { name: 'status', dbType: 'order_status', nullable: false, enumValues: ['pending', 'paid'] },
            { name: 'customer_id', dbType: 'bigint', nullable: false },
          ],
        },
      ]),
    };
    const text = formatCatalogForPrompt(c);
    expect(text).toMatch(/RELATIONSHIPS/);
    expect(text).toMatch(/orders\.customer_id = customers\.id/);
    expect(text).toMatch(/values: pending\|paid/);
  });
  it('renders sampled values for a non-enum column, and enum wins when both are present', () => {
    const c = cat([
      {
        ...tbl('tickets', ['status', 'kind']),
        columns: [
          { name: 'status', dbType: 'varchar', nullable: false, sampledValues: ['open', 'closed'] },
          // A column with both should show the declared enum, never the sample.
          { name: 'kind', dbType: 'kind_enum', nullable: false, enumValues: ['bug'], sampledValues: ['bug', 'stale'] },
        ],
      },
    ]);
    const text = formatCatalogForPrompt(c);
    expect(text).toMatch(/sample values: open\|closed/);
    expect(text).toMatch(/values: bug/);
    expect(text).not.toMatch(/sample values: bug/);
  });
  it('sanitizes sampled values so a value containing the pipe separator cannot corrupt the list', () => {
    const c = cat([
      {
        ...tbl('logs', ['level']),
        columns: [{ name: 'level', dbType: 'text', nullable: false, sampledValues: ['a|b', 'c\n d', 'z'.repeat(200)] }],
      },
    ]);
    const text = formatCatalogForPrompt(c);
    const line = text.split('\n').find((l) => l.includes('sample values:'))!;
    // 3 values -> exactly 2 separators; the embedded pipe became a slash.
    expect(line.split('|')).toHaveLength(3);
    expect(line).toContain('a/b');
    expect(line).toContain('c d'); // newline flattened to a space
    expect(line).not.toMatch(/z{90}/); // long value capped
  });
  it('estimateTokens is roughly length/4', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });
});
