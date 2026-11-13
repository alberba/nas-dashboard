import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

import host_commands
import maintenance
import server


class RecordingExecutor:
    def __init__(self, status=0, error=None):
        self.status = status
        self.error = error
        self.calls = []

    def run_status(self, argv, timeout=15):
        self.calls.append((list(argv), timeout))
        if self.error:
            raise self.error
        return self.status, ""


class PrivilegedExitCodeTest(unittest.TestCase):
    def test_run_status_reports_the_helper_exit_code_and_cleans_up(self):
        class Socket:
            def __init__(self):
                self.calls = []

            def call(self, method, path, body=None, *, timeout=None, raw=False):
                self.calls.append((method, path, body, raw))
                if path == "/containers/create":
                    return {"Id": "helper"}
                if path.endswith("/wait"):
                    return {"StatusCode": 7}
                if path.endswith("/logs?stdout=true&stderr=true"):
                    return b"\x01\x00\x00\x00\x00\x00\x00\x06failed"
                return {}

        socket = Socket()
        executor = maintenance.HostExecutor(docker=socket, image="hub-agent:1")

        status, output = executor.run_status(["systemctl", "status"], timeout=7)

        self.assertEqual(status, 7)
        self.assertEqual(output, "failed")
        self.assertIn(("DELETE", "/containers/helper?force=1", None, False), socket.calls)


class HostCommandTest(unittest.TestCase):
    def commands(self, role="instance", unit_names=None, executor=None):
        return host_commands.HostCommands(
            role=role,
            unit_names=unit_names,
            executor=executor or RecordingExecutor(),
        )

    def test_instance_commands_use_the_instance_follower_and_security_units(self):
        executor = RecordingExecutor()
        commands = self.commands(executor=executor)

        for name in (
            "deploy-now",
            "pause-follower",
            "resume-follower",
            "run-security",
        ):
            self.assertEqual(
                commands.execute(name),
                {"command": name, "status": "success"},
            )

        self.assertEqual(
            [call[0] for call in executor.calls],
            [
                [
                    "systemctl",
                    "start",
                    "--no-block",
                    "media-stack-merged-updates.service",
                ],
                [
                    "systemctl",
                    "disable",
                    "--now",
                    "media-stack-merged-updates.timer",
                ],
                [
                    "systemctl",
                    "enable",
                    "--now",
                    "media-stack-merged-updates.timer",
                ],
                [
                    "systemctl",
                    "start",
                    "--no-block",
                    "media-stack-security-updates.service",
                ],
            ],
        )

    def test_apps_server_commands_use_the_apps_units(self):
        executor = RecordingExecutor()
        commands = self.commands(role="apps-server", executor=executor)

        commands.execute("deploy-now")
        commands.execute("run-security")

        self.assertEqual(
            [call[0] for call in executor.calls],
            [
                [
                    "systemctl",
                    "start",
                    "--no-block",
                    "media-stack-apps-merged-updates.service",
                ],
                [
                    "systemctl",
                    "start",
                    "--no-block",
                    "media-stack-apps-security-updates.service",
                ],
            ],
        )

    def test_follower_commands_respect_configured_unit_names(self):
        executor = RecordingExecutor()
        commands = self.commands(
            unit_names=[
                "custom-merged-updates",
                "custom-security-updates",
            ],
            executor=executor,
        )

        commands.execute("pause-follower")

        self.assertEqual(
            executor.calls[0][0],
            ["systemctl", "disable", "--now", "custom-merged-updates.timer"],
        )

    def test_only_whitelisted_command_names_are_accepted(self):
        executor = RecordingExecutor()
        commands = self.commands(executor=executor)

        for name in (
            "systemctl restart media-stack-merged-updates.service",
            "deploy-now --unit other.service",
            "pause",
            "",
            None,
        ):
            with self.assertRaises(ValueError):
                commands.execute(name)

        self.assertEqual(executor.calls, [])

    def test_an_unconfigured_unit_disables_its_commands_without_executing(self):
        executor = RecordingExecutor()
        commands = self.commands(unit_names=["media-stack-evidence"], executor=executor)

        with self.assertRaises(ValueError):
            commands.execute("deploy-now")

        self.assertEqual(executor.calls, [])

    def test_an_invalid_configured_unit_name_is_never_sent_to_the_helper(self):
        executor = RecordingExecutor()
        commands = self.commands(
            unit_names=["merged-updates; reboot", "security-updates"],
            executor=executor,
        )

        with self.assertRaises(ValueError):
            commands.execute("pause-follower")

        self.assertEqual(executor.calls, [])

    def test_a_failed_host_command_is_reported_and_not_retried(self):
        executor = RecordingExecutor(status=1)
        commands = self.commands(executor=executor)

        with self.assertRaises(host_commands.CommandFailed):
            commands.execute("pause-follower")

        self.assertEqual(len(executor.calls), 1)

    def test_an_uncertain_helper_result_is_not_retried(self):
        executor = RecordingExecutor(error=OSError("timeout"))
        commands = self.commands(executor=executor)

        with self.assertRaises(OSError):
            commands.execute("deploy-now")

        self.assertEqual(len(executor.calls), 1)


class FakeHost:
    def __init__(self):
        self.units = [
            {
                "name": "media-stack-merged-updates",
                "service": "media-stack-merged-updates.service",
                "timer": "media-stack-merged-updates.timer",
                "activeState": "active",
                "subState": "waiting",
                "unitFileState": "enabled",
                "result": "success",
                "lastRun": None,
                "nextRun": None,
            }
        ]

    def units_for(self, names):
        return list(self.units)

    def failed_units(self):
        return []

    def reboot(self):
        return {"available": False, "required": None}


class FakeDocker:
    def usage(self):
        return {
            "available": False,
            "images": {"count": 0, "size": 0, "reclaimable": 0},
            "containers": {"count": 0, "size": 0},
            "volumes": {"count": 0, "size": 0},
            "buildCache": {"count": 0, "size": 0},
            "total": 0,
            "reclaimable": 0,
        }


class HostCommandRouteTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.appdata = Path(self.temp.name)
        self.host = FakeHost()
        self.executor = RecordingExecutor()
        self.previous = (
            server.TOKEN,
            server.ALLOWED_NETWORKS,
            server.MAINTENANCE,
            server.COMMANDS,
        )
        server.TOKEN = "t" * 32
        server.ALLOWED_NETWORKS = server.allowed_networks("127.0.0.1")
        server.MAINTENANCE = maintenance.Maintenance(
            appdata=self.appdata,
            host_reader=self.host,
            docker_reader=FakeDocker(),
            clock=lambda: 2000.0,
            cache_seconds=60,
        )
        server.COMMANDS = host_commands.HostCommands(
            role="instance",
            unit_names=maintenance.INSTANCE_UNITS,
            executor=self.executor,
        )
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        (
            server.TOKEN,
            server.ALLOWED_NETWORKS,
            server.MAINTENANCE,
            server.COMMANDS,
        ) = self.previous
        self.temp.cleanup()

    def request(self, method, path, body=None, token="t" * 32):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.httpd.server_address[1], timeout=5
        )
        try:
            headers = {"Authorization": "Bearer " + token} if token else {}
            raw = json.dumps(body) if body is not None else None
            if raw is not None:
                headers["Content-Type"] = "application/json"
            connection.request(method, path, body=raw, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def snapshot(self):
        return self.request("GET", "/maintenance")[1]

    def test_runs_a_whitelisted_command_and_invalidates_the_snapshot_cache(self):
        self.assertEqual(self.snapshot()["units"][0]["state"], "active")

        status, body = self.request(
            "POST", "/command", {"command": "pause-follower"}
        )

        self.assertEqual(status, 200)
        self.assertEqual(body, {"command": "pause-follower", "status": "success"})
        self.assertEqual(
            self.executor.calls[0][0],
            ["systemctl", "disable", "--now", "media-stack-merged-updates.timer"],
        )
        self.host.units[0].update(
            activeState="inactive", subState="dead", unitFileState="disabled"
        )
        cached_until = self.snapshot()
        self.assertEqual(cached_until["timestamp"], 2000.0)
        self.assertEqual(cached_until["units"][0]["state"], "paused")
        self.assertTrue(cached_until["units"][0]["paused"])

    def test_rejects_unknown_commands_without_calling_the_helper(self):
        status, body = self.request(
            "POST", "/command", {"command": "systemctl restart evil.service"}
        )

        self.assertEqual(status, 400)
        self.assertIn("error", body)
        self.assertEqual(self.executor.calls, [])

    def test_rejects_free_arguments_in_the_request(self):
        status, _ = self.request(
            "POST",
            "/command",
            {"command": "pause-follower", "unit": "other.timer"},
        )

        self.assertEqual(status, 400)
        self.assertEqual(self.executor.calls, [])

    def test_a_failed_host_command_is_reported_as_an_unconfirmed_result(self):
        self.executor.status = 1

        status, body = self.request("POST", "/command", {"command": "deploy-now"})

        self.assertEqual(status, 502)
        self.assertIn("error", body)
        self.assertNotIn("systemctl", json.dumps(body))
        self.assertEqual(len(self.executor.calls), 1)

    def test_an_unconfirmed_helper_failure_returns_a_server_error(self):
        self.executor.error = OSError("timeout")

        status, body = self.request("POST", "/command", {"command": "deploy-now"})

        self.assertEqual(status, 502)
        self.assertNotIn("timeout", json.dumps(body))
        self.assertEqual(len(self.executor.calls), 1)

    def test_requires_authentication(self):
        status, _ = self.request(
            "POST", "/command", {"command": "deploy-now"}, token=None
        )

        self.assertEqual(status, 401)
        self.assertEqual(self.executor.calls, [])

    def test_command_route_is_post_only(self):
        status, _ = self.request("GET", "/command")

        self.assertEqual(status, 404)
        self.assertEqual(self.executor.calls, [])


if __name__ == "__main__":
    unittest.main()
