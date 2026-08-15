package com.rahulmahadik.asksql.ide.engine

/**
 * Mirrors redactValuesInError in packages/core/src/engine.ts.
 *
 * A driver error can quote the offending row ("Key (email)=(ada@example.com) already exists", or
 * Postgres appending the whole row as "Failing row contains (...)"). The user never asked to send
 * that to a model, and this side had no redaction at all: the repair prompt carried the raw text.
 * The structural part - constraint, column, table, error code - is what the repair needs.
 */
object ErrorRedaction {

    /** Quoted text that is an IDENTIFIER, which the repair loop needs to fix a wrong name. */
    private val IDENTIFIER_CONTEXT =
        Regex("""\b(unknown column|unknown table|no such column|no such table|column|table|field|near|constraint|index)\s*$""", RegexOption.IGNORE_CASE)

    private val KEY_EQUALS = Regex("""(\((?:[^()]*)\)\s*=\s*)\([^)]*\)""")
    private val SINGLE_QUOTED = Regex("""'[^']*'""")
    private val TYPED_VALUE = Regex("""((?:invalid input syntax for type|out of range for type)\s+\w+:\s*)"[^"]*"""", RegexOption.IGNORE_CASE)
    private val INVALID_VALUE = Regex("""(invalid value\s*(?:for \w+)?:\s*)"[^"]*"""", RegexOption.IGNORE_CASE)
    private val CONVERSION = Regex("""(unable to parse|could not convert|conversion failed for)([^"]{0,40})"[^"]*"""", RegexOption.IGNORE_CASE)
    private val DATE_RANGE = Regex("""(date/time field value out of range:\s*)"[^"]*"""", RegexOption.IGNORE_CASE)
    private val VALUE_RANGE = Regex("""(value out of range[^:"]{0,20}:\s*)"[^"]*"""", RegexOption.IGNORE_CASE)
    private val ENUM_VALUE = Regex("""(invalid input value for enum \w+:\s*)"[^"]*"""", RegexOption.IGNORE_CASE)
    private val FAILING_ROW = Regex("""(failing row contains\s*)\([^)]*\)""", RegexOption.IGNORE_CASE)
    private val ORACLE_VALUE =
        Regex("""((?:ORA-\d+:\s*)?(?:invalid number|character to number conversion error)[^\n]{0,3}:\s*)[^\n]+""", RegexOption.IGNORE_CASE)
    private val LONG_QUOTED = Regex(""""[^"]{60,}"""")

    fun redactValuesInError(detail: String): String {
        var out = KEY_EQUALS.replace(detail) { it.groupValues[1] + "(...)" }
        // MySQL and SQLite quote identifiers this way too, so those phrasings keep theirs.
        out = SINGLE_QUOTED.replace(out) { m ->
            val before = out.substring(maxOf(0, m.range.first - 40), m.range.first)
            if (IDENTIFIER_CONTEXT.containsMatchIn(before)) m.value else "'...'"
        }
        out = TYPED_VALUE.replace(out) { it.groupValues[1] + "\"...\"" }
        out = INVALID_VALUE.replace(out) { it.groupValues[1] + "\"...\"" }
        out = CONVERSION.replace(out) { it.groupValues[1] + it.groupValues[2] + "\"...\"" }
        out = DATE_RANGE.replace(out) { it.groupValues[1] + "\"...\"" }
        out = VALUE_RANGE.replace(out) { it.groupValues[1] + "\"...\"" }
        out = ENUM_VALUE.replace(out) { it.groupValues[1] + "\"...\"" }
        // Postgres appends the WHOLE offending row as a DETAIL on a constraint violation.
        out = FAILING_ROW.replace(out) { it.groupValues[1] + "(...)" }
        // Oracle carries the value after the message rather than in quotes.
        out = ORACLE_VALUE.replace(out) { it.groupValues[1] + "..." }
        return LONG_QUOTED.replace(out, "\"...\"")
    }
}
