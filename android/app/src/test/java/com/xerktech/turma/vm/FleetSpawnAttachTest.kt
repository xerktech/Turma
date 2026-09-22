package com.xerktech.turma.vm

import android.net.Uri
import com.xerktech.turma.core.AttachStatus
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream

/**
 * The full NEW-SESSION attach flow (XERK-234 spawn attach), end to end through
 * the real Retrofit stack: pick a file → host-scoped stage → the SPAWN request
 * must carry its `uploadIds`. `SpawnRequestTest` pins the JSON shape in
 * isolation; this proves the ViewModel actually THREADS a staged id from the
 * picker into the spawn body — the leg a "the UI exists but nothing attaches"
 * bug lives in.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FleetSpawnAttachTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    private val host = "nas01"

    private fun fleetWithUpload() =
        """{"now":1,"agents":[{"key":"$host","device":"$host","online":true,""" +
            """"terminalOnline":true,"uploadMaxBytes":5000,""" +
            """"repos":[{"name":"Turma","lastActivity":"2026-08-12T00:00:00Z"}],"sessions":[]}]}"""

    @Test
    fun `a spawn with an attached file threads its uploadId onto the spawn body`() {
        hub.seedFleet(fleetWithUpload())
        hub.json("/api/agents/$host/uploads",
            """{"ok":true,"uploadId":"u1","name":"diagram.png","size":5}""")
        hub.json("/api/agents/$host/sessions", """{"ok":true,"cmdId":"c1"}""")

        val vm = FleetViewModel(hub.app)
        val uri = Uri.parse("content://test/diagram.png")
        shadowOf(hub.app.contentResolver)
            .registerInputStream(uri, ByteArrayInputStream("hello".toByteArray()))

        // Pick the file — the app stages it host-scoped.
        vm.attachSpawn(host, "Turma", listOf(uri))
        // The chip reaches READY once the upload round-trips.
        hub.awaitValue {
            vm.spawnAtt.value["$host::Turma"]?.firstOrNull { it.status == AttachStatus.READY }
        }

        // It went to the HOST-scoped staging route (no session id yet).
        val up = hub.findRequest("/api/agents/$host/uploads")
        assertTrue("upload hit ${up.path}", up.path!!.startsWith("/api/agents/$host/uploads?name="))

        // The spawn must carry the staged id.
        vm.spawn(host, "Turma", prompt = "look at this")
        val body = hub.findRequest("/api/agents/$host/sessions").body.readUtf8()
        assertTrue("spawn body did NOT carry the uploadId: $body",
            body.contains("\"uploadIds\":[\"u1\"]"))
    }

    @Test
    fun `a bare spawn with no attachment carries no uploadIds`() {
        hub.seedFleet(fleetWithUpload())
        hub.json("/api/agents/$host/sessions", """{"ok":true,"cmdId":"c1"}""")
        val vm = FleetViewModel(hub.app)
        vm.spawn(host, "Turma")
        val body = hub.findRequest("/api/agents/$host/sessions").body.readUtf8()
        assertTrue("bare spawn should omit uploadIds: $body", !body.contains("uploadIds"))
    }
}
