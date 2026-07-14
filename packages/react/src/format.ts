/** Pure result-cell formatting helpers (unit-tested, DOM-free). */

import type { CellValue, ResultColumn } from '@asksql/core';

export interface DisplayCell {
  readonly text: string;
  readonly kind: 'null' | 'binary' | 'json' | 'value';
  readonly title?: string;
}

const MAX_INLINE = 400;

export function formatCell(value: CellValue, _column?: ResultColumn): DisplayCell {
  if (value === null) return { text: 'NULL', kind: 'null', title: 'NULL (no value)' };
  if (typeof value === 'object' && '__binary' in value) {
    const b = value.__binary;
    return { text: `⬡ ${formatBytes(b.bytes)}`, kind: 'binary', title: `binary, ${b.bytes} bytes (0x${b.hexPreview}…)` };
  }
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', kind: 'value' };
  if (typeof value === 'number') return { text: String(value), kind: 'value' };
  const str = value;
  // Empty string is visually distinct from NULL.
  if (str === '') return { text: '(empty)', kind: 'null', title: 'empty string' };
  if (looksJson(str)) return { text: truncate(str), kind: 'json', title: str.length > MAX_INLINE ? str : undefined };
  return { text: truncate(str), kind: 'value', title: str.length > MAX_INLINE ? str : undefined };
}

function looksJson(s: string): boolean {
  const t = s.trimStart();
  return (t.startsWith('{') && s.trimEnd().endsWith('}')) || (t.startsWith('[') && s.trimEnd().endsWith(']'));
}

function truncate(s: string): string {
  return s.length > MAX_INLINE ? `${s.slice(0, MAX_INLINE)}…` : s;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** CSV export with correct quoting (raw values, no locale). */
export function toCsv(columns: readonly ResultColumn[], rows: readonly (readonly CellValue[])[]): string {
  const esc = (v: CellValue): string => {
    if (v === null) return '';
    if (typeof v === 'object' && '__binary' in v) return `0x${v.__binary.hexPreview}`;
    let s = typeof v === 'string' ? v : String(v);
    // Neutralize spreadsheet formula injection: a cell starting with = + - @
    // (or tab/CR) is executed as a formula by Excel/Sheets on open. Prefix
    // with a single quote so it opens as literal text.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.name)).join(',');
  const body = rows.map((r) => r.map(esc).join(',')).join('\n');
  return `${head}\n${body}`;
}
