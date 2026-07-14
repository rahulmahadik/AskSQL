/**
 * Chart-shape inference. Pure, DOM-free, unit-tested: decide whether
 * a ResultSet is chartable and as what. One category/label column + one or
 * more numeric columns -> bar; a temporal x-axis -> line. Everything else ->
 * not chartable (the table is the right view).
 */

import type { CellValue, ResultColumn, ResultSet } from '@asksql/core';

export type ChartKind = 'bar' | 'line';

export interface ChartSeries {
  readonly name: string;
  readonly points: readonly { readonly label: string; readonly value: number }[];
}

export interface ChartSpec {
  readonly kind: ChartKind;
  readonly labelColumn: string;
  readonly series: readonly ChartSeries[];
}

function toNumber(v: CellValue): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function isNumericColumn(result: ResultSet, idx: number): boolean {
  const kind = result.columns[idx]!.kind;
  if (kind === 'number' || kind === 'bigint' || kind === 'decimal') return true;
  // Fall back to sampling values.
  const sample = result.rows.slice(0, 20);
  if (sample.length === 0) return false;
  return sample.every((r) => r[idx] === null || toNumber(r[idx]!) !== null);
}

function isTemporal(col: ResultColumn): boolean {
  return col.kind === 'date' || col.kind === 'timestamp';
}

const MAX_BARS = 50;

/**
 * Infer a chart from a result, or null when a chart wouldn't help (no label
 * column, no numeric column, too many rows, all-text, etc.).
 */
export function inferChart(result: ResultSet): ChartSpec | null {
  if (result.rowCount === 0 || result.columns.length < 2) return null;
  if (result.rowCount > MAX_BARS) return null;

  const numericIdx: number[] = [];
  for (let i = 0; i < result.columns.length; i++)
    if (isNumericColumn(result, i)) numericIdx.push(i);
  if (numericIdx.length === 0) return null;

  // Label column = first non-numeric column, else the first column.
  let labelIdx = result.columns.findIndex((_, i) => !numericIdx.includes(i));
  if (labelIdx === -1) labelIdx = 0;
  const valueIdx = numericIdx.filter((i) => i !== labelIdx);
  if (valueIdx.length === 0) return null;

  const labelCol = result.columns[labelIdx]!;
  const kind: ChartKind = isTemporal(labelCol) ? 'line' : 'bar';

  const series: ChartSeries[] = valueIdx.slice(0, 4).map((ci) => ({
    name: result.columns[ci]!.name,
    points: result.rows.map((r) => ({
      label: r[labelIdx] === null ? '∅' : String(r[labelIdx]),
      value: toNumber(r[ci]!) ?? 0,
    })),
  }));

  return { kind, labelColumn: labelCol.name, series };
}
