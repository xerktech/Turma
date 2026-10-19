package com.xerktech.turma

import android.content.Context
import android.graphics.drawable.Drawable
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import coil.ImageLoader
import coil.decode.DataSource
import coil.decode.ImageSource
import coil.fetch.SourceResult
import coil.request.Options
import coil.size.Scale
import coil.size.Size
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.util.zip.CRC32
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
    private fun decode(bytes: ByteArray, mime: String? = null): Drawable? {
        val result = SourceResult(ImageSource(Buffer().write(bytes), context), mime, DataSource.MEMORY)
        val options = Options(context, size = Size(1000, 320), scale = Scale.FIT)
        val decoder = SafeSvgDecoder.Factory().create(result, options, loader) ?: return null
        return runBlocking { decoder.decode() }!!.drawable
    }

    private fun intrinsic(s: String) = decode(s.toByteArray())!!.let { it.intrinsicWidth to it.intrinsicHeight }

    @Test fun `an svg reports its own size, never the box it was decoded for`() {
        // Coil's decoder reported the bitmap it scaled UP to the 1000px box, so an
        // 80 x 40 SVG laid out at the full bubble width (web: 80px).
        assertEquals(80 to 40, intrinsic("<svg $ns width=\"80\" height=\"40\"/>"))
        assertEquals(80 to 40, intrinsic("<svg $ns width=\"80\" height=\"40\" viewBox=\"0 0 800 400\"/>"))
        assertEquals(24 to 24, intrinsic("<svg $ns viewBox=\"0 0 24 24\"/>"))
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
        val start = System.nanoTime()
        assertTrue(refused(svg))
        val ms = (System.nanoTime() - start) / 1_000_000
        assertTrue("took ${ms}ms", ms < 5_000)
    }
}
