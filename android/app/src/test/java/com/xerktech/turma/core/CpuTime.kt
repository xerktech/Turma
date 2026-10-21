package com.xerktech.turma.core

/**
 * This thread's CPU milliseconds spent in [block] — never the wall clock. A wall
 * bound measured the scheduler, not the code: with every core busy (a parallel
 * gradle run, an emulator booting) a linear parse took >10 s of wall time and
 * failed. A quadratic one burns tens of seconds of CPU however idle the box is.
 */
internal fun cpuMs(block: () -> Unit): Long {
    // Reflected: the unit-test classpath compiles against android.jar, which has no
    // java.lang.management; the JVM running the test does.
    val bean = Class.forName("java.lang.management.ManagementFactory")
        .getMethod("getThreadMXBean").invoke(null)
    val cpu = Class.forName("java.lang.management.ThreadMXBean").getMethod("getCurrentThreadCpuTime")
    val t = cpu.invoke(bean) as Long
    block()
    return ((cpu.invoke(bean) as Long) - t) / 1_000_000
}
