package com.xerktech.turma.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import android.widget.Toast
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.core.BoardSite
import com.xerktech.turma.core.ageStr
import com.xerktech.turma.core.autoStartOn
import com.xerktech.turma.core.effectiveOrg
import com.xerktech.turma.core.mergeSites
import com.xerktech.turma.core.orgColorMap
import com.xerktech.turma.core.orgName
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.OrgViewModel

/**
 * The one org-scoping control (XERK-62), carried by the shared [ScreenHeader] so
 * it is on all four top-level screens — the web mounts it in the site header's
 * `#hdrOrg` slot for the same reason. It replaced the board's own chip strip:
 * an org partitions the whole fleet, not just the Kanban, so the scope belongs
 * somewhere every screen can see it.
 *
 * A button reading the current scope, opening a menu of "All orgs" + one row per
 * reporting org. Laid out as a Material dropdown rather than the web's popover
 * of divided pills — on a phone a chip strip in the header would crowd out the
 * title, and a menu row has room for the ticket count, the offline note and the
 * per-org auto-start switch the board chips used to carry (XERK-41).
 *
 * Nothing to scope by until some host reports a tracker org, so with no orgs it
 * renders nothing at all (the web's slot collapses the same way) rather than
 * offering a menu whose only entry is "All orgs".
 */
@Composable
fun OrgFilterAction(vm: OrgViewModel = viewModel()) {
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val stored by vm.org.collectAsStateWithLifecycle()
    val sites = remember(fleet.agents) { mergeSites(fleet.agents) }
    if (sites.isEmpty()) return

    val context = LocalContext.current
    LaunchedEffect(Unit) { vm.messages.collect { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() } }

    // One assignment of unique per-org colors over the whole org set, so an org's
    // dot here is the color its cards and columns paint elsewhere (XERK-48).
    val colorMap = remember(sites) { orgColorMap(sites.map { it.siteKey }) }
    val key = effectiveOrg(stored, sites)
    val scoped = sites.firstOrNull { it.siteKey == key }
    val now = fleet.now.takeIf { it > 0 } ?: System.currentTimeMillis()
    var open by remember { mutableStateOf(false) }

    Box {
        TextButton(onClick = { open = true }) {
            if (scoped != null) {
                OrgDot(orgColor(colorMap, scoped.siteKey))
            }
            Text(
                if (scoped != null) orgName(scoped.siteKey, scoped.orgName) else "All orgs",
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                // Capped so a long org name can't push the title or the actions
                // off a phone header — the full key is one tap away in the menu.
                modifier = Modifier
                    .padding(start = if (scoped != null) 6.dp else 0.dp)
                    .widthIn(max = 120.dp),
            )
            Icon(Icons.Filled.ArrowDropDown, "Filter by org")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { OrgRowLabel("All orgs", null, sites.sumOf { it.tickets.size }, null, key.isBlank()) },
                onClick = { open = false; vm.setOrg("") },
            )
            for (s in sites) {
                OrgMenuRow(
                    site = s,
                    color = orgColor(colorMap, s.siteKey),
                    active = key == s.siteKey,
                    now = now,
                    autoOn = autoStartOn(fleet.autoStartOrgs, s.siteKey),
                    onToggleAuto = { vm.setAutoStart(s.siteKey, it) },
                    onPick = { open = false; vm.setOrg(s.siteKey) },
                )
            }
        }
    }
}

/**
 * One org's row: the scope pick, plus its auto-start switch as the trailing
 * control (the second segment of the old divided chip). The switch handles its
 * own tap, so touching it flips auto-start without also re-scoping the fleet.
 */
@Composable
private fun OrgMenuRow(
    site: BoardSite,
    color: Color,
    active: Boolean,
    now: Long,
    autoOn: Boolean,
    onToggleAuto: (Boolean) -> Unit,
    onPick: () -> Unit,
) {
    // An org whose every host is offline is still shown (its last report is the
    // truth we have), flagged with how stale that report is.
    val age = if (site.online) "" else ageStr(site.fetchedAt, now)
    val note = when {
        site.online -> null
        age.isBlank() -> "⚠ offline"
        else -> "⚠ offline · synced $age ago"
    }
    DropdownMenuItem(
        text = { OrgRowLabel(orgName(site.siteKey, site.orgName), color, site.tickets.size, note, active) },
        onClick = onPick,
        trailingIcon = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    "auto",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Switch(
                    checked = autoOn,
                    onCheckedChange = onToggleAuto,
                    colors = SwitchDefaults.colors(checkedTrackColor = color),
                )
            }
        },
    )
}

/** Dot + name + ticket count + offline note, shared by the "All orgs" row. */
@Composable
private fun OrgRowLabel(label: String, color: Color?, count: Int, note: String?, active: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (color != null) OrgDot(color)
        Text(
            label,
            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text("$count", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (note != null) Text(note, style = MaterialTheme.typography.labelSmall, color = TurmaColors.waiting)
    }
}

@Composable
private fun OrgDot(color: Color) {
    Box(Modifier.size(9.dp).clip(CircleShape).background(color))
}

private fun orgColor(colorMap: Map<String, Int>, siteKey: String): Color =
    TurmaColors.series[(colorMap[siteKey] ?: 0) % TurmaColors.series.size]
