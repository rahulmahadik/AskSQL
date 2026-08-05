package com.rahulmahadik.asksql.ide.llm

import java.io.BufferedReader

/** Minimal Server-Sent-Events line reader: `data:` lines, blank-line terminators, and the `data: [DONE]` sentinel. */
class SseReader(private val reader: BufferedReader) {

    /** Invokes [onData] once per SSE `data:` payload; returns normally on stream end or `[DONE]`. */
    fun forEachDataLine(onData: (String) -> Boolean) {
        while (true) {
            val line = reader.readLine() ?: return
            if (line.isEmpty()) continue
            val payload = when {
                line.startsWith("data:") -> line.removePrefix("data:").trim()
                else -> continue // ignore event:/id:/retry: and any other framing line
            }
            if (payload == "[DONE]") return
            if (!onData(payload)) return
        }
    }
}
