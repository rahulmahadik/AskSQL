/**
 * SchemaBrowser - a compact, searchable tree of the connection's
 * objects so users can see what they're allowed to ask about: tables, views,
 * columns (with PK/FK/enum hints), plus triggers, indexes and functions.
 * Read-only; DDL is shown, never editable (schema management is a non-goal).
 */

import { useMemo, useState, type JSX } from 'react';
import type { SchemaCatalog, TableInfo } from '@asksql/core';

export interface SchemaBrowserProps {
  readonly catalog: SchemaCatalog;
  /** Called when a table row is clicked (e.g. to seed a question). */
  readonly onPick?: (table: TableInfo) => void;
}

export function SchemaBrowser({ catalog, onPick }: SchemaBrowserProps): JSX.Element {
  const [q, setQ] = useState('');
  const multiSchema = catalog.schemas.length > 1;

  const tables = useMemo(() => {
    const term = q.trim().toLowerCase();
    const visible = catalog.tables.filter((t) => !t.partitionOf);
    if (!term) return visible;
    return visible.filter(
      (t) =>
        t.name.toLowerCase().includes(term) ||
        (t.schema ?? '').toLowerCase().includes(term) ||
        t.columns.some((c) => c.name.toLowerCase().includes(term)),
    );
  }, [catalog.tables, q]);

  if (catalog.tables.length === 0) {
    return (
      <div className="asksql-empty">
        <p>No tables found. Check permissions or upload a file.</p>
      </div>
    );
  }

  return (
    <div className="asksql-schema">
      <input
        className="asksql-schema-search"
        placeholder="Search tables & columns..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search schema"
      />
      <div className="asksql-schema-list">
        {tables.length === 0 && <div className="asksql-meta">No matches.</div>}
        {tables.map((t) => (
          <TableNode key={`${t.schema ?? ''}.${t.name}`} table={t} multiSchema={multiSchema} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

function TableNode({
  table,
  multiSchema,
  onPick,
}: {
  table: TableInfo;
  multiSchema: boolean;
  onPick?: (t: TableInfo) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const name = multiSchema && table.schema ? `${table.schema}.${table.name}` : table.name;
  const icon = table.kind === 'view' ? '⊞' : table.kind === 'materialized_view' ? '⊟' : '▦';
  return (
    <div className="asksql-schema-node">
      <div className="asksql-schema-row">
        <button
          className="asksql-schema-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`Toggle ${name}`}
        >
          {open ? '▾' : '▸'} <span className="asksql-schema-icon">{icon}</span> {name}
          {table.source === 'file' && <em className="asksql-schema-tag"> file</em>}
        </button>
        {onPick && (
          <button
            className="asksql-btn asksql-schema-use"
            style={{ padding: '1px 6px', fontSize: 11 }}
            onClick={() => onPick(table)}
          >
            Ask
          </button>
        )}
      </div>
      {open && (
        <div className="asksql-schema-cols">
          {table.columns.map((c) => {
            const isPk = table.primaryKey.includes(c.name);
            const fk = table.foreignKeys.find((f) => f.columns.includes(c.name));
            return (
              <div key={c.name} className="asksql-schema-col">
                <span className="asksql-schema-colname">{c.name}</span>
                <span className="asksql-schema-coltype">{c.dbType}</span>
                {isPk && <span className="asksql-schema-badge">PK</span>}
                {fk && <span className="asksql-schema-badge">FK→{fk.refTable}</span>}
                {c.enumValues && c.enumValues.length > 0 && (
                  <span className="asksql-schema-enum" title={c.enumValues.join(', ')}>
                    enum
                  </span>
                )}
                {!c.nullable && <span className="asksql-schema-req">required</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
