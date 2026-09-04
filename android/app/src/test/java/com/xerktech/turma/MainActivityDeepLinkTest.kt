package com.xerktech.turma

import android.content.Intent
import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * A notification tap that opens the app carries the target session as intent
 * extras (`Notifications.kt`), and `MainActivity` turns that into a one-shot
 * deep-link navigation to the session's chat. The launching intent is STICKY —
 * `getIntent()` returns it for the life of the task — so consuming the deep link
 * must not leave it armed to fire again on the next Activity recreation (a
 * rotation, a fold/unfold, a night-mode/font-size change, a process-death
 * restore). Re-firing yanks the user off whatever screen they had navigated to,
 * e.g. straight back into the chat every time they reach the Dashboard
 * (XERK-603).
 *
 * The guard is "don't re-arm the deep link we already navigated for", keyed by
 * the target's identity ([MainActivity.DeepLink.key]) persisted in
 * savedInstanceState — NOT a bare `savedInstanceState == null`, so a genuinely
 * NEW notification arriving through a cold `onCreate` after the OS killed the
 * process (non-null savedInstanceState, fresh intent) still opens.
 *
 * `deepLink` is read straight after `onCreate` (via `create(...)`, before the
 * composition is resumed), because once TurmaApp's `LaunchedEffect` runs it
 * consumes the state and nulls it — so the armed-vs-not distinction is only
 * visible at that point.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MainActivityDeepLinkTest {

    private fun notifIntent(host: String = "nas01", session: String = "sess-1") =
        Intent(RuntimeEnvironment.getApplication(), MainActivity::class.java).apply {
            putExtra(MainActivity.EXTRA_HOST, host)
            putExtra(MainActivity.EXTRA_SESSION, session)
        }

    private fun consumedBundle(host: String = "nas01", session: String = "sess-1") = Bundle().apply {
        putString("deepLinkConsumed", MainActivity.DeepLink(host, session, null).key())
    }

    /** A fresh launch from a notification (no saved state) arms the deep link. */
    @Test fun freshLaunchArmsTheDeepLink() {
        val controller = Robolectric.buildActivity(MainActivity::class.java, notifIntent()).create()
        val dl = controller.get().deepLink
        assertNotNull("a fresh notification launch must arm the deep link", dl)
        assertEquals("nas01", dl?.host)
        assertEquals("sess-1", dl?.sessionId)
    }

    /**
     * The core regression: an Activity RECREATION whose restored state already
     * names the same sticky intent's target must NOT re-arm it. This is the
     * config-change / restore-from-recents path that was re-firing the chat.
     */
    @Test fun recreationDoesNotRefireTheStickyDeepLink() {
        val controller = Robolectric.buildActivity(MainActivity::class.java, notifIntent())
            .create(consumedBundle())
        assertNull(
            "a recreation must not re-fire the already-consumed sticky deep link",
            controller.get().deepLink,
        )
    }

    /**
     * The edge QA flagged: a genuinely NEW notification (different session)
     * delivered through a cold `onCreate` after the process was killed — non-null
     * savedInstanceState carrying the OLD consumed key — must still open, because
     * the new target's key differs from the consumed one.
     */
    @Test fun newNotificationAfterProcessDeathStillArms() {
        val controller = Robolectric.buildActivity(
            MainActivity::class.java, notifIntent(session = "sess-2"),
        ).create(consumedBundle(session = "sess-1"))
        assertEquals(
            "a new notification target must re-arm even across a restore",
            "sess-2", controller.get().deepLink?.sessionId,
        )
    }

    /**
     * The full persist→restore round trip through the real lifecycle: what
     * `onSaveInstanceState` writes must be what a recreation reads back, so
     * removing that write silently reintroduces the re-fire.
     */
    @Test fun consumedKeySurvivesSaveInstanceStateRoundTrip() {
        val first = Robolectric.buildActivity(MainActivity::class.java, notifIntent()).create()
        // Simulate the composition consuming the armed deep link.
        first.get().consumedKey = first.get().deepLink!!.key()
        val saved = Bundle()
        first.saveInstanceState(saved)

        val recreated = Robolectric.buildActivity(MainActivity::class.java, notifIntent())
            .create(saved)
        assertNull(
            "the persisted consumedKey must suppress the sticky intent's re-fire",
            recreated.get().deepLink,
        )
    }

    /** A NEW notification tapped while the app is running still deep-links. */
    @Test fun onNewIntentStillArmsTheDeepLink() {
        val controller = Robolectric.buildActivity(MainActivity::class.java, notifIntent()).create()
        controller.get().deepLink = null
        controller.newIntent(notifIntent(session = "sess-2"))
        assertEquals("sess-2", controller.get().deepLink?.sessionId)
    }
}
