/**
 * Reserved words per engine, read from each database itself rather than guessed:
 * pg_get_keywords(), information_schema.KEYWORDS, V$RESERVED_WORDS, duckdb_keywords().
 * SQLite publishes a fixed list and has no catalog to query.
 *
 * Regenerate with: node tools/generate-sql-keywords.mjs
 * One word list plus a bit per engine, which costs a few hundred bytes instead of repeating words.
 */

const WORDS =
  'abort|accessible|action|add|after|all|alter|always|analyse|analyze|and|any|array|as|asc|asensitive|asymmetric|' +
  'attach|authorization|autoincrement|before|begin|between|bigint|binary|blob|both|by|call|cascade|case|cast|chan' +
  'ge|char|character|check|cluster|collate|collation|column|commit|compress|concurrently|condition|conflict|conne' +
  'ct|constraint|continue|convert|create|cross|cube|cume_dist|current|current_catalog|current_date|current_role|c' +
  'urrent_schema|current_time|current_timestamp|current_user|cursor|database|databases|date|day_hour|day_microsec' +
  'ond|day_minute|day_second|dec|decimal|declare|default|deferrable|deferred|delayed|delete|dense_rank|desc|descr' +
  'ibe|detach|deterministic|distinct|distinctrow|div|do|double|drop|dual|each|else|elseif|empty|enclosed|end|esca' +
  'pe|escaped|except|exclude|exclusive|exists|exit|explain|fail|false|fetch|filter|first|first_value|float|float4' +
  '|float8|following|for|force|foreign|freeze|from|full|fulltext|function|generated|get|glob|grant|group|grouping' +
  '|groups|having|high_priority|hour_microsecond|hour_minute|hour_second|identified|if|ignore|ilike|immediate|in|' +
  'index|indexed|infile|initially|inner|inout|insensitive|insert|instead|int|int1|int2|int3|int4|int8|integer|int' +
  'ersect|interval|into|io_after_gtids|io_before_gtids|is|isnull|iterate|join|json_table|key|keys|kill|lag|lambda' +
  '|last|last_value|lateral|lead|leading|leave|left|like|limit|linear|lines|load|localtime|localtimestamp|lock|lo' +
  'ng|longblob|longtext|loop|low_priority|match|materialized|maxvalue|mediumblob|mediumint|mediumtext|middleint|m' +
  'inus|minute_microsecond|minute_second|mod|mode|modifies|natural|no|no_write_to_binlog|nocompress|not|nothing|n' +
  'otnull|nowait|nth_value|ntile|null|nulls|number|numeric|of|offset|on|only|optimize|optimizer_costs|option|opti' +
  'onally|or|order|others|out|outer|outfile|over|overlaps|partition|pctfree|percent_rank|pivot|pivot_longer|pivot' +
  '_wider|placing|plan|pragma|preceding|precision|primary|prior|procedure|public|purge|qualify|query|raise|range|' +
  'rank|raw|read|read_write|reads|real|recursive|references|regexp|reindex|release|rename|repeat|replace|require|' +
  'resignal|resource|restrict|return|returning|revoke|right|rlike|rollback|row|row_number|rows|savepoint|schema|s' +
  'chemas|second_microsecond|select|sensitive|separator|session_user|set|share|show|signal|similar|size|smallint|' +
  'some|spatial|specific|sql|sql_big_result|sql_calc_found_rows|sql_small_result|sqlexception|sqlstate|sqlwarning' +
  '|ssl|start|starting|stored|straight_join|summarize|symmetric|synonym|system|system_user|table|tablesample|temp' +
  '|temporary|terminated|then|ties|tinyblob|tinyint|tinytext|to|trailing|transaction|trigger|true|unbounded|undo|' +
  'union|unique|unlock|unpivot|unsigned|update|usage|use|user|using|utc_date|utc_time|utc_timestamp|vacuum|values' +
  '|varbinary|varchar|varchar2|varcharacter|variadic|varying|verbose|view|virtual|when|where|while|window|with|wi' +
  'thout|write|xor|year_month|zerofill';

const WORD_LIST = WORDS.split('|');

/** One bit per word in WORD_LIST, base64 encoded. */
const BY_ENGINE: Record<string, string> = {
  sqlite: '/WZ66KhRpkwAV6XG3gxrqsHeDCgrBAfAAJhjDq4CFxz4RbURAQAAaKM1Iga8Aw==',
  postgres: 'IH8FxehExh8AQyREAgN6MAHFACgLUMcAAIgiHCaBEAAQAAWQkACAHGEyMICyAQ==',
  mysql: 'aubQf6/In/z++d4/c/Ou99+s9//9+f9/36046/cKWLO/3+5+Tf87mn177135PQ==',
  oracle: 'YGxACBoiAgBBUYQEGiAiMCEMBCwBAAIDIMKkigYEoEAAIQIQYwAECSExAjQkAQ==',
  duckdb: 'IH8BxKhAAgAAwyREAgMqIAFEACgAUgQAAIAgHAbwEAIQAAEQhADACGGyIICwAQ==',
};

const cache = new Map<string, ReadonlySet<string>>();

/** The engine's reserved words; an unknown engine falls back to the union, which is the safe side. */
export function reservedWordsFor(engine: string): ReadonlySet<string> {
  const key = engine.toLowerCase();
  let set = cache.get(key);
  if (!set) {
    const packed = BY_ENGINE[key];
    if (packed) {
      const bytes = atob(packed);
      set = new Set(WORD_LIST.filter((_, i) => (bytes.charCodeAt(i >> 3) >> (i & 7)) & 1));
    } else set = new Set(WORD_LIST);
    cache.set(key, set);
  }
  return set;
}
