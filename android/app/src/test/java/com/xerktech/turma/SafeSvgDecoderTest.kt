package com.xerktech.turma

import android.content.Context
import android.graphics.drawable.Drawable
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import coil.ImageLoader
import coil.decode.DataSource
import coil.decode.Decoder
import coil.decode.ImageSource
import coil.fetch.SourceResult
import coil.request.Options
import coil.size.Scale
import coil.size.Size
import com.xerktech.turma.core.cpuMs
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.util.zip.CRC32
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The SVG decoder end to end over real bytes (XERK-1858): the sniff, the size the
 * drawable reports (the SVG's own, which `ProseImage` caps the box at), and the
 * embedded-image bound. The pure rules are pinned in
 * [com.xerktech.turma.core.SvgGuardTest]; this gates that the decoder uses them.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
// Real Skia: the legacy shadow BitmapFactory can't read a header-only PNG's bounds.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SafeSvgDecoderTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val loader = ImageLoader(context)
    private val ns = "xmlns=\"http://www.w3.org/2000/svg\""

    /** Decode for a phone-wide prose placeholder: 1000 × 320 px, fitted. Null: not an SVG. */
    private fun decode(bytes: ByteArray, mime: String? = null, source: DataSource = DataSource.MEMORY): Drawable? {
        val decoder = decoder(bytes, mime, source) ?: return null
        return runBlocking { decoder.decode() }!!.drawable
    }

    private fun decoder(bytes: ByteArray, mime: String? = null, source: DataSource = DataSource.MEMORY): Decoder? {
        val result = SourceResult(ImageSource(Buffer().write(bytes), context), mime, source)
        val options = Options(context, size = Size(1000, 320), scale = Scale.FIT)
        return SafeSvgDecoder.Factory().create(result, options, loader)
    }

    private fun intrinsic(s: String) = decode(s.toByteArray())!!.let { it.intrinsicWidth to it.intrinsicHeight }

    @Test fun `an svg reports its own size, never the box it was decoded for`() {
        // Coil's decoder reported the bitmap it scaled UP to the 1000px box, so an
        // 80 x 40 SVG laid out at the full bubble width (web: 80px).
        assertEquals(80 to 40, intrinsic("<svg $ns width=\"80\" height=\"40\"/>"))
        assertEquals(80 to 40, intrinsic("<svg $ns width=\"80\" height=\"40\" viewBox=\"0 0 800 400\"/>"))
    }

    // Chrome's sizes (rollup XERK-2109), read off the parsed root rather than AndroidSVG's
    // document size, which made a width-only SVG square and dropped a lone height.
    @Test fun `one side alone takes the other from the viewBox, else the CSS default`() {
        assertEquals(100 to 150, intrinsic("<svg $ns width=\"100\"/>"))
        assertEquals(100 to 50, intrinsic("<svg $ns width=\"100\" viewBox=\"0 0 10 5\"/>"))
        assertEquals(300 to 100, intrinsic("<svg $ns height=\"100\"/>"))
        assertEquals(200 to 100, intrinsic("<svg $ns height=\"100\" viewBox=\"0 0 10 5\"/>"))
        // A percentage has no box to resolve against in an <img>: Chrome drops it.
        assertEquals(300 to 30, intrinsic("<svg $ns width=\"50%\" height=\"30\"/>"))
        // Chrome: 10em 160, 10mm 38, 1in 96.
        assertEquals(160 to 150, intrinsic("<svg $ns width=\"10em\"/>"))
        // ex: half an em (Chrome's follows the font's x-height, 9px headless).
        assertEquals(80 to 150, intrinsic("<svg $ns width=\"10ex\"/>"))
        assertEquals(38 to 96, intrinsic("<svg $ns width=\"10mm\" height=\"1in\"/>"))
    }

    @Test fun `a viewBox alone fills the box it is decoded for, at its own ratio`() {
        // Chrome lays it out as wide as its container; the box here is 1000 px.
        val w = Math.round(1000 / context.resources.displayMetrics.density)
        assertEquals(w to w, intrinsic("<svg $ns viewBox=\"0 0 24 24\"/>"))
        assertEquals(w to w / 2, intrinsic("<svg $ns viewBox=\"0 0 800 400\"/>"))
        assertEquals(w to w / 2, intrinsic("<svg $ns width=\"50%\" viewBox=\"0 0 10 5\"/>"))
    }

    private val tiny = "<svg $ns width=\"20\" height=\"10\"/>".toByteArray()

    private fun refusedFrom(bytes: ByteArray, mime: String?, source: DataSource): Boolean =
        runCatching { decode(bytes, mime, source) }.exceptionOrNull() is IllegalStateException

    @Test fun `a remote svg renders only when served as image svg+xml`() {
        // Chrome shows each of these broken (an <img> never sniffs an SVG).
        for (mime in listOf(null, "application/octet-stream", "text/html", "text/xml", "application/xml")) {
            for (source in listOf(DataSource.NETWORK, DataSource.DISK)) {
                assertTrue("$mime from $source", refusedFrom(tiny, mime, source))
            }
        }
        assertEquals(20, decode(tiny, "image/svg+xml", DataSource.NETWORK)!!.intrinsicWidth)
        assertEquals(20, decode(tiny, "Image/SVG+XML", DataSource.DISK)!!.intrinsicWidth)
        // In-memory bytes (a data: URI) are sniffed, as before.
        assertEquals(20, decode(tiny, null, DataSource.MEMORY)!!.intrinsicWidth)
    }

    @Test fun `a remote bitmap of any type is left to the bitmap decoder`() {
        val png = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10)
        assertNull(decoder(png, "application/octet-stream", DataSource.NETWORK))
    }

    @Test fun `an svg with no size at all is the browser's 300 x 150`() {
        assertEquals(300 to 150, intrinsic("<svg $ns><rect width=\"9\" height=\"9\"/></svg>"))
    }

    @Test fun `an svg behind more than 64 bytes of whitespace is still an svg`() {
        assertEquals(20 to 10, intrinsic(" ".repeat(200) + "\n<svg $ns width=\"20\" height=\"10\"/>"))
    }

    @Test fun `bitmap bytes and plain whitespace are not taken as svg`() {
        val png = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10)
        assertNull(decode(png))
        assertNull(decode(" ".repeat(500).toByteArray()))
    }

    @Test fun `an extreme aspect decodes, keeping its own size`() {
        assertEquals(1 to 100000, intrinsic("<svg $ns width=\"1\" height=\"100000\"/>"))
        assertEquals(100000 to 1, intrinsic("<svg $ns width=\"100000\" height=\"1\"/>"))
    }

    @Test fun `a zero-area svg decodes to an empty drawable`() {
        val d = decode("<svg $ns width=\"0\" height=\"40\"/>".toByteArray())
        assertNotNull(d)
        assertEquals(0 to 0, d!!.intrinsicWidth to d.intrinsicHeight)
    }

    /** A PNG that is only a signature + IHDR claiming [w] × [h] + IEND: its header alone. */
    private fun pngHeader(w: Int, h: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val d = DataOutputStream(out)
        d.write(byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10))
        fun chunk(type: String, body: ByteArray) {
            d.writeInt(body.size)
            val tb = type.toByteArray() + body
            d.write(tb)
            d.writeInt(CRC32().apply { update(tb) }.value.toInt())
        }
        val ihdr = ByteArrayOutputStream().also {
            DataOutputStream(it).apply { writeInt(w); writeInt(h); write(byteArrayOf(8, 6, 0, 0, 0)) }
        }.toByteArray()
        chunk("IHDR", ihdr)
        // A token IDAT: libpng reads the header up to the first one. Its pixels are
        // never decoded — bounds are all the decoder asks for.
        chunk("IDAT", java.util.zip.Deflater().run {
            setInput(ByteArray(64)); finish()
            ByteArray(128).let { buf -> buf.copyOf(deflate(buf)) }
        })
        chunk("IEND", ByteArray(0))
        return out.toByteArray()
    }

    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)

    /** A REAL 1500 × 1500 PNG (2.25 M px): decodable, so every draw of it counts. */
    private val realPng: String by lazy {
        val bmp = android.graphics.Bitmap.createBitmap(1500, 1500, android.graphics.Bitmap.Config.ARGB_8888)
        b64(ByteArrayOutputStream().also { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }.toByteArray())
    }

    private val open = "<svg $ns xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"10\" height=\"10\">"

    /** One `<image>` whose href attribute is [attr] verbatim (quotes included). */
    private fun withHref(attr: String) = "$open<image width=\"10\" height=\"10\" xlink:href=$attr/></svg>"

    private fun refusedFor(svg: String) = runCatching { decode(svg.toByteArray()) }.exceptionOrNull()?.message

    /** Runs [block] with the render deadline set to [ms], restoring it after. */
    private fun <T> withDeadline(ms: Long, block: () -> T): T {
        val saved = SvgRenderGuard.renderDeadlineMs
        SvgRenderGuard.renderDeadlineMs = ms
        try {
            return block()
        } finally {
            SvgRenderGuard.renderDeadlineMs = saved
        }
    }

    private fun refused(svg: String): Boolean =
        runCatching { decode(svg.toByteArray()) }.exceptionOrNull() is IllegalStateException

    @Test fun `a huge embedded image is refused before AndroidSVG decodes it, however the href is spelled`() {
        // 20000 x 20000 is a 1.6 GB bitmap AndroidSVG 1.4 would allocate in full.
        val p = b64(pngHeader(20000, 20000))
        for (attr in listOf(
            "\"data:image/png;base64,$p\"",
            // QA bypasses of the text pre-scan this replaced: a mime past 256 chars,
            // and a raw quote of the other kind inside the payload (Base64 skips it).
            "\"data:image/png;" + "x=y;".repeat(80) + "base64,$p\"",
            "\"data:image/png;base64,'$p\"",
            "'data:image/png;base64,\"$p'",
            "\"data:image/png;base64,!$p\"",
            "\"&#100;ata:image/png;base64,&quot;$p\"",
        )) assertTrue("must refuse $attr".take(120), refused(withHref(attr)))
    }

    @Test fun `the size budget's boundary is 2896 squared`() {
        assertEquals(false, refused(withHref("\"data:image/png;base64,${b64(pngHeader(2896, 2896))}\"")))
        assertTrue(refused(withHref("\"data:image/png;base64,${b64(pngHeader(2900, 2900))}\"")))
    }

    @Test fun `a modest embedded image still decodes`() {
        assertEquals(10 to 10, intrinsic(withHref("\"data:image/png;base64,${b64(pngHeader(640, 480))}\"")))
        assertEquals(10 to 10, intrinsic(withHref("\"data:image/png;base64,$realPng\"")))
    }

    @Test fun `every draw counts - use repeats past the budget are refused, within it drawn`() {
        val img = "<defs><image id=\"i\" width=\"10\" height=\"10\" xlink:href=\"data:image/png;base64,$realPng\"/></defs>"
        val use = "<use xlink:href=\"#i\"/>"
        assertEquals(10 to 10, intrinsic("$open$img${use.repeat(3)}</svg>"))
        assertTrue(refused("$open$img${use.repeat(4)}</svg>"))
    }

    @Test fun `a pattern of tiny tiles over a big image is refused fast, not decoded per tile`() {
        // 1 x 1 tiles over 100 x 100: 10000 draws of a 2.25 M px image. Before the guard
        // AndroidSVG re-decoded it on every tile (minutes of a core, past Back).
        val svg = "<svg $ns xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"100\" height=\"100\">" +
            "<defs><pattern id=\"p\" width=\"1\" height=\"1\" patternUnits=\"userSpaceOnUse\">" +
            "<image width=\"1\" height=\"1\" xlink:href=\"data:image/png;base64,$realPng\"/></pattern></defs>" +
            "<rect width=\"100\" height=\"100\" fill=\"url(#p)\"/></svg>"
        val ms = cpuMs { assertTrue(refused(svg)) }
        assertTrue("took ${ms}ms of CPU", ms < 5_000)
    }

    /** A 100 x 100 rect filled with a pattern of [tile]-unit tiles, each a plain rect. */
    private fun tiles(tile: String) = "<svg $ns width=\"100\" height=\"100\">" +
        "<defs><pattern id=\"p\" width=\"$tile\" height=\"$tile\" patternUnits=\"userSpaceOnUse\">" +
        "<rect width=\"0.5\" height=\"0.5\"/></pattern></defs>" +
        "<rect width=\"100\" height=\"100\" fill=\"url(#p)\"/></svg>"

    @Test fun `an image-free pattern of tiny tiles is refused fast (XERK-2108)`() {
        // 0.01-unit tiles: 10^8 of them. Before the guard this pinned a core for
        // 11+ minutes on the emulator and kept running after Back.
        // The wall-clock deadline is lifted so only the step budget can refuse it.
        var message: String? = null
        val ms = withDeadline(Long.MAX_VALUE / 1_000_000) {
            cpuMs { message = refusedFor(tiles("0.01")) }
        }
        assertEquals("refused SVG: too many steps to draw", message)
        assertTrue("took ${ms}ms of CPU", ms < 2_000)
    }

    @Test fun `a pattern of a sane number of tiles still draws`() {
        // 1-unit tiles: 10000 of them, well inside the step budget.
        assertEquals(100 to 100, intrinsic(tiles("1")))
    }

    @Test fun `a cancelled decode stops at the next step`() {
        // Coil cancels a decode by interrupting its thread (runInterruptible); the render
        // must notice at its next step rather than draw on. 0.45-unit tiles: ~50000 of
        // them, inside the budget, so only cancellation can cut the render short. The job
        // is cancelled from the render's own 10th step, so no clock decides the outcome.
        val bytes = tiles("0.45").toByteArray()
        var last = -1
        var error: Throwable? = null
        runBlocking {
            // Not decode(): its own runBlocking would shield the render from the cancel.
            launch(Dispatchers.IO) {
                val job = coroutineContext.job
                SvgRenderGuard.onStep = { taken ->
                    last = taken
                    if (taken == 10) job.cancel()
                }
                try {
                    error = runCatching { decoder(bytes)!!.decode() }.exceptionOrNull()
                } finally {
                    SvgRenderGuard.onStep = null
                }
            }.join()
        }
        assertEquals("SVG render cancelled", error?.message)
        assertEquals(10, last)
    }

    private val xl = "$ns xmlns:xlink=\"http://www.w3.org/1999/xlink\""

    /** Clip paths [depth] deep, each holding ten `<use>`s of a rect clipped by the last. */
    private fun clipFan(depth: Int): String {
        val sb = StringBuilder("<svg $xl width=\"100\" height=\"100\"><defs><rect id=\"r0\" width=\"100\" height=\"100\"/>")
        for (i in 1..depth) {
            sb.append("<clipPath id=\"c$i\">")
            repeat(10) { sb.append("<use xlink:href=\"#r${i - 1}\"/>") }
            sb.append("</clipPath><rect id=\"r$i\" width=\"100\" height=\"100\" clip-path=\"url(#c$i)\"/>")
        }
        return sb.append("</defs><use xlink:href=\"#r$depth\"/></svg>").toString()
    }


    @Test fun `clip-path fan-out is refused before it renders`() {
        // Depth 7 is 2.5 KB and never calls save(): on the emulator it pinned a core for
        // 4+ minutes past Back with the save() guard alone (QA on XERK-2108).
        val ms = cpuMs {
            assertEquals("refused SVG: too costly to draw", refusedFor(clipFan(7)))
            assertEquals("refused SVG: too costly to draw", refusedFor(clipFan(3)))
        }
        assertTrue("took ${ms}ms of CPU", ms < 2_000)
    }

    @Test fun `costly single draws are refused - a long clip text, a long self-crossing clip outline, a huge path`() {
        fun clipped(clip: String) = "<svg $ns width=\"100\" height=\"100\"><defs><clipPath id=\"c\">$clip</clipPath></defs>" +
            "<rect width=\"100\" height=\"100\" clip-path=\"url(#c)\"/></svg>"
        fun star(n: Int) = "M0 0 " + (0 until n).joinToString(" ") { "L${(it * 37) % 100} ${(it * 61) % 100}" }
        val text = "<text y=\"50\" font-size=\"10\">${"W".repeat(5000)}</text>"
        assertEquals("refused SVG: too costly to draw", refusedFor(clipped(text)))
        assertEquals("refused SVG: too costly to draw", refusedFor(clipped("<path d=\"${star(1000)}\"/>")))
        val stroke = "<svg $ns width=\"100\" height=\"100\"><path fill=\"none\" stroke=\"black\" stroke-width=\"500\" d=\"${star(40_000)}\"/></svg>"
        assertEquals("refused SVG: too costly to draw", refusedFor(stroke))
        // Within the budget each still draws.
        assertEquals(100 to 100, intrinsic(clipped("<path d=\"${star(100)}\"/>")))
        assertEquals(100 to 100, intrinsic(clipped("<text y=\"50\">${"W".repeat(100)}</text>")))
    }

    @Test fun `what the cost walk can't price is refused - stylesheet clips, a clip inside a pattern`() {
        val css = "<svg $ns width=\"10\" height=\"10\"><style>rect { clip-path: url(#c) }</style>" +
            "<clipPath id=\"c\"><rect width=\"5\" height=\"5\"/></clipPath><rect width=\"10\" height=\"10\"/></svg>"
        assertEquals("refused SVG: a stylesheet sets clip-path, mask or a marker", refusedFor(css))
        val pattern = "<svg $ns width=\"10\" height=\"10\"><defs><clipPath id=\"c\"><rect width=\"1\" height=\"1\"/></clipPath>" +
            "<pattern id=\"p\" width=\"2\" height=\"2\" patternUnits=\"userSpaceOnUse\"><rect width=\"2\" height=\"2\" clip-path=\"url(#c)\"/></pattern></defs>" +
            "<rect width=\"10\" height=\"10\" fill=\"url(#p)\"/></svg>"
        assertEquals("refused SVG: a clip-path inside a pattern", refusedFor(pattern))
        // The same pattern applied by a stylesheet rule, not an attribute.
        val cssFill = pattern.replace("<rect width=\"10\" height=\"10\" fill=\"url(#p)\"/>",
            "<style>rect.f { fill: url(#p) }</style><rect class=\"f\" width=\"10\" height=\"10\"/>")
        assertTrue(cssFill != pattern)
        assertEquals("refused SVG: a clip-path inside a pattern", refusedFor(cssFill))
        // A stylesheet that only paints is fine.
        assertEquals(10 to 10, intrinsic("<svg $ns width=\"10\" height=\"10\"><style>rect { fill: red }</style><rect width=\"5\" height=\"5\"/></svg>"))
    }

    @Test fun `an ordinary clipped diagram still draws`() {
        val bars = (0 until 50).joinToString("") { "<rect x=\"${it * 2}\" width=\"1\" height=\"${it + 10}\" clip-path=\"url(#c)\"/>" }
        val svg = "<svg $xl width=\"100\" height=\"100\"><defs><clipPath id=\"c\"><rect width=\"100\" height=\"60\" rx=\"4\"/></clipPath>" +
            "<g id=\"g\">$bars</g></defs><use xlink:href=\"#g\"/><use xlink:href=\"#g\" y=\"40\"/></svg>"
        assertEquals(100 to 100, intrinsic(svg))
    }

    @Test fun `a render past the deadline is refused`() {
        withDeadline(0) { assertEquals("refused SVG: render too slow", refusedFor(tiles("10"))) }
    }
}
