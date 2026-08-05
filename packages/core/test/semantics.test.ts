/**
 * The ungrouped-aggregate lint. This shape is rejected by PostgreSQL and by MySQL in strict mode,
 * and silently returns one arbitrary row in SQLite - so it is never the answer that was asked for.
 * A false positive costs a repair round on a correct query, so the negatives matter as much.
 */
import { describe, expect, it } from 'vitest';
import { fanOutAggregate, ungroupedAggregate } from '../src/semantics.js';

const pg = (sql: string) => ungroupedAggregate(sql, 'postgresql');

describe('an aggregate beside a bare column with no GROUP BY is caught', () => {
  it('the classic case', () => {
    expect(pg('SELECT status, count(*) FROM orders')).toBe('status');
  });

  it('aggregate first, column second', () => {
    expect(pg('SELECT count(*), status FROM orders')).toBe('status');
  });

  it('with a WHERE clause', () => {
    expect(pg("SELECT status, sum(total_cents) FROM orders WHERE status <> 'void'")).toBe('status');
  });

  it('with a qualified column', () => {
    expect(pg('SELECT o.status, count(*) FROM orders o')).toBe('status');
  });

  it('with an alias on the aggregate', () => {
    expect(pg('SELECT status, count(*) AS n FROM orders')).toBe('status');
  });

  it('other aggregate functions too', () => {
    expect(pg('SELECT region, avg(total_cents) FROM orders')).toBe('region');
    expect(pg('SELECT region, min(total_cents) FROM orders')).toBe('region');
  });
});

describe('correct SQL is left alone', () => {
  const FINE = [
    'SELECT status, count(*) FROM orders GROUP BY status',
    'SELECT count(*) FROM orders',
    'SELECT sum(total_cents) FROM orders',
    'SELECT status FROM orders',
    'SELECT * FROM orders',
    // A window function needs no GROUP BY - this is the shape a naive check breaks on.
    'SELECT status, count(*) OVER (PARTITION BY status) FROM orders',
    'SELECT id, sum(total_cents) OVER (ORDER BY placed_at) AS running FROM orders',
    // The aggregate belongs to the subquery, not to this select list.
    'SELECT status FROM orders WHERE total_cents > (SELECT avg(total_cents) FROM orders)',
    'SELECT o.status, x.n FROM orders o JOIN (SELECT customer_id, count(*) AS n FROM orders GROUP BY customer_id) x ON x.customer_id = o.customer_id',
    // Grouping by an expression still counts as grouped.
    "SELECT date_trunc('month', placed_at), count(*) FROM orders GROUP BY 1",
    // Only columns inside the aggregate: nothing bare to group by.
    'SELECT count(DISTINCT customer_id) FROM orders',
  ];
  for (const sql of FINE) {
    it(`no complaint: ${sql.slice(0, 58)}`, () => {
      expect(pg(sql)).toBeNull();
    });
  }
});

describe('it never reports on SQL it cannot parse', () => {
  it('returns null rather than guessing', () => {
    expect(pg('SELECT status count(*) FROM orders GROUP BY')).toBeNull();
    expect(pg('not sql at all')).toBeNull();
  });
});

describe('other dialects', () => {
  it('catches the same shape in MySQL and SQLite grammars', () => {
    expect(ungroupedAggregate('SELECT status, count(*) FROM orders', 'mysql')).toBe('status');
    expect(ungroupedAggregate('SELECT status, count(*) FROM orders', 'sqlite')).toBe('status');
  });
});

describe('a one-to-many join that inflates a SUM', () => {
  const catalog = {
    tables: [
      { name: 'customers', foreignKeys: [] },
      { name: 'orders', foreignKeys: [{ refTable: 'customers' }] },
      { name: 'order_items', foreignKeys: [{ refTable: 'orders' }] },
    ],
  };
  const check = (sql: string) => fanOutAggregate(sql, 'postgresql', catalog);

  it('flags a parent total summed across its child rows', () => {
    const sql =
      'SELECT c.id, SUM(o.total_cents) FROM customers c JOIN orders o ON c.id=o.customer_id JOIN order_items oi ON o.id=oi.order_id GROUP BY c.id';
    expect(check(sql)).toEqual({ column: 'total_cents', parent: 'orders', child: 'order_items' });
  });

  it('leaves correct queries alone', () => {
    for (const sql of [
      'SELECT SUM(total_cents) FROM orders',
      'SELECT c.id, SUM(o.total_cents) FROM customers c JOIN orders o ON c.id=o.customer_id GROUP BY c.id',
      'SELECT o.id, SUM(oi.qty) FROM orders o JOIN order_items oi ON o.id=oi.order_id GROUP BY o.id',
      'SELECT c.id, COUNT(*) FROM customers c JOIN orders o ON c.id=o.customer_id GROUP BY c.id',
      'SELECT c.id, SUM(DISTINCT o.total_cents) FROM customers c JOIN orders o ON c.id=o.customer_id JOIN order_items oi ON o.id=oi.order_id GROUP BY c.id',
    ]) {
      expect(check(sql), sql).toBeNull();
    }
  });

  it('reports nothing for SQL it cannot parse', () => {
    expect(check('not sql at all')).toBeNull();
  });
});

describe('shapes the fan-out check must not misread', () => {
  const catalog = {
    tables: [
      { name: 'customers', foreignKeys: [] },
      { name: 'orders', foreignKeys: [{ refTable: 'customers' }] },
      { name: 'order_items', foreignKeys: [{ refTable: 'orders' }] },
    ],
  };
  const check = (sql: string) => fanOutAggregate(sql, 'postgresql', catalog);

  it('flags AVG as well as SUM, since both are averaged over multiplied rows', () => {
    const sql =
      'SELECT c.id, AVG(o.total_cents) FROM customers c JOIN orders o ON c.id=o.customer_id JOIN order_items oi ON o.id=oi.order_id GROUP BY c.id';
    expect(check(sql)?.column).toBe('total_cents');
  });

  it('ignores a windowed aggregate, which is computed per row rather than per group', () => {
    const sql =
      'SELECT o.id, SUM(o.total_cents) OVER (PARTITION BY o.customer_id) FROM customers c JOIN orders o ON c.id=o.customer_id JOIN order_items oi ON o.id=oi.order_id';
    expect(check(sql)).toBeNull();
  });

  it('resolves the table through its alias and through its own name', () => {
    const aliased =
      'SELECT SUM(o.total_cents) FROM customers c JOIN orders o ON c.id=o.customer_id JOIN order_items oi ON o.id=oi.order_id';
    const unaliased =
      'SELECT SUM(orders.total_cents) FROM customers JOIN orders ON customers.id=orders.customer_id JOIN order_items ON orders.id=order_items.order_id';
    expect(check(aliased)?.parent).toBe('orders');
    expect(check(unaliased)?.parent).toBe('orders');
  });

  it('says nothing about a table the catalog does not describe', () => {
    const sql = 'SELECT SUM(a.amount) FROM unknown_a a JOIN unknown_b b ON a.id=b.a_id';
    expect(check(sql)).toBeNull();
  });

  it('does not read a subquery aggregate as the outer query\'s', () => {
    const sql =
      'SELECT c.id, (SELECT SUM(o.total_cents) FROM orders o WHERE o.customer_id=c.id) AS total FROM customers c JOIN order_items oi ON oi.order_id=c.id';
    expect(check(sql)).toBeNull();
  });

  it('an unqualified aggregate names no table, so nothing is claimed', () => {
    const sql = 'SELECT SUM(total_cents) FROM orders JOIN order_items ON orders.id=order_items.order_id';
    expect(check(sql)).toBeNull();
  });
});
