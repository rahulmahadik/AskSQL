package com.rahulmahadik.asksql.ide.settings

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.components.service
import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * PasswordSafe-backed secret storage; entry points hop to [Dispatchers.IO] since PasswordSafe blocks.
 * DB passwords carry [ConnectionDescriptor.endpointIdentity] and are checked against it on read.
 */
object AskSqlSecrets {

    private fun passwordSafe(): PasswordSafe = service()

    private fun dbPasswordAttributes(connectionId: String) =
        CredentialAttributes(generateServiceName("AskSQL", "conn.$connectionId"))

    private fun apiKeyAttributes(provider: String) =
        CredentialAttributes(generateServiceName("AskSQL", "apiKey.$provider"))

    suspend fun getDbPassword(descriptor: ConnectionDescriptor): String? = withContext(Dispatchers.IO) {
        val stored = passwordSafe().get(dbPasswordAttributes(descriptor.id))?.getPasswordAsString() ?: return@withContext null
        val envelope = try {
            JsonParser.parseString(stored).asJsonObject
        } catch (e: Exception) {
            return@withContext null // corrupt/legacy envelope, fail closed: never treat raw text as the password
        }
        val storedEndpoint = envelope.get("endpoint")?.asString
        if (storedEndpoint != descriptor.endpointIdentity()) return@withContext null // fail-closed: endpoint mismatch
        envelope.get("password")?.asString
    }

    suspend fun setDbPassword(descriptor: ConnectionDescriptor, password: String?) = withContext(Dispatchers.IO) {
        val attrs = dbPasswordAttributes(descriptor.id)
        if (password == null) {
            passwordSafe().set(attrs, null)
            return@withContext
        }
        val envelope = JsonObject().apply {
            addProperty("endpoint", descriptor.endpointIdentity())
            addProperty("password", password)
        }
        passwordSafe().set(attrs, Credentials(descriptor.id, envelope.toString()))
    }

    suspend fun removeDbPassword(connectionId: String) = withContext(Dispatchers.IO) {
        passwordSafe().set(dbPasswordAttributes(connectionId), null)
    }

    suspend fun getApiKey(provider: String): String? = withContext(Dispatchers.IO) {
        passwordSafe().get(apiKeyAttributes(provider))?.getPasswordAsString()
    }

    suspend fun setApiKey(provider: String, key: String?) = withContext(Dispatchers.IO) {
        val attrs = apiKeyAttributes(provider)
        passwordSafe().set(attrs, key?.let { Credentials(provider, it) })
    }

    /**
     * Purges keychain entries for connection ids no longer present in app- or
     * project-level settings. Called from the Configurables after a connection is removed.
     */
    suspend fun pruneOrphaned(knownConnectionIds: Set<String>, previouslyKnownIds: Set<String>) {
        val removed = previouslyKnownIds - knownConnectionIds
        removed.forEach { removeDbPassword(it) }
    }
}
