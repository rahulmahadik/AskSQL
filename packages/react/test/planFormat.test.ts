import { describe, expect, it } from 'vitest';
import { formatPlan } from '../src/useAskSql.js';
import type { ResultSet } from '@asksql/core';

const rs = (columns: string[], rows: unknown[][]): ResultSet =>
  ({
    columns: columns.map((name) => ({ name, kind: 'text' })),
    rows,
    rowCount: rows.length,
    truncated: false,
    durationMs: 1,
    warnings: [],
  }) as ResultSet;

describe('formatPlan', () => {
  it('shows only the plan text for DuckDB, never the explain_key label', () => {
    const plan = formatPlan(rs(['explain_key', 'explain_value'], [['physical_plan', '┌─ SEQ_SCAN ─┐']]));
    expect(plan).toBe('┌─ SEQ_SCAN ─┐');
    expect(plan).not.toContain('physical_plan');
  });

  it('keeps every line of a multi-row Postgres QUERY PLAN', () => {
    expect(formatPlan(rs(['QUERY PLAN'], [['Seq Scan on t'], ['  Filter: (a > 1)']]))).toBe(
      'Seq Scan on t\n  Filter: (a > 1)',
    );
  });

  it('matches the plan column case-insensitively', () => {
    expect(formatPlan(rs(['Query Plan'], [['Index Scan']]))).toBe('Index Scan');
  });

  it('falls back to joining columns when no plan column is recognisable (MySQL-style)', () => {
    expect(formatPlan(rs(['id', 'select_type', 'table'], [[1, 'SIMPLE', 'users']]))).toBe('1 SIMPLE users');
  });

  it('drops blank plan rows instead of leaving gaps', () => {
    expect(formatPlan(rs(['explain_value'], [['a'], ['   '], ['b']]))).toBe('a\nb');
  });

  it('returns an empty string for no rows, so the caller can say "(no plan returned)"', () => {
    expect(formatPlan(rs(['explain_value'], []))).toBe('');
  });

  it('renders a null cell as empty rather than the text "null"', () => {
    expect(formatPlan(rs(['a', 'b'], [[null, 'x']]))).toBe('x');
  });
});

/**
 * Regression: auto-run fires before React re-renders, so reading `collection`
 * from the turn ref returned undefined and every MongoDB question failed with
 * "A MongoDB query needs the collection it runs against."
 */
describe('doRun receives the collection from the sql event, not from stale state', () => {
  it('exposes collection on ChatEvent so the caller can pass it straight through', () => {
    const ev: import('../src/client.js').ChatEvent = {
      type: 'sql',
      sql: '[{"$limit":1}]',
      collection: 'orders',
      autoLimited: false,
    };
    expect(ev.collection).toBe('orders');
  });
});
