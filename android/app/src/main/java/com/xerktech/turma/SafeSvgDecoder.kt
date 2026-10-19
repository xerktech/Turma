package com.xerktech.turma

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.graphics.drawable.ShapeDrawable
import android.util.Base64
import coil.ImageLoader
import coil.decode.DecodeResult
import coil.decode.Decoder
import coil.decode.ImageSource
import coil.fetch.SourceResult
import coil.request.Options
import coil.size.Dimension
import com.caverock.androidsvg.SVG
import com.caverock.androidsvg.SVGExternalFileResolver
import com.xerktech.turma.core.SVG_EMBEDDED_MAX_PIXELS
import com.xerktech.turma.core.SVG_PROLOG_MAX
import com.xerktech.turma.core.SvgVerdict
import com.xerktech.turma.core.blankSoFar
import com.xerktech.turma.core.dataUrlPayload
import com.xerktech.turma.core.opensMarkup
import com.xerktech.turma.core.svgBitmapSize
import com.xerktech.turma.core.svgNaturalSize
import com.xerktech.turma.core.svgVerdict
import com.xerktech.turma.core.svgZeroArea
import kotlinx.coroutines.runInterruptible
import okio.Buffer

/**
 * The SVG decoder behind [svgVerdict]: a safe SVG is rendered by [SizedSvgDecoder],
 * one carrying a DOCTYPE fails to decode (the caller shows its alt text), and
 * anything that isn't an SVG is left to the bitmap decoder. Registered INSTEAD of
 * Coil's `SvgDecoder.Factory`, so no path reaches AndroidSVG without the check.
 */
class SafeSvgDecoder private constructor() {
    class Factory : Decoder.Factory {
        override fun create(result: SourceResult, options: Options, imageLoader: ImageLoader): Decoder? {
            val declared = result.mimeType.equals("image/svg+xml", ignoreCase = true)
            // Peek, never consume: the chosen decoder reads the same source after.
            val peek = result.source.source().peek()
            val buf = Buffer()
            // A short look first, so a bitmap costs no more than it did before —
            // read on only while it is all whitespace, which no bitmap format opens with.
            peek.read(buf, 64)
            while (!declared && buf.size < SVG_PROLOG_MAX && blankSoFar(buf.snapshot().toByteArray())) {
                if (peek.read(buf, 4096) < 0) break
            }
            if (!declared && !opensMarkup(buf.snapshot().toByteArray())) return null
            while (buf.size < SVG_PROLOG_MAX) {
                if (peek.read(buf, SVG_PROLOG_MAX - buf.size) < 0) break
            }
            val head = buf.readByteArray()
            return when (svgVerdict(head, declared)) {
                SvgVerdict.NOT_SVG -> null
                SvgVerdict.SAFE -> SizedSvgDecoder(result.source, options, svgZeroArea(head))
                SvgVerdict.UNSAFE -> Decoder { throw IllegalStateException("refused SVG with a DOCTYPE") }
            }
        }

        override fun equals(other: Any?) = other is Factory
        override fun hashCode() = javaClass.hashCode()
    }
}

/**
 * An SVG decoder sized the way a browser sizes an SVG `<img>` (web parity with chat.js
 * svgToImg). The drawable's intrinsic size is the SVG's own in CSS px ([svgNaturalSize]:
 * no size at all is 300 × 150), which `ProseImage` reads as dp and caps the box at —
 * never the bitmap's, which is rasterised at device resolution ([svgBitmapSize], each
 * side ≥ 1 px). A declared zero width or height ([zeroArea]) decodes to an empty 0 × 0
 * drawable the caller lays out as nothing. Coil's own decoder reported the bitmap it
 * had scaled UP to the placeholder box, so every SVG filled the bubble width.
 *
 * Every render goes through [SvgRenderGuard], which bounds its time, its steps and the
 * images it embeds, and stops it when the decode is cancelled.
 */
private class SizedSvgDecoder(
    private val source: ImageSource,
    private val options: Options,
    private val zeroArea: Boolean,
) : Decoder {
    override suspend fun decode(): DecodeResult = runInterruptible {
        if (zeroArea) return@runInterruptible DecodeResult(ShapeDrawable(), isSampled = false)
        val svg = source.source().use { SVG.getFromInputStream(it.inputStream()) }
        val viewBox = svg.documentViewBox
        val (w, h) = svgNaturalSize(svg.documentWidth, svg.documentHeight, viewBox?.width(), viewBox?.height())
        val (bw, bh) = svgBitmapSize(
            w, h,
            (options.size.width as? Dimension.Pixels)?.px,
            options.context.resources.displayMetrics.density,
        )
        // Without a viewBox AndroidSVG draws 1:1 in user units; give it one so the
        // drawing scales to the bitmap (a browser's 300 × 150 viewport for none).
        if (viewBox == null) svg.setDocumentViewBox(0f, 0f, w, h)
        svg.setDocumentWidth("100%")
        svg.setDocumentHeight("100%")
        val config = options.config.takeIf { it != Bitmap.Config.HARDWARE } ?: Bitmap.Config.ARGB_8888
        val bitmap = Bitmap.createBitmap(bw, bh, config)
        SvgRenderGuard.render(svg, bitmap)
        DecodeResult(SvgDrawable(bitmap, maxOf(1, Math.round(w)), maxOf(1, Math.round(h))), isSampled = true)
    }
}

/**
 * Bounds an SVG render (XERK-2108). AndroidSVG has no hook for an ordinary draw, and a
 * `<pattern>` of 0.01-unit tiles over a 100 × 100 rect draws 10⁸ tiles: one core pinned
 * for 11+ minutes, still running after Back. But it calls `Canvas.save()` for every
 * element it renders and every pattern tile, so it renders onto a [GuardedCanvas] whose
 * `save()` counts the step against [RENDER_MAX_STEPS], checks the [RENDER_DEADLINE_MS]
 * deadline, and checks the thread's interrupt — which Coil's `runInterruptible` sets when
 * the request is cancelled (the image leaves the screen). Past any of them it throws (alt
 * text). The same checks guard every embedded image draw.
 *
 * It also bounds the raster images an SVG embeds. AndroidSVG decodes a `data:…;base64,` href
 * itself, at full size, on EVERY draw — a 20000 × 20000 PNG data URI allocated
 * ~1.6 GB, and a `<pattern>` of 1 × 1 tiles over a 2000² image re-decoded it per tile
 * for minutes after the screen was left. It consults the external resolver only when
 * that check returns null (javap of 1.4's `render(Image)`: `checkForImageDataURL`
 * first), so a resolver alone can't intercept it, and a text pre-scan kept losing to
 * its parser (a long mime type, a quote inside the payload).
 *
 * So the PARSED tree is rewritten: every `<image>` href AndroidSVG will use is swapped
 * for a sentinel no data-URL check accepts, and the original goes to this resolver,
 * which decodes it the way 1.4 does ([dataUrlPayload]) — size read first, each href
 * decoded once, every draw counted against [SVG_EMBEDDED_MAX_PIXELS], the render's
 * deadline and cancellation checked. Past any of them the render throws (alt text).
 * A non-data href resolves to nothing, as with no resolver: nothing is ever fetched.
 */
private object SvgRenderGuard : SVGExternalFileResolver() {
    private const val SENTINEL = "turma-image:"
    private const val RENDER_DEADLINE_MS = 5_000L

    // A step is one element or one pattern tile. A dense diagram takes a few thousand;
    // this is far past any SVG worth drawing, and reached in well under a second.
    const val RENDER_MAX_STEPS = 200_000

    private class Render(val hrefs: List<String>) {
        val started = System.nanoTime()
        val cache = HashMap<String, Bitmap?>()
        var drawn = 0L
        var steps = 0

        /** Throws once the render is cancelled, too slow, or too many steps long. */
        fun step() {
            check(!Thread.currentThread().isInterrupted) { "SVG render cancelled" }
            check(System.nanoTime() - started < RENDER_DEADLINE_MS * 1_000_000) { "refused SVG: render too slow" }
            check(++steps <= RENDER_MAX_STEPS) { "refused SVG: too many steps to draw" }
        }
    }

    /** A canvas that runs [Render.step] at every `save()` AndroidSVG makes. */
    private class GuardedCanvas(bitmap: Bitmap, private val r: Render) : Canvas(bitmap) {
        override fun save(): Int {
            r.step()
            return super.save()
        }
    }

    private val current = ThreadLocal<Render?>()

    // AndroidSVG 1.4's tree is package-private, so it is reached by reflection. A
    // rename in a later version fails loudly here (every SVG shows alt text and
    // SafeSvgDecoderTest goes red) rather than rendering images unbounded.
    private val rootField = SVG::class.java.getDeclaredField("rootElement").apply { isAccessible = true }
    private val containerClass = Class.forName("com.caverock.androidsvg.SVG\$SvgContainer")
    private val getChildren = containerClass.getMethod("getChildren").apply { isAccessible = true }
    private val imageClass = Class.forName("com.caverock.androidsvg.SVG\$Image")
    private val hrefField = imageClass.getDeclaredField("href").apply { isAccessible = true }

    init { SVG.registerExternalFileResolver(this) }

    fun render(svg: SVG, bitmap: Bitmap) {
        val hrefs = ArrayList<String>()
        rewrite(rootField.get(svg), hrefs)
        val r = Render(hrefs)
        current.set(r)
        try {
            svg.renderToCanvas(GuardedCanvas(bitmap, r))
        } finally {
            current.remove()
        }
    }

    /** Swap every `<image>` href under [node] for a sentinel indexing [hrefs]. */
    private fun rewrite(node: Any?, hrefs: MutableList<String>) {
        if (node == null) return
        if (imageClass.isInstance(node)) {
            (hrefField.get(node) as String?)?.let {
                hrefField.set(node, SENTINEL + hrefs.size)
                hrefs.add(it)
            }
        }
        if (containerClass.isInstance(node)) {
            @Suppress("UNCHECKED_CAST")
            for (child in getChildren.invoke(node) as List<Any?>) rewrite(child, hrefs)
        }
    }

    override fun resolveImage(filename: String?): Bitmap? {
        val r = current.get() ?: return null
        val href = filename?.removePrefix(SENTINEL)?.toIntOrNull()?.let { r.hrefs.getOrNull(it) } ?: return null
        r.step()
        val bitmap = r.cache.getOrPut(href) { decode(href, r) } ?: return null
        r.drawn += bitmap.width.toLong() * bitmap.height
        check(r.drawn <= SVG_EMBEDDED_MAX_PIXELS) { "refused SVG: embedded images draw too many pixels" }
        return bitmap
    }

    /** 1.4's `checkForImageDataURL`, with the size read (and budgeted) before the decode. */
    private fun decode(href: String, r: Render): Bitmap? {
        val payload = dataUrlPayload(href) ?: return null
        val data = runCatching { Base64.decode(payload, Base64.DEFAULT) }.getOrNull() ?: return null
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        runCatching { BitmapFactory.decodeByteArray(data, 0, data.size, o) }
        if (o.outWidth <= 0 || o.outHeight <= 0) return null
        check(r.drawn + o.outWidth.toLong() * o.outHeight <= SVG_EMBEDDED_MAX_PIXELS) {
            "refused SVG: embedded image too large"
        }
        return runCatching { BitmapFactory.decodeByteArray(data, 0, data.size) }.getOrNull()
    }
}

/**
 * A rasterised SVG whose intrinsic size is the SVG's own ([w] × [h] CSS px), not its
 * [bitmap]'s; drawn scaled into whatever bounds it is given.
 */
private class SvgDrawable(private val bitmap: Bitmap, private val w: Int, private val h: Int) : Drawable() {
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
    override fun draw(canvas: Canvas) = canvas.drawBitmap(bitmap, null, bounds, paint)
    override fun getIntrinsicWidth() = w
    override fun getIntrinsicHeight() = h
    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}
