package com.xerktech.turma

import android.content.Context
import android.graphics.drawable.Drawable
import androidx.test.core.app.ApplicationProvider
import coil.ImageLoader
import coil.fetch.SourceResult
import coil.request.Options
import coil.size.Scale
import coil.size.Size
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
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
 * A data: URI is decoded by the type it declares, as the web does (XERK-2161): SVG
 * markup behind a `data:image/png` is broken, not sniffed into an SVG.
 *
 * Runs the app's own components ([turmaImageComponents]) the way Coil does — fetch,
 * then the first decoder factory that takes the source, else Coil's bitmap decoder —
 * without `ImageLoader.execute`, which resumes on the main thread and so never
 * returns from `runBlocking` under Robolectric's paused looper.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DataImageTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val loader = ImageLoader(context)
    private val components = turmaImageComponents()
    private val svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"10\"><rect width=\"20\" height=\"10\"/></svg>"

    // Percent-encoded with spaces as %20: DataImage keeps a `+` literal, as the web does.
    private fun pct(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
    private fun b64(bytes: ByteArray) = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)

    private val options = Options(context, size = Size(100, 100), scale = Scale.FIT)

    /** [src] fetched by the app's own fetcher, as the decoders receive it. */
    private fun fetched(src: String): SourceResult = runBlocking {
        val data = DataImage.parse(src)!!
        val fetcher = components.fetcherFactories.firstNotNullOf { (f, type) ->
            @Suppress("UNCHECKED_CAST")
            if (type.isInstance(data)) (f as coil.fetch.Fetcher.Factory<Any>).create(data, options, loader) else null
        }
        fetcher.fetch() as SourceResult
    }

    /** The decoded drawable, or null when decoding fails (the caller shows alt text). */
    private fun load(src: String): Drawable? = runBlocking {
        val result = fetched(src)
        val decoder = components.decoderFactories.firstNotNullOfOrNull { it.create(result, options, loader) }
            ?: coil.decode.BitmapFactoryDecoder(result.source, options)
        runCatching { decoder.decode() }.getOrNull()?.drawable
    }

    @Test fun `parse keeps the declared type and decodes both payload forms`() {
        val p = DataImage.parse("data:Image/SVG+xml;charset=utf-8,%3Csvg%3E+")!!
        assertEquals("image/svg+xml", p.mimeType)
        assertArrayEquals("<svg>+".toByteArray(), p.bytes)
        val b = DataImage.parse("data:image/png;base64,QUJD")!!
        assertEquals("image/png", b.mimeType)
        assertArrayEquals("ABC".toByteArray(), b.bytes)
        assertEquals("text/plain", DataImage.parse("data:,x")!!.mimeType)
        assertNull(DataImage.parse("data:image/png;base64"))
        assertNull(DataImage.parse("data:image/svg+xml,%E0%A4%A"))
    }

    @Test fun `svg markup declared as a bitmap type is broken, not rendered`() {
        assertNull(load("data:image/png," + pct(svg)))
        assertNull(load("data:image/jpeg;base64," + b64(svg.toByteArray())))
        // The same bytes without a declared bitmap type are an SVG: the decoder above is what refuses them.
        assertNotNull(load("data:image/svg+xml," + pct(svg)))
    }

    @Test fun `svg declared as svg still renders at its own size`() {
        assertEquals(20, load("data:image/svg+xml," + pct(svg))!!.intrinsicWidth)
        assertEquals(20, load("data:image/svg+xml;base64," + b64(svg.toByteArray()))!!.intrinsicWidth)
    }

    @Test fun `a declared bitmap type still renders a real bitmap`() {
        val bmp = android.graphics.Bitmap.createBitmap(3, 2, android.graphics.Bitmap.Config.ARGB_8888)
        val out = java.io.ByteArrayOutputStream()
        bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
        val png = b64(out.toByteArray())
        // Decoded (Coil scales it to the requested size, so only presence is checked).
        assertNotNull(load("data:image/png;base64,$png"))
        assertNotNull(load("data:image/jpeg;base64,$png"))
    }

    /**
     * A declared bitmap goes through Coil's own factory, whose decoders share its
     * 4-permit lock on parallel bitmap decodes (rollup XERK-2148). A bare
     * `BitmapFactoryDecoder(source, options)` decodes the same and passes every other
     * test, but its lock is unbounded: any number of full-size decodes at once.
     */
    @Test fun `a declared bitmap keeps Coil's 4-permit parallel decode lock`() {
        val decoder = DeclaredBitmapDecoder.Factory().create(fetched("data:image/png;base64,QUJD"), options, loader)!!
        val lock = decoder.javaClass.getDeclaredField("parallelismLock").apply { isAccessible = true }
        assertEquals(4, (lock.get(decoder) as kotlinx.coroutines.sync.Semaphore).availablePermits)
    }

    @Test fun `the app's loader decodes a declared bitmap before the svg sniff`() {
        val declared = components.decoderFactories.indexOfFirst { it is DeclaredBitmapDecoder.Factory }
        val sniff = components.decoderFactories.indexOfFirst { it is SafeSvgDecoder.Factory }
        assertTrue("$declared < $sniff", declared in 0 until sniff)
    }
}
