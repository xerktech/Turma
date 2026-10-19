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
import com.xerktech.turma.core.SVG_EMBEDDED_MAX_PIXELS
import com.xerktech.turma.core.SVG_PROLOG_MAX
import com.xerktech.turma.core.SvgVerdict
import com.xerktech.turma.core.blankSoFar
import com.xerktech.turma.core.opensMarkup
import com.xerktech.turma.core.svgBitmapSize
import com.xerktech.turma.core.svgEmbeddedImages
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
 * An SVG whose embedded raster images ([svgEmbeddedImages]) would decode past
 * [SVG_EMBEDDED_MAX_PIXELS] is refused (alt text): AndroidSVG decodes them at full
 * size with no bound of its own.
 */
private class SizedSvgDecoder(
    private val source: ImageSource,
    private val options: Options,
    private val zeroArea: Boolean,
) : Decoder {
    override suspend fun decode(): DecodeResult = runInterruptible {
        if (zeroArea) return@runInterruptible DecodeResult(ShapeDrawable(), isSampled = false)
        val bytes = source.source().use { it.readByteArray() }
        check(embeddedPixels(String(bytes, Charsets.ISO_8859_1)) <= SVG_EMBEDDED_MAX_PIXELS) {
            "refused SVG with an oversized embedded image"
        }
        val svg = SVG.getFromInputStream(bytes.inputStream())
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
        svg.renderToCanvas(Canvas(bitmap))
        DecodeResult(SvgDrawable(bitmap, maxOf(1, Math.round(w)), maxOf(1, Math.round(h))), isSampled = true)
    }

    /** The pixels [svg]'s embedded images decode to, read from their headers alone. */
    private fun embeddedPixels(svg: String): Long {
        var total = 0L
        for (payload in svgEmbeddedImages(svg)) {
            // The decode AndroidSVG does: a payload that fails here fails there too.
            val data = runCatching { Base64.decode(payload, Base64.DEFAULT) }.getOrNull() ?: continue
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            runCatching { BitmapFactory.decodeByteArray(data, 0, data.size, o) }
            if (o.outWidth > 0 && o.outHeight > 0) total += o.outWidth.toLong() * o.outHeight
        }
        return total
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
