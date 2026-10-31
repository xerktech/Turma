package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.xerktech.turma.core.ADMIN_ONLY_NOTE
import com.xerktech.turma.model.Me
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** XERK-2553: an admin-only account sees why the app is empty, and can sign out. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AdminOnlyScreenTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun `names the account, explains, and signs out`() {
        var signedOut = 0
        compose.setContent { AdminOnlyScreen(Me(name = "root", roles = listOf("admin"), adminOnly = true)) { signedOut++ } }
        compose.onNodeWithText("Signed in as root").assertExists()
        compose.onNodeWithText(ADMIN_ONLY_NOTE).assertExists()
        compose.onNodeWithText("Sign out").performClick()
        assertEquals(1, signedOut)
    }
}
