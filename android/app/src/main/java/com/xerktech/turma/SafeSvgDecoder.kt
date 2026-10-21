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
import androidx.annotation.VisibleForTesting
import coil.ImageLoader
import coil.decode.DataSource
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
import com.xerktech.turma.core.svgFilledSize
import com.xerktech.turma.core.svgNaturalSize
import com.xerktech.turma.core.svgVerdict
import com.xerktech.turma.core.svgZeroArea
import kotlinx.coroutines.runInterruptible
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Response
import okhttp3.ResponseBody.Companion.asResponseBody
import okio.Buffer

/**
 * The SVG decoder behind [svgVerdict]: a safe SVG is rendered by [SizedSvgDecoder],
 * one carrying a DOCTYPE fails to decode (the caller shows its alt text), and
 * anything that isn't an SVG is left to the bitmap decoder. Registered INSTEAD of
 * Coil's `SvgDecoder.Factory`, so no path reaches AndroidSVG without the check.
 *
 * An SVG fetched over the network renders only when it was SERVED as image/svg+xml,
 * as in a browser, which never sniffs an SVG (Chrome shows one served as text/plain,
 * application/xml, octet-stream or with no type broken, while it sniffs a bitmap
 * whatever its type). Coil guesses an `.svg` URL's type from its extension when the
 * server says text/plain or nothing, so [ServedContentType] keeps that guess from
 * reaching here. Data URIs and in-memory bytes are sniffed as before.
 */
class SafeSvgDecoder private constructor() {
    class Factory : Decoder.Factory {
        override fun create(result: SourceResult, options: Options, imageLoader: ImageLoader): Decoder? {
            val declared = result.mimeType?.trim().equals("image/svg+xml", ignoreCase = true)
            // DISK is Coil's disk cache of an http fetch: this app loads no files.
            val remote = result.dataSource == DataSource.NETWORK || result.dataSource == DataSource.DISK
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
            val verdict = svgVerdict(head, declared)
            if (verdict != SvgVerdict.NOT_SVG && remote && !declared) {
                return Decoder { throw IllegalStateException("refused SVG not served as image/svg+xml") }
            }
            return when (verdict) {
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
 * no size at all is 300 × 150; a viewBox alone is the width of the box it is decoded
 * for, [svgFilledSize]), which `ProseImage` reads as dp and caps the box at —
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
        val (rootW, rootH) = SvgRenderGuard.rootSize(svg)
        val dstW = (options.size.width as? Dimension.Pixels)?.px
        val density = options.context.resources.displayMetrics.density
        val (w, h) = svgFilledSize(svgNaturalSize(rootW, rootH, viewBox?.width(), viewBox?.height()), dstW, density)
        val (bw, bh) = svgBitmapSize(w, h, dstW, density)
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
 * `save()` counts the step against [RENDER_MAX_STEPS], checks the [renderDeadlineMs]
 * deadline, and checks the thread's interrupt — which Coil's `runInterruptible` sets when
 * the request is cancelled (the image leaves the screen). Past any of them it throws (alt
 * text). The same checks guard every embedded image draw.
 *
 * Not everything reaches `save()`: computing a clip path (`<use>` and nested clip-paths
 * inside it, text turned into glyph outlines, `Path.op` per element) runs in one call,
 * and a 2.5 KB SVG of clip-paths that each `<use>` the last one ten times pinned a core
 * past Back. So before rendering, [cost] walks the parsed tree once, following every
 * reference AndroidSVG will (`<use>`, `<tref>`, `<textPath>`, a pattern's `href`, a
 * pattern fill, clip-path, mask, markers), and refuses an SVG whose total passes
 * [RENDER_MAX_COST]. References are memoised, so the walk is linear in the file even when
 * what it measures is exponential. Two things it can't measure are refused outright: a
 * stylesheet rule setting clip-path, mask or a marker (it could apply to any element),
 * and a clip-path inside pattern content (paid once per tile).
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
internal object SvgRenderGuard : SVGExternalFileResolver() {
    private const val SENTINEL = "turma-image:"
    @VisibleForTesting internal var renderDeadlineMs = 5_000L

    // A step is one element or one pattern tile. A dense diagram takes a few thousand;
    // this is far past any SVG worth drawing, and reached in well under a second.
    const val RENDER_MAX_STEPS = 200_000

    // A unit of [cost] is one element, path command, polyline point or text character;
    // inside a clip path each counts [CLIP_WEIGHT], as clipping runs Path.op on its outline,
    // and a path or polyline of n points counts n² / 4 there (a self-crossing outline of
    // 300 points clipped in 53 ms, of 950 in 8 s). The budget is set from the worst shapes
    // measured (Robolectric, real Skia), each about 2 s at most: a 29 000-segment stroke
    // 500 wide, a 950-character clip-path text, a 340-point self-crossing clip path.
    const val RENDER_MAX_COST = 30_000L
    private const val CLIP_WEIGHT = 30L

    private class Render(val hrefs: List<String>) {
        val started = System.nanoTime()
        val cache = HashMap<String, Bitmap?>()
        var drawn = 0L
        var steps = 0

        /** Throws once the render is cancelled, too slow, or too many steps long. */
        fun step() {
            check(!Thread.currentThread().isInterrupted) { "SVG render cancelled" }
            check(System.nanoTime() - started < renderDeadlineMs * 1_000_000) { "refused SVG: render too slow" }
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

    private fun svgClass(name: String) = Class.forName("com.caverock.androidsvg.SVG\$$name")
    private fun field(c: Class<*>, name: String) = c.getDeclaredField(name).apply { isAccessible = true }
    private val resolveIri = SVG::class.java.getDeclaredMethod("resolveIRI", String::class.java)
        .apply { isAccessible = true }
    private val cssRulesField = field(SVG::class.java, "cssRules")
    private val rulesField = field(Class.forName("com.caverock.androidsvg.CSSParser\$Ruleset"), "rules")
    private val ruleStyleField = field(Class.forName("com.caverock.androidsvg.CSSParser\$Rule"), "style")
    private val elementBaseClass = svgClass("SvgElementBase")
    private val baseStyleField = field(elementBaseClass, "baseStyle")
    private val styleField = field(elementBaseClass, "style")
    private val styleClass = svgClass("Style")
    private val clipPathField = field(styleClass, "clipPath")
    private val maskField = field(styleClass, "mask")
    private val markerFields = listOf("markerStart", "markerMid", "markerEnd").map { field(styleClass, it) }
    private val paintFields = listOf("fill", "stroke").map { field(styleClass, it) }
    private val paintRefClass = svgClass("PaintReference")
    private val paintHrefField = field(paintRefClass, "href")
    private val patternClass = svgClass("Pattern")
    private val clipPathClass = svgClass("ClipPath")
    // Elements that reference another by href: AndroidSVG renders (or, for a pattern,
    // inherits the children of) the target.
    private val hrefFields = listOf("Use", "TRef", "TextPath", "Pattern").map { field(svgClass(it), "href") }
    private val hrefClasses = hrefFields.map { it.declaringClass }
    private val pathClass = svgClass("Path")
    private val pathDField = field(pathClass, "d")
    private val commandsLengthField = field(svgClass("PathDefinition"), "commandsLength")
    private val polyLineClass = svgClass("PolyLine")
    private val pointsField = field(polyLineClass, "points")
    private val textSequenceClass = svgClass("TextSequence")
    private val textField = field(textSequenceClass, "text")

    // The root <svg>'s own width and height, which SVG.getDocumentWidth/Height don't
    // give: they invent a height from the width, and drop both when either is relative.
    private val rootClass = svgClass("Svg")
    private val rootWidthField = field(rootClass, "width")
    private val rootHeightField = field(rootClass, "height")
    private val lengthClass = svgClass("Length")
    private val lengthValueField = field(lengthClass, "value")
    private val lengthUnitField = field(lengthClass, "unit")
    private val lengthToPx = lengthClass.getDeclaredMethod("floatValue", Float::class.javaPrimitiveType)
        .apply { isAccessible = true }

    init { SVG.registerExternalFileResolver(this) }

    /**
     * The root's width and height in CSS px, each null when absent or a percentage
     * (a browser's `<img>` has no box for a percentage to resolve against). An `em` is
     * the browser default 16 px and an `ex` half that; absolute units at [SVG.getRenderDPI].
     */
    fun rootSize(svg: SVG): Pair<Float?, Float?> {
        val root = rootField.get(svg)
        fun px(f: java.lang.reflect.Field): Float? {
            val len = root?.let { f.get(it) } ?: return null
            val value = lengthValueField.getFloat(len)
            return when ((lengthUnitField.get(len) as Enum<*>?)?.name) {
                "percent" -> null
                "em" -> value * 16f
                "ex" -> value * 8f
                else -> lengthToPx.invoke(len, svg.renderDPI) as Float
            }
        }
        return px(rootWidthField) to px(rootHeightField)
    }

    fun render(svg: SVG, bitmap: Bitmap) {
        check(Cost(svg).total() <= RENDER_MAX_COST) { "refused SVG: too costly to draw" }
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

    /**
     * The work a render of [svg] does that `save()` can't see, as an upper bound. Each
     * node's cost is memoised by identity, so a node referenced N times is walked once
     * and costs N times; a reference cycle counts 0 (AndroidSVG overflows its stack on
     * one, which shows alt text).
     */
    private class Cost(private val svg: SVG) {
        private class Node(val cost: Long, val clips: Boolean)
        // Indexed by whether the walk is inside a clip path, which prices a node differently.
        private val memo = Array(2) { java.util.IdentityHashMap<Any, Node>() }
        private val walking = Array(2) { java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Any, Boolean>()) }

        fun total(): Long {
            val rules = cssRulesField.get(svg)?.let { rulesField.get(it) as List<*>? }.orEmpty()
            for (rule in rules) {
                val style = ruleStyleField.get(rule) ?: continue
                check(clipPathField.get(style) == null && maskField.get(style) == null &&
                    markerFields.all { it.get(style) == null }) {
                    "refused SVG: a stylesheet sets clip-path, mask or a marker"
                }
                // A stylesheet's pattern fill could land on any element: its clips are refused
                // here, as the walk below only sees fills set on the element itself.
                for (f in paintFields) patternRef(f.get(style), false)
            }
            return node(rootField.get(svg), false).cost
        }

        private fun resolve(iri: String?): Any? = iri?.let { resolveIri.invoke(svg, it) }

        /** The pattern [paint] fills with, if any; refused if its content clips. */
        private fun patternRef(paint: Any?, inClip: Boolean): Node? {
            if (!paintRefClass.isInstance(paint)) return null
            val target = resolve(paintHrefField.get(paint) as String?)
            if (!patternClass.isInstance(target)) return null
            return node(target, inClip).also { check(!it.clips) { "refused SVG: a clip-path inside a pattern" } }
        }

        private fun node(n: Any?, inClip: Boolean): Node {
            val c = if (inClip) 1 else 0
            if (n == null || n in walking[c]) return Node(0, false)
            memo[c][n]?.let { return it }
            walking[c].add(n)
            val weight = if (inClip) CLIP_WEIGHT else 1L
            var cost = weight
            var clips = false
            fun add(other: Node, times: Long = 1) {
                cost = saturatedAdd(cost, saturatedTimes(other.cost, times))
                clips = clips || other.clips
            }
            // Points (or text characters) this element draws, priced for where it is drawn.
            fun points(k: Long) {
                cost = saturatedAdd(cost, if (inClip) maxOf(k * weight, saturatedTimes(k, k) / 4) else k)
            }
            val vertices = when {
                pathClass.isInstance(n) -> pathDField.get(n)?.let { commandsLengthField.getInt(it).toLong() } ?: 0
                polyLineClass.isInstance(n) -> ((pointsField.get(n) as FloatArray?)?.size ?: 0) / 2L
                else -> 0
            }
            points(vertices)
            if (textSequenceClass.isInstance(n)) cost += weight * ((textField.get(n) as String?)?.length ?: 0)
            hrefClasses.forEachIndexed { i, cls ->
                if (cls.isInstance(n)) add(node(resolve(hrefFields[i].get(n) as String?), inClip))
            }
            if (elementBaseClass.isInstance(n)) {
                for (style in listOf(baseStyleField.get(n), styleField.get(n))) {
                    if (style == null) continue
                    resolve(clipPathField.get(style) as String?)?.let {
                        add(node(it, true))
                        clips = true
                    }
                    add(node(resolve(maskField.get(style) as String?), inClip))
                    for (f in markerFields) add(node(resolve(f.get(style) as String?), inClip), maxOf(1L, vertices))
                    for (f in paintFields) patternRef(f.get(style), inClip)?.let { add(it) }
                }
            }
            if (containerClass.isInstance(n)) {
                @Suppress("UNCHECKED_CAST")
                for (child in getChildren.invoke(n) as List<Any?>) add(node(child, inClip))
            }
            // A clipPath's own content is a clip: counted, and flagged, wherever it is used.
            if (clipPathClass.isInstance(n)) clips = true
            walking[c].remove(n)
            return Node(cost, clips).also { memo[c][n] = it }
        }

        private fun saturatedAdd(a: Long, b: Long) = if (Long.MAX_VALUE - a < b) Long.MAX_VALUE else a + b
        private fun saturatedTimes(a: Long, b: Long) = if (a != 0L && b > Long.MAX_VALUE / a) Long.MAX_VALUE else a * b
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

/**
 * Keeps Coil from guessing an image's type from its URL (XERK-2109). Coil's
 * `HttpUriFetcher` takes a response served as text/plain, or with no (or an
 * unparseable) Content-Type, to
 * be whatever its extension says — an `.svg` URL then reads as image/svg+xml and
 * renders, where a browser shows it broken. Such a response is relabelled
 * application/octet-stream, which Coil passes through as it is, so [SafeSvgDecoder]
 * sees what the server really said. A bitmap is sniffed from its bytes either way.
 */
object ServedContentType : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        // Coil guesses when the type is text/plain or none — and an empty or unparseable
        // header IS none to it (OkHttp gives the body no type).
        // Coil's text/plain test is a prefix of the raw string ("text/plainx" too), so is this one.
        val raw = response.header("Content-Type")
        val guessed = raw?.toMediaTypeOrNull() == null || raw.trim().startsWith("text/plain", ignoreCase = true)
        val body = response.body
        if (!guessed || body == null) return response
        // Coil reads the BODY's type on a fetch and the header on a disk-cache hit: both change.
        return response.newBuilder()
            .header("Content-Type", OCTET_STREAM.toString())
            .body(body.source().asResponseBody(OCTET_STREAM, body.contentLength()))
            .build()
    }

    private val OCTET_STREAM = "application/octet-stream".toMediaType()
}
