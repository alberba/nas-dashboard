from datetime import datetime
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

import helper_cleanup
import maintenance
import server


class FakeHost:
    def __init__(self, units=None, failed=None, reboot=None):
        self.unit_requests = []
        self.failed_calls = 0
        self.reboot_calls = 0
        self.units = units or []
        self.failed = failed or []
        self.reboot_state = reboot or {"available": False, "required": None}

    def units_for(self, names):
        self.unit_requests.append(list(names))
        return self.units

    def failed_units(self):
        self.failed_calls += 1
        return self.failed

    def reboot(self):
        self.reboot_calls += 1
        return self.reboot_state


class FakeDocker:
    def __init__(self, usage=None, error=None):
        self.calls = 0
        self.usage_value = usage or {
            "available": True,
            "images": {"count": 0, "size": 0, "reclaimable": 0},
            "containers": {"count": 0, "size": 0},
            "volumes": {"count": 0, "size": 0},
            "buildCache": {"count": 0, "size": 0},
            "total": 0,
            "reclaimable": 0,
        }
        self.error = error

    def usage(self):
        self.calls += 1
        if self.error:
            raise OSError("docker unavailable")
        return self.usage_value


class FakeSmart:
    def __init__(self, section=None, error=None):
        self.calls = 0
        self.section = section or {"available": True, "devices": []}
        self.error = error

    def read(self):
        self.calls += 1
        if self.error:
            raise self.error
        return self.section


class FakeContainers:
    def __init__(self, section=None, error=None):
        self.calls = 0
        self.invalidated = []
        self.section = section or {"available": True, "items": []}
        self.error = error

    def read(self):
        self.calls += 1
        if self.error:
            raise self.error
        return self.section

    def invalidate(self, reference=None):
        self.invalidated.append(reference)


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.appdata = Path(self.temp.name) / "appdata"
        self.appdata.mkdir()
        self.host = FakeHost()
        self.docker = FakeDocker()
        self.ticks = [1000.0]
        self.snapshot = maintenance.Maintenance(
            appdata=self.appdata,
            role="instance",
            host_reader=self.host,
            docker_reader=self.docker,
            clock=lambda: self.ticks[0],
            cache_seconds=60,
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_missing_follower_files_leave_an_unknown_release_without_failing(self):
        snapshot = self.snapshot.snapshot()

        self.assertEqual(snapshot["role"], "instance")
        self.assertEqual(
            snapshot["follower"],
            {
                "available": False,
                "state": "unknown",
                "installed": None,
                "pending": None,
                "failed": None,
            },
        )

    def test_reads_the_follower_state_without_exposing_transaction_paths(self):
        state = self.appdata / "security-monitor" / "merged-releases"
        state.mkdir(parents=True)
        (state / "installed.json").write_text(
            json.dumps(
                {
                    "release": "v2.4.1",
                    "commit": "a" * 40,
                    "bootstrap": False,
                }
            )
        )
        (state / "pending.json").write_text(
            json.dumps(
                {
                    "release": "v2.5.0",
                    "status": "deploying",
                    "previous_installed": {"release": "v2.4.1", "commit": "a" * 40},
                    "changed": ["radarr", "sonarr"],
                    "folder": "/appdata/security-monitor/merged-releases/secret",
                    "environment": "/appdata/security-monitor/merged-releases/secret/env",
                    "snapshots": [{"source": "/appdata/private"}],
                }
            )
        )
        (state / "failed-release.json").write_text(
            json.dumps({"release": "v2.5.0", "configuration": "b" * 64})
        )

        follower = self.snapshot.snapshot()["follower"]

        self.assertTrue(follower["available"])
        self.assertEqual(follower["state"], "deploying")
        self.assertEqual(follower["installed"]["release"], "v2.4.1")
        self.assertEqual(follower["installed"]["commit"], "a" * 40)
        self.assertEqual(
            follower["pending"],
            {
                "release": "v2.5.0",
                "status": "deploying",
                "previousRelease": "v2.4.1",
                "changed": ["radarr", "sonarr"],
                "since": follower["pending"]["since"],
            },
        )
        self.assertEqual(follower["failed"]["release"], "v2.5.0")
        serialized = json.dumps(follower)
        self.assertNotIn("/appdata/private", serialized)
        self.assertNotIn("snapshots", serialized)
        self.assertNotIn("environment", serialized)
        self.assertNotIn("folder", serialized)
        self.assertNotIn("configuration", serialized)

    def test_reads_security_pins_and_pending_work_without_secrets(self):
        state = self.appdata / "security-monitor"
        (state / "comparisons").mkdir(parents=True)
        (state / "images.compose.json").write_text(
            json.dumps(
                {
                    "services": {
                        "radarr": {
                            "image": "lscr.io/linuxserver/radarr:5.27.0-ls325@sha256:"
                            + "c" * 64
                        },
                        "sonarr": {
                            "image": "lscr.io/linuxserver/sonarr:4.0.16@sha256:"
                            + "d" * 64
                        },
                    }
                }
            )
        )
        (state / "active-update.json").write_text(
            json.dumps(
                {
                    "service": "radarr",
                    "status": "deploying",
                    "candidate_ref": "lscr.io/linuxserver/radarr:5.28.0@sha256:"
                    + "e" * 64,
                    "before_pins": {"services": {"secret": {"image": "hidden"}}},
                    "snapshots": [{"source": "/appdata/private"}],
                }
            )
        )
        (state / "comparisons" / "pair.json").write_text(
            json.dumps(
                {
                    "names": ["media-stack-radarr-1"],
                    "local_ref": "lscr.io/linuxserver/radarr:5.27.0-ls325",
                    "remote_ref": "lscr.io/linuxserver/radarr:5.28.0",
                    "pinned_ref": "lscr.io/linuxserver/radarr:5.28.0@sha256:"
                    + "e" * 64,
                    "semver_diff": "minor",
                    "fixed": {"CVE-2026-0001": "HIGH", "CVE-2026-0002": "LOW"},
                    "new_severe": [],
                    "verified_at": "2026-11-13T10:00:00+00:00",
                }
            )
        )
        (state / "comparisons" / "applied.json").write_text(
            json.dumps(
                {
                    "names": ["media-stack-sonarr-1"],
                    "local_ref": "lscr.io/linuxserver/sonarr:4.0.15",
                    "remote_ref": "lscr.io/linuxserver/sonarr:4.0.16",
                    "pinned_ref": "lscr.io/linuxserver/sonarr:4.0.16@sha256:"
                    + "d" * 64,
                    "semver_diff": "patch",
                    "fixed": {"CVE-2026-0003": "HIGH"},
                    "new_severe": [],
                    "verified_at": "2026-11-13T09:00:00+00:00",
                }
            )
        )
        (state / "attempted-updates.json").write_text(
            json.dumps(
                {
                    "one": {
                        "service": "radarr",
                        "candidate": "lscr.io/linuxserver/radarr:5.28.0@sha256:"
                        + "e" * 64,
                        "result": "manual: major version: manual review",
                    },
                    "two": {
                        "service": "sonarr",
                        "candidate": "lscr.io/linuxserver/sonarr:4.0.16@sha256:"
                        + "d" * 64,
                        "result": "actualizada; comprobación de salud correcta",
                    },
                }
            )
        )

        security = self.snapshot.snapshot()["security"]

        self.assertEqual(
            [pin["service"] for pin in security["pins"]], ["radarr", "sonarr"]
        )
        self.assertEqual(security["pins"][0]["version"], "5.27.0-ls325")
        self.assertEqual(security["pins"][0]["digest"], "sha256:" + "c" * 64)
        self.assertEqual(security["pending"]["service"], "radarr")
        self.assertEqual(security["pending"]["status"], "deploying")
        self.assertEqual(security["pending"]["candidate"], "5.28.0")
        self.assertEqual(len(security["review"]), 1)
        self.assertEqual(security["review"][0]["names"], ["media-stack-radarr-1"])
        self.assertEqual(security["review"][0]["cves"], 2)
        self.assertEqual(
            security["review"][0]["reason"], "major version: manual review"
        )
        serialized = json.dumps(security)
        self.assertNotIn("before_pins", serialized)
        self.assertNotIn("snapshots", serialized)
        self.assertNotIn("hidden", serialized)
        self.assertNotIn("/appdata/private", serialized)

    def test_reads_the_last_backup_result(self):
        backup = self.appdata / "backup"
        backup.mkdir()
        (backup / "last-status").write_text("ok 2026-11-13T04:04:49+01:00\n")

        snapshot = self.snapshot.snapshot()["backup"]

        self.assertEqual(snapshot["status"], "ok")
        self.assertEqual(
            datetime.fromisoformat(snapshot["at"]).timestamp(),
            datetime.fromisoformat("2026-11-13T04:04:49+01:00").timestamp(),
        )

    def test_missing_or_malformed_backup_status_is_unknown(self):
        backup = self.appdata / "backup"
        backup.mkdir()
        (backup / "last-status").write_text("something unexpected\n")

        snapshot = self.snapshot.snapshot()["backup"]

        self.assertEqual(snapshot, {"status": "unknown", "at": None})

    def test_role_units_cover_follower_security_and_nas_automations(self):
        self.host.units = [
            {
                "name": "media-stack-merged-updates",
                "service": "media-stack-merged-updates.service",
                "timer": "media-stack-merged-updates.timer",
                "activeState": "active",
                "subState": "waiting",
                "unitFileState": "enabled",
                "result": "success",
                "lastRun": "2026-11-13T10:00:00Z",
                "nextRun": "2026-11-13T10:05:00Z",
            },
            {
                "name": "media-stack-evidence",
                "service": "media-stack-evidence.service",
                "timer": "media-stack-evidence.timer",
                "activeState": "active",
                "subState": "waiting",
                "unitFileState": "enabled",
                "result": "success",
                "lastRun": None,
                "nextRun": None,
            },
            {
                "name": "media-stack-tdarr-hardlinks",
                "service": "media-stack-tdarr-hardlinks.service",
                "timer": "media-stack-tdarr-hardlinks.timer",
                "activeState": "inactive",
                "subState": "dead",
                "unitFileState": "disabled",
                "result": "success",
                "lastRun": None,
                "nextRun": None,
            },
        ]

        units = self.snapshot.snapshot()["units"]

        self.assertEqual(
            self.host.unit_requests[0],
            list(maintenance.INSTANCE_UNITS),
        )
        self.assertEqual(
            [unit["name"] for unit in units],
            [
                "media-stack-merged-updates",
                "media-stack-evidence",
                "media-stack-tdarr-hardlinks",
            ],
        )
        self.assertEqual(units[0]["kind"], "follower")
        self.assertEqual(units[0]["state"], "active")
        self.assertEqual(units[0]["lastRun"], "2026-11-13T10:00:00Z")
        self.assertEqual(units[0]["nextRun"], "2026-11-13T10:05:00Z")
        self.assertEqual(units[2]["state"], "paused")
        self.assertTrue(units[2]["paused"])

    def test_failed_units_are_split_between_the_stack_and_other_services(self):
        self.host.failed = [
            {"name": "media-stack-upgrade.service", "description": "old upgrade"},
            {"name": "logrotate.service", "description": "log rotation"},
            {"name": "tor@default.service", "description": "tor"},
        ]

        failed = self.snapshot.snapshot()["failedUnits"]

        self.assertEqual(
            [unit["name"] for unit in failed["stack"]],
            ["media-stack-upgrade.service"],
        )
        self.assertEqual(
            [unit["name"] for unit in failed["other"]],
            ["logrotate.service", "tor@default.service"],
        )

    def test_reboot_is_available_when_the_host_supports_it(self):
        self.host.reboot_state = {"available": True, "required": True}

        reboot = self.snapshot.snapshot()["reboot"]

        self.assertEqual(reboot, {"available": True, "required": True})

    def test_reboot_is_unavailable_on_hosts_without_the_mechanism(self):
        self.host.reboot_state = {"available": False, "required": None}

        reboot = self.snapshot.snapshot()["reboot"]

        self.assertEqual(reboot, {"available": False, "required": None})

    def test_apps_host_uses_its_own_units(self):
        apps = maintenance.Maintenance(
            appdata=self.appdata,
            role="apps-server",
            host_reader=self.host,
            docker_reader=self.docker,
            clock=lambda: 1000.0,
        )

        apps.snapshot()

        self.assertEqual(self.host.unit_requests[0], list(maintenance.APPS_UNITS))
        self.assertEqual(apps.snapshot()["role"], "apps-server")

    def test_docker_usage_reports_space_and_reclaimable_space(self):
        self.docker.usage_value = {
            "available": True,
            "images": {"count": 12, "size": 42_000, "reclaimable": 30_000},
            "containers": {"count": 3, "size": 500},
            "volumes": {"count": 2, "size": 1_500},
            "buildCache": {"count": 4, "size": 2_000},
            "total": 46_000,
            "reclaimable": 31_000,
        }

        docker = self.snapshot.snapshot()["docker"]

        self.assertTrue(docker["available"])
        self.assertEqual(docker["images"], {"count": 12, "size": 42_000, "reclaimable": 30_000})
        self.assertEqual(docker["reclaimable"], 31_000)
        self.assertEqual(docker["total"], 46_000)

    def test_smart_disks_extend_the_snapshot_without_replacing_its_other_sections(self):
        disks = {
            "available": True,
            "devices": [
                {
                    "device": "sda",
                    "model": "WDC WD40EFRX-68N32N0",
                    "serial": "WD-WCC7K0AAAAAA",
                    "kind": "sata",
                    "size": 4000787030016,
                    "temperature": 34,
                    "reallocatedSectors": 0,
                    "wear": None,
                    "status": "ok",
                    "issues": [],
                }
            ],
        }
        smart_reader = FakeSmart(disks)
        snapshot = maintenance.Maintenance(
            appdata=self.appdata,
            host_reader=self.host,
            docker_reader=self.docker,
            smart_reader=smart_reader,
            clock=lambda: 1000.0,
        )

        value = snapshot.snapshot()

        self.assertEqual(value["disks"], disks)
        self.assertEqual(smart_reader.calls, 1)
        self.assertEqual(value["follower"]["state"], "unknown")
        self.assertTrue(value["docker"]["available"])

    def test_a_failing_smart_read_degrades_only_the_disks_section(self):
        snapshot = maintenance.Maintenance(
            appdata=self.appdata,
            host_reader=self.host,
            docker_reader=self.docker,
            smart_reader=FakeSmart(error=OSError("smartctl unavailable")),
            clock=lambda: 1000.0,
        )

        value = snapshot.snapshot()

        self.assertEqual(value["disks"], {"available": False, "devices": []})
        self.assertIn("disks", value["degraded"])
        self.assertEqual(value["follower"]["state"], "unknown")
        self.assertTrue(value["docker"]["available"])

    def test_snapshot_is_cached_for_about_a_minute(self):
        self.assertEqual(self.host.unit_requests, [])
        self.snapshot.snapshot()
        self.assertEqual(len(self.host.unit_requests), 1)
        self.assertEqual(self.docker.calls, 1)

        self.ticks[0] += 59
        cached = self.snapshot.snapshot()
        self.assertEqual(len(self.host.unit_requests), 1)
        self.assertEqual(self.docker.calls, 1)
        self.assertEqual(cached["timestamp"], 1000.0)

        self.ticks[0] += 2
        self.snapshot.snapshot()
        self.assertEqual(len(self.host.unit_requests), 2)
        self.assertEqual(self.docker.calls, 2)

    def test_a_failing_host_read_degrades_only_that_section(self):
        class BrokenHost(FakeHost):
            def units_for(self, names):
                raise OSError("systemd unavailable")

        self.snapshot.host_reader = BrokenHost()

        snapshot = self.snapshot.snapshot()

        self.assertEqual(snapshot["units"], [])
        self.assertIn("units", snapshot["degraded"])
        self.assertEqual(snapshot["follower"]["state"], "unknown")
        self.assertTrue(snapshot["docker"]["available"])

    def test_container_access_and_versions_are_published(self):
        reader = FakeContainers(
            {
                "available": True,
                "items": [{"id": "a" * 64, "name": "jellyfin", "version": "10.10.7"}],
            }
        )
        snapshot = maintenance.Maintenance(
            appdata=self.appdata,
            host_reader=self.host,
            docker_reader=self.docker,
            container_reader=reader,
            clock=lambda: 1000.0,
        )

        value = snapshot.snapshot()

        self.assertEqual(value["containers"]["items"][0]["version"], "10.10.7")
        self.assertNotIn("containers", value["degraded"])
        self.assertEqual(reader.calls, 1)

        snapshot.invalidate_container("lscr.io/linuxserver/jellyfin:latest")
        self.assertEqual(
            reader.invalidated, ["lscr.io/linuxserver/jellyfin:latest"]
        )

    def test_a_failing_container_read_degrades_only_that_section(self):
        snapshot = maintenance.Maintenance(
            appdata=self.appdata,
            host_reader=self.host,
            docker_reader=self.docker,
            container_reader=FakeContainers(error=OSError("docker unavailable")),
            clock=lambda: 1000.0,
        )

        value = snapshot.snapshot()

        self.assertEqual(value["containers"], {"available": False, "items": []})
        self.assertIn("containers", value["degraded"])
        self.assertTrue(value["docker"]["available"])


class RecordingExecutor:
    def __init__(self, *outputs):
        self.outputs = list(outputs)
        self.calls = []

    def run(self, argv, timeout=8):
        self.calls.append((argv, timeout))
        return self.outputs.pop(0)


class HostReaderTest(unittest.TestCase):
    def test_parses_systemd_show_into_automation_times(self):
        output = """Id=media-stack-merged-updates.service
LoadState=loaded
ActiveState=inactive
SubState=dead
UnitFileState=enabled
LastTriggerUSec=
NextElapseUSecRealtime=
NextElapseUSecMonotonic=
ExecMainStartTimestamp=@1794577367
Result=success

Id=media-stack-merged-updates.timer
LoadState=loaded
ActiveState=active
SubState=waiting
UnitFileState=enabled
LastTriggerUSec=@1794578088
NextElapseUSecRealtime=
NextElapseUSecMonotonic=1d 15min 13.568179s
ExecMainStartTimestamp=
Result=success

"""
        executor = RecordingExecutor(output)
        reader = maintenance.HostReader(
            executor=executor, clock=lambda: 10_000, monotonic_clock=lambda: 4_000
        )

        units = reader.units_for(["media-stack-merged-updates"])

        command, timeout = executor.calls[0]
        self.assertEqual(timeout, 8)
        self.assertEqual(command[:4], ["systemctl", "--timestamp=unix", "show", "--no-pager"])
        self.assertIn("media-stack-merged-updates.service", command)
        self.assertIn("media-stack-merged-updates.timer", command)
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["service"], "media-stack-merged-updates.service")
        self.assertEqual(units[0]["timer"], "media-stack-merged-updates.timer")
        self.assertEqual(units[0]["activeState"], "active")
        self.assertEqual(units[0]["unitFileState"], "enabled")
        self.assertEqual(
            datetime.fromisoformat(units[0]["lastRun"]).timestamp(), 1794578088
        )
        self.assertAlmostEqual(
            datetime.fromisoformat(units[0]["nextRun"]).timestamp(),
            6000 + 86400 + 15 * 60 + 13.568179,
            places=3,
        )

    def test_units_without_a_timer_keep_the_service_state(self):
        output = """Id=media-stack-backup.service
LoadState=loaded
ActiveState=inactive
SubState=dead
UnitFileState=static
ExecMainStartTimestamp=@1794500000
Result=success

"""
        reader = maintenance.HostReader(
            executor=RecordingExecutor(output),
            clock=lambda: 10_000,
            monotonic_clock=lambda: 4_000,
        )

        units = reader.units_for(["media-stack-backup"])

        self.assertEqual(units[0]["service"], "media-stack-backup.service")
        self.assertIsNone(units[0]["timer"])
        self.assertIsNone(units[0]["nextRun"])
        self.assertEqual(units[0]["activeState"], "inactive")

    def test_unit_names_from_configuration_cannot_become_commands(self):
        self.assertEqual(
            maintenance.parse_unit_names("media-stack-evidence,--help", "instance"),
            ["media-stack-evidence"],
        )
        self.assertEqual(
            maintenance.parse_unit_names("bad name,;rm -rf", "instance"),
            list(maintenance.INSTANCE_UNITS),
        )
        self.assertEqual(
            maintenance.parse_unit_names("custom.service,custom.timer", "instance"),
            ["custom"],
        )

    def test_parses_failed_units_and_ignores_other_lines(self):
        output = """media-stack-upgrade.service loaded failed failed Old upgrade
logrotate.service loaded failed failed Rotate logs
  some warning without columns
"""
        executor = RecordingExecutor(output)
        reader = maintenance.HostReader(executor=executor)

        failed = reader.failed_units()

        self.assertEqual(
            failed,
            [
                {"name": "media-stack-upgrade.service", "description": "Old upgrade"},
                {"name": "logrotate.service", "description": "Rotate logs"},
            ],
        )
        command, _ = executor.calls[0]
        self.assertEqual(command[0], "systemctl")
        self.assertIn("--state=failed", command)

    def test_reboot_markers_are_fixed_and_distinguish_unavailable(self):
        cases = {
            "required\n": {"available": True, "required": True},
            "available\n": {"available": True, "required": False},
            "unavailable\n": {"available": False, "required": None},
        }
        for marker, expected in cases.items():
            with self.subTest(marker=marker):
                executor = RecordingExecutor(marker)
                reader = maintenance.HostReader(executor=executor)
                self.assertEqual(reader.reboot(), expected)
                command, _ = executor.calls[0]
                self.assertEqual(command[0], "/bin/sh")
                self.assertIn("/var/run/reboot-required", command[2])


class FakeDockerSocket:
    def __init__(self):
        self.calls = []

    def call(self, method, path, body=None, *, timeout=None, raw=False):
        self.calls.append((method, path, body))
        if path == "/system/df":
            return {
                "LayersSize": 42_000,
                "Images": [
                    {"Id": "used", "Size": 10_000, "Containers": 1},
                    {"Id": "unused", "Size": 30_000, "Containers": 0},
                ],
                "Containers": [{"SizeRw": 500}],
                "Volumes": [{"UsageData": {"Size": 1_500}}],
                "BuildCache": [
                    {"Size": 1_000, "InUse": False},
                    {"Size": 1_000, "InUse": True},
                ],
            }
        raise AssertionError(path)


class DockerUsageTest(unittest.TestCase):
    def test_usage_comes_from_the_docker_system_df_endpoint(self):
        socket = FakeDockerSocket()

        usage = maintenance.DockerUsage(socket).usage()

        self.assertEqual(socket.calls[0][:2], ("GET", "/system/df"))
        self.assertEqual(usage["images"], {"count": 2, "size": 42_000, "reclaimable": 30_000})
        self.assertEqual(usage["containers"], {"count": 1, "size": 500})
        self.assertEqual(usage["volumes"], {"count": 1, "size": 1_500})
        self.assertEqual(usage["buildCache"], {"count": 2, "size": 2_000})
        self.assertEqual(usage["total"], 46_000)
        self.assertEqual(usage["reclaimable"], 31_000)


class AuxiliaryExecutorTest(unittest.TestCase):
    def test_run_uses_nsenter_with_the_fixed_arguments_and_cleans_up(self):
        class Socket:
            def __init__(self):
                self.calls = []

            def call(self, method, path, body=None, *, timeout=None, raw=False):
                self.calls.append((method, path, body, raw))
                if path == "/containers/create":
                    return {"Id": "a" * 64}
                if path.endswith("/logs?stdout=true&stderr=true"):
                    return b"\x01\x00\x00\x00\x00\x00\x00\x03ok\n"
                return {}

        socket = Socket()
        executor = maintenance.HostExecutor(docker=socket, image="hub-agent:1")

        output = executor.run(["/bin/true"], timeout=7)

        self.assertEqual(output, "ok\n")
        create = socket.calls[0]
        self.assertEqual(create[0], "POST")
        self.assertEqual(create[1], "/containers/create")
        self.assertEqual(create[2]["Entrypoint"], ["nsenter"])
        self.assertEqual(create[2]["Cmd"][:8], ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--"])
        self.assertEqual(create[2]["Cmd"][-1], "/bin/true")
        self.assertTrue(create[2]["HostConfig"]["Privileged"])
        self.assertEqual(create[2]["HostConfig"]["PidMode"], "host")
        self.assertEqual(
            create[2]["Labels"][helper_cleanup.HELPER_LABEL],
            helper_cleanup.HELPER_LABEL_VALUE,
        )
        self.assertIn(
            ("DELETE", "/containers/" + "a" * 64 + "?v=0", None, False),
            socket.calls,
        )


class DiskExecutorTest(unittest.TestCase):
    def test_runs_smartctl_in_the_image_with_the_host_devices_read_only(self):
        class Socket:
            def __init__(self):
                self.calls = []

            def call(self, method, path, body=None, *, timeout=None, raw=False):
                self.calls.append((method, path, body, raw))
                if path == "/containers/create":
                    return {"Id": "c" * 64}
                if path == "/containers/" + "c" * 64 + "/logs?stdout=true&stderr=false":
                    return b"\x01\x00\x00\x00\x00\x00\x00\x03ok\n"
                return {}

        socket = Socket()
        executor = maintenance.DiskExecutor(
            docker=socket, image="hub-agent:1"
        )

        output = executor.run(["smartctl", "--scan-open", "--json"], timeout=7)

        self.assertEqual(output, "ok\n")
        create = socket.calls[0]
        self.assertEqual(create[0:2], ("POST", "/containers/create"))
        self.assertEqual(create[2]["Image"], "hub-agent:1")
        self.assertEqual(create[2]["Entrypoint"], ["smartctl"])
        self.assertEqual(create[2]["Cmd"], ["--scan-open", "--json"])
        self.assertTrue(create[2]["HostConfig"]["Privileged"])
        self.assertIn("/dev:/dev:ro", create[2]["HostConfig"]["Binds"])
        self.assertIn("/sys:/sys:ro", create[2]["HostConfig"]["Binds"])
        self.assertNotIn("PidMode", create[2]["HostConfig"])
        self.assertEqual(
            create[2]["Labels"][helper_cleanup.FAMILY_LABEL], "disk"
        )
        self.assertIn(
            (
                "GET",
                "/containers/" + "c" * 64 + "/logs?stdout=true&stderr=false",
                None,
                True,
            ),
            socket.calls,
        )
        self.assertIn(
            ("DELETE", "/containers/" + "c" * 64 + "?v=0", None, False),
            socket.calls,
        )


class FakeNotFound(OSError):
    status = 404


class HelperDocker:
    """Records every Docker call and simulates helper containers."""

    def __init__(self, clock=lambda: 1000.0, delete_failures=0):
        self.clock = clock
        self.calls = []
        self.containers = {}
        self.details = {}
        self.delete_failures = delete_failures
        self.fail_list = False
        self.inspect_failures = {}
        self.counter = 0

    def new_id(self):
        self.counter += 1
        return "%064x" % self.counter

    def add_helper(
        self,
        *,
        owner,
        instance,
        family="host",
        created=300.0,
        state="exited",
        marker=True,
        labels_extra=None,
    ):
        ident = self.new_id()
        labels = dict(labels_extra or {})
        if marker:
            labels[helper_cleanup.HELPER_LABEL] = helper_cleanup.HELPER_LABEL_VALUE
        labels[helper_cleanup.OWNER_LABEL] = owner
        if family is not None:
            labels[helper_cleanup.FAMILY_LABEL] = family
        if instance is not None:
            labels[helper_cleanup.INSTANCE_LABEL] = instance
        labels[helper_cleanup.CREATED_LABEL] = str(int(created))
        self.containers[ident] = {
            "Id": ident,
            "Names": ["/helper-" + ident[:8]],
            "Image": "hub-agent:1",
            "Labels": labels,
            "State": state,
            "Created": created,
        }
        self.details[ident] = {
            "Id": ident,
            "Config": {"Labels": labels},
            "State": {
                "Status": state,
                "Running": state == "running",
            },
        }
        return ident

    def deletes(self):
        return [path for method, path, _, _ in self.calls if method == "DELETE"]

    def call(self, method, path, body=None, *, timeout=None, raw=False):
        self.calls.append((method, path, body, timeout))
        if method == "POST" and path == "/containers/create":
            ident = self.new_id()
            labels = (body or {}).get("Labels") or {}
            now = self.clock()
            self.containers[ident] = {
                "Id": ident,
                "Names": ["/helper-" + ident[:8]],
                "Image": (body or {}).get("Image"),
                "Labels": labels,
                "State": "created",
                "Created": now,
            }
            self.details[ident] = {
                "Id": ident,
                "Config": {"Labels": labels},
                "State": {"Status": "created", "Running": False},
            }
            return {"Id": ident}
        if method == "POST" and path.endswith("/start"):
            ident = path.split("/")[2]
            self.containers[ident]["State"] = "running"
            self.details[ident]["State"] = {
                "Status": "running",
                "Running": True,
            }
            return {}
        if method == "POST" and path.endswith("/wait"):
            return {"StatusCode": 0}
        if method == "GET" and path.endswith("/logs?stdout=true&stderr=true"):
            return b"\x01\x00\x00\x00\x00\x00\x00\x03ok\n"
        if method == "GET" and path == "/containers/json?all=true":
            if self.fail_list:
                raise OSError("inventario no disponible")
            return list(self.containers.values())
        if (
            method == "GET"
            and path.startswith("/containers/")
            and path.endswith("/json")
        ):
            ident = path.split("/")[2]
            if self.inspect_failures.get(ident):
                self.inspect_failures[ident] -= 1
                raise OSError("inspección no disponible")
            if ident not in self.details:
                raise FakeNotFound("no existe")
            return self.details[ident]
        if method == "DELETE" and path.startswith("/containers/"):
            ident = path.split("/")[2].split("?")[0]
            if self.delete_failures:
                self.delete_failures -= 1
                raise OSError("eliminación fallida")
            if ident not in self.containers:
                raise FakeNotFound("no existe")
            self.containers.pop(ident, None)
            self.details.pop(ident, None)
            return {}
        raise AssertionError((method, path))


class HelperCleanupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.appdata = Path(self.temp.name)
        self.ticks = [1000.0]
        self.clock = lambda: self.ticks[0]
        self.registry = helper_cleanup.HelperRegistry(
            owner="hub-agent:test:instance",
            instance="a" * 32,
            clock=self.clock,
        )
        self.docker = HelperDocker(clock=self.clock)
        self.snapshot = maintenance.Maintenance(
            appdata=self.appdata,
            host_reader=FakeHost(),
            docker_reader=FakeDocker(),
            helper_cleanup=self.registry,
            clock=self.clock,
            cache_seconds=60,
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_a_failed_delete_is_visible_then_persistent_after_the_background_retry(self):
        self.docker.delete_failures = 3
        executor = maintenance.HostExecutor(
            docker=self.docker, registry=self.registry
        )

        self.assertEqual(executor.run(["/bin/true"]), "ok\n")
        ident = next(iter(self.docker.containers))
        self.docker.containers[ident]["Created"] = self.ticks[0] - 700
        self.docker.containers[ident]["Labels"][
            helper_cleanup.CREATED_LABEL
        ] = str(int(self.ticks[0] - 700))
        self.docker.containers[ident]["State"] = "exited"
        self.docker.details[ident]["State"] = {
            "Status": "exited",
            "Running": False,
        }

        first = self.snapshot.snapshot()
        self.assertEqual(first["helperCleanup"]["status"], "failing")
        self.assertEqual(first["helperCleanup"]["pending"], 1)
        self.assertEqual(first["helperCleanup"]["persistent"], 0)

        # Reading the snapshot is not a cleanup attempt.
        for _ in range(3):
            repeated = self.snapshot.snapshot()
        self.assertEqual(repeated["helperCleanup"]["persistent"], 0)
        self.assertEqual(repeated["timestamp"], first["timestamp"])

        reaper = helper_cleanup.HelperReaper(
            docker=self.docker,
            registry=self.registry,
            clock=self.clock,
        )
        result = reaper.sweep()

        self.assertEqual(result["deleted"], 0)
        self.assertEqual(
            self.registry.section(self.ticks[0]),
            {
                "available": True,
                "status": "persistent",
                "checkedAt": repeated["helperCleanup"]["checkedAt"],
                "pending": 1,
                "persistent": 1,
            },
        )
        deletes = self.docker.deletes()
        self.assertEqual(len(deletes), 2)
        self.assertTrue(all(path.endswith("?v=0") for path in deletes))

    def test_the_cleanup_failure_is_not_hidden_by_the_mantained_cache(self):
        first = self.snapshot.snapshot()
        self.assertEqual(first["helperCleanup"]["status"], "indeterminate")

        ident = self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            created=self.ticks[0] - 700,
        )
        self.docker.delete_failures = 0
        self.registry.discover(ident, "host", self.ticks[0] - 700)
        self.registry.record_delete_failure(ident, "host", self.ticks[0])

        second = self.snapshot.snapshot()

        self.assertEqual(second["timestamp"], first["timestamp"])
        self.assertEqual(second["helperCleanup"]["status"], "failing")
        self.assertEqual(second["helperCleanup"]["pending"], 1)

    def test_two_scattered_failures_do_not_reach_the_persistent_threshold(self):
        first = self.docker.add_helper(
            owner=self.registry.owner, instance="b" * 32
        )
        second = self.docker.add_helper(
            owner=self.registry.owner, instance="b" * 32, family="disk"
        )
        self.registry.discover(first, "host", 300.0)
        self.registry.discover(second, "disk", 300.0)
        self.registry.record_delete_failure(first, "host", self.ticks[0])
        self.registry.record_delete_failure(second, "disk", self.ticks[0])

        section = self.registry.section(self.ticks[0])

        self.assertEqual(section["status"], "failing")
        self.assertEqual(section["pending"], 2)
        self.assertEqual(section["persistent"], 0)

    def test_a_partial_resolution_keeps_the_remaining_helper_pending(self):
        first = self.docker.add_helper(
            owner=self.registry.owner, instance="b" * 32
        )
        second = self.docker.add_helper(
            owner=self.registry.owner, instance="b" * 32, family="disk"
        )
        self.registry.discover(first, "host", 300.0)
        self.registry.record_delete_failure(first, "host", self.ticks[0])
        self.registry.record_delete_failure(first, "host", self.ticks[0])
        self.registry.discover(second, "disk", 300.0)
        self.registry.record_delete_failure(second, "disk", self.ticks[0])

        self.registry.confirm_removed(first, self.ticks[0])
        section = self.registry.section(self.ticks[0])
        self.assertEqual(section["status"], "failing")
        self.assertEqual(section["pending"], 1)
        self.assertEqual(section["persistent"], 0)

        self.registry.confirm_absent(second, self.ticks[0])
        self.assertEqual(
            self.registry.section(self.ticks[0])["status"], "indeterminate"
        )

        reaper = helper_cleanup.HelperReaper(
            docker=self.docker, registry=self.registry, clock=self.clock
        )
        reaper.sweep()
        self.assertEqual(self.registry.section(self.ticks[0])["status"], "clean")

    def _reaper(self):
        return helper_cleanup.HelperReaper(
            docker=self.docker, registry=self.registry, clock=self.clock
        )

    def test_a_previous_generation_orphan_is_deleted_without_volumes(self):
        ident = self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            family="host",
        )
        self.assertEqual(
            self.registry.section(self.ticks[0])["status"], "indeterminate"
        )

        result = self._reaper().sweep()

        self.assertEqual(result["deleted"], 1)
        self.assertEqual(
            self.docker.deletes(), ["/containers/" + ident + "?v=0"]
        )
        self.assertEqual(self.registry.section(self.ticks[0])["status"], "clean")

    def test_foreign_containers_with_the_same_image_are_never_deleted(self):
        self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            marker=False,
        )
        self.docker.add_helper(
            owner="hub-agent:other:instance",
            instance="b" * 32,
            family="host",
        )

        result = self._reaper().sweep()

        self.assertEqual(result["deleted"], 0)
        self.assertEqual(self.docker.deletes(), [])

    def test_incomplete_ownership_labels_are_preserved(self):
        self.docker.add_helper(
            owner=self.registry.owner,
            instance=None,
            family="host",
        )
        result = self._reaper().sweep()
        self.assertEqual(result["deleted"], 0)
        self.assertEqual(self.docker.deletes(), [])
        self.assertEqual(
            self.registry.section(self.ticks[0])["status"], "indeterminate"
        )

        self.docker.containers.clear()
        self.docker.details.clear()
        self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            family=None,
        )
        result = self._reaper().sweep()
        self.assertEqual(result["deleted"], 0)
        self.assertEqual(self.docker.deletes(), [])

    def test_active_helpers_and_old_running_helpers_are_preserved(self):
        running = self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            family="host",
            state="running",
            created=self.ticks[0] - 900,
        )
        active = self.docker.add_helper(
            owner=self.registry.owner,
            instance=self.registry.instance,
            family="host",
            state="exited",
            created=self.ticks[0] - 900,
        )
        self.registry.enrol(active, "host")

        result = self._reaper().sweep()

        self.assertEqual(result["deleted"], 0)
        self.assertEqual(self.docker.deletes(), [])
        self.assertIn(running, self.docker.containers)
        self.assertIn(active, self.docker.containers)

        self.registry.release(active)
        result = self._reaper().sweep()
        self.assertEqual(result["deleted"], 1)
        self.assertIn(running, self.docker.containers)
        self.assertNotIn(active, self.docker.containers)

    def test_the_reboot_helper_is_protected_while_it_runs(self):
        running = self.docker.add_helper(
            owner=self.registry.owner,
            instance=self.registry.instance,
            family="reboot",
            state="running",
            created=self.ticks[0] - 900,
        )
        self.registry.enrol(running, "reboot")
        self.registry.protect(running)
        stopped = self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            family="reboot",
            state="exited",
            created=self.ticks[0] - 900,
        )
        self.registry.enrol(stopped, "reboot")
        self.registry.protect(stopped)

        result = self._reaper().sweep()

        self.assertEqual(result["deleted"], 0)
        self.assertEqual(self.docker.deletes(), [])

    def test_an_invalid_identifier_leaves_the_sweep_indeterminate(self):
        self.docker.containers["bad"] = {
            "Id": "not-a-docker-id",
            "Labels": {},
            "State": "exited",
            "Created": 300.0,
        }

        result = self._reaper().sweep()

        self.assertEqual(result["deleted"], 0)
        self.assertEqual(self.docker.deletes(), [])
        self.assertEqual(
            self.registry.section(self.ticks[0])["status"], "indeterminate"
        )

    def test_an_inventory_failure_preserves_the_pending_attempts(self):
        ident = self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            family="host",
        )
        self.registry.discover(ident, "host", 300.0)
        self.registry.record_delete_failure(ident, "host", self.ticks[0])
        self.docker.fail_list = True

        result = self._reaper().sweep()

        self.assertEqual(result["deleted"], 0)
        self.assertEqual(self.docker.deletes(), [])
        section = self.registry.section(self.ticks[0])
        self.assertEqual(section["status"], "indeterminate")
        self.assertEqual(section["pending"], 1)

    def test_an_incoherent_inspection_preserves_the_helper(self):
        ident = self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            family="host",
        )
        self.docker.details[ident]["Id"] = "d" * 64

        result = self._reaper().sweep()

        self.assertEqual(result["deleted"], 0)
        self.assertEqual(self.docker.deletes(), [])
        self.assertEqual(
            self.registry.section(self.ticks[0])["status"], "indeterminate"
        )

    def test_an_inspection_without_a_valid_stopped_state_preserves_the_helper(self):
        ident = self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
        )
        detail = self.docker.details[ident]
        detail.pop("State")
        reaper = self._reaper()

        for state in (
            None,
            {"Status": "unknown"},
            {"Status": "exited", "Running": True},
        ):
            with self.subTest(state=state):
                if state is not None:
                    detail["State"] = state

                result = reaper.sweep()

                self.assertEqual(result, {"status": "indeterminate", "deleted": 0})
                self.assertEqual(self.docker.deletes(), [])
                self.assertIn(ident, self.docker.containers)

    def test_an_unknown_inventory_state_leaves_the_sweep_indeterminate(self):
        ident = self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
        )
        self.docker.containers[ident]["State"] = "unknown"

        result = self._reaper().sweep()

        self.assertEqual(result, {"status": "indeterminate", "deleted": 0})
        self.assertEqual(self.docker.deletes(), [])

    def test_failed_deletes_count_towards_the_candidate_limit(self):
        for _ in range(6):
            self.docker.add_helper(owner=self.registry.owner, instance="b" * 32)
        self.docker.delete_failures = 6

        result = self._reaper().sweep()

        self.assertEqual(len(self.docker.deletes()), 5)
        self.assertEqual(result, {"status": "indeterminate", "deleted": 0})
        self.assertEqual(self.registry.section()["pending"], 5)

    def test_a_candidate_beyond_the_limit_prevents_a_clean_sweep(self):
        for _ in range(6):
            last = self.docker.add_helper(owner=self.registry.owner, instance="b" * 32)
        reaper = self._reaper()

        result = reaper.sweep()

        self.assertEqual(result, {"status": "indeterminate", "deleted": 5})
        self.assertEqual(list(self.docker.containers), [last])
        self.assertEqual(reaper.sweep(), {"status": "clean", "deleted": 1})

    def test_two_coexisting_roles_are_each_deleted_once(self):
        host = self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            family="host",
        )
        disk = self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            family="disk",
        )

        result = self._reaper().sweep()

        self.assertEqual(result["deleted"], 2)
        self.assertEqual(
            sorted(self.docker.deletes()),
            sorted(
                [
                    "/containers/" + host + "?v=0",
                    "/containers/" + disk + "?v=0",
                ]
            ),
        )

    def test_a_lost_counter_does_not_imply_recovery(self):
        self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            family="host",
        )
        self.docker.delete_failures = 1

        self._reaper().sweep()
        section = self.registry.section(self.ticks[0])
        self.assertEqual(section["status"], "failing")
        self.assertEqual(section["pending"], 1)
        self.assertEqual(section["persistent"], 0)

        self._reaper().sweep()
        self.assertEqual(
            self.registry.section(self.ticks[0])["status"], "clean"
        )

    def test_a_too_recent_orphan_is_preserved(self):
        self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            family="host",
            created=self.ticks[0] - 60,
        )

        result = self._reaper().sweep()

        self.assertEqual(result["deleted"], 0)
        self.assertEqual(self.docker.deletes(), [])

    def test_a_pending_helper_absent_from_a_complete_list_is_accredited(self):
        ident = self.docker.add_helper(
            owner=self.registry.owner,
            instance="b" * 32,
            family="host",
        )
        self.registry.discover(ident, "host", 300.0)
        self.registry.record_delete_failure(ident, "host", self.ticks[0])
        self.docker.containers.clear()
        self.docker.details.clear()

        result = self._reaper().sweep()

        self.assertEqual(result["deleted"], 0)
        self.assertEqual(self.docker.deletes(), [])
        self.assertEqual(self.registry.section(self.ticks[0])["status"], "clean")

    def test_an_older_check_date_never_replaces_a_newer_one(self):
        self.registry.finish_sweep(2000.0, True)
        self.registry.mark_indeterminate(1000.0)

        section = self.registry.section(self.ticks[0])

        self.assertEqual(helper_cleanup._iso(2000.0), section["checkedAt"])


class MaintenanceRouteTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.appdata = Path(self.temp.name)
        self.previous = (server.TOKEN, server.ALLOWED_NETWORKS, server.MAINTENANCE)
        server.TOKEN = "t" * 32
        server.ALLOWED_NETWORKS = server.allowed_networks("127.0.0.1")
        server.MAINTENANCE = maintenance.Maintenance(
            appdata=self.appdata,
            host_reader=FakeHost(),
            docker_reader=FakeDocker(),
            clock=lambda: 2000.0,
        )
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        server.TOKEN, server.ALLOWED_NETWORKS, server.MAINTENANCE = self.previous
        self.temp.cleanup()

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

    def test_maintenance_route_returns_the_cached_snapshot_with_auth(self):
        status, body = self.request("/maintenance")

        self.assertEqual(status, 200)
        self.assertEqual(body["timestamp"], 2000.0)
        self.assertEqual(body["follower"]["state"], "unknown")
        self.assertNotIn(str(self.appdata), json.dumps(body))

    def test_maintenance_route_rejects_a_missing_token(self):
        status, _ = self.request("/maintenance", token=None)

        self.assertEqual(status, 401)


if __name__ == "__main__":
    unittest.main()
