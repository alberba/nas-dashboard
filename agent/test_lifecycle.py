import hashlib
import unittest

import lifecycle
import server


def container_id(name):
    return hashlib.sha256(name.encode()).hexdigest()


def listed(name, state="exited", exit_code=0, project=None, service=None, status=None):
    labels = {}
    if project:
        labels["com.docker.compose.project"] = project
    if service:
        labels["com.docker.compose.service"] = service
    if status is None:
        status = "Up 2 hours" if state == "running" else "Exited (%s) 3 days ago" % exit_code
    return {
        "Id": container_id(name),
        "Names": ["/" + name],
        "Image": "example/" + name + ":1",
        "State": state,
        "Status": status,
        "Labels": labels,
    }


def inspected(name, running=False, labels=None):
    return {
        "Id": container_id(name),
        "Name": "/" + name,
        "State": {
            "Status": "running" if running else "exited",
            "Running": running,
            "Paused": False,
            "Restarting": False,
            "ExitCode": 0,
        },
        "Config": {"Labels": labels or {}},
    }


MEDIA = "media-stack"


class FakeDocker:
    def __init__(self, target, running=True):
        self.target = target
        self.running = running
        self.calls = []

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == "GET" and path == "/containers/" + self.target["Id"] + "/json":
            return self.target
        if method == "GET" and path == "/containers/json?all=true":
            if not self.running:
                return [self.target]
            return [
                listed("jellyfin", state="running", project=MEDIA, service="jellyfin"),
                self.target,
            ]
        if method == "DELETE":
            return None
        raise AssertionError("unexpected Docker call: %s %s" % (method, path))


class ContainerClassification(unittest.TestCase):
    def classify(self, items, protected=()):
        return {item["name"]: item for item in lifecycle.classify(items, protected)}

    def test_stopped_previews_outside_the_active_compose_project_are_orphans(self):
        items = [
            listed("jellyfin", state="running", project=MEDIA, service="jellyfin"),
            listed("homarr-v2-native-preview", project="homarr-preview", service="preview"),
            listed("homarr-v2-native-preview-mock"),
        ]
        records = self.classify(items)

        self.assertTrue(records["homarr-v2-native-preview"]["orphan"])
        self.assertTrue(records["homarr-v2-native-preview-mock"]["orphan"])
        self.assertFalse(records["homarr-v2-native-preview"]["recreateOnCompose"])

    def test_wire_and_wire_seed_that_completed_successfully_are_not_orphans(self):
        items = [
            listed("jellyfin", state="running", project=MEDIA, service="jellyfin"),
            listed("wire", project=MEDIA, service="wire", exit_code=0),
            listed("wire-seed", project=MEDIA, service="wire-seed", exit_code=0),
        ]
        records = self.classify(items)

        for name in ("wire", "wire-seed"):
            self.assertFalse(records[name]["orphan"])
            self.assertTrue(records[name]["oneShot"])
            self.assertEqual(records[name]["exitCode"], 0)

    def test_a_failed_one_shot_is_not_an_orphan_but_exposes_its_failure(self):
        items = [
            listed("jellyfin", state="running", project=MEDIA, service="jellyfin"),
            listed("wire", project=MEDIA, service="wire", exit_code=1),
        ]
        wire = self.classify(items)["wire"]

        self.assertFalse(wire["orphan"])
        self.assertTrue(wire["oneShot"])
        self.assertEqual(wire["exitCode"], 1)

    def test_a_stopped_service_of_the_active_project_warns_that_compose_recreates_it(self):
        items = [
            listed("jellyfin", state="running", project=MEDIA, service="jellyfin"),
            listed("sonarr", project=MEDIA, service="sonarr", exit_code=137),
        ]
        sonarr = self.classify(items)["sonarr"]

        self.assertFalse(sonarr["orphan"])
        self.assertTrue(sonarr["recreateOnCompose"])

    def test_running_and_protected_containers_are_never_orphans(self):
        items = [
            listed("standalone-preview", state="running"),
            listed("tailscale", project=MEDIA, service="tailscale"),
        ]
        records = self.classify(items, protected={"tailscale"})

        self.assertFalse(records["standalone-preview"]["orphan"])
        self.assertFalse(records["tailscale"]["orphan"])
        self.assertTrue(records["tailscale"]["protected"])


class ContainerRemoval(unittest.TestCase):
    def setUp(self):
        self.previous = server.docker
        self.previous_cache = server.container_cache
        self.name = "homarr-v2-native-preview"
        self.target = inspected(self.name)

    def tearDown(self):
        server.docker = self.previous
        server.container_cache = self.previous_cache

    def remove(self, confirmation=None, target=None):
        fake = FakeDocker(target or self.target)
        server.docker = fake
        try:
            result = server.execute(
                {
                    "action": "remove-container",
                    "id": (target or self.target)["Id"],
                    "confirmation": confirmation if confirmation is not None else self.name,
                }
            )
        except Exception:
            return fake, None
        return fake, result

    def test_removes_a_stopped_container_without_touching_volumes(self):
        fake, result = self.remove()

        deletes = [call for call in fake.calls if call[0] == "DELETE"]
        self.assertEqual(deletes, [("DELETE", "/containers/" + self.target["Id"] + "?v=0", None)])
        self.assertFalse(any("v=1" in call[1] for call in fake.calls))
        self.assertEqual(result["state"], "removed")
        self.assertEqual(result["name"], self.name)
        self.assertFalse(result["volumesRemoved"])

    def test_rejects_a_running_container_without_deleting_it(self):
        fake, result = self.remove(
            target=inspected(self.name, running=True)
        )

        self.assertIsNone(result)
        self.assertFalse(any(call[0] == "DELETE" for call in fake.calls))

    def test_rejects_a_protected_container_without_deleting_it(self):
        previous = server.PROTECTED
        server.PROTECTED = set(previous) | {self.name}
        try:
            fake, result = self.remove()
        finally:
            server.PROTECTED = previous

        self.assertIsNone(result)
        self.assertFalse(any(call[0] == "DELETE" for call in fake.calls))

    def test_rejects_an_inexact_confirmation_without_deleting_it(self):
        for confirmation in ("", "homarr-v2-native-preview ", "Homarr-v2-native-preview"):
            with self.subTest(confirmation=confirmation):
                fake, result = self.remove(confirmation=confirmation)
                self.assertIsNone(result)
                self.assertFalse(any(call[0] == "DELETE" for call in fake.calls))

    def test_rejects_an_invalid_identifier_before_calling_docker(self):
        fake = FakeDocker(self.target)
        server.docker = fake
        with self.assertRaises(ValueError):
            server.execute(
                {
                    "action": "remove-container",
                    "id": "bad;reboot",
                    "confirmation": self.name,
                }
            )
        self.assertEqual(fake.calls, [])

    def test_warns_when_the_active_project_will_recreate_the_container(self):
        labels = {
            "com.docker.compose.project": MEDIA,
            "com.docker.compose.service": "sonarr",
        }
        target = inspected("sonarr", labels=labels)
        fake, result = self.remove(confirmation="sonarr", target=target)

        self.assertTrue(result["recreateOnCompose"])
        self.assertEqual(result["composeService"], "sonarr")
        self.assertFalse(result["volumesRemoved"])


if __name__ == "__main__":
    unittest.main()
