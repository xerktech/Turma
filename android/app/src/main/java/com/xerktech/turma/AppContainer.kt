package com.xerktech.turma

import android.content.Context
import com.xerktech.turma.data.Config
import com.xerktech.turma.net.Dictation
import com.xerktech.turma.net.FleetRepository
import com.xerktech.turma.net.HubClient
import com.xerktech.turma.net.LiveTail
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

    /** A fresh dictation session (each recording is single-use). */
    fun newDictation(): Dictation = Dictation(client, config)
}
