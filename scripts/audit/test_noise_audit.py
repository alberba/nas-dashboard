import json
import os
import unittest
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


def family(inventory, name):
    return inventory["families"].get(name)


SIGNATURE_CASES = [
    (
        "wud",
        "New tag found for container demo-arr<br><br>"
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
        "Demo Monitor — 3 actualizaciones de seguridad verificadas<br><br>"
        "demo-arr: 1.0.0 → 1.0.1",
        {"key": "security:digest"},
    ),
    (
        "security-update",
        "Demo Monitor — autoactualización de seguridad<br><br>"
        "demo-arr → 1.0.1: actualizada; comprobación de salud correcta<br>"
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
        "Backup of demo-host FAILED:<br>- cannot open the repository",
        {"key": "backup:demo-host", "host": "demo-host"},
    ),
    (
        "issue-incident",
        "🚨 Incidencia reportada en Seerr<br><br>🎬 Título: Demo",
        {"key": "issue:seerr"},
    ),
    ("issue-test", "🧪 Test manual de Issue Automator", {"key": "issue:test"}),
    (
        "smart",
        "🚨 Alerta SMART - NAS<br><br>🟠 /dev/demo: 2 sectores pendientes",
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


if __name__ == "__main__":
    unittest.main()
