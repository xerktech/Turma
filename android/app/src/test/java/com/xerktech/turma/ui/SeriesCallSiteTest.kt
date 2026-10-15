package com.xerktech.turma.ui

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Org tints and chart lines read the THEME's palette, `TurmaColors.series()` (rollup
 * XERK-1701): the light slots on a light surface, the dark ones on dark. A call site
 * reading `ChartSeries` / `ChartSeriesLight` directly paints one theme's colours in
 * both, and no render test covers every org-tint site (Sessions, Usage, Fleet, Board,
 * OrgControl), so this pins it at the source: outside `ui/theme`, nothing names the
 * palette lists, and each of those screens does read `series()`.
 */
class SeriesCallSiteTest {
    private val root = File("src/main/java/com/xerktech/turma")
    private val direct = Regex("""\bChartSeries(Light)?\b""")

    /** Code only: comment lines may name the palette. */
    private fun codeLines(f: File) = f.readLines().withIndex().filter { (_, l) ->
        val t = l.trim()
        !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"))
    }

    @Test fun `nothing outside the theme reads a palette list directly`() {
        assertTrue("source root not found from ${File(".").absolutePath}", root.isDirectory)
        val hits = root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" && !it.path.contains("/ui/theme/") }
            .flatMap { f -> codeLines(f).filter { direct.containsMatchIn(it.value) }.map { "${f.path}:${it.index + 1}: ${it.value.trim()}" } }
            .toList()
        assertEquals("direct ChartSeries use outside ui/theme (use TurmaColors.series())", emptyList<String>(), hits)
    }

    @Test fun `every org-tint screen reads the theme's series`() {
        for (name in listOf("SessionsScreen", "UsageScreen", "FleetScreen", "BoardScreen", "OrgControl")) {
            val f = File(root, "ui/$name.kt")
            assertTrue("$name reads TurmaColors.series()", codeLines(f).any { "TurmaColors.series()" in it.value })
        }
    }
}
