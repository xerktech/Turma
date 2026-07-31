package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.net.Updater
import kotlinx.coroutines.flow.StateFlow

/** Exposes the app-global [Updater] (in-app self-update, XERK-11) to the UI. */
class UpdateViewModel(app: Application) : AndroidViewModel(app) {
    private val updater = (app as TurmaApplication).container.updater
    val state: StateFlow<Updater.State> = updater.state

    fun check() = updater.check()
    fun act() = updater.act()
    fun dismiss() = updater.dismiss()
}
