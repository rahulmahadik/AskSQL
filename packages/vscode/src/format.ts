/**
 * Tabular export shared by Export CSV and Copy as TSV. Local so this bundle does
 * not pull in the React package.
 */

import type { ResultSet } from '@asksql/core';

/** Excel/Sheets treat a cell starting with one of these as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;
/** A plain numeric literal - data, never a formula, so a negative amount stays a number. */
const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Renders one value and prefixes `'` when a spreadsheet would evaluate it. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return FORMULA_START.test(s) && !NUMERIC.test(s) ? `'${s}` : s;
}

/** Minimal RFC-4180 CSV. */
export function toCsv(res: ResultSet): string {
  const esc = (v: unknown): string => {
    const s = cell(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = res.columns.map((c) => esc(c.name)).join(',');
  const body = res.rows.map((r) => r.map(esc).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

/** Header row + all rows, for pasting into a sheet. */
export function toTsv(res: ResultSet): string {
  const esc = (v: unknown): string => {
    const s = cell(v);
    // Excel-style quoting: a tab or newline inside a cell must not break the grid.
    return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [res.columns.map((c) => esc(c.name)).join('\t'), ...res.rows.map((r) => r.map(esc).join('\t'))].join('\n');
}
