package com.xerktech.turma.core

import com.xerktech.turma.model.JiraTicket
import com.xerktech.turma.model.QueuedTicket

/**
 * The board toolbar's search / filter / sort VIEW — a pure port of board.js's
 * `boardView*` block (`ticketFacets`, `ticketSearchMatch`, `boardViewMatches`,
 * `boardViewSort`, `boardFilterGroups`, `boardViewFromParams`/`ToParams`).
 * Client-only: nothing here reaches the hub or the tracker. Change one side,
 * change the other; `BoardViewTest` mirrors `board-view.test.js`.
 *
 * Within one field the selected values OR; across fields they AND. Every filter
 * is a FACET — a field maps to the list of values a ticket carries for it — so
 * multi-valued fields (labels, due windows) need no special case.
 */
data class BoardView(
    val q: String = "",
    val f: Map<String, List<String>> = emptyMap(),
    val sort: String = "updated",
    val rev: Boolean = false,
    val hideDone: Boolean = false,
)

val FILTER_FIELDS: List<Pair<String, String>> = listOf(
    "type" to "Type", "priority" to "Priority", "project" to "Project",
    "label" to "Label", "repo" to "Repo", "epic" to "Epic",
    "session" to "Session", "deps" to "Dependencies", "due" to "Due",
    "updated" to "Updated",
)

/** Fixed-vocabulary facets, in display order (board.js FACET_LABELS). */
private val FACET_LABELS: Map<String, Map<String, String>> = mapOf(
    "repo" to linkedMapOf("-none" to "no repo", "-untriaged" to "untriaged"),
    "epic" to linkedMapOf("-none" to "No epic"),
    "session" to linkedMapOf("running" to "Running", "queued" to "Queued", "none" to "None"),
    "deps" to linkedMapOf("blocked" to "Blocked", "blocking" to "Blocking"),
    "due" to linkedMapOf("overdue" to "Overdue", "week" to "Next 7 days", "has" to "Has due date", "none" to "No due date"),
    "updated" to linkedMapOf("24h" to "24h", "7d" to "7 days", "30d" to "30 days"),
)

/** A sort: its natural direction first; `rev` flips it. */
data class BoardSort(val key: String, val label: String, val natural: String, val reversed: String)

val BOARD_SORTS: List<BoardSort> = listOf(
    BoardSort("updated", "Updated", "Newest first", "Oldest first"),
    BoardSort("created", "Created", "Newest first", "Oldest first"),
    BoardSort("priority", "Priority", "Highest first", "Lowest first"),
    BoardSort("due", "Due date", "Soonest first", "Latest first"),
    BoardSort("key", "Key", "Ascending", "Descending"),
    BoardSort("type", "Type", "A → Z", "Z → A"),
)

fun boardSortOf(view: BoardView): BoardSort = BOARD_SORTS.firstOrNull { it.key == view.sort } ?: BOARD_SORTS[0]

/** Caps on a stored view — mirrors board.js VIEW_MAX_VALUES / VIEW_MAX_LEN. */
private const val VIEW_MAX_VALUES = 50
private const val VIEW_MAX_LEN = 200

/** Does the view narrow the board? Sort and the Done toggle never hide a ticket. */
fun boardViewActive(view: BoardView): Boolean =
    view.q.isNotBlank() || view.f.values.any { it.isNotEmpty() }

fun boardViewFilterCount(view: BoardView): Int = view.f.values.count { it.isNotEmpty() }

/** Jira names, Azure P<n> and common alternates onto 0 (most urgent)..4; unknown 8, none 9. */
fun priorityRank(name: String?): Int {
    val p = name.orEmpty().trim().lowercase()
    if (p.isEmpty()) return 9
    if (Regex("^p\\d$").matches(p)) return minOf(p.substring(1).toInt() - 1, 8)
    return when (p) {
        "highest", "blocker", "critical", "urgent" -> 0
        "high", "major" -> 1
        "medium", "normal" -> 2
        "low", "minor" -> 3
        "lowest", "trivial" -> 4
        else -> 8
    }
}

/** The viewer's LOCAL calendar day — "overdue" must not flip at UTC midnight. */
private fun localDay(ms: Long): String =
    java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString()

/** field -> the values this ticket carries for it (board.js ticketFacets). */
fun ticketFacets(
    t: JiraTicket,
    siteKey: String,
    sessionIndex: Map<String, List<TicketSession>>,
    queue: List<QueuedTicket>?,
    now: Long,
): Map<String, List<String>> {
    val g = t.repoGuess
    val repo = when {
        g == null -> "-untriaged"
        !g.repo.isNullOrEmpty() -> g.repo
        else -> "-none"
    }
    // The index also folds in killed/ended sessions and resumable transcripts
    // (for the chips), so only a session whose OWN status is live counts.
    val sess = ticketSessionsOf(sessionIndex, siteKey, t.key)
    val session = when {
        sess.any { it.status == "running" } -> "running"
        sess.any { it.status == "queued" } || queuedTicketOf(queue, siteKey, t.key) != null -> "queued"
        else -> "none"
    }
    val deps = buildList {
        if (t.blockedBy.isNotEmpty()) add("blocked")
        if (t.blocks.isNotEmpty()) add("blocking")
    }
    val dd = t.dueDate.orEmpty().takeIf { Regex("^\\d{4}-\\d{2}-\\d{2}").containsMatchIn(it) }?.take(10)
    val due = if (dd != null) {
        val today = localDay(now)
        buildList {
            add("has")
            if (dd < today) add("overdue")
            else if (dd <= localDay(now + 7 * 86_400_000L)) add("week")
        }
    } else listOf("none")
    val updated = buildList {
        parseIsoMs(t.updated)?.let { at ->
            val h = (now - at) / 3_600_000.0
            if (h <= 24) add("24h")
            if (h <= 24 * 7) add("7d")
            if (h <= 24 * 30) add("30d")
        }
    }
    return mapOf(
        "type" to listOfNotNull(t.type.ifEmpty { null }),
        "priority" to listOfNotNull(t.priority.ifEmpty { null }),
        "project" to listOfNotNull(t.project.ifEmpty { null }),
        "label" to t.labels.filter { it.isNotEmpty() },
        "repo" to listOf(repo),
        "epic" to listOf(t.epicKey?.ifEmpty { null } ?: "-none"),
        "session" to listOf(session),
        "deps" to deps,
        "due" to due,
        "updated" to updated,
    )
}

private val KEY_QUERY_RE = Regex("^[a-z][a-z0-9_]*-\\d+$", RegexOption.IGNORE_CASE)

/** Substring over text fields; an issue-key-shaped query matches that ticket exactly. */
fun ticketSearchMatch(t: JiraTicket, q: String): Boolean {
    val s = q.trim().lowercase()
    if (s.isEmpty()) return true
    if (KEY_QUERY_RE.matches(s)) return t.key.lowercase() == s
    val hay = (listOf(t.key, t.summary, t.type, t.status, t.project, t.projectName, t.epicKey, t.repoGuess?.repo) + t.labels)
        .filterNot { it.isNullOrEmpty() }
        .joinToString("\n")
        .lowercase()
    return s in hay
}

fun boardViewMatches(
    t: JiraTicket,
    siteKey: String,
    view: BoardView,
    sessionIndex: Map<String, List<TicketSession>>,
    queue: List<QueuedTicket>?,
    now: Long,
): Boolean {
    if (!ticketSearchMatch(t, view.q)) return false
    var facets: Map<String, List<String>>? = null
    for ((field, _) in FILTER_FIELDS) {
        val sel = view.f[field]
        if (sel.isNullOrEmpty()) continue
        val fs = facets ?: ticketFacets(t, siteKey, sessionIndex, queue, now).also { facets = it }
        if (fs[field].orEmpty().none { it in sel }) return false
    }
    return true
}

/** Natural ordering of keys: XERK-9 before XERK-10 (board.js localeCompare numeric). */
private val NATURAL: Comparator<String> = Comparator { a, b ->
    val ra = Regex("\\d+|\\D+").findAll(a.lowercase()).map { it.value }.toList()
    val rb = Regex("\\d+|\\D+").findAll(b.lowercase()).map { it.value }.toList()
    for (i in 0 until minOf(ra.size, rb.size)) {
        val x = ra[i]; val y = rb[i]
        val d = if (x[0].isDigit() && y[0].isDigit()) {
            x.toBigInteger().compareTo(y.toBigInteger())
        } else x.compareTo(y)
        if (d != 0) return@Comparator d
    }
    ra.size - rb.size
}

/**
 * The comparator for a view's sort (board.js boardViewSort): epics pinned to
 * the top under every sort, ties on newest `updated`, and a missing due date
 * last in BOTH directions.
 */
fun boardViewComparator(view: BoardView): Comparator<JiraTicket> {
    val sort = boardSortOf(view).key
    val dir = if (view.rev) -1 else 1
    return Comparator { a, b ->
        val ea = if (isEpicTicket(a)) 0 else 1
        val eb = if (isEpicTicket(b)) 0 else 1
        if (ea != eb) return@Comparator ea - eb
        val d = when (sort) {
            "updated" -> b.updated.compareTo(a.updated) * dir
            "created" -> b.created.compareTo(a.created) * dir
            "priority" -> (priorityRank(a.priority) - priorityRank(b.priority)) * dir
            "due" -> {
                val da = a.dueDate.orEmpty(); val db = b.dueDate.orEmpty()
                if (da.isEmpty() != db.isEmpty()) return@Comparator if (da.isNotEmpty()) -1 else 1
                da.compareTo(db) * dir
            }
            "key" -> NATURAL.compare(a.key, b.key) * dir
            "type" -> a.type.compareTo(b.type, ignoreCase = true) * dir
            else -> 0
        }
        if (d != 0) d else b.updated.compareTo(a.updated)
    }
}

data class FilterOption(val value: String, val label: String, val count: Int, val selected: Boolean)
data class FilterGroup(val field: String, val label: String, val options: List<FilterOption>)

/**
 * The filter sheet's groups (board.js boardFilterGroups): every field, with the
 * values the in-scope tickets carry and how many carry each. A selected value
 * nobody carries stays offered (count 0) so it can be cleared.
 */
fun boardFilterGroups(
    sites: List<BoardSite>,
    view: BoardView,
    sessionIndex: Map<String, List<TicketSession>>,
    queue: List<QueuedTicket>?,
    now: Long,
): List<FilterGroup> {
    val counts = FILTER_FIELDS.associate { it.first to LinkedHashMap<String, Int>() }
    val epicNames = HashMap<String, String>()
    for (site in sites) for (t in site.tickets) {
        // A hidden Done column hides its tickets, so they don't count either.
        if (view.hideDone && categoryOf(t) == "done") continue
        if (isEpicTicket(t) && t.key.isNotEmpty() && t.summary.isNotEmpty()) epicNames[t.key] = "${t.key} · ${t.summary}"
        val facets = ticketFacets(t, site.siteKey, sessionIndex, queue, now)
        for ((field, _) in FILTER_FIELDS) {
            val m = counts.getValue(field)
            for (v in facets[field].orEmpty().toSet()) m[v] = (m[v] ?: 0) + 1
        }
    }
    return FILTER_FIELDS.map { (field, label) ->
        val m = counts.getValue(field)
        val sel = view.f[field].orEmpty()
        for (v in sel) if (v !in m) m[v] = 0
        val fixed = FACET_LABELS[field]
        val values = when {
            fixed != null && field != "repo" && field != "epic" -> fixed.keys.filter { it in m }
            field == "priority" -> m.keys.sortedWith(compareBy<String> { priorityRank(it) }.thenBy { it })
            else -> m.keys.sortedWith(
                compareBy<String> { it.startsWith("-") }
                    .thenByDescending { m.getValue(it) }
                    .thenComparing(NATURAL),
            )
        }
        FilterGroup(field, label, values.map { v ->
            FilterOption(
                value = v,
                label = fixed?.get(v) ?: (if (field == "epic") epicNames[v] else null) ?: v,
                count = m[v] ?: 0,
                selected = v in sel,
            )
        })
    }
}

/** Flip one value of one field. */
fun toggleBoardFilter(view: BoardView, field: String, value: String): BoardView {
    val cur = view.f[field].orEmpty()
    val next = if (value in cur) cur - value else cur + value
    val f = view.f.toMutableMap()
    if (next.isEmpty()) f.remove(field) else f[field] = next
    return view.copy(f = f)
}

/**
 * The view as query pairs, defaults omitted — the SAME encoding as the web's
 * URL (board.js boardViewToParams), used here for the persisted preference.
 */
fun boardViewToParams(view: BoardView): List<Pair<String, String>> = buildList {
    view.q.trim().takeIf { it.isNotEmpty() }?.let { add("q" to it) }
    for ((field, _) in FILTER_FIELDS) for (v in view.f[field].orEmpty()) add(field to v)
    if (view.sort != "updated") add("sort" to view.sort)
    if (view.rev) add("rev" to "1")
    if (view.hideDone) add("done" to "0")
}

/** Inverse of [boardViewToParams]; unknown fields/sorts and oversized values drop. */
fun boardViewFromParams(pairs: List<Pair<String, String>>): BoardView {
    val get = { k: String -> pairs.firstOrNull { it.first == k }?.second }
    val sort = get("sort")?.takeIf { s -> BOARD_SORTS.any { it.key == s } } ?: "updated"
    val f = LinkedHashMap<String, List<String>>()
    for ((field, _) in FILTER_FIELDS) {
        val vals = pairs.filter { it.first == field }.map { it.second }
            .filter { it.isNotEmpty() && it.length <= VIEW_MAX_LEN }
            .distinct().take(VIEW_MAX_VALUES)
        if (vals.isNotEmpty()) f[field] = vals
    }
    return BoardView(
        q = get("q").orEmpty().take(VIEW_MAX_LEN),
        f = f,
        sort = sort,
        rev = get("rev") == "1",
        hideDone = get("done") == "0",
    )
}

/** URL-encoded form of [boardViewToParams], for storage. */
fun encodeBoardView(view: BoardView): String = boardViewToParams(view).joinToString("&") { (k, v) ->
    java.net.URLEncoder.encode(k, "UTF-8") + "=" + java.net.URLEncoder.encode(v, "UTF-8")
}

fun decodeBoardView(s: String?): BoardView {
    if (s.isNullOrEmpty()) return BoardView()
    val pairs = s.split("&").mapNotNull { part ->
        val i = part.indexOf('=')
        if (i <= 0) null else runCatching {
            java.net.URLDecoder.decode(part.substring(0, i), "UTF-8") to
                java.net.URLDecoder.decode(part.substring(i + 1), "UTF-8")
        }.getOrNull()
    }
    return boardViewFromParams(pairs)
}
