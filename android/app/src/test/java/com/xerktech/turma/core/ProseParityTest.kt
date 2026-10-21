package com.xerktech.turma.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.fail
import org.junit.Test

/**
 * Web ⇄ Android prose parity (XERK-2140): every input in the shared corpus must
 * parse here to the same canonical tree chat.js `renderProse` renders.
 *
 * The fixture `prose-parity.json` is generated from chat.js by
 * `node turma/tests/prose-parity.js`, which also documents the canonical shape
 * and the deliberate differences it folds away. Regenerate it whenever
 * `renderProse` changes (`prose-parity.test.js` fails until you do); a failure
 * HERE means Prose.kt reads that input differently from the web.
 */
class ProseParityTest {

    @Test fun `parseProse matches renderProse over the shared corpus`() {
        val text = javaClass.getResourceAsStream("/prose-parity.json")!!.bufferedReader().readText()
        val cases = Json.parseToJsonElement(text).jsonArray
        val failures = ArrayList<String>()
        for (c in cases) {
            val input = c.jsonObject.getValue("input").jsonPrimitive.content
            val want = c.jsonObject.getValue("web")
            val got = proseCanon(parseProse(input))
            if (got != want) failures.add(visible("input=${JsonPrimitive(input)}\n  web=$want\n  android=$got"))
        }
        if (failures.isNotEmpty()) {
            fail("${failures.size} of ${cases.size} corpus inputs render differently on Android:\n" +
                failures.take(20).joinToString("\n"))
        }
    }
}

/** Every character outside printable ASCII as `\uXXXX`: the divergences live in invisible ones. */
private fun visible(s: String): String = buildString {
    for (ch in s) if (ch == '\n' || ch.code in 0x20..0x7E) append(ch) else append("\\u%04x".format(ch.code))
}

/** [blocks] as the harness's canonical JSON tree (see turma/tests/prose-parity.js). */
internal fun proseCanon(blocks: List<ProseBlock>): JsonElement = JsonArray(normBlocks(blocks.map(::canonBlock)))

private fun arr(vararg e: Any): JsonArray = JsonArray(e.map {
    when (it) {
        is JsonElement -> it
        is String -> JsonPrimitive(it)
        is Int -> JsonPrimitive(it)
        else -> error("unexpected $it")
    }
})

private fun canonBlock(b: ProseBlock): JsonArray = when (b) {
    is ProseBlock.Paragraph -> arr("p", canonSpans(b.spans))
    is ProseBlock.Code -> arr("code", b.lang, b.body)
    is ProseBlock.Heading -> arr("h", b.level, canonSpans(b.spans))
    ProseBlock.Rule -> arr("hr")
    is ProseBlock.Quote -> arr("q", JsonArray(normBlocks(b.blocks.map(::canonBlock))))
    is ProseBlock.ListBlock -> arr("list", JsonArray(b.items.map { arr(it.depth, it.marker, canonSpans(it.spans)) }))
    is ProseBlock.Table -> arr(
        "table",
        JsonArray(b.header.map(::canonSpans)),
        JsonArray(b.aligns.map { JsonPrimitive(if (it == CellAlign.NONE) "" else it.name.lowercase()) }),
        JsonArray(b.rows.map { r -> JsonArray(r.map(::canonSpans)) }),
    )
    is ProseBlock.Svg -> arr("svg", b.source)
}

/** Spans with adjacent text merged and empty text dropped, as the web's HTML reads back. */
private fun canonSpans(spans: List<Span>): JsonArray {
    val out = ArrayList<JsonElement>()
    for (s in spans) {
        val e: JsonElement = when (s) {
            is Span.Text -> if (s.text.isEmpty()) continue else JsonPrimitive(s.text)
            is Span.Code -> arr("c", s.text)
            is Span.Link -> arr("a", s.label, s.url)
            is Span.Image -> arr("img", s.alt, s.url)
            is Span.Styled -> arr(
                "s",
                (if (s.bold) "b" else "") + (if (s.italic) "i" else "") + (if (s.strike) "x" else ""),
                canonSpans(s.spans),
            )
        }
        val last = out.lastOrNull()
        if (e is JsonPrimitive && last is JsonPrimitive) out[out.size - 1] = JsonPrimitive(last.content + e.content)
        else out.add(e)
    }
    return JsonArray(out)
}

/** Whitespace-only paragraphs dropped, adjacent lists merged — the deliberate list/spacing folds. */
private fun normBlocks(blocks: List<JsonArray>): List<JsonArray> {
    val out = ArrayList<JsonArray>()
    for (b in blocks) {
        val kind = b[0].jsonPrimitive.content
        if (kind == "p" && b[1].jsonArray.all { it is JsonPrimitive && isJsBlank(it.content) }) continue
        val last = out.lastOrNull()
        if (kind == "list" && last != null && last[0].jsonPrimitive.content == "list") {
            out[out.size - 1] = arr("list", JsonArray(last[1].jsonArray + b[1].jsonArray))
        } else {
            out.add(b)
        }
    }
    return out
}
