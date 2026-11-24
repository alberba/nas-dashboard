import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import noise_audit
import telegram_export

BOT = "NAS Monitor"
OPERATOR = "Operador Demo"


def real_export_path():
    configured = os.environ.get("NOISE_EXPORT")
    if configured:
        return Path(configured)
    return Path.home() / "Downloads" / "ChatExport_NAS Monitor" / "messages.html"


ALERTS_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "alerts_sample.csv"


def wud_text(container, target_tag):
    return (
        f"New tag found for container {container}\n\n"
        f"Container {container} running with tag 1.0.0 "
        f"can be updated to tag {target_tag}"
    )


def security_update_text(*lines):
    return "Demo Monitor — autoactualización de seguridad\n\n" + "\n".join(lines)


def row(**overrides):
    base = {
        "id": "message1",
        "joined": False,
        "sender": BOT,
        "sent_at": "2026-05-01T10:00:00",
        "time": True,
        "hour": 10,
        "text": "",
        "length": 0,
    }
    base.update(overrides)
    return base


def source_metadata():
    return {
        "path_hint": "messages.html",
        "sha256": "0" * 64,
        "bytes": 1,
        "exported_mtime_note": "nota",
        "date_separators": 1,
    }


def family(inventory, name):
    return inventory["families"].get(name)


SIGNATURE_CASES = [
    (
        "wud",
        "New tag found for container demo-arr\n\n"
        "Container demo-arr running with tag 1.0.0 can be updated to tag 1.1.0",
        {
            "key": "wud:demo-arr",
            "container": "demo-arr",
            "from_tag": "1.0.0",
            "target_tag": "1.1.0",
        },
    ),
    (
        "security-digest",
        "Demo Monitor — 3 actualizaciones de seguridad verificadas\n\n"
        "demo-arr: 1.0.0 → 1.0.1",
        {"key": "security:digest"},
    ),
    (
        "security-update",
        "Demo Monitor — autoactualización de seguridad\n\n"
        "demo-arr → 1.0.1: actualizada; comprobación de salud correcta\n"
        "demo-db → 2.0.0: manual: missing healthcheck",
        {
            "key": "security:update",
            "updates": [
                {
                    "container": "demo-arr",
                    "target_tag": "1.0.1",
                    "outcome": "updated",
                },
                {"container": "demo-db", "target_tag": "2.0.0", "outcome": "manual"},
            ],
        },
    ),
    (
        "release-stop",
        "Demo Stack — actualización automática detenida: dirty working tree",
        {"key": "release:stop", "reason": "dirty working tree"},
    ),
    (
        "release-apply",
        "Demo Home — v1.2.3 aplicada y verificada; servicios: demo-arr, demo-db",
        {
            "key": "release:apply",
            "services": ["demo-arr", "demo-db"],
            "outcome": "applied",
        },
    ),
    (
        "release-apply",
        "Demo Home — v1.2.3 falló",
        {"key": "release:apply", "outcome": "failed"},
    ),
    (
        "release-upgrade",
        "Demo Stack — actualizado de v1.0.0 a v1.1.0 y verificado.",
        {"key": "release:upgrade"},
    ),
    (
        "backup",
        "Backup of demo-host FAILED:\n- cannot open the repository",
        {"key": "backup:demo-host", "host": "demo-host"},
    ),
    (
        "issue-incident",
        "🚨 Incidencia reportada en Seerr\n\n🎬 Título: Demo",
        {"key": "issue:seerr"},
    ),
    ("issue-test", "🧪 Test manual de Issue Automator", {"key": "issue:test"}),
    (
        "smart",
        "🚨 Alerta SMART - NAS\n\n🟠 /dev/demo: 2 sectores pendientes",
        {"key": "smart:unknown", "emitter": "unknown"},
    ),
]

KNOWN_FAMILIES = [
    "wud",
    "security-digest",
    "security-update",
    "release-stop",
    "release-apply",
    "release-upgrade",
    "backup",
    "issue-incident",
    "issue-test",
    "smart",
]


class ClassifyTest(unittest.TestCase):
    def test_every_known_signature_returns_its_family_key_and_join_fields(self):
        for family_name, text, expected in SIGNATURE_CASES:
            with self.subTest(family=family_name):
                result = noise_audit.classify(text)
                self.assertEqual(result["family"], family_name)
                for field, value in expected.items():
                    self.assertEqual(result[field], value)

    def test_an_unmatched_message_falls_back_to_unknown_without_raising(self):
        result = noise_audit.classify("Texto de familia desconocida")

        self.assertEqual(result, {"family": "unknown", "key": "unknown"})

    def test_the_first_matching_signature_wins(self):
        text = (
            "Demo Stack — actualización automática detenida: dirty working tree "
            "y el intento anterior falló"
        )

        self.assertEqual(noise_audit.classify(text)["family"], "release-stop")

    def test_the_signature_table_lists_the_ten_families_once(self):
        names = [entry[0] for entry in noise_audit.SIGNATURES]

        self.assertEqual(names, KNOWN_FAMILIES)
        self.assertEqual(len(names), len(set(names)))


class InventoryTest(unittest.TestCase):
    def inventory(self, *texts, operator_rows=0):
        rows = [
            row(id=f"message{index}", text=text)
            for index, text in enumerate(texts, 1)
        ]
        rows.extend(
            row(id=f"operator{index}", sender=OPERATOR, text="hola")
            for index in range(1, operator_rows + 1)
        )
        return noise_audit.build_inventory(rows)

    def test_family_counts_sum_to_the_bot_messages(self):
        inventory = self.inventory(
            *[text for _family, text, _expected in SIGNATURE_CASES], operator_rows=2
        )

        self.assertEqual(inventory["operator"], 2)
        self.assertEqual(sum(inventory["families"].values()), len(SIGNATURE_CASES))
        for family_name, _text, _expected in SIGNATURE_CASES:
            self.assertGreaterEqual(family(inventory, family_name), 1)

    def test_the_inventory_lists_nine_emitters_with_the_hub_on_push(self):
        inventory = self.inventory(
            *[text for _family, text, _expected in SIGNATURE_CASES]
        )

        self.assertEqual(len(inventory["emitters"]), 9)
        hub = next(entry for entry in inventory["emitters"] if entry["id"] == "hub")
        self.assertEqual(hub["channel"], "push")
        self.assertEqual(hub["messages"], 0)
        self.assertEqual(inventory["hub_telegram_messages"], 0)
        self.assertEqual(inventory["hub_channel"], "push")
        for entry in inventory["emitters"]:
            self.assertTrue(entry["evidence"], entry["id"])
            self.assertIn("messages", entry)
            self.assertIn("by_family", entry)

    def test_every_telegram_emitter_count_adds_up_to_the_bot_messages(self):
        inventory = self.inventory(
            *[text for _family, text, _expected in SIGNATURE_CASES]
        )

        telegram = [entry for entry in inventory["emitters"] if entry["channel"] == "telegram"]

        self.assertEqual(sum(entry["messages"] for entry in telegram), len(SIGNATURE_CASES))
        self.assertTrue(all(entry["messages"] >= 1 for entry in telegram), telegram)

    def test_the_unknown_bucket_keeps_ids_and_dates_only(self):
        inventory = self.inventory("Texto de familia desconocida", "Otro texto sin firma")

        self.assertIsInstance(inventory["unknown"], list)
        self.assertEqual(len(inventory["unknown"]), 2)
        for entry in inventory["unknown"]:
            self.assertEqual(set(entry), {"id", "sent_at"})
        self.assertEqual(family(inventory, "unknown"), 2)

    def test_the_inventory_never_carries_a_message_body(self):
        inventory = self.inventory(
            *[text for _family, text, _expected in SIGNATURE_CASES]
        )

        serialised = json.dumps(inventory, ensure_ascii=False)
        self.assertNotIn('"text"', serialised)
        self.assertNotIn("demo-arr running with tag", serialised)

    def test_the_aggregate_adds_the_inventory_and_keeps_the_dataset_section(self):
        rows = [row(text=SIGNATURE_CASES[0][1])]
        source = {
            "path_hint": "messages.html",
            "sha256": "0" * 64,
            "bytes": 1,
            "exported_mtime_note": "nota",
            "date_separators": 1,
        }

        aggregate = noise_audit.aggregate(rows, source)

        self.assertIn("dataset", aggregate)
        self.assertIn("sender_split", aggregate)
        self.assertEqual(aggregate["inventory"]["families"], {"wud": 1})
        self.assertEqual(aggregate["sender_split"], {"bot": 1, "operator": 0})

    @unittest.skipUnless(real_export_path().exists(), "export real no disponible")
    def test_the_real_export_reproduces_the_family_counts(self):
        rows = telegram_export.parse_export(real_export_path())
        inventory = noise_audit.build_inventory(rows)

        self.assertEqual(
            inventory["families"],
            {
                "wud": 95,
                "security-digest": 1,
                "security-update": 31,
                "release-stop": 5,
                "release-apply": 4,
                "release-upgrade": 1,
                "backup": 2,
                "issue-incident": 3,
                "issue-test": 2,
                "smart": 2,
            },
        )
        self.assertEqual(inventory["operator"], 2)
        self.assertEqual(sum(inventory["families"].values()), 146)
        self.assertEqual(inventory["unknown"], [])


class RecoveryTest(unittest.TestCase):
    def signature_rows(self):
        return [
            row(id=f"message{index}", text=text)
            for index, (_family, text, _expected) in enumerate(SIGNATURE_CASES, 1)
        ]

    def test_the_telegram_split_covers_every_bot_message_once(self):
        rows = self.signature_rows() + [row(id="operator1", sender=OPERATOR)]

        telegram = noise_audit.build_recoveries(rows)["telegram"]

        self.assertEqual(telegram["messages"], len(SIGNATURE_CASES))
        self.assertEqual(
            telegram["openings"]
            + telegram["informational"]
            + telegram["recovery_messages"],
            len(SIGNATURE_CASES),
        )
        self.assertEqual(telegram["openings"], 7)
        self.assertEqual(telegram["informational"], 4)
        self.assertEqual(telegram["recovery_messages"], 0)

    def test_a_manual_and_updated_message_counts_once_as_an_opening(self):
        text = (
            "Demo Monitor — autoactualización de seguridad\n\n"
            "demo-arr → 1.0.1: actualizada; comprobación de salud correcta\n"
            "demo-db → 2.0.0: manual: missing healthcheck"
        )

        result = noise_audit.build_openings([row(text=text)])

        self.assertEqual(result["openings"], 1)
        self.assertEqual(result["informational"], 0)

    def test_an_all_updated_security_update_is_informational(self):
        text = (
            "Demo Monitor — autoactualización de seguridad\n\n"
            "demo-arr → 1.0.1: actualizada; comprobación de salud correcta"
        )

        result = noise_audit.build_openings([row(text=text)])

        self.assertEqual(result["openings"], 0)
        self.assertEqual(result["informational"], 1)

    def test_a_failed_release_apply_is_an_opening(self):
        result = noise_audit.build_openings(
            [row(text="Demo Home — v1.2.3 falló")]
        )

        self.assertEqual(result["openings"], 1)
        self.assertEqual(result["informational"], 0)

    def test_a_recovery_line_is_not_counted_as_an_opening(self):
        text = (
            "Demo Monitor — autoactualización de seguridad\n\n"
            "— recuperación completada: demo-arr"
        )

        result = noise_audit.build_recoveries([row(text=text)])["telegram"]

        self.assertEqual(result["recovery_messages"], 1)
        self.assertEqual(result["openings"], 0)
        self.assertEqual(result["informational"], 0)

    def test_the_ratio_is_zero_without_openings(self):
        rows = [row(text="🧪 Test manual de Issue Automator")]

        telegram = noise_audit.build_recoveries(rows)["telegram"]

        self.assertEqual(telegram["openings"], 0)
        self.assertEqual(telegram["recovery_ratio"], 0.0)

    def test_the_hub_push_block_stays_unmeasured_without_a_csv(self):
        recoveries = noise_audit.build_recoveries(self.signature_rows())
        hub = recoveries["hub_push"]

        self.assertNotIn("total", recoveries)
        self.assertEqual(hub["status"], "unavailable")
        self.assertEqual(hub["source"], "alerts.resolvedAt")
        for field in (
            "openings",
            "recovery_messages",
            "recovery_ratio",
            "push_decision_at",
            "push_resolved_at",
            "push_latency_s",
        ):
            self.assertIsNone(hub[field], field)

    def test_each_family_declares_its_recovery_capability(self):
        capabilities = noise_audit.build_recoveries([])["telegram"][
            "by_family_capability"
        ]

        self.assertTrue(capabilities["security-update"]["can_emit_recovery"])
        self.assertTrue(capabilities["hub"]["can_emit_recovery"])
        self.assertTrue(capabilities["security-update"]["recovery_template"])
        self.assertTrue(capabilities["hub"]["recovery_template"])
        for family_name in KNOWN_FAMILIES:
            if family_name == "security-update":
                continue
            self.assertFalse(
                capabilities[family_name]["can_emit_recovery"], family_name
            )

    def test_the_aggregate_publishes_recoveries(self):
        aggregate = noise_audit.aggregate(self.signature_rows(), source_metadata())

        self.assertIn("recoveries", aggregate)
        self.assertEqual(
            aggregate["recoveries"]["telegram"]["openings"]
            + aggregate["recoveries"]["telegram"]["informational"],
            len(SIGNATURE_CASES),
        )

    @unittest.skipUnless(real_export_path().exists(), "export real no disponible")
    def test_the_real_export_has_146_messages_and_zero_recoveries(self):
        rows = telegram_export.parse_export(real_export_path())

        telegram = noise_audit.build_recoveries(rows)["telegram"]

        self.assertEqual(telegram["messages"], 146)
        self.assertEqual(
            telegram["openings"]
            + telegram["informational"]
            + telegram["recovery_messages"],
            146,
        )
        self.assertEqual(telegram["recovery_messages"], 0)


class PushAdapterTest(unittest.TestCase):
    def test_the_synthetic_fixture_keeps_four_valid_rows(self):
        loaded = noise_audit.load_alerts_csv(ALERTS_FIXTURE)

        self.assertEqual(loaded["skipped_rows"], 0)
        self.assertEqual(len(loaded["rows"]), 4)
        opened = [entry for entry in loaded["rows"] if entry["resolvedAt"] is None]
        self.assertEqual(len(opened), 2)
        self.assertIn("unknown-key", {entry["key"] for entry in loaded["rows"]})

    def test_a_malformed_row_is_counted_and_skipped(self):
        content = (
            "hostId,key,severity,at,resolvedAt\n"
            "nas-home,backup-failed,critical,2026-11-20T03:00:00Z,\n"
            "nas-home,backup-failed,critical,,\n"
            "nas-home,backup-failed,critical,not-a-date,\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "alerts.csv"
            path.write_text(content, encoding="utf-8")

            loaded = noise_audit.load_alerts_csv(path)

        self.assertEqual(len(loaded["rows"]), 1)
        self.assertEqual(loaded["skipped_rows"], 2)
        self.assertIsNone(loaded["rows"][0]["resolvedAt"])

    def test_a_different_header_is_rejected(self):
        content = "hostId,key,severity,at\nnas-home,backup-failed,critical,2026-11-20T03:00:00Z\n"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "alerts.csv"
            path.write_text(content, encoding="utf-8")

            with self.assertRaises(ValueError):
                noise_audit.load_alerts_csv(path)

    def test_wall_clock_conversion_resolves_the_dst_offset(self):
        before = noise_audit.to_instant("2026-10-24T12:00:00")
        after = noise_audit.to_instant("2026-10-26T12:00:00")
        change = noise_audit.to_instant("2026-10-25T02:30:00")

        self.assertEqual(
            before, datetime(2026, 10, 24, 10, 0, tzinfo=timezone.utc)
        )
        self.assertEqual(
            after, datetime(2026, 10, 26, 11, 0, tzinfo=timezone.utc)
        )
        self.assertEqual(
            change, datetime(2026, 10, 25, 0, 30, tzinfo=timezone.utc)
        )


class DuplicateTest(unittest.TestCase):
    def test_a_wud_message_matching_two_lines_counts_once(self):
        rows = [
            row(id="wud1", sent_at="2026-05-01T10:00:00",
                text=wud_text("demo", "2.0.0")),
            row(id="security1", sent_at="2026-05-01T12:00:00",
                text=security_update_text(
                    "demo → 2.0.0: manual: missing healthcheck",
                    "demo → 2.0.0: manual: still missing healthcheck",
                )),
        ]

        inter_system = noise_audit.build_duplicates(rows)["inter_system"]

        self.assertEqual(inter_system["messages"], 1)
        self.assertEqual(len(inter_system["items"]), 1)

    def test_a_manual_review_is_not_a_real_update(self):
        rows = [
            row(id="wud1", sent_at="2026-05-01T10:00:00",
                text=wud_text("demo", "2.0.0")),
            row(id="security1", sent_at="2026-05-01T12:00:00",
                text=security_update_text(
                    "demo → 2.0.0: manual: missing healthcheck"
                )),
            row(id="wud2", sent_at="2026-05-02T10:00:00",
                text=wud_text("other", "3.0.0")),
            row(id="security2", sent_at="2026-05-02T12:00:00",
                text=security_update_text(
                    "other → 3.0.0: actualizada; comprobación de salud correcta"
                )),
        ]

        inter_system = noise_audit.build_duplicates(rows)["inter_system"]

        self.assertEqual(inter_system["messages"], 2)
        self.assertEqual(inter_system["manual_only"], 1)
        self.assertEqual(inter_system["real_update"], 1)

    def test_same_target_requires_the_exact_tag(self):
        rows = [
            row(id="wud1", sent_at="2026-05-01T10:00:00",
                text=wud_text("demo", "2.0.0")),
            row(id="security1", sent_at="2026-05-01T12:00:00",
                text=security_update_text(
                    "demo → 2.0.1: actualizada; comprobación de salud correcta"
                )),
        ]

        inter_system = noise_audit.build_duplicates(rows)["inter_system"]

        self.assertEqual(inter_system["same_target"], 0)
        self.assertFalse(inter_system["items"][0]["same_target"])

    def test_without_a_csv_the_channel_duplicate_is_unavailable(self):
        rows = [
            row(id="backup1", sent_at="2026-11-20T04:10:00",
                text="Backup of demo-host FAILED:\n- cannot open the repository"),
        ]

        duplicates = noise_audit.build_duplicates(rows)
        inter_channel = duplicates["inter_channel"]

        self.assertNotIn("total", duplicates)
        self.assertNotIn("duplicates", duplicates)
        self.assertEqual(inter_channel["status"], "unavailable")
        self.assertIsNone(inter_channel["duplicates"])
        self.assertIsNone(inter_channel["latency_s"])

    def test_with_a_csv_the_copy_latency_comes_from_alerts_at(self):
        alerts = noise_audit.load_alerts_csv(ALERTS_FIXTURE)
        rows = [
            row(id="backup1", sent_at="2026-11-20T04:10:00", hour=4,
                text="Backup of demo-host FAILED:\n- cannot open the repository"),
        ]

        joins = noise_audit.join_push_windows(alerts["rows"], rows)
        inter_channel = noise_audit.build_duplicates(rows, alerts)["inter_channel"]

        self.assertEqual(len(joins), 1)
        self.assertEqual(joins[0]["push_latency_s"], 600.0)
        self.assertEqual(joins[0]["push_status"], "measured")
        self.assertEqual(joins[0]["push_resolved_at"], "2026-11-20T03:25:00Z")
        self.assertEqual(inter_channel["status"], "measured")
        self.assertEqual(inter_channel["duplicates"], 1)
        self.assertEqual(inter_channel["latency_s"], 600.0)

    @unittest.skipUnless(real_export_path().exists(), "export real no disponible")
    def test_the_real_export_reproduces_the_inter_system_duplicate(self):
        rows = telegram_export.parse_export(real_export_path())

        inter_system = noise_audit.build_duplicates(rows)["inter_system"]

        self.assertEqual(inter_system["messages"], 14)
        self.assertEqual(inter_system["same_target"], 12)
        self.assertEqual(inter_system["real_update"], 1)
        self.assertEqual(inter_system["manual_only"], 13)


class HistogramTest(unittest.TestCase):
    def test_the_histogram_has_24_buckets_and_skips_rows_without_time(self):
        rows = [
            row(id="message1", sent_at="2026-11-20T23:30:00", hour=23),
            row(id="message2", sent_at="2026-11-20", hour=None, time=None),
        ]

        histogram = noise_audit.build_histogram(rows)

        self.assertEqual(
            list(histogram["buckets"]), [str(hour) for hour in range(24)]
        )
        self.assertEqual(histogram["buckets"]["23"], 1)
        self.assertEqual(histogram["missing_time"], 1)
        self.assertEqual(sum(histogram["buckets"].values()), 1)
        for era_buckets in histogram["by_era"].values():
            self.assertEqual(
                list(era_buckets), [str(hour) for hour in range(24)]
            )

    def test_a_message_at_2330_stays_in_bucket_23(self):
        histogram = noise_audit.build_histogram(
            [row(sent_at="2026-11-20T23:30:00", hour=23)]
        )

        self.assertEqual(histogram["buckets"]["23"], 1)
        self.assertEqual(histogram["buckets"]["22"], 0)

    def test_each_era_has_its_own_hourly_buckets(self):
        rows = [
            row(id="message1", sent_at="2026-05-01T10:00:00", hour=10),
            row(id="message2", sent_at="2026-11-20T06:00:00", hour=6),
        ]

        histogram = noise_audit.build_histogram(rows)

        self.assertEqual(histogram["by_era"]["E1"]["10"], 1)
        self.assertEqual(histogram["by_era"]["E4"]["6"], 1)
        self.assertEqual(sum(histogram["by_era"]["E1"].values()), 1)

    @unittest.skipUnless(real_export_path().exists(), "export real no disponible")
    def test_the_real_export_keeps_eight_messages_at_0600_in_e4(self):
        rows = telegram_export.parse_export(real_export_path())

        histogram = noise_audit.build_histogram(rows)

        self.assertEqual(
            histogram["by_era"]["E4"]["6"],
            max(histogram["by_era"]["E4"].values()),
        )
        self.assertEqual(histogram["by_era"]["E4"]["6"], 8)
        self.assertEqual(
            sum(histogram["buckets"].values()),
            len(rows) - histogram["missing_time"],
        )


class TopKeysTest(unittest.TestCase):
    def test_top_keys_order_by_count_and_break_ties_alphabetically(self):
        rows = [
            row(id=f"security{index}",
                text=security_update_text(
                    "demo → 1.0.0: actualizada; comprobación de salud correcta"
                ))
            for index in range(3)
        ]
        rows.extend(
            row(id=f"aaa{index}", text=wud_text("aaa", "2.0.0"))
            for index in range(2)
        )
        rows.extend(
            row(id=f"bbb{index}", text=wud_text("bbb", "3.0.0"))
            for index in range(2)
        )

        top_keys = noise_audit.build_top_keys(rows, limit=3)

        self.assertEqual(
            [entry["key"] for entry in top_keys],
            ["security:update", "wud:aaa", "wud:bbb"],
        )
        self.assertTrue(all(0 < entry["share"] <= 1 for entry in top_keys))

    @unittest.skipUnless(real_export_path().exists(), "export real no disponible")
    def test_the_real_export_has_the_expected_top_three(self):
        top_keys = noise_audit.build_top_keys(
            telegram_export.parse_export(real_export_path())
        )

        self.assertEqual(
            [entry["key"] for entry in top_keys],
            ["security:update", "wud:tdarr", "wud:radarr"],
        )
        self.assertEqual(
            [entry["messages"] for entry in top_keys], [31, 15, 10]
        )


class WudEventTest(unittest.TestCase):
    def test_a_gap_of_five_minutes_stays_in_the_same_scan_pass(self):
        rows = [
            row(id="message1", sent_at="2026-05-01T10:00:00",
                text=wud_text("demo", "1.0.0")),
            row(id="message2", sent_at="2026-05-01T10:05:00",
                text=wud_text("other", "1.0.0")),
            row(id="message3", sent_at="2026-05-01T10:11:00",
                text=wud_text("third", "1.0.0")),
        ]

        events = noise_audit.build_wud_events(rows)

        self.assertEqual(events["messages"], 3)
        self.assertEqual(events["scan_passes"], 2)
        self.assertEqual(events["messages_per_event"], 1.5)
        self.assertEqual(events["passes"][0]["containers"], ["demo", "other"])

    def test_repetitions_group_by_container_and_target_tag(self):
        rows = [
            row(id="message1", text=wud_text("demo", "1.0.0")),
            row(id="message2", text=wud_text("demo", "1.0.0")),
            row(id="message3", text=wud_text("demo", "2.0.0")),
            row(id="message4", text=wud_text("other", "1.0.0")),
            row(id="message5", text=wud_text("other", "1.0.0")),
        ]

        repetitions = noise_audit.build_repetitions(rows)

        self.assertEqual(repetitions["repeated_groups"], 2)
        self.assertEqual(len(repetitions["groups"]), 2)
        self.assertEqual(repetitions["extra_messages"], 2)
        self.assertEqual(
            repetitions["groups"][0],
            {
                "container": "demo",
                "target_tag": "1.0.0",
                "messages": 2,
                "extra_messages": 1,
            },
        )

    @unittest.skipUnless(real_export_path().exists(), "export real no disponible")
    def test_the_real_export_has_51_scan_passes_and_11_repeated_groups(self):
        rows = telegram_export.parse_export(real_export_path())

        events = noise_audit.build_wud_events(rows)
        repetitions = noise_audit.build_repetitions(rows)

        self.assertEqual(events["messages"], 95)
        self.assertEqual(events["scan_passes"], 51)
        self.assertEqual(events["messages_per_event"], 1.86)
        self.assertEqual(repetitions["repeated_groups"], 11)
        self.assertEqual(repetitions["extra_messages"], 14)


class WindowTest(unittest.TestCase):
    def test_windows_anchor_at_the_last_day_and_publish_every_emitter(self):
        rows = [
            row(id=f"message{index}", sent_at="2026-11-20T12:00:00",
                hour=12, text=text)
            for index, (_family, text, _expected) in enumerate(SIGNATURE_CASES, 1)
        ]
        rows.append(row(id="operator1", sender=OPERATOR, text="hola"))

        windows = noise_audit.build_windows(rows)

        self.assertEqual(
            {name: window["from"] for name, window in windows.items()},
            {"30d": "2026-10-22", "60d": "2026-09-22", "90d": "2026-08-23"},
        )
        emitter_ids = {
            emitter["id"] for emitter in noise_audit.EMITTERS
        }
        for name, window in windows.items():
            self.assertEqual(window["inclusive_days"], int(name[:-1]))
            self.assertLessEqual(
                emitter_ids, set(window["by_emitter"])
            )
            self.assertEqual(
                sum(
                    entry["messages"]
                    for entry in window["by_emitter"].values()
                ),
                window["messages"],
            )
            for entry in window["by_emitter"].values():
                self.assertEqual(
                    entry["rate"],
                    round(entry["messages"] / window["inclusive_days"], 2),
                )

    def test_era_events_count_scan_passes_plus_non_wud_bot_messages(self):
        rows = era_shape_rows()
        rows.extend(
            row(id=f"wud{index}", sent_at=f"2026-10-01T10:0{index}:00",
                text=wud_text("demo", f"1.0.{index}"))
            for index in range(3)
        )

        wud_events = noise_audit.build_wud_events(rows)
        eras = noise_audit.build_eras(rows)
        noise_audit.apply_wud_events(eras, wud_events, rows)

        self.assertEqual(wud_events["scan_passes"], 1)
        self.assertEqual(eras["E2"]["events"], 106)
        self.assertEqual(eras["E2"]["messages"], 108)
        self.assertLess(eras["E2"]["events"], eras["E2"]["messages"])
        self.assertEqual(
            sum(eras[name]["events"] for name in ("E1", "E2", "E3", "E4")),
            wud_events["scan_passes"] + (len(rows) - wud_events["messages"]),
        )

    @unittest.skipUnless(real_export_path().exists(), "export real no disponible")
    def test_the_real_export_reproduces_the_windows_and_era_events(self):
        rows = telegram_export.parse_export(real_export_path())

        windows = noise_audit.build_windows(rows)
        wud_events = noise_audit.build_wud_events(rows)
        eras = noise_audit.build_eras(rows)
        noise_audit.apply_wud_events(eras, wud_events, rows)

        self.assertEqual(
            [windows[name]["messages"] for name in ("30d", "60d", "90d")],
            [44, 140, 144],
        )
        self.assertEqual(
            [eras[name]["events"] for name in ("E1", "E2", "E3", "E4")],
            [6, 62, 19, 15],
        )
        self.assertTrue(
            all(
                eras[name]["events"] <= eras[name]["messages"]
                for name in ("E1", "E2", "E3", "E4")
            )
        )
        self.assertEqual(
            sum(
                eras[name]["events"] for name in ("E1", "E2", "E3", "E4")
            ),
            wud_events["scan_passes"] + (146 - wud_events["messages"]),
        )


class ReproducibilityTest(unittest.TestCase):
    def test_canonical_json_sorts_keys_and_ends_with_one_newline(self):
        first = noise_audit.canonical_json({"b": 1, "a": 2})
        second = noise_audit.canonical_json({"a": 2, "b": 1})

        self.assertEqual(first, second)
        self.assertTrue(first.endswith("\n"))
        self.assertFalse(first.endswith("\n\n"))
        self.assertLess(first.index('"a"'), first.index('"b"'))

    def test_the_aggregate_never_carries_message_bodies_or_the_text_substring(self):
        aggregate = noise_audit.aggregate(
            [row(text=wud_text("demo", "2.0.0"))], source_metadata()
        )

        serialised = json.dumps(aggregate, ensure_ascii=False)
        self.assertNotIn('"text"', serialised)
        self.assertNotIn("text", serialised)
        self.assertNotIn(str(Path.home()), serialised)

    @unittest.skipUnless(real_export_path().exists(), "export real no disponible")
    def test_the_real_export_is_reproducible_byte_for_byte(self):
        self.assertEqual(
            noise_audit.check_repro(real_export_path()), {"reproducible": True}
        )


class EraTest(unittest.TestCase):
    def test_each_era_declares_its_inclusive_calendar_days(self):
        eras = noise_audit.build_eras(era_shape_rows())

        self.assertEqual(
            {name: era["inclusive_days"] for name, era in eras.items()},
            {"E1": 156, "E2": 36, "E3": 10, "E4": 12},
        )
        for era in eras.values():
            self.assertEqual(era["span_days"], era["inclusive_days"] - 1)

    def test_the_rate_is_messages_over_inclusive_days(self):
        eras = noise_audit.build_eras(era_shape_rows())

        self.assertEqual(
            {name: era["rate"] for name, era in eras.items()},
            {"E1": 0.05, "E2": 2.92, "E3": 2.0, "E4": 1.25},
        )
        for era in eras.values():
            self.assertEqual(era["rate"], round(era["messages"] / era["inclusive_days"], 2))

    def test_build_rates_is_the_only_source_of_the_rate_field(self):
        eras = noise_audit.build_eras(era_shape_rows())
        rates = noise_audit.build_rates(eras)

        self.assertEqual(rates, {name: era["rate"] for name, era in eras.items()})

    def test_era_messages_add_up_to_the_whole_dataset(self):
        rows = era_shape_rows() + [row(id="operator1", sender=OPERATOR)]

        eras = noise_audit.build_eras(rows)

        self.assertEqual(sum(era["messages"] for era in eras.values()), len(rows))

    def test_era_boundaries_are_inclusive_and_never_overlap(self):
        eras = noise_audit.build_eras(era_boundary_rows())

        self.assertEqual({name: era["messages"] for name, era in eras.items()},
                         {"E1": 2, "E2": 2, "E3": 2, "E4": 2})

    def test_the_rate_never_uses_the_number_of_days_with_messages(self):
        rows = [
            row(id="message1", sent_at="2026-11-05T08:00:00"),
            row(id="message2", sent_at="2026-11-05T09:00:00"),
        ]

        era = noise_audit.build_eras(rows)["E3"]

        self.assertEqual(era["messages"], 2)
        self.assertEqual(era["inclusive_days"], 10)
        self.assertEqual(era["rate"], 0.2)
        self.assertNotEqual(era["rate"], round(era["messages"] / 1, 2))

    def test_each_era_carries_its_own_family_counts(self):
        eras = noise_audit.build_eras(
            [
                row(id="message1", sent_at="2026-05-01T10:00:00", text=SIGNATURE_CASES[0][1]),
                row(id="message2", sent_at="2026-11-20T10:00:00", text=SIGNATURE_CASES[7][1]),
            ]
        )

        self.assertEqual(eras["E1"]["by_family"], {"wud": 1})
        self.assertEqual(eras["E4"]["by_family"], {"backup": 1})
        self.assertEqual(eras["E2"]["by_family"], {})

    def test_the_denominator_note_explains_the_two_published_rates(self):
        rows = [row()]
        source = {
            "path_hint": "messages.html",
            "sha256": "0" * 64,
            "bytes": 1,
            "exported_mtime_note": "nota",
            "date_separators": 1,
        }

        dataset = noise_audit.build_dataset_summary(rows, source)

        self.assertIn("0,04", dataset["denominator_note"])
        self.assertIn("1,15", dataset["denominator_note"])
        self.assertIn("inclusivos", dataset["denominator_note"])

    @unittest.skipUnless(real_export_path().exists(), "export real no disponible")
    def test_the_real_export_reproduces_the_era_counts(self):
        eras = noise_audit.build_eras(telegram_export.parse_export(real_export_path()))

        self.assertEqual(
            [eras[name]["messages"] for name in ("E1", "E2", "E3", "E4")],
            [8, 105, 20, 15],
        )
        self.assertEqual(
            [eras[name]["inclusive_days"] for name in ("E1", "E2", "E3", "E4")],
            [156, 36, 10, 12],
        )
        self.assertEqual(
            [eras[name]["rate"] for name in ("E1", "E2", "E3", "E4")],
            [0.05, 2.92, 2.0, 1.25],
        )


class EvidenceTest(unittest.TestCase):
    def test_the_sources_declare_nine_entries_with_their_limits(self):
        sources = noise_audit.build_evidence_sources()

        self.assertEqual(len(sources), 9)
        self.assertEqual(len({source["id"] for source in sources}), 9)
        for source in sources:
            for field in ("id", "label", "access", "proves", "status"):
                self.assertTrue(source[field], (source["id"], field))
        statuses = {source["id"]: source["status"] for source in sources}
        self.assertEqual(statuses["alerts"], "unavailable")
        self.assertEqual(statuses["docker-logs"], "partial")
        self.assertEqual(statuses["export"], "available")

    def test_a_state_root_refreshes_exists_and_readable_without_raising(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "backup").mkdir()
            (root / "backup" / "last-status").write_text("ok", encoding="utf-8")
            (root / "security-monitor").mkdir()
            outbox = root / "security-monitor" / "update-notifications.json"
            outbox.write_text("{}", encoding="utf-8")
            outbox.chmod(0o000)

            sources = {
                source["id"]: source
                for source in noise_audit.build_evidence_sources(root)
            }

        self.assertTrue(sources["backup-status"]["exists"])
        self.assertTrue(sources["backup-status"]["readable"])
        self.assertTrue(sources["update-outbox"]["exists"])
        self.assertFalse(sources["update-outbox"]["readable"])
        self.assertFalse(sources["failed-release"]["exists"])
        self.assertFalse(sources["failed-release"]["readable"])

    def test_without_a_state_root_the_probe_fields_stay_unset(self):
        sources = noise_audit.build_evidence_sources()

        for source in sources:
            self.assertNotIn("exists", source)
            self.assertNotIn("readable", source)

    def test_the_aggregate_publishes_eras_and_evidence_sources(self):
        rows = era_boundary_rows()
        source = {
            "path_hint": "messages.html",
            "sha256": "0" * 64,
            "bytes": 1,
            "exported_mtime_note": "nota",
            "date_separators": 1,
        }

        aggregate = noise_audit.aggregate(rows, source)

        self.assertEqual(set(aggregate["eras"]), {"E1", "E2", "E3", "E4"})
        self.assertEqual(len(aggregate["evidence_sources"]), 9)


def bucket_of(policy, key):
    for bucket in ("immediate", "digest", "silent"):
        for entry in policy["buckets"][bucket]:
            if entry["key"] == key:
                return bucket, entry
    raise AssertionError(f"{key} no está en ningún bucket")


class PolicyMapTest(unittest.TestCase):
    def test_the_union_covers_the_22_keys_exactly_once(self):
        policy = noise_audit.build_policy_map()

        keys = [
            entry["key"]
            for bucket in ("immediate", "digest", "silent")
            for entry in policy["buckets"][bucket]
        ]
        catalog = {entry["key"] for entry in noise_audit.HUB_KEYS} | {
            entry["family"] for entry in noise_audit.TELEGRAM_FAMILIES
        }

        self.assertEqual(policy["total_keys"], 22)
        self.assertEqual(len(keys), 22)
        self.assertEqual(len(set(keys)), 22)
        self.assertEqual(set(keys), catalog)
        self.assertEqual(policy["counts"], {"immediate": 9, "digest": 9, "silent": 4})

    def test_wud_is_silent_and_backup_failures_are_immediate(self):
        policy = noise_audit.build_policy_map()

        self.assertEqual(bucket_of(policy, "wud")[0], "silent")
        self.assertEqual(bucket_of(policy, "backup")[0], "immediate")
        self.assertEqual(bucket_of(policy, "backup-failed")[0], "immediate")

    def test_security_update_splits_success_from_manual_and_failed(self):
        policy = noise_audit.build_policy_map()

        bucket, entry = bucket_of(policy, "security-update")

        self.assertEqual(bucket, "digest")
        self.assertEqual(
            entry["split_by_outcome"],
            {"updated": "digest", "manual": "immediate", "failed": "immediate"},
        )

    def test_release_apply_splits_applied_from_failed(self):
        policy = noise_audit.build_policy_map()

        bucket, entry = bucket_of(policy, "release-apply")

        self.assertEqual(bucket, "digest")
        self.assertEqual(
            entry["split_by_outcome"],
            {"applied": "digest", "failed": "immediate"},
        )

    def test_the_hub_container_key_is_silent_and_grouped_in_phase_three(self):
        policy = noise_audit.build_policy_map()

        bucket, entry = bucket_of(policy, "container:<name>")

        self.assertEqual(bucket, "silent")
        self.assertEqual(entry["grouped_in"], "phase 3")

    def test_each_entry_declares_its_source_and_rationale(self):
        policy = noise_audit.build_policy_map()

        for bucket in ("immediate", "digest", "silent"):
            for entry in policy["buckets"][bucket]:
                self.assertTrue(entry["source"], entry["key"])
                self.assertTrue(entry["rationale"], entry["key"])

    def test_the_aggregate_publishes_the_policy_map(self):
        aggregate = noise_audit.aggregate([row()], source_metadata())

        self.assertEqual(aggregate["policy"]["total_keys"], 22)
        self.assertEqual(
            aggregate["policy"]["counts"],
            {"immediate": 9, "digest": 9, "silent": 4},
        )


class SuccessTargetTest(unittest.TestCase):
    def test_the_target_rests_on_the_inclusive_e4_baseline(self):
        eras = noise_audit.build_eras(era_shape_rows())

        target = noise_audit.build_success_target(eras)

        self.assertEqual(target["baseline_era"], "E4")
        self.assertEqual(target["baseline_inclusive_days"], 12)
        self.assertEqual(target["baseline_messages_per_day"], 1.25)
        self.assertEqual(target["window_days"], 14)
        self.assertGreater(target["proactive_messages_per_day"], 0)
        self.assertLessEqual(
            target["proactive_messages_per_day"],
            target["baseline_messages_per_day"],
        )

    def test_the_ack_block_defines_median_p90_and_publishes_no_value(self):
        target = noise_audit.build_success_target(
            noise_audit.build_eras(era_shape_rows())
        )
        ack = target["ack"]

        self.assertEqual(ack["metric"], "median(sentAt -> ackAt)")
        self.assertEqual(ack["guard"], "p90")
        self.assertTrue(ack["per_severity"])
        self.assertEqual(ack["immediate_median_target_minutes"], 15)
        self.assertEqual(ack["p90_guard_minutes"], 60)
        self.assertIsNone(ack["current"])
        self.assertEqual(ack["status"], "not_measurable")

    def test_the_aggregate_publishes_the_success_target(self):
        aggregate = noise_audit.aggregate(era_shape_rows(), source_metadata())

        self.assertIsNone(aggregate["success_target"]["ack"]["current"])


class ReportModelTest(unittest.TestCase):
    def test_the_model_publishes_the_policy_and_target_sections(self):
        aggregate = noise_audit.aggregate(era_shape_rows(), source_metadata())

        model = noise_audit.build_report_model(aggregate)

        ids = [section["id"] for section in model["sections"]]
        self.assertIn("politica", ids)
        self.assertIn("objetivo", ids)
        self.assertEqual(model["source_hash"], aggregate["source"]["sha256"])

    def test_the_render_is_not_empty_and_keeps_the_policy_section(self):
        aggregate = noise_audit.aggregate(era_shape_rows(), source_metadata())

        rendered = noise_audit.render_report(
            noise_audit.build_report_model(aggregate)
        )

        self.assertIsInstance(rendered, str)
        self.assertTrue(rendered.strip())
        self.assertIn("politica", rendered)
        self.assertIn("objetivo", rendered)

    @unittest.skipUnless(real_export_path().exists(), "export real no disponible")
    def test_the_real_export_fixes_the_expected_policy_and_target(self):
        aggregate = noise_audit.aggregate(
            telegram_export.parse_export(real_export_path()), source_metadata()
        )

        self.assertEqual(
            aggregate["policy"]["counts"],
            {"immediate": 9, "digest": 9, "silent": 4},
        )
        self.assertEqual(
            aggregate["success_target"]["baseline_messages_per_day"], 1.25
        )
        self.assertLessEqual(
            aggregate["success_target"]["proactive_messages_per_day"], 1.25
        )


def era_shape_rows():
    shape = {"E1": (8, "2026-05-01T12:00:00"), "E2": (105, "2026-10-01T12:00:00"),
             "E3": (20, "2026-11-05T12:00:00"), "E4": (15, "2026-11-20T12:00:00")}
    rows = []
    for era, (count, stamp) in shape.items():
        rows.extend(
            row(id=f"{era}-{index}", sent_at=stamp) for index in range(count)
        )
    return rows


def era_boundary_rows():
    stamps = (
        "2026-04-25T18:00:00",
        "2026-09-27T23:59:59",
        "2026-09-28T00:00:00",
        "2026-11-02T23:59:59",
        "2026-11-03T00:00:00",
        "2026-11-12T23:59:59",
        "2026-11-13T00:00:00",
        "2026-11-24T06:08:00",
    )
    return [row(id=f"message{index}", sent_at=stamp) for index, stamp in enumerate(stamps, 1)]


if __name__ == "__main__":
    unittest.main()
