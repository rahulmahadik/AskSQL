/**
 * Column-level hallucination floor (firstUnknownColumn). A column attributed to
 * a real base table must exist on it; everything ambiguous fails open so a valid
 * query is never blocked. Organized as rounds of edge cases.
 */
import { describe, expect, it } from 'vitest';
import { firstUnknownColumn } from '../src/engine.js';
import type { SchemaCatalog, TableInfo } from '../src/types.js';

function tbl(name: string, cols: string[], schema?: string): TableInfo {
  return {
    name,
    schema,
    kind: 'table',
    columns: cols.map((c) => ({ name: c, dbType: 'text', nullable: true })),
    primaryKey: [],
    foreignKeys: [],
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
const CAT = cat([
  tbl('services', ['service_id', 'service_name', 'service_price', 'is_active']),
  tbl('appointments', ['appointment_id', 'client_id', 'employee_id', 'service_id', 'canceled', 'start_time']),
  tbl('employees', ['employee_id', 'first_name', 'last_name']),
  tbl('clients', ['client_id', 'first_name', 'last_name']),
]);
const find = (sql: string, c: SchemaCatalog = CAT) => firstUnknownColumn(sql, c, 'mysql');

describe('firstUnknownColumn - round 1: basic detection', () => {
  it('flags a hallucinated column on a table', () => {
    // Single base table: an unqualified invented column is now attributable and caught.
    expect(find('SELECT is_canceled FROM appointments')?.column).toBe('is_canceled');
    expect(find('SELECT appointments.is_canceled FROM appointments')?.column).toBe('is_canceled');
  });
  it('passes a valid qualified column', () => {
    expect(find('SELECT appointments.canceled FROM appointments')).toBeNull();
  });
  it('flags the common mis-guess (services.id vs service_id)', () => {
    const r = find('SELECT services.id FROM services');
    expect(r?.table).toBe('services');
    expect(r?.column).toBe('id');
    expect(r?.available).toContain('service_id');
  });
});

describe('firstUnknownColumn - round 2: alias resolution', () => {
  it('resolves an alias to the real table and flags a bad column', () => {
    expect(find('SELECT s.id FROM services s')?.column).toBe('id');
    expect(find('SELECT a.is_canceled FROM appointments a')?.column).toBe('is_canceled');
  });
  it('passes a valid aliased column', () => {
    expect(find('SELECT s.service_name FROM services s')).toBeNull();
  });
  it('flags a column qualified to the wrong table in a join', () => {
    // canceled lives on appointments, not services -> s.canceled is wrong
    expect(find('SELECT s.canceled FROM services s JOIN appointments a ON a.service_id = s.service_id')?.column).toBe(
      'canceled',
    );
  });
  it('passes every column correctly qualified across a 4-table join', () => {
    const sql = `SELECT c.first_name, e.last_name, s.service_name, a.start_time
      FROM appointments a
      JOIN clients c ON a.client_id = c.client_id
      JOIN employees e ON a.employee_id = e.employee_id
      JOIN services s ON a.service_id = s.service_id
      WHERE a.canceled = 0`;
    expect(find(sql)).toBeNull();
  });
});

describe('firstUnknownColumn - round 3: fail-open (never block a valid query)', () => {
  it('catches an unqualified invented column when there is exactly one base table', () => {
    expect(find('SELECT service_name, made_up_col FROM services')?.column).toBe('made_up_col');
  });
  it('catches an unqualified invented column across a join when every table is known', () => {
    expect(
      find('SELECT made_up_col FROM appointments JOIN services ON appointments.service_id = services.service_id')
        ?.column,
    ).toBe('made_up_col');
  });
  it('fails open on an unqualified column when a joined table is not in the catalog', () => {
    expect(
      find('SELECT made_up_col FROM services JOIN bookings ON services.service_id = bookings.service_id'),
    ).toBeNull();
  });
  it('allows an unqualified column that belongs to the other joined table', () => {
    expect(
      find('SELECT first_name FROM appointments JOIN employees ON appointments.employee_id = employees.employee_id'),
    ).toBeNull();
  });
  it('does not flag a SELECT alias used in ORDER BY / HAVING', () => {
    expect(find('SELECT count(*) AS n FROM services ORDER BY n DESC')).toBeNull();
    expect(find('SELECT service_name AS s FROM services ORDER BY s')).toBeNull();
  });
  it('ignores SELECT * and table.*', () => {
    expect(find('SELECT * FROM services')).toBeNull();
    expect(find('SELECT s.* FROM services s')).toBeNull();
  });
  it('ignores CTE-qualified columns (the CTE defines its own columns)', () => {
    expect(find('WITH t AS (SELECT service_id AS sid FROM services) SELECT t.sid FROM t')).toBeNull();
    expect(find('WITH t AS (SELECT service_id AS sid FROM services) SELECT t.anything FROM t')).toBeNull();
  });
  it('ignores derived/subquery-alias columns', () => {
    expect(find('SELECT sub.x FROM (SELECT 1 AS x) sub')).toBeNull();
    expect(find('SELECT sub.whatever FROM (SELECT service_id FROM services) sub')).toBeNull();
  });
  it('ignores tables not present in the catalog (pruning must not cause blocks)', () => {
    expect(find('SELECT bogus.col FROM bogus')).toBeNull();
  });
  it('returns null on a parse failure', () => {
    expect(find('this is not sql ;;;')).toBeNull();
  });
});

describe('firstUnknownColumn - round 4: structural coverage', () => {
  it('checks columns inside function calls', () => {
    expect(find('SELECT COUNT(a.appointment_id) FROM appointments a')).toBeNull();
    expect(find('SELECT COUNT(a.made_up) FROM appointments a')?.column).toBe('made_up');
  });
  it('checks WHERE / GROUP BY / ORDER BY column refs', () => {
    expect(find('SELECT s.service_name FROM services s WHERE s.nope > 0')?.column).toBe('nope');
    expect(find('SELECT s.service_id FROM services s GROUP BY s.ghost')?.column).toBe('ghost');
    expect(find('SELECT s.service_id FROM services s ORDER BY s.phantom')?.column).toBe('phantom');
  });
  it('checks a subquery in WHERE', () => {
    const sql = 'SELECT c.first_name FROM clients c WHERE c.client_id IN (SELECT a.bad_col FROM appointments a)';
    expect(find(sql)?.column).toBe('bad_col');
  });
  it('handles UNION of two selects', () => {
    expect(find('SELECT s.service_name FROM services s UNION SELECT e.first_name FROM employees e')).toBeNull();
    expect(find('SELECT s.service_name FROM services s UNION SELECT e.oops FROM employees e')?.column).toBe('oops');
  });
});

describe('firstUnknownColumn - round 5: robustness', () => {
  it('is case-insensitive for tables and columns', () => {
    expect(find('SELECT S.Service_Name FROM Services S')).toBeNull();
    expect(find('SELECT S.Made_Up FROM Services S')?.column).toBe('made_up');
  });
  it('ignores system-catalog references', () => {
    expect(find('SELECT information_schema.columns.column_name FROM information_schema.columns')).toBeNull();
  });
  it('unions columns for a table name that exists in two schemas', () => {
    const c = cat([tbl('orders', ['id', 'a'], 'shop'), tbl('orders', ['id', 'b'], 'archive')]);
    // a exists in shop.orders, b in archive.orders - both should pass (union)
    expect(firstUnknownColumn('SELECT orders.a FROM orders', c, 'mysql')).toBeNull();
    expect(firstUnknownColumn('SELECT orders.b FROM orders', c, 'mysql')).toBeNull();
    // c exists in neither -> flagged
    expect(firstUnknownColumn('SELECT orders.c FROM orders', c, 'mysql')?.column).toBe('c');
  });
  it('returns null against an empty catalog', () => {
    expect(firstUnknownColumn('SELECT s.id FROM services s', cat([]), 'mysql')).toBeNull();
  });
  it('returns the first offender only', () => {
    const r = find('SELECT s.bad1, s.bad2 FROM services s');
    expect(r?.column).toBe('bad1');
  });
});

describe('firstUnknownColumn - round 7: adversarial / production hardening', () => {
  it('resolves self-joins per alias', () => {
    const sql =
      'SELECT e1.first_name, e2.last_name FROM employees e1 JOIN employees e2 ON e1.employee_id = e2.employee_id';
    expect(find(sql)).toBeNull();
    const bad =
      'SELECT e1.first_name, e2.made_up FROM employees e1 JOIN employees e2 ON e1.employee_id = e2.employee_id';
    expect(find(bad)?.column).toBe('made_up');
  });
  it('checks columns inside window functions and CASE expressions', () => {
    expect(find('SELECT s.service_name, ROW_NUMBER() OVER (PARTITION BY s.service_id) FROM services s')).toBeNull();
    expect(find('SELECT CASE WHEN s.service_id > 0 THEN 1 ELSE 0 END FROM services s')).toBeNull();
    expect(find('SELECT CASE WHEN s.nope > 0 THEN 1 ELSE 0 END FROM services s')?.column).toBe('nope');
  });
  it('fails open on USING joins (unqualified) and quoted identifiers', () => {
    expect(find('SELECT service_name FROM services JOIN appointments USING(service_id)')).toBeNull();
    expect(find('SELECT `s`.`service_name` FROM services s')).toBeNull();
  });
  it('fails open on a non-SELECT statement (the guard blocks those anyway)', () => {
    expect(find('UPDATE services SET service_name = 1')).toBeNull();
  });
});
