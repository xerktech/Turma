package com.xerktech.turma

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import coil.ImageLoader
import coil.request.ErrorResult
import coil.request.ImageRequest
import coil.request.SuccessResult
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
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
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DataImageTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    // The app's own components (TurmaApplication.newImageLoader), in its order.
    private val loader = ImageLoader.Builder(context)
        .components {
            add(DataImage.Fetcher.Factory())
            add(DeclaredBitmapDecoder.Factory())
            add(SafeSvgDecoder.Factory())
        }
        .build()
    private val svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"10\"><rect width=\"20\" height=\"10\"/></svg>"

    private fun load(src: String) = runBlocking {
        loader.execute(ImageRequest.Builder(context).data(DataImage.parse(src)!!).size(100, 100).build())
    }

    @Test fun `parse keeps the declared type and decodes both payload forms`() {
        val pct = DataImage.parse("data:Image/SVG+xml;charset=utf-8,%3Csvg%3E+")!!
        assertEquals("image/svg+xml", pct.mimeType)
        assertArrayEquals("<svg>+".toByteArray(), pct.bytes)
        val b64 = DataImage.parse("data:image/png;base64,QUJD")!!
        assertEquals("image/png", b64.mimeType)
        assertArrayEquals("ABC".toByteArray(), b64.bytes)
        assertEquals("text/plain", DataImage.parse("data:,x")!!.mimeType)
        assertNull(DataImage.parse("data:image/png;base64"))
        assertNull(DataImage.parse("data:image/svg+xml,%E0%A4%A"))
    }

    @Test fun `svg markup declared as a bitmap type is broken, not rendered`() {
        assertTrue(load("data:image/png," + java.net.URLEncoder.encode(svg, "UTF-8")) is ErrorResult)
        val b64 = android.util.Base64.encodeToString(svg.toByteArray(), android.util.Base64.NO_WRAP)
        assertTrue(load("data:image/jpeg;base64,$b64") is ErrorResult)
    }

    @Test fun `svg declared as svg still renders`() {
        val r = load("data:image/svg+xml," + java.net.URLEncoder.encode(svg, "UTF-8"))
        assertTrue(r.toString(), r is SuccessResult)
        assertEquals(20, (r as SuccessResult).drawable.intrinsicWidth)
    }

    @Test fun `a declared bitmap type still renders a real bitmap`() {
        val bmp = android.graphics.Bitmap.createBitmap(3, 2, android.graphics.Bitmap.Config.ARGB_8888)
        val out = java.io.ByteArrayOutputStream()
        bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
        val b64 = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
        val r = load("data:image/png;base64,$b64")
        assertTrue(r.toString(), r is SuccessResult)
    }
}
