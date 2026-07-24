package com.rahulmahadik.asksql.ide.test

/** JUnit [org.junit.experimental.categories.Category] marker for tests backed by a real external dependency the fast default `test` task cannot assume is present - Docker/Testcontainers, or a locally-running LLM server. Excluded from `test` by default, run via `./gradlew test -PintegrationTests=true`. */
interface IntegrationTest
