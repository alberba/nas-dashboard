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

    def test_reports_no_compose_metadata_outside_a_compose_project(self):
        for labels in (None, {}, {"com.docker.compose.project": "media-stack"}):
            with self.subTest(labels=labels):
                result = server.container_stat(summary(labels))
                self.assertIsNone(result["compose"])


if __name__ == "__main__":
    unittest.main()
