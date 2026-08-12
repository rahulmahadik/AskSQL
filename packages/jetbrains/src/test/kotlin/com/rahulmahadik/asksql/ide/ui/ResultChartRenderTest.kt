package com.rahulmahadik.asksql.ide.ui

import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO
import javax.swing.JFrame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The chart is drawn with Graphics2D and had no coverage at all. Painting it is the only way to
 * catch a scaling mistake: the maths is invisible until pixels land in the wrong place.
 */
class ResultChartRenderTest {

    @org.junit.Before fun requireRenderingRun() {
        org.junit.Assume.assumeTrue(
            "UI rendering is opt-in: pass -PrenderUi=true",
            System.getProperty("renderUi") == "true",
        )
    }

    private val width = 420
    private val height = 260

    private fun paint(name: String, spec: ChartSpec): BufferedImage {
        val canvas = ResultChartPanel(spec).component
        val frame = JFrame().apply {
            isUndecorated = true
            contentPane = javax.swing.JPanel(java.awt.BorderLayout()).apply { add(canvas, java.awt.BorderLayout.CENTER) }
            pack()
            setSize(width, height)
        }
        frame.validate()
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB)
        val g = image.createGraphics()
        canvas.paint(g)
        g.dispose()
        frame.dispose()
        File("build/ui-render").mkdirs()
        ImageIO.write(image, "png", File("build/ui-render/chart-$name.png"))
        return image
    }

    private fun bars(vararg values: Pair<String, Double>) =
        ChartSpec(ChartKind.BAR, "label", listOf(ChartSeries("amount", values.map { ChartPoint(it.first, it.second) })))

    /** Any pixel that is neither transparent nor the panel's own background. */
    private fun inkCount(image: BufferedImage): Int {
        val background = image.getRGB(1, 1)
        var n = 0
        for (y in 0 until image.height) for (x in 0 until image.width) {
            val p = image.getRGB(x, y)
            if ((p ushr 24) != 0 && p != background) n++
        }
        return n
    }

    @Test fun `a bar chart paints`() {
        assertTrue(inkCount(paint("bars", bars("a" to 3.0, "b" to 7.0, "c" to 5.0))) > 200)
    }

    @Test fun `a line chart paints`() {
        val spec = ChartSpec(ChartKind.LINE, "day", listOf(ChartSeries("hits", (1..6).map { ChartPoint("d$it", it * 2.0) })))
        assertTrue(inkCount(paint("line", spec)) > 200)
    }

    /** span falls back to 1.0 when every value is equal; without it the scale divides by zero. */
    @Test fun `identical values do not divide by zero`() {
        assertTrue(inkCount(paint("flat", bars("a" to 4.0, "b" to 4.0, "c" to 4.0))) > 100)
    }

    @Test fun `all zero values still paint axes and labels`() {
        assertTrue(inkCount(paint("zeros", bars("a" to 0.0, "b" to 0.0))) > 50)
    }

    /** The axis always includes zero, so negatives have somewhere to go. */
    @Test fun `negative values paint`() {
        assertTrue(inkCount(paint("negative", bars("a" to -5.0, "b" to -2.0))) > 100)
    }

    @Test fun `a mixed sign series paints`() {
        assertTrue(inkCount(paint("mixed", bars("a" to -4.0, "b" to 6.0))) > 100)
    }

    @Test fun `a single point paints, with no step to divide by`() {
        val spec = ChartSpec(ChartKind.LINE, "day", listOf(ChartSeries("hits", listOf(ChartPoint("only", 5.0)))))
        assertTrue(inkCount(paint("single", spec)) > 20)
    }

    @Test fun `several series paint a legend`() {
        val spec = ChartSpec(
            ChartKind.BAR,
            "label",
            listOf(
                ChartSeries("first", listOf(ChartPoint("a", 3.0), ChartPoint("b", 5.0))),
                ChartSeries("second", listOf(ChartPoint("a", 4.0), ChartPoint("b", 2.0))),
            ),
        )
        assertTrue(inkCount(paint("multi", spec)) > 200)
    }

    /** Very large and very small magnitudes go through the same scale. */
    @Test fun `extreme magnitudes paint`() {
        assertTrue(inkCount(paint("huge", bars("a" to 1e12, "b" to 2e12))) > 100)
        assertTrue(inkCount(paint("tiny", bars("a" to 1e-9, "b" to 2e-9))) > 100)
    }
}
