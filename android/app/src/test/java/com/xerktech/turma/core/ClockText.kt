package com.xerktech.turma.core

import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * The separator the JDK's own US short-time format puts before AM/PM: a plain space on
 * JDK 17, a narrow no-break space (U+202F) on JDK 20+ (CLDR 42). Read from the same
 * formatter [briefWhenLabel] uses, so an expected label matches on whichever JDK runs it.
 */
private val amPmSeparator: String =
    DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(Locale.US)
        .format(LocalTime.of(9, 30)).removePrefix("9:30").removeSuffix("AM")

/** [text] with each " AM"/" PM" spaced the way this JDK formats US clock times. */
fun usClock(text: String): String =
    text.replace(" AM", "${amPmSeparator}AM").replace(" PM", "${amPmSeparator}PM")
