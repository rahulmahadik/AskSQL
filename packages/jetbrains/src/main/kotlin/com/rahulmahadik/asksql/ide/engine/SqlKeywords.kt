package com.rahulmahadik.asksql.ide.engine

/**
 * Reserved words per engine, generated alongside packages/core/src/sql-keywords.ts so the plugin and
 * the npm engine cannot drift. Regenerate both with: node tools/generate-sql-keywords.mjs
 */
object SqlKeywords {

    private val WORDS = (
        "abort|accessible|action|add|after|all|alter|always|analyse|analyze|and|any|array|as|asc|asensitive|a" +
        "symmetric|attach|authorization|autoincrement|before|begin|between|bigint|binary|blob|both|by|call|ca" +
        "scade|case|cast|change|char|character|check|cluster|collate|collation|column|commit|compress|concurr" +
        "ently|condition|conflict|connect|constraint|continue|convert|create|cross|cube|cume_dist|current|cur" +
        "rent_catalog|current_date|current_role|current_schema|current_time|current_timestamp|current_user|cu" +
        "rsor|database|databases|date|day_hour|day_microsecond|day_minute|day_second|dec|decimal|declare|defa" +
        "ult|deferrable|deferred|delayed|delete|dense_rank|desc|describe|detach|deterministic|distinct|distin" +
        "ctrow|div|do|double|drop|dual|each|else|elseif|empty|enclosed|end|escape|escaped|except|exclude|excl" +
        "usive|exists|exit|explain|fail|false|fetch|filter|first|first_value|float|float4|float8|following|fo" +
        "r|force|foreign|freeze|from|full|fulltext|function|generated|get|glob|grant|group|grouping|groups|ha" +
        "ving|high_priority|hour_microsecond|hour_minute|hour_second|identified|if|ignore|ilike|immediate|in|" +
        "index|indexed|infile|initially|inner|inout|insensitive|insert|instead|int|int1|int2|int3|int4|int8|i" +
        "nteger|intersect|interval|into|io_after_gtids|io_before_gtids|is|isnull|iterate|join|json_table|key|" +
        "keys|kill|lag|lambda|last|last_value|lateral|lead|leading|leave|left|like|limit|linear|lines|load|lo" +
        "caltime|localtimestamp|lock|long|longblob|longtext|loop|low_priority|match|materialized|maxvalue|med" +
        "iumblob|mediumint|mediumtext|middleint|minus|minute_microsecond|minute_second|mod|mode|modifies|natu" +
        "ral|no|no_write_to_binlog|nocompress|not|nothing|notnull|nowait|nth_value|ntile|null|nulls|number|nu" +
        "meric|of|offset|on|only|optimize|optimizer_costs|option|optionally|or|order|others|out|outer|outfile" +
        "|over|overlaps|partition|pctfree|percent_rank|pivot|pivot_longer|pivot_wider|placing|plan|pragma|pre" +
        "ceding|precision|primary|prior|procedure|public|purge|qualify|query|raise|range|rank|raw|read|read_w" +
        "rite|reads|real|recursive|references|regexp|reindex|release|rename|repeat|replace|require|resignal|r" +
        "esource|restrict|return|returning|revoke|right|rlike|rollback|row|row_number|rows|savepoint|schema|s" +
        "chemas|second_microsecond|select|sensitive|separator|session_user|set|share|show|signal|similar|size" +
        "|smallint|some|spatial|specific|sql|sql_big_result|sql_calc_found_rows|sql_small_result|sqlexception" +
        "|sqlstate|sqlwarning|ssl|start|starting|stored|straight_join|summarize|symmetric|synonym|system|syst" +
        "em_user|table|tablesample|temp|temporary|terminated|then|ties|tinyblob|tinyint|tinytext|to|trailing|" +
        "transaction|trigger|true|unbounded|undo|union|unique|unlock|unpivot|unsigned|update|usage|use|user|u" +
        "sing|utc_date|utc_time|utc_timestamp|vacuum|values|varbinary|varchar|varchar2|varcharacter|variadic|" +
        "varying|verbose|view|virtual|when|where|while|window|with|without|write|xor|year_month|zerofill"
    ).split("|")

    /** One bit per word in WORDS, base64 encoded. */
    private val BY_ENGINE = mapOf(
        "sqlite" to "/WZ66KhRpkwAV6XG3gxrqsHeDCgrBAfAAJhjDq4CFxz4RbURAQAAaKM1Iga8Aw==",
        "postgres" to "IH8FxehExh8AQyREAgN6MAHFACgLUMcAAIgiHCaBEAAQAAWQkACAHGEyMICyAQ==",
        "mysql" to "aubQf6/In/z++d4/c/Ou99+s9//9+f9/36046/cKWLO/3+5+Tf87mn177135PQ==",
        "oracle" to "YGxACBoiAgBBUYQEGiAiMCEMBCwBAAIDIMKkigYEoEAAIQIQYwAECSExAjQkAQ==",
        "duckdb" to "IH8BxKhAAgAAwyREAgMqIAFEACgAUgQAAIAgHAbwEAIQAAEQhADACGGyIICwAQ==",
    )

    private val cache = HashMap<String, Set<String>>()

    /** The engine's reserved words; an unknown engine falls back to the union, which is the safe side. */
    fun reservedWordsFor(engine: String): Set<String> {
        val key = engine.lowercase()
        cache[key]?.let { return it }
        val packed = BY_ENGINE[key]
        val set = if (packed != null) {
            val bytes = java.util.Base64.getDecoder().decode(packed)
            WORDS.filterIndexed { i, _ -> (bytes[i shr 3].toInt() shr (i and 7)) and 1 == 1 }.toSet()
        } else {
            WORDS.toSet()
        }
        cache[key] = set
        return set
    }
}
