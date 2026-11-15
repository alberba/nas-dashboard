import unittest
from unittest.mock import patch

import server


def summary(labels):
    return {
        "Id": "a" * 64,
        "Names": ["/radarr"],
        "Image": "lscr.io/linuxserver/radarr:6.4.4.10685-ls325",
        "State": "exited",
        "Status": "Exited (0) 2 days ago",
        "Labels": labels,
    }


class ComposeMetadata(unittest.TestCase):
    def test_reports_the_compose_project_and_service_labels(self):
        result = server.container_stat(
            summary(
                {
                    "com.docker.compose.project": "media-stack",
                    "com.docker.compose.service": "radarr",
                    "com.docker.compose.project.config_files": "/volume2/media-stack/compose.yaml",
                }
            )
        )
        self.assertEqual(
            result["compose"], {"project": "media-stack", "service": "radarr"}
        )
        self.assertEqual(result["composeProject"], "media-stack")
        self.assertEqual(result["composeService"], "radarr")

    def test_reports_no_compose_metadata_outside_a_compose_project(self):
        for labels in (None, {}, {"com.docker.compose.project": "media-stack"}):
            with self.subTest(labels=labels):
                result = server.container_stat(summary(labels))
                self.assertIsNone(result["compose"])

class ContainerNetwork(unittest.TestCase):
    def setUp(self):
        self.previous = dict(server.container_previous)
        server.container_previous.clear()

    def tearDown(self):
        server.container_previous.clear()
        server.container_previous.update(self.previous)

    def test_network_rates_need_a_previous_sample(self):
        item = summary({})
        item.update(State="running", Status="Up 1 hour (healthy)")
        first = {
            "cpu_stats": {
                "cpu_usage": {"total_usage": 100},
                "system_cpu_usage": 1000,
                "online_cpus": 1,
            },
            "memory_stats": {"usage": 1000, "stats": {"inactive_file": 100}},
            "networks": {"eth0": {"rx_bytes": 1000, "tx_bytes": 2000}},
        }
        second = {
            "cpu_stats": {
                "cpu_usage": {"total_usage": 200},
                "system_cpu_usage": 2000,
                "online_cpus": 1,
            },
            "memory_stats": {"usage": 1000, "stats": {"inactive_file": 100}},
            "networks": {"eth0": {"rx_bytes": 2000, "tx_bytes": 4000}},
        }
        with patch("server.docker", side_effect=[first, second]):
            with patch("server.time.time", return_value=1000):
                first_result = server.container_stat(item, now=1000)
            second_result = server.container_stat(item, now=1010)

        self.assertEqual(first_result["network"], {"rx": None, "tx": None})
        self.assertEqual(second_result["network"], {"rx": 100.0, "tx": 200.0})
        self.assertEqual(second_result["cpu"], 10.0)


class HealthObservation(unittest.TestCase):
    def test_unhealthy_observation_survives_samples_and_resets_on_recovery(self):
        from unittest.mock import patch
        item = summary({})
        item.update(State="running", Status="Up 1 hour (unhealthy)")
        with patch("server.docker", side_effect=RuntimeError("stats unavailable")):
            with patch("server.time.time", return_value=100):
                first = server.container_stat(item)
            self.assertEqual(first["healthObservedSince"], 100)
            with patch("server.time.time", return_value=160):
                self.assertEqual(server.container_stat(item)["healthObservedSince"], 100)
            item["Status"] = "Up 1 hour (healthy)"
            self.assertIsNone(server.container_stat(item)["healthObservedSince"])


if __name__ == "__main__":
    unittest.main()
