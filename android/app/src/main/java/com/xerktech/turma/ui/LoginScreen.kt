package com.xerktech.turma.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.R
import com.xerktech.turma.vm.LoginViewModel

@Composable
fun LoginScreen(onSignedIn: () -> Unit, vm: LoginViewModel = viewModel()) {
    val ui by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(ui.done) { if (ui.done) onSignedIn() }

    var url by rememberSaveable { mutableStateOf(vm.current.hubUrl) }
    var user by rememberSaveable { mutableStateOf(vm.current.user) }
    var pass by rememberSaveable { mutableStateOf("") }

    Box(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState()).padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            modifier = Modifier.widthIn(max = 360.dp).fillMaxWidth()
                .shadow(14.dp, RoundedCornerShape(14.dp), clip = false),
            shape = RoundedCornerShape(14.dp),
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        ) {
            Column(Modifier.padding(28.dp, 30.dp, 28.dp, 26.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    // The launcher icon is an adaptive-icon XML (not loadable via
                    // painterResource), so stack its two vector layers to render
                    // the same rounded favicon tile the web login shows.
                    Box(Modifier.size(40.dp).clip(RoundedCornerShape(10.dp))) {
                        Image(painterResource(R.drawable.ic_launcher_background), null, Modifier.matchParentSize())
                        Image(painterResource(R.drawable.ic_launcher_foreground), null, Modifier.matchParentSize())
                    }
                    Text("Turma", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                }
                Text(
                    "Sign in to manage your agent fleet.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 10.dp, bottom = 22.dp),
                )

                ui.error?.let { ErrorBox(it) }

                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    WebField(url, { url = it }, "Hub URL", keyboardType = KeyboardType.Uri)
                    WebField(user, { user = it }, "Username")
                    WebField(pass, { pass = it }, "Password", password = true)
                    PrimaryButton(
                        if (ui.busy) "Signing in…" else "Sign in",
                        onClick = { vm.signIn(url, user, pass) },
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                        enabled = !ui.busy && url.isNotBlank() && user.isNotBlank() && pass.isNotBlank(),
                    )
                }

                Text(
                    "Single-user access",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
                )
            }
        }
    }
}

/** The web login's error box: critical text on a soft critical wash with a border. */
@Composable
private fun ErrorBox(message: String) {
    val c = MaterialTheme.colorScheme.error
    Box(
        Modifier.fillMaxWidth()
            .padding(bottom = 14.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(c.copy(alpha = 0.10f))
            .border(1.dp, c.copy(alpha = 0.28f), RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Text(message, color = c, style = MaterialTheme.typography.bodySmall)
    }
}

/** Web-style field: a small bold label above a filled, hairline-bordered input. */
@Composable
private fun WebField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    password: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    var focused by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Box(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                .border(
                    1.dp,
                    if (focused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                    RoundedCornerShape(8.dp),
                )
                .padding(horizontal = 12.dp, vertical = 12.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = LocalTextStyle.current.copy(
                    color = MaterialTheme.colorScheme.onSurface,
                    fontSize = 15.sp,
                ),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
                keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else keyboardType),
                modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused },
            )
        }
    }
}
