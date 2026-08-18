package com.xerktech.turma.vm

import com.xerktech.turma.core.ModelSource
import com.xerktech.turma.model.TurmaJson
import com.xerktech.turma.vm.FleetViewModel.Companion.spawnRequest
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The exact body a "New session" spawn puts on the wire.
 *
 * Pinned as JSON rather than as field reads because the hub validates the BODY:
 * `turma/server.js` rejects an unknown-typed field and 409s a `modelSource:
 * "local"` at a host with no local model, and an accidentally-present field
 * would change what an ordinary spawn queues on every host in the fleet.
 */
class SpawnRequestTest {

    private fun json(r: com.xerktech.turma.net.SpawnRequest) = TurmaJson.encodeToString(r)

    @Test fun `a bare spawn is exactly what it always was`() {
        // No modelSource key at all — the pre-XERK-246 body, byte for byte.
        assertEquals("""{"repo":"Turma"}""", json(spawnRequest("Turma")))
    }

    @Test fun `blank optionals are omitted, not sent empty`() {
        assertEquals(
            """{"repo":"Turma"}""",
            json(spawnRequest("Turma", prompt = "", label = "", baseRef = "", model = "",
                permissionMode = "", modelSource = "")),
        )
    }

    @Test fun `a subscription spawn sends no model source`() {
        // "subscription" is what a spawn already meant; sending it would change
        // the body every existing host receives for no behavioural gain.
        assertEquals(
            """{"repo":"Turma","model":"opus","permissionMode":"auto"}""",
            json(spawnRequest("Turma", model = "opus", permissionMode = "auto",
                modelSource = ModelSource.SUBSCRIPTION)),
        )
    }

    @Test fun `a local spawn carries the source AND the Claude alias`() {
        // The alias goes too, matching the web composer (sessions.html). The
        // agent drops `--model` for a local session itself, and this is the
        // model that session returns to if it is later switched back — so
        // dropping it here would give an Android-spawned session a different
        // model from a web-spawned one.
        assertEquals(
            """{"repo":"Turma","model":"sonnet","permissionMode":"auto","modelSource":"local"}""",
            json(spawnRequest("Turma", model = "sonnet", permissionMode = "auto",
                modelSource = ModelSource.LOCAL)),
        )
    }

    /**
     * The switch's own wire contract — the ONE thing between the chip and a
     * hub route, and the only part of it not covered by anything else. Renaming
     * either the field or the path leaves the whole suite green while the
     * feature is dead on the wire (a 400 "modelSource must be subscription or
     * local", or a 404). The sibling `SpawnRequest.modelSource` is pinned above
     * for the same reason; this closes the pair.
     */
    @Test fun `the model-source switch posts the field and path the hub expects`() {
        assertEquals(
            """{"modelSource":"local"}""",
            TurmaJson.encodeToString(com.xerktech.turma.net.ModelSourceRequest("local")),
        )
        // By name, not signature: a `suspend fun` carries a trailing
        // Continuation parameter that getMethod(...) won't match.
        val m = com.xerktech.turma.net.HubApi::class.java.methods
            .single { it.name == "setModelSource" }
        assertEquals("api/agents/{host}/sessions/{id}/model-source",
            m.getAnnotation(retrofit2.http.POST::class.java)!!.value)
    }

    @Test fun `the full composer body keeps its field order and content`() {
        assertEquals(
            """{"repo":"Turma","prompt":"do the thing","label":"lbl","baseRef":"main",""" +
                """"model":"haiku","permissionMode":"plan","modelSource":"local"}""",
            json(spawnRequest("Turma", prompt = "do the thing", label = "lbl", baseRef = "main",
                model = "haiku", permissionMode = "plan", modelSource = ModelSource.LOCAL)),
        )
    }
}
