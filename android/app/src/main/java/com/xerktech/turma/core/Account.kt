package com.xerktech.turma.core

import com.xerktech.turma.model.Me

/**
 * Who is signed in (XERK-2553), read off the hub's `GET /api/me`. Pure, so the
 * wording is JVM-tested against the web's `nav.js` (`meLabel` /
 * `ADMIN_ONLY_NOTE`), which says the same words.
 */

/** "Signed in as <name>" for the ⋮ menu, or "" when the hub named nobody (an open hub, an older hub). */
fun meLabel(me: Me?): String = me?.name?.takeIf { it.isNotEmpty() }?.let { "Signed in as $it" } ?: ""

/**
 * An admin-only principal — the admin role and no tenant of its own — reaches no
 * host, session or ticket, and the admin panel is web-only, so the app shows
 * [ADMIN_ONLY_NOTE] instead of an empty fleet. Null (no answer, an older hub)
 * is never admin-only: the app behaves as it always did.
 */
fun isAdminOnly(me: Me?): Boolean = me?.adminOnly == true

/**
 * Whether to cover the app with the admin-only screen: the hub said admin-only
 * (it counted no host this account may drive) AND the fleet, once loaded, still
 * lists none. The fleet half keeps it live: a host enrolled after `/api/me`
 * answered lifts the screen on the next poll, with no re-read of `/api/me`.
 */
fun showAdminOnly(me: Me?, fleetLoading: Boolean, hostCount: Int): Boolean =
    isAdminOnly(me) && !fleetLoading && hostCount == 0

const val ADMIN_ONLY_NOTE =
    "This account is an administrator without a workspace of its own, so there are no hosts, " +
        "sessions or tickets to show. Sign in with a user account to work in a workspace."

/**
 * A 404 on a session's own route. Since tenancy (XERK-2534) the hub answers a
 * session on another account's host with the SAME 404 an unknown one gets, so
 * the app cannot tell "ended and gone" from "not yours" — and must not try. The
 * hub's own words stay at the end (XERK-264).
 */
fun sessionUnavailableMessage(hubWords: String): String =
    "This session isn’t available — it has ended, or it belongs to another account ($hubWords)."
