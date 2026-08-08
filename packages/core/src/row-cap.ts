/**
 * The one row-cap clamp, shared by the SQL and MongoDB guards. maxRows arrives untrusted, from a
 * user setting or an HTTP client.
 */

/** Nothing a caller asks for may exceed this; a row cap is a memory bound, not a preference. */
export const MAX_ROW_CAP = 100_000;

/** Always a positive integer: `fallback` unless `requested` is finite and >= 1, then floored and capped. */
export function clampMaxRows(requested: number | undefined, fallback: number): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested >= 1
    ? Math.min(Math.floor(requested), MAX_ROW_CAP)
    : fallback;
}
