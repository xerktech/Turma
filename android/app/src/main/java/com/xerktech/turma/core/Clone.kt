package com.xerktech.turma.core

import com.xerktech.turma.model.CloneInfo
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
)

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
 * The specs a Clone press fires, one POST each: every checked repo plus a
 * non-blank free-text box. Deduped by the dir they'd land in, and anything that
 * resolves to no name is dropped (the agent would refuse it anyway).
 */
fun cloneSpecs(picked: Set<String>, freeText: String): List<String> {
    val out = mutableListOf<String>()
    val seen = mutableSetOf<String>()
    for (spec in picked.sorted() + listOf(freeText.trim())) {
        if (spec.isBlank()) continue
        val name = cloneRepoName(spec)
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
