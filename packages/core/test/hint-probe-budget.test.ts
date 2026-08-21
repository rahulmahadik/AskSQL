/**
 * The probe budget is global and spent in catalog order. A flat per-table cap does not spread it: the
 * first tables take everything and the rest get no hints at all, silently. An application database of
 * 186 tables is ordinary, and the flat cap covered only the first 50 of them.
 */
import { describe, expect, it } from 'vitest';
import { MAX_HINT_PROBES, MAX_HINT_PROBES_PER_TABLE, hintProbesPerTable } from '../src/column-hints.js';

describe('the hint probe budget is shared, not first-come', () => {
  it('gives every table a share on a schema too wide for the flat cap', () => {
    expect(hintProbesPerTable(186)).toBeGreaterThanOrEqual(1);
    // Total spend stays inside the global cap, so this costs no more time than the flat cap did.
    expect(hintProbesPerTable(186) * 186).toBeLessThanOrEqual(MAX_HINT_PROBES + 186);
  });

  it('never starves a table to zero, however wide the schema', () => {
    for (const n of [51, 200, 1000, 5000]) {
      expect(hintProbesPerTable(n), `${n} tables`).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps the full per-table allowance on a schema that fits', () => {
    for (const n of [1, 5, 50]) {
      expect(hintProbesPerTable(n), `${n} tables`).toBe(MAX_HINT_PROBES_PER_TABLE);
    }
  });

  it('never exceeds the per-table cap', () => {
    for (const n of [1, 10, 186, 5000]) {
      expect(hintProbesPerTable(n)).toBeLessThanOrEqual(MAX_HINT_PROBES_PER_TABLE);
    }
  });

  it('treats an empty schema as one table rather than dividing by zero', () => {
    expect(Number.isFinite(hintProbesPerTable(0))).toBe(true);
    expect(hintProbesPerTable(0)).toBe(MAX_HINT_PROBES_PER_TABLE);
  });
});
