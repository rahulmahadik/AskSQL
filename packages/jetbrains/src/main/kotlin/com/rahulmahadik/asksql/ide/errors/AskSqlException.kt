package com.rahulmahadik.asksql.ide.errors

/**
 * The full error taxonomy of `@asksql/core`'s `errors.ts`. Every exception thrown in the
 * engine/db/llm layers carries one of these codes so [ErrorPresenter] can show a stable, friendly message.
 */
enum class AskSqlErrorCode {
    CONFIG_ERROR,
    INVALID_INPUT,
    GUARD_BLOCKED,
    DB_UNREACHABLE,
    DB_QUERY_ERROR,
    DB_TOO_MANY_ROWS,
    LLM_AUTH,
    LLM_UNAVAILABLE,
    LLM_BAD_OUTPUT,
    LLM_REFUSAL,
    /** The model examined the schema and legitimately concluded the question is unanswerable from it; a normal outcome, not a malfunction, shown calmly rather than as a red error. */
    LLM_CANNOT_ANSWER,
    LLM_CONTEXT_OVERFLOW,
    CANCELLED,
    /** A user-supplied file (CSV/JSON/Parquet/XLSX/.sql dump) couldn't be loaded into DuckDB; see [com.rahulmahadik.asksql.ide.db.DuckDbFileLoader]. */
    FILE_LOAD_ERROR,
    UNKNOWN,
}

/**
 * The single exception type thrown across engine/db/llm boundaries. [userMessage] is the only text
 * ever shown in the transcript; [detail] (raw driver message, SQL fragment, HTTP body) goes to the Logger only.
 */
class AskSqlException(
    val code: AskSqlErrorCode,
    val userMessage: String = defaultUserMessage(code),
    val detail: String? = null,
    val retryable: Boolean = code in RETRYABLE_CODES,
    /**
     * On a runtime DB error, the engine may attach a model-suggested corrected statement here,
     * surfaced to the user for re-approval; never executed automatically.
     */
    var suggestedSql: String? = null,
    cause: Throwable? = null,
) : Exception(detail ?: userMessage, cause) {

    companion object {
        private val RETRYABLE_CODES = setOf(
            AskSqlErrorCode.DB_UNREACHABLE,
            AskSqlErrorCode.LLM_UNAVAILABLE,
        )

        fun defaultUserMessage(code: AskSqlErrorCode): String = when (code) {
            AskSqlErrorCode.CONFIG_ERROR -> "Something in AskSQL's setup needs a look. Check the connection and model settings."
            AskSqlErrorCode.INVALID_INPUT -> "That input doesn't look quite right. Give it another go."
            AskSqlErrorCode.GUARD_BLOCKED -> "I stopped that one for safety. AskSQL only ever runs read-only SELECT queries."
            AskSqlErrorCode.DB_UNREACHABLE -> "I couldn't reach the database. Check it's running and the connection settings are right."
            AskSqlErrorCode.DB_QUERY_ERROR -> "The database didn't accept that query."
            AskSqlErrorCode.DB_TOO_MANY_ROWS -> "That returned more rows than the limit, so I trimmed it. Export to CSV for the full result."
            AskSqlErrorCode.LLM_AUTH -> "The AI provider didn't accept those credentials. Check your API key in Settings."
            AskSqlErrorCode.LLM_UNAVAILABLE -> "The AI provider isn't responding right now. Give it a moment and try again."
            AskSqlErrorCode.LLM_BAD_OUTPUT -> "I couldn't turn that reply into a working query. Try rephrasing the question."
            AskSqlErrorCode.LLM_REFUSAL -> "The model chose not to answer that one. Try rewording it."
            AskSqlErrorCode.LLM_CANNOT_ANSWER -> "I couldn't work out a query for this database from that question."
            AskSqlErrorCode.LLM_CONTEXT_OVERFLOW -> "The question plus the schema was too big for this model. Try a shorter question, or lower Max schema tokens in Settings."
            AskSqlErrorCode.CANCELLED -> "Cancelled."
            AskSqlErrorCode.FILE_LOAD_ERROR -> "I couldn't load that file."
            AskSqlErrorCode.UNKNOWN -> "Something went wrong on my side. If it keeps happening, check idea.log for \"AskSQL\"."
        }

        /** Wraps a [Throwable] as an [AskSqlException] without leaking its raw message; a coroutine cancellation always maps to [AskSqlErrorCode.CANCELLED] regardless of [code]. */
        fun from(cause: Throwable, code: AskSqlErrorCode): AskSqlException {
            if (cause is AskSqlException) return cause
            if (cause is kotlinx.coroutines.CancellationException) {
                return AskSqlException(code = AskSqlErrorCode.CANCELLED, detail = cause.message, cause = cause, retryable = false)
            }
            return AskSqlException(code = code, detail = cause.message, cause = cause)
        }
    }
}
