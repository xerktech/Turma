package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.vm.BriefViewModel
import com.xerktech.turma.vm.CalendarViewModel
import com.xerktech.turma.vm.MeetingsViewModel
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A Turma-made event wears the Turma blue → purple gradient on Android as on the web
 * (XERK-3020, web `.cal-ev.turma`), even while not yet responded to, and its left bar
 * is each of its orgs' colours stacked; an Outlook event keeps its org tint.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)   // real drawing: the fill is read in pixels
class CalendarTurmaGradientTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val a = "a.atlassian.net"
    private val b = "b.atlassian.net"
    private val zone = ZoneId.systemDefault()
    private val today = LocalDate.now(zone)
    private fun t(h: Int) = today.atTime(h, 0).atZone(zone).toInstant().toEpochMilli()

    private fun host(key: String, site: String) = """{ "key": "$key", "device": "$key", "online": true, "lastSeen": 1, "org": "$site",
        "jira": { "available": true, "siteKey": "$site", "site": "$site", "tickets": [] } }"""

    // notResponded: an Outlook event in this state is hatched; a Turma one keeps the gradient.
    private val turma = """
        { "source": "turma", "host": "", "id": "turma:0123456789abcdef", "orgs": ["$a", "$b"], "org": "$a",
          "subject": "Joint planning", "startMs": ${t(9)}, "endMs": ${t(11)}, "timeZone": "${zone.id}",
          "busy": "busy", "myResponse": "notResponded", "editable": true, "version": 1, "meeting": false }"""

    // Canceled, its Outlook copy failed: dimmed like the web, the "!" on a white pill.
    private val canceled = """
        { "source": "turma", "host": "", "id": "turma:fedcba9876543210", "orgs": ["$a"], "org": "$a",
          "subject": "Dropped sync", "startMs": ${t(15)}, "endMs": ${t(17)}, "timeZone": "${zone.id}",
          "busy": "busy", "canceled": true, "editable": true, "version": 1, "meeting": false,
          "outlook": { "$a": { "state": "failed", "error": "Outlook is not open", "at": 1 } } }"""

    private val outlook = """
        { "host": "h1", "org": "$a", "matchOrg": "$a", "id": "E1", "source": "outlook", "subject": "Outlook standup",
          "startMs": ${t(12)}, "endMs": ${t(14)}, "busy": "busy", "myResponse": "accepted" }"""

    private fun show() {
        hub.seedFleet("""{ "now": 1, "agents": [ ${host("h1", a)}, ${host("h2", b)} ] }""")
        hub.route("/api/calendar") { req ->
            val url = req.requestUrl!!
            okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{ "from": ${url.queryParameter("from")}, "until": ${url.queryParameter("until")},
                  "hosts": [ { "host": "h1", "device": "h1", "online": true, "syncedAt": 1, "ranges": [[0, 9000000000000000]] } ],
                  "events": [ $turma, $canceled, $outlook ] }""",
            )
        }
        hub.json("/api/holidays", "[]")
        val cvm = main.track(CalendarViewModel(hub.app))
        val vm = main.track(BriefViewModel(hub.app))
        val mvm = main.track(MeetingsViewModel(hub.app))
        compose.setContent { BriefScreen(vm = vm, meetingsVm = mvm, calendarVm = cvm, wide = false) }
    }

    private fun event(text: String) = hasTestTag("cal-ev") and hasContentDescription(text, substring = true)

    /** The drawn pixel at (x, y) root px, drawn by hand: Robolectric never delivers `captureToImage`'s frame. */
    private fun pixel(x: Float, y: Float): Int {
        compose.waitForIdle()
        val view = compose.activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0)
        var px = 0
        compose.runOnUiThread {
            val bmp = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bmp))
            px = bmp.getPixel(x.toInt(), y.toInt())
        }
        return px and 0xFFFFFF
    }

    private fun r(c: Int) = (c shr 16) and 0xFF
    private fun g(c: Int) = (c shr 8) and 0xFF
    private fun bl(c: Int) = c and 0xFF
    private fun hex(c: Int) = "#%06x".format(c)

    @Test fun `a Turma event is painted with the Turma gradient and its orgs stacked in the bar`() {
        show()
        compose.waitUntil(10_000) { compose.onAllNodes(event("Joint planning")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(event("Joint planning")).performScrollTo()
        val box = compose.onNode(event("Joint planning")).fetchSemanticsNode().boundsInRoot
        val px = with(compose.density) { 1.dp.toPx() }
        val bar = box.left + 2 * px                      // inside the 4dp org bar
        val inner = box.left + 8 * px                    // just right of it

        // Top-left reads the gradient's blue end, bottom-right its purple end: saturated, blue-led,
        // never the light org wash or the surface an unanswered Outlook event is hatched on.
        val top = pixel(inner, box.top + 2 * px)
        val bottom = pixel(box.right - 3 * px, box.bottom - 3 * px)
        for (c in listOf(top, bottom)) {
            assertTrue("gradient pixel ${hex(c)}", bl(c) > 180 && bl(c) - g(c) > 50 && r(c) < 150)
        }
        assertTrue("blue end ${hex(top)} → purple end ${hex(bottom)}", r(bottom) > r(top) + 20 && g(bottom) < g(top) - 20)

        // The title is drawn white on it: somewhere in the title line a near-white glyph pixel.
        val white = (0 until 40).any { dx -> (0 until 10).any { dy ->
            val c = pixel(inner + dx * 2 * px, box.top + (3 + dy) * px); r(c) > 225 && g(c) > 225 && bl(c) > 225 } }
        assertTrue("white title text", white)

        // Two orgs: the bar's top half is one org's colour and its bottom half the other's.
        val barTop = pixel(bar, box.top + box.height * 0.25f)
        val barBottom = pixel(bar, box.top + box.height * 0.75f)
        assertNotEquals("stacked org bar", hex(barTop), hex(barBottom))

        // A canceled Turma event is dimmed (alpha 0.6): its blue end washes toward the page.
        compose.onNode(event("Dropped sync")).performScrollTo()
        val cb = compose.onNode(event("Dropped sync")).fetchSemanticsNode().boundsInRoot
        val dim = pixel(cb.left + 8 * px, cb.bottom - 3 * px)
        val full = pixel(box.left + 8 * px, box.bottom - 3 * px)
        assertTrue("dimmed ${hex(dim)} vs ${hex(full)}", r(dim) > r(full) + 40 && g(dim) > g(full) + 30)

        // Its failed mark sits on a white pill, not red straight on the gradient.
        val olk = compose.onNodeWithTag("cal-olk-failed", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val pill = pixel(olk.left + 1.5f * px, (olk.top + olk.bottom) / 2)
        assertTrue("pill ${hex(pill)}", r(pill) > 225 && g(pill) > 225 && bl(pill) > 225)

        // An Outlook event keeps its light org tint.
        compose.onNode(event("Outlook standup")).performScrollTo()
        val ob = compose.onNode(event("Outlook standup")).fetchSemanticsNode().boundsInRoot
        val o = pixel(ob.left + 8 * px, ob.top + 2 * px)
        assertTrue("Outlook tint ${hex(o)}", r(o) > 150 && g(o) > 150)
    }
}
