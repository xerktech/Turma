package com.xerktech.turma.push

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `Notifications.channelFor` maps a hub alert's `tags` to a notification
 * channel. It is pure string logic (no Android API), so a plain JVM test pins
 * it — before XERK-310 the whole function had no test at all, so the new
 * money_with_wings -> CH_SPEND row and its ORDER ahead of the moneybag -> CH_HOST
 * row were compiled by CI and asserted by nothing; a reorder would ship green.
 *
 * The order matters: the hub's runaway-spend alert carries `money_with_wings`,
 * while an older hub's HOST-level cost alert carries `moneybag`. Both contain no
 * overlapping token, but the spend row is checked FIRST deliberately, and a
 * future tag that matched both rows must land on CH_SPEND.
 */
class NotificationsChannelTest {

    @Test fun `runaway spend routes to its own channel`() {
        assertEquals(Notifications.CH_SPEND, Notifications.channelFor("money_with_wings"))
    }

    @Test fun `the spend row is checked before the host moneybag row`() {
        // A message tagged with BOTH must resolve to CH_SPEND, proving spend is
        // matched ahead of the host-status row — the exact ordering a reorder
        // would silently break.
        assertEquals(Notifications.CH_SPEND, Notifications.channelFor("money_with_wings,moneybag"))
    }

    @Test fun `the existing rows still route as before`() {
        assertEquals(Notifications.CH_QUESTION, Notifications.channelFor("question"))
        assertEquals(Notifications.CH_TURN, Notifications.channelFor("mag"))
        assertEquals(Notifications.CH_TURN, Notifications.channelFor("checkered_flag"))
        assertEquals(Notifications.CH_PR, Notifications.channelFor("rocket"))
        assertEquals(Notifications.CH_HOST, Notifications.channelFor("key"))
        assertEquals(Notifications.CH_HOST, Notifications.channelFor("moneybag"))
        assertEquals(Notifications.CH_HOST, Notifications.channelFor("rotating_light"))
        assertEquals(Notifications.CH_HOST, Notifications.channelFor("green_circle"))
        // A host-level cost alert (moneybag) still lands on CH_HOST, unchanged —
        // only the per-session money_with_wings moved to CH_SPEND.
        assertEquals(Notifications.CH_ALERTS, Notifications.channelFor("unknown_tag"))
        assertEquals(Notifications.CH_ALERTS, Notifications.channelFor(""))
    }
}
