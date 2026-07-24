package com.rahulmahadik.asksql.ide.settings

import com.intellij.util.messages.Topic

/** Broadcast when AI-provider/connection settings change, so already-open UI can refresh without polling. Published on the application message bus. */
fun interface AskSqlSettingsListener {
    fun settingsChanged()

    companion object {
        val TOPIC: Topic<AskSqlSettingsListener> = Topic.create("AskSQL settings changed", AskSqlSettingsListener::class.java)
    }
}
