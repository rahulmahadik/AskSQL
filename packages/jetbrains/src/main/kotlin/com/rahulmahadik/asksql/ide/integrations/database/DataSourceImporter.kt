package com.rahulmahadik.asksql.ide.integrations.database

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.rahulmahadik.asksql.ide.model.EngineKind

/** Reflective import of connection basics (never a password) from the Database plugin; every step fails soft to an empty list. */
object DataSourceImporter {

    data class ImportedDataSource(val name: String, val engine: EngineKind, val host: String?, val port: Int?, val database: String?, val user: String?)

    private val log = logger<DataSourceImporter>()
    private const val DATABASE_PLUGIN_MARKER_CLASS = "com.intellij.database.dataSource.LocalDataSource"

    fun isDatabasePluginAvailable(): Boolean = try {
        Class.forName(DATABASE_PLUGIN_MARKER_CLASS)
        true
    } catch (e: ClassNotFoundException) {
        false
    }

    /** Returns whatever data sources could be read; empty (never throws) if the Database plugin isn't present or its API doesn't match. */
    fun listImportableDataSources(project: Project): List<ImportedDataSource> {
        if (!isDatabasePluginAvailable()) return emptyList()
        return try {
            reflectDataSources(project)
        } catch (e: Exception) {
            log.info("AskSQL: could not reflectively read Database-plugin data sources (non-fatal, feature skipped): ${e.message}")
            emptyList()
        }
    }

    private fun reflectDataSources(project: Project): List<ImportedDataSource> {
        val facadeClass = Class.forName("com.intellij.database.psi.DbPsiFacade")
        val getInstance = facadeClass.getMethod("getInstance", com.intellij.openapi.project.Project::class.java)
        val facade = getInstance.invoke(null, project) ?: return emptyList()

        val getDataSourceManagers = facadeClass.getMethod("getDataSourceManagers")
        @Suppress("UNCHECKED_CAST")
        val managers = getDataSourceManagers.invoke(facade) as? Collection<Any> ?: return emptyList()

        val result = mutableListOf<ImportedDataSource>()
        for (manager in managers) {
            val getDataSources = manager.javaClass.getMethod("getDataSources")
            @Suppress("UNCHECKED_CAST")
            val dataSources = getDataSources.invoke(manager) as? Collection<Any> ?: continue
            for (ds in dataSources) {
                result += reflectOneDataSource(ds) ?: continue
            }
        }
        return result
    }

    private fun reflectOneDataSource(dataSource: Any): ImportedDataSource? {
        fun stringProp(name: String): String? = runCatching {
            dataSource.javaClass.getMethod(name).invoke(dataSource) as? String
        }.getOrNull()
        fun intProp(name: String): Int? = runCatching {
            dataSource.javaClass.getMethod(name).invoke(dataSource) as? Int
        }.getOrNull()

        val name = stringProp("getName") ?: return null
        val urlOrHost = stringProp("getUrl") ?: stringProp("getHost")
        val engine = guessEngine(urlOrHost, stringProp("getDatabaseDriver")) ?: return null

        return ImportedDataSource(
            name = name,
            engine = engine,
            host = stringProp("getHost"),
            port = intProp("getPort"),
            database = stringProp("getDatabaseName") ?: stringProp("getDatabase"),
            user = stringProp("getUsername") ?: stringProp("getUser"),
        )
    }

    private fun guessEngine(url: String?, driverHint: String?): EngineKind? {
        val text = "${url.orEmpty()} ${driverHint.orEmpty()}".lowercase()
        return when {
            "postgres" in text -> EngineKind.POSTGRES
            "mysql" in text || "mariadb" in text -> EngineKind.MYSQL
            "sqlite" in text -> EngineKind.SQLITE
            "duckdb" in text -> EngineKind.DUCKDB
            "oracle" in text -> EngineKind.ORACLE
            else -> null
        }
    }
}
