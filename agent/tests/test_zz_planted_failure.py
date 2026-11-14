import unittest


class PlantedFailure(unittest.TestCase):
    """Temporary (XERK-2889): proves a failing shard turns the required check red."""

    def test_fails(self):
        self.fail("planted")
