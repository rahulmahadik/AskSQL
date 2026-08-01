package com.rahulmahadik.asksql.ide.engine

/**
 * What AskSQL will and will not answer, and the shape of a schema answer. Mirrors core's
 * `scope.ts`; [Grounding] holds the catalog-aware half.
 *
 * Separate from [EnginePipeline] for the same reason the TypeScript module is separate from its
 * engine: the MongoDB path needs these too, and reaching into the SQL pipeline for them couples
 * the two engines through a class that has nothing to do with documents.
 */
object Scope {

    /** A prose answer about the schema. Structure only - never data values, since no query runs. */
    data class SchemaAnswer(
        val answer: String,
        val tables: List<String>,
        val grounded: Boolean,
        val unknownReferences: List<String>,
        val isSchemaChange: Boolean,
    )

    /**
     * A refusal is the WHOLE reply - models wrap the sentinel in punctuation or a short apology,
     * but never bury it in a real answer, so only a short reply counts. Matching it anywhere would
     * let an answer that happens to discuss the sentinel be replaced by the decline.
     */
    private const val OFF_TOPIC_MAX_REPLY_LENGTH = 120

    /**
     * Models reformat the sentinel: "OUT OF SCOPE", "out-of-scope", "**OUT_OF_SCOPE**". Punctuated
     * forms are never prose, so case is ignored; the spaced form must be capitals, since
     * "that is out of scope for this schema" is ordinary English. Mirrors core's `scope.ts`.
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
        // A reply that OPENS with the marker is a refusal however much the model then rambles;
        // only a marker buried later in a long reply is treated as an answer (and stripped).
        if (OFF_TOPIC_LEADING_RE.containsMatchIn(trimmed) || OFF_TOPIC_LEADING_CI_RE.containsMatchIn(trimmed)) return true
        if (trimmed.length > OFF_TOPIC_MAX_REPLY_LENGTH) return false
        return OFF_TOPIC_RE.containsMatchIn(trimmed) || OFF_TOPIC_CI_RE.containsMatchIn(trimmed)
    }

    /**
     * Remove a sentinel the model bolted onto a real answer. Above the length bound the reply is
     * treated as an answer, but the marker is internal protocol and must never be shown.
     */
    fun stripSentinel(answer: String): String {
        val stripped = OFF_TOPIC_CI_RE.replace(OFF_TOPIC_RE.replace(answer, " "), " ")
        return if (stripped == answer) answer else stripped.replace(Regex("[ \\t]{2,}"), " ").trim()
    }

    /**
     * A model declining in prose rather than answering. Both apostrophes: models emit U+2019 as
     * often as U+0027.
     */
    val MODEL_REFUSAL_RE = Regex(
        """\b(i can(?:no|['’])t|i cannot|i am unable|i['’]m unable|i['’]m sorry|as an ai)\b""",
        RegexOption.IGNORE_CASE,
    )

    /**
     * A reply that is ONLY a refusal. Length-bounded for the same reason as [isOffTopic]: a real
     * schema answer may contain "I can't tell from the schema alone" and must not be thrown away.
     */
    private const val PROSE_REFUSAL_MAX_LENGTH = 400

    fun isProseRefusal(answer: String, mentionsSchema: Boolean = false): Boolean {
        // An answer that names a real table or column is an ANSWER, however it is worded.
        if (mentionsSchema) return false
        val trimmed = answer.trim()
        return trimmed.length <= PROSE_REFUSAL_MAX_LENGTH && MODEL_REFUSAL_RE.containsMatchIn(trimmed)
    }

    /**
     * A reply that is not an explanation at all: a couple of words, or no prose in it. The prompt
     * asks for sentences, so a fragment is unusable however it arose - a small model can complete
     * the sentinel into a schema token it just read (an Oracle catalog holding OUT_ARGUMENT yields
     * "OUT_ARGUMENT VARCHAR2"). Callers exempt statement-shaped replies, which ARE answers.
     */
    private val CJK_RE = Regex("[\\p{IsHan}\\p{IsHiragana}\\p{IsKatakana}\\p{IsHangul}]")
    private val LOWERCASE_RUN_RE = Regex("\\p{Ll}{3}")

    fun isDegenerateAnswer(answer: String): Boolean {
        val trimmed = answer.trim()
        if (trimmed.length >= 60) return false
        // Chinese, Japanese and Korean do not put spaces between words, so a complete sentence
        // counts as one "word" and scored the same as a two-token fragment. Judge those by length.
        if (CJK_RE.containsMatchIn(trimmed)) return trimmed.length < 8
        val words = trimmed.split(Regex("\\s+")).filter { it.isNotEmpty() }
        // Lowercase letters in ANY script: the point is to reject shouty catalog fragments like
        // "OUT_ARGUMENT VARCHAR2" without also rejecting Cyrillic or Greek prose.
        return words.size < 4 || !LOWERCASE_RUN_RE.containsMatchIn(trimmed)
    }

    /**
     * Database vocabulary in the question itself. A small model calls anything naming another
     * product ("how would I do this in MongoDB?") off-topic, so its refusal is challenged once
     * when the question plainly IS about data.
     */
    private val DATABASE_VOCABULARY_RE = Regex(
        "\\b(database|databases|db|dbs|table|tables|column|columns|row|rows|schema|schemas|sql|query|queries|select|insert|update|delete|drop|alter|truncate|join|joins|index|indexes|indices|key|keys|constraint|trigger|view|views|collection|collections|document|documents|aggregate|aggregation|pipeline|transaction|normalise|normalize|denormalise|denormalize|migration|migrate|partition|shard|replica|postgres|postgresql|mysql|mariadb|oracle|sqlite|duckdb|mongo|mongodb|redis|nosql|orm|etl|data|dataset|record|records)\\b",
        RegexOption.IGNORE_CASE,
    )

    fun looksDatabaseRelated(question: String): Boolean = DATABASE_VOCABULARY_RE.containsMatchIn(question)

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
