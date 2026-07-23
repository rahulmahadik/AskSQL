import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetVscodeMock, setInspect, setConfig, MarkdownString } from './vscode-mock.js';
import { SchemaTreeProvider, type Node } from '../src/tree.js';
import type { ConnectionConfig, ConnectionScope } from '../src/engine.js';

beforeEach(() => resetVscodeMock());

/** A stand-in EngineManager exposing only what the tree calls. */
function fakeEngines(over: Partial<Record<'catalogFor' | 'invalidateCatalogs', unknown>> = {}) {
  return {
    catalogFor: vi.fn(async () => ({ tables: [] })),
    invalidateCatalogs: vi.fn(),
    ...over,
  } as never;
}

const conn = (over: Partial<ConnectionConfig> = {}): ConnectionConfig & { scope: ConnectionScope } => ({
  id: 'db1',
  name: 'DB One',
  engine: 'postgres',
  database: 'app',
  scope: 'user',
  ...over,
});

const table = {
  name: 'orders',
  schema: 'public',
  kind: 'table' as const,
  columns: [
    { name: 'id', dbType: 'int', nullable: false },
    { name: 'total', dbType: 'numeric', nullable: true },
  ],
  primaryKey: ['id'],
  foreignKeys: [{ columns: ['total'], refTable: 'money' }],
};

describe('SchemaTreeProvider.getChildren', () => {
  it('returns nothing when no connections (so viewsWelcome renders)', async () => {
    setInspect('connections', { global: [] });
    const tree = new SchemaTreeProvider(fakeEngines());
    expect(await tree.getChildren()).toEqual([]);
  });

  it('leads with the AI node then one node per connection', async () => {
    setInspect('connections', { global: [conn(), conn({ id: 'db2', name: 'DB Two' })] });
    const tree = new SchemaTreeProvider(fakeEngines());
    const roots = await tree.getChildren();
    expect(roots.map((n) => n.kind)).toEqual(['ai', 'connection', 'connection']);
  });

  it('groups a connection catalog by kind, skipping empty groups', async () => {
    setInspect('connections', { global: [conn()] });
    const cat = {
      tables: [table, { ...table, name: 'v', kind: 'view' as const }],
    };
    const tree = new SchemaTreeProvider(fakeEngines({ catalogFor: vi.fn(async () => cat) }));
    const groups = await tree.getChildren({ kind: 'connection', conn: conn() } as Node);
    expect(groups.map((g) => (g as { group: { label: string } }).group.label)).toEqual(['Tables', 'Views']);
  });

  it('shows a message row when a connection has no tables', async () => {
    setInspect('connections', { global: [conn()] });
    const tree = new SchemaTreeProvider(fakeEngines());
    const kids = await tree.getChildren({ kind: 'connection', conn: conn() } as Node);
    expect(kids).toEqual([{ kind: 'message', label: 'No tables found' }]);
  });

  it('shows a user message when reading the schema throws', async () => {
    setInspect('connections', { global: [conn()] });
    const engines = fakeEngines({
      catalogFor: vi.fn(async () => {
        throw { code: 'ECONNREFUSED' };
      }),
    });
    const tree = new SchemaTreeProvider(engines);
    const kids = await tree.getChildren({ kind: 'connection', conn: conn() } as Node);
    expect((kids[0] as { kind: string; label: string }).label).toMatch(/refused the connection/);
  });

  it('expands a group into tables and a table into columns', async () => {
    const group = {
      kind: 'group' as const,
      connId: 'db1',
      group: { kind: 'table', label: 'Tables', icon: 'table' },
      tables: [table],
    };
    const tree = new SchemaTreeProvider(fakeEngines());
    const tables = await tree.getChildren(group as Node);
    expect(tables).toEqual([{ kind: 'table', connId: 'db1', table }]);

    const cols = await tree.getChildren({ kind: 'table', connId: 'db1', table } as Node);
    expect(cols.map((c) => (c as { label: string }).label)).toEqual(['id', 'total']);
    // PK / FK / nullability are folded into the column detail.
    expect((cols[0] as { detail: string }).detail).toBe('int PK not null');
    expect((cols[1] as { detail: string }).detail).toBe('numeric FK money');
  });

  it('returns nothing for a leaf column node', async () => {
    const tree = new SchemaTreeProvider(fakeEngines());
    expect(await tree.getChildren({ kind: 'column', connId: 'x', tableKey: 't', label: 'c', detail: 'd' })).toEqual([]);
  });
});

describe('SchemaTreeProvider.getTreeItem', () => {
  it('renders the AI node with the current provider and model', () => {
    setConfig({ provider: 'openai', model: 'gpt-4o' });
    const tree = new SchemaTreeProvider(fakeEngines());
    const item = tree.getTreeItem({ kind: 'ai' });
    expect(item.description).toBe('openai · gpt-4o');
    expect((item.command as { command: string }).command).toBe('asksql.pickModel');
  });

  it('renders the AI node with a no-model hint when unset', () => {
    setConfig({ provider: 'ollama', model: '' });
    const tree = new SchemaTreeProvider(fakeEngines());
    expect(tree.getTreeItem({ kind: 'ai' }).description).toBe('ollama · no model selected');
  });

  it('renders a connection node with engine and database', () => {
    const tree = new SchemaTreeProvider(fakeEngines());
    const item = tree.getTreeItem({ kind: 'connection', conn: conn() });
    expect(item.description).toBe('postgres · app');
    expect(item.contextValue).toBe('asksql.connection');
    expect(item.id).toBe('conn:db1');
  });

  it('renders a sqlite connection using the file basename', () => {
    const tree = new SchemaTreeProvider(fakeEngines());
    const item = tree.getTreeItem({
      kind: 'connection',
      conn: conn({ engine: 'sqlite', database: undefined, file: '/data/app/mydb.sqlite' }),
    });
    expect(item.description).toBe('sqlite · mydb.sqlite');
  });

  it('renders a group node with its table count', () => {
    const tree = new SchemaTreeProvider(fakeEngines());
    const item = tree.getTreeItem({
      kind: 'group',
      connId: 'db1',
      group: { kind: 'table', label: 'Tables', icon: 'table' },
      tables: [table, table],
    });
    expect(item.description).toBe('2');
    expect(item.id).toBe('group:db1:table');
  });

  it('renders a table node with schema and column count, and an escaped tooltip', () => {
    const tree = new SchemaTreeProvider(fakeEngines());
    const item = tree.getTreeItem({ kind: 'table', connId: 'db1', table });
    expect(item.description).toBe('public · 2 cols');
    expect(item.tooltip).toBeInstanceOf(MarkdownString);
    expect((item.tooltip as MarkdownString).value).toContain('public.orders (table)');
    expect((item.tooltip as MarkdownString).value).toContain('id  int not null');
  });

  it('singularises the column count for a one-column table', () => {
    const tree = new SchemaTreeProvider(fakeEngines());
    const one = { ...table, columns: [table.columns[0]] };
    expect(tree.getTreeItem({ kind: 'table', connId: 'db1', table: one }).description).toBe('public · 1 col');
  });

  it('renders a column node with its detail', () => {
    const tree = new SchemaTreeProvider(fakeEngines());
    const item = tree.getTreeItem({
      kind: 'column',
      connId: 'db1',
      tableKey: 'public.orders',
      label: 'id',
      detail: 'int PK',
    });
    expect(item.label).toBe('id');
    expect(item.description).toBe('int PK');
    expect(item.id).toBe('col:db1:public.orders:id');
  });

  it('renders a message node', () => {
    const tree = new SchemaTreeProvider(fakeEngines());
    expect(tree.getTreeItem({ kind: 'message', label: 'nope' }).label).toBe('nope');
  });
});

describe('SchemaTreeProvider.refresh / dispose', () => {
  it('invalidates catalogs and fires the change event', () => {
    const engines = fakeEngines();
    const tree = new SchemaTreeProvider(engines);
    const listener = vi.fn();
    tree.onDidChangeTreeData(listener);
    tree.refresh();
    expect((engines as { invalidateCatalogs: ReturnType<typeof vi.fn> }).invalidateCatalogs).toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(undefined);
    expect(() => tree.dispose()).not.toThrow();
  });
});
