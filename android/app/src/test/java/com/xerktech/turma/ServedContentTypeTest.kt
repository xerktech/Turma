package com.xerktech.turma

import android.graphics.Bitmap
import android.os.Looper
import android.webkit.MimeTypeMap
import androidx.test.core.app.ApplicationProvider
import coil.ImageLoader
import coil.request.ErrorResult
import coil.request.ImageRequest
import coil.request.ImageResult
import coil.request.SuccessResult
import java.io.ByteArrayOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The app's real image loader over real HTTP (rollup XERK-2109): a remote `.svg`
 * renders only when SERVED as image/svg+xml, as in Chrome, which showed the same URL
 * served as text/plain, or with no type, broken. Coil guessed image/svg+xml from the
 * extension for both, so Android drew them. A bitmap still renders whatever its type.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ServedContentTypeTest {
    private val app = ApplicationProvider.getApplicationContext<TurmaApplication>()
    private val server = MockWebServer()
    private val svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"20\"/>"

    @Before fun setUp() {
        // Robolectric's MimeTypeMap is empty; the device's maps svg, which is what let
        // Coil's extension guess through.
        shadowOf(MimeTypeMap.getSingleton()).addExtensionMimeTypeMapping("svg", "image/svg+xml")
        shadowOf(MimeTypeMap.getSingleton()).addExtensionMimeTypeMapping("png", "image/png")
        server.start()
    }

    @After fun tearDown() = server.shutdown()

    private fun load(body: Buffer, type: String?, name: String, noStore: Boolean = false): ImageResult {
        server.enqueue(MockResponse().setBody(body).apply {
            if (type != null) setHeader("Content-Type", type)
            // no-store: Coil skips its disk cache and reads the BODY's type, not the header.
            if (noStore) setHeader("Cache-Control", "no-store")
        })
        return fetch(app.newImageLoader(), server.url("/$name").toString())
    }

    private fun fetch(loader: ImageLoader, url: String): ImageResult {
        val request = ImageRequest.Builder(app).data(url).size(100, 100).build()
        // Coil's execute() hops to the main thread, which is this test's: run it on
        // another and pump the main looper until it answers.
        val result = CompletableFuture<ImageResult>()
        thread { runCatching { runBlocking { loader.execute(request) } }.fold(result::complete, result::completeExceptionally) }
        val deadline = System.currentTimeMillis() + 30_000
        while (!result.isDone && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            runCatching { result.get(5, TimeUnit.MILLISECONDS) }
        }
        return result.get(1, TimeUnit.MILLISECONDS).also { loader.shutdown() }
    }

    private var n = 0

    // A fresh URL per load: the disk cache outlives a loader.
    private fun svgAs(type: String?, noStore: Boolean = false) =
        load(Buffer().writeUtf8(svg), type, "x${++n}.svg", noStore)

    @Test fun `an svg served as image svg+xml renders`() {
        assertTrue(svgAs("image/svg+xml") is SuccessResult)
        assertTrue(svgAs("image/svg+xml; charset=utf-8") is SuccessResult)
    }

    @Test fun `an svg served as text plain or with no type is broken`() {
        assertTrue(svgAs("text/plain") is ErrorResult)
        assertTrue(svgAs("text/plain; charset=utf-8") is ErrorResult)
        assertTrue(svgAs(null) is ErrorResult)
        // Empty or unparseable: OkHttp gives the body no type, so Coil guessed from the URL.
        for (bad in listOf("", "bogus", "svg")) assertTrue("[$bad]", svgAs(bad) is ErrorResult)
        // Coil guesses for any raw "text/plain…" prefix.
        for (bad in listOf("text/plainx", "text/plain-utf8")) {
            assertTrue("[$bad]", svgAs(bad) is ErrorResult)
            assertTrue("[$bad] no-store", svgAs(bad, noStore = true) is ErrorResult)
        }
        assertTrue(svgAs("application/xml") is ErrorResult)
    }

    @Test fun `an uncached svg served as text plain or with no type is broken too`() {
        assertTrue(svgAs("text/plain", noStore = true) is ErrorResult)
        assertTrue(svgAs(null, noStore = true) is ErrorResult)
        assertTrue(svgAs("image/svg+xml", noStore = true) is SuccessResult)
    }

    @Test fun `an svg the old loader cached as text plain is not served from that cache`() {
        // The pre-fix loader: Coil's default disk cache, no interceptor.
        val old = ImageLoader.Builder(app).components { add(SafeSvgDecoder.Factory()) }.build()
        val cached = { MockResponse().setBody(svg).setHeader("Content-Type", "text/plain").setHeader("Cache-Control", "max-age=3600") }
        server.enqueue(cached())
        server.enqueue(cached())
        val url = server.url("/old.svg").toString()
        assertTrue(fetch(old, url) is SuccessResult) // the bug, as it was cached
        assertTrue(fetch(app.newImageLoader(), url) is ErrorResult)
        // ...and the old cache is cleared, not left orphaned on disk.
        assertTrue(!app.cacheDir.resolve("image_cache").exists())
    }

    @Test fun `a png served as text plain still renders`() {
        val bmp = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val png = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        assertTrue(load(Buffer().write(png), "text/plain", "x.png") is SuccessResult)
    }
}
