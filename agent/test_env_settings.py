import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import threading
import http.client
import unittest

import deployments
import env_settings
import server

FOLLOWER = "media-stack-merged-updates"
SECRET = "s3cr3t-value-never-returned"


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


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


CATALOG = {
    "APPDATA_ROOT": {
        "scopes": {"instance": {"default": "/srv/appdata", "required": True}},
        "secret": False,
    },
    "EXISTING": {
        "scopes": {"instance": {"default": "", "required": False}},
        "secret": False,
    },
    "NEW_SETTING": {
        "scopes": {"instance": {"default": "", "required": True}},
        "secret": False,
    },
    "SECRET_SETTING": {
        "scopes": {"instance": {"default": "", "required": False}},
        "secret": True,
    },
    "UNREQUESTED": {
        "scopes": {"instance": {"default": "", "required": False}},
        "secret": False,
    },
    "GLUETUN_CONTROL_API_KEY": {
        "scopes": {
            "instance": {
                "default": "",
                "required": False,
                "pattern": "[0-9a-fA-F]{64}",
            }
        },
        "secret": True,
    },
    "ONLY_APPS": {
        "scopes": {"apps-server": {"default": "", "required": False}},
        "secret": False,
    },
}

BASELINE_ENV = "APPDATA_ROOT=/srv/appdata\nEXISTING=1\n"
RELEASE_ENV = (
    BASELINE_ENV
    + "NEW_SETTING=example\nSECRET_SETTING=\nGLUETUN_CONTROL_API_KEY=\n"
)


class FakeJournal:
    def __init__(self):
        self.calls = []

    def read(self, units, lines):
        self.calls.append((list(units), lines))
        return []


class EnvSettingsFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.appdata = self.root / "appdata"
        self.checkout = self.root / "media-stack"
        self.env_dir = self.root / "media-stack-env"
        self.env_file = self.env_dir / ".env"
        self.state = self.appdata / "security-monitor" / "merged-releases"
        self.state.mkdir(parents=True)
        self.checkout.mkdir()
        self.env_dir.mkdir()
        write(self.env_file, BASELINE_ENV)
        os.chmod(self.env_file, 0o640)
        write(self.checkout / ".gitignore", ".env\n")
        write(self.checkout / "compose.yaml", "services:\n  radarr:\n    image: radarr:1\n")
        write(self.checkout / ".env.example", BASELINE_ENV)
        self.publish_baseline()
        self.publish_release()
        self.write_installed("v1.0.0")
        self.journal = FakeJournal()
        self.now = [2000.0]
        self.service = deployments.Deployments(
            appdata=self.appdata,
            checkout=self.checkout,
            role="instance",
            unit_names=[FOLLOWER],
            journal_reader=self.journal,
            clock=lambda: self.now[0],
            cache_seconds=3600,
            env_file=self.env_file,
        )
        self.settings = env_settings.EnvSettings(self.service)

    def tearDown(self):
        self.temp.cleanup()

    def publish_baseline(self):
        git(self.checkout, "init", "-q", "-b", "main")
        git(self.checkout, "add", ".")
        git(self.checkout, "commit", "-qm", "baseline")
        git(self.checkout, "tag", "v1.0.0")

    def publish_release(self):
        write(self.checkout / "env/catalog.json", json.dumps(CATALOG))
        write(self.checkout / ".env.example", RELEASE_ENV)
        write(
            self.checkout / "docs/releases/v1.1.0.md",
            "# v1.1.0\nBreaking changes: no\n\n## Manual steps\n"
            "- Fill the new settings in `.env` after reading the release notes.\n",
        )
        write(
            self.checkout / "docs/releases/v1.1.0.deploy.json",
            json.dumps(
                {
                    "schema": 1,
                    "approved_merge": True,
                    "source_commit": "0" * 40,
                    "roles": ["instance", "apps-server"],
                }
            ),
        )
        git(self.checkout, "add", ".")
        git(self.checkout, "commit", "-qm", "release v1.1.0")
        source = git(self.checkout, "rev-parse", "HEAD")
        write(
            self.checkout / "docs/releases/v1.1.0.deploy.json",
            json.dumps(
                {
                    "schema": 1,
                    "approved_merge": True,
                    "source_commit": source,
                    "roles": ["instance", "apps-server"],
                }
            ),
        )
        git(self.checkout, "add", ".")
        git(self.checkout, "commit", "-qm", "release manifest")
        git(self.checkout, "tag", "v1.1.0")
        git(self.checkout, "checkout", "-q", "v1.0.0")

    def write_installed(self, release):
        write(
            self.state / "installed.json",
            json.dumps({"release": release, "commit": "a" * 40}),
        )

    def backups(self):
        return sorted(self.env_dir.glob(".env.backup-*"))

    def save(self, values, **overrides):
        body = {
            "release": "v1.1.0",
            "values": values,
            "acknowledgedManualSteps": True,
            **overrides,
        }
        return self.settings.save(body)


class EnvSettingsTest(EnvSettingsFixture):
    def test_saves_only_missing_catalog_settings_and_keeps_a_backup(self):
        before = self.env_file.read_bytes()

        result = self.save({"NEW_SETTING": "hello world", "SECRET_SETTING": SECRET})

        self.assertEqual(result["saved"], ["NEW_SETTING", "SECRET_SETTING"])
        self.assertEqual(result["missingSettings"], ["GLUETUN_CONTROL_API_KEY"])
        text = self.env_file.read_text()
        self.assertIn("NEW_SETTING='hello world'", text)
        self.assertIn(f"SECRET_SETTING={SECRET}", text)
        self.assertIn("EXISTING=1\n", text)
        self.assertEqual(stat.S_IMODE(self.env_file.stat().st_mode), 0o640)
        backups = self.backups()
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)
        self.assertNotIn(SECRET, json.dumps(result))

    def test_after_saving_the_snapshot_no_longer_retains_the_release_for_settings(self):
        first = self.service.snapshot()
        self.assertEqual(first["retained"][0]["reason"], "missing-configuration")

        self.now[0] = 2100.0
        self.save(
            {
                "NEW_SETTING": "value",
                "SECRET_SETTING": SECRET,
                "GLUETUN_CONTROL_API_KEY": "0" * 64,
            }
        )
        after = self.service.snapshot()

        self.assertEqual(after["retained"], [])
        self.assertIsNone(after["blocker"])
        self.assertNotEqual(first["timestamp"], after["timestamp"])

    def test_snapshot_marks_which_missing_settings_are_secrets(self):
        snapshot = self.service.snapshot()

        retained = snapshot["retained"][0]
        self.assertEqual(retained["missingSettings"], [
            "NEW_SETTING",
            "SECRET_SETTING",
            "GLUETUN_CONTROL_API_KEY",
        ])
        self.assertEqual(
            retained["secretSettings"],
            ["SECRET_SETTING", "GLUETUN_CONTROL_API_KEY"],
        )

    def test_rejects_names_outside_the_catalog_the_release_or_the_missing_list(self):
        cases = {
            "unknown": {"EVIL_SETTING": "value"},
            "existing": {"EXISTING": "changed"},
            "catalog but not requested": {"UNREQUESTED": "value"},
            "other role only": {"ONLY_APPS": "value"},
        }
        for label, values in cases.items():
            with self.subTest(label=label):
                with self.assertRaises(env_settings.EnvSettingsError):
                    self.save(values)
                self.assertEqual(self.env_file.read_text(), BASELINE_ENV)
                self.assertEqual(self.backups(), [])

    def test_rejects_invalid_values_without_echoing_them(self):
        cases = [
            ("NEW_SETTING", "line\nbreak"),
            ("NEW_SETTING", "control\x01value"),
            ("NEW_SETTING", "x" * 5000),
            ("NEW_SETTING", ""),
            ("GLUETUN_CONTROL_API_KEY", "not-hex"),
        ]
        for name, value in cases:
            with self.subTest(name=name):
                with self.assertRaises(env_settings.EnvSettingsError) as error:
                    self.save({name: value})
                if value:
                    self.assertNotIn(value, str(error.exception))
                self.assertEqual(self.env_file.read_text(), BASELINE_ENV)
                self.assertEqual(self.backups(), [])

    def test_requires_the_manual_steps_acknowledgement_when_the_release_has_steps(self):
        for acknowledged in (None, False):
            with self.subTest(acknowledged=acknowledged):
                body = {
                    "release": "v1.1.0",
                    "values": {"NEW_SETTING": "value"},
                }
                if acknowledged is not None:
                    body["acknowledgedManualSteps"] = acknowledged
                with self.assertRaises(env_settings.EnvSettingsError):
                    self.settings.save(body)
                self.assertEqual(self.env_file.read_text(), BASELINE_ENV)

    def test_rejects_a_request_with_extra_fields_or_a_non_boolean_acknowledgement(self):
        with self.assertRaises(env_settings.EnvSettingsError):
            self.save({"NEW_SETTING": "value"}, extra="field")
        with self.assertRaises(env_settings.EnvSettingsError):
            self.save({"NEW_SETTING": "value"}, acknowledgedManualSteps="yes")

    def test_rejects_a_release_that_is_not_retained(self):
        with self.assertRaises(env_settings.EnvSettingsError):
            self.save({"NEW_SETTING": "value"}, release="v9.9.9")

    def test_rejects_writes_on_the_apps_server(self):
        apps = deployments.Deployments(
            appdata=self.appdata,
            checkout=self.checkout,
            role="apps-server",
            unit_names=[FOLLOWER],
            journal_reader=self.journal,
            clock=lambda: 2000.0,
            cache_seconds=0,
            env_file=self.env_file,
        )
        settings = env_settings.EnvSettings(apps)

        with self.assertRaises(env_settings.EnvSettingsError):
            settings.save(
                {
                    "release": "v1.1.0",
                    "values": {"NEW_SETTING": "value"},
                    "acknowledgedManualSteps": True,
                }
            )
        self.assertEqual(self.env_file.read_text(), BASELINE_ENV)

    def test_refuses_a_symlinked_environment_file(self):
        target = self.root / "elsewhere.env"
        target.write_text(BASELINE_ENV)
        self.env_file.unlink()
        self.env_file.symlink_to(target)

        with self.assertRaises(env_settings.EnvSettingsError):
            self.save({"NEW_SETTING": "value"})

        self.assertEqual(target.read_text(), BASELINE_ENV)
        self.assertEqual(self.backups(), [])

    def test_refuses_a_symlinked_lock_file(self):
        outside = self.root / "outside.lock"
        outside.write_text("")
        (self.env_dir / ".env.lock").symlink_to(outside)

        with self.assertRaises(env_settings.EnvSettingsError):
            self.save({"NEW_SETTING": "value"})

        self.assertEqual(self.env_file.read_text(), BASELINE_ENV)
        self.assertEqual(self.backups(), [])

    def test_never_overwrites_a_key_written_by_a_previous_request(self):
        self.save({"NEW_SETTING": "first"})

        with self.assertRaises(env_settings.EnvSettingsError):
            self.save({"NEW_SETTING": "second"})

        text = self.env_file.read_text()
        self.assertIn("NEW_SETTING=first\n", text)
        self.assertNotIn("NEW_SETTING=second", text)

    def test_serializes_concurrent_writes_without_losing_updated_bytes(self):
        from concurrent.futures import ThreadPoolExecutor

        def write(name, value):
            return self.save({name: value})

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [
                future.result()
                for future in [
                    pool.submit(write, "NEW_SETTING", "one"),
                    pool.submit(write, "SECRET_SETTING", "two"),
                ]
            ]

        self.assertEqual(sorted(results[0]["saved"] + results[1]["saved"]), [
            "NEW_SETTING",
            "SECRET_SETTING",
        ])
        text = self.env_file.read_text()
        self.assertIn("NEW_SETTING=one\n", text)
        self.assertIn("SECRET_SETTING=two\n", text)
        self.assertEqual(len(self.backups()), 2)
        self.assertEqual(list(self.env_dir.glob(".env.tmp-*")), [])

    def test_aborts_when_an_external_edit_changes_the_env_during_the_write(self):
        original = self.settings._write_backup

        def racing_write(directory_fd, data):
            name = original(directory_fd, data)
            self.env_file.write_bytes(
                BASELINE_ENV.replace("EXISTING=1", "EXISTING=2").encode()
            )
            return name

        self.settings._write_backup = racing_write

        with self.assertRaises(env_settings.EnvSettingsError):
            self.save({"NEW_SETTING": "value"})

        self.assertEqual(
            self.env_file.read_text(),
            BASELINE_ENV.replace("EXISTING=1", "EXISTING=2"),
        )
        self.assertNotIn("NEW_SETTING=", self.env_file.read_text())
        self.assertEqual(list(self.env_dir.glob(".env.tmp-*")), [])

    def test_appends_after_a_file_without_a_trailing_newline(self):
        write(self.env_file, BASELINE_ENV.rstrip("\n"))

        self.save({"NEW_SETTING": "value"})

        text = self.env_file.read_text()
        self.assertTrue(text.startswith(BASELINE_ENV))
        self.assertIn("\nNEW_SETTING=value\n", text)

    def test_quotes_values_in_compose_syntax(self):
        self.assertEqual(env_settings.quote_value("plain"), "plain")
        self.assertEqual(env_settings.quote_value("with space"), "'with space'")
        self.assertEqual(env_settings.quote_value("a$b"), "'a$b'")
        self.assertEqual(env_settings.quote_value('a"b$c'), "'a\"b$c'")
        self.assertEqual(env_settings.quote_value("a'b$c"), '"a\'b\\$c"')

    def test_reports_each_saved_name_but_never_a_value(self):
        result = self.save(
            {"NEW_SETTING": "public-value", "SECRET_SETTING": SECRET}
        )

        serialized = json.dumps(result)
        self.assertIn("NEW_SETTING", serialized)
        self.assertIn("SECRET_SETTING", serialized)
        self.assertNotIn(SECRET, serialized)
        self.assertNotIn("public-value", serialized)



class EnvSettingsRouteTest(EnvSettingsFixture):
    def setUp(self):
        super().setUp()
        self.previous = (
            server.TOKEN,
            server.ALLOWED_NETWORKS,
            server.ENV_SETTINGS,
        )
        server.TOKEN = "t" * 32
        server.ALLOWED_NETWORKS = server.allowed_networks("127.0.0.1")
        server.ENV_SETTINGS = self.settings
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(
            target=self.httpd.serve_forever, daemon=True
        )
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        server.TOKEN, server.ALLOWED_NETWORKS, server.ENV_SETTINGS = self.previous
        super().tearDown()

    def request(self, body, token="t" * 32):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.httpd.server_address[1], timeout=5
        )
        try:
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = "Bearer " + token
            connection.request(
                "POST",
                "/deployments/settings",
                body=json.dumps(body),
                headers=headers,
            )
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_writes_the_settings_and_never_returns_the_secret(self):
        status, body = self.request(
            {
                "release": "v1.1.0",
                "values": {"NEW_SETTING": "value", "SECRET_SETTING": SECRET},
                "acknowledgedManualSteps": True,
            }
        )

        self.assertEqual(status, 200)
        self.assertEqual(body["saved"], ["NEW_SETTING", "SECRET_SETTING"])
        self.assertNotIn(SECRET, json.dumps(body))
        self.assertIn(f"SECRET_SETTING={SECRET}\n", self.env_file.read_text())

    def test_rejects_a_missing_token_without_writing(self):
        status, _ = self.request(
            {
                "release": "v1.1.0",
                "values": {"NEW_SETTING": "value"},
                "acknowledgedManualSteps": True,
            },
            token=None,
        )

        self.assertEqual(status, 401)
        self.assertEqual(self.env_file.read_text(), BASELINE_ENV)

    def test_rejects_an_invalid_body_without_leaking_its_values(self):
        status, body = self.request(
            {
                "release": "v1.1.0",
                "values": {"NOT_ALLOWED": SECRET},
                "acknowledgedManualSteps": True,
            }
        )

        self.assertEqual(status, 400)
        self.assertNotIn(SECRET, json.dumps(body))
        self.assertNotIn(SECRET, self.env_file.read_text())
        self.assertEqual(self.env_file.read_text(), BASELINE_ENV)


if __name__ == "__main__":
    unittest.main()
