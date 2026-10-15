package com.xerktech.turma.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SvgGuardTest {
    private fun v(s: String, declared: Boolean = false) = svgVerdict(s.toByteArray(), declared)

    @Test fun `a plain svg is safe, with leading whitespace or a long prolog too`() {
        assertEquals(SvgVerdict.SAFE, v("<svg viewBox=\"0 0 1 1\"></svg>"))
        assertEquals(SvgVerdict.SAFE, v("\n  <svg></svg>"))
        assertEquals(SvgVerdict.SAFE, v("<?xml version=\"1.0\"?><!--" + "x".repeat(5000) + "--><svg/>"))
        assertEquals(SvgVerdict.SAFE, v("﻿<SVG></SVG>"))
    }

    @Test fun `a DOCTYPE or entity before the root is refused`() {
        val bomb = "<?xml version=\"1.0\"?><!DOCTYPE lolz [<!ENTITY lol \"lol\"><!ENTITY lol2 \"&lol;&lol;\">]>" +
            "<svg><text>&lol2;</text></svg>"
        assertEquals(SvgVerdict.UNSAFE, v(bomb))
        assertEquals(SvgVerdict.UNSAFE, v(bomb, declared = true))
        assertEquals(SvgVerdict.UNSAFE, v("<!doctype svg><svg/>"))
        assertEquals(SvgVerdict.UNSAFE, v("<!ENTITY a \"b\"><svg/>"))
    }

    @Test fun `non-svg bytes are left to the bitmap decoder unless declared svg`() {
        val png = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte())
        assertEquals(SvgVerdict.NOT_SVG, svgVerdict(png, false))
        assertEquals(SvgVerdict.NOT_SVG, v("<html><body>hi</body></html>"))
        assertEquals(SvgVerdict.NOT_SVG, v("<svgfoo/>"))
        // Declared svg whose root can't be found within the window: refused, not guessed.
        assertEquals(SvgVerdict.UNSAFE, v("<?xml?><!--" + "x".repeat(SVG_PROLOG_MAX) + "-->", declared = true))
    }

    @Test fun `a svg hidden in a comment or PI cannot smuggle a DOCTYPE past the check`() {
        val bomb = "<!DOCTYPE svg [<!ENTITY a \"x\">]><svg>&a;</svg>"
        assertEquals(SvgVerdict.UNSAFE, v("<!-- <svg > -->$bomb"))
        assertEquals(SvgVerdict.UNSAFE, v("<?x-a <svg/?>$bomb"))
        assertEquals(SvgVerdict.UNSAFE, v("<!-- <svg > -->$bomb", declared = true))
        // A DOCTYPE past the window's root is still refused, as the second line.
        assertEquals(SvgVerdict.UNSAFE, v("<svg/><!DOCTYPE x>"))
        // A real comment/PI before a clean root is fine.
        assertEquals(SvgVerdict.SAFE, v("<?xml version=\"1.0\"?>\n<!-- made by x -->\n<svg/>"))
        // A prolog that runs past the window: can't vouch for the root.
        assertEquals(SvgVerdict.UNSAFE, v("<!--" + "x".repeat(SVG_PROLOG_MAX)))
    }

    @Test fun `a BOM then whitespace, and a namespaced root, are svg`() {
        assertEquals(SvgVerdict.SAFE, v("\uFEFF\n <svg/>"))
        assertEquals(SvgVerdict.SAFE, v("<svg:svg xmlns:svg=\"http://www.w3.org/2000/svg\"/>"))
        assertTrue(opensMarkup("\uFEFF\n <svg/>".toByteArray()))
        assertEquals(SvgVerdict.NOT_SVG, v("<svgx/>"))
    }
}
