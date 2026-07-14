package com.xerktech.turma.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
    const val FLEET = "fleet"
    const val USAGE = "usage"
    const val ARCHIVE = "archive"
    const val SETTINGS = "settings"
    fun chat(host: String, session: String) = "chat/${enc(host)}/${enc(session)}"
    fun terminal(session: String) = "terminal/${enc(session)}"
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

@Composable
fun TurmaApp(
    container: AppContainer,
    pendingDeepLink: MainActivity.DeepLink?,
    onDeepLinkConsumed: () -> Unit,
) {
    val nav = rememberNavController()
    val settings by container.config.state.collectAsStateWithLifecycle()
    val start = if (settings.configured) Routes.FLEET else Routes.LOGIN

    // Route an FCM tap to the exact session (or host's fleet section).
    LaunchedEffect(pendingDeepLink, settings.configured) {
        val dl = pendingDeepLink ?: return@LaunchedEffect
        if (settings.configured) {
            if (!dl.host.isNullOrEmpty() && !dl.sessionId.isNullOrEmpty()) {
                nav.navigate(Routes.chat(dl.host, dl.sessionId))
            }
        }
        onDeepLinkConsumed()
    }

    NavHost(navController = nav, startDestination = start) {
        composable(Routes.LOGIN) {
            LoginScreen(onSignedIn = {
                nav.navigate(Routes.FLEET) { popUpTo(Routes.LOGIN) { inclusive = true } }
            })
        }
        composable(Routes.FLEET) {
            FleetScreen(
                onOpenChat = { host, session -> nav.navigate(Routes.chat(host, session)) },
                onUsage = { nav.navigate(Routes.USAGE) },
                onArchive = { nav.navigate(Routes.ARCHIVE) },
                onSettings = { nav.navigate(Routes.SETTINGS) },
            )
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
                onTerminal = { nav.navigate(Routes.terminal(session)) },
            )
        }
        composable(
            "terminal/{session}",
            arguments = listOf(navArgument("session") { type = NavType.StringType }),
        ) { entry ->
            val session = entry.arguments?.getString("session").orEmpty()
            TerminalScreen(sessionId = session, onBack = { nav.popBackStack() })
        }
        composable(Routes.USAGE) { UsageScreen(onBack = { nav.popBackStack() }) }
        composable(Routes.ARCHIVE) { ArchiveScreen(onBack = { nav.popBackStack() }) }
        composable(Routes.SETTINGS) {
            SettingsScreen(
                onBack = { nav.popBackStack() },
                onSignedOut = { nav.navigate(Routes.LOGIN) { popUpTo(0) } },
            )
        }
    }
}
