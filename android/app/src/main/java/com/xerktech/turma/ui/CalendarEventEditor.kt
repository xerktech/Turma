package com.xerktech.turma.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.xerktech.turma.core.CAL_SHOW_AS
import com.xerktech.turma.core.TurmaEventDraft
import com.xerktech.turma.core.calDraftErrors
import com.xerktech.turma.core.calLongDay
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.CalendarViewModel
import com.xerktech.turma.vm.EventEditor
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/*
 * The full-screen editor for a Turma-created calendar event (XERK-2972, epic
 * XERK-2967): the fields the hub's record holds — title, required / optional
 * attendees, start / end, all-day, time zone, location, online + join link,
 * details, show-as, categories, private, and the orgs it belongs to (one or
 * more). Repeat is a placeholder until recurring events land (XERK-2969).
 * Saving is the view model's; a refusal stays on screen in the hub's words, and
 * a 409 (changed since opened) reloads the editor from the event as it is now.
 */

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
internal fun CalendarEventEditor(
    modifier: Modifier,
    ed: EventEditor,
    orgOptions: List<Pair<String, String>>,
    cvm: CalendarViewModel,
) {
    val locale = Locale.getDefault()
    val busy by cvm.eventBusy.collectAsStateWithLifecycle()
    val d = ed.draft
    fun set(next: TurmaEventDraft) = cvm.editDraft(next)
    val err = ed.error
    var tried by remember(ed.base) { mutableStateOf(false) }
    var picker by remember(ed.base) { mutableStateOf("") }   // "startDate" | "endDate" | "startTime" | "endTime"
    var confirmDiscard by remember { mutableStateOf(false) }
    // Closing a changed draft asks first: a Back meant for the keyboard otherwise lost it (QA).
    fun close() { if (ed.dirty) confirmDiscard = true else cvm.closeEditor() }
    BackHandler(enabled = picker.isEmpty() && !confirmDiscard) { close() }

    val problems = calDraftErrors(d)
    fun save() {
        tried = true
        if (problems.isNotEmpty()) return
        cvm.saveEditor()
    }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text("Discard this event?") },
            text = { Text("What you typed is not saved.") },
            confirmButton = {
                TextButton({ confirmDiscard = false; cvm.closeEditor() }, Modifier.testTag("cal-editor-discard")) { Text("Discard") }
            },
            dismissButton = { TextButton({ confirmDiscard = false }) { Text("Keep editing") } },
        )
    }

    Column(modifier.fillMaxSize().testTag("cal-editor")) {
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(::close, Modifier.testTag("cal-editor-close")) { Icon(Icons.Filled.Close, "Discard and close") }
            Text(
                if (d.editing) "Edit event" else "New event", Modifier.weight(1f).semantics { heading() },
                style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold,
            )
            Button(::save, Modifier.testTag("cal-editor-save"), enabled = !busy) { Text(if (busy) "Saving…" else "Save") }
        }
        Column(
            Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (err.isNotEmpty()) Text(err, Modifier.testTag("cal-editor-err"), color = TurmaColors.critical)
            if (tried && problems.isNotEmpty()) {
                for (p in problems) Text(p, color = TurmaColors.critical, style = MaterialTheme.typography.bodySmall)
            }
            OutlinedTextField(
                d.subject, { set(d.copy(subject = it)) }, Modifier.fillMaxWidth().testTag("cal-ed-title"),
                label = { Text("Title") }, singleLine = true,
            )
            OutlinedTextField(
                d.required, { set(d.copy(required = it)) }, Modifier.fillMaxWidth().testTag("cal-ed-required"),
                label = { Text("Required attendees") }, placeholder = { Text("Ann <ann@example.com>, bo@example.com") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            )
            OutlinedTextField(
                d.optional, { set(d.copy(optional = it)) }, Modifier.fillMaxWidth().testTag("cal-ed-optional"),
                label = { Text("Optional attendees") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            )
            HorizontalDivider()
            CheckRow("All day", d.allDay, { set(d.copy(allDay = it)) }, Modifier.testTag("cal-ed-allday"))
            WhenRow("Starts", d.startDate, d.startTime, d.allDay, locale, "start", { picker = it })
            WhenRow("Ends", d.endDate, d.endTime, d.allDay, locale, "end", { picker = it })
            OutlinedTextField(
                d.timeZone, { set(d.copy(timeZone = it)) }, Modifier.fillMaxWidth().testTag("cal-ed-tz"),
                label = { Text("Time zone") }, singleLine = true,
            )
            // Recurrence is the next child of the epic (XERK-2969): shown, not yet editable.
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Repeat", Modifier.width(84.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("Does not repeat", Modifier.testTag("cal-ed-repeat"), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            HorizontalDivider()
            OutlinedTextField(
                d.location, { set(d.copy(location = it)) }, Modifier.fillMaxWidth().testTag("cal-ed-location"),
                label = { Text("Location") }, singleLine = true,
            )
            CheckRow("Online meeting", d.online, { set(d.copy(online = it)) }, Modifier.testTag("cal-ed-online"))
            if (d.online) {
                OutlinedTextField(
                    d.joinUrl, { set(d.copy(joinUrl = it)) }, Modifier.fillMaxWidth().testTag("cal-ed-join"),
                    label = { Text("Join link (https://)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
            }
            OutlinedTextField(
                d.body, { set(d.copy(body = it)) }, Modifier.fillMaxWidth().height(140.dp).testTag("cal-ed-body"),
                label = { Text("Details") },
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Show as", Modifier.width(84.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Picker(
                    CAL_SHOW_AS.firstOrNull { it.first == d.busy }?.second ?: "Busy", CAL_SHOW_AS,
                    { set(d.copy(busy = it)) }, Modifier.testTag("cal-ed-busy"),
                )
            }
            OutlinedTextField(
                d.categories, { set(d.copy(categories = it)) }, Modifier.fillMaxWidth().testTag("cal-ed-categories"),
                label = { Text("Categories (comma-separated)") }, singleLine = true,
            )
            CheckRow("Private", d.private, { set(d.copy(private = it)) }, Modifier.testTag("cal-ed-private"))
            HorizontalDivider()
            Text("Orgs", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(
                "Every org picked sees this event; it shows once on the all-orgs view.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            // An org the event holds that this phone no longer lists stays pickable, so an edit never drops it silently.
            val opts = orgOptions + d.orgs.filter { o -> orgOptions.none { it.first == o } }.map { it to it }
            if (opts.isEmpty()) {
                Text("No org reports a host yet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for ((key, label) in opts) {
                    FilterChip(
                        selected = key in d.orgs,
                        onClick = { set(d.copy(orgs = if (key in d.orgs) d.orgs - key else d.orgs + key)) },
                        label = { Text(label) },
                        modifier = Modifier.testTag("cal-ed-org-$key"),
                    )
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    when (picker) {
        "startDate", "endDate" -> {
            val cur = if (picker == "startDate") d.startDate else d.endDate
            val state = rememberDatePickerState(initialSelectedDateMillis = cur.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
            DatePickerDialog(
                onDismissRequest = { picker = "" },
                confirmButton = {
                    TextButton({
                        state.selectedDateMillis?.let { ms ->
                            val day = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate()
                            set(if (picker == "startDate") moveStart(d, day, d.startTime) else d.copy(endDate = day))
                        }
                        picker = ""
                    }) { Text("OK") }
                },
                dismissButton = { TextButton({ picker = "" }) { Text("Cancel") } },
            ) { DatePicker(state) }
        }
        "startTime", "endTime" -> {
            val cur = if (picker == "startTime") d.startTime else d.endTime
            val state = rememberTimePickerState(cur.hour, cur.minute)
            AlertDialog(
                onDismissRequest = { picker = "" },
                confirmButton = {
                    TextButton({
                        val t = LocalTime.of(state.hour, state.minute)
                        set(if (picker == "startTime") moveStart(d, d.startDate, t) else d.copy(endTime = t))
                        picker = ""
                    }, Modifier.testTag("cal-ed-time-ok")) { Text("OK") }
                },
                dismissButton = { TextButton({ picker = "" }) { Text("Cancel") } },
                text = { TimePicker(state) },
            )
        }
    }
}

/** Moving the start keeps the event's length, as every calendar does. */
private fun moveStart(d: TurmaEventDraft, day: LocalDate, time: LocalTime): TurmaEventDraft {
    val len = java.time.Duration.between(d.startDate.atTime(d.startTime), d.endDate.atTime(d.endTime))
    val end = day.atTime(time).plus(if (len.isNegative) java.time.Duration.ZERO else len)
    return d.copy(startDate = day, startTime = time, endDate = end.toLocalDate(), endTime = end.toLocalTime())
}

@Composable
private fun WhenRow(
    label: String,
    day: LocalDate,
    time: LocalTime,
    allDay: Boolean,
    locale: Locale,
    which: String,
    onPick: (String) -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, Modifier.width(84.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        GhostButton(calLongDay(day, locale), { onPick("${which}Date") }, Modifier.testTag("cal-ed-$which-date"))
        if (!allDay) {
            GhostButton(DateTimeFormatter.ofPattern("h:mm a", locale).format(time), { onPick("${which}Time") }, Modifier.testTag("cal-ed-$which-time"))
        }
    }
}
