package com.rahulmahadik.asksql.ide.engine

/**
 * What AskSQL will and will not answer, and the shape of a schema answer. Mirrors core's
 * `scope.ts`; [Grounding] holds the catalog-aware half. Shared by the SQL and MongoDB pipelines.
 */
object Scope {

    /** A prose answer about the schema. Structure only - never data values. */
    data class SchemaAnswer(
        val answer: String,
        val tables: List<String>,
        val grounded: Boolean,
        val unknownReferences: List<String>,
        val isSchemaChange: Boolean,
        /** The read-only query this answer suggested, carried into the next turn's context. */
        val proposedSql: String? = null,
    )

    /** Only a reply this short counts as a refusal; a sentinel inside a longer reply is part of an answer. */
    private const val OFF_TOPIC_MAX_REPLY_LENGTH = 120

    /**
     * Models reformat the sentinel: "OUT OF SCOPE", "out-of-scope", "**OUT_OF_SCOPE**". Punctuated
     * forms match case-insensitively; the spaced form must be capitals. Mirrors core's `scope.ts`.
     */
    private val SENTINEL_BODY = Prompts.OFF_TOPIC_SENTINEL.split("_").joinToString("[_-]")
    private val SENTINEL_SPACED = Prompts.OFF_TOPIC_SENTINEL.split("_").joinToString("\\s")

    private val OFF_TOPIC_RE = Regex("(^|\\W)(?:$SENTINEL_BODY|$SENTINEL_SPACED)(\\W|$)")
    private val OFF_TOPIC_CI_RE = Regex("(^|\\W)$SENTINEL_BODY(\\W|$)", RegexOption.IGNORE_CASE)
    private val OFF_TOPIC_LEADING_RE = Regex("^\\W{0,3}(?:$SENTINEL_BODY|$SENTINEL_SPACED)\\b")
    private val OFF_TOPIC_LEADING_CI_RE = Regex("^\\W{0,3}$SENTINEL_BODY\\b", RegexOption.IGNORE_CASE)

    /** True when the model classified the question as nothing to do with data or databases. */
    fun isOffTopic(answer: String): Boolean {
        val trimmed = answer.trim()
        // A reply that OPENS with the marker is a refusal; a marker buried later is stripped from the answer.
        if (OFF_TOPIC_LEADING_RE.containsMatchIn(trimmed) || OFF_TOPIC_LEADING_CI_RE.containsMatchIn(trimmed)) return true
        if (trimmed.length > OFF_TOPIC_MAX_REPLY_LENGTH) return false
        return OFF_TOPIC_RE.containsMatchIn(trimmed) || OFF_TOPIC_CI_RE.containsMatchIn(trimmed)
    }

    /** Removes a sentinel the model bolted onto a real answer; the marker is internal protocol and is never shown. */
    fun stripSentinel(answer: String): String {
        val stripped = OFF_TOPIC_CI_RE.replace(OFF_TOPIC_RE.replace(answer, " "), " ")
        return if (stripped == answer) answer else stripped.replace(Regex("[ \\t]{2,}"), " ").trim()
    }

    /** A model declining in prose rather than answering. Both apostrophes: models emit U+2019 as often as U+0027. */
    val MODEL_REFUSAL_RE = Regex(
        """\b(i can(?:no|['’])t|i cannot|i am unable|i['’]m unable|i['’]m sorry|as an ai)\b""",
        RegexOption.IGNORE_CASE,
    )

    /** A reply that is ONLY a refusal; length-bounded like [isOffTopic]. */
    private const val PROSE_REFUSAL_MAX_LENGTH = 400

    fun isProseRefusal(answer: String, mentionsSchema: Boolean = false): Boolean {
        // An answer that names a real table or column is an ANSWER, however it is worded.
        if (mentionsSchema) return false
        val trimmed = answer.trim()
        return trimmed.length <= PROSE_REFUSAL_MAX_LENGTH && MODEL_REFUSAL_RE.containsMatchIn(trimmed)
    }

    /**
     * A reply that is not an explanation at all: a couple of words, or no prose in it.
     * Callers exempt statement-shaped replies, which ARE answers.
     */
    private val CJK_RE = Regex("[\\p{IsHan}\\p{IsHiragana}\\p{IsKatakana}\\p{IsHangul}]")
    private val LOWERCASE_RUN_RE = Regex("\\p{Ll}{3}")

    fun isDegenerateAnswer(answer: String): Boolean {
        val trimmed = answer.trim()
        if (trimmed.length >= 60) return false
        // Chinese, Japanese and Korean do not put spaces between words, so judge those by length.
        if (CJK_RE.containsMatchIn(trimmed)) return trimmed.length < 8
        val words = trimmed.split(Regex("\\s+")).filter { it.isNotEmpty() }
        // Lowercase letters in ANY script, so shouty catalog fragments fail but Cyrillic or Greek prose passes.
        return words.size < 4 || !LOWERCASE_RUN_RE.containsMatchIn(trimmed)
    }

    /** Database vocabulary in the question itself, used to challenge a model's off-topic refusal once. */
    private val DATABASE_VOCABULARY_RE = Regex(
        """\b(database|databases|db|dbs|dbms|rdbms|table|tables|column|columns|field|fields|row|rows|record|records|schema|schemas|catalog|sql|query|queries|statement|statements|subquery|cte|select|insert|update|delete|drop|alter|truncate|merge|upsert|join|joins|inner join|outer join|group by|order by|having|where clause|window function|aggregate|aggregation|pipeline|index|indexes|indices|indexing|key|keys|primary key|foreign key|unique|constraint|constraints|trigger|triggers|view|views|materialized view|procedure|procedures|routine|routines|(?<!\b(?:python|javascript|typescript|java|ruby|rust|php|kotlin|swift|scala|perl|bash|shell|golang) )functions?|sequence|sequences|partition|partitions|partitioning|shard|sharding|replica|replication|cluster|tablespace|cursor|transaction|transactions|commit|rollback|isolation|lock|locks|locking|deadlock|vacuum|analyze|statistics|cardinality|selectivity|explain|query plan|execution plan|normali[sz]\w*|denormali[sz]\w*|migration|migrations|migrate|backup|restore|dump|seed|fixture|grant|revoke|privilege|privileges|permission|permissions|role|roles|autoincrement|identity|serial|datatype|data type|varchar|integer|bigint|numeric|decimal|boolean|timestamp|datetime|blob|clob|json|jsonb|uuid|null|nulls|nullable|duplicate|duplicates|relation|relations|relationship|relationships|entity|entities|erd|collection|collections|document|documents|bson|objectid|postgres|postgresql|pgsql|mysql|mariadb|oracle|plsql|sqlite|duckdb|mongo|mongodb|redis|mssql|sql server|sqlserver|snowflake|bigquery|redshift|clickhouse|cockroach|timescale|supabase|planetscale|nosql|olap|oltp|orm|etl|elt|warehouse|data ?lake|data|dataset|latency|throughput|read replica)\b""",
        RegexOption.IGNORE_CASE,
    )

    fun looksDatabaseRelated(question: String): Boolean = DATABASE_VOCABULARY_RE.containsMatchIn(question)

    /** Attempts to talk past the instructions rather than ask a question; declined in code, not by the model. */
    private val PROMPT_INJECTION_RE = Regex(
        """\b(?:ignore (?:all |any )?(?:previous|prior|earlier|above|the|your|these|those) (?:instructions|prompts?|rules)\b(?!\s+(?:table|collection|column|field|view|list|entry|entries|row|rows))|disregard (?:all |any )?(?:the |your )?(?:previous|prior|earlier|above|system) (?:instructions|prompts?|rules)\b(?!\s+(?:table|collection|column|field|view|list|entry|entries|row|rows))|(?:print|reveal|show|repeat|output|tell me) (?:me )?(?:your|the) (?:system |initial |original )?(?:prompt|instructions)\b(?!\s+(?:table|collection|column|field|view|list|entry|entries|row|rows))|what (?:is|are|were) your (?:system )?(?:prompt|instructions|rules)|you are now (?:a|an|no longer)|pretend (?:to be|you are)|act as (?:if|though) you)""",
        RegexOption.IGNORE_CASE,
    )

    fun isPromptInjection(question: String): Boolean = PROMPT_INJECTION_RE.containsMatchIn(question)

    /** Questions about AskSQL itself, answered from code rather than generated by the model. */
    private val CAPABILITY_RE = Regex(
        """\b(?:what can you do|what do you do|what are you|who are you|how do you work|what is asksql|is asksql (?:safe|read[- ]?only)|are you (?:safe|read[- ]?only)|is (?:this|it) (?:safe|read[- ]?only)|(?:can|could|will|would|do|does|are you able to|is it able to)\s+(?:you\s+|it\s+)?(?:ever\s+)?(?:delete|drop|update|insert|modify|change|write|edit|alter|remove)\s+(?:to\s+)?(?:my\s+|the\s+|any\s+|our\s+)?(?:data|database|db|records?|rows?|tables?|schema|anything|something|things)\b)""",
        RegexOption.IGNORE_CASE,
    )

    fun isCapabilityQuestion(question: String): Boolean = CAPABILITY_RE.containsMatchIn(question)

    /** The honest answer about what AskSQL does, written in code rather than generated. */
    fun capabilityAnswer(dialectLabel: String): SchemaAnswer = SchemaAnswer(
        "I turn your questions into read-only SQL for this $dialectLabel database, show you the query before it runs, " +
            "and explain the result.\n\n" +
            "I never change your data. Every statement is checked before it reaches the database and anything that is not a " +
            "read-only query is refused - that check is code, not a prompt, so it holds regardless of what the AI replies. " +
            "If you ask for an INSERT, UPDATE, DELETE or a schema change, I write the statement out for you to run yourself " +
            "and never run it.\n\n" +
            "I can also answer questions about the database itself: what it holds, how the tables relate, what to index, and " +
            "how to improve the design.",
        emptyList(),
        true,
        emptyList(),
        false,
    )

    /** The reply for an out-of-scope question, written here rather than left to the model. */
    fun offTopicAnswer(dialectLabel: String): SchemaAnswer = SchemaAnswer(
        "I only help with databases - this connection is $dialectLabel. Ask me about its structure, " +
            "a query over your data, or database topics in general (modelling, indexing, performance) and I am happy to help.",
        emptyList(),
        true,
        emptyList(),
        false,
    )
}
