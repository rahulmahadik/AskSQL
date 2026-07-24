package com.rahulmahadik.asksql.ide.guard

/** Stage/operator vocabulary for [com.rahulmahadik.asksql.ide.guard.MongoGuard]; original security surface with no `@asksql/core` counterpart. */
object MongoDenyLists {

    /**
     * Allowlist, not denylist: aggregation stages have no structural read/write split ($out looks
     * just like $match), so a future server-added stage is rejected by default, not silently allowed.
     */
    val ALLOWED_STAGES: Set<String> = setOf(
        "\$match", "\$project", "\$group", "\$sort", "\$limit", "\$skip", "\$unwind",
        "\$lookup", "\$facet", "\$count", "\$sample", "\$addFields", "\$set",
        "\$replaceRoot", "\$replaceWith", "\$bucket", "\$bucketAuto", "\$sortByCount",
        "\$graphLookup", "\$unionWith", "\$geoNear", "\$redact", "\$unset",
        "\$setWindowFields", "\$densify", "\$fill", "\$documents",
        // Atlas Search: read-only; a missing search index errors server-side, not something this guard polices.
        "\$search", "\$searchMeta",
    )

    /**
     * Banned at any nesting depth via a full document-tree walk (not just top-level keys):
     * these execute arbitrary server-side JavaScript, and $expr/$redact can embed them anywhere.
     */
    val DENIED_OPERATORS_ANYWHERE: Set<String> = setOf("\$where", "\$function", "\$accumulator")

    /** Stage keys whose value may carry a nested pipeline that must be recursively re-validated with the same rules (`$lookup`'s optional `pipeline`, `$unionWith`'s optional `pipeline`, `$facet`'s branches). */
    const val LOOKUP_STAGE = "\$lookup"
    const val UNION_WITH_STAGE = "\$unionWith"
    const val FACET_STAGE = "\$facet"
    const val LIMIT_STAGE = "\$limit"
}
