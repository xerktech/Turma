package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.xerktech.turma.core.ModelQuality
import com.xerktech.turma.model.ModelQualityGroup
import com.xerktech.turma.model.ModelQualityPr
import com.xerktech.turma.model.ModelQualityRow
import com.xerktech.turma.model.ModelQualityView
import com.xerktech.turma.vm.UsageViewModel
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Usage screen's "Model quality" card (XERK-1849), the port of usage.html's. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ModelQualitySectionTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val now = 2_000_000_000_000L

    internal val view = ModelQualityView(
        windowDays = 90,
        groups = listOf(
            ModelQualityGroup(cls = "bug", model = "opus", sessions = 24, good = 14, bad = 2, pending = 5, noChange = 3),
            ModelQualityGroup(cls = "bug", model = "sonnet", sessions = 12, good = 6, bad = 2, pending = 3, undelivered = 1),
            ModelQualityGroup(cls = "task", model = "haiku", sessions = 3, good = 2, bad = 1),
        ),
        rows = listOf(
            ModelQualityRow(issue = "ACME-101", host = "builder-01", repo = "web", cls = "bug", model = "sonnet",
                outcome = "bad", reason = "closed unmerged", updatedAt = (now - 3_600_000).toDouble(),
                prs = listOf(ModelQualityPr("https://github.com/acme/web/pull/401", "CLOSED"))),
        ),
    )

    private fun show(ui: UsageViewModel.ModelQualityUi) {
        compose.setContent {
            Column(Modifier.verticalScroll(rememberScrollState())) { ModelQualitySection(ui, nowMs = now) }
        }
        compose.waitForIdle()
    }

    @Test
    fun `groups show their counts, bad rate and the class's Opus baseline`() {
        show(UsageViewModel.ModelQualityUi(view = view))
        compose.onNodeWithText("Bad rate 25%").assertExists()
        compose.onNodeWithText("Opus 13%").assertExists()
        // Opus is the baseline; a class with no Opus session shows no Opus figure.
        assertEquals(1, compose.onAllNodesWithText("Status baseline").fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithText("Opus —").fetchSemanticsNodes().size)
        compose.onNodeWithText("3 no change").assertExists()
        // No org picked: the session rows are org-scoped, so the card says how to get them.
        compose.onNodeWithText(ModelQuality.PICK_ORG).performScrollTo().assertExists()
    }

    @Test
    fun `one org lists its sessions under a disclosure`() {
        show(UsageViewModel.ModelQualityUi(view = view, org = "acme.atlassian.net"))
        compose.onNodeWithText("Sessions in", substring = true).performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("ACME-101").assertExists()
        compose.onNodeWithText("#401").assertExists()
        compose.onNodeWithText("1h 00m ago").assertExists()
    }

    @Test
    fun `a failed first read says why`() {
        show(UsageViewModel.ModelQualityUi(error = "the hub answered HTTP 503"))
        compose.onNodeWithText("Could not load model quality (the hub answered HTTP 503).").assertExists()
    }
}
