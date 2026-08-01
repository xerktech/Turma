package com.xerktech.turma.net

import com.xerktech.turma.model.TurmaJson
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The device registration body must carry `features` so the hub knows this
 * build handles notification retractions (XERK-154). TurmaJson runs with
 * encodeDefaults=false, so a defaulted `features` would be silently dropped and
 * the hub would withhold every dismiss — regression guard for exactly that.
 */
class DeviceRequestTest {

    @Test fun `registration body includes the dismiss capability`() {
        val json = TurmaJson.encodeToString(DeviceRequest(token = "tok", features = listOf("dismiss")))
        assertTrue("features must be serialized: $json", json.contains("\"features\""))
        assertTrue("dismiss capability must be present: $json", json.contains("dismiss"))
    }
}
