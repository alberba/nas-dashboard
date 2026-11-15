import http.client
import json
import threading
import unittest

import server


class FakeHost:
    def sample(self, proc, sys, roots, extra):
        return {
            "timestamp": 1000.0,
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
