package com.xerktech.turma

import android.content.Context
import com.xerktech.turma.data.Config
import com.xerktech.turma.data.DraftStore
import com.xerktech.turma.data.ModelSwitchStore
import com.xerktech.turma.data.OrgFilter
import com.xerktech.turma.data.TextSizePref
import com.xerktech.turma.net.Dictation
import com.xerktech.turma.net.FleetRepository
import com.xerktech.turma.net.HubClient
import com.xerktech.turma.net.LiveTail
import com.xerktech.turma.net.Updater
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Manual dependency container (no DI framework). One instance per process, held
 * by [TurmaApplication] and reached from ViewModels via the Application.
 */
class AppContainer(context: Context) {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val config = Config.get(context)
    val client = HubClient(config)
    val fleet = FleetRepository(client, config, appScope)
    val liveTail = LiveTail(client, config)

    /**
     * The org scope (XERK-62). Held here rather than in a ViewModel because it is
     * ONE value shared by every screen — the header control sets it, the fleet,
     * sessions, board and usage screens all read it.
     */
    val org = OrgFilter(context.applicationContext)

    /**
     * Per-session compose drafts (XERK-122). Here for the same reason as [org]:
     * the chat screen and the terminal screen each have a compose box over the
     * SAME session, and the half-typed message has to survive walking between
     * them — so it can't live in either screen's own state.
     */
    val drafts = DraftStore()

    /**
     * In-flight model-source switches (XERK-246). Here for the same reason as
     * [drafts]: the chat ViewModel is scoped to its nav entry, so a memo kept
     * there died the moment you walked back to the session list — mid-switch,
     * which is exactly when the memo is doing its job.
     */
    val modelSwitches = ModelSwitchStore()

    /**
     * The in-session chat text size (XERK-144). Here for the same reason as [org]:
     * it is ONE value shared by every chat — set from any session's settings menu,
     * read by every transcript renderer (live chat, archive, ended review).
     */
    val textSize = TextSizePref(context.applicationContext)

    /** In-app self-updater (XERK-11); [installedVersion] read once from the package manager. */
    val updater = Updater(context.applicationContext, appScope, installedVersion(context))

    /** A fresh dictation session (each recording is single-use). */
    fun newDictation(): Dictation = Dictation(client, config)

    /** This build's versionName (e.g. "0.4.2"), or "0" if the package can't be read. */
    private fun installedVersion(context: Context): String = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName
    }.getOrNull() ?: "0"
}
