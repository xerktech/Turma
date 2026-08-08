package com.xerktech.turma.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xerktech.turma.core.CellAlign
import com.xerktech.turma.core.ChatItem
import com.xerktech.turma.core.ProseBlock
import com.xerktech.turma.core.Span
import com.xerktech.turma.core.parseProse
import com.xerktech.turma.model.SendFile
import android.graphics.Color as AndroidColor
import android.util.Base64
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.viewinterop.AndroidView
import coil.compose.AsyncImage
import java.nio.ByteBuffer
import kotlinx.coroutines.delay

/** Shared renderers for one transcript item — used by live chat + the archive. */
@Composable
fun ChatItemView(item: ChatItem) {
    when (item) {
        is ChatItem.Bubble -> TranscriptBubble(item)
        is ChatItem.Thinking -> TranscriptThinking(item.text)
        is ChatItem.Tool -> TranscriptTool(item)
        is ChatItem.TaskNote -> Pill("⚑ ${item.summary} (${item.status})")
    }
}

/**
 * The fleet-wide chat text size (XERK-144): every hardcoded `.sp` below is scaled
 * by this so one preference moves all of them together, keeping their relative
 * proportions. Reads `ui.LocalTextSize`, provided at the app root.
 */
@Composable
private fun scaledSp(base: Float): TextUnit = (base * LocalTextSize.current.current.scale).sp

// The bubble keeps a max width so a long turn doesn't run edge to edge, but the
// leftover gutter (available width − BASE_BUBBLE_MAX) is halved (XERK-74): the cap
// is (available + BASE_BUBBLE_MAX)/2, so the empty space shrinks by half at any
// screen width. Short turns still hug their text; only the cap moves.
private val BASE_BUBBLE_MAX = 340.dp

@Composable
private fun TranscriptBubble(b: ChatItem.Bubble) {
    val isUser = b.role == "user"
    val shown = if (b.revealLen in 0 until b.text.length) b.text.take(b.revealLen) else b.text
    // Parse the prose once (web parity: chat.js renderProse) — tables, fenced
    // code, inline code and links become real blocks/spans rather than raw text.
    val blocks = remember(shown) { parseProse(shown) }
    // A bubble carrying a table or code block takes the full width so the grid /
    // code lines have room, mirroring the web's `:has(.md-code)` widening.
    val wide = blocks.any { it is ProseBlock.Table || it is ProseBlock.Code }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val cap = if (wide) maxWidth else (maxWidth + BASE_BUBBLE_MAX) / 2
        Row(Modifier.fillMaxWidth(), horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start) {
            Surface(
                color = if (isUser) MaterialTheme.colorScheme.primary.copy(alpha = 0.16f) else MaterialTheme.colorScheme.surfaceVariant,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.widthIn(max = cap),
            ) {
                // Force full-contrast prose (web parity: assistant text is --ink,
                // not the muted --ink-2). Without this the assistant bubble's
                // surfaceVariant background makes Surface derive onSurfaceVariant
                // (a grey) as its content color, so agent text read grey in dark
                // mode while the user bubble — whose color isn't a theme token, so
                // it keeps the ambient onSurface — read white (XERK-136).
                ProseBlocks(
                    blocks,
                    Modifier.padding(10.dp, 6.dp),
                    fontSize = scaledSp(13f),
                    lineHeight = scaledSp(18f),
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

@Composable
private fun TranscriptThinking(text: String) {
    var open by remember { mutableStateOf(false) }
    val blocks = remember(text) { parseProse(text) }
    Column(Modifier.fillMaxWidth().clickable { open = !open }) {
        Text("💭 thinking", fontSize = scaledSp(12f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        // The web renders the thinking trace through renderProse too (italic).
        if (open) ProseBlocks(
            blocks,
            Modifier.padding(start = 8.dp, top = 2.dp),
            fontSize = scaledSp(12f),
            lineHeight = scaledSp(16f),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            italic = true,
        )
    }
}

// ---- prose block rendering (web parity: chat.js renderProse) --------------
// Render the typed tree from core.parseProse: paragraphs with inline code/link
// spans, fenced code blocks, and GFM tables. Colors are derived from the text
// color at low alpha so a code chip / table border is visible on any bubble
// background (the assistant's surfaceVariant, the user's primary tint, or a
// thinking trace) without a hardcoded palette.
@Composable
private fun ProseBlocks(
    blocks: List<ProseBlock>,
    modifier: Modifier = Modifier,
    fontSize: TextUnit,
    lineHeight: TextUnit,
    color: Color,
    italic: Boolean = false,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (block in blocks) when (block) {
            is ProseBlock.Paragraph -> Text(
                spansToAnnotated(block.spans, codeBg = color.copy(alpha = 0.10f), linkColor = MaterialTheme.colorScheme.primary, codeSize = fontSize * 0.88f),
                fontSize = fontSize,
                lineHeight = lineHeight,
                color = color,
                fontStyle = if (italic) FontStyle.Italic else FontStyle.Normal,
            )
            is ProseBlock.Code -> ProseCode(block, fontSize, color)
            is ProseBlock.Table -> ProseTable(block, fontSize, color)
        }
    }
}

/** Inline spans → an AnnotatedString: code chips (mono, tinted) and tappable links. */
private fun spansToAnnotated(spans: List<Span>, codeBg: Color, linkColor: Color, codeSize: TextUnit): AnnotatedString =
    buildAnnotatedString {
        for (span in spans) when (span) {
            is Span.Text -> append(span.text)
            is Span.Code -> withStyle(
                SpanStyle(fontFamily = FontFamily.Monospace, fontStyle = FontStyle.Normal, background = codeBg, fontSize = codeSize)
            ) { append(span.text) }
            // LinkAnnotation.Url opens via the ambient UriHandler (external browser).
            is Span.Link -> withLink(
                LinkAnnotation.Url(span.url, TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)))
            ) { append(span.label) }
        }
    }

@Composable
private fun ProseCode(block: ProseBlock.Code, fontSize: TextUnit, color: Color) {
    // A copy button pinned to the top-right corner of the block (XERK-183),
    // matching the web/phone chat views. The Box is the positioning context; the
    // code Column keeps right padding so a long first line doesn't run under it.
    Box(Modifier.fillMaxWidth()) {
        Column(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(6.dp))
                .background(color.copy(alpha = 0.06f))
                .border(1.dp, color.copy(alpha = 0.22f), RoundedCornerShape(6.dp))
                .padding(start = 8.dp, top = 6.dp, bottom = 6.dp, end = 34.dp),
        ) {
            if (block.lang.isNotBlank()) {
                Text(
                    block.lang.uppercase(),
                    fontSize = scaledSp(9f),
                    fontFamily = FontFamily.Monospace,
                    color = color.copy(alpha = 0.6f),
                    modifier = Modifier.padding(bottom = 4.dp),
                )
            }
            // white-space: pre + overflow-x: auto — no wrap, scroll horizontally.
            Text(
                block.body,
                Modifier.horizontalScroll(rememberScrollState()),
                fontSize = fontSize * 0.9f,
                lineHeight = fontSize * 1.25f,
                fontFamily = FontFamily.Monospace,
                color = color,
                softWrap = false,
            )
        }
        CopyButton(
            text = block.body,
            tint = color,
            modifier = Modifier.align(Alignment.TopEnd).padding(4.dp),
        )
    }
}

// Small clipboard button used by ProseCode. Copies `text` and flashes a check
// for ~1.2s, mirroring the web's .md-copy button.
@Composable
private fun CopyButton(text: String, tint: Color, modifier: Modifier = Modifier) {
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) { delay(1200); copied = false }
    }
    Box(
        modifier
            .size(24.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(tint.copy(alpha = 0.10f))
            .clickable {
                clipboard.setText(AnnotatedString(text))
                copied = true
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy,
            contentDescription = "Copy code",
            tint = if (copied) MaterialTheme.colorScheme.primary else tint.copy(alpha = 0.7f),
            modifier = Modifier.size(15.dp),
        )
    }
}

@Composable
private fun ProseTable(block: ProseBlock.Table, fontSize: TextUnit, color: Color) {
    val border = color.copy(alpha = 0.3f)
    val cols = block.header.size
    if (cols == 0) return
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        ProseTableRow(block.header, block.aligns, cols, fontSize, color, border, bg = color.copy(alpha = 0.09f), header = true)
        block.rows.forEachIndexed { idx, row ->
            ProseTableRow(row, block.aligns, cols, fontSize, color, border, bg = if (idx % 2 == 1) color.copy(alpha = 0.04f) else Color.Transparent, header = false)
        }
    }
}

@Composable
private fun ProseTableRow(
    cells: List<List<Span>>,
    aligns: List<CellAlign>,
    cols: Int,
    fontSize: TextUnit,
    color: Color,
    border: Color,
    bg: Color,
    header: Boolean,
) {
    // Equal-weight columns fill the bubble width (mobile-idiomatic: wide tables
    // wrap their cells rather than scroll). height(IntrinsicSize.Min) makes every
    // cell in the row share the tallest cell's height so borders line up.
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        for (i in 0 until cols) {
            Box(
                Modifier.weight(1f).fillMaxHeight()
                    .border(0.5.dp, border)
                    .background(bg)
                    .padding(horizontal = 6.dp, vertical = 4.dp),
            ) {
                val align = aligns.getOrElse(i) { CellAlign.NONE }
                Text(
                    spansToAnnotated(cells.getOrElse(i) { emptyList() }, codeBg = color.copy(alpha = 0.10f), linkColor = MaterialTheme.colorScheme.primary, codeSize = fontSize * 0.82f),
                    Modifier.fillMaxWidth(),
                    fontSize = fontSize * 0.9f,
                    lineHeight = fontSize * 1.2f,
                    color = color,
                    fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal,
                    textAlign = when (align) {
                        CellAlign.CENTER -> TextAlign.Center
                        CellAlign.RIGHT -> TextAlign.End
                        else -> TextAlign.Start
                    },
                )
            }
        }
    }
}

@Composable
private fun TranscriptTool(t: ChatItem.Tool) {
    var open by remember { mutableStateOf(false) }
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (t.isError) MaterialTheme.colorScheme.error.copy(alpha = 0.12f)
            else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)
        ),
        modifier = Modifier.fillMaxWidth().clickable { open = !open },
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 7.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("🔧 ${t.name}", fontWeight = FontWeight.SemiBold, fontSize = scaledSp(12f), modifier = Modifier.weight(1f))
                // A SendUserFile card leads with its caption/file count, not the raw
                // path JSON (web parity: renderActionCard's argOne).
                val summary = if (t.files.isNotEmpty())
                    (t.caption.substringBefore('\n').ifBlank { "${t.files.size} file" + if (t.files.size == 1) "" else "s" })
                else t.input
                if (summary.isNotBlank()) Text(summary.take(48), fontSize = scaledSp(11f), fontFamily = FontFamily.Monospace, maxLines = 1, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            // SendUserFile inline previews (XERK-221) — shown open, like the web card.
            if (t.files.isNotEmpty()) {
                Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (f in t.files) SendFileView(f)
                }
                if (t.caption.isNotBlank()) {
                    Text(t.caption, Modifier.padding(top = 4.dp), fontSize = scaledSp(12f), lineHeight = scaledSp(16f), color = MaterialTheme.colorScheme.onSurface)
                }
            }
            if (open && t.result.isNotBlank()) {
                Text(t.result, Modifier.padding(top = 5.dp), fontSize = scaledSp(11f), lineHeight = scaledSp(15f), fontFamily = FontFamily.Monospace)
            }
        }
    }
}

// One SendUserFile preview (XERK-221): an image/SVG via Coil, an HTML page in a
// JS-disabled (sandboxed) WebView, else a name chip. Web parity: renderToolFiles.
@Composable
private fun SendFileView(f: SendFile) {
    when (f.kind) {
        "image" -> {
            // Coil 2.x doesn't load data: URIs itself, so decode them to bytes (a
            // ByteBuffer the SVG/bitmap decoders both accept); pass remote URLs
            // straight through. A bad/empty src degrades to a chip.
            val model = remember(f.src) {
                when {
                    f.src.startsWith("data:", ignoreCase = true) -> dataUriToBytes(f.src)?.let { ByteBuffer.wrap(it) }
                    f.src.startsWith("http", ignoreCase = true) -> f.src
                    else -> null
                }
            }
            if (model == null) { FileChip(f.name); return }
            Column {
                // A DEFINITE height, not heightIn(max): AsyncImage's painter starts
                // with an unknown intrinsic size, so a max-only height constraint
                // measures the box at 0 (invisible) — the image never appears. A
                // fixed-height box (like the HTML preview below) always has room; the
                // SVG/PNG is Fit-scaled into it, centred on the white backdrop.
                Box(
                    Modifier.fillMaxWidth().height(260.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(Color.White)
                        .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.4f), RoundedCornerShape(6.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    AsyncImage(
                        model = model,
                        contentDescription = f.name,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxSize().padding(6.dp),
                    )
                }
                Text(f.name, fontSize = scaledSp(10f), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
            }
        }
        "html" -> Column {
            HtmlPreview(f.html, Modifier.fillMaxWidth().height(360.dp)
                .clip(RoundedCornerShape(6.dp))
                .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.4f), RoundedCornerShape(6.dp)))
            Text(f.name, fontSize = scaledSp(10f), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
        }
        else -> FileChip(f.name)
    }
}

@Composable
private fun FileChip(name: String) {
    Text("📎 $name", fontSize = scaledSp(12f), color = MaterialTheme.colorScheme.onSurfaceVariant)
}

// A SendUserFile HTML page in a FULLY sandboxed WebView (web parity: the
// `sandbox` iframe): JavaScript OFF, no file/DOM storage, navigation blocked, a
// null base URL so it has no origin. Renders static HTML/CSS/inline-SVG only.
@Composable
private fun HtmlPreview(html: String, modifier: Modifier) {
    AndroidView(
        factory = { ctx ->
            WebView(ctx).apply {
                setBackgroundColor(AndroidColor.WHITE)
                with(settings) {
                    javaScriptEnabled = false
                    domStorageEnabled = false
                    allowFileAccess = false
                    allowContentAccess = false
                    loadWithOverviewMode = true
                    useWideViewPort = true
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView?, request: android.webkit.WebResourceRequest?,
                    ): Boolean = true // block all navigation out of the preview
                }
            }
        },
        update = { it.loadDataWithBaseURL(null, html, "text/html", "utf-8", null) },
        modifier = modifier,
    )
}

// Decode a data: URI to raw bytes. Handles ;base64 payloads and percent-encoded
// ones (the `+` guard keeps a literal plus in an SVG from decoding to a space).
private fun dataUriToBytes(src: String): ByteArray? = try {
    val comma = src.indexOf(',')
    if (comma < 0) null else {
        val meta = src.substring(0, comma)
        val payload = src.substring(comma + 1)
        if (meta.contains(";base64", ignoreCase = true)) Base64.decode(payload, Base64.DEFAULT)
        else java.net.URLDecoder.decode(payload.replace("+", "%2B"), "UTF-8").toByteArray(Charsets.UTF_8)
    }
} catch (e: Exception) { null }
