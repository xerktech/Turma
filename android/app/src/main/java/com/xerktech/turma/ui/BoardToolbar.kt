package com.xerktech.turma.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SwapVert
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.xerktech.turma.core.BOARD_SORTS
import com.xerktech.turma.core.BoardView
import com.xerktech.turma.core.FilterGroup
import com.xerktech.turma.core.boardSortOf
import com.xerktech.turma.core.boardViewFilterCount
import com.xerktech.turma.core.toggleBoardFilter
import kotlinx.coroutines.delay

/**
 * The board's one-row toolbar under the header — the web board bar's search /
 * Filters / Sort (board.html `.board-tools`). Badge-only on the phone: active
 * filters show as a count on the filter button, never as a second row of chips.
 */
@Composable
fun BoardToolbar(
    view: BoardView,
    onView: (BoardView) -> Unit,
    onOpenFilters: () -> Unit,
) {
    // The field types locally and commits after a short pause, like the web's
    // 150ms debounce, so each keystroke doesn't re-filter the board.
    var text by remember { mutableStateOf(view.q) }
    val latestView by rememberUpdatedState(view)
    LaunchedEffect(view.q) { if (view.q != text.take(200)) text = view.q }
    LaunchedEffect(text) {
        if (text.take(200) == latestView.q) return@LaunchedEffect
        delay(150)
        onView(latestView.copy(q = text.take(200)))
    }
    val focus = LocalFocusManager.current
    val filterCount = boardViewFilterCount(view)
    var sortOpen by remember { mutableStateOf(false) }
    val sortOn = view.sort != "updated" || view.rev
    val accent = MaterialTheme.colorScheme.primary
    val onAccentSoft = accent.copy(alpha = 0.14f)

    Row(
        Modifier.fillMaxWidth().padding(start = 12.dp, end = 8.dp, top = 2.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            Modifier
                .weight(1f)
                .height(44.dp)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(22.dp))
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Search, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(10.dp))
            Box(Modifier.weight(1f)) {
                if (text.isEmpty()) {
                    Text(
                        "Search tickets",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                BasicTextField(
                    value = text,
                    onValueChange = { text = it.take(200) },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(accent),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (text.isNotEmpty()) {
                IconButton(
                    onClick = { text = ""; onView(view.copy(q = "")) },
                    modifier = Modifier.size(28.dp),
                ) { Icon(Icons.Filled.Close, "Clear search", Modifier.size(18.dp)) }
            }
        }
        IconButton(
            onClick = onOpenFilters,
            colors = if (filterCount > 0) IconButtonDefaults.iconButtonColors(containerColor = onAccentSoft, contentColor = accent)
            else IconButtonDefaults.iconButtonColors(),
        ) {
            BadgedBox(badge = { if (filterCount > 0) Badge { Text("$filterCount") } }) {
                Icon(Icons.Filled.FilterList, if (filterCount > 0) "Filters, $filterCount active" else "Filters")
            }
        }
        Box {
            IconButton(
                onClick = { sortOpen = true },
                colors = if (sortOn) IconButtonDefaults.iconButtonColors(containerColor = onAccentSoft, contentColor = accent)
                else IconButtonDefaults.iconButtonColors(),
            ) { Icon(Icons.Filled.SwapVert, "Sort: ${boardSortOf(view).label}") }
            DropdownMenu(expanded = sortOpen, onDismissRequest = { sortOpen = false }) {
                Text(
                    "SORT BY",
                    Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val cur = boardSortOf(view)
                for (s in BOARD_SORTS) {
                    SortItem(s.label, s.key == cur.key) { onView(view.copy(sort = s.key, rev = false)); sortOpen = false }
                }
                HorizontalDivider(Modifier.padding(vertical = 4.dp))
                SortItem(cur.natural, !view.rev) { onView(view.copy(rev = false)); sortOpen = false }
                SortItem(cur.reversed, view.rev) { onView(view.copy(rev = true)); sortOpen = false }
            }
        }
    }
}

@Composable
private fun SortItem(label: String, selected: Boolean, onClick: () -> Unit) {
    DropdownMenuItem(
        text = {
            Text(
                label,
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            )
        },
        trailingIcon = if (selected) {
            { Icon(Icons.Filled.Check, null, tint = MaterialTheme.colorScheme.primary) }
        } else null,
        onClick = onClick,
    )
}

/**
 * Every filter, as chip groups in a bottom sheet — the web's Filters popover
 * (board.js boardFilterPanelHtml). Options come from the tickets in scope, each
 * with its count; choosing one applies at once, the button just closes.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun BoardFilterSheet(
    groups: List<FilterGroup>,
    view: BoardView,
    shown: Int,
    total: Int,
    onView: (BoardView) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp, 0.dp, 20.dp, 32.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Filters", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                if (boardViewFilterCount(view) > 0) {
                    TextButton(onClick = { onView(view.copy(f = emptyMap())) }) { Text("Clear all") }
                }
            }
            for (g in groups) {
                if (g.options.isEmpty()) continue
                Text(
                    g.label.uppercase(),
                    Modifier.padding(top = 8.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    for (o in g.options) {
                        FilterChip(
                            selected = o.selected,
                            onClick = { onView(toggleBoardFilter(view, g.field, o.value)) },
                            label = {
                                Text(
                                    if (o.count > 0) "${o.label}  ${o.count}" else o.label,
                                    maxLines = 1,
                                )
                            },
                            leadingIcon = if (o.selected) {
                                { Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) }
                            } else null,
                        )
                    }
                }
            }
            if (groups.all { it.options.isEmpty() }) {
                Text("No tickets to filter", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Show Done column", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                Switch(checked = !view.hideDone, onCheckedChange = { onView(view.copy(hideDone = !it)) })
            }
            Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
                Text(if (shown == total) "Show all $total tickets" else "Show $shown of $total tickets")
            }
        }
    }
}
