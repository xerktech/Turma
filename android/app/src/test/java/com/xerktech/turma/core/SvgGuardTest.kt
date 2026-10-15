package com.xerktech.turma.core

import org.junit.Assert.assertEquals
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
}
