/** Chart-shape inference (pure). */
import { describe, expect, it } from 'vitest';
import { inferChart } from '../src/chart.js';
import type { ResultSet } from '@asksql/core';

const rs = (columns: ResultSet['columns'], rows: ResultSet['rows']): ResultSet => ({
  columns,
  rows,
  rowCount: rows.length,
  truncated: false,
  durationMs: 1,
  warnings: [],
});

describe('inferChart', () => {
  it('category + numeric -> bar', () => {
    const spec = inferChart(
      rs(
        [
          { name: 'region', kind: 'text' },
          { name: 'total', kind: 'number' },
        ],
        [
          ['EU', 100],
          ['NA', 250],
          ['APAC', 75],
        ],
      ),
    );
    expect(spec?.kind).toBe('bar');
    expect(spec?.labelColumn).toBe('region');
    expect(spec?.series[0]!.points.map((p) => p.value)).toEqual([100, 250, 75]);
  });

  it('date + numeric -> line', () => {
    const spec = inferChart(
      rs(
        [
          { name: 'day', kind: 'date' },
          { name: 'revenue', kind: 'bigint' },
        ],
        [
          ['2026-01-01', '10'],
          ['2026-01-02', '20'],
        ],
      ),
    );
    expect(spec?.kind).toBe('line');
  });

  it('multiple numeric columns -> multi-series', () => {
    const spec = inferChart(
      rs(
        [
          { name: 'region', kind: 'text' },
          { name: 'sales', kind: 'number' },
          { name: 'refunds', kind: 'number' },
        ],
        [
          ['EU', 100, 5],
          ['NA', 200, 8],
        ],
      ),
    );
    expect(spec?.series.length).toBe(2);
  });

  it('all-text result is not chartable', () => {
    expect(
      inferChart(
        rs(
          [
            { name: 'a', kind: 'text' },
            { name: 'b', kind: 'text' },
          ],
          [['x', 'y']],
        ),
      ),
    ).toBeNull();
  });

  it('single column is not chartable', () => {
    expect(inferChart(rs([{ name: 'n', kind: 'number' }], [[1]]))).toBeNull();
  });

  it('too many rows is not chartable', () => {
    const rows = Array.from({ length: 60 }, (_, i) => [`c${i}`, i]);
    expect(
      inferChart(
        rs(
          [
            { name: 'k', kind: 'text' },
            { name: 'v', kind: 'number' },
          ],
          rows,
        ),
      ),
    ).toBeNull();
  });

  it('zero rows is not chartable', () => {
    expect(
      inferChart(
        rs(
          [
            { name: 'k', kind: 'text' },
            { name: 'v', kind: 'number' },
          ],
          [],
        ),
      ),
    ).toBeNull();
  });
});
