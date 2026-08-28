package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.model.DshTrajectory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The dsh session Trajectory (XERK-498) — the read-only view that replaces the
 * ttyd terminal for a HEADLESS dsh session (there is no pty to attach to). It
 * fetches `GET /api/dsh/<tid>/trajectory`, which the hub parses out of the dsh
 * native event log in the raw archive (`turma/archive.js` dshTrajectory). Web
 * twin: `sessions.html` `loadTrajectory`/`renderTrajectory`.
 *
 * The three outcomes are kept distinct because they mean different things to the
 * operator: [data] is the trajectory; [notSynced] is a 404 (the running session's
 * log has not reached the archive yet — retry, it will), which is the ORDINARY
 * case for a just-opened session; [error] is anything else (unreachable hub, a
 * non-404 status), which retrying will not fix on its own.
 */
class TrajectoryViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container

    data class Ui(
        val loading: Boolean = false,
        val data: DshTrajectory? = null,
        /** A 404 — the native log has not synced to the archive yet (retry). */
        val notSynced: Boolean = false,
        /** Anything other than a 404 (unreachable hub, a non-404 status). */
        val error: String? = null,
    )

    private val _state = MutableStateFlow(Ui())
    val state: StateFlow<Ui> = _state

    /** The last id a load has committed to (in-flight or settled), so a second
     *  non-force load of the same id — the screen re-runs its `LaunchedEffect` on
     *  every re-entry — neither re-fetches nor un-settles a resolved outcome.
     *  The ↻ Refresh button (force=true) is the retry path. Keyed on the id, not
     *  on `data`, so a 404/error is idempotent too, not just a success. */
    private var loadedId: String? = null

    /**
     * Load the trajectory for [transcriptId]. Idempotent per id unless [force]:
     * a re-open of the same session that already loaded does not re-fetch, but
     * the ↻ Refresh button and a 404-retry pass force=true. A blank id (an older
     * agent that reports no transcript id) is a terminal "nothing to show".
     */
    fun load(transcriptId: String, force: Boolean = false) {
        if (transcriptId.isBlank()) {
            _state.update { Ui(error = "This session has no transcript id yet.") }
            return
        }
        if (!force && loadedId == transcriptId) return
        loadedId = transcriptId
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val res = runCatching { container.client.api.dshTrajectory(transcriptId) }
            val resp = res.getOrNull()
            _state.update {
                when {
                    resp == null -> it.copy(loading = false, error = "Couldn't reach the hub for the trajectory.")
                    resp.code() == 404 -> it.copy(loading = false, notSynced = true, data = null, error = null)
                    resp.isSuccessful && resp.body() != null ->
                        it.copy(loading = false, data = resp.body(), notSynced = false, error = null)
                    else -> it.copy(loading = false, error = "Couldn't load the trajectory (HTTP ${resp.code()}).")
                }
            }
        }
    }
}
