package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.model.TurmaJson
import com.xerktech.turma.vm.BriefViewModel
import com.xerktech.turma.vm.CalendarViewModel
import com.xerktech.turma.vm.MeetingsViewModel
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Turma-created calendar events on Android (XERK-2972) over the real HTTP stack:
 * one block for an event of two orgs, Edit / Delete only on an editable Turma
 * event (never on Outlook's), the create body the editor sends, a 409 shown in
 * the hub's words with the editor reloaded, and delete.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CalendarTurmaEventsTest {

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
    private fun iso(h: Int) = today.atTime(h, 0).atZone(zone).toOffsetDateTime().toString()

    private fun host(key: String, site: String) = """{ "key": "$key", "device": "$key", "online": true, "lastSeen": 1, "org": "$site",
        "jira": { "available": true, "siteKey": "$site", "site": "$site", "tickets": [] } }"""

    private fun turmaEvent(subject: String = "Joint planning", version: Int = 3, editable: Boolean = true, extra: String = "") = """
        { "source": "turma", "host": "", "id": "turma:0123456789abcdef", "orgs": ["$a", "$b"], "org": "$a",
          "subject": "$subject", "start": "${iso(10)}", "end": "${iso(11)}", "startMs": ${t(10)}, "endMs": ${t(11)},
          "timeZone": "${zone.id}", "busy": "busy", "editable": $editable, "version": $version, "meeting": false $extra }"""

    private val outlook = """
        { "host": "h1", "org": "$a", "matchOrg": "$a", "id": "E1", "source": "outlook", "subject": "Outlook standup",
          "startMs": ${t(13)}, "endMs": ${t(14)}, "busy": "busy", "myResponse": "accepted" }"""

    private fun seed(vararg events: String) {
        hub.seedFleet("""{ "now": 1, "agents": [ ${host("h1", a)}, ${host("h2", b)} ] }""")
        hub.route("/api/calendar") { req ->
            val url = req.requestUrl!!
            okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{ "from": ${url.queryParameter("from")}, "until": ${url.queryParameter("until")},
                  "hosts": [ { "host": "h1", "device": "h1", "online": true, "syncedAt": 1, "ranges": [[0, 9000000000000000]] } ],
                  "events": [ ${events.joinToString(",")} ] }""",
            )
        }
        hub.json("/api/holidays", "[]")
    }

    private fun show(): CalendarViewModel {
        val cvm = main.track(CalendarViewModel(hub.app))
        val vm = main.track(BriefViewModel(hub.app))
        val mvm = main.track(MeetingsViewModel(hub.app))
        compose.setContent { BriefScreen(vm = vm, meetingsVm = mvm, calendarVm = cvm, wide = false) }
        return cvm
    }

    private fun event(text: String) = hasTestTag("cal-ev") and hasContentDescription(text, substring = true)

    private fun awaitEvent(text: String) =
        compose.waitUntil(10_000) { compose.onAllNodes(event(text)).fetchSemanticsNodes().isNotEmpty() }

    private fun body(path: String): JsonObject = TurmaJson.decodeFromString(hub.findRequest(path).body.readUtf8())

    @Test fun `an event of two orgs is one block naming both, and only it offers Edit and Delete`() {
        seed(turmaEvent(), outlook)
        show()
        awaitEvent("Joint planning")
        assertEquals(1, compose.onAllNodes(event("Joint planning")).fetchSemanticsNodes().size)
        compose.onNode(event("Joint planning") and hasContentDescription("a, b", substring = true)).assertExists()
        compose.onNodeWithTag("cal-multi-org", useUnmergedTree = true).assertExists()

        compose.onNode(event("Joint planning")).performScrollTo().performClick()
        compose.onNodeWithText("Made in Turma — not on Outlook").assertExists()
        compose.onNodeWithText("a, b").assertExists()
        compose.onNodeWithTag("cal-edit").assertExists()
        compose.onNodeWithTag("cal-delete").assertExists()
        compose.onNodeWithTag("cal-detail-close").performClick()

        // An Outlook event stays read-only.
        compose.onNode(event("Outlook standup")).performScrollTo().performClick()
        compose.onNodeWithTag("cal-detail").assertExists()
        compose.onNodeWithTag("cal-edit").assertDoesNotExist()
        compose.onNodeWithTag("cal-delete").assertDoesNotExist()
    }

    @Test fun `a Turma event the caller may not edit, or from an older hub, offers no Edit`() {
        seed(turmaEvent(editable = false))
        show()
        awaitEvent("Joint planning")
        compose.onNode(event("Joint planning")).performScrollTo().performClick()
        compose.onNodeWithTag("cal-detail").assertExists()
        compose.onNodeWithTag("cal-edit").assertDoesNotExist()
    }

    @Test fun `New event creates the event for the picked orgs`() {
        seed(outlook)
        hub.json("/api/calendar/events", """{ "ok": true, "event": ${turmaEvent("Kickoff")} }""")
        show()
        awaitEvent("Outlook standup")
        compose.onNodeWithTag("cal-new-event").performClick()
        compose.onNodeWithTag("cal-editor").assertExists()
        compose.onNodeWithText("Does not repeat").assertExists()
        compose.onNodeWithTag("cal-ed-title").performTextInput("Kickoff")
        compose.onNodeWithTag("cal-ed-required").performTextInput("Ann <ann@x.com>")
        // Two orgs and no header pick: none is chosen for the operator, so Save says so.
        compose.onNodeWithTag("cal-editor-save").performClick()
        compose.onNodeWithText("Pick at least one org.").assertExists()
        compose.onNodeWithTag("cal-ed-org-$b").performScrollTo().performClick()
        compose.onNodeWithTag("cal-ed-org-$a").performScrollTo().performClick()
        compose.onNodeWithTag("cal-editor-save").performClick()
        val sent = body("/api/calendar/events")
        assertEquals(listOf(a, b), sent["orgs"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("Kickoff", sent["subject"]!!.jsonPrimitive.content)
        assertEquals(zone.id, sent["timeZone"]!!.jsonPrimitive.content)
        assertEquals("ann@x.com", (sent["attendees"]!!.jsonArray[0] as JsonObject)["email"]!!.jsonPrimitive.content)
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("cal-editor")).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun `a stale edit shows the hub's words and reloads the editor from the current event`() {
        seed(turmaEvent())
        hub.json(
            "/api/calendar/events/turma:0123456789abcdef",
            """{ "error": "this event was changed since you opened it; reload it and edit again",
                 "event": ${turmaEvent("Renamed elsewhere", version = 4)} }""",
            code = 409,
        )
        show()
        awaitEvent("Joint planning")
        compose.onNode(event("Joint planning")).performScrollTo().performClick()
        compose.onNodeWithTag("cal-edit").performScrollTo().performClick()
        compose.onNodeWithTag("cal-ed-title").performTextReplacement("Mine")
        compose.onNodeWithTag("cal-editor-save").performClick()
        val sent = hub.findRequest("/api/calendar/events/turma:0123456789abcdef")
        assertEquals("PATCH", sent.method)
        assertEquals("3", TurmaJson.decodeFromString<JsonObject>(sent.body.readUtf8())["version"]!!.jsonPrimitive.content)
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("cal-editor-err")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("changed since you opened it", substring = true).assertExists()
        compose.onNodeWithText("Renamed elsewhere").assertExists()
    }

    @Test fun `Delete asks first, then deletes the event`() {
        seed(turmaEvent())
        hub.json("/api/calendar/events/turma:0123456789abcdef", """{ "ok": true }""")
        show()
        awaitEvent("Joint planning")
        compose.onNode(event("Joint planning")).performScrollTo().performClick()
        compose.onNodeWithTag("cal-delete").performScrollTo().performClick()
        compose.onNodeWithTag("cal-delete-confirm").performClick()
        val sent = hub.findRequest("/api/calendar/events/turma:0123456789abcdef")
        assertEquals("DELETE", sent.method)
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("cal-detail")).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun `XERK-2972 QA a withheld private event offers no Edit or Delete, even when the hub says editable`() {
        seed(turmaEvent("Private event", extra = ""","private": true"""))
        show()
        awaitEvent("Private event")
        compose.onNode(event("Private event")).performScrollTo().performClick()
        compose.onNodeWithTag("cal-detail").assertExists()
        compose.onNodeWithTag("cal-edit").assertDoesNotExist()
        compose.onNodeWithTag("cal-delete").assertDoesNotExist()
    }

    @Test fun `XERK-2972 QA the draft lives in the view model and a changed one asks before it is discarded`() {
        seed(outlook)
        val cvm = show()
        awaitEvent("Outlook standup")
        compose.onNodeWithTag("cal-new-event").performClick()
        compose.onNodeWithTag("cal-ed-title").performTextInput("Draft kept")
        // Held by the view model, so a rotation or a tab switch keeps it.
        assertEquals("Draft kept", cvm.editor.value?.draft?.subject)
        compose.onNodeWithTag("cal-editor-close").performClick()
        compose.onNodeWithTag("cal-editor-discard").assertExists()
        compose.onNodeWithText("Keep editing").performClick()
        compose.onNodeWithTag("cal-editor").assertExists()
        compose.onNodeWithTag("cal-editor-close").performClick()
        compose.onNodeWithTag("cal-editor-discard").performClick()
        compose.onNodeWithTag("cal-editor").assertDoesNotExist()
        assertEquals(null, cvm.editor.value)
    }
}
