package com.xerktech.turma.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.xerktech.turma.AppContainer
import com.xerktech.turma.MainActivity
import com.xerktech.turma.push.PushRegistrar
import java.net.URLEncoder

object Routes {
    const val LOGIN = "login"
    const val ARCHIVE = "archive"
    fun chat(host: String, session: String) = "chat/${enc(host)}/${enc(session)}"
    fun terminal(host: String, session: String) = "terminal/${enc(host)}/${enc(session)}"
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

/**
 * The sign-out action, provided around the NavHost so the shared ScreenHeader can
 * offer it on every top-level screen (the web has "Sign out" in its nav on every
 * page) without threading a callback through each screen. Default no-op keeps
 * previews/tests happy.
 */
val LocalSignOut = staticCompositionLocalOf<() -> Unit> { {} }

@Composable
fun TurmaApp(
    container: AppContainer,
    wide: Boolean,
    pendingDeepLink: MainActivity.DeepLink?,
    onDeepLinkConsumed: () -> Unit,
) {
    val nav = rememberNavController()
    val ctx = LocalContext.current
    val settings by container.config.state.collectAsStateWithLifecycle()
    val start = if (settings.configured) TopDest.DASHBOARD.route else Routes.LOGIN

    // Unregister push, drop the stored credentials, and return to the login
    // screen clearing the whole back stack (so Back can't re-enter the app).
    val signOut: () -> Unit = {
        PushRegistrar.unregister(ctx, container)
        container.config.clear()
        nav.navigate(Routes.LOGIN) {
            popUpTo(0) { inclusive = true }
            launchSingleTop = true
        }
    }

    // Route an FCM tap to the exact session once we're signed in.
    LaunchedEffect(pendingDeepLink, settings.configured) {
        val dl = pendingDeepLink ?: return@LaunchedEffect
        if (settings.configured && !dl.host.isNullOrEmpty() && !dl.sessionId.isNullOrEmpty()) {
            nav.navigate(Routes.chat(dl.host, dl.sessionId))
        }
        onDeepLinkConsumed()
    }

    // Switch top-level tabs, keeping a single back-stack entry per tab.
    val goTab: (TopDest) -> Unit = { dest ->
        nav.navigate(dest.route) {
            popUpTo(TopDest.DASHBOARD.route) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    CompositionLocalProvider(LocalSignOut provides signOut) {
    NavHost(navController = nav, startDestination = start) {
        composable(Routes.LOGIN) {
            LoginScreen(onSignedIn = {
                nav.navigate(TopDest.DASHBOARD.route) { popUpTo(Routes.LOGIN) { inclusive = true } }
            })
        }
        composable(TopDest.DASHBOARD.route) {
            MainScaffold(TopDest.DASHBOARD, goTab) { m ->
                FleetScreen(onOpenChat = { h, s -> nav.navigate(Routes.chat(h, s)) }, modifier = m)
            }
        }
        composable(TopDest.SESSIONS.route) {
            // Sessions is the one adaptive screen: single-pane list (→ full-screen
            // chat) when narrow, list-detail two-pane when wide. It owns its own
            // scaffold/bottom-nav so it can drop the nav on a compact chat.
            SessionsRoute(
                wide = wide,
                onNavigate = goTab,
                onTerminal = { h, s -> nav.navigate(Routes.terminal(h, s)) },
                onOpenArchive = { nav.navigate(Routes.ARCHIVE) },
            )
        }
        composable(TopDest.BOARD.route) {
            MainScaffold(TopDest.BOARD, goTab) { m -> BoardScreen(modifier = m) }
        }
        composable(TopDest.USAGE.route) {
            MainScaffold(TopDest.USAGE, goTab) { m -> UsageScreen(modifier = m) }
        }
        composable(
            "chat/{host}/{session}",
            arguments = listOf(
                navArgument("host") { type = NavType.StringType },
                navArgument("session") { type = NavType.StringType },
            ),
        ) { entry ->
            val host = entry.arguments?.getString("host").orEmpty()
            val session = entry.arguments?.getString("session").orEmpty()
            ChatScreen(
                host = host,
                sessionId = session,
                onBack = { nav.popBackStack() },
                onTerminal = { nav.navigate(Routes.terminal(host, session)) },
            )
        }
        composable(
            "terminal/{host}/{session}",
            arguments = listOf(
                navArgument("host") { type = NavType.StringType },
                navArgument("session") { type = NavType.StringType },
            ),
        ) { entry ->
            val host = entry.arguments?.getString("host").orEmpty()
            val session = entry.arguments?.getString("session").orEmpty()
            TerminalScreen(host = host, sessionId = session, onBack = { nav.popBackStack() })
        }
        // Full-history archive + FTS search. The web reaches this from the
        // Sessions sidebar's "Search all session history…" box; here it's the
        // search action on the Sessions header (see SessionsRoute onOpenArchive).
        composable(Routes.ARCHIVE) {
            ArchiveScreen(onBack = { nav.popBackStack() })
        }
    }
    }
}
