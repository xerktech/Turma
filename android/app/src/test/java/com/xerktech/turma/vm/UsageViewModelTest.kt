package com.xerktech.turma.vm

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.LimitWindow
import com.xerktech.turma.model.LimitsInfo
import com.xerktech.turma.model.ModelUsage
import com.xerktech.turma.model.RepoUsage
import com.xerktech.turma.model.SubscriptionInfo
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

    @Test fun `a removed host still counts, and says it is gone`() {
        // XERK-338: the hub keeps a durable usage ledger and serves what a host
        // it no longer has spent as `retiredUsage`. The Usage screen charts those
        // beside the live fleet, so the fleet's all-time figure must not drop
        // when a host card is removed — and the series has to say the host is
        // gone, or a name that exists nowhere else in the app reads as a live
        // host that simply spent nothing today.
        val live = AgentInfo(key = "live", usage = usage(today = 1, week = 1, all = 5))
        val gone = AgentInfo(key = "gone", retired = true,
            usage = usage(today = 0, week = 0, all = 7))
        val ui = UsageViewModel.compute(FleetState(agents = listOf(live, gone)))
        assertEquals(12L, ui.total)
        assertEquals(listOf("gone (removed)", "live"), ui.byHost.map { it.label }.sorted())
        // The key the legend toggles on is the host name, unchanged by the
        // label — a host that is removed must not lose a toggle set before it was.
        assertEquals(listOf("host::gone", "host::live"), ui.byHost.map { it.skey }.sorted())
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

    // --- one card per subscription (XERK-301) -------------------------------
    // Ports of usage.html's limitGroups / limitHostLabel.

    private fun sub(key: String) = SubscriptionInfo(key = key)

    @Test fun `hosts on one subscription fold into a single card`() {
        // Both are logged into the same Claude account, so they read and spend
        // one pool — two sets of bars was the same number drawn twice.
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "maxai", device = "maxai", subscription = sub("k1"),
                limits = limits(now - 600, five = LimitWindow(usedPct = 30.0))),
            AgentInfo(key = "truenas", device = "truenas", subscription = sub("k1"),
                limits = limits(now - 60, five = LimitWindow(usedPct = 42.0))),
        ))
        val cards = UsageViewModel.compute(fleet, now).limits
        assertEquals(1, cards.size)
        assertEquals(listOf("truenas", "maxai"), cards[0].hosts.map { it.host })
        assertEquals("truenas · maxai", cards[0].host)
        assertEquals(now - 60, cards[0].capturedAt)
    }

    @Test fun `different subscriptions keep their own cards`() {
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "work", device = "work", subscription = sub("k1"),
                limits = limits(now, five = LimitWindow(usedPct = 30.0))),
            AgentInfo(key = "home", device = "home", subscription = sub("k2"),
                limits = limits(now - 30, five = LimitWindow(usedPct = 5.0))),
        ))
        assertEquals(listOf(listOf("work"), listOf("home")),
            UsageViewModel.compute(fleet, now).limits.map { c -> c.hosts.map { it.host } })
    }

    @Test fun `two hosts that merely both report NO subscription are never folded`() {
        // Absent means "this host can't tell you", so two silent hosts are not
        // thereby on one plan — an older agent must not have its bars merged
        // into somebody else's.
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "old-a", device = "old-a",
                limits = limits(now, five = LimitWindow(usedPct = 30.0))),
            AgentInfo(key = "old-b", device = "old-b",
                limits = limits(now, five = LimitWindow(usedPct = 70.0))),
            AgentInfo(key = "old-c", device = "old-c", subscription = sub(""),
                limits = limits(now, five = LimitWindow(usedPct = 90.0))),
        ))
        assertEquals(listOf(listOf("old-a"), listOf("old-b"), listOf("old-c")),
            UsageViewModel.compute(fleet, now).limits.map { c -> c.hosts.map { it.host } })
    }

    @Test fun `each window takes its freshest reading, per window`() {
        // The newest read of a shared counter is the most recent truth, and
        // across a reset it is the only right answer — a maximum would keep the
        // pre-reset figure alive. Per window, since the freshest snapshot need
        // not carry both.
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "a", device = "a", subscription = sub("k1"), limits = limits(
                now - 600, five = LimitWindow(usedPct = 80.0), seven = LimitWindow(usedPct = 44.0))),
            AgentInfo(key = "b", device = "b", subscription = sub("k1"),
                limits = limits(now - 60, five = LimitWindow(usedPct = 3.0))),
        ))
        val card = UsageViewModel.compute(fleet, now).limits.single()
        assertEquals(3.0, card.fiveHour!!.pct, 0.001)    // freshest, not highest
        assertEquals(44.0, card.sevenDay!!.pct, 0.001)   // the only reading there is
    }

    @Test fun `an aged-out snapshot never joins a group`() {
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "dead", device = "dead", subscription = sub("k1"), limits = limits(
                now - UsageViewModel.LIMIT_MAX_AGE_SEC - 60, five = LimitWindow(usedPct = 40.0))),
            AgentInfo(key = "live", device = "live", subscription = sub("k1"),
                limits = limits(now, five = LimitWindow(usedPct = 7.0))),
        ))
        assertEquals(listOf("live"),
            UsageViewModel.compute(fleet, now).limits.single().hosts.map { it.host })
    }

    @Test fun `a capturedAt tie breaks the same way the web does`() {
        // Two hosts whose snapshots tie to the second: fold in fleet order (or
        // accept an equal capturedAt as newer) and this client shows a DIFFERENT
        // percentage from the web for one subscription — the parity rule. Both
        // sort freshest-first stably and replace only on a strictly newer read.
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "first", device = "first", subscription = sub("k1"), limits = limits(
                now - 5, five = LimitWindow(usedPct = 11.0), seven = LimitWindow(usedPct = 21.0))),
            AgentInfo(key = "second", device = "second", subscription = sub("k1"), limits = limits(
                now - 5, five = LimitWindow(usedPct = 99.0), seven = LimitWindow(usedPct = 91.0))),
        ))
        val card = UsageViewModel.compute(fleet, now).limits.single()
        assertEquals(11.0, card.fiveHour!!.pct, 0.001)
        assertEquals(21.0, card.sevenDay!!.pct, 0.001)
    }

    @Test fun `a window read before the card's stamp carries its own read time`() {
        // The head shows the group's FRESHEST capture, so a window the freshest
        // host didn't report must not be presented under it.
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "old", device = "old", subscription = sub("k1"),
                limits = limits(now - 900, seven = LimitWindow(usedPct = 44.0))),
            AgentInfo(key = "new", device = "new", subscription = sub("k1"),
                limits = limits(now - 30, five = LimitWindow(usedPct = 3.0))),
        ))
        val card = UsageViewModel.compute(fleet, now).limits.single()
        assertEquals(now - 30, card.capturedAt)
        assertEquals(now - 30, card.fiveHourAt)   // same as the head: nothing to disclose
        assertEquals(now - 900, card.sevenDayAt)  // older, so the row says so
    }

    @Test fun `the five-hour row discloses its own read time too`() {
        // The web renders both windows through one loop; this screen has two
        // separate LimitRow call sites, so covering only the 7d one leaves the
        // 5d half free to regress. Same fleet as above with the windows swapped.
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "old", device = "old", subscription = sub("k1"),
                limits = limits(now - 900, five = LimitWindow(usedPct = 80.0))),
            AgentInfo(key = "new", device = "new", subscription = sub("k1"),
                limits = limits(now - 30, seven = LimitWindow(usedPct = 12.0))),
        ))
        val card = UsageViewModel.compute(fleet, now).limits.single()
        assertEquals(now - 900, card.fiveHourAt)
        assertEquals(now - 30, card.sevenDayAt)
    }

    @Test fun `a long host list gives way to a count`() {
        val fleet = FleetState(agents = (1..5).map {
            AgentInfo(key = "h$it", device = "h$it", subscription = sub("k1"),
                limits = limits(now - it, five = LimitWindow(usedPct = 1.0)))
        })
        assertEquals("h1 · h2 · h3 +2 more",
            UsageViewModel.compute(fleet, now).limits.single().host)
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

    // --- the sub-agent split (XERK-302) ---------------------------------
    // Delegated tokens are a SLICE of the totals above, not an addend. The rule
    // worth guarding is that a host which cannot report the split is left OUT of
    // the share rather than counted as one that delegated nothing.

    private fun split(all: Long) =
        com.xerktech.turma.model.SubagentUsage(
            today = bucket(all), week = bucket(all), totals = bucket(all))

    @Test fun `the delegated share is taken against reporting hosts only`() {
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "new", usage = usage(today = 250, week = 250, all = 1000)
                .copy(subagent = split(250))),
            // Too old to break its usage down — its 2000 must not dilute the share.
            AgentInfo(key = "old", usage = usage(today = 2000, week = 2000, all = 2000)),
        ))
        val sub = UsageViewModel.compute(fleet).subagent
        assertEquals(250L, sub.total)
        assertEquals(1000L, sub.ofTotal)
        assertEquals(25.0, sub.totalPct!!, 0.001)
        assertEquals(1, sub.reporting)
        assertEquals(2, sub.hosts)
        assertEquals(true, sub.partial)
    }

    @Test fun `no host reporting a split means no answer, not a zero share`() {
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "old", usage = usage(today = 1, week = 1, all = 500)),
        ))
        val sub = UsageViewModel.compute(fleet).subagent
        assertEquals(false, sub.any)
        assertEquals(null, sub.totalPct)
    }

    @Test fun `a host that delegated nothing is a real zero percent`() {
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "new", usage = usage(today = 1, week = 1, all = 500)
                .copy(subagent = split(0))),
        ))
        val sub = UsageViewModel.compute(fleet).subagent
        assertEquals(true, sub.any)
        assertEquals(false, sub.partial)
        assertEquals(0.0, sub.totalPct!!, 0.001)
    }

    @Test fun `a window with no spend has no share to take`() {
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "new", usage = UsageInfo(totals = bucket(500))
                .copy(subagent = split(0))),
        ))
        val sub = UsageViewModel.compute(fleet).subagent
        assertEquals(null, sub.todayPct)      // nothing spent today
        assertEquals(0.0, sub.totalPct!!, 0.001)
    }

    @Test fun `a host with no usage block takes its split from its repos`() {
        // Same host-block-then-repos fallback as the totals: an older aggregate
        // shape must not drop this host out of the share.
        val fleet = FleetState(agents = listOf(
            AgentInfo(key = "old", usage = null, repoUsage = listOf(
                RepoUsage("A", "k/a", usage(today = 4, week = 4, all = 40)
                    .copy(subagent = split(10))),
                RepoUsage("B", "k/b", usage(today = 6, week = 6, all = 60)),  // no split
            )),
        ))
        val sub = UsageViewModel.compute(fleet).subagent
        assertEquals(10L, sub.total)
        assertEquals(40L, sub.ofTotal)   // only the repo that reported one
        assertEquals(25.0, sub.totalPct!!, 0.001)
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
