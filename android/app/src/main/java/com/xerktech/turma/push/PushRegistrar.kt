package com.xerktech.turma.push

import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.xerktech.turma.AppContainer
import com.xerktech.turma.net.DeviceRequest
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume
import retrofit2.HttpException

/**
 * Registers this device's FCM token with the hub so alerts fan out to it, and
 * unregisters on sign-out. Fully guarded: with no google-services.json the
 * default FirebaseApp never initializes and every call here quietly no-ops, so
 * a credential-less build still runs.
 */
object PushRegistrar {
    private const val TAG = "PushRegistrar"

    private fun firebaseReady(context: Context): Boolean =
        runCatching { FirebaseApp.getApps(context).isNotEmpty() }.getOrDefault(false)

    /** Fetch the current token and POST it to the hub (best-effort). */
    fun register(context: Context, container: AppContainer) {
        if (!firebaseReady(context)) return
        if (!container.config.current.configured) return // no hub creds yet
        runCatching {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                if (!token.isNullOrEmpty()) sendToken(container, token)
            }
        }.onFailure { Log.w(TAG, "token fetch failed: ${it.message}") }
    }

    /** Called from the messaging service when FCM rotates the token. */
    fun onNewToken(context: Context, container: AppContainer, token: String) {
        if (!container.config.current.configured) return
        sendToken(container, token)
    }

    /**
     * Release this device's hub binding (XERK-2622). Suspends until the DELETE
     * has been answered, so the caller must clear the stored credentials only
     * AFTER this returns — a DELETE sent without them is a 401 and leaves the
     * phone bound to the account signing out. Bounded so an offline sign-out
     * still completes; a lost release is recovered by the 409 rotation below.
     */
    suspend fun unregister(context: Context, container: AppContainer) {
        if (!firebaseReady(context)) return
        val token = withTimeoutOrNull(3_000) {
            suspendCancellableCoroutine<String?> { cont ->
                runCatching {
                    FirebaseMessaging.getInstance().token
                        .addOnSuccessListener { cont.resume(it) }
                        .addOnFailureListener { cont.resume(null) }
                }.onFailure { cont.resume(null) }
            }
        }
        if (token.isNullOrEmpty()) return
        withTimeoutOrNull(5_000) { runCatching { container.client.api.unregisterDevice(token) } }
    }

    // At most one rotation per lost release: a fresh token can't be bound
    // elsewhere, so a 409 straight after rotating means something else is wrong
    // and retrying would just churn. Re-armed by every successful register, so
    // a later account switch can rotate again.
    @Volatile private var rotated = false

    private fun sendToken(container: AppContainer, token: String) {
        container.appScope.launch {
            runCatching { container.client.api.registerDevice(DeviceRequest(token = token, features = listOf("dismiss"))) }
                .onSuccess { rotated = false }
                .onFailure {
                    Log.w(TAG, "device register failed: ${it.message}")
                    // 409 = the hub has this token bound to another account — the
                    // sign-out that would have released it never reached the hub
                    // (XERK-2622). Rotate to a fresh, unbound token and register that;
                    // the hub prunes the dead one on its next send.
                    if (it is HttpException && it.code() == 409 && !rotated) {
                        rotated = true
                        rotateToken(container)
                    }
                }
        }
    }

    private fun rotateToken(container: AppContainer) {
        runCatching {
            val fm = FirebaseMessaging.getInstance()
            fm.deleteToken().addOnSuccessListener {
                fm.token.addOnSuccessListener { fresh ->
                    if (!fresh.isNullOrEmpty()) sendToken(container, fresh)
                }
            }
        }.onFailure { Log.w(TAG, "token rotate failed: ${it.message}") }
    }
}
