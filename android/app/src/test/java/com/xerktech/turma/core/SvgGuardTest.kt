package com.xerktech.turma.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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

    @Test fun `an encoding the walk cannot read as Latin-1 is refused`() {
        assertEquals(SvgVerdict.UNSAFE, v("<?xml version=\"1.0\" encoding=\"UTF-7\"?><!--+ACQ---><svg/>"))
        assertEquals(SvgVerdict.UNSAFE, v("<?xml version='1.0' encoding='ISO-2022-JP'?><svg/>"))
        assertEquals(SvgVerdict.SAFE, v("<?xml version=\"1.0\" encoding=\"UTF-8\"?><svg/>"))
        assertEquals(SvgVerdict.SAFE, v("<?xml version=\"1.0\" encoding=\"iso-8859-1\"?><svg/>"))
    }

    // XERK-1858: the decoder's short look was 64 bytes, so an SVG behind more
    // leading whitespace than that was handed to the bitmap decoder (alt text).
    @Test fun `a sniff of only whitespace or a cut-off BOM is undecided, never a bitmap`() {
        assertTrue(blankSoFar(" ".repeat(64).toByteArray()))
        assertTrue(blankSoFar(("\n".repeat(63) + "ï").toByteArray(Charsets.ISO_8859_1)))
        assertTrue(blankSoFar(ByteArray(0)))
        assertEquals(false, blankSoFar((" ".repeat(10) + "<svg").toByteArray()))
        assertEquals(false, blankSoFar(byteArrayOf(0x89.toByte(), 'P'.code.toByte())))
        assertTrue(opensMarkup((" ".repeat(200) + "<svg/>").toByteArray()))
    }

    @Test fun `a declared zero width or height is zero-area, other sizes are not`() {
        fun z(s: String) = svgZeroArea(s.toByteArray())
        assertTrue(z("<svg width=\"0\" height=\"10\"/>"))
        assertTrue(z("<svg\nheight='0px' width='5'>"))
        assertTrue(z("<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"0.0\"/>"))
        assertTrue(z("<svg width=0>"))
        assertEquals(false, z("<svg width=\"10\" height=\"5\"/>"))
        assertEquals(false, z("<svg viewBox=\"0 0 10 10\"/>"))
        assertEquals(false, z("<svg stroke-width=\"0\" data-height=\"0\"/>"))
        assertEquals(false, z("<svg width=\"0.5\"/>"))
        // Only the ROOT's attributes count: a decoy in a comment or a child is ignored.
        assertEquals(false, z("<!-- <svg width=\"0\"> --><svg width=\"4\" height=\"4\"><rect width=\"0\"/></svg>"))
    }

    @Test fun `natural size is width x height, else the viewBox, else the CSS 300 x 150 default`() {
        // A browser sizes an SVG <img> by its width/height; the viewBox only scales the drawing.
        assertEquals(40f to 20f, svgNaturalSize(40f, 20f, 400f, 200f))
        assertEquals(40f to 20f, svgNaturalSize(40f, 20f, null, null))
        assertEquals(10f to 5f, svgNaturalSize(-1f, -1f, 10f, 5f))
        assertEquals(300f to 150f, svgNaturalSize(-1f, -1f, null, null))
        assertEquals(300f to 150f, svgNaturalSize(40f, -1f, null, null))
    }

    @Test fun `the bitmap is the intrinsic size at device density, never scaled up to the box`() {
        // An 80 x 40 SVG in a 1080px-wide box: 80 x 40 CSS px at 2.75x, not 1080 wide.
        assertEquals(220 to 110, svgBitmapSize(80f, 40f, 1080, 2.75f))
        // Unbounded: the SVG's own size, never a fit to the other side.
        assertEquals(825 to 413, svgBitmapSize(300f, 150f, null, 2.75f))
        // Wider than the box: narrowed to it.
        assertEquals(1000 to 5, svgBitmapSize(2000f, 10f, 1000, 2f))
        // A huge SVG is held to the pixel ceiling.
        val (w, h) = svgBitmapSize(4000f, 4000f, null, 3f)
        assertTrue(w.toLong() * h <= SVG_BITMAP_MAX_PIXELS + 2 * w)
        assertEquals(2048, w)
    }

    @Test fun `an extreme aspect still gets a one-pixel side, never zero`() {
        assertEquals(3 to 275000, svgBitmapSize(1f, 100000f, 1000, 2.75f))
        assertEquals(1000 to 1, svgBitmapSize(100000f, 1f, 1000, 2.75f))
    }

    @Test fun `a data URL payload is read by AndroidSVG 1·4's own rule`() {
        assertEquals("QUJD", dataUrlPayload("data:image/png;base64,QUJD"))
        // No limit on the mime part; the payload is everything after the FIRST comma.
        assertEquals("QUJD", dataUrlPayload("data:" + "x".repeat(300) + ";base64,QUJD"))
        assertEquals("'QU\"JD,x", dataUrlPayload("data:image/png;base64,'QU\"JD,x"))
        assertEquals("", dataUrlPayload("data:image/png;base64,"))
        // What 1.4 does not decode: wrong case, not base64, a comma before index 12.
        assertNull(dataUrlPayload("DATA:image/png;base64,QUJD"))
        assertNull(dataUrlPayload("data:image/svg+xml,%3Csvg/%3E"))
        assertNull(dataUrlPayload("data:,;base64,QUJDQUJD"))
        assertNull(dataUrlPayload("https://example.com/a.png"))
    }
}
