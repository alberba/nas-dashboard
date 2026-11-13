import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.parse import parse_qs

import server

ID = "a" * 64
T1 = "2026-11-13T10:00:00.000000001Z"
T2 = "2026-11-13T10:00:00.000000002Z"
T3 = "2026-11-13T10:00:01.000000001Z"


def frame(stream, data):
    return bytes([stream, 0, 0, 0]) + len(data).to_bytes(4, "big") + data


def line(timestamp, message):
    return f"{timestamp} {message}\n".encode()


class FakeDocker:
    def __init__(self, payload=b""):
        self.payload = payload
        self.calls = []

    def __call__(self, ident, since, lines):
        self.calls.append((ident, since, lines))
        return self.payload


class ContainerLogs(unittest.TestCase):
    def setUp(self):
        self.docker = FakeDocker()
        self.previous = server.docker_logs
        server.docker_logs = self.docker

    def tearDown(self):
        server.docker_logs = self.previous

    def test_separates_stdout_and_stderr_and_rebuilds_split_lines(self):
        self.docker.payload = (
            frame(1, line(T1, "out one")[:22])
            + frame(1, line(T1, "out one")[22:])
            + frame(2, line(T2, "err one"))
        )
        result = server.container_logs(ID, "200", "")
        self.assertEqual(
            [(entry["stream"], entry["at"], entry["message"]) for entry in result["lines"]],
            [("stdout", T1, "out one"), ("stderr", T2, "err one")],
        )
        self.assertEqual(result["id"], ID)
        self.assertFalse(result["truncated"])

    def test_unframed_tty_output_is_kept_as_stdout(self):
        self.docker.payload = line(T1, "tty output")
        result = server.container_logs(ID, "200", "")
        self.assertEqual(
            [(entry["stream"], entry["message"]) for entry in result["lines"]],
            [("stdout", "tty output")],
        )

    def test_returns_only_the_requested_number_of_lines(self):
        self.docker.payload = (
            frame(1, line(T1, "one") + line(T2, "two") + line(T3, "three"))
        )
        result = server.container_logs(ID, "2", "")
        self.assertEqual(
            [entry["message"] for entry in result["lines"]], ["two", "three"]
        )
        self.assertTrue(result["truncated"])
        self.assertEqual(self.docker.calls[-1], (ID, "", 2))

    def test_accepts_the_maximum_and_rejects_other_limits(self):
        server.container_logs(ID, "5000", "")
        self.assertEqual(self.docker.calls[-1], (ID, "", 5000))
        for value in ("0", "5001", "many", "-1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                server.container_logs(ID, value, "")

    def test_incremental_cursor_never_repeats_lines_with_the_same_timestamp(self):
        self.docker.payload = frame(2, line(T2, "first") + line(T2, "second"))
        first = server.container_logs(ID, "200", "")
        self.assertEqual(
            [entry["message"] for entry in first["lines"]], ["first", "second"]
        )
        self.assertEqual(first["cursor"], f"{T2}#2")

        self.docker.payload = frame(
            2, line(T2, "first") + line(T2, "second") + line(T2, "new")
        ) + frame(1, line(T3, "later"))
        second = server.container_logs(ID, "200", first["cursor"])
        self.assertEqual(
            [entry["message"] for entry in second["lines"]], ["new", "later"]
        )
        self.assertEqual(second["cursor"], f"{T3}#1")
        self.assertEqual(self.docker.calls[-1], (ID, T2, 200))

    def test_truncated_incremental_reads_continue_forward(self):
        self.docker.payload = frame(
            1,
            line(T2, "one")
            + line(T2, "two")
            + line(T2, "three")
            + line(T3, "four")
            + line(T3, "five"),
        )
        first = server.container_logs(ID, "2", f"{T2}#0")
        self.assertEqual([entry["message"] for entry in first["lines"]], ["one", "two"])
        self.assertTrue(first["truncated"])
        self.assertEqual(first["cursor"], f"{T2}#2")

        second = server.container_logs(ID, "2", first["cursor"])
        self.assertEqual(
            [entry["message"] for entry in second["lines"]], ["three", "four"]
        )
        self.assertEqual(second["cursor"], f"{T3}#1")

        third = server.container_logs(ID, "2", second["cursor"])
        self.assertEqual([entry["message"] for entry in third["lines"]], ["five"])

    def test_rejects_invalid_container_ids_and_marks(self):
        with self.assertRaises(ValueError):
            server.container_logs("bad;id", "200", "")
        with self.assertRaises(ValueError):
            server.container_logs(ID, "200", "yesterday")
        self.assertEqual(self.docker.calls, [])


class FakeResponse:
    status = 200
    payload = b""

    def read(self, size=-1):
        return self.payload


class FakeUnixHTTP:
    path = None
    method = None
    status = 200
    payload = b""

    def __init__(self, host, timeout=8):
        self.host = host
        self.timeout = timeout

    def request(self, method, path, body=None, headers=None):
        type(self).method = method
        type(self).path = path

    def getresponse(self):
        response = FakeResponse()
        response.status = type(self).status
        response.payload = type(self).payload
        return response

    def close(self):
        pass


class DockerLogsRequest(unittest.TestCase):
    def setUp(self):
        self.previous = server.UnixHTTP
        server.UnixHTTP = FakeUnixHTTP
        FakeUnixHTTP.method = None
        FakeUnixHTTP.path = None
        FakeUnixHTTP.status = 200
        FakeUnixHTTP.payload = b""

    def tearDown(self):
        server.UnixHTTP = self.previous

    def test_reads_a_bounded_framed_snapshot_never_a_follow_stream(self):
        server.docker_logs(ID, T2, 200)
        self.assertEqual(FakeUnixHTTP.method, "GET")
        path, _, raw = FakeUnixHTTP.path.partition("?")
        self.assertEqual(path, f"/v1.45/containers/{ID}/logs")
        self.assertEqual(
            parse_qs(raw),
            {
                "stdout": ["1"],
                "stderr": ["1"],
                "timestamps": ["1"],
                "tail": ["200"],
                "since": [T2],
            },
        )

    def test_a_docker_read_failure_is_rejected(self):
        FakeUnixHTTP.status = 404
        FakeUnixHTTP.payload = b'{"message":"no such container"}'
        with self.assertRaises(ValueError):
            server.docker_logs(ID, "", 200)


class LogsEndpoint(unittest.TestCase):
    def setUp(self):
        self.docker = FakeDocker(frame(1, line(T1, "hello")))
        self.previous_docker = server.docker_logs
        self.previous_token = server.TOKEN
        self.previous_networks = server.ALLOWED_NETWORKS
        server.docker_logs = self.docker
        server.TOKEN = "t" * 32
        server.ALLOWED_NETWORKS = server.allowed_networks("127.0.0.1")
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        server.docker_logs = self.previous_docker
        server.TOKEN = self.previous_token
        server.ALLOWED_NETWORKS = self.previous_networks

    def request(self, path, method="GET", token=True):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Authorization": "Bearer " + server.TOKEN} if token else {}
        connection.request(method, path, headers=headers)
        response = connection.getresponse()
        data = json.loads(response.read() or b"null")
        connection.close()
        return response.status, data

    def test_requires_the_agent_bearer_token(self):
        status, _ = self.request(f"/logs?id={ID}&lines=10", token=False)
        self.assertEqual(status, 401)
        self.assertEqual(self.docker.calls, [])

    def test_returns_logs_for_an_authenticated_get(self):
        status, body = self.request(f"/logs?id={ID}&lines=10")
        self.assertEqual(status, 200)
        self.assertEqual(body["id"], ID)
        self.assertEqual(body["lines"][0]["message"], "hello")
        self.assertEqual(self.docker.calls[-1], (ID, "", 10))

    def test_invalid_id_is_rejected_without_reading_docker(self):
        status, body = self.request("/logs?id=short&lines=10")
        self.assertEqual(status, 400)
        self.assertIn("error", body)
        self.assertEqual(self.docker.calls, [])

    def test_logs_are_read_only(self):
        status, _ = self.request(f"/logs?id={ID}&lines=10", method="POST")
        self.assertEqual(status, 404)
        self.assertEqual(self.docker.calls, [])


if __name__ == "__main__":
    unittest.main()
