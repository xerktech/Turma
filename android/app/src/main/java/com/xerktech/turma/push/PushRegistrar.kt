package com.xerktech.turma.push

import android.content.Context
import android.util.Log
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.xerktech.turma.AppContainer
import com.xerktech.turma.net.DeviceRequest
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume
import java.util.concurrent.atomic.AtomicBoolean
import retrofit2.HttpException

/**
 * Registers this device's FCM token with the hub so alerts fan out to it, and
 * unregisters on sign-out. Fully guarded: with no google-services.json the
 * default FirebaseApp never initializes and every call here quietly no-ops, so
 * a credential-less build still runs.
 */
object PushRegistrar {
    private const val TAG = "PushRegistrar"

    /**
     * Where this device's FCM token comes from. A seam only so the unit test
     * (`PushRegistrarTest`) can drive the hub calls without Firebase; nothing in
     * production replaces [FirebaseTokens].
     */
    internal interface TokenSource {
        fun ready(context: Context): Boolean
        suspend fun current(): String?
        /** Drop the current token and return a fresh, never-registered one. */
        suspend fun rotate(): String?
    }

    internal var tokens: TokenSource = FirebaseTokens

    /** Fetch the current token and POST it to the hub (best-effort). */
    fun register(context: Context, container: AppContainer) {
        if (!tokens.ready(context)) return
        if (!container.config.current.configured) return // no hub creds yet
        container.appScope.launch {
            val token = runCatching { tokens.current() }
                .onFailure { Log.w(TAG, "token fetch failed: ${it.message}") }.getOrNull()
            if (!token.isNullOrEmpty()) registerToken(container, token)
        }
    }

    /** Called from the messaging service when FCM rotates the token. */
    fun onNewToken(context: Context, container: AppContainer, token: String) {
        if (!container.config.current.configured) return
        container.appScope.launch { registerToken(container, token) }
    }

    /**
     * Release this device's hub binding (XERK-2622). Suspends until the DELETE
     * has been answered, so the caller must clear the stored credentials only
     * AFTER this returns — a DELETE sent without them is a 401 and leaves the
     * phone bound to the account signing out. Bounded so an offline sign-out
     * still completes; a lost release is recovered by the 409 rotation below.
     */
    suspend fun unregister(context: Context, container: AppContainer) {
        if (!tokens.ready(context)) return
        val token = withTimeoutOrNull(3_000) { runCatching { tokens.current() }.getOrNull() }
        if (token.isNullOrEmpty()) return
        withTimeoutOrNull(5_000) { runCatching { container.client.api.unregisterDevice(token) } }
    }

    // At most one rotation per lost release: a fresh token can't be bound
    // elsewhere, so a 409 straight after rotating means something else is wrong
    // and retrying would just churn. Re-armed by every successful register, so
    // a later account switch can rotate again.
    // Atomic so two registers 409ing at once (launch + login) rotate only once.
    internal val rotated = AtomicBoolean(false)

    /** POST [token]; on a 409 rotate once and register the fresh token. */
    internal suspend fun registerToken(container: AppContainer, token: String) {
        runCatching { container.client.api.registerDevice(DeviceRequest(token = token, features = listOf("dismiss"))) }
            .onSuccess { rotated.set(false) }
            .onFailure {
                Log.w(TAG, "device register failed: ${it.message}")
                // 409 = the hub has this token bound to another account — the
                // sign-out that would have released it never reached the hub
                // (XERK-2622). Rotate to a fresh, unbound token and register that;
                // the hub prunes the dead one on its next send.
                if (it is HttpException && it.code() == 409 && rotated.compareAndSet(false, true)) {
                    val fresh = runCatching { tokens.rotate() }
                        .onFailure { e -> Log.w(TAG, "token rotate failed: ${e.message}") }.getOrNull()
                    if (!fresh.isNullOrEmpty()) registerToken(container, fresh)
                }
            }
    }
}

/** The production [PushRegistrar.TokenSource]: Firebase Messaging's token. */
private object FirebaseTokens : PushRegistrar.TokenSource {
    override fun ready(context: Context): Boolean =
        runCatching { FirebaseApp.getApps(context).isNotEmpty() }.getOrDefault(false)

    override suspend fun current(): String? = await { FirebaseMessaging.getInstance().token }

    override suspend fun rotate(): String? {
        val old = current()
        await { FirebaseMessaging.getInstance().deleteToken() }
        // A failed delete leaves the old (bound) token: nothing new to register.
        return current()?.takeIf { it != old }
    }

    private suspend fun <T> await(task: () -> Task<T>): T? =
        suspendCancellableCoroutine { cont ->
            runCatching {
                task().addOnSuccessListener { cont.resume(it) }
                    .addOnFailureListener { cont.resume(null) }
                    // A cancelled Task fires neither listener above; without this
                    // the caller's coroutine would never resume.
                    .addOnCanceledListener { cont.resume(null) }
            }.onFailure { cont.resume(null) }
        }
}
