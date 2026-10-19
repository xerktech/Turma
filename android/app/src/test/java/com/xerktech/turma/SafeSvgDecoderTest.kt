package com.xerktech.turma

import android.content.Context
import android.graphics.drawable.BitmapDrawable
import androidx.test.core.app.ApplicationProvider
import coil.ImageLoader
import coil.decode.DataSource
import coil.decode.ImageSource
import coil.fetch.SourceResult
import coil.request.Options
import coil.size.Scale
import coil.size.Size
import kotlinx.coroutines.runBlocking
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The SVG decoder end to end over real bytes (XERK-1858): the sniff, then the
 * size the drawing is rendered at. The pure rules are pinned in
 * [com.xerktech.turma.core.SvgGuardTest]; this gates that the decoder uses them.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SafeSvgDecoderTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val loader = ImageLoader(context)

    /** A phone-wide prose box: 1000 × 320 px, fitted. */
    private fun decode(bytes: ByteArray, mime: String? = null): Pair<Int, Int>? {
        val result = SourceResult(ImageSource(Buffer().write(bytes), context), mime, DataSource.MEMORY)
        val options = Options(context, size = Size(1000, 320), scale = Scale.FIT)
        val decoder = SafeSvgDecoder.Factory().create(result, options, loader) ?: return null
        val drawable = runBlocking { decoder.decode() }!!.drawable
        return if (drawable is BitmapDrawable) drawable.bitmap.width to drawable.bitmap.height
            else drawable.intrinsicWidth to drawable.intrinsicHeight
    }

    private fun svg(s: String) = s.toByteArray()

    @Test fun `an svg behind more than 64 bytes of whitespace is still an svg`() {
        val size = decode(svg(" ".repeat(200) + "\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"10\"/>"))
        assertEquals(640 to 320, size)
    }

    @Test fun `bitmap bytes and plain whitespace are not taken as svg`() {
        val png = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10)
        assertNull(decode(png))
        assertNull(decode(svg(" ".repeat(500))))
    }

    @Test fun `an extreme aspect renders a one-pixel side instead of failing`() {
        val ns = "xmlns=\"http://www.w3.org/2000/svg\""
        assertEquals(1 to 320, decode(svg("<svg $ns width=\"1\" height=\"100000\"/>")))
        assertEquals(1000 to 1, decode(svg("<svg $ns width=\"100000\" height=\"1\"/>")))
    }

    @Test fun `an svg with no size at all is the browser's 300 x 150, fitted`() {
        assertEquals(640 to 320, decode(svg("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"9\" height=\"9\"/></svg>")))
    }

    @Test fun `a zero-area svg decodes to an empty drawable`() {
        val size = decode(svg("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"0\" height=\"40\"/>"))
        assertNotNull(size)
        assertEquals(0 to 0, size)
    }
}
