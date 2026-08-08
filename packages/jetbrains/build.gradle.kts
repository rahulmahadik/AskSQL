import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile
import java.io.File

// AskSQL: JetBrains IDE plugin build script.
// Versions verified against Maven Central / Gradle Plugin Portal / GitHub releases on 2026-07-16; re-verify at each release rather than bumping blindly.
//
// Kotlin is pinned below the latest stable: newer compilers emit coroutine bytecode the 2025.2/2025.3
// bundled coroutines runtime can't parse, silently hanging every `withContext`; `javap -v` a suspend lambda before bumping.
plugins {
    id("java")
    kotlin("jvm") version "2.1.20"
    id("org.jetbrains.intellij.platform") version "2.18.1"
    id("org.jetbrains.changelog") version "2.5.0"
    id("org.jetbrains.kotlinx.kover") version "0.9.1"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        create(providers.gradleProperty("platformType"), providers.gradleProperty("platformVersion")) {
            // Maven resolution instead of the CDN installer download: more reliable in sandboxed/restricted-network builds.
            useInstaller = false
        }

        pluginVerifier()
        zipSigner()
        testFramework(TestFrameworkType.Platform)
    }

    // --- Bundled into the plugin distribution (per-plugin classloader, no conflict with the host IDE). ---
    // jsqlparser's POM mis-scopes its benchmark harness (jmh-core + transitives, ~2.8 MB) as a
    // runtime dependency; it's unreachable from the parsing/AST code, so exclude it from the zip.
    implementation("com.github.jsqlparser:jsqlparser:5.3") {
        exclude(group = "org.openjdk.jmh", module = "jmh-core")
    }
    // pgjdbc's POM similarly mis-scopes checker-framework's annotation-only
    // (no runtime behavior) checker-qual as a runtime dependency.
    implementation("org.postgresql:postgresql:42.7.13") {
        exclude(group = "org.checkerframework", module = "checker-qual")
    }
    implementation("org.mariadb.jdbc:mariadb-java-client:3.5.9")
    implementation("org.xerial:sqlite-jdbc:3.53.2.0")
    // Gson's POM likewise mis-scopes error_prone_annotations (annotation-only, no runtime behavior).
    implementation("com.google.code.gson:gson:2.14.0") {
        exclude(group = "com.google.errorprone", module = "error_prone_annotations")
    }
    // DuckDB and Oracle are deliberately ABSENT: lazy-downloaded and SHA-256-verified at runtime by
    // DriverProvisioner (DuckDB for size, Oracle for its non-OSI license); MongoDB (Apache-2.0, ~2.7 MB) is bundled.
    implementation("org.mongodb:mongodb-driver-sync:5.9.0")

    // compileOnly: the IntelliJ Platform bundles its own Kotlin coroutines runtime, so this compiles
    // against an older, stable API (1.9.0) rather than bundling a second copy that could conflict.
    compileOnly("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")

    // pgjdbc's public API carries checker-framework @Nullable annotations Kotlin needs to resolve at compile time only.
    testCompileOnly("org.checkerframework:checker-qual:4.2.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    // Testcontainers 2.0.x exists for the core artifact only; postgresql/mysql/oracle-xe/mongodb/
    // junit-jupiter haven't published a 2.x release yet, so 1.21.4 is the current release everywhere.
    testImplementation("org.testcontainers:testcontainers:1.21.4")
    testImplementation("org.testcontainers:postgresql:1.21.4")
    testImplementation("org.testcontainers:mysql:1.21.4")
    // Test-only: testcontainers' MySQLContainer readiness probe requires the com.mysql.cj driver.
    // Production ships the MariaDB driver (above); this is never distributed.
    testImplementation("com.mysql:mysql-connector-j:9.1.0")
    testImplementation("org.testcontainers:oracle-xe:1.21.4")
    testImplementation("org.testcontainers:mongodb:1.21.4")
    testImplementation("org.testcontainers:junit-jupiter:1.21.4")
}

// Rendered eagerly into a plain String: a Provider lambda capturing `changelog` directly would hold
// a Project reference internally, breaking Gradle's configuration-cache serialization.
val changeNotesHtml: String = run {
    val version = providers.gradleProperty("pluginVersion").get()
    if (changelog.has(version)) {
        changelog.renderItem(changelog.get(version), org.jetbrains.changelog.Changelog.OutputType.HTML)
    } else {
        "See the full changelog at ${changelog.repositoryUrl.get()}/blob/main/packages/jetbrains/CHANGELOG.md"
    }
}

intellijPlatform {
    // Kotlin already enforces null-safety at the language level, so the Ant-based @NotNull
    // instrumentation step adds no value and hits an unrelated ArrayIndexOutOfBoundsException here.
    instrumentCode = false

    pluginConfiguration {
        id = "com.rahulmahadik.asksql"
        name = providers.gradleProperty("pluginName")
        version = providers.gradleProperty("pluginVersion")

        vendor {
            name = "Rahul Mahadik"
            email = "rahultkiet@gmail.com"
            url = "https://github.com/rahulmahadik/AskSQL"
        }

        ideaVersion {
            // Floor 2024.2 (build 242), open-ended upper bound: the plugin stays installable on new
            // majors until the Plugin Verifier's EAP run proves otherwise (a verifier failure blocks release).
            // 2024.1 is out of reach: com.intellij.util.net.JdkProxyProvider, which routes LLM calls
            // through the IDE's proxy settings, arrives in 242.
            sinceBuild = "242"
            untilBuild = provider { null }
        }

        // Renders THIS version's own CHANGELOG.md section as the
        // Marketplace "What's New" tab.
        changeNotes = provider { changeNotesHtml }
    }

    pluginVerification {
        ides {
            // ideaIC publishes both build-number and marketing-version Maven
            // artifacts; build numbers pin the exact floor/latest builds.
            create(IntelliJPlatformType.IntellijIdeaCommunity, "2024.2")  // 2024.2 (compatibility floor)
            create(IntelliJPlatformType.IntellijIdeaCommunity, "2024.3")
            create(IntelliJPlatformType.IntellijIdeaCommunity, "251.29188.72")  // 2025.1
            create(IntelliJPlatformType.IntellijIdeaCommunity, "252.28539.54")  // 2025.2.6.2
            create(IntelliJPlatformType.IntellijIdeaCommunity, "253.28294.334") // 2025.3 (IC's own latest stable)
            // Full cross-IDE matrix only when ASKSQL_VERIFY_FULL=true (the release workflow sets it); per-push CI verifies the IC floor+latest above to avoid ~10 cold IDE downloads.
            if (providers.environmentVariable("ASKSQL_VERIFY_FULL").orNull == "true") {
                // Every major IntelliJ-Platform IDE (Fleet excluded: it uses a different plugin model).
                // These publish Maven artifacts under the marketing version only.
                create(IntelliJPlatformType.IntellijIdeaUltimate, "2026.1.4")
                create(IntelliJPlatformType.Rider, "2026.1.4")
                create(IntelliJPlatformType.PyCharmProfessional, "2026.1.4")
                create(IntelliJPlatformType.GoLand, "2026.1.4")
                create(IntelliJPlatformType.WebStorm, "2026.1.4")
                create(IntelliJPlatformType.PhpStorm, "2026.1.4")
                create(IntelliJPlatformType.CLion, "2026.1.4")
                create(IntelliJPlatformType.RubyMine, "2026.1.4")
                create(IntelliJPlatformType.RustRover, "2026.1.4")
            }
            // DataGrip omitted: IPGP 2.18.1's releases-API lookup for product code "DB" is broken upstream.
            // Android Studio isn't on the JetBrains releases API; verify against a local install
            // only when present, so verifyPlugin doesn't fail outright on CI runners.
            val androidStudioPath = "/Applications/Android Studio.app/Contents"
            if (File(androidStudioPath).exists()) local(androidStudioPath)
        }
        failureLevel = listOf(
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.INVALID_PLUGIN,
        )
    }

    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }

    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
        // Channel derives from the version suffix in the publish workflow (stable unless -eap/-beta); plugin default here.
    }
}

changelog {
    version = providers.gradleProperty("pluginVersion")
    groups.empty()
    repositoryUrl = "https://github.com/rahulmahadik/AskSQL"
}

kotlin {
    jvmToolchain(21)
}

// Coverage floor for the Kotlin engine. Set just under the current line coverage so it cannot
// slide; the UI packages are Swing and largely undriven by tests, which is what holds it here.
kover {
    reports {
        verify {
            rule {
                bound {
                    minValue = 40
                    coverageUnits = kotlinx.kover.gradle.plugin.dsl.CoverageUnit.LINE
                }
            }
        }
    }
}

tasks {
    withType<KotlinCompile> {
        compilerOptions {
            // Plain compiler flag, not the typed `jvmDefault` DSL property: stays valid across the
            // range of Kotlin Gradle plugin versions this project may need (see the version comment above).
            freeCompilerArgs.addAll("-Xjsr305=strict", "-Xjvm-default=all")
        }
    }

    // Print the full exception chain in CI logs; the default truncates at the first cause.
    withType<Test>().configureEach {
        testLogging {
            showCauses = true
            showStackTraces = true
            exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        }
    }

    test {
        // Unit tests by default; -PintegrationTests=true runs the integration category through this same task.
        val integration = providers.gradleProperty("integrationTests").orNull == "true"
        useJUnit {
            if (integration) {
                includeCategories("com.rahulmahadik.asksql.ide.test.IntegrationTest")
            } else {
                excludeCategories("com.rahulmahadik.asksql.ide.test.IntegrationTest")
            }
        }
        systemProperty("idea.force.use.core.classloader", "true")
        // Painting Swing to a PNG needs real font metrics and a window peer: opt in with -PrenderUi=true.
        if (providers.gradleProperty("renderUi").orNull == "true") {
            systemProperty("java.awt.headless", "false")
            systemProperty("renderUi", "true")
        }
        maxHeapSize = "2g"
    }

    // Regenerates the golden guard/prompt parity vectors from the published @asksql/core (see tools/parity/).
    register<Exec>("parityVectors") {
        group = "verification"
        description = "Regenerates golden parity vectors from the published @asksql/core via Node (CI + local dev only)."
        workingDir = file("tools/parity")
        commandLine("npm", "run", "export")
    }

    // Both Configurables and every action are indexed here; without it "AskSQL" finds nothing in
    // the Settings search field. Costs a headless IDE run at build time.
    buildSearchableOptions {
        enabled = true
    }

    // Hand-maintained rather than a license-scanning plugin: the bundled dependency set is small
    // and changes rarely, so a static list is simpler and more auditable.
    val thirdPartyNotices = register("thirdPartyNotices") {
        group = "build"
        description = "Generates THIRD-PARTY-NOTICES.txt for every bundled runtime dependency."
        val outputFile = layout.buildDirectory.file("generated/THIRD-PARTY-NOTICES.txt")
        outputs.file(outputFile)
        doLast {
            outputFile.get().asFile.also { it.parentFile.mkdirs() }.writeText(
                """
                AskSQL for JetBrains IDEs: Third-Party Notices
                ================================================
                This plugin bundles the following runtime dependencies:

                * JSqlParser 5.3: Apache License 2.0
                  https://github.com/JSQLParser/JSqlParser

                * PostgreSQL JDBC Driver (pgjdbc) 42.7.13: BSD 2-Clause License
                  https://github.com/pgjdbc/pgjdbc

                * MariaDB Connector/J 3.5.9: GNU Lesser General Public License v2.1 (LGPL-2.1)
                  https://github.com/mariadb-corporation/mariadb-connector-j
                  (Used for MySQL/MariaDB connectivity in place of MySQL Connector/J, which is
                   GPL-2.0 with the Universal FOSS Exception; the LGPL driver avoids that
                   redistribution ambiguity for an Apache-2.0-licensed plugin.)

                * SQLite JDBC (Xerial) 3.53.2.0: Apache License 2.0
                  https://github.com/xerial/sqlite-jdbc

                * Gson 2.14.0: Apache License 2.0
                  https://github.com/google/gson

                * MongoDB Java Driver (mongodb-driver-sync, mongodb-driver-core, bson,
                  bson-record-codec, the last a transitive dependency of bson) 5.9.0:
                  Apache License 2.0
                  https://github.com/mongodb/mongo-java-driver

                DuckDB JDBC (org.duckdb:duckdb_jdbc, MIT License) is NOT bundled in this zip.
                It is downloaded on first use directly from Maven Central, verified by SHA-256
                checksum. See https://github.com/duckdb/duckdb for its license.

                Oracle JDBC Driver (com.oracle.database.jdbc:ojdbc11) is likewise NOT bundled.
                It ships under the Oracle Free Use Terms and Conditions (FUTC), not an
                OSI-approved license, so it is downloaded on first use directly from Maven
                Central and verified by SHA-256 checksum instead of being redistributed in this
                zip. See https://www.oracle.com/downloads/licenses/oracle-free-license.html.

                Full license texts are available at each project's repository above.
                """.trimIndent() + "\n",
            )
        }
    }

    // `dependsOn` alone only orders task execution; `from(...)` is what actually places the
    // generated notices and LICENSE into the plugin's distributed content.
    named<org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask>("prepareSandbox") {
        dependsOn(thirdPartyNotices)
        from(thirdPartyNotices.map { it.outputs.files.singleFile }) {
            into(pluginName.map { "$it/lib" })
        }
        from(file("LICENSE")) {
            into(pluginName.map { "$it/lib" })
        }
    }
}

