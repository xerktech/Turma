package com.xerktech.turma.core

import com.xerktech.turma.model.CloneInfo
import com.xerktech.turma.model.GitSourceInfo
import com.xerktech.turma.model.GithubInfo
import com.xerktech.turma.model.GithubRepo

/**
 * The clone bar's pure reducers — a port of turma/public/index.html's
 * `cloneBar`/`cloneBody`/`cloneRepo`, kept out of the Compose layer so the
 * candidate list, the free-text spec parsing and the job rows are JVM-tested
 * against the web behavior rather than eyeballed on a phone.
 */

/** One row of the multi-select repo list. */
data class CloneCandidate(
    val nameWithOwner: String,
    /** Bare repo dir it would clone into — what decides "already here". */
    val name: String,
    val isPrivate: Boolean,
    /** True when this host already has the repo, so the row is un-pickable. */
    val alreadyHere: Boolean,
    /** Which listing the row came from — rides the pick key into the POST. */
    val source: String = "github",
)

/**
 * One clone source the picker lists (the web's `cloneSources`, XERK-155):
 * the legacy `github` block as the GitHub section plus every extra source the
 * agent reports in `gitSources`. An agent predating the block yields the
 * GitHub section alone, so the bar renders exactly as it always did.
 */
data class CloneSource(
    val source: String,
    val label: String,
    val user: String?,
    val available: Boolean,
    val repos: List<GithubRepo>,
)

fun cloneSources(github: GithubInfo?, gitSources: List<GitSourceInfo>): List<CloneSource> {
    val out = mutableListOf<CloneSource>()
    if ((github != null && github.available) || gitSources.isEmpty()) {
        out += CloneSource(
            source = "github", label = "GitHub",
            user = github?.login?.takeIf { it.isNotBlank() },
            available = github != null && github.available,
            repos = github?.repos ?: emptyList(),
        )
    }
    for (s in gitSources) {
        if (s.source.isBlank()) continue
        out += CloneSource(
            source = s.source, label = s.label.ifBlank { s.source },
            user = s.user.takeIf { it.isNotBlank() },
            available = s.available, repos = s.repos,
        )
    }
    return out
}

/**
 * The clone bar's header. One source names it — "Clone from GitHub · as me",
 * "Clone from gitlab.example.com" — so a GitLab- or Azure-only host never
 * claims GitHub; several sources make it generic ("Clone a repo") and the
 * per-source labels move into the list.
 */
fun cloneBarTitle(sources: List<CloneSource>): String {
    val one = sources.singleOrNull() ?: return "Clone a repo"
    return "Clone from ${one.label.ifBlank { "GitHub" }}" +
        one.user?.let { " · as $it" }.orEmpty()
}

/** The greyed note when no source on the bar is usable, naming the single
 *  source it is about (the generic wording covers a multi-source host). */
fun cloneUnavailableNote(sources: List<CloneSource>): String {
    val one = sources.singleOrNull()
        ?: return "No usable git-source credentials on this host — cloning unavailable."
    return "No ${one.label.ifBlank { "GitHub" }} credentials on this host — cloning unavailable."
}

/**
 * A pick's identity in the multi-select: `<source>|<nameWithOwner>` — the same
 * key the web stores, safe because '|' can appear in neither half. cloneSpecs
 * splits it back apart for the POST.
 */
fun clonePickKey(source: String, nameWithOwner: String): String = "$source|$nameWithOwner"

/** One clone POST: the repo spec plus the listing it was picked from (null = the
 *  legacy free-text GitHub path). */
data class CloneSpec(val repo: String, val source: String?)

/**
 * The pickable repo list: every repo the host's gh login can clone, marked with
 * whether it is already present, filtered by the search box (case-insensitive,
 * over owner/repo — the same match the web search does). Order is the agent's
 * (newest-updated first); present repos are kept in the list rather than hidden,
 * so "already here" is visible instead of looking like a missing repo.
 */
fun cloneCandidates(
    repos: List<GithubRepo>,
    present: Set<String>,
    query: String = "",
    source: String = "github",
): List<CloneCandidate> {
    val q = query.trim().lowercase()
    return repos
        .filter { q.isEmpty() || it.nameWithOwner.lowercase().contains(q) }
        .map {
            CloneCandidate(
                nameWithOwner = it.nameWithOwner,
                name = it.name,
                isPrivate = it.isPrivate,
                alreadyHere = it.name in present,
                source = source,
            )
        }
}

/**
 * The bare repo dir a clone spec lands in — the web's
 * `spec.replace(/\.git$/,'').replace(/\/+$/,'').split('/').pop()`. Used to match
 * a just-fired clone against the job the agent echoes back (which is keyed on
 * that name), so the optimistic row retires instead of doubling up. Blank when
 * the spec names nothing.
 */
fun cloneRepoName(spec: String): String =
    spec.trim().trimEnd('/').removeSuffix(".git").trimEnd('/').substringAfterLast('/')

/**
 * The specs a Clone press fires, one POST each: every checked repo (a
 * `<source>|<nameWithOwner>` pick key) plus a non-blank free-text box, which
 * stays source-less — the legacy GitHub meaning. Deduped by the dir they'd
 * land in, and anything that resolves to no name is dropped (the agent would
 * refuse it anyway).
 */
fun cloneSpecs(picked: Set<String>, freeText: String): List<CloneSpec> {
    val out = mutableListOf<CloneSpec>()
    val seen = mutableSetOf<String>()
    val all = picked.sorted().map { key ->
        val i = key.indexOf('|')
        if (i < 0) CloneSpec(key, null) else CloneSpec(key.substring(i + 1), key.substring(0, i))
    } + listOf(CloneSpec(freeText.trim(), null))
    for (spec in all) {
        if (spec.repo.isBlank()) continue
        val name = cloneRepoName(spec.repo)
        if (name.isBlank() || !seen.add(name)) continue
        out += spec
    }
    return out
}

/** How a clone job renders: its one-line message and whether it failed. */
data class CloneJobRow(val text: String, val done: Boolean, val failed: Boolean)

/**
 * One clone job's status row, mirroring the web's three states. A job in any
 * other/unknown state is treated as still running rather than dropped, so a
 * newer agent's state never leaves the operator with no feedback at all.
 */
fun cloneJobRow(job: CloneInfo): CloneJobRow = when (job.status) {
    "done" -> CloneJobRow(
        "✓ Cloned ${job.name.ifBlank { job.repo }} — it should appear below shortly.",
        done = true, failed = false,
    )
    "error" -> CloneJobRow(
        "⚠ Clone of ${job.repo} failed: ${job.error.ifBlank { "unknown error" }}",
        done = false, failed = true,
    )
    else -> CloneJobRow("Cloning ${job.repo}…", done = false, failed = false)
}
