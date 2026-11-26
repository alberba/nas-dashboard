import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import server


def make_stat(pid, identity):
    fields = [
        "S",
        "1",
        str(pid),
        str(pid),
        "0",
        "-1",
        "4194304",
        "100",
        "0",
        "0",
        "0",
        "1",
        "1",
        "0",
        "0",
        "20",
        "0",
        "1",
        "0",
        identity,
    ]
    return "%d (python) %s 0 0" % (pid, " ".join(fields))


class HealthProbeTest(unittest.TestCase):
    pid = 4242
    identity = "777"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.proc = self.root / "proc"
        (self.proc / str(self.pid)).mkdir(parents=True)
        (self.proc / str(self.pid) / "stat").write_text(
            make_stat(self.pid, self.identity)
        )
        self.file = self.root / "agent-health.json"
        self.now = 1_000_000.0

    def tearDown(self):
        self.temporary.cleanup()

    def health(self, minimum_interval=0):
        return server.HealthMark(
            path=self.file,
            now=lambda: self.now,
            pid=self.pid,
            proc=self.proc,
            minimum_interval=minimum_interval,
        )

    def check(self):
        return server.read_health_check(
            path=self.file, now=self.now, proc=self.proc
        )

    def test_a_fresh_private_mark_from_the_serve_loop_is_healthy(self):
        self.assertTrue(self.health().refresh())
        self.assertEqual(self.check(), (True, "ok"))

    def test_a_stopped_loop_is_unhealthy_while_the_process_is_still_alive(self):
        self.assertTrue(self.health().refresh())
        self.now += server.HEALTH_STALE_SECONDS + 1
        self.assertEqual(self.check(), (False, "stale"))
        # The PID and its boot identity are unchanged: only progress is gone.
        self.assertEqual(
            server.process_start_identity(self.pid, self.proc), self.identity
        )
        self.assertTrue(self.health().refresh())
        self.assertEqual(self.check(), (True, "ok"))

    def test_a_reused_pid_with_another_start_identity_is_unhealthy(self):
        server.write_health_mark(
            self.file,
            {"progressAt": self.now - 1, "pid": self.pid, "startedAt": "999"},
        )
        self.assertEqual(self.check(), (False, "wrong_start"))

    def test_missing_malformed_future_unsafe_dead_and_unreadable_marks_fail(self):
        self.assertEqual(self.check(), (False, "missing"))

        self.file.write_text("not json")
        os.chmod(self.file, 0o600)
        self.assertEqual(self.check(), (False, "malformed"))

        server.write_health_mark(
            self.file,
            {
                "progressAt": self.now + 60,
                "pid": self.pid,
                "startedAt": self.identity,
            },
        )
        self.assertEqual(self.check(), (False, "future"))

        os.chmod(self.file, 0o644)
        self.assertEqual(self.check(), (False, "unsafe"))

        server.write_health_mark(
            self.file,
            {
                "progressAt": self.now,
                "pid": self.pid + 1,
                "startedAt": self.identity,
            },
        )
        self.assertEqual(self.check(), (False, "dead_pid"))

        (self.proc / str(self.pid + 2)).mkdir()
        server.write_health_mark(
            self.file,
            {
                "progressAt": self.now,
                "pid": self.pid + 2,
                "startedAt": self.identity,
            },
        )
        self.assertEqual(self.check(), (False, "identity_unreadable"))

    def test_a_non_finite_progress_mark_is_malformed(self):
        # json.loads accepts the non-standard NaN and Infinity tokens, which
        # pass the numeric type check and defeat both freshness comparisons.
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value):
                server.write_health_mark(
                    self.file,
                    {
                        "progressAt": value,
                        "pid": self.pid,
                        "startedAt": self.identity,
                    },
                )
                self.assertEqual(self.check(), (False, "malformed"))

    def test_progress_writes_are_rate_limited(self):
        health = self.health(minimum_interval=2)
        self.assertTrue(health.refresh())
        self.now += 1
        self.assertFalse(health.refresh())
        self.now += 1
        self.assertTrue(health.refresh())

    def test_a_lock_held_by_another_thread_blocks_progress_and_recovery(self):
        class FakeHealth:
            def __init__(self):
                self.calls = 0

            def refresh(self):
                self.calls += 1
                return True

        fake = FakeHealth()
        httpd = server.HealthServer(("127.0.0.1", 0), server.Handler)
        httpd.health = fake
        acquired = threading.Event()
        release = threading.Event()

        def hold():
            with server.LOCK:
                acquired.set()
                release.wait(5)

        thread = threading.Thread(target=hold, daemon=True)
        thread.start()
        try:
            self.assertTrue(acquired.wait(5))
            httpd.service_actions()
            self.assertEqual(fake.calls, 0)
            release.set()
            thread.join(5)
            httpd.service_actions()
            self.assertEqual(fake.calls, 1)
        finally:
            release.set()
            httpd.server_close()

    def test_the_probe_exit_code_does_not_start_the_server(self):
        self.assertEqual(
            server.run_health_check(
                path=self.file, now=self.now, proc=self.proc
            ),
            1,
        )
        self.assertTrue(self.health().refresh())
        self.assertEqual(
            server.run_health_check(
                path=self.file, now=self.now, proc=self.proc
            ),
            0,
        )

    def test_health_mode_exits_before_the_token_check(self):
        environment = dict(os.environ)
        environment["AGENT_HEALTH_FILE"] = str(self.file)
        environment.pop("AGENT_TOKEN", None)
        result = subprocess.run(
            [sys.executable, "server.py", "--health-check"],
            cwd=str(Path(server.__file__).parent),
            env=environment,
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("missing", result.stderr)



class FakeHost:
    def sample(self, proc, sys, roots, extra, root=None):
        return {
            "timestamp": 1000.0,
            "system": {
                "hostname": "nas",
                "cpuModel": "Intel Core i3-1315U",
                "cores": 6,
                "threads": 8,
                "sockets": 1,
                "arch": "x86_64",
                "kernel": "6.18.15",
                "osName": "Debian GNU/Linux 12",
                "memoryTotal": 8_000_000,
            },
            "cpu": 12.3,
            "cpuCores": [10.0, 14.6],
            "cpuBreakdown": {
                "user": 20.0,
                "system": 5.0,
                "iowait": 1.0,
                "steal": 0.0,
                "idle": 73.0,
                "irq": 0.5,
                "softirq": 0.5,
                "nice": 0.0,
            },
            "load": [0.5, 0.6, 0.7],
            "memory": {
                "total": 8_000_000,
                "used": 6_000_000,
                "cache": 1_000_000,
                "swap": {"total": 2_000_000, "used": 500_000},
            },
            "network": {
                "rx": 100.0,
                "tx": 50.0,
                "interfaces": [
                    {
                        "name": "eth0",
                        "rx": 100.0,
                        "tx": 50.0,
                        "rxTotal": 1000,
                        "txTotal": 500,
                    }
                ],
            },
            "io": {
                "read": 200.0,
                "write": 100.0,
                "latency": {
                    "readMs": 1.5,
                    "writeMs": 2.0,
                    "utilization": 4.2,
                    "weightedMs": 1.8,
                    "devices": [],
                },
            },
            "uptime": 3600.0,
            "disks": [],
            "filesystems": [
                {
                    "name": "Volumen de películas",
                    "total": 1000,
                    "used": 400,
                    "free": 600,
                }
            ],
            "raid": [
                {
                    "name": "md0",
                    "level": "raid1",
                    "state": "clean",
                    "disks": 2,
                    "capacity": 1000,
                    "degraded": 0,
                    "syncAction": "idle",
                    "syncCompleted": "none",
                    "syncSpeed": "none",
                }
            ],
            "temperatures": [{"name": "nvme_composite", "value": 42.0}],
        }


class MetricsRouteTest(unittest.TestCase):
    def setUp(self):
        self.previous = (
            server.TOKEN,
            server.ALLOWED_NETWORKS,
            server.HOST,
            server.container_cache,
        )
        server.TOKEN = "t" * 32
        server.ALLOWED_NETWORKS = server.allowed_networks("127.0.0.1")
        server.HOST = FakeHost()
        server.container_cache = (1000.0, [])
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
            server.HOST,
            server.container_cache,
        ) = self.previous

    def request(self, path):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.httpd.server_address[1], timeout=5
        )
        try:
            connection.request(
                "GET", path, headers={"Authorization": "Bearer " + ("t" * 32)}
            )
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_metrics_route_exposes_the_native_fields(self):
        status, body = self.request("/metrics")

        self.assertEqual(status, 200)
        self.assertEqual(body["system"]["cpuModel"], "Intel Core i3-1315U")
        self.assertEqual(body["cpuCores"], [10.0, 14.6])
        self.assertEqual(body["load"], [0.5, 0.6, 0.7])
        self.assertEqual(body["memory"]["swap"], {"total": 2_000_000, "used": 500_000})
        self.assertEqual(body["network"]["interfaces"][0]["name"], "eth0")
        self.assertEqual(body["io"]["latency"]["readMs"], 1.5)
        self.assertEqual(body["filesystems"][0]["name"], "Volumen de películas")
        self.assertEqual(body["raid"][0]["name"], "md0")
        self.assertEqual(body["temperatures"][0]["name"], "nvme_composite")
        self.assertEqual(body["containers"], [])


if __name__ == "__main__":
    unittest.main()
