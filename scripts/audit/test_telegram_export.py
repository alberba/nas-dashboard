import json
import os
import tempfile
import unittest
from collections import Counter
from pathlib import Path

import noise_audit
import telegram_export

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE = FIXTURES / "telegram_export_sample.html"
OPERATOR_NAME = "Operador Demo"
BOT_NAME = "NAS Monitor"


def real_export_path():
    configured = os.environ.get("NOISE_EXPORT")
    if configured:
        return Path(configured)
    return Path.home() / "Downloads" / "ChatExport_NAS Monitor" / "messages.html"


def sample_document():
    return telegram_export.parse_export_document(SAMPLE, expected_sha256=None)


def sample_rows():
    return telegram_export.parse_export(SAMPLE, expected_sha256=None)


class TelegramExportTest(unittest.TestCase):
    def test_date_separators_are_not_counted_as_messages(self):
        rows, stats = sample_document()

        self.assertEqual(len(rows), 6)
        self.assertEqual(stats["date_separators"], 2)
        self.assertEqual([row["id"] for row in rows], [f"message{n}" for n in range(1, 7)])

    def test_joined_messages_inherit_the_previous_sender(self):
        rows = sample_rows()

        self.assertEqual(
            [row["sender"] for row in rows],
            [BOT_NAME, BOT_NAME, BOT_NAME, OPERATOR_NAME, BOT_NAME, BOT_NAME],
        )
        self.assertEqual([row["joined"] for row in rows], [False, True, True, False, False, True])
        self.assertNotIn(None, [row["sender"] for row in rows])

    def test_the_literal_backslash_n_normalises_to_the_same_break_as_a_br(self):
        rows = sample_rows()

        self.assertEqual(rows[1]["text"], "Demo Alerta\n\nsegunda linea")
        self.assertEqual(rows[2]["text"], rows[1]["text"])

    def test_a_tel_link_contributes_its_text_and_never_its_href(self):
        rows = sample_rows()

        self.assertIn("CVE-2026-103111", rows[0]["text"])
        self.assertNotIn("tel:", json.dumps(rows, ensure_ascii=False))

    def test_a_title_without_a_clock_keeps_the_row_without_an_hour(self):
        rows = sample_rows()

        self.assertIsNone(rows[4]["time"])
        self.assertIsNone(rows[4]["hour"])
        self.assertEqual(rows[4]["sent_at"], "2026-01-02")
        self.assertTrue(rows[0]["time"])
        self.assertEqual(rows[0]["hour"], 8)

    def test_a_different_sha256_raises_with_the_expected_and_obtained_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "messages.html"
            copy.write_bytes(SAMPLE.read_bytes())

            with self.assertRaises(telegram_export.DatasetHashError) as caught:
                telegram_export.parse_export(copy)

        message = str(caught.exception)
        self.assertIn(telegram_export.EXPECTED_SHA256, message)
        self.assertIn(telegram_export.hashlib.sha256(SAMPLE.read_bytes()).hexdigest(), message)

    def test_the_aggregate_keeps_only_the_two_sender_buckets(self):
        rows = sample_rows()
        source = {
            "path_hint": SAMPLE.name,
            "sha256": "0" * 64,
            "bytes": SAMPLE.stat().st_size,
            "exported_mtime_note": "nota de prueba",
            "date_separators": 2,
        }

        aggregate = noise_audit.aggregate(rows, source)
        serialised = json.dumps(aggregate, ensure_ascii=False)

        self.assertEqual(aggregate["sender_split"], {"bot": 5, "operator": 1})
        self.assertEqual(aggregate["dataset"]["messages"], 6)
        self.assertEqual(aggregate["dataset"]["bot_messages"], 5)
        self.assertEqual(aggregate["dataset"]["operator_messages"], 1)
        self.assertEqual(aggregate["dataset"]["missing_time"], 1)
        self.assertEqual(aggregate["dataset"]["days_with_messages"], 2)
        self.assertEqual(aggregate["dataset"]["span_days"], 1)
        self.assertEqual(aggregate["dataset"]["inclusive_days"], 2)
        self.assertNotIn(OPERATOR_NAME, serialised)
        self.assertNotIn(BOT_NAME, serialised)
        self.assertNotIn('"text"', serialised)

    def test_write_ndjson_round_trips_one_row_per_line(self):
        rows = sample_rows()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "nested" / "messages.ndjson"

            telegram_export.write_ndjson(rows, target)

            lines = target.read_text(encoding="utf-8").splitlines()

        self.assertEqual(len(lines), len(rows))
        self.assertEqual(json.loads(lines[0])["id"], "message1")
        self.assertEqual(Counter(json.loads(line)["sender"] for line in lines)[OPERATOR_NAME], 1)

    @unittest.skipUnless(real_export_path().exists(), "export real no disponible")
    def test_the_real_export_matches_the_pinned_counts(self):
        rows, stats = telegram_export.parse_export_document(real_export_path())
        split = Counter(
            noise_audit.sender_kind(row["sender"]) for row in rows
        )

        self.assertEqual(len(rows), 148)
        self.assertEqual(split["bot"], 146)
        self.assertEqual(split["operator"], 2)
        self.assertEqual(stats["date_separators"], 45)
        self.assertEqual(stats["bytes"], telegram_export.EXPECTED_BYTES)
        self.assertEqual(sum(1 for row in rows if row["time"] is None), 0)


if __name__ == "__main__":
    unittest.main()
