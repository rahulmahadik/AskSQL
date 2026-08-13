import { describe, expect, it } from 'vitest';
import { nestedAggregate } from '../src/semantics.js';

describe('nestedAggregate', () => {
  /** Reported by a real question: AVG over a SUM is rejected by every engine. */
  it('flags an aggregate inside another aggregate', () => {
    const sql =
      'SELECT c.country, AVG(o.freight + SUM(od.unit_price)) AS v FROM orders o ' +
      'JOIN customers c ON o.customer_id = c.customer_id JOIN order_details od ON o.order_id = od.order_id GROUP BY c.country';
    expect(nestedAggregate(sql, 'Postgresql')).toBe('AVG');
  });

  it('allows aggregates side by side', () => {
    expect(nestedAggregate('SELECT SUM(a), AVG(b) FROM t', 'Postgresql')).toBeNull();
  });

  it('allows an aggregate over an expression', () => {
    expect(nestedAggregate('SELECT SUM(a * b + 1) FROM t', 'Postgresql')).toBeNull();
  });

  /** A subquery has its own scope, so its aggregate is not nested in the outer call. */
  it('allows an aggregate inside a subquery argument', () => {
    expect(nestedAggregate('SELECT SUM((SELECT COUNT(*) FROM u WHERE u.id = t.id)) FROM t', 'Postgresql')).toBeNull();
  });

  it('returns null for unparsable sql rather than blocking', () => {
    expect(nestedAggregate('NOT SQL AT ALL', 'Postgresql')).toBeNull();
  });

  it('flags nesting in HAVING', () => {
    expect(nestedAggregate('SELECT a FROM t GROUP BY a HAVING SUM(COUNT(b)) > 1', 'Postgresql')).toBe('SUM');
  });

  it('flags nesting in ORDER BY', () => {
    expect(nestedAggregate('SELECT a FROM t GROUP BY a ORDER BY AVG(SUM(b))', 'Postgresql')).toBe('AVG');
  });
});
