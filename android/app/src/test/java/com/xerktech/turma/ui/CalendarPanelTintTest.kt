package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import com.xerktech.turma.core.orgColorMap
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.ui.theme.AccentDark
import com.xerktech.turma.ui.theme.AccentLight
import com.xerktech.turma.ui.theme.ChartSeries
import com.xerktech.turma.ui.theme.ChartSeriesLight
import com.xerktech.turma.ui.theme.Critical
import com.xerktech.turma.ui.theme.CriticalTextDark
import com.xerktech.turma.ui.theme.Good
import com.xerktech.turma.ui.theme.GoodTextDark
import com.xerktech.turma.ui.theme.Ink2Dark
import com.xerktech.turma.ui.theme.Ink2Light
import com.xerktech.turma.ui.theme.InkDark
import com.xerktech.turma.ui.theme.InkLight
import com.xerktech.turma.ui.theme.SurfaceDark
import com.xerktech.turma.ui.theme.SurfaceLight
import com.xerktech.turma.ui.theme.TurmaTheme
import com.xerktech.turma.ui.theme.Warning
import com.xerktech.turma.ui.theme.WarningTextLight
import com.xerktech.turma.vm.BriefViewModel
import com.xerktech.turma.vm.CalendarViewModel
import com.xerktech.turma.vm.MeetingsViewModel
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The calendar detail panel wears its event's org tint (XERK-2939, web `.cal-detail`):
 * the helpers' colours and contrast, and — in pixels — that the panel actually draws it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)   // real drawing: the panel's background is read in pixels
class CalendarPanelTintTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private fun rgb(c: Color) = c.toArgb() and 0xFFFFFF
    private fun hex(v: Int) = "#%06X".format(v)
    private fun contrast(a: Color, b: Color): Float {
        val (hi, lo) = listOf(a.luminance(), b.luminance()).sortedDescending()
        return (hi + 0.05f) / (lo + 0.05f)
    }

    @Test fun `an org event wears exactly the session card's tint, no org is the plain surface`() {
        assertEquals(SurfaceLight, calPanelTint(null, SurfaceLight))
        // The operator's rule: the panel matches the session card's colour exactly (TurmaCard).
        for (slot in ChartSeriesLight) assertEquals(hex(rgb(orgCardColor(slot, SurfaceLight))), hex(rgb(calPanelTint(slot, SurfaceLight))))
        assertEquals(hex(rgb(androidx.compose.ui.graphics.lerp(SurfaceLight, Color(0xFFE87BA4), 0.12f))),
            hex(rgb(calPanelTint(Color(0xFFE87BA4), SurfaceLight))))
        assertEquals(1f, calPanelTint(Color(0xFFE87BA4), SurfaceLight).alpha)
        // Panel text is half the token, half ink (web `color-mix(… 50%, var(--ink))`): #d03b3b → (110, 35, 35).
        assertEquals(hex(0x6E2323), hex(rgb(calOnTint(Critical, InkLight))))
    }

    @Test fun `every text colour the panel shows stays at least 4_5 to 1 on every org tint, both themes`() {
        // The panel's tokens as CalendarDetail reads them: muted, primary (links/buttons), and the
        // response/state text colours (TurmaColors workingText/criticalText/waitingText).
        val light = Triple(SurfaceLight, InkLight, listOf(Ink2Light, AccentLight, Good, Critical, WarningTextLight))
        val dark = Triple(SurfaceDark, InkDark, listOf(Ink2Dark, AccentDark, GoodTextDark, CriticalTextDark, Warning))
        for ((theme, series) in listOf(light to ChartSeriesLight, dark to ChartSeries)) {
            val (surface, ink, tokens) = theme
            for (slot in series) for (t in tokens) {
                val c = contrast(calOnTint(t, ink), calPanelTint(slot, surface))
                assertTrue("${hex(rgb(t))} on ${hex(rgb(slot))} tint: $c", c >= 4.5f)
            }
        }
    }

    @Test fun `the open panel draws its org's tint`() {
        val site = "o.atlassian.net"
        val zone = ZoneId.systemDefault()
        val today = LocalDate.now(zone)
        fun t(h: Int) = today.atTime(h, 0).atZone(zone).toInstant().toEpochMilli()
        hub.seedFleet("""{ "now": 1, "agents": [ { "key": "h1", "device": "Desk", "online": true, "lastSeen": 1,
            "jira": { "available": true, "siteKey": "$site", "site": "$site", "tickets": [] } } ],
            "meetingProposals": { "$site": [ { "meetingId": "m1", "status": "failed", "error": "boom", "title": "Tinted",
              "startedAt": ${t(10)}, "calendarEventId": "E1", "calendarBy": "auto" } ] } }""")
        hub.json("/api/calendar", """{ "from": 0, "until": 9000000000000000,
            "hosts": [ { "host": "h1", "device": "Desk", "online": true, "syncedAt": 1, "ranges": [[0, 9000000000000000]] } ],
            "events": [ { "host": "h1", "org": "$site", "matchOrg": "$site", "id": "E1", "source": "outlook",
              "subject": "Tinted", "startMs": ${t(10)}, "endMs": ${t(11)}, "busy": "busy", "myResponse": "accepted",
              "meetings": [ { "site": "$site", "meetingId": "m1", "title": "Tinted" } ] } ] }""")
        hub.json("/api/holidays", "[]")
        val cvm = main.track(CalendarViewModel(hub.app))
        val vm = main.track(BriefViewModel(hub.app))
        val mvm = main.track(MeetingsViewModel(hub.app))
        compose.setContent { TurmaTheme(darkTheme = false) { BriefScreen(vm = vm, meetingsVm = mvm, calendarVm = cvm) } }
        val ev = hasTestTag("cal-ev") and hasContentDescription("Tinted", substring = true)
        compose.waitUntil(10_000) { compose.onAllNodes(ev).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(ev).performClick()
        compose.waitForIdle()
        val box = compose.onNodeWithTag("cal-detail").fetchSemanticsNode().boundsInRoot
        val want = rgb(calPanelTint(ChartSeriesLight[orgColorMap(listOf(site))[site]!! % ChartSeriesLight.size], SurfaceLight))
        assertNotEquals(hex(rgb(SurfaceLight)), hex(want))
        // A corner well clear of any text: the panel's own background.
        assertEquals(hex(want), hex(pixel(box.right.toInt() - 3, box.bottom.toInt() - 3)))
        // The capture's own failed-run line (MeetingPart) is the critical text pulled toward ink,
        // never the raw fill: that read 3.85:1 on this tint (QA).
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasText("Could not propose", substring = true)).fetchSemanticsNodes().isNotEmpty()
        }
        val node = compose.onNode(hasText("Could not propose", substring = true)).fetchSemanticsNode()
        val out = mutableListOf<TextLayoutResult>()
        node.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(out)
        assertEquals(hex(rgb(calOnTint(Critical, InkLight))), hex(rgb(out.single().layoutInput.style.color)))
    }

    /** The drawn pixel at (x, y) root px — Robolectric never delivers captureToImage's frame. */
    private fun pixel(x: Int, y: Int): Int {
        compose.waitForIdle()
        val view = compose.activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0)
        var px = 0
        compose.runOnUiThread {
            val bmp = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bmp))
            px = bmp.getPixel(x, y)
        }
        return px and 0xFFFFFF
    }
}
