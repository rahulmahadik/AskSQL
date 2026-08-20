/**
 * What a column's TYPE does not say, stated in its comment so the model does not have to guess.
 *
 * Two gaps, both measured as silently wrong answers rather than errors:
 *  - an integer column holding a moment carries no unit, so epoch milliseconds compared against epoch
 *    seconds matches every row (measured on Postgres: 3 returned, 2 true) and against a text date
 *    matches none;
 *  - a JSON column carries no key names, so the model invents one and the filter matches nothing.
 *
 * Shared here because six connectors in two languages would otherwise each carry a copy. Only the probe
 * SQL and the accessor syntax are per-engine; the judgement is not.
 */

/** An integer column whose name says it holds a moment; the unit is not in the type. */
const TIMEISH_NAME =
  /(?:^|_)(?:at|ts|time|date|timestamp|created|updated|modified|deleted|expires?|expiry|last_seen|since|until)(?:_|$)|(?:time|date|timestamp)$/i;

/** An identifier, never a moment: `created_by_employee_id` matches the name test but holds an id. */
const ID_NAME = /(?:^|_)(?:id|ids|key|uuid|guid|hash|no|num|number|code|by)$/i;

/** A fixed-scale number is a measurement, not a moment: `amount_due numeric(14,2)` is money. */
const HAS_SCALE = /\(\s*\d+\s*,\s*[1-9]\d*\s*\)/;

/** Integer-ish across engines: SQLite affinity, Postgres int8, MySQL bigint, Oracle NUMBER. */
const INTEGERISH =
  /^(?:big\s*int|int|integer|int2|int4|int8|smallint|tinyint|mediumint|unsigned\s+big\s+int|numeric|number|decimal)\b/i;

/** A column that stores a moment as a number, decided from the schema alone. */
export function isMomentColumn(name: string, dbType: string): boolean {
  const type = dbType.trim();
  // `due`, `start`, `end`, `sent` and `received` are left out of TIMEISH_NAME on purpose: alone they
  // are `amount_due`, `month_end`, `quantity_sent`. Paired with a real time word (`due_at`,
  // `start_date`) they still match, so nothing genuine is lost.
  return INTEGERISH.test(type) && !HAS_SCALE.test(type) && TIMEISH_NAME.test(name) && !ID_NAME.test(name);
}

/** At or above this a value is a sentinel, not a moment: Long.MAX_VALUE means "never expires". */
const SENTINEL_FLOOR = 9e18;

function bucketOf(v: number): string | null {
  if (v >= 1e17) return 'epoch nanoseconds';
  if (v >= 1e14) return 'epoch microseconds';
  if (v >= 1e11) return 'epoch milliseconds';
  if (v >= 1e8) return 'epoch seconds';
  return null; // too small to be a modern timestamp; saying nothing beats guessing
}

/**
 * Which epoch unit a column is in, from its range rather than one end of it. A single `MAX()` is decided
 * by the largest row, so a "never expires" sentinel reported nanoseconds for an ordinary milliseconds
 * column, and one legacy millisecond row among seconds reported milliseconds for all of them. When the
 * ends disagree the column is mixed and the honest hint is none.
 *
 * Decided from aggregates, so the unit is stated and no row value is.
 */
export function epochUnitOf(lo: number | null | undefined, hi?: number | null): string | null {
  const low = lo == null || !Number.isFinite(lo) ? null : lo;
  const high = hi === undefined ? low : hi == null || !Number.isFinite(hi) ? null : hi;
  if (low == null || high == null || low <= 0) return null;
  // A sentinel is not a moment; ignore it and judge by the rest of the range.
  const top = high >= SENTINEL_FLOOR ? low : high;
  const bucket = bucketOf(low);
  return bucket !== null && bucket === bucketOf(top) ? bucket : null;
}

/** Types that can hold JSON text. Kept wide and shared: a narrower copy meant one IDE probed a column the other skipped. */
const JSON_CAPABLE =
  /^(?:json|jsonb|text|longtext|mediumtext|tinytext|varchar|character varying|citext|char|clob|nclob|nvarchar|string)/i;

/** Whether a column could hold JSON, decided from its declared type alone. */
export function isJsonCandidateColumn(dbType: string): boolean {
  return JSON_CAPABLE.test(dbType.trim());
}

/** A key that reads as a field name. One that does not is data: a map keyed by an address or an id. */
const JSON_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const JSON_MAX_KEYS = 12;
const JSON_MIN_ROWS_TO_NAME = 3;
const JSON_KEY_SHARE = 0.4;

/**
 * Null when the column does not hold JSON objects; an empty list when it does but nothing is nameable.
 * Only keys that RECUR are named: a record repeats its keys, a map keyed by data does not, so
 * `{"ZZALICE":3}, {"ZZBOB":7}` yields no stable key and the usernames never reach the prompt. Known
 * residual: a fixed set of identifier-shaped keys present on most rows still reads as a record.
 */
export function jsonShapeOf(values: readonly unknown[]): { keys: string[] } | null {
  const seenIn = new Map<string, number>();
  let parsed = 0;
  for (const raw of values) {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text.startsWith('{')) return null;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    for (const k of Object.keys(value)) {
      if (!JSON_KEY.test(k)) return null;
      seenIn.set(k, (seenIn.get(k) ?? 0) + 1);
    }
    parsed++;
  }
  if (parsed === 0) return null;
  if (parsed < JSON_MIN_ROWS_TO_NAME) return { keys: [] };
  // A share, not a flat count: two repeat customers among eighteen one-off keys cleared a threshold of 2.
  const needed = Math.max(2, parsed * JSON_KEY_SHARE);
  const stable = [...seenIn.entries()].filter(([, n]) => n >= needed).map(([k]) => k);
  return { keys: stable.length >= 2 && stable.length <= JSON_MAX_KEYS ? stable : [] };
}

/** Leaves room for the schema builder's own 200-character comment cap. */
const HINT_CAP = 185;

/**
 * The hint as the model is shown it, with the engine's own accessor.
 *
 * The key NAMES are gated. A map with a stable key set - per-user scores, per-tenant flags - has perfect
 * recurrence and so scores maximally as a record; `{"ZZALICE":3,"ZZBOB":5}` on every row is structurally
 * identical to `{theme,notify}` on every row. No threshold separates them, so the names ride the same
 * opt-in as every other cell value and the default states only how many there are. The accessor is
 * always safe and is what stopped the model reaching for LIKE, which was the larger win.
 *
 * The key list is trimmed at a key boundary: the comment cap appends an ellipsis, which would cut the
 * last name in half and offer a key that does not exist.
 */
export function jsonHint(accessor: string, keys: readonly string[], nameKeys = false): string {
  const prefix = `JSON object, read with ${accessor}`;
  if (keys.length === 0) return prefix;
  if (!nameKeys) return `${prefix} (${keys.length} recurring ${keys.length === 1 ? 'key' : 'keys'})`;
  const lead = `${prefix}; keys: `;
  const kept: string[] = [];
  for (const k of keys) {
    if (lead.length + [...kept, k].join(', ').length > HINT_CAP) break;
    kept.push(k);
  }
  const shown = kept.length > 0 ? kept : keys.slice(0, 1);
  return lead + shown.join(', ') + (shown.length < keys.length ? ', ...' : '');
}

/** A shared cap, so a wide schema cannot turn a catalog read into a scan. */
export const MAX_HINT_PROBES = 200;

/** Per table, so a wide schema degrades evenly instead of the first tables taking every probe. */
export const MAX_HINT_PROBES_PER_TABLE = 4;
export const JSON_SAMPLE_ROWS = 20;

/** A probe reads only enough of a cell to judge its shape; the rest is bandwidth and parse cost. */
export const HINT_VALUE_CAP = 8192;

/**
 * The element type of a JSON ARRAY column, or null if the values are not all arrays. Real schemas keep
 * lists of ids this way (measured on a 65-table production schema: `client_ids`, `room_id`,
 * `equipment_id` are all `[123504,312]`), and without a hint the model wrote
 * `JSON_CONTAINS(col, '["1"]')` - a string against numbers - which matched nothing and raised no error.
 * The element type only; never an element.
 */
export function jsonArrayElementOf(values: readonly unknown[]): 'number' | 'string' | null {
  let seen: 'number' | 'string' | null = null;
  let parsed = 0;
  for (const raw of values) {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text.startsWith('[')) return null;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (!Array.isArray(value)) return null;
    for (const el of value) {
      const t = typeof el === 'number' ? 'number' : typeof el === 'string' ? 'string' : null;
      if (t === null) return null; // objects and nested arrays are not a simple membership test
      if (seen && seen !== t) return null; // mixed, so no single membership form is right
      seen = t;
    }
    parsed++;
  }
  return parsed > 0 ? seen : null;
}
