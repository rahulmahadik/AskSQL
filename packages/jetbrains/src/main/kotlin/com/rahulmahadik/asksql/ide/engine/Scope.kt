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
    private val OFF_TOPIC_WHOLE_CI_RE = Regex("^\\W*$SENTINEL_BODY\\W*$", RegexOption.IGNORE_CASE)
    private val OFF_TOPIC_LEADING_RE = Regex("^\\W{0,3}(?:$SENTINEL_BODY|$SENTINEL_SPACED)\\b")
    private val OFF_TOPIC_LEADING_CI_RE = Regex("^\\W{0,3}$SENTINEL_BODY\\b", RegexOption.IGNORE_CASE)

    /** True when the model classified the question as nothing to do with data or databases. */
    fun isOffTopic(answer: String): Boolean {
        val trimmed = answer.trim()
        // A reply that OPENS with the marker is a refusal; a marker buried later is stripped from the answer.
        if (OFF_TOPIC_LEADING_RE.containsMatchIn(trimmed) || OFF_TOPIC_LEADING_CI_RE.containsMatchIn(trimmed)) return true
        if (trimmed.length > OFF_TOPIC_MAX_REPLY_LENGTH) return false
        if (OFF_TOPIC_RE.containsMatchIn(trimmed)) return true
        // Any casing counts only when the sentinel IS the whole reply; mid-sentence it is English.
        return OFF_TOPIC_WHOLE_CI_RE.matches(trimmed)
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
    /**
     * Two tiers, because half of these words are ordinary English. "data", "key", "record", "index"
     * and "role" carried the same weight as "foreign key", so "what is the weather data for
     * tomorrow" was treated as a question about this database.
     */
    private val STRONG_VOCABULARY_RE = Regex(
        """\b(database|databases|db|dbs|dbms|rdbms|table|tables|column|columns|schema|schemas|catalog|sql|query|queries|statement|statements|subquery|cte|select|insert|update|delete|drop|alter|truncate|merge|upsert|join|joins|inner join|outer join|group by|order by|having|where clause|window function|aggregate|aggregation|pipeline|indexes|indices|primary key|foreign key|unique|constraint|constraints|trigger|triggers|materialized view|procedure|procedures|routine|routines|sequence|sequences|partition|partitions|partitioning|shard|sharding|replica|replication|tablespace|cursor|transaction|transactions|commit|rollback|isolation|deadlock|vacuum|cardinality|selectivity|explain|query plan|execution plan|normali[sz]\w*|denormali[sz]\w*|migration|migrations|migrate|autoincrement|datatype|data type|varchar|integer|bigint|numeric|decimal|boolean|timestamp|datetime|blob|clob|jsonb|uuid|nullable|erd|bson|objectid|collection|collections|document|documents|postgres|postgresql|pgsql|mysql|mariadb|oracle|plsql|sqlite|duckdb|mongo|mongodb|redis|mssql|sql server|sqlserver|snowflake|bigquery|redshift|clickhouse|cockroach|timescale|supabase|planetscale|nosql|olap|oltp|orm|etl|elt|warehouse|data ?lake|dataset|read replica)\b""",
        RegexOption.IGNORE_CASE,
    )

    /** The ambiguous half, which counts only inside a phrase that is unmistakably about a database. */
    private val WEAK_IN_CONTEXT_RE = Regex(
        """\b(?:primary|foreign|unique|composite|surrogate|natural|candidate|partition)\s+keys?\b|\bkeys?\s+(?:constraint|violation|column)\b|\b(?:create|drop|add|rebuild|missing|unused|covering|clustered|partial|composite)\s+index(?:es)?\b|\bindex(?:es|ing)?\s+(?:on|for|scan|seek|usage|strategy)\b|\bdata\s+(?:type|types|model|modelling|modeling|warehouse|lake|set|sets|base|integrity|quality)\b|\b(?:row|rows|record|records|field|fields)\s+(?:in|from|of|per|with|where|count|returned)\b|\b(?:how many|number of|count of|total)\s+(?:rows|records|fields|columns)\b|\b(?:materiali[sz]ed|create|drop|define)\s+views?\b|\bviews?\s+(?:definition|named|on)\b|\bnulls?\s+(?:values?|constraint)\b|\b(?:is|not)\s+null\b|\bstatistics\s+(?:on|for)\s+(?:the\s+|this\s+|a\s+)?(?:table|tables|column|columns|index|indexes|query|queries|database|db|schema)\b|\b(?:grant|revoke)\s+(?:role|privilege)|\broles?\s+(?:privileges?|permissions?|grants?)\b|\block(?:s|ing)?\s+(?:contention|timeout|wait|table|escalation)\b|\bcluster(?:ed)?\s+(?:index|key|by)\b|\bfunctions?\s+(?:in|on)\s+(?:postgres|postgresql|mysql|oracle|sqlite|duckdb|mongo|sql)\b|\bstored\s+(?:function|procedure)s?\b|\brelationships?\s+between\b|\b(?:entity|entities)\s+(?:relationship|model)\b|\bbackup\s+(?:and|the|my|this)\s+(?:restore|database|db|data)\b|\bdump\s+the\s+(?:database|db|table|schema)\b""",
        RegexOption.IGNORE_CASE,
    )

    fun looksDatabaseRelated(question: String): Boolean =
        STRONG_VOCABULARY_RE.containsMatchIn(question) || WEAK_IN_CONTEXT_RE.containsMatchIn(question)

    /**
     * A third-person singular pronoun with nothing to bind it to. "What role did he play in the
     * film?" names no one, so the model picks a subject itself and answers about the wrong person.
     *
     * Third-person singular only: "their" is ordinary in "customers and their orders". A capitalised
     * word earlier in the question is the antecedent, and prior turns bind it too.
     */
    private val UNBOUND_PRONOUN_RE = Regex("""\b(he|him|his|she|her|hers)\b""", RegexOption.IGNORE_CASE)

    fun danglingReference(question: String, hasContext: Boolean): String? {
        if (hasContext) return null
        val match = UNBOUND_PRONOUN_RE.find(question) ?: return null
        val before = question.substring(0, match.range.first)
        // A proper noun earlier in the sentence is the antecedent; the first word is capitalisation.
        if (Regex("""\s\p{Lu}""").containsMatchIn(before)) return null
        return match.groupValues[1].lowercase()
    }

    /** Attempts to talk past the instructions rather than ask a question; declined in code, not by the model. */
    private const val NOT_MY_INSTRUCTIONS =
        """(?!\s+(?:table|collection|column|field|view|list|entry|entries|row|rows))"""

    /** Determiners stack freely: "ignore all the previous instructions" is one slot per word, not one. */
    private const val INJECTION_DETERMINERS = """(?:(?:all|any|the|your|our|my|these|those)\s+)*"""
    private const val INJECTION_QUALIFIERS =
        """(?:(?:previous|prior|earlier|above|preceding|system|initial|original)\s+)?"""

    private val PROMPT_INJECTION_RE = Regex(
        listOf(
            """\b(?:ignore|disregard|forget|override|discard)\s+$INJECTION_DETERMINERS$INJECTION_QUALIFIERS(?:instructions?|prompts?|rules?)\b$NOT_MY_INSTRUCTIONS""",
            // "the instructions" alone is not enough: a table can be called that, and "show me the
            // instructions for order 42" is an ordinary data question.
            """\b(?:print|reveal|show|repeat|output|tell|give)\s+(?:me\s+)?(?:your\s+$INJECTION_QUALIFIERS(?:prompt|instructions)|the\s+(?:system|initial|original)\s+(?:prompt|instructions))\b$NOT_MY_INSTRUCTIONS""",
            """\bwhat\s+(?:is|are|were)\s+your\s+(?:system\s+)?(?:prompt|instructions|rules)\b""",
            """\byour\s+new\s+(?:instructions?|prompts?|rules?)\b""",
            """\b(?:from\s+now\s+on,?\s+)?you\s+are\s+now\s+(?:a|an|no\s+longer)\b""",
            """\bfrom\s+now\s+on,?\s+you\s+(?:are|will|must)\b""",
            """\bpretend\s+(?:to\s+be|you\s+are)\b""",
            """\bact\s+as\s+(?:if|though)\s+you\b""",
        ).joinToString("|"),
        RegexOption.IGNORE_CASE,
    )

    fun isPromptInjection(question: String): Boolean = PROMPT_INJECTION_RE.containsMatchIn(question)

    /** Questions about AskSQL itself, answered from code rather than generated by the model. */
    private val CAPABILITY_RE = Regex(
        listOf(
            // The boundary matters: "who are your top customers" is a data question.
            """\b(?:what can you do|what do you do|what are you|who are you|how do you work)\b""",
            """\bwhat is asksql\b""",
            """\b(?:is asksql|are you|is (?:this|it)) (?:safe|read[- ]?only)\b""",
            // The object has to END the question: once it carries a qualifier it is a concrete
            // request, not a question about AskSQL, and belongs on the write path.
            """\b(?:can|could|will|would|do|does|are you able to|is it able to)\s+(?:you\s+|it\s+|asksql\s+)?(?:ever\s+)?""" +
                """(?:delete|drop|update|insert|modify|change|write|edit|alter|remove)\s+(?:to\s+)?(?:my\s+|the\s+|any\s+|our\s+)?""" +
                """(?:data|database|db|records?|rows?|tables?|schema|anything|something|things|it|this|that)(?:\s+(?:tables?|records?|rows?|data))?""" +
                // A generic tail keeps it a question about AskSQL; a concrete one (a WHERE clause, a
                // named table) makes it a real request, which belongs on the write-proposal path.
                """(?:\s+(?:please|thanks|thank you|ever|at all|for me|or not|in any way|(?:from|in|on)\s+(?:the\s+|my\s+|our\s+)?(?:database|db|schema|tables?)))*\s*[?.!]*\s*$""",
            """\b(?:will|does|can|could)\s+(?:this|that|it|asksql)\s+(?:ever\s+)?(?:change|modify|alter|affect|delete|update|write to|touch)\s+(?:my\s+|the\s+|any\s+|our\s+)?(?:data|database|db|records?|rows?|tables?|schema|anything|something)\b""",
            """\bis my data safe\b""",
            """\b(?:do|does|will)\s+(?:you|it|asksql)\s+(?:store|keep|save|retain|send|share|upload|log)\s+(?:my|our|the)\s+(?:data|queries|questions|schema|results)\b""",
            """\bwhere\s+(?:does|do)\s+(?:my|our)\s+(?:data|queries)\s+go\b""",
        ).joinToString("|"),
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
