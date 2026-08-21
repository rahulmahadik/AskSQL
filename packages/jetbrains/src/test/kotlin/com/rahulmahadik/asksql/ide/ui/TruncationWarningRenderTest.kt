package com.rahulmahadik.asksql.ide.ui

import java.awt.BorderLayout
import java.awt.Rectangle
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO
import javax.swing.JPanel
import javax.swing.SwingUtilities
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Paints [warningsLabel] - the real function [TurnPanel.showResult] adds to its toolbar - with the
 * exact text a lowered-limit query now produces (see RowCapTruncationTest and the live run against a
 * real database). [ResultTablePanel] needs a running IntelliJ Application this suite does not
 * bootstrap, which is why the toolbar label is extracted and painted on its own rather than through
 * the full showResult call: this still exercises the production code, just not the whole assembly.
 */
class TruncationWarningRenderTest {

    @org.junit.Before fun requireRenderingRun() {
        org.junit.Assume.assumeTrue(
            "UI rendering is opt-in: pass -PrenderUi=true",
            System.getProperty("renderUi") == "true",
        )
    }

    @Test fun `the lowered-limit warning paints visibly, orange, in the real production label`() {
        lateinit var frame: javax.swing.JFrame
        lateinit var root: JPanel
        var image: BufferedImage? = null
        var labelBounds: Rectangle? = null

        SwingUtilities.invokeAndWait {
            val label = warningsLabel(listOf("The row limit was lowered to 100."))
            assertTrue("warningsLabel returned null for a non-empty warning list", label != null)
            assertTrue("the warning label is not the product's orange", label!!.foreground == com.intellij.ui.JBColor.ORANGE)

            root = JPanel(BorderLayout())
            root.add(label, BorderLayout.CENTER)
            frame = javax.swing.JFrame().apply { isUndecorated = true; contentPane = root; pack() }
            frame.setSize(400, 40)
            frame.validate()

            image = BufferedImage(400, 40, BufferedImage.TYPE_INT_ARGB)
            val g = image!!.createGraphics()
            root.paint(g)
            g.dispose()
            labelBounds = SwingUtilities.convertRectangle(label.parent, label.bounds, root)
            File("build/ui-render").mkdirs()
            ImageIO.write(image, "png", File("build/ui-render/truncation-warning.png"))
            frame.dispose()
        }

        assertTrue("the label has no width", labelBounds!!.width > 0)
        assertTrue("the label painted no visible text", inkColumns(image!!, labelBounds!!).isNotEmpty())
    }

    private fun inkColumns(image: BufferedImage, area: Rectangle): List<Int> {
        val background = image.getRGB(1, 1)
        val columns = mutableListOf<Int>()
        for (x in area.x.coerceAtLeast(0) until (area.x + area.width).coerceAtMost(image.width)) {
            for (y in area.y.coerceAtLeast(0) until (area.y + area.height).coerceAtMost(image.height)) {
                val pixel = image.getRGB(x, y)
                if ((pixel ushr 24) != 0 && pixel != background) {
                    columns += x
                    break
                }
            }
        }
        return columns
    }
}
