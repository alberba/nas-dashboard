import json
from pathlib import Path
import tempfile
import unittest

import maintenance_actions


class FakeDocker:
    def __init__(self, responses=None):
        self.responses = responses or {}
        self.calls = []

    def call(self, method, path, body=None, *, timeout=None, raw=False):
        self.calls.append((method, path, body, raw))
        key = (method, path)
        value = self.responses.get(key)
        if isinstance(value, Exception):
            raise value
        return value


class FakeExecutor:
    def __init__(self, status=0, output="", error=None):
        self.status = status
        self.output = output
        self.error = error
        self.calls = []

    def run_status(self, argv, timeout=8):
        self.calls.append((list(argv), timeout))
        if self.error:
            raise self.error
        return self.status, self.output


class ActionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.appdata = Path(self.temp.name)
        self.checkout = "/volume2/media-stack"

    def tearDown(self):
        self.temp.cleanup()

    def actions(self, docker=None, executor=None, role="instance"):
        return maintenance_actions.MaintenanceActions(
            appdata=self.appdata,
            role=role,
            checkout=self.checkout,
            docker=docker or FakeDocker(),
            executor=executor or FakeExecutor(),
        )


def image(ident, size, tags=(), digests=(), containers=0, created=0):
    return {
        "Id": "sha256:" + ident * 64,
        "RepoTags": list(tags),
        "RepoDigests": list(digests),
        "Containers": containers,
        "Size": size,
        "Created": created,
    }


class CleanImagesTest(ActionsTest):
    def write_state(self):
        monitor = self.appdata / "security-monitor"
        (monitor / "merged-releases").mkdir(parents=True)
        (monitor / "images.compose.json").write_text(
            json.dumps(
                {
                    "services": {
                        "radarr": {
                            "image": "lscr.io/linuxserver/radarr:5.27.0-ls325@sha256:"
                            + "c" * 64
                        }
                    }
                }
            )
        )
        (monitor / "active-update.json").write_text(
            json.dumps(
                {
                    "service": "sonarr",
                    "old_id": "sha256:" + "e" * 64,
                    "old_pin": "sonarr:4.0.15",
                    "before_pins": {
                        "services": {
                            "sonarr": {"image": "sonarr:4.0.15"},
                            "bazarr": {"image": "bazarr:1.2.3"},
                        }
                    },
                }
            )
        )
        (monitor / "merged-releases" / "pending.json").write_text(
            json.dumps(
                {
                    "release": "v2.5.0",
                    "status": "deploying",
                    "images": {
                        "radarr": {
                            "id": "sha256:" + "d" * 64,
                            "reference": "follower:old",
                        }
                    },
                }
            )
        )

    def test_deletes_only_unused_images_while_keeping_every_rollback_image(self):
        self.write_state()
        removable = [
            image("a", 100, ["unused/old:1"], created=2),
            image("b", 200, ["other:2"], created=1),
        ]
        rollback = [
            image(
                "c",
                300,
                ["lscr.io/linuxserver/radarr:5.27.0-ls325"],
                ["lscr.io/linuxserver/radarr@sha256:" + "c" * 64],
            ),
            image("d", 400, ["follower:old"]),
            image("e", 500, ["sonarr:4.0.15"]),
            image("f", 600, ["bazarr:1.2.3"]),
        ]
        used = image("1", 700, ["stopped:app"])
        still_used = image("2", 800, ["counted:image"], containers=1)
        docker = FakeDocker(
            {
                ("GET", "/images/json"): removable + rollback + [used, still_used],
                ("GET", "/containers/json?all=1"): [
                    {
                        "Names": ["/old-app"],
                        "ImageID": "sha256:" + "1" * 64,
                        "State": "exited",
                    }
                ],
                (
                    "DELETE",
                    "/images/sha256:" + "a" * 64 + "?force=0&noprune=1",
                ): [],
                (
                    "DELETE",
                    "/images/sha256:" + "b" * 64 + "?force=0&noprune=1",
                ): [],
            }
        )

        result = self.actions(docker=docker).execute("clean-images")

        cleanup = result["cleanup"]
        self.assertEqual(cleanup["imagesRemoved"], 2)
        self.assertEqual(cleanup["imagesPreserved"], 4)
        self.assertEqual(cleanup["reclaimedBytes"], 300)
        deletes = [call for call in docker.calls if call[0] == "DELETE"]
        self.assertEqual(
            sorted(call[1] for call in deletes),
            sorted(
                [
                    "/images/sha256:" + "a" * 64 + "?force=0&noprune=1",
                    "/images/sha256:" + "b" * 64 + "?force=0&noprune=1",
                ]
            ),
        )
        self.assertFalse(
            any(call[1].startswith("/images/prune") for call in docker.calls),
            "cleanup must never run an indiscriminate prune",
        )

    def test_preserves_an_old_pin_that_is_a_local_image_id(self):
        monitor = self.appdata / "security-monitor"
        monitor.mkdir()
        (monitor / "active-update.json").write_text(
            json.dumps(
                {
                    "old_id": "sha256:" + "e" * 64,
                    "old_pin": "sha256:" + "f" * 64,
                    "before_pins": {"services": {}},
                }
            )
        )
        docker = FakeDocker(
            {
                ("GET", "/images/json"): [
                    image("f", 900, []),
                    image("a", 100, ["unused:1"]),
                ],
                ("GET", "/containers/json?all=1"): [],
                (
                    "DELETE",
                    "/images/sha256:" + "a" * 64 + "?force=0&noprune=1",
                ): [],
            }
        )

        cleanup = self.actions(docker=docker).execute("clean-images")["cleanup"]

        self.assertEqual(cleanup["imagesPreserved"], 1)
        self.assertEqual(cleanup["imagesRemoved"], 1)
        self.assertEqual(
            [call[1] for call in docker.calls if call[0] == "DELETE"],
            ["/images/sha256:" + "a" * 64 + "?force=0&noprune=1"],
        )

    def test_fails_closed_without_deleting_when_rollback_state_is_unreadable(self):
        monitor = self.appdata / "security-monitor"
        monitor.mkdir()
        (monitor / "merged-releases").mkdir()
        (monitor / "merged-releases" / "pending.json").write_text("{not json")
        docker = FakeDocker(
            {
                ("GET", "/images/json"): [
                    image("a", 100, ["unused:1"])
                ]
            }
        )

        with self.assertRaises(ValueError):
            self.actions(docker=docker).execute("clean-images")

        self.assertEqual(docker.calls, [])

    def test_a_rejected_delete_does_not_stop_the_others_or_retry(self):
        docker = FakeDocker(
            {
                ("GET", "/images/json"): [
                    image("a", 100, ["first:1"], created=2),
                    image("b", 200, ["second:1"], created=1),
                ],
                ("GET", "/containers/json?all=1"): [],
                (
                    "DELETE",
                    "/images/sha256:" + "a" * 64 + "?force=0&noprune=1",
                ): OSError("image in use"),
                (
                    "DELETE",
                    "/images/sha256:" + "b" * 64 + "?force=0&noprune=1",
                ): [],
            }
        )

        cleanup = self.actions(docker=docker).execute("clean-images")["cleanup"]

        deletes = [call[1] for call in docker.calls if call[0] == "DELETE"]
        self.assertEqual(len(deletes), 2)
        self.assertEqual(cleanup["imagesRemoved"], 1)
        self.assertEqual(cleanup["imagesFailed"], 1)
        self.assertEqual(cleanup["reclaimedBytes"], 200)

    def test_fails_closed_when_the_active_security_update_has_no_old_image(self):
        monitor = self.appdata / "security-monitor"
        monitor.mkdir()
        (monitor / "active-update.json").write_text(
            json.dumps({"service": "radarr", "status": "deploying"})
        )
        docker = FakeDocker(
            {
                ("GET", "/images/json"): [
                    image("a", 100, ["unused:1"])
                ]
            }
        )

        with self.assertRaises(ValueError):
            self.actions(docker=docker).execute("clean-images")

        self.assertEqual(docker.calls, [])


class CheckHealthTest(ActionsTest):
    def media(self, project="media-stack"):
        def container(name, ident, service, state="running", health="healthy"):
            return {
                "Names": ["/" + name],
                "Id": ident,
                "State": state,
                "Labels": {
                    "com.docker.compose.project": project,
                    "com.docker.compose.service": service,
                },
                "inspect": {
                    "State": {
                        "Status": state,
                        "Running": state == "running",
                        "ExitCode": 0 if state == "exited" else 1,
                        "Health": {"Status": health} if health else None,
                    }
                },
            }

        containers = [
            container("gluetun", "a" * 64, "gluetun"),
            container("jellyfin", "b" * 64, "jellyfin"),
            container("radarr", "c" * 64, "radarr", health="unhealthy"),
            container("wire", "d" * 64, "wire", state="exited", health=None),
        ]
        agent = container("hub-agent", "e" * 64, "agent")
        agent["Labels"]["com.docker.compose.project"] = "nas-dashboard"
        return containers + [agent]

    def docker(self, containers):
        responses = {("GET", "/containers/json?all=1"): containers}
        for container in containers:
            responses[("GET", "/containers/" + container["Id"] + "/json")] = (
                container["inspect"]
            )
        return FakeDocker(responses)

    def test_reports_the_vpn_and_every_app_health_by_role(self):
        result = self.actions(docker=self.docker(self.media())).execute(
            "check-health"
        )

        health = result["health"]
        self.assertTrue(health["vpn"]["applicable"])
        self.assertTrue(health["vpn"]["connected"])
        self.assertEqual(
            [(app["name"], app["healthy"]) for app in health["apps"]],
            [("jellyfin", True), ("radarr", False)],
        )
        self.assertFalse(health["healthy"])

    def test_a_missing_vpn_container_makes_the_instance_unhealthy(self):
        containers = [
            {
                "Names": ["/jellyfin"],
                "Id": "b" * 64,
                "State": "running",
                "Labels": {
                    "com.docker.compose.project": "media-stack",
                    "com.docker.compose.service": "jellyfin",
                },
                "inspect": {
                    "State": {
                        "Status": "running",
                        "Running": True,
                        "ExitCode": 0,
                        "Health": {"Status": "healthy"},
                    }
                },
            }
        ]

        health = self.actions(docker=self.docker(containers)).execute(
            "check-health"
        )["health"]

        self.assertTrue(health["vpn"]["applicable"])
        self.assertFalse(health["vpn"]["connected"])
        self.assertFalse(health["healthy"])

    def test_the_apps_server_has_no_vpn_and_checks_its_own_project(self):
        containers = [
            {
                "Names": ["/seerr"],
                "Id": "f" * 64,
                "State": "running",
                "Labels": {
                    "com.docker.compose.project": "media-stack-apps",
                    "com.docker.compose.service": "seerr",
                },
                "inspect": {
                    "State": {
                        "Status": "running",
                        "Running": True,
                        "ExitCode": 0,
                        "Health": {"Status": "healthy"},
                    }
                },
            },
            {
                "Names": ["/media-stack-1"],
                "Id": "1" * 64,
                "State": "running",
                "Labels": {
                    "com.docker.compose.project": "media-stack",
                    "com.docker.compose.service": "radarr",
                },
                "inspect": {
                    "State": {
                        "Status": "running",
                        "Running": True,
                        "ExitCode": 0,
                        "Health": {"Status": "unhealthy"},
                    }
                },
            },
        ]

        result = self.actions(
            docker=self.docker(containers), role="apps-server"
        ).execute("check-health")

        health = result["health"]
        self.assertFalse(health["vpn"]["applicable"])
        self.assertIsNone(health["vpn"]["connected"])
        self.assertEqual(
            [(app["name"], app["healthy"]) for app in health["apps"]],
            [("seerr", True)],
        )
        self.assertTrue(health["healthy"])


class ReconnectAppsTest(ActionsTest):
    def test_instance_launches_the_fixed_wiring_command(self):
        executor = FakeExecutor(
            output="ok   every app is wired\n"
        )

        result = self.actions(executor=executor).execute("reconnect-apps")

        self.assertTrue(result["wiring"]["started"])
        self.assertEqual(
            executor.calls[0][0],
            [
                "docker",
                "compose",
                "--project-directory",
                self.checkout,
                "--env-file",
                self.checkout + "/.env",
                "up",
                "-d",
                "--no-deps",
                "wire",
            ],
        )
        self.assertEqual(len(executor.calls), 1)

    def test_the_apps_server_has_no_wiring_to_reconnect(self):
        executor = FakeExecutor()

        with self.assertRaises(ValueError):
            self.actions(executor=executor, role="apps-server").execute(
                "reconnect-apps"
            )

        self.assertEqual(executor.calls, [])

    def test_a_failed_wiring_command_is_not_retried(self):
        executor = FakeExecutor(status=1)

        with self.assertRaises(maintenance_actions.CommandFailed):
            self.actions(executor=executor).execute("reconnect-apps")

        self.assertEqual(len(executor.calls), 1)

    def test_requires_an_absolute_configured_checkout(self):
        executor = FakeExecutor()
        actions = maintenance_actions.MaintenanceActions(
            appdata=self.appdata,
            checkout="relative/media-stack",
            docker=FakeDocker(),
            executor=executor,
        )

        with self.assertRaises(ValueError):
            actions.execute("reconnect-apps")

        self.assertEqual(executor.calls, [])


class BackupNowTest(ActionsTest):
    def test_starts_the_fixed_backup_exec_without_the_privileged_helper(self):
        docker = FakeDocker(
            {
                ("GET", "/containers/json?all=1"): [
                    {"Names": ["/backup"], "State": "running", "Labels": {}}
                ],
                ("POST", "/containers/backup/exec"): {"Id": "a" * 64},
                ("POST", "/exec/" + "a" * 64 + "/start"): None,
            }
        )
        executor = FakeExecutor()
        backup = self.appdata / "backup"
        backup.mkdir()
        (backup / "last-status").write_text("ok 2026-11-13T04:04:49+01:00\n")

        result = self.actions(docker=docker, executor=executor).execute(
            "backup-now"
        )

        self.assertEqual(result["command"], "backup-now")
        self.assertEqual(result["status"], "success")
        self.assertTrue(result["backup"]["started"])
        self.assertEqual(result["backup"]["lastStatus"]["status"], "ok")
        self.assertEqual(
            (docker.calls[1][0], docker.calls[1][1], docker.calls[1][2]),
            (
                "POST",
                "/containers/backup/exec",
                {
                    "AttachStdout": False,
                    "AttachStderr": False,
                    "Cmd": ["media-backup", "run"],
                },
            ),
        )
        self.assertEqual(
            (docker.calls[2][0], docker.calls[2][1], docker.calls[2][2]),
            ("POST", "/exec/" + "a" * 64 + "/start", {"Detach": True}),
        )
        self.assertEqual(executor.calls, [])

    def test_refuses_to_run_without_the_backup_container(self):
        docker = FakeDocker({("GET", "/containers/json?all=1"): []})

        with self.assertRaises(ValueError):
            self.actions(docker=docker).execute("backup-now")

        self.assertEqual(
            [call[1] for call in docker.calls], ["/containers/json?all=1"]
        )

    def test_refuses_a_stopped_backup_container(self):
        docker = FakeDocker(
            {
                ("GET", "/containers/json?all=1"): [
                    {"Names": ["/backup"], "State": "exited", "Labels": {}}
                ]
            }
        )

        with self.assertRaises(ValueError):
            self.actions(docker=docker).execute("backup-now")

        self.assertEqual(len(docker.calls), 1)


if __name__ == "__main__":
    unittest.main()
