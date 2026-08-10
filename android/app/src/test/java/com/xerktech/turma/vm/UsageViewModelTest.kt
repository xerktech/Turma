package com.xerktech.turma.vm

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.LimitWindow
import com.xerktech.turma.model.LimitsInfo
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
        UsageInfo(today = bucket(today), week = bucket(week), totals = bucket(all), models = models)

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

    @Test fun `root and legacy junk buckets fold into one Root series`() {
        // The agent's root pseudo-repo plus the buckets older agents used for
        // unattributable usage ("(other)", "?", a blank repo) collapse into ONE
        // series, keyed "(root)" and labelled "Root" (XERK-147).
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "h1", repoUsage = listOf(
                RepoUsage("(root)", "(root)", usage(today = 1, week = 2, all = 10)),
                RepoUsage("(other)", "(other)", usage(today = 0, week = 0, all = 5)),
            )),
            AgentInfo(key = "h2", repoUsage = listOf(
                RepoUsage("", "?", usage(today = 0, week = 0, all = 1)),
            )),
        ))
        val root = UsageViewModel.compute(fleet).byRepo.single()
        assertEquals("(root)", root.repo)
        assertEquals("Root", root.label)
        assertEquals("repo::(root)", root.skey)
        assertEquals(16L, root.total)
        // A real repo passes through the label untouched.
        assertEquals("Turma", UsageViewModel.repoLabel("Turma"))
    }

    @Test fun `an empty fleet computes to zeroes rather than throwing`() {
        val ui = UsageViewModel.compute(FleetState())
        assertEquals(0L, ui.total)
        assertEquals(emptyList<UsageViewModel.RepoTotal>(), ui.byRepo)
        assertEquals(emptyList<UsageViewModel.ModelTotal>(), ui.byModel)
    }

    // ---- per-day buckets for the stacked daily chart (XERK-78) ---------------

    private fun usageDays(vararg days: Pair<String, Long>) =
        UsageInfo(days = days.toMap().mapValues { bucket(it.value) })

    @Test fun `per-day buckets merge across hosts for a unified repo`() {
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "h1", repoUsage = listOf(
                RepoUsage("Turma", "github.com/x/turma", usageDays("2026-07-20" to 10, "2026-07-21" to 5)),
            )),
            AgentInfo(key = "h2", repoUsage = listOf(
                RepoUsage("Turma", "github.com/x/turma", usageDays("2026-07-21" to 7)),
            )),
        ))
        val turma = UsageViewModel.compute(fleet).byRepo.single()
        assertEquals(mapOf("2026-07-20" to 10L, "2026-07-21" to 12L), turma.days)
        assertEquals("repo::github.com/x/turma", turma.skey)
    }

    @Test fun `host days prefer the host block, else sum the repos`() {
        val withBlock = AgentInfo(key = "h1", usage = usageDays("2026-07-20" to 3), repoUsage = listOf(
            RepoUsage("A", "k/a", usageDays("2026-07-20" to 999)),
        ))
        val without = AgentInfo(key = "h2", repoUsage = listOf(
            RepoUsage("A", "k/a", usageDays("2026-07-20" to 1)),
            RepoUsage("B", "k/b", usageDays("2026-07-20" to 2)),
        ))
        val ui = UsageViewModel.compute(FleetState(agents = listOf(withBlock, without)))
        assertEquals(mapOf("2026-07-20" to 3L), ui.byHost.first { it.host == "h1" }.days)
        assertEquals(mapOf("2026-07-20" to 3L), ui.byHost.first { it.host == "h2" }.days)
    }

    @Test fun `dateWindow ends at the newest reported day, 30 days wide`() {
        val dates = UsageViewModel.dateWindow(listOf(
            mapOf("2026-07-01" to 1L),
            mapOf("2026-07-10" to 2L, "2026-06-01" to 1L),
        ))
        assertEquals(UsageViewModel.DAYS_SHOWN, dates.size)
        assertEquals("2026-07-10", dates.last())
        assertEquals("2026-06-11", dates.first())
        // No per-day data at all (older agents): no window, chart shows a note.
        assertEquals(emptyList<String>(), UsageViewModel.dateWindow(listOf(emptyMap())))
    }

    @Test fun `niceMax rounds up to a tidy axis ceiling`() {
        assertEquals(1L, UsageViewModel.niceMax(0))
        assertEquals(100L, UsageViewModel.niceMax(81))
        assertEquals(250L, UsageViewModel.niceMax(201))
        assertEquals(500L, UsageViewModel.niceMax(400))
        assertEquals(1000L, UsageViewModel.niceMax(999))
    }

    // --- cache split (mirrors turma/tests/usage.test.js) ----------------------
    // The denominator is the prompt (input + cacheWrite + cacheRead), never
    // output: output is generated, never served from cache, so counting it would
    // make a perfectly-cached repo look like it was missing.

    private fun cache(read: Long = 0, write: Long = 0, input: Long = 0) =
        UsageViewModel.CacheSummary(read = read, write = write, input = input)

    @Test fun `hitPct is the cached share of the prompt`() {
        assertEquals(90, cache(read = 900, input = 100).hitPct)
    }

    @Test fun `hitPct counts a cache write as a miss`() {
        // The session paid 1.25x to write this prefix; it read none of it back.
        assertEquals(0, cache(write = 1000).hitPct)
    }

    @Test fun `hitPct is null when there is no prompt traffic`() {
        assertEquals(null, cache().hitPct)
    }

    @Test fun `hitPct rounds rather than truncating`() {
        // 2/3 -> 67, not 66. Same vector as the web test.
        assertEquals(67, cache(read = 2000, input = 1000).hitPct)
    }

    @Test fun `any is false for an agent reporting no cache fields`() {
        // Drives whether the sub-line renders at all: "0 cached · 0 written"
        // would read as caching being broken rather than simply unreported.
        assertEquals(false, cache(input = 500).any)
        assertEquals(true, cache(write = 1).any)
        assertEquals(true, cache(read = 1).any)
    }

    @Test fun `compute carries the cache split onto repos, hosts and the fleet`() {
        val split = UsageBucket(input = 100, output = 50, cacheWrite = 200, cacheRead = 700)
        val fleet = FleetState(agents = listOf(
            AgentInfo(
                key = "h1",
                usage = UsageInfo(totals = split),
                repoUsage = listOf(RepoUsage("turma", "github.com/x/turma", UsageInfo(totals = split))),
            ),
        ))
        val ui = UsageViewModel.compute(fleet)
        // Prompt = 100 + 200 + 700 = 1000, of which 700 was read from cache.
        assertEquals(70, ui.cache.hitPct)
        assertEquals(700L, ui.byHost.single().cache.read)
        assertEquals(200L, ui.byRepo.single().cache.write)
    }

    @Test fun `a host with no usage block sums its repos for the cache split too`() {
        // Same host-block-then-repos fallback the totals use — an older agent's
        // cache traffic must not silently read as zero.
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "old", usage = null, repoUsage = listOf(
                RepoUsage("A", "k/a", UsageInfo(totals = UsageBucket(cacheRead = 30, input = 10))),
                RepoUsage("B", "k/b", UsageInfo(totals = UsageBucket(cacheRead = 30, input = 30))),
            )),
        ))
        val host = UsageViewModel.compute(fleet).byHost.single()
        assertEquals(60L, host.cache.read)
        assertEquals(100L, host.cache.prompt)
        assertEquals(60, host.cache.hitPct)
    }

    // --- subscription limits (XERK-247) -------------------------------------
    // Ports of usage.html's limitEntries / limitWindowView / fmtDuration; these
    // mirror turma/tests/usage.test.js case for case.

    private val now = 1_786_400_000L // epoch seconds, so countdowns are assertable

    private fun limits(captured: Long = now, five: LimitWindow? = null, seven: LimitWindow? = null) =
        LimitsInfo(fiveHour = five, sevenDay = seven, capturedAt = captured)

    @Test fun `a host reporting no limits gets no card`() {
        // An agent too old to send the field, a login with no subscription
        // windows, and a block carrying neither window all mean the same thing:
        // this host can't tell you. None of them is a card full of zeroes.
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "old", device = "old"),
            AgentInfo(key = "api", device = "api", limits = null),
            AgentInfo(key = "empty", device = "empty", limits = limits()),
            // A window with a reset time but no percentage draws nothing.
            AgentInfo(key = "nopct", device = "nopct",
                limits = limits(five = LimitWindow(resetsAt = now + 60))),
            AgentInfo(key = "real", device = "real", limits = limits(five = LimitWindow(usedPct = 5.0))),
        ))
        val cards = UsageViewModel.compute(fleet, now).limits
        assertEquals(listOf("real"), cards.map { it.host })
    }

    @Test fun `a snapshot too old to describe the current windows is dropped`() {
        // The agent refuses to report one this old, but the hub keeps an OFFLINE
        // host's last heartbeat for days — without this mirror, a dead host shows
        // a frozen 5-hour window that has since reset many times over.
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "dead", device = "dead", limits = limits(
                now - UsageViewModel.LIMIT_MAX_AGE_SEC - 60, five = LimitWindow(usedPct = 40.0))),
            AgentInfo(key = "old", device = "old", limits = limits(
                now - UsageViewModel.LIMIT_MAX_AGE_SEC + 60, five = LimitWindow(usedPct = 40.0))),
        ))
        assertEquals(listOf("old"), UsageViewModel.compute(fleet, now).limits.map { it.host })
    }

    @Test fun `limit cards lead with the freshest snapshot`() {
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "stale", device = "stale",
                limits = limits(now - 9000, seven = LimitWindow(usedPct = 1.0))),
            AgentInfo(key = "fresh", device = "fresh",
                limits = limits(now - 60, seven = LimitWindow(usedPct = 2.0))),
        ))
        assertEquals(listOf("fresh", "stale"), UsageViewModel.compute(fleet, now).limits.map { it.host })
    }

    @Test fun `a window reports its percentage and the countdown to reset`() {
        val v = UsageViewModel.limitView(
            LimitWindow(usedPct = 23.5, resetsAt = now + 2 * 3600 + 14 * 60), now)!!
        assertEquals("23.5%", v.pctLabel)
        assertEquals("resets in 2h 14m", v.reset)
        assertEquals(false, v.expired)
        assertEquals(UsageViewModel.LimitView.Level.NORMAL, v.level)
    }

    @Test fun `a whole percentage drops its trailing zero`() {
        assertEquals("41%", UsageViewModel.limitView(LimitWindow(usedPct = 41.0), now)!!.pctLabel)
    }

    @Test fun `the bar is coloured by headroom, not by branding`() {
        fun level(pct: Double) = UsageViewModel.limitView(LimitWindow(usedPct = pct), now)!!.level
        assertEquals(UsageViewModel.LimitView.Level.NORMAL, level(74.0))
        assertEquals(UsageViewModel.LimitView.Level.WARN, level(75.0))
        assertEquals(UsageViewModel.LimitView.Level.CRIT, level(90.0))
    }

    @Test fun `a window whose reset has already passed is no longer believed`() {
        // The snapshot describes a window that has since rolled over; showing
        // its last percentage would present a stale number as the balance.
        val v = UsageViewModel.limitView(LimitWindow(usedPct = 88.0, resetsAt = now - 60), now)!!
        assertEquals(true, v.expired)
        assertEquals("—", v.pctLabel)
        assertEquals("window has since reset", v.reset)
    }

    @Test fun `a window with no percentage has nothing to draw`() {
        assertEquals(null, UsageViewModel.limitView(LimitWindow(resetsAt = now + 60), now))
        assertEquals(null, UsageViewModel.limitView(null, now))
    }

    @Test fun `fmtDuration reads as an age or a countdown at every scale`() {
        assertEquals("0s", UsageViewModel.fmtDuration(0))
        assertEquals("45s", UsageViewModel.fmtDuration(45))
        assertEquals("6m", UsageViewModel.fmtDuration(6 * 60))
        assertEquals("2h 14m", UsageViewModel.fmtDuration(2 * 3600 + 14 * 60))
        assertEquals("2d 2h", UsageViewModel.fmtDuration(50 * 3600))
        // A clock skew that puts the snapshot in the future must not read "-3m".
        assertEquals("0s", UsageViewModel.fmtDuration(-90))
    }
}
