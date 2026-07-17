package com.xerktech.turma.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.xerktech.turma.AppContainer
import com.xerktech.turma.MainActivity
import java.net.URLEncoder

object Routes {
    const val LOGIN = "login"
    fun chat(host: String, session: String) = "chat/${enc(host)}/${enc(session)}"
    fun terminal(host: String, session: String) = "terminal/${enc(host)}/${enc(session)}"
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

@Composable
fun TurmaApp(
    container: AppContainer,
    wide: Boolean,
    pendingDeepLink: MainActivity.DeepLink?,
    onDeepLinkConsumed: () -> Unit,
) {
    val nav = rememberNavController()
    val settings by container.config.state.collectAsStateWithLifecycle()
    val start = if (settings.configured) TopDest.DASHBOARD.route else Routes.LOGIN

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
    }
}
