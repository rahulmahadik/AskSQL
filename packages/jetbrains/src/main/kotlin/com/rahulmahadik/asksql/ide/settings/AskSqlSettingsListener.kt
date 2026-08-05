package com.rahulmahadik.asksql.ide.settings

import com.intellij.util.messages.Topic

/** Broadcast on the application message bus when AI-provider or connection settings change. */
fun interface AskSqlSettingsListener {
    fun settingsChanged()

    companion object {
        val TOPIC: Topic<AskSqlSettingsListener> = Topic.create("AskSQL settings changed", AskSqlSettingsListener::class.java)
    }
}
