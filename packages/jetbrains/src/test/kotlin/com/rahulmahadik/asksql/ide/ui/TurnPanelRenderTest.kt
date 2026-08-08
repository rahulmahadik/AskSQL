package com.rahulmahadik.asksql.ide.ui

import com.intellij.openapi.project.Project

import java.awt.Container
import java.awt.Rectangle
import java.awt.image.BufferedImage
import java.io.File
import java.lang.reflect.Proxy
import javax.imageio.ImageIO
import javax.swing.JEditorPane
import javax.swing.JPanel
import javax.swing.SwingUtilities
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Paints a turn to a PNG under build/ui-render/ and asserts its geometry: the question hugs the
 * right edge and sits in its bubble, the assistant's header hugs the left, and a wrapped answer
 * keeps every line it wrapped to.
 */
class TurnPanelRenderTest {

    @org.junit.Before fun requireRenderingRun() {
        org.junit.Assume.assumeTrue(
            "UI rendering is opt-in: pass -PrenderUi=true",
            System.getProperty("renderUi") == "true",
        )
    }

    /** Only the [SqlBlockPanel]/[ResultTablePanel] paths touch the project, and this test avoids them. */
    private fun stubProject(): Project =
        Proxy.newProxyInstance(Project::class.java.classLoader, arrayOf(Project::class.java)) { _, method, _ ->
            when (method.returnType) {
                Boolean::class.javaPrimitiveType -> false
                String::class.java -> ""
                else -> null
            }
        } as Project

    private val width = 420

    private val defaultQuestion = "which customers spent the most last quarter?"

    /** One paint, in image coordinates. */
    private class Rendered(
        val image: BufferedImage,
        val turnContent: Rectangle,
        val paneBounds: List<Rectangle>,
        val copyButtons: List<Rectangle>,
    )

    /**
     * Mirrors how a turn reaches the screen: a column that already has its width gains one turn and
     * is laid out once. Each step is a separate EDT block, so anything a component queues for after
     * a layout pass runs between the passes, as it would in a running IDE.
     */
    private fun render(name: String, question: String = defaultQuestion, build: (TurnPanel) -> Unit = {}): Rendered {
        lateinit var frame: javax.swing.JFrame
        lateinit var root: JPanel

        // Swing paints nothing for a component with no peer.
        onEdt {
            root = JPanel(java.awt.BorderLayout())
            frame = javax.swing.JFrame().apply {
                isUndecorated = true
                contentPane = root
                pack()
            }
            frame.setSize(width, 2000)
            frame.validate()
        }

        // NORTH gives the turn precisely the height it asked for; no second layout pass.
        onEdt {
            val turn = TurnPanel(stubProject(), question)
            build(turn)
            root.add(turn.component, java.awt.BorderLayout.NORTH)
            root.revalidate()
            frame.validate()
        }

        lateinit var rendered: Rendered
        onEdt {
            // AllIcons paints nothing outside an IDE. Swapped after layout, so bounds stay the product's.
            copyControls(root).forEach { it.icon = STAND_IN_ICON }
            val turnComponent = root.getComponent(0) as Container
            val image = BufferedImage(width, turnComponent.height.coerceAtLeast(80), BufferedImage.TYPE_INT_ARGB)
            val g = image.createGraphics()
            root.paint(g)
            g.dispose()
            val bounds = editorPanes(root).map { SwingUtilities.convertRectangle(it.parent, it.bounds, root) }
            val copies = copyControls(root).map { SwingUtilities.convertRectangle(it.parent, it.bounds, root) }
            val turnBounds = SwingUtilities.convertRectangle(turnComponent.parent, turnComponent.bounds, root)
            val turnInsets = turnComponent.insets
            frame.dispose()
            File("build/ui-render").mkdirs()
            ImageIO.write(image, "png", File("build/ui-render/$name.png"))
            rendered = Rendered(
                image,
                Rectangle(
                    turnBounds.x + turnInsets.left,
                    turnBounds.y + turnInsets.top,
                    turnBounds.width - turnInsets.left - turnInsets.right,
                    turnBounds.height - turnInsets.top - turnInsets.bottom,
                ),
                bounds,
                copies,
            )
        }
        return rendered
    }

    private fun onEdt(block: () -> Unit) = SwingUtilities.invokeAndWait(block)

    @Test fun `a prose answer renders with the question right and the assistant left`() {
        val rendered = render("prose-answer") { turn ->
            turn.showSchemaAnswer(
                answer = "The orders table holds one row per order, keyed by id, and joins to customers on customer_id.",
                unknownReferences = emptyList(),
                isSchemaChange = false,
            )
        }
        assertTrue("rendered nothing", rendered.image.width == width && rendered.image.height > 80)
        // Question first, then the answer prose, then the "generated from your schema" note.
        val questionPane = rendered.paneBounds.first()
        val answerPane = rendered.paneBounds[1]
        val question = inkColumns(rendered.image, questionPane)
        val answer = inkColumns(rendered.image, answerPane)
        assertTrue("the question pane painted nothing", question.isNotEmpty())
        assertTrue("the answer pane painted nothing", answer.isNotEmpty())
        // Edges are the turn's, not the pane's.
        val content = rendered.turnContent
        assertTrue(
            "question text did not reach the turn's right edge",
            content.x + content.width - question.max() < EDGE_SLACK,
        )
        assertTrue("answer text did not start at the turn's left edge", answer.min() - content.x < EDGE_SLACK)
    }

    @Test fun `an explanation renders with its copy control`() {
        val rendered = render("explanation") { turn -> turn.appendExplanation("Counts the orders per customer, newest first.") }
        assertTrue("no explanation pane was rendered", rendered.paneBounds.size >= 2)
        val explanation = rendered.paneBounds.last()
        assertTrue("the explanation pane painted nothing", inkColumns(rendered.image, explanation).isNotEmpty())
        val copy = rendered.copyButtons.singleOrNull()
        assertTrue("no copy control was rendered for the explanation", copy != null)
        assertTrue(
            "the copy control does not sit under the explanation it copies",
            copy!!.y >= explanation.y + explanation.height,
        )
        assertTrue("the copy control does not hug the right edge", width - (copy.x + copy.width) < EDGE_SLACK)
        assertTrue("the copy control painted nothing", inkColumns(rendered.image, copy).isNotEmpty())
    }

    /** Edge tolerance: borders plus antialiasing. */
    private val EDGE_SLACK = 24

    /** Stands in for the icon an IDE would supply; sized under the icon-only button's own insets. */
    private val STAND_IN_ICON = object : javax.swing.Icon {
        override fun getIconWidth() = 10

        override fun getIconHeight() = 10

        override fun paintIcon(c: java.awt.Component?, g: java.awt.Graphics, x: Int, y: Int) {
            g.color = java.awt.Color.BLACK
            g.fillRect(x, y, 10, 10)
        }
    }

    /** The "You" header above the question is right-aligned too. */
    @Test fun `the question ink sits on the right half of the turn`() {
        val rendered = render("question-alignment", question = "top customers")
        // The question pane is painted first.
        val columns = inkColumns(rendered.image, rendered.paneBounds.first())
        assertTrue("the question pane painted nothing", columns.isNotEmpty())
        assertTrue("question text was not painted right of centre", columns.max() > width / 2)
    }

    /** One long line that wraps to three at [width]; no explicit breaks. */
    private val wrappingAnswer =
        "This counts one row per customer across the whole order history, then sorts those totals so " +
            "the largest accounts come first, and finally keeps only the ten highest-spending rows " +
            "from the last complete quarter."

    @Test fun `a wrapped answer keeps the height of every line it wrapped to`() {
        val rendered = render("wrapped-answer", question = "top customers") { it.appendExplanation(wrappingAnswer) }
        // The question pane is painted first, so the answer is the last one.
        val lines = inkBands(rendered.image, rendered.paneBounds.last())
        assertTrue("the answer was painted as $lines line(s); a wrapped answer must keep all of them", lines >= 3)
    }

    /** An empty bubble still paints full-width tint on its own rows. */
    @Test fun `the question is painted as a tinted bubble`() {
        val rendered = render("question-bubble")
        val image = rendered.image
        val tint = QUESTION_BUBBLE_BACKGROUND.rgb
        val pane = rendered.paneBounds.first()
        val rows = inkRows(image, pane)
        assertTrue("the question pane painted nothing", rows.isNotEmpty())
        // Antialiasing leaves few pixels exactly tint, so this looks for tint on both sides of the ink.
        val naked = rows.count { y ->
            val ink = inkColumns(image, Rectangle(pane.x, y, pane.width, 1))
            val enclosed = (0 until ink.min()).any { image.getRGB(it, y) == tint } &&
                (ink.max() + 1 until image.width).any { image.getRGB(it, y) == tint }
            !enclosed
        }
        assertTrue("the question text sits outside the bubble on $naked of its ${rows.size} row(s)", naked == 0)
    }

    private fun editorPanes(container: Container): List<JEditorPane> =
        container.components.flatMap { child ->
            val nested = if (child is Container) editorPanes(child) else emptyList()
            if (child is JEditorPane) listOf(child) + nested else nested
        }

    /** The icon-only copy buttons [copyRow] adds, identified by their tooltip. */
    private fun copyControls(container: Container): List<javax.swing.JButton> =
        container.components.flatMap { child ->
            val nested = if (child is Container) copyControls(child) else emptyList()
            if (child is javax.swing.JButton && child.toolTipText == COPY_TOOLTIP) listOf(child) + nested else nested
        }

    /** Maximal runs of consecutive rows carrying ink inside [area]: one run per painted line of text. */
    private fun inkBands(image: BufferedImage, area: Rectangle): Int {
        val background = image.getRGB(1, 1)
        var bands = 0
        var inBand = false
        for (y in area.y.coerceAtLeast(0) until (area.y + area.height).coerceAtMost(image.height)) {
            var ink = false
            for (x in area.x.coerceAtLeast(0) until (area.x + area.width).coerceAtMost(image.width)) {
                val pixel = image.getRGB(x, y)
                if ((pixel ushr 24) != 0 && pixel != background && contrastsWith(pixel, background)) {
                    ink = true
                    break
                }
            }
            if (ink && !inBand) bands++
            inBand = ink
        }
        return bands
    }

    /** Columns carrying text ink inside [area]; the panel's own background does not count as ink. */
    private fun inkColumns(image: BufferedImage, area: Rectangle): List<Int> {
        val background = image.getRGB(1, 1)
        val columns = mutableListOf<Int>()
        for (x in area.x.coerceAtLeast(0) until (area.x + area.width).coerceAtMost(image.width)) {
            for (y in area.y.coerceAtLeast(0) until (area.y + area.height).coerceAtMost(image.height)) {
                val pixel = image.getRGB(x, y)
                if ((pixel ushr 24) != 0 && pixel != background && contrastsWith(pixel, background)) {
                    columns += x
                    break
                }
            }
        }
        return columns
    }

    /** Rows carrying text ink inside [area]; the row counterpart to [inkColumns]. */
    private fun inkRows(image: BufferedImage, area: Rectangle): List<Int> {
        val background = image.getRGB(1, 1)
        val rows = mutableListOf<Int>()
        for (y in area.y.coerceAtLeast(0) until (area.y + area.height).coerceAtMost(image.height)) {
            for (x in area.x.coerceAtLeast(0) until (area.x + area.width).coerceAtMost(image.width)) {
                val pixel = image.getRGB(x, y)
                if ((pixel ushr 24) != 0 && pixel != background && contrastsWith(pixel, background)) {
                    rows += y
                    break
                }
            }
        }
        return rows
    }

    private fun contrastsWith(pixel: Int, background: Int): Boolean {
        fun luma(c: Int) = 0.299 * ((c shr 16) and 0xFF) + 0.587 * ((c shr 8) and 0xFF) + 0.114 * (c and 0xFF)
        return kotlin.math.abs(luma(pixel) - luma(background)) > 40
    }
}
