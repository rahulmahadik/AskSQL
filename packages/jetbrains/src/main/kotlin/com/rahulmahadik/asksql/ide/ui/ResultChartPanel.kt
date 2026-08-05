package com.rahulmahadik.asksql.ide.ui

import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import java.awt.BasicStroke
import java.awt.Color
import java.awt.Dimension
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import javax.swing.JPanel
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Draws a [ChartSpec] with Graphics2D, with no charting-library dependency. */
class ResultChartPanel(private val spec: ChartSpec) {

    private companion object {
        /** Distinct in both themes, and distinguishable in the common forms of colour blindness. */
        val SERIES_COLORS = listOf(
            JBColor(Color(0x31, 0x6D, 0xCA), Color(0x6A, 0x9F, 0xE8)),
            JBColor(Color(0xC2, 0x5D, 0x1E), Color(0xE0, 0x8B, 0x4F)),
            JBColor(Color(0x2E, 0x8B, 0x57), Color(0x5F, 0xB8, 0x83)),
            JBColor(Color(0x7A, 0x4C, 0xA8), Color(0xA9, 0x84, 0xD6)),
        )
        const val Y_TICKS = 4
    }

    val component: JPanel = ChartCanvas()

    private inner class ChartCanvas : JPanel() {

        init {
            isOpaque = false
            preferredSize = Dimension(JBUI.scale(420), JBUI.scale(240))
            minimumSize = Dimension(JBUI.scale(240), JBUI.scale(180))
            toolTipText = "${spec.labelColumn} vs ${spec.series.joinToString(", ") { it.name }}"
        }

        override fun paintComponent(g: Graphics) {
            super.paintComponent(g)
            val g2 = g.create() as Graphics2D
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
                paintChart(g2)
            } finally {
                g2.dispose()
            }
        }

        private fun paintChart(g2: Graphics2D) {
            val metrics = g2.fontMetrics
            val lineHeight = metrics.height
            val legendHeight = if (spec.series.size > 1) lineHeight + JBUI.scale(6) else 0
            val gutterLeft = JBUI.scale(52)
            val gutterBottom = lineHeight + JBUI.scale(8)
            val padding = JBUI.scale(8)

            val plotLeft = gutterLeft
            val plotTop = padding + legendHeight
            val plotRight = width - padding
            val plotBottom = height - gutterBottom
            if (plotRight <= plotLeft || plotBottom <= plotTop) return

            // The axis always includes zero: a floating baseline exaggerates small differences.
            val values = spec.series.flatMap { series -> series.points.map { it.value } }
            val upper = max(0.0, values.maxOrNull() ?: 0.0)
            val lower = min(0.0, values.minOrNull() ?: 0.0)
            val span = (upper - lower).takeIf { it > 0.0 } ?: 1.0

            fun yFor(value: Double): Int = plotBottom - (((value - lower) / span) * (plotBottom - plotTop)).roundToInt()

            if (legendHeight > 0) paintLegend(g2, padding, padding + metrics.ascent)
            paintAxes(g2, plotLeft, plotTop, plotRight, plotBottom, lower, span, ::yFor)

            val labels = spec.series.first().points.map { it.label }
            when (spec.kind) {
                ChartKind.BAR -> paintBars(g2, plotLeft, plotRight, plotBottom, ::yFor)
                ChartKind.LINE -> paintLines(g2, plotLeft, plotRight, ::yFor)
            }
            paintXLabels(g2, labels, plotLeft, plotRight, plotBottom, metrics.ascent)
        }

        private fun paintLegend(g2: Graphics2D, x: Int, baseline: Int) {
            var cursor = x
            val swatch = JBUI.scale(9)
            for ((index, series) in spec.series.withIndex()) {
                g2.color = SERIES_COLORS[index % SERIES_COLORS.size]
                g2.fillRect(cursor, baseline - swatch, swatch, swatch)
                cursor += swatch + JBUI.scale(4)
                g2.color = JBColor.foreground()
                g2.drawString(series.name, cursor, baseline)
                cursor += g2.fontMetrics.stringWidth(series.name) + JBUI.scale(14)
            }
        }

        private fun paintAxes(
            g2: Graphics2D,
            left: Int,
            top: Int,
            right: Int,
            bottom: Int,
            lower: Double,
            span: Double,
            yFor: (Double) -> Int,
        ) {
            val metrics = g2.fontMetrics
            for (tick in 0..Y_TICKS) {
                val value = lower + span * tick / Y_TICKS
                val y = yFor(value)
                g2.color = JBColor.border()
                g2.drawLine(left, y, right, y)
                val text = formatTick(value, span)
                g2.color = JBColor.GRAY
                g2.drawString(text, left - metrics.stringWidth(text) - JBUI.scale(6), y + metrics.ascent / 2)
            }
            g2.color = JBColor.border()
            g2.drawLine(left, top, left, bottom)
        }

        private fun paintBars(g2: Graphics2D, left: Int, right: Int, bottom: Int, yFor: (Double) -> Int) {
            val points = spec.series.first().points.size
            if (points == 0) return
            val slot = (right - left).toDouble() / points
            val barGroup = slot * 0.72
            val barWidth = max(1.0, barGroup / spec.series.size)
            val zeroY = yFor(0.0)
            for ((seriesIndex, series) in spec.series.withIndex()) {
                g2.color = SERIES_COLORS[seriesIndex % SERIES_COLORS.size]
                for ((pointIndex, point) in series.points.withIndex()) {
                    val x = left + slot * pointIndex + (slot - barGroup) / 2 + barWidth * seriesIndex
                    val y = yFor(point.value)
                    // A zero-height bar is invisible, which reads as missing data rather than a zero.
                    val barHeight = max(1, abs(y - zeroY))
                    g2.fillRect(x.roundToInt(), min(y, zeroY), max(1, barWidth.roundToInt() - 1), barHeight)
                }
            }
            g2.color = JBColor.border()
            g2.drawLine(left, zeroY, right, zeroY)
        }

        private fun paintLines(g2: Graphics2D, left: Int, right: Int, yFor: (Double) -> Int) {
            val points = spec.series.first().points.size
            if (points == 0) return
            val step = if (points == 1) 0.0 else (right - left).toDouble() / (points - 1)
            val dot = JBUI.scale(3)
            g2.stroke = BasicStroke(JBUI.scale(2).toFloat(), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND)
            for ((seriesIndex, series) in spec.series.withIndex()) {
                g2.color = SERIES_COLORS[seriesIndex % SERIES_COLORS.size]
                var previousX = 0
                var previousY = 0
                for ((pointIndex, point) in series.points.withIndex()) {
                    val x = (left + step * pointIndex).roundToInt()
                    val y = yFor(point.value)
                    if (pointIndex > 0) g2.drawLine(previousX, previousY, x, y)
                    g2.fillOval(x - dot, y - dot, dot * 2, dot * 2)
                    previousX = x
                    previousY = y
                }
            }
        }

        /** Labels are drawn only while they fit without overlapping; past that, every nth. */
        private fun paintXLabels(g2: Graphics2D, labels: List<String>, left: Int, right: Int, bottom: Int, ascent: Int) {
            if (labels.isEmpty()) return
            val metrics = g2.fontMetrics
            val slot = (right - left).toDouble() / labels.size
            val widest = labels.maxOf { metrics.stringWidth(it) } + JBUI.scale(8)
            val stride = max(1, (widest / slot).toInt().let { if (it * slot < widest) it + 1 else it })
            g2.color = JBColor.GRAY
            for ((index, label) in labels.withIndex()) {
                if (index % stride != 0) continue
                val text = truncate(metrics, label, (slot * stride).toInt())
                val center = left + slot * index + slot / 2
                g2.drawString(text, (center - metrics.stringWidth(text) / 2.0).roundToInt(), bottom + ascent + JBUI.scale(4))
            }
        }

        private fun truncate(metrics: java.awt.FontMetrics, text: String, maxWidth: Int): String {
            if (metrics.stringWidth(text) <= maxWidth) return text
            var cut = text.length
            while (cut > 1 && metrics.stringWidth(text.take(cut) + "…") > maxWidth) cut--
            return text.take(cut) + "…"
        }
    }

    /** Whole numbers on a whole-number axis; a fractional span keeps enough digits to tell ticks apart. */
    private fun formatTick(value: Double, span: Double): String = when {
        span >= 10 || value == Math.floor(value) -> value.roundToInt().toString()
        span >= 1 -> String.format("%.1f", value)
        else -> String.format("%.3f", value)
    }
}
