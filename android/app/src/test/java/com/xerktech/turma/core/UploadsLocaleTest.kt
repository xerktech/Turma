package com.xerktech.turma.core

import java.util.Locale
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The same locale trap `fmtTokens` had, in the two siblings that still carried
 * it. Both sit beside figures the web renders with a dot, so a device locale
 * leaking into either is the phone and the browser disagreeing about one value.
 */
class UploadsLocaleTest {

    @After fun restoreLocale() = Locale.setDefault(Locale.US)

    @Test fun `a byte chip does not follow the device locale`() {
        for (locale in listOf(Locale.US, Locale.GERMANY, Locale("ar", "EG"))) {
            Locale.setDefault(locale)
            assertEquals("locale $locale", "3.4 MB", Uploads.formatBytes(3_565_158))
        }
    }
}
