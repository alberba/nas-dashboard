from datetime import datetime, timezone
import http.client
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

import deployments
import server

FOLLOWER = "media-stack-merged-updates"
SECURITY = "media-stack-security-updates"
BACKUP = "media-stack-backup"
SECRET = "must-never-leak"


def git(root, *args):
    result = subprocess.run(
        [
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        cwd=root,
        text=True,
        capture_output=True,
    )
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


def iso(epoch):
    return (
        datetime.fromtimestamp(epoch, timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


class FakeJournal:
    def __init__(self, entries=None, error=None):
        self.entries = entries or []
        self.error = error
        self.calls = []

    def read(self, units, lines):
        self.calls.append((list(units), lines))
        if self.error:
            raise self.error
        return list(self.entries)


COMPOSE = """\
services:
  vpn:
    image: vpn:1
    restart: unless-stopped
  radarr:
    image: radarr:1
    restart: unless-stopped
    network_mode: service:vpn
  sonarr:
    image: sonarr:1
    restart: unless-stopped
    network_mode: service:vpn
  wire:
    image: wire:1
    restart: "no"
"""


class DeploymentsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.appdata = self.root / "appdata"
        self.checkout = self.root / "media-stack"
        self.state = self.appdata / "security-monitor" / "merged-releases"
        self.state.mkdir(parents=True)
        self.checkout.mkdir()
        write(self.checkout / ".gitignore", ".env\n")
        write(
            self.checkout / ".env",
            "APPDATA_ROOT=/srv/appdata\nCOMPOSE_PROFILES=\nEXISTING=1\n",
        )
        write(
            self.checkout / ".env.example",
            "APPDATA_ROOT=/srv/appdata\nEXISTING=1\n",
        )
        write(self.checkout / "compose.yaml", COMPOSE)
        write(
            self.checkout / "compose.gpu.yaml",
            "services:\n  radarr:\n    devices:\n      - /dev/dri:/dev/dri\n",
        )
        write(self.checkout / "old.md", "renamed later\n")
        git(self.checkout, "init", "-q", "-b", "main")
        git(self.checkout, "add", ".")
        git(self.checkout, "commit", "-qm", "baseline")
        git(self.checkout, "tag", "v1.0.0")
        self.baseline = git(self.checkout, "rev-parse", "HEAD")
        self.installed({"release": "v1.0.0", "commit": self.baseline})
        self.journal = FakeJournal()

    def tearDown(self):
        self.temp.cleanup()

    def installed(self, value):
        write(self.state / "installed.json", json.dumps(value))

    def service(self, *extra):
        return deployments.Deployments(
            appdata=self.appdata,
            checkout=self.checkout,
            role="instance",
            unit_names=[FOLLOWER, SECURITY, BACKUP],
            journal_reader=self.journal,
            clock=lambda: 2000.0,
            cache_seconds=0,
            **({"git": extra[0]} if extra else {}),
        )

    def publish(
        self,
        release="v1.1.0",
        *,
        new_setting=None,
        change="radarr",
        manual="- Fill NEW_SETTING in `.env`.",
        manifest=True,
        manifest_source=None,
        notes=True,
        files=None,
    ):
        compose = COMPOSE.replace(
            f"{change}:1", f"{change}:2"
        ) if change else COMPOSE
        write(self.checkout / "compose.yaml", compose)
        for name, content in (files or {}).items():
            write(self.checkout / name, content)
        example = "APPDATA_ROOT=/srv/appdata\nEXISTING=1\n"
        if new_setting:
            example += f"{new_setting}=value\n"
        write(self.checkout / ".env.example", example)
        git(self.checkout, "add", ".")
        git(self.checkout, "commit", "-qm", "release changes")
        source = git(self.checkout, "rev-parse", "HEAD")
        if notes:
            write(
                self.checkout / f"docs/releases/{release}.md",
                f"""# {release}
Breaking changes: no

## Images bumped
- `{change or 'none'}`

## Manual steps
{manual}
""",
            )
        if manifest:
            write(
                self.checkout / f"docs/releases/{release}.deploy.json",
                json.dumps(
                    {
                        "schema": 1,
                        "approved_merge": True,
                        "source_commit": manifest_source or source,
                        "roles": ["instance", "apps-server"],
                    }
                ),
            )
        if notes or manifest:
            git(self.checkout, "add", ".")
            git(self.checkout, "commit", "-qm", "release metadata")
        git(self.checkout, "tag", release)
        git(self.checkout, "checkout", "-q", "v1.0.0")

    def history(self, name, result, mtime):
        folder = self.state / name
        folder.mkdir()
        path = folder / "result.json"
        write(path, json.dumps(result))
        os.utime(path, (mtime, mtime))

    def test_history_uses_the_follower_result_files_without_transaction_paths(self):
        self.history(
            "a" * 32,
            {
                "release": "v1.1.0",
                "status": "updated",
                "changed": ["radarr"],
                "folder": "/private/transaction",
                "environment": "/private/environment",
                "snapshots": [{"source": "/private/appdata"}],
            },
            1_000,
        )
        self.history(
            "b" * 32,
            {
                "release": "v1.2.0",
                "status": "rolled_back",
                "changed": ["sonarr"],
                "previous_installed": {"release": "v1.1.0"},
            },
            2_000,
        )

        snapshot = self.service().snapshot()

        self.assertEqual(
            snapshot["history"],
            [
                {
                    "release": "v1.2.0",
                    "outcome": "rolled-back",
                    "at": iso(2_000),
                    "previousRelease": "v1.1.0",
                    "services": ["sonarr"],
                },
                {
                    "release": "v1.1.0",
                    "outcome": "success",
                    "at": iso(1_000),
                    "previousRelease": None,
                    "services": ["radarr"],
                },
            ],
        )
        serialized = json.dumps(snapshot)
        self.assertNotIn("/private", serialized)
        self.assertNotIn("snapshots", serialized)
        self.assertNotIn("environment", serialized)

    def test_a_dirty_checkout_blocks_the_follower_with_the_exact_files(self):
        self.publish()
        write(self.checkout / "compose.yaml", COMPOSE + "# local change\n")
        write(self.checkout / "docs/notes.md", "local notes\n")
        git(self.checkout, "mv", "old.md", "new.md")

        snapshot = self.service().snapshot()

        self.assertEqual(snapshot["blocker"]["code"], "dirty-checkout")
        self.assertEqual(
            {
                (item["status"], item["path"], item["from"])
                for item in snapshot["blocker"]["files"]
            },
            {
                ("M", "compose.yaml", None),
                ("??", "docs/notes.md", None),
                ("R", "new.md", "old.md"),
            },
        )
        self.assertEqual(snapshot["retained"][0]["reason"], "dirty-checkout")
        self.assertEqual(snapshot["retained"][0]["release"], "v1.1.0")

    def test_retained_release_explains_missing_settings_manual_steps_and_services(self):
        self.publish(new_setting="NEW_SETTING")

        snapshot = self.service().snapshot()

        self.assertEqual(len(snapshot["retained"]), 1)
        retained = snapshot["retained"][0]
        self.assertEqual(retained["release"], "v1.1.0")
        self.assertEqual(retained["reason"], "missing-configuration")
        self.assertEqual(retained["missingSettings"], ["NEW_SETTING"])
        self.assertEqual(retained["manualSteps"], ["Fill NEW_SETTING in `.env`."])
        self.assertEqual(retained["services"], ["radarr"])
        self.assertFalse(retained["breaking"])
        self.assertEqual(snapshot["blocker"]["code"], "missing-configuration")
        self.assertEqual(snapshot["blocker"]["release"], "v1.1.0")
        self.assertEqual(snapshot["blocker"]["missingSettings"], ["NEW_SETTING"])
        self.assertEqual(snapshot["degraded"], [])

    def test_automatic_release_notes_do_not_invent_manual_steps(self):
        self.publish(
            new_setting="NEW_SETTING",
            manual="- None. Automatic release: compatible changes only.",
        )

        snapshot = self.service().snapshot()

        self.assertEqual(snapshot["retained"][0]["manualSteps"], [])

    def test_a_release_without_a_ci_manifest_is_retained_with_its_reason(self):
        self.publish(manifest=False, manual="- None.")

        snapshot = self.service().snapshot()

        retained = snapshot["retained"][0]
        self.assertEqual(retained["reason"], "missing-manifest")
        self.assertEqual(retained["manualSteps"], [])
        self.assertEqual(retained["services"], ["radarr"])
        self.assertIsNone(snapshot["blocker"])

    def test_a_manifest_with_an_unknown_source_is_not_approved(self):
        self.publish(manifest_source="f" * 40, manual="- None.")

        snapshot = self.service().snapshot()

        self.assertEqual(snapshot["retained"][0]["reason"], "invalid-manifest")
        self.assertIsNone(snapshot["retained"][0]["sourceCommit"])

    def test_a_later_release_is_blocked_by_the_one_that_needs_settings(self):
        self.publish(new_setting="NEW_SETTING")
        self.publish(
            release="v1.2.0",
            change="sonarr",
            new_setting=None,
            manual="- None.",
        )

        snapshot = self.service().snapshot()

        self.assertEqual(
            [(entry["release"], entry["reason"]) for entry in snapshot["retained"]],
            [
                ("v1.2.0", "blocked-by-previous-release"),
                ("v1.1.0", "missing-configuration"),
            ],
        )
        self.assertEqual(snapshot["retained"][0]["blockedBy"], "v1.1.0")

    def test_a_failed_release_with_the_same_configuration_is_not_retried(self):
        self.publish(new_setting=None, manual="- None.")
        key = deployments.configuration_key(
            self.checkout / ".env",
            self.appdata / "security-monitor" / "images.compose.json",
        )
        write(
            self.state / "failed-release.json",
            json.dumps({"release": "v1.1.0", "configuration": key}),
        )

        snapshot = self.service().snapshot()

        self.assertEqual(snapshot["retained"][0]["reason"], "previously-failed")
        self.assertIsNone(snapshot["blocker"])

    def test_a_disabled_compose_override_does_not_promise_services(self):
        self.publish(
            change=None,
            new_setting="NEW_SETTING",
            manual="- None.",
            files={
                "compose.gpu.yaml": (
                    "services:\n  radarr:\n    devices:\n"
                    "      - /dev/dri:/dev/dri\n      - /dev/kfd:/dev/kfd\n"
                )
            },
        )

        snapshot = self.service().snapshot()

        self.assertEqual(snapshot["retained"][0]["services"], [])

    def test_a_changed_gateway_recreates_its_network_consumers(self):
        self.publish(change="vpn", new_setting="NEW_SETTING", manual="- None.")

        snapshot = self.service().snapshot()

        self.assertEqual(
            snapshot["retained"][0]["services"], ["radarr", "sonarr", "vpn"]
        )

    def test_a_pending_release_transaction_blocks_without_exposing_paths(self):
        write(
            self.state / "pending.json",
            json.dumps(
                {
                    "release": "v1.1.0",
                    "status": "deploying",
                    "previous_installed": {"release": "v1.0.0"},
                    "changed": ["radarr"],
                    "folder": "/private/transaction",
                    "snapshots": [{"source": "/private/appdata"}],
                }
            ),
        )

        snapshot = self.service().snapshot()

        self.assertEqual(snapshot["blocker"]["code"], "release-recovery-pending")
        self.assertEqual(snapshot["blocker"]["release"], "v1.1.0")
        self.assertEqual(snapshot["follower"]["state"], "deploying")
        self.assertNotIn("/private", json.dumps(snapshot))

    def test_a_pending_security_recovery_blocks_releases(self):
        self.publish(new_setting=None, manual="- None.")
        write(
            self.appdata / "security-monitor/active-update.json",
            json.dumps(
                {
                    "service": "radarr",
                    "status": "deploying",
                    "before_pins": {"services": {"radarr": {"image": SECRET}}},
                }
            ),
        )

        snapshot = self.service().snapshot()

        self.assertEqual(snapshot["blocker"]["code"], "security-recovery-pending")
        self.assertEqual(snapshot["retained"][0]["reason"], "security-recovery-pending")
        self.assertNotIn(SECRET, json.dumps(snapshot))

    def test_journal_only_reads_the_role_units_and_the_requested_tail(self):
        self.journal.entries = [
            {
                "at": "2026-11-13T10:00:00Z",
                "unit": f"{FOLLOWER}.service",
                "priority": 6,
                "level": "info",
                "message": "v2.5.0 aplicada",
            },
            {
                "at": "2026-11-13T10:00:01Z",
                "unit": "unrelated.service",
                "priority": 3,
                "level": "error",
                "message": "foreign unit",
            },
            {
                "at": "2026-11-13T10:00:02Z",
                "unit": f"{BACKUP}.service",
                "priority": 4,
                "level": "warning",
                "message": "TOKEN=" + SECRET,
            },
        ]

        snapshot = self.service().snapshot(lines=3)

        self.assertEqual(
            [entry["unit"] for entry in snapshot["journal"]["entries"]],
            [f"{FOLLOWER}.service", f"{BACKUP}.service"],
        )
        units, lines = self.journal.calls[0]
        self.assertEqual(lines, 3)
        self.assertIn(f"{FOLLOWER}.service", units)
        self.assertIn(f"{SECURITY}.service", units)
        self.assertIn(f"{BACKUP}.service", units)
        self.assertNotIn("unrelated.service", units)
        self.assertNotIn(SECRET, json.dumps(snapshot))

    def test_a_missing_checkout_degrades_without_failing_the_snapshot(self):
        instance = deployments.Deployments(
            appdata=self.appdata,
            checkout=self.root / "missing",
            role="instance",
            unit_names=[FOLLOWER],
            journal_reader=self.journal,
            clock=lambda: 2000.0,
            cache_seconds=0,
        )

        snapshot = instance.snapshot()

        self.assertFalse(snapshot["available"])
        self.assertEqual(snapshot["blocker"]["code"], "checkout-unavailable")
        self.assertIn("checkout", snapshot["degraded"])
        self.assertEqual(snapshot["history"], [])

    def test_a_failed_journal_read_leaves_the_rest_of_the_snapshot(self):
        self.journal.error = OSError("journal unavailable")

        snapshot = self.service().snapshot(lines=50)

        self.assertEqual(snapshot["journal"]["entries"], [])
        self.assertIn("journal", snapshot["degraded"])
        self.assertEqual(snapshot["follower"]["installed"]["release"], "v1.0.0")

    def test_snapshot_is_cached_for_the_configured_seconds(self):
        ticks = [1000.0]
        journal = FakeJournal()
        instance = deployments.Deployments(
            appdata=self.appdata,
            checkout=self.checkout,
            role="instance",
            unit_names=[FOLLOWER],
            journal_reader=journal,
            clock=lambda: ticks[0],
            cache_seconds=60,
        )

        first = instance.snapshot(lines=10)
        ticks[0] = 1030.0
        second = instance.snapshot(lines=10)
        ticks[0] = 1061.0
        third = instance.snapshot(lines=10)

        self.assertEqual(first["timestamp"], second["timestamp"])
        self.assertNotEqual(second["timestamp"], third["timestamp"])
        self.assertEqual(len(journal.calls), 2)


class FakeExecutor:
    def __init__(self, output=""):
        self.output = output
        self.calls = []

    def run(self, argv, timeout=None):
        self.calls.append((list(argv), timeout))
        return self.output


class JournalReaderTest(unittest.TestCase):
    def test_reads_a_fixed_json_tail_for_the_allowed_units(self):
        executor = FakeExecutor(
            "\n".join(
                json.dumps(record)
                for record in [
                    {
                        "_SYSTEMD_UNIT": "media-stack-merged-updates.service",
                        "__REALTIME_TIMESTAMP": "1763030000000000",
                        "PRIORITY": "6",
                        "MESSAGE": "release ready",
                    },
                    {
                        "_SYSTEMD_UNIT": "other.service",
                        "__REALTIME_TIMESTAMP": "1763030001000000",
                        "PRIORITY": "3",
                        "MESSAGE": "foreign",
                    },
                ]
            )
        )

        entries = deployments.JournalReader(executor).read(
            ["media-stack-merged-updates.service"], 25
        )

        argv, timeout = executor.calls[0]
        self.assertEqual(argv[0], "journalctl")
        self.assertIn("--output=json", argv)
        self.assertIn("--unit=media-stack-merged-updates.service", argv)
        self.assertEqual(argv[argv.index("--lines") + 1], "25")
        self.assertEqual(timeout, 10)
        self.assertEqual(
            [(entry["unit"], entry["message"]) for entry in entries],
            [("media-stack-merged-updates.service", "release ready")],
        )

    def test_rejects_a_tail_outside_the_bounded_range(self):
        for value in (0, 501):
            with self.subTest(value=value), self.assertRaises(ValueError):
                deployments.JournalReader(FakeExecutor()).read(
                    ["media-stack-merged-updates.service"], value
                )

    def test_rejects_a_unit_that_is_not_a_systemd_service_or_timer(self):
        executor = FakeExecutor()

        with self.assertRaises(ValueError):
            deployments.JournalReader(executor).read(["--unit=evil"], 10)

        self.assertEqual(executor.calls, [])


class FakeDeployments:
    def __init__(self):
        self.calls = []

    def snapshot(self, lines=100):
        self.calls.append(lines)
        return {"timestamp": 2000.0, "journal": {"entries": []}, "lines": lines}


class DeploymentsRouteTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeDeployments()
        self.previous = (server.TOKEN, server.ALLOWED_NETWORKS, server.DEPLOYMENTS)
        server.TOKEN = "t" * 32
        server.ALLOWED_NETWORKS = server.allowed_networks("127.0.0.1")
        server.DEPLOYMENTS = self.fake
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        server.TOKEN, server.ALLOWED_NETWORKS, server.DEPLOYMENTS = self.previous

    def request(self, path, token="t" * 32):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.httpd.server_address[1], timeout=5
        )
        try:
            headers = {"Authorization": "Bearer " + token} if token else {}
            connection.request("GET", path, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_deployments_route_passes_the_bounded_tail_with_auth(self):
        status, body = self.request("/deployments?lines=25")

        self.assertEqual(status, 200)
        self.assertEqual(body["lines"], 25)
        self.assertEqual(self.fake.calls, [25])

    def test_deployments_route_rejects_an_invalid_tail(self):
        status, _ = self.request("/deployments?lines=many")

        self.assertEqual(status, 400)
        self.assertEqual(self.fake.calls, [])

    def test_deployments_route_rejects_a_missing_token(self):
        status, _ = self.request("/deployments", token=None)

        self.assertEqual(status, 401)


if __name__ == "__main__":
    unittest.main()
