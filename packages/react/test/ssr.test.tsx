/**
 * (SSR / Next.js) + (XSS-safe cells).
 *
 * Production apps import @asksql/react on the server (Next.js App Router).
 * These render the components with `react-dom/server` - no DOM, no effects -
 * and assert (a) importing + rendering never touches `window`/`document`,
 * and (b) untrusted result values are HTML-escaped in the output.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { AskSqlChat, AskSqlBubble, ResultTable, SqlBlock } from '../src/components.js';
import { SchemaBrowser } from '../src/SchemaBrowser.js';
import type { Transport } from '../src/client.js';
import type { ResultSet, SchemaCatalog } from '@asksql/core';

const noopTransport: Transport = {
  listConnections: async () => [],
  schema: async () => ({
    engine: 'postgres',
    schemas: [],
    tables: [],
    enums: [],
    sequences: [],
    triggers: [],
    routines: [],
    warnings: [],
    fetchedAt: 'now',
  }),
  chat: async function* () {},
  execute: async () => ({ columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0, warnings: [] }),
  explain: async () => '',
};

describe('server-side rendering (Next.js safe)', () => {
  it('AskSqlChat renders to string without a DOM', () => {
    const html = renderToString(createElement(AskSqlChat, { transport: noopTransport }));
    expect(html).toContain('asksql-chat');
    expect(html).toContain('textarea');
  });

  it('AskSqlBubble renders to string without a DOM', () => {
    const html = renderToString(createElement(AskSqlBubble, { transport: noopTransport, title: 'Ask' }));
    expect(html).toContain('asksql-bubble-btn');
  });

  it('no window/document access at import or render time', () => {
    // The test process is Node (no window/document). Reaching here without a
    // ReferenceError proves import + renderToString are DOM-free.
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
  });
});

describe('result cells are XSS-safe', () => {
  it('escapes HTML/script markup in cell values', () => {
    const result: ResultSet = {
      columns: [{ name: 'payload', kind: 'text' }],
      rows: [['<script>alert(1)</script>'], ['<img src=x onerror=alert(2)>']],
      rowCount: 2,
      truncated: false,
      durationMs: 1,
      warnings: [],
    };
    const html = renderToString(createElement(ResultTable, { result }));
    // React escapes by default: the raw tags must NOT appear as live markup.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    // The escaped, inert form IS present.
    expect(html).toContain('&lt;script&gt;');
  });

  it('SQL block renders SQL as inert text, not markup', () => {
    const html = renderToString(createElement(SqlBlock, { sql: "SELECT '<b>x</b>' FROM t" }));
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('SchemaBrowser renders (SSR-safe)', () => {
  const catalog: SchemaCatalog = {
    engine: 'postgres',
    schemas: ['public'],
    tables: [
      {
        name: 'orders',
        kind: 'table',
        columns: [
          { name: 'id', dbType: 'bigint', nullable: false },
          { name: 'status', dbType: 'order_status', nullable: false, enumValues: ['paid', 'shipped'] },
          { name: 'customer_id', dbType: 'bigint', nullable: false },
        ],
        primaryKey: ['id'],
        foreignKeys: [{ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }],
        uniques: [],
        checks: [],
        indexes: [],
        source: 'db',
      },
    ],
    enums: [],
    sequences: [],
    triggers: [],
    routines: [],
    warnings: [],
    fetchedAt: 'now',
  };
  it('lists tables and is server-renderable', () => {
    const html = renderToString(createElement(SchemaBrowser, { catalog }));
    expect(html).toContain('orders');
    expect(html).toContain('asksql-schema');
  });
  it('empty catalog shows a friendly empty state', () => {
    const empty: SchemaCatalog = { ...catalog, tables: [] };
    const html = renderToString(createElement(SchemaBrowser, { catalog: empty }));
    expect(html).toMatch(/No tables found/i);
  });
});
