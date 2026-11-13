import unittest
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
