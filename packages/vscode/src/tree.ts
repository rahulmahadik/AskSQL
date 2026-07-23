/**
 * Native schema explorer: Connections > tables/views > columns.
 *
 * A real TreeView (not a webview) so it themes, keyboard-navigates, and reads to
 * a screen reader like every other VS Code panel. It also doubles as the honest
 * answer to "what can I even ask about?" - the same catalog the model is given.
 */

import * as vscode from 'vscode';
import type { TableInfo } from '@asksql/core';
import type { EngineManager } from './engine.js';
import { connectionConfigs, type ConnectionConfig, type ConnectionScope } from './engine.js';
import { log } from './log.js';
import { userMessage } from './errors.js';

/** The kinds a catalog reports, in the order a person expects to see them. */
const GROUPS: readonly { readonly kind: TableInfo['kind']; readonly label: string; readonly icon: string }[] = [
  { kind: 'table', label: 'Tables', icon: 'table' },
  { kind: 'view', label: 'Views', icon: 'eye' },
  { kind: 'materialized_view', label: 'Materialized views', icon: 'database' },
];

export type Node =
  | { readonly kind: 'ai' }
  | { readonly kind: 'connection'; readonly conn: ConnectionConfig & { readonly scope: ConnectionScope } }
  | {
      readonly kind: 'group';
      readonly connId: string;
      readonly group: (typeof GROUPS)[number];
      readonly tables: readonly TableInfo[];
    }
  | { readonly kind: 'table'; readonly connId: string; readonly table: TableInfo }
  | {
      readonly kind: 'column';
      readonly connId: string;
      readonly tableKey: string;
      readonly label: string;
      readonly detail: string;
    }
  | { readonly kind: 'message'; readonly label: string };

/** Schema-qualified table key: table names repeat across schemas. */
const tableKeyOf = (t: TableInfo): string => `${t.schema ?? ''}.${t.name}`;

const ICON: Record<string, string> = {
  table: 'table',
  view: 'eye',
  materialized_view: 'eye',
};

export class SchemaTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly engines: EngineManager) {}

  /**
   * Drop the cached schema and redraw.
   *
   * The catalog is cached in EngineManager and NOWHERE else. A second cache here
   * is what made "Refresh Schema" a no-op: this class cleared its own copy, then
   * read straight back through to EngineManager's still-stale one, so a new
   * table never appeared until the window was reloaded.
   */
  refresh(): void {
    this.engines.invalidateCatalogs();
    this._onDidChange.fire(undefined);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'ai') {
      // The active AI at a glance, so "which model is answering?" is never a mystery.
      const cfg = vscode.workspace.getConfiguration('asksql');
      const provider = cfg.get<string>('provider') || 'ollama';
      const model = (cfg.get<string>('model') || '').trim();
      const item = new vscode.TreeItem('AI model', vscode.TreeItemCollapsibleState.None);
      item.id = 'asksql.ai';
      item.description = model ? `${provider} · ${model}` : `${provider} · no model selected`;
      item.iconPath = new vscode.ThemeIcon('sparkle');
      item.contextValue = 'asksql.ai';
      item.tooltip = model
        ? `Answering with ${provider} (${model}). Click to change the model.`
        : `No model selected for ${provider}. Click to choose one.`;
      // Clicking picks the answering model (VS Code chat model or your provider's).
      item.command = { command: 'asksql.pickModel', title: 'Choose Answering Model' };
      return item;
    }
    if (node.kind === 'connection') {
      const item = new vscode.TreeItem(node.conn.name, vscode.TreeItemCollapsibleState.Collapsed);
      // Ids must be stable and unique: VS Code falls back to the LABEL, and two
      // connections can share one (the wizard defaults the name to the engine).
      item.id = `conn:${node.conn.id}`;
      // Show the actual database/file being queried, not the settings scope - that
      // is what tells two same-engine connections apart. Engine leads, scope is in
      // the tooltip.
      const target =
        node.conn.engine === 'sqlite'
          ? ((node.conn.file ?? '').split(/[\\/]/).pop() ?? '')
          : (node.conn.database ?? '');
      item.description = [node.conn.engine, target].filter(Boolean).join(' · ');
      item.iconPath = new vscode.ThemeIcon('database');
      item.contextValue = 'asksql.connection';
      item.tooltip =
        `${node.conn.name} (${node.conn.engine})\n` +
        `${target ? `database: ${target}\n` : ''}` +
        `defined in: ${node.conn.scope} settings`;
      return item;
    }
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.group.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `group:${node.connId}:${node.group.kind}`;
      item.description = String(node.tables.length);
      item.iconPath = new vscode.ThemeIcon(node.group.icon);
      item.contextValue = 'asksql.group';
      return item;
    }
    if (node.kind === 'table') {
      const t = node.table;
      const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `table:${node.connId}:${tableKeyOf(t)}`;
      // Inside a "Tables"/"Views" group the kind is implied, so spend the
      // description on what actually differs: the schema and the column count.
      item.description = `${t.schema ? `${t.schema} · ` : ''}${t.columns.length} col${t.columns.length === 1 ? '' : 's'}`;
      item.iconPath = new vscode.ThemeIcon(ICON[t.kind] ?? 'table');
      item.contextValue = 'asksql.table';
      // Names come from the connected database (untrusted); appendText escapes
      // markdown so a crafted table/column name cannot inject a link or an image beacon.
      const tip = new vscode.MarkdownString();
      tip.appendText(`${t.schema ? `${t.schema}.` : ''}${t.name} (${t.kind.replace('_', ' ')})`);
      for (const c of t.columns) tip.appendText(`\n• ${c.name}  ${c.dbType}${c.nullable ? '' : ' not null'}`);
      item.tooltip = tip;
      return item;
    }
    if (node.kind === 'column') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      // `id`/`name`/`created_at` repeat in every table, so scope by table.
      item.id = `col:${node.connId}:${node.tableKey}:${node.label}`;
      item.description = node.detail;
      item.iconPath = new vscode.ThemeIcon('symbol-field');
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      // Return nothing when unconfigured: an empty view lets VS Code render the
      // `viewsWelcome` contribution, which gives the user real buttons instead
      // of a dead-end "nothing here" row.
      const conns = connectionConfigs();
      if (conns.length === 0) return [];
      // Lead with the active AI so it is visible above the databases; the welcome
      // still handles the first-run (no-connection) case above.
      return [{ kind: 'ai' }, ...conns.map((conn) => ({ kind: 'connection' as const, conn }))];
    }

    if (node.kind === 'connection') {
      try {
        const cat = await this.engines.catalogFor(node.conn.id);
        if (cat.tables.length === 0) return [{ kind: 'message', label: 'No tables found' }];
        // Group by kind. A flat list mixes a materialized view in among the
        // tables, and the two are not interchangeable when you are deciding
        // what to ask about.
        return GROUPS.flatMap((group) => {
          const tables = cat.tables.filter((t) => t.kind === group.kind);
          // No empty groups: "Views 0" is noise, not information.
          return tables.length ? [{ kind: 'group' as const, connId: node.conn.id, group, tables }] : [];
        });
      } catch (err) {
        // Say what to do, not what threw: a driver message here is unreadable in
        // a tree row and can carry the host and user name. Detail goes to the log.
        log.error(`could not read the schema of "${node.conn.id}"`, err);
        return [{ kind: 'message', label: userMessage(err) }];
      }
    }

    if (node.kind === 'group') {
      return node.tables.map((table) => ({ kind: 'table' as const, connId: node.connId, table }));
    }

    if (node.kind === 'table') {
      return node.table.columns.map((c) => {
        const pk = node.table.primaryKey.includes(c.name) ? ' PK' : '';
        const fk = node.table.foreignKeys.find((f) => f.columns.includes(c.name));
        return {
          kind: 'column',
          connId: node.connId,
          tableKey: tableKeyOf(node.table),
          label: c.name,
          detail: `${c.dbType}${pk}${fk ? ` FK ${fk.refTable}` : ''}${c.nullable ? '' : ' not null'}`,
        };
      });
    }
    return [];
  }
}
