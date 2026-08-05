/**
 * The webview draws its own charts (media/chat.js ships no imports), so the rule deciding what is
 * chartable exists twice: here and in `@asksql/react`'s chart.ts. This runs the React package's
 * own vectors against the webview copy, so a divergence fails here rather than showing a user a
 * chart in one surface and none in the other.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inferChart as reactInferChart } from '../../react/src/chart.js';
import type { ResultSet } from '@asksql/core';

const source = readFileSync(fileURLToPath(new URL('../media/chat.js', import.meta.url)), 'utf8');

/** Lift the webview's chart inference out of its IIFE so it can be called directly. */
function loadWebviewInferChart(): (columns: string[], kinds: string[], rows: unknown[][]) => unknown {
  const start = source.indexOf('const CHART_MAX_ROWS');
  const end = source.indexOf('const SVG_NS');
  expect(start, 'chart block not found in media/chat.js').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  return new Function(`${block}; return inferChart;`)() as ReturnType<typeof loadWebviewInferChart>;
}

const webviewInferChart = loadWebviewInferChart();

const rs = (columns: ResultSet['columns'], rows: ResultSet['rows']): ResultSet => ({
  columns,
  rows,
  rowCount: rows.length,
  truncated: false,
  durationMs: 1,
  warnings: [],
});

const CASES: readonly (readonly [string, ResultSet])[] = [
  [
    'category + numeric',
    rs(
      [
        { name: 'region', kind: 'text' },
        { name: 'total', kind: 'number' },
      ],
      [
        ['EU', 100],
        ['NA', 250],
      ],
    ),
  ],
  [
    'date + numeric',
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
  ],
  [
    'two numeric columns',
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
  ],
  [
    'all text',
    rs(
      [
        { name: 'a', kind: 'text' },
        { name: 'b', kind: 'text' },
      ],
      [['x', 'y']],
    ),
  ],
  ['single column', rs([{ name: 'n', kind: 'number' }], [[1]])],
  [
    'zero rows',
    rs(
      [
        { name: 'k', kind: 'text' },
        { name: 'v', kind: 'number' },
      ],
      [],
    ),
  ],
  [
    'too many rows',
    rs(
      [
        { name: 'k', kind: 'text' },
        { name: 'v', kind: 'number' },
      ],
      Array.from({ length: 60 }, (_, i) => [`c${i}`, i]),
    ),
  ],
  [
    'numbers arriving as text',
    rs(
      [
        { name: 'status', kind: 'text' },
        { name: 'orders', kind: 'text' },
      ],
      [
        ['open', '12'],
        ['closed', '30'],
      ],
    ),
  ],
];

describe('the webview chart rule matches the React one', () => {
  for (const [name, result] of CASES) {
    it(name, () => {
      const react = reactInferChart(result);
      const webview = webviewInferChart(
        result.columns.map((c) => c.name),
        result.columns.map((c) => c.kind),
        result.rows as unknown[][],
      ) as { kind?: string; series?: { name: string; points: { value: number }[] }[] } | null;

      expect(webview === null, `chartable disagreement for "${name}"`).toBe(react === null);
      if (!react || !webview) return;
      expect(webview.kind).toBe(react.kind);
      expect(webview.series?.length).toBe(react.series.length);
      expect(webview.series?.[0]?.points.map((p) => p.value)).toEqual(react.series[0]!.points.map((p) => p.value));
    });
  }
});
