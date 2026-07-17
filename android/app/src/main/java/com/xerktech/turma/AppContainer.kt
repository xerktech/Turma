package com.xerktech.turma

import android.content.Context
import com.xerktech.turma.data.Config
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

    /** In-app self-updater (XERK-11); [installedVersion] read once from the package manager. */
    val updater = Updater(context.applicationContext, appScope, installedVersion(context))

    /** A fresh dictation session (each recording is single-use). */
    fun newDictation(): Dictation = Dictation(client, config)

    /** This build's versionName (e.g. "0.4.2"), or "0" if the package can't be read. */
    private fun installedVersion(context: Context): String = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName
    }.getOrNull() ?: "0"
}
