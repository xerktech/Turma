package com.xerktech.turma.vm

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.ModelUsage
import com.xerktech.turma.model.RepoUsage
import com.xerktech.turma.model.UsageBucket
import com.xerktech.turma.model.UsageInfo
import com.xerktech.turma.net.FleetState
import org.junit.Assert.assertEquals
import org.junit.Test

class UsageViewModelTest {

    /** A bucket whose four token fields sum to [total]. */
    private fun bucket(total: Long) = UsageBucket(input = total)

    private fun usage(today: Long, week: Long, all: Long, models: List<ModelUsage> = emptyList()) =
        UsageInfo(bucket(today), bucket(week), bucket(all), models)

    @Test fun `bucket total sums every token field, cache included`() {
        val b = UsageBucket(input = 1, output = 2, cacheWrite = 4, cacheRead = 8)
        assertEquals(15L, b.total)
    }

    @Test fun `fleet windows sum the host-level block, not the live sessions`() {
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "h1", usage = usage(today = 10, week = 70, all = 500)),
            AgentInfo(key = "h2", usage = usage(today = 5, week = 30, all = 100)),
        ))
        val ui = UsageViewModel.compute(fleet)
        assertEquals(15L, ui.today)
        assertEquals(100L, ui.week)
        assertEquals(600L, ui.total)
    }

    @Test fun `a host with no usage block falls back to summing its repos`() {
        // An older agent reports repoUsage but no host-level aggregate; its work
        // must still reach the fleet totals rather than silently reading zero.
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "old", usage = null, repoUsage = listOf(
                RepoUsage("A", "k/a", usage(today = 1, week = 7, all = 10)),
                RepoUsage("B", "k/b", usage(today = 2, week = 14, all = 20)),
            )),
        ))
        val ui = UsageViewModel.compute(fleet)
        assertEquals(3L, ui.today)
        assertEquals(21L, ui.week)
        assertEquals(30L, ui.total)
    }

    @Test fun `a repo on two hosts unifies by remoteKey and sorts by tokens`() {
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "h1", repoUsage = listOf(
                RepoUsage("Turma", "github.com/x/turma", usage(today = 1, week = 5, all = 100)),
                RepoUsage("Small", "github.com/x/small", usage(today = 0, week = 0, all = 5)),
            )),
            AgentInfo(key = "h2", repoUsage = listOf(
                // Same repo, other host: one series, summed.
                RepoUsage("Turma", "github.com/x/turma", usage(today = 2, week = 6, all = 300)),
            )),
        ))
        val ui = UsageViewModel.compute(fleet)
        assertEquals(listOf("Turma", "Small"), ui.byRepo.map { it.repo })
        val turma = ui.byRepo.first()
        assertEquals(400L, turma.total)
        assertEquals(3L, turma.today)
        assertEquals(11L, turma.week)
    }

    @Test fun `a repo with no remote falls back to its name as the key`() {
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "h1", repoUsage = listOf(
                RepoUsage("Local", "", usage(today = 0, week = 0, all = 9)),
            )),
        ))
        assertEquals(listOf("Local"), UsageViewModel.compute(fleet).byRepo.map { it.remoteKey })
    }

    @Test fun `the same model on two hosts merges by name, biggest first`() {
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "h1", usage = usage(0, 0, 0, models = listOf(
                ModelUsage("opus", bucket(1), bucket(5), bucket(100)),
                ModelUsage("haiku", bucket(0), bucket(1), bucket(3)),
            ))),
            AgentInfo(key = "h2", usage = usage(0, 0, 0, models = listOf(
                ModelUsage("opus", bucket(2), bucket(6), bucket(50)),
            ))),
        ))
        val ui = UsageViewModel.compute(fleet)
        assertEquals(listOf("opus", "haiku"), ui.byModel.map { it.model })
        val opus = ui.byModel.first()
        assertEquals(150L, opus.total)
        assertEquals(3L, opus.today)
        assertEquals(11L, opus.week)
    }

    @Test fun `an empty fleet computes to zeroes rather than throwing`() {
        val ui = UsageViewModel.compute(FleetState())
        assertEquals(0L, ui.total)
        assertEquals(emptyList<UsageViewModel.RepoTotal>(), ui.byRepo)
        assertEquals(emptyList<UsageViewModel.ModelTotal>(), ui.byModel)
    }
}
