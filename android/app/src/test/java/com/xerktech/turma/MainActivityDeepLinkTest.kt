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
 * `deepLink` is read straight after `onCreate` (via `create(...)`, before the
 * composition is resumed), because once TurmaApp's `LaunchedEffect` runs it
 * consumes the state and nulls it — so the armed-vs-not distinction is only
 * visible at that point.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MainActivityDeepLinkTest {

    private fun notifIntent(session: String = "sess-1") =
        Intent(RuntimeEnvironment.getApplication(), MainActivity::class.java).apply {
            putExtra(MainActivity.EXTRA_HOST, "nas01")
            putExtra(MainActivity.EXTRA_SESSION, session)
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
     * The regression: an Activity RECREATION (non-null savedInstanceState) with
     * the same still-sticky launching intent must NOT re-arm the deep link. This
     * is the config-change / process-restore path that was re-firing the
     * notification's chat every time the user navigated away.
     */
    @Test fun recreationDoesNotRefireTheStickyDeepLink() {
        val controller = Robolectric.buildActivity(MainActivity::class.java, notifIntent())
            .create(Bundle())
        assertNull(
            "a recreation must not re-fire the already-consumed sticky deep link",
            controller.get().deepLink,
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
