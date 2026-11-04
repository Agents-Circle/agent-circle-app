"""Checks the independent scorer against what the TypeScript engine printed for the same logs.

    python3 -m unittest discover -s scorer -v

The fixtures in `fixtures/` were written by `tools/make-fixtures.mjs`, which runs the
engine itself: `<name>.expected.txt` is the stdout of `npm run arena:replay`, and
`<name>.ts.json` is the engine's per-entry state. Standard library only.
"""

import json
import os
import tempfile
import unittest

import arena_scorer as s

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
LOGS = {
    "edge-cases": "edge-cases.jsonl",
    "long-season": "long-season.jsonl",
    "recorded-mainnet": "recorded-mainnet.jsonl.gz",
}


def fixture(name: str) -> str:
    return os.path.join(FIXTURES, name)


class MatchesTheEngine(unittest.TestCase):
    """The acceptance test: the same ranks, and the same state behind them, from the log alone."""

    def check(self, name: str) -> None:
        season, engine, ranked = s.replay(fixture(LOGS[name]))
        with open(fixture(f"{name}.expected.txt"), encoding="utf-8") as handle:
            expected = handle.read().rstrip("\n").split("\n")
        self.assertEqual(s.ranking_lines(season, engine, ranked), expected)

        with open(fixture(f"{name}.ts.json"), encoding="utf-8") as handle:
            ts = json.load(handle)
        ours = s.ranking_json(season, engine, ranked)
        self.assertEqual(ours["events"], ts["events"])
        self.assertEqual(len(ours["entries"]), len(ts["entries"]))
        for theirs, mine in zip(ts["entries"], ours["entries"]):
            with self.subTest(entry=theirs["entryId"]):
                self.assertEqual({key: mine[key] for key in theirs}, theirs)

    def test_edge_cases(self):
        self.check("edge-cases")

    def test_long_season(self):
        self.check("long-season")

    def test_recorded_mainnet(self):
        self.check("recorded-mainnet")


class PrizeRanks(unittest.TestCase):
    def test_only_eligible_entries_get_a_prize_rank(self):
        season, engine, ranked = s.replay(fixture(LOGS["long-season"]))
        rows = s.ranking_json(season, engine, ranked)["entries"]
        self.assertEqual([(r["entryId"], r["prizeRank"]) for r in rows][:2], [("holder", None), ("daily", 1)])


class Arithmetic(unittest.TestCase):
    def test_division_truncates_toward_zero(self):
        self.assertEqual(s.tdiv(7, 2), 3)
        self.assertEqual(s.tdiv(-7, 2), -3)
        self.assertEqual(s.tdiv(7, -2), -3)
        self.assertEqual(s.signed_value(-1, 15_000_000_000), -1)  # -1.5 -> -1, not -2
        self.assertEqual(s.return_bps(10_000_000_000, 9_999_999_999), 0)

    def test_hyperliquid_price_rule(self):
        btc = s.Instrument("BTC", 0, 5)  # one decimal allowed
        self.assertTrue(btc.price_is_valid(100_000_00000000))  # integers always
        self.assertTrue(btc.price_is_valid(1234_50000000))
        self.assertFalse(btc.price_is_valid(1234_56000000))  # two decimals
        self.assertFalse(btc.price_is_valid(12345_60000000))  # six significant figures
        self.assertTrue(btc.size_is_valid(1_000))
        self.assertFalse(btc.size_is_valid(1_001))

    def test_utc_day(self):
        self.assertEqual(s.utc_day(0), "1970-01-01")
        self.assertEqual(s.utc_day(s.DAY_MS - 1), "1970-01-01")
        self.assertEqual(s.utc_day(-1), "1969-12-31")


class RefusesBadLogs(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        with open(fixture("edge-cases.jsonl.season.json"), encoding="utf-8") as handle:
            self.season = json.load(handle)

    def write(self, text: str, season: dict | None = None) -> str:
        path = os.path.join(self.dir.name, "s.jsonl")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        with open(path + ".season.json", "w", encoding="utf-8") as handle:
            json.dump(season or self.season, handle)
        return path

    def test_out_of_order(self):
        path = self.write('{"kind":"clock","atMs":2}\n{"kind":"clock","atMs":1}\n')
        with self.assertRaisesRegex(s.LogError, "out of order"):
            s.replay(path)

    def test_torn_final_line_is_skipped(self):
        path = self.write('{"kind":"register","atMs":1,"entryId":"a"}\n{"kind":"regi')
        _, engine, ranked = s.replay(path)
        self.assertEqual([r.entry.id for r in ranked], ["a"])

    def test_torn_line_in_the_middle_is_fatal(self):
        path = self.write('{"kind":"regi\n{"kind":"clock","atMs":2}\n')
        with self.assertRaisesRegex(s.LogError, "unreadable"):
            s.replay(path)

    def test_changed_rules(self):
        path = self.write("", {**self.season, "rulesHash": "00" * 32})
        with self.assertRaisesRegex(s.LogError, "rules hash"):
            s.replay(path)

    def test_bigint_must_be_encoded(self):
        line = '{"kind":"cancel","atMs":1,"entryId":"a","cloid":5}\n'
        with self.assertRaisesRegex(s.LogError, "bigint"):
            s.replay(self.write(line))


if __name__ == "__main__":
    unittest.main()
