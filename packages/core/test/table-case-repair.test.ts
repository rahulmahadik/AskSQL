/**
 * The engine wiring for the catalog-driven case repair: a wrong-cased table must come back with a
 * corrected query, and must not spend a model round trip getting there.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAskSql, firstUnknownColumn, firstUnknownTable } from '../src/engine.js';
import { AskSqlError } from '../src/errors.js';
import { MYSQL_DIALECT, POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, ResultSet, SchemaCatalog } from '../src/types.js';

const CATALOG: SchemaCatalog = {
  engine: 'mysql',
  schemas: ['public'],
  tables: [
    {
      name: 'Users',
      kind: 'table',
      columns: [
        { name: 'id', dbType: 'bigint', nullable: false },
        { name: 'name', dbType: 'text', nullable: false },
      ],
      primaryKey: ['id'],
      foreignKeys: [],
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

function connThatRejects(detail: string, execute?: () => Promise<ResultSet>): Connector {
  return {
    // MySQL folds nothing, so generation leaves the case alone and the repair path is what runs.
    engine: 'mysql',
    dialect: MYSQL_DIALECT,
    capabilities: {
      supportsCancel: true,
      supportsExplain: true,
      supportsSchemas: true,
      readOnlySession: true,
      supportsMatViews: true,
      supportsTriggers: true,
      supportsRoutines: true,
    },
    id: 'db',
    name: 'DB',
    async connect() {},
    async close() {},
    async introspect() {
      return CATALOG;
    },
    execute:
      execute ??
      (async () => {
        throw new AskSqlError('DB_QUERY_ERROR', { userMessage: 'query failed', detail });
      }),
  } as unknown as Connector;
}

const modelSaying =
  (sql: string): CustomModel =>
  async () =>
    `\`\`\`sql\n${sql}\n\`\`\``;

describe('wrong-cased table repair', () => {
  it('suggests the catalog spelling when the database rejects the case', async () => {
    const conn = connThatRejects('relation "users" does not exist');
    const engine = createAskSql({ connectors: [conn], model: modelSaying('SELECT * FROM users') });

    const answer = await engine.ask('list the users');
    const err = await answer.run().catch((e: unknown) => e);

    expect(AskSqlError.is(err)).toBe(true);
    expect((err as { suggestedSql?: string }).suggestedSql).toContain('`Users`');
  });

  it('derives the fix from the catalog rather than a second model call', async () => {
    const model = vi.fn(async () => '```sql\nSELECT * FROM users\n```');
    const engine = createAskSql({
      connectors: [connThatRejects('relation "users" does not exist')],
      model: model as unknown as CustomModel,
    });

    await engine
      .ask('list the users')
      .then((a) => a.run())
      .catch(() => undefined);

    expect(model).toHaveBeenCalledTimes(1); // the ask itself, with no repair round trip
  });

  /** A failure the catalog cannot explain still belongs to the model repair. */
  it('leaves an unrelated database error to the model', async () => {
    const model = vi.fn(async () => '```sql\nSELECT * FROM `Users`\n```');
    const engine = createAskSql({
      connectors: [connThatRejects('column "nope" does not exist')],
      model: model as unknown as CustomModel,
    });

    await engine
      .ask('list the users')
      .then((a) => a.run())
      .catch(() => undefined);

    expect(model.mock.calls.length).toBeGreaterThan(1); // ask, then the repair attempt
  });

  it('does not suggest anything when the query already matches the catalog', async () => {
    let calls = 0;
    const conn = connThatRejects('', async () => {
      calls++;
      throw new AskSqlError('DB_QUERY_ERROR', { userMessage: 'boom', detail: 'deadlock detected' });
    });
    const engine = createAskSql({ connectors: [conn], model: modelSaying('SELECT * FROM `Users`') });

    const answer = await engine.ask('list the users');
    const err = await answer.run().catch((e: unknown) => e);

    expect(calls).toBe(1);
    expect((err as { suggestedSql?: string }).suggestedSql).toBeUndefined();
  });

  /** On a folding engine the query is corrected before it runs, so nothing has to fail first. */
  it('quotes a folded name at generation time on Postgres', async () => {
    const pg = {
      ...connThatRejects('unused'),
      engine: 'postgres',
      dialect: POSTGRES_DIALECT,
      async execute() {
        return { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1, warnings: [] };
      },
    } as unknown as Connector;
    const engine = createAskSql({ connectors: [pg], model: modelSaying('SELECT name FROM users') });

    const answer = await engine.ask('list the users');

    expect(answer.sql).toContain('"Users"');
  });
});

describe('unknown-column floor on set operations', () => {
  const catalog = {
    engine: 'sqlite',
    schemas: [],
    tables: [
      { name: 'Album', kind: 'table', columns: [{ name: 'AlbumId', dbType: 'int', nullable: false }], primaryKey: [], foreignKeys: [], uniques: [], checks: [], indexes: [], source: 'db' },
      { name: 'Artist', kind: 'table', columns: [{ name: 'ArtistId', dbType: 'int', nullable: false }], primaryKey: [], foreignKeys: [], uniques: [], checks: [], indexes: [], source: 'db' },
    ],
    enums: [], sequences: [], triggers: [], routines: [], warnings: [], fetchedAt: 'now',
  } as unknown as SchemaCatalog;

  /** Per-table row counts are a normal DBA question, and this blocked them outright. */
  it('does not flag a UNION ALL of per-table counts', () => {
    const sql =
      "SELECT 'Album' AS TableName, COUNT(*) AS RowCount FROM Album " +
      "UNION ALL SELECT 'Artist' AS TableName, COUNT(*) AS RowCount FROM Artist";

    expect(firstUnknownColumn(sql, catalog, 'sqlite')).toBeNull();
  });

  it('still flags a hallucinated column on a plain select', () => {
    expect(firstUnknownColumn('SELECT Nope FROM Album', catalog, 'sqlite')).not.toBeNull();
  });
});

describe('set-operation detection ignores literals', () => {
  const catalog = {
    engine: 'postgres',
    schemas: [],
    tables: [
      { name: 'notes', kind: 'table', columns: [{ name: 'body', dbType: 'text', nullable: false }], primaryKey: [], foreignKeys: [], uniques: [], checks: [], indexes: [], source: 'db' },
    ],
    enums: [], sequences: [], triggers: [], routines: [], warnings: [], fetchedAt: 'now',
  } as unknown as SchemaCatalog;

  /** A value containing "except" once disabled the column floor for an ordinary query. */
  it('still flags a hallucinated column when a literal contains a set-operation word', () => {
    const sql = "SELECT nope FROM notes WHERE body = 'except this'";
    expect(firstUnknownColumn(sql, catalog, 'Postgresql')).not.toBeNull();
  });

  it('still skips attribution for a real set operation', () => {
    const sql = "SELECT nope FROM notes UNION ALL SELECT body FROM notes";
    expect(firstUnknownColumn(sql, catalog, 'Postgresql')).toBeNull();
  });
});

describe('catalog-driven guards', () => {
  const base = {
    engine: 'postgres',
    schemas: [],
    enums: [], sequences: [], triggers: [], routines: [], warnings: [], fetchedAt: 'now',
  };
  const table = (name: string, cols: string[]) => ({
    name, kind: 'table',
    columns: cols.map((c) => ({ name: c, dbType: 'text', nullable: true })),
    primaryKey: [], foreignKeys: [], uniques: [], checks: [], indexes: [], source: 'db',
  });

  /** A quoted CTE was read as a hallucinated table, rejecting a valid query. */
  it('recognises a CTE whose name is quoted', () => {
    const catalog = { ...base, tables: [table('Orders', ['Amount'])] } as unknown as SchemaCatalog;
    const sql = 'WITH "Amount" AS (SELECT "Amount" FROM "Orders") SELECT * FROM "Amount"';

    expect(firstUnknownTable(sql, catalog, 'Postgresql')).toBeNull();
  });

  it('still reports a genuinely unknown table', () => {
    const catalog = { ...base, tables: [table('Orders', ['Amount'])] } as unknown as SchemaCatalog;
    expect(firstUnknownTable('SELECT * FROM nosuchtable', catalog, 'Postgresql')).toBe('nosuchtable');
  });
});
