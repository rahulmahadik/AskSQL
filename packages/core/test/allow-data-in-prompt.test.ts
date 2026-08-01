/**
 * `allowDataInPrompt` is the switch a regulated host flips so no cell value reaches a model.
 * Sampled values are the only real data a catalog carries, so the test is whether they get out.
 */
import { describe, expect, it } from 'vitest';
import { createAskSql } from '../src/engine.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import type { Connector, CustomModel, ResultSet, SchemaCatalog } from '../src/types.js';

const SECRET = 'ada@example.com';

const CATALOG: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['public'],
  tables: [
    {
      name: 'customers',
      kind: 'table',
      columns: [
        { name: 'id', dbType: 'bigint', nullable: false },
        // A connector that samples: this is real data out of somebody's table.
        { name: 'email', dbType: 'text', nullable: false, sampledValues: [SECRET, 'grace@example.com'] },
        // A declared enum is schema, written in the DDL - it must NOT be stripped.
        { name: 'region', dbType: 'text', nullable: true, enumValues: ['EU', 'NA'] },
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

class FakeConnector implements Connector {
  engine = 'postgres' as const;
  dialect = POSTGRES_DIALECT;
  capabilities = { supportsCancel: false, supportsExplain: true, readOnlySession: true, maxRowsHardCap: 1000 };
  id = 'c';
  name = 'c';
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async introspect(): Promise<SchemaCatalog> {
    return CATALOG;
  }
  async execute(): Promise<ResultSet> {
    return { columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 1 };
  }
}

/** Captures every prompt the engine sends, so the assertion is about what actually left. */
function recordingModel(): { model: CustomModel; sent: string[] } {
  const sent: string[] = [];
  const model: CustomModel = async ({ system, prompt }) => {
    sent.push(`${system}\n${prompt}`);
    return '```sql\nSELECT id FROM customers\n```';
  };
  return { model, sent };
}

describe('allowDataInPrompt gates real cell values', () => {
  it('does not send sampled values by default', async () => {
    const { model, sent } = recordingModel();
    const engine = createAskSql({ connectors: [new FakeConnector()], model });
    await engine.ask('how many customers');
    expect(sent.join('\n')).not.toContain(SECRET);
  });

  it('sends them once the host opts in', async () => {
    const { model, sent } = recordingModel();
    const engine = createAskSql({ connectors: [new FakeConnector()], model, allowDataInPrompt: true });
    await engine.ask('how many customers');
    expect(sent.join('\n')).toContain(SECRET);
  });

  it('keeps declared enum labels either way - they are schema, not data', async () => {
    for (const allowDataInPrompt of [false, true]) {
      const { model, sent } = recordingModel();
      const engine = createAskSql({ connectors: [new FakeConnector()], model, allowDataInPrompt });
      await engine.ask('how many customers');
      expect(sent.join('\n'), `enum labels missing with allowDataInPrompt=${allowDataInPrompt}`).toContain('EU');
    }
  });

  it('also keeps them out of a schema answer, not just the SQL prompt', async () => {
    const { model, sent } = recordingModel();
    const engine = createAskSql({ connectors: [new FakeConnector()], model });
    await engine.explainSchema('what is in this database?');
    expect(sent.join('\n')).not.toContain(SECRET);
  });

  it('drops them from the engine catalog itself, so no later code path can reintroduce them', async () => {
    const engine = createAskSql({ connectors: [new FakeConnector()], model: recordingModel().model });
    const catalog = await engine.catalog();
    // Deliberately stronger than filtering at each prompt builder: values a connector sampled
    // never enter the engine's catalog at all, so a future prompt cannot leak what is not there.
    expect(catalog.tables[0]!.columns.find((c) => c.name === 'email')?.sampledValues).toBeUndefined();
    expect(catalog.tables[0]!.columns.find((c) => c.name === 'region')?.enumValues).toEqual(['EU', 'NA']);
  });
});
