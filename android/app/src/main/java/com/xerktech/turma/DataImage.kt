package com.xerktech.turma

import android.util.Base64
import coil.ComponentRegistry
import coil.ImageLoader
import coil.decode.BitmapFactoryDecoder
import coil.decode.DataSource
import coil.decode.Decoder
import coil.decode.ImageSource
import coil.fetch.FetchResult
import coil.fetch.SourceResult
import coil.request.Options
import okio.Buffer

/**
 * A `data:` URI image: its bytes and the type it DECLARES (XERK-2161). Coil 2.x
 * loads no data: URI itself, and bytes handed to it bare arrive with no type, so
 * [SafeSvgDecoder] sniffed them: a `data:image/png` whose bytes were SVG markup
 * rendered here and was broken on the web, which trusts the declared type. [Fetcher]
 * hands Coil the declared type, and [DeclaredBitmapDecoder] keeps a declared bitmap
 * away from the SVG sniff.
 */
class DataImage(val mimeType: String, val bytes: ByteArray) {
    class Fetcher private constructor(private val data: DataImage, private val options: Options) : coil.fetch.Fetcher {
        override suspend fun fetch(): FetchResult =
            SourceResult(ImageSource(Buffer().write(data.bytes), options.context), data.mimeType, DataSource.MEMORY)

        class Factory : coil.fetch.Fetcher.Factory<DataImage> {
            override fun create(data: DataImage, options: Options, imageLoader: ImageLoader): coil.fetch.Fetcher =
                Fetcher(data, options)
        }
    }

    companion object {
        /**
         * A data: URI → its declared type (lower-cased, no parameters; none is
         * text/plain, as RFC 2397 says) and its bytes. Handles ;base64 payloads and
         * percent-encoded ones (the `+` guard keeps a literal plus in an SVG from
         * decoding to a space). Null for anything malformed.
         */
        fun parse(src: String): DataImage? = try {
            val comma = src.indexOf(',')
            if (comma < 0 || !src.startsWith("data:", ignoreCase = true)) null else {
                val meta = src.substring(5, comma)
                val payload = src.substring(comma + 1)
                val type = meta.substringBefore(';').trim().lowercase().ifEmpty { "text/plain" }
                val bytes = if (meta.contains(";base64", ignoreCase = true)) Base64.decode(payload, Base64.DEFAULT)
                else java.net.URLDecoder.decode(payload.replace("+", "%2B"), "UTF-8").toByteArray(Charsets.UTF_8)
                DataImage(type, bytes)
            }
        } catch (e: Exception) { null }
    }
}

/**
 * A source that declares a non-SVG image type is decoded as a bitmap and never
 * sniffed for SVG, as a browser does: bytes that aren't that bitmap fail (alt text),
 * where [SafeSvgDecoder] would have rendered SVG markup found in them. Registered
 * ahead of it. A source with no type, or an SVG one, is left to [SafeSvgDecoder].
 */
class DeclaredBitmapDecoder private constructor() {
    class Factory : Decoder.Factory {
        // Coil's own factory, so its cap on parallel bitmap decodes still holds.
        private val bitmaps = BitmapFactoryDecoder.Factory()

        override fun create(result: SourceResult, options: Options, imageLoader: ImageLoader): Decoder? {
            val type = result.mimeType?.substringBefore(';')?.trim()?.lowercase() ?: return null
            if (!type.startsWith("image/") || type == "image/svg+xml") return null
            return bitmaps.create(result, options, imageLoader)
        }

        override fun equals(other: Any?) = other is Factory
        override fun hashCode() = javaClass.hashCode()
    }
}

/**
 * The app loader's components, in order: data: URIs carry their declared type, and
 * a declared bitmap is never sniffed for SVG (XERK-2161) — so [DeclaredBitmapDecoder]
 * before [SafeSvgDecoder]. Shared with the tests, so they check the app's own list.
 */
fun turmaImageComponents(): ComponentRegistry = ComponentRegistry.Builder()
    .add(DataImage.Fetcher.Factory())
    .add(DeclaredBitmapDecoder.Factory())
    .add(SafeSvgDecoder.Factory())
    .build()
