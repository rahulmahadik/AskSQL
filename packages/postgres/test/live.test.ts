/**
 * Live PostgreSQL connector tests against the shop fixture.
 * Requires a reachable Postgres; set ASKSQL_PG_URL or rely on the default
 * local test database. Skips (not fails) when unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresConnector } from '../src/index.js';
import { guardSql, POSTGRES_DIALECT, AskSqlError } from '@asksql/core';

const URL = process.env['ASKSQL_PG_URL'] ?? 'postgres://postgres:root@localhost:5432/asksql_test';

let available = true;
const conn = new PostgresConnector({ id: 'pg', name: 'Shop DB', connectionString: URL });

beforeAll(async () => {
  try {
    await conn.connect();
  } catch {
    available = false;
  }
});
afterAll(async () => {
  await conn.close();
});

const maybe = (name: string, fn: () => Promise<void> | void) =>
  it(name, async () => {
    if (!available) {
      console.warn('[skip] Postgres not reachable at', URL);
      return;
    }
    await fn();
  });

describe('INT - introspection covers every object type', () => {
  maybe('finds tables, views, and the materialized view', async () => {
    const cat = await conn.introspect();
    const names = new Map(cat.tables.map((t) => [`${t.schema}.${t.name}`, t]));
    expect(names.get('shop.customers')?.kind).toBe('table');
    expect(names.get('shop.orders')?.kind).toBe('table');
    expect(names.get('shop.paid_orders')?.kind).toBe('view');
    expect(names.get('shop.revenue_by_region')?.kind).toBe('materialized_view');
  });

  maybe('captures PK, FK join graph, checks, uniques', async () => {
    const cat = await conn.introspect();
    const orders = cat.tables.find((t) => t.name === 'orders')!;
    expect(orders.primaryKey).toEqual(['id']);
    const fk = orders.foreignKeys.find((f) => f.refTable === 'customers');
    expect(fk?.columns).toEqual(['customer_id']);
    expect(orders.checks.join(' ')).toMatch(/total_cents/);
    const customers = cat.tables.find((t) => t.name === 'customers')!;
    expect(customers.uniques.flat()).toContain('email');
  });

  maybe('enum values, comments, generated columns', async () => {
    const cat = await conn.introspect();
    const orders = cat.tables.find((t) => t.name === 'orders')!;
    const status = orders.columns.find((c) => c.name === 'status')!;
    expect(status.enumValues).toEqual(['pending', 'paid', 'shipped', 'cancelled']);
    const net = orders.columns.find((c) => c.name === 'net_cents')!;
    expect(net.generated).toBe(true);
    const customers = cat.tables.find((t) => t.name === 'customers')!;
    expect(customers.comment).toMatch(/place orders/i);
    expect(customers.columns.find((c) => c.name === 'region')!.comment).toMatch(/region code/i);
  });

  maybe('indexes: partial + expression + unique captured', async () => {
    const cat = await conn.introspect();
    const orders = cat.tables.find((t) => t.name === 'orders')!;
    const partial = orders.indexes.find((i) => i.predicate);
    expect(partial?.predicate).toMatch(/cancelled/);
    const customers = cat.tables.find((t) => t.name === 'customers')!;
    expect(customers.indexes.some((i) => /lower/i.test(i.definition ?? ''))).toBe(true);
  });

  maybe('triggers with timing + events', async () => {
    const cat = await conn.introspect();
    const trg = cat.triggers.find((t) => t.name === 'trg_orders_touch')!;
    expect(trg.table).toBe('orders');
    expect(trg.timing).toBe('BEFORE');
    expect(trg.events).toContain('UPDATE');
  });

  maybe('functions with volatility (callable vs not)', async () => {
    const cat = await conn.introspect();
    const stable = cat.routines.find((r) => r.name === 'customer_order_count')!;
    expect(stable.volatility).toBe('stable');
    const volatile = cat.routines.find((r) => r.name === 'touch_now')!;
    expect(volatile.volatility).toBe('volatile');
  });

  maybe('enums + sequences present', async () => {
    const cat = await conn.introspect();
    expect(cat.enums.find((e) => e.name === 'order_status')?.values).toContain('shipped');
    expect(cat.sequences.some((s) => s.name === 'invoice_seq')).toBe(true);
  });
});

describe('EXE - execution, fidelity, read-only, cancel', () => {
  maybe('runs a join + aggregate', async () => {
    const res = await conn.execute(
      'SELECT c.full_name, count(o.id) AS orders FROM shop.customers c LEFT JOIN shop.orders o ON o.customer_id=c.id GROUP BY 1 ORDER BY 1',
      { maxRows: 100 },
    );
    expect(res.columns.map((c) => c.name)).toEqual(['full_name', 'orders']);
    expect(res.rowCount).toBe(3);
  });

  maybe('BIGINT fidelity preserved as string', async () => {
    const res = await conn.execute('SELECT total_cents FROM shop.orders ORDER BY total_cents DESC LIMIT 1');
    const cell = res.rows[0]![0]!;
    expect(res.columns[0]!.kind).toBe('bigint');
    expect(cell).toBe('999999999999'); // exact, not 1e12
    expect(typeof cell).toBe('string');
  });

  maybe('NUMERIC fidelity preserved as string', async () => {
    const res = await conn.execute(
      'SELECT tax_amount FROM shop.orders WHERE tax_amount > 0 ORDER BY tax_amount DESC LIMIT 1',
    );
    expect(res.columns[0]!.kind).toBe('decimal');
    expect(res.rows[0]![0]).toBe('12.50');
  });

  maybe('row cap truncates + flags', async () => {
    const res = await conn.execute('SELECT * FROM shop.orders', { maxRows: 2 });
    expect(res.rowCount).toBe(2);
    expect(res.truncated).toBe(true);
  });

  maybe('SEC/read-only session rejects writes at the DB', async () => {
    // Bypass the guard entirely: prove the DB session itself blocks writes.
    await expect(conn.execute("INSERT INTO shop.customers (email, full_name) VALUES ('x@y.z','x')")).rejects.toThrow();
  });

  maybe('statement timeout maps to DB_TIMEOUT', async () => {
    try {
      await conn.execute('SELECT pg_sleep(3)', { timeoutMs: 300 });
      throw new Error('should have timed out');
    } catch (err) {
      expect(AskSqlError.is(err)).toBe(true);
      expect((err as AskSqlError).code).toBe('DB_TIMEOUT');
    }
  });

  maybe('cancel via AbortSignal maps to CANCELLED', async () => {
    const ac = new AbortController();
    const p = conn.execute('SELECT pg_sleep(5)', { signal: ac.signal, timeoutMs: 10_000 });
    setTimeout(() => ac.abort(), 200);
    try {
      await p;
      throw new Error('should have cancelled');
    } catch (err) {
      expect((err as AskSqlError).code).toBe('CANCELLED');
    }
  });

  maybe('duplicate column names preserved', async () => {
    const res = await conn.execute('SELECT id, id FROM shop.customers LIMIT 1');
    expect(res.columns).toHaveLength(2);
    expect(res.rows[0]).toHaveLength(2);
  });

  maybe('guard + execute integration: generated SELECT is capped', async () => {
    const v = guardSql({ sql: 'SELECT * FROM shop.customers', dialect: POSTGRES_DIALECT, policy: { maxRows: 2 } });
    expect(v.allowed).toBe(true);
    const res = await conn.execute(v.sql);
    expect(res.rowCount).toBeLessThanOrEqual(2);
  });
});
