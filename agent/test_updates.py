import unittest

import updates


class FakeDocker:
    def __init__(self, responses=None):
        self.responses = responses or {}
        self.calls = []

    def call(self, method, path, body=None, *, timeout=None, raw=False):
        self.calls.append((method, path, body, timeout))
        value = self.responses.get((method, path))
        if isinstance(value, Exception):
            raise value
        return value


class FakeExecutor:
    def __init__(self, statuses=None):
        self.statuses = list(statuses or [0, 0])
        self.calls = []

    def run_status(self, argv, timeout=8):
        self.calls.append((list(argv), timeout))
        status = self.statuses.pop(0) if self.statuses else 0
        return status, ""


def image(ident="b"):
    return {"Id": "sha256:" + ident * 64}


def summary(labels, state="running", name="jellyfin"):
    return {
        "Id": "a" * 64,
        "Names": ["/" + name],
        "Image": "lscr.io/linuxserver/jellyfin:latest",
        "ImageID": "sha256:" + "b" * 64,
        "State": state,
        "Status": "Up 1 hour",
        "Labels": labels,
    }


COMPOSE = {
    "com.docker.compose.project": "media-stack",
    "com.docker.compose.service": "jellyfin",
    "com.docker.compose.project.working_dir": "/volume2/media-stack",
    "com.docker.compose.project.config_files": "/volume2/media-stack/compose.yaml",
}


class ReferenceTest(unittest.TestCase):
    def test_splits_repository_tag_and_digest(self):
        self.assertEqual(
            updates.split_reference("lscr.io/linuxserver/jellyfin:10.10.7"),
            ("lscr.io/linuxserver/jellyfin", "10.10.7", None),
        )
        self.assertEqual(
            updates.split_reference("registry:5000/app@sha256:" + "c" * 64),
            ("registry:5000/app", None, "sha256:" + "c" * 64),
        )
        self.assertEqual(updates.split_reference(None), (None, None, None))

    def test_reads_the_version_from_labels_before_the_tag(self):
        self.assertEqual(
            updates.image_version(
                "lscr.io/linuxserver/jellyfin:latest",
                {"org.opencontainers.image.version": "10.10.7"},
            ),
            "10.10.7",
        )
        self.assertEqual(
            updates.image_version(
                "lscr.io/linuxserver/jellyfin:10.10.7",
                {"build_version": "Linuxserver.io version:- 10.10.7-ls279 Build-date:- 2025-01-02"},
            ),
            "10.10.7-ls279",
        )
        self.assertEqual(
            updates.image_version("app:1.4.2", {}),
            "1.4.2",
        )

    def test_a_floating_tag_is_not_a_version(self):
        self.assertIsNone(updates.image_version("app:latest", {}))
        self.assertIsNone(updates.image_version("app", {}))
        self.assertIsNone(updates.image_version("sha256:" + "a" * 64, {}))

    def test_image_labels_are_cleaned(self):
        self.assertIsNone(updates.clean_version(" x\x00y "))
        self.assertIsNone(updates.clean_version("x" * 81))
        self.assertEqual(updates.clean_version(" 1.2.3 "), "1.2.3")


class AccessTest(unittest.TestCase):
    def test_uses_a_valid_explicit_url(self):
        self.assertEqual(
            updates.image_url({"hub.url": "https://jellyfin.alberba.es"}),
            "https://jellyfin.alberba.es",
        )
        self.assertIsNone(updates.image_url({"hub.url": "javascript:alert(1)"}))

    def test_reads_the_first_traefik_host_rule(self):
        labels = {
            "traefik.http.routers.jellyfin.rule": "Host(`jellyfin.alberba.es`) && PathPrefix(`/`)",
            "traefik.http.routers.other.rule": "Host(`other.alberba.es`)",
        }
        self.assertEqual(
            updates.image_url(labels), "https://jellyfin.alberba.es"
        )

    def test_ignores_wildcards_and_invalid_hosts(self):
        self.assertIsNone(
            updates.image_url(
                {"traefik.http.routers.x.rule": "Host(`*.alberba.es`)"}
            )
        )
        self.assertIsNone(
            updates.image_url(
                {"traefik.http.routers.x.rule": "Host(`not a host`)"}
            )
        )

    def test_no_labels_means_no_link(self):
        self.assertIsNone(updates.image_url({}))


class ComposeTest(unittest.TestCase):
    def test_builds_the_fixed_compose_argv(self):
        argv, service = updates.compose_argv(summary(COMPOSE), role="instance")
        self.assertEqual(service, "jellyfin")
        self.assertEqual(
            argv,
            [
                "docker",
                "compose",
                "-p",
                "media-stack",
                "--project-directory",
                "/volume2/media-stack",
                "-f",
                "/volume2/media-stack/compose.yaml",
            ],
        )

    def test_passes_an_absolute_environment_file(self):
        labels = dict(COMPOSE)
        labels["com.docker.compose.project.environment_file"] = (
            "/volume2/media-stack/.env"
        )
        argv, _ = updates.compose_argv(summary(labels))
        self.assertIn("--env-file", argv)
        self.assertIn("/volume2/media-stack/.env", argv)

    def test_falls_back_to_the_role_checkout_only_for_its_project(self):
        labels = {
            "com.docker.compose.project": "media-stack",
            "com.docker.compose.service": "jellyfin",
        }
        argv, _ = updates.compose_argv(
            summary(labels), role="instance", stack_path="/volume2/media-stack"
        )
        self.assertIn("--project-directory", argv)
        with self.assertRaises(ValueError):
            updates.compose_argv(
                summary(labels), role="apps-server", stack_path="/opt/apps"
            )

    def test_rejects_relative_or_missing_locations(self):
        labels = dict(COMPOSE)
        labels["com.docker.compose.project.working_dir"] = "relative"
        labels["com.docker.compose.project.config_files"] = "compose.yaml"
        with self.assertRaises(ValueError):
            updates.compose_argv(summary(labels))

    def test_rejects_containers_outside_compose(self):
        with self.assertRaises(ValueError):
            updates.compose_argv(summary({}))
        with self.assertRaises(ValueError):
            updates.compose_argv(
                summary(
                    {
                        "com.docker.compose.project": "media-stack",
                        "com.docker.compose.service": "bad service",
                    }
                )
            )

    def test_can_update_requires_running_unprotected_compose(self):
        protected = updates.protected_names("hub-agent")
        self.assertTrue(
            updates.can_update(summary(COMPOSE), protected=protected)
        )
        self.assertFalse(
            updates.can_update(summary(COMPOSE, state="exited"), protected=protected)
        )
        self.assertFalse(
            updates.can_update(
                summary(COMPOSE, name="hub-agent"), protected=protected
            )
        )
        self.assertFalse(updates.can_update(summary({}), protected=protected))


class RunUpdateTest(unittest.TestCase):
    def test_pulls_then_recreates_the_service(self):
        docker = FakeDocker({("GET", "/containers/" + "a" * 64 + "/json"): summary(COMPOSE)})
        executor = FakeExecutor()
        result = updates.run_update(
            docker,
            executor,
            "a" * 64,
            role="instance",
            protected=updates.protected_names(),
        )
        self.assertEqual(result["state"], "updated")
        self.assertEqual(result["name"], "jellyfin")
        self.assertEqual(len(executor.calls), 2)
        self.assertEqual(
            executor.calls[0][0][-2:], ["pull", "jellyfin"]
        )
        self.assertEqual(
            executor.calls[1][0][-4:],
            ["up", "-d", "--no-deps", "jellyfin"],
        )

    def test_a_failed_pull_changes_nothing_and_reports_a_rejection(self):
        docker = FakeDocker({("GET", "/containers/" + "a" * 64 + "/json"): summary(COMPOSE)})
        executor = FakeExecutor([1, 0])
        with self.assertRaises(ValueError):
            updates.run_update(docker, executor, "a" * 64)
        self.assertEqual(len(executor.calls), 1)

    def test_a_failed_recreate_is_uncertain(self):
        docker = FakeDocker({("GET", "/containers/" + "a" * 64 + "/json"): summary(COMPOSE)})
        executor = FakeExecutor([0, 1])
        with self.assertRaises(updates.CommandFailed):
            updates.run_update(docker, executor, "a" * 64)
        self.assertEqual(len(executor.calls), 2)

    def test_rejects_protected_stopped_and_invalid_containers(self):
        docker = FakeDocker(
            {
                ("GET", "/containers/" + "a" * 64 + "/json"): summary(
                    COMPOSE, name="hub-agent"
                )
            }
        )
        with self.assertRaises(ValueError):
            updates.run_update(docker, FakeExecutor(), "a" * 64)
        with self.assertRaises(ValueError):
            updates.run_update(docker, FakeExecutor(), "not-an-id")


class RegistryTest(unittest.TestCase):
    reference = "lscr.io/linuxserver/jellyfin:latest"
    local = "sha256:" + "c" * 64

    def checker(self, docker):
        return updates.RegistryChecker(docker, clock=lambda: 100.0, ttl=60)

    def test_reports_an_update_when_the_registry_digest_differs(self):
        docker = FakeDocker(
            {
                ("GET", "/distribution/" + self.reference + "/json"): {
                    "Descriptor": {"digest": "sha256:" + "d" * 64}
                }
            }
        )
        result = self.checker(docker).check(self.reference, [self.reference.split(":")[0] + "@" + self.local])
        self.assertTrue(result["available"])
        self.assertEqual(result["checkedAt"], 100.0)

    def test_reports_up_to_date_when_the_digests_match(self):
        docker = FakeDocker(
            {
                ("GET", "/distribution/" + self.reference + "/json"): {
                    "Descriptor": {"digest": self.local}
                }
            }
        )
        result = self.checker(docker).check(
            self.reference,
            ["lscr.io/linuxserver/jellyfin@" + self.local],
        )
        self.assertFalse(result["available"])

    def test_a_registry_error_is_unknown_not_outdated(self):
        docker = FakeDocker(
            {("GET", "/distribution/" + self.reference + "/json"): OSError("offline")}
        )
        self.assertIsNone(self.checker(docker).check(self.reference, [])["available"])

    def test_a_pinned_reference_never_needs_an_update(self):
        docker = FakeDocker()
        result = self.checker(docker).check(
            "app@sha256:" + "d" * 64, ["app@sha256:" + "d" * 64]
        )
        self.assertFalse(result["available"])
        self.assertEqual(docker.calls, [])

    def test_caches_the_answer_and_can_forget_it(self):
        docker = FakeDocker(
            {
                ("GET", "/distribution/" + self.reference + "/json"): {
                    "Descriptor": {"digest": "sha256:" + "d" * 64}
                }
            }
        )
        checker = self.checker(docker)
        for _ in range(3):
            checker.check(self.reference, [])
        self.assertEqual(len(docker.calls), 1)
        checker.invalidate(self.reference)
        checker.check(self.reference, [])
        self.assertEqual(len(docker.calls), 2)


class SnapshotTest(unittest.TestCase):
    def test_reads_links_versions_and_update_state_per_container(self):
        labels = dict(COMPOSE)
        labels["hub.url"] = "https://jellyfin.alberba.es"
        reference = "lscr.io/linuxserver/jellyfin:latest"
        docker = FakeDocker(
            {
                ("GET", "/containers/json?all=1"): [summary(labels)],
                ("GET", "/images/sha256:" + "b" * 64 + "/json"): {
                    "Config": {"Labels": {"org.opencontainers.image.version": "10.10.7"}},
                    "RepoDigests": ["lscr.io/linuxserver/jellyfin@sha256:" + "c" * 64],
                },
                ("GET", "/distribution/" + reference + "/json"): {
                    "Descriptor": {"digest": "sha256:" + "d" * 64}
                },
            }
        )
        section = updates.ContainerUpdates(
            docker,
            role="instance",
            stack_path="/volume2/media-stack",
            protected=updates.protected_names(),
            clock=lambda: 100.0,
        ).read()

        self.assertTrue(section["available"])
        entry = section["items"][0]
        self.assertEqual(entry["id"], "a" * 64)
        self.assertEqual(entry["version"], "10.10.7")
        self.assertEqual(entry["tag"], "latest")
        self.assertEqual(entry["url"], "https://jellyfin.alberba.es")
        self.assertTrue(entry["canUpdate"])
        self.assertTrue(entry["updateAvailable"])
        self.assertEqual(entry["checkedAt"], 100.0)

    def test_a_docker_failure_raises_for_the_degraded_section(self):
        docker = FakeDocker(
            {("GET", "/containers/json?all=1"): OSError("unavailable")}
        )
        with self.assertRaises(OSError):
            updates.ContainerUpdates(docker).read()


class ProtectedTest(unittest.TestCase):
    def test_defaults_and_configured_names_are_protected(self):
        names = updates.protected_names("custom-one, custom-two")
        self.assertTrue({"hub-agent", "npm", "custom-one", "custom-two"} <= names)


if __name__ == "__main__":
    unittest.main()
