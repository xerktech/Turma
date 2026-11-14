#!/usr/bin/env python3
"""Run one shard of a unittest discovery, so CI can spread a suite over parallel jobs.

    python3 .github/scripts/unittest_shard.py <start_dir> <index> <count>

Discovers exactly as `python3 -m unittest discover -s <start_dir> -p "test_*.py"`
does, flattens the suite to single test cases in their usual order, and runs every
<count>-th case starting at <index> (1-based). Round-robin, not by class or module:
the slow suites are a few heavy classes (the guard's), so dealing their tests out
one by one is what spreads them evenly.

Every case lands in exactly one shard, so the shards together run the whole
suite. Splitting a class still works: unittest runs setUpClass/setUpModule once
per run of adjacent cases from that class, in every shard that has some. A
module that fails to import becomes one failing case and so fails its shard.
"""

import sys
import unittest


def _cases(suite):
    for t in suite:
        if isinstance(t, unittest.TestSuite):
            yield from _cases(t)
        else:
            yield t


def main(argv):
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    start, index, count = argv[0], int(argv[1]), int(argv[2])
    if not 1 <= index <= count:
        print(f"shard index {index} is not within 1..{count}", file=sys.stderr)
        return 2
    every = list(_cases(unittest.defaultTestLoader.discover(start, pattern="test_*.py")))
    mine = every[index - 1::count]
    print(f"shard {index}/{count}: {len(mine)} of {len(every)} tests", flush=True)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(mine))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
