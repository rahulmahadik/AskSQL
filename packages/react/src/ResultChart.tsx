/**
 * ResultChart - renders an inferred {@link ChartSpec} as inline,
 * theme-aware SVG. No external charting dependency (keeps the bundle small);
 * colors come from the same CSS variables as the rest of the UI.
 */

import { useMemo, type JSX } from 'react';
import type { ResultSet } from '@asksql/core';
import { inferChart, type ChartSpec } from './chart.js';

const SERIES_COLORS = ['var(--aq-accent)', '#0ea5e9', '#10b981', '#f59e0b'];

export function ResultChart({ result }: { result: ResultSet }): JSX.Element | null {
  const spec = useMemo(() => inferChart(result), [result]);
  if (!spec) return null;
  return spec.kind === 'bar' ? <BarChart spec={spec} /> : <LineChart spec={spec} />;
}

/** True when a result can be charted (drives showing a chart toggle). */
export function isChartable(result: ResultSet): boolean {
  return inferChart(result) !== null;
}

const W = 520;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 40, left: 44 };

/** Signed value domain with a zero baseline, so negative bars/points render correctly. */
function scaleDomain(spec: ChartSpec): { min: number; max: number } {
  const values = spec.series.flatMap((s) => s.points.map((p) => p.value));
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  // Never let the range collapse to 0 (all-zero series).
  return { min, max: max === min ? max + 1 : max };
}

function BarChart({ spec }: { spec: ChartSpec }): JSX.Element {
  const { min, max } = scaleDomain(spec);
  const range = max - min;
  const labels = spec.series[0]!.points.map((p) => p.label);
  const groupW = (W - PAD.left - PAD.right) / labels.length;
  const barW = Math.max(2, (groupW * 0.8) / spec.series.length);
  const plotH = H - PAD.top - PAD.bottom;
  const yOf = (v: number) => PAD.top + ((max - v) / range) * plotH;
  const zeroY = yOf(0);

  return (
    <figure
      className="asksql-chart"
      role="img"
      aria-label={`Bar chart of ${spec.series.map((s) => s.name).join(', ')} by ${spec.labelColumn}`}
    >
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet">
        <Axes min={min} max={max} plotH={plotH} zeroY={zeroY} />
        {labels.map((label, li) => (
          <g key={li} transform={`translate(${PAD.left + li * groupW}, 0)`}>
            {spec.series.map((s, si) => {
              const v = s.points[li]!.value;
              const yv = yOf(v);
              return (
                <rect
                  key={si}
                  x={groupW * 0.1 + si * barW}
                  y={Math.min(yv, zeroY)}
                  width={barW}
                  height={Math.max(0, Math.abs(yv - zeroY))}
                  fill={SERIES_COLORS[si % SERIES_COLORS.length]}
                >
                  <title>{`${label} · ${s.name}: ${v}`}</title>
                </rect>
              );
            })}
            <text x={groupW / 2} y={H - PAD.bottom + 14} textAnchor="middle" className="asksql-chart-xlabel">
              {label.length > 10 ? `${label.slice(0, 9)}…` : label}
            </text>
          </g>
        ))}
      </svg>
      <Legend spec={spec} />
    </figure>
  );
}

function LineChart({ spec }: { spec: ChartSpec }): JSX.Element {
  const { min, max } = scaleDomain(spec);
  const range = max - min;
  const points = spec.series[0]!.points;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + ((max - v) / range) * plotH;
  const zeroY = y(0);

  return (
    <figure
      className="asksql-chart"
      role="img"
      aria-label={`Line chart of ${spec.series.map((s) => s.name).join(', ')} over ${spec.labelColumn}`}
    >
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet">
        <Axes min={min} max={max} plotH={plotH} zeroY={zeroY} />
        {spec.series.map((s, si) => (
          <polyline
            key={si}
            fill="none"
            stroke={SERIES_COLORS[si % SERIES_COLORS.length]}
            strokeWidth={2}
            points={s.points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')}
          />
        ))}
        {points.map((p, i) => (
          <text key={i} x={x(i)} y={H - PAD.bottom + 14} textAnchor="middle" className="asksql-chart-xlabel">
            {i % Math.ceil(points.length / 8 || 1) === 0
              ? p.label.length > 10
                ? `${p.label.slice(0, 9)}…`
                : p.label
              : ''}
          </text>
        ))}
      </svg>
      <Legend spec={spec} />
    </figure>
  );
}

function Axes({ min, max, plotH, zeroY }: { min: number; max: number; plotH: number; zeroY: number }): JSX.Element {
  return (
    <g>
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + plotH} className="asksql-chart-axis" />
      {/* Category axis sits at the zero baseline, so negative values drop below it. */}
      <line x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY} className="asksql-chart-axis" />
      <text x={PAD.left - 6} y={PAD.top + 4} textAnchor="end" className="asksql-chart-ylabel">
        {formatNum(max)}
      </text>
      <text x={PAD.left - 6} y={zeroY + 4} textAnchor="end" className="asksql-chart-ylabel">
        0
      </text>
      {min < 0 && (
        <text x={PAD.left - 6} y={PAD.top + plotH} textAnchor="end" className="asksql-chart-ylabel">
          {formatNum(min)}
        </text>
      )}
    </g>
  );
}

function Legend({ spec }: { spec: ChartSpec }): JSX.Element | null {
  if (spec.series.length < 2) return null;
  return (
    <div className="asksql-chart-legend">
      {spec.series.map((s, i) => (
        <span key={s.name}>
          <i style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

function formatNum(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}
