package com.xerktech.turma.push

import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.xerktech.turma.AppContainer
import com.xerktech.turma.net.DeviceRequest
import kotlinx.coroutines.launch

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

    fun unregister(context: Context, container: AppContainer) {
        if (!firebaseReady(context)) return
        runCatching {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                if (!token.isNullOrEmpty()) {
                    container.appScope.launch {
                        runCatching { container.client.api.unregisterDevice(token) }
                    }
                }
            }
        }
    }

    private fun sendToken(container: AppContainer, token: String) {
        container.appScope.launch {
            runCatching { container.client.api.registerDevice(DeviceRequest(token = token)) }
                .onFailure { Log.w(TAG, "device register failed: ${it.message}") }
        }
    }
}
