package com.xerktech.turma

import android.graphics.Bitmap
import android.os.Looper
import android.webkit.MimeTypeMap
import androidx.test.core.app.ApplicationProvider
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

    private fun load(body: Buffer, type: String?, name: String): ImageResult {
        server.enqueue(MockResponse().setBody(body).apply { if (type != null) setHeader("Content-Type", type) })
        val loader = app.newImageLoader()
        val request = ImageRequest.Builder(app).data(server.url("/$name").toString()).size(100, 100).build()
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
    private fun svgAs(type: String?) = load(Buffer().writeUtf8(svg), type, "x${++n}.svg")

    @Test fun `an svg served as image svg+xml renders`() {
        assertTrue(svgAs("image/svg+xml") is SuccessResult)
        assertTrue(svgAs("image/svg+xml; charset=utf-8") is SuccessResult)
    }

    @Test fun `an svg served as text plain or with no type is broken`() {
        assertTrue(svgAs("text/plain") is ErrorResult)
        assertTrue(svgAs("text/plain; charset=utf-8") is ErrorResult)
        assertTrue(svgAs(null) is ErrorResult)
        assertTrue(svgAs("application/xml") is ErrorResult)
    }

    @Test fun `a png served as text plain still renders`() {
        val bmp = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val png = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        assertTrue(load(Buffer().write(png), "text/plain", "x.png") is SuccessResult)
    }
}
