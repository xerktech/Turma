package com.xerktech.turma.ui

import com.xerktech.turma.model.PrInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class PrBadgeTest {

    @Test fun `number leads when the status has one`() {
        assertEquals("#7", prNumberLabel(PrInfo(url = "https://github.com/o/r/pull/7", number = 7)))
    }

    @Test fun `bare github url falls back to the pull number`() {
        assertEquals("#42", prNumberLabel(PrInfo(url = "https://github.com/o/r/pull/42")))
    }

    // XERK-162: a GitLab merge request chips exactly like a PR — labelled with
    // GitLab's own !n sigil.
    @Test fun `bare gitlab mr url falls back to the merge_requests number`() {
        assertEquals(
            "!12",
            prNumberLabel(PrInfo(url = "https://gitlab.example.com/grp/app/-/merge_requests/12")),
        )
    }

    @Test fun `gitlab mr keeps the bang sigil when the status has a number`() {
        assertEquals(
            "!3",
            prNumberLabel(
                PrInfo(url = "https://gitlab.example.com/grp/app/-/merge_requests/3", number = 3),
            ),
        )
    }

    // XERK-226: and so does an Azure DevOps pull request (!n too — in ADO #n
    // addresses a WORK ITEM).
    @Test fun `bare azure devops pr url falls back to the pullrequest number`() {
        assertEquals(
            "!12",
            prNumberLabel(PrInfo(url = "https://dev.azure.com/myorg/Proj/_git/app/pullrequest/12")),
        )
    }

    @Test fun `no number anywhere reads PR`() {
        assertEquals("PR", prNumberLabel(PrInfo(url = "https://example.com/somewhere")))
    }
}
