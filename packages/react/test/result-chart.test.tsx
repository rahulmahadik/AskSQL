// @vitest-environment jsdom
/**
 * ResultChart SVG rendering: signed value domains so negative bars keep a real
 * height and negative line points stay inside the viewBox (not clamped to 0).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ResultChart } from '../src/ResultChart.js';
import type { ResultSet } from '@asksql/core';

afterEach(cleanup);

const H = 220;
const PAD_TOP = 12;
const PAD_BOTTOM = 40;
const PLOT_BOTTOM = H - PAD_BOTTOM; // 180

const rs = (columns: ResultSet['columns'], rows: ResultSet['rows']): ResultSet => ({
  columns,
  rows,
  rowCount: rows.length,
  truncated: false,
  durationMs: 1,
  warnings: [],
});

describe('ResultChart negative values', () => {
  it('all-negative bars keep a positive height and stay within the plot', () => {
    const { container } = render(
      <ResultChart
        result={rs(
          [
            { name: 'region', kind: 'text' },
            { name: 'net', kind: 'number' },
          ],
          [
            ['EU', -5],
            ['NA', -10],
          ],
        )}
      />,
    );
    const rects = Array.from(container.querySelectorAll('rect'));
    expect(rects.length).toBe(2);
    for (const r of rects) {
      const y = Number(r.getAttribute('y'));
      const h = Number(r.getAttribute('height'));
      expect(h).toBeGreaterThan(0);
      expect(y).toBeGreaterThanOrEqual(PAD_TOP - 0.001);
      expect(y + h).toBeLessThanOrEqual(PLOT_BOTTOM + 0.001);
    }
  });

  it('mixed-sign line points all stay inside the viewBox', () => {
    const { container } = render(
      <ResultChart
        result={rs(
          [
            { name: 'day', kind: 'date' },
            { name: 'delta', kind: 'number' },
          ],
          [
            ['2026-01-01', -8],
            ['2026-01-02', 6],
            ['2026-01-03', -3],
          ],
        )}
      />,
    );
    const polyline = container.querySelector('polyline')!;
    const ys = polyline
      .getAttribute('points')!
      .split(' ')
      .map((p) => Number(p.split(',')[1]));
    expect(ys).toHaveLength(3);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(PAD_TOP - 0.001);
      expect(y).toBeLessThanOrEqual(PLOT_BOTTOM + 0.001);
    }
    // A positive and a negative point must land on opposite sides of the zero baseline.
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0);
  });
});
